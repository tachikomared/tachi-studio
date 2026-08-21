// apps/desktop/test/unit/hotkeyRegistrations.test.ts
//
// hotkey-manager registerAll() result reporting. A global accelerator that
// another app already owns fails SILENTLY in Electron (globalShortcut.register
// returns false) — the manager now returns/stores one {id, accel, ok} row per
// global action so the failure is at least reportable over IPC.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const registered: string[] = []
let refuse: string[] = []

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  BrowserWindow: class {},
  ipcMain: { emit: vi.fn(), on: vi.fn(), handle: vi.fn() },
  globalShortcut: {
    register: (accel: string) => {
      if (refuse.includes(accel)) return false
      registered.push(accel)
      return true
    },
    unregisterAll: () => { registered.length = 0 },
  },
}))

import { registerAll, getHotkeyRegistrations } from '../../electron/services/hotkey-manager'
import { HOTKEY_ACTIONS } from '../../src/types/hotkeys'

const GLOBAL_ACTIONS = HOTKEY_ACTIONS.filter(a => a.scope === 'global')

beforeEach(() => { refuse = []; registered.length = 0 })

describe('registerAll result shape', () => {
  it('returns one {id, accel, ok} row per GLOBAL action (in-app actions excluded)', () => {
    const results = registerAll({})
    expect(results).toHaveLength(GLOBAL_ACTIONS.length)
    for (const r of results) {
      expect(Object.keys(r).sort()).toEqual(['accel', 'id', 'ok'])
      expect(typeof r.id).toBe('string')
      expect(typeof r.accel).toBe('string')
      expect(r.ok).toBe(true)
    }
    expect(results.map(r => r.id)).toEqual(GLOBAL_ACTIONS.map(a => a.id))
    expect(results.some(r => r.id === 'quick-ask')).toBe(true)
    // in-app actions are never registered globally
    expect(results.some(r => r.id === 'palette')).toBe(false)
  })

  it('reports ok:false for an accelerator another app already owns', () => {
    const quickAsk = GLOBAL_ACTIONS.find(a => a.id === 'quick-ask')!
    refuse = [quickAsk.defaultAccelerator]
    const results = registerAll({})
    const row = results.find(r => r.id === 'quick-ask')!
    expect(row).toEqual({ id: 'quick-ask', accel: quickAsk.defaultAccelerator, ok: false })
    expect(results.filter(r => r.ok).length).toBe(GLOBAL_ACTIONS.length - 1)
  })

  it('reports the USER OVERRIDE accelerator, not the default', () => {
    const results = registerAll({ 'quick-ask': 'Alt+Space' })
    expect(results.find(r => r.id === 'quick-ask')).toEqual({ id: 'quick-ask', accel: 'Alt+Space', ok: true })
  })

  it('stores the last results for the hotkeys IPC to read back', () => {
    registerAll({ 'quick-ask': 'Alt+Space' })
    expect(getHotkeyRegistrations()).toEqual(registerAll({ 'quick-ask': 'Alt+Space' }))
    expect(getHotkeyRegistrations().find(r => r.id === 'quick-ask')?.accel).toBe('Alt+Space')
  })
})
