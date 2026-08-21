// apps/desktop/electron/ipc/oauth.ipc.ts
import { ipcMain, shell } from 'electron'
import { z } from 'zod'
import {
  startAnthropicLogin,
  completeAnthropicLogin,
  startOpenRouterLogin,
} from '../services/oauth-service'

let activeAnthropic: { state: string; verifier: string } | null = null
let openrouterAbort: AbortController | null = null

export function registerOAuthIpc(): void {
  ipcMain.handle('oauth:anthropic-start', () => {
    const init = startAnthropicLogin()
    activeAnthropic = { state: init.state, verifier: init.verifier }
    shell.openExternal(init.authorizeUrl)
    return { authorizeUrl: init.authorizeUrl }
  })

  ipcMain.handle('oauth:anthropic-complete', async (_e, payload) => {
    const { code } = z.object({ code: z.string().min(1) }).parse(payload)
    if (!activeAnthropic) throw new Error('No active Anthropic sign-in')
    const result = await completeAnthropicLogin(code, activeAnthropic.state, activeAnthropic.verifier)
    activeAnthropic = null
    return result
  })

  ipcMain.handle('oauth:openrouter-start', async () => {
    if (openrouterAbort) openrouterAbort.abort()
    openrouterAbort = new AbortController()
    try {
      const key = await startOpenRouterLogin(openrouterAbort.signal)
      return { ok: true, key }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      openrouterAbort = null
    }
  })

  ipcMain.handle('oauth:openrouter-cancel', () => {
    openrouterAbort?.abort()
    openrouterAbort = null
  })
}
