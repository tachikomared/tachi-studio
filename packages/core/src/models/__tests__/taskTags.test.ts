// packages/core/src/models/__tests__/taskTags.test.ts
//
// The invariants this data layer exists to hold. Most of these tests are not
// about "does the function work" — they are about "can a future edit smuggle a
// guess back in". Read the header of task-tags.ts for why.

import { describe, it, expect } from 'vitest'
import {
  TASK_TAGS,
  TASK_TAG_COPY,
  CURATED_MODEL_NOTES,
  IMAGE_INPUT_MODELS,
  REJECTED_TAGS,
  CURATION_MAX_AGE_DAYS,
  LONG_CONTEXT_MIN_TOKENS,
  EVERYDAY_MAX_INPUT_USD_PER_M,
  EVERYDAY_MAX_OUTPUT_USD_PER_M,
  PREMIUM_MIN_INPUT_USD_PER_M,
  PREMIUM_MIN_OUTPUT_USD_PER_M,
  PRICE_BANDS,
  PRICE_BAND_COPY,
  staleCuratedModelIds,
  isCurationFresh,
  isTaskTag,
  isPriceBand,
  taskTagI18nKey,
  priceBandI18nKey,
  type TaskTag,
} from '../task-tags.js'
import {
  resolveTaskTags,
  hasTaskTag,
  recommendModels,
  resolveModelPrice,
  priceBandOf,
  formatUsdPerM,
} from '../resolve-task-tags.js'
import { TACHI_MODEL_CAPABILITIES } from '../../tachi/models.js'
import { ratesFor } from '../../pricing.js'

// A stable "today" so nothing in this file is time-bombed.
const NOW = Date.parse('2026-08-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000

describe('the taxonomy itself', () => {
  it('is small and closed — eight tags, no more', () => {
    // Six at birth; `uncensored` and `frontier` were added 2026-08-02 at the
    // owner's explicit request, each with its own PIN suite below.
    expect(TASK_TAGS).toEqual(['agentic', 'coding', 'everyday', 'long-context', 'vision', 'uncensored', 'frontier', 'free'])
    expect(TASK_TAGS.length).toBeLessThanOrEqual(8)
  })

  it('has beginner copy for every tag and nothing extra', () => {
    expect(Object.keys(TASK_TAG_COPY).sort()).toEqual([...TASK_TAGS].sort())
    for (const tag of TASK_TAGS) {
      const c = TASK_TAG_COPY[tag]
      expect(c.label.length, tag).toBeGreaterThan(0)
      expect(c.label.length, `${tag} label should fit a chip`).toBeLessThanOrEqual(24)
      // One sentence of plain English, not a paragraph.
      expect(c.blurb.length, tag).toBeGreaterThan(20)
      expect(c.blurb.length, tag).toBeLessThanOrEqual(200)
    }
  })

  it('pins the i18n key scheme so the UI lane cannot invent a second one', () => {
    expect(taskTagI18nKey('coding', 'label')).toBe('providers:taskTags.coding.label')
    expect(taskTagI18nKey('long-context', 'blurb')).toBe('providers:taskTags.long-context.blurb')
  })

  it('records why each rejected candidate was rejected', () => {
    expect(REJECTED_TAGS.length).toBeGreaterThanOrEqual(5)
    for (const r of REJECTED_TAGS) {
      expect(r.candidate.length).toBeGreaterThan(0)
      expect(r.reason.length, r.candidate).toBeGreaterThan(40)
    }
  })

  it('guards the tag type at the settings boundary', () => {
    expect(isTaskTag('coding')).toBe(true)
    expect(isTaskTag('best')).toBe(false)
    expect(isTaskTag(null)).toBe(false)
  })
})

// ── THE FOUR PINS NAMED IN THE BRIEF ─────────────────────────────────────────

describe('PIN: an unknown model gets no tags, never a default', () => {
  it('returns an empty tag set for an id nothing knows', () => {
    const r = resolveTaskTags({ id: 'acme-fictional-9000', now: NOW })
    expect(r.tags).toEqual([])
    expect(r.capabilityMatch).toBeNull()
    expect(r.reasons).toEqual({})
  })

  it('does NOT inherit resolveCapability\'s permissive DEFAULT row', () => {
    // tachi/models.ts answers an unknown id with {32k, tools:true,
    // agentCapable:true} so the harness will still ATTEMPT it. That default must
    // never become a badge.
    const r = resolveTaskTags({ id: 'zzz-nothing-matches-this-zzz', now: NOW })
    expect(r.tags).not.toContain('agentic')
    expect(r.capabilityMatch).toBeNull()
  })

  it('an empty / whitespace id is not an error and not a tag', () => {
    expect(resolveTaskTags({ id: '', now: NOW }).tags).toEqual([])
    expect(resolveTaskTags({ id: '   ', now: NOW }).tags).toEqual([])
  })
})

describe('PIN: a model without tool support can never be agentic', () => {
  it('holds for every no-tools row in the capability catalog', () => {
    const noTools = TACHI_MODEL_CAPABILITIES.filter(c => !c.supportsTools)
    expect(noTools.length, 'the catalog should still contain no-tool rows').toBeGreaterThan(0)
    for (const cap of noTools) {
      const r = resolveTaskTags({ id: cap.match, now: NOW })
      expect(r.tags, `${cap.match} must not be agentic`).not.toContain('agentic')
    }
  })

  it('holds for every not-agent-capable row too', () => {
    for (const cap of TACHI_MODEL_CAPABILITIES.filter(c => !c.agentCapable)) {
      expect(resolveTaskTags({ id: cap.match, now: NOW }).tags).not.toContain('agentic')
    }
  })

  it('a live catalog row that lists capabilities without tools vetoes agentic', () => {
    const withTools = resolveTaskTags({ id: 'claude-opus-5', providerId: 'bankr-gateway', now: NOW })
    expect(withTools.tags).toContain('agentic')

    const vetoed = resolveTaskTags({
      id: 'claude-opus-5',
      providerId: 'bankr-gateway',
      live: { capabilities: ['text', 'vision'] },
      now: NOW,
    })
    expect(vetoed.tags).not.toContain('agentic')
  })
})

describe('PIN: no tag is derived from a substring of a model id', () => {
  it('an id containing "code"/"coder" earns nothing', () => {
    for (const id of ['acme-coder-v2', 'supercode-70b', 'my-code-model', 'code-llama-fictional']) {
      const r = resolveTaskTags({ id, now: NOW })
      expect(r.tags, id).not.toContain('coding')
    }
  })

  it('coding comes from exact curated membership, not from the family name', () => {
    // The :free row is curated (OpenRouter description, dated). The bare id is
    // NOT — and it does not inherit the claim by looking similar.
    expect(hasTaskTag({ id: 'cohere/north-mini-code:free', now: NOW }, 'coding')).toBe(true)
    expect(hasTaskTag({ id: 'cohere/north-mini-code', now: NOW }, 'coding')).toBe(false)
    expect(hasTaskTag({ id: 'north-mini-code', now: NOW }, 'coding')).toBe(false)
  })

  it('an id containing "vision"/"vl" earns nothing — providers/vision.ts is NOT the source', () => {
    for (const id of ['acme-vision-8b', 'fictional-vl-2b', 'multimodal-thing-3']) {
      expect(resolveTaskTags({ id, now: NOW }).tags, id).not.toContain('vision')
    }
  })

  it('an id containing "uncensored" earns nothing without the provider\'s own claim', () => {
    // The rule fails in BOTH directions for this tag — see the uncensored suite
    // below for the reverse case (Venice's qwen-3-6-plus, whose id says nothing).
    for (const id of ['acme-uncensored-13b', 'totally-uncensored-9000', 'dolphin-uncensored']) {
      expect(resolveTaskTags({ id, now: NOW }).tags, id).not.toContain('uncensored')
    }
  })

  it('a `:free` suffix is a name, not a price', () => {
    // The exact regression pricing.ts fixed on 2026-08-01, restated at the tag layer.
    const r = resolveTaskTags({ id: 'tencent/hy3:free', providerId: 'opengateway', now: NOW })
    expect(r.tags).not.toContain('free')
  })

  it('a keyword-matched price never produces the cheap-tier tag', () => {
    // ratesFor('acme-gpt-4-clone') hits the 'gpt-4' keyword fallback and returns
    // a price. The everyday tag must require an EXACT table row instead.
    const r = resolveTaskTags({ id: 'acme-gpt-4-clone-9b', now: NOW })
    expect(r.tags).not.toContain('everyday')
  })
})

describe('PIN: every curated entry carries a source and a date', () => {
  it('all entries', () => {
    const ids = Object.keys(CURATED_MODEL_NOTES)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      const n = CURATED_MODEL_NOTES[id]
      expect(n.source.length, `${id} needs a specific source`).toBeGreaterThan(20)
      expect(Number.isFinite(Date.parse(n.readOn)), `${id} needs a parseable readOn`).toBe(true)
      expect(n.claim.length, `${id} needs the claim recorded`).toBeGreaterThan(20)
      // A number with no benchmark named is not evidence.
      if (n.benchmark) {
        expect(n.benchmark.name.length, id).toBeGreaterThan(2)
        expect(n.benchmark.score.length, id).toBeGreaterThan(0)
      }
      for (const t of n.tags) expect(TASK_TAGS).toContain(t)
    }
  })

  it('no citation is dated in the future', () => {
    for (const [id, n] of Object.entries(CURATED_MODEL_NOTES)) {
      expect(Date.parse(n.readOn), id).toBeLessThanOrEqual(Date.now() + DAY)
    }
  })

  it('the image-input table is dated and sourced the same way', () => {
    for (const [id, f] of Object.entries(IMAGE_INPUT_MODELS)) {
      expect(f.source.length, id).toBeGreaterThan(20)
      expect(Number.isFinite(Date.parse(f.readOn)), id).toBe(true)
    }
  })
})

