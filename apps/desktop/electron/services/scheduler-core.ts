// apps/desktop/electron/services/scheduler-core.ts
//
// PURE scheduling logic for the local, offline scheduler (USER-PAINS #9 / T14:
// "the 2am build never fires"). No electron, no fs, no timers of its own —
// everything here is data-in / data-out so vitest can drive it headlessly and
// with fake timers.
//
// What lives here:
//   - the ScheduledJob shape + validation/normalization of untrusted input
//   - computeNextRun(): the recurrence math (once / daily / weekly / interval)
//   - decideRun():      the MISSED-RUN decision table (the app was closed or the
//                       PC was asleep when the job was due — run-on-wake vs skip)
//   - SchedulerEngine:  a self-rearming timer wheel with injected now()/timers
//
// TIMEBASE. Everything is local wall-clock time (a user who schedules "07:30
// daily" means their own 07:30, DST included) — daily/weekly walk Date fields
// rather than adding fixed millisecond deltas, so a DST shift does not drift the
// hour. `interval` is a pure delta (every N minutes) and is DST-agnostic by
// design.
//
// SLEEP. A sleeping PC does not fire timers; the wheel therefore never trusts
// the timer alone. Every tick re-derives due-ness from wall-clock time, and the
// tick delay is capped (MAX_TICK_MS) so a long sleep is noticed within seconds
// of wake even before powerMonitor's 'resume' forces an immediate refresh().

export const SCHEDULE_TYPES = ['once', 'daily', 'weekly', 'interval'] as const
export type ScheduleType = (typeof SCHEDULE_TYPES)[number]

/** What to do about an occurrence that came due while nothing was running. */
export const MISSED_POLICIES = ['run', 'skip'] as const
export type MissedRunPolicy = (typeof MISSED_POLICIES)[number]

export const JOB_TARGETS = ['flow', 'prompt', 'loop'] as const
export type JobTarget = (typeof JOB_TARGETS)[number]

/**
 * Resume state for target 'loop' — a LOOP-MODE harness run persisted so it
 * survives an app restart. The controller re-writes this after every iteration
 * (pushing `at` forward) and deletes the job when the loop ends on its own
 * terms, so while the app is alive the job never fires; if the app died
 * mid-loop, the missed-run policy resumes it from `iteration`.
 */
export interface LoopJobState {
  /** Loop registry key (the harness sessionId) — also the de-dup key. */
  key: string
  goal: string
  cap: number
  /** Iterations already completed. */
  iteration: number
  workspaceRoot: string
}

/** Upper bound on a persisted loop's cap (matches the controller's own cap). */
const LOOP_JOB_MAX_CAP = 20

export type JobRunStatus = 'ok' | 'error' | 'blocked' | 'skipped'

export interface JobSchedule {
  type: ScheduleType
  /** `once`: absolute epoch ms of the single run. */
  at?: number
  /** `daily` / `weekly`: local time of day, 'HH:MM' (24h). */
  timeOfDay?: string
  /** `weekly`: 0 = Sunday … 6 = Saturday. */
  weekday?: number
  /** `interval`: minutes between runs (>= 1). */
  everyMinutes?: number
}

export interface ScheduledJob {
  id: string
  name: string
  target: JobTarget
  /** target 'flow': the saved flow's basename (`<name>.tachi-flow.json`). */
  flowFile?: string
  /** target 'prompt': the task text. target 'flow': optional canvas input. */
  prompt: string
  /** target 'loop': where to resume the loop from (see LoopJobState). */
  loop?: LoopJobState
  schedule: JobSchedule
  missedPolicy: MissedRunPolicy
  enabled: boolean
  createdAt: number
  /** Epoch ms of the next occurrence; null = nothing further to run. */
  nextRunAt: number | null
  lastRunAt?: number
  lastStatus?: JobRunStatus
  /** Short human-readable outcome (final text preview, error, or block reason). */
  lastDetail?: string
  lastDurationMs?: number
  runCount: number
}

/** The subset a caller (renderer form) may send; the store owns the rest. */
export interface ScheduledJobInput {
  id?: string
  name?: unknown
  target?: unknown
  flowFile?: unknown
  prompt?: unknown
  schedule?: unknown
  missedPolicy?: unknown
  enabled?: unknown
  loop?: unknown
}

