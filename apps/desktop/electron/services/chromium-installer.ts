// apps/desktop/electron/services/chromium-installer.ts
//
// Managed Chromium (chrome-headless-shell) — ONE downloaded browser amortized
// across every consumer that needs real Chromium rendering:
//   • Design → Export MP4   (@remotion/renderer, via browserExecutable)
//   • deep_research / web-search JS-render   (puppeteer-core, later)
//   • agent browse(url) tool                 (puppeteer-core, later)
//
// Why we own the download instead of letting Remotion manage it: Remotion's
// ensureBrowser() drops chrome-headless-shell into `node_modules/.remotion/…`,
// which is READ-ONLY inside a packaged Electron asar — so it cannot write there
// in a shipped build. We download into `userData/chromium` (writable) via the
// official @puppeteer/browsers installer, which gives a DETERMINISTIC executable
// path we can hand to BOTH Remotion (browserExecutable) and puppeteer-core.
//
//   ${userData}/chromium/
//     ├── installed.json                      { buildId, platform }
//     └── chrome-headless-shell/<plat>-<id>/… the unpacked binary
//
// Mirrors the llama-cpp / sd-cpp installer ergonomics: a singleton+lockfile
// guard (withInstallLock), `*-install-progress` IPC events with speed/ETA, and a
// synchronous getChromiumPath() once installed. Integrity: the archive is fetched
// over TLS from Google's Chrome-for-Testing CDN (the same trust model Puppeteer
// itself uses); @puppeteer/browsers also supports an expectedHash we pin once a
// build is chosen.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app, type BrowserWindow } from 'electron'
// @puppeteer/browsers v3 is ESM-only — Electron's bundled Node (CJS main) cannot
// `require()` it (ERR_REQUIRE_ESM). So we NEVER statically import it; the value
// API is pulled via dynamic import() inside the async installer (dynamic import
// works for ESM from CJS), and getChromiumPath() computes the path itself so it
// stays synchronous and dependency-free. Types are import-type-only (erased).
import type { BrowserPlatform } from '@puppeteer/browsers'
import { withInstallLock } from './util/install-lock'
import { DownloadProgressTracker } from './util/download-progress'

// ─── Paths / metadata ───────────────────────────────────────────────────────

function chromiumRoot(): string { return join(app.getPath('userData'), 'chromium') }
function metaPath(): string { return join(chromiumRoot(), 'installed.json') }

interface ChromiumMeta { buildId: string; platform: BrowserPlatform }

function readMeta(): ChromiumMeta | null {
  try {
    const raw = readFileSync(metaPath(), 'utf8')
    const m = JSON.parse(raw) as Partial<ChromiumMeta>
    if (m && typeof m.buildId === 'string' && typeof m.platform === 'string') {
      return { buildId: m.buildId, platform: m.platform as BrowserPlatform }
    }
  } catch { /* not installed yet / unreadable */ }
  return null
}

function writeMeta(meta: ChromiumMeta): void {
  mkdirSync(chromiumRoot(), { recursive: true })
  writeFileSync(metaPath(), JSON.stringify(meta), 'utf8')
}

/**
 * The @puppeteer/browsers cache layout is deterministic, so we derive the exe
 * path ourselves (avoids importing the ESM-only package just to compute a path):
 *   <cacheDir>/chrome-headless-shell/<platform>-<buildId>/chrome-headless-shell-<platform>/chrome-headless-shell[.exe]
 */
function exePathFor(meta: ChromiumMeta): string {
  const bin = meta.platform.startsWith('win') ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'
  return join(chromiumRoot(), 'chrome-headless-shell', `${meta.platform}-${meta.buildId}`, `chrome-headless-shell-${meta.platform}`, bin)
}

/**
 * Absolute path to the managed chrome-headless-shell executable, or null when it
 * isn't installed. Synchronous + deterministic — derived from the recorded
 * buildId, so callers (Remotion, puppeteer) get a stable path with no network.
 */
export function getChromiumPath(): string | null {
  const meta = readMeta()
  if (!meta) return null
  const p = exePathFor(meta)
  return existsSync(p) ? p : null
}

