// packages/core/src/catalog/__tests__/hf.test.ts
import { describe, it, expect } from 'vitest'
import { parseQuantFromFilename, normalizeHfModel, deriveCapabilities, type HfRepoLite } from '../hf.js'

describe('parseQuantFromFilename', () => {
  it('extracts Q4_K_M', () => {
    expect(parseQuantFromFilename('Qwen2.5-7B-Instruct-Q4_K_M.gguf')).toBe('Q4_K_M')
  })
  it('extracts Q8_0', () => {
    expect(parseQuantFromFilename('model-Q8_0.gguf')).toBe('Q8_0')
  })
  it('extracts IQ4_XS', () => {
    expect(parseQuantFromFilename('model-IQ4_XS.gguf')).toBe('IQ4_XS')
  })
  it('extracts F16', () => {
    expect(parseQuantFromFilename('model-f16.gguf')).toBe('F16')
  })
  it('extracts Q4_K_M_L (community _L variant)', () => {
    expect(parseQuantFromFilename('model-Q4_K_M_L.gguf')).toBe('Q4_K_M_L')
  })
  it('returns null for non-quant filenames', () => {
    expect(parseQuantFromFilename('README.md')).toBeNull()
  })
})

describe('normalizeHfModel', () => {
  it('maps a GGUF repo into a CatalogEntry with one quant per gguf file', () => {
    const repo: HfRepoLite = {
      id: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
      siblings: [
        { rfilename: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', size: 4700000000 },
        { rfilename: 'Qwen2.5-7B-Instruct-Q8_0.gguf', size: 8000000000 },
        { rfilename: 'README.md' },
      ],
    }
    const entry = normalizeHfModel(repo)
    expect(entry).not.toBeNull()
    expect(entry!.source).toBe('hf')
    expect(entry!.params).toBe('7B')
    expect(entry!.quants).toHaveLength(2)
    // Single-file quants download directly into llama.cpp by URL.
    const q4 = entry!.quants.find(q => q.label === 'Q4_K_M')!
    expect(q4.runtime).toBe('llamacpp')
    expect(q4.url).toBe('https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf')
    expect(q4.ref).not.toContain('/') // sanitized local id, not a path
    expect(entry!.capabilities).toContain('chat')
  })

  it('marks the Q4_K_M quant as recommended', () => {
    const repo: HfRepoLite = {
      id: 'bartowski/X-7B-GGUF',
      siblings: [
        { rfilename: 'X-7B-Q4_K_M.gguf', size: 4_700_000_000 },
        { rfilename: 'X-7B-Q8_0.gguf', size: 8_000_000_000 },
      ],
    }
    const entry = normalizeHfModel(repo)!
    expect(entry.quants.find(q => q.label === 'Q4_K_M')!.recommended).toBe(true)
    expect(entry.quants.find(q => q.label === 'Q8_0')!.recommended).toBe(false)
  })

  it('collapses split GGUF parts into one quant and sums their sizes; skips mmproj', () => {
    const repo: HfRepoLite = {
      id: 'org/Big-70B-GGUF',
      siblings: [
        { rfilename: 'Big-70B-Q4_K_M-00001-of-00002.gguf', size: 20_000_000_000 },
        { rfilename: 'Big-70B-Q4_K_M-00002-of-00002.gguf', size: 22_000_000_000 },
        { rfilename: 'mmproj-Big-70B-f16.gguf', size: 600_000_000 },
      ],
    }
    const entry = normalizeHfModel(repo)!
    const q4 = entry.quants.filter(q => q.label === 'Q4_K_M')
    expect(q4).toHaveLength(1)
    expect(q4[0].sizeBytes).toBe(42_000_000_000)
    expect(entry.quants.find(q => q.label === 'F16')).toBeUndefined() // mmproj skipped
    expect(q4[0].ref).toBe('hf.co/org/Big-70B-GGUF:Q4_K_M')
  })

  it('returns null when the repo has no gguf files', () => {
    const repo: HfRepoLite = { id: 'someone/not-gguf', siblings: [{ rfilename: 'config.json' }] }
    expect(normalizeHfModel(repo)).toBeNull()
  })

  it('skips gguf files with no recognisable quant (avoids malformed Ollama tags)', () => {
    const repo: HfRepoLite = {
      id: 'Andycurrent/Weird-Merge_GGUF',
      siblings: [
        { rfilename: 'Weird-Merge-Heretic-Thinking.gguf', size: 1_000_000_000 }, // no quant token
        { rfilename: 'Weird-Merge-Q4_K_M.gguf', size: 2_000_000_000 },           // valid quant
      ],
    }
    const entry = normalizeHfModel(repo)!
    expect(entry.quants).toHaveLength(1)
    expect(entry.quants[0].label).toBe('Q4_K_M')
  })

  it('returns null when no gguf has a recognisable quant', () => {
    const repo: HfRepoLite = {
      id: 'x/Frankenmerge_GGUF',
      siblings: [{ rfilename: 'Frankenmerge-Uncensored-Thinking.gguf', size: 800_000_000 }],
    }
    expect(normalizeHfModel(repo)).toBeNull()
  })
})

describe('deriveCapabilities', () => {
  it('always includes chat as the baseline', () => {
    expect(deriveCapabilities({ name: 'Llama-3.1-8B-Instruct' })).toEqual(['chat'])
  })
  it('detects code models by name', () => {
    expect(deriveCapabilities({ name: 'Qwen2.5-Coder-7B-Instruct' })).toContain('code')
  })
  it('detects vision from pipeline tag', () => {
    expect(deriveCapabilities({ name: 'SomeVLM-7B', pipelineTag: 'image-text-to-text' })).toContain('vision')
  })
  it('detects reasoning models (R1/QwQ)', () => {
    expect(deriveCapabilities({ name: 'DeepSeek-R1-Distill-Qwen-7B' })).toContain('reasoning')
    expect(deriveCapabilities({ name: 'QwQ-32B-Preview' })).toContain('reasoning')
  })
  it('detects tools from HF tags', () => {
    expect(deriveCapabilities({ name: 'Foo-7B', tags: ['function-calling'] })).toContain('tools')
  })
  it('detects image-gen from pipeline tag', () => {
    expect(deriveCapabilities({ name: 'sd-v1-5', pipelineTag: 'text-to-image' })).toContain('image-gen')
  })
  it('detects video-gen (Wan) from pipeline tag', () => {
    expect(deriveCapabilities({ name: 'Wan2.1-T2V-1.3B', pipelineTag: 'text-to-video' })).toContain('video-gen')
  })
  it('detects stt (Whisper) from pipeline tag', () => {
    expect(deriveCapabilities({ name: 'whisper-large-v3', pipelineTag: 'automatic-speech-recognition' })).toContain('stt')
  })
  it('detects tts (piper) from pipeline tag', () => {
    expect(deriveCapabilities({ name: 'piper-voice-en', pipelineTag: 'text-to-speech' })).toContain('tts')
  })
})