describe('stale curation is visible, not silently permanent', () => {
  it('nothing is stale as of the dates the sources were read', () => {
    expect(staleCuratedModelIds(NOW)).toEqual([])
  })

  it('a curated tag DISAPPEARS once the citation expires', () => {
    const fresh = resolveTaskTags({ id: 'poolside/laguna-s-2.1:free', now: NOW })
    expect(fresh.tags).toContain('coding')
    expect(fresh.curated?.benchmark?.name).toBe('Terminal-Bench 2.1')

    const later = NOW + (CURATION_MAX_AGE_DAYS + 1) * DAY
    const stale = resolveTaskTags({ id: 'poolside/laguna-s-2.1:free', now: later })
    expect(stale.tags).not.toContain('coding')
    expect(stale.curated).toBeUndefined()
    // …and the expiry is enumerable, so a doctor panel can show it.
    expect(staleCuratedModelIds(later)).toContain('poolside/laguna-s-2.1:free')
  })

  it('an unparseable date is treated as stale, not as fresh', () => {
    expect(isCurationFresh({ tags: ['coding'], source: 'x'.repeat(30), readOn: 'not-a-date', claim: 'y' }, NOW)).toBe(false)
  })

  it('a not-a-general-chat-model note survives expiry as an advisory', () => {
    // The tags go, but "this is a moderation classifier" is not a claim that rots.
    const later = NOW + (CURATION_MAX_AGE_DAYS + 1) * DAY
    const r = resolveTaskTags({ id: 'nvidia/nemotron-3.5-content-safety:free', now: later })
    expect(r.notGeneralChat).toBeTruthy()
  })
})

// ── The derivable half, rule by rule ─────────────────────────────────────────

describe('long-context is a number, not an opinion', () => {
  it('a 262k row clears the line; an 8k local Gemma does not', () => {
    expect(hasTaskTag({ id: 'inclusionai/ling-3.0-flash:free', now: NOW }, 'long-context')).toBe(true)
    expect(hasTaskTag({ id: 'gemma3:4b', now: NOW }, 'long-context')).toBe(false)
  })

  it('a model two gateways serve at two windows earns the tag from NEITHER', () => {
    // nemotron-3-ultra used to be this file's 1M example. On 2026-08-02 both
    // keyless catalogs were read for the identical id: OpenGateway says
    // 131_072, OpenRouter says 1_000_000. Our provider-less row now carries the
    // smaller value with known:false, so the static path claims nothing…
    expect(hasTaskTag({ id: 'nvidia/nemotron-3-ultra-550b-a55b:free', providerId: 'opengateway', now: NOW }, 'long-context')).toBe(false)
    // …and the gateway that really serves 1M can still say so, live.
    expect(hasTaskTag({
      id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      providerId: 'openrouter-oauth',
      live: { contextTokens: 1_000_000 },
      now: NOW,
    }, 'long-context')).toBe(true)
  })

  it('a live catalog row outranks the static catalog', () => {
    const r = resolveTaskTags({ id: 'gemma3:4b', live: { contextTokens: 1_000_000 }, now: NOW })
    expect(r.tags).toContain('long-context')
    expect(r.reasons['long-context']).toContain('live catalog')
  })

  it('sits exactly on the documented threshold', () => {
    const at = resolveTaskTags({ id: 'x', live: { contextTokens: LONG_CONTEXT_MIN_TOKENS }, now: NOW })
    const below = resolveTaskTags({ id: 'x', live: { contextTokens: LONG_CONTEXT_MIN_TOKENS - 1 }, now: NOW })
    expect(at.tags).toContain('long-context')
    expect(below.tags).not.toContain('long-context')
  })
})