/** Narrow an untrusted loop-resume blob, or explain what is wrong with it. */
export function validateLoopState(raw: unknown): { ok: true; loop: LoopJobState } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'Missing loop state.' }
  const l = raw as Record<string, unknown>
  const key = typeof l.key === 'string' ? l.key.trim() : ''
  if (!key) return { ok: false, error: 'The loop has no session key.' }
  const goal = typeof l.goal === 'string' ? l.goal.trim() : ''
  if (!goal) return { ok: false, error: 'The loop has no goal.' }
  const workspaceRoot = typeof l.workspaceRoot === 'string' ? l.workspaceRoot.trim() : ''
  if (!workspaceRoot) return { ok: false, error: 'The loop has no workspace.' }
  const capRaw = typeof l.cap === 'number' ? Math.trunc(l.cap) : Number.NaN
  const cap = Number.isFinite(capRaw) ? Math.max(1, Math.min(LOOP_JOB_MAX_CAP, capRaw)) : 5
  const iterRaw = typeof l.iteration === 'number' ? Math.trunc(l.iteration) : 0
  const iteration = Number.isFinite(iterRaw) ? Math.max(0, Math.min(cap, iterRaw)) : 0
  return { ok: true, loop: { key, goal: goal.slice(0, 8000), cap, iteration, workspaceRoot } }
}

/**
 * How late a fire may be and still count as "on time" rather than a MISSED run.
 * Generous enough to cover a busy tick + a slow machine, far below any real
 * sleep/close gap.
 */
export const MISSED_GRACE_MS = 90_000

/** Timer-wheel bounds. The ceiling is what makes a wake-from-sleep cheap. */
export const MAX_TICK_MS = 30_000
export const MIN_TICK_MS = 250

/** Interval jobs may not run hotter than this (protects the spend cap). */
export const MIN_INTERVAL_MINUTES = 5

// ── Parsing / validation ──────────────────────────────────────────────────────

