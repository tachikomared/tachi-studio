// apps/desktop/electron/ipc/hotkeys.ipc.ts
//
// IPC handler for saving user hotkey overrides. Saves to settings and
// immediately re-registers global shortcuts so the new bindings take effect.

import { ipcMain } from 'electron'
import { z } from 'zod'
import { loadSettings, saveSettings } from '../services/settings-store'
import { registerAll, getHotkeyRegistrations } from '../services/hotkey-manager'

export function registerHotkeysIpc(): void {
  ipcMain.handle('hotkeys:save', (_event, payload: unknown) => {
    const schema = z.object({
      hotkeys: z.record(z.string(), z.string()),
    })
    const { hotkeys } = schema.parse(payload)
    saveSettings({ hotkeys })
    // Re-register global shortcuts with the updated bindings immediately.
    registerAll(hotkeys)
  })

  ipcMain.handle('hotkeys:load', () => {
    const settings = loadSettings()
    return settings.hotkeys ?? {}
  })

  // Per-action binding results from the last registerAll() — {id, accel, ok}.
  // `ok:false` = another app already owns that accelerator. Data only for now;
  // the Settings -> Shortcuts badge that renders it is NOT built yet.
  ipcMain.handle('hotkeys:registrations', () => getHotkeyRegistrations())
}
