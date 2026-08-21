// apps/desktop/src/components/activity/activityBridge.ts
//
// THE RAIL'S SUBSCRIPTIONS HAVE TO OUTLIVE EVERY PAGE — the same lesson
// mediaProgressBridge is named after, applied to the operations that never got
// it: engine installs, the Design MP4 export, and the model-weights migration.
//
// Each of those already pushes progress on its own IPC channel. Nothing here
// invents a channel, opens a socket or arms a timer: it attaches ONE listener
// per existing channel, once, for the life of the app, and writes what the
// producer said into activity.store. The pages keep their own rich inline
// progress — they read the same channels; the rail is simply a second listener
// that is never unmounted.
//
// ── WHY SOME PRODUCERS ARE ABSENT (deliberate, not forgotten) ────────────────
//
// A rail row must have a TERMINAL event or it sticks at N% forever, and it must
// not double-render work the download manager already owns. That rules three
// channels out for now, and each is a one-line fix in main, not here:
//
//   • whisper (`whisper:install-progress`) emits `stage:'downloading'` for BOTH
//     the whisper-cli binary AND the managed ggml model download. The model's
//     bytes already render as a download row (whisper-installer adopts the
//     managed task), so a rail row keyed off that stage would show the same
//     transfer twice — and telling them apart by MESSAGE text would be a
//     heuristic, which is exactly the class of guess this rail exists to remove.
//   • yt-dlp (`yt-dlp:install-progress`) never emits an error stage — every
//     failure path throws without pushing, so a failed install would leave a
//     row running forever.
//   • codex / claude-code-router / sidecar / openclaude use a different
//     `step`-shaped vocabulary whose terminal coverage is unverified.
//
// sd.cpp, piper and llama.cpp all push `stage:'error'` on every failure path
// (verified against each installer) and use a stage vocabulary that separates
// the ENGINE BINARY download (theirs) from the MODEL/VOICE download (the
// download manager's) — which is what MANAGED_STAGES below keys off.
//
// ── AND WHEN A ROW SETTLES, THE OS SAYS SO ───────────────────────────────────
//
// A row is only a report for someone looking at this window. `notification:show`
// shipped with zero callers, so an install or an interpolation that finished
// while the user was in another app said nothing at all. Every settle here now
// goes through `announceSettle` → activityNotify, which fires at most ONE native
// toast and only when the window is unfocused. It obeys the same admission rule
// as the rows: a terminal event for a row that was never open announces nothing.

import { useActivityStore } from '../../store/activity.store'
import type { ActivityCounts, ActivityTaskKind } from '../../store/activity.store'
import { notifySettle, type SettleNotifyKind, type SettleNotifyStatus } from './activityNotify'

/** The normalized shape every install channel collapses to. */
export interface NormalizedInstallEvent {
  stage: string
  message: string
  percent: number
  bytes?: { received: number; total: number; speedBytesPerSec?: number; etaSec?: number }
}

/**
 * Stages whose BYTES are owned by the main-process download manager (the
 * installer adopts a managed task for them). The rail must stay silent for the
 * whole of such a transfer — the download row is the single truth for it.
 */
export const MANAGED_STAGES: readonly string[] = ['downloading-model', 'downloading-voice']

/** Stages that end the operation. */
export const TERMINAL_STAGES: readonly string[] = ['done', 'error', 'aborted', 'cancelled']

/**
 * One shape out of two vocabularies (`stage` on the newer installers, `step` on
 * the older ones) plus a defensive read of everything else. Returns null for
 * anything that is not an object with a readable stage — a stale preload or a
 * future event shape must be a silent no-op, never a row with a blank name.
 */
export function normalizeInstallEvent(raw: unknown): NormalizedInstallEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const stageRaw = typeof e.stage === 'string' ? e.stage : typeof e.step === 'string' ? e.step : null
  if (!stageRaw) return null
  const percent = typeof e.percent === 'number' && Number.isFinite(e.percent) && e.percent >= 0
    ? Math.min(100, Math.round(e.percent))
    : -1
  const received = typeof e.bytes === 'number' && Number.isFinite(e.bytes) ? e.bytes : null
  const total = typeof e.totalBytes === 'number' && Number.isFinite(e.totalBytes) ? e.totalBytes : null
  const out: NormalizedInstallEvent = {
    stage: stageRaw,
    message: typeof e.message === 'string' ? e.message : '',
    percent,
  }
  if (received !== null) {
    out.bytes = {
      received,
      total: total ?? 0,
      speedBytesPerSec: typeof e.speedBytesPerSec === 'number' ? e.speedBytesPerSec : undefined,
      etaSec: typeof e.etaSec === 'number' ? e.etaSec : undefined,
    }
  }
  return out
}

