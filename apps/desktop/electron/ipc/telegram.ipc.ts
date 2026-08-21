// apps/desktop/electron/ipc/telegram.ipc.ts
//
// IPC for the Telegram remote channel (Settings → TELEGRAM card):
//   telegram:status     — enabled/running/hasToken/paired/pairingCode/workspace
//   telegram:set-token  — store the bot token (keychain 'telegram-bot') + sync
//   telegram:set-enabled— toggle + sync (starts/stops the long-poll loop)
//   telegram:unpair     — forget the paired chat (new pairing code on sync)
//   telegram:choose-workspace — folder picker for the agent's workspace
//
// The token NEVER leaves main (status only reports hasToken).

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { z } from 'zod'
import { storeKey, deleteKey } from '../services/keychain'
import { saveSettings } from '../services/settings-store'
import { syncTelegramService, telegramStatus, unpairTelegram } from '../services/telegram-service'

export function registerTelegramIpc(): void {
  ipcMain.handle('telegram:status', () => telegramStatus())

  ipcMain.handle('telegram:set-token', (_e, p: unknown) => {
    const { token } = z.object({ token: z.string().max(200) }).parse(p)
    if (token.trim()) storeKey('telegram-bot', token.trim())
    else deleteKey('telegram-bot')
    syncTelegramService()
    return telegramStatus()
  })

  ipcMain.handle('telegram:set-enabled', (_e, p: unknown) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(p)
    saveSettings({ telegramEnabled: enabled })
    syncTelegramService()
    return telegramStatus()
  })

  ipcMain.handle('telegram:unpair', () => {
    unpairTelegram()
    return telegramStatus()
  })

  ipcMain.handle('telegram:choose-workspace', async () => {
    const win = BrowserWindow.getAllWindows()[0] ?? null
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    const picked = res.canceled ? null : res.filePaths[0]
    if (picked) { saveSettings({ telegramWorkspace: picked }); syncTelegramService() }
    return telegramStatus()
  })
}
