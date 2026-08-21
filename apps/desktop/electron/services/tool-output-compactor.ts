// apps/desktop/electron/services/tool-output-compactor.ts
//
// Sprint D2 — Per-tool-result compaction.
//
// Sidecar agents like OpenClaude emit tool-done events whose stdout/stderr
// can reach hundreds of KB (find dumps, npm install logs, grep matches).
// Flooding the context window with raw output both wastes tokens and degrades
// model attention on the signal lines.
//
// This module compacts each tool result deterministically — no LLM in the loop —
// before the event is forwarded to the renderer and before it is written to the
// checkpoint. The raw bytes are preserved in the network audit log; only the
// in-flight and persisted copies are compacted.
//
// AUTHORITATIVE FOOTER RATIONALE
// --------------------------------
// Without an explicit statement that the output is complete, the model may
// assume truncation occurred and re-issue the command to retrieve the "rest".
// Every compacted result therefore ends with a fixed footer declaring that the
// omitted content is low-signal noise and the command must not be re-run.
// The text is intentionally machine-parseable and distinct from normal output so
// it cannot be confused with actual tool output.

import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompactInput {
  toolName: string
  stdout:   string
  stderr:   string
  exitCode: number
}

export interface CompactResult {
  /** The final text to replace event.output with. */
  inlineText:     string
  /** Human-readable rule id that was applied, e.g. "npm/install". */
  classification: string
  stats: {
    rawChars:     number
    reducedChars: number
    ratio:        number    // reducedChars / rawChars, 1.0 means no reduction
  }
  /** The exact footer appended — exposed so callers can strip it in tests. */
  footer: string
}

interface RuleTransforms {
  stripAnsi:      boolean
  dedupeAdjacent: boolean
}

interface RuleWindow {
  /** Lines to keep from the start. 0 means keep none (used with alwaysFull). */
  head:     number
  /** Lines to keep from the end. 0 means keep none (used with alwaysFull). */
  tail:     number
  /** Hard char cap applied after head/tail slice. 0 means unlimited. */
  maxChars: number
}

interface CompactionRule {
  id:               string
  matches: {
    toolName:        string
    stdoutContains?: string[]
  }
  transforms:       RuleTransforms
  success:          RuleWindow
  failure:          RuleWindow
  /** When true, never truncate on non-zero exit even if failure window is set. */
  preserveOnFailure?: boolean
  /** When true, never truncate regardless of exit code (e.g. git-status). */
  alwaysFull?:        boolean
  /** Optional suffix when find-style "cap N" truncation drops lines. */
  suffixOnTruncation?: string
  /**
   * tokenjuice-style whole-output short-circuit. When the combined output matches
   * one of these case-insensitive regexes, the entire result is collapsed to the
   * one-line `replacement` (the verbose body is known-benign noise). Evaluated
   * after transforms, before windowing. First match wins. This is lossy, so it
   * carries the authoritative footer + content id.
   */
  matchOutput?: Array<{ pattern: string; replacement: string }>
}

// ── Authoritative footer ──────────────────────────────────────────────────────

const AUTHORITATIVE_FOOTER =
  '[tachi-compactor] This is the complete, authoritative output. It was ' +
  'deterministically compacted to remove low-signal noise; the omitted ' +
  'content is not retrievable. Do not re-run the command for the same input.'