/** The migration event, as `model-storage:migrate-progress` sends it. */
export interface NormalizedMigrateEvent {
  engine: string
  phase: string
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  message: string
  error?: string
}

export function normalizeMigrateEvent(raw: unknown): NormalizedMigrateEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.engine !== 'string' || typeof e.phase !== 'string') return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    engine: e.engine,
    phase: e.phase,
    filesDone: num(e.filesDone),
    filesTotal: num(e.filesTotal),
    bytesDone: num(e.bytesDone),
    bytesTotal: num(e.bytesTotal),
    message: typeof e.message === 'string' ? e.message : '',
    error: typeof e.error === 'string' ? e.error : undefined,
  }
}

// ── the wiring ───────────────────────────────────────────────────────────────

type Unsub = () => void
interface ProgressChannel { onInstallProgress?(cb: (e: unknown) => void): Unsub }

/** Just the slice of `window.tachi` this needs, so a test can hand over a fake. */
export interface ActivityBridgeSources {
  sdCpp?: ProgressChannel
  piper?: ProgressChannel
  llamaCpp?: ProgressChannel
  design?: { onRenderProgress?(cb: (p: unknown) => void): Unsub }
  modelStorage?: { onMigrateProgress?(cb: (e: unknown) => void): Unsub }
  rife?: ProgressChannel & { onProgress?(cb: (p: unknown) => void): Unsub }
}

/** Engine-install channels the rail watches, with the row identity each gets. */
export const ENGINE_CHANNELS: ReadonlyArray<{
  source: 'sdCpp' | 'piper' | 'llamaCpp' | 'rife'
  id: string
  /** The engine's OWN name — a proper noun, so it is not translated. */
  label: string
  surface: string
}> = [
  { source: 'sdCpp',    id: 'engine:sdcpp',    label: 'stable-diffusion.cpp', surface: '/catalog' },
  { source: 'piper',    id: 'engine:piper',    label: 'piper',                surface: '/catalog' },
  { source: 'llamaCpp', id: 'engine:llamacpp', label: 'llama.cpp',            surface: '/catalog' },
  // rife qualifies on the rail's OWN admission test (see the header): it pushes
  // a terminal 'done'/'error' on every exit path, and none of its stages are
  // owned by the download manager — the 431 MB engine zip takes the direct
  // installer path, so those bytes have no download row to double.
  { source: 'rife',     id: 'engine:rife',     label: 'rife-ncnn-vulkan',     surface: '/media' },
]

// Per-channel suppression: once a channel starts reporting a MANAGED transfer,
// every event on it is ignored until the next terminal one. Without this, the
// `verifying` tick that a model download emits mid-transfer would open a rail
// row for bytes the download manager is already showing.
const suppressed = new Set<string>()

type ActivityStoreState = ReturnType<typeof useActivityStore.getState>

/** The rail's four terminal stage words, as the notify seam's three statuses. */
function settleStatus(stage: string): SettleNotifyStatus {
  return stage === 'error' ? 'failed' : stage === 'done' ? 'completed' : 'cancelled'
}

/**
 * WAS THIS ROW ACTUALLY BEING WATCHED?
 *
 * The store's own admission rule (`settleTask` is a no-op for an id it has never
 * seen) is what keeps an installer's "already on disk" fast path from
 * conjuring a finished row — and the completion toast has to obey the SAME rule
 * or the app would announce work that never appeared. Returns the row's start
 * so the toast can report a real duration rather than a guessed one.
 */
function watchedRow(store: ActivityStoreState, id: string): { startedAt: number } | null {
  const tasks = Array.isArray(store?.tasks) ? store.tasks : []
  const t = tasks.find(x => x && x.id === id && x.status === 'running')
  return t ? { startedAt: t.startedAt } : null
}

/**
 * One settled row → at most one OS toast. Silent when the user is watching the
 * window, when they cancelled the work themselves, and when no row was open.
 * See activityNotify for every rule; nothing here decides, it only reports.
 */
function announceSettle(
  watched: { startedAt: number } | null,
  kind: SettleNotifyKind,
  status: SettleNotifyStatus,
  opts: { name?: string; detail?: string } = {},
): void {
  if (!watched) return
  notifySettle({
    kind,
    status,
    name: opts.name,
    detail: status === 'failed' ? opts.detail : undefined,
    elapsedMs: Math.max(0, Date.now() - watched.startedAt),
  })
}

/**
 * Route one normalized install event to the store. Exported so the whole
 * decision table (suppress / open / advance / settle / ignore) is testable
 * without any IPC.
 */
