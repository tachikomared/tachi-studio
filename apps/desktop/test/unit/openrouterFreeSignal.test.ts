// apps/desktop/test/unit/openrouterFreeSignal.test.ts
//
// THE per-model OpenRouter free signal (FREE-FLEET-SWEEP-2026-08-01 §3):
//
//     free ⇔ live pricing.prompt === 0 AND pricing.completion === 0
//
// — never the `:free` id suffix (a name, not a price: 322 of 336 OpenRouter
// models are paid), and never a provider-level billing flip. These tests drive
// the real service against a stubbed live catalog.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: vi.fn(() => null),
}))

// Importing the service is what REGISTERS its live-rate lookup with the cost
// ledger (see the bottom of openrouter-service.ts). That side effect is the
// subject of the last describe block in this file, so the import order matters.
import { listOpenrouterModels, liveOpenrouterRates } from '../../electron/services/openrouter-service'
import { CostLedger, resolveRegisteredLiveRates } from '../../electron/services/cost-ledger'

const catalog = (data: unknown) =>
  ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response

beforeEach(() => { vi.restoreAllMocks() })

describe('OpenRouter per-model free signal', () => {
  it('free ⇔ BOTH live prices are exactly zero — the suffix buys nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', pricing: { prompt: '0', completion: '0' } },
      // A paid model wearing the :free suffix — the tencent/hy3 trap.
      { id: 'someorg/paid-model:free', pricing: { prompt: '0.000002', completion: '0.000004' } },
      // Half-zero is NOT free (completion still costs money).
      { id: 'someorg/half-free', pricing: { prompt: '0', completion: '0.000004' } },
      { id: 'anthropic/claude-sonnet-4.6', pricing: { prompt: '0.000003', completion: '0.000015' } },
    ])))
    const res = await listOpenrouterModels({ force: true })
    expect(res.ok).toBe(true)
    const byId = Object.fromEntries(res.models.map(m => [m.id, m]))
    expect(byId['nvidia/nemotron-3-ultra-550b-a55b:free']!.free).toBe(true)
    expect(byId['someorg/paid-model:free']!.free).toBe(false)      // THE PIN
    expect(byId['someorg/half-free']!.free).toBe(false)
    expect(byId['anthropic/claude-sonnet-4.6']!.free).toBe(false)
  })

  it('absent / empty / malformed pricing claims nothing (never free)', async () => {
    // Number('') === 0 is the trap: an empty string price must NOT read as $0.
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'a/no-pricing' },
      { id: 'a/empty-strings', pricing: { prompt: '', completion: '' } },
      { id: 'a/garbage', pricing: { prompt: 'zero', completion: '0' } },
      { id: 'a/really-free', pricing: { prompt: '0', completion: '0' } },
    ])))
    const res = await listOpenrouterModels({ force: true })
    const byId = Object.fromEntries(res.models.map(m => [m.id, m]))
    expect(byId['a/no-pricing']!.free).toBe(false)
    expect(byId['a/empty-strings']!.free).toBe(false)
    expect(byId['a/garbage']!.free).toBe(false)
    expect(byId['a/really-free']!.free).toBe(true)
  })

  it('sorts auto → free → paid, de-duplicating catalog rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'anthropic/claude-sonnet-4.6', pricing: { prompt: '0.000003', completion: '0.000015' } },
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'a/free-row', pricing: { prompt: '0', completion: '0' } },
      { id: 'a/free-row', pricing: { prompt: '0', completion: '0' } },  // duplicate alias row
    ])))
    const res = await listOpenrouterModels({ force: true })
    expect(res.models.map(m => m.id)).toEqual([
      'openrouter/auto', 'a/free-row', 'anthropic/claude-sonnet-4.6',
    ])
  })

  it('a failed live fetch degrades to the dated fallback, marked stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const res = await listOpenrouterModels({ force: true })
    expect(res.ok).toBe(true)
    expect(res.stale).toBe(true)
    // The fallback free set is the dated 2026-08-01 whitelist (live:false), so
    // even offline the affordance never claims a paid model is free.
    for (const m of res.models) {
      expect(m.live).toBe(false)
      if (m.id === 'openrouter/auto') expect(m.free).toBe(false)
    }
    expect(res.models.some(m => m.free)).toBe(true)
  })
})

