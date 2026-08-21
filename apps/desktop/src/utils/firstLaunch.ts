// apps/desktop/src/utils/firstLaunch.ts
//
// First-launch LEARN landing — decision core + flag helpers.
//
// On a FRESH install's very first launch we land the user on the LEARN tab once
// (with a dismissible welcome hero). The DECISION is a pure function so it is
// trivially unit-testable and cannot accidentally hijack an existing user's
// navigation: the caller assembles the persisted signals (the done-flag, chat
// conversation count, saved-flow count) and asks shouldShowFirstLaunch().
//
// The flag write is deliberately kept OUT of the pure function — persisting the
// "done" flag is a side effect owned by the runtime helpers below (and the
// LearnPage hero), never by the predicate.

/** localStorage key that permanently marks the first-launch landing as handled. */
export const FIRST_LAUNCH_KEY = 'tachi:first-launch-done'

export interface FirstLaunchInput {
  /**
   * Current value of localStorage[FIRST_LAUNCH_KEY]. `null`/`undefined` = unset
   * (never landed / never a decision). Any string value = already handled.
   */
  flag: string | null | undefined
  /** Number of persisted chat conversations (chat store's persisted state). */
  conversationCount: number
  /**
   * Number of persisted node flows — the current canvas graph (nodes store) plus
   * any flows saved to disk. Zero = the user has never built a workflow.
   */
  savedFlowCount: number
}

/**
 * PURE. No I/O, no side effects. Returns true only for a genuinely fresh
 * install: the done-flag is unset AND there is no prior user state (zero chat
 * conversations AND zero saved flows).
 *
 * - Flag already set  → false (existing/handled user; no re-show on update).
 * - Any prior data    → false (existing user; the caller sets the flag silently).
 * - Truly empty + flag unset → true (show the landing once).
 *
 * Counts are compared with `=== 0` so only an exact, clean "no data" read shows
 * the landing — any positive count (has data) OR a corrupt read (negative / NaN,
 * neither of which equals 0) fails CLOSED, never yanking a user to LEARN.
 */
export function shouldShowFirstLaunch(input: FirstLaunchInput): boolean {
  if (input.flag != null) return false
  return input.conversationCount === 0 && input.savedFlowCount === 0
}

// ── Runtime flag helpers (side-effectful; intentionally separate from the pure
//    predicate above so the decision stays trivially testable) ────────────────

/** Read the persisted flag. Returns null when unset or storage is unavailable. */
export function readFirstLaunchFlag(): string | null {
  try {
    return localStorage.getItem(FIRST_LAUNCH_KEY)
  } catch {
    return null
  }
}

/** True once the first-launch landing has been handled (shown+dismissed, or
 *  silently recorded for an existing user). */
export function isFirstLaunchDone(): boolean {
  return readFirstLaunchFlag() != null
}

/** Permanently record the first-launch landing as handled. Idempotent; tolerant
 *  of storage being unavailable (tests / exotic setups). */
export function markFirstLaunchDone(): void {
  try {
    localStorage.setItem(FIRST_LAUNCH_KEY, '1')
  } catch {
    /* storage unavailable — nothing else to do */
  }
}
