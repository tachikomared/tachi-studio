// apps/desktop/electron/services/auto-update.ts
//
// Wires electron-updater into TachiDesk's renderer toast / notification system.
// Auto-download is off: we only inform the user and let them decide.
//
// The existing setupAutoUpdater() in main.ts used dialog boxes. This module
// replaces that with IPC push events the renderer can turn into toasts, plus
// a native notification for update-downloaded.

import type { BrowserWindow } from 'electron'
import { notifyTaskDone } from './notifications'

// ── R8b: electron-updater is loaded ON FIRST USE, not at boot ────────────────
//
// Measured (R8b baseline, installed build 2026-07-27): the static
// `import { autoUpdater } from 'electron-updater'` cost **34.4 ms** of the
// 1317 ms pre-STARTUP_T0 prelude — for a feature that, on a build without a
// publish feed, immediately fails with `ENOENT … app-update.yml` and does
// nothing. Its own `startupPhase('auto-update')` span measures 0-1 ms; the
// whole cost was the import.
//
// A BARE-specifier `require()` (not a relative one — see
// test/unit/noRuntimeRelativeRequire.test.ts) is deliberate here instead of
// `await import()`: it keeps every exported signature SYNCHRONOUS, so
// `setupAutoUpdate` still throws through `startupPhase('auto-update', …)` on
// the same call, in the same order, as it did when the failure happened at
// module-eval time. electron-vite emits CJS for the main process and
// externalizes deps, so this is byte-for-byte the same `require("electron-updater")`
// the bundler used to hoist — only later.
type UpdaterModule = typeof import('electron-updater')
let updaterModule: UpdaterModule | null = null
/** The electron-updater singleton, loaded on first touch. Memoized. */
function updater(): UpdaterModule['autoUpdater'] {
  updaterModule ??= require('electron-updater') as UpdaterModule
  return updaterModule.autoUpdater
}

let wired = false

function pushUpdateStatus(win: BrowserWindow, payload: { state: string; version?: string }): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('app:update-status', payload)
  }
}

export function setupAutoUpdate(win: BrowserWindow): void {
  if (wired) return
  wired = true

  const autoUpdater = updater()

  // Do not auto-download — user must click the button.
  autoUpdater.autoDownload = false
  // Silently install on next quit if already downloaded.
  autoUpdater.autoInstallOnAppQuit = true

  // Route electron-updater logs to console rather than a file.
  autoUpdater.logger = {
    info:  (msg: unknown) => console.info('[updater]', msg),
    warn:  (msg: unknown) => console.warn('[updater]', msg),
    error: (msg: unknown) => console.error('[updater]', msg),
    debug: (msg: unknown) => console.debug('[updater]', msg),
    // electron-updater logger interface has a `transports` property but we
    // don't use it — satisfying as `unknown` is enough.
  } as unknown as typeof autoUpdater.logger

  autoUpdater.on('update-available', (info: { version: string }) => {
    pushUpdateStatus(win, { state: 'available', version: info.version })
  })

  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    pushUpdateStatus(win, { state: 'ready', version: info.version })
    notifyTaskDone('Update ready', 'Restart Tachi Studio to install the new version.')
  })

  autoUpdater.on('error', (err: Error) => {
    console.warn('[updater] error:', err.message)
    // Do not surface every error as a toast — network hiccups are normal.
    // The renderer can check on-demand via the manual check button.
  })

  // Delay the first check by 5 s so sidecars and the renderer have time to settle.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, 5_000)
}

/**
 * The outcome of a manual update check. Crucially distinguishes "no update feed
 * configured" (dev build, or a packaged build without a publish provider) from
 * "genuinely up to date" — the renderer must NOT claim "up to date" when the
 * updater literally cannot check (that was the C3 audit bug: every prod build
 * showed "up to date" because the check threw and was swallowed to null).
 */
export type UpdateCheckResult =
  | { state: 'available'; version: string }
  | { state: 'current' }
  | { state: 'unconfigured' }
  | { state: 'error'; message: string }

/** True when the thrown error means "there is no update feed to check". */
function isUnconfigured(msg: string): boolean {
  return /app-update\.yml|dev-app-update|not packed|dev update config|update config (was )?not found|ENOENT|No published versions|Unable to find latest version/i.test(msg)
}

/** Programmatically trigger an update check. */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  try {
    await updater().checkForUpdates()
    // The 'update-available' event (pushed to the renderer) is the authoritative
    // "newer version exists" signal and upgrades the UI to 'available'. If the
    // check succeeds without throwing, we are reachable + on the latest.
    return { state: 'current' }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    if (isUnconfigured(msg)) return { state: 'unconfigured' }
    return { state: 'error', message: msg }
  }
}

/** Start downloading a previously-announced update. */
export function downloadUpdate(): void {
  updater().downloadUpdate().catch((err: Error) => {
    console.warn('[updater] download failed:', err.message)
  })
}

/** Quit and install the downloaded update. */
export function quitAndInstall(): void {
  updater().quitAndInstall()
}