/** 'HH:MM' → {h, m}, or null when malformed / out of range. */
export function parseTimeOfDay(raw: unknown): { h: number; m: number } | null {
  if (typeof raw !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return { h, m: min }
}

/** Normalize to 'HH:MM' with a leading zero (what the UI + storage use). */
export function formatTimeOfDay(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Validate an untrusted schedule blob. Returns the normalized schedule, or a
 * message explaining exactly what is wrong (surfaced verbatim in the UI).
 */
export function validateSchedule(raw: unknown): { ok: true; schedule: JobSchedule } | { ok: false; error: string } {
  if (raw === null || typeof raw !== 'object') return { ok: false, error: 'Missing schedule.' }
  const s = raw as Record<string, unknown>
  const type = s.type
  if (typeof type !== 'string' || !(SCHEDULE_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `Unknown schedule type "${String(type)}".` }
  }
  switch (type as ScheduleType) {
    case 'once': {
      const at = typeof s.at === 'number' ? s.at : Number.NaN
      if (!Number.isFinite(at)) return { ok: false, error: 'Pick a date and time for the one-off run.' }
      return { ok: true, schedule: { type: 'once', at: Math.round(at) } }
    }
    case 'daily': {
      const tod = parseTimeOfDay(s.timeOfDay)
      if (!tod) return { ok: false, error: 'Time of day must look like 07:30.' }
      return { ok: true, schedule: { type: 'daily', timeOfDay: formatTimeOfDay(tod.h, tod.m) } }
    }
    case 'weekly': {
      const tod = parseTimeOfDay(s.timeOfDay)
      if (!tod) return { ok: false, error: 'Time of day must look like 07:30.' }
      const wd = typeof s.weekday === 'number' ? Math.trunc(s.weekday) : Number.NaN
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) return { ok: false, error: 'Pick a weekday.' }
      return { ok: true, schedule: { type: 'weekly', timeOfDay: formatTimeOfDay(tod.h, tod.m), weekday: wd } }
    }
    case 'interval': {
      const mins = typeof s.everyMinutes === 'number' ? Math.trunc(s.everyMinutes) : Number.NaN
      if (!Number.isInteger(mins) || mins < MIN_INTERVAL_MINUTES) {
        return { ok: false, error: `Interval must be at least ${MIN_INTERVAL_MINUTES} minutes.` }
      }
      return { ok: true, schedule: { type: 'interval', everyMinutes: mins } }
    }
  }
}

/**
 * Validate a whole job payload from the renderer. `existing` (when editing)
 * supplies the immutable bookkeeping fields.
 */
export function validateJobInput(
  input: ScheduledJobInput,
  ctx: {
    now: number
    id: string
    existing?: ScheduledJob
    /** Skip the "one-off is in the past" check — set when REHYDRATING stored
     *  rows, where a fired one-off legitimately points at a past moment and
     *  must not be dropped from the list. */
    allowPast?: boolean
  },
): { ok: true; job: ScheduledJob } | { ok: false; error: string } {
  const target: JobTarget | null = (JOB_TARGETS as readonly string[]).includes(input.target as string)
    ? (input.target as JobTarget)
    : null
  if (!target) return { ok: false, error: 'Pick what to run: a saved flow or a prompt.' }

  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  const flowFile = typeof input.flowFile === 'string' ? input.flowFile.trim() : ''

  // target 'loop' is written by the loop controller, never by the job form: it
  // carries its own resume state and must round-trip through storage intact.
  let loop: LoopJobState | undefined
  if (target === 'loop') {
    const parsedLoop = validateLoopState(input.loop)
    if (!parsedLoop.ok) return { ok: false, error: parsedLoop.error }
    loop = parsedLoop.loop
  }

  if (target === 'flow') {
    // Basename only — the executor joins this into the flows dir, so a path
    // separator here would be a traversal primitive.
    if (!flowFile) return { ok: false, error: 'Pick a saved flow to run.' }
    if (/[/\\]/.test(flowFile) || !flowFile.endsWith('.tachi-flow.json')) {
      return { ok: false, error: 'That is not a saved flow file.' }
    }
  } else if (!prompt) {
    return { ok: false, error: 'Write the prompt the agent should run.' }
  }

  const sched = validateSchedule(input.schedule)
  if (!sched.ok) return sched

  // A one-off already in the past would save as a job that can never fire.
  if (!ctx.allowPast && sched.schedule.type === 'once' && (sched.schedule.at ?? 0) <= ctx.now) {
    return { ok: false, error: 'That moment has already passed — pick a time in the future.' }
  }

  const nameRaw = typeof input.name === 'string' ? input.name.trim() : ''
  const name = (nameRaw || (target === 'flow' ? flowFile.replace(/\.tachi-flow\.json$/, '') : prompt)).slice(0, 120)

  const missedPolicy: MissedRunPolicy = input.missedPolicy === 'skip' ? 'skip' : 'run'
  const enabled = input.enabled !== false

  const job: ScheduledJob = {
    id: ctx.existing?.id ?? ctx.id,
    name: name || 'Scheduled job',
    target,
    ...(target === 'flow' ? { flowFile } : {}),
    ...(loop ? { loop } : {}),
    prompt: prompt.slice(0, 8000),
    schedule: sched.schedule,
    missedPolicy,
    enabled,
    createdAt: ctx.existing?.createdAt ?? ctx.now,
    nextRunAt: enabled ? computeNextRun(sched.schedule, ctx.now) : null,
    ...(ctx.existing?.lastRunAt !== undefined ? { lastRunAt: ctx.existing.lastRunAt } : {}),
    ...(ctx.existing?.lastStatus !== undefined ? { lastStatus: ctx.existing.lastStatus } : {}),
    ...(ctx.existing?.lastDetail !== undefined ? { lastDetail: ctx.existing.lastDetail } : {}),
    ...(ctx.existing?.lastDurationMs !== undefined ? { lastDurationMs: ctx.existing.lastDurationMs } : {}),
    runCount: ctx.existing?.runCount ?? 0,
  }
  return { ok: true, job }
}

/** Narrow one parsed JSON row to a ScheduledJob, or null when unusable. */
export function asJob(v: unknown): ScheduledJob | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const validated = validateJobInput(o as ScheduledJobInput, {
    now: typeof o.createdAt === 'number' ? o.createdAt : Date.now(),
    id: o.id,
    allowPast: true,
  })
  if (!validated.ok) return null
  const job = validated.job
  // Restore the bookkeeping fields validateJobInput can't know about.
  if (typeof o.createdAt === 'number') job.createdAt = o.createdAt
  // An explicit null means "spent" (a fired `once` job) and MUST survive the
  // round-trip — falling back to the recomputed value would resurrect it.
  job.nextRunAt = o.nextRunAt === null ? null
    : typeof o.nextRunAt === 'number' ? o.nextRunAt
      : job.nextRunAt
  if (typeof o.lastRunAt === 'number') job.lastRunAt = o.lastRunAt
  if (typeof o.lastStatus === 'string' && ['ok', 'error', 'blocked', 'skipped'].includes(o.lastStatus)) {
    job.lastStatus = o.lastStatus as JobRunStatus
  }
  if (typeof o.lastDetail === 'string') job.lastDetail = o.lastDetail
  if (typeof o.lastDurationMs === 'number') job.lastDurationMs = o.lastDurationMs
  if (typeof o.runCount === 'number') job.runCount = o.runCount
  return job
}

