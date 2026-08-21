// apps/desktop/electron/ipc/connectors.ipc.ts
import { ipcMain } from 'electron'
import { z } from 'zod'
import { listConnectors, disconnectConnector } from '../services/connectors-service'

export function registerConnectorsIpc(): void {
  ipcMain.handle('connectors:list', () => listConnectors())

  ipcMain.handle('connectors:disconnect', (_e, payload) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(payload)
    const ok = disconnectConnector(id)
    return { ok }
  })
}
