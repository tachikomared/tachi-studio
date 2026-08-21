// apps/desktop/electron/services/scheduler-service.ts
//
// The local, offline scheduler (USER-PAINS #9 / T14 — "the 2am build never
// fires"). Electron-coupled half: persistence path, the timer wheel's lifecycle,
// powerMonitor wake handling, and the actual EXECUTION of a due job.
//
// EXECUTION REUSES EXISTING RUN PATHS — it never forks run logic:
//   target 'flow'   → runGraphFlowHeadless() in ipc/graph.ipc.ts, i.e. the exact
//                     code path the canvas's Run-flow button uses (private-mode
//                     provider/internet/MCP guards included), minus the
//                     "which node is active" stream.
//   target 'prompt' → runTachiSession() in services/tachi/loop.ts, composed like
//                     the swarm executor's and Telegram's headless paths.
//
// UNATTENDED SAFETY (nobody is watching a 2am run):
//   - the 30-day spend cap (llmBudgetUsd30d + cost-ledger) is checked BEFORE a
//     job starts; over-cap jobs are recorded as 'blocked' and roll forward
//     instead of burning the budget at 5-minute intervals;
//   - prompt jobs run behind the same two-stage gate as the swarm/Telegram
//     paths: checkAgentToolEgress (PRIVATE-MODE egress) then
//     classifyUnattendedTool (destructive shell + protected-path writes are
//     hard-denied because there is no human to prompt);
//   - flow jobs execute agent-kit tools built by graph-tools.ts, which already
//     enforces the same catastrophic-command denylist, the egress policy and a
//     workspace-root path sandbox on every file tool.
//
// RESULTS ARE VISIBLE: every attempt appends to the shared run-log (the same
// JSONL that backs the Recent-Runs readout), fires an OS notification, and
// updates the job's last-run / next-run readout in Settings.

import { app, powerMonitor, type BrowserWindow } from 'electron'
import { join } from 'node:path'

import {
  SchedulerEngine,
  afterRunPatch,
  computeNextRun,
  type JobRunStatus,
  type LoopJobState,
  type ScheduledJob,
  type ScheduledJobInput,
} from './scheduler-core'
import { SchedulerStore } from './scheduler-store'
import { loadSettings } from './settings-store'
import { getCostLedger } from './cost-ledger'
import { getRunLog } from './run-log'
import { notifyTaskDone } from './notifications'
import { getStorageRoot } from './storage-root'
import { checkAgentToolEgress } from './egress-policy'
import { classifyUnattendedTool } from './unattended-gate'
import { getCurrentPrivacyMode } from '../ipc/privacy.ipc'

const DAY_MS = 86_400_000
/** A scheduled run is capped so a runaway agent cannot hold the wheel forever. */
const JOB_TIMEOUT_MS = 20 * 60_000
/** How much of the final answer is kept for the last-run readout. */
const DETAIL_MAX = 600

let store: SchedulerStore | null = null
let engine: SchedulerEngine | null = null
let win: BrowserWindow | null = null
let powerHooked = false
/** Set while a MANUAL "run now" is in flight — the wheel yields to it. */
let manualRunInFlight = false

/** Lazy singleton — userData is only known after app ready. */
export function getSchedulerStore(): SchedulerStore {
  if (!store) store = new SchedulerStore(join(app.getPath('userData'), 'scheduler-jobs.json'))
  return store
}

function broadcast(): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  try { win.webContents.send('scheduler:changed', { jobs: getSchedulerStore().list() }) } catch { /* window gone */ }
}

// ── Execution ─────────────────────────────────────────────────────────────────

interface RunOutcome {
  status: JobRunStatus
  detail: string
}

/** The 30-day spend cap, checked before a job starts (0 = no cap). */
function budgetBlock(): string | null {
  try {
    const { llmBudgetUsd30d } = loadSettings()
    if (!(llmBudgetUsd30d > 0)) return null
    const spent = getCostLedger().spendUsdSince(Date.now() - 30 * DAY_MS)
    if (spent < llmBudgetUsd30d) return null
    return `30-day LLM spend ($${spent.toFixed(2)}) has reached the budget cap ($${llmBudgetUsd30d.toFixed(2)}). The scheduled run was skipped — raise the cap in Settings.`
  } catch {
    // A missing/unreadable ledger must not silently disable the cap OR block
    // every run; fall through to running (identical to chat/tachi behaviour).
    return null
  }
}

