// apps/desktop/electron/services/rife-installer.ts
//
// rife-ncnn-vulkan sidecar installer — the FIFTH member of this app's installer
// family (llama.cpp, sd.cpp, piper, whisper, yt-dlp), built out of the same
// proven primitives rather than a sixth private copy of them:
//
//   installer-kit  resumableDownload (Range resume + retry + the not-a-file and
//                  range-ignored guards), sha256File, extractArchive,
//                  prepareResumablePartial (the Windows DELETE-PENDING un-wedge)
//   install-lock   withInstallLock (module singleton + cross-process lockfile)
//   resolve-binary env override → bundled → PATH
//   sd-cpp-installer  canReuseLandedArchive — a COMPLETE, sha-verified zip from
//                  an attempt that died later must never come down the wire
//                  again. That is 431 MB of not-re-downloading, and the logic is
//                  already proven + tested (sdCppArchiveReuse.test.ts).
//
//   ${userData}/rife/
//     ├── bin/        rife-ncnn-vulkan[.exe] + vcomp140.dll (win) + all 11 model
//     │               dirs, lifted out of the archive's single root
//     └── downloads/  the transient zip + its `.tmp` partial
//
// ── WHY THE LEGACY DIRECT DOWNLOAD AND NOT THE MANAGED QUEUE ──────────────────
//
// sd-cpp draws the line at "release archives take the direct path; MODEL WEIGHTS
// take the download-manager", and this is a release archive. It is also the only
// line available without editing DOWNLOAD_KINDS (util/download-queue.ts), a
// closed union owned by the manager and outside this lane's territory — a new
// kind there changes the persistence parser and the strip. The direct path still
// resumes across attempts (prepareResumablePartial + resumableDownload) and
// still reports bytes/speed/ETA, which is what the activity rail renders.
//
// ── SIZE, HONESTLY ────────────────────────────────────────────────────────────
//
// 431 MB. The research verdict said 20-25 MB; see the note in rife-plan.ts. The
// app must SAY so before it starts — `rifeStatus()` reports downloadBytes so the
// button can read "Install · 431 MB" rather than ambushing a metered connection.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { type BrowserWindow } from 'electron'
import { withInstallLock } from './util/install-lock'
import { DownloadProgressTracker } from './util/download-progress'
import { resumableDownload, sha256File, extractArchive, prepareResumablePartial } from './util/installer-kit'
import { canReuseLandedArchive } from './sd-cpp-installer'
import { RIFE_VERSION, RIFE_MODEL_DIR, defaultRifeRelease, rifeExeName, rifeSanityRefusal } from './rife-plan'
import { getRifeBinaryPath, isRifeInstalled, rifeBinDir, rifeDownloadsDir } from './rife-paths'

// Paths + status live in rife-paths so the RUNNER can import them without
// dragging installer-kit's `https` onto its graph — see that file's header.
// Re-exported here so the installer keeps one coherent public surface.
export {
  getRifeBinaryPath, isRifeInstalled, rifeBinDir, rifeModelDir, rifeStatus,
  type RifeStatus,
} from './rife-paths'

// ─── Progress push ────────────────────────────────────────────────────────────
//
// The stage vocabulary is the one activityBridge already routes: a terminal
// 'done'/'error' on EVERY exit path (the rail's hard requirement — yt-dlp is
// excluded from the rail precisely because it throws without pushing), and no
// stage named in MANAGED_STAGES (nothing here is owned by the download manager).

export type RifeInstallStage = 'checking' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'

export interface RifeInstallProgress {
  stage: RifeInstallStage
  message: string
  percent: number
  bytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSec?: number
}

function push(win: BrowserWindow | null, e: RifeInstallProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('rife:install-progress', e)
}

// ─── Install ──────────────────────────────────────────────────────────────────

