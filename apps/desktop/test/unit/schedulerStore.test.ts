// apps/desktop/test/unit/schedulerStore.test.ts
//
// Persistence for the local scheduler (USER-PAINS #9): the store is what makes
// "survives an app restart" true, so the round-trip, the atomic write and the
// corrupt-file behaviour are all asserted against a real temp file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SchedulerStore } from '../../electron/services/scheduler-store'
import type { ScheduledJobInput } from '../../electron/services/scheduler-core'

function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

const NOW = at(2026, 7, 1, 12, 0)

let dir: string
let file: string
let ids: number

function makeStore(now = NOW): SchedulerStore {
  ids = 0
  return new SchedulerStore(file, () => now, () => `job_${++ids}`)
}

const dailyPrompt: ScheduledJobInput = {
  target: 'prompt',
  name: 'Nightly digest',
  prompt: 'summarize today',
  schedule: { type: 'daily', timeOfDay: '02:00' },
  missedPolicy: 'run',
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tachi-sched-'))
  file = join(dir, 'nested', 'scheduler-jobs.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

describe('SchedulerStore', () => {
  it('starts empty and creates the file lazily (mkdir -p on first write)', () => {
    const s = makeStore()
    expect(s.list()).toEqual([])
    expect(existsSync(file)).toBe(false)
    s.upsert(dailyPrompt)
    expect(existsSync(file)).toBe(true)
  })

  it('round-trips a job through a FRESH store instance (the restart case)', () => {
    const created = makeStore().upsert(dailyPrompt)
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const reopened = makeStore().list()
    expect(reopened).toHaveLength(1)
    expect(reopened[0]).toEqual(created.job)
    expect(reopened[0]!.nextRunAt).toBe(at(2026, 7, 2, 2, 0))
    expect(reopened[0]!.runCount).toBe(0)
  })

  it('keeps run bookkeeping across a reopen', () => {
    const s = makeStore()
    const created = s.upsert(dailyPrompt)
    if (!created.ok) throw new Error('setup failed')
    s.patch(created.job.id, {
      lastRunAt: NOW, lastStatus: 'error', lastDetail: 'gateway said no', lastDurationMs: 4200, runCount: 3,
    })

    const back = makeStore().get(created.job.id)
    expect(back).toMatchObject({
      lastRunAt: NOW, lastStatus: 'error', lastDetail: 'gateway said no', lastDurationMs: 4200, runCount: 3,
    })
  })

  it('a fired one-off is REHYDRATED, not dropped, even though its moment has passed', () => {
    const s = makeStore()
    const created = s.upsert({
      target: 'prompt', prompt: 'once only',
      schedule: { type: 'once', at: at(2026, 7, 1, 18, 0) },
    })
    if (!created.ok) throw new Error('setup failed')
    s.patch(created.job.id, { nextRunAt: null, enabled: false, runCount: 1 })

    // Re-open the store "a week later": the past moment must not disqualify the row.
    const later = new SchedulerStore(file, () => at(2026, 7, 8, 12, 0), () => 'unused')
    expect(later.list()).toHaveLength(1)
  })

  it('a spent one-off stays spent after a reopen', () => {
    const s = makeStore()
    const created = s.upsert({
      target: 'prompt', prompt: 'once only',
      schedule: { type: 'once', at: at(2026, 7, 1, 18, 0) },
    })
    if (!created.ok) throw new Error('setup failed')
    s.patch(created.job.id, { nextRunAt: null, enabled: false, runCount: 1 })

    const back = makeStore().get(created.job.id)
    expect(back?.nextRunAt).toBeNull()
    expect(back?.enabled).toBe(false)
  })

  it('upsert with a known id EDITS instead of duplicating, preserving createdAt', () => {
    const s = makeStore()
    const created = s.upsert(dailyPrompt)
    if (!created.ok) throw new Error('setup failed')

    const edited = s.upsert({ ...dailyPrompt, id: created.job.id, name: 'Renamed', schedule: { type: 'daily', timeOfDay: '06:30' } })
    expect(edited.ok).toBe(true)
    const all = s.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.id).toBe(created.job.id)
    expect(all[0]!.name).toBe('Renamed')
    expect(all[0]!.createdAt).toBe(created.job.createdAt)
    expect(all[0]!.nextRunAt).toBe(at(2026, 7, 2, 6, 30))
  })

  it('rejects an invalid job without touching what is already stored', () => {
    const s = makeStore()
    s.upsert(dailyPrompt)
    const bad = s.upsert({ target: 'flow', flowFile: '../escape.tachi-flow.json', schedule: { type: 'daily', timeOfDay: '09:00' } })
    expect(bad).toMatchObject({ ok: false })
    expect(s.list()).toHaveLength(1)
  })

  it('setEnabled(false) clears the next occurrence; re-enabling recomputes it from now', () => {
    const s = makeStore()
    const created = s.upsert(dailyPrompt)
    if (!created.ok) throw new Error('setup failed')

    expect(s.setEnabled(created.job.id, false)).toMatchObject({ enabled: false, nextRunAt: null })
    expect(s.setEnabled(created.job.id, true)).toMatchObject({ enabled: true, nextRunAt: at(2026, 7, 2, 2, 0) })
  })

  it('remove() reports whether anything was actually removed', () => {
    const s = makeStore()
    const created = s.upsert(dailyPrompt)
    if (!created.ok) throw new Error('setup failed')
    expect(s.remove('nope')).toBe(false)
    expect(s.remove(created.job.id)).toBe(true)
    expect(s.list()).toEqual([])
  })

  it('patch()/get() on an unknown id are no-ops rather than throws', () => {
    const s = makeStore()
    expect(s.get('nope')).toBeNull()
    expect(s.patch('nope', { runCount: 9 })).toBeNull()
    expect(s.setEnabled('nope', true)).toBeNull()
  })

  it('a corrupt file degrades to an empty list instead of taking the app down', () => {
    const s = makeStore()
    s.upsert(dailyPrompt)
    writeFileSync(file, '{ this is not json', 'utf8')
    expect(s.list()).toEqual([])
    // …and the next write repairs the file.
    expect(s.upsert(dailyPrompt).ok).toBe(true)
    expect(s.list()).toHaveLength(1)
  })

  it('drops individual junk rows but keeps the good ones', () => {
    const s = makeStore()
    const created = s.upsert(dailyPrompt)
    if (!created.ok) throw new Error('setup failed')
    const rows = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
    writeFileSync(file, JSON.stringify([...rows, { id: 'junk' }, null, 42]), 'utf8')
    expect(s.list()).toHaveLength(1)
  })

  it('writes atomically (no .tmp left behind)', () => {
    const s = makeStore()
    s.upsert(dailyPrompt)
    expect(existsSync(file + '.tmp')).toBe(false)
  })
})
