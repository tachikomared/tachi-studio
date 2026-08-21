// apps/desktop/electron/ipc/ollama.ipc.ts
import { ipcMain, type BrowserWindow } from 'electron'
import {
  ensureOllamaRunning,
  isOllamaRunning,
  listOllamaModels,
  pullOllamaModel,
  deleteOllamaModel,
} from '../services/ollama-service'

export function registerOllamaIpc(mainWindow: BrowserWindow | null): void {
  ipcMain.handle('ollama:status', async () => ({ running: await isOllamaRunning() }))

  ipcMain.handle('ollama:ensure-running', async () => {
    try { await ensureOllamaRunning(); return { ok: true } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('ollama:list-models', async () => {
    try { return { ok: true, models: await listOllamaModels() } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err), models: [] } }
  })

  ipcMain.handle('ollama:delete', async (_event, payload: unknown) => {
    const { name } = (payload as { name?: string } | null | undefined) ?? {}
    if (!name) return { ok: false as const, error: 'name is required' }
    try {
      await deleteOllamaModel(name)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('ollama:pull', async (_event, payload: unknown) => {
    const { name } = (payload as { name?: string } | null | undefined) ?? {}
    if (!name) return { ok: false as const, error: 'name is required' }
    try {
      await pullOllamaModel(name, (p) => {
        mainWindow?.webContents.send('ollama:pull-progress', { name, ...p })
      })
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
