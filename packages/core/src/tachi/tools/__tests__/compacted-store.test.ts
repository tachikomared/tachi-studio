// packages/core/src/tachi/tools/__tests__/compacted-store.test.ts
//
// CCR — reversible compaction (steal: headroomlabs/headroom, STEAL §10). When a
// tool output is elided, the FULL original is kept in a bounded session store so
// the agent can expand it on demand instead of re-running. Pure + dependency-free.

import { describe, it, expect } from 'vitest'
import { CompactedStore, readCompactedSlice, compactionReceipt, queryCompacted, unknownCompactedId } from '../compacted-store.js'

describe('CompactedStore', () => {
  it('saves text under a fresh id and reads it back', () => {
    const s = new CompactedStore()
    const id = s.save('the full output')
    expect(typeof id).toBe('string')
    expect(s.get(id)).toBe('the full output')
  })

  it('issues distinct ids for distinct saves', () => {
    const s = new CompactedStore()
    expect(s.save('a')).not.toBe(s.save('b'))
  })

  it('evicts the oldest entries past maxEntries (bounded memory)', () => {
    const s = new CompactedStore(2)
    const a = s.save('a'); const b = s.save('b'); const c = s.save('c')
    expect(s.get(a)).toBeUndefined() // evicted
    expect(s.get(b)).toBe('b')
    expect(s.get(c)).toBe('c')
    expect(s.size()).toBe(2)
  })

  it('evicts to stay under the byte budget', () => {
    const s = new CompactedStore(100, 10) // 10-byte budget
    const a = s.save('12345')
    const b = s.save('67890')
    s.save('XYZ') // pushes total over 10 → oldest dropped
    expect(s.get(a)).toBeUndefined()
    expect(s.get(b)).toBe('67890')
  })

  it('returns undefined for an unknown id', () => {
    expect(new CompactedStore().get('nope')).toBeUndefined()
  })
})

describe('readCompactedSlice', () => {
  it('returns the whole text (no header) when it fits in the limit', () => {
    expect(readCompactedSlice('hello', 0, 100)).toBe('hello')
  })

  it('returns a slice with a continuation header when more remains', () => {
    const out = readCompactedSlice('hello world', 0, 5)
    expect(out).toContain('hello')
    expect(out).not.toContain('world')
    expect(out).toMatch(/offset=5/) // tells the agent how to get the rest
  })

  it('honours offset', () => {
    expect(readCompactedSlice('0123456789', 5, 100)).toContain('56789')
  })
})