describe('OpenRouter live context window', () => {
  it('carries the catalog window through, and omits it when unpublished', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'a/normal', context_length: 262144, pricing: { prompt: '0', completion: '0' } },
      // Some rows publish the window only under top_provider.
      { id: 'a/nested', top_provider: { context_length: 131072 }, pricing: { prompt: '1', completion: '1' } },
      // THE PIN: no window published ⇒ no field. Absent is "unknown", and the
      // static capability rows answer instead of us inventing a number.
      { id: 'a/silent', pricing: { prompt: '1', completion: '1' } },
      { id: 'a/junk', context_length: 0, pricing: { prompt: '1', completion: '1' } },
    ])))
    const byId = Object.fromEntries((await listOpenrouterModels({ force: true })).models.map(m => [m.id, m]))
    expect(byId['a/normal']!.contextTokens).toBe(262144)
    expect(byId['a/nested']!.contextTokens).toBe(131072)
    expect(byId['a/silent']!.contextTokens).toBeUndefined()
    expect(byId['a/junk']!.contextTokens).toBeUndefined()
  })

  it('the dated offline fallback carries the exact catalog windows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const byId = Object.fromEntries((await listOpenrouterModels({ force: true })).models.map(m => [m.id, m]))
    // 262_144, not a rounded 262_000 — this list is the evidence the @tachi/core
    // capability rows for gemma-4 / ling-3.0 / laguna are pinned against.
    expect(byId['google/gemma-4-31b-it:free']!.contextTokens).toBe(262_144)
    expect(byId['inclusionai/ling-3.0-flash:free']!.contextTokens).toBe(262_144)
    expect(byId['poolside/laguna-s-2.1:free']!.contextTokens).toBe(262_144)
    expect(byId['openai/gpt-oss-20b:free']!.contextTokens).toBe(131_072)
  })
})

