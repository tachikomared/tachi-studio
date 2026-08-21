// apps/desktop/src/pages/nodes/canvas/fanout.ts
//
// FAN-OUT xN (flowith "batch quantity") — the PURE core of running a PROMPT or
// MEDIA node N times into N separate sibling result cards. Kept store-, React-
// and i18n-free so the geometry + keying can be unit-tested in isolation
// (test/unit/fanout.test.ts); the store action (upsertOutputNode) and the hook
// (useNodeRun) drive it.
//
// Why this exists: generating N variations (most valuable for local sd.cpp
// seeds — one prompt, four seeds, four images side by side) is a one-verb
// gesture. A tiny x1/x2/x4 cycle-chip next to RUN sets the count; RUN then
// executes the single-run path N times SEQUENTIALLY and lands the results as
// ordinary output cards fanned out in a row. x1 keeps today's exact behavior.

/** The cycle-chip steps: x1 (single, today's behavior), x2, x4 sibling runs. */
export const FANOUT_STEPS = [1, 2, 4] as const
export type FanoutCount = (typeof FANOUT_STEPS)[number]

/**
 * Advance the cycle-chip: 1 → 2 → 4 → 1. An off-cycle value (should never
 * happen, but a stale persisted value could) resolves to the first step.
 */
export function nextFanoutCount(current: number): FanoutCount {
  const i = FANOUT_STEPS.indexOf(current as FanoutCount)
  return FANOUT_STEPS[(i + 1) % FANOUT_STEPS.length]
}

/**
 * Stable identity for a fan-out variant card: keys the output card on its
 * SOURCE + variant index so a REPEAT fan-out refreshes the SAME N cards in
 * place instead of piling up duplicates. x1 (single) runs carry no key — they
 * follow today's plain append/refresh path untouched.
 */
export function fanoutVariantKey(sourceId: string, index: number): string {
  return `${sourceId}::v${index}`
}

// ── Row geometry ───────────────────────────────────────────────────────────────
// Cards fan out to the RIGHT of the source in one horizontal row (same y).
// baseGap clears the source's right edge (mirrors upsertOutputNode's `+ 90`);
// cardStride = output-card width (~250) + a gap so siblings don't overlap.

export const FANOUT_BASE_GAP = 90
export const FANOUT_CARD_STRIDE = 290
/** Fallback source width when the caller doesn't know it (APPROX_NODE_RECT.w). */
const DEFAULT_SRC_WIDTH = 180

export interface FanoutPosOpts {
  /** Actual source-node width (so the first card clears it). */
  srcWidth?: number
  /** Gap from the source's right edge to the first card. */
  baseGap?: number
  /** Horizontal distance between adjacent sibling cards. */
  cardStride?: number
}

/**
 * Positions for N sibling result cards fanned out in a row beside the source.
 * Pure: `fanoutPositions({x,y}, n)` returns n {x,y}s left-to-right at the
 * source's y. Card i (0-based) sits at x0 + i·stride, x0 = source right edge +
 * baseGap. n ≤ 0 → []. Coordinates are rounded (drag micro-noise otherwise
 * leaks fractional px into every card).
 */
export function fanoutPositions(
  sourcePos: { x: number; y: number },
  n: number,
  opts: FanoutPosOpts = {},
): Array<{ x: number; y: number }> {
  const count = Math.max(0, Math.floor(n))
  const srcWidth = opts.srcWidth ?? DEFAULT_SRC_WIDTH
  const baseGap = opts.baseGap ?? FANOUT_BASE_GAP
  const stride = opts.cardStride ?? FANOUT_CARD_STRIDE
  const x0 = sourcePos.x + srcWidth + baseGap
  const y = Math.round(sourcePos.y)
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i < count; i++) {
    out.push({ x: Math.round(x0 + i * stride), y })
  }
  return out
}

/**
 * Seed for fan-out variant `index`, or null to leave the node's seed untouched.
 *
 * A FIXED seed (a finite number ≥ 0) is bumped by the variant index so each
 * sibling differs deterministically-yet-reproducibly (variant 0 keeps the
 * user's exact seed). A RANDOM seed (-1 / negative / absent / non-numeric) is
 * left alone — the engine already rerolls it every run, so the siblings vary on
 * their own. This is the sd.cpp sweet spot: "one prompt, four seeds".
 */
export function fanoutSeed(baseSeed: unknown, index: number): number | null {
  if (typeof baseSeed !== 'number' || !Number.isFinite(baseSeed) || baseSeed < 0) return null
  return Math.floor(baseSeed) + Math.max(0, Math.floor(index))
}
