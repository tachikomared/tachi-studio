// apps/desktop/electron/services/provider-key-probe.ts
//
// "IS THIS PASTED KEY LIVE?" — for the four provider credentials that can
// actually be asked, plus the written record of why the fifth cannot.
//
// This module exists because of the Civitai lesson (docs/app/
// CIVITAI-AUTH-RESEARCH-2026-08-01.md §5): every PUBLIC endpoint of that API
// answers a clean 200 to a garbage bearer, so a validator built on the obvious
// endpoint would have printed a green tick over a typo. Only /api/v1/me reacted
// to the caller. The same question had to be asked of the five remaining key
// cards ONE PROVIDER AT A TIME, by measurement, because the answer is different
// for each.
//
// ═══════════════════════════════════════════════════════════════════════════
// TWO WAYS TO FAIL, AND CONFLATING THEM IS ITSELF A BUG
// ═══════════════════════════════════════════════════════════════════════════
//
// Until 2026-08-01 every failure here was one flat `{ ok: false }`, and the
// Settings card hard-blocked the save on all of them. That is right for exactly
// one case and dangerous for every other:
//
//   REJECTED   the provider answered, and the answer was about the CREDENTIAL:
//              "this is not a key I accept" (a documented 401). We learned a
//              fact. Never store it.
//   UNVERIFIED we did not learn anything about the credential: the machine is
//              offline, the request timed out, the edge 5xx'd, an x402 payment
//              challenge came back (which means no credential reached them at
//              all), or the answer was unparseable. Store the key and SAY that
//              it could not be checked.
//
// Hard-blocking an UNVERIFIED result strands a working key the user cannot save
// at all — a plane-mode paste, a provider outage, a corporate proxy. And telling
// them "your key is bad" on a network blip is a lie about a fact we do not have.
// `verdictFor()` below is the single place that decides which is which, and
// `validateThenStoreKey` (SettingsPage) is the single place that acts on it.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE MEASUREMENTS. 2026-08-01, from a clean shell, with NO real key: only
// no-header, an obviously fake bearer ("nope"), and a plausibly-shaped fake
// ("ogw_live_9f2c…", "bk_live_9f2c…", "inf_9f2c…", a 32-char Venice-shaped
// string, a "kat_…:sk_…" pair). The owner's keys stayed DPAPI-encrypted in the
// keychain throughout; none was read, decrypted or sent anywhere.
//
// ── OpenGateway — NO SIGNAL ────────────────────────────────────────────────
//   GET https://opengateway.gitlawb.com/v1/models
//     no header ................... 200, full catalog
//     Bearer nope ................. 200, byte-identical catalog
//     Bearer ogw_live_9f2c…(fake) . 200, byte-identical catalog
//   GET /v1/{me,credits,balance,key,usage,account,keys/me,auth/me,user}
//     any header .................. 404, body verbatim:
//                                   "Not found. Use POST /v1/chat/completions."
//   ⇒ The gateway exposes exactly two things: a keyless model list and a PAID
//     pay-as-you-go completion. A validator would have to spend the user's
//     money on every paste, and the free-model list it could aim at has already
//     drifted once (MiMo went paid 2026-07-16). NO VALIDATOR. There is also no
//     docs site, no OpenAPI and no llms.txt to overturn this with — unlike the
//     four below, this refusal rests on the absence of an endpoint, not on the
//     absence of a document.
//
// ── Venice — VALIDATOR: GET /api/v1/api_keys/rate_limits ───────────────────
//   Every INFERENCE-surface GET is public and therefore useless here:
//   /models, /models/traits, /models/compatibility_mapping, /image/styles and
//   /crypto/rpc/networks all answered 200 to no header AND to a fake bearer
//   (the swagger even declares `security: [{}, BearerAuth]` on /models).
//   GET https://api.venice.ai/api/v1/api_keys/rate_limits   (re-measured today)
//     no header ................... 402 {"x402Version":2,"error":
//                                   "Authentication required", …} — an x402
//                                   payment challenge, i.e. NOTHING about a key
//     Bearer <32-char fake> ....... 401 {"error":"Authentication failed"}
//   The swagger calls it "Return details about user balances and rate limits"
//   and carries NO `x-payment-info` on this path (24 other paths do) — a free
//   metadata read. Its 200 body is `{data:{accessPermitted, apiTier{id,
//   isCharged}, balances{USD,DIEM}, keyExpiration, nextEpochBegins,
//   rateLimits[]}}`.
//
//   WHY 403 IS A PASS, NOT A FAILURE. <https://docs.venice.ai/api-reference/
//   error-codes> separates the two things a flat "auth error" would merge:
//     401 AUTHENTICATION_FAILED               "Authentication failed"
//     401 AUTHENTICATION_FAILED_INACTIVE_KEY  "…Pro subscription is inactive"
//     403 UNAUTHORIZED                        "Unauthorized access"
//     403 API_ACCESS_DISABLED                 "API access has been disabled…"
//   403 is Venice's documented code for a REAL key that lacks rights. So a
//   scope-limited key gets `ok: true, limited: true`: accepted, no balance
//   claimed, nothing asserted beyond what we saw.
//
//   ⚠ THE OPEN QUESTION, and the reason a Venice 401 is NOT final — see
//     `validateVeniceKey` below, where the whole argument lives next to the
//     code that acts on it.
//
// ── imgnAI — VALIDATOR: GET /v1/me/balance ─────────────────────────────────
//   GET https://kat.imgnai.com/v1/models
//     no header ................... 200 (sectioned images/videos/text catalog)
//     Bearer nope ................. 200 (OpenAI-shaped list — it reacts to the
//                                   header's PRESENCE, never to its value)
//   GET https://kat.imgnai.com/v1/me/balance
//     no header ................... 401 {"detail":"Missing API credentials"}
//     Bearer nope (no colon) ...... 401 {"detail":"Missing API credentials"}
//     Bearer key:secret (fake) .... 401 {"detail":"Invalid API credentials"}
//     X-API-Key + X-API-Secret .... 401 {"detail":"Invalid API credentials"}
//     X-API-Key alone ............. 401 {"detail":"Missing API credentials"}
//   ⇒ A free account read that separates "no credential" from "a credential I
//     reject", and it only accepts the PAIR — which is exactly what the
//     two-field card needs to check. Documented at
//     <https://kat.imgnai.com/llms.txt> ("To check a standard account credit
//     balance by API, call GET /v1/me/balance with the account API key and
//     secret"), response `{"credits":"1234.5"}`.
//
// ── Bankr — VALIDATOR: GET /v1/credits ─────────────────────────────────────
//   GET https://llm.bankr.bot/v1/credits            (measured today)
//     no header ......... 401 {"error":{"message":"API key required",…}}
//     Bearer bk_live_9f2c…(fake)
//                       . 401 {"error":{"message":"Invalid or inactive API key",
//                              "type":"auth_error"}}
//   GET https://llm.bankr.bot/v1/models — same two 401s; this was the validator
//     until today. /v1/credits replaces it because it answers with a fact the
//     user can act on rather than a model count:
//     <https://docs.bankr.bot/llm-gateway/api-reference> — "Returns the current
//     LLM credit balance for the API key's wallet. Requires authentication",
//     `{object:"credit_balance", balanceUsd, effectiveBalanceUsd,
//     undeductedCostUsd}`, where effectiveBalanceUsd "is the truest available
//     balance because it nets out in-flight usage".
//   THE HEADER IS DOCUMENTED, NOT JUST MEASURED: the same page states that all
//     requests take the key "in the X-API-Key header or Authorization: Bearer
//     token". We send Bearer, matching every other provider in this module.
//   ⚠ GET https://llm.bankr.bot/health → 200 WITH NO HEADER AT ALL. That was a
//     live bug in `determineBankrHealth` (packages/core/src/providers/bankr/
//     bankr-health.ts): its level-1 probe hit /health unauthenticated and
//     returned 'healthy' before the authenticated check was ever reached, so
//     `provider:test-key` — the onboarding "Test" button — reported healthy for
//     ANY string. FIXED 2026-08-01 there; this module never asks /health.
//
// ── Surplus — VALIDATOR: POST /anthropic/v1/messages/count_tokens ──────────
//   Their READ surface is keyless, as measured: /v1/models, /v1/prices,
//   /api/markets and /anthropic/v1/models all 200 to no header and to a fake
//   `inf_…` bearer; /v1/{me,credits,balance,key,usage} 404 "Cannot GET /v1/…".
//   OUR OWN TABLE WAS WRONG about what that implies. It claimed only a
//   USDC-spending request reads a buyer key. It does not:
//   POST https://api.surplusintelligence.ai/anthropic/v1/messages/count_tokens
//     x-api-key: inf_9f2c…(fake) ... 401 {"type":"error","error":{"type":
//                                   "authentication_error","message":"Missing
//                                   or invalid API key. Set ANTHROPIC_AUTH_TOKEN
//                                   (or x-api-key) to your Surplus buyer key
//                                   (inf_…)."}}
//     no key at all ............... 401, byte-identical message
//     Authorization: Bearer inf_… . 401, byte-identical message (both accepted)
//   ⇒ It reads the buyer key and it does no inference. FREE-NESS IS INFERRED,
//     NOT DOCUMENTED: no page says "this endpoint is free" in words. What
//     <https://surplusintelligence.ai/docs/api-reference/messages> does say is
//     mechanism-level — count_tokens "is a heuristic estimate (no upstream
//     round-trip)" — so there is no seller call and nothing to settle. The same
//     page pins the 401: "An unauthenticated or non-buyer request returns an
//     Anthropic-shaped 401 authentication_error".
//   ⚠ HOST DISCREPANCY, deliberately not resolved here. The registry's
//     `surplus.baseUrl` is `https://www.surplusintelligence.ai/api/inference/v1`
//     (the OpenAI-shaped chat surface the whole app talks to). count_tokens is
//     NOT reachable there — measured today:
//       www…/api/inference/anthropic/v1/messages/count_tokens → 410
//         {"code":"endpoint_removed", "…Call https://api.surplusintelligence.ai
//         directly"}
//       www…/api/inference/v1/messages/count_tokens           → 404
//         "Cannot POST /v1/messages/count_tokens"
//     So this ONE call names the docs' canonical `api.` host explicitly instead
//     of deriving it from the registry, and the registry base URL is left
//     exactly as it is. Changing where chat routes is a separate decision with
//     its own evidence; a validator must not smuggle it in.
// ═══════════════════════════════════════════════════════════════════════════
//
// MAIN-PROCESS ONLY, like the Civitai and HuggingFace validators next door: an
// authenticated cross-origin request from the renderer is a CORS problem at
// best and a credential in a web context at worst. The renderer asks over IPC
// and gets back an ACCOUNT FACT (a balance, a tier, a token count) — never the
// key.
//
// None of these functions throws. A Settings card must be able to RENDER a
// failure instead of catching one.

