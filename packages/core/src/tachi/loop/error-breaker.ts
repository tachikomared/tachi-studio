// packages/core/src/tachi/loop/error-breaker.ts
//
// Error-signature circuit breaker for the TACHI agent loop (STEAL 2026-07-08,
// loop-engineering pattern — MIT). Complements stall.ts:
//
//   stall.ts        catches the SAME call repeated (identical fingerprint).
//   error-breaker   catches the SAME failure reached via DIFFERENT calls.
//
// A model that keeps hitting one underlying problem — "file not found" whether
// it reads, greps, or edits; "permission denied" across three paths; a compile
// error it keeps trying to patch differently — produces a fresh fingerprint
// each time, so stall.ts never trips, and it burns tokens flailing. This module
// reduces an error string to a stable SIGNATURE (concrete paths/numbers/hashes
// stripped) and reports when the recent tail has degenerated into the same
// signature N times, so the loop can inject a "you keep hitting this — change
// strategy" nudge listing what was already tried.
//
// Pure + dependency-free; same test style as stall.ts.

import type { StallVerdict } from '../contract.js'

/**
 * Reduce a tool-error message to a stable signature: lowercase, then blank out
 * the volatile specifics (absolute/rel paths, line:col, numbers, hex ids,
 * quoted literals, addresses) so two errors that are "the same kind of failure"
 * collapse to one signature. Returns '' for input with no error-like content.
 */
export function errorSignature(output: string): string {
  if (typeof output !== 'string' || output.trim() === '') return ''
  let s = output.toLowerCase()
  // Windows + POSIX paths → <path>
  s = s.replace(/[a-z]:\\[^\s"']*/g, '<path>')
  s = s.replace(/(?:\/[\w.-]+){2,}\/?/g, '<path>')
  // URLs → <url>
  s = s.replace(/https?:\/\/[^\s"']+/g, '<url>')
  // Hex ids / hashes (>=6 hex chars) → <hex>
  s = s.replace(/\b[0-9a-f]{6,}\b/g, '<hex>')
  // line:col and standalone numbers → <n>
  s = s.replace(/\b\d+:\d+\b/g, '<n>')
  s = s.replace(/\b\d+\b/g, '<n>')
  // Quoted literals (paths, identifiers the model varies) → <q>
  s = s.replace(/"[^"]*"/g, '<q>').replace(/'[^']*'/g, '<q>').replace(/`[^`]*`/g, '<q>')
  // Collapse whitespace, cap length so an enormous stack trace can't dominate.
  s = s.replace(/\s+/g, ' ').trim().slice(0, 200)
  return s
}

/**
 * Inspect a history of error signatures (oldest→newest; typically ONE entry per
 * FAILED tool call, successes omitted) and report whether the recent tail has
 * collapsed into a single repeating failure. Mirrors detectStall's shape but
 * over error classes rather than call fingerprints, so it fires when the model
 * keeps hitting the same wall via different actions.
 *
 * `stalled` iff the last `threshold` non-empty signatures are all equal.
 */
export function detectErrorLoop(signatures: string[], threshold = 3): StallVerdict {
  const sigs = signatures.filter(s => s !== '')
  const n = sigs.length
  if (n === 0) return { stalled: false, repeats: 0 }
  const last = sigs[n - 1]
  let repeats = 1
  for (let i = n - 2; i >= 0 && sigs[i] === last; i--) repeats++
  const stalled = threshold > 0 && repeats >= threshold
  return { stalled, repeats }
}

/**
 * Steering message injected when detectErrorLoop trips: names the repeated
 * failure and the DISTINCT actions already tried against it, and tells the
 * model to change strategy rather than keep flailing (deterministic — no LLM).
 * `recentTools` is the ordered list of tool names that produced the run.
 */
export function buildRepeatedErrorNudge(signature: string, count: number, recentTools: string[]): string {
  const tried = [...new Set(recentTools)].slice(-6)
  const via = tried.length > 1
    ? ` You have tried this via: ${tried.join(', ')}.`
    : ''
  return (
    `You have hit the SAME failure ${count} times: "${signature}".${via} ` +
    `Repeating with a different call will not help — the underlying problem is unchanged. ` +
    `Step back: re-examine an assumption (wrong path? missing prerequisite? wrong tool?), ` +
    `or if it cannot be resolved, call complete and report the blocker honestly.`
  )
}
