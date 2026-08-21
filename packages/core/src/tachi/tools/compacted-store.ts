// packages/core/src/tachi/tools/compacted-store.ts
//
// CCR — reversible compaction (steal: headroomlabs/headroom, STEAL §10). Our
// tool-output compactor (signalCompact / truncateOutput) is LOSSY: elided detail
// is gone, so the agent must re-run a command to recover it. CCR keeps the FULL
// original in a small per-session, in-memory, bounded store and hands the model a
// receipt with an id; the read-only `expand_compacted` tool pages it back on
// demand. Pure + dependency-free (in-memory only — scoped to one harness run, so
// no fs lifecycle to manage); the harness builds one store per run in ToolContext.

export class CompactedStore {
  private readonly map = new Map<string, string>()
  private readonly order: string[] = []
  private bytes = 0
  private seq = 0

  constructor(
    private readonly maxEntries = 64,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  /** Persist `text`, returning a short id to reference it. Evicts oldest to stay bounded. */
  save(text: string): string {
    const id = `c${++this.seq}`
    this.map.set(id, text)
    this.order.push(id)
    this.bytes += text.length
    this.evict()
    return id
  }

  /** The full text for `id`, or undefined if unknown / evicted. */
  get(id: string): string | undefined {
    return this.map.get(id)
  }

  size(): number {
    return this.map.size
  }

  private evict(): void {
    // Always keep the most recent entry even if it alone exceeds maxBytes.
    while (this.order.length > this.maxEntries || (this.bytes > this.maxBytes && this.order.length > 1)) {
      const old = this.order.shift()
      if (old === undefined) break
      const t = this.map.get(old)
      if (t !== undefined) { this.bytes -= t.length; this.map.delete(old) }
    }
  }
}

const DEFAULT_SLICE = 65_536

/**
 * A bounded window of a stored output for `expand_compacted`. Returns the whole
 * text when it fits in `limit`; otherwise the [offset, offset+limit) slice with a
 * one-line continuation header telling the model the next offset to request.
 */
export function readCompactedSlice(full: string, offset = 0, limit = DEFAULT_SLICE): string {
  const start = Math.max(0, Math.min(Math.floor(offset), full.length))
  const end = Math.min(full.length, start + Math.max(1, Math.floor(limit)))
  const body = full.slice(start, end)
  if (end < full.length) {
    return `[chars ${start}–${end} of ${full.length}; call expand_compacted with offset=${end} for more]\n${body}`
  }
  return body
}

// ── query modes (steal: OmniRoute ccrQuery) ─────────────────────────────────
// Paging a 2 MB log 64 KB at a time burns tokens when the model only wants the
// last 40 lines or the lines around one error. These query modes make targeted
// reads first-class: head/tail/lines/grep/stats over the stored full text, all
// pure and bounded. 'full' keeps the original paged behaviour.

export type CcrQueryMode = 'full' | 'head' | 'tail' | 'lines' | 'grep' | 'stats'

export interface CcrQuery {
  mode?: CcrQueryMode
  /** 'full' only: char offset to start from. */
  offset?: number
  /** 'full': char cap; 'head'/'tail': line count (default 40). */
  limit?: number
  /** 'lines' only: 1-indexed inclusive range, clamped to the text. */
  start?: number
  end?: number
  /** 'grep' only: literal substring (case-insensitive); regex iff it compiles and is ≤200 chars. */
  pattern?: string
  /** 'grep' only: stop after this many matching lines (default 100). */
  maxMatches?: number
}

const HEAD_TAIL_DEFAULT_LINES = 40
const GREP_DEFAULT_MAX_MATCHES = 100
// Hard scan budget for grep, counted in LINES (pure function — no wall clock):
// past this many lines we stop and say so, whatever maxMatches asked for.
const GREP_MAX_SCAN_LINES = 200_000
// A regex is only ever tested against this much of a line, so a pathological
// pattern (catastrophic backtracking) has a bounded input per match attempt.
const GREP_LINE_TEST_CAP = 2_000
const GREP_MAX_PATTERN_LEN = 200

/** The not-found message for a compacted id — shared verbatim by every reader. */
export function unknownCompactedId(id: string): string {
  return `No stored output for id "${id}" (only recent large outputs are retained — it may have been evicted). Re-run the command if you still need it.`
}

function clampInt(n: number | undefined, fallback: number, min: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback
  return Math.max(min, Math.floor(n))
}

/** UTF-8 byte length without Buffer (pure, portable). Approximate is fine for stats. */
function utf8Bytes(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4
  }
  return bytes
}

function renderLineRange(lines: string[], start1: number, end1: number, total: number): string {
  const body = lines.slice(start1 - 1, end1).join('\n')
  const more = end1 < total ? `; call expand_compacted with mode="lines", start=${end1 + 1} for more` : ''
  return `[lines ${start1}–${end1} of ${total}${more}]\n${body}`
}

/**
 * Grep matcher: literal case-insensitive substring by default. The pattern is
 * treated as a regex ONLY when it compiles and is short enough that a hostile
 * pattern stays cheap; the per-line input is capped either way, and any runtime
 * regex error on a line falls back to the literal test for that line.
 */
