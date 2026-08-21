import { describe, it, expect } from 'vitest'
import { resolveModelProfile, profiledIdleMs } from '../model-profiles.js'

describe('resolveModelProfile', () => {
  it('classifies reasoning-class models with a 3× timeout multiplier', () => {
    for (const id of ['deepseek-r1', 'deepseek/deepseek-r1-0528', 'QwQ-32B', 'o3-mini', 'o1', 'o4-mini', 'gpt-5.2-thinking', 'qwen3-235b-thinking']) {
      const p = resolveModelProfile(id)
      expect(p.reasoning, id).toBe(true)
      expect(p.timeoutMultiplier, id).toBe(3)
      expect(p.tier, id).toBe('full')
    }
  })

  it('reasoning wins over size/mini markers in the same id (rule order)', () => {
    expect(resolveModelProfile('deepseek-r1-distill-qwen-7b').reasoning).toBe(true)
    expect(resolveModelProfile('o3-mini').reasoning).toBe(true)
  })

  it('classifies frontier models as full tier, no adjustments', () => {
    for (const id of ['claude-opus-4.8', 'claude-opus-5', 'claude-sonnet-5', 'gpt-5', 'gemini-3.0-pro', 'grok-4', 'deepseek-v3', 'kimi-k2']) {
      const p = resolveModelProfile(id)
      expect(p.tier, id).toBe('full')
      expect(p.timeoutMultiplier, id).toBe(1)
      expect(p.simplifiedPrompt, id).toBe(false)
    }
  })

  it('classifies small/cheap models as basic with the simplified-prompt flag', () => {
    for (const id of ['claude-haiku-4.5', 'gemini-3-flash', 'gpt-5-mini', 'gpt-4o-mini', 'gemma-2-9b-it', 'phi-4']) {
      const p = resolveModelProfile(id)
      expect(p.tier, id).toBe('basic')
      expect(p.simplifiedPrompt, id).toBe(true)
    }
  })

  it('falls back to the parameter-size heuristic: ≤14B basic, ≥65B full', () => {
    expect(resolveModelProfile('llama-3.1-8b-instruct').tier).toBe('basic')
    expect(resolveModelProfile('meta/llama-3.1-70b-instruct').tier).toBe('full')
    expect(resolveModelProfile('mixtral-32b').tier).toBe('standard') // mid-size → standard
  })

  it('unknown or empty ids get the conservative standard profile', () => {
    for (const id of ['auto', 'totally-new-model-x', '', null, undefined]) {
      const p = resolveModelProfile(id)
      expect(p.tier).toBe('standard')
      expect(p.timeoutMultiplier).toBe(1)
      expect(p.simplifiedPrompt).toBe(false)
    }
  })

  it('does not misread ids: gpt-4o is not o4-reasoning; 405b is not small', () => {
    expect(resolveModelProfile('gpt-4o').reasoning).toBe(false)
    expect(resolveModelProfile('llama-3.1-405b').tier).toBe('full')
  })
})

describe('profiledIdleMs', () => {
  it('multiplies the base timeout only for reasoning models', () => {
    expect(profiledIdleMs('deepseek-r1', 120_000)).toBe(360_000)
    expect(profiledIdleMs('claude-opus-4.8', 120_000)).toBe(120_000)
    expect(profiledIdleMs(undefined, 120_000)).toBe(120_000)
  })
})
