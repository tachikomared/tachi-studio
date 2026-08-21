// apps/desktop/test/unit/providerKeyProbe.test.ts
//
// The four provider validators — and the ONE deliberate absence next to them.
//
// A green tick on a garbage key is worse than no tick at all: it tells the user
// the credential is fine and sends them looking for the problem somewhere else.
// So the rule this file holds is not "validate the key cards", it is:
//
//     a validator may only exist where a FREE endpoint measurably
//     distinguishes a bad key from no key, and it may only call a key BAD when
//     the provider actually said so.
//
// THE SECOND HALF OF THAT RULE IS NEW (2026-08-01) and it is the bigger of the
// two. Every failure used to be one flat `{ ok: false }` and the card blocked
// the save on all of them, so an offline laptop, a 503 and a payment challenge
// all rendered as "your key is bad" AND cost the user the save. Now:
//
//     REJECTED    the provider answered about the credential (a 401). No write.
//     UNVERIFIED  we learned nothing — offline, timeout, 5xx, 402, garbage
//                 body. The key IS stored, and the card says it was not checked.
//
// Measured 2026-08-01 against the live APIs with no-header, an obviously fake
// bearer, and a plausibly-shaped fake — never with a real key. Full status
// tables are in the module under test. Verdicts:
//
//   bankr   ✅ GET /v1/credits    401 "API key required" / "Invalid or inactive
//                                API key"; 200 carries the wallet balance.
//   imgnai  ✅ GET /v1/me/balance 401 "Missing API credentials" for a lone
//                                half, 401 "Invalid API credentials" for a
//                                fake pair — the only free endpoint that can
//                                judge BOTH fields.
//   venice  ✅ GET /api/v1/api_keys/rate_limits — no header → 402 x402
//                                challenge, fake bearer → 401. 403 is their
//                                DOCUMENTED "valid key, no rights", so it
//                                passes; their 401 is ambiguous, so it does
//                                NOT reject (suite 3 pins the whole argument).
//   surplus ✅ POST /anthropic/v1/messages/count_tokens — reads the buyer key,
//                                runs no inference, settles nothing. 401 for a
//                                fake inf_ key.
//   opengateway ❌ /v1/models 200s any string incl. no header; everything else
//                                404s "Use POST /v1/chat/completions" (PAID).
//                                No docs site, no OpenAPI, no llms.txt either.
//
// Suite 6 pins that last absence: if someone later adds a channel for it, this
// file fails and asks for the measurement first.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// PRIVATE MODE off by default; one test per validator flips it.
let privacyMode: 'open' | 'private' = 'open'
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => privacyMode }))

import {
  validateBankrKey,
  validateImgnaiCredential,
  validateVeniceKey,
  validateSurplusKey,
  rejected,
  unverified,
  verdictFor,
} from '../../electron/services/provider-key-probe'

const PROBE_MODULE = 'electron/services/provider-key-probe.ts'
const PROVIDERS_IPC = 'electron/ipc/providers.ipc.ts'
const PRELOAD = 'electron/preload.ts'
const SETTINGS_PAGE = 'src/pages/settings/SettingsPage.tsx'

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response
const errResponse = (status: number) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response

beforeEach(() => { privacyMode = 'open'; vi.restoreAllMocks() })
afterEach(() => { vi.unstubAllGlobals() })

// ═══════════════════════════════════════════════════════════════════════════
// 0. THE VERDICT VOCABULARY — one definition, six validators
// ═══════════════════════════════════════════════════════════════════════════

