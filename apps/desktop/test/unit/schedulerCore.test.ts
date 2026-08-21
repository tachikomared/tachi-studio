// apps/desktop/test/unit/schedulerCore.test.ts
//
// Pure scheduling logic (USER-PAINS #9). Three things are worth guarding:
//   1. recurrence math — the next occurrence for once/daily/weekly/interval;
//   2. the MISSED-RUN decision table — the whole point of the feature is that a
//      closed app or a sleeping PC does not silently swallow a run;
//   3. the timer wheel — with fake timers, so "it fires" is asserted rather than
//      hoped for.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MAX_TICK_MS,
  IDLE_TICK_MS,
  MIN_INTERVAL_MINUTES,
  MISSED_GRACE_MS,
  SchedulerEngine,
  afterRunPatch,
  asJob,
  computeNextRun,
  decideRun,
  nextTickDelay,
  parseTimeOfDay,
  validateJobInput,
  validateSchedule,
  type ScheduledJob,
} from '../../electron/services/scheduler-core'

/** Local-time epoch helper — the scheduler is wall-clock, so tests must be too. */
function at(y: number, mo: number, d: number, h: number, mi: number): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime()
}

function job(over: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'j1',
    name: 'Nightly',
    target: 'prompt',
    prompt: 'do the thing',
    schedule: { type: 'daily', timeOfDay: '02:00' },
    missedPolicy: 'run',
    enabled: true,
    createdAt: at(2026, 7, 1, 12, 0),
    nextRunAt: at(2026, 7, 2, 2, 0),
    runCount: 0,
    ...over,
  }
}

describe('parseTimeOfDay', () => {
  it('accepts HH:MM and rejects everything else', () => {
    expect(parseTimeOfDay('07:30')).toEqual({ h: 7, m: 30 })
    expect(parseTimeOfDay('7:05')).toEqual({ h: 7, m: 5 })
    expect(parseTimeOfDay('00:00')).toEqual({ h: 0, m: 0 })
    expect(parseTimeOfDay('23:59')).toEqual({ h: 23, m: 59 })
    expect(parseTimeOfDay('24:00')).toBeNull()
    expect(parseTimeOfDay('12:60')).toBeNull()
    expect(parseTimeOfDay('12')).toBeNull()
    expect(parseTimeOfDay(730)).toBeNull()
  })
})

describe('computeNextRun', () => {
  it('once: returns the moment only while it is still in the future', () => {
    const moment = at(2026, 7, 4, 9, 0)
    expect(computeNextRun({ type: 'once', at: moment }, at(2026, 7, 4, 8, 0))).toBe(moment)
    expect(computeNextRun({ type: 'once', at: moment }, moment)).toBeNull()
    expect(computeNextRun({ type: 'once', at: moment }, at(2026, 7, 4, 10, 0))).toBeNull()
  })

  it('daily: today when the time is still ahead, otherwise tomorrow', () => {
    const s = { type: 'daily' as const, timeOfDay: '02:00' }
    expect(computeNextRun(s, at(2026, 7, 1, 1, 0))).toBe(at(2026, 7, 1, 2, 0))
    expect(computeNextRun(s, at(2026, 7, 1, 3, 0))).toBe(at(2026, 7, 2, 2, 0))
    // Exactly ON the slot counts as passed — occurrences are strictly after.
    expect(computeNextRun(s, at(2026, 7, 1, 2, 0))).toBe(at(2026, 7, 2, 2, 0))
  })

  it('daily: rolls across a month boundary', () => {
    expect(computeNextRun({ type: 'daily', timeOfDay: '06:15' }, at(2026, 7, 31, 9, 0)))
      .toBe(at(2026, 8, 1, 6, 15))
  })

  it('weekly: lands on the requested weekday at the requested time', () => {
    // 2026-07-01 is a Wednesday (getDay() === 3).
    expect(new Date(at(2026, 7, 1, 12, 0)).getDay()).toBe(3)
    const monday = { type: 'weekly' as const, timeOfDay: '09:00', weekday: 1 }
    const next = computeNextRun(monday, at(2026, 7, 1, 12, 0))!
    expect(new Date(next).getDay()).toBe(1)
    expect(next).toBe(at(2026, 7, 6, 9, 0))
  })

  it('weekly: same weekday but later today stays today; earlier rolls a full week', () => {
    const wed = { type: 'weekly' as const, timeOfDay: '18:00', weekday: 3 }
    expect(computeNextRun(wed, at(2026, 7, 1, 12, 0))).toBe(at(2026, 7, 1, 18, 0))
    expect(computeNextRun(wed, at(2026, 7, 1, 19, 0))).toBe(at(2026, 7, 8, 18, 0))
  })

  it('interval: adds the delta and never runs hotter than the floor', () => {
    const from = at(2026, 7, 1, 12, 0)
    expect(computeNextRun({ type: 'interval', everyMinutes: 30 }, from)).toBe(from + 30 * 60_000)
    // A hand-edited file asking for 1 minute is clamped, not obeyed.
    expect(computeNextRun({ type: 'interval', everyMinutes: 1 }, from)).toBe(from + MIN_INTERVAL_MINUTES * 60_000)
  })
})

