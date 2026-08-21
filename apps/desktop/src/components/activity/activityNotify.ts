// apps/desktop/src/components/activity/activityNotify.ts
//
// THE ONE CALLER OF `notification:show`.
//
// The native-notification IPC shipped complete — a zod-validated handler
// (electron/ipc/notification.ipc.ts), a service that respects the
// `notificationsEnabled` setting (services/notifications.ts), a preload wire and
// a Settings toggle for it — and NOTHING IN THE APP EVER CALLED IT. Meanwhile
// the app's longest operations (a 27-minute Wan render, a multi-GB engine
// install, a frame interpolation) finish into a window the user walked away
// from, and the only report was a rail row they had to be looking at.
//
// This module is the seam between "a row settled" and "the OS says so", and it
// is deliberately a data-in / decision-out function rather than a call buried in
// the bridges, because every rule below is a rule someone will want to argue
// with:
//
//   • FOCUSED = SILENT. A toast for work the user is sitting in front of is
//     spam; the rail is already on screen and already says it. `document
//     .hasFocus()` is the simplest honest signal the renderer has, and a hidden
//     document counts as unwatched even if the platform still claims focus.
//   • CANCELLED = SILENT. They pressed Stop. Telling them it stopped is telling
//     them what they just did.
//   • ONE TOAST PER SETTLE, and only for a row that was actually OPEN — the
//     same admission rule activityBridge's header states for rows themselves
//     ("no terminal event = no row"): an installer's "already on disk" fast path
//     settles nothing, so it announces nothing.
//   • THE COPY IS NEVER INVENTED ABOUT THE WORK. A duration is printed only
//     when the producer measured one; a failure body is the producer's own
//     words, never a rewrite of them.
//
// NOT A NOTIFICATION CENTRE. There is no queue, no history, no grouping and no
// retry: one settle, at most one OS toast, forget it.

import { fmtElapsed } from './activityRows'

/** What settled. Maps 1:1 onto a copy line — a kind cannot be added without one. */
export type SettleNotifyKind = 'image' | 'video' | 'engine-install' | 'render' | 'rife' | 'audio-overview'

export type SettleNotifyStatus = 'completed' | 'failed' | 'cancelled'

export interface SettleNotice {
  kind: SettleNotifyKind
  status: SettleNotifyStatus
  /** The producer's OWN name for itself (an engine's proper noun). Not translated. */
  name?: string
  /** The producer's own last words on a failure. Never written here. */
  detail?: string
  /** How long the work ran, when the producer measured it. Absent ⇒ no body. */
  elapsedMs?: number
}

/**
 * The lines this module may print. A function per line rather than a string
 * table so the interpolated ones ({{name}}, {{elapsed}}) go through i18next's
 * own formatting rather than a hand-rolled replace.
 */
export interface ActivityNotifyCopy {
  imageReady(): string
  videoReady(): string
  genFailed(): string
  installed(name: string): string
  installFailed(name: string): string
  renderDone(): string
  renderFailed(): string
  rifeDone(): string
  rifeFailed(): string
  /** The two-host podcast render — a minute-plus of local LLM + TTS, and the
   *  op most likely to land in an app the user has already walked away from. */
  audioOverviewDone(): string
  audioOverviewFailed(): string
  took(elapsed: string): string
}

/** English, and the shipped default until ActivityStrip registers the localized
 *  set (the same setter contract mediaProgressBridge uses for phase labels: the
 *  seam installs once for the life of the app and the locale does not). */
export const FALLBACK_NOTIFY_COPY: ActivityNotifyCopy = {
  imageReady:    () => 'Image ready',
  videoReady:    () => 'Video ready',
  genFailed:     () => 'Generation failed',
  installed:     (name) => `${name} installed`,
  installFailed: (name) => `${name} install failed`,
  renderDone:    () => 'Video export finished',
  renderFailed:  () => 'Video export failed',
  rifeDone:      () => 'Frame interpolation finished',
  rifeFailed:    () => 'Frame interpolation failed',
  audioOverviewDone:   () => 'Audio overview ready',
  audioOverviewFailed: () => 'Audio overview failed',
  took:          (elapsed) => `took ${elapsed}`,
}

let copy: ActivityNotifyCopy = FALLBACK_NOTIFY_COPY

/** Hand over the localized lines (ActivityStrip, on every `t` change). */
export function setActivityNotifyCopy(next: ActivityNotifyCopy): void {
  copy = next
}

// The IPC's zod schema is the hard limit — a longer string is a thrown
// ZodError in main, i.e. a lost notification. Truncating is the honest failure.
const TITLE_MAX = 256
const BODY_MAX = 512

