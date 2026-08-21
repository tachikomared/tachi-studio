// apps/desktop/test/unit/veniceLiveRates.test.ts
//
// Venice's live per-model prices, driven against a stubbed wire.
//
// WHY THIS FILE EXISTS: `model_spec.pricing` was fetched and discarded, so a
// Venice model could only be priced by @tachi/core's bundled table — which
// matches EXACTLY for 2 of the 9 curated ids (measured against MODEL_RATES on
// 2026-08-03: `claude-opus-4-8` and `deepseek-v4-pro`). The picker's band
// refuses that table's substring keyword fallback, correctly, so the other 7
// showed no price at all, and the cost ledger had the same hole from the other
// side.
//
// AND VENICE'S UNITS ARE NOT ITS SIBLINGS'. OpenRouter and OpenGateway publish
// per-TOKEN strings and their readers multiply by 1e6; Venice publishes
// `{ usd, diem }` objects already denominated per MILLION tokens. Every fixture
// below is a verbatim slice of the live payload read on 2026-08-03, so the unit
// is pinned by real numbers rather than by a comment.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// venice-service refuses to fetch without a key, so the suite has to hold one.
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: vi.fn(() => 'test-key'),
}))

import {
  listVeniceModels,
  liveVeniceRates,
  __clearVeniceCacheForTests,
} from '../../electron/services/venice-service'
import { resolveRegisteredLiveRates } from '../../electron/services/cost-ledger'
import { costUsdFromRates } from '@tachi/core'

const catalog = (data: unknown) =>
  ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response

/**
 * Verbatim rows from GET /api/v1/models?type=text, read 2026-08-03. Trimmed to
 * the fields each test needs; the `pricing` blocks are unedited.
 */
const ROWS = [
  {
    // The cheapest shape Venice ships: input/output and nothing else.
    id: 'venice-uncensored-1-2',
    model_spec: {
      availableContextTokens: 32_768,
      pricing: { input: { usd: 0.2, diem: 0.2 }, output: { usd: 0.9, diem: 0.9 } },
    },
  },
  {
    // Full house: both cache halves published.
    id: 'claude-opus-5',
    model_spec: {
      availableContextTokens: 200_000,
      capabilities: { supportsVision: true, supportsFunctionCalling: true },
      pricing: {
        input:       { usd: 6,   diem: 6 },
        cache_input: { usd: 0.6, diem: 0.6 },
        cache_write: { usd: 7.5, diem: 7.5 },
        output:      { usd: 30,  diem: 30 },
      },
    },
  },
  {
    // A SECOND PRICE TIER above 200k prompt tokens — both halves double.
    id: 'grok-4-5',
    model_spec: {
      availableContextTokens: 2_000_000,
      pricing: {
        input:       { usd: 2.27, diem: 2.27 },
        cache_input: { usd: 0.34, diem: 0.34 },
        output:      { usd: 6.8,  diem: 6.8 },
        extended: {
          context_token_threshold: 200_000,
          input:       { usd: 4.53, diem: 4.53 },
          output:      { usd: 13.6, diem: 13.6 },
          cache_input: { usd: 0.68, diem: 0.68 },
        },
      },
    },
  },
]

// The catalog cache is module state and outlives a test. Clearing it is what
// makes the dead-API case observable: a failed refresh deliberately keeps
// serving the last good read, which is right, and would otherwise let an
// earlier test's fixture answer a later assertion.
beforeEach(() => { vi.restoreAllMocks(); __clearVeniceCacheForTests() })

async function load(rows: unknown[] = ROWS) {
  vi.stubGlobal('fetch', vi.fn(async () => catalog(rows)))
  return listVeniceModels({ force: true })
}

