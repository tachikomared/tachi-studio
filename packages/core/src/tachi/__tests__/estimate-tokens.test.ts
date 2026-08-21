// packages/core/src/tachi/__tests__/estimate-tokens.test.ts
import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessageTokens } from '../estimate-tokens.js'
import type { EstimableMessage } from '../contract.js'

describe('estimateTokens', () => {
  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('weighs pure ASCII at ~0.25 tok/char (rounded up)', () => {
    // 4 ASCII chars * 0.25 = 1.0 -> 1
    expect(estimateTokens('abcd')).toBe(1)
    // 8 ASCII chars * 0.25 = 2.0 -> 2
    expect(estimateTokens('abcdefgh')).toBe(2)
    // 100 ASCII chars * 0.25 = 25
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  it('rounds up partial tokens', () => {
    // 1 ASCII char * 0.25 = 0.25 -> ceil -> 1
    expect(estimateTokens('a')).toBe(1)
    // 5 ASCII chars * 0.25 = 1.25 -> ceil -> 2
    expect(estimateTokens('hello')).toBe(2)
  })

  it('weighs a CJK string heavier than the same-length ASCII string', () => {
    const cjk = '你好世界私'   // 5 CJK code points
    const ascii = 'abcde'      // 5 ASCII chars
    expect([...cjk].length).toBe(5)
    expect([...ascii].length).toBe(5)
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens(ascii))
    // 5 CJK * 1.5 = 7.5 -> ceil -> 8
    expect(estimateTokens(cjk)).toBe(8)
  })

  it('weighs each CJK code point at ~1.5', () => {
    // 2 CJK * 1.5 = 3.0 -> 3
    expect(estimateTokens('你好')).toBe(3)
    // Hiragana / Katakana / Hangul also count as CJK
    expect(estimateTokens('あ')).toBe(2)   // 1 * 1.5 = 1.5 -> 2
    expect(estimateTokens('한')).toBe(2)   // 1 * 1.5 = 1.5 -> 2
  })

  it('weighs an emoji / surrogate-pair code point at ~2', () => {
    // A single emoji (one code point, two UTF-16 units) -> ~2
    expect(estimateTokens('😀')).toBe(2)
    // Two emoji -> 2 * 2 = 4
    expect(estimateTokens('😀🎉')).toBe(4)
  })

  it('does not undercount emoji by treating them as their UTF-16 length', () => {
    const emoji = '😀'
    // String.length is 2 (surrogate pair); a naive length*0.25 would give 1.
    expect(emoji.length).toBe(2)
    expect(estimateTokens(emoji)).toBe(2)
  })

  it('weighs other (non-ASCII, non-CJK, non-surrogate) chars at ~0.5', () => {
    // Latin-1 supplement / accented chars: 4 * 0.5 = 2.0 -> 2
    expect(estimateTokens('éàçü')).toBe(2)
    // Cyrillic: 2 * 0.5 = 1.0 -> 1
    expect(estimateTokens('да')).toBe(1)
  })

  it('handles a mixed string by summing per-codepoint weights', () => {
    // 'ab' (2*0.25=0.5) + '你' (1.5) + '😀' (2) + 'é' (0.5) = 4.5 -> ceil -> 5
    expect(estimateTokens('ab你😀é')).toBe(5)
  })

  it('is deterministic — same input yields the same output', () => {
    const s = 'The quick brown 狐 jumps 🦊 over éé'
    const a = estimateTokens(s)
    const b = estimateTokens(s)
    const c = estimateTokens(s)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

describe('estimateMessageTokens', () => {
  it('returns 0 for an empty message list', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })

  it('adds a per-message overhead so a trivial message is non-zero', () => {
    const msgs: EstimableMessage[] = [{ role: 'user', content: '' }]
    // Even an empty-content message serializes to JSON with role/keys + overhead.
    expect(estimateMessageTokens(msgs)).toBeGreaterThan(0)
  })

  it('counts serialized structure, not just visible text', () => {
    // A message whose content is a tool_use block with args estimates HIGHER
    // than a plain-text message containing only the visible text fragment.
    const visibleText = 'edit'
    const toolHeavy: EstimableMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01ABCDEFGHIJKLMNOP',
            name: 'edit',
            input: {
              file_path: '/repo/packages/core/src/tachi/estimate-tokens.ts',
              old_string: 'const a = 1',
              new_string: 'const a = 2',
            },
          },
        ],
      },
    ]
    const textOnly: EstimableMessage[] = [{ role: 'assistant', content: visibleText }]
    expect(estimateMessageTokens(toolHeavy)).toBeGreaterThan(estimateMessageTokens(textOnly))
  })

  it('sums across multiple messages', () => {
    const one: EstimableMessage[] = [{ role: 'user', content: 'hello world' }]
    const two: EstimableMessage[] = [
      { role: 'user', content: 'hello world' },
      { role: 'user', content: 'hello world' },
    ]
    const single = estimateMessageTokens(one)
    const pair = estimateMessageTokens(two)
    // Two BYTE-IDENTICAL messages should be exactly double a single one
    // (per-message overhead is paid once each, serialization is identical).
    expect(pair).toBeGreaterThan(single)
    expect(pair).toBe(single * 2)
  })

  it('reflects role/wrapper bytes — a longer role name costs slightly more', () => {
    // The serializer counts the role string too, so an "assistant" message
    // estimates at least as high as the same-content "user" message.
    const user: EstimableMessage[] = [{ role: 'user', content: 'hello world' }]
    const assistant: EstimableMessage[] = [{ role: 'assistant', content: 'hello world' }]
    expect(estimateMessageTokens(assistant)).toBeGreaterThanOrEqual(estimateMessageTokens(user))
  })

  it('counts CJK content in messages more heavily than ASCII content', () => {
    const cjk: EstimableMessage[] = [{ role: 'user', content: '你好世界你好世界你好' }]
    const ascii: EstimableMessage[] = [{ role: 'user', content: 'aaaaaaaaaaaaaaaaaaaa' }]
    expect(estimateMessageTokens(cjk)).toBeGreaterThan(estimateMessageTokens(ascii))
  })

  it('is deterministic for message arrays', () => {
    const msgs: EstimableMessage[] = [
      { role: 'system', content: 'You are a helpful 🤖 assistant.' },
      { role: 'user', content: { nested: ['structured', '内容', 42] } },
    ]
    expect(estimateMessageTokens(msgs)).toBe(estimateMessageTokens(msgs))
  })

  it('handles structured (non-string) content without throwing', () => {
    const msgs: EstimableMessage[] = [
      { role: 'tool', content: { result: { rows: [1, 2, 3], ok: true } } },
    ]
    const n = estimateMessageTokens(msgs)
    expect(Number.isFinite(n)).toBe(true)
    expect(n).toBeGreaterThan(0)
  })
})
