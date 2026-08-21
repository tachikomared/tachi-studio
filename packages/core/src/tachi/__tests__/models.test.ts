// packages/core/src/tachi/__tests__/models.test.ts
import { describe, it, expect } from 'vitest'
import {
  TACHI_MODEL_CAPABILITIES, resolveCapability, resolveContextWindow,
  parseLiveContextTokens, pickLiveContextTokens, ASSUMED_CONTEXT_WINDOW,
} from '../models.js'
import type { ModelCapability } from '../contract.js'

describe('TACHI_MODEL_CAPABILITIES catalog', () => {
  it('is a non-empty array of ModelCapability entries', () => {
    expect(Array.isArray(TACHI_MODEL_CAPABILITIES)).toBe(true)
    expect(TACHI_MODEL_CAPABILITIES.length).toBeGreaterThan(0)
  })

  it('every entry has all required ModelCapability fields with sane types', () => {
    for (const c of TACHI_MODEL_CAPABILITIES) {
      expect(typeof c.match).toBe('string')
      expect(c.match.length).toBeGreaterThan(0)
      expect(typeof c.contextWindow).toBe('number')
      expect(c.contextWindow).toBeGreaterThan(0)
      expect(typeof c.contextWindowKnown).toBe('boolean')
      expect(typeof c.supportsTools).toBe('boolean')
      expect(typeof c.supportsTemperature).toBe('boolean')
      expect(['native', 'native-then-salvage', 'none']).toContain(c.toolProtocol)
      expect(['edit-cascade', 'whole-file', 'apply-patch']).toContain(c.editFormat)
      expect(typeof c.agentCapable).toBe('boolean')
    }
  })

  it('has no duplicate match keys', () => {
    const keys = TACHI_MODEL_CAPABILITIES.map(c => c.match)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('covers the documented provider zoo match keys', () => {
    const keys = new Set(TACHI_MODEL_CAPABILITIES.map(c => c.match))
    for (const k of ['claude', 'gpt', 'codex', 'mimo', 'qwen', 'deepseek', 'llama', 'gemini', 'gemma']) {
      expect(keys.has(k)).toBe(true)
    }
  })

  it('encodes the claude entry exactly per spec', () => {
    const c = TACHI_MODEL_CAPABILITIES.find(e => e.match === 'claude')!
    expect(c).toMatchObject({
      match: 'claude',
      contextWindow: 200000,
      supportsTools: true,
      supportsTemperature: true,
      toolProtocol: 'native',
      editFormat: 'edit-cascade',
      agentCapable: true,
    })
  })

  it('encodes the gpt/codex entries per spec (native, apply-patch, 128k)', () => {
    for (const k of ['gpt', 'codex']) {
      const c = TACHI_MODEL_CAPABILITIES.find(e => e.match === k)!
      expect(c.contextWindow).toBe(128000)
      expect(c.toolProtocol).toBe('native')
      expect(c.editFormat).toBe('apply-patch')
      expect(c.agentCapable).toBe(true)
    }
  })

  it('encodes mimo per spec (128k, native-then-salvage, edit-cascade)', () => {
    const c = TACHI_MODEL_CAPABILITIES.find(e => e.match === 'mimo')!
    expect(c).toMatchObject({
      contextWindow: 128000,
      toolProtocol: 'native-then-salvage',
      editFormat: 'edit-cascade',
      agentCapable: true,
    })
  })

  it('encodes qwen per spec (32k, native-then-salvage, edit-cascade)', () => {
    const c = TACHI_MODEL_CAPABILITIES.find(e => e.match === 'qwen')!
    expect(c).toMatchObject({
      contextWindow: 32000,
      toolProtocol: 'native-then-salvage',
      editFormat: 'edit-cascade',
      agentCapable: true,
    })
  })

  it('encodes deepseek per spec (64k, native-then-salvage)', () => {
    const c = TACHI_MODEL_CAPABILITIES.find(e => e.match === 'deepseek')!
    expect(c.contextWindow).toBe(64000)
    expect(c.toolProtocol).toBe('native-then-salvage')
    expect(c.editFormat).toBe('edit-cascade')
    expect(c.agentCapable).toBe(true)
  })

  it('encodes llama per spec (32k, native-then-salvage)', () => {
    const c = TACHI_MODEL_CAPABILITIES.find(e => e.match === 'llama')!
    expect(c.contextWindow).toBe(32000)
    expect(c.toolProtocol).toBe('native-then-salvage')
    expect(c.editFormat).toBe('edit-cascade')
    expect(c.agentCapable).toBe(true)
  })

  it('encodes gemini as an ESTIMATE — the family spans 32x, so no row can be sure', () => {
    const c = TACHI_MODEL_CAPABILITIES.find(e => e.match === 'gemini')!
    // 1_048_576, not the 1_000_000 this used to pin: that was a rounding of the
    // common case. And known:false, because OpenRouter's own catalogue serves
    // `google/gemini*` at 1_048_576 (x13), 131_072 (x2), 65_536 (x3) and 32_768
    // (x1) — measured 2026-08-02. A family row cannot be evidence about that.
    expect(c.contextWindow).toBe(1_048_576)
    expect(c.contextWindowKnown).toBe(false)
    expect(c.toolProtocol).toBe('native')
    expect(c.editFormat).toBe('edit-cascade')
    expect(c.agentCapable).toBe(true)
  })

  it('encodes the small-context gemma marker (8192, none, whole-file, NOT agent-capable)', () => {
    const c = TACHI_MODEL_CAPABILITIES.find(e => e.match === 'gemma')!
    expect(c.contextWindow).toBe(8192)
    expect(c.toolProtocol).toBe('none')
    expect(c.editFormat).toBe('whole-file')
    expect(c.agentCapable).toBe(false)
  })
})

describe('resolveCapability', () => {
  it('returns the exact-match entry when modelId equals a match key', () => {
    const c = resolveCapability('claude')
    expect(c.match).toBe('claude')
    expect(c.contextWindow).toBe(200000)
  })

  it('resolves a substring match (claude-haiku-4-5 -> claude entry, 200k baseline)', () => {
    const c = resolveCapability('claude-haiku-4-5')
    expect(c.match).toBe('claude')
    expect(c.contextWindow).toBe(200000)
    expect(c.agentCapable).toBe(true)
  })

  it('resolves the 1M-context Claude tier over the generic claude entry', () => {
    // Real limits per Anthropic docs 2026: Fable 5 / Mythos 5 / Opus 4.6+ /
    // Sonnet 4.6+ serve a 1M window — the longer match must beat 'claude'.
    for (const id of ['claude-fable-5', 'claude-mythos-5', 'claude-opus-4-8', 'claude-opus-4.8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4.6']) {
      const c = resolveCapability(id)
      expect(c.contextWindow, id).toBe(1000000)
      expect(c.agentCapable, id).toBe(true)
    }
  })

  it('resolves the Claude 5 Opus tier (opus-5 ties "claude" on length — the long key must win)', () => {
    // 'opus-5' is exactly as long as 'claude', so on 'claude-opus-5' the tie
    // would hand the match to the earlier 200k 'claude' entry. The explicit
    // 'claude-opus-5' key is what makes this 1M; 'opus-5' covers bare ids.
    for (const id of ['claude-opus-5', 'opus-5', 'Claude-Opus-5', 'bankr/claude-opus-5']) {
      const c = resolveCapability(id)
      expect(c.contextWindow, id).toBe(1000000)
      expect(c.supportsTools, id).toBe(true)
      expect(c.toolProtocol, id).toBe('native')
      expect(c.agentCapable, id).toBe(true)
    }
  })

  it('resolves real-world ids to the right family', () => {
    expect(resolveCapability('gpt-4o-mini').match).toBe('gpt')
    expect(resolveCapability('gemini-2.5-pro').match).toBe('gemini')
    expect(resolveCapability('deepseek-coder-v2').match).toBe('deepseek')
    expect(resolveCapability('Meta-Llama-3.1-70B-Instruct').match).toBe('llama')
    expect(resolveCapability('Xiaomi-MiMo-7B').match).toBe('mimo')
    expect(resolveCapability('Qwen2.5-Coder-32B-Instruct').match).toBe('qwen')
    expect(resolveCapability('gemma-2-2b-it').match).toBe('gemma')
  })

  it('is case-insensitive for substring matching', () => {
    expect(resolveCapability('CLAUDE-3-7-SONNET').match).toBe('claude')
    expect(resolveCapability('Gemini-Flash').match).toBe('gemini')
    expect(resolveCapability('GEMMA-7B').match).toBe('gemma')
  })

  it('case-insensitivity also covers an exact match given in a different case', () => {
    const c = resolveCapability('Claude')
    expect(c.match).toBe('claude')
    expect(c.contextWindow).toBe(200000)
  })

  it('prefers the longest match when two keys could both substring-match', () => {
    // A synthetic id containing BOTH "gpt" and "codex" — "codex" (5) is longer
    // than "gpt" (3), so the codex entry must win.
    const c = resolveCapability('openai-gpt-codex-preview')
    expect(c.match).toBe('codex')
  })

  it('longest-substring wins is not order-dependent (gemma vs llama style)', () => {
    // Build an id that contains a short key and a longer key; the longer must win.
    // "deepseek" (8) is longer than "gpt" (3).
    const c = resolveCapability('gpt-deepseek-merge-13b')
    expect(c.match).toBe('deepseek')
  })

  it('falls back to a conservative DEFAULT for an unknown id — which asserts NO window', () => {
    const c = resolveCapability('totally-unknown-model-xyz')
    // The number survives so budgeting callers can budget, but the row does not
    // CLAIM it: a model we have never heard of has an unknown context window.
    expect(c.contextWindow).toBe(ASSUMED_CONTEXT_WINDOW)
    expect(c.contextWindowKnown).toBe(false)
    expect(c.supportsTools).toBe(true)
    expect(c.supportsTemperature).toBe(true)
    expect(c.toolProtocol).toBe('native-then-salvage')
    expect(c.editFormat).toBe('edit-cascade')
    expect(c.agentCapable).toBe(true)
  })

  it('falls back to DEFAULT for empty string', () => {
    const c = resolveCapability('')
    expect(c.contextWindow).toBe(32000)
    expect(c.toolProtocol).toBe('native-then-salvage')
  })

  it('the gemma 8k entry resolves with agentCapable:false', () => {
    const c = resolveCapability('google/gemma-2-9b')
    expect(c.match).toBe('gemma')
    expect(c.agentCapable).toBe(false)
    expect(c.toolProtocol).toBe('none')
  })

  it('returned object satisfies the ModelCapability shape', () => {
    const c: ModelCapability = resolveCapability('whatever')
    expect(Object.keys(c).sort()).toEqual(
      ['agentCapable', 'contextWindow', 'contextWindowKnown', 'editFormat', 'match', 'supportsTemperature', 'supportsTools', 'toolProtocol'].sort(),
    )
  })

  it('a family key does not match inside a longer word (token-boundary rule)', () => {
    // A bare includes() handed these unrelated families' protocol AND window.
    for (const id of ['regpts-model', 'myllamaish-7b', 'ungemmaified']) {
      expect(resolveCapability(id).match, id).toBe('*')
    }
    // …while the real ids those keys exist for still match, including the
    // letter→digit run-ons that appear in real catalogs.
    expect(resolveCapability('Qwen2.5-Coder-32B-Instruct').match).toBe('qwen')
    expect(resolveCapability('claude3-opus').match).toBe('claude')
    expect(resolveCapability('e2ee-gpt-oss-120b-p').match).toBe('gpt-oss')
  })
})

describe('context windows: live catalog is the authority', () => {
  it('the wildcard asserts no window — unknown id yields source "assumed", known false', () => {
    for (const id of ['totally-unknown-model-xyz', '', 'venice-uncensored-1-2']) {
      const w = resolveContextWindow(id)
      expect(w.source, id).toBe('assumed')
      expect(w.known, id).toBe(false)
      expect(w.tokens, id).toBe(ASSUMED_CONTEXT_WINDOW)
    }
  })

  it('a live catalog value beats every static row, including a sourced one', () => {
    // claude-opus-5 has a strong static row (1M). A provider that publishes its
    // own number for the model IT serves still wins — it is the one serving it.
    const w = resolveContextWindow('claude-opus-5', 250_000)
    expect(w.tokens).toBe(250_000)
    expect(w.source).toBe('live')
    expect(w.known).toBe(true)
  })

  it('THE regression: the owner\'s Venice model gets its real 200k from the live catalog, not 32k', () => {
    const id = 'olafangensan-glm-4.7-glash-heretic'
    // Before: the wildcard row asserted 32k and the harness truncated history
    // against it. No static row matches this id and none should be invented.
    expect(resolveContextWindow(id).source).toBe('assumed')
    // After: Venice's own model_spec.availableContextTokens answers.
    const live = resolveContextWindow(id, 200_000)
    expect(live).toEqual({ tokens: 200_000, source: 'live', known: true })
  })

  it('an unusable live value is ignored rather than believed', () => {
    // A catalog that omits the field, or publishes junk, must not be able to
    // claim a zero-token model — we fall through and report the weaker source.
    for (const bad of [0, -1, NaN, Infinity, undefined, null, 'abc', {}]) {
      const w = resolveContextWindow('claude-opus-5', bad as number)
      expect(w.source, String(bad)).toBe('catalog')
      expect(w.tokens, String(bad)).toBe(1_000_000)
    }
  })

  it('the three known-wrong variants no longer inherit an unrelated family row', () => {
    // gpt-oss is OpenAI's OPEN-WEIGHTS line: it took the proprietary 'gpt' row's
    // 128k AND its apply-patch edit format, which an open-weights build does not
    // drive. It now has its own sourced row.
    const oss = resolveCapability('e2ee-gpt-oss-120b-p')
    expect(oss.match).toBe('gpt-oss')
    expect(oss.editFormat).toBe('edit-cascade')
    expect(resolveContextWindow('e2ee-gpt-oss-120b-p')).toEqual({ tokens: 131_072, source: 'catalog', known: true })

    // hermes/qwen still land in the right FAMILY, but that family's number is
    // now reported as an estimate — so nothing displays it as their window, and
    // the provider's live value takes over when there is one.
    for (const id of ['hermes-3-llama-3.1-405b', 'e2ee-qwen-2-5-7b-p']) {
      expect(resolveContextWindow(id).source, id).toBe('family-estimate')
      expect(resolveContextWindow(id).known, id).toBe(false)
      expect(resolveContextWindow(id, 131_072).source, id).toBe('live')
    }
  })

  it('bare family buckets are estimates; exact and named-variant rows are evidence', () => {
    const bySource = (id: string) => resolveContextWindow(id).source
    for (const id of ['gpt-4o-mini', 'qwen3-235b', 'llama-3.3-70b', 'deepseek-chat', 'codex-mini', 'mimo-7b', 'gemma-2-2b-it']) {
      expect(bySource(id), id).toBe('family-estimate')
    }
    for (const id of ['claude-haiku-4-5', 'claude-opus-5', 'gemma-4-31b-it', 'grok-4-5']) {
      expect(bySource(id), id).toBe('catalog')
    }
    // `gemini-3-pro` left that list on 2026-08-02 for the same reason nemotron
    // did below: it resolves through the BARE `gemini` family row, and that
    // family is served anywhere from 32_768 to 1_048_576. A bucket is an
    // estimate however large its members usually are.
    expect(bySource('gemini-3-pro')).toBe('family-estimate')
    // nemotron-3-ultra MOVED to the estimate side on 2026-08-02, and the move is
    // the point of this test rather than an exception to it: two keyless
    // catalogs publish two different windows for the identical id (OpenGateway
    // 131_072, OpenRouter 1_000_000), so our single provider-less row is an
    // estimate no matter which number it carries. It now says so.
    expect(bySource('nemotron-3-ultra-550b')).toBe('family-estimate')
  })

  it('every row marked contextWindowKnown carries the exact catalog value, not a rounding', () => {
    // These were recorded as 262_000 while the 2026-08-01 catalog read (kept in
    // openrouter-service.ts FALLBACK) says 262_144. A window we round is a
    // window we made up.
    const w = (k: string) => TACHI_MODEL_CAPABILITIES.find(c => c.match === k)!
    expect(w('gemma-4').contextWindow).toBe(262_144)
    expect(w('ling-3.0').contextWindow).toBe(262_144)
    expect(w('laguna').contextWindow).toBe(262_144)
    // …and the two rows that genuinely span a range stopped claiming a number.
    expect(w('nemotron').contextWindowKnown).toBe(false)
    expect(w('kilo-auto').contextWindowKnown).toBe(false)
  })
})

describe('reading a window off a provider catalog row', () => {
  it('parseLiveContextTokens takes numbers and numeric strings, rejects everything else', () => {
    expect(parseLiveContextTokens(131072)).toBe(131072)
    expect(parseLiveContextTokens('262144')).toBe(262144)
    expect(parseLiveContextTokens(200000.7)).toBe(200000)
    for (const bad of [0, -5, NaN, Infinity, '', '  ', 'lots', null, undefined, {}, []]) {
      expect(parseLiveContextTokens(bad), String(bad)).toBeUndefined()
    }
  })

  it('pickLiveContextTokens finds the window under each spelling gateways use', () => {
    expect(pickLiveContextTokens({ context_length: 131072 })).toBe(131072)       // OpenRouter
    expect(pickLiveContextTokens({ max_model_len: 32768 })).toBe(32768)          // vLLM
    expect(pickLiveContextTokens({ n_ctx: 8192 })).toBe(8192)                    // llama.cpp
    expect(pickLiveContextTokens({ model_spec: { availableContextTokens: 200000 } })).toBe(200000) // Venice
    expect(pickLiveContextTokens({ top_provider: { context_length: 65536 } })).toBe(65536)
  })

  it('pickLiveContextTokens returns undefined when the row publishes nothing usable', () => {
    // "The gateway did not tell us" must stay distinguishable from a number, so
    // the caller omits the field instead of defaulting it.
    for (const row of [{}, { id: 'x', name: 'X' }, { context_length: null }, { context_length: 0 }, null, undefined, 'nope']) {
      expect(pickLiveContextTokens(row), JSON.stringify(row)).toBeUndefined()
    }
  })
})
