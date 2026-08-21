// apps/desktop/electron/services/util/circuit-breaker.ts
//
// Generic three-state circuit breaker, ported from Pulse's
// internal/monitoring/circuit_breaker.go (closed/open/half-open).
//
//   closed ──(consecutiveFailures >= failureThreshold)──► open
//   open   ──(now >= nextAttemptAt)──────────────────────► half-open  (grants ONE probe)
//   half-open ──(probe succeeds)─────────────────────────► closed     (cadence reset)
//   half-open ──(probe fails)────────────────────────────► open       (delay doubled, capped)
//
// The whole point: a dead/stopped dependency stops being hammered at a fixed
// short interval. Each re-open doubles the backoff (binary-exponential) up to
// maxDelayMs, and a single success snaps the cadence back to normal.
//
// Determinism: the clock is injectable (now()) and jitter is injectable +
// disabled by default, so the transition table is fully testable without
// real timers or randomness.

export type BreakerState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerOpts {
  // Consecutive failures (while closed) that trip the breaker open.
  failureThreshold: number
  // Base backoff for the first trip. Doubles on each subsequent re-open.
  baseDelayMs: number
  // Upper bound on the backoff delay; binary-exponential growth is clamped here.
  maxDelayMs: number
  // Minimum spacing between half-open probes. Defaults to baseDelayMs when
  // unset — bounds how often a single probe is re-granted before it resolves.
  halfOpenAfterMs?: number
  // Optional jitter added to each computed backoff delay. Must be injectable so
  // tests stay deterministic; omitted => no jitter (delay exactly base * 2^n).
  jitter?: () => number
}

export interface BreakerSnapshot {
  state:                BreakerState
  consecutiveFailures:  number
  // ms-since-epoch (per the injected clock) at which the next attempt is
  // permitted. 0 while closed (attempts are always allowed).
  nextAttemptAt:        number
}

export class CircuitBreaker {
  private readonly failureThreshold: number
  private readonly baseDelayMs:      number
  private readonly maxDelayMs:       number
  private readonly halfOpenAfterMs:  number
  private readonly jitter:           () => number
  private readonly now:              () => number

  private state: BreakerState = 'closed'
  private consecutiveFailures = 0
  // Computed backoff delay of the CURRENT open period (grows on each re-open).
  private currentDelayMs = 0
  // ms-since-epoch the breaker may next be probed (open) or re-probed (half-open).
  private nextAttemptAt = 0

  constructor(opts: CircuitBreakerOpts, now: () => number = Date.now) {
    this.failureThreshold = opts.failureThreshold > 0 ? opts.failureThreshold : 3
    this.baseDelayMs      = opts.baseDelayMs > 0 ? opts.baseDelayMs : 1000
    this.maxDelayMs       = opts.maxDelayMs > 0 ? opts.maxDelayMs : 60_000
    this.halfOpenAfterMs  = opts.halfOpenAfterMs && opts.halfOpenAfterMs > 0
      ? opts.halfOpenAfterMs
      : this.baseDelayMs
    this.jitter = opts.jitter ?? (() => 0)
    this.now    = now
  }

  /**
   * Consult before each attempt.
   *   closed     → always true.
   *   open       → true only once the backoff window has elapsed; the breaker
   *                transitions to half-open and grants exactly ONE probe (the
   *                next consult is blocked until the probe resolves or the
   *                half-open window passes).
   *   half-open  → false until halfOpenAfterMs has elapsed since the last
   *                granted probe (prevents a flood of in-flight probes).
   */
  shouldAttempt(): boolean {
    const t = this.now()
    switch (this.state) {
      case 'closed':
        return true
      case 'open':
        if (t >= this.nextAttemptAt) {
          this.state = 'half-open'
          this.nextAttemptAt = t + this.halfOpenAfterMs
          return true
        }
        return false
      case 'half-open':
        if (t >= this.nextAttemptAt) {
          this.nextAttemptAt = t + this.halfOpenAfterMs
          return true
        }
        return false
      default:
        return true
    }
  }

  /** A success closes the breaker and resets the cadence. */
  recordSuccess(): void {
    this.state = 'closed'
    this.consecutiveFailures = 0
    this.currentDelayMs = 0
    this.nextAttemptAt = 0
  }

  /**
   * A failure increments the consecutive count. From half-open it re-opens
   * immediately (doubling the delay). From closed it trips open once the
   * threshold is reached.
   */
  recordFailure(): void {
    this.consecutiveFailures++
    if (this.state === 'half-open') {
      this.trip()
    } else if (this.state === 'closed') {
      if (this.consecutiveFailures >= this.failureThreshold) this.trip()
    }
  }

  /** Move to open and compute the (doubled, capped, jittered) backoff. */
  private trip(): void {
    this.state = 'open'
    // Binary-exponential: first trip uses baseDelayMs, each re-open doubles it.
    const next = this.currentDelayMs === 0 ? this.baseDelayMs : this.currentDelayMs * 2
    this.currentDelayMs = Math.min(next, this.maxDelayMs)
    this.nextAttemptAt = this.now() + this.currentDelayMs + this.jitter()
  }

  /** Serialisable view for observability (StatusPage / debugger). */
  snapshot(): BreakerSnapshot {
    return {
      state:               this.state,
      consecutiveFailures: this.consecutiveFailures,
      nextAttemptAt:       this.state === 'closed' ? 0 : this.nextAttemptAt,
    }
  }
}
