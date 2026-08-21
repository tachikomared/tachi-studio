import { describe, it, expect } from 'vitest'
import { tokenize, scoreRecall, recall, recallAndPack } from '../recall.js'

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('Hello, World-42!')).toEqual(['hello', 'world', '42'])
  })

  it('drops stopwords and single-char tokens', () => {
    // 'the', 'a', 'of' are stopwords; 'x' is a single-char token.
    expect(tokenize('the cat a x of dogs')).toEqual(['cat', 'dogs'])
  })

  it('returns an empty array for text with no usable tokens', () => {
    expect(tokenize('the a of')).toEqual([])
    expect(tokenize('   !!!  ')).toEqual([])
    expect(tokenize('')).toEqual([])
  })
})

describe('scoreRecall', () => {
  it('returns 0 when the query has no usable tokens', () => {
    expect(scoreRecall('the a of', 'the cat sat on the mat')).toBe(0)
  })

  it('returns 0 when the text has no usable tokens', () => {
    expect(scoreRecall('cat', 'the a of')).toBe(0)
  })

  it('returns 0 when there is no overlap', () => {
    expect(scoreRecall('cat dog', 'rocket science')).toBe(0)
  })

  it('normalizes by the number of distinct query tokens', () => {
    // Each present token contributes 1 + a small tf bonus; with both query tokens
    // present once the average is just above 1 (and identical for one token).
    const two = scoreRecall('cat dog', 'the cat met the dog')
    const one = scoreRecall('cat', 'the cat met the dog')
    expect(two).toBeCloseTo(one, 10)
    expect(two).toBeGreaterThan(1)
    expect(two).toBeLessThan(1.5)
  })

  it('scores partial overlap below full overlap', () => {
    // Only one of two distinct query tokens present -> ~ (1 + tfbonus) / 2.
    const full = scoreRecall('cat dog', 'the cat met the dog')
    const partial = scoreRecall('cat dog', 'just a cat here')
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(full)
  })

  it('gives a small sublinear bonus for repeated terms', () => {
    const once = scoreRecall('cat', 'a single cat')
    const many = scoreRecall('cat', 'cat cat cat cat')
    expect(many).toBeGreaterThan(once)
    // The bonus is capped at 0.5, so a single query token can never exceed 1.5.
    expect(many).toBeLessThanOrEqual(1.5)
  })

  it('counts a query token only once even when repeated in the query', () => {
    // qSet dedupes 'cat' -> same score as a single 'cat' query.
    expect(scoreRecall('cat cat', 'a cat')).toBeCloseTo(scoreRecall('cat', 'a cat'), 10)
  })
})

describe('recall', () => {
  const items = [
    { text: 'the cat sat on the mat' },
    { text: 'a dog chased the ball' },
    { text: 'rocket science is hard' },
  ]

  it('ranks more relevant items first and drops zero-overlap items by default', () => {
    const out = recall('cat mat', items)
    expect(out.map(i => i.text)).toEqual(['the cat sat on the mat'])
    expect(out[0].score).toBeGreaterThan(0)
  })

  it('keeps zero-overlap items when keepZero is set', () => {
    const out = recall('cat', items, { keepZero: true })
    expect(out).toHaveLength(items.length)
  })

  it('honours topK', () => {
    const out = recall('cat dog rocket', items, { topK: 2 })
    expect(out).toHaveLength(2)
  })

  it('returns an empty array for topK <= 0', () => {
    expect(recall('cat', items, { topK: 0 })).toEqual([])
    expect(recall('cat', items, { topK: -5 })).toEqual([])
  })

  it('applies per-item boost to the score', () => {
    const boosted = [
      { text: 'cat one', boost: 3 },
      { text: 'cat two' },
    ]
    const out = recall('cat', boosted, { keepZero: true })
    expect(out.map(i => i.text)).toEqual(['cat one', 'cat two'])
    const scores = out.map(i => i.score)
    expect(scores[0]).toBeCloseTo((scores[1] ?? 0) * 3, 10)
  })

  it('is stable for equal scores (preserves input order)', () => {
    const ties = [
      { text: 'cat alpha' },
      { text: 'cat beta' },
    ]
    const out = recall('cat', ties)
    expect(out.map(i => i.text)).toEqual(['cat alpha', 'cat beta'])
  })
})

