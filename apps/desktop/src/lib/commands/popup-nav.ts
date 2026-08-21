// apps/desktop/src/lib/commands/popup-nav.ts
//
// Keyboard state machine for the slash-command autocomplete popup, extracted so
// it can be unit-tested in the node env (no DOM, no React). Both composers —
// Chat (`pages/chat/InputBar.tsx`) and Code/harness (`pages/agent/AgentPage.tsx`)
// — drive the same function so their keyboard behaviour cannot drift.
//
// Contract: ArrowUp/ArrowDown wrap around, Enter and Tab pick the highlighted
// row, Escape closes, Shift+Enter is NOT a pick (it must stay a newline), and
// every other key is ignored so normal typing flows through untouched.
//
// @module commands/popup-nav

export type PopupAction = 'move' | 'select' | 'close' | 'ignore'

export interface PopupNavResult {
  /** Cursor index AFTER the key. Unchanged for non-move keys. */
  cursor: number
  /** Whether the popup should still be open. */
  open:   boolean
  action: PopupAction
  /** True when the composer must call preventDefault() for this key. */
  preventDefault: boolean
}

export interface PopupNavOptions {
  shiftKey?: boolean
}

/**
 * Advance the popup state for one keydown.
 *
 * @param key    `KeyboardEvent.key`
 * @param cursor current highlighted index
 * @param count  number of rows currently listed
 *
 * @example navigatePopup('ArrowDown', 0, 3) // → { cursor: 1, action: 'move' }
 * @example navigatePopup('ArrowUp',   0, 3) // → { cursor: 2, action: 'move' }  (wraps)
 * @example navigatePopup('Enter',     1, 3) // → { action: 'select' }
 * @example navigatePopup('Enter',     1, 3, { shiftKey: true }) // → { action: 'ignore' }
 * @example navigatePopup('Escape',    1, 3) // → { open: false, action: 'close' }
 */
export function navigatePopup(
  key: string,
  cursor: number,
  count: number,
  opts: PopupNavOptions = {},
): PopupNavResult {
  const ignored: PopupNavResult = { cursor, open: true, action: 'ignore', preventDefault: false }

  // Escape always closes, even with nothing listed — it is the user's way out.
  if (key === 'Escape') return { cursor, open: false, action: 'close', preventDefault: true }
  // With no rows there is nothing to move through or pick.
  if (count <= 0) return ignored

  // Clamp a stale cursor (the list shrinks as the query narrows).
  const safe = cursor < 0 || cursor >= count ? 0 : cursor

  if (key === 'ArrowDown') {
    return { cursor: (safe + 1) % count, open: true, action: 'move', preventDefault: true }
  }
  if (key === 'ArrowUp') {
    return { cursor: (safe - 1 + count) % count, open: true, action: 'move', preventDefault: true }
  }
  if (key === 'Tab') {
    return { cursor: safe, open: false, action: 'select', preventDefault: true }
  }
  if (key === 'Enter') {
    // Shift+Enter must remain "insert a newline", never "pick a command".
    if (opts.shiftKey) return { ...ignored, cursor: safe }
    return { cursor: safe, open: false, action: 'select', preventDefault: true }
  }
  return { ...ignored, cursor: safe }
}
