// apps/desktop/electron/ipc/privacy-mode.ts
//
// PURE privacy-mode helpers (no electron) so the policy is unit-testable.
// Audit 2026-06-12 (dimension 6): the mirror used to fail OPEN — default 'open'
// at cold start AND 'open' on a malformed renderer payload. For a privacy
// control the safe direction is the opposite: fail CLOSED.

export type PrivacyMode = 'open' | 'private'

/**
 * Coerce a renderer-supplied value to a mode, FAIL-CLOSED: anything that is not
 * exactly 'open' or 'private' becomes 'private' (block egress) rather than 'open'.
 */
export function coerceMode(value: unknown): PrivacyMode {
  if (value === 'open') return 'open'
  if (value === 'private') return 'private'
  return 'private'
}

/** Map the persisted strictPrivacyMode flag to the startup mode. */
export function startupModeFromStrict(strict: boolean | undefined): PrivacyMode {
  return strict === true ? 'private' : 'open'
}
