// apps/desktop/electron/ipc/rife.ipc.ts
//
// IPC surface for the RIFE frame-interpolation sidecar.
//   rife:status      — { installed, version, model, downloadBytes, supported, active[] }
//   rife:install     — download + verify + extract + sanity-run the sidecar
//   rife:uninstall   — delete the install (431 MB of models, so this matters)
//   rife:interpolate — one local video → "<name>-rife2x.mp4" beside it
//   rife:cancel      — stop the run for one source path
// Push: rife:install-progress  (installer stages, rail-compatible vocabulary)
//       rife:progress          (per-run stages + real frame counts)
//
// REGISTERED FROM sd-cpp.ipc.ts, NOT main.ts — the same rule civitai.ipc
// follows and civitaiIpcWiring pins: electron-vite bundles electron/ into ONE
// entry chunk, so every name main.ts imports is evaluated above STARTUP_T0.
// This vertical is a sibling of the local media engines, so it hangs off their
// registrar, which already owns a BrowserWindow.
//
// NO EGRESS GATE HERE, DELIBERATELY. yt-dlp's handlers call checkUrlEgressSafe
// because they fetch a remote page; this one reads a file the user already has
// and spawns three local programs. PRIVATE MODE must not disable it — blocking
// a purely local computation would be theatre, and the guard that matters
// (localVideoRefusal) is the one that stops a remote URL from reaching ffmpeg
// in the first place.

import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { installRife, uninstallRife, rifeStatus } from '../services/rife-installer'
import { interpolateVideo, cancelRifeRun, activeRifeRuns } from '../services/rife-runner'

export function registerRifeIpc(win: BrowserWindow): void {
  ipcMain.handle('rife:status', () => ({ ...rifeStatus(), active: activeRifeRuns() }))

  ipcMain.handle('rife:install', async () => {
    try {
      await installRife(win)
      return { ok: true as const, ...rifeStatus() }
    } catch (err) {
      // The installer pushes its own 'error' stage; this is the awaited answer
      // the button inspects, so it must carry the reason rather than throw
      // across the bridge (where it would arrive as an opaque Error).
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('rife:uninstall', () => uninstallRife())

  ipcMain.handle('rife:interpolate', async (e, payload: unknown) => {
    const { path, multiplier } = z.object({
      path: z.string().min(1),
      multiplier: z.union([z.literal(2), z.literal(4)]).optional(),
    }).parse(payload)
    // The window that ASKED gets the progress — not a captured one, so a run
    // started from a reopened window still reports to the surface in front.
    const sender = BrowserWindow.fromWebContents(e.sender) ?? win
    return interpolateVideo({ sourcePath: path, multiplier, win: sender })
  })

  ipcMain.handle('rife:cancel', (_e, payload: unknown) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(payload)
    return { ok: cancelRifeRun(path) }
  })
}