// ---------------------------------------------------------------------------
// Ported verbatim from apps/desktop/test/unit/recall.test.ts (the module moved
// to @tachi/core so the Electron MAIN process can import it; its tests followed
// it here). Assertions unchanged — only the import path moved. Nested under one
// parent describe so the original block titles don't collide with the suites
// above, which cover the same functions from a different angle. This block owns
// the ONLY recallAndPack coverage in the repo.
// ---------------------------------------------------------------------------
describe('ported from apps/desktop/test/unit/recall.test.ts', () => {
  describe('tokenize', () => {
    it('lowercases, splits on non-alphanumerics, drops stopwords + 1-char tokens', () => {
      expect(tokenize('The Cat-Sat on a MAT!')).toEqual(['cat', 'sat', 'mat'])
      expect(tokenize('   ')).toEqual([])
    })
  })

  describe('scoreRecall', () => {
    it('is 0 for an empty query or zero overlap', () => {
      expect(scoreRecall('', 'a cat')).toBe(0)
      expect(scoreRecall('cat', 'dog fish')).toBe(0)
    })

    it('scores present query tokens, normalized by distinct query-token count', () => {
      expect(scoreRecall('cat', 'the cat')).toBeCloseTo(1 + Math.min(0.5, Math.log(2) * 0.2), 5)
    })

    it('rewards a term that recurs in the text (sublinear tf bonus)', () => {
      expect(scoreRecall('cat', 'cat cat cat')).toBeGreaterThan(scoreRecall('cat', 'the cat'))
    })

    it('matching MORE distinct query tokens scores higher (same query)', () => {
      const both = scoreRecall('cat dog', 'a cat and a dog')
      const one  = scoreRecall('cat dog', 'a cat and a bird')
      expect(both).toBeGreaterThan(one)
    })
  })

  describe('recall', () => {
    const items = [
      { text: 'how to run a database migration safely' },
      { text: 'database backup and restore tool' },
      { text: 'totally unrelated cooking recipe' },
    ]

    it('ranks by lexical overlap and drops zero-overlap items', () => {
      const res = recall('database migration', items)
      expect(res).toHaveLength(2) // the recipe is dropped
      expect(res[0].text).toBe('how to run a database migration safely') // both tokens
      // `!`: PackItem.score is optional in the TYPE, but recall() always sets it.
      // (apps/desktop's tsconfig excluded test/, so this never had to typecheck
      // there; core's tsconfig includes its tests.)
      expect(res[0].score).toBeGreaterThan(res[1].score!)
    })

    it('respects topK', () => {
      expect(recall('database', items, { topK: 1 })).toHaveLength(1)
    })

    it('keepZero retains non-matching items (score 0)', () => {
      const res = recall('xyzzy', items, { keepZero: true })
      expect(res).toHaveLength(3)
      expect(res.every(r => r.score === 0)).toBe(true)
    })

    it('applies the per-item boost', () => {
      const boosted = recall('database', [
        { text: 'database one' },
        { text: 'database two', boost: 3 },
      ])
      expect(boosted[0].text).toBe('database two') // boost lifts it above the equal-overlap peer
    })

    it('an empty query recalls nothing (no false matches)', () => {
      expect(recall('', items)).toEqual([])
    })
  })

  describe('recallAndPack', () => {
    it('recalls then budget-packs, keeping the strongest match and the char cap', () => {
      const items = [
        { text: 'how to run a database migration safely with rollback' },
        { text: 'database backup and restore tool' },
        { text: 'totally unrelated cooking recipe' },
      ]
      const res = recallAndPack('database migration', items, { maxTotalChars: 500, targetItems: 5 })
      expect(res.items.length).toBeGreaterThan(0)
      expect(res.items.length).toBeLessThanOrEqual(2) // recipe dropped by recall
      expect(res.totalChars).toBeLessThanOrEqual(500)
      expect(res.items.some(t => t.includes('migration'))).toBe(true)
    })
  })
})