describe('free is asserted per model, never per suffix', () => {
  it('a verified-free row is free', () => {
    expect(hasTaskTag({ id: 'nvidia/nemotron-3-ultra-550b-a55b:free', providerId: 'opengateway', now: NOW }, 'free')).toBe(true)
  })

  it('a live $0/$0 catalog row is the strongest signal', () => {
    const r = resolveTaskTags({ id: 'whatever-unknown', live: { pricing: { inUsdPerMTok: 0, outUsdPerMTok: 0 } }, now: NOW })
    expect(r.tags).toContain('free')
    expect(r.reasons.free).toContain('$0')
  })

  it('your own hardware is free', () => {
    const r = resolveTaskTags({ id: 'gemma3:4b', providerId: 'ollama-local', now: NOW })
    expect(r.tags).toContain('free')
    expect(r.reasons.free).toContain('your own machine')
  })

  it('a provider the registry records as free confers it', () => {
    // registry.ts defines billing:'free' as "costs the user nothing WHATEVER
    // model it resolves to" — a reviewed single-source-of-truth fact.
    const r = resolveTaskTags({ id: 'kilo-auto/free', providerId: 'freellmapi-local', now: NOW })
    expect(r.tags).toContain('free')
    expect(r.reasons.free).toContain('provider registry')
  })

  it('a mixed gateway: a caller-supplied whitelist OVERRIDES provider-level free', () => {
    // The Kilo lesson, kept as a mechanism after Kilo moved inside the router:
    // a gateway that serves 343 models of which 13 are free must not confer $0
    // on all of them just because its registry row says 'free'.
    const whitelist = ['kilo-auto/free', 'nvidia/nemotron-3-ultra-550b-a55b:free']
    expect(hasTaskTag(
      { id: 'kilo-auto/free', providerId: 'freellmapi-local', freeModelIds: whitelist, now: NOW }, 'free',
    )).toBe(true)
    expect(hasTaskTag(
      { id: 'anthropic/claude-opus-5', providerId: 'freellmapi-local', freeModelIds: whitelist, now: NOW }, 'free',
    )).toBe(false)
  })

  it('an unknown provider promises nothing', () => {
    expect(hasTaskTag({ id: 'some-model', providerId: 'provider-that-does-not-exist', now: NOW }, 'free')).toBe(false)
  })

  it('a promo window that has closed is no longer free', () => {
    const inside = Date.parse('2026-08-02T00:00:00Z')
    const after = Date.parse('2026-08-04T00:00:00Z')
    expect(hasTaskTag({ id: 'ling-3.0-flash:free', now: inside }, 'free')).toBe(true)
    expect(hasTaskTag({ id: 'ling-3.0-flash:free', now: after }, 'free')).toBe(false)
  })
})

describe('everyday is a price claim and says so', () => {
  it('the cheap tier qualifies, the flagship tier does not', () => {
    expect(hasTaskTag({ id: 'gpt-5-mini', now: NOW }, 'everyday')).toBe(true)
    expect(hasTaskTag({ id: 'claude-haiku-4.5', now: NOW }, 'everyday')).toBe(true)
    expect(hasTaskTag({ id: 'claude-sonnet-4.6', now: NOW }, 'everyday')).toBe(false)
    expect(hasTaskTag({ id: 'claude-opus-5', now: NOW }, 'everyday')).toBe(false)
  })

  it('free implies everyday, and the reason says why', () => {
    const r = resolveTaskTags({ id: 'nvidia/nemotron-3-ultra-550b-a55b:free', now: NOW })
    expect(r.tags).toContain('everyday')
    expect(r.reasons.everyday).toContain('costs nothing')
  })
})

describe('vision comes from a modality fact, not a name', () => {
  it('a dated measured row qualifies', () => {
    const r = resolveTaskTags({ id: 'google/gemma-4-31b-it:free', now: NOW })
    expect(r.tags).toContain('vision')
    expect(r.reasons.vision).toContain('2026-08-01')
  })

  it('a live capability list qualifies and outranks the table', () => {
    const r = resolveTaskTags({ id: 'brand-new-model-we-never-saw', live: { capabilities: ['text', 'vision'] }, now: NOW })
    expect(r.tags).toContain('vision')
    expect(r.reasons.vision).toContain('live catalog')
  })

  it('a provider whose PROVIDER row lists vision does not confer it on every model', () => {
    // venice's descriptor carries ['text','vision','tools','image','embedding'].
    // That says the provider serves some such models — not that this one is one.
    const r = resolveTaskTags({ id: 'venice-uncatalogued-text-model', providerId: 'venice', now: NOW })
    expect(r.tags).not.toContain('vision')
  })
})

// ── Five real examples across providers (the report's worked cases) ──────────