export function isChromiumInstalled(): boolean { return getChromiumPath() !== null }

// ─── Progress push ──────────────────────────────────────────────────────────

export type ChromiumStage = 'checking' | 'resolving' | 'downloading' | 'done' | 'error'
export interface ChromiumInstallProgress {
  stage: ChromiumStage
  message: string
  percent: number
  bytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSec?: number
}

function push(win: BrowserWindow | null, e: ChromiumInstallProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('chromium:install-progress', e)
}

// ─── Install ──────────────────────────────────────────────────────────────────

/**
 * Ensure the managed Chromium is present, downloading it on first use. Returns
 * the absolute executable path. Concurrency-safe (withInstallLock dedups a
 * simultaneous install across windows/processes). Throws — and emits an `error`
 * progress event — when the platform is unsupported or the download fails.
 */
export async function installChromium(win: BrowserWindow | null): Promise<string> {
  const existing = getChromiumPath()
  if (existing) { push(win, { stage: 'done', message: 'Chromium already installed', percent: 100 }); return existing }
  // withInstallLock dedups concurrent installs (its fn returns void); the actual
  // path is read back deterministically afterwards — correct for the dedup case
  // too, since the winning install records the meta we resolve against.
  await withInstallLock('chromium', async () => { await _doInstall(win) })
  const exe = getChromiumPath()
  if (!exe) throw new Error('Chromium install finished but no executable was found.')
  return exe
}

async function _doInstall(win: BrowserWindow | null): Promise<string> {
  // Re-check inside the lock — another caller may have just finished.
  const ready = getChromiumPath()
  if (ready) { push(win, { stage: 'done', message: 'Chromium already installed', percent: 100 }); return ready }

  // Dynamic import: ESM-only package, loaded from the CJS main process at call time.
  // Stage logs: packaged-only hangs (asar ESM resolution) are invisible without them.
  console.log('[chromium-installer] importing @puppeteer/browsers…')
  const { Browser, detectBrowserPlatform, resolveBuildId, canDownload, install } = await import('@puppeteer/browsers')
  console.log('[chromium-installer] @puppeteer/browsers loaded')

  push(win, { stage: 'checking', message: 'Detecting platform…', percent: 0 })
  const platform = detectBrowserPlatform()
  if (!platform) {
    const msg = `No managed Chromium build for this platform (${process.platform}/${process.arch}).`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }

  push(win, { stage: 'resolving', message: 'Resolving latest stable Chromium…', percent: -1 })
  let buildId: string
  try {
    buildId = await resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, 'stable')
  } catch (err) {
    const msg = `Could not resolve a Chromium build: ${err instanceof Error ? err.message : String(err)}`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }

  const opts = { browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir: chromiumRoot(), platform } as const
  if (!(await canDownload(opts))) {
    const msg = `Chromium build ${buildId} is not available for ${platform}.`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }

  mkdirSync(chromiumRoot(), { recursive: true })
  push(win, { stage: 'downloading', message: `Downloading Chromium (${buildId})…`, percent: 0 })
  const tracker = new DownloadProgressTracker([{ id: 'chromium' }])
  try {
    await install({
      ...opts,
      downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
        tracker.tick('chromium', downloadedBytes, totalBytes)
        const snap = tracker.snapshot()
        push(win, {
          stage: 'downloading', message: `Downloading Chromium (${buildId})`,
          percent: snap.percent, bytes: snap.receivedBytes, totalBytes: snap.totalBytes,
          speedBytesPerSec: snap.speedBytesPerSec, etaSec: snap.etaSec,
        })
      },
    })
  } catch (err) {
    const msg = `Chromium download failed: ${err instanceof Error ? err.message : String(err)}`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }

  writeMeta({ buildId, platform })
  const exe = getChromiumPath()
  if (!exe) {
    const msg = `Chromium reported installed but the executable is missing under ${chromiumRoot()}.`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }
  push(win, { stage: 'done', message: 'Chromium installed.', percent: 100 })
  return exe
}
