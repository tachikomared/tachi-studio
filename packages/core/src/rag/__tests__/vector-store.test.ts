import { describe, it, expect } from 'vitest'
import { cosineSimilarity } from '../cosine.js'
import { VectorStore } from '../vector-store.js'
import type { StoredVector, RagChunk } from '../types.js'

const chunk = (id: string, path = 'a.ts'): RagChunk => ({ id, text: id, path, startLine: 1, endLine: 2 })
const sv = (id: string, vector: number[], path?: string): StoredVector => ({ id, vector, chunk: chunk(id, path) })

describe('cosineSimilarity', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })
  it('returns 0 (never NaN/throw) on a zero vector or length mismatch', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    expect(cosineSimilarity([1], [1, 2])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
})

describe('VectorStore.query', () => {
  it('returns the top-k chunks ordered by cosine similarity (desc)', () => {
    const s = new VectorStore()
    s.add([sv('near', [1, 0]), sv('mid', [0.7, 0.7]), sv('far', [0, 1])])
    const out = s.query([1, 0], 2)
    expect(out.map(o => o.chunk.id)).toEqual(['near', 'mid'])
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score)
  })
  it('k larger than the store returns everything; empty store returns []', () => {
    const s = new VectorStore()
    s.add([sv('a', [1, 0])])
    expect(s.query([1, 0], 10)).toHaveLength(1)
    expect(new VectorStore().query([1, 0], 5)).toEqual([])
  })
})

describe('VectorStore.replacePath (incremental re-index of a changed file)', () => {
  it('replaces ONLY the vectors for the given path', () => {
    const s = new VectorStore()
    s.add([sv('a1', [1, 0], 'a.ts'), sv('b1', [0, 1], 'b.ts')])
    s.replacePath('a.ts', [sv('a2', [1, 0], 'a.ts')])
    expect(s.size).toBe(2)
    const ids = s.query([1, 0], 10).map(o => o.chunk.id)
    expect(ids).toContain('a2')
    expect(ids).not.toContain('a1') // old chunks for a.ts are gone
    expect(ids).toContain('b1')     // other files untouched
  })
})

describe('VectorStore serialize/deserialize', () => {
  it('round-trips through JSON preserving query results', () => {
    const s = new VectorStore()
    s.add([sv('a', [1, 0]), sv('b', [0, 1])])
    const r = VectorStore.deserialize(s.serialize())
    expect(r.size).toBe(2)
    expect(r.query([1, 0], 1)[0]!.chunk.id).toBe('a')
  })
  it('deserialize tolerates garbage (returns an empty store, never throws)', () => {
    expect(VectorStore.deserialize('not json').size).toBe(0)
    expect(VectorStore.deserialize('{}').size).toBe(0)
  })
})
