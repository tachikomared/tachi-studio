// apps/desktop/electron/ipc/codex.ipc.ts
//
// IPC for the Codex worker sidecar (Settings → CODEX WORKER card):
//   codex:status  — { installed, version, loggedIn, detail }
//   codex:install — npm-installs the pinned @openai/codex into userData/sidecars
//                   (progress via 'codex:install-progress' pushes)
//   codex:login   — runs `codex login` for the user (opens the browser;
//                   output lines via 'codex:login-progress' pushes)
//
// Once installed (+ logged in), the TACHI harness auto-gains the gated
// codex_worker delegation tool on its next session — installing IS "adding
// the worker" (same semantic as openai/codex-plugin-cc for Claude Code).

import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  isCodexInstalled, installCodex, codexAuthStatus, loginCodex, logoutCodex,
  resolveCodexHome, strayAuthLocation, adoptStrayAuth, CODEX_VERSION,
} from '../services/codex-installer'
import { getCodexLog } from '../services/codex-run-log'
import { loadSettings, saveSettings } from '../services/settings-store'

function mainWin(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

export function registerCodexIpc(): void {
  ipcMain.handle('codex:status', async () => {
    const enabled = loadSettings().codexWorkerEnabled !== false
    const installed = isCodexInstalled()
    if (!installed) return { installed: false, version: CODEX_VERSION, loggedIn: false, detail: '', enabled, home: resolveCodexHome(), strayAuthAt: null }
    const auth = await codexAuthStatus()
    // Troubleshooting: a login sitting in the NON-active codex home (moved
    // CODEX_HOME, tools that ignored the var, app launched without the env).
    const strayAuthAt = auth.loggedIn ? null : strayAuthLocation()
    return { installed: true, version: CODEX_VERSION, loggedIn: auth.loggedIn, detail: auth.detail, enabled, home: resolveCodexHome(), strayAuthAt }
  })

  // One-click fix for the stray-login case: copy auth.json into the active home.
  ipcMain.handle('codex:adopt-auth', () => adoptStrayAuth())

  // The CODE-tab chip's ON/OFF toggle: controls whether the TACHI harness
  // injects the codex_worker delegation tool for its next session.
  ipcMain.handle('codex:set-enabled', (_e, p: unknown) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(p)
    saveSettings({ codexWorkerEnabled: enabled })
    return { ok: true as const, enabled }
  })

  ipcMain.handle('codex:install', async () => {
    return await installCodex(mainWin())
  })

  ipcMain.handle('codex:login', async () => {
    return await loginCodex(mainWin())
  })

  // The fix for the "refresh token was already used" dead-end: clear the auth
  // so the card/chip flip to LOG IN and a fresh browser login can be made.
  ipcMain.handle('codex:logout', async () => {
    return await logoutCodex()
  })

  // Console dock CODEX tab: the run journal snapshot (live lines arrive via
  // 'codex:log-event' pushes from codex-run-log).
  ipcMain.handle('codex:get-log', () => getCodexLog())
}
