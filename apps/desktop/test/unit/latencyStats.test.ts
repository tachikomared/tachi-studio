// apps/desktop/test/unit/latencyStats.test.ts
//
// Per-key bounded latency ring + p95/jitter/spike-rate/stability score (ported
// from free-coding-models utils.js getP95 / getJitter / getStabilityScore).
// Pure, no IO. Covers the math and the "spiky" downgrade case.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  p95, jitter, spikeRate, stabilityScore,
  recordSample, getSamples, getStabilityScoreForKey, resetLatencyStats,
  LATENCY_RING_SIZE, STABILITY_SPIKY_THRESHOLD,
} from '../../electron/services/util/latency-stats'

describe('p95', () => {
  it('returns Infinity with no samples', () => {
    expect(p95([])).toBe(Infinity)
  })

  it('picks the value at ceil(N*0.95)-1', () => {
    // [100,200,300,400,5000] -> idx ceil(5*0.95)-1 = 4 -> 5000
    expect(p95([100, 200, 300, 400, 5000])).toBe(5000)
  })

  it('is order-independent (sorts internally)', () => {
    expect(p95([5000, 100, 400, 200, 300])).toBe(5000)
  })

  it('handles a single sample', () => {
    expect(p95([250])).toBe(250)
  })
})

describe('jitter (population stddev)', () => {
  it('is 0 with fewer than 2 samples', () => {
    expect(jitter([])).toBe(0)
    expect(jitter([500])).toBe(0)
  })

  it('is 0 for identical samples', () => {
    expect(jitter([300, 300, 300])).toBe(0)
  })

  it('computes population standard deviation (divide by N)', () => {
    // mean=300, deviations 100,0,-100 -> variance (10000+0+10000)/3 -> sqrt ~ 82
    expect(jitter([200, 300, 400])).toBe(82)
  })
})

describe('spikeRate (>3000ms fraction)', () => {
  it('is 0 with no samples', () => {
    expect(spikeRate([])).toBe(0)
  })

  it('is the fraction of samples above 3000ms', () => {
    expect(spikeRate([100, 200, 4000, 5000])).toBeCloseTo(0.5, 5)
    expect(spikeRate([100, 200, 300])).toBe(0)
    expect(spikeRate([4000, 5000])).toBe(1)
  })
})

describe('stabilityScore', () => {
  it('is -1 with no samples (not enough data)', () => {
    expect(stabilityScore([])).toBe(-1)
  })

  it('rewards a boringly consistent model (high score)', () => {
    // ~400ms tight cluster: low p95, low jitter, no spikes, full uptime.
    const consistent = [380, 400, 420, 410, 390, 405, 395, 415]
    expect(stabilityScore(consistent)).toBeGreaterThan(80)
  })

  it('downgrades a spiky model (low avg but huge tail) below a consistent one', () => {
    // Model A: fast on average but littered with >3s spikes.
    const spiky = [250, 240, 6000, 260, 5500, 230, 6200, 245]
    const consistent = [380, 400, 420, 410, 390, 405, 395, 415]
    const spikyScore = stabilityScore(spiky)
    const consistentScore = stabilityScore(consistent)
    expect(spikyScore).toBeLessThan(consistentScore)
    // The spiky model should clearly land in the deprioritize band (<40).
    expect(spikyScore).toBeLessThan(40)
  })

  it('is clamped to 0..100', () => {
    const s = stabilityScore([100, 110, 90, 105, 95])
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(100)
  })
})

describe('per-key ring', () => {
  beforeEach(() => { resetLatencyStats() })

  it('records samples under a key and reads them back', () => {
    recordSample('m1', 200)
    recordSample('m1', 300)
    expect(getSamples('m1')).toEqual([200, 300])
  })

  it('keeps separate rings per key', () => {
    recordSample('a', 100)
    recordSample('b', 999)
    expect(getSamples('a')).toEqual([100])
    expect(getSamples('b')).toEqual([999])
  })

  it('bounds the ring to LATENCY_RING_SIZE, dropping the oldest', () => {
    for (let i = 0; i < LATENCY_RING_SIZE + 5; i++) recordSample('ring', i)
    const s = getSamples('ring')
    expect(s.length).toBe(LATENCY_RING_SIZE)
    // oldest 5 dropped — first retained is sample #5
    expect(s[0]).toBe(5)
    expect(s[s.length - 1]).toBe(LATENCY_RING_SIZE + 4)
  })

  it('ignores non-finite / negative samples', () => {
    recordSample('bad', NaN)
    recordSample('bad', -10)
    recordSample('bad', 250)
    expect(getSamples('bad')).toEqual([250])
  })

  it('getStabilityScoreForKey returns -1 for an unknown key', () => {
    expect(getStabilityScoreForKey('never-seen')).toBe(-1)
  })

  it('getStabilityScoreForKey scores the recorded ring', () => {
    for (const ms of [380, 400, 420, 410, 390]) recordSample('stable-key', ms)
    expect(getStabilityScoreForKey('stable-key')).toBeGreaterThan(80)
  })
})

