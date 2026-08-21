// apps/desktop/electron/services/util/latency-stats.ts
//
// Per-model latency telemetry for the surplus router. Ported from
// free-coding-models (src/core/utils.js getP95 / getJitter / getStabilityScore):
// a consistent-but-average model FEELS faster than a low-average model that
// randomly stalls, so we score CONSISTENCY (p95 + jitter + spike-rate) and use
// it as a late tiebreaker in ranking.
//
// Two layers:
//   - pure stat fns over a number[] (p95 / jitter / spikeRate / stabilityScore)
//   - a bounded per-key ring (recordSample / getStabilityScoreForKey) the caller
//     feeds from observed request round-trips.
//
// Pure TypeScript — no imports, no side-effects beyond the in-memory ring
// (vitest-importable; no electron dependency).

// Samples we keep per key. Bounded so a long-lived process can't grow unbounded
// and so the score tracks RECENT behavior (a model that recovered shouldn't be
// punished forever).
export const LATENCY_RING_SIZE = 50

// Latencies above this (ms) count as a "spike" — a tail-latency stall that hurts
// interactive use even when the average looks fine.
const SPIKE_THRESHOLD_MS = 3000

// Stability-score band below which a model is considered "spiky" and should be
// deprioritized within its tier (never promoted across tiers).
export const STABILITY_SPIKY_THRESHOLD = 40

// ── Pure stat functions ─────────────────────────────────────────────────────-

/**
 * 95th percentile latency: "95% of requests are faster than this". Sort ascending
 * and pick the value at ceil(N*0.95)-1. Infinity when there are no samples.
 */
export function p95(samples: number[]): number {
  if (samples.length === 0) return Infinity
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.ceil(sorted.length * 0.95) - 1
  return sorted[Math.max(0, idx)]!
}

/**
 * Jitter = population standard deviation (divide by N, not N-1: we hold ALL the
 * recent samples, not a draw from a larger set). 0 with fewer than 2 samples.
 */
export function jitter(samples: number[]): number {
  if (samples.length < 2) return 0
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const variance = samples.reduce((sum, ms) => sum + (ms - mean) ** 2, 0) / samples.length
  return Math.round(Math.sqrt(variance))
}

/** Fraction (0..1) of samples slower than the spike threshold. 0 with no samples. */
export function spikeRate(samples: number[]): number {
  if (samples.length === 0) return 0
  return samples.filter(ms => ms > SPIKE_THRESHOLD_MS).length / samples.length
}

/**
 * Composite 0..100 stability score (higher = more consistent). Weighted:
 *   30% p95 (tail latency) + 30% jitter (variance) + 20% spike-rate +
 *   20% reliability (uptime). Here every sample IS a successful round-trip, so
 *   the reliability term is full credit; the router blends real reliability in
 *   separately. Returns -1 when there are no samples (not enough data yet).
 */
export function stabilityScore(samples: number[]): number {
  if (samples.length === 0) return -1
  const tail = p95(samples)
  const jit = jitter(samples)
  const spikes = spikeRate(samples)

  const p95Score    = Math.max(0, Math.min(100, 100 * (1 - tail / 5000)))
  const jitterScore = Math.max(0, Math.min(100, 100 * (1 - jit / 2000)))
  const spikeScore  = Math.max(0, 100 * (1 - spikes))
  const reliability = 100  // every sample is a measured success; real reliability blended elsewhere

  const score = 0.3 * p95Score + 0.3 * jitterScore + 0.2 * spikeScore + 0.2 * reliability
  return Math.round(Math.max(0, Math.min(100, score)))
}

// ── Per-key bounded ring ──────────────────────────────────────────────────────

const rings = new Map<string, number[]>()

/** Append a latency sample (ms) for a model key; ignores non-finite/negative values. */
export function recordSample(key: string, ms: number): void {
  if (!key) return
  if (!Number.isFinite(ms) || ms < 0) return
  const ring = rings.get(key) ?? []
  ring.push(ms)
  while (ring.length > LATENCY_RING_SIZE) ring.shift()
  rings.set(key, ring)
}

/** Current samples for a key (copy, oldest first). [] when the key is unknown. */
export function getSamples(key: string): number[] {
  const ring = rings.get(key)
  return ring ? [...ring] : []
}

/** Stability score for a key's recorded ring. -1 when the key has no samples. */
export function getStabilityScoreForKey(key: string): number {
  return stabilityScore(getSamples(key))
}

/** Clear all rings — test hook (no production caller). */
export function resetLatencyStats(): void {
  rings.clear()
}
