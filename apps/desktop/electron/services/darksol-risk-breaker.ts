// apps/desktop/electron/services/darksol-risk-breaker.ts
//
// PURE money-policy risk circuit breaker for the darksol MCP shim. Zero imports —
// no electron, no node builtins — so it bundles cleanly into the standalone
// `darksol-mcp-server` rollup entry (electron.vite.config.ts) alongside the
// money-policy gate it feeds, and so vitest can import it without electron.
//
// WHY THIS EXISTS:
//   The money-policy gate (darksol-money-policy.ts) caps a SINGLE trade — per-trade
//   ETH ceiling, recipient allowlist, dry-run lock. It cannot see ACROSS trades: an
//   agent (or a prompt-injected one) can still bleed the wallet via many in-cap
//   sends, or hammer failing transactions that each burn gas. This breaker is the
//   cross-trade safety net. Adapted from CloddsBot's typed-condition circuit breaker
//   (consecutive-failures + rolling-loss windows + manual reset), sized to our
//   agent-wallet reality: failure streaks, rolling USD spend, rolling action count.
//   Fail-closed: once tripped it denies real money actions until a manual reset.

/** N money actions that failed in a row trips the breaker. */
export interface ConsecutiveFailuresCondition {
  type: 'consecutiveFailures'
  /** Trip once the failure streak reaches this count. */
  max: number
}

/** Total USD spent within a sliding window trips the breaker once it exceeds maxUsd. */
export interface RollingSpendUsdCondition {
  type: 'rollingSpendUsd'
  /** Window length in ms; spend older than this slides out. */
  windowMs: number
  /** Trip once windowed spend strictly exceeds this. */
  maxUsd: number
}

/** Too many money actions within a sliding window trips the breaker. */
export interface RollingActionCountCondition {
  type: 'rollingActionCount'
  /** Window length in ms; actions older than this slide out. */
  windowMs: number
  /** Trip once the windowed action count strictly exceeds this. */
  max: number
}

export type TripCondition =
  | ConsecutiveFailuresCondition
  | RollingSpendUsdCondition
  | RollingActionCountCondition

export interface RiskBreakerConfig {
  conditions: TripCondition[]
}

export interface TripResult {
  tripped: boolean
  /** Present only when tripped — human-readable cause for the deny message. */
  reason?: string
}

export interface RiskBreaker {
  /**
   * Record the outcome of one money action.
   * @param action darksol tool name (e.g. 'send' | 'swap'), kept for diagnostics.
   * @param ok     whether the action succeeded.
   * @param usd    approximate USD value moved/spent (counted even on failure —
   *               a failed real send can still burn gas). Omitted -> 0.
   */
  recordOutcome(action: string, ok: boolean, usd?: number): void
  /** Whether any condition is currently met. Pure read — does not mutate state. */
  isTripped(): TripResult
  /** Clear all accumulated state (streak, windows). The operator's "I've got this" reset. */
  manualReset(): void
}

/** Injectable monotonic-ish clock; defaults to Date.now (fine in the plain-node child). */
export type Clock = () => number

interface ActionRecord {
  at: number
  usd: number
}

/**
 * Build a risk breaker. State lives in the closure; one instance guards one wallet
 * session. Conditions are OR-ed — the first met condition trips and names the reason.
 */
export function createRiskBreaker(config: RiskBreakerConfig, clock: Clock = Date.now): RiskBreaker {
  const conditions = config.conditions ?? []
  let consecutiveFailures = 0
  // Rolling history of recorded actions; pruned lazily to the longest configured window.
  let history: ActionRecord[] = []

  /** Longest window any rolling condition cares about — older records can be dropped. */
  function maxWindowMs(): number {
    let max = 0
    for (const c of conditions) {
      if (c.type === 'rollingSpendUsd' || c.type === 'rollingActionCount') {
        if (c.windowMs > max) max = c.windowMs
      }
    }
    return max
  }

  function prune(now: number): void {
    const window = maxWindowMs()
    if (window <= 0) {
      history = []
      return
    }
    const cutoff = now - window
    if (history.length && history[0].at <= cutoff) {
      history = history.filter(r => r.at > cutoff)
    }
  }

  function checkCondition(c: TripCondition, now: number): TripResult {
    switch (c.type) {
      case 'consecutiveFailures': {
        if (consecutiveFailures >= c.max) {
          return { tripped: true, reason: `Refused: ${consecutiveFailures} consecutive money-action failures (limit ${c.max}). Reset the wallet risk breaker once you've checked what's wrong.` }
        }
        return { tripped: false }
      }
      case 'rollingSpendUsd': {
        const cutoff = now - c.windowMs
        let spend = 0
        for (const r of history) if (r.at > cutoff) spend += r.usd
        if (spend > c.maxUsd) {
          return { tripped: true, reason: `Refused: rolling spend ~$${spend.toFixed(2)} USD in the last ${Math.round(c.windowMs / 1000)}s (limit $${c.maxUsd}). Reset the wallet risk breaker to continue.` }
        }
        return { tripped: false }
      }
      case 'rollingActionCount': {
        const cutoff = now - c.windowMs
        let count = 0
        for (const r of history) if (r.at > cutoff) count++
        if (count > c.max) {
          return { tripped: true, reason: `Refused: ${count} money actions in the last ${Math.round(c.windowMs / 1000)}s (limit ${c.max}). Reset the wallet risk breaker to continue.` }
        }
        return { tripped: false }
      }
      default:
        return { tripped: false }
    }
  }

  return {
    recordOutcome(_action: string, ok: boolean, usd = 0): void {
      const now = clock()
      if (ok) consecutiveFailures = 0
      else consecutiveFailures++
      history.push({ at: now, usd: typeof usd === 'number' && usd > 0 ? usd : 0 })
      prune(now)
    },

    isTripped(): TripResult {
      const now = clock()
      for (const c of conditions) {
        const r = checkCondition(c, now)
        if (r.tripped) return r
      }
      return { tripped: false }
    },

    manualReset(): void {
      consecutiveFailures = 0
      history = []
    },
  }
}