describe('worked examples', () => {
  const ex = (id: string, providerId: string) => resolveTaskTags({ id, providerId, now: NOW }).tags

  it('keyless free · kilo-auto/free through the freellmapi-local router', () => {
    expect(ex('kilo-auto/free', 'freellmapi-local')).toEqual(['agentic', 'everyday', 'long-context', 'free'])
  })

  it('free + curated coding · poolside/laguna-s-2.1:free on openrouter-oauth', () => {
    expect(ex('poolside/laguna-s-2.1:free', 'openrouter-oauth'))
      .toEqual(['agentic', 'coding', 'everyday', 'long-context', 'free'])
  })

  it('free reasoning · nemotron-3-ultra on opengateway — no long-context, and that is the fix', () => {
    // The tag went away on 2026-08-02 with the window it rested on: OpenGateway
    // publishes 131_072 for this id, under the 200k line. It was only ever there
    // because our row carried the OTHER gateway's number.
    expect(ex('nvidia/nemotron-3-ultra-550b-a55b:free', 'opengateway'))
      .toEqual(['agentic', 'everyday', 'free'])
  })

  it('paid flagship · claude-sonnet-4.6 on bankr-gateway (coding, from a first-party launch post)', () => {
    // This row USED to assert the absence of a coding tag, and that assertion
    // was correct on the evidence then held (an Anthropic catalog line calling
    // it "previous-generation Sonnet"). A first-party re-read on 2026-08-02
    // found the launch post, which claims coding outright and publishes
    // SWE-bench Verified 79.2%. The rule did not move; the evidence did.
    expect(ex('claude-sonnet-4.6', 'bankr-gateway')).toEqual(['agentic', 'coding', 'long-context', 'vision'])
  })

  it('the dearest model we list gets NO coding tag, because its maker never claims one', () => {
    // claude-fable-5 is the price ceiling of the whole catalog, and OpenRouter's
    // catalogue blurb says "knowledge work and coding". Anthropic's own pages do
    // not. Maker beats reseller, so the tag is absent — and the band still warns.
    const r = resolveTaskTags({ id: 'claude-fable-5', providerId: 'bankr-gateway', now: NOW })
    expect(r.tags).not.toContain('coding')
    expect(r.priceBand).toBe('premium')
  })

  it('local · gemma3:4b on ollama-local (free, but 8k and no tools ⇒ never agentic)', () => {
    expect(ex('gemma3:4b', 'ollama-local')).toEqual(['everyday', 'free'])
  })
})

// ── THE PRICE AXIS ───────────────────────────────────────────────────────────

describe('the price vocabulary', () => {
  it('is four bands, cheapest to dearest, and closed', () => {
    expect(PRICE_BANDS).toEqual(['free', 'budget', 'mid', 'premium'])
  })

  it('has beginner copy for every band and nothing extra', () => {
    expect(Object.keys(PRICE_BAND_COPY).sort()).toEqual([...PRICE_BANDS].sort())
    for (const band of PRICE_BANDS) {
      const c = PRICE_BAND_COPY[band]
      expect(c.label.length, `${band} label should fit a chip`).toBeLessThanOrEqual(24)
      expect(c.label.length, band).toBeGreaterThan(0)
      expect(c.blurb.length, band).toBeGreaterThan(20)
      expect(c.blurb.length, band).toBeLessThanOrEqual(200)
    }
  })

  it('names money and never quality — no label implies the model is BETTER', () => {
    // "Premium", "top-tier" and "frontier" all read as capability claims. This
    // module has no evidence for one (see REJECTED_TAGS 'best / most capable').
    const labels = PRICE_BANDS.map(b => PRICE_BAND_COPY[b].label.toLowerCase())
    for (const word of ['premium', 'frontier', 'flagship', 'best', 'top-tier', 'pro']) {
      expect(labels.join(' '), `a band label must not say "${word}"`).not.toContain(word)
    }
  })

  it('pins the i18n key scheme, mirroring the tags', () => {
    expect(priceBandI18nKey('premium', 'label')).toBe('providers:priceBands.premium.label')
    expect(priceBandI18nKey('free', 'blurb')).toBe('providers:priceBands.free.blurb')
  })

  it('guards the band type at the settings boundary', () => {
    expect(isPriceBand('premium')).toBe(true)
    expect(isPriceBand('expensive')).toBe(false)
    expect(isPriceBand(undefined)).toBe(false)
  })
})

describe('PIN: a model whose price we cannot prove gets NO band', () => {
  it('an unknown id has neither a price nor a band', () => {
    const r = resolveTaskTags({ id: 'acme-fictional-9000', now: NOW })
    expect(r.price).toBeNull()
    expect(r.priceBand).toBeNull()
  })

  it('a model the picker really serves but we cannot price stays unbanded', () => {
    // Bankr lists `deepseek-v4`; MODEL_RATES has deepseek-v4-PRO and nothing
    // that exactly names this one. No band beats a wrong one.
    const r = resolveTaskTags({ id: 'deepseek-v4', providerId: 'bankr-gateway', now: NOW })
    expect(r.priceBand).toBeNull()
    // …and it is not silently dropped from the list: it still earns real tags.
    expect(r.tags.length).toBeGreaterThan(0)
  })

  it('null band and null price always travel together — the bands PARTITION', () => {
    const ids = ['claude-opus-5', 'claude-haiku-4.5', 'gpt-5-mini', 'acme-nothing',
                 'deepseek-v4', 'gemma3:4b', 'nvidia/nemotron-3-ultra-550b-a55b:free']
    for (const id of ids) {
      const r = resolveTaskTags({ id, providerId: 'bankr-gateway', now: NOW })
      expect(r.price === null, id).toBe(r.priceBand === null)
    }
  })
})

describe('PIN: the keyword price fallback never reaches a band', () => {
  it('a name-matched rate prices a LEDGER but never a badge', () => {
    // ratesFor() falls through to a substring keyword list so a spend cap can
    // never under-count. That is right for money and wrong for a claim, so the
    // two paths must visibly disagree here. If this test ever goes green in
    // both directions, someone wired ratesFor() into the UI.
    expect(ratesFor('acme-gpt-4-clone-9b')).not.toBeNull()
    expect(resolveModelPrice({ id: 'acme-gpt-4-clone-9b', now: NOW })).toBeNull()
    expect(resolveTaskTags({ id: 'acme-gpt-4-clone-9b', now: NOW }).priceBand).toBeNull()
  })

  it('the progressive dash-prefix fallback does not reach a band either', () => {
    // ratesFor('claude-opus-9.9') walks back to the 'claude-opus' row. An
    // unreleased version number must not inherit its family's price.
    expect(ratesFor('claude-opus-9.9')).not.toBeNull()
    expect(resolveModelPrice({ id: 'claude-opus-9.9', now: NOW })).toBeNull()
  })

  it('a `:free` suffix still buys nothing — not a tag, not a band', () => {
    const r = resolveTaskTags({ id: 'tencent/hy3:free', providerId: 'opengateway', now: NOW })
    expect(r.tags).not.toContain('free')
    expect(r.priceBand).not.toBe('free')
  })
})

