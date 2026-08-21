// apps/desktop/test/unit/opengatewayCatalog.test.ts
//
// OpenGateway's live catalog, driven against a stubbed wire.
//
// The gateway is the reason the capability table's nemotron row had to become
// an estimate: it serves `nvidia/nemotron-3-ultra-550b-a55b:free` at 131,072
// while OpenRouter serves the SAME id at 1,000,000, and our provider-less row
// carried the other gateway's number while the agent harness routed here. These
// tests pin the four rules that make a live row trustworthy enough to outrank
// it — and the one trap this gateway ships in its own payload.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  listOpengatewayModels,
  liveOpengatewayRates,
  liveOpengatewayContextTokens,
  liveOpengatewayFree,
  liveOpengatewayPromoEndsAt,
  __clearOpengatewayCacheForTests,
} from '../../electron/services/opengateway-service'
import { resolveRegisteredLiveRates } from '../../electron/services/cost-ledger'

const catalog = (data: unknown) =>
  ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response

/** The 2026-08-02 payload, trimmed to the rows each test needs. */
const ROWS = [
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    context_window: 131072,
    pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
    effective_pricing: { prompt: '0', completion: '0', input_cache_read: '0' },
    promo: null,
    aliases: [],
  },
  {
    id: 'inclusionai/ling-3.0-flash:free',
    context_window: 262144,
    pricing: { prompt: '0', completion: '0' },
    effective_pricing: { prompt: '0', completion: '0' },
    promo: { discount: 1, ends_at: '2026-08-03T10:00:00Z', note: 'free launch window' },
  },
  {
    // THE TRAP, and it is the gateway's own structure: a PAID row that ships a
    // `:free` alias.
    id: 'tencent/hy3',
    context_window: 262144,
    pricing: { prompt: '0.0000002', completion: '0.0000008', input_cache_read: '0.00000005' },
    aliases: ['tencent/hy3:free'],
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    context_window: 1048576,
    pricing: { prompt: '0.0000001', completion: '0.0000004' },
  },
]

// The catalog cache is module state and outlives a test. Clearing it is what
// makes the dead-gateway case observable at all — a failed refresh deliberately
// keeps serving the last good read, which is right, and would otherwise make
// every later assertion answer from an earlier test's fixture.
beforeEach(() => { vi.restoreAllMocks(); __clearOpengatewayCacheForTests() })

async function load(rows: unknown[] = ROWS) {
  vi.stubGlobal('fetch', vi.fn(async () => catalog(rows)))
  return listOpengatewayModels({ force: true })
}

