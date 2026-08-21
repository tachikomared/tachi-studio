// packages/core/src/chat/__tests__/budget-history-twophase.test.ts
//
// Two-phase compaction for budgetHistory (STEAL 2026-06-12 cluster A;
// OpenAlice src/core/compaction.ts microcompact idea, sized to our
// string-content history). Phase 1: deterministically elide the middles of
// OLD oversized turns (head+tail kept) — often enough to fit the budget
// WITHOUT losing whole turns. Phase 2: the existing whole-turn oldest-drop,
// now running over the compacted copy. No options -> exact legacy behavior
// (covered by budget-history.test.ts).

import { describe, it, expect } from 'vitest'
import { budgetHistory, type HistoryTurn } from '../budget-history'

const turn = (role: 'user' | 'assistant', content: string): HistoryTurn => ({ role, content })

const MICRO = { keepRecentVerbatim: 2, perTurnCapChars: 100 }

describe('budgetHistory two-phase (microcompact)', () => {
  it('under budget: untouched, no elision', () => {
    const h = [turn('user', 'a'.repeat(500)), turn('assistant', 'b'.repeat(50))]
    const out = budgetHistory(h, { maxChars: 1000, microcompact: MICRO })
    expect(out).toEqual(h)
  })

  it('phase 1 saves all turns by eliding an old fat turn', () => {
    const h = [
      turn('user', 'OLD-'.repeat(300)),          // 1200 chars, old
      turn('assistant', 'mid'),                   // recent-2 (verbatim)
      turn('user', 'newest question'),            // recent-1 (verbatim)
    ]
    const out = budgetHistory(h, { maxChars: 400, microcompact: MICRO })
    expect(out).toHaveLength(3)                    // nothing dropped
    expect(out[0]!.content.length).toBeLessThanOrEqual(150) // capped (+marker)
    expect(out[0]!.content).toContain('chars elided')
    expect(out[0]!.content.startsWith('OLD-')).toBe(true)   // head kept
    expect(out[0]!.content.endsWith('OLD-')).toBe(true)     // tail kept
    expect(out[1]!.content).toBe('mid')            // recent turns verbatim
    expect(out[2]!.content).toBe('newest question')
  })

  it('recent turns are never elided even when oversized', () => {
    const h = [
      turn('user', 'old'),
      turn('assistant', 'BIGRECENT-'.repeat(50)), // 500 chars but inside keepRecentVerbatim
      turn('user', 'q'),
    ]
    const out = budgetHistory(h, { maxChars: 5000, microcompact: MICRO })
    expect(out[1]!.content).toBe('BIGRECENT-'.repeat(50))
  })

  it('phase 2 still drops whole oldest turns when elision is not enough', () => {
    const h = [
      turn('user', 'x'.repeat(120)),   // old, will be capped to ~100
      turn('assistant', 'y'.repeat(120)), // old, capped
      turn('user', 'z'.repeat(120)),   // recent-2 verbatim
      turn('assistant', 'w'.repeat(120)), // recent-1 verbatim
    ]
    // Budget so tight that even compacted old turns cannot all stay.
    const out = budgetHistory(h, { maxChars: 260, microcompact: MICRO })
    expect(out[0]!.content).toMatch(/omitted to fit context/) // notice turn
    expect(out.length).toBeLessThan(5)
    // The newest turn always survives verbatim.
    expect(out[out.length - 1]!.content).toBe('w'.repeat(120))
  })

  it('without microcompact the legacy drop path is byte-identical', () => {
    const h = [turn('user', 'a'.repeat(300)), turn('assistant', 'b'.repeat(300))]
    const legacy = budgetHistory(h, { maxChars: 350 })
    const explicit = budgetHistory(h, { maxChars: 350, microcompact: undefined })
    expect(explicit).toEqual(legacy)
  })
})
