// packages/core/src/providers/__tests__/vision.test.ts
//
// isVisionModel — does a model id name a multimodal (image-reading) model? The
// Nodes surface used to assume "only Venice has vision"; in fact Bankr/Surplus/
// OpenAI-compat gateways serve plenty of vision models (Claude, Gemini, GPT-4o/5,
// Qwen-VL, Pixtral…). Heuristic by id family, like the rest of the catalog code.

import { describe, it, expect } from 'vitest'
import { isVisionModel } from '../vision.js'

describe('isVisionModel', () => {
  it('flags modern Claude (opus/sonnet/haiku) as vision', () => {
    expect(isVisionModel('claude-opus-4.8')).toBe(true)
    expect(isVisionModel('claude-sonnet-4.6')).toBe(true)
    expect(isVisionModel('claude-haiku-4.5')).toBe(true)
  })
  it('flags the Claude 5 family Bankr serves (opus-5 / sonnet-5)', () => {
    expect(isVisionModel('claude-opus-5')).toBe(true)
    expect(isVisionModel('claude-sonnet-5')).toBe(true)
  })
  it('flags Gemini + GPT-4o/4.1/5 + o-series as vision', () => {
    expect(isVisionModel('gemini-3-pro')).toBe(true)
    expect(isVisionModel('gemini-3-flash')).toBe(true)
    expect(isVisionModel('gpt-4o')).toBe(true)
    expect(isVisionModel('gpt-5.2')).toBe(true)
    expect(isVisionModel('o3-mini')).toBe(true)
  })
  it('flags the open vision families (Qwen-VL, Pixtral, Llama-4/vision, GLM-4v)', () => {
    expect(isVisionModel('qwen2.5-vl-72b')).toBe(true)
    expect(isVisionModel('pixtral-12b')).toBe(true)
    expect(isVisionModel('llama-3.2-90b-vision')).toBe(true)
    expect(isVisionModel('llama-4-scout')).toBe(true)
    expect(isVisionModel('glm-4v-9b')).toBe(true)
  })
  it('does NOT flag text-only models', () => {
    expect(isVisionModel('llama-3.3-70b')).toBe(false)
    expect(isVisionModel('deepseek-v3.2')).toBe(false)
    expect(isVisionModel('gpt-3.5-turbo')).toBe(false)
    expect(isVisionModel('qwen3-235b-a22b-thinking-2507')).toBe(false)
    expect(isVisionModel('')).toBe(false)
  })
})
