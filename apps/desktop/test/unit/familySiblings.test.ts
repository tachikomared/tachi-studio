// apps/desktop/test/unit/familySiblings.test.ts
import { describe, it, expect } from 'vitest'
import { findSiblings, findBestSibling, hasSibling } from '../../src/pages/catalog/familySiblings'

// Minimal CatalogEntry stand-in — only id/family/capabilities/downloads are read.
type E = { id: string; family: string; capabilities?: string[]; downloads?: number }
const mk = (e: E) => e as unknown as Parameters<typeof findSiblings>[0]

const source = mk({ id: 'llama-3-chat', family: 'llama', capabilities: ['chat'] })
const catalog = [
  source,
  mk({ id: 'llama-3-vision', family: 'llama', capabilities: ['vision'], downloads: 100 }),
  mk({ id: 'llama-vision-2', family: 'llama', capabilities: ['vision'], downloads: 500 }),
  mk({ id: 'qwen-vision',    family: 'qwen',  capabilities: ['vision'], downloads: 9999 }), // different family
  mk({ id: 'llama-3-code',   family: 'llama', capabilities: ['code'] }),                    // not a sibling cap of chat
]

describe('findSiblings', () => {
  it('maps chat -> vision within the same family, excluding self & cross-family', () => {
    const res = findSiblings(source, catalog)
    expect(res).toHaveLength(1)
    expect(res[0].siblingCap).toBe('vision')
    // sorted by downloads desc; cross-family qwen-vision excluded despite high downloads
    expect(res[0].entries.map(e => e.id)).toEqual(['llama-vision-2', 'llama-3-vision'])
  })

  it('returns [] when the source has no capabilities', () => {
    expect(findSiblings(mk({ id: 'x', family: 'y', capabilities: [] }), catalog)).toEqual([])
  })

  it('returns [] when the source cap has no sibling mapping', () => {
    expect(findSiblings(mk({ id: 'e', family: 'llama', capabilities: ['embedding'] }), catalog)).toEqual([])
  })

  it('maps image-gen <-> video-gen within a family', () => {
    const sd = mk({ id: 'sd', family: 'stable-diffusion', capabilities: ['image-gen'] })
    const cat = [sd, mk({ id: 'svd', family: 'stable-diffusion', capabilities: ['video-gen'], downloads: 1 })]
    const res = findSiblings(sd, cat)
    expect(res).toHaveLength(1)
    expect(res[0].siblingCap).toBe('video-gen')
    expect(res[0].entries[0].id).toBe('svd')
  })

  it('respects maxPerCap', () => {
    expect(findSiblings(source, catalog, 1).find(r => r.siblingCap === 'vision')!.entries).toHaveLength(1)
  })
})

describe('findBestSibling / hasSibling', () => {
  it('findBestSibling returns the most popular match or null', () => {
    expect(findBestSibling(source, catalog, 'vision')?.id).toBe('llama-vision-2')
    expect(findBestSibling(source, catalog, 'image-gen')).toBeNull()
  })

  it('hasSibling is a cheap boolean pre-check', () => {
    expect(hasSibling(source, catalog, 'vision')).toBe(true)
    expect(hasSibling(source, catalog, 'tts')).toBe(false)
  })
})