export function routeInstallEvent(
  id: string,
  label: string,
  surface: string,
  ev: NormalizedInstallEvent,
  store = useActivityStore.getState(),
): void {
  const terminal = TERMINAL_STAGES.includes(ev.stage)
  if (MANAGED_STAGES.includes(ev.stage)) {
    suppressed.add(id)
    return
  }
  if (suppressed.has(id)) {
    if (terminal) suppressed.delete(id)
    return
  }
  if (terminal) {
    // No row open ⇒ nothing was being watched ⇒ no row is created (a `done`
    // with no prior tick is the installer's "already on disk" fast path).
    const watched = watchedRow(store, id)
    const status = settleStatus(ev.stage)
    store.settleTask(id, {
      status,
      stage: ev.message || ev.stage,
      error: ev.stage === 'error' ? (ev.message || 'Install failed') : undefined,
    })
    // A multi-GB engine install is exactly the operation the user walks away
    // from — the label is the engine's OWN name, so the toast reads as itself.
    announceSettle(watched, 'engine-install', status, { name: label, detail: ev.message })
    return
  }
  store.progressTask(id, {
    kind: 'engine-install' as ActivityTaskKind,
    label,
    surface,
    stage: ev.message || ev.stage,
    percent: ev.percent,
    bytes: ev.bytes,
    cancel: null,   // no installer exposes a cancel — clause 5, in the honest direction
  })
}

/** Route one design MP4-export event. */
export function routeRenderEvent(ev: NormalizedInstallEvent, store = useActivityStore.getState()): void {
  const id = 'design:render'
  if (TERMINAL_STAGES.includes(ev.stage)) {
    const watched = watchedRow(store, id)
    const status = settleStatus(ev.stage)
    store.settleTask(id, {
      status,
      stage: ev.message || ev.stage,
      error: ev.stage === 'error' ? (ev.message || 'Export failed') : undefined,
    })
    announceSettle(watched, 'render', status, { detail: ev.message })
    return
  }
  store.progressTask(id, {
    kind: 'render',
    label: '',
    labelKey: 'activity.label.render',
    surface: '/design',
    stage: ev.message || ev.stage,
    percent: ev.percent,
    cancel: null,   // the Remotion render has no abort — say so rather than lie
  })
}

/** The interpolation-run event, as `rife:progress` sends it. */
export interface NormalizedRifeRunEvent {
  jobId: string
  stage: string
  message: string
  percent: number
  counts?: ActivityCounts
  error?: string
}

export function normalizeRifeRunEvent(raw: unknown): NormalizedRifeRunEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  // jobId is the row identity; without it there is no row to open or settle.
  if (typeof e.jobId !== 'string' || !e.jobId || typeof e.stage !== 'string') return null
  const percent = typeof e.percent === 'number' && Number.isFinite(e.percent) && e.percent >= 0
    ? Math.min(100, Math.round(e.percent))
    : -1
  const c = e.counts as { done?: unknown; total?: unknown } | undefined
  const counts = c && typeof c.done === 'number' && typeof c.total === 'number'
    ? { done: c.done, total: c.total }
    : undefined
  return {
    jobId: e.jobId,
    stage: e.stage,
    message: typeof e.message === 'string' ? e.message : '',
    percent,
    counts,
    error: typeof e.error === 'string' ? e.error : undefined,
  }
}

/**
 * Route one frame-interpolation RUN event.
 *
 * Filed under the 'render' kind rather than a new one: it is the same shape of
 * work the Design MP4 export already occupies that row for — a long local
 * encode with a measurable step count — and inventing a fourth kind would mean
 * a fourth label, icon and translation for no behavioural difference.
 *
 * Unlike every other row in this bridge, it carries a REAL cancel: the run
 * holds the GPU for minutes and the gallery card that started it scrolls away.
 */
export function routeRifeRunEvent(ev: NormalizedRifeRunEvent, store = useActivityStore.getState()): void {
  const id = `rife:${ev.jobId}`
  if (TERMINAL_STAGES.includes(ev.stage)) {
    const watched = watchedRow(store, id)
    const status = settleStatus(ev.stage)
    store.settleTask(id, {
      status,
      stage: ev.message || ev.stage,
      error: ev.stage === 'error' ? (ev.error || ev.message || 'Interpolation failed') : undefined,
    })
    announceSettle(watched, 'rife', status, { detail: ev.error || ev.message })
    return
  }
  store.progressTask(id, {
    kind: 'render',
    label: '',
    labelKey: 'activity.label.rife',
    surface: '/media',
    stage: ev.message || ev.stage,
    percent: ev.percent,
    counts: ev.counts,
    cancel: { kind: 'rife', jobId: ev.jobId },
  })
}

