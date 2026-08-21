// apps/desktop/test/unit/catalogSearch.test.ts
import { describe, it, expect } from 'vitest'
import { scoreEntry, searchEntries, hfSearchCoordinator } from '../../src/pages/catalog/search'

// Minimal CatalogEntry stand-in — scoreEntry only reads name/family/params/capabilities.
type E = { name: string; family: string; params?: string; capabilities?: string[] }
const mk = (e: E) => e as unknown as Parameters<typeof scoreEntry>[0]

describe('scoreEntry', () => {
  it('returns a neutral 1 for a blank query (always include)', () => {
    expect(scoreEntry(mk({ name: 'X', family: 'y' }), '')).toBe(1)
    expect(scoreEntry(mk({ name: 'X', family: 'y' }), '   ')).toBe(1)
  })

  it('returns 0 when nothing matches', () => {
    expect(scoreEntry(mk({ name: 'gpt', family: 'openai' }), 'zzzznope')).toBe(0)
  })

  it('scores an exact name-token match far above a substring-only match', () => {
    const exact  = scoreEntry(mk({ name: 'Llama', family: 'meta' }), 'llama')
    const substr = scoreEntry(mk({ name: 'XLlamaY', family: 'meta' }), 'llama')
    expect(exact).toBeGreaterThan(substr)
    expect(substr).toBeGreaterThan(0)
  })

  it('gives a small fuzzy bonus for an in-order subsequence match', () => {
    // 'lma' is a subsequence of 'llama' but not a token/prefix/substring; family doesn't match.
    expect(scoreEntry(mk({ name: 'llama', family: 'x' }), 'lma')).toBe(2)
  })

  it('matches params and capability tokens', () => {
    expect(scoreEntry(mk({ name: 'Mixtral', family: 'mistral', params: '7B' }), '7b')).toBeGreaterThan(0)
    expect(scoreEntry(mk({ name: 'CLIP', family: 'openai', capabilities: ['vision'] }), 'vision')).toBeGreaterThan(0)
  })
})

describe('searchEntries', () => {
  const entries = [
    mk({ name: 'XLlamaY', family: 'meta', capabilities: ['text'] }),
    mk({ name: 'Llama', family: 'meta', capabilities: ['text'] }),
    mk({ name: 'Stable Diffusion', family: 'sd', capabilities: ['image'] }),
  ]

  it('ranks the best match first and drops non-matches', () => {
    const res = searchEntries(entries, 'llama', [])
    expect(res).toHaveLength(2)
    expect(res[0].name).toBe('Llama') // exact token beats substring
  })

  it('applies the capability pre-filter', () => {
    const res = searchEntries(entries, '', ['image'])
    expect(res.map(e => e.name)).toEqual(['Stable Diffusion'])
  })

  it('returns the tag-filtered list unchanged for a blank query', () => {
    expect(searchEntries(entries, '', []).length).toBe(3)
  })
})

describe('hfSearchCoordinator', () => {
  it('invalidates earlier request ids when a new one is issued', () => {
    const id1 = hfSearchCoordinator.next()
    const id2 = hfSearchCoordinator.next()
    expect(hfSearchCoordinator.isCurrent(id1)).toBe(false)
    expect(hfSearchCoordinator.isCurrent(id2)).toBe(true)
  })
})
