// apps/desktop/test/unit/surplusRouterState.test.ts
//
// Runtime half of the smart router (cooldown / reliability / momentum). electron
// `app` is mocked to a non-existent path so persistence is a silent no-op and
// every run starts from fresh in-memory state. Fake timers control Date.now so
// cooldown TTLs are deterministic (and the lazy persist timer never fires).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/__nonexistent_tachi_test__' } }))

import {
  cooldownKindForStatus, markCooldown, cooledDownSet,
  reliability, recordOutcome, pushTier, recentTiers, banditArm,
  recordRouteStat, getRouteStats,
  recordLatencySample, getStabilityScore, noteQuotaPercent,
} from '../../electron/services/surplus-router-state'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0) })
afterEach(() => { vi.useRealTimers() })

describe('cooldownKindForStatus', () => {
  it('maps HTTP statuses to cooldown kinds', () => {
    expect(cooldownKindForStatus(429)).toBe('rate_limit')
    expect(cooldownKindForStatus(503)).toBe('overload')
    expect(cooldownKindForStatus(529)).toBe('overload')
    expect(cooldownKindForStatus(408)).toBe('timeout')
    expect(cooldownKindForStatus(504)).toBe('timeout')
    expect(cooldownKindForStatus(500)).toBe('error')
    expect(cooldownKindForStatus(0)).toBe('error')
  })
})

describe('cooldown set + expiry', () => {
  it('parks a model then prunes it after its TTL', () => {
    markCooldown('cd-overload', 'overload') // 15s TTL
    expect(cooledDownSet().has('cd-overload')).toBe(true)
    vi.setSystemTime(15_001)
    expect(cooledDownSet().has('cd-overload')).toBe(false)
  })

  it('a successful outcome clears an active cooldown', () => {
    markCooldown('cd-clear', 'error')
    expect(cooledDownSet().has('cd-clear')).toBe(true)
    recordOutcome('cd-clear', true)
    expect(cooledDownSet().has('cd-clear')).toBe(false)
  })
})

describe('reliability', () => {
  it('is optimistic 1.0 until at least 3 observations', () => {
    expect(reliability('rel-unknown')).toBe(1)
    recordOutcome('rel-a', true)
    recordOutcome('rel-a', true)
    expect(reliability('rel-a')).toBe(1) // only 2 obs -> still optimistic
  })

  it('becomes the success ratio once enough observations exist', () => {
    recordOutcome('rel-b', true)
    recordOutcome('rel-b', true)
    recordOutcome('rel-b', false)
    expect(reliability('rel-b')).toBeCloseTo(2 / 3, 5)
  })
})

describe('bandit arms (C1)', () => {
  it('is undefined for a pair with no recorded outcome', () => {
    expect(banditArm('code:TOP', 'arm-none')).toBeUndefined()
  })

  it('records a per-(bucket|model) arm alongside the bucket entry', () => {
    recordOutcome('arm-m1', true,  'code:MID')
    recordOutcome('arm-m1', true,  'code:MID')
    recordOutcome('arm-m1', false, 'code:MID')
    // Beta(1,1) init + 2 successes + 1 failure.
    expect(banditArm('code:MID', 'arm-m1')).toEqual({ a: 3, b: 2 })
  })

  it('keeps arms separate per bucket for the same model', () => {
    recordOutcome('arm-m2', true, 'general:SIMPLE')
    recordOutcome('arm-m2', false, 'reasoning:TOP')
    expect(banditArm('general:SIMPLE', 'arm-m2')).toEqual({ a: 2, b: 1 })
    expect(banditArm('reasoning:TOP', 'arm-m2')).toEqual({ a: 1, b: 2 })
  })
})

describe('route stats (savings substrate)', () => {
  it('tallies routed requests per tier and returns a copy', () => {
    const before = getRouteStats()
    recordRouteStat('SIMPLE')
    recordRouteStat('SIMPLE')
    recordRouteStat('TOP')
    const after = getRouteStats()
    expect(after.SIMPLE).toBe(before.SIMPLE + 2)
    expect(after.TOP).toBe(before.TOP + 1)
    expect(after.MID).toBe(before.MID)
    // copy, not a live reference
    after.SIMPLE = 9999
    expect(getRouteStats().SIMPLE).toBe(before.SIMPLE + 2)
  })
})

describe('latency stability (router-intel)', () => {
  it('is -1 for a model with no samples', () => {
    expect(getStabilityScore('stab-unknown')).toBe(-1)
    expect(getStabilityScore('')).toBe(-1)
  })

  it('scores a consistent model high once samples land', () => {
    for (const ms of [380, 400, 420, 410, 390, 405]) recordLatencySample('stab-consistent', ms)
    expect(getStabilityScore('stab-consistent')).toBeGreaterThan(80)
  })

  it('scores a spiky model low (tail-latency stalls)', () => {
    for (const ms of [250, 6000, 240, 5500, 6200, 230]) recordLatencySample('stab-spiky', ms)
    expect(getStabilityScore('stab-spiky')).toBeLessThan(40)
  })
})

describe('header-quota soft cooldown (router-intel)', () => {
  it('maps a soft-quota park to a shorter TTL than a 429', () => {
    // soft_quota TTL is 20s vs rate_limit 120s.
    markCooldown('q-soft', 'soft_quota')
    expect(cooledDownSet().has('q-soft')).toBe(true)
    vi.setSystemTime(20_001)
    expect(cooledDownSet().has('q-soft')).toBe(false)
  })

  it('noteQuotaPercent parks a near-exhausted model preemptively', () => {
    noteQuotaPercent('q-low', 3)        // <= 5% headroom
    expect(cooledDownSet().has('q-low')).toBe(true)
    // and it recovers on the SHORT soft-quota TTL, well before a 429 would.
    vi.setSystemTime(20_001)
    expect(cooledDownSet().has('q-low')).toBe(false)
  })

  it('noteQuotaPercent is a no-op for healthy headroom / null / empty key', () => {
    noteQuotaPercent('q-high', 80)
    noteQuotaPercent('q-null', null)
    noteQuotaPercent('', 0)
    expect(cooledDownSet().has('q-high')).toBe(false)
    expect(cooledDownSet().has('q-null')).toBe(false)
    expect(cooledDownSet().has('')).toBe(false)
  })

  it('parks exactly at the 5% boundary', () => {
    noteQuotaPercent('q-boundary', 5)
    expect(cooledDownSet().has('q-boundary')).toBe(true)
  })
})

describe('momentum (recentTiers)', () => {
  it('keeps only the last 5 tiers, newest last', () => {
    for (const t of ['SIMPLE', 'MID', 'TOP', 'SIMPLE', 'MID', 'TOP', 'TOP'] as const) {
      pushTier('conv-1', t)
    }
    expect(recentTiers('conv-1')).toEqual(['TOP', 'SIMPLE', 'MID', 'TOP', 'TOP'])
  })

  it('returns [] for an unknown / empty conversation id', () => {
    expect(recentTiers('conv-none')).toEqual([])
    expect(recentTiers('')).toEqual([])
  })
})
