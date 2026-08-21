// packages/core/src/tachi/tools/signal-compact.ts
//
// SIGNAL-scored tool-output compaction (steal: h5i token_filter, Apache-2.0,
// reimplemented). The flat HEAD+TAIL truncateOutput is great for a uniform log
// but it DROPS the lines that matter most when they sit in the middle — the one
// `error TS2322` in a 4000-line build, the panic line, the failing assertion.
//
// signalCompact scores every line 0..1 (panic/error/assert = high, progress
// dots/blank/percent noise = low), then keeps the head + the tail + EVERY
// high-signal middle line (capped), eliding contiguous low-signal runs with a
// `[... N lines elided ...]` marker and a single sha256 receipt so an identical
// rerun is recognisable and the model knows the full bytes still exist.
//
// Pure: only node:crypto for the receipt. No fs, no network.

import { createHash } from 'node:crypto'
import type { TruncateResult } from '../contract.js'

export interface SignalCompactOptions {
  /** Compact only when the output exceeds this many lines (default 200). */
  maxLines?: number
  /** Hard char budget for the kept content; lowest-signal middle lines are dropped to fit (default 40_000). */
  maxChars?: number
  /** Always keep this many leading lines (default 24). */
  headLines?: number
  /** Always keep this many trailing lines (default 24). */
  tailLines?: number
  /** Cap on extra high-signal middle lines kept (default 80). */
  maxSignalLines?: number
  /** Clip any single kept line to this many chars (default 600). */
  maxLineChars?: number
  /** Keep middle lines scoring >= this (default 0.8). */
  signalThreshold?: number
}

const D = { maxLines: 200, maxChars: 40_000, headLines: 24, tailLines: 24, maxSignalLines: 80, maxLineChars: 600, signalThreshold: 0.8 }

/**
 * Signal score of one line, 0 (pure noise) .. 1 (must-keep). Ordered so the
 * strongest signal wins. Heuristic + deterministic; no allocations beyond regex.
 */
export function scoreLine(line: string): number {
  const l = line.toLowerCase()
  if (/\b(panic|fatal|segfault|core dumped|traceback|unhandled|assertionerror|stack overflow)\b/.test(l)) return 1.0
  if (/\berror\b|\bexception\b|\bfailed\b|\bfailure\b|\b err!|✗|✖|×|\bnot ok\b/.test(l)) return 0.95
  if (/error ts\d+|\be\d{3,}\b|\bexit code\b|\bexit status\b|rejected|denied/.test(l)) return 0.9
  if (/[\w./@-]+:\d+:\d+|[\w./@-]+\(\d+,\d+\)/.test(line)) return 0.85 // file:line:col or tsc (l,c)
  if (/\bwarn(ing)?\b|deprecat|\btodo\b|\bfixme\b/.test(l)) return 0.6
  if (/[\w./@-]+:\d+\b/.test(line)) return 0.55 // file:line
  if (line.trim() === '') return 0.05
  if (/^[\s.>%#=_*+\-]+$/.test(line) || /\b\d{1,3}%/.test(line) || /\b(downloading|installing|fetching|resolving|building|compiling|\bget\b|\bput\b)\b/i.test(l)) return 0.15
  return 0.4
}

/**
 * Keep head + tail + every high-signal middle line (capped), eliding low-signal
 * runs. Returns the same shape as truncateOutput; verbatim + truncated:false when
 * the output is within the line and char budgets.
 */
export function signalCompact(text: string, opts: SignalCompactOptions = {}): TruncateResult {
  const maxLines = opts.maxLines ?? D.maxLines
  const maxChars = opts.maxChars ?? D.maxChars
  const headLines = opts.headLines ?? D.headLines
  const tailLines = opts.tailLines ?? D.tailLines
  const maxSignalLines = opts.maxSignalLines ?? D.maxSignalLines
  const maxLineChars = opts.maxLineChars ?? D.maxLineChars
  const threshold = opts.signalThreshold ?? D.signalThreshold

  const originalChars = text.length
  const lines = text.split('\n')
  if (lines.length <= maxLines && originalChars <= maxChars) {
    return { text, truncated: false, originalChars, keptChars: originalChars }
  }

  const hash = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  const clip = (s: string) => (s.length > maxLineChars ? `${s.slice(0, maxLineChars - 1)}…` : s)

  // 1. Always-keep head + tail.
  const keep = new Set<number>()
  for (let i = 0; i < Math.min(headLines, lines.length); i++) keep.add(i)
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i++) keep.add(i)

  // 2. High-signal middle lines, highest score first, up to the cap.
  const midStart = Math.min(headLines, lines.length)
  const midEnd = Math.max(midStart, lines.length - tailLines)
  const scored: Array<{ i: number; s: number }> = []
  for (let i = midStart; i < midEnd; i++) {
    const s = scoreLine(lines[i]!)
    if (s >= threshold) scored.push({ i, s })
  }
  scored.sort((a, b) => b.s - a.s || a.i - b.i)
  let signalKept = 0
  for (const { i } of scored) {
    if (signalKept >= maxSignalLines) break
    keep.add(i); signalKept++
  }

  // 3. Enforce the char budget: drop the lowest-signal MIDDLE kept lines (never
  //    head/tail) until the kept content fits.
  const charsOf = (idx: number) => clip(lines[idx]!).length + 1
  let keptChars = [...keep].reduce((n, i) => n + charsOf(i), 0)
  if (keptChars > maxChars) {
    const droppable = [...keep]
      .filter(i => i >= midStart && i < midEnd)
      .map(i => ({ i, s: scoreLine(lines[i]!) }))
      .filter(x => x.s < 0.9) // errors/panics/asserts are sacrosanct — never dropped for budget
      .sort((a, b) => a.s - b.s || b.i - a.i) // lowest signal first
    for (const { i } of droppable) {
      if (keptChars <= maxChars) break
      keep.delete(i); keptChars -= charsOf(i); signalKept = Math.max(0, signalKept - 1)
    }
  }

  // 4. Render in document order, eliding contiguous gaps.
  const out: string[] = []
  let gap = 0
  let elided = 0
  const flush = () => { if (gap > 0) { out.push(`[... ${gap} low-signal lines elided ...]`); elided += gap; gap = 0 } }
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) { flush(); out.push(clip(lines[i]!)) } else gap++
  }
  flush()
  out.push(`[signal-compacted: ${elided} lines elided, ${signalKept} high-signal kept — sha256:${hash} — full output out of band; do not re-run to retrieve]`)

  const result = out.join('\n')
  return { text: result, truncated: true, contentHash: hash, originalChars, keptChars: result.length }
}