// ── Recurrence math ───────────────────────────────────────────────────────────

/**
 * The first occurrence STRICTLY AFTER `fromMs`, or null when the schedule has
 * no future occurrence (a `once` job whose moment has passed).
 *
 * daily/weekly walk calendar fields (setDate + setHours) rather than adding
 * 86_400_000, so the local hour survives a DST transition.
 */
export function computeNextRun(schedule: JobSchedule, fromMs: number): number | null {
  switch (schedule.type) {
    case 'once': {
      const at = schedule.at
      return typeof at === 'number' && at > fromMs ? at : null
    }
    case 'interval': {
      const mins = Math.max(MIN_INTERVAL_MINUTES, schedule.everyMinutes ?? MIN_INTERVAL_MINUTES)
      return fromMs + mins * 60_000
    }
    case 'daily': {
      const tod = parseTimeOfDay(schedule.timeOfDay)
      if (!tod) return null
      const d = new Date(fromMs)
      d.setHours(tod.h, tod.m, 0, 0)
      if (d.getTime() <= fromMs) {
        d.setDate(d.getDate() + 1)
        d.setHours(tod.h, tod.m, 0, 0)
      }
      return d.getTime()
    }
    case 'weekly': {
      const tod = parseTimeOfDay(schedule.timeOfDay)
      if (!tod) return null
      const weekday = schedule.weekday ?? 0
      const d = new Date(fromMs)
      d.setHours(tod.h, tod.m, 0, 0)
      let delta = (weekday - d.getDay() + 7) % 7
      if (delta === 0 && d.getTime() <= fromMs) delta = 7
      d.setDate(d.getDate() + delta)
      d.setHours(tod.h, tod.m, 0, 0)
      return d.getTime()
    }
  }
}

// ── Missed-run decision table ─────────────────────────────────────────────────

export type TickAction = 'idle' | 'wait' | 'run' | 'skip'

export interface TickDecision {
  action: TickAction
  /** True when the occurrence came due while nothing was watching. */
  missed: boolean
  /** Where nextRunAt should land after acting on this decision. */
  nextRunAt: number | null
  reason: string
}

/**
 * The whole policy, in one place:
 *
 *   job state                            → action
 *   ───────────────────────────────────────────────────────────────────────────
 *   paused (enabled === false)           → idle   (never fires while paused)
 *   nextRunAt === null                   → idle   (a spent `once` job)
 *   nextRunAt in the future              → wait
 *   due within MISSED_GRACE_MS           → run    (a normal, on-time fire)
 *   overdue, missedPolicy === 'run'      → run    (run-on-wake catch-up — ONE
 *                                                  run, however many were
 *                                                  missed; we never stampede)
 *   overdue, missedPolicy === 'skip'     → skip   (roll forward to the next
 *                                                  future occurrence)
 */
export function decideRun(job: ScheduledJob, nowMs: number, graceMs = MISSED_GRACE_MS): TickDecision {
  if (!job.enabled) {
    return { action: 'idle', missed: false, nextRunAt: job.nextRunAt, reason: 'paused' }
  }
  if (job.nextRunAt === null || !Number.isFinite(job.nextRunAt)) {
    return { action: 'idle', missed: false, nextRunAt: null, reason: 'no further occurrence' }
  }
  if (job.nextRunAt > nowMs) {
    return { action: 'wait', missed: false, nextRunAt: job.nextRunAt, reason: 'not due yet' }
  }
  const lateByMs = nowMs - job.nextRunAt
  if (lateByMs <= graceMs) {
    return { action: 'run', missed: false, nextRunAt: job.nextRunAt, reason: 'due' }
  }
  if (job.missedPolicy === 'run') {
    return { action: 'run', missed: true, nextRunAt: job.nextRunAt, reason: 'missed run — catching up on wake' }
  }
  return {
    action: 'skip',
    missed: true,
    nextRunAt: computeNextRun(job.schedule, nowMs),
    reason: 'missed run skipped by policy',
  }
}

/**
 * The bookkeeping patch to apply once a run finishes. A `once` job pauses itself
 * (kept in the list so its last-run readout stays visible); recurring jobs roll
 * forward from NOW — never from the missed slot — so a long sleep can only ever
 * produce a single catch-up run.
 */
