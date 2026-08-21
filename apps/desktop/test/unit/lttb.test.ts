// apps/desktop/test/unit/lttb.test.ts
import { describe, it, expect } from 'vitest'
import { lttb } from '../../src/utils/lttb'

describe('lttb (number[] form)', () => {
  it('passes input through unchanged when targetCount >= length', () => {
    const data = [1, 2, 3, 4, 5]
    expect(lttb(data, 5)).toEqual(data)
    expect(lttb(data, 99)).toEqual(data)
  })

  it('passes input through unchanged when targetCount < 3 (Go: targetPoints < 3)', () => {
    const data = [1, 2, 3, 4, 5, 6]
    expect(lttb(data, 2)).toEqual(data)
    expect(lttb(data, 0)).toEqual(data)
  })

  it('always keeps the first and last point', () => {
    const data = Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) * 10 + i)
    const out = lttb(data, 10)
    expect(out.length).toBe(10)
    expect(out[0]).toBe(data[0])
    expect(out[out.length - 1]).toBe(data[data.length - 1])
  })

  it('preserves a sharp peak that flat-uniform sampling would miss', () => {
    // Flat baseline with a single tall spike. LTTB selects the spike because it
    // maximises triangle area, where naive every-Nth sampling would skip it.
    const data = new Array(200).fill(1)
    data[97] = 1000 // a spike off the uniform grid
    const out = lttb(data, 12)
    expect(Math.max(...out)).toBe(1000)
    // endpoints intact
    expect(out[0]).toBe(1)
    expect(out[out.length - 1]).toBe(1)
  })

  it('returns exactly targetCount points for the down-sampled case', () => {
    const data = Array.from({ length: 500 }, (_, i) => i % 7)
    expect(lttb(data, 50).length).toBe(50)
    expect(lttb(data, 3).length).toBe(3)
  })

  it('handles degenerate tiny inputs', () => {
    expect(lttb([], 10)).toEqual([])
    expect(lttb([42], 10)).toEqual([42])
    expect(lttb([1, 2], 10)).toEqual([1, 2])
    // target<3 with len 3 -> passthrough
    expect(lttb([1, 2, 3], 2)).toEqual([1, 2, 3])
  })
})

describe('lttb ({x,y}[] form)', () => {
  it('returns the same shape (objects) and preserves endpoints', () => {
    const data = Array.from({ length: 100 }, (_, i) => ({ x: i, y: Math.cos(i / 4) * 5 }))
    const out = lttb(data, 10)
    expect(out.length).toBe(10)
    expect(out[0]).toEqual(data[0])
    expect(out[out.length - 1]).toEqual(data[data.length - 1])
    // every emitted point must be one of the originals (LTTB never invents points)
    for (const p of out) {
      expect(data).toContainEqual(p)
    }
  })

  it('passes through {x,y}[] unchanged when targetCount >= length', () => {
    const data = [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }]
    expect(lttb(data, 3)).toEqual(data)
  })

  it('preserves the {x,y} peak on a spike', () => {
    const data = Array.from({ length: 150 }, (_, i) => ({ x: i, y: 0 }))
    data[71] = { x: 71, y: 999 }
    const out = lttb(data, 10)
    expect(Math.max(...out.map(p => p.y))).toBe(999)
  })
})
