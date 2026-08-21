// apps/desktop/src/store/activity.store.ts
//
// THE ACTIVITY TASK REGISTRY — the rail's home for every long operation that is
// NOT already owned by a main-process registry.
//
// Two operations in this app already survive navigation for the right reason:
// model downloads live in the main-process download manager and arrive on a
// broadcast (downloads.store), and the in-flight media render lives in
// media.store's non-persisted `run` slice fed by a never-torn-down bridge. Both
// were fixed only AFTER a driver lost work to them. Everything else still kept
// its progress in the page that started it — so an engine install, an MP4
// export or a tens-of-GB weights migration became invisible the moment the user
// switched tabs, and the Catalog's install row froze at its last seen percent
// forever because the `stage === 'done'` handler had been unmounted.
//
// This store is the third home. It holds one row per event-driven producer,
// written ONLY by activityBridge (which subscribes, once and for the life of
// the app, to push channels that already existed) and read by ActivityStrip and
// the chassis IO lamp.
//
// NOT PERSISTED, on purpose and for the same reason as media.store's `run`
// slice: an install or a render dies with the app, so a restored "running" row
// would offer to watch a process that no longer exists.
//
// ── WHAT THIS STORE REFUSES TO DO ────────────────────────────────────────────
//  • It arms no timer to LOOK for work. Every row is opened by an event a
//    producer was already sending; the rail costs one function call per emit.
//    (The idle audit deleted the app's polls — the rail must not reintroduce
//    one. The single `setTimeout` here is a one-shot auto-dismiss AFTER a row
//    has already settled, not a poll.)
//  • `settle()` on an id it has never seen is a NO-OP, never an insert. A
//    producer's terminal event for work the rail did not watch (an "already on
//    disk" fast path, a managed download the download manager owns) must not
//    conjure a finished row for something the user never saw start.
//  • A row claims `cancel` only when a real cancel exists, and the claim is
//    DATA (a descriptor), not a closure — so it is assertable.

import { create } from 'zustand'

/**
 * Which producer opened the row. Downloads and the sd.cpp media render are NOT
 * here — they have their own, older, main-owned homes (see the header).
 *
 * 'generate' is the exception that proves it: the AUDIO OVERVIEW pipeline runs
 * entirely in the renderer (quick-ask → local TTS → WebAudio stitch), so there
 * is no main-process registry that could own it. It is a generation like the
 * sd.cpp one — same 'GEN' tag, same shape of row — it just reports itself.
 */
export type ActivityTaskKind = 'engine-install' | 'render' | 'migrate' | 'generate'

export type ActivityStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * A real, reachable cancel. Deliberately a descriptor rather than a function:
 * the row's "you can stop this" claim then survives a store snapshot, and a
 * test can assert it without executing anything.
 */
export type ActivityCancel =
  | { kind: 'sd-generate' }
  | { kind: 'migrate'; engine: string }
  // A RIFE interpolation run. `jobId` IS the source path (one run per file), so
  // the descriptor names the exact child the kill will reach.
  | { kind: 'rife'; jobId: string }
  // The AUDIO OVERVIEW pipeline. The only cancel here that reaches no IPC at
  // all: the run is renderer-local, so the descriptor resolves to its own
  // module's stop (audioOverviewRun.cancelAudioOverviewRun). It is still a
  // descriptor rather than a closure — the claim "this can be stopped" stays a
  // value a test can assert.
  | { kind: 'audio-overview' }

export interface ActivityBytes {
  received: number
  total: number
  speedBytesPerSec?: number
  etaSec?: number
}

export interface ActivityCounts { done: number; total: number }

export interface ActivityTask {
  id: string
  kind: ActivityTaskKind
  /** The producer's literal name for the work (an engine's own name). */
  label: string
  /** i18n key naming the row when the producer has no name of its own. */
  labelKey?: string
  /** The producer's own progress phrase — never written by the renderer. */
  stage: string
  /** 0..100 when measured, -1 when it is not. */
  percent: number
  bytes?: ActivityBytes
  counts?: ActivityCounts
  status: ActivityStatus
  error?: string
  /** Route the strip navigates to when the row's label is clicked. */
  surface?: string
  cancel: ActivityCancel | null
  startedAt: number
  updatedAt: number
}

/** What a producer may write on each tick. Identity fields are only used when
 *  the row is being opened for the first time. */
export interface ActivityProgressPatch {
  kind: ActivityTaskKind
  label?: string
  labelKey?: string
  stage?: string
  percent?: number
  bytes?: ActivityBytes
  counts?: ActivityCounts
  surface?: string
  cancel?: ActivityCancel | null
}

export interface ActivitySettlePatch {
  status: Exclude<ActivityStatus, 'running'>
  stage?: string
  error?: string
}

