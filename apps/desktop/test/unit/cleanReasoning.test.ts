// apps/desktop/test/unit/cleanReasoning.test.ts
//
// Reasoning-leakage stripping (ported from Pulse patrol_ai.go
// CleanThinkingTokens). Pure, deterministic. cleanReasoningLeakage runs on the
// FULL accumulated assistant text (not per token); it must be idempotent and a
// no-op on clean output. Covers plain <think>/<thought>/<reasoning> blocks,
// DeepSeek full-width <｜DSML｜…> markers, orphaned leading end-markers, the
// idempotence guarantee, and the "don't eat a legitimate non-marker tag" case.
import { describe, it, expect } from 'vitest'
import { cleanReasoningLeakage } from '../../electron/services/util/clean-reasoning'

describe('cleanReasoningLeakage — block stripping', () => {
  it('removes a plain <think>…</think> block, keeping the answer', () => {
    expect(cleanReasoningLeakage('<think>chain of thought</think>the answer')).toBe('the answer')
  })

  it('removes <thought> and <reasoning> blocks', () => {
    expect(cleanReasoningLeakage('<thought>hmm</thought>done')).toBe('done')
    expect(cleanReasoningLeakage('<reasoning>step 1\nstep 2</reasoning>final')).toBe('final')
  })

  it('matches across newlines (dotall) inside a block', () => {
    const input = '<think>\nline one\nline two\n</think>\nThe real answer.'
    expect(cleanReasoningLeakage(input)).toBe('The real answer.')
  })

  it('is case-insensitive on tag names', () => {
    expect(cleanReasoningLeakage('<THINK>x</THINK>answer')).toBe('answer')
    expect(cleanReasoningLeakage('<Thought>y</Thought>answer')).toBe('answer')
  })

  it('keeps leading and trailing text around a block', () => {
    expect(cleanReasoningLeakage('before <think>cot</think> after')).toBe('before  after')
  })

  it('removes multiple and nested blocks', () => {
    expect(cleanReasoningLeakage('a<think>1</think>b<think>2</think>c')).toBe('abc')
    // A same-kind nested block: the outer open pairs with the FIRST close, and
    // the now-orphaned remainder up to the second close is swept too.
    const out = cleanReasoningLeakage('<think>outer<think>inner</think>more</think>answer')
    expect(out).toBe('answer')
  })

  it('handles the <|reasoning|>…<|/reasoning|> pipe form', () => {
    expect(cleanReasoningLeakage('<|reasoning|>deliberating</|reasoning|>answer'.replace('</|', '<|/'))).toBe('answer')
    expect(cleanReasoningLeakage('<|reasoning|>deliberating<|/reasoning|>answer')).toBe('answer')
  })
})

describe('cleanReasoningLeakage — DeepSeek full-width markers', () => {
  it('strips a full-width <｜DSML｜…> function-call block at the tail', () => {
    const input = 'Here is your answer.\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="x">'
    expect(cleanReasoningLeakage(input)).toBe('Here is your answer.')
  })

  it('strips the ASCII <|DSML|…> variant', () => {
    const input = 'Answer text.<|DSML|function_calls>blah'
    expect(cleanReasoningLeakage(input)).toBe('Answer text.')
  })

  it('removes a dangling full-width <｜end▁of▁thinking｜> end-marker line', () => {
    const input = 'reasoning leaked here\n<｜end▁of▁thinking｜>\nThe answer.'
    const out = cleanReasoningLeakage(input)
    expect(out).not.toContain('end')
    expect(out).toContain('The answer.')
  })
})

describe('cleanReasoningLeakage — orphaned leading end-marker', () => {
  it('removes a leading </think> with no opening tag (model started mid-reasoning)', () => {
    // Model began emitting reasoning before its first streamed token, so only the
    // closing tag survives in the accumulated text. Everything before it is the
    // orphaned reasoning and must be dropped along with the marker.
    const input = 'I should look at the config first.\n</think>\nThe config is valid.'
    const out = cleanReasoningLeakage(input)
    expect(out).toContain('The config is valid.')
    expect(out).not.toContain('</think>')
    expect(out).not.toContain('I should look at the config first.')
  })

  it('removes a leading orphaned </thought>', () => {
    const out = cleanReasoningLeakage('musing about it\n</thought>\nResult.')
    expect(out).toBe('Result.')
  })
})

describe('cleanReasoningLeakage — no-op / idempotence / safety', () => {
  it('returns clean text unchanged (trimmed)', () => {
    expect(cleanReasoningLeakage('just a normal answer')).toBe('just a normal answer')
  })

  it('returns empty string for empty input', () => {
    expect(cleanReasoningLeakage('')).toBe('')
  })

  it('is idempotent — a second pass changes nothing', () => {
    const input = '<think>cot</think>answer<|DSML|invoke>'
    const once = cleanReasoningLeakage(input)
    expect(cleanReasoningLeakage(once)).toBe(once)
  })

  it('is idempotent with multiple orphaned end-markers (fixed-point sweep)', () => {
    // Two dangling </think> of the same kind: a one-shot per-marker pass would
    // leave the second behind. One full pass must reach a fixed point.
    const input = 'x</think>y</think>z'
    const once = cleanReasoningLeakage(input)
    expect(once).not.toContain('</think>')
    expect(cleanReasoningLeakage(once)).toBe(once)
  })

  it('does not eat a legitimate non-marker tag like <thinking about it>', () => {
    const input = 'I was <thinking about it> for a while.'
    expect(cleanReasoningLeakage(input)).toBe('I was <thinking about it> for a while.')
  })

  it('does not strip prose that merely mentions think/thought words', () => {
    const input = 'I think the thought process here is sound.'
    expect(cleanReasoningLeakage(input)).toBe('I think the thought process here is sound.')
  })

  it('leaves a standalone < or unrelated angle brackets alone', () => {
    expect(cleanReasoningLeakage('a < b and c > d')).toBe('a < b and c > d')
  })
})
