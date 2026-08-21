// apps/desktop/electron/ipc/yt-dlp.ipc.ts
//
// IPC surface for media URL-import (STEAL 2026-06-21 #8). Three read/act
// handlers consumed by the Media page's "Import from URL" panel. The page URL
// is egress-gated inside the service (PRIVATE MODE + SSRF), so a malicious or
// private-mode request is refused before yt-dlp runs.

import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { getMediaInfo, downloadMedia } from '../services/yt-dlp-service'
import { isYtDlpInstalled } from '../services/yt-dlp-installer'

export function registerYtDlpIpc(): void {
  ipcMain.handle('ytdlp:installed', async () => ({ installed: isYtDlpInstalled() }))

  ipcMain.handle('ytdlp:info', async (e, payload: unknown) => {
    const { url } = z.object({ url: z.string().min(1) }).parse(payload)
    const win = BrowserWindow.fromWebContents(e.sender)
    try {
      return { ok: true as const, info: await getMediaInfo(url, win) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('ytdlp:download', async (e, payload: unknown) => {
    const { url, formatId, audioOnly } = z.object({
      url: z.string().min(1),
      formatId: z.string().optional(),
      audioOnly: z.boolean().optional(),
    }).parse(payload)
    const win = BrowserWindow.fromWebContents(e.sender)
    return downloadMedia({ url, formatId, audioOnly, win })
  })
}
