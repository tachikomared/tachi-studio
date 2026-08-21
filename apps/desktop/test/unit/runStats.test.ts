// apps/desktop/test/unit/runStats.test.ts
//
// Pure rollup of run-log entries for the Observability "Recent runs" header
// (STEAL 2026-06-21 #11, CodexMonitor usage snapshot). Renderer-side + pure so
// it's unit-tested without IPC.
import { describe, it, expect } from 'vitest'
import { runStats, type RunLogLite } from '../../src/utils/runStats'

const DAY = 86_400_000
const e = (over: Partial<RunLogLite>): RunLogLite => ({ ts: 0, outcome: 'done', durationMs: 1000, ...over })

describe('runStats', () => {
  it('counts outcomes, ok% and average duration within the window', () => {
    const now = 100 * DAY
    const entries: RunLogLite[] = [
      e({ ts: now - 1 * DAY, outcome: 'done', durationMs: 2000 }),
      e({ ts: now - 2 * DAY, outcome: 'error', durationMs: 4000 }),
      e({ ts: now - 3 * DAY, outcome: 'done', durationMs: 6000 }),
      e({ ts: now - 3 * DAY, outcome: 'abort', durationMs: 0 }),
    ]
    const s = runStats(entries, now, 7)
    expect(s.runs).toBe(4)
    expect(s.ok).toBe(2)
    expect(s.errored).toBe(1)
    expect(s.aborted).toBe(1)
    expect(s.okPct).toBe(50)            // 2/4
    expect(s.avgDurationMs).toBe(3000)  // (2000+4000+6000+0)/4
  })

  it('excludes entries older than the window', () => {
    const now = 100 * DAY
    const entries = [e({ ts: now - 2 * DAY }), e({ ts: now - 40 * DAY })]
    expect(runStats(entries, now, 7).runs).toBe(1)
    expect(runStats(entries, now, 90).runs).toBe(2)
  })

  it('returns zeros for an empty window (no division by zero)', () => {
    const s = runStats([], 100 * DAY, 7)
    expect(s).toMatchObject({ runs: 0, ok: 0, okPct: 0, avgDurationMs: 0 })
  })
})
