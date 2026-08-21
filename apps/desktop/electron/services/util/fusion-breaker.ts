// apps/desktop/electron/services/util/fusion-breaker.ts
//
// Per-process circuit breaker registry keyed by Fusion panel model id.
//
// runFusion (in @tachi/core) is pure and stateless: it re-runs every panel
// member on every call. A model id that keeps erroring would be retried forever.
// This registry layers the existing CircuitBreaker (closed/open/half-open) over
// each model id so the desktop layer can:
//   - skipMember(modelId)      → true while that model's breaker is OPEN (skip it)
//   - recordMember(modelId,ok) → feed each panel member's outcome back, which
//                                closes the breaker on success or trips it open
//                                after repeated failures (then half-open recovery)
//
// One shared instance lives for the lifetime of the app process — exactly the
// scope the task asks for ("skipped on subsequent Fusion calls within the same
// app process … then allowed to recover").

import { CircuitBreaker } from './circuit-breaker.js'

// Tuned for LLM panels: a couple of consecutive failures trip the breaker, then
// back off in the tens-of-seconds range (binary-exponential, capped) before a
// single half-open probe is granted.
const DEFAULTS = {
  failureThreshold: 2,
  baseDelayMs: 30_000,
  maxDelayMs: 5 * 60_000,
} as const

export class FusionBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private get(modelId: string): CircuitBreaker {
    let b = this.breakers.get(modelId)
    if (!b) {
      b = new CircuitBreaker({ ...DEFAULTS }, this.now)
      this.breakers.set(modelId, b)
    }
    return b
  }

  /**
   * True when this model id should be SKIPPED on the current Fusion call (its
   * breaker is open and the backoff window has not elapsed). Calling this both
   * answers the question AND advances the breaker into half-open when the window
   * passes (granting one probe) — so a skipped-then-recovering model is retried.
   */
  shouldSkip(modelId: string): boolean {
    return !this.get(modelId).shouldAttempt()
  }

  /** Feed a panel member's outcome back: success closes, failure may trip open. */
  record(modelId: string, ok: boolean): void {
    const b = this.get(modelId)
    if (ok) b.recordSuccess()
    else b.recordFailure()
  }
}

// Shared per-process registry used by all Fusion entry points (chat streamFusion,
// agent consult_panel / fuse_plan). Test the class directly with an injected clock.
export const fusionBreakers = new FusionBreakerRegistry()
