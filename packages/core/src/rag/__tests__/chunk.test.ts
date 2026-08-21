import { describe, it, expect } from 'vitest'
import { chunkText } from '../chunk.js'

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    const c = chunkText('line1\nline2', 'a.ts', { maxLines: 10, overlap: 2 })
    expect(c).toHaveLength(1)
    expect(c[0]!.path).toBe('a.ts')
    expect(c[0]!.startLine).toBe(1)
    expect(c[0]!.endLine).toBe(2)
    expect(c[0]!.text).toBe('line1\nline2')
  })

  it('splits long text into overlapping line windows', () => {
    const text = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n')
    const c = chunkText(text, 'a.ts', { maxLines: 4, overlap: 1 })
    // stride = maxLines - overlap = 3 → windows start at 1, 4, 7
    expect(c.length).toBeGreaterThanOrEqual(3)
    expect(c[0]!.startLine).toBe(1)
    expect(c[0]!.endLine).toBe(4)
    expect(c[1]!.startLine).toBe(4) // overlaps the previous window's last line
  })

  it('gives each chunk a stable, unique id of path:startLine', () => {
    const text = Array.from({ length: 8 }, (_, i) => `L${i + 1}`).join('\n')
    const c = chunkText(text, 'src/x.ts', { maxLines: 4, overlap: 1 })
    expect(c[0]!.id).toBe('src/x.ts:1')
    const ids = c.map(x => x.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('skips blank / whitespace-only windows', () => {
    expect(chunkText('   \n  \n', 'a.ts')).toEqual([])
  })

  it('never loops forever on degenerate options (overlap >= maxLines)', () => {
    const text = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n')
    const c = chunkText(text, 'a.ts', { maxLines: 3, overlap: 9 })
    expect(c.length).toBeGreaterThan(0)
    expect(c.length).toBeLessThanOrEqual(20)
  })
})