// ── extra edge cases ───────────────────────────────────────────────────────────

describe('p95 small-series indexing', () => {
  it('clamps to a valid element on a tiny series (idx never goes negative)', () => {
    // N=3 -> ceil(2.85)-1 = idx 2 -> the largest of the three
    expect(p95([100, 300, 200])).toBe(300)
  })

  it('N=100 lands on the 95th value', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(p95(samples)).toBe(95)
  })
})

describe('spikeRate threshold boundary', () => {
  it('treats exactly 3000ms as NOT a spike (strict greater-than)', () => {
    expect(spikeRate([3000, 3000, 3000])).toBe(0)
  })

  it('counts 3001ms as a spike', () => {
    expect(spikeRate([3001])).toBe(1)
  })
})

describe('stabilityScore edge & band cases', () => {
  it('returns a 0..100 score for a single sample (not -1)', () => {
    const s = stabilityScore([100])
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(100)
  })

  it('is clamped to 0..100 even for absurd multi-second latencies', () => {
    const s = stabilityScore([60000, 120000, 90000])
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(100)
  })

  it('drives a heavily-spiking series below STABILITY_SPIKY_THRESHOLD', () => {
    const spiky = [8000, 9000, 8500, 9500, 7000, 9000]
    expect(stabilityScore(spiky)).toBeLessThan(STABILITY_SPIKY_THRESHOLD)
  })

  it('keeps a fast, flat series above STABILITY_SPIKY_THRESHOLD', () => {
    expect(stabilityScore([120, 130, 110, 125, 115])).toBeGreaterThan(STABILITY_SPIKY_THRESHOLD)
  })

  it('ranks consistent over spiky at the same ~mean', () => {
    const consistent = Array(10).fill(1000)
    const spiky = [100, 100, 100, 100, 100, 100, 100, 100, 100, 9000]
    expect(stabilityScore(consistent)).toBeGreaterThan(stabilityScore(spiky))
  })
})

describe('ring guards & semantics', () => {
  beforeEach(() => { resetLatencyStats() })

  it('returns [] for an unknown key', () => {
    expect(getSamples('never-seen')).toEqual([])
  })

  it('ignores an empty key', () => {
    recordSample('', 100)
    expect(getSamples('')).toEqual([])
  })

  it('ignores Infinity samples', () => {
    recordSample('m', Infinity)
    recordSample('m', 150)
    expect(getSamples('m')).toEqual([150])
  })

  it('accepts a 0ms sample (boundary of the >= 0 guard)', () => {
    recordSample('m', 0)
    expect(getSamples('m')).toEqual([0])
  })

  it('returns a defensive copy (mutating the result does not affect the ring)', () => {
    recordSample('m', 100)
    const snapshot = getSamples('m')
    snapshot.push(999)
    expect(getSamples('m')).toEqual([100])
  })

  it('holds exactly LATENCY_RING_SIZE when filled to the brim (no eviction yet)', () => {
    for (let i = 0; i < LATENCY_RING_SIZE; i++) recordSample('brim', i)
    expect(getSamples('brim').length).toBe(LATENCY_RING_SIZE)
    expect(getSamples('brim')[0]).toBe(0)
  })
})

describe('ring recency & score wiring', () => {
  beforeEach(() => { resetLatencyStats() })

  it('a recovered model is no longer punished once spikes scroll out of the ring', () => {
    // Spiky window: alternating fast/stalled -> high tail + high jitter + spikes.
    for (let i = 0; i < LATENCY_RING_SIZE; i++) recordSample('rec', i % 2 === 0 ? 100 : 9000)
    expect(getStabilityScoreForKey('rec')).toBeLessThan(STABILITY_SPIKY_THRESHOLD)
    // A full window of fast samples evicts every spike; score recovers.
    for (let i = 0; i < LATENCY_RING_SIZE; i++) recordSample('rec', 120)
    expect(getStabilityScoreForKey('rec')).toBeGreaterThan(STABILITY_SPIKY_THRESHOLD)
  })

  it('getStabilityScoreForKey mirrors stabilityScore over the same series', () => {
    const series = [100, 120, 110, 130, 105]
    series.forEach(ms => recordSample('mirror', ms))
    expect(getStabilityScoreForKey('mirror')).toBe(stabilityScore(series))
  })
})

describe('resetLatencyStats', () => {
  it('clears all rings across keys', () => {
    recordSample('a', 1)
    recordSample('b', 2)
    resetLatencyStats()
    expect(getSamples('a')).toEqual([])
    expect(getSamples('b')).toEqual([])
    expect(getStabilityScoreForKey('a')).toBe(-1)
  })
})