describe('the band thresholds are lines, and the lines are documented', () => {
  const at = (inPerM: number, outPerM: number) =>
    priceBandOf({ inPerM, outPerM, source: 'price-table', why: 'test' })

  it('free requires BOTH sides at zero', () => {
    expect(at(0, 0)).toBe('free')
    expect(at(0, 0.5)).toBe('budget')
    expect(at(0.5, 0)).toBe('budget')
  })

  it('budget sits exactly on the cheap line, and one cent over falls out', () => {
    expect(at(EVERYDAY_MAX_INPUT_USD_PER_M, EVERYDAY_MAX_OUTPUT_USD_PER_M)).toBe('budget')
    expect(at(EVERYDAY_MAX_INPUT_USD_PER_M + 0.01, EVERYDAY_MAX_OUTPUT_USD_PER_M)).toBe('mid')
    expect(at(EVERYDAY_MAX_INPUT_USD_PER_M, EVERYDAY_MAX_OUTPUT_USD_PER_M + 0.01)).toBe('mid')
  })

  it('budget needs BOTH halves cheap — a cheap input cannot carry a dear output', () => {
    expect(at(0.01, 20)).toBe('mid')
  })

  it('premium fires on EITHER half — a dear output cannot hide behind a cheap input', () => {
    expect(at(PREMIUM_MIN_INPUT_USD_PER_M, 0.01)).toBe('premium')
    expect(at(0.01, PREMIUM_MIN_OUTPUT_USD_PER_M)).toBe('premium')
    expect(at(PREMIUM_MIN_INPUT_USD_PER_M - 0.01, PREMIUM_MIN_OUTPUT_USD_PER_M - 0.01)).toBe('mid')
  })

  it('a corrupt (negative) rate claims nothing rather than reading as cheap', () => {
    expect(at(-1, -1)).toBeNull()
    expect(at(-0.5, 3)).toBeNull()
  })

  it('an absent price is null, not a band', () => {
    expect(priceBandOf(null)).toBeNull()
    expect(priceBandOf(undefined)).toBeNull()
  })
})

describe('the band and the `everyday` tag can never disagree', () => {
  it('because they read the same constant, on every model we can price', () => {
    const ids = ['claude-opus-5', 'claude-sonnet-4.6', 'claude-haiku-4.5', 'gpt-5-mini',
                 'gpt-5-nano', 'gemini-3-flash', 'glm-5.2', 'kimi-k3', 'hy3', 'mimo-v2.5-pro']
    for (const id of ids) {
      const r = resolveTaskTags({ id, providerId: 'bankr-gateway', now: NOW })
      if (!r.price) continue
      const cheap = r.priceBand === 'budget' || r.priceBand === 'free'
      expect(r.tags.includes('everyday'), `${id} band=${r.priceBand}`).toBe(cheap)
    }
  })
})

describe('the price carries its provenance, like every tag carries its reason', () => {
  it('a live catalog row outranks the bundled table and says so', () => {
    const r = resolveTaskTags({
      id: 'claude-opus-5',
      providerId: 'bankr-gateway',
      live: { pricing: { inUsdPerMTok: 2, outUsdPerMTok: 6 } },
      now: NOW,
    })
    expect(r.price?.source).toBe('live-catalog')
    expect(r.priceBand).toBe('mid')          // the LIVE number, not the table's $15/$75
  })

  it('the bundled table admits it is a snapshot', () => {
    const r = resolveTaskTags({ id: 'claude-opus-5', providerId: 'bankr-gateway', now: NOW })
    expect(r.price?.source).toBe('price-table')
    expect(r.price?.why).toContain('drift')
  })

  it('free evidence names WHICH kind of free it is', () => {
    expect(resolveModelPrice({ id: 'gemma3:4b', providerId: 'ollama-local', now: NOW })?.source)
      .toBe('local-hardware')
    expect(resolveModelPrice({ id: 'nvidia/nemotron-3-ultra-550b-a55b:free', now: NOW })?.source)
      .toBe('verified-free')
    expect(resolveModelPrice({ id: 'x', live: { pricing: { inUsdPerMTok: 0, outUsdPerMTok: 0 } }, now: NOW })?.source)
      .toBe('live-catalog')
  })
})

describe('formatting a rate never lies about it', () => {
  it('prints round numbers roundly', () => {
    expect(formatUsdPerM(15)).toBe('15')
    expect(formatUsdPerM(0.25)).toBe('0.25')
    expect(formatUsdPerM(0.522)).toBe('0.522')
    expect(formatUsdPerM(0)).toBe('0')
  })

  it('NEVER rounds a real charge down to $0', () => {
    // The one thing a price string must not do is tell you something is free.
    expect(formatUsdPerM(0.00003)).not.toBe('0')
    expect(Number(formatUsdPerM(0.00003))).toBeGreaterThan(0)
  })

  it('refuses a nonsense number rather than printing one', () => {
    expect(formatUsdPerM(Number.NaN)).toBe('')
    expect(formatUsdPerM(-3)).toBe('')
  })
})

// ── The 2026-08-02 additions, each with its own pins ─────────────────────────

describe('frontier is a price fact, not a quality claim', () => {
  it('the flagship-priced rows carry it, with the rate in the reason', () => {
    for (const id of ['claude-opus-5', 'claude-fable-5', 'gpt-5.5']) {
      const r = resolveTaskTags({ id, providerId: 'bankr-gateway', now: NOW })
      expect(r.tags, id).toContain('frontier')
      expect(r.priceBand, id).toBe('premium')
      expect(r.reasons.frontier, id).toContain('/M')
    }
  })

  it('the workhorse tier does not — mid is not the top', () => {
    for (const id of ['claude-sonnet-5', 'claude-sonnet-4.6', 'gpt-5.4']) {
      expect(resolveTaskTags({ id, providerId: 'bankr-gateway', now: NOW }).tags, id).not.toContain('frontier')
    }
  })

  it('no provable price ⇒ not in the group, exactly as it carries no band', () => {
    // A big name is not a price. `deepseek-v4` has no exact rate row, so it is
    // neither banded nor "top tier" — unknown asserts nothing, in either
    // direction.
    const r = resolveTaskTags({ id: 'deepseek-v4', providerId: 'bankr-gateway', now: NOW })
    expect(r.priceBand).toBeNull()
    expect(r.tags).not.toContain('frontier')
  })

  it('a live catalog price decides in BOTH directions', () => {
    const dear = resolveTaskTags({
      id: 'nobody-knows-this-id',
      live: { pricing: { inUsdPerMTok: 30, outUsdPerMTok: 180 } },
      now: NOW,
    })
    expect(dear.tags).toContain('frontier')
    // …and a live rate BELOW the line removes the table's claim: the provider
    // actually serving the model outranks our snapshot.
    const repriced = resolveTaskTags({
      id: 'claude-opus-5',
      providerId: 'bankr-gateway',
      live: { pricing: { inUsdPerMTok: 2, outUsdPerMTok: 6 } },
      now: NOW,
    })
    expect(repriced.tags).not.toContain('frontier')
  })

  it('the tag and the amber band can never disagree — one resolved price feeds both', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'gpt-5-mini', 'deepseek-v4', 'claude-fable-5']) {
      const r = resolveTaskTags({ id, providerId: 'bankr-gateway', now: NOW })
      expect(r.tags.includes('frontier'), id).toBe(r.priceBand === 'premium')
    }
  })

  it('orders the filtered group dearest-first — the group is defined by price', () => {
    const out = recommendModels(
      'frontier',
      [
        { id: 'claude-opus-5', providerId: 'bankr-gateway' },   // $15/$75 snapshot? — whatever the table says, opus > sonnet-tier
        { id: 'claude-fable-5', providerId: 'bankr-gateway' },  // the price ceiling of the catalog
        { id: 'gpt-5.5', providerId: 'bankr-gateway' },
      ],
      {},
      { now: NOW },
    )
    expect(out.length).toBe(3)
    const costs = out.map(r => {
      const p = resolveTaskTags({ id: r.id, providerId: r.providerId, now: NOW }).price!
      return p.inPerM + p.outPerM
    })
    expect([...costs].sort((a, b) => b - a)).toEqual(costs)
    expect(out[0].because.some(b => b.includes('highest rate first'))).toBe(true)
  })
})

