// apps/desktop/src/components/activity/activityRows.ts
//
// THE ACTIVITY RAIL'S PURE HALF (audit U2 §2 — "the activity rail").
//
// Every long operation in the app used to keep its progress in the page that
// started it, so switching tabs unmounted the component and threw the progress
// away while the work kept running. `DownloadStrip` was the one surface that
// got it right — main-process truth, a store mirror, visible from any tab — and
// it was hard-coded to a single kind of work. This module is the generalization
// U2 designed: it turns the three sources of truth that ALREADY exist
//
//   • the download manager's queue          (downloads.store, main-owned)
//   • the media run slice                   (media.store `run`, bridge-fed)
//   • the activity task registry            (activity.store, event-fed)
//
// into ONE ordered list of rows for the strip to render. It is deliberately
// pure: no React, no zustand, no `window` — the whole ordering / formatting /
// "is a percent a measurement" contract is testable in the node environment.
//
// ── THE HONESTY LAW (U2 §2.5), as enforced here ──────────────────────────────
//  1. A row is a REAL operation or it is not rendered. `mediaRunRow` returns
//     null unless the store says a render is in flight; a settled task is
//     dropped by the store, never by a placeholder here.
//  3. `percent` is a MEASUREMENT or it is -1. `parseRunProgress` is the exact
//     inverse of mediaProgressBridge.formatSdProgress and refuses to invent a
//     number from any line it did not itself produce.
//  4. `stage` is the PRODUCER's own words. Nothing in this file writes copy —
//     the only strings it emits are i18n KEYS the component resolves.
//  5. A cancel is offered IFF a real cancel exists. `cancel` is a data
//     descriptor (never a closure), so the "is this cancellable" claim is a
//     value a test can assert, not a function that might be a no-op.

import type { MediaRunState } from '../../store/media.store'
import type { ActivityBytes, ActivityCounts, ActivityCancel, ActivityStatus, ActivityTask } from '../../store/activity.store'
import type { DownloadItemInfo } from '../../types/electron'

/** What the row is. 'download' rows keep their own renderer (see ActivityStrip). */
export type ActivityRowKind = 'download' | 'engine-install' | 'generate' | 'render' | 'migrate'

/** One generic (non-download) row, fully resolved for rendering. */
export interface ActivityRow {
  id: string
  kind: Exclude<ActivityRowKind, 'download'>
  /** Literal name from the producer (an engine's own name). May be ''. */
  label: string
  /** i18n key that names the row when the producer has no name of its own. */
  labelKey?: string
  /** The producer's own progress phrase. Never synthesized here. */
  stage: string | null
  /** 0..100 when measured, -1 when it is not. */
  percent: number
  status: ActivityStatus
  bytes?: ActivityBytes
  counts?: ActivityCounts
  error: string | null
  /** Non-null IFF a real cancel exists for this row. */
  cancel: ActivityCancel | null
  /** A cancel has been issued and we are waiting for the producer to confirm. */
  stopping: boolean
  /** Route to jump to when the label is clicked. */
  surface?: string
}

/** The strip's render list: download rows keep their original component. */
export type ActivityEntry =
  | { type: 'download'; item: DownloadItemInfo }
  | { type: 'row'; row: ActivityRow }

/** Rows shown before the "+N more" fold. */
export const ACTIVITY_MAX_VISIBLE = 4

// ── formatting (shared by both row renderers, so both are pinned by one test) ─

export function fmtMb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(bytes >= 10 * 1_048_576 ? 0 : 1)
}

export function fmtSpeed(bps: number): string {
  return `${(bps / 1_048_576).toFixed(1)} MB/s`
}

/**
 * How long the row has been on the rail, as `m:ss` (or `h:mm:ss` past an hour).
 *
 * ELAPSED IS THE ONE NUMBER THE RAIL CAN ALWAYS BE HONEST ABOUT. A Wan render
 * reports no percent for minutes at a time (it is loading a 14B model), and the
 * incident this rail exists for is the owner not knowing whether anything was
 * running at all. A wall clock answers that with no cooperation from the
 * producer — but it is a wall clock, never an estimate: nothing here divides
 * elapsed by percent to invent a "time remaining" the engine never promised.
 *
 * A negative or non-finite input is a clock that went backwards (a host sleep,
 * a reordered first-seen write), which is not a measurement — it reads 0:00
 * rather than a stray minus sign.
 */
