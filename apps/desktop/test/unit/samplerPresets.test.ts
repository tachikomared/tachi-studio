// apps/desktop/test/unit/samplerPresets.test.ts
//
// PER-CHAT SAMPLER PRESETS (USER-PAINS T19). Two things are load-bearing and
// easy to get subtly wrong:
//
//   1. The preset → OpenAI-compat params mapping. The safety guarantee is that
//      BALANCED (and an ABSENT sampler) sends NOTHING — the provider's own
//      defaults apply, so we never surprise a provider with an explicit default
//      it didn't ask for. FAST/CREATIVE use fixed values; ADVANCED emits exactly
//      the clamped knobs the user set.
//
//   2. The persisted store shape: setConversationSampler must persist the
//      setting on the conversation and normalize BALANCED back to ABSENT so
//      "absent = BALANCED" holds for every reader (migration-safe for old blobs).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  samplerToParams, samplerPayload, samplerPreset,
  clampTemperature, clampTopP,
  DEFAULT_SAMPLER, SAMPLER_PRESETS,
  FAST_TEMPERATURE, CREATIVE_TEMPERATURE, CREATIVE_TOP_P,
  type SamplerSettings,
} from '../../src/pages/chat/samplerPresets'

// ── Renderer-global stubs, installed BEFORE importing the store (same shape as
// chatStore.test.ts) so the persist middleware's write path resolves quietly in
// the node env and module-load rehydration sees them.
const memStore = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
}
;(globalThis as Record<string, unknown>).window = {
  tachi: { safeStorage: { isAvailable: async () => ({ available: false }) } },
}

const { useChatStore } = await import('../../src/store/chat.store')

// ─────────────────────────────────────────────────────────────────────────────
describe('samplerToParams — preset → params mapping', () => {
  it('BALANCED sends NOTHING (the safety guarantee)', () => {
    expect(samplerToParams({ preset: 'balanced' })).toEqual({})
  })

  it('an ABSENT sampler is treated as BALANCED (migration-safe) — sends nothing', () => {
    expect(samplerToParams(undefined)).toEqual({})
    expect(samplerToParams(null)).toEqual({})
  })

  it('FAST → temperature 0.3 only (no top_p)', () => {
    const p = samplerToParams({ preset: 'fast' })
    expect(p).toEqual({ temperature: FAST_TEMPERATURE })
    expect(p).toEqual({ temperature: 0.3 })
    expect('top_p' in p).toBe(false)
  })

  it('CREATIVE → temperature 0.9 + top_p 0.95', () => {
    expect(samplerToParams({ preset: 'creative' })).toEqual({
      temperature: CREATIVE_TEMPERATURE, top_p: CREATIVE_TOP_P,
    })
    expect(samplerToParams({ preset: 'creative' })).toEqual({ temperature: 0.9, top_p: 0.95 })
  })

  it('ADVANCED emits exactly the knobs the user set', () => {
    expect(samplerToParams({ preset: 'advanced', temperature: 1.2, topP: 0.8 }))
      .toEqual({ temperature: 1.2, top_p: 0.8 })
  })

  it('ADVANCED clamps temperature to [0,2] and top_p to [0,1]', () => {
    expect(samplerToParams({ preset: 'advanced', temperature: 5, topP: 3 }))
      .toEqual({ temperature: 2, top_p: 1 })
    expect(samplerToParams({ preset: 'advanced', temperature: -1, topP: -0.5 }))
      .toEqual({ temperature: 0, top_p: 0 })
  })

  it('ADVANCED omits a missing knob rather than inventing a default', () => {
    expect(samplerToParams({ preset: 'advanced', temperature: 0.5 })).toEqual({ temperature: 0.5 })
    expect(samplerToParams({ preset: 'advanced', topP: 0.5 })).toEqual({ top_p: 0.5 })
    // advanced with neither knob set → still nothing (never a phantom default)
    expect(samplerToParams({ preset: 'advanced' })).toEqual({})
  })

  it('ADVANCED ignores non-finite knob values', () => {
    expect(samplerToParams({ preset: 'advanced', temperature: NaN, topP: Infinity })).toEqual({})
  })

  it('an unknown preset falls back to BALANCED semantics (sends nothing)', () => {
    expect(samplerToParams({ preset: 'nonsense' as unknown as SamplerSettings['preset'] })).toEqual({})
  })
})

