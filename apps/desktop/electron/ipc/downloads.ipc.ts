// apps/desktop/electron/ipc/downloads.ipc.ts
//
// downloads:* — the resumable download manager's renderer surface
// (UX-benchmark #11). Plain ipcMain.handle wiring in the llama-cpp.ipc style.
// Progress streams the other way on the 'downloads:changed' broadcast channel
// (see services/download-manager.ts).

import { ipcMain } from 'electron'
import {
  listDownloads,
  pauseManagedDownload,
  resumeManagedDownload,
  cancelManagedDownload,
  dismissManagedDownload,
} from '../services/download-manager'

function idOf(payload: unknown): string | null {
  const { id } = (payload as { id?: unknown } | null | undefined) ?? {}
  return typeof id === 'string' && id ? id : null
}

export function registerDownloadsIpc(): void {
  /** downloads:list — full snapshot of the queue (strip mounts read this once). */
  ipcMain.handle('downloads:list', () => listDownloads())

  /** downloads:pause — stop the transfer, KEEP the partial bytes for resume. */
  ipcMain.handle('downloads:pause', (_event, payload: unknown) => {
    const id = idOf(payload)
    if (!id) return { ok: false as const, error: 'id is required' }
    return { ok: pauseManagedDownload(id) }
  })

  /** downloads:resume — continue a paused/errored task from the bytes on disk. */
  ipcMain.handle('downloads:resume', (_event, payload: unknown) => {
    const id = idOf(payload)
    if (!id) return { ok: false as const, error: 'id is required' }
    return { ok: resumeManagedDownload(id) }
  })

  /** downloads:cancel — abort + delete the partial file + drop the task. */
  ipcMain.handle('downloads:cancel', (_event, payload: unknown) => {
    const id = idOf(payload)
    if (!id) return { ok: false as const, error: 'id is required' }
    return { ok: cancelManagedDownload(id) }
  })

  /** downloads:dismiss — clear a settled (done/error) row from the strip. */
  ipcMain.handle('downloads:dismiss', (_event, payload: unknown) => {
    const id = idOf(payload)
    if (!id) return { ok: false as const, error: 'id is required' }
    return { ok: dismissManagedDownload(id) }
  })
}
