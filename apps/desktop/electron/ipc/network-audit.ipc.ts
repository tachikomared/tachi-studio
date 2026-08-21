// electron/ipc/network-audit.ipc.ts
//
// Exposes the in-memory network audit ring buffer to the renderer via IPC.

import { ipcMain } from 'electron'
import { z }       from 'zod'
import { getRecent, clear } from '../services/network-audit'

const ListSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
})

export function registerNetworkAuditIpc(): void {
  /** Returns the most-recent entries. */
  ipcMain.handle('network-audit:list', (_event, payload: unknown) => {
    const { limit } = ListSchema.parse(payload ?? {})
    return getRecent(limit ?? 100)
  })

  /** Clears the ring buffer. */
  ipcMain.handle('network-audit:clear', () => {
    clear()
    return { ok: true }
  })
}
