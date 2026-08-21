// apps/desktop/electron/services/portable-mode.ts
//
// PORTABLE MODE — the app in one folder, touching nothing else on the machine.
//
// The normal install splits its files in two, on purpose: things a person wants
// to find (generated media, designs, renders) go to `Documents\Tachi Studio`,
// and things they never need to see (settings, keys, logs, sidecar binaries,
// model weights, indexes) go to `app.getPath('userData')` — on Windows that is
// `C:\Users\<name>\AppData\Roaming\tachi-studio-desktop`.
//
// That is right for an installed app and wrong for a folder you unzip onto a
// drive and hand to someone, or keep on a stick, or run on a machine whose C:
// you would rather not write to at all. So: if a directory named `tachi-data`
// sits next to the executable, EVERYTHING goes inside it — the internals and the
// user content both — and the app writes nowhere else.
//
// ── WHY A MARKER YOU CREATE, AND NOT AUTO-DETECTION ──────────────────────────
//
// The tempting version is "if the folder next to the exe is writable, be
// portable". That guesses, and it guesses about where a person's data lives. A
// user who unzips to their Desktop would silently get a different data location
// than the same build installed normally, with no way to tell which they are
// looking at. An explicit marker is one documented step and it is never a
// surprise. It is the same choice VS Code and Obsidian make.
//
// ── WHY THIS MUST BE THE FIRST IMPORT ────────────────────────────────────────
//
// `app.setPath('userData', …)` only redirects what has not been read yet.
// Modules that compute a path at import time — and this codebase has several —
// would capture the old location if they loaded first. So this module has side
// effects at import and main.ts imports it before anything else, exactly as it
// already does for esbuild-binary-path.

import { app } from 'electron'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, statSync } from 'fs'

/** The folder name a user creates (or unzips) to ask for portable mode. */
export const PORTABLE_MARKER = 'tachi-data'

/**
 * The directory the running program lives in.
 *
 * `process.execPath` is the Electron binary: in a packaged app that is
 * `<app>/Tachi Studio.exe`, and in development it is node_modules' electron —
 * which is why development never turns portable on by accident (nobody is going
 * to create `tachi-data` inside node_modules/electron/dist).
 */
function executableDir(): string {
  return dirname(process.execPath)
}

/** The portable data directory, if the marker is there. */
export function portableDir(): string | null {
  try {
    const dir = join(executableDir(), PORTABLE_MARKER)
    return statSync(dir).isDirectory() ? dir : null
  } catch {
    return null
  }
}

export function isPortable(): boolean {
  return portableDir() !== null
}

/**
 * The storage root a portable install uses for USER CONTENT.
 *
 * Kept as a named subfolder rather than the data directory itself so that what a
 * person opens ("Media", "Designs") is not mixed in with settings and a 20 GB
 * model cache. storage-root.ts asks for this before it considers Documents.
 */
export function portableStorageRoot(): string | null {
  const dir = portableDir()
  return dir ? join(dir, 'Tachi Studio') : null
}

/**
 * Point Electron's own writable paths inside the portable folder.
 *
 * Called for its side effect at import. Silent and harmless when the marker is
 * absent — the overwhelmingly common case — so an ordinary install pays one
 * `statSync` at boot and nothing else.
 *
 * `userData` covers settings, keys and the sidecar/model trees this app derives
 * from it. `sessionData` follows it or Chromium keeps its cache in the profile,
 * which would leave exactly the C:\Users footprint portable mode exists to
 * avoid. `logs` and `crashDumps` for the same reason; `temp` is deliberately NOT
 * moved, because a render can spill gigabytes and a USB stick is the wrong place
 * for that.
 */
export function applyPortableMode(): { portable: boolean; dir: string | null } {
  const dir = portableDir()
  if (!dir) return { portable: false, dir: null }
  try {
    const userData = join(dir, 'userData')
    mkdirSync(userData, { recursive: true })
    app.setPath('userData', userData)
    // setPath throws for an unknown name on some Electron versions; each is
    // guarded on its own so one failure cannot cost the others.
    for (const [name, sub] of [['sessionData', 'session'], ['logs', 'logs'], ['crashDumps', 'crash']] as const) {
      try {
        const p = join(dir, sub)
        mkdirSync(p, { recursive: true })
        app.setPath(name, p)
      } catch { /* this path stays at its default; portable mode still holds for the rest */ }
    }
    console.log(`[portable] data directory: ${dir}`)
    return { portable: true, dir }
  } catch (e) {
    // A marker on a read-only volume, or a permission refusal. Falling back to
    // the normal locations is strictly better than refusing to start, and saying
    // so is what stops the user wondering why their folder stayed empty.
    console.warn(`[portable] found ${PORTABLE_MARKER} but could not use it (${e instanceof Error ? e.message : String(e)}) — using the normal locations`)
    return { portable: false, dir: null }
  }
}

// The side effect. See the header for why this runs at import rather than being
// called from somewhere sensible-looking later.
applyPortableMode()

/** For the Settings card and the doctor row: where is this install writing? */
export function portableState(): { portable: boolean; dir: string | null; marker: string; exeDir: string } {
  return { portable: isPortable(), dir: portableDir(), marker: PORTABLE_MARKER, exeDir: executableDir() }
}

/** True when the marker exists but the directory could not be used. */
export function portableMarkerUnusable(): boolean {
  try {
    const p = join(executableDir(), PORTABLE_MARKER)
    return existsSync(p) && !statSync(p).isDirectory()
  } catch {
    return false
  }
}
