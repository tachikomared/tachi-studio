// packages/core/src/chat/__tests__/reasoning-stream.test.ts
import { describe, it, expect } from 'vitest'
import { extractReasoningDelta, createThinkWrapper } from '../reasoning-stream.js'

const chunk = (delta: Record<string, unknown>) => ({ choices: [{ delta }] })

describe('extractReasoningDelta', () => {
  it('reads DeepSeek reasoning_content', () => {
    expect(extractReasoningDelta(chunk({ reasoning_content: 'hmm' }))).toBe('hmm')
  })
  it('reads OpenRouter reasoning', () => {
    expect(extractReasoningDelta(chunk({ reasoning: 'let me think' }))).toBe('let me think')
  })
  it('returns undefined for content-only / empty / malformed', () => {
    expect(extractReasoningDelta(chunk({ content: 'hi' }))).toBeUndefined()
    expect(extractReasoningDelta(chunk({ reasoning_content: '' }))).toBeUndefined()
    expect(extractReasoningDelta({})).toBeUndefined()
    expect(extractReasoningDelta(null)).toBeUndefined()
  })
})

describe('createThinkWrapper', () => {
  it('wraps a reasoning-then-content stream in a balanced <think> block', () => {
    const w = createThinkWrapper()
    let out = ''
    out += w.next('The user ', undefined)   // reasoning fragment 1
    out += w.next('wants X.', undefined)     // reasoning fragment 2
    out += w.next(undefined, 'Answer: X')    // first content → closes think
    out += w.next(undefined, ' done.')       // more content
    out += w.flush()
    expect(out).toBe('<think>The user wants X.</think>Answer: X done.')
    expect(w.isOpen()).toBe(false)
  })

  it('opens on first reasoning and stays open until content', () => {
    const w = createThinkWrapper()
    expect(w.next('a', undefined)).toBe('<think>a')
    expect(w.isOpen()).toBe(true)
    expect(w.next('b', undefined)).toBe('b')            // no re-open
    expect(w.next(undefined, 'c')).toBe('</think>c')    // close + content
    expect(w.isOpen()).toBe(false)
  })

  it('flush closes a stream that ended mid-reasoning', () => {
    const w = createThinkWrapper()
    expect(w.next('thinking…', undefined)).toBe('<think>thinking…')
    expect(w.flush()).toBe('</think>')
    expect(w.flush()).toBe('')                           // idempotent
  })

  it('passes plain content through untouched (non-reasoning models)', () => {
    const w = createThinkWrapper()
    expect(w.next(undefined, 'hello')).toBe('hello')
    expect(w.next(undefined, ' world')).toBe(' world')
    expect(w.flush()).toBe('')
    expect(w.isOpen()).toBe(false)
  })

  it('handles a chunk carrying BOTH reasoning and content (transition frame)', () => {
    const w = createThinkWrapper()
    expect(w.next('last thought', 'first answer')).toBe('<think>last thought</think>first answer')
  })
})
