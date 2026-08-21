// apps/desktop/electron/ipc/notification.ipc.ts
//
// Allows the renderer to request a native desktop notification.
// Payload is zod-validated before forwarding to the notifications service.

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { z } from 'zod'
import { notifyTaskDone } from '../services/notifications'
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../services/auto-update'

const ShowNotificationSchema = z.object({
  title:  z.string().min(1).max(256),
  body:   z.string().max(512).default(''),
  silent: z.boolean().optional(),
})

export function registerNotificationIpc(win: BrowserWindow): void {
  // Renderer-requested native notification.
  ipcMain.handle('notification:show', (_event, payload: unknown) => {
    const { title, body, silent } = ShowNotificationSchema.parse(payload)
    notifyTaskDone(title, body, { silent })
  })

  // Manual "Check for updates" from Settings → About. Returns a discriminated
  // result (available/current/unconfigured/error); a genuinely-newer build is
  // signalled separately by the autoUpdater 'update-available' event, so we do
  // NOT synthesise an 'available' push here (that would mislabel 'current').
  ipcMain.handle('app:check-for-updates', async () => {
    return await checkForUpdates()
  })

  // Kick off download after user confirms.
  ipcMain.handle('app:download-update', () => {
    downloadUpdate()
  })

  // Quit + install the downloaded update.
  ipcMain.handle('app:quit-and-install', () => {
    quitAndInstall()
  })
}