import { enforceProviderEgress } from './egress-policy'

/** Same budget as the other Settings pings — long enough for a cold edge. */
const TIMEOUT_MS = 8_000
const timeout = () => AbortSignal.timeout(TIMEOUT_MS) as AbortSignal

// ── THE VERDICT VOCABULARY ───────────────────────────────────────────────────
//
// Exported from here rather than from a new module because four of the six
// validators live in this file; civitai-search.ts and hf-search.ts import these
// three helpers so that all six speak the same two words. One definition, or
// the distinction rots into six slightly different ones.

/** What a failed probe actually established. See the block comment above. */
export type ProbeVerdict = 'rejected' | 'unverified'

/** The failure half of every key probe in the app. */
export type KeyProbeFailure = { ok: false; verdict: ProbeVerdict; status?: number }

/** The provider answered, and the answer was "this credential is invalid". */
export const rejected = (status: number): KeyProbeFailure =>
  ({ ok: false, verdict: 'rejected', status })

/**
 * We could not ask, or the answer was not about the credential.
 *
 * The status is OMITTED rather than set to undefined when there was no HTTP
 * answer at all — an offline machine and a 503 are both unverified, but only
 * one of them has a number to show.
 */
export const unverified = (status?: number): KeyProbeFailure =>
  status === undefined ? { ok: false, verdict: 'unverified' } : { ok: false, verdict: 'unverified', status }

