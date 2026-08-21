import { describe, it, expect } from 'vitest'
import { modelDisplayName } from '../../src/utils/model-display'

describe('modelDisplayName', () => {
  it('empty / auto', () => {
    expect(modelDisplayName(undefined)).toBe('')
    expect(modelDisplayName('')).toBe('')
    expect(modelDisplayName('auto')).toBe('Auto')
  })

  it('the gguf horror case: hf owner prefix + quant suffix + extension', () => {
    expect(modelDisplayName('hf_hauhaucs_gemma-4-e2b-uncensored-iq3_m.gguf'))
      .toBe('Gemma 4 e2b Uncensored')
  })

  it('classic gguf with upper quant', () => {
    expect(modelDisplayName('Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf'))
      .toBe('Meta Llama 3.1 8b Instruct')
  })

  it('cloud catalog ids', () => {
    expect(modelDisplayName('claude-opus-4.8')).toBe('Claude Opus 4.8')
    expect(modelDisplayName('gpt-5-6')).toBe('GPT 5 6')
    expect(modelDisplayName('zai-org-glm-4.7')).toBe('Zai Org GLM 4.7')
    expect(modelDisplayName('deepseek-chat')).toBe('DeepSeek Chat')
  })

  it('ollama tags: latest dropped, size kept', () => {
    expect(modelDisplayName('llama3.2:latest')).toBe('Llama3.2')
    expect(modelDisplayName('qwen2.5:7b')).toBe('Qwen2.5 7b')
  })

  it('org/model paths use the basename', () => {
    expect(modelDisplayName('meta-llama/Llama-3.3-70B')).toBe('Llama 3.3 70b')
  })

  it('router aliases keep the ROUTER, not the tier word', () => {
    // Driver-proven 2026-08-01: a Kilo reply's badge read "Free" — the basename
    // of `kilo-auto/free`. "Free" names no model and tells the user nothing
    // about what answered. The honest half of an alias is its head.
    expect(modelDisplayName('kilo-auto/free')).toBe('Kilo Auto')
    expect(modelDisplayName('openrouter/auto')).toBe('Openrouter')
    expect(modelDisplayName('some-router/default')).toBe('Some Router')
    // …and a REAL org/model id is untouched — 'free'/'auto' only as the tail.
    expect(modelDisplayName('meta-llama/Llama-3.3-70B')).toBe('Llama 3.3 70b')
    expect(modelDisplayName('deepseek/deepseek-chat-v3')).toBe('DeepSeek Chat v3')
  })

  it('never returns empty for weird-but-nonempty input', () => {
    expect(modelDisplayName('q4_k_m')).not.toBe('')
  })
})
