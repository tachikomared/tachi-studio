// apps/desktop/electron/services/hotkey-manager.ts
//
// Manages OS-wide (global) keyboard shortcuts defined in the HOTKEY_ACTIONS
// registry. Call registerAll() on app boot and whenever hotkey settings change.
//
// When a global shortcut fires, main sends a 'hotkey:fired' IPC event to the
// renderer carrying the action id. Consumers (e.g. overlay-service) subscribe
// to 'hotkey:fired' instead of registering their own globalShortcut calls.

import { app, globalShortcut, BrowserWindow, ipcMain } from 'electron'
import { HOTKEY_ACTIONS } from '../../src/types/hotkeys'

// The main window reference — set once by init() and cleared on window close.
let mainWindowRef: BrowserWindow | null = null

// Resolve the effective accelerator for an action: user override → default.
function resolveAccelerator(
  actionId: string,
  hotkeys: Record<string, string>,
  defaultAccelerator: string,
): string {
  return hotkeys[actionId] ?? defaultAccelerator
}

/**
 * Must be called once (e.g. from main.ts createWindow) so the manager knows
 * which window to send 'hotkey:fired' events to.
 */
export function initHotkeyManager(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow
  mainWindow.on('closed', () => { mainWindowRef = null })
}

/**
 * Outcome of one global-shortcut binding attempt. `ok:false` means another app
 * already owns that accelerator (the loudest complaint in this category on
 * Windows: whichever app registered first wins, silently). Reported so the UI
 * can eventually badge a dead binding instead of leaving the user guessing.
 */
export type HotkeyRegistration = { id: string; accel: string; ok: boolean }

// Result of the most recent registerAll() — read via getHotkeyRegistrations()
// and exposed over the hotkeys IPC ('hotkeys:registrations').
let lastRegistrations: HotkeyRegistration[] = []

/** Per-action registration results from the last registerAll() call. */
export function getHotkeyRegistrations(): HotkeyRegistration[] {
  return lastRegistrations
}

/**
 * (Re-)registers all global-scope hotkeys. Safe to call multiple times —
 * unregisters all first to avoid double-binding.
 *
 * @param hotkeys User's saved overrides from settings.hotkeys (may be empty).
 * @returns One {id, accel, ok} row per global action, in registry order.
 */
export function registerAll(hotkeys: Record<string, string>): HotkeyRegistration[] {
  // Unregister all previous bindings so re-registration is idempotent.
  globalShortcut.unregisterAll()

  const results: HotkeyRegistration[] = []

  for (const action of HOTKEY_ACTIONS) {
    if (action.scope !== 'global') continue

    const accel = resolveAccelerator(action.id, hotkeys, action.defaultAccelerator)
    const id    = action.id  // capture for closure

    const ok = globalShortcut.register(accel, () => {
      // Notify the renderer (for potential in-renderer handling).
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send('hotkey:fired', { id })
      }
      // Notify main-process listeners (e.g. overlay-service) via synthetic IPC event.
      ipcMain.emit('hotkey:fired-internal', null, { id })
    })

    results.push({ id, accel, ok })

    if (!ok) {
      console.warn(`[hotkey-manager] Failed to register global shortcut "${accel}" for action "${id}"`)
    }
  }

  lastRegistrations = results
  return results
}

// Clean up all shortcuts on quit so we don't leave dangling registrations.
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