// ── LIVE per-model rates (2026-08-02) ────────────────────────────────────────
// The catalog publishes a real price for every row and the service used to
// reduce all of it to one boolean, which is why 281 of 337 picker rows showed
// no price band. The numbers were already on the wire.
describe('OpenRouter live per-model rates', () => {
  it('converts the per-token price strings to $/M for every priced row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005', input_cache_write: '0.00000625' } },
      { id: 'openai/gpt-5.5', pricing: { prompt: '0.000005', completion: '0.00003' } },
    ])))
    const byId = Object.fromEntries((await listOpenrouterModels({ force: true })).models.map(m => [m.id, m]))
    // The two rates the brief named, as the live catalog publishes them.
    expect(byId['anthropic/claude-opus-5']!.rates).toEqual({
      inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWritePerM: 6.25,
    })
    // Cache fields are optional: omitted upstream ⇒ omitted here, so the shared
    // 0.1×/1.25× heuristic applies downstream rather than a fabricated zero.
    expect(byId['openai/gpt-5.5']!.rates).toEqual({ inputPerM: 5, outputPerM: 30 })
  })

  it('forwards NOTHING — never zero — when a price cannot be read', async () => {
    // THE TRAP, and it is the bug the `:free` work fixed on 2026-08-01: a zero
    // reads as "free". Number('') === 0, so an empty string must yield no rate.
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'a/no-pricing' },
      { id: 'a/empty-strings', pricing: { prompt: '', completion: '' } },
      { id: 'a/garbage', pricing: { prompt: 'zero', completion: '0.000001' } },
      { id: 'a/half-published', pricing: { prompt: '0.000001' } },
      { id: 'a/negative', pricing: { prompt: '-1', completion: '1' } },
      { id: 'a/really-free', pricing: { prompt: '0', completion: '0' } },
    ])))
    const byId = Object.fromEntries((await listOpenrouterModels({ force: true })).models.map(m => [m.id, m]))
    for (const id of ['a/no-pricing', 'a/empty-strings', 'a/garbage', 'a/half-published', 'a/negative'])
      expect(byId[id]!.rates, id).toBeUndefined()
    // A genuine $0 IS a readable price and must survive as one.
    expect(byId['a/really-free']!.rates).toEqual({ inputPerM: 0, outputPerM: 0 })
  })

  it('`free` stays an independent claim, derived from the same payload', async () => {
    // free must NOT start being computed from the new rate fields — it is a
    // separately audited claim, and the two must agree because they read the
    // same source, not because one is derived from the other.
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'a/paid', pricing: { prompt: '0.000002', completion: '0.000004' } },
      { id: 'a/free', pricing: { prompt: '0', completion: '0' } },
      { id: 'a/unreadable', pricing: { prompt: '', completion: '' } },
    ])))
    const byId = Object.fromEntries((await listOpenrouterModels({ force: true })).models.map(m => [m.id, m]))
    expect(byId['a/paid']!.free).toBe(false)
    expect(byId['a/paid']!.rates).toEqual({ inputPerM: 2, outputPerM: 4 })
    expect(byId['a/free']!.free).toBe(true)
    // Unreadable price ⇒ not free AND not priced. Two refusals, one cause.
    expect(byId['a/unreadable']!.free).toBe(false)
    expect(byId['a/unreadable']!.rates).toBeUndefined()
  })

  it('the offline fallback rows carry NO rates — they are not live facts', async () => {
    // THE OTHER TRAP: the curated fallback lists 14 free rows with a static
    // `free: true`. Attaching a rate to a hand-written row would print "the
    // provider's live catalog says…" over a number a human typed.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const res = await listOpenrouterModels({ force: true })
    expect(res.stale).toBe(true)
    for (const m of res.models) {
      expect(m.live, m.id).toBe(false)
      expect(m.rates, m.id).toBeUndefined()
    }
  })

  it('liveOpenrouterRates reads the cache and never fetches', async () => {
    // The cost ledger calls this while recording an event. It must be
    // synchronous and cache-only: a slow or down catalog can never stall or
    // fail a ledger write, because the ledger is the spend cap's data.
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'openai/gpt-5.5', pricing: { prompt: '0.000005', completion: '0.00003' } },
    ])))
    await listOpenrouterModels({ force: true })

    const fetchSpy = vi.fn(async () => { throw new Error('must not be called') })
    vi.stubGlobal('fetch', fetchSpy)
    expect(liveOpenrouterRates('openai/gpt-5.5')).toEqual({ inputPerM: 5, outputPerM: 30 })
    expect(liveOpenrouterRates('OpenAI/GPT-5.5')).toEqual({ inputPerM: 5, outputPerM: 30 })  // case-insensitive
    expect(liveOpenrouterRates('anthropic/not-in-catalog')).toBeNull()
    expect(liveOpenrouterRates('')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ── The wire between the catalog and the ledger (2026-08-02) ─────────────────
//
// cost-ledger used to reach for this service with `require('./openrouter-
// service')`. electron-vite bundles main into ONE out/main/index.js, so that
// relative path does not exist inside app.asar: the require threw "Cannot find
// module" in every packaged build while `pnpm dev` was perfect. It is inverted
// now — this service registers its cache-only lookup with the ledger at module
// init, and the ledger imports nothing.
//
// This file is where that can be proven end to end: it is the one that already
// imports the service (with the keychain stubbed), so the registration has
// actually happened by the time these tests run.
describe('the catalog publishes its rates to the cost ledger', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'or-ledger-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  const ledger = () => new CostLedger(join(dir, 'cost-ledger.jsonl'), () => 1_754_000_000_000,
    resolveRegisteredLiveRates)

  it('a ledger write prices from the LIVE rate once the catalog is loaded', async () => {
    // The live catalog says $9/M in. The bundled table says $3/M for the same
    // model — the drift that let real spend past the 30-day cap.
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'anthropic/claude-sonnet-4.6', pricing: { prompt: '0.000009', completion: '0' } },
    ])))
    await listOpenrouterModels({ force: true })

    const ev = ledger().record('openrouter-oauth', 'anthropic/claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(9)
    expect(ev.rateSource).toBe('live-catalog')
  })

  it('…and from the STATIC TABLE for a model the catalog does not carry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'anthropic/claude-sonnet-4.6', pricing: { prompt: '0.000009', completion: '0' } },
    ])))
    await listOpenrouterModels({ force: true })

    // Same live catalog, a model absent from it: the resolver returns null and
    // the bundled snapshot answers. Never $0.
    const ev = ledger().record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(3)
    expect(ev.priced).toBe(true)
    expect(ev.rateSource).toBe('price-table')
  })

  it('the registration claims OpenRouter rows only — it never answers for another provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'anthropic/claude-sonnet-4.6', pricing: { prompt: '0.000009', completion: '0' } },
    ])))
    await listOpenrouterModels({ force: true })

    // The SAME model id, billed through Anthropic directly, is not OpenRouter's
    // to price. It must fall to the table, or one gateway's discount would
    // silently reprice every other provider's identical model.
    expect(resolveRegisteredLiveRates('anthropic-oauth', 'anthropic/claude-sonnet-4.6')).toBeNull()
    const ev = ledger().record('anthropic-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.rateSource).toBe('price-table')
  })

  it('an unfetched catalog degrades to the table — it does NOT fetch from a ledger write', async () => {
    // The pre-existing behaviour, and the reason the lookup is cache-only: the
    // ledger is the spend cap's data and must acquire no network dependency.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await listOpenrouterModels({ force: true })   // stale fallback rows, live:false

    const fetchSpy = vi.fn(async () => { throw new Error('must not be called') })
    vi.stubGlobal('fetch', fetchSpy)
    const ev = ledger().record('openrouter-oauth', 'claude-sonnet-4.6', 1_000_000, 0)
    expect(ev.costUsd).toBeCloseTo(3)
    expect(ev.rateSource).toBe('price-table')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
