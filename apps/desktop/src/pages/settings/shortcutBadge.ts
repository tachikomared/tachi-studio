// apps/desktop/src/pages/settings/shortcutBadge.ts
//
// Pure row-decision helper for the Shortcuts section's "NOT REGISTERED"
// badge. Takes the {id, accel, ok} rows returned by
// window.tachi.hotkeys.registrations() plus the action id for one row and
// decides whether that row should show the badge, and if so, which
// accelerator failed to register (for the tooltip). Kept side-effect-free
// and framework-free so it is trivially unit-testable.

/** One row from window.tachi.hotkeys.registrations(). */
export interface HotkeyRegistrationRow {
  id: string
  accel: string
  ok: boolean
}

export interface ShortcutBadgeState {
  /** true when this action's last global registration attempt failed
   *  (another app already owns the accelerator). */
  notRegistered: boolean
  /** The accelerator that failed to register, for the tooltip.
   *  null whenever notRegistered is false. */
  failedAccel: string | null
}

const NO_BADGE: ShortcutBadgeState = { notRegistered: false, failedAccel: null }

/**
 * Decide the badge state for one hotkey action.
 *
 * - `registrations` is null/undefined before the one-shot mount load
 *   resolves, or on load failure — never show a badge in that case (no
 *   false positives while data is unknown).
 * - In-app scoped actions never appear in `registrations` (only global
 *   actions are registered via Electron's globalShortcut) — no badge.
 * - A row with `ok: true` never shows a badge.
 * - A row with `ok: false` shows the badge, carrying its accelerator.
 */
export function getShortcutBadgeState(
  registrations: readonly HotkeyRegistrationRow[] | null | undefined,
  actionId: string,
): ShortcutBadgeState {
  if (!registrations) return NO_BADGE
  const row = registrations.find(r => r.id === actionId)
  if (!row || row.ok) return NO_BADGE
  return { notRegistered: true, failedAccel: row.accel }
}