describe('rejected / unverified — the distinction itself', () => {
  it('only 401 is an affirmative rejection; everything else is unverified', () => {
    expect(verdictFor(401)).toEqual({ ok: false, verdict: 'rejected', status: 401 })
    for (const s of [400, 402, 403, 404, 418, 429, 500, 502, 503]) {
      expect(verdictFor(s), String(s)).toEqual({ ok: false, verdict: 'unverified', status: s })
    }
  })

  it('unverified with NO answer at all omits the status rather than faking one', () => {
    // An offline machine and a 503 are both unverified, but only one of them has
    // a number to show — and a card that printed "(undefined)" would be worse
    // than one that printed nothing.
    expect(unverified()).toEqual({ ok: false, verdict: 'unverified' })
    expect('status' in unverified()).toBe(false)
    expect(unverified(503)).toEqual({ ok: false, verdict: 'unverified', status: 503 })
  })

  it('rejected always carries the status that justified it', () => {
    expect(rejected(401)).toEqual({ ok: false, verdict: 'rejected', status: 401 })
  })

  it('the two weights-host validators import this vocabulary rather than copying it', () => {
    // Six validators, one definition. Two slightly different definitions is how
    // one of them starts calling a network blip a bad key again.
    for (const rel of ['electron/services/civitai-search.ts', 'electron/services/hf-search.ts']) {
      const src = read(rel)
      expect(src, rel).toMatch(/from '\.\/provider-key-probe'/)
      expect(strip(src), rel).toContain('verdictFor(res.status)')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. BANKR — GET /v1/credits, authenticated and free
// ═══════════════════════════════════════════════════════════════════════════

describe('validateBankrKey', () => {
  it('asks the AUTHENTICATED credit balance and reports it', async () => {
    const spy = vi.fn(async () => okResponse({
      object: 'credit_balance', balanceUsd: 12.34, effectiveBalanceUsd: 11.2, undeductedCostUsd: 1.14,
    }))
    vi.stubGlobal('fetch', spy)
    // effectiveBalanceUsd wins — Bankr's own docs call it the truest available
    // balance, because it nets out in-flight usage.
    await expect(validateBankrKey('bk_live')).resolves.toEqual({ ok: true, balanceUsd: '11.20' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://llm.bankr.bot/v1/credits')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bk_live')
  })

  it('falls back to balanceUsd when the effective figure is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ balanceUsd: 5 })))
    await expect(validateBankrKey('bk')).resolves.toEqual({ ok: true, balanceUsd: '5.00' })
  })

  it('NEVER asks /health — that one answers 200 with no header at all', async () => {
    // packages/core/.../bankr-health.ts probes /health unauthenticated FIRST and
    // returns 'healthy' when it answers, which it does, anonymously — so that
    // path reports healthy for any string. This validator must not inherit it.
    const spy = vi.fn(async () => okResponse({ balanceUsd: 0 }))
    vi.stubGlobal('fetch', spy)
    await validateBankrKey('bk_live')
    for (const call of spy.mock.calls) {
      expect(String((call as unknown as [string])[0])).not.toContain('/health')
    }
  })

  it('validates the TYPED key — it never reads the keychain', () => {
    // Structural, because it is the reason a rejected key is never stored: the
    // card pings BEFORE it saves, so reading the stored copy would report on the
    // credential being replaced rather than the new one.
    const src = strip(read(PROBE_MODULE))
    expect(src).not.toMatch(/retrieveKey|keychain/)
  })

  it('a 401 is REJECTED — the one answer that may cost the user the save', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(401)))
    await expect(validateBankrKey('nope')).resolves.toEqual({ ok: false, verdict: 'rejected', status: 401 })
  })

  it('a 5xx is UNVERIFIED, not a rejection — Bankr never judged the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(503)))
    await expect(validateBankrKey('bk')).resolves.toEqual({ ok: false, verdict: 'unverified', status: 503 })
  })

  it('a 402 is UNVERIFIED too — an empty wallet is not a bad key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(402)))
    await expect(validateBankrKey('bk')).resolves.toEqual({ ok: false, verdict: 'unverified', status: 402 })
  })

  it('never throws on a network failure — a card must render, not catch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(validateBankrKey('bk')).resolves.toEqual({ ok: false, verdict: 'unverified' })
  })

  it('a 200 with an unreadable body is still an ACCEPTED key', async () => {
    // Refusing to store a credential the gateway just accepted, because we could
    // not read its balance, would be the wrong way round.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => { throw new Error('not json') },
    }) as unknown as Response))
    await expect(validateBankrKey('bk')).resolves.toEqual({ ok: true, balanceUsd: '' })
  })

  it('refuses an empty key without touching the network — and calls it unverified', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    for (const v of ['', '   ', undefined, null, 42]) {
      await expect(validateBankrKey(v)).resolves.toEqual({ ok: false, verdict: 'unverified' })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('PRIVATE MODE blocks it before a byte leaves, and that is UNVERIFIED', async () => {
    // Our own privacy gate saying no tells us nothing about the key. Rendering
    // it as a rejection would blame the user for a setting they chose.
    privacyMode = 'private'
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(validateBankrKey('bk_live')).resolves.toEqual({ ok: false, verdict: 'unverified' })
    expect(spy).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. imgnAI — GET /v1/me/balance, the only endpoint that judges BOTH halves
// ═══════════════════════════════════════════════════════════════════════════

describe('validateImgnaiCredential', () => {
  it('sends the PAIR as the same X-API-Key / X-API-Secret the media engine uses', async () => {
    const spy = vi.fn(async () => okResponse({ credits: '200.0' }))
    vi.stubGlobal('fetch', spy)
    await expect(validateImgnaiCredential('kat_key', 'sk_secret'))
      .resolves.toEqual({ ok: true, credits: '200.0' })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://kat.imgnai.com/v1/me/balance')
    const h = init.headers as Record<string, string>
    expect(h['X-API-Key']).toBe('kat_key')
    expect(h['X-API-Secret']).toBe('sk_secret')
    // The combined bearer is the TEXT path's shape; checking the pair proves the
    // halves that image/video will actually send.
    expect(h.Authorization).toBeUndefined()
  })

  it('EITHER HALF MISSING = no request, and UNVERIFIED rather than a verdict', async () => {
    // /v1/me/balance answers "Missing API credentials" to a lone key, so a
    // one-field credential is a question it cannot answer. "We could not ask" is
    // the honest reading — never "the key is bad".
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    for (const [k, s] of [['k', ''], ['', 's'], ['', ''], ['  ', 'x']] as const) {
      await expect(validateImgnaiCredential(k, s)).resolves.toEqual({ ok: false, verdict: 'unverified' })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('trims both halves before sending them', async () => {
    const spy = vi.fn(async () => okResponse({ credits: '1.0' }))
    vi.stubGlobal('fetch', spy)
    await validateImgnaiCredential('  k  ', '  s  ')
    const h = (spy.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>
    expect(h['X-API-Key']).toBe('k')
    expect(h['X-API-Secret']).toBe('s')
  })

  it('passes the balance through verbatim — it is imgnAI\'s own decimal string', async () => {
    // Their contract: the API already converts the 10x service units, so
    // re-parsing and re-formatting would be inventing a different number.
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ credits: '1234.5' })))
    await expect(validateImgnaiCredential('k', 's')).resolves.toEqual({ ok: true, credits: '1234.5' })
  })

  it('a numeric balance is stringified rather than dropped', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ credits: 42 })))
    await expect(validateImgnaiCredential('k', 's')).resolves.toEqual({ ok: true, credits: '42' })
  })

  it('a 200 with no balance field is still an ACCEPTED pair', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({})))
    await expect(validateImgnaiCredential('k', 's')).resolves.toEqual({ ok: true, credits: '' })
  })

  it('a 401 is REJECTED; a 500 is only UNVERIFIED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(401)))
    await expect(validateImgnaiCredential('k', 's'))
      .resolves.toEqual({ ok: false, verdict: 'rejected', status: 401 })
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(500)))
    await expect(validateImgnaiCredential('k', 's'))
      .resolves.toEqual({ ok: false, verdict: 'unverified', status: 500 })
  })

  it('never throws on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(validateImgnaiCredential('k', 's')).resolves.toEqual({ ok: false, verdict: 'unverified' })
  })

  it('PRIVATE MODE blocks it before a byte leaves', async () => {
    privacyMode = 'private'
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(validateImgnaiCredential('k', 's')).resolves.toEqual({ ok: false, verdict: 'unverified' })
    expect(spy).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. VENICE — 403 is a PASS, and 401 is not final
// ═══════════════════════════════════════════════════════════════════════════

describe('validateVeniceKey', () => {
  const limits = (data: unknown) => okResponse({ data })

  it('asks the rate-limit read and surfaces tier + balance', async () => {
    const spy = vi.fn(async () => limits({
      accessPermitted: true,
      apiTier: { id: 'paid', isCharged: true },
      balances: { USD: 50.23, DIEM: 100.023 },
      keyExpiration: null,
    }))
    vi.stubGlobal('fetch', spy)
    await expect(validateVeniceKey('venice_key')).resolves.toEqual({
      ok: true, limited: false, accessPermitted: true, tier: 'paid', usd: '50.23', diem: '100.02',
    })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.venice.ai/api/v1/api_keys/rate_limits')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer venice_key')
  })

  it('tolerates a FLAT body as well as the spec\'s data-wrapped one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({
      accessPermitted: true, apiTier: { id: 'explorer' }, balances: { USD: 0 },
    })))
    const r = await validateVeniceKey('k')
    expect(r).toMatchObject({ ok: true, tier: 'explorer', usd: '0.00' })
  })

  // ── THE LOAD-BEARING PAIR ─────────────────────────────────────────────────

  it('403 IS A VALID KEY — scope-limited, with no balance invented for it', async () => {
    // docs.venice.ai/api-reference/error-codes: 403 UNAUTHORIZED "Unauthorized
    // access" and 403 API_ACCESS_DISABLED are their codes for a REAL credential
    // that lacks rights. Rejecting one would refuse a key that works.
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(403)))
    await expect(validateVeniceKey('inference_only')).resolves.toEqual({ ok: true, limited: true })
  })

  it('401 IS NOT FINAL — unverified, so the card can still store the key', async () => {
    // Nobody could establish what an INFERENCE-type key gets from this endpoint,
    // and Venice's two documents disagree about whether a 401 is even possible
    // for a live key (error-codes says 403; the swagger's per-path list declares
    // only 200/401/500 and no 403). On top of that their own table lists
    // AUTHENTICATION_FAILED_INACTIVE_KEY as a 401 — a REAL key on a lapsed Pro
    // plan. A rejection here could therefore refuse a working credential.
    await Promise.resolve()
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(401)))
    const r = await validateVeniceKey('maybe_inference_only')
    expect(r).toEqual({ ok: false, verdict: 'unverified', status: 401 })
    expect((r as { verdict?: string }).verdict).not.toBe('rejected')
  })

  it('402 is unverified — an x402 challenge means no credential reached them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(402)))
    await expect(validateVeniceKey('k')).resolves.toEqual({ ok: false, verdict: 'unverified', status: 402 })
  })

  it('accessPermitted:false comes back as a FACT, not as a pass or a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => limits({
      accessPermitted: false, apiTier: { id: 'explorer' }, balances: { USD: 0, DIEM: 0 },
    })))
    const r = await validateVeniceKey('k')
    expect(r).toMatchObject({ ok: true, limited: false, accessPermitted: false })
  })

  it('5xx, a bad body and an empty box are all unverified', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(500)))
    await expect(validateVeniceKey('k')).resolves.toEqual({ ok: false, verdict: 'unverified', status: 500 })
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => { throw new Error('nope') },
    }) as unknown as Response))
    // A 200 we could not parse is still an accepted key — with no facts to show.
    await expect(validateVeniceKey('k')).resolves.toEqual({
      ok: true, limited: false, accessPermitted: undefined, tier: '', usd: '', diem: '',
    })
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(validateVeniceKey('  ')).resolves.toEqual({ ok: false, verdict: 'unverified' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('never throws, and PRIVATE MODE blocks it before a byte leaves', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(validateVeniceKey('k')).resolves.toEqual({ ok: false, verdict: 'unverified' })
    privacyMode = 'private'
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(validateVeniceKey('k')).resolves.toEqual({ ok: false, verdict: 'unverified' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('the open question is WRITTEN DOWN, with the way to close it', () => {
    // The next person must find the reasoning, not just the behaviour —
    // otherwise "401 does not reject" reads as a bug worth tightening.
    const raw = read(PROBE_MODULE)
    expect(raw).toContain('AUTHENTICATION_FAILED_INACTIVE_KEY')
    expect(raw).toContain('only 200, 401 and 500')
    expect(raw).toMatch(/TO CLOSE THIS/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. SURPLUS — the endpoint that reads the buyer key and spends nothing
// ═══════════════════════════════════════════════════════════════════════════

describe('validateSurplusKey', () => {
  it('POSTs the minimal count_tokens request with the documented x-api-key', async () => {
    const spy = vi.fn(async () => okResponse({ input_tokens: 14 }))
    vi.stubGlobal('fetch', spy)
    await expect(validateSurplusKey('inf_live')).resolves.toEqual({ ok: true, tokens: 14 })
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.surplusintelligence.ai/anthropic/v1/messages/count_tokens')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('inf_live')
    const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] }
    expect(body.model).toBeTruthy()
    expect(body.messages).toHaveLength(1)
  })

  it('SPENDS NOTHING — it never touches /v1/messages or /v1/chat/completions', async () => {
    // The whole justification for this validator is that count_tokens is "a
    // heuristic estimate (no upstream round-trip)": no seller call, nothing to
    // settle. A probe that drifted onto the generation endpoint would be
    // spending the owner's USDC on every paste.
    const spy = vi.fn(async () => okResponse({ input_tokens: 1 }))
    vi.stubGlobal('fetch', spy)
    await validateSurplusKey('inf_live')
    for (const call of spy.mock.calls) {
      const url = String((call as unknown as [string])[0])
      expect(url).toContain('/count_tokens')
      expect(url).not.toMatch(/chat\/completions/)
    }
  })

  it('a 401 is REJECTED — their documented authentication_error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errResponse(401)))
    await expect(validateSurplusKey('inf_fake'))
      .resolves.toEqual({ ok: false, verdict: 'rejected', status: 401 })
  })

  it('anything else is UNVERIFIED — 402, 410, 5xx, offline, empty box', async () => {
    for (const s of [402, 410, 500, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => errResponse(s)))
      await expect(validateSurplusKey('inf'), String(s))
        .resolves.toEqual({ ok: false, verdict: 'unverified', status: s })
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(validateSurplusKey('inf')).resolves.toEqual({ ok: false, verdict: 'unverified' })
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(validateSurplusKey('')).resolves.toEqual({ ok: false, verdict: 'unverified' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('a 200 with an unreadable body is still an ACCEPTED key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({})))
    await expect(validateSurplusKey('inf')).resolves.toEqual({ ok: true, tokens: 0 })
  })

  it('PRIVATE MODE blocks it before a byte leaves', async () => {
    privacyMode = 'private'
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(validateSurplusKey('inf')).resolves.toEqual({ ok: false, verdict: 'unverified' })
    expect(spy).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE HOSTS ARE THE REGISTRY'S HOSTS — except the one that cannot be
// ═══════════════════════════════════════════════════════════════════════════

describe('the probe URLs cannot drift from the provider registry', () => {
  const registry = read('../../packages/core/src/providers/registry.ts')

  it('bankr-gateway', () => {
    expect(registry).toContain("baseUrl: 'https://llm.bankr.bot/v1'")
    expect(read(PROBE_MODULE)).toContain("'https://llm.bankr.bot/v1/credits'")
  })

  it('imgnai', () => {
    expect(registry).toContain("baseUrl: 'https://kat.imgnai.com/v1'")
    expect(read(PROBE_MODULE)).toContain("'https://kat.imgnai.com/v1/me/balance'")
  })

  it('venice', () => {
    expect(registry).toContain("baseUrl: 'https://api.venice.ai/api/v1'")
    expect(read(PROBE_MODULE)).toContain("'https://api.venice.ai/api/v1/api_keys/rate_limits'")
  })

  it('surplus is the DOCUMENTED exception, and the registry stays untouched', () => {
    // The app talks to www…/api/inference/v1 for chat. count_tokens is not
    // served there at all — measured 2026-08-01: the /anthropic path 410s with
    // "endpoint_removed · Call https://api.surplusintelligence.ai directly", and
    // /api/inference/v1/messages/count_tokens 404s. So the probe names the docs'
    // canonical host itself, and this test exists so nobody "fixes" the mismatch
    // by quietly repointing where chat routes.
    expect(registry).toContain("baseUrl: 'https://www.surplusintelligence.ai/api/inference/v1'")
    const probe = read(PROBE_MODULE)
    expect(probe).toContain("'https://api.surplusintelligence.ai/anthropic/v1/messages/count_tokens'")
    expect(probe).toContain('HOST DISCREPANCY')
    expect(probe).toContain('endpoint_removed')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE ONE REMAINING ABSENCE IS LOAD-BEARING
// ═══════════════════════════════════════════════════════════════════════════

describe('OpenGateway has NO validator, on purpose', () => {
  it('there is no IPC channel for it to call', () => {
    const ipc = strip(read(PROVIDERS_IPC))
    expect(ipc).not.toMatch(/validate-opengateway/)
    // And the four that DO exist are named per provider rather than generic, so
    // no card can reach a validator that does not apply to it.
    for (const ch of [
      "'provider:validate-bankr-key'",
      "'provider:validate-imgnai-credential'",
      "'provider:validate-venice-key'",
      "'provider:validate-surplus-key'",
    ]) expect(ipc).toContain(ch)
    expect(ipc).not.toContain("'provider:validate-key'")
  })

  it('a malformed IPC payload is UNVERIFIED, never a rejection', () => {
    // Answering `rejected` to our own bug would let a payload-shape mistake stop
    // a user saving a perfectly good key.
    const ipc = strip(read(PROVIDERS_IPC))
    expect((ipc.match(/if \(!parsed\.success\) return unverified\(\)/g) ?? []).length).toBe(4)
  })

  it('the preload surface exposes exactly those four', () => {
    const pre = strip(read(PRELOAD))
    for (const m of ['validateBankrKey:', 'validateImgnaiCredential:', 'validateVeniceKey:', 'validateSurplusKey:']) {
      expect(pre).toContain(m)
    }
    expect(pre).not.toMatch(/validateOpenGateway/i)
  })

  it('its card runs no validateThenStoreKey — and no format check either', () => {
    // A regex over a key's SHAPE proves nothing about whether it works. Dressing
    // one up as a check is the exact failure this whole file exists to prevent.
    const src = strip(read(SETTINGS_PAGE))
    const a = src.indexOf('function OpenGatewayCard')
    const b = src.indexOf('function VeniceCard', a + 1)
    expect(a).toBeGreaterThan(-1)
    expect(b).toBeGreaterThan(a)
    const body = src.slice(a, b)
    expect(body).not.toContain('validateThenStoreKey')
    expect(body).not.toMatch(/startsWith\(|\/\^|test\(key|RegExp/)
    // …and it says so on screen rather than implying a check happened.
    expect(body).toContain("t('keyCard.replaceHintPlain')")
  })

  it('the removed Kilo standalone left no validator, key field or IPC behind', () => {
    // Kilo was a keyless standalone provider (it 200s ANY Authorization value,
    // so a key could never be validated) until 2026-08-01, when it became an
    // upstream INSIDE the FreeLLM local router. The provider is gone; this pins
    // that the deletion was complete rather than partial — a leftover validator
    // or key field for a provider nothing dispatches would be the worst of both
    // worlds. The keyless PATTERN it established is documented in
    // recipes/ADDING-A-PROVIDER.md and still governs OpenCode Zen inside the
    // relay (which needs the Authorization header ABSENT, not empty).
    const ipc = strip(read(PROVIDERS_IPC))
    expect(ipc).not.toMatch(/validate-kilo/)
    const pre = strip(read(PRELOAD))
    expect(pre).not.toMatch(/validateKilo/i)
    const src = strip(read(SETTINGS_PAGE))
    expect(src).not.toContain('function KiloCard')
    expect(src).not.toMatch(/t\('kilo\./)
  })

  it('the free route discloses that some upstreams may train on prompts', () => {
    // THE DISCLOSURE MUST SURVIVE THE MOVE. It used to live on the Kilo card;
    // Kilo is now reachable without the user ever picking it, so the fact moved
    // to the router's own surface. If this fails, the app got quieter about the
    // same risk — which is exactly what the refactor had to avoid.
    const providers = read('src/pages/status/freellmapi-providers.ts')
    expect(providers).toMatch(/trainsOnPrompts:\s*true/)

    const card = read('src/pages/status/ProvidersCard.tsx')
    expect(card).toContain("t('disclosure.trainsOnPrompts')")
    expect(card).toContain("t('disclosure.trainsBadge')")

    // …in every shipped locale, with a real translation (not the English copy).
    const en = JSON.parse(read('src/i18n/locales/en/freellmapi.json'))
    expect(en.disclosure.trainsOnPrompts).toBeTruthy()
    for (const loc of ['ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']) {
      const j = JSON.parse(read(`src/i18n/locales/${loc}/freellmapi.json`))
      expect(j.disclosure?.trainsOnPrompts, `${loc} missing disclosure`).toBeTruthy()
      expect(j.disclosure.trainsOnPrompts).not.toBe(en.disclosure.trainsOnPrompts)
    }

    // …and the picker hint the relay shows carries it too.
    const registry = fs.readFileSync(path.resolve(APP, '../../packages/core/src/providers/registry.ts'), 'utf8')
    const i = registry.indexOf("id: 'freellmapi-local'")
    const hint = registry.slice(i, registry.indexOf('},', i))
    expect(hint).toMatch(/train on your prompts/i)
  })

  it('the measured tables that force the refusal — and justify the four — stay in the source', () => {
    // The next person to look at this must find the evidence, not just the
    // verdict — otherwise "no validator" reads as an oversight worth fixing, and
    // "401 does not reject" reads as a bug.
    const raw = read(PROBE_MODULE)
    for (const marker of [
      'Use POST /v1/chat/completions',      // opengateway 404 body
      'Cannot GET /v1/',                    // surplus keyless read surface
      'Missing API credentials',            // imgnai lone-half 401
      'Invalid or inactive API key',        // bankr fake-key 401
      'x402Version',                        // venice no-header 402
      'no upstream round-trip',             // surplus free-ness, inferred
      'only able to call inference',        // venice key-type split
    ]) {
      expect(raw, marker).toContain(marker)
    }
  })
})