describe('validateSchedule / validateJobInput', () => {
  it('rejects unusable schedules with an actionable message', () => {
    expect(validateSchedule(null)).toEqual({ ok: false, error: 'Missing schedule.' })
    expect(validateSchedule({ type: 'yearly' })).toMatchObject({ ok: false })
    expect(validateSchedule({ type: 'daily', timeOfDay: 'noon' })).toMatchObject({ ok: false })
    expect(validateSchedule({ type: 'weekly', timeOfDay: '09:00', weekday: 9 })).toMatchObject({ ok: false })
    expect(validateSchedule({ type: 'interval', everyMinutes: 2 })).toMatchObject({ ok: false })
  })

  it('normalizes a sloppy but valid time of day', () => {
    expect(validateSchedule({ type: 'daily', timeOfDay: '7:05' })).toEqual({
      ok: true, schedule: { type: 'daily', timeOfDay: '07:05' },
    })
  })

  it('refuses a flow target whose filename could escape the flows directory', () => {
    const base = { target: 'flow' as const, schedule: { type: 'daily', timeOfDay: '09:00' } }
    expect(validateJobInput({ ...base, flowFile: '../../etc/passwd.tachi-flow.json' }, { now: 0, id: 'x' }))
      .toMatchObject({ ok: false })
    expect(validateJobInput({ ...base, flowFile: 'notes.txt' }, { now: 0, id: 'x' }))
      .toMatchObject({ ok: false })
    expect(validateJobInput({ ...base, flowFile: 'nightly.tachi-flow.json' }, { now: 0, id: 'x' }))
      .toMatchObject({ ok: true })
  })

  it('requires a prompt for a prompt job and seeds nextRunAt from now', () => {
    const now = at(2026, 7, 1, 12, 0)
    expect(validateJobInput({ target: 'prompt', prompt: '  ', schedule: { type: 'daily', timeOfDay: '09:00' } }, { now, id: 'x' }))
      .toMatchObject({ ok: false })
    const res = validateJobInput({ target: 'prompt', prompt: 'go', schedule: { type: 'daily', timeOfDay: '09:00' } }, { now, id: 'x' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.job.nextRunAt).toBe(at(2026, 7, 2, 9, 0))
      expect(res.job.name).toBe('go')  // falls back to the prompt
      expect(res.job.missedPolicy).toBe('run')
    }
  })

  it('refuses a one-off already in the past (it could never fire)', () => {
    const now = at(2026, 7, 1, 12, 0)
    expect(validateJobInput(
      { target: 'prompt', prompt: 'go', schedule: { type: 'once', at: at(2026, 6, 30, 9, 0) } },
      { now, id: 'x' },
    )).toMatchObject({ ok: false })
    expect(validateJobInput(
      { target: 'prompt', prompt: 'go', schedule: { type: 'once', at: at(2026, 7, 1, 18, 0) } },
      { now, id: 'x' },
    )).toMatchObject({ ok: true })
    // …but REHYDRATION must keep a fired one-off (allowPast).
    expect(validateJobInput(
      { target: 'prompt', prompt: 'go', schedule: { type: 'once', at: at(2026, 6, 30, 9, 0) } },
      { now, id: 'x', allowPast: true },
    )).toMatchObject({ ok: true })
  })

  it('a job created as paused gets no next occurrence', () => {
    const res = validateJobInput(
      { target: 'prompt', prompt: 'go', enabled: false, schedule: { type: 'daily', timeOfDay: '09:00' } },
      { now: at(2026, 7, 1, 12, 0), id: 'x' },
    )
    expect(res.ok && res.job.nextRunAt).toBeNull()
  })
})