describe('the unit — Venice prices in $/M, not per token', () => {
  it('carries the published number through unscaled', async () => {
    await load()
    const r = liveVeniceRates('venice-uncensored-1-2')!
    // The whole point. A borrowed `* 1e6` from the sibling services would make
    // these 200000 and 900000 — a Venice run over-counted a millionfold, which
    // would trip the 30-day spend cap on the first message.
    expect(r.inputPerM).toBe(0.2)
    expect(r.outputPerM).toBe(0.9)
  })

  it('reads `usd`, not `diem`, even while the two agree', async () => {
    // They were equal on all 106 rows that day. The ledger is denominated in
    // dollars, so the reader must not be left to pick whichever it finds first.
    await load([{
      id: 'divergent',
      model_spec: { pricing: { input: { usd: 1, diem: 99 }, output: { usd: 2, diem: 99 } } },
    }])
    expect(liveVeniceRates('divergent')).toMatchObject({ inputPerM: 1, outputPerM: 2 })
  })

  it('prices the row the ledger would actually bill', async () => {
    await load()
    // 1M prompt + 1M completion at 0.2/0.9 is $1.10. Priced through the same
    // function the ledger calls, so the unit is checked end to end rather than
    // asserted on a field.
    const cost = costUsdFromRates(liveVeniceRates('venice-uncensored-1-2')!, 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(1.1, 10)
  })
})

describe('cache rates: carried when published, omitted when not', () => {
  it('maps cache_input → cacheReadPerM and cache_write → cacheWritePerM', async () => {
    await load()
    expect(liveVeniceRates('claude-opus-5')).toEqual({
      inputPerM: 6, outputPerM: 30, cacheReadPerM: 0.6, cacheWritePerM: 7.5,
    })
  })

  it('a row with no cache block omits the fields rather than zeroing them', async () => {
    await load()
    const r = liveVeniceRates('venice-uncensored-1-2')!
    // 33 of the 106 rows publish no cache_input and 84 no cache_write. Omitted
    // falls through to the shared 0.1x / 1.25x heuristic downstream; a zero
    // would claim cached reads are free and under-count every cached run.
    expect(r).not.toHaveProperty('cacheReadPerM')
    expect(r).not.toHaveProperty('cacheWritePerM')
  })
})

describe('the second price tier — the one that would halve a long run', () => {
  it('carries `extended` through as longContext', async () => {
    await load()
    expect(liveVeniceRates('grok-4-5')!.longContext).toEqual({
      minPromptTokens: 200_000, inputPerM: 4.53, outputPerM: 13.6,
    })
  })

  it('and the ledger charges the higher tier once the prompt crosses it', async () => {
    await load()
    const r = liveVeniceRates('grok-4-5')!
    const short = costUsdFromRates(r, 199_999, 0)!
    const long  = costUsdFromRates(r, 200_000, 0)!
    // Dropping the block would price a 400k-token agent run at half rate, and
    // under-counting is the one direction a spend cap may not err in.
    expect(short).toBeCloseTo((199_999 / 1e6) * 2.27, 10)
    expect(long).toBeCloseTo((200_000 / 1e6) * 4.53, 10)
    expect(long).toBeGreaterThan(short * 1.9)
  })

  it('a partial `extended` block is discarded, leaving the base rate in force', async () => {
    await load([{
      id: 'half-tier',
      model_spec: {
        pricing: {
          input: { usd: 1, diem: 1 }, output: { usd: 2, diem: 2 },
          // No threshold, so there is no answer to "above what?" — half-applying
          // it would invent one.
          extended: { input: { usd: 4, diem: 4 }, output: { usd: 8, diem: 8 } },
        },
      },
    }])
    expect(liveVeniceRates('half-tier')).toEqual({ inputPerM: 1, outputPerM: 2 })
  })
})

describe('an unreadable price is NO price — never a zero that reads as free', () => {
  it('drops the whole row\'s rates when either half is missing or corrupt', async () => {
    // `Number('') === 0` is the trap. Venice ships no $0 text model at all
    // (0 of 106 on 2026-08-03), so a zero here could only be a parse failure
    // wearing a price's clothes — and it would promise a free run.
    await load([
      { id: 'blank',    model_spec: { pricing: { input: { usd: '' }, output: { usd: '' } } } },
      { id: 'no-input', model_spec: { pricing: { output: { usd: 3 } } } },
      { id: 'negative', model_spec: { pricing: { input: { usd: -1 }, output: { usd: 2 } } } },
      { id: 'nan',      model_spec: { pricing: { input: { usd: 'free' }, output: { usd: 2 } } } },
      { id: 'no-block', model_spec: { availableContextTokens: 1000 } },
      { id: 'no-spec' },
    ])
    for (const id of ['blank', 'no-input', 'negative', 'nan', 'no-block', 'no-spec']) {
      expect(liveVeniceRates(id), id).toBeNull()
    }
  })

  it('but a genuine zero, published as a number, is still a price', async () => {
    await load([{
      id: 'actually-free',
      model_spec: { pricing: { input: { usd: 0, diem: 0 }, output: { usd: 0, diem: 0 } } },
    }])
    expect(liveVeniceRates('actually-free')).toEqual({ inputPerM: 0, outputPerM: 0 })
  })
})

describe('a curated fallback row must never carry a laundered price', () => {
  it('serves the fallback on a dead API, and reports no rate for any of it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET') }))
    const res = await listVeniceModels({ force: true })
    expect(res.ok).toBe(true)
    expect(res.stale).toBe(true)
    expect(res.models.length).toBeGreaterThan(0)
    expect(res.models.every(m => m.live === false)).toBe(true)
    expect(res.models.every(m => m.rates === undefined)).toBe(true)
    // …and nothing published from a fallback row may be read back as evidence.
    for (const m of res.models) expect(liveVeniceRates(m.id), m.id).toBeNull()
  })

  it('an id Venice does not serve yields nothing, not a default', async () => {
    await load()
    expect(liveVeniceRates('anthropic/claude-opus-5')).toBeNull()
    expect(liveVeniceRates('')).toBeNull()
  })
})

describe('the ledger seam', () => {
  it('claims venice rows and nobody else\'s', async () => {
    await load()
    // Importing the service registered the resolver; the ledger walks every
    // registered resolver and each returns null for what it does not own.
    expect(resolveRegisteredLiveRates('venice', 'claude-opus-5')?.inputPerM).toBe(6)
    // The SAME model id on another provider is priced by that provider, not by
    // Venice's margin over it — Venice resells claude-opus-5 at 6/30 while
    // Anthropic's own published rate is 5/25.
    expect(resolveRegisteredLiveRates('bankr-gateway', 'claude-opus-5')).toBeNull()
    expect(resolveRegisteredLiveRates('venice', 'gpt-that-venice-never-served')).toBeNull()
  })

  it('does not claim a hypothetical venice-* route it has never priced', async () => {
    await load()
    // Exact match, unlike OpenRouter's `startsWith('openrouter')`: Venice has
    // one id in the provider registry, and a prefix test would silently answer
    // for a future sibling route whose catalog we have never read.
    expect(resolveRegisteredLiveRates('venice-enterprise', 'claude-opus-5')).toBeNull()
  })
})