/**
 * Route one weights-migration event.
 *
 * The ONE settling row that does not announce itself (see announceSettle): a
 * migration is started from the Settings section that renders its own progress
 * and its own result, and it is the only long op here the user is told to sit
 * through. If that changes, this is a one-line addition, not a redesign.
 */
export function routeMigrateEvent(ev: NormalizedMigrateEvent, store = useActivityStore.getState()): void {
  const id = `migrate:${ev.engine}`
  if (ev.phase === 'done' || ev.phase === 'error' || ev.phase === 'aborted' || ev.phase === 'skip') {
    store.settleTask(id, {
      status: ev.phase === 'error' ? 'failed' : ev.phase === 'aborted' ? 'cancelled' : 'completed',
      stage: ev.message || ev.phase,
      error: ev.error,
    })
    return
  }
  store.progressTask(id, {
    kind: 'migrate',
    label: ev.engine,
    labelKey: 'activity.label.migrate',
    surface: '/settings',
    stage: ev.message || ev.phase,
    percent: ev.bytesTotal > 0 ? Math.round((ev.bytesDone / ev.bytesTotal) * 100) : -1,
    bytes: { received: ev.bytesDone, total: ev.bytesTotal },
    counts: ev.filesTotal > 0 ? { done: ev.filesDone, total: ev.filesTotal } : undefined,
    // The ONE row in this bridge that carries a real cancel: model-storage
    // exposes abort(engine), and today the only button for it lives on a
    // Settings section the user has already navigated away from.
    cancel: { kind: 'migrate', engine: ev.engine },
  })
}

let installed = false

// THE LATCH SURVIVES A MODULE RELOAD, NOT JUST A REMOUNT. A module-scoped
// boolean is enough for React (a second ActivityStrip mount re-imports the same
// evaluated module), but it is NOT enough for Vite HMR: editing this file swaps
// in a fresh module with `installed = false` while the previous module's
// listeners are still attached to the same `window`, and every progress event
// would then be routed twice. The window outlives the module, so the latch lives
// on the window too. Belt and braces — the module flag stays as the fast path.
const HMR_LATCH = '__tachiActivityBridgeInstalled'

function latched(): boolean {
  if (installed) return true
  try {
    return (globalThis as Record<string, unknown>)[HMR_LATCH] === true
  } catch {
    return false
  }
}

function latch(on: boolean): void {
  installed = on
  try {
    ;(globalThis as Record<string, unknown>)[HMR_LATCH] = on
  } catch { /* frozen global (a hardened test host) — the module flag still holds */ }
}

/**
 * Attach every rail listener. Idempotent — calling it from an app-lifetime
 * effect installs exactly one set for the life of the app. Returns true when
 * this call is the one that installed them.
 *
 * The unsubscribers are DELIBERATELY dropped, exactly as in
 * mediaProgressBridge: there is one window and one store, and a listener that
 * writes a row costs nothing while nothing is running.
 */
export function installActivityBridge(api?: ActivityBridgeSources): boolean {
  if (latched()) return false
  const src = api ?? (globalThis as { tachi?: ActivityBridgeSources }).tachi
  if (!src) return false
  let attached = false

  for (const ch of ENGINE_CHANNELS) {
    const bridge = src[ch.source]
    if (!bridge?.onInstallProgress) continue
    attached = true
    bridge.onInstallProgress(raw => {
      const ev = normalizeInstallEvent(raw)
      if (!ev) return
      routeInstallEvent(ch.id, ch.label, ch.surface, ev)
    })
  }

  if (src.design?.onRenderProgress) {
    attached = true
    src.design.onRenderProgress(raw => {
      const ev = normalizeInstallEvent(raw)
      if (!ev) return
      routeRenderEvent(ev)
    })
  }

  if (src.modelStorage?.onMigrateProgress) {
    attached = true
    src.modelStorage.onMigrateProgress(raw => {
      const ev = normalizeMigrateEvent(raw)
      if (!ev) return
      routeMigrateEvent(ev)
    })
  }

  // The interpolation RUN (its INSTALL rides ENGINE_CHANNELS above).
  if (src.rife?.onProgress) {
    attached = true
    src.rife.onProgress(raw => {
      const ev = normalizeRifeRunEvent(raw)
      if (!ev) return
      routeRifeRunEvent(ev)
    })
  }

  // Preload not ready yet ⇒ stay uninstalled so the next mount can try again
  // (the same re-arm contract mediaProgressBridge uses).
  if (!attached) return false
  latch(true)
  return true
}

/** Tests only — the module latch and the suppression set are per-process. */
export function resetActivityBridge(): void {
  latch(false)
  suppressed.clear()
}