export function fmtElapsed(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const ss = String(s).padStart(2, '0')
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`
  return `${m}:${ss}`
}

/**
 * The right-hand measurement column for a generic row. Bytes beat counts beat
 * nothing — and "nothing" is an EMPTY STRING, not a fabricated "0%". A percent
 * is never printed here: the bar already carries it, and printing it twice was
 * how the old catalog row ended up claiming 97% forever.
 */
export function formatRowDetail(row: Pick<ActivityRow, 'bytes' | 'counts'>): string {
  const b = row.bytes
  if (b && b.total > 0) {
    const speed = b.speedBytesPerSec && b.speedBytesPerSec > 0 ? ` · ${fmtSpeed(b.speedBytesPerSec)}` : ''
    return `${fmtMb(b.received)}/${fmtMb(b.total)} MB${speed}`
  }
  if (b && b.received > 0) return `${fmtMb(b.received)} MB`
  const c = row.counts
  if (c && c.total > 0) return `${c.done}/${c.total}`
  return ''
}

// ── the media run row ────────────────────────────────────────────────────────

/**
 * Recover the NUMBERS out of the one line mediaProgressBridge formatted.
 *
 * `formatSdProgress` collapses the engine's event into a string ("12/20",
 * "48%", or the engine's own message). Reading them back is legitimate — those
 * two shapes came from real engine counters — but ONLY those two: any other
 * line is the engine talking prose ("loading model") and there is no percent in
 * it. Returning -1 there is the point; the strip renders -1 as the indeterminate
 * bar it already has, instead of a number nobody measured.
 */
export function parseRunProgress(line: string | null | undefined): { percent: number; counts: ActivityCounts | null } {
  if (typeof line !== 'string') return { percent: -1, counts: null }
  const trimmed = line.trim()
  const steps = /^(\d+)\s*\/\s*(\d+)$/.exec(trimmed)
  if (steps) {
    const done = Number(steps[1])
    const total = Number(steps[2])
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : -1
    return { percent, counts: { done, total } }
  }
  const pct = /^(\d{1,3})\s*%$/.exec(trimmed)
  if (pct) {
    const n = Number(pct[1])
    if (n >= 0 && n <= 100) return { percent: n, counts: null }
  }
  return { percent: -1, counts: null }
}

/**
 * The in-flight media generation, as a row — or null when nothing is running.
 *
 * The row exists exactly while `run.busy` does. A FAILED run deliberately does
 * NOT get a row: media.store keeps the failure so the composer can show it
 * inline (that is where the Retry lives), and a rail row repeating it would be
 * a second, dismissable copy of a message the page owns.
 */
export function mediaRunRow(run: MediaRunState | null | undefined): ActivityRow | null {
  if (!run || !run.busy) return null
  const { percent, counts } = parseRunProgress(run.progress)
  return {
    id: 'media:generate',
    kind: 'generate',
    label: '',
    labelKey: 'activity.label.generate',
    stage: run.progress ?? null,
    percent,
    status: 'running',
    counts: counts ?? undefined,
    error: null,
    // Clause 5: only a LOCAL sd.cpp render has a child process to kill. A cloud
    // job has no handle, so it gets no button rather than a button that lies.
    cancel: run.cancellable && !run.stopping ? { kind: 'sd-generate' } : null,
    stopping: run.stopping,
    surface: '/media',
  }
}

// ── tasks ────────────────────────────────────────────────────────────────────

/** A registry task, as a row. A straight projection — no invented fields. */
export function taskRow(task: ActivityTask): ActivityRow {
  return {
    id: task.id,
    kind: task.kind,
    label: task.label,
    labelKey: task.labelKey,
    stage: task.stage || null,
    percent: typeof task.percent === 'number' ? task.percent : -1,
    status: task.status,
    bytes: task.bytes,
    counts: task.counts,
    error: task.error ?? null,
    cancel: task.status === 'running' ? task.cancel : null,
    stopping: false,
    surface: task.surface,
  }
}

/** Running before settled, then oldest first — so a live row never jumps below
 *  a finished one, and two live rows keep a stable order. */
export function sortTasks(tasks: readonly ActivityTask[]): ActivityTask[] {
  return [...tasks].sort((a, b) => {
    const ra = a.status === 'running' ? 0 : 1
    const rb = b.status === 'running' ? 0 : 1
    if (ra !== rb) return ra - rb
    return a.startedAt - b.startedAt
  })
}

// ── the strip's render list ──────────────────────────────────────────────────

export interface ActivitySources {
  run?: MediaRunState | null
  tasks?: readonly ActivityTask[] | null
  downloads?: readonly DownloadItemInfo[] | null
}

/**
 * The whole rail, in render order: the generation the user just started, then
 * the event-driven tasks, then the download queue in the manager's own order
 * (unchanged — the download rows must keep rendering exactly as they did when
 * this component was DownloadStrip).
 */
export function buildActivityEntries(src: ActivitySources): ActivityEntry[] {
  const out: ActivityEntry[] = []
  const gen = mediaRunRow(src.run ?? null)
  if (gen) out.push({ type: 'row', row: gen })
  const tasks = Array.isArray(src.tasks) ? src.tasks : []
  for (const t of sortTasks(tasks)) out.push({ type: 'row', row: taskRow(t) })
  const dls = Array.isArray(src.downloads) ? src.downloads : []
  for (const d of dls) if (d) out.push({ type: 'download', item: d })
  return out
}

/** Fold everything past ACTIVITY_MAX_VISIBLE behind a "+N more" toggle so the
 *  dock can never eat the page. */
export function splitEntries(
  entries: readonly ActivityEntry[],
  expanded: boolean,
  max: number = ACTIVITY_MAX_VISIBLE,
): { shown: ActivityEntry[]; hidden: number } {
  const all = Array.isArray(entries) ? entries : []
  if (expanded || all.length <= max) return { shown: [...all], hidden: 0 }
  return { shown: all.slice(0, max), hidden: all.length - max }
}

/**
 * Is ANY tracked operation in flight? This is the generalized IO-lamp signal
 * (honesty clause 6): the lamp lights on the first in-flight row and goes dark
 * on the last terminal one. Tolerant of missing / oddly-shaped inputs, and an
 * unreadable source is NOT activity — the same fail-dark rule
 * `opusDownloadActive` already carries.
 */
export function anyActivityInFlight(src: ActivitySources & {
  downloadActive?: boolean
}): boolean {
  if (src.downloadActive === true) return true
  if (src.run && src.run.busy === true) return true
  const tasks = Array.isArray(src.tasks) ? src.tasks : []
  return tasks.some(t => !!t && t.status === 'running')
}