function clamp(s: string, max: number): string {
  const t = (s ?? '').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

export interface NotifyPayload { title: string; body: string }

/**
 * Turn a settled row into the two lines an OS toast shows — or null when there
 * is nothing honest to say (a cancel the user issued themselves).
 */
export function formatSettleNotice(n: SettleNotice, c: ActivityNotifyCopy = copy): NotifyPayload | null {
  if (!n || n.status === 'cancelled') return null
  const failed = n.status === 'failed'
  const name = n.name ?? ''

  let title: string
  switch (n.kind) {
    case 'image':          title = failed ? c.genFailed()          : c.imageReady(); break
    case 'video':          title = failed ? c.genFailed()          : c.videoReady(); break
    case 'engine-install': title = failed ? c.installFailed(name)  : c.installed(name); break
    case 'render':         title = failed ? c.renderFailed()       : c.renderDone(); break
    case 'rife':           title = failed ? c.rifeFailed()         : c.rifeDone(); break
    case 'audio-overview': title = failed ? c.audioOverviewFailed(): c.audioOverviewDone(); break
    default:               return null
  }

  // A failure says WHY, in the producer's words. A success says how long it
  // took — and only when the producer actually measured it.
  const body = failed
    ? clamp(n.detail ?? '', BODY_MAX)
    : typeof n.elapsedMs === 'number' && Number.isFinite(n.elapsedMs) && n.elapsedMs > 0
      ? clamp(c.took(fmtElapsed(n.elapsedMs)), BODY_MAX)
      : ''

  return { title: clamp(title, TITLE_MAX), body }
}

/** Just the slice of `window.tachi` a toast needs, so a test can hand a fake. */
export interface ActivityNotifySink {
  show(payload: { title: string; body?: string; silent?: boolean }): unknown
}

export interface ActivityNotifyDeps {
  sink?: ActivityNotifySink | null
  /** Override the focus reading (tests, and any future "always notify" setting). */
  focused?: boolean
  copy?: ActivityNotifyCopy
}

export type NotifySkipReason = 'focused' | 'nothing-to-say' | 'unavailable' | 'error'

export interface NotifyOutcome {
  sent: boolean
  reason?: NotifySkipReason
  title?: string
  body?: string
}

/**
 * Is the user looking at this window right now?
 *
 * `hasFocus()` is the whole test, plus a hidden document (minimized, another
 * virtual desktop) counting as unwatched regardless. A host with no `document`
 * at all — a test, an overlay — is NOT focus: the point of this seam is that a
 * finished render is never lost, so "cannot tell" resolves toward telling them.
 */
export function isWindowFocused(): boolean {
  try {
    const doc = (globalThis as { document?: { hasFocus?: () => boolean; visibilityState?: string } }).document
    if (!doc || typeof doc.hasFocus !== 'function') return false
    if (doc.visibilityState === 'hidden') return false
    return doc.hasFocus() === true
  } catch {
    return false
  }
}

function defaultSink(): ActivityNotifySink | null {
  try {
    const t = (globalThis as { tachi?: { notification?: ActivityNotifySink } }).tachi
    return t?.notification ?? null
  } catch {
    return null
  }
}

/**
 * Announce one settled row, if there is anything to announce and nobody is
 * watching. Returns an outcome instead of throwing: a failed toast must never
 * take down the bridge that was reporting the work.
 */
export function notifySettle(n: SettleNotice, deps: ActivityNotifyDeps = {}): NotifyOutcome {
  const payload = formatSettleNotice(n, deps.copy ?? copy)
  if (!payload) return { sent: false, reason: 'nothing-to-say' }

  const focused = deps.focused ?? isWindowFocused()
  if (focused) return { sent: false, reason: 'focused', ...payload }

  const sink = deps.sink === undefined ? defaultSink() : deps.sink
  if (!sink || typeof sink.show !== 'function') return { sent: false, reason: 'unavailable', ...payload }

  try {
    // `silent` is left to the platform default: this is the ONE report the user
    // gets for work they walked away from, so muting it by default would undo
    // the fix. The global off-switch is Settings → notificationsEnabled, which
    // main already honours before a Notification is ever constructed.
    const r = sink.show({ title: payload.title, body: payload.body })
    // The IPC returns a promise; a rejection here is main's problem, not the
    // rail's — swallow it rather than surfacing an unhandled rejection.
    void Promise.resolve(r as unknown).catch(() => {})
    return { sent: true, ...payload }
  } catch {
    return { sent: false, reason: 'error', ...payload }
  }
}

/** Tests only — the copy registration is module-scoped and specs need a fresh one. */
export function resetActivityNotify(): void {
  copy = FALLBACK_NOTIFY_COPY
}
