// apps/desktop/electron/services/scheduler-store.ts
//
// Persistence for the local scheduler (USER-PAINS #9). Jobs live in
// userData/scheduler-jobs.json as a flat array — the same tmp+rename write the
// memory-fact store uses, so a crash mid-write can never leave a truncated file
// (and therefore can never silently drop everybody's schedules).
//
// Deliberately electron-free (path injected) so vitest drives it against a temp
// file; the electron-coupled singleton lives in scheduler-service.ts.
//
// Every mutation returns the freshly persisted job, and every read re-parses
// from disk: a scheduled run and the Settings UI are two writers of the same
// file within one process, and re-reading is cheaper than a cache-invalidation
// bug that loses a run.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import {
  asJob,
  computeNextRun,
  validateJobInput,
  type ScheduledJob,
  type ScheduledJobInput,
} from './scheduler-core'

function defaultIdGen(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export class SchedulerStore {
  constructor(
    private filePath: string,
    private now: () => number = Date.now,
    private idGen: () => string = defaultIdGen,
  ) {}

  private readAll(): ScheduledJob[] {
    if (!existsSync(this.filePath)) return []
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown
      if (!Array.isArray(raw)) return []
      return raw.map(asJob).filter((j): j is ScheduledJob => j !== null)
    } catch {
      // A corrupt file must not take the app down — the user sees an empty list
      // and can re-create jobs; the bad file is left in place for inspection.
      return []
    }
  }

  private writeAll(jobs: ScheduledJob[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(jobs, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  list(): ScheduledJob[] {
    return this.readAll()
  }

  get(id: string): ScheduledJob | null {
    return this.readAll().find(j => j.id === id) ?? null
  }

  /** Create (no id / unknown id) or replace (known id) one job. */
  upsert(input: ScheduledJobInput): { ok: true; job: ScheduledJob } | { ok: false; error: string } {
    const jobs = this.readAll()
    const idx = typeof input.id === 'string' ? jobs.findIndex(j => j.id === input.id) : -1
    const existing = idx >= 0 ? jobs[idx] : undefined
    const validated = validateJobInput(input, { now: this.now(), id: this.idGen(), existing })
    if (!validated.ok) return validated
    if (idx >= 0) jobs[idx] = validated.job
    else jobs.push(validated.job)
    this.writeAll(jobs)
    return { ok: true, job: validated.job }
  }

  /** Merge a partial update (run bookkeeping). Returns null for an unknown id. */
  patch(id: string, patch: Partial<ScheduledJob>): ScheduledJob | null {
    const jobs = this.readAll()
    const idx = jobs.findIndex(j => j.id === id)
    if (idx < 0) return null
    jobs[idx] = { ...jobs[idx]!, ...patch, id }
    this.writeAll(jobs)
    return jobs[idx]!
  }

  remove(id: string): boolean {
    const jobs = this.readAll()
    const next = jobs.filter(j => j.id !== id)
    if (next.length === jobs.length) return false
    this.writeAll(next)
    return true
  }

  /**
   * Pause / resume. Resuming recomputes nextRunAt from NOW, so a job paused for
   * a week does not come back with a week of "missed" runs to reason about.
   */
  setEnabled(id: string, enabled: boolean): ScheduledJob | null {
    const job = this.get(id)
    if (!job) return null
    return this.patch(id, {
      enabled,
      nextRunAt: enabled ? computeNextRun(job.schedule, this.now()) : null,
    })
  }
}