describe('uncensored comes from the serving provider\'s own words, never from the id', () => {
  it('Venice\'s flagship uncensored row: trait + name + description, dated', () => {
    const r = resolveTaskTags({ id: 'venice-uncensored-1-2', providerId: 'venice', now: NOW })
    expect(r.tags).toContain('uncensored')
    expect(r.reasons.uncensored).toContain('2026-08-02')
    // The same citation still records the coding NEGATIVE it always did —
    // one entry, two decisions, neither borrowed from the other.
    expect(r.tags).not.toContain('coding')
  })

  it('the id can say NOTHING while the provider says it outright — the reverse trap', () => {
    // Venice names `qwen-3-6-plus` "Qwen 3.6 Plus Uncensored". An id-substring
    // rule would MISS it, which is the other half of why the rule is forbidden.
    expect(hasTaskTag({ id: 'qwen-3-6-plus', providerId: 'venice', now: NOW }, 'uncensored')).toBe(true)
    // Same shape: a "heretic" id that never contains the word.
    expect(hasTaskTag({ id: 'olafangensan-glm-4.7-flash-heretic', providerId: 'venice', now: NOW }, 'uncensored')).toBe(true)
  })

  it('an OpenRouter row is tagged only because the catalog description says so', () => {
    expect(hasTaskTag({ id: 'thedrummer/cydonia-24b-v4.1', providerId: 'openrouter-oauth', now: NOW }, 'uncensored')).toBe(true)
    expect(hasTaskTag({ id: 'cognitivecomputations/dolphin-mistral-24b-venice-edition', providerId: 'openrouter-oauth', now: NOW }, 'uncensored')).toBe(true)
  })

  it('imgnAI describes its own model — maker and server are the same party', () => {
    expect(hasTaskTag({ id: 'q-naifu-a3b', providerId: 'imgnai', now: NOW }, 'uncensored')).toBe(true)
  })

  it('a reseller\'s quality blurb does not ride in with the uncensored claim', () => {
    // Venice's description of qwen-3-6-plus also says "exceptional performance
    // across coding". Maker-wins: no coding tag from a reseller summary.
    expect(hasTaskTag({ id: 'qwen-3-6-plus', providerId: 'venice', now: NOW }, 'coding')).toBe(false)
  })

  it('the claim expires like every curated claim, visibly', () => {
    // +2, not +1: the citation is dated 2026-08-02, one day after this file's
    // NOW baseline, so the shelf life runs one day longer than laguna's above.
    const later = NOW + (CURATION_MAX_AGE_DAYS + 2) * DAY
    expect(hasTaskTag({ id: 'venice-uncensored-1-2', providerId: 'venice', now: later }, 'uncensored')).toBe(false)
    expect(staleCuratedModelIds(later)).toContain('venice-uncensored-1-2')
  })
})

describe('the two poles the picker exists to show', () => {
  it('the dearest models we serve land in `premium`', () => {
    // gpt-5.5 MOVED HERE on 2026-08-02, and the move is a consistency fix, not
    // a threshold change: PREMIUM_MIN_INPUT_USD_PER_M is anchored on a measured
    // list that NAMES "openai/gpt-5.5 $5.00 in / $30.00 out" as one of the rows
    // defining the line. MODEL_RATES had it at $1.25/$10 — the stale row was
    // the only reason it read as mid, so the band disagreed with the constant
    // that its own documentation cites.
    for (const id of ['claude-opus-5', 'claude-opus-4.8', 'claude-fable-5', 'claude-opus-4.6', 'gpt-5.5']) {
      expect(resolveTaskTags({ id, providerId: 'bankr-gateway', now: NOW }).priceBand, id).toBe('premium')
    }
  })

  it('the workhorse tier lands in `mid`, not lumped with the flagships', () => {
    for (const id of ['claude-sonnet-5', 'claude-sonnet-4.6', 'gemini-3.1-pro', 'gpt-5.4']) {
      expect(resolveTaskTags({ id, providerId: 'bankr-gateway', now: NOW }).priceBand, id).toBe('mid')
    }
  })

  it('a RETIRED id is flagged, and priced as what actually serves it', () => {
    // The nastiest failure this table can hide: xAI retired the grok-4 line on
    // 2026-05-15 and now SILENTLY redirects — no error, no 404 — so a row for
    // `grok-4` showed a name, a window and a price for a model that is not
    // there. The resolver must say so, and must price what is really billed.
    const res = resolveTaskTags({ id: 'grok-4', providerId: 'surplus', now: NOW })
    expect(res.retired).toBeDefined()
    expect(res.retired!.successor).toBe('grok-4.3')
    expect(res.retired!.source.length).toBeGreaterThan(20)
    // Priced as grok-4.3, because that is the rate xAI charges for the request.
    expect(res.price!.inPerM).toBe(resolveTaskTags({ id: 'grok-4.3', providerId: 'surplus', now: NOW }).price!.inPerM)
    // …and a live id claims no retirement.
    expect(resolveTaskTags({ id: 'grok-4.5', providerId: 'surplus', now: NOW }).retired).toBeUndefined()
  })

  it('the cheap tier lands in `budget`, and $0 models in `free`', () => {
    for (const id of ['claude-haiku-4.5', 'gpt-5-mini', 'gemini-3-flash']) {
      expect(resolveTaskTags({ id, providerId: 'bankr-gateway', now: NOW }).priceBand, id).toBe('budget')
    }
    expect(resolveTaskTags({ id: 'gemma3:4b', providerId: 'ollama-local', now: NOW }).priceBand).toBe('free')
    expect(resolveTaskTags({ id: 'poolside/laguna-s-2.1:free', now: NOW }).priceBand).toBe('free')
  })
})

