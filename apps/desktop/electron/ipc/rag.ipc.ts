// apps/desktop/electron/ipc/rag.ipc.ts
//
// Local folder RAG surface (rag-service): index/search/status over IPC so any
// renderer surface (nodes, future chat attach, quick tools) can use it. The
// heavy lifting — embedder + vector store — stays in main.

import { ipcMain } from 'electron'
import { indexFolder, searchFolder, ragStatus } from '../services/rag-service'

export function registerRagIpc(): void {
  ipcMain.handle('rag:index', async (_e, payload: unknown) => {
    const { root, force } = (payload ?? {}) as { root?: string; force?: boolean }
    if (typeof root !== 'string' || !root.trim()) return { ok: false, error: 'No folder path.' }
    return indexFolder(root.trim(), !!force)
  })

  ipcMain.handle('rag:search', async (_e, payload: unknown) => {
    const { root, query, k } = (payload ?? {}) as { root?: string; query?: string; k?: number }
    if (typeof root !== 'string' || !root.trim()) return { ok: false, error: 'No folder path.' }
    if (typeof query !== 'string' || !query.trim()) return { ok: false, error: 'No query.' }
    const kk = typeof k === 'number' && Number.isFinite(k) ? Math.max(1, Math.min(12, Math.round(k))) : 6
    return searchFolder(root.trim(), query.trim(), kk)
  })

  ipcMain.handle('rag:status', async (_e, payload: unknown) => {
    const { root } = (payload ?? {}) as { root?: string }
    if (typeof root !== 'string' || !root.trim()) return { ok: false, error: 'No folder path.' }
    return { ok: true, ...ragStatus(root.trim()) }
  })
}