/**
 * The default HTTP→verdict rule: ONLY 401 is an affirmative rejection.
 *
 * Everything else — 402 payment challenge, 403, 404, 429, 5xx — is a statement
 * about the request, the account's rights or the service, not about whether the
 * pasted string is the user's key. Providers that need a different rule (Venice
 * does, twice) map their statuses themselves and say why.
 */
export const verdictFor = (status: number): KeyProbeFailure =>
  status === 401 ? rejected(401) : unverified(status)

/**
 * Hosts mirrored from packages/core/src/providers/registry.ts (`bankr-gateway`,
 * `imgnai`, `venice` baseUrl). Pinned by test/unit/providerKeyProbe.test.ts so a
 * registry move cannot leave a validator pointing at a dead host. Surplus is the
 * documented exception — see the HOST DISCREPANCY note above.
 */
const BANKR_CREDITS_URL   = 'https://llm.bankr.bot/v1/credits'
const IMGNAI_BALANCE_URL  = 'https://kat.imgnai.com/v1/me/balance'
const VENICE_LIMITS_URL   = 'https://api.venice.ai/api/v1/api_keys/rate_limits'
const SURPLUS_COUNT_URL   = 'https://api.surplusintelligence.ai/anthropic/v1/messages/count_tokens'

const BANKR_KEY_ID   = 'bankr-gateway'
const IMGNAI_KEY_ID  = 'imgnai'
const VENICE_KEY_ID  = 'venice'
const SURPLUS_KEY_ID = 'surplus'

