// apps/desktop/src/components/civitaiAdultPolicy.ts
//
// THE 18+ DIALOG'S RULES, AS PURE FUNCTIONS.
//
// The dialog itself is JSX and this repo's test runner is node-only (no DOM,
// `test/**/*.test.ts`), so everything that could be got WRONG lives here and is
// unit-tested, and CivitaiAdultDialog.tsx is left with markup that a source
// assertion can pin. That split is the same one civitaiRow.ts made for the
// catalog card.
//
// ─── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
// It is NOT the unlock decision. That lives in main
// (civitaiAdultUnlocked in electron/services/civitai-gate.ts), is recomputed on
// every request from the settings store AND a live keychain read, and is the
// only thing that can move a byte to civitai.red. Nothing here is trusted by
// main; `civitaiAdultStatus` below even takes main's own `unlocked` verbatim
// rather than re-deriving it, precisely so the renderer can never disagree with
// the process that actually makes the request.

/** The shape `window.tachi.civitai.adultState()` resolves to. */
export interface CivitaiAdultState {
  /** MAIN's verdict. The renderer displays it; it never recomputes it. */
  unlocked: boolean
  adultMode: boolean
  /** epoch ms of the affirmation; 0 = never affirmed */
  acceptedAt: number
  hasKey: boolean
}

/** Why the surface looks the way it does. Only ever used to pick a sentence. */
export type CivitaiAdultStatus = 'unlocked' | 'off' | 'no-key' | 'not-affirmed'

/**
 * Which explanation to show.
 *
 * `unlocked` is checked FIRST and taken as given. The three remaining branches
 * exist because "the switch is on and nothing happened" is the failure mode
 * this whole design invites: the user deletes their API key in the card
 * directly above, the mode silently drops back to SFW (by design — it is
 * revocable in one click), and without this the switch would sit there lit and
 * lying. `no-key` outranks `not-affirmed` because the key is the thing the user
 * can see and fix in the same card.
 */
export function civitaiAdultStatus(state: CivitaiAdultState | null | undefined): CivitaiAdultStatus {
  if (!state) return 'off'
  if (state.unlocked) return 'unlocked'
  if (state.adultMode !== true) return 'off'
  if (state.hasKey !== true) return 'no-key'
  return 'not-affirmed'
}

/**
 * May the dialog's confirm button fire?
 *
 * BOTH, always: the affirmation must be actively ticked (never pre-checked —
 * see the dialog's initial state) and the credential must already be stored.
 * Offering "turn it on anyway" with no key would write a setting that provably
 * does nothing, which is a worse lie than refusing.
 */
export function canAffirmCivitaiAdult(input: { affirmed: boolean; hasKey: boolean }): boolean {
  return input.affirmed === true && input.hasKey === true
}

/** The exact settings patch an affirmation writes. */
export interface CivitaiAdultPatch {
  civitaiAdultMode: boolean
  civitaiAdultAcceptedAt: number
}

/**
 * The unlock patch. BOTH keys, together, in one save — a write that set only
 * the boolean would leave `acceptedAt` at 0 and main would keep browsing SFW,
 * which is the correct outcome but an incomprehensible one to debug.
 *
 * `now` is injected so the test can pin the value instead of racing a clock. A
 * non-finite, non-positive or fractional argument falls back to Date.now():
 * this function's job is to produce a MOMENT, and there is no reading of a
 * broken input that should silently become "never affirmed".
 */
export function civitaiAdultUnlockPatch(now: number = Date.now()): CivitaiAdultPatch {
  const at = Number.isFinite(now) && now > 0 ? Math.floor(now) : Date.now()
  return { civitaiAdultMode: true, civitaiAdultAcceptedAt: at }
}

/**
 * The lock patch — and it RESETS THE TIMESTAMP, which is the whole reason
 * turning the switch off needs no dialog while turning it on always does.
 * Re-enabling therefore always goes back through the affirmation; there is no
 * path where a stale consent from three months ago is silently reused.
 */
export function civitaiAdultLockPatch(): CivitaiAdultPatch {
  return { civitaiAdultMode: false, civitaiAdultAcceptedAt: 0 }
}

/**
 * The affirmation date for the card, or '' when there is none.
 *
 * Locale-formatted through the platform, not hand-formatted: the app ships in 8
 * languages and `2026-07-28` is not how a date reads in most of them.
 */
export function formatCivitaiAcceptedAt(acceptedAt: unknown, locale?: string): string {
  if (typeof acceptedAt !== 'number' || !Number.isFinite(acceptedAt) || acceptedAt <= 0) return ''
  const d = new Date(acceptedAt)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleDateString(locale)
  } catch {
    return d.toLocaleDateString()
  }
}