describe('the window THIS gateway serves — the reason the file exists', () => {
  it('reads context_window per model', async () => {
    await load()
    expect(liveOpengatewayContextTokens('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(131_072)
    expect(liveOpengatewayContextTokens('google/gemini-3.1-flash-lite')).toBe(1_048_576)
  })

  it('is null for an id the catalog does not carry — never a default', () => {
    // "We do not know" must stay distinguishable from a number, so the caller
    // keeps falling through to the static estimate instead of asserting.
    expect(liveOpengatewayContextTokens('acme/not-served-here')).toBeNull()
    expect(liveOpengatewayContextTokens('')).toBeNull()
  })
})

describe('price comes from the effective rate, never from a name', () => {
  it('free requires BOTH halves at exactly zero', async () => {
    await load()
    expect(liveOpengatewayFree('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(true)
    expect(liveOpengatewayFree('tencent/hy3')).toBe(false)
    expect(liveOpengatewayFree('google/gemini-3.1-flash-lite')).toBe(false)
  })

  it('THE ALIAS TRAP: hy3:free resolves to hy3 and is PAID', async () => {
    await load()
    // The gateway publishes the alias, so we honour it as an ADDRESS — and the
    // row it addresses carries its own price. A `:free` suffix has never been a
    // price in this codebase; here is the gateway itself demonstrating why.
    expect(liveOpengatewayFree('tencent/hy3:free')).toBe(false)
    expect(liveOpengatewayRates('tencent/hy3:free')).toEqual(liveOpengatewayRates('tencent/hy3'))
    expect(liveOpengatewayRates('tencent/hy3:free')?.inputPerM).toBeCloseTo(0.2)
  })

  it('effective_pricing WINS when it is HIGHER than list — the gateway margin', async () => {
    // The real-world shape, measured 2026-08-03: `effective_pricing` is exactly
    // 1.2x `pricing` on every paid row in the catalog. It is the gateway's
    // margin over the upstream list rate, and it is what the user is billed.
    // A ledger priced from `pricing` — the number a hand-entered static row
    // copies, because it is what the underlying vendor publishes — under-counts
    // every run here by 20%, which is the one direction a spend cap may not err.
    await load([{
      id: 'margin/model',
      context_window: 262144,
      pricing: { prompt: '0.0000002', completion: '0.0000008' },
      effective_pricing: { prompt: '0.00000024', completion: '0.00000096' },
    }])
    const r = liveOpengatewayRates('margin/model')!
    expect(r.inputPerM).toBeCloseTo(0.24, 10)
    expect(r.outputPerM).toBeCloseTo(0.96, 10)
    expect(liveOpengatewayFree('margin/model')).toBe(false)
  })

  it('effective_pricing WINS over pricing — you are charged the promo rate', async () => {
    await load([{
      id: 'promo/model',
      context_window: 65536,
      pricing: { prompt: '0.000004', completion: '0.000008' },
      effective_pricing: { prompt: '0', completion: '0' },
      promo: { discount: 1, ends_at: '2026-09-01T00:00:00Z' },
    }])
    expect(liveOpengatewayFree('promo/model')).toBe(true)
    expect(liveOpengatewayRates('promo/model')).toEqual({ inputPerM: 0, outputPerM: 0 })
  })

  it('converts per-token strings to $/M, cache rates included when published', async () => {
    await load()
    const r = liveOpengatewayRates('tencent/hy3')!
    // toBeCloseTo, not toEqual: 0.0000002 * 1e6 is 0.19999999999999998 in IEEE
    // 754. Irrelevant to a bill (it is a 1e-17 error on a per-million rate) but
    // an exact-equality assertion would fail on arithmetic rather than on a
    // change in behaviour, which is a test that cries wolf.
    expect(r.inputPerM).toBeCloseTo(0.2, 10)
    expect(r.outputPerM).toBeCloseTo(0.8, 10)
    expect(r.cacheReadPerM).toBeCloseTo(0.05, 10)
    expect(r.cacheWritePerM).toBeUndefined()   // omitted, not zeroed
  })

  it('an unreadable price is NO price — never a zero that reads as free', async () => {
    // Number('') === 0 is the trap. A blank, a null and a negative must all
    // yield "unknown", because a zero here would promise the run costs nothing.
    await load([
      { id: 'a/blank', pricing: { prompt: '', completion: '' } },
      { id: 'a/missing', pricing: {} },
      { id: 'a/negative', pricing: { prompt: '-1', completion: '2' } },
    ])
    for (const id of ['a/blank', 'a/missing', 'a/negative']) {
      expect(liveOpengatewayRates(id), id).toBeNull()
      expect(liveOpengatewayFree(id), id).toBe(false)
    }
  })
})

describe('a promo that has ENDED stops being a price', () => {
  const ROW = [{
    id: 'promo/expiring',
    context_window: 65536,
    pricing: { prompt: '0.000004', completion: '0.000008' },
    effective_pricing: { prompt: '0', completion: '0' },
    promo: { discount: 1, ends_at: '2026-08-03T10:00:00Z', note: 'free launch window' },
  }]
  const INSIDE = Date.parse('2026-08-03T09:59:00Z')
  const AFTER  = Date.parse('2026-08-03T10:01:00Z')

  it('is free while the window is open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog(ROW)))
    await listOpengatewayModels({ force: true, now: INSIDE })
    expect(liveOpengatewayFree('promo/expiring')).toBe(true)
    expect(liveOpengatewayRates('promo/expiring')?.inputPerM).toBe(0)
  })

  it('falls back to the LIST price the moment it closes', async () => {
    // The whole reason `freeUntil` exists in pricing.ts, restated for a live
    // feed: a row held past its own `ends_at` — a cache straddling the
    // deadline, or a gateway that stopped answering — would keep promising $0
    // for a model that has started billing. The pessimistic direction is the
    // safe one for a spend cap.
    vi.stubGlobal('fetch', vi.fn(async () => catalog(ROW)))
    await listOpengatewayModels({ force: true, now: AFTER })
    expect(liveOpengatewayFree('promo/expiring')).toBe(false)
    expect(liveOpengatewayRates('promo/expiring')?.inputPerM).toBeCloseTo(4, 10)
    expect(liveOpengatewayRates('promo/expiring')?.outputPerM).toBeCloseTo(8, 10)
  })

  it('exactly ON the deadline is already closed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog(ROW)))
    await listOpengatewayModels({ force: true, now: Date.parse('2026-08-03T10:00:00Z') })
    expect(liveOpengatewayFree('promo/expiring')).toBe(false)
  })
})

describe('the promo date the gateway publishes for itself', () => {
  it('is surfaced, and matches what pricing.ts hand-maintains', async () => {
    await load()
    // The exact value VERIFIED_FREE_MODELS carries for the same id. Two
    // independent records agreeing is what makes retiring the hand-dated one
    // safe; a mismatch here is the signal that ours has drifted.
    expect(liveOpengatewayPromoEndsAt('inclusionai/ling-3.0-flash:free'))
      .toBe('2026-08-03T10:00:00Z')
  })

  it('a row with no promo, or an unparseable date, reports nothing', async () => {
    await load([
      ...ROWS,
      { id: 'x/bad-date', context_window: 1000, pricing: { prompt: '0', completion: '0' }, promo: { ends_at: 'soon' } },
    ])
    expect(liveOpengatewayPromoEndsAt('nvidia/nemotron-3-ultra-550b-a55b:free')).toBeNull()
    expect(liveOpengatewayPromoEndsAt('x/bad-date')).toBeNull()
  })
})

describe('a failed fetch degrades to a dated fallback, marked as ours', () => {
  it('serves the curated rows with live:false and says it is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    const res = await listOpengatewayModels({ force: true })
    expect(res.ok).toBe(true)
    expect(res.stale).toBe(true)
    expect(res.models.length).toBeGreaterThan(0)
    expect(res.models.every(m => m.live === false)).toBe(true)
    // …and NOTHING published from a fallback row may be read back as live
    // evidence: a hand-written window must never be laundered into "the
    // provider says".
    expect(liveOpengatewayContextTokens('nvidia/nemotron-3-ultra-550b-a55b:free')).toBeNull()
    expect(liveOpengatewayRates('tencent/hy3')).toBeNull()
  })

  it('the fallback still carries THIS gateway 131k, not the other one 1M', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    const res = await listOpengatewayModels({ force: true })
    const nemo = res.models.find(m => m.id === 'nvidia/nemotron-3-ultra-550b-a55b:free')
    expect(nemo?.contextTokens).toBe(131_072)
  })
})