// ── Bankr ─────────────────────────────────────────────────────────────────────

/** The answer to "does Bankr accept this key?" — never the key back. */
export type BankrKeyProbe =
  | { ok: true; balanceUsd: string }
  | KeyProbeFailure

/**
 * Validate a PASTED Bankr key against the authenticated credit balance.
 *
 * Takes the key as an ARGUMENT and never reads the keychain: the card pings
 * BEFORE it saves, so a rejected key is never stored — and pinging the stored
 * copy would report on the credential being replaced rather than the new one.
 *
 * WHAT A GREEN ANSWER PROVES: the gateway accepts this key for authenticated
 * reads right now, and how much credit its wallet has. WHAT IT DOES NOT PROVE:
 * that any particular model is routable — this call spends nothing.
 *
 * `effectiveBalanceUsd` is preferred over `balanceUsd` on Bankr's own advice
 * (it nets out in-flight usage); a body we cannot read still leaves the key
 * ACCEPTED, with an empty balance, because refusing a credential the gateway
 * just took would be the wrong way round.
 */
export async function validateBankrKey(key: unknown): Promise<BankrKeyProbe> {
  const k = typeof key === 'string' ? key.trim() : ''
  // No request for an empty box — and no egress check either, since nothing
  // would be sent. An empty box was never a rejection: nothing was asked.
  if (!k) return unverified()
  try {
    enforceProviderEgress(BANKR_KEY_ID)
    const res = await fetch(BANKR_CREDITS_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${k}` },
      signal: timeout(),
    })
    if (!res.ok) return verdictFor(res.status)
    const body = await res.json().catch(() => null) as
      { balanceUsd?: unknown; effectiveBalanceUsd?: unknown } | null
    const n = typeof body?.effectiveBalanceUsd === 'number'
      ? body.effectiveBalanceUsd
      : typeof body?.balanceUsd === 'number'
        ? body.balanceUsd
        : null
    return { ok: true, balanceUsd: n === null ? '' : n.toFixed(2) }
  } catch {
    return unverified()
  }
}

// ── imgnAI ────────────────────────────────────────────────────────────────────

/** The answer to "does imgnAI accept this key+secret PAIR?" */
export type ImgnaiKeyProbe =
  | { ok: true; credits: string }
  | KeyProbeFailure

/**
 * Validate a PASTED imgnAI key + secret against the account balance read.
 *
 * TWO ARGUMENTS, NOT THE COMBINED "key:secret" STRING, on purpose: this is the
 * one call in the app that must prove BOTH halves are right, and it sends them
 * as the `X-API-Key` / `X-API-Secret` pair — the exact shape imgnai-media.ts
 * will use for every image and video render. A combined bearer would also be
 * accepted by this endpoint, but it would test the text path's shape only.
 *
 * EITHER HALF MISSING ⇒ UNVERIFIED WITH NO REQUEST. `/v1/me/balance` answers
 * "Missing API credentials" to a lone key (measured above), so a single-field
 * credential is a question this endpoint cannot answer — and "could not ask" is
 * the honest reading, never "the key is bad". The card does not route a
 * one-field save through here at all; it saves that case directly, unvalidated,
 * and says so on screen.
 *
 * WHAT A GREEN ANSWER PROVES: imgnAI accepts this pair for account reads, and
 * the balance it reports. WHAT IT DOES NOT PROVE: that the balance covers any
 * particular render, or that a given model is available to this account.
 */
export async function validateImgnaiCredential(key: unknown, secret: unknown): Promise<ImgnaiKeyProbe> {
  const k = typeof key    === 'string' ? key.trim()    : ''
  const s = typeof secret === 'string' ? secret.trim() : ''
  if (!k || !s) return unverified()
  try {
    enforceProviderEgress(IMGNAI_KEY_ID)
    const res = await fetch(IMGNAI_BALANCE_URL, {
      headers: {
        Accept:           'application/json',
        'X-API-Key':      k,
        'X-API-Secret':   s,
      },
      signal: timeout(),
    })
    if (!res.ok) return verdictFor(res.status)
    const body = await res.json().catch(() => null) as { credits?: unknown } | null
    // `credits` is a DECIMAL STRING in imgnAI's own contract ("1234.5"), already
    // converted from the 10x service units — so it is passed through verbatim
    // rather than parsed and re-formatted into a different number.
    const credits = typeof body?.credits === 'string'
      ? body.credits
      : typeof body?.credits === 'number'
        ? String(body.credits)
        : ''
    return { ok: true, credits }
  } catch {
    return unverified()
  }
}

// ── Venice ────────────────────────────────────────────────────────────────────

/**
 * The answer to "does Venice accept this key?".
 *
 * `limited: true` is the 403 case: a key Venice recognises but will not let
 * read account metadata. There is no balance to report and none is invented.
 */
export type VeniceKeyProbe =
  | { ok: true; limited: boolean; accessPermitted?: boolean; tier?: string; usd?: string; diem?: string }
  | KeyProbeFailure

/**
 * Validate a PASTED Venice key against the API-key rate-limit read.
 *
 * STATUS MAP, and every line of it is a decision:
 *   200 → valid. Surfaces `apiTier.id` and the USD balance — the same shape of
 *         checkable fact the imgnAI card shows — plus `accessPermitted`, which
 *         is the one thing a green tick would otherwise paper over (a key that
 *         authenticates but may not call inference).
 *   403 → VALID BUT SCOPE-LIMITED. Venice's error-code page reserves 403 for
 *         UNAUTHORIZED / API_ACCESS_DISABLED — a real credential without
 *         rights. Accepting it and claiming nothing more is the honest read.
 *   402 → UNVERIFIED. An x402 challenge is what this endpoint returns when NO
 *         credential arrives; rendering it as a bad key would be a straight
 *         lie about a request that never carried one.
 *   401 → UNVERIFIED, with its own warning copy. NOT `rejected`. Read on.
 *   anything else / throw → UNVERIFIED.
 *
 * ═══ WHY A VENICE 401 MAY NOT BE FINAL — the open question, in the code ═══
 *
 * Venice splits keys into ADMIN and INFERENCE ("Admin keys have full access to
 * the API while inference keys are only able to call inference endpoints" —
 * api.venice.ai/api/v1/swagger.yaml), and their key-generation guide tells
 * users to prefer Inference Only, which is the type a desktop app should be
 * holding. NOBODY HAS ESTABLISHED WHAT AN INFERENCE KEY GETS FROM THIS
 * ENDPOINT. Two documents disagree about whether 401 is even possible for a
 * live key:
 *   • the error-code page says a valid-but-unentitled caller gets 403, which
 *     would make 401 mean "bad credential" and a strict rejection correct;
 *   • the swagger's per-path response list for /api_keys/rate_limits declares
 *     only 200, 401 and 500 — NO 403 — which formally leaves 401 as the
 *     response an inference key could receive, contradicting the first.
 * Only a real inference key can settle it, and minting one is not something
 * this codebase may do with the owner's account.
 *
 * SO 401 IS TREATED AS UNVERIFIED-WITH-A-WARNING, and the key is stored. The
 * alternative — reject, plus a "save anyway" escape hatch — was rejected for
 * two reasons. First, it makes the DEFAULT outcome the sentence we are least
 * sure of ("your key is bad"), and buries the truth behind a control most users
 * will read as "I know better than the app". Second, Venice's own error table
 * already lists a 401 that is NOT a bad credential:
 * AUTHENTICATION_FAILED_INACTIVE_KEY, "Pro subscription is inactive" — a real
 * key on a lapsed plan. A 401 here is documented to be ambiguous even before
 * the inference-key question, so making it final would be wrong on paper today,
 * not merely risky in theory.
 *
 * The card therefore says: saved, Venice answered "authentication failed", here
 * is what that can mean. Not "your key is bad".
 *
 * TO CLOSE THIS: mint a Venice INFERENCE-type key and call
 * `GET /api/v1/api_keys/rate_limits` with it. A 200 or 403 means this 401 can
 * become a real `rejected`. A 401 means it must stay exactly as it is.
 */
export async function validateVeniceKey(key: unknown): Promise<VeniceKeyProbe> {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) return unverified()
  try {
    enforceProviderEgress(VENICE_KEY_ID)
    const res = await fetch(VENICE_LIMITS_URL, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${k}` },
      signal: timeout(),
    })
    // A key Venice knows but will not let read this. Accepted; nothing claimed.
    if (res.status === 403) return { ok: true, limited: true }
    if (!res.ok) {
      // 401 included — see the block above. Never `rejected` for Venice.
      return unverified(res.status)
    }
    const body = await res.json().catch(() => null) as { data?: unknown } | null
    // The swagger nests everything under `data`; tolerate a flat body too rather
    // than dropping facts if that ever changes.
    const d = (body && typeof body === 'object' && 'data' in body && body.data && typeof body.data === 'object'
      ? body.data
      : body) as {
        accessPermitted?: unknown
        apiTier?: { id?: unknown } | null
        balances?: { USD?: unknown; DIEM?: unknown } | null
      } | null
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '')
    return {
      ok: true,
      limited: false,
      accessPermitted: typeof d?.accessPermitted === 'boolean' ? d.accessPermitted : undefined,
      tier: typeof d?.apiTier?.id === 'string' ? d.apiTier.id : '',
      usd:  num(d?.balances?.USD),
      diem: num(d?.balances?.DIEM),
    }
  } catch {
    return unverified()
  }
}