export function installRife(win: BrowserWindow | null): Promise<void> {
  if (isRifeInstalled()) {
    push(win, { stage: 'done', message: 'rife-ncnn-vulkan already installed', percent: 100 })
    return Promise.resolve()
  }
  return withInstallLock('rife-binary', () => _doInstall(win))
}

async function _doInstall(win: BrowserWindow | null): Promise<void> {
  const fail = (msg: string): never => {
    push(win, { stage: 'error', message: msg, percent: 0 })
    throw new Error(msg)
  }

  push(win, { stage: 'checking', message: 'Resolving the rife-ncnn-vulkan release…', percent: 0 })
  const asset = defaultRifeRelease(process.platform)
  if (!asset) {
    return fail(`No rife-ncnn-vulkan build is published for ${process.platform}. Supported: Windows, macOS, Linux (x64).`)
  }

  mkdirSync(rifeDownloadsDir(), { recursive: true })
  mkdirSync(rifeBinDir(), { recursive: true })
  const zipFinal = join(rifeDownloadsDir(), asset.filename)

  // A verified 431 MB zip from an attempt that died in the EXTRACT is reused.
  push(win, { stage: 'verifying', message: 'Checking for an already-downloaded archive…', percent: -1 })
  if (!(await canReuseLandedArchive(zipFinal, asset.sha256))) {
    const zipTmp = prepareResumablePartial(join(rifeDownloadsDir(), `${asset.filename}.tmp`)).path
    const tracker = new DownloadProgressTracker([{ id: 'rife', totalBytes: asset.sizeBytes }])
    push(win, { stage: 'downloading', message: `Downloading rife-ncnn-vulkan ${RIFE_VERSION}`, percent: 0 })
    try {
      await resumableDownload(asset.url, zipTmp, (bytes, total) => {
        tracker.tick('rife', bytes, total)
        const snap = tracker.snapshot()
        push(win, {
          stage: 'downloading', message: `Downloading rife-ncnn-vulkan ${RIFE_VERSION}`,
          percent: snap.percent, bytes: snap.receivedBytes, totalBytes: snap.totalBytes,
          speedBytesPerSec: snap.speedBytesPerSec, etaSec: snap.etaSec,
        })
      }, 6, undefined, { expectedTotalBytes: asset.sizeBytes })
    } catch (err) {
      // KEEP the partial: the next Install click resumes from these bytes. On a
      // 431 MB asset that is the difference between a retry and a re-download.
      return fail(`Download failed: ${err instanceof Error ? err.message : String(err)} — partial kept, click Install to resume.`)
    }

    push(win, { stage: 'verifying', message: 'Verifying SHA256…', percent: -1 })
    const actual = await sha256File(zipTmp)
    if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
      // Proven-bad bytes are DELETED, never resumed onto.
      try { rmSync(zipTmp, { force: true }) } catch { /* */ }
      return fail(`SHA256 mismatch for ${asset.filename}: expected ${asset.sha256}, got ${actual}. Aborting.`)
    }
    try { renameSync(zipTmp, zipFinal) } catch { /* */ }
  } else {
    console.info(`[rife] reusing the verified archive already on disk: ${asset.filename} (skipping a ${asset.sizeBytes}-byte download).`)
  }

  push(win, { stage: 'extracting', message: 'Extracting (431 MB of models — this takes a minute)…', percent: -1 })
  const staging = join(rifeDownloadsDir(), 'staging')
  try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }
  mkdirSync(staging, { recursive: true })
  try {
    await extractArchive(zipFinal, staging)
  } catch (err) {
    return fail(`Extraction failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const sourceDir = findRifeDir(staging, asset.archiveRoot)
  if (!sourceDir) {
    try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }
    return fail(`Could not locate ${rifeExeName(process.platform)} in the extracted archive (${staging}). The release layout may have changed.`)
  }

  // Move the archive root's CONTENTS into bin/ (binary + every model dir).
  try {
    moveDirContents(sourceDir, rifeBinDir())
  } catch (err) {
    try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }
    return fail(`Could not place the engine into ${rifeBinDir()}: ${err instanceof Error ? err.message : String(err)}`)
  }
  try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }

  if (!isRifeInstalled()) {
    return fail(`Install reported success but ${rifeExeName(process.platform)} or ${RIFE_MODEL_DIR}/ is missing under ${rifeBinDir()}.`)
  }

  // SANITY: does the binary actually START on this machine? (Missing runtime
  // DLL, quarantined image, damaged extraction.) See rifeSanityRefusal for why
  // a non-zero exit here is EXPECTED and the usage banner is the real signal.
  push(win, { stage: 'verifying', message: 'Checking the engine starts…', percent: -1 })
  const refusal = await sanityCheck(getRifeBinaryPath()!)
  if (refusal) {
    // Roll the bin dir back: a binary that cannot start must not read as
    // installed, or every later Interpolate click fails the same way.
    try { rmSync(rifeBinDir(), { recursive: true, force: true }) } catch { /* */ }
    return fail(refusal)
  }

  // Only past every failure exit: the 431 MB zip is dead weight now.
  try { rmSync(zipFinal, { force: true }) } catch { /* */ }
  sweepStalePartials(asset.filename)
  push(win, { stage: 'done', message: 'rife-ncnn-vulkan installed.', percent: 100 })
}

/** Remove the whole install (binary + all model dirs). Downloads are swept too. */
export function uninstallRife(): { ok: boolean; error?: string } {
  try {
    rmSync(rifeBinDir(), { recursive: true, force: true })
    rmSync(rifeDownloadsDir(), { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The directory inside `root` that holds the executable. The archive's declared
 * root is tried first (one statSync instead of a walk over ~450 MB of models);
 * the walk is the fallback for a layout change, and is DEPTH-CAPPED so it can
 * never descend into the model trees.
 */
function findRifeDir(root: string, archiveRoot: string): string | null {
  const exe = rifeExeName(process.platform)
  const declared = join(root, archiveRoot)
  if (existsSync(join(declared, exe))) return declared
  if (existsSync(join(root, exe))) return root
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return null }
  for (const name of entries) {
    const p = join(root, name)
    try { if (!statSync(p).isDirectory()) continue } catch { continue }
    if (existsSync(join(p, exe))) return p
  }
  return null
}

function moveDirContents(srcDir: string, destDir: string): void {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name)
    const dst = join(destDir, name)
    try { rmSync(dst, { recursive: true, force: true }) } catch { /* */ }
    renameSync(src, dst)
  }
}

function sweepStalePartials(assetFilename: string): void {
  const prefix = `${assetFilename}.tmp`
  let entries: string[] = []
  try { entries = readdirSync(rifeDownloadsDir()) } catch { return }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    try { rmSync(join(rifeDownloadsDir(), name), { force: true }) } catch { /* */ }
  }
}

/**
 * Run the binary with NO arguments and read its usage banner off stderr.
 *
 * Upstream `print_usage()` + `return -1` means the exit code is 255 / 4294967295
 * on a HEALTHY binary, so the verdict is made by rifeSanityRefusal on the
 * banner, not on the code. Time-boxed: a wedged image must not hang the install.
 */
function sanityCheck(binPath: string): Promise<string | null> {
  return new Promise(resolve => {
    let stderr = ''
    let settled = false
    const done = (v: string | null): void => { if (!settled) { settled = true; resolve(v) } }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(binPath, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      done(rifeSanityRefusal({ error: err instanceof Error ? err.message : String(err), code: null, stderr: '' }))
      return
    }
    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* */ }
      done(rifeSanityRefusal({ code: null, stderr }))
    }, 20_000)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    proc.stdout?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    proc.on('error', (err: Error) => {
      clearTimeout(timer)
      done(rifeSanityRefusal({ error: err.message, code: null, stderr }))
    })
    proc.on('close', (code: number | null) => {
      clearTimeout(timer)
      done(rifeSanityRefusal({ code, stderr }))
    })
  })
}