describe('asJob (persistence round-trip narrowing)', () => {
  it('survives a JSON round-trip with its bookkeeping intact', () => {
    const original = job({ runCount: 4, lastRunAt: 123, lastStatus: 'error', lastDetail: 'boom', lastDurationMs: 900 })
    const back = asJob(JSON.parse(JSON.stringify(original)))
    expect(back).toEqual(original)
  })

  it('keeps a spent `once` job spent (null nextRunAt must not be recomputed)', () => {
    const spent = job({
      schedule: { type: 'once', at: at(2026, 7, 5, 9, 0) },
      nextRunAt: null,
      enabled: false,
      runCount: 1,
    })
    const back = asJob(JSON.parse(JSON.stringify(spent)))
    expect(back?.nextRunAt).toBeNull()
    expect(back?.enabled).toBe(false)
  })

  it('drops rows that are not jobs at all', () => {
    expect(asJob(null)).toBeNull()
    expect(asJob({ id: '' })).toBeNull()
    expect(asJob({ id: 'a', target: 'prompt', prompt: 'x' })).toBeNull() // no schedule
  })
})

describe('decideRun — the missed-run decision table', () => {
  const due = at(2026, 7, 2, 2, 0)

  it('paused → idle, whatever the clock says', () => {
    expect(decideRun(job({ enabled: false }), due + 10 * 86_400_000).action).toBe('idle')
  })

  it('no further occurrence → idle', () => {
    expect(decideRun(job({ nextRunAt: null }), due).action).toBe('idle')
  })

  it('not due yet → wait', () => {
    expect(decideRun(job(), due - 60_000).action).toBe('wait')
  })

  it('due within the grace window → an ordinary, non-missed run', () => {
    expect(decideRun(job(), due)).toMatchObject({ action: 'run', missed: false })
    expect(decideRun(job(), due + MISSED_GRACE_MS)).toMatchObject({ action: 'run', missed: false })
  })

  it('overdue + policy "run" → catch up on wake (still just ONE run)', () => {
    const d = decideRun(job({ missedPolicy: 'run' }), due + 3 * 86_400_000)
    expect(d).toMatchObject({ action: 'run', missed: true })
  })

  it('overdue + policy "skip" → skip and roll forward to the next future slot', () => {
    const now = at(2026, 7, 5, 12, 0)      // three days asleep, past 02:00
    const d = decideRun(job({ missedPolicy: 'skip' }), now)
    expect(d).toMatchObject({ action: 'skip', missed: true })
    expect(d.nextRunAt).toBe(at(2026, 7, 6, 2, 0))
  })

  it('a missed one-off with policy "skip" has nothing to roll forward to', () => {
    const moment = at(2026, 7, 2, 2, 0)
    const d = decideRun(
      job({ schedule: { type: 'once', at: moment }, nextRunAt: moment, missedPolicy: 'skip' }),
      moment + 86_400_000,
    )
    expect(d.action).toBe('skip')
    expect(d.nextRunAt).toBeNull()
  })
})

describe('afterRunPatch', () => {
  it('a one-off pauses itself and keeps its readout', () => {
    const moment = at(2026, 7, 2, 2, 0)
    const patch = afterRunPatch(job({ schedule: { type: 'once', at: moment }, nextRunAt: moment }), moment)
    expect(patch).toMatchObject({ nextRunAt: null, enabled: false, runCount: 1, lastRunAt: moment })
  })

  it('a recurring job rolls forward from NOW, not from the missed slot', () => {
    // Due at 02:00 on the 2nd, actually ran at 12:00 on the 5th (catch-up).
    const ranAt = at(2026, 7, 5, 12, 0)
    const patch = afterRunPatch(job(), ranAt)
    expect(patch.nextRunAt).toBe(at(2026, 7, 6, 2, 0))
    expect(patch.runCount).toBe(1)
  })
})

describe('nextTickDelay', () => {
  const now = at(2026, 7, 1, 12, 0)

  it('caps an ARMED job at the wheel ceiling so a long sleep is noticed quickly', () => {
    expect(nextTickDelay([job({ nextRunAt: now + 86_400_000 })], now)).toBe(MAX_TICK_MS)
  })

  // Idle honesty: with nothing armed the ceiling bought nothing and paid two
  // sync reads of scheduler-jobs.json per cycle forever. A refresh() re-arms
  // the wheel the instant a job appears, so the empty set may idle far longer.
  it('idles far longer when NOTHING is armed', () => {
    expect(nextTickDelay([], now)).toBe(IDLE_TICK_MS)
    expect(nextTickDelay([job({ enabled: false, nextRunAt: now + 1_000 })], now)).toBe(IDLE_TICK_MS)
    expect(nextTickDelay([job({ nextRunAt: null })], now)).toBe(IDLE_TICK_MS)
    expect(IDLE_TICK_MS).toBeGreaterThan(MAX_TICK_MS)
  })

  it('targets the soonest ENABLED job', () => {
    const jobs = [
      job({ id: 'a', nextRunAt: now + 20_000 }),
      job({ id: 'b', nextRunAt: now + 5_000 }),
      job({ id: 'c', enabled: false, nextRunAt: now + 1_000 }),
    ]
    expect(nextTickDelay(jobs, now)).toBe(5_000)
  })

  it('never returns a negative delay for an overdue job', () => {
    expect(nextTickDelay([job({ nextRunAt: now - 999_999 })], now)).toBeGreaterThan(0)
  })
})