describe('the harness budget seam — the reason this is not just a picker feed', () => {
  it('the loop asks THIS service for the window on the opengateway route', () => {
    // Source-pinned, because the loop's own test file pins the surrounding call
    // site by string and a driver cannot reach a history budget. The rung must
    // go through the alias-aware lookup, not a find() on the returned list: the
    // gateway serves `tencent/hy3` as `tencent/hy3:free` as well, and an
    // id-equality scan would miss a run that used the alias.
    const src = readFileSync(
      join(__dirname, '../../electron/services/tachi/loop.ts'), 'utf8')
    expect(src).toContain("if (providerId === 'opengateway')")
    expect(src).toContain('liveOpengatewayContextTokens(modelId) ?? undefined')
    // The prose that used to say this gateway published nothing must not
    // survive the code that proves it does.
    expect(src).not.toContain('opengateway, imgnAI and the freellmapi router publish none')
  })

  it('an id the gateway does not serve still yields nothing to budget from', async () => {
    await load()
    expect(liveOpengatewayContextTokens('anthropic/claude-opus-5')).toBeNull()
  })
})

describe('the ledger seam', () => {
  it('claims opengateway rows and nobody else\'s', async () => {
    await load()
    // Importing the service registered the resolver; the ledger walks every
    // registered resolver and each returns null for what it does not own.
    expect(resolveRegisteredLiveRates('opengateway', 'tencent/hy3')?.inputPerM).toBeCloseTo(0.2)
    expect(resolveRegisteredLiveRates('bankr-gateway', 'tencent/hy3')).toBeNull()
    expect(resolveRegisteredLiveRates('opengateway', 'anthropic/claude-opus-5')).toBeNull()
  })
})
