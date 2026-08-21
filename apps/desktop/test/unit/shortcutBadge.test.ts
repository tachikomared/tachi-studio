// apps/desktop/test/unit/shortcutBadge.test.ts
//
// Pure row-decision test for the Shortcuts section's NOT-REGISTERED badge.
// getShortcutBadgeState(registrations, actionId) decides — from the
// {id, accel, ok} rows returned by window.tachi.hotkeys.registrations() —
// whether a given action's row should show the badge, and which accelerator
// failed (for the tooltip). No React, no Electron: pure data in, data out.

import { describe, it, expect } from 'vitest'
import {
  getShortcutBadgeState,
  type HotkeyRegistrationRow,
} from '../../src/pages/settings/shortcutBadge'

describe('getShortcutBadgeState', () => {
  it('shows no badge before registrations have loaded (null)', () => {
    expect(getShortcutBadgeState(null, 'quick-ask')).toEqual({
      notRegistered: false,
      failedAccel: null,
    })
  })

  it('shows no badge when registrations is undefined', () => {
    expect(getShortcutBadgeState(undefined, 'quick-ask')).toEqual({
      notRegistered: false,
      failedAccel: null,
    })
  })

  it('shows no badge for an action with ok:true', () => {
    const rows: HotkeyRegistrationRow[] = [
      { id: 'quick-ask', accel: 'CommandOrControl+Shift+Space', ok: true },
    ]
    expect(getShortcutBadgeState(rows, 'quick-ask')).toEqual({
      notRegistered: false,
      failedAccel: null,
    })
  })

  it('shows the badge and carries the failed accelerator for ok:false', () => {
    const rows: HotkeyRegistrationRow[] = [
      { id: 'quick-ask', accel: 'CommandOrControl+Shift+Space', ok: false },
    ]
    expect(getShortcutBadgeState(rows, 'quick-ask')).toEqual({
      notRegistered: true,
      failedAccel: 'CommandOrControl+Shift+Space',
    })
  })

  it('matches by id, not by array position', () => {
    const rows: HotkeyRegistrationRow[] = [
      { id: 'overlay-capture', accel: 'Alt+Shift+Space', ok: true },
      { id: 'quick-ask', accel: 'CommandOrControl+Shift+Space', ok: false },
    ]
    expect(getShortcutBadgeState(rows, 'overlay-capture').notRegistered).toBe(false)
    expect(getShortcutBadgeState(rows, 'quick-ask').notRegistered).toBe(true)
  })

  it('shows no badge for an action absent from registrations (e.g. in-app scope)', () => {
    const rows: HotkeyRegistrationRow[] = [
      { id: 'quick-ask', accel: 'CommandOrControl+Shift+Space', ok: false },
    ]
    // 'palette' is an in-app action — never registered globally, never in the list.
    expect(getShortcutBadgeState(rows, 'palette')).toEqual({
      notRegistered: false,
      failedAccel: null,
    })
  })

  it('handles an empty registrations array (no badge for anything)', () => {
    expect(getShortcutBadgeState([], 'quick-ask')).toEqual({
      notRegistered: false,
      failedAccel: null,
    })
  })
})
