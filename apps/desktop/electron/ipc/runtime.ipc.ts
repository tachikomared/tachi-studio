import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { buildRuntimeRegistry } from '../services/runtime-detect'

export function registerRuntimeIpc(win: BrowserWindow) {
  ipcMain.handle('runtime:scan-all', async () => {
    const registry = buildRuntimeRegistry()
    await Promise.all(
      registry.map(detector =>
        detector.detect().then(update => {
          if (!win.isDestroyed()) win.webContents.send('runtime:card-update', update)
        }).catch(() => {
          if (!win.isDestroyed()) win.webContents.send('runtime:card-update', {
            runtimeId: detector.runtimeId,
            kind: detector.kind,
            displayName: detector.displayName,
            status: 'error',
            checkedAt: new Date().toISOString(),
          })
        })
      )
    )
  })

  ipcMain.handle('runtime:scan-one', async (_event, payload: unknown) => {
    const { runtimeId } = z.object({ runtimeId: z.string() }).parse(payload)
    const registry = buildRuntimeRegistry()
    const detector = registry.find(d => d.runtimeId === runtimeId)
    if (!detector) throw new Error(`Unknown runtime: ${runtimeId}`)
    return detector.detect()
  })
}
