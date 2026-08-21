import { describe, it, expect, vi } from 'vitest'
import { fetchBankrModels } from '../bankr-models.js'

function okResponse(ids: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: ids.map(id => ({ id })) }),
  }
}

describe('fetchBankrModels', () => {
  it('maps ids to ModelInfo with id as displayName', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse(['some-model']))
    const result = await fetchBankrModels('bk_test', mockFetch as any)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('some-model')
    expect(result[0].displayName).toBe('some-model')
  })

  it('infers tier from the model id (case-insensitive, substring)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      okResponse([
        'anthropic/claude-haiku-20240307',
        'anthropic/Claude-Sonnet-4',
        'anthropic/claude-opus-4',
        'openai/gpt-4o-mini',
        'openai/gpt-4o',
        'google/gemini-flash',
        'google/gemini-pro',
      ]),
    )
    const result = await fetchBankrModels('bk_test', mockFetch as any)
    const tierById = Object.fromEntries(result.map(m => [m.id, m.tier]))
    expect(tierById['anthropic/claude-haiku-20240307']).toBe('fast')
    expect(tierById['anthropic/Claude-Sonnet-4']).toBe('balanced')
    expect(tierById['anthropic/claude-opus-4']).toBe('powerful')
    expect(tierById['openai/gpt-4o-mini']).toBe('fast')
    expect(tierById['openai/gpt-4o']).toBe('balanced')
    expect(tierById['google/gemini-flash']).toBe('fast')
    expect(tierById['google/gemini-pro']).toBe('balanced')
  })

  it('tiers the Claude 5 family (claude-opus-5 / claude-sonnet-5) from the family key', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse(['claude-opus-5', 'claude-sonnet-5']))
    const result = await fetchBankrModels('bk_test', mockFetch as any)
    const tierById = Object.fromEntries(result.map(m => [m.id, m.tier]))
    expect(tierById['claude-opus-5']).toBe('powerful')
    expect(tierById['claude-sonnet-5']).toBe('balanced')
  })

  it('leaves tier undefined for an unrecognised id', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse(['mystery-model-v9']))
    const result = await fetchBankrModels('bk_test', mockFetch as any)
    expect(result[0].tier).toBeUndefined()
  })

  it('marks any sonnet model as default (case-insensitive)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      okResponse(['claude-haiku', 'anthropic/Claude-Sonnet-4', 'gpt-4o']),
    )
    const result = await fetchBankrModels('bk_test', mockFetch as any)
    const defaults = result.filter(m => m.isDefault).map(m => m.id)
    expect(defaults).toEqual(['anthropic/Claude-Sonnet-4'])
  })

  it('throws when the response is not ok', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(fetchBankrModels('bk_test', mockFetch as any)).rejects.toThrow(
      'Models fetch failed: 500',
    )
  })

  it('returns an empty array when the provider lists no models', async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse([]))
    const result = await fetchBankrModels('bk_test', mockFetch as any)
    expect(result).toEqual([])
  })
})
