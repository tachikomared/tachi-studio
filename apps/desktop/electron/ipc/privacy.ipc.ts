// apps/desktop/electron/ipc/privacy.ipc.ts
//
// PRIVATE MODE (Tier 1) — main-process side of the privacy toggle.
//
// The renderer is the source of truth (zustand + persisted encrypted
// localStorage in apps/desktop/src/store/privacy.store.ts). The main
// process mirrors the current mode here so that Tier 2 enforcement
// modules (chat-service, agent.ipc.ts) can synchronously gate cloud
// providers at the IPC boundary without an extra round-trip to the
// renderer.
//
// Channels:
//   privacy:set-mode   — renderer → main. Updates currentMode and
//                        re-broadcasts to every BrowserWindow as
//                        `privacy:mode-changed` so other open windows
//                        stay in sync.
//   privacy:get-mode   — renderer → main. Returns the current mode.
//                        Used by future Tier 2 callers; the store
//                        rehydrates from its own persisted copy on
//                        startup, so this is mostly for diagnostics.
//
// Default: 'open'. The renderer's onRehydrateStorage callback pushes
// the persisted value back to main shortly after preload finishes,
// so the 'open' default only applies during the first ~50ms of a
// cold launch.

import { ipcMain, BrowserWindow } from 'electron'
import { coerceMode, startupModeFromStrict, type PrivacyMode } from './privacy-mode'

export type { PrivacyMode }

// Fail-CLOSED default (audit 2026-06-12, dim 6): if main is queried before the
// startup init / renderer rehydrate runs, block egress rather than allowing it.
// registerPrivacyIpc() immediately reconciles this to the user's persisted mode,
// so open-mode users are not blocked in practice.
let currentMode: PrivacyMode = 'private'

/** Synchronous read for other main-process modules (Tier 2 gating). */
export function getCurrentPrivacyMode(): PrivacyMode {
  return currentMode
}

/**
 * Broadcast the new mode to every open BrowserWindow except the sender.
 * Excluding the sender prevents an echo loop when a renderer subscribes
 * to `onModeChange(setMode)` — without exclusion the setMode→IPC→broadcast
 * roundtrip would ping-pong against the very window that initiated it.
 */
function broadcast(mode: PrivacyMode, excludeSenderId?: number): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue
    if (excludeSenderId !== undefined && w.webContents.id === excludeSenderId) continue
    w.webContents.send('privacy:mode-changed', { mode })
  }
}

export interface RegisterPrivacyIpcOptions {
  /**
   * The persisted `strictPrivacyMode` flag, read by the CALLER (main.ts, which
   * already imports settings-store). Injected rather than imported so this
   * module keeps settings-store — which touches app.getPath at module load —
   * out of the import graph of the many callers that only want
   * getCurrentPrivacyMode(). It used to be pulled in with a function-body
   * require of a relative path, which does not resolve inside the packaged
   * bundle (single out/main/index.js): the catch there swallowed the failure and
   * a user with strict privacy ON silently cold-started in 'open' mode.
   */
  strictPrivacyMode?: boolean
}

export function registerPrivacyIpc(opts: RegisterPrivacyIpcOptions = {}): void {
  // Initialise from the persisted setting so the mode is correct from t=0 —
  // closes the cold-start window where currentMode could differ from the user's
  // real choice (audit 2026-06-12, dim 6).
  currentMode = startupModeFromStrict(opts.strictPrivacyMode)

  ipcMain.handle('privacy:set-mode', (event, payload: unknown) => {
    const next = coerceMode((payload as { mode?: unknown } | null | undefined)?.mode)
    const changed = next !== currentMode
    currentMode = next
    if (changed) broadcast(currentMode, event.sender.id)
    return { ok: true as const, mode: currentMode }
  })

  ipcMain.handle('privacy:get-mode', () => {
    return { mode: currentMode }
  })
}
