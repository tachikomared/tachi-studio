// apps/desktop/test/unit/compareStats.test.ts
//
// Per-column COMPARE stats (UX #6) — the pure math behind the "312 tok/s ·
// TTFT 0.4s" line. The contract under test is TRUTHFULNESS: any dimension that
// wasn't measured (no delta ever arrived, generation window too small to
// divide by) must come back null so the UI renders "—", never a fake number.
import { describe, it, expect } from 'vitest'
import { computeCompareStats, formatRate, formatTtft } from '../../src/pages/chat/compareStats'

describe('computeCompareStats', () => {
  it('computes tok/s from reported tokens over the generation window', () => {
    // 400ms TTFT + 1000ms generating 312 tokens → 312 tok/s
    const s = computeCompareStats({ text: 'x'.repeat(1200), ms: 1400, tokens: 312, ttftMs: 400 })
    expect(s.ttftSeconds).toBeCloseTo(0.4)
    expect(s.tokPerSec).toBeCloseTo(312, 0)
    expect(s.tokensEstimated).toBe(false)
  })

  it('falls back to chars/4 when the provider reported no usage — flagged as estimated', () => {
    // 4000 chars → ~1000 tokens over 2s of generation → ~500 tok/s
    const s = computeCompareStats({ text: 'a'.repeat(4000), ms: 2500, ttftMs: 500 })
    expect(s.tokPerSec).toBeCloseTo(500, 0)
    expect(s.tokensEstimated).toBe(true)
  })

  it('returns null rate AND null ttft when no delta ever arrived (no ttftMs)', () => {
    const s = computeCompareStats({ text: 'answer', ms: 900, tokens: 50 })
    expect(s.ttftSeconds).toBeNull()
    expect(s.tokPerSec).toBeNull() // no observed stream → no honest rate
  })

  it('refuses to divide by a sub-80ms generation window (single buffered flush)', () => {
    // Whole answer arrived in one flush: ttft ≈ ms → window ≈ 0 → rate would explode
    const s = computeCompareStats({ text: 'a'.repeat(4000), ms: 1000, ttftMs: 990 })
    expect(s.tokPerSec).toBeNull()
    expect(s.ttftSeconds).toBeCloseTo(0.99)
  })

  it('returns null rate for an empty answer', () => {
    const s = computeCompareStats({ text: '   ', ms: 1000, ttftMs: 100 })
    expect(s.tokPerSec).toBeNull()
  })

  it('ignores negative / non-finite ttft values', () => {
    expect(computeCompareStats({ text: 'abc', ms: 500, ttftMs: -5 }).ttftSeconds).toBeNull()
    expect(computeCompareStats({ text: 'abc', ms: 500, ttftMs: Number.NaN }).ttftSeconds).toBeNull()
  })

  it('ignores a zero/negative reported token count (falls back to chars/4)', () => {
    const s = computeCompareStats({ text: 'a'.repeat(400), ms: 1100, tokens: 0, ttftMs: 100 })
    expect(s.tokensEstimated).toBe(true)
    expect(s.tokPerSec).toBeCloseTo(100, 0) // 100 est. tokens over 1s
  })
})

describe('formatters', () => {
  it('formats rates: integers ≥10, one decimal below', () => {
    expect(formatRate(312.4)).toBe('312')
    expect(formatRate(9.44)).toBe('9.4')
    expect(formatRate(10)).toBe('10')
  })
  it('formats TTFT with one decimal', () => {
    expect(formatTtft(0.42)).toBe('0.4')
    expect(formatTtft(12)).toBe('12.0')
  })
})
