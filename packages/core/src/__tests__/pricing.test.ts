// packages/core/src/__tests__/pricing.test.ts — STEAL 2026-07-09 (codeburn):
// the cost ledger must price the cloud/OpenRouter models TachiDesk actually
// routes to, not fall back to $0.
import { describe, it, expect } from 'vitest'
import {
  ratesFor, costUsd, costUsdFromRates, isVerifiedFreeModel,
  retirementOf, MODEL_RATES, RETIRED_MODELS, expiredFreeModelIds, VERIFIED_FREE_MODELS,
} from '../pricing.js'
// The user-facing price path, which deliberately refuses what ratesFor allows.
import { resolveModelPrice } from '../models/resolve-task-tags.js'

/**
 * `ratesFor` returns null for an id it cannot price, so every comparison of two
 * rates has to establish that both exist first. Doing that inline left six
 * `Object is possibly 'null'` errors in `tsc` — green under vitest, which does
 * not typecheck, and red in the build. Asserting here means a missing row fails
 * as "expected a rate for gpt-5-mini" instead of as a null dereference.
 */
function rate(id: string): NonNullable<ReturnType<typeof ratesFor>> {
  const r = ratesFor(id)
  expect(r, `expected a rate row for ${id}`).toBeTruthy()
  return r!
}

describe('ratesFor — models that used to resolve to $0', () => {
  it('prices the gpt-5 / o-series family', () => {
    expect(ratesFor('gpt-5-mini')).toBeTruthy()
    expect(ratesFor('gpt-5.4')).toBeTruthy()
    expect(ratesFor('o3')).toBeTruthy()
    expect(ratesFor('o4-mini')).toBeTruthy()
  })
  it('prices gemini / deepseek / grok / glm / minimax', () => {
    for (const m of ['gemini-3-flash', 'gemini-2.5-pro', 'deepseek-r1', 'deepseek-v3.2', 'grok-4', 'glm-5', 'minimax-m2.5'])
      expect(ratesFor(m), m).toBeTruthy()
  })
  it('prices the Claude 5 family Bankr serves (opus-5 / sonnet-5)', () => {
    // These rows USED to carry a "PROVISIONAL" comment and the Opus 4.1-era
    // $15/$75, because no published Opus-5 rate had been found in-repo. It was
    // read first-party on 2026-08-02 and is $5/$25 — the old row over-charged 3×.
    expect(ratesFor('claude-opus-5')).toEqual(ratesFor('claude-opus-4.8'))
    // …and Opus 5 is still the expensive tier relative to Sonnet 5.
    expect(rate('claude-opus-5').inputPerM).toBeGreaterThan(rate('claude-sonnet-5').inputPerM)
  })
  it('mini/nano tiers cost less than their flagship', () => {
    expect(rate('gpt-5-mini').inputPerM).toBeLessThan(rate('gpt-5').inputPerM)
    expect(rate('gpt-5-nano').inputPerM).toBeLessThan(rate('gpt-5-mini').inputPerM)
  })
})

describe('ratesFor — OpenRouter / routing id shapes', () => {
  it('strips the org/ prefix (deepseek/deepseek-r1 → deepseek-r1)', () => {
    expect(ratesFor('deepseek/deepseek-r1')).toEqual(ratesFor('deepseek-r1'))
    expect(ratesFor('google/gemini-2.5-pro')).toEqual(ratesFor('gemini-2.5-pro'))
  })
  it('treats :free as a ROUTING suffix, not a price (prices the underlying model)', () => {
    // Regression guard for the 2026-08-01 spend-cap hole: `:free` used to
    // short-circuit to {0,0} for ANY id. It must now strip like `:nitro` does.
    expect(ratesFor('meta-llama/llama-3.3-70b:free')).toEqual(ratesFor('meta-llama/llama-3.3-70b'))
    expect(ratesFor('meta-llama/llama-3.3-70b:free')!.inputPerM).toBeGreaterThan(0)
  })
  it('ignores routing suffixes like :nitro', () => {
    expect(ratesFor('anthropic/claude-sonnet-4.6:nitro')).toEqual(ratesFor('claude-sonnet-4.6'))
  })
  it('falls back via substring keyword for host-prefixed names', () => {
    expect(ratesFor('meta-llama-3.2-90b-vision')).toBeTruthy()  // matches 'llama'
    expect(ratesFor('qwen2.5-72b-instruct')).toBeTruthy()       // matches 'qwen'
  })
  it('still returns null for a truly unknown model (honest $0)', () => {
    expect(ratesFor('totally-made-up-model-xyz')).toBeNull()
  })
})

