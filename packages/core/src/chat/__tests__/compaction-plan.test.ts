import { describe, it, expect } from 'vitest'
import type { HistoryTurn } from '../budget-history.js'
import {
  planLlmCompaction,
  buildCompactionPrompt,
  applyCompactionSummary,
} from '../compaction-plan.js'

function turn(role: 'user' | 'assistant', content: string): HistoryTurn {
  return { role, content }
}

// Deterministic builder: 10 turns alternating user/assistant, each `size` chars.
function makeHistory(n: number, size: number): HistoryTurn[] {
  const turns: HistoryTurn[] = []
  for (let i = 0; i < n; i++) {
    turns.push(turn(i % 2 === 0 ? 'user' : 'assistant', `t${i}-` + 'x'.repeat(size)))
  }
  return turns
}

describe('planLlmCompaction', () => {
  it('returns needsSummary=false when total content is under budget', () => {
    const history = makeHistory(4, 50) // ~4*53 = 212 chars
    const plan = planLlmCompaction(history, { maxChars: 100_000, keepRecentVerbatim: 2 })
    expect(plan.needsSummary).toBe(false)
    expect(plan.toSummarize).toEqual([])
    expect(plan.keep).toEqual(history)
  })

  it('returns needsSummary=false for empty history', () => {
    const plan = planLlmCompaction([], { maxChars: 10, keepRecentVerbatim: 2 })
    expect(plan.needsSummary).toBe(false)
    expect(plan.toSummarize).toEqual([])
    expect(plan.keep).toEqual([])
  })

  it('picks the oldest span to summarize and keeps recent N verbatim when over budget', () => {
    const history = makeHistory(10, 100) // 10 turns ~ 1030 chars
    const plan = planLlmCompaction(history, { maxChars: 200, keepRecentVerbatim: 3 })
    expect(plan.needsSummary).toBe(true)
    // recent 3 are always kept verbatim (the tail of `keep`)
    expect(plan.keep.slice(-3)).toEqual(history.slice(-3))
    // toSummarize is the oldest contiguous span, in original order
    expect(plan.toSummarize[0]).toEqual(history[0])
    // toSummarize + keep losslessly recovers the original history (contiguous split)
    expect([...plan.toSummarize, ...plan.keep]).toEqual(history)
  })

  it('summarizes the older HALF (not just one turn) so the window stays bounded', () => {
    const history = makeHistory(10, 100)
    const plan = planLlmCompaction(history, { maxChars: 200, keepRecentVerbatim: 3 })
    // older half of 10 = first 5 turns should be in toSummarize
    expect(plan.toSummarize.length).toBeGreaterThanOrEqual(5)
  })

  it('never summarizes the recent-verbatim window even when it alone exceeds budget', () => {
    const history = makeHistory(5, 1000) // each ~1004 chars, far over budget
    const plan = planLlmCompaction(history, { maxChars: 100, keepRecentVerbatim: 3 })
    // the 3 most-recent turns must remain verbatim in keep
    expect(plan.keep.slice(-3)).toEqual(history.slice(-3))
    // and must NOT appear in toSummarize
    for (const t of history.slice(-3)) {
      expect(plan.toSummarize).not.toContainEqual(t)
    }
  })

  it('is deterministic — same input yields identical plan', () => {
    const history = makeHistory(10, 100)
    const a = planLlmCompaction(history, { maxChars: 200, keepRecentVerbatim: 3 })
    const b = planLlmCompaction(history, { maxChars: 200, keepRecentVerbatim: 3 })
    expect(a).toEqual(b)
  })

  it('does not summarize when keepRecentVerbatim covers the whole history', () => {
    const history = makeHistory(3, 1000)
    const plan = planLlmCompaction(history, { maxChars: 10, keepRecentVerbatim: 5 })
    expect(plan.needsSummary).toBe(false)
    expect(plan.toSummarize).toEqual([])
    expect(plan.keep).toEqual(history)
  })
})

describe('buildCompactionPrompt', () => {
  const toSummarize: HistoryTurn[] = [
    turn('user', 'Build me a wallet tracker for SOL'),
    turn('assistant', 'I created tracker.ts and added a balance poll loop'),
    turn('user', 'Now add a price alert at $200'),
  ]

  it('contains the structured Cursor-style sections', () => {
    const prompt = buildCompactionPrompt(toSummarize)
    expect(prompt).toMatch(/goal/i)
    expect(prompt).toMatch(/done|accomplished|completed/i)
    expect(prompt).toMatch(/current state/i)
    expect(prompt).toMatch(/pending/i)
    expect(prompt).toMatch(/key context/i)
  })

  it('embeds the conversation content to be summarized', () => {
    const prompt = buildCompactionPrompt(toSummarize)
    expect(prompt).toContain('Build me a wallet tracker for SOL')
    expect(prompt).toContain('price alert at $200')
  })

  it('labels turns by role', () => {
    const prompt = buildCompactionPrompt(toSummarize)
    expect(prompt).toMatch(/USER/)
    expect(prompt).toMatch(/ASSISTANT/)
  })

  it('is deterministic', () => {
    expect(buildCompactionPrompt(toSummarize)).toBe(buildCompactionPrompt(toSummarize))
  })
})

describe('applyCompactionSummary', () => {
  const keep: HistoryTurn[] = [
    turn('assistant', 'kept-1'),
    turn('user', 'kept-2'),
    turn('assistant', 'kept-3'),
  ]

  it('prepends exactly one notice turn and preserves kept turns in order', () => {
    const out = applyCompactionSummary('SUMMARY BODY', keep)
    expect(out.length).toBe(keep.length + 1)
    expect(out.slice(1)).toEqual(keep)
  })

  it('the prepended turn carries the summary text and a compact boundary marker', () => {
    const out = applyCompactionSummary('SUMMARY BODY', keep)
    expect(out[0].content).toContain('SUMMARY BODY')
    expect(out[0].content).toMatch(/compact_boundary/)
  })

  it('the notice turn is user-role (mirrors budget-history notice convention)', () => {
    const out = applyCompactionSummary('SUMMARY BODY', keep)
    expect(out[0].role).toBe('user')
  })

  it('does not mutate the input keep array', () => {
    const snapshot = keep.map(t => ({ ...t }))
    applyCompactionSummary('SUMMARY BODY', keep)
    expect(keep).toEqual(snapshot)
  })

  it('is deterministic', () => {
    expect(applyCompactionSummary('S', keep)).toEqual(applyCompactionSummary('S', keep))
  })
})
