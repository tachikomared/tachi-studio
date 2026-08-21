// packages/core/src/tachi/loop/__tests__/stall.test.ts
import { describe, it, expect } from 'vitest'
import { fingerprint, detectStall } from '../stall.js'

describe('fingerprint', () => {
  it('is stable across calls for the same input', () => {
    const a = fingerprint('read', { path: '/foo', limit: 10 })
    const b = fingerprint('read', { path: '/foo', limit: 10 })
    expect(a).toBe(b)
    expect(typeof a).toBe('string')
    expect(a.length).toBeGreaterThan(0)
  })

  it('is independent of top-level key order ({a:1,b:2} === {b:2,a:1})', () => {
    expect(fingerprint('tool', { a: 1, b: 2 })).toBe(fingerprint('tool', { b: 2, a: 1 }))
  })

  it('is independent of nested object key order', () => {
    const x = fingerprint('edit', { file: 'x', opts: { deep: { p: 1, q: 2 }, flag: true } })
    const y = fingerprint('edit', { opts: { flag: true, deep: { q: 2, p: 1 } }, file: 'x' })
    expect(x).toBe(y)
  })

  it('differs when the tool name differs but args match', () => {
    expect(fingerprint('read', { path: '/a' })).not.toBe(fingerprint('write', { path: '/a' }))
  })

  it('differs when args differ', () => {
    expect(fingerprint('read', { path: '/a' })).not.toBe(fingerprint('read', { path: '/b' }))
  })

  it('differs for nested value changes', () => {
    expect(fingerprint('edit', { opts: { n: 1 } })).not.toBe(fingerprint('edit', { opts: { n: 2 } }))
  })

  it('preserves array element order (order is significant in arrays)', () => {
    expect(fingerprint('grep', { paths: ['a', 'b'] })).not.toBe(fingerprint('grep', { paths: ['b', 'a'] }))
  })

  it('distinguishes value types: number 1 vs string "1"', () => {
    expect(fingerprint('t', { v: 1 })).not.toBe(fingerprint('t', { v: '1' }))
  })

  it('distinguishes null, undefined-ish, and missing keys sensibly', () => {
    // null present vs key absent should not collide
    expect(fingerprint('t', { v: null })).not.toBe(fingerprint('t', {}))
  })

  it('handles empty args object', () => {
    const a = fingerprint('read', {})
    const b = fingerprint('read', {})
    expect(a).toBe(b)
    expect(typeof a).toBe('string')
  })
})

describe('detectStall', () => {
  it('empty array -> not stalled, repeats 0', () => {
    const v = detectStall([])
    expect(v.stalled).toBe(false)
    expect(v.repeats).toBe(0)
  })

  it('three identical tail with default threshold -> stalled, repeats 3', () => {
    const v = detectStall(['x', 'x', 'x'])
    expect(v.stalled).toBe(true)
    expect(v.repeats).toBe(3)
  })

  it('two identical with default threshold (3) -> not stalled', () => {
    const v = detectStall(['x', 'x'])
    expect(v.stalled).toBe(false)
    expect(v.repeats).toBe(2)
  })

  it('A,A,B,B,B with threshold 3 -> stalled, repeats 3', () => {
    const v = detectStall(['A', 'A', 'B', 'B', 'B'], 3)
    expect(v.stalled).toBe(true)
    expect(v.repeats).toBe(3)
  })

  it('A,A,B,B,B counts only the contiguous tail run (repeats 3, not 5)', () => {
    const v = detectStall(['A', 'A', 'B', 'B', 'B'], 3)
    expect(v.repeats).toBe(3)
  })

  it('threshold override of 2: two identical tail -> stalled', () => {
    const v = detectStall(['a', 'b', 'b'], 2)
    expect(v.stalled).toBe(true)
    expect(v.repeats).toBe(2)
  })

  it('threshold override of 2: single trailing element -> not stalled, repeats 1', () => {
    const v = detectStall(['a', 'b'], 2)
    expect(v.stalled).toBe(false)
    expect(v.repeats).toBe(1)
  })

  it('single element -> repeats 1, not stalled with default threshold', () => {
    const v = detectStall(['only'])
    expect(v.stalled).toBe(false)
    expect(v.repeats).toBe(1)
  })

  it('tail differs from the rest -> repeats 1', () => {
    const v = detectStall(['x', 'x', 'x', 'y'])
    expect(v.stalled).toBe(false)
    expect(v.repeats).toBe(1)
  })

  it('more than threshold identical at tail -> stalled, repeats = full run length', () => {
    const v = detectStall(['z', 'z', 'z', 'z', 'z'], 3)
    expect(v.stalled).toBe(true)
    expect(v.repeats).toBe(5)
  })

  it('mixed history with long identical tail beyond threshold', () => {
    const v = detectStall(['a', 'b', 'c', 'c', 'c', 'c'], 3)
    expect(v.stalled).toBe(true)
    expect(v.repeats).toBe(4)
  })

  it('integrates with fingerprint: identical repeated calls stall', () => {
    const fp = fingerprint('read', { path: '/loop' })
    const v = detectStall([fp, fp, fp])
    expect(v.stalled).toBe(true)
    expect(v.repeats).toBe(3)
  })

  it('integrates with fingerprint: key-order-different but equal calls stall', () => {
    const seq = [
      fingerprint('edit', { a: 1, b: 2 }),
      fingerprint('edit', { b: 2, a: 1 }),
      fingerprint('edit', { a: 1, b: 2 }),
    ]
    const v = detectStall(seq)
    expect(v.stalled).toBe(true)
    expect(v.repeats).toBe(3)
  })

  it('threshold of 1 -> any non-empty tail is "stalled"', () => {
    const v = detectStall(['a', 'b', 'c'], 1)
    expect(v.stalled).toBe(true)
    expect(v.repeats).toBe(1)
  })

  it('repeats never exceeds array length', () => {
    const v = detectStall(['q', 'q'], 5)
    expect(v.repeats).toBe(2)
    expect(v.stalled).toBe(false)
  })
})