describe('SchedulerEngine (fake timers)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  /** Wire an engine over a mutable in-memory job list + a controllable clock. */
  function harness(initial: ScheduledJob[], startNow: number) {
    let now = startNow
    const jobs = [...initial]
    const ran: string[] = []
    const engine = new SchedulerEngine({
      now: () => now,
      listJobs: () => jobs.map(j => ({ ...j })),
      patchJob: (id, patch) => {
        const i = jobs.findIndex(j => j.id === id)
        if (i >= 0) jobs[i] = { ...jobs[i]!, ...patch }
      },
      runJob: async (j) => {
        ran.push(j.id)
        const i = jobs.findIndex(x => x.id === j.id)
        if (i >= 0) jobs[i] = { ...jobs[i]!, ...afterRunPatch(jobs[i]!, now) }
      },
    })
    return { engine, ran, jobs, setNow: (t: number) => { now = t }, getNow: () => now }
  }

  it('fires a job once its moment arrives, and not before', async () => {
    const start = at(2026, 7, 1, 12, 0)
    const h = harness([job({ nextRunAt: start + 10_000 })], start)
    h.engine.start()

    h.setNow(start + 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.ran).toEqual([])

    h.setNow(start + 11_000)
    await vi.advanceTimersByTimeAsync(MAX_TICK_MS)
    expect(h.ran).toEqual(['j1'])
    h.engine.stop()
  })

  it('never fires a paused job', async () => {
    const start = at(2026, 7, 1, 12, 0)
    const h = harness([job({ enabled: false, nextRunAt: start - 1000 })], start)
    h.engine.start()
    await vi.advanceTimersByTimeAsync(MAX_TICK_MS * 3)
    expect(h.ran).toEqual([])
    h.engine.stop()
  })

  it('a long sleep produces exactly ONE catch-up run under policy "run"', async () => {
    // Due 02:00 daily; the machine slept for three days.
    const start = at(2026, 7, 2, 1, 59)
    const h = harness([job({ missedPolicy: 'run', nextRunAt: at(2026, 7, 2, 2, 0) })], start)
    h.engine.start()

    h.setNow(at(2026, 7, 5, 12, 0))   // wake up, three occurrences behind
    h.engine.refresh()
    await vi.advanceTimersByTimeAsync(MAX_TICK_MS)
    expect(h.ran).toEqual(['j1'])
    // …and it rolled forward instead of queueing the other two.
    expect(h.jobs[0]!.nextRunAt).toBe(at(2026, 7, 6, 2, 0))
    h.engine.stop()
  })

  it('a long sleep runs nothing under policy "skip" — it only rolls forward', async () => {
    const start = at(2026, 7, 2, 1, 59)
    const h = harness([job({ missedPolicy: 'skip', nextRunAt: at(2026, 7, 2, 2, 0) })], start)
    h.engine.start()

    h.setNow(at(2026, 7, 5, 12, 0))
    h.engine.refresh()
    await vi.advanceTimersByTimeAsync(MAX_TICK_MS)
    expect(h.ran).toEqual([])
    expect(h.jobs[0]!.nextRunAt).toBe(at(2026, 7, 6, 2, 0))
    expect(h.jobs[0]!.lastStatus).toBe('skipped')
    h.engine.stop()
  })

  it('stop() ends the wheel — a later due time fires nothing', async () => {
    const start = at(2026, 7, 1, 12, 0)
    const h = harness([job({ nextRunAt: start + 5_000 })], start)
    h.engine.start()
    h.engine.stop()
    h.setNow(start + 60_000)
    await vi.advanceTimersByTimeAsync(MAX_TICK_MS * 3)
    expect(h.ran).toEqual([])
  })

  it('a recurring job keeps firing on each subsequent interval', async () => {
    const start = at(2026, 7, 1, 12, 0)
    const every = { type: 'interval' as const, everyMinutes: MIN_INTERVAL_MINUTES }
    const step = MIN_INTERVAL_MINUTES * 60_000
    const h = harness([job({ schedule: every, nextRunAt: start + step })], start)
    h.engine.start()

    for (let i = 1; i <= 3; i++) {
      h.setNow(start + step * i + 500)
      h.engine.refresh()
      await vi.advanceTimersByTimeAsync(MAX_TICK_MS)
    }
    expect(h.ran).toEqual(['j1', 'j1', 'j1'])
    h.engine.stop()
  })
})
