// apps/desktop/test/unit/circuitBreaker.test.ts
import { describe, it, expect } from 'vitest'
import { CircuitBreaker } from '../../electron/services/util/circuit-breaker'

// Injectable clock so every transition is deterministic — no real timers.
function makeClock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => { t += ms },
    set: (ms: number) => { t = ms },
  }
}

describe('CircuitBreaker', () => {
  it('starts closed and allows attempts', () => {
    const b = new CircuitBreaker({ failureThreshold: 3, baseDelayMs: 1000, maxDelayMs: 60_000 })
    const s = b.snapshot()
    expect(s.state).toBe('closed')
    expect(s.consecutiveFailures).toBe(0)
    expect(b.shouldAttempt()).toBe(true)
  })

  it('stays closed below the failure threshold', () => {
    const clk = makeClock()
    const b = new CircuitBreaker({ failureThreshold: 3, baseDelayMs: 1000, maxDelayMs: 60_000 }, clk.now)
    b.recordFailure()
    b.recordFailure()
    expect(b.snapshot().state).toBe('closed')
    expect(b.snapshot().consecutiveFailures).toBe(2)
    expect(b.shouldAttempt()).toBe(true)
  })

  it('opens once consecutive failures reach the threshold', () => {
    const clk = makeClock()
    const b = new CircuitBreaker({ failureThreshold: 3, baseDelayMs: 1000, maxDelayMs: 60_000 }, clk.now)
    b.recordFailure()
    b.recordFailure()
    b.recordFailure()
    const s = b.snapshot()
    expect(s.state).toBe('open')
    expect(s.consecutiveFailures).toBe(3)
  })

  it('blocks attempts while open and the backoff window has not elapsed', () => {
    const clk = makeClock()
    const b = new CircuitBreaker({ failureThreshold: 1, baseDelayMs: 1000, maxDelayMs: 60_000 }, clk.now)
    b.recordFailure() // trips open at threshold 1
    expect(b.snapshot().state).toBe('open')
    expect(b.shouldAttempt()).toBe(false)
    clk.advance(999)
    expect(b.shouldAttempt()).toBe(false) // still before nextAttemptAt
  })

  it('reports nextAttemptAt as openedAt + backoff delay', () => {
    const clk = makeClock(5000)
    const b = new CircuitBreaker({ failureThreshold: 1, baseDelayMs: 1000, maxDelayMs: 60_000 }, clk.now)
    b.recordFailure() // first trip: delay = baseDelayMs * 2^0 = 1000
    expect(b.snapshot().nextAttemptAt).toBe(5000 + 1000)
  })

  it('moves to half-open and allows exactly ONE probe after the backoff elapses', () => {
    const clk = makeClock()
    const b = new CircuitBreaker({ failureThreshold: 1, baseDelayMs: 1000, maxDelayMs: 60_000 }, clk.now)
    b.recordFailure() // open, delay 1000
    clk.advance(1000) // backoff elapsed
    expect(b.shouldAttempt()).toBe(true)   // first call -> half-open, single probe granted
    expect(b.snapshot().state).toBe('half-open')
    // A second consult before the probe resolves must NOT grant another attempt.
    expect(b.shouldAttempt()).toBe(false)
  })

  it('closes on success from half-open and resets the cadence', () => {
    const clk = makeClock()
    const b = new CircuitBreaker({ failureThreshold: 1, baseDelayMs: 1000, maxDelayMs: 60_000 }, clk.now)
    b.recordFailure()
    clk.advance(1000)
    expect(b.shouldAttempt()).toBe(true) // half-open probe
    b.recordSuccess()
    const s = b.snapshot()
    expect(s.state).toBe('closed')
    expect(s.consecutiveFailures).toBe(0)
    expect(b.shouldAttempt()).toBe(true) // back to normal cadence
  })

  it('re-opens with a DOUBLED delay on failure from half-open (binary-exponential)', () => {
    const clk = makeClock(0)
    const b = new CircuitBreaker({ failureThreshold: 1, baseDelayMs: 1000, maxDelayMs: 60_000 }, clk.now)
    b.recordFailure()                       // failures=1, delay = 1000 * 2^0 = 1000
    expect(b.snapshot().nextAttemptAt).toBe(1000)
    clk.set(1000)
    expect(b.shouldAttempt()).toBe(true)    // half-open probe
    b.recordFailure()                       // failures=2, re-open, delay = 1000 * 2^1 = 2000
    expect(b.snapshot().state).toBe('open')
    expect(b.snapshot().nextAttemptAt).toBe(1000 + 2000)
    clk.set(3000)
    expect(b.shouldAttempt()).toBe(true)    // half-open probe
    b.recordFailure()                       // failures=3, re-open, delay = 1000 * 2^2 = 4000
    expect(b.snapshot().nextAttemptAt).toBe(3000 + 4000)
  })

  it('caps the backoff delay at maxDelayMs', () => {
    const clk = makeClock(0)
    const b = new CircuitBreaker({ failureThreshold: 1, baseDelayMs: 1000, maxDelayMs: 3000 }, clk.now)
    // Drive failures past the point the uncapped delay would exceed the cap.
    b.recordFailure()                       // delay 1000 (<= cap)
    clk.set(b.snapshot().nextAttemptAt)
    b.shouldAttempt(); b.recordFailure()    // uncapped 2000 (<= cap)
    clk.set(b.snapshot().nextAttemptAt)
    b.shouldAttempt(); b.recordFailure()    // uncapped 4000 -> capped to 3000
    const opened = b.snapshot().nextAttemptAt
    clk.set(opened)
    b.shouldAttempt(); b.recordFailure()    // uncapped 8000 -> capped to 3000
    // The delta between successive nextAttemptAt values must never exceed the cap.
    const prev = opened
    const next = b.snapshot().nextAttemptAt
    expect(next - prev).toBe(3000)
  })

  it('counts consecutive failures and resets the count on any success while closed', () => {
    const clk = makeClock()
    const b = new CircuitBreaker({ failureThreshold: 5, baseDelayMs: 1000, maxDelayMs: 60_000 }, clk.now)
    b.recordFailure()
    b.recordFailure()
    expect(b.snapshot().consecutiveFailures).toBe(2)
    b.recordSuccess()
    expect(b.snapshot().consecutiveFailures).toBe(0)
    expect(b.snapshot().state).toBe('closed')
  })

  it('is deterministic with no jitter by default (delay exactly base * 2^n)', () => {
    const clk = makeClock(0)
    const b = new CircuitBreaker({ failureThreshold: 1, baseDelayMs: 500, maxDelayMs: 60_000 }, clk.now)
    b.recordFailure()
    expect(b.snapshot().nextAttemptAt).toBe(500) // exactly, no random component
  })

  it('applies injectable jitter when provided', () => {
    const clk = makeClock(0)
    // jitter() returns a fixed offset so the test stays deterministic.
    const b = new CircuitBreaker(
      { failureThreshold: 1, baseDelayMs: 1000, maxDelayMs: 60_000, jitter: () => 100 },
      clk.now,
    )
    b.recordFailure()
    expect(b.snapshot().nextAttemptAt).toBe(1000 + 100)
  })

  it('respects an explicit halfOpenAfterMs window distinct from the open backoff', () => {
    const clk = makeClock(0)
    const b = new CircuitBreaker(
      { failureThreshold: 1, baseDelayMs: 1000, maxDelayMs: 60_000, halfOpenAfterMs: 200 },
      clk.now,
    )
    b.recordFailure()      // open, backoff 1000
    clk.set(1000)
    expect(b.shouldAttempt()).toBe(true)   // half-open probe granted
    expect(b.shouldAttempt()).toBe(false)  // within the half-open window -> blocked
    clk.advance(200)                        // half-open window elapsed
    expect(b.shouldAttempt()).toBe(true)   // a fresh probe is allowed
  })
})