// ── COVERAGE FLOORS ──────────────────────────────────────────────────────────
//
// The owner's actual complaint was a count: "WRITING CODE 3" over a catalog of
// dozens. These assert the coverage this work bought, per provider, so a later
// edit cannot quietly delete a citation and shrink a group back to nothing.
//
// The id lists are each picker's own keyless FALLBACK catalog — verbatim what a
// newcomer with no key sees on first open. They are a fixed sample on purpose:
// the point is a floor that cannot drift, not a live mirror of five services.

const FALLBACK_CATALOGS: Record<string, { providerId: string; ids: string[] }> = {
  bankr: {
    providerId: 'bankr-gateway',
    ids: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4.8',
          'claude-sonnet-4.6', 'claude-haiku-4.5', 'gpt-5.5', 'gpt-5-mini',
          'gemini-3.1-pro', 'gemini-3-flash', 'glm-5.2', 'deepseek-v4'],
  },
  venice: {
    providerId: 'venice',
    ids: ['zai-org-glm-4.7', 'qwen-2.5-vl', 'mistral-31-24b', 'qwen3-235b-a22b-thinking-2507',
          'claude-opus-4-8', 'llama-3.3-70b', 'deepseek-v4-pro', 'openai-gpt-oss-120b',
          'venice-uncensored-1-2'],
  },
  surplus: {
    providerId: 'surplus',
    // Mirrors surplus-service.ts's shipped fallback. `grok-4` was replaced with
    // `grok-4.5` on 2026-08-02: xAI retired the grok-4 line on 2026-05-15 and
    // silently redirects it, so offering it handed the user a different model
    // than the row named. See the retired-id tests below.
    ids: ['claude-opus-4.6', 'claude-sonnet-4.5', 'claude-haiku-4.5', 'gpt-5.4', 'gpt-5-mini',
          'gemini-3.1-pro', 'gemini-2.5-flash', 'deepseek-v3.2', 'qwen3-235b-a22b-2507',
          'llama-3.3-70b-instruct', 'mistral-large', 'grok-4.5', 'kimi-k2'],
  },
  openrouterFree: {
    providerId: 'openrouter-oauth',
    ids: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free',
          'google/gemma-4-26b-a4b-it:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
          'nvidia/nemotron-nano-12b-v2-vl:free', 'nvidia/nemotron-3-super-120b-a12b:free',
          'inclusionai/ling-3.0-flash:free', 'poolside/laguna-s-2.1:free',
          'poolside/laguna-xs-2.1:free', 'cohere/north-mini-code:free',
          'nvidia/nemotron-3-nano-30b-a3b:free', 'nvidia/nemotron-nano-9b-v2:free',
          'nvidia/nemotron-3.5-content-safety:free', 'openai/gpt-oss-20b:free'],
  },
  opengateway: {
    providerId: 'opengateway',
    ids: ['hy3', 'tencent/hy3', 'mimo-v2.5-pro', 'mimo-v2.5', 'gemini-3.1-flash-lite',
          'minimax-m3', 'qwen3.7-max', 'kimi-k3', 'glm-5.2',
          'nvidia/nemotron-3-ultra-550b-a55b:free', 'inclusionai/ling-3.0-flash:free',
          'macaron-v1-tall'],
  },
}

function tally(key: string, tag: TaskTag): number {
  const c = FALLBACK_CATALOGS[key]
  return c.ids.filter(id => hasTaskTag({ id, providerId: c.providerId, now: NOW }, tag)).length
}

describe('coverage floors — the counts a newcomer actually sees', () => {
  // Measured on 2026-08-02 after the vendor-primary sweep. The number in the
  // comment is what it WAS before, so the delta is legible in the diff.
  const CODING_FLOOR: Record<string, number> = {
    bankr: 8,            // was 3 — the count in the owner's screenshot
    venice: 3,           // was 1
    surplus: 7,          // was 0
    openrouterFree: 3,   // was 3 (already curated; the free fleet was done first)
    opengateway: 7,      // was 0
  }
  for (const [key, floor] of Object.entries(CODING_FLOOR)) {
    it(`${key} labels at least ${floor} models for writing code`, () => {
      expect(tally(key, 'coding')).toBeGreaterThanOrEqual(floor)
    })
  }

  const VISION_FLOOR: Record<string, number> = {
    bankr: 10,           // was 6
    venice: 3,           // was 1
    surplus: 7,          // was 1
    opengateway: 4,      // was 0
  }
  for (const [key, floor] of Object.entries(VISION_FLOOR)) {
    it(`${key} labels at least ${floor} models as reading images`, () => {
      expect(tally(key, 'vision')).toBeGreaterThanOrEqual(floor)
    })
  }

  it('prices as much of each fallback catalog as we honestly can, and no more', () => {
    // Per-provider floors, measured 2026-08-02. They are NOT all high, and the
    // low one is the interesting one:
    //
    //   VENICE prices 2 of 9. Venice serves models under spellings nobody else
    //   uses (`zai-org-glm-4.7`, `mistral-31-24b`, `openai-gpt-oss-120b`) and
    //   bills in its own units rather than $/M, so there is no exact rate row
    //   to read for most of them. Seven unbanded rows is the correct answer,
    //   not a gap to paper over — and it is why the floor is a per-provider
    //   number rather than one ratio applied to everybody.
    const PRICED_FLOOR: Record<string, number> = {
      bankr: 11,           // of 12 — only `deepseek-v4` has no exact row
      venice: 2,           // of 9  — see above
      surplus: 10,         // of 13
      openrouterFree: 14,  // of 14 — all verified-free
      opengateway: 12,     // of 12
    }
    for (const [key, c] of Object.entries(FALLBACK_CATALOGS)) {
      const banded = c.ids.filter(id =>
        resolveTaskTags({ id, providerId: c.providerId, now: NOW }).priceBand !== null).length
      expect(banded, `${key} priced ${banded}/${c.ids.length}`).toBeGreaterThanOrEqual(PRICED_FLOOR[key])
    }
  })

  it('bankr shows a top-tier group with the flagships in it — the 2026-08-02 ask', () => {
    // fable-5, opus-5, opus-4.8 and gpt-5.5 all bill at the flagship rate.
    expect(tally('bankr', 'frontier')).toBeGreaterThanOrEqual(4)
  })

  it('venice groups its uncensored row — the other half of the 2026-08-02 ask', () => {
    // The fallback catalog carries one (venice-uncensored-1-2); the live
    // catalog carries seven more, curated under their own ids.
    expect(tally('venice', 'uncensored')).toBeGreaterThanOrEqual(1)
  })

  it('the paid pickers each show at least one PRICIEST row — the warning the owner asked for', () => {
    for (const key of ['bankr', 'venice', 'surplus']) {
      const c = FALLBACK_CATALOGS[key]
      const premium = c.ids.filter(id =>
        resolveTaskTags({ id, providerId: c.providerId, now: NOW }).priceBand === 'premium')
      expect(premium.length, key).toBeGreaterThanOrEqual(1)
    }
  })

  it('and the free fleet is banded `free`, never merely `budget`', () => {
    const c = FALLBACK_CATALOGS.openrouterFree
    for (const id of c.ids) {
      expect(resolveTaskTags({ id, providerId: c.providerId, now: NOW }).priceBand, id).toBe('free')
    }
  })
})