export function afterRunPatch(job: ScheduledJob, nowMs: number): Partial<ScheduledJob> {
  if (job.schedule.type === 'once') {
    return { nextRunAt: null, enabled: false, lastRunAt: nowMs, runCount: job.runCount + 1 }
  }
  return { nextRunAt: computeNextRun(job.schedule, nowMs), lastRunAt: nowMs, runCount: job.runCount + 1 }
}

/**
 * Delay until the next tick: the soonest due job, clamped to the wheel bounds.
 *
 * IDLE HONESTY (lane V): with NOTHING armed, the 30s ceiling bought nothing and
 * cost two synchronous `readFileSync` + `JSON.parse` of scheduler-jobs.json per
 * cycle forever (`arm()` derives the delay from listJobs(), then `tick()` reads
 * the list again) — ~5.7k disk reads a day on a machine that has never created
 * a job, which is the overwhelmingly common case. The ceiling exists to make
 * wake-from-sleep cheap for a job that IS armed, so it still applies the moment
 * `soonest` is finite; the empty set falls through to a far lazier idle tick.
 *
 * This can never delay a real job: every mutation path (upsert / remove /
 * setEnabled in scheduler-service) calls refreshScheduler() → arm(0), and
 * powerMonitor 'resume'/'unlock-screen' do the same, so the wheel re-derives
 * the instant a job comes into existence rather than waiting for a tick.
 */
export const IDLE_TICK_MS = 5 * 60_000

export function nextTickDelay(jobs: readonly ScheduledJob[], nowMs: number): number {
  let soonest = Number.POSITIVE_INFINITY
  for (const j of jobs) {
    if (!j.enabled || j.nextRunAt === null) continue
    if (j.nextRunAt < soonest) soonest = j.nextRunAt
  }
  // Nothing armed — no job can become due without a refresh() that re-arms us.
  if (!Number.isFinite(soonest)) return IDLE_TICK_MS
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, soonest - nowMs))
}

// ── Timer wheel ───────────────────────────────────────────────────────────────

export interface SchedulerEngineDeps {
  now: () => number
  listJobs: () => ScheduledJob[]
  /** Persist a partial update for one job (store owns the write). */
  patchJob: (id: string, patch: Partial<ScheduledJob>) => void
  /** Execute one job. MUST resolve (never reject) — the wheel does not retry. */
  runJob: (job: ScheduledJob) => Promise<void>
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * A self-rearming wheel over the persisted jobs. One timer for the whole set —
 * recomputed after every tick — instead of one timer per job, so job edits,
 * clock jumps and wake-from-sleep all converge on the same re-derivation.
 */
export class SchedulerEngine {
  private handle: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  /** Serializes runs: a scheduled job never overlaps another scheduled job. */
  private ticking = false

  constructor(private deps: SchedulerEngineDeps) {}

  private get setTimer(): (fn: () => void, ms: number) => ReturnType<typeof setTimeout> {
    return this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  }

  private get clearTimer(): (h: ReturnType<typeof setTimeout>) => void {
    return this.deps.clearTimer ?? ((h) => clearTimeout(h))
  }

  /** True while a scheduled run is in flight. */
  get busy(): boolean {
    return this.ticking
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.arm(0)
  }

  stop(): void {
    this.stopped = true
    if (this.handle !== null) {
      this.clearTimer(this.handle)
      this.handle = null
    }
  }

  /** Re-derive immediately — after a job edit, or on powerMonitor 'resume'. */
  refresh(): void {
    if (this.stopped) return
    this.arm(0)
  }

  private arm(delayMs?: number): void {
    if (this.stopped) return
    if (this.handle !== null) {
      this.clearTimer(this.handle)
      this.handle = null
    }
    const delay = delayMs ?? nextTickDelay(this.deps.listJobs(), this.deps.now())
    this.handle = this.setTimer(() => {
      this.handle = null
      void this.tick().finally(() => this.arm())
    }, Math.max(0, delay))
  }

  /**
   * One pass over every job. Exposed for tests (and for a forced catch-up on
   * boot) — safe to call directly; overlapping calls are dropped.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const job of this.deps.listJobs()) {
        if (this.stopped) return
        // Re-read `now` per job: a long-running job can push the next one past
        // its own due time, and that next one must see the real clock.
        const decision = decideRun(job, this.deps.now())
        if (decision.action === 'skip') {
          this.deps.patchJob(job.id, {
            nextRunAt: decision.nextRunAt,
            lastStatus: 'skipped',
            lastDetail: decision.reason,
          })
          continue
        }
        if (decision.action !== 'run') continue
        await this.deps.runJob(job)
      }
    } finally {
      this.ticking = false
    }
  }
}
