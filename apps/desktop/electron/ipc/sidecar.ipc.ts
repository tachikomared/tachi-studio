import { ipcMain, app } from 'electron'
import type { BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import {
  startFreellmapi,
  stopFreellmapi,
  startOpenClaude,
  stopOpenClaude,
  stopFreeClaudeCode,
  listSidecars,
  healthCheckSidecar,
} from '../services/sidecar-manager'
import {
  isFreellmapiInstalled,
  installFreellmapi,
} from '../services/freellmapi-installer'

const SidecarIdSchema = z.enum(['freellmapi', 'openclaude', 'freeclaudecode'])

// Map sidecar id → log file name in userData. Only openclaude currently writes a
// dedicated log file (others use stdio:ignore). Easy to extend later.
const LOG_PATHS: Partial<Record<string, string>> = {
  openclaude: 'openclaude.log',
}

const StartSchema = z.object({
  id:         SidecarIdSchema,
  workingDir: z.string().min(1).optional(),
})

const StopSchema = z.object({
  id: SidecarIdSchema,
})

const HealthSchema = z.object({
  id: SidecarIdSchema,
})

export function registerSidecarIpc(win: BrowserWindow): void {
  /** Returns the current state snapshot for all sidecars. */
  ipcMain.handle('sidecar:list', () => {
    return listSidecars()
  })

  /**
   * Starts the specified sidecar.
   *
   * Dispatch is per-id. It used to be `freellmapi ? startFreellmapi : startGoose`,
   * which meant pressing START on the openclaude/freeclaudecode row silently
   * started GOOSE instead — a latent bug that only surfaced when goose was
   * removed. `freeclaudecode` has no manual start (it is spawned by the chat
   * path that needs it), so it reports that rather than starting the wrong thing.
   */
  ipcMain.handle('sidecar:start', async (_event, payload: unknown) => {
    const { id } = StartSchema.parse(payload)
    if      (id === 'freellmapi') await startFreellmapi()
    else if (id === 'openclaude') await startOpenClaude()
    else throw new Error(`sidecar:start does not manage "${id}" — it starts on demand from the surface that needs it.`)
    return listSidecars().find(s => s.id === id)
  })

  /** Stops the specified sidecar. */
  ipcMain.handle('sidecar:stop', (_event, payload: unknown) => {
    const { id } = StopSchema.parse(payload)
    if      (id === 'freellmapi')     stopFreellmapi()
    else if (id === 'openclaude')     stopOpenClaude()
    else if (id === 'freeclaudecode') stopFreeClaudeCode()
    return listSidecars().find(s => s.id === id)
  })

  /**
   * Performs a live health probe.
   * Returns true only when the process is verified reachable.
   */
  ipcMain.handle('sidecar:health', async (_event, payload: unknown) => {
    const { id } = HealthSchema.parse(payload)
    return healthCheckSidecar(id)
  })

  /** Returns whether freellmapi's built entry point exists. */
  ipcMain.handle('sidecar:check-installed', () => ({
    installed: isFreellmapiInstalled(),
  }))

  /**
   * Returns the last N lines of a sidecar's log file (if one exists).
   * Currently only openclaude writes a dedicated log file.
   */
  ipcMain.handle('sidecar:logs', (_event, payload: unknown) => {
    const { id, lines } = z.object({
      id:    SidecarIdSchema,
      lines: z.number().int().min(1).max(2000).optional(),
    }).parse(payload)
    const fileName = LOG_PATHS[id]
    if (!fileName) return { available: false, lines: [] }
    const path = join(app.getPath('userData'), fileName)
    if (!existsSync(path)) return { available: true, lines: [], path }
    try {
      const content = readFileSync(path, 'utf8')
      // Take the last N lines; tail behavior. Default 200.
      const split = content.split(/\r?\n/)
      const tail  = split.slice(Math.max(0, split.length - (lines ?? 200)))
      return { available: true, lines: tail, path }
    } catch (err) {
      return { available: true, lines: [`<failed to read log: ${String(err)}>`], path }
    }
  })

  /**
   * Clones, installs, and builds freellmapi.
   * Streams InstallProgressEvent via 'sidecar:install-progress' push channel.
   * On success, starts freellmapi automatically.
   */
  ipcMain.handle('sidecar:install', async () => {
    try {
      await installFreellmapi(win)
      await startFreellmapi()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('sidecar:install-progress', {
          step: 'error', message, percent: 0,
        })
      }
      throw err
    }
  })
}