/**
 * How long a SUCCESSFUL row stays on the rail after it settles. It is the only
 * completion report the user gets when the page that started the work is
 * unmounted, so it must be visible for a beat — and then it must go, because a
 * row that outlives its process is the "animation that outlived its state"
 * defect with a progress bar. Failures are sticky until dismissed: an error the
 * user never saw is the loss this whole rail exists to stop.
 */
export const ACTIVITY_AUTO_DISMISS_MS = 6000

interface ActivityStore {
  tasks: ActivityTask[]
  /** Open (or advance) a row. Only a producer's own event may call this. */
  progressTask(id: string, patch: ActivityProgressPatch): void
  /** Terminal. NO-OP for an id with no open row — see the header. */
  settleTask(id: string, patch: ActivitySettlePatch, autoDismissMs?: number): void
  /** Drop a settled row (the ✕ on a failed row, or the auto-dismiss). */
  dismissTask(id: string): void
  /** Tests only — drop every row and cancel every pending auto-dismiss. */
  resetTasks(): void
}

function clampPercent(p: unknown): number {
  if (typeof p !== 'number' || !Number.isFinite(p)) return -1
  if (p < 0) return -1
  return Math.min(100, Math.round(p))
}

// Pending auto-dismiss timers, so a row settled twice (a producer that emits
// 'done' and then errors on cleanup) can never be removed by a stale timer.
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimer(id: string): void {
  const t = dismissTimers.get(id)
  if (t !== undefined) {
    clearTimeout(t)
    dismissTimers.delete(id)
  }
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
  tasks: [],

  progressTask(id, patch) {
    if (!id) return
    clearTimer(id)
    const now = Date.now()
    set(s => {
      const idx = s.tasks.findIndex(t => t.id === id)
      if (idx === -1) {
        const task: ActivityTask = {
          id,
          kind: patch.kind,
          label: patch.label ?? '',
          labelKey: patch.labelKey,
          stage: patch.stage ?? '',
          percent: clampPercent(patch.percent),
          bytes: patch.bytes,
          counts: patch.counts,
          status: 'running',
          surface: patch.surface,
          cancel: patch.cancel ?? null,
          startedAt: now,
          updatedAt: now,
        }
        return { tasks: [...s.tasks, task] }
      }
      const prev = s.tasks[idx]
      const next: ActivityTask = {
        ...prev,
        // A tick may re-open a row the producer had already settled (a retry on
        // the same channel) — that is real work again, so the status resets.
        status: 'running',
        error: undefined,
        label: patch.label ?? prev.label,
        labelKey: patch.labelKey ?? prev.labelKey,
        stage: patch.stage ?? prev.stage,
        percent: patch.percent === undefined ? prev.percent : clampPercent(patch.percent),
        bytes: patch.bytes ?? prev.bytes,
        counts: patch.counts ?? prev.counts,
        surface: patch.surface ?? prev.surface,
        cancel: patch.cancel === undefined ? prev.cancel : patch.cancel,
        updatedAt: now,
      }
      const tasks = [...s.tasks]
      tasks[idx] = next
      return { tasks }
    })
  },

  settleTask(id, patch, autoDismissMs = ACTIVITY_AUTO_DISMISS_MS) {
    if (!id) return
    // A terminal event for a row nobody opened is not a finished operation the
    // user was watching — it is a fast path ("already on disk") or a producer
    // whose transfer the download manager owns. Rendering it would be a fake row.
    if (!get().tasks.some(t => t.id === id)) return
    clearTimer(id)
    set(s => ({
      tasks: s.tasks.map(t => t.id === id ? {
        ...t,
        status: patch.status,
        stage: patch.stage ?? t.stage,
        error: patch.error,
        // Percent is a measurement: a successful settle IS 100%, everything
        // else keeps whatever the last real reading was.
        percent: patch.status === 'completed' ? 100 : t.percent,
        cancel: null,
        updatedAt: Date.now(),
      } : t),
    }))
    if (patch.status === 'completed' || patch.status === 'cancelled') {
      const timer = setTimeout(() => {
        dismissTimers.delete(id)
        get().dismissTask(id)
      }, Math.max(0, autoDismissMs))
      // Never hold the process open for a cosmetic fade (node/test hosts).
      ;(timer as unknown as { unref?: () => void }).unref?.()
      dismissTimers.set(id, timer)
    }
  },

  dismissTask(id) {
    clearTimer(id)
    set(s => ({ tasks: s.tasks.filter(t => t.id !== id) }))
  },

  resetTasks() {
    for (const id of Array.from(dismissTimers.keys())) clearTimer(id)
    set({ tasks: [] })
  },
}))
