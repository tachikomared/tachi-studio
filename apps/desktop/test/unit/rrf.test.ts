// apps/desktop/test/unit/rrf.test.ts
//
// Reciprocal-Rank-Fusion + BM25-lite lexical ranking (ported from
// code-review-graph search.py rrf_merge: 1/(k+rank+1) summation, k=60).
// Pure, no IO. Covers fusion math (high-in-both wins, k damping), bm25Lite
// term-frequency / doc-length ranking, and a conversations_search-shaped
// fusion case (substring list fused with a bm25 list, no hit dropped).
import { describe, it, expect } from 'vitest'
import { rrfMerge, bm25Lite } from '../../electron/services/util/rrf'

describe('rrfMerge', () => {
  it('returns [] for no lists / all-empty lists', () => {
    expect(rrfMerge([])).toEqual([])
    expect(rrfMerge([[], []])).toEqual([])
  })

  it('passes a single list through in order', () => {
    expect(rrfMerge([['a', 'b', 'c']])).toEqual(['a', 'b', 'c'])
  })

  it('ranks an item that is high in BOTH lists above items high in only one', () => {
    // 'x' is rank 0 in list A and rank 0 in list B -> wins.
    const a = ['x', 'a', 'b']
    const b = ['x', 'c', 'd']
    const fused = rrfMerge([a, b])
    expect(fused[0]).toBe('x')
    // every input id is preserved
    expect(new Set(fused)).toEqual(new Set(['x', 'a', 'b', 'c', 'd']))
  })

  it('a consistently 2nd-place item beats one that is 1st in a single list only', () => {
    // 'y' is 2nd in both lists; 'z' is 1st in A but absent from B.
    // RRF(y) = 1/(60+1+1)*2 = 2/62 ≈ 0.03226
    // RRF(z) = 1/(60+0+1)   = 1/61 ≈ 0.01639
    const a = ['z', 'y', 'p']
    const b = ['q', 'y', 'r']
    const fused = rrfMerge([a, b])
    expect(fused.indexOf('y')).toBeLessThan(fused.indexOf('z'))
  })

  it('larger k flattens rank differences (damping)', () => {
    // With huge k the 1/(k+rank+1) terms converge; an item present in both
    // lists still beats a single-list item regardless of its exact rank.
    const a = ['m', 'n']
    const b = ['n', 'm']
    const fused = rrfMerge([a, b], 1000)
    expect(new Set(fused)).toEqual(new Set(['m', 'n']))
  })

  it('dedups an id that repeats within a single list (first position counts)', () => {
    const fused = rrfMerge([['a', 'a', 'b']])
    expect(fused).toEqual(['a', 'b'])
  })

  it('is a stable, deterministic order for ties', () => {
    // Symmetric input: 'a' before 'b' both times -> 'a' keeps the edge.
    const fused = rrfMerge([['a', 'b'], ['a', 'b']])
    expect(fused).toEqual(['a', 'b'])
  })
})

describe('bm25Lite', () => {
  it('returns [] for empty query or empty docs', () => {
    expect(bm25Lite('', [{ id: '1', text: 'hello world' }])).toEqual([])
    expect(bm25Lite('hello', [])).toEqual([])
    expect(bm25Lite('   ', [{ id: '1', text: 'hello' }])).toEqual([])
  })

  it('ranks an exact-term doc above one that only partially matches', () => {
    const docs = [
      { id: 'partial', text: 'the cat sat on a mat in the morning sunshine quietly' },
      { id: 'exact', text: 'database migration database migration' },
    ]
    const ranked = bm25Lite('database migration', docs)
    expect(ranked[0]).toBe('exact')
  })

  it('does not return docs with zero query-term overlap', () => {
    const docs = [
      { id: 'hit', text: 'kubernetes deployment rollout' },
      { id: 'miss', text: 'completely unrelated prose about gardening' },
    ]
    const ranked = bm25Lite('kubernetes', docs)
    expect(ranked).toEqual(['hit'])
  })

  it('length-normalizes: a short doc with the term beats a long doc that buries it', () => {
    const short = { id: 'short', text: 'oauth' }
    const long = {
      id: 'long',
      text: 'oauth ' + 'lorem ipsum dolor sit amet consectetur '.repeat(20),
    }
    const ranked = bm25Lite('oauth', [long, short])
    expect(ranked[0]).toBe('short')
  })

  it('tokenizes case-insensitively', () => {
    const ranked = bm25Lite('OAuth', [{ id: 'd', text: 'oauth oauth' }])
    expect(ranked).toEqual(['d'])
  })
})

describe('conversations_search-shaped fusion', () => {
  it('fuses a substring-ranked list with a bm25 list without dropping a substring hit', () => {
    // Docs that all contain the substring "deploy" somewhere.
    const docs = [
      { id: 'c1', text: 'we should deploy the service tonight' },
      { id: 'c2', text: 'deploy deploy deploy the rollout plan deploy' },
      { id: 'c3', text: 'a long unrelated ramble that happens to deploy once near the very end ' + 'x '.repeat(40) },
    ]
    // (A) substring order = discovery order (unranked): c1, c2, c3
    const substringIds = docs.map(d => d.id)
    // (B) bm25 order over the same text -> [c2, c1, c3] (c2 densest, c3 length-penalized)
    const bm25Ids = bm25Lite('deploy', docs)
    expect(bm25Ids).toEqual(['c2', 'c1', 'c3'])

    const fused = rrfMerge([substringIds, bm25Ids])

    // c2 (rank-0 in bm25) is fused to the top tier; the long, sparse c3 sinks to
    // last. (c1 and c2 hold symmetric reciprocal ranks, so c2 is at worst tied
    // for first — bm25 lifts it out of pure discovery order.)
    expect(fused.slice(0, 2)).toEqual(expect.arrayContaining(['c2']))
    expect(fused[fused.length - 1]).toBe('c3')
    // No substring hit is dropped — RRF only re-orders.
    expect(new Set(fused)).toEqual(new Set(['c1', 'c2', 'c3']))
  })
})
