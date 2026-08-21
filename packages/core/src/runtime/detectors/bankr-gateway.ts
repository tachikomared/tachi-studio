import { RuntimeDetector, RuntimeCardUpdate, RuntimeStatus } from '../types.js'
import { determineBankrHealth } from '../../providers/bankr/bankr-health.js'

export function createBankrGatewayDetector(apiKey?: string, fetchFn: typeof fetch = fetch): RuntimeDetector {
  return {
    runtimeId: 'bankr-gateway', kind: 'cloud_gateway', displayName: 'Bankr Gateway',
    async detect(): Promise<RuntimeCardUpdate> {
      const base = {
        runtimeId: 'bankr-gateway', kind: 'cloud_gateway' as const,
        displayName: 'Bankr Gateway', endpoint: 'https://llm.bankr.bot',
      }
      if (!apiKey) return { ...base, status: 'needs_login', checkedAt: new Date().toISOString() }
      const health = await determineBankrHealth(apiKey, fetchFn)
      // 'degraded' (a 429/5xx from the gateway, or "gateway is up but the
      // authenticated call never completed") is NOT the same fact as
      // 'unreachable'. Collapsing it into 'unreachable' was live, working-key
      // behaviour reported as a dead gateway — a rate limit or a transient 5xx
      // on Bankr's side would have painted the whole card red and sent the user
      // hunting for a local problem that isn't theirs. RuntimeStatus has no
      // "reachable but degraded" state, so this deliberately reuses 'unknown' —
      // defined in the enum but not otherwise used by any detector — which
      // StudioPage.tsx / Sidebar.tsx already render neutrally (no color/label
      // entry ⇒ dim dot, plain uppercased text), neither a green lie nor a red
      // one. True network failure (the fetch never got an answer from anything,
      // including /health) still maps to 'unreachable'.
      const status: RuntimeStatus =
        health.status === 'healthy' ? 'healthy'
        : health.status === 'reachable_auth_invalid' ? 'needs_login'
        : health.status === 'degraded' ? 'unknown'
        : 'unreachable'
      const error = health.status === 'degraded' ? health.message : undefined
      return { ...base, status, error, checkedAt: new Date().toISOString() }
    },
  }
}