// ── Surplus ───────────────────────────────────────────────────────────────────

/** The answer to "does Surplus accept this buyer key?" */
export type SurplusKeyProbe =
  | { ok: true; tokens: number }
  | KeyProbeFailure

/**
 * Validate a PASTED Surplus buyer key against the token-count estimator.
 *
 * THE POINT OF THIS ENDPOINT: it reads the buyer key and does NO inference.
 * Their docs call the result "a heuristic estimate (no upstream round-trip)" —
 * no seller is called, so there is nothing to settle and no USDC moves. That is
 * mechanism-level evidence, not a published "this is free"; it is the strongest
 * claim available and this comment does not upgrade it.
 *
 * The two-token body is the smallest well-formed Anthropic request their skin
 * will parse. `x-api-key` is their documented default (the Anthropic-SDK shape);
 * Bearer is accepted too, and both produce the identical 401 for a fake key.
 *
 * 200 → valid, with the estimate as the checkable fact. 401 → REJECTED (their
 * only auth failure, documented and measured, identical for a missing key and a
 * bad one — which is fine here because we always send one). Everything else,
 * including a 402 or an unreadable body, is UNVERIFIED.
 */
export async function validateSurplusKey(key: unknown): Promise<SurplusKeyProbe> {
  const k = typeof key === 'string' ? key.trim() : ''
  if (!k) return unverified()
  try {
    enforceProviderEgress(SURPLUS_KEY_ID)
    const res = await fetch(SURPLUS_COUNT_URL, {
      method: 'POST',
      headers: {
        Accept:         'application/json',
        'Content-Type': 'application/json',
        'x-api-key':    k,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: timeout(),
    })
    if (!res.ok) return verdictFor(res.status)
    const body = await res.json().catch(() => null) as { input_tokens?: unknown } | null
    // A 200 we could not parse is still an ACCEPTED key.
    return { ok: true, tokens: typeof body?.input_tokens === 'number' ? body.input_tokens : 0 }
  } catch {
    return unverified()
  }
}
