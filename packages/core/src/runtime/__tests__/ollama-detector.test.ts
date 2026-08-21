import { describe, it, expect, vi } from 'vitest'
import { createOllamaDetector } from '../detectors/ollama.js'

describe('OllamaDetector', () => {
  it('returns healthy when port probe succeeds', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3' }] }),
    })
    const detector = createOllamaDetector(mockFetch as any)
    const result = await detector.detect()
    expect(result.status).toBe('healthy')
    expect(result.runtimeId).toBe('ollama')
    expect(result.kind).toBe('local_model_server')
  })

  it('returns not_running when port probe fails with connection refused', async () => {
    const mockFetch = vi.fn().mockRejectedValue(Object.assign(new Error(), { code: 'ECONNREFUSED' }))
    const detector = createOllamaDetector(mockFetch as any)
    const result = await detector.detect()
    expect(result.status).toBe('not_running')
  })

  it('includes checkedAt timestamp', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) })
    const detector = createOllamaDetector(mockFetch as any)
    const result = await detector.detect()
    expect(new Date(result.checkedAt).getTime()).toBeGreaterThan(0)
  })
})
