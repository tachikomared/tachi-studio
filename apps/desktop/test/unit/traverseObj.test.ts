// apps/desktop/test/unit/traverseObj.test.ts
import { describe, it, expect } from 'vitest'
import { traverseObj } from '../../electron/services/util/traverse-obj'

describe('traverseObj', () => {
  it('resolves a dot-path with numeric (array-index) segments', () => {
    const res = { choices: [{ message: { content: 'hi' } }] }
    expect(traverseObj(res, 'choices.0.message.content')).toBe('hi')
  })

  it('returns undefined for a missing path (no default)', () => {
    expect(traverseObj({ a: { b: 1 } }, 'a.x.y')).toBeUndefined()
  })

  it('is null/undefined safe at the root and mid-path', () => {
    expect(traverseObj(null, 'a.b')).toBeUndefined()
    expect(traverseObj(undefined, 'a')).toBeUndefined()
    expect(traverseObj({ a: null }, 'a.b')).toBeUndefined()
  })

  it('tries multiple paths and returns the first non-null match', () => {
    const res = { text: 'fallback-text' }
    expect(
      traverseObj(res, ['choices.0.delta.content', 'choices.0.delta.text', 'text'], {
        expectedType: 'string',
      }),
    ).toBe('fallback-text')
  })

  it('enforces expectedType and falls back to default on mismatch', () => {
    expect(traverseObj({ n: 5 }, 'n', { expectedType: 'string' })).toBeUndefined()
    expect(traverseObj({ n: 5 }, 'n', { expectedType: 'string', default: 'x' })).toBe('x')
    expect(traverseObj({ n: 5 }, 'n', { expectedType: 'number' })).toBe(5)
  })

  it('matches arrays only under expectedType "array"', () => {
    expect(traverseObj({ models: [1, 2] }, 'models', { expectedType: 'array' })).toEqual([1, 2])
    // an array is NOT an "object"
    expect(traverseObj({ models: [1, 2] }, 'models', { expectedType: 'object' })).toBeUndefined()
  })

  it('collects wildcard values and continues traversal, flattening one level', () => {
    expect(traverseObj({ a: { x: 1 }, b: { x: 2 } }, '*.x')).toEqual([1, 2])
    expect(traverseObj({ a: 1, b: 2 }, '*')).toEqual([1, 2])
  })

  it('skipEmpty skips empty strings/arrays in favour of the next path', () => {
    expect(traverseObj({ a: '', b: 'x' }, ['a', 'b'], { skipEmpty: true })).toBe('x')
    // without skipEmpty the empty string is a valid match
    expect(traverseObj({ a: '', b: 'x' }, ['a', 'b'])).toBe('')
  })

  it('treats "" / "." as the identity path (returns the root)', () => {
    const root = { a: 1 }
    expect(traverseObj(root, '')).toBe(root)
    expect(traverseObj(root, '.')).toBe(root)
  })
})