/** First 12 hex of sha256(text) — a stable content id (tokenjuice receipt). */
function contentId(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * The footer for a LOSSY result: the authoritative notice plus a stable content
 * id so the model can recognise that a re-run produced the same output (and
 * therefore must not re-run to "get the rest").
 */
function lossyFooter(id: string): string {
  return `${AUTHORITATIVE_FOOTER} [content id sha256:${id} — a re-run yields the same id.]`
}

// ── Rule loading ──────────────────────────────────────────────────────────────

// Rules are loaded once at module init and cached. The directory is resolved
// relative to this file's compiled output location in the same way that
// playbook-service resolves its data directory — using __dirname.
//
// Load order matters for rule priority:
//   1. More-specific rules first (npm-install, grep, find, git-status)
//   2. bash-default before generic-fallback
//   3. generic-fallback last (wildcard toolName "*")

const RULES_DIR = join(__dirname, 'tool-output-rules')

const PREFERRED_ORDER = [
  'npm-install',
  'grep',
  'find',
  'git-status',
  'bash-default',
  'generic-fallback',
]

let _cachedRules: CompactionRule[] | null = null

function loadRules(): CompactionRule[] {
  if (_cachedRules) return _cachedRules

  if (!existsSync(RULES_DIR)) {
    console.warn('[compactor] tool-output-rules directory not found at:', RULES_DIR)
    _cachedRules = []
    return _cachedRules
  }

  const allFiles = readdirSync(RULES_DIR).filter(f => f.endsWith('.json'))

  // Sort by preferred order; unknown names go after the known set.
  allFiles.sort((a, b) => {
    const ai = PREFERRED_ORDER.indexOf(a.replace('.json', ''))
    const bi = PREFERRED_ORDER.indexOf(b.replace('.json', ''))
    const av = ai === -1 ? PREFERRED_ORDER.length : ai
    const bv = bi === -1 ? PREFERRED_ORDER.length : bi
    return av - bv
  })

  const rules: CompactionRule[] = []
  for (const file of allFiles) {
    try {
      const raw = readFileSync(join(RULES_DIR, file), 'utf-8')
      const rule = JSON.parse(raw) as CompactionRule
      rules.push(rule)
    } catch (err) {
      console.warn('[compactor] failed to parse rule file:', file, err)
    }
  }

  _cachedRules = rules
  return rules
}

// ── Rule matching ─────────────────────────────────────────────────────────────

function matchesRule(rule: CompactionRule, input: CompactInput): boolean {
  const { toolName: ruleToolName, stdoutContains } = rule.matches

  // Wildcard tool name matches everything.
  if (ruleToolName !== '*' && ruleToolName.toLowerCase() !== input.toolName.toLowerCase()) {
    return false
  }

  // If the rule requires certain strings in stdout, at least one must appear.
  if (stdoutContains && stdoutContains.length > 0) {
    const combined = input.stdout + input.stderr
    const found = stdoutContains.some(s => combined.includes(s))
    if (!found) return false
  }

  return true
}

function pickRule(input: CompactInput, rules: CompactionRule[]): CompactionRule {
  for (const rule of rules) {
    if (matchesRule(rule, input)) return rule
  }

  // Safety net — this can only happen if generic-fallback.json is missing.
  console.warn('[compactor] no rule matched for toolName:', input.toolName, '— using inline fallback')
  return {
    id:       'generic/inline-fallback',
    matches:  { toolName: '*' },
    transforms: { stripAnsi: true, dedupeAdjacent: true },
    success:  { head: 8, tail: 8, maxChars: 4000 },
    failure:  { head: 12, tail: 20, maxChars: 6000 },
    preserveOnFailure: true,
  }
}

// ── Text transforms ───────────────────────────────────────────────────────────

// Matches the most common ANSI CSI escape sequences produced by terminal output.
// Covers color codes, cursor movement, and SGR attributes.
const ANSI_RE = /\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|[()][A-B0-1]|[^[\]()NOPQRSTUVWXYZ\\^_`{|}~])/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

function dedupeAdjacentLines(lines: string[]): string[] {
  const result: string[] = []
  let prev: string | undefined
  for (const line of lines) {
    if (line !== prev) {
      result.push(line)
    }
    prev = line
  }
  return result
}

// ── Head/tail slicer ──────────────────────────────────────────────────────────

/**
 * Keep the top `headLines` and bottom `tailLines` from `text`.
 * Inserts `[... omitted N lines ...]` between them when the middle is removed.
 * Returns text unchanged when the total line count is <= headLines + tailLines.
 *
 * Exported for unit-level smoke testing:
 *
 * headTail("a\nb\nc\nd\ne", 2, 2)
 *   => "a\nb\n[... omitted 1 lines ...]\nd\ne"
 *
 * headTail("a\nb\nc", 2, 2)
 *   => "a\nb\nc"   (only 3 lines, no omission marker)
 */
export function headTail(text: string, headLines: number, tailLines: number): string {
  if (!text) return text
  const lines = text.split('\n')
  const total = lines.length
  const window = headLines + tailLines

  // No truncation needed when the text is short enough.
  if (total <= window || window === 0) return text

  const head = headLines > 0 ? lines.slice(0, headLines) : []
  const tail = tailLines > 0 ? lines.slice(total - tailLines) : []
  const omitted = total - headLines - tailLines

  const parts: string[] = []
  if (head.length > 0) parts.push(head.join('\n'))
  parts.push(`[... omitted ${omitted} lines ...]`)
  if (tail.length > 0) parts.push(tail.join('\n'))

  return parts.join('\n')
}

// ── Hard char cap ─────────────────────────────────────────────────────────────

function applyCharCap(text: string, maxChars: number, omittedSuffix?: string): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  const kept   = text.slice(0, maxChars)
  const excess = text.length - maxChars
  const note   = omittedSuffix
    ? omittedSuffix.replace('{n}', String(excess))
    : `[... ${excess} chars omitted by char cap ...]`
  return kept + '\n' + note
}

// ── JSON-aware crusher (headroom-inspired, CLEAN-ROOM) ─────────────────────────
//
// The blind head/tail slicer above is JSON-illiterate: given an API/tool payload
// that is one big array of similar records, it keeps the first N lines and drops
// the structural tail (the closing brackets, the shape). A model then re-issues
// the call chasing the "rest". This crusher instead reshapes the PARSED value:
//
//   • arrays of similar objects  → keep the first `headItems` + last `tailItems`,
//     replace the omitted middle with ONE marker string that also carries the
//     union key-schema ("[… K similar items crushed · keys: a, b, c]").
//   • oversized string fields    → truncated to `maxStringLen` with an explicit
//     "…[+N chars truncated]" marker.
//   • depth/size budget          → containers deeper than `maxDepth` collapse to
//     a one-line summary marker, so a pathologically nested giant can't blow the
//     budget.
//
// The result is re-serialised with JSON.stringify (2-space indent). Because every
// marker is itself a JSON string, the output stays VALID, parseable JSON — just
// smaller. Fully deterministic: same input → same bytes (keys sorted, no clocks,
// no randomness). Returns null when the text is not parseable JSON, signalling
// the caller to fall through to the existing head/tail path untouched.

export interface CrushOptions {
  /** Array elements kept from the front (default 5). */
  headItems?:    number
  /** Array elements kept from the back (default 2). */
  tailItems?:    number
  /** String fields longer than this are truncated (default 200). */
  maxStringLen?: number
  /** Containers nested deeper than this collapse to a summary marker (default 6). */
  maxDepth?:     number
}

export interface CrushResult {
  /** The crushed, still-valid-JSON text. */
  text:    string
  /** True iff the structure was actually reduced (else the caller should not prefer it). */
  crushed: boolean
}

const CRUSH_DEFAULTS: Required<CrushOptions> = {
  headItems:    5,
  tailItems:    2,
  maxStringLen: 200,
  maxDepth:     6,
}

/**
 * Fallback "over the compaction threshold" size (chars) used only when the matched
 * rule sets no char cap (maxChars === 0, i.e. unlimited). When a rule DOES set a
 * cap, that cap is the threshold — a JSON payload only gets crushed once it would
 * have been truncated anyway.
 */
const CRUSH_THRESHOLD = 2000

/** JSON type label for one value (used in the primitive-array schema summary). */
function typeLabel(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v // 'string' | 'number' | 'boolean' | 'object'
}

/**
 * Describe the shape of a crushed array as a single line. For an array of
 * objects: the sorted UNION of their keys ("keys: a, b, c"). For primitives:
 * the sorted set of element types ("type: number"). Deterministic (sorted).
 */
function arraySchema(arr: unknown[]): string {
  const keys = new Set<string>()
  const prims = new Set<string>()
  let objCount = 0
  for (const el of arr) {
    if (el !== null && typeof el === 'object' && !Array.isArray(el)) {
      objCount++
      for (const k of Object.keys(el as Record<string, unknown>)) keys.add(k)
    } else {
      prims.add(typeLabel(el))
    }
  }
  if (objCount === arr.length && keys.size > 0) {
    return `keys: ${[...keys].sort().join(', ')}`
  }
  if (objCount === 0 && prims.size > 0) {
    return `type: ${[...prims].sort().join('|')}`
  }
  return `keys: ${[...keys].sort().join(', ')} · type: ${[...prims].sort().join('|')}`.trim()
}

/** One-line summary when a container is pruned at the depth budget. */
function depthMarker(v: unknown): string {
  if (Array.isArray(v)) return `[… pruned: array of ${v.length} items beyond depth budget]`
  const n = Object.keys(v as Record<string, unknown>).length
  return `[… pruned: object with ${n} keys beyond depth budget]`
}

/** Recursively crush one value. `flag.on` is set true whenever anything is reduced. */
function crushValue(value: unknown, depth: number, opts: Required<CrushOptions>, flag: { on: boolean }): unknown {
  // Strings: truncate oversized ones with an explicit marker.
  if (typeof value === 'string') {
    if (value.length > opts.maxStringLen) {
      flag.on = true
      return value.slice(0, opts.maxStringLen) + `…[+${value.length - opts.maxStringLen} chars truncated]`
    }
    return value
  }

  // Primitives (number/boolean/null) are cheap — keep verbatim.
  if (value === null || typeof value !== 'object') return value

  // Containers past the depth budget collapse to a one-line summary.
  if (depth >= opts.maxDepth) {
    flag.on = true
    return depthMarker(value)
  }

  if (Array.isArray(value)) {
    const n = value.length
    if (n > opts.headItems + opts.tailItems) {
      flag.on = true
      const K = n - opts.headItems - opts.tailItems
      const head = value.slice(0, opts.headItems).map(v => crushValue(v, depth + 1, opts, flag))
      const tail = value.slice(n - opts.tailItems).map(v => crushValue(v, depth + 1, opts, flag))
      const marker = `[… ${K} similar items crushed · ${arraySchema(value)}]`
      return [...head, marker, ...tail]
    }
    return value.map(v => crushValue(v, depth + 1, opts, flag))
  }

  // Plain object — recurse into each value, preserving key order.
  const src = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(src)) out[k] = crushValue(src[k], depth + 1, opts, flag)
  return out
}

/**
 * JSON-aware structural compaction. Returns null when `text` is not valid JSON
 * (the caller keeps its existing behaviour); otherwise the reshaped, still-valid
 * JSON text plus a `crushed` flag indicating whether anything was reduced.
 */
export function crushJson(text: string, opts: CrushOptions = {}): CrushResult | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null // not JSON (or malformed) — signal the caller to fall back
  }
  const o: Required<CrushOptions> = { ...CRUSH_DEFAULTS, ...opts }
  const flag = { on: false }
  const crushedValue = crushValue(parsed, 0, o, flag)
  return { text: JSON.stringify(crushedValue, null, 2), crushed: flag.on }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Compact a tool result deterministically.
 *
 * The returned `inlineText` should replace `event.output` on both the
 * outgoing renderer push AND the checkpoint write. The raw bytes in the
 * network audit log must NOT be touched.
 *
 * Never throws — any internal error is caught and the raw combined output is
 * returned with the classification set to "error/passthrough".
 */
export function compactToolOutput(input: CompactInput): CompactResult {
  const rawChars = input.stdout.length + input.stderr.length

  try {
    return _compact(input, rawChars)
  } catch (err) {
    console.warn('[compactor] unexpected error in compactToolOutput (passthrough):', err)
    const raw = [input.stdout, input.stderr].filter(Boolean).join('\n')
    // Passthrough is NOT lossy — return the raw output verbatim with no footer.
    return {
      inlineText:     raw,
      classification: 'error/passthrough',
      stats: { rawChars, reducedChars: raw.length, ratio: 1 },
      footer: '',
    }
  }
}

/** Assemble a CompactResult; append the lossy footer + content id only when lossy. */
function finish(text: string, lossy: boolean, id: string, classification: string, rawChars: number): CompactResult {
  const footer = lossy ? lossyFooter(id) : ''
  const inlineText = lossy ? `${text}\n\n${footer}` : text
  return {
    inlineText,
    classification,
    stats: {
      rawChars,
      reducedChars: inlineText.length,
      ratio: rawChars > 0 ? inlineText.length / rawChars : 1,
    },
    footer,
  }
}

function _compact(input: CompactInput, rawChars: number): CompactResult {
  const rules = loadRules()
  const rule  = pickRule(input, rules)
  const isSuccess = input.exitCode === 0

  // Combine stdout + stderr into a single text blob, stdout first.
  const rawCombined = [input.stdout, input.stderr].filter(Boolean).join('\n')
  const id = contentId(rawCombined)
  let text = rawCombined

  // Apply ANSI stripping.
  if (rule.transforms.stripAnsi) {
    text = stripAnsi(text)
  }

  // Split into lines for per-line transforms.
  let lines = text.split('\n')

  // Deduplicate adjacent identical lines (e.g. npm progress bars repeating).
  if (rule.transforms.dedupeAdjacent) {
    lines = dedupeAdjacentLines(lines)
  }

  text = lines.join('\n')

  // tokenjuice matchOutput short-circuit: a whole-output regex collapses a
  // known-benign verbose result to one line. This IS lossy (carries footer+id).
  if (rule.matchOutput) {
    for (const { pattern, replacement } of rule.matchOutput) {
      try {
        if (new RegExp(pattern, 'i').test(text)) {
          return finish(replacement, true, id, rule.id, rawChars)
        }
      } catch { /* a malformed rule pattern is non-fatal — skip it */ }
    }
  }

  // The post-transform text is the baseline we compare against to decide whether
  // windowing actually dropped anything (= lossy). ANSI-strip / dedupe are
  // noise-removal, not truncation, so they alone do NOT trigger the footer.
  const transformed = text

  // If the rule says always keep full output, skip all window/char-cap logic.
  if (rule.alwaysFull) {
    return finish(text, false, id, rule.id, rawChars)
  }

  // On failure, if preserveOnFailure is set, skip window truncation but still
  // apply the char cap (to prevent pathological cases from bypassing the cap).
  const window = isSuccess ? rule.success : rule.failure

  if (!isSuccess && rule.preserveOnFailure) {
    text = applyCharCap(text, rule.failure.maxChars, rule.suffixOnTruncation)
  } else {
    // JSON-aware crush (headroom-inspired), PREFERRED over the blind head/tail:
    // when the payload parses as JSON and is over the compaction threshold, reshape
    // it structurally (repetitive arrays → head+tail+marker, long strings truncated,
    // deep containers pruned) instead of a byte-blind slice that would shred the
    // structure. Non-JSON / malformed → crushJson returns null → head/tail as before.
    const threshold = window.maxChars > 0 ? window.maxChars : CRUSH_THRESHOLD
    const crushed = text.length > threshold ? crushJson(text) : null
    // The blind head/tail result is always computed as the comparison baseline.
    const htText = applyCharCap(headTail(text, window.head, window.tail), window.maxChars, rule.suffixOnTruncation)
    if (crushed && crushed.crushed) {
      // Size-budget backstop: a crushed head can still be large — keep the same
      // hard char cap the head/tail path would have applied.
      const crushedText = applyCharCap(crushed.text, window.maxChars, rule.suffixOnTruncation)
      // Prefer the JSON-aware crush, but never make the payload larger than the
      // blind slice would (pretty-printing a borderline case can inflate it).
      text = crushedText.length <= htText.length ? crushedText : htText
    } else {
      text = htText
    }
  }

  // Lossy iff windowing changed the text (dropped lines / capped chars).
  const lossy = text !== transformed
  return finish(text, lossy, id, rule.id, rawChars)
}

/*
 * ── Smoke test (mental run, no test framework) ────────────────────────────────
 *
 * headTail("a\nb\nc\nd\ne", 2, 2)
 *   lines = ["a","b","c","d","e"], total=5, window=4, omitted=1
 *   expected: "a\nb\n[... omitted 1 lines ...]\nd\ne"
 *
 * headTail("a\nb\nc", 2, 2)
 *   total=3, window=4, 3 <= 4 => return unchanged: "a\nb\nc"
 *
 * compactToolOutput({ toolName: "Bash", stdout: "x\n".repeat(200), stderr: "", exitCode: 0 })
 *   rawChars = 400
 *   rule = bash-default (head:8, tail:8, maxChars:4000)
 *   after headTail: 8 + 1 + 8 = 17 lines
 *   reducedChars << 400
 *   inlineText ends with AUTHORITATIVE_FOOTER
 *
 * compactToolOutput({ toolName: "UnknownTool", stdout: "x", stderr: "", exitCode: 0 })
 *   no specific rule matches -> generic-fallback.json picked
 *   classification = "generic/fallback"
 */
