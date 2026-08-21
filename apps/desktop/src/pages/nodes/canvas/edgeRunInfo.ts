// apps/desktop/src/pages/nodes/canvas/edgeRunInfo.ts
//
// NODES-RESEARCH (EDGE RUN-INFO) — the "missing half" of the run overlay: the
// execution result overlays the SAME canvas, on the WIRES. After a node runs,
// each of its outgoing edges shows a tiny mid-edge chip with the size of the
// data that flowed through it (character count → an approx-token tooltip), and
// an error-edge that actually carried an error reads "ERR" in the danger color.
//
// This module is the PURE, side-effect-free core (no store, no React, no IPC)
// so the whole rule is unit-testable in isolation (test/unit/edgeRunInfo.test.ts).
// The chip is DERIVED at render time from the source node's `lastOutput` /
// `lastError` — nothing is persisted, so the serialized flow (stableFlowJson) is
// byte-for-byte untouched.

/**
 * Compact character-count label for the data flowing along an edge.
 *   0 / non-finite / negative → '' (caller renders no chip)
 *   < 1000                    → '<n> ch'         e.g. '842 ch'
 *   1000 … 9999               → '<n.n>k ch'      e.g. '1.2k ch' (trailing .0 dropped)
 *   >= 10000                  → '<n>k ch'        e.g. '42k ch'
 * "ch" is a universal unit abbreviation (like the '×' delete glyph on the edge),
 * so no i18n key is needed — the label stays pure numbers + unit.
 */
export function charCountLabel(len: number): string {
  if (!Number.isFinite(len) || len <= 0) return ''
  const n = Math.round(len)
  if (n < 1000) return `${n} ch`
  const k = n / 1000
  const num = k < 10
    // 1 decimal place; JS number→string drops a trailing .0 (1.0 → '1').
    ? (Math.round(k * 10) / 10).toString()
    : Math.round(k).toString()
  return `${num}k ch`
}

/**
 * Rough token estimate for a character count (~4 chars/token — the usual
 * back-of-envelope for English/code). Used only for the chip's hover tooltip so
 * it stays pure units ("… · ~N tok"). Never 0 for a non-empty payload.
 */
export function approxTokens(len: number): number {
  if (!Number.isFinite(len) || len <= 0) return 0
  return Math.max(1, Math.round(len / 4))
}

/** The chip an edge should render, or null when it should render nothing. */
export interface EdgeRunChip {
  /** Uppercase micro-label: a size like '1.2k ch', or the literal 'ERR'. */
  text: string
  /** Paint in the danger color (an error-edge that carried an error). */
  danger: boolean
}

/**
 * Decide the mid-edge run-info chip from the SOURCE node's run state.
 *
 *   • error-edge (sourceHandle === 'err'): shows 'ERR' ONLY while the source
 *     node actually holds an error (it just routed that error downstream);
 *     otherwise nothing — a run that succeeded routed no error down this wire.
 *   • normal edge: shows the character count of the source's last output; empty
 *     output (never run, or cleared on failure) → no chip.
 *
 * Pure — depends only on its inputs, so the exact rule is pinned by the tests.
 */
export function edgeRunChip(input: {
  isError: boolean
  hasError: boolean
  outLen: number
}): EdgeRunChip | null {
  const { isError, hasError, outLen } = input
  if (isError) {
    return hasError ? { text: 'ERR', danger: true } : null
  }
  const label = charCountLabel(outLen)
  return label ? { text: label, danger: false } : null
}

/**
 * Hover tooltip for a run-info chip — pure units, so no i18n is needed.
 *   error chip → 'ERR · <len> ch'   (len = error-text length)
 *   size chip  → '<len> ch · ~<tok> tok'
 */
export function edgeRunTooltip(chip: EdgeRunChip, len: number): string {
  const n = Number.isFinite(len) && len > 0 ? Math.round(len) : 0
  return chip.danger ? `ERR · ${n} ch` : `${n} ch · ~${approxTokens(n)} tok`
}