describe('samplerPayload — clean IPC payload', () => {
  it('returns undefined for BALANCED / absent (nothing to send)', () => {
    expect(samplerPayload({ preset: 'balanced' })).toBeUndefined()
    expect(samplerPayload(undefined)).toBeUndefined()
    expect(samplerPayload({ preset: 'advanced' })).toBeUndefined() // resolves to {}
  })

  it('returns the resolved params for non-BALANCED presets', () => {
    expect(samplerPayload({ preset: 'fast' })).toEqual({ temperature: 0.3 })
    expect(samplerPayload({ preset: 'creative' })).toEqual({ temperature: 0.9, top_p: 0.95 })
    expect(samplerPayload({ preset: 'advanced', temperature: 1.5, topP: 0.7 }))
      .toEqual({ temperature: 1.5, top_p: 0.7 })
  })
})

describe('helpers', () => {
  it('DEFAULT_SAMPLER is BALANCED', () => {
    expect(DEFAULT_SAMPLER).toEqual({ preset: 'balanced' })
  })

  it('SAMPLER_PRESETS lists the four presets with BALANCED present', () => {
    expect(SAMPLER_PRESETS).toEqual(['fast', 'balanced', 'creative', 'advanced'])
  })

  it('samplerPreset resolves absent → balanced', () => {
    expect(samplerPreset(undefined)).toBe('balanced')
    expect(samplerPreset(null)).toBe('balanced')
    expect(samplerPreset({ preset: 'creative' })).toBe('creative')
  })

  it('clampTemperature / clampTopP clamp + round to their ranges', () => {
    expect(clampTemperature(0.35)).toBe(0.35)
    expect(clampTemperature(9)).toBe(2)
    expect(clampTemperature(-3)).toBe(0)
    expect(clampTopP(0.95)).toBe(0.95)
    expect(clampTopP(9)).toBe(1)
    expect(clampTopP(-3)).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('store — setConversationSampler persistence shape', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: [{
        id: 'c1', title: 'New Chat', messages: [],
        providerId: 'llama-cpp', model: 'auto',
        createdAt: 't0', updatedAt: 't0',
      }],
      activeConversationId: 'c1',
    })
  })

  const conv = () => useChatStore.getState().conversations.find(c => c.id === 'c1')!

  it('a fresh conversation has NO sampler (absent = BALANCED)', () => {
    expect(conv().sampler).toBeUndefined()
    expect(samplerPreset(conv().sampler)).toBe('balanced')
    expect(samplerToParams(conv().sampler)).toEqual({})
  })

  it('setting FAST persists { preset: "fast" }', () => {
    useChatStore.getState().setConversationSampler('c1', { preset: 'fast' })
    expect(conv().sampler).toEqual({ preset: 'fast' })
    expect(samplerPayload(conv().sampler)).toEqual({ temperature: 0.3 })
  })

  it('setting ADVANCED persists the exact knobs', () => {
    useChatStore.getState().setConversationSampler('c1', { preset: 'advanced', temperature: 1.1, topP: 0.85 })
    expect(conv().sampler).toEqual({ preset: 'advanced', temperature: 1.1, topP: 0.85 })
  })

  it('setting BALANCED normalizes back to ABSENT (never persists a redundant marker)', () => {
    useChatStore.getState().setConversationSampler('c1', { preset: 'creative' })
    expect(conv().sampler).toEqual({ preset: 'creative' })
    useChatStore.getState().setConversationSampler('c1', { preset: 'balanced' })
    expect(conv().sampler).toBeUndefined()
  })

  it('passing null clears the sampler', () => {
    useChatStore.getState().setConversationSampler('c1', { preset: 'fast' })
    useChatStore.getState().setConversationSampler('c1', null)
    expect(conv().sampler).toBeUndefined()
  })

  it('only touches the targeted conversation', () => {
    useChatStore.setState({
      conversations: [
        ...useChatStore.getState().conversations,
        { id: 'c2', title: 'B', messages: [], providerId: 'p', model: 'auto', createdAt: 't', updatedAt: 't' },
      ],
    })
    useChatStore.getState().setConversationSampler('c1', { preset: 'creative' })
    expect(useChatStore.getState().conversations.find(c => c.id === 'c2')!.sampler).toBeUndefined()
  })
})
