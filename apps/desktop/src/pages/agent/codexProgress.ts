// apps/desktop/src/pages/agent/codexProgress.ts
//
// The Codex vertical's PURE seam: which tool names belong to the codex family,
// and how the worker's live progress lines get out of the flat text stream and
// into the card that owns them.
//
// WHY THIS EXISTS
// ---------------
// loop.ts streams worker progress as ordinary transcript text:
//
//     onProgress: (line) => onEventSafe(opts.onEvent, { type: 'text', text: `[codex] ${line}\n` })
//
// so every "$ npm test" / "edit src/foo.ts" line lands as an AgentEvent of type
// 'text' — OUTSIDE the tool-call/tool-done pair, and (because agent.store
// coalesces consecutive text chunks) usually merged into one grey prose block
// sitting under the still-running codex card. The user asked for the opposite:
// the progress belongs INSIDE the card that produced it.
//
// pairToolEvents consumes these helpers to re-route those lines onto the open
// codex ToolBlock. Everything here is framework-free and unit-tested
// (test/unit/codexProgress.test.ts) — the routing decision must be provable
// without mounting a transcript.

/** The two tools the Codex sidecar exposes to the harness. */
export type CodexToolKind = 'worker' | 'review'

/**
 * Classify a harness-reported tool name as a codex tool.
 *
 * Tolerates the fan-out child prefix ("[2] codex_worker") the parent transcript
 * adds, and the `codex-worker` spelling, same as ToolCallBlock's family matcher.
 * Returns null for everything else — the caller then keeps generic behaviour.
 */
export function codexToolKind(name: unknown): CodexToolKind | null {
  if (typeof name !== 'string') return null
  const n = name.trim().replace(/^\[\d+\]\s*/, '')
  if (/^codex[_-]?worker$/i.test(n)) return 'worker'
  if (/^codex[_-]?review$/i.test(n)) return 'review'
  return null
}

/** True for any tool whose progress + result the codex cards render. */
export function isCodexFamilyTool(name: unknown): boolean {
  return codexToolKind(name) !== null
}

/** The prefix loop.ts stamps on every forwarded worker progress line. */
export const CODEX_PROGRESS_PREFIX = '[codex] '

const PROGRESS_LINE_RE = /^\s*\[codex\]\s?(.*)$/

/**
 * How many progress lines a single card keeps. The worker itself caps its
 * `progress` array at 200 (codex-worker.ts); matching that here keeps a long
 * run's memory bounded without ever truncating a run the worker considered
 * complete.
 */
export const PROGRESS_CAP = 200

export interface CodexProgressSplit {
  /** Progress lines, prefix stripped, in arrival order. */
  progress: string[]
  /** Whatever else the text block carried, blank edges trimmed. */
  rest: string
}

/**
 * Split a transcript text blob into codex progress lines and the remainder.
 *
 * A text block is usually ALL progress (the store coalesced N forwarded lines
 * into one message), but it can be mixed when the model streamed prose in the
 * same window. Mixed blocks keep their non-progress half as a normal text
 * event — routing must never eat transcript.
 */
export function splitCodexProgress(text: unknown): CodexProgressSplit {
  if (typeof text !== 'string' || !text) return { progress: [], rest: typeof text === 'string' ? text : '' }
  if (!text.includes(CODEX_PROGRESS_PREFIX.trimEnd())) return { progress: [], rest: text }

  const progress: string[] = []
  const rest: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const m = raw.match(PROGRESS_LINE_RE)
    if (m) {
      const line = m[1].trimEnd()
      if (line) progress.push(line)
      continue
    }
    rest.push(raw)
  }
  while (rest.length && !rest[0].trim()) rest.shift()
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop()
  return { progress, rest: rest.join('\n') }
}

/**
 * Append new progress lines to a card's buffer, dropping a repeat of the line
 * already at the tail (the worker de-dupes consecutive events, but a resumed
 * stream can re-send its last one) and capping the buffer.
 */
export function appendProgress(existing: string[] | undefined, lines: string[]): string[] {
  const out = existing ? existing.slice() : []
  for (const line of lines) {
    if (out.length && out[out.length - 1] === line) continue
    out.push(line)
  }
  return out.length > PROGRESS_CAP ? out.slice(out.length - PROGRESS_CAP) : out
}

/** What a progress line is talking about — drives the row's glyph + colour. */
export type ProgressKind = 'command' | 'edit' | 'error' | 'note'

/**
 * Classify one progress line. Mirrors summarizeEvent() in codex-worker-core.ts,
 * which emits "$ <cmd>", "edit <path>", "error: <msg>" or a bare event type.
 */
export function classifyProgress(line: unknown): ProgressKind {
  if (typeof line !== 'string') return 'note'
  const s = line.trim()
  if (/^\$\s+/.test(s)) return 'command'
  if (/^edit\s+\S/i.test(s)) return 'edit'
  if (/^error\b/i.test(s)) return 'error'
  return 'note'
}

/** Strip the leading marker so the row can render its own glyph. */
export function progressBody(line: string): string {
  return line.replace(/^\s*\$\s+/, '').trimEnd()
}

export interface ProgressTail {
  /** The lines to render, oldest first. */
  shown: string[]
  /** How many older lines were dropped (rendered as a "+N earlier" hint). */
  hidden: number
}

/** Keep the newest `max` lines; report how many scrolled out of view. */
export function progressTail(lines: readonly string[], max = 8): ProgressTail {
  if (max <= 0) return { shown: [], hidden: lines.length }
  if (lines.length <= max) return { shown: [...lines], hidden: 0 }
  return { shown: lines.slice(lines.length - max), hidden: lines.length - max }
}

/**
 * Whether the card should render its PROGRESS strip.
 *
 * While the worker runs, progress IS the card's content. Once the result lands
 * the card must end in its TERMINAL state — the answer, findings and step
 * summary supersede the live feed — so the strip retires. The one exception is
 * a result that carried no detail at all (empty answer, no steps): then the
 * progress is the only evidence the run left behind and dropping it would lose
 * information.
 */
export function shouldShowProgress(o: {
  running: boolean
  hasResultDetail: boolean
  progressCount: number
}): boolean {
  if (o.progressCount <= 0) return false
  if (o.running) return true
  return !o.hasResultDetail
}