// ── The recommender ──────────────────────────────────────────────────────────

describe('recommendModels', () => {
  const CANDIDATES = [
    { id: 'claude-opus-5', providerId: 'bankr-gateway' },
    { id: 'kilo-auto/free', providerId: 'freellmapi-local' },
    { id: 'poolside/laguna-s-2.1:free', providerId: 'openrouter-oauth' },
    { id: 'poolside/laguna-xs-2.1:free', providerId: 'openrouter-oauth' },
    { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', providerId: 'opengateway' },
    { id: 'nvidia/nemotron-3.5-content-safety:free', providerId: 'openrouter-oauth' },
    { id: 'gemma3:4b', providerId: 'ollama-local' },
  ]

  it('only returns models that carry the tag', () => {
    const out = recommendModels('coding', CANDIDATES, {}, { now: NOW })
    expect(new Set(out.map(r => r.id))).toEqual(new Set([
      'poolside/laguna-s-2.1:free',
      'poolside/laguna-xs-2.1:free',
      'claude-opus-5',
    ]))
    // gemma / nemotron-ultra / kilo-auto carry no coding citation, so they are
    // absent rather than ranked last.
    expect(out.map(r => r.id)).not.toContain('kilo-auto/free')
  })

  it('orders coding by: free first, then a published benchmark, then catalog order', () => {
    const out = recommendModels('coding', CANDIDATES, {}, { now: NOW })
    expect(out.map(r => r.id)).toEqual([
      'poolside/laguna-s-2.1:free',
      'poolside/laguna-xs-2.1:free',
      'claude-opus-5',
    ])
    // Nothing opaque: every position is explained by its own criteria list.
    for (const r of out) expect(r.because.length).toBeGreaterThan(0)
    expect(out[0].because).toContain('costs nothing')
    expect(out[2].because).toContain('you pay for this one')
  })

  it('never shortlists a model flagged as not-a-general-chat-model', () => {
    // Every shipped tag — iterating the closed set itself, so a ninth tag can
    // never be added without this guard covering it.
    for (const tag of TASK_TAGS) {
      const out = recommendModels(tag, CANDIDATES, {}, { now: NOW })
      expect(out.map(r => r.id), tag).not.toContain('nvidia/nemotron-3.5-content-safety:free')
    }
  })

  it('puts what the user can actually reach first, and says so', () => {
    const out = recommendModels('long-context', CANDIDATES, { readyProviderIds: ['freellmapi-local'] }, { now: NOW })
    expect(out[0].providerId).toBe('freellmapi-local')
    expect(out[0].because[0]).toBe('you can use this provider right now')
    expect(out[1].because[0]).toBe('needs a key or a download before it will run')
  })

  it('private mode drops everything whose prompt would leave the machine', () => {
    const out = recommendModels('free', CANDIDATES, { privateMode: true }, { now: NOW })
    expect(out.map(r => r.providerId)).toEqual(['ollama-local'])
  })

  it('orders long-context by measured window size', () => {
    // A LIVE window decides the order, which is the whole contract: the row the
    // gateway itself sizes at 1M outranks the 262k rows, and it does so on the
    // number the gateway published rather than on one of ours.
    const out = recommendModels(
      'long-context',
      [
        ...CANDIDATES,
        { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', providerId: 'openrouter-oauth', live: { contextTokens: 1_000_000 } },
      ],
      {},
      { now: NOW },
    )
    expect(out[0].id).toBe('nvidia/nemotron-3-ultra-550b-a55b:free')
    expect(out[0].providerId).toBe('openrouter-oauth')
    expect(out[0].because.some(b => b.includes('bigger context window'))).toBe(true)
  })

  it('orders everyday cheapest-first and sends an unknown price to the back', () => {
    const out = recommendModels(
      'everyday',
      [
        { id: 'claude-haiku-4.5', providerId: 'bankr-gateway' },   // $1 / $5
        { id: 'gpt-5-nano', providerId: 'bankr-gateway' },         // $0.05 / $0.4
        { id: 'gpt-5-mini', providerId: 'bankr-gateway' },         // $0.25 / $2
      ],
      {},
      { now: NOW },
    )
    expect(out.map(r => r.id)).toEqual(['gpt-5-nano', 'gpt-5-mini', 'claude-haiku-4.5'])
  })

  it('honours the shortlist limit', () => {
    expect(recommendModels('free', CANDIDATES, {}, { now: NOW, limit: 2 })).toHaveLength(2)
    expect(recommendModels('free', CANDIDATES, {}, { now: NOW }).length).toBeLessThanOrEqual(5)
  })

  it('every recommendation carries a one-line reason', () => {
    for (const r of recommendModels('agentic', CANDIDATES, {}, { now: NOW })) {
      expect(r.reason.length).toBeGreaterThan(10)
    }
  })

  it('an empty candidate list is empty, not an error', () => {
    expect(recommendModels('coding', [], {}, { now: NOW })).toEqual([])
  })
})