function buildMatcher(pattern: string): (line: string) => boolean {
  const literal = pattern.toLowerCase()
  const literalTest = (line: string) => line.toLowerCase().includes(literal)
  if (pattern.length > GREP_MAX_PATTERN_LEN) return literalTest
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    return literalTest // does not compile → literal
  }
  return (line: string) => {
    const probe = line.length > GREP_LINE_TEST_CAP ? line.slice(0, GREP_LINE_TEST_CAP) : line
    try {
      return re.test(probe)
    } catch {
      return literalTest(line)
    }
  }
}

function grepLines(lines: string[], pattern: string, maxMatches: number): string {
  const matches = buildMatcher(pattern)
  const emitted = new Set<number>() // 0-based indices already in the output
  const out: string[] = []
  let hits = 0
  let scanned = 0
  for (let i = 0; i < lines.length; i++) {
    if (++scanned > GREP_MAX_SCAN_LINES) {
      out.push(`[scan budget of ${GREP_MAX_SCAN_LINES} lines reached at line ${i} — narrow with mode="lines"]`)
      break
    }
    if (!matches(lines[i])) continue
    hits++
    // Matching line + 1 line of context each side; ":" marks the hit, "-" context.
    for (const j of [i - 1, i, i + 1]) {
      if (j < 0 || j >= lines.length || emitted.has(j)) continue
      emitted.add(j)
      out.push(`${j + 1}${j === i ? ':' : '-'} ${lines[j]}`)
    }
    if (hits >= maxMatches) {
      out.push(`[stopped at ${maxMatches} matches — refine the pattern or raise max_matches]`)
      break
    }
  }
  if (hits === 0) return `[no matches for "${pattern}" in ${lines.length} lines]`
  return `[${hits} matching line(s) for "${pattern}"]\n${out.join('\n')}`
}

/**
 * Query a stored compacted output by id. 'full' preserves the original paged
 * read (readCompactedSlice); the other modes answer targeted questions without
 * streaming the whole text back through the context window.
 */
export function queryCompacted(store: CompactedStore, id: string, q: CcrQuery = {}): string {
  const full = store.get(id)
  if (full === undefined) return unknownCompactedId(id)
  const mode = q.mode ?? 'full'
  if (mode === 'full') return readCompactedSlice(full, q.offset ?? 0, q.limit ?? DEFAULT_SLICE)
  if (mode === 'stats') {
    const lineCount = full.split('\n').length
    return `{lines: ${lineCount}, chars: ${full.length}, bytes~: ${utf8Bytes(full)}}`
  }
  const lines = full.split('\n')
  const total = lines.length
  switch (mode) {
    case 'head': {
      const n = Math.min(clampInt(q.limit, HEAD_TAIL_DEFAULT_LINES, 1), total)
      return renderLineRange(lines, 1, n, total)
    }
    case 'tail': {
      const n = Math.min(clampInt(q.limit, HEAD_TAIL_DEFAULT_LINES, 1), total)
      return renderLineRange(lines, total - n + 1, total, total)
    }
    case 'lines': {
      // 1-indexed inclusive [start, end], clamped into range (never an error).
      const start = Math.min(clampInt(q.start, 1, 1), total)
      const end = Math.min(Math.max(clampInt(q.end, total, 1), start), total)
      return renderLineRange(lines, start, end, total)
    }
    case 'grep': {
      const pattern = q.pattern ?? ''
      if (pattern === '') return '[grep mode requires a non-empty pattern]'
      return grepLines(lines, pattern, clampInt(q.maxMatches, GREP_DEFAULT_MAX_MATCHES, 1))
    }
    default:
      return unknownCompactedId(id) // unreachable with the typed mode union
  }
}

/**
 * The marker appended to an elided tool output, pointing at the stored full text.
 *
 * The wording is an "authoritative compaction" contract (steal: tokenjuice
 * WRAP_AUTHORITATIVE_FOOTER, STEAL 2026-07-07): without it, models re-run the
 * same command with varied flags trying to see the omitted middle — burning the
 * very tokens compaction saved. The footer names the ONE sanctioned recovery
 * path instead.
 */
export function compactionReceipt(id: string, fullLen: number, shownLen: number): string {
  return `\n\n[${fullLen - shownLen} of ${fullLen} chars elided by deterministic compaction; every high-signal line (errors, failures, file:line) was kept. This is the complete, authoritative output for this command — do NOT re-run it, vary flags, or switch tools to recover the omitted content. To read more, call expand_compacted({ id: "${id}" }).]`
}

/**
 * Same contract for the rare path where elision happened but no compacted store
 * exists (nothing to expand): still tell the model not to chase the omitted
 * lines by re-running.
 */
export function elisionNotice(fullLen: number, shownLen: number): string {
  return `\n\n[${fullLen - shownLen} of ${fullLen} chars elided by deterministic compaction; every high-signal line (errors, failures, file:line) was kept. This is the complete, authoritative output for this command — do NOT re-run it or vary flags to recover the omitted content.]`
}
