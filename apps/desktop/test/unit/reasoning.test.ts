// apps/desktop/test/unit/reasoning.test.ts
import { describe, it, expect } from 'vitest'
import { parseReasoning, hasReasoning } from '../../src/pages/chat/reasoning'

describe('parseReasoning', () => {
  it('returns [] for empty and a single text segment when there are no tags', () => {
    expect(parseReasoning('')).toEqual([])
    expect(parseReasoning('just an answer')).toEqual([{ kind: 'text', text: 'just an answer' }])
  })

  it('splits a balanced <think> block from the answer', () => {
    expect(parseReasoning('<think>chain of thought</think>the answer')).toEqual([
      { kind: 'reasoning', text: 'chain of thought', open: false },
      { kind: 'text', text: 'the answer' },
    ])
  })

  it('keeps leading and trailing text around a block', () => {
    expect(parseReasoning('before<think>cot</think>after')).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'reasoning', text: 'cot', open: false },
      { kind: 'text', text: 'after' },
    ])
  })

  it('flags an unclosed (streaming) block as open and absorbs the tail', () => {
    expect(parseReasoning('<think>still thinking')).toEqual([
      { kind: 'reasoning', text: 'still thinking', open: true },
    ])
    expect(parseReasoning('partial<think>thinking more')).toEqual([
      { kind: 'text', text: 'partial' },
      { kind: 'reasoning', text: 'thinking more', open: true },
    ])
  })

  it('is case-insensitive and supports <thought> / <reasoning>', () => {
    expect(parseReasoning('<THINK>x</THINK>a')[0]).toEqual({ kind: 'reasoning', text: 'x', open: false })
    expect(parseReasoning('<thought>y</thought>a')[0]).toMatchObject({ kind: 'reasoning', text: 'y' })
    expect(parseReasoning('<reasoning>z</reasoning>a')[0]).toMatchObject({ kind: 'reasoning', text: 'z' })
  })

  it('treats nested same-kind tags as part of the outer block', () => {
    const segs = parseReasoning('<think>outer<think>inner</think>more</think>answer')
    expect(segs).toHaveLength(2)
    expect(segs[0].kind).toBe('reasoning')
    expect((segs[0] as { open: boolean }).open).toBe(false)
    expect(segs[0].text).toContain('outer')
    expect(segs[0].text).toContain('inner')
    expect(segs[0].text).toContain('more')
    expect(segs[1]).toEqual({ kind: 'text', text: 'answer' })
  })

  it('drops a whitespace-only closed reasoning block', () => {
    expect(parseReasoning('<think>   </think>answer')).toEqual([{ kind: 'text', text: 'answer' }])
  })
})

describe('hasReasoning', () => {
  it('detects an opening reasoning tag, ignores plain text', () => {
    expect(hasReasoning('<think>x</think>')).toBe(true)
    expect(hasReasoning('<think>')).toBe(true)
    expect(hasReasoning('no tags here')).toBe(false)
  })
})
