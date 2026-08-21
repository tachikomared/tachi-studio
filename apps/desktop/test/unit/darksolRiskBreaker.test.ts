// Tests for the darksol money-policy risk circuit breaker (darksol-risk-breaker.ts).
//
// The money-policy gate (darksol-money-policy.ts) caps a SINGLE trade. The breaker
// adds a cross-trade safety net: a run of failed money actions, a spend total over
// a rolling window, or too many actions in a window trips it, and a tripped breaker
// denies further real money actions until a manual reset. Adapted from CloddsBot's
// typed-condition circuit breaker (consecutive-failures + rolling-loss windows +
// manual reset), sized to our agent-wallet reality. Clock is injectable.

import { describe, it, expect } from 'vitest'
import { createRiskBreaker, type RiskBreakerConfig } from '../../electron/services/darksol-risk-breaker'

/** A controllable clock so window/expiry behaviour is deterministic. */
function fakeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

describe('createRiskBreaker — consecutiveFailures', () => {
  it('trips after N failed money actions in a row and clears the streak on a success', () => {
    const clock = fakeClock()
    const b = createRiskBreaker({ conditions: [{ type: 'consecutiveFailures', max: 3 }] }, clock.now)

    expect(b.isTripped().tripped).toBe(false)
    b.recordOutcome('send', false)
    b.recordOutcome('send', false)
    expect(b.isTripped().tripped).toBe(false) // 2 < 3

    // A success resets the streak — the breaker must NOT trip on the next failure alone.
    b.recordOutcome('send', true)
    b.recordOutcome('send', false)
    b.recordOutcome('send', false)
    expect(b.isTripped().tripped).toBe(false) // streak is 2 again

    b.recordOutcome('send', false) // 3rd consecutive failure
    const t = b.isTripped()
    expect(t.tripped).toBe(true)
    expect(t.reason).toMatch(/consecutive|failure/i)
  })
})

describe('createRiskBreaker — rollingSpendUsd', () => {
  it('trips when spend within the window exceeds maxUsd, and old spend slides out', () => {
    const clock = fakeClock()
    const b = createRiskBreaker(
      { conditions: [{ type: 'rollingSpendUsd', windowMs: 10_000, maxUsd: 100 }] },
      clock.now,
    )

    b.recordOutcome('swap', true, 60)
    expect(b.isTripped().tripped).toBe(false) // 60 <= 100

    b.recordOutcome('swap', true, 50) // window total 110 > 100
    const t = b.isTripped()
    expect(t.tripped).toBe(true)
    expect(t.reason).toMatch(/spend|usd/i)
  })

  it('does not trip when older spend has slid out of the window', () => {
    const clock = fakeClock()
    const b = createRiskBreaker(
      { conditions: [{ type: 'rollingSpendUsd', windowMs: 10_000, maxUsd: 100 }] },
      clock.now,
    )

    b.recordOutcome('swap', true, 80)
    clock.advance(11_000) // first spend is now outside the 10s window
    b.recordOutcome('swap', true, 80) // only this one counts -> 80 <= 100
    expect(b.isTripped().tripped).toBe(false)
  })

  it('counts spend even on failed actions (a failed real send can still cost gas/value)', () => {
    const clock = fakeClock()
    const b = createRiskBreaker(
      { conditions: [{ type: 'rollingSpendUsd', windowMs: 10_000, maxUsd: 100 }] },
      clock.now,
    )
    b.recordOutcome('send', false, 120)
    expect(b.isTripped().tripped).toBe(true)
  })
})

describe('createRiskBreaker — rollingActionCount', () => {
  it('trips when too many money actions happen within the window, and old actions slide out', () => {
    const clock = fakeClock()
    const b = createRiskBreaker(
      { conditions: [{ type: 'rollingActionCount', windowMs: 10_000, max: 3 }] },
      clock.now,
    )

    b.recordOutcome('send', true)
    b.recordOutcome('send', true)
    b.recordOutcome('send', true)
    expect(b.isTripped().tripped).toBe(false) // 3 <= 3

    b.recordOutcome('send', true) // 4th in window
    const t = b.isTripped()
    expect(t.tripped).toBe(true)
    expect(t.reason).toMatch(/action|rate|count/i)

    // Slide the whole window past — count drops back under the cap.
    clock.advance(11_000)
    expect(b.isTripped().tripped).toBe(false)
  })
})

describe('createRiskBreaker — manualReset', () => {
  it('manualReset clears a tripped breaker and its accumulated history', () => {
    const clock = fakeClock()
    const b = createRiskBreaker({ conditions: [{ type: 'consecutiveFailures', max: 2 }] }, clock.now)
    b.recordOutcome('send', false)
    b.recordOutcome('send', false)
    expect(b.isTripped().tripped).toBe(true)

    b.manualReset()
    expect(b.isTripped().tripped).toBe(false)

    // A single failure post-reset must not re-trip (the streak was cleared).
    b.recordOutcome('send', false)
    expect(b.isTripped().tripped).toBe(false)
  })
})

describe('createRiskBreaker — multiple conditions', () => {
  it('trips if ANY condition is met and reports that condition in the reason', () => {
    const clock = fakeClock()
    const cfg: RiskBreakerConfig = {
      conditions: [
        { type: 'consecutiveFailures', max: 5 },
        { type: 'rollingSpendUsd', windowMs: 60_000, maxUsd: 50 },
      ],
    }
    const b = createRiskBreaker(cfg, clock.now)
    b.recordOutcome('swap', true, 51) // spend condition trips though failures are 0
    const t = b.isTripped()
    expect(t.tripped).toBe(true)
    expect(t.reason).toMatch(/spend|usd/i)
  })

  it('an empty condition list never trips', () => {
    const b = createRiskBreaker({ conditions: [] })
    b.recordOutcome('send', false, 9_999)
    b.recordOutcome('send', false)
    b.recordOutcome('send', false)
    expect(b.isTripped().tripped).toBe(false)
  })
})
