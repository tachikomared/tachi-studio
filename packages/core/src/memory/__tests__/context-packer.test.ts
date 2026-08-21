// packages/core/src/memory/__tests__/context-packer.test.ts
//
// Ported verbatim from apps/desktop/test/unit/contextPacker.test.ts (the module
// moved to @tachi/core so the Electron MAIN process can import it; its tests
// followed it here). Assertions unchanged — only the import path moved.
import { describe, it, expect } from 'vitest'
import { packContext } from '../context-packer.js'

const stripEllipsis = (s: string) => s.replace(/…$/, '')

describe('packContext', () => {
  it('returns empty for empty input and drops blank items', () => {
    expect(packContext([])).toEqual({ items: [], totalChars: 0 })
    expect(packContext([{ text: '   ' }, { text: '' }])).toEqual({ items: [], totalChars: 0 })
  })

  it('caps the item count at targetItems and total chars at maxTotalChars', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ text: `item-${i}`, score: i }))
    const res = packContext(items, { targetItems: 3, maxTotalChars: 1000 })
    expect(res.items.length).toBeLessThanOrEqual(3)
    expect(res.totalChars).toBeLessThanOrEqual(1000)
  })

  it('never keeps an item longer than maxItemChars', () => {
    const res = packContext([{ text: 'x'.repeat(500), score: 1 }], { maxItemChars: 120, maxTotalChars: 1000 })
    expect(res.items[0].length).toBeLessThanOrEqual(120)
  })

  it('places the strongest items at BOTH ends (anti lost-in-the-middle)', () => {
    const items = [5, 4, 3, 2, 1].map(n => ({ text: `score${n}`, score: n }))
    const res = packContext(items, { targetItems: 5, maxTotalChars: 1000, maxItemChars: 360 })
    expect(res.items.length).toBe(5)
    // highest score leads the head; second-highest anchors the tail
    expect(res.items[0]).toBe('score5')
    expect(res.items[res.items.length - 1]).toBe('score4')
  })

  it('re-expands kept items from their OWN source after compression (phase-3 regression)', () => {
    // Three distinct single-letter sources. If phase 3 ever re-expands a kept
    // item from the WRONG source (the bug that was fixed), a packed item would
    // carry another letter's content — caught by the identity + purity checks.
    const items = [
      { text: 'A'.repeat(300), score: 3 },
      { text: 'B'.repeat(300), score: 2 },
      { text: 'C'.repeat(300), score: 1 },
    ]
    const res = packContext(items, { targetItems: 3, maxTotalChars: 600, minItemChars: 80, maxItemChars: 300 })
    expect(res.items.length).toBe(3)
    // Every source represented exactly once, by its own first character.
    expect(new Set(res.items.map(s => s[0]))).toEqual(new Set(['A', 'B', 'C']))
    // Each packed item is pure (one repeated letter, ignoring the ellipsis).
    for (const it of res.items) {
      const body = stripEllipsis(it)
      expect(new Set(body.split(''))).toHaveProperty('size', 1)
    }
    expect(res.totalChars).toBeLessThanOrEqual(600)
  })

  it('orders by score regardless of input order', () => {
    const res = packContext([
      { text: 'low', score: 1 },
      { text: 'high', score: 9 },
    ], { targetItems: 2, maxTotalChars: 1000 })
    // 'high' is strongest -> sits at the head
    expect(res.items[0]).toBe('high')
  })
})
