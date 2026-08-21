// apps/desktop/test/unit/swarmHistory.test.ts
//
// Swarm run-history (STEAL 2026-06-21 #15, CodexMonitor). Pure helpers behind
// the SwarmHistory view: terminal runs only, newest-first, duration formatting.

import { describe, it, expect } from 'vitest'
import { sortRunsForHistory, formatRunDuration } from '../../src/pages/swarm/runHistory'
import type { GnapRun } from '../../src/types/electron'

const run = (over: Partial<GnapRun>): GnapRun => ({
  id: 'r', task: 't', agent: 'a', state: 'completed', started_at: '2026-06-22T10:00:00Z',
  attempt: 1, commits: [], artifacts: [], ...over,
})

describe('sortRunsForHistory', () => {
  it('keeps only terminal runs (drops running) and sorts newest-first', () => {
    const runs: GnapRun[] = [
      run({ id: 'old', state: 'completed', finished_at: '2026-06-22T10:05:00Z' }),
      run({ id: 'live', state: 'running' }),
      run({ id: 'new', state: 'failed', finished_at: '2026-06-22T11:00:00Z' }),
    ]
    expect(sortRunsForHistory(runs).map(r => r.id)).toEqual(['new', 'old'])
  })

  it('falls back to started_at when finished_at is absent', () => {
    const runs: GnapRun[] = [
      run({ id: 'a', state: 'cancelled', started_at: '2026-06-22T09:00:00Z' }),
      run({ id: 'b', state: 'cancelled', started_at: '2026-06-22T12:00:00Z' }),
    ]
    expect(sortRunsForHistory(runs).map(r => r.id)).toEqual(['b', 'a'])
  })

  it('does not mutate the input array', () => {
    const runs: GnapRun[] = [run({ id: 'x', finished_at: '2026-06-22T10:05:00Z' })]
    const copy = [...runs]
    sortRunsForHistory(runs)
    expect(runs).toEqual(copy)
  })
})

describe('formatRunDuration', () => {
  it('formats sub-minute durations in seconds', () => {
    expect(formatRunDuration(run({ started_at: '2026-06-22T10:00:00Z', finished_at: '2026-06-22T10:00:42Z' }))).toBe('42s')
  })

  it('formats minute+ durations as Xm Ys', () => {
    expect(formatRunDuration(run({ started_at: '2026-06-22T10:00:00Z', finished_at: '2026-06-22T10:02:05Z' }))).toBe('2m 5s')
  })

  it('returns null when the run has not finished', () => {
    expect(formatRunDuration(run({ state: 'running', finished_at: undefined }))).toBeNull()
  })
})
