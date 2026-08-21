// apps/desktop/electron/services/darksol-money-policy.ts
//
// PURE money-moving policy gate for the darksol MCP shim (and any in-process
// caller). Zero imports — no electron, no node builtins — so it bundles cleanly
// into the standalone `darksol-mcp-server` rollup entry (electron.vite.config.ts)
// that runs in a plain `node <script>` child process.
//
// WHY THIS EXISTS (audit 2026-06-12, dimension 2 / CRITICAL):
//   The darksol per-trade / daily ETH ceiling and recipient allowlist were
//   DEFINED (wallet-service.AgentLimits) but enforced ONLY by flags passed to
//   the third-party `darksol agent start` sidecar — NOT on the MCP path. An LLM
//   agent (tachi/openclaude) calling `send`/`swap` through the darksol MCP
//   shim had no per-trade cap, no allowlist, and could pass dryRun:false to
//   execute a real transfer. This module is the in-process chokepoint the shim
//   consults BEFORE shelling out to the darksol CLI, so TachiDesk enforces the
//   limits itself regardless of what the external CLI does. Fail-closed.

/** ETH has 18 decimals. We compare amounts in wei (BigInt) to avoid float error. */
const WEI_DECIMALS = 18

/**
 * Parse a plain non-negative decimal ETH string to wei (BigInt), or null if the
 * string is not a clean decimal we can safely compare. Rejects: empty, negative,
 * scientific notation, >18 fractional digits, multiple dots, non-digits.
 * Whitespace is trimmed.
 */
export function toWei(value: string): bigint | null {
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const [intPart, fracPartRaw = ''] = s.split('.')
  if (fracPartRaw.length > WEI_DECIMALS) return null // would lose precision / can't represent
  const frac = fracPartRaw.padEnd(WEI_DECIMALS, '0')
  try {
    return BigInt(intPart) * 10n ** BigInt(WEI_DECIMALS) + BigInt(frac || '0')
  } catch {
    return null
  }
}

/** Whether a limit string is a valid non-negative plain decimal (0 allowed). */
export function isValidLimitString(value: string): boolean {
  return toWei(value) !== null
}

export interface MoneyToolCall {
  /** darksol harness tool name, e.g. 'send' | 'swap'. */
  tool: string
  /** Human-readable amount string (e.g. '0.05'); may be absent/garbage. */
  amount?: unknown
  /** Recipient address for `send` (the "recipient wallet" allowlist target). */
  to?: unknown
  /** Caller-supplied dry-run flag (may be undefined). */
  dryRun?: unknown
}

export interface MoneyPolicy {
  /** True when the wallet has dry-run LOCKED ON — real transfers are forbidden. */
  dryRunForced: boolean
  /** Per-trade ceiling in ETH (decimal string). */
  maxPerTradeEth: string
  /** Recipient/contract addresses; empty = no recipient restriction. */
  allowlist: string[]
}

export interface MoneyDecision {
  allowed: boolean
  reason?: string
  /** The dry-run value the shim should actually forward to the CLI. */
  effectiveDryRun: boolean
}

/**
 * Cross-trade risk gate consulted before a REAL money action is approved.
 * Structurally satisfied by the RiskBreaker from darksol-risk-breaker.ts —
 * declared here as a minimal shape so this pure module takes no hard import.
 */
export interface RiskGate {
  isTripped(): { tripped: boolean; reason?: string }
}

/** Tools whose `to` field is an external recipient the allowlist should gate. */
const RECIPIENT_TOOLS = new Set(['send'])

/**
 * Decide whether a money-moving tool call may proceed, and with what dry-run.
 *
 * Rules (fail-closed):
 *   1. dryRunForced → always a simulation (effectiveDryRun=true), allowed. The
 *      caller cannot turn a locked wallet into a real send by passing dryRun:false.
 *   2. caller dryRun === true → simulation, allowed, caps skipped (nothing real moves).
 *   3. otherwise REAL send → enforce:
 *        a. the cross-trade risk breaker must not be tripped (else deny with its reason),
 *        b. amount must parse (else deny),
 *        c. configured cap must be valid (else deny — misconfigured = unsafe),
 *        d. amount ≤ per-trade cap (else deny),
 *        e. for recipient tools, `to` ∈ allowlist when the allowlist is non-empty.
 *
 * `breaker` is optional and only consulted on the REAL-send path — a simulation
 * moves no money, so a tripped breaker never blocks a dry run. Omitting it
 * preserves the original single-trade-only behaviour.
 */
export function evaluateMoneyPolicy(call: MoneyToolCall, policy: MoneyPolicy, breaker?: RiskGate): MoneyDecision {
  // 1. Locked dry-run: force a simulation, always allowed.
  if (policy.dryRunForced) {
    return { allowed: true, effectiveDryRun: true }
  }

  // 2. Caller explicitly asked for a simulation.
  if (call.dryRun === true) {
    return { allowed: true, effectiveDryRun: true }
  }

  // 3. Real send — the cross-trade risk breaker gates BEFORE the single-trade caps:
  // a failure streak / rolling spend / rolling action burst halts all real money
  // until a manual reset, regardless of whether this one trade is within caps.
  if (breaker) {
    const trip = breaker.isTripped()
    if (trip.tripped) {
      return { allowed: false, effectiveDryRun: false, reason: trip.reason ?? 'Refused: the wallet risk breaker is tripped. Reset it to continue.' }
    }
  }

  // Real send — enforce the ceiling + allowlist.
  const amountStr = typeof call.amount === 'string' ? call.amount : String(call.amount ?? '')
  const amountWei = toWei(amountStr)
  if (amountWei === null) {
    return { allowed: false, effectiveDryRun: false, reason: `Refused: "${call.tool}" has an invalid or missing amount ("${amountStr}").` }
  }

  const capWei = toWei(policy.maxPerTradeEth)
  if (capWei === null) {
    return { allowed: false, effectiveDryRun: false, reason: `Refused: the per-trade limit is misconfigured ("${policy.maxPerTradeEth}"). Set a valid limit in the Wallet tab.` }
  }

  if (amountWei > capWei) {
    return { allowed: false, effectiveDryRun: false, reason: `Refused: ${amountStr} exceeds the per-trade cap of ${policy.maxPerTradeEth} ETH. Raise the limit in the Wallet tab or send less.` }
  }

  // Recipient allowlist (send-style tools only — swap has no external recipient).
  if (RECIPIENT_TOOLS.has(call.tool) && policy.allowlist.length > 0) {
    const to = typeof call.to === 'string' ? call.to.trim().toLowerCase() : ''
    const allowed = policy.allowlist.map(a => a.trim().toLowerCase())
    if (!to || !allowed.includes(to)) {
      return { allowed: false, effectiveDryRun: false, reason: `Refused: recipient "${typeof call.to === 'string' ? call.to : '(none)'}" is not in the wallet's allowlist.` }
    }
  }

  return { allowed: true, effectiveDryRun: false }
}

/** Parse the DARKSOL_ALLOWLIST env (JSON array or comma list) into a string[]. */
export function parseAllowlistEnv(raw: string | undefined): string[] {
  if (!raw) return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean)
}
