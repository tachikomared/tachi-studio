// apps/desktop/test/unit/costPricing.test.ts
import { describe, it, expect } from 'vitest'
import { ratesFor, costUsd } from '../../electron/services/cost-pricing'

describe('ratesFor', () => {
  it('returns rates for known models (cache fields now present too)', () => {
    expect(ratesFor('claude-sonnet-4.6')).toMatchObject({ inputPerM: 3, outputPerM: 15 })
    // Opus 4.8 is $5/$25 (Anthropic pricing page, read 2026-08-02). This
    // assertion carried the Opus 4.1-era $15/$75 that the 2026-08-02 audit
    // found across every Claude row — a ~3× over-charge.
    expect(ratesFor('claude-opus-4-8')).toMatchObject({ inputPerM: 5, outputPerM: 25 })
  })
  it('falls back to the dash-prefix (mirrors ObservabilityTab heuristic)', () => {
    // e.g. 'gpt-4o-mini-2024-07-18' → 'gpt-4o-mini'
    expect(ratesFor('gpt-4o-mini-2024-07-18')).toMatchObject({ inputPerM: 0.15, outputPerM: 0.6 })
  })
  it('returns null for unknown models (honesty: never fabricate)', () => {
    expect(ratesFor('mystery-model-9000')).toBeNull()
  })
})

describe('costUsd', () => {
  it('computes prompt+completion cost per million tokens', () => {
    // sonnet: 1M in = $3, 1M out = $15
    expect(costUsd('claude-sonnet-4.6', 1_000_000, 0)).toBeCloseTo(3)
    expect(costUsd('claude-sonnet-4.6', 0, 1_000_000)).toBeCloseTo(15)
    expect(costUsd('claude-sonnet-4.6', 500_000, 100_000)).toBeCloseTo(1.5 + 1.5)
  })
  it('returns null for unpriced models', () => {
    expect(costUsd('mystery-model-9000', 1000, 1000)).toBeNull()
  })
})