describe('queryCompacted', () => {
  // A store pre-loaded with 10 numbered lines: "line 1" … "line 10".
  const seeded = () => {
    const s = new CompactedStore()
    const id = s.save(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
    return { s, id }
  }

  it('unknown id → the exact not-found text the paged reader uses', () => {
    const s = new CompactedStore()
    expect(queryCompacted(s, 'nope')).toBe(unknownCompactedId('nope'))
    expect(queryCompacted(s, 'nope')).toMatch(/No stored output for id "nope"/)
  })

  it('mode "full" (and the default) matches readCompactedSlice paging', () => {
    const s = new CompactedStore()
    const id = s.save('hello world')
    expect(queryCompacted(s, id, { mode: 'full', offset: 0, limit: 5 })).toBe(readCompactedSlice('hello world', 0, 5))
    expect(queryCompacted(s, id)).toBe('hello world') // default = full, whole text fits
  })

  it('head returns the first N lines with a range header', () => {
    const { s, id } = seeded()
    const out = queryCompacted(s, id, { mode: 'head', limit: 3 })
    expect(out).toContain('[lines 1–3 of 10')
    expect(out).toContain('line 1')
    expect(out).toContain('line 3')
    expect(out).not.toContain('line 4')
  })

  it('head defaults to 40 lines and clamps to the text', () => {
    const { s, id } = seeded() // only 10 lines
    const out = queryCompacted(s, id, { mode: 'head' })
    expect(out).toContain('[lines 1–10 of 10]')
    expect(out).toContain('line 10')
  })

  it('tail returns the last N lines', () => {
    const { s, id } = seeded()
    const out = queryCompacted(s, id, { mode: 'tail', limit: 2 })
    expect(out).toContain('[lines 9–10 of 10]')
    expect(out).toContain('line 9')
    expect(out).not.toContain('line 8')
  })

  it('lines returns a 1-indexed inclusive range', () => {
    const { s, id } = seeded()
    const out = queryCompacted(s, id, { mode: 'lines', start: 4, end: 6 })
    expect(out).toContain('[lines 4–6 of 10')
    expect(out).toContain('line 4')
    expect(out).toContain('line 6')
    expect(out).not.toContain('line 7')
  })

  it('lines clamps out-of-range bounds instead of erroring', () => {
    const { s, id } = seeded()
    expect(queryCompacted(s, id, { mode: 'lines', start: -5, end: 999 })).toContain('[lines 1–10 of 10]')
    expect(queryCompacted(s, id, { mode: 'lines', start: 999 })).toContain('[lines 10–10 of 10]')
    expect(queryCompacted(s, id, { mode: 'lines', start: 5, end: 2 })).toContain('[lines 5–5 of 10') // end < start → single line
  })

  it('grep matches literally and case-insensitively, tagging line numbers', () => {
    const s = new CompactedStore()
    const id = s.save('alpha\nERROR: boom\ngamma')
    const out = queryCompacted(s, id, { mode: 'grep', pattern: 'error' })
    expect(out).toContain('2: ERROR: boom')
    expect(out).toContain('1- alpha') // 1 line of context each side
    expect(out).toContain('3- gamma')
  })

  it('grep caps output at maxMatches (default 100) and says so', () => {
    const s = new CompactedStore()
    const id = s.save(Array.from({ length: 150 }, () => 'hit').join('\n'))
    const capped = queryCompacted(s, id, { mode: 'grep', pattern: 'hit', maxMatches: 5 })
    expect(capped).toContain('[5 matching line(s)')
    expect(capped).toContain('stopped at 5 matches')
    const def = queryCompacted(s, id, { mode: 'grep', pattern: 'hit' })
    expect(def).toContain('stopped at 100 matches')
  })

  it('grep treats a non-compiling pattern as a literal substring', () => {
    const s = new CompactedStore()
    const id = s.save('x\nprice is $(1.99) today\ny')
    const out = queryCompacted(s, id, { mode: 'grep', pattern: '$(1.99' }) // invalid regex
    expect(out).toContain('2: price is $(1.99) today')
  })

  it('grep uses regex semantics when the pattern compiles', () => {
    const s = new CompactedStore()
    const id = s.save('foo123\nbar\nfoo999')
    const out = queryCompacted(s, id, { mode: 'grep', pattern: 'foo\\d+' })
    expect(out).toContain('1: foo123')
    expect(out).toContain('3: foo999')
    expect(out).not.toContain(': bar')
  })

  it('grep falls back to literal for over-long (>200 char) patterns', () => {
    const long = 'a'.repeat(201)
    const s = new CompactedStore()
    const id = s.save(`x\n${long}\ny`)
    expect(queryCompacted(s, id, { mode: 'grep', pattern: long })).toContain(`2: ${long}`)
  })

  it('grep reports zero matches without dumping the text', () => {
    const { s, id } = seeded()
    const out = queryCompacted(s, id, { mode: 'grep', pattern: 'zzz-not-there' })
    expect(out).toContain('no matches')
    expect(out).not.toContain('line 1')
  })

  it('grep with no pattern is a friendly nudge, not a crash', () => {
    const { s, id } = seeded()
    expect(queryCompacted(s, id, { mode: 'grep' })).toContain('requires a non-empty pattern')
  })

  it('stats emits one summary line without the block itself', () => {
    const s = new CompactedStore()
    const id = s.save('ab\ncd\né') // 3 lines, 7 chars, é = 2 bytes → 8 bytes
    expect(queryCompacted(s, id, { mode: 'stats' })).toBe('{lines: 3, chars: 7, bytes~: 8}')
  })
})

describe('compactionReceipt', () => {
  it('embeds the id in an expand_compacted call the model can copy', () => {
    const r = compactionReceipt('c7', 1000, 200)
    expect(r).toContain('800') // 1000 - 200 elided
    expect(r).toMatch(/expand_compacted\(\{ id: "c7" \}\)/)
  })

  it('carries the authoritative do-not-re-run contract (tokenjuice footer)', () => {
    const r = compactionReceipt('c7', 1000, 200)
    expect(r).toMatch(/authoritative/i)
    expect(r).toMatch(/do NOT re-run/i)
    expect(r).toMatch(/high-signal/i)
  })
})

describe('elisionNotice', () => {
  it('states the contract without naming a recovery tool (no store to expand)', async () => {
    const { elisionNotice } = await import('../compacted-store.js')
    const n = elisionNotice(1000, 200)
    expect(n).toContain('800')
    expect(n).toMatch(/do NOT re-run/i)
    expect(n).not.toContain('expand_compacted')
  })
})
