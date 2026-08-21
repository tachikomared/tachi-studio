// apps/desktop/test/unit/schedulerLoopJob.test.ts
//
// LOOP MODE survives a restart by riding the scheduler: the controller parks a
// ONE-OFF job carrying its resume state, refreshes it after every iteration and
// deletes it when the loop ends. That only works if the resume state ROUND-TRIPS
// through the JSON store intact — so this asserts the full path (validate →
// write → fresh store instance → read back), plus the validation that keeps a
// hand-edited or truncated row from resurrecting a nonsense loop.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SchedulerStore } from '../../electron/services/scheduler-store'
import {
  asJob,
  decideRun,
  validateJobInput,
  validateLoopState,
  type ScheduledJobInput,
} from '../../electron/services/scheduler-core'

const NOW = new Date(2026, 6, 25, 12, 0, 0, 0).getTime()

let dir: string
let file: string

function makeStore(now = NOW): SchedulerStore {
  let n = 0
  return new SchedulerStore(file, () => now, () => `job_${++n}`)
}

const loopJob: ScheduledJobInput = {
  target: 'loop',
  name: 'Loop: make every test pass',
  prompt: 'make every test pass',
  loop: { key: 'sess-1', goal: 'make every test pass', cap: 5, iteration: 2, workspaceRoot: 'D:/proj' },
  schedule: { type: 'once', at: NOW + 3 * 60_000 },
  missedPolicy: 'run',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tachi-loopjob-'))
  file = join(dir, 'scheduler-jobs.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

describe('validateLoopState', () => {
  it('accepts a complete resume state and bounds the numbers', () => {
    const r = validateLoopState({ key: 'k', goal: 'g', cap: 999, iteration: 999, workspaceRoot: '/ws' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.loop).toEqual({ key: 'k', goal: 'g', cap: 20, iteration: 20, workspaceRoot: '/ws' })
  })

  it('refuses a state missing the key, goal or workspace', () => {
    expect(validateLoopState({ goal: 'g', workspaceRoot: '/ws' }).ok).toBe(false)
    expect(validateLoopState({ key: 'k', workspaceRoot: '/ws' }).ok).toBe(false)
    expect(validateLoopState({ key: 'k', goal: 'g' }).ok).toBe(false)
    expect(validateLoopState(null).ok).toBe(false)
  })

  it('defaults a missing/negative iteration to 0 (a resumed loop restarts the cycle, never a negative one)', () => {
    const r = validateLoopState({ key: 'k', goal: 'g', cap: 3, iteration: -5, workspaceRoot: '/ws' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.loop.iteration).toBe(0)
  })
})

describe('validateJobInput — target loop', () => {
  it('accepts a loop job and keeps its resume state', () => {
    const r = validateJobInput(loopJob, { now: NOW, id: 'x' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.job.target).toBe('loop')
    expect(r.job.loop).toEqual({ key: 'sess-1', goal: 'make every test pass', cap: 5, iteration: 2, workspaceRoot: 'D:/proj' })
  })

  it('refuses a loop job with no resume state (no silent half-loop)', () => {
    const r = validateJobInput({ ...loopJob, loop: undefined }, { now: NOW, id: 'x' })
    expect(r.ok).toBe(false)
  })

  it('leaves flow and prompt jobs exactly as they were', () => {
    const prompt = validateJobInput({ target: 'prompt', prompt: 'hi', schedule: { type: 'daily', timeOfDay: '02:00' } }, { now: NOW, id: 'p' })
    expect(prompt.ok).toBe(true)
    if (prompt.ok) expect(prompt.job.loop).toBeUndefined()

    const flow = validateJobInput({ target: 'flow', flowFile: 'nightly.tachi-flow.json', prompt: '', schedule: { type: 'daily', timeOfDay: '02:00' } }, { now: NOW, id: 'f' })
    expect(flow.ok).toBe(true)
    if (flow.ok) expect(flow.job.target).toBe('flow')
  })
})

describe('loop job persistence round-trip', () => {
  it('survives a fresh store instance (the restart case) with its resume point intact', () => {
    const created = makeStore().upsert(loopJob)
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const reopened = makeStore().list()
    expect(reopened).toHaveLength(1)
    expect(reopened[0].target).toBe('loop')
    expect(reopened[0].loop).toEqual({ key: 'sess-1', goal: 'make every test pass', cap: 5, iteration: 2, workspaceRoot: 'D:/proj' })
    expect(reopened[0]).toEqual(created.job)
  })

  it('refreshing the resume point is an idempotent upsert on the same id', () => {
    const store = makeStore()
    const first = store.upsert(loopJob)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // The service re-finds the row by loop key and reuses its id — that is what
    // keeps a loop from appending one job per iteration.
    const again = store.upsert({ ...loopJob, id: first.job.id, loop: { key: 'sess-1', goal: 'make every test pass', cap: 5, iteration: 3, workspaceRoot: 'D:/proj' }, schedule: { type: 'once', at: NOW + 6 * 60_000 } })
    expect(again.ok).toBe(true)
    const all = makeStore().list()
    expect(all).toHaveLength(1)                     // refreshed, not duplicated
    expect(all[0].loop?.iteration).toBe(3)
    expect(all[0].nextRunAt).toBe(NOW + 6 * 60_000) // pushed forward, so it never fires while alive
  })

  it('a loop parked in the future WAITS; one left overdue by a crash RUNS on the next boot', () => {
    const store = makeStore()
    const created = store.upsert(loopJob)
    if (!created.ok) return
    expect(decideRun(created.job, NOW).action).toBe('wait')

    // The app died; hours later the wheel boots and sees an overdue one-off.
    const later = NOW + 4 * 3_600_000
    const decision = decideRun(created.job, later)
    expect(decision).toMatchObject({ action: 'run', missed: true })
  })

  it('a corrupt loop row is dropped rather than resurrected as a broken loop', () => {
    writeFileSync(file, JSON.stringify([
      { id: 'bad', target: 'loop', prompt: 'g', schedule: { type: 'once', at: NOW }, loop: { goal: 'g' } },
    ]), 'utf8')
    expect(makeStore().list()).toEqual([])
    expect(asJob({ id: 'bad', target: 'loop', prompt: 'g', schedule: { type: 'once', at: NOW } })).toBeNull()
  })

  it('clearing the loop removes exactly that job', () => {
    const store = makeStore()
    const created = store.upsert(loopJob)
    if (!created.ok) return
    store.upsert({ target: 'prompt', prompt: 'unrelated', schedule: { type: 'daily', timeOfDay: '02:00' } })
    // clearLoopJob() looks the row up by loop key, then removes it by id.
    const found = store.list().find(j => j.target === 'loop' && j.loop?.key === 'sess-1')
    expect(found?.id).toBe(created.job.id)
    expect(store.remove(found!.id)).toBe(true)
    const left = makeStore().list()
    expect(left).toHaveLength(1)
    expect(left[0].target).toBe('prompt')
  })
})
