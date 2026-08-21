import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  isRouterInstalled,
  installRouter,
  readConfig,
  writeConfig,
  seedFromTachi,
  type RouterConfig,
} from '../services/router-service'
import { startRouter, stopRouter } from '../services/sidecar-manager'

export function registerClaudeCodeRouterIpc(win: BrowserWindow): void {
  /** Returns whether @musistudio/claude-code-router is installed globally. */
  ipcMain.handle('claude-code-router:check-installed', async () => ({
    installed: await isRouterInstalled(),
  }))

  /**
   * Install @musistudio/claude-code-router globally via npm.
   * Streams RouterInstallProgress via 'claude-code-router:install-progress'.
   */
  ipcMain.handle('claude-code-router:install', async () => {
    try {
      await installRouter(win)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('claude-code-router:install-progress', {
          step: 'error', message, percent: 0,
        })
      }
      throw err
    }
  })

  /** Start the router sidecar. */
  ipcMain.handle('claude-code-router:start', async () => {
    await startRouter()
  })

  /** Stop the router sidecar. */
  ipcMain.handle('claude-code-router:stop', () => {
    stopRouter()
  })

  /** Read current config from disk. Returns null if not yet written. */
  ipcMain.handle('claude-code-router:read-config', () => {
    return readConfig()
  })

  /**
   * Write (overwrite) config to disk.
   *
   * RouterConfig is intentionally loose (upstream schema passthrough), so we
   * validate the structural skeleton only: must be a plain object; Providers,
   * when present, must be an array of { name, api_base_url, api_key } objects;
   * Router, when present, must be an object. This stops a malformed renderer
   * payload (null/array/primitive, type-confused providers) from being
   * serialised into the sidecar's config file. Throwing is the contract —
   * RouterSection.tsx catches and surfaces the message via setError.
   */
  ipcMain.handle('claude-code-router:write-config', (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('write-config: payload must be a JSON object')
    }
    const cfg = payload as RouterConfig
    if (cfg.Providers !== undefined) {
      const bad =
        !Array.isArray(cfg.Providers) ||
        cfg.Providers.some(
          (p) =>
            p === null || typeof p !== 'object' ||
            typeof p.name !== 'string' ||
            typeof p.api_base_url !== 'string' ||
            typeof p.api_key !== 'string',
        )
      if (bad) {
        throw new Error('write-config: Providers must be an array of { name, api_base_url, api_key } objects')
      }
    }
    if (cfg.Router !== undefined && (cfg.Router === null || typeof cfg.Router !== 'object' || Array.isArray(cfg.Router))) {
      throw new Error('write-config: Router must be an object')
    }
    writeConfig(cfg)
  })

  /**
   * Seed the config from TachiDesk's stored keys (OpenGateway, OpenRouter, Ollama).
   * Returns the written config so the renderer can display it.
   */
  ipcMain.handle('claude-code-router:seed-config', () => {
    return seedFromTachi()
  })
}