/** Run a saved flow through the canvas's own runtime. */
async function runFlowJob(job: ScheduledJob): Promise<RunOutcome> {
  const { readSavedFlowJson } = await import('../ipc/nodes.ipc')
  const read = readSavedFlowJson(job.flowFile ?? '')
  if (!read.ok) return { status: 'error', detail: `Could not load the flow: ${read.error}` }

  let flow: unknown
  try {
    flow = JSON.parse(read.json)
  } catch (err) {
    return { status: 'error', detail: `The saved flow is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }

  const { runGraphFlowHeadless } = await import('../ipc/graph.ipc')
  const res = await runGraphFlowHeadless({ flow, input: job.prompt })
  if (!res.ok) return { status: 'error', detail: res.error }
  const final = (res.final || '').trim()
  return { status: 'ok', detail: final || '(the flow finished without a text answer)' }
}

/** Run a prompt through the TACHI harness, gated for unattended execution. */
async function runPromptJob(job: ScheduledJob, signal: AbortSignal): Promise<RunOutcome> {
  const workspace = getStorageRoot()
  const denials: string[] = []
  const gate = async (name: string, input: Record<string, unknown>): Promise<boolean> => {
    const egress = checkAgentToolEgress(name, input)
    if (!egress.allowed) { denials.push(`${name}: ${egress.reason ?? 'egress denied'}`); return false }
    const u = classifyUnattendedTool(name, input, { workingDir: workspace })
    if (!u.allowed) { denials.push(`${name}: ${u.reason ?? 'unattended-denied'}`); return false }
    return true
  }

  let finalText = ''
  let failure = ''
  try {
    const { runTachiSession } = await import('./tachi/loop')
    await runTachiSession({
      workspaceRoot: workspace,
      task: job.prompt,
      signal,
      onEvent: (e) => {
        if (e.type === 'text' && typeof e.text === 'string') finalText += e.text
        if (e.type === 'error' && typeof e.message === 'string' && !failure) failure = e.message
      },
      gate,
      privateMode: getCurrentPrivacyMode() === 'private',
    })
  } catch (err) {
    return { status: 'error', detail: err instanceof Error ? err.message : String(err) }
  }

  const answer = finalText.trim()
  const denialNote = denials.length
    ? ` (${denials.length} action(s) blocked by the unattended-safety gate)`
    : ''
  if (!answer && failure) return { status: 'error', detail: failure + denialNote }
  return { status: 'ok', detail: (answer || '(the agent finished without a text answer)') + denialNote }
}

// ── Loop-mode persistence (the harness's /loop, surviving a restart) ─────────
//
// A loop-mode harness run is stored as a ONE-OFF job a couple of minutes in the
// future, rewritten after every iteration (so while the app lives the moment
// keeps sliding forward and the job never fires) and deleted when the loop ends
// on its own terms. If the app dies mid-loop the job is overdue on the next
// boot and the missed-run policy resumes it — a loop survives a restart exactly
// like any scheduled job. runLoopJob refuses to start a loop that is still live
// in this process, so the wheel and a running loop can never double-run.

/** How far ahead a live loop parks its resume job. */
const LOOP_RESUME_DELAY_MS = 3 * 60_000

/**
 * The stored resume job for one loop key, if any. The store mints its own ids
 * (a caller-supplied id only selects an EXISTING row), so a loop is identified
 * by its key and the id is looked up — that is what keeps `persist` idempotent
 * instead of appending a new row every iteration.
 */
function findLoopJob(key: string): ScheduledJob | null {
  try {
    return getSchedulerStore().list().find(j => j.target === 'loop' && j.loop?.key === key) ?? null
  } catch { return null }
}

/** Write (or refresh) the resume job for a live loop. Best-effort. */
export function persistLoopJob(state: LoopJobState): void {
  try {
    const existing = findLoopJob(state.key)
    getSchedulerStore().upsert({
      ...(existing ? { id: existing.id } : {}),
      name: `Loop: ${state.goal.split('\n')[0].slice(0, 80)}`,
      target: 'loop',
      prompt: state.goal,
      loop: state,
      schedule: { type: 'once', at: Date.now() + LOOP_RESUME_DELAY_MS },
      missedPolicy: 'run',
      enabled: true,
    })
    broadcast()
  } catch { /* a loop that can't persist still runs — it just won't survive a restart */ }
}

/** Drop a loop's resume job (the loop ended). Best-effort. */
export function clearLoopJob(key: string): void {
  try {
    const existing = findLoopJob(key)
    if (existing && getSchedulerStore().remove(existing.id)) broadcast()
  } catch { /* nothing persisted */ }
}

/** Resume a loop that outlived the app, under the unattended-safety gate. */
async function runLoopJob(job: ScheduledJob, signal: AbortSignal): Promise<RunOutcome> {
  const loop = job.loop
  if (!loop) return { status: 'error', detail: 'This loop job has no resume state.' }

  const { isLoopLive } = await import('./tachi/loop-controller')
  if (isLoopLive(loop.key)) {
    return { status: 'skipped', detail: 'That loop is still running in this session — the resume job stood down.' }
  }
  if (loop.iteration >= loop.cap) {
    return { status: 'skipped', detail: `The loop already ran its ${loop.cap} iteration(s).` }
  }

  const workspace = loop.workspaceRoot || getStorageRoot()
  const denials: string[] = []
  const gate = async (name: string, input: Record<string, unknown>): Promise<boolean> => {
    const egress = checkAgentToolEgress(name, input)
    if (!egress.allowed) { denials.push(`${name}: ${egress.reason ?? 'egress denied'}`); return false }
    const u = classifyUnattendedTool(name, input, { workingDir: workspace })
    if (!u.allowed) { denials.push(`${name}: ${u.reason ?? 'unattended-denied'}`); return false }
    return true
  }

  let finalText = ''
  let failure = ''
  try {
    const { runTachiSession } = await import('./tachi/loop')
    await runTachiSession({
      workspaceRoot: workspace,
      task: loop.goal,
      loop: { goal: loop.goal, cap: loop.cap, startIteration: loop.iteration },
      loopKey: loop.key,
      signal,
      onEvent: (e) => {
        if (e.type === 'text' && typeof e.text === 'string') finalText += e.text
        if (e.type === 'error' && typeof e.message === 'string' && !failure) failure = e.message
      },
      gate,
      privateMode: getCurrentPrivacyMode() === 'private',
    })
  } catch (err) {
    return { status: 'error', detail: err instanceof Error ? err.message : String(err) }
  }

  const denialNote = denials.length ? ` (${denials.length} action(s) blocked by the unattended-safety gate)` : ''
  const answer = finalText.trim()
  if (!answer && failure) return { status: 'error', detail: failure + denialNote }
  return { status: 'ok', detail: (answer || '(the loop resumed and finished without a text answer)') + denialNote }
}

/**
 * Execute one job end-to-end: gate, run, record, notify, roll the schedule
 * forward. NEVER throws — the wheel must keep turning whatever a job does.
 *
 * `rollSchedule` is false for a manual RUN NOW: testing a job must not consume
 * its one-off occurrence or shift a daily job's slot.
 */
export async function executeJob(job: ScheduledJob, opts?: { rollSchedule?: boolean }): Promise<RunOutcome> {
  const started = Date.now()
  let outcome: RunOutcome

  const blocked = budgetBlock()
  if (blocked) {
    outcome = { status: 'blocked', detail: blocked }
  } else {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), JOB_TIMEOUT_MS)
    try {
      outcome = job.target === 'flow'
        ? await runFlowJob(job)
        : job.target === 'loop'
          ? await runLoopJob(job, ctrl.signal)
          : await runPromptJob(job, ctrl.signal)
    } catch (err) {
      outcome = { status: 'error', detail: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  const durationMs = Date.now() - started
  const detail = outcome.detail.slice(0, DETAIL_MAX)

  // Durable run history — same JSONL the interactive harness writes to.
  try {
    getRunLog().record({
      task: `[scheduled] ${job.name}`,
      harness: job.target === 'flow' ? 'scheduler:flow' : job.target === 'loop' ? 'scheduler:loop' : 'scheduler:prompt',
      workingDir: getStorageRoot(),
      outcome: outcome.status === 'ok' ? 'done' : outcome.status === 'blocked' ? 'abort' : 'error',
      durationMs,
      ...(outcome.status === 'ok' ? {} : { error: detail }),
    })
  } catch { /* history is best-effort — never fail a finished run over it */ }

  // A resumed LOOP re-persists its own row between iterations. When the stored
  // resume state has moved past the one this run started from, that fresh row IS
  // the schedule — spending the one-off here (enabled:false, nextRunAt:null)
  // would strand a loop that is still making progress.
  const loopAdvanced = job.target === 'loop' && (() => {
    try {
      const fresh = getSchedulerStore().get(job.id)
      return !!fresh?.loop && !!job.loop && fresh.loop.iteration > job.loop.iteration
    } catch { return false }
  })()

  // Persist the readout + (for a scheduled fire) roll forward from NOW.
  try {
    getSchedulerStore().patch(job.id, {
      ...(opts?.rollSchedule === false || loopAdvanced ? { lastRunAt: Date.now() } : afterRunPatch(job, Date.now())),
      lastStatus: outcome.status,
      lastDetail: detail,
      lastDurationMs: durationMs,
    })
  } catch { /* a failed write must not swallow the notification below */ }

  try {
    notifyTaskDone(
      outcome.status === 'ok' ? `Scheduled run finished: ${job.name}` : `Scheduled run ${outcome.status}: ${job.name}`,
      detail.slice(0, 220),
    )
  } catch { /* notifications are best-effort */ }

  broadcast()
  return outcome
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Boot the scheduler: re-derive every job's next occurrence from the persisted
 * state, arm the wheel, and re-derive again whenever the OS says we just woke
 * up. Safe to call once from app.whenReady().
 */
export function initScheduler(window: BrowserWindow | null): void {
  win = window
  // Idempotent: createWindow() runs again on macOS 'activate', and a second
  // wheel would leave the first one's timer orphaned.
  if (engine) { engine.refresh(); return }
  const s = getSchedulerStore()

  // Boot repair: a job whose nextRunAt is missing (hand-edited file, an older
  // build, or a `once` job restored without one) gets a fresh occurrence so it
  // can never sit idle forever.
  const now = Date.now()
  for (const job of s.list()) {
    if (!job.enabled) continue
    if (job.nextRunAt === null && job.schedule.type !== 'once') {
      s.patch(job.id, { nextRunAt: computeNextRun(job.schedule, now) })
    }
  }

  engine = new SchedulerEngine({
    now: () => Date.now(),
    listJobs: () => getSchedulerStore().list(),
    patchJob: (id, patch) => { try { getSchedulerStore().patch(id, patch); broadcast() } catch { /* ignore */ } },
    // Yield to a manual run: the occurrence stays due and fires on the next
    // tick rather than racing the user's own RUN NOW.
    runJob: async (job) => { if (manualRunInFlight) return; await executeJob(job) },
  })
  engine.start()

  if (!powerHooked) {
    powerHooked = true
    // Wake-from-sleep: timers that should have fired during suspend either
    // never fired or fire late, so force an immediate re-derivation. Same for
    // an unlocked screen (a laptop lid re-open often reports only this).
    powerMonitor.on('resume', () => { engine?.refresh() })
    powerMonitor.on('unlock-screen', () => { engine?.refresh() })
  }
}

export function stopScheduler(): void {
  engine?.stop()
  engine = null
}

/** Re-arm after a job was created / edited / paused from the UI. */
export function refreshScheduler(): void {
  engine?.refresh()
}

/** True while any run (wheel or manual) is in flight — the UI greys out RUN NOW. */
export function schedulerBusy(): boolean {
  return manualRunInFlight || (engine?.busy ?? false)
}

// ── Operations used by the IPC layer ──────────────────────────────────────────

export function listJobs(): ScheduledJob[] {
  return getSchedulerStore().list()
}

export function saveJob(input: ScheduledJobInput): { ok: true; job: ScheduledJob } | { ok: false; error: string } {
  const res = getSchedulerStore().upsert(input)
  if (res.ok) { refreshScheduler(); broadcast() }
  return res
}

export function deleteJob(id: string): { ok: boolean } {
  const removed = getSchedulerStore().remove(id)
  if (removed) { refreshScheduler(); broadcast() }
  return { ok: removed }
}

export function setJobEnabled(id: string, enabled: boolean): { ok: boolean; job?: ScheduledJob } {
  const job = getSchedulerStore().setEnabled(id, enabled)
  if (job) { refreshScheduler(); broadcast() }
  return job ? { ok: true, job } : { ok: false }
}

/** Manual "run it now" — the same execution path, off-schedule. */
export async function runJobNow(id: string): Promise<{ ok: boolean; status?: JobRunStatus; detail?: string; error?: string }> {
  const job = getSchedulerStore().get(id)
  if (!job) return { ok: false, error: 'That scheduled job no longer exists.' }
  if (schedulerBusy()) return { ok: false, error: 'A scheduled run is already in flight — try again when it finishes.' }
  manualRunInFlight = true
  try {
    const outcome = await executeJob(job, { rollSchedule: false })
    return { ok: outcome.status === 'ok', status: outcome.status, detail: outcome.detail }
  } finally {
    manualRunInFlight = false
  }
}
