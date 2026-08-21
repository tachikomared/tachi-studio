// packages/core/src/providers/bankr/bankr-health.ts
//
// "Is the Bankr gateway usable WITH THIS KEY?" — and only the authenticated
// request is allowed to answer yes.
//
// ─── WHAT THIS FILE USED TO DO, AND WHY IT WAS WRONG ─────────────────────────
// Until 2026-08-01 the first thing it did was probe `${BASE_URL}/health` with
// NO Authorization header and return `{ status: 'healthy' }` if it answered 200.
// Measured live 2026-08-01:
//
//   GET https://llm.bankr.bot/health      no header → 200
//                                         {"status":"ok","providers":{…}}
//   GET https://llm.bankr.bot/v1/health   no header → 401 "API key required"
//   GET https://llm.bankr.bot/v1/models   no header → 401 "API key required"
//                                         Bearer nope → 401 "Invalid or
//                                         inactive API key"
//                                         plausibly-shaped fake → same 401
//
// `/health` (no `/v1`) is a PUBLIC gateway-liveness page. It answers 200 to
// anyone, so the early return fired every time and the authenticated `/v1/models`
// block below it was unreachable code. The function therefore returned `healthy`
// for ANY string — including a typo, an expired key, or an empty box.
//
// That verdict is not academic: it reaches
// apps/desktop/electron/services/provider-service.ts (healthCheck + testKey for
// both 'bankr' and 'bankr-gateway'), the `provider:health-check` and
// `provider:test-key` IPC channels, and the onboarding ProviderStep "Test"
// button. A new user pasting a mistyped key in their first minute with the app
// got a green "connected" and then an unexplainable failure later. A green tick
// on a garbage key is worse than no tick at all, because it sends the user
// looking for the problem somewhere else.
//
// ─── THE RULE NOW ────────────────────────────────────────────────────────────
// ONLY the authenticated `/v1/models` request may produce `healthy` or
// `reachable_auth_invalid`. It runs FIRST and it is the whole verdict on the
// happy path — one request, not two.
//
// `/health` survives strictly as a REACHABILITY signal, and it is consulted only
// when the authenticated call could not complete at all (network error, DNS,
// timeout). It can no longer produce `healthy`; the most it can do is soften
// `unreachable` to `degraded`, which is a genuinely different and useful fact:
// "the gateway is up, so this is your network or their edge, not their outage —
// but we still do not know anything about your key." Both of those states render
// distinctly in ProviderStep, so the nuance reaches the user instead of being
// flattened into a lie.
//
// ─── ONE MORE PLACE THIS IS MEASURED ─────────────────────────────────────────
// apps/desktop/electron/services/provider-key-probe.ts `validateBankrKey` asks
// the SAME authenticated endpoint for the Settings card's validate-before-store
// ping, and carries the full status table for all five provider cards. It is a
// separate function because it returns the model COUNT (a fact HealthStatus
// cannot carry) and runs behind the desktop app's PRIVATE MODE egress gate,
// which this package must not import. It deliberately does NOT call this
// function — that was written down when the /health bug was found here and is
// still true. `BASE_URL` below stays the single Bankr host in this package.

import { HealthStatus } from '../../chat/backend.js'

const BASE_URL = 'https://llm.bankr.bot'

/** Same budget for both probes; a health check must never hold up a UI. */
const TIMEOUT_MS = 5_000

/**
 * The gateway answered but the authenticated call did not, so the key is
 * UNKNOWN — not good, not bad. English string, matching the existing
 * `HealthStatus.message` convention in this file and in
 * provider-service.ts's discoveryToHealth (ProviderStep renders `message`
 * verbatim and falls back to a translated generic line when it is absent).
 */
const GATEWAY_UP_KEY_UNKNOWN =
  'Bankr\'s gateway is reachable, but the authenticated request did not complete — the key could not be checked.'

export async function determineBankrHealth(
  apiKey: string,
  fetchFn: typeof fetch = fetch
): Promise<HealthStatus> {
  // ── THE VERDICT. Authenticated, first, and on its own. ─────────────────────
  try {
    const modelsRes = await fetchFn(`${BASE_URL}/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // 2xx here means the gateway accepted THIS key for an authenticated read.
    if (modelsRes.ok) return { status: 'healthy' }
    // 401 = "API key required" / "Invalid or inactive API key"; 403 = accepted
    // but not permitted. Either way the credential is what needs fixing.
    if (modelsRes.status === 401 || modelsRes.status === 403) return { status: 'reachable_auth_invalid' }
    // Anything else (429, 5xx …) is the gateway's problem, not the key's, and
    // must not be reported as either healthy or rejected.
    return { status: 'degraded', message: `Models endpoint returned ${modelsRes.status}` }
  } catch {
    // We never got an answer. Fall through to the reachability question ONLY —
    // there is nothing here that can license a `healthy`.
  }

  // ── REACHABILITY ONLY, and only because the call above failed. ─────────────
  try {
    const healthRes = await fetchFn(`${BASE_URL}/health`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (healthRes.ok) return { status: 'degraded', message: GATEWAY_UP_KEY_UNKNOWN }
  } catch {
    // Nothing answered at all.
  }
  return { status: 'unreachable' }
}
