// apps/desktop/electron/ipc/chat-archive.ipc.ts
//
// Full-text chat search over the JSON conversation archive (chat-search-
// service: SQLite FTS5 via wasm — derived index, JSON stays source of truth).

import { ipcMain } from 'electron'
import { getChatIndex } from '../services/chat-search-service'

export function registerChatArchiveIpc(): void {
  ipcMain.handle('chat-archive:search', async (_e, payload: unknown) => {
    const { query, limit } = (payload ?? {}) as { query?: string; limit?: number }
    if (typeof query !== 'string' || !query.trim()) return { ok: false, error: 'No query.' }
    const lim = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.round(limit))) : 20
    try {
      const { hits, mode } = getChatIndex().search(query.trim(), lim)
      return { ok: true, hits, mode }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('chat-archive:status', async () => {
    try {
      const sync = getChatIndex().sync()
      return { ok: true, ...getChatIndex().status(), ...sync }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