// ── The `:free` suffix is a naming convention, not a fact about money ────────
// Live-verified 2026-08-01 against https://opengateway.gitlawb.com/v1/models,
// which publishes `pricing` / `effective_pricing` / `promo` per model.
describe('ratesFor — free-ness comes from catalog data, never from the id string', () => {
  const AFTER_LING_PROMO  = Date.parse('2026-08-04T00:00:00Z')
  const BEFORE_LING_PROMO = Date.parse('2026-08-02T00:00:00Z')

  it('does NOT price a paid model as free just because it ships a :free alias', () => {
    // tencent/hy3 is PAID (promo: null) yet publishes the alias tencent/hy3:free.
    // Under the old suffix shortcut this recorded $0 and never touched the cap.
    const r = ratesFor('tencent/hy3:free')
    expect(r).not.toBeNull()
    expect(r!.inputPerM).toBeGreaterThan(0)
    expect(r!.outputPerM).toBeGreaterThan(0)
    expect(r).toEqual(ratesFor('tencent/hy3'))          // the alias prices as the model
    expect(costUsd('tencent/hy3:free', 1_000_000, 1_000_000)).toBeGreaterThan(0)
  })

  it('keeps a genuinely free model free (no phantom cost)', () => {
    // nemotron-3-ultra: all-zero pricing, promo: null → unconditionally free.
    for (const id of ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nemotron-3-ultra-550b-a55b:free'])
      expect(ratesFor(id), id).toEqual({ inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 })
    expect(costUsd('nvidia/nemotron-3-ultra-550b-a55b:free', 5_000_000, 5_000_000)).toBe(0)
  })

  it('a :free id with no verified entry and no priceable base is UNKNOWN, not $0', () => {
    // The load-bearing assertion: a refactor that restores the suffix shortcut
    // turns this null into {0,0} and this test fails.
    expect(ratesFor('someorg/unlisted-model-xyz:free')).toBeNull()
    expect(costUsd('someorg/unlisted-model-xyz:free', 1_000_000, 1_000_000)).toBeNull()
  })

  it('expires a promo free window instead of freezing it at $0 forever', () => {
    const FREE = { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 }
    // ling-3.0-flash is free only until its published ends_at (2026-08-03T10:00Z).
    expect(ratesFor('inclusionai/ling-3.0-flash:free', BEFORE_LING_PROMO)).toEqual(FREE)
    // Past it the id rejoins the normal pipeline. Whatever that yields, it must
    // not be $0 — a launch promo must never become a permanent free pass.
    const after = ratesFor('inclusionai/ling-3.0-flash:free', AFTER_LING_PROMO)
    expect(after).not.toEqual(FREE)
    expect(after === null || after.inputPerM > 0).toBe(true)
    // macaron has no family the table can guess at, so it expires to UNKNOWN.
    expect(ratesFor('mindai/macaron-v1-tall', BEFORE_LING_PROMO)).toEqual(FREE)
    expect(ratesFor('mindai/macaron-v1-tall', Date.parse('2026-08-11T00:00:00Z'))).toBeNull()
  })

  it('prices the paid OpenGateway catalog from real per-token rates', () => {
    // Previously under-priced by the family fallback (glm-5.2 → 'glm-5',
    // qwen3.7-max → 'qwen') or missing entirely (hy3, kimi-k3, mimo-*).
    expect(ratesFor('z-ai/glm-5.2')!.inputPerM).toBeGreaterThan(ratesFor('glm-5')!.inputPerM)
    expect(ratesFor('qwen/qwen3.7-max')!.inputPerM).toBeGreaterThan(ratesFor('qwen2.5-72b-instruct')!.inputPerM)
    for (const m of ['xiaomi/mimo-v2.5-pro', 'xiaomi/mimo-v2.5', 'moonshotai/kimi-k3', 'minimax/minimax-m3'])
      expect(ratesFor(m), m).toBeTruthy()
  })

  it('leaves OpenGateway `auto` UNKNOWN — it is billed at the served model rate', () => {
    expect(ratesFor('auto')).toBeNull()
  })
})

// ── OpenRouter :free rows — verified against the LIVE catalog 2026-08-01 ─────
// pricing.prompt === "0" && pricing.completion === "0" per model. The signal is
// PER MODEL: the provider stays billing 'paid' (322 of 336 models are paid).
describe('ratesFor — OpenRouter verified-free rows', () => {
  const FREE = { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 }

  it('prices the live-verified $0 rows at exactly $0', () => {
    for (const id of [
      'google/gemma-4-31b-it:free',
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'cohere/north-mini-code:free',
      'openai/gpt-oss-20b:free',
    ]) {
      expect(ratesFor(id), id).toEqual(FREE)
      expect(costUsd(id, 1_000_000, 1_000_000), id).toBe(0)
      expect(isVerifiedFreeModel(id), id).toBe(true)
    }
  })

  it('a PAID OpenRouter model is unaffected — priced from its real family', () => {
    const r = ratesFor('anthropic/claude-sonnet-4.6')!
    expect(r.inputPerM).toBeGreaterThan(0)
    expect(costUsd('anthropic/claude-sonnet-4.6', 1_000_000, 0)).toBeGreaterThan(0)
    expect(isVerifiedFreeModel('anthropic/claude-sonnet-4.6')).toBe(false)
    // …and the base model of a verified-free row, WITHOUT its :free routing
    // spelling, is not verified-free either (different route, different price).
    expect(isVerifiedFreeModel('openai/gpt-oss-20b')).toBe(false)
  })

  it('isVerifiedFreeModel is a table lookup, never a :free suffix rule', () => {
    expect(isVerifiedFreeModel('someorg/unlisted-model:free')).toBe(false)
    expect(isVerifiedFreeModel('tencent/hy3:free')).toBe(false)   // paid, ships the alias
    expect(isVerifiedFreeModel('')).toBe(false)
  })

  it('honours promo windows the same way ratesFor does', () => {
    const BEFORE = Date.parse('2026-08-02T00:00:00Z')
    const AFTER  = Date.parse('2026-08-04T00:00:00Z')
    expect(isVerifiedFreeModel('inclusionai/ling-3.0-flash:free', BEFORE)).toBe(true)
    expect(isVerifiedFreeModel('inclusionai/ling-3.0-flash:free', AFTER)).toBe(false)
  })
})

describe('costUsd — cache-aware', () => {
  it('bills cached prompt reads at the cache-read rate, not full input', () => {
    // Opus 4.8: input $5/M, cacheRead $0.50/M (Anthropic pricing page, read
    // 2026-08-02). 1M prompt tokens all cached + 0 output.
    const full = costUsd('claude-opus-4.8', 1_000_000, 0, 0)
    const cached = costUsd('claude-opus-4.8', 1_000_000, 0, 1_000_000)
    expect(full).toBeCloseTo(5, 5)
    expect(cached).toBeCloseTo(0.5, 5)   // 10× cheaper — the mispricing fix
  })
  it('prices a formerly-$0 cloud model to a real number', () => {
    const c = costUsd('gemini-3-flash', 1_000_000, 1_000_000)
    expect(c).not.toBeNull()
    expect(c).toBeGreaterThan(0)
  })
  it('returns null (→ ledger records $0, priced:false) for unknown models', () => {
    expect(costUsd('nope-model', 1000, 1000)).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// AUDIT 2026-08-02 — every rate below was re-read from the source named in the
// test. These are REGRESSION PINS: if a future edit reverts one, the test names
// the number, the source and the date, so the next person does not have to
// re-derive them. The table had drifted in BOTH directions, and the
// under-counting half was a live hole in the llmBudgetUsd30d spend control.
// ════════════════════════════════════════════════════════════════════════════

describe('the corrected rates, each pinned to its source', () => {
  // Anthropic pricing page (platform.claude.com/docs/en/about-claude/pricing),
  // read 2026-08-02. Every Claude row previously carried the Opus 4.1-era
  // $15/$75 and over-charged the current tiers ~3×.
  const ANTHROPIC: Array<[string, number, number]> = [
    ['claude-opus-5',     5,  25],
    ['claude-opus-4.8',   5,  25],
    ['claude-opus-4.7',   5,  25],
    ['claude-opus-4.6',   5,  25],
    ['claude-fable-5',   10,  50],
    ['claude-sonnet-4.6', 3,  15],
    ['claude-haiku-4.5',  1,   5],
  ]
  it.each(ANTHROPIC)('%s is $%d/$%d (Anthropic pricing page, 2026-08-02)', (id, inp, out) => {
    const r = ratesFor(id)!
    expect(r.inputPerM).toBe(inp)
    expect(r.outputPerM).toBe(out)
  })

  // OpenAI (developers.openai.com/api/docs/pricing), read 2026-08-02. The whole
  // gpt-5.x line was pinned at gpt-5's $1.25/$10 — the UNDER-counting direction,
  // which is what let real spend past the cap.
  const OPENAI: Array<[string, number, number]> = [
    ['gpt-5.5', 5,    30],
    ['gpt-5.4', 2.5,  15],
    ['gpt-5.2', 1.75, 14],
    ['gpt-5',   1.25, 10],
  ]
  it.each(OPENAI)('%s is $%s/$%s (OpenAI pricing, 2026-08-02)', (id, inp, out) => {
    const r = ratesFor(id)!
    expect(r.inputPerM).toBe(inp)
    expect(r.outputPerM).toBe(out)
  })

  it('gpt-5.5 is no longer under-priced against gpt-5 — it is 4× the input', () => {
    // The headline finding: $1.25/$10 recorded against a real $5/$30.
    expect(ratesFor('gpt-5.5')!.inputPerM).toBe(4 * ratesFor('gpt-5')!.inputPerM)
  })

  it('Google Flash is no longer priced at the superseded 2.5-era rate', () => {
    // ai.google.dev/gemini-api/docs/pricing, read 2026-08-02: $0.30/$2.50.
    // The old row said 0.15/0.60 — a 4× UNDER on output.
    const r = ratesFor('gemini-2.5-flash')!
    expect(r.inputPerM).toBe(0.3)
    expect(r.outputPerM).toBe(2.5)
  })

  it('Z.ai GLM rows match Z.ai list price or exceed it, never fall short', () => {
    // docs.z.ai/guides/overview/pricing, read 2026-08-02: glm-5 $1.0/$3.2,
    // glm-4.7 $0.6/$2.2. Both were UNDER.
    expect(ratesFor('glm-5')!.inputPerM).toBeGreaterThanOrEqual(1)
    expect(ratesFor('glm-5')!.outputPerM).toBeGreaterThanOrEqual(3.2)
    expect(ratesFor('glm-4.7')!.outputPerM).toBeGreaterThanOrEqual(2.2)
  })

  it('the `flash` keyword no longer under-prices the current Flash tier 10×', () => {
    // The single worst fallback in the table: an unrecognised Flash id resolved
    // to 0.15/0.60 while Google bills the current generation at up to $9/M out.
    expect(ratesFor('some-vendor-flash-9000')!.outputPerM).toBeGreaterThanOrEqual(9)
  })

  it('every keyword fallback errs HIGH — none is cheaper than gpt-5-nano', () => {
    // The keyword list is the LAST line before a model is recorded as unpriced,
    // so it is exactly the "genuinely uncertain" case the err-high rule governs.
    for (const id of ['unknown-gemini-x', 'unknown-grok-x', 'unknown-glm-x',
                      'unknown-qwen-x', 'unknown-mistral-x', 'unknown-deepseek-x']) {
      expect(ratesFor(id)!.outputPerM, id).toBeGreaterThan(ratesFor('gpt-5-nano')!.outputPerM)
    }
  })
})

describe('published long-context tiers are billed, not silently under-counted', () => {
  it('gpt-5.5 crosses to 2× input / 1.5× output at 272K prompt tokens', () => {
    // developers.openai.com/api/docs/pricing, read 2026-08-02 — the multiplier
    // applies to the WHOLE session, not just the tokens past the threshold.
    const short = costUsd('gpt-5.5', 271_000, 0)!
    const long  = costUsd('gpt-5.5', 273_000, 0)!
    expect(long / short).toBeGreaterThan(1.9)
    expect(costUsd('gpt-5.5', 0, 1_000_000)).toBeCloseTo(30, 5)             // short-session output
    expect(costUsd('gpt-5.5', 300_000, 1_000_000)!).toBeCloseTo(45 + 3, 5)  // long: $45/M out + 300k × $10/M in
  })

  it('Gemini 3.1 Pro and Grok 4.3 both bill their published 200K tier', () => {
    for (const id of ['gemini-3.1-pro', 'grok-4.3']) {
      const below = costUsd(id, 199_000, 0)!
      const above = costUsd(id, 201_000, 0)!
      expect(above / below, id).toBeGreaterThan(1.9)
    }
  })

  it('a model with no published tier is unaffected by prompt size', () => {
    // Guard against the tier logic leaking onto flat-rate models.
    const a = costUsd('claude-opus-5', 100_000, 0)!
    const b = costUsd('claude-opus-5', 900_000, 0)!
    expect(b / a).toBeCloseTo(9, 5)
  })

  it('the long tier also lifts the cache-read rate, not just full input', () => {
    // A long request must not read cache at the short-prompt discount.
    const cachedShort = costUsd('gemini-3.1-pro', 199_000, 0, 199_000)!
    const cachedLong  = costUsd('gemini-3.1-pro', 201_000, 0, 201_000)!
    expect(cachedLong / cachedShort).toBeGreaterThan(1.9)
  })
})

describe('a dated promotional rate expires instead of rotting', () => {
  const DURING = Date.parse('2026-08-15T00:00:00Z')   // inside the intro window
  const AFTER  = Date.parse('2026-09-15T00:00:00Z')   // after the 09-01 revert

  it('Claude Sonnet 5 bills the intro rate now and the standard rate later', () => {
    // Anthropic pricing page, read 2026-08-02: introductory $2/$10 "through
    // August 31, 2026", standard $3/$15 "starting September 1, 2026".
    expect(ratesFor('claude-sonnet-5', DURING)!.inputPerM).toBe(2)
    expect(ratesFor('claude-sonnet-5', DURING)!.outputPerM).toBe(10)
    expect(ratesFor('claude-sonnet-5', AFTER)!.inputPerM).toBe(3)
    expect(ratesFor('claude-sonnet-5', AFTER)!.outputPerM).toBe(15)
  })

  it('the revert needs no code change — it is a date, not a TODO', () => {
    // THE POINT of the mechanism: the standard rate is already in the table, so
    // nobody has to remember to edit anything on 2026-09-01.
    expect(MODEL_RATES['claude-sonnet-5'].inputPerM).toBe(3)
    expect(MODEL_RATES['claude-sonnet-5'].promotional!.until).toBe('2026-09-01T00:00:00Z')
  })

  it('costUsd honours the switchover too', () => {
    expect(costUsd('claude-sonnet-5', 1_000_000, 0, 0, DURING)).toBeCloseTo(2, 5)
    expect(costUsd('claude-sonnet-5', 1_000_000, 0, 0, AFTER)).toBeCloseTo(3, 5)
  })
})

// ── Retired ids: metadata that described a model which is not there ──────────
describe('a retired id is priced as what actually serves the request', () => {
  it('grok-4 prices as grok-4.3, because that is what xAI bills', () => {
    // xAI migration notice (docs.x.ai/developers/migration/may-15-retirement):
    // effective 2026-05-15 the slugs "continue to resolve" and redirect to
    // grok-4.3 at $1.25/$2.50. Our table charged $3/$15 for that work.
    expect(ratesFor('grok-4')).toEqual(ratesFor('grok-4.3'))
    expect(ratesFor('grok-4')!.inputPerM).toBe(1.25)
    expect(ratesFor('grok-4')!.outputPerM).toBe(2.5)
  })

  it('all eight ids on the xAI retirement notice resolve to their successor', () => {
    const EIGHT = [
      'grok-4-1-fast-reasoning', 'grok-4-1-fast-non-reasoning',
      'grok-4-fast-reasoning', 'grok-4-fast-non-reasoning',
      'grok-4-0709', 'grok-code-fast-1', 'grok-3', 'grok-imagine-image-pro',
    ]
    for (const id of EIGHT) {
      const rec = retirementOf(id)
      expect(rec, id).not.toBeNull()
      expect(rec!.evidence, id).toBe('retirement-notice')
      expect(rec!.behaviour, id).toBe('redirects-silently')
      expect(rec!.successor, id).toBeTruthy()
    }
    // grok-code-fast-1 goes to grok-build-0.1, NOT grok-4.3.
    expect(retirementOf('grok-code-fast-1')!.successor).toBe('grok-build-0.1')
    expect(ratesFor('grok-code-fast-1')).toEqual(ratesFor('grok-build-0.1'))
  })

  it('NOTHING is deleted — a pinned conversation still prices', () => {
    // A user may have a saved conversation on any of these. Deleting the row
    // would make it unpriceable (null → the ledger's `unknown` estimate) and
    // lose its metadata. Every retired id must still return a real rate.
    for (const id of Object.keys(RETIRED_MODELS)) {
      if (id === 'grok-imagine-image-pro') continue   // image model, priced per image
      expect(ratesFor(id), id).not.toBeNull()
      expect(costUsd(id, 1_000, 1_000), id).toBeGreaterThan(0)
    }
  })

  it('distinguishes a published retirement from mere absence-from-catalog', () => {
    // The two are not equally strong evidence, and the table says which is which.
    expect(retirementOf('grok-3')!.evidence).toBe('retirement-notice')
    expect(retirementOf('grok-4')!.evidence).toBe('absent-from-catalog')
    expect(retirementOf('gemini-2.0-flash')!.evidence).toBe('retirement-notice')
    expect(retirementOf('o1-mini')!.evidence).toBe('absent-from-catalog')
  })

  it('every retirement record carries a source AND a date, like the free list', () => {
    for (const [id, rec] of Object.entries(RETIRED_MODELS)) {
      expect(rec.source.length, id).toBeGreaterThan(20)
      expect(Number.isFinite(Date.parse(rec.readOn)), `${id} readOn`).toBe(true)
      expect(Number.isFinite(Date.parse(rec.retiredOn)), `${id} retiredOn`).toBe(true)
    }
  })

  it('a live id claims no retirement — this is a table, not a name rule', () => {
    for (const id of ['grok-4.3', 'grok-4.5', 'claude-opus-5', 'gpt-5.5'])
      expect(retirementOf(id), id).toBeNull()
  })

  it('normalises the org/ prefix and routing suffix like ratesFor does', () => {
    expect(retirementOf('x-ai/grok-4')).not.toBeNull()
    expect(retirementOf('x-ai/grok-4:nitro')).not.toBeNull()
  })
})

// ── The live-rate seam ───────────────────────────────────────────────────────
describe('costUsdFromRates — a live rate beats a static one, at record time', () => {
  it('prices from rates the caller holds, ignoring the bundled table', () => {
    // The whole point: OpenRouter publishes a real per-model rate, so a ledger
    // event on that provider should bill that number rather than our snapshot.
    const live = { inputPerM: 0.37, outputPerM: 1.16 }        // measured glm-5.2 on OpenRouter
    expect(costUsdFromRates(live, 1_000_000, 1_000_000)).toBeCloseTo(0.37 + 1.16, 5)
    // …and the static row for the same id is the dearer OpenGateway route,
    // which is the documented cross-gateway err-high behaviour.
    expect(ratesFor('glm-5.2')!.inputPerM).toBeGreaterThan(live.inputPerM)
  })

  it('applies cache-read and long-context tiers the same way costUsd does', () => {
    const r = { inputPerM: 10, outputPerM: 20, cacheReadPerM: 1 }
    expect(costUsdFromRates(r, 1_000_000, 0, 1_000_000)).toBeCloseTo(1, 5)
    const tiered = { inputPerM: 1, outputPerM: 2, longContext: { minPromptTokens: 100, inputPerM: 2, outputPerM: 4 } }
    expect(costUsdFromRates(tiered, 200, 0)).toBeCloseTo((200 / 1e6) * 2, 9)
  })

  it('refuses a nonsensical rate instead of fabricating a number', () => {
    // Same refusal ratesFor() makes for an unknown model: null, never 0.
    expect(costUsdFromRates({ inputPerM: -1, outputPerM: 2 }, 100, 100)).toBeNull()
    expect(costUsdFromRates({ inputPerM: NaN, outputPerM: 2 }, 100, 100)).toBeNull()
  })

  it('a genuinely free live rate is still exactly $0', () => {
    expect(costUsdFromRates({ inputPerM: 0, outputPerM: 0 }, 5_000_000, 5_000_000)).toBe(0)
  })
})

describe('the ledger can never record $0 for a model whose price we know', () => {
  it('every enumerated MODEL_RATES row prices a non-trivial request above zero', () => {
    // The failure this guards: a row edited to 0/0 (or a lookup that silently
    // misses) reads to the 30-day cap as free usage. Only the verified-free
    // list may produce $0, and it is checked separately above.
    for (const id of Object.keys(MODEL_RATES)) {
      const c = costUsd(id, 100_000, 100_000)
      expect(c, id).not.toBeNull()
      expect(c, id).toBeGreaterThan(0)
    }
  })

  it('the models the pickers actually offer all price', () => {
    // Ids taken from the shipped fallback catalogs (bankr-service, surplus-service).
    for (const id of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4.8',
                      'claude-sonnet-4.6', 'claude-haiku-4.5', 'gpt-5.5', 'gpt-5-mini',
                      'gemini-3.1-pro', 'gemini-3-flash', 'glm-5.2', 'deepseek-v4',
                      'gpt-5.4', 'gemini-2.5-flash', 'deepseek-v3.2', 'qwen3-235b-a22b-2507',
                      'llama-3.3-70b-instruct', 'mistral-large', 'grok-4.5', 'kimi-k2']) {
      expect(costUsd(id, 10_000, 10_000), id).toBeGreaterThan(0)
    }
  })

  it('every rate row is a finite, non-negative number', () => {
    for (const [id, r] of Object.entries(MODEL_RATES)) {
      for (const [k, v] of Object.entries(r)) {
        if (typeof v !== 'number') continue
        expect(Number.isFinite(v), `${id}.${k}`).toBe(true)
        expect(v, `${id}.${k}`).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

// ── Models their MAKER no longer sells (2026-08-03) ──────────────────────────
//
// P1-11 asked for exact rows for `kimi-k2` and bare `deepseek-v4` so the picker
// would show them a price band. Checking first-party turned the task around:
// DeepSeek's list documents only `-flash` and `-pro` (there is no product
// called `deepseek-v4`), and Moonshot's lists K3 / K2.7 Code / K2.6 but no
// plain K2. Both ids are alive only because a GATEWAY chose to serve them, so
// the gateway is the only thing that can price them. Inventing a row here would
// print a number for a model its maker does not sell.
describe('a model its maker does not price gets no invented row', () => {
  for (const id of ['kimi-k2', 'deepseek-v4']) {
    it(`${id} has no exact MODEL_RATES row`, () => {
      expect(MODEL_RATES[id]).toBeUndefined()
    })

    it(`${id} shows NO price band — the honest direction`, () => {
      // resolveModelPrice requires an exact row, so the picker prints nothing
      // rather than a sibling's rate dressed as this model's.
      expect(resolveModelPrice({ id, providerId: 'surplus' })).toBeNull()
    })

    it(`${id} still prices for the CAP, and over-counts rather than under`, () => {
      // ratesFor's prefix walk lands on the newer sibling. Against a spend cap
      // that is the safe direction — the dangerous one is reading as free.
      const r = ratesFor(id)
      expect(r).not.toBeNull()
      expect(r!.inputPerM).toBeGreaterThan(0)
    })
  }

  it('the two directions are deliberately different, and that is the design', () => {
    // If these ever agree, someone wired the ledger's pessimistic fallback into
    // a user-facing claim — the exact confusion this module exists to prevent.
    expect(ratesFor('kimi-k2')).not.toBeNull()
    expect(resolveModelPrice({ id: 'kimi-k2' })).toBeNull()
  })
})

// ── A closed promo window announces itself (2026-08-03) ─────────────────────
//
// Expiry already worked: isVerifiedFreeModel stops saying yes on the dot and the
// model falls through to UNKNOWN rather than staying free forever. What it did
// not do is TELL anybody — the row keeps sitting in the table looking
// authoritative while a model quietly starts costing money, and the first sign
// is a changed number on a dashboard days later. Same argument as
// staleCuratedModelIds, applied to the other dated table.
describe('expiredFreeModelIds makes a closed window visible', () => {
  const BEFORE = Date.parse('2026-08-03T09:59:00Z')
  const AFTER  = Date.parse('2026-08-03T10:01:00Z')

  it('reports nothing while every published window is open', () => {
    expect(expiredFreeModelIds(BEFORE)).toEqual([])
  })

  it('names the id AND the date the moment one closes', () => {
    const out = expiredFreeModelIds(AFTER)
    expect(out.length).toBeGreaterThan(0)
    const ids = out.map(e => e.id)
    expect(ids).toContain('ling-3.0-flash:free')
    expect(out.every(e => Number.isFinite(Date.parse(e.freeUntil)))).toBe(true)
  })

  it('agrees with isVerifiedFreeModel — one clock, two readers', () => {
    // If these ever disagree, one of them is using a different rule and the
    // doctor row is reporting on something the pricing path does not do.
    for (const { id } of expiredFreeModelIds(AFTER)) {
      expect(isVerifiedFreeModel(id, AFTER), id).toBe(false)
    }
  })

  it('never reports a row that has no expiry at all', () => {
    // An unconditionally-free row is not "expired", it is unconditional. A
    // doctor that nagged about those would be trained out of usefulness.
    const far = Date.parse('2099-01-01T00:00:00Z')
    for (const { id } of expiredFreeModelIds(far)) {
      expect(VERIFIED_FREE_MODELS[id].freeUntil, id).toBeTruthy()
    }
  })

  it('sorts newest expiry first, so the most recent change leads', () => {
    const far = Date.parse('2099-01-01T00:00:00Z')
    const out = expiredFreeModelIds(far).map(e => Date.parse(e.freeUntil))
    expect([...out].sort((a, b) => b - a)).toEqual(out)
  })
})
