// apps/desktop/electron/services/app-control-bridge.ts
//
// Lets a MAIN-process caller (the TACHI harness `app_control` tool) ask the
// RENDERER to perform a curated app action — read app state, set the theme,
// navigate a tab, set the Design provider — and await the result. This is what
// turns "operate/customize the app in natural language" into reality: the agent
// can drive the app the same way a button would (the agent-native "one action,
// many callers" idea), instead of only editing files.
//
// Security: this is LOCAL only (no fs, no network), so it stays available even in
// Private Mode. The boundary is the RENDERER's action ALLOWLIST (app-control
// executor) — nothing destructive or financial is exposed. Each request is keyed
// by id; the renderer replies on `app-control:result`; unanswered requests time out.

import { ipcMain, BrowserWindow } from 'electron'

export interface AppControlResult { ok: boolean; result?: unknown; error?: string }

const pending = new Map<string, (r: AppControlResult) => void>()
let wired = false

function ensureWired(): void {
  if (wired) return
  wired = true
  ipcMain.on('app-control:result', (_e, payload: { id: string } & AppControlResult) => {
    const resolve = pending.get(payload?.id)
    if (resolve) {
      pending.delete(payload.id)
      resolve({ ok: !!payload.ok, result: payload.result, error: payload.error })
    }
  })
}

/** The main app window — skip destroyed + hidden (capture/overlay) windows. */
function appWindow(): BrowserWindow | null {
  const all = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed() && !w.webContents.isDestroyed())
  return all.find(w => w.isVisible()) ?? all[0] ?? null
}

/**
 * Ask the renderer to run an app action and resolve with its result. Never
 * rejects — failures come back as `{ ok: false, error }` so the tool can surface
 * a friendly message to the model.
 */
export function execAppControl(
  action: string,
  args: Record<string, unknown> = {},
  timeoutMs = 8000,
): Promise<AppControlResult> {
  ensureWired()
  const win = appWindow()
  if (!win) return Promise.resolve({ ok: false, error: 'no app window is open' })
  const id = `ac_${Date.now()}_${Math.random().toString(36).slice(2)}`
  return new Promise<AppControlResult>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) resolve({ ok: false, error: 'app-control timed out (renderer did not reply)' })
    }, timeoutMs)
    pending.set(id, (r) => { clearTimeout(timer); resolve(r) })
    try {
      win.webContents.send('app-control:exec', { id, action, args })
    } catch (e) {
      pending.delete(id); clearTimeout(timer)
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}
