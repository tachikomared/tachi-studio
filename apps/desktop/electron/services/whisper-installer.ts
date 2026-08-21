// apps/desktop/electron/services/whisper-installer.ts
//
// Whisper STT: prebuilt whisper-cli binary downloader + direct ggml model
// downloader. Audit H3 — local STT used to cmake-build whisper.cpp from source
// on first use, which silently fails on clean machines without a C++ toolchain.
// This mirrors the proven piper / sd-cpp / llama-cpp prebuilt-binary pattern:
// download → SHA-verify (fail-closed in packaged builds) → extract → place the
// binary + DLLs into {userData}/whisper/bin/. Models are fetched directly from
// HuggingFace (no cmake side-effect).
//
//   {userData}/whisper/
//     ├── bin/        whisper-cli.exe + ggml/whisper DLLs
//     └── downloads/  transient .tmp for the BINARY zip only
//
// MODELS (LANE U): a NEW ggml model lands in `<storage root>/Models/whisper/`
// (resolveModelPath), with its `.part` in that same directory — the landing
// rename cannot cross devices. Pre-existing models in
// `{userData}/whisper-models/` keep resolving there until the user relocates
// them from the Settings storage dashboard.

import { existsSync, mkdirSync, renameSync, statSync, readdirSync, copyFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { app, type BrowserWindow } from 'electron'
import {
  WHISPER_VERSION, WHISPER_MODELS, defaultWhisperRelease, isWhisperShaPlaceholder,
  type WhisperRelease, type WhisperModelName,
} from './whisper-models'
import { resolveBinary } from './util/resolve-binary'
import { withInstallLock } from './util/install-lock'
import { resumableDownload, sha256File, extractArchive } from './util/installer-kit'
import { runManagedDownload, adoptExternalProgress, settleExternalDownload, pauseManagedDownload } from './download-manager'
import { shouldFallBackToLegacyDownload, approxBytesFromSizeLabel } from './util/download-queue'
import { resolveModelPath, partPathFor, removeResolved } from './model-storage'

function whisperRoot(): string { return join(app.getPath('userData'), 'whisper') }
export function whisperBinDir(): string { return join(whisperRoot(), 'bin') }
function whisperDownloadsDir(): string { return join(whisperRoot(), 'downloads') }

/** Resolve the installed prebuilt whisper-cli, or null if not installed. */
export function getWhisperCliPath(): string | null {
  return resolveBinary('whisper-cli', {
    envVar: 'WHISPER_CLI_PATH',
    bundledCandidates: [join(whisperBinDir(), 'whisper-cli')],
  })
}
export function isWhisperCliInstalled(): boolean { return getWhisperCliPath() !== null }

// ─── Progress ──────────────────────────────────────────────────────────────────
export type WhisperInstallStage = 'checking' | 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
export interface WhisperInstallProgress { stage: WhisperInstallStage; message: string; percent: number }
function push(win: BrowserWindow | null, e: WhisperInstallProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('whisper:install-progress', e)
}

/** The directory inside `root` that contains whisper-cli (the zip may nest it). */
function findBinaryDir(root: string): string | null {
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
  let found: string | null = null
  const walk = (dir: string): void => {
    if (found) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let s; try { s = statSync(p) } catch { continue }
      if (s.isFile() && name.toLowerCase() === exe) { found = dir; return }
      if (s.isDirectory()) walk(p)
    }
  }
  walk(root)
  return found
}
function moveDirContents(srcDir: string, destDir: string): void {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name), dst = join(destDir, name)
    try { renameSync(src, dst) } catch { try { copyFileSync(src, dst) } catch { /* ignore */ } }
  }
}

// ─── Public: install the prebuilt whisper-cli binary ─────────────────────────────
export function installWhisperCli(win: BrowserWindow | null): Promise<void> {
  if (isWhisperCliInstalled()) { push(win, { stage: 'done', message: 'whisper-cli already installed', percent: 100 }); return Promise.resolve() }
  return withInstallLock('whisper-cli', () => _doInstall(win))
}

async function _doInstall(win: BrowserWindow | null): Promise<void> {
  push(win, { stage: 'checking', message: 'Resolving whisper release...', percent: 0 })
  const asset: WhisperRelease | null = defaultWhisperRelease(process.platform, process.arch)
  if (!asset) {
    const e = `No prebuilt whisper-cli for ${process.platform}/${process.arch}. Supported: Windows x64.`
    push(win, { stage: 'error', message: e, percent: 0 }); throw new Error(e)
  }
  mkdirSync(whisperDownloadsDir(), { recursive: true }); mkdirSync(whisperBinDir(), { recursive: true })
  const tmp = join(whisperDownloadsDir(), `${asset.filename}.tmp`)
  const fin = join(whisperDownloadsDir(), asset.filename)

  push(win, { stage: 'downloading', message: `Downloading whisper-cli (${WHISPER_VERSION})`, percent: 0 })
  try {
    await resumableDownload(asset.url, tmp, (b, t) => {
      push(win, { stage: 'downloading', message: 'Downloading whisper-cli', percent: t > 0 ? Math.round((b / t) * 100) : -1 })
    })
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* */ }
    const m = `Download failed: ${err instanceof Error ? err.message : String(err)}`
    push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m)
  }

  push(win, { stage: 'verifying', message: 'Verifying SHA256...', percent: -1 })
  const actual = await sha256File(tmp)
  if (isWhisperShaPlaceholder(asset.sha256)) {
    if (app.isPackaged) { try { rmSync(tmp, { force: true }) } catch { /* */ } const m = `Refusing to install whisper-cli — placeholder SHA in a packaged build. Observed ${actual}.`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
    console.warn(`[whisper] SHA256 SKIPPED (placeholder). Observed: ${actual}.`)
  } else if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
    try { rmSync(tmp, { force: true }) } catch { /* */ }
    const m = `whisper-cli SHA256 mismatch: expected ${asset.sha256}, got ${actual}. Aborting.`
    push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m)
  }
  try { renameSync(tmp, fin) } catch { /* */ }

  push(win, { stage: 'extracting', message: 'Extracting whisper-cli...', percent: -1 })
  const staging = join(whisperDownloadsDir(), 'staging')
  try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }
  mkdirSync(staging, { recursive: true })
  await extractArchive(fin, staging)
  const binDir = findBinaryDir(staging)
  if (!binDir) { const m = 'whisper-cli not found in the downloaded archive.'; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
  // Lift the executable AND its sibling DLLs (ggml*.dll, whisper.dll) together.
  moveDirContents(binDir, whisperBinDir())
  try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }
  try { rmSync(fin, { force: true }) } catch { /* */ }

  if (!isWhisperCliInstalled()) { const m = 'whisper-cli install completed but the binary could not be resolved.'; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
  push(win, { stage: 'done', message: 'whisper-cli ready', percent: 100 })
}

// ─── Public: download a ggml model directly (no cmake) ───────────────────────────
// REMOVED (LANE U): whisperModelDir() hardcoded — and eagerly CREATED — the
// legacy `<userData>/whisper-models` dir. It had no callers left, and keeping a
// single-root helper next to a dual-root resolver is how the whisper-service
// `ready`/`ensureModel` mismatch happened in the first place. Use
// whisperModelPath(name) (dual-root) or dirname() of it for the folder.
/** Dual-root: relocated `<storage root>/Models/whisper/<file>` first, legacy
 *  userData `whisper-models/<file>` fallback (and the write target for new
 *  downloads, since neither exists yet then). */
export function whisperModelPath(name: WhisperModelName): string {
  return resolveModelPath('whisper', WHISPER_MODELS[name].file)
}

/**
 * LEGACY direct model download (kept as the manager fallback). It writes to
 * the managed task's own .part, so it must ADOPT that task on every chunk
 * (same contract as sd-cpp/piper). The partial is KEPT on network failure —
 * deleting it both threw away up to 1.5 GB of resume progress and, before the
 * installer-kit fd fix, was the exact rmSync-on-open-handle move that leaves
 * the name DELETE-PENDING on Windows.
 */
async function legacyDownloadWhisperModel(name: WhisperModelName, win: BrowserWindow | null, tmp: string, dest: string, managedId?: string): Promise<void> {
  const asset = WHISPER_MODELS[name]
  try {
    await resumableDownload(asset.url, tmp, (b, t) => {
      if (managedId) adoptExternalProgress(managedId, b, t)
      push(win, { stage: 'downloading', message: `Downloading ${name} model`, percent: t > 0 ? Math.round((b / t) * 100) : -1 })
    })
  } catch (err) { throw new Error(`Model download failed: ${err instanceof Error ? err.message : String(err)} — partial kept, click Download to resume.`) }
  const actual = await sha256File(tmp)
  if (!isWhisperShaPlaceholder(asset.sha256) && actual.toLowerCase() !== asset.sha256.toLowerCase()) {
    try { rmSync(tmp, { force: true }) } catch { /* */ }
    throw new Error(`Model SHA256 mismatch for ${name}: expected ${asset.sha256}, got ${actual}.`)
  }
  try { renameSync(tmp, dest) } catch { /* */ }
}

/**
 * Download ggml-<model>.bin from HuggingFace with SHA verification.
 *
 * Model files (75 MB - 1.5 GB) route through the central download-manager:
 * pause/resume/cancel from the DownloadStrip, HTTP-Range resume across drops
 * AND app restarts, disk preflight, sha256 integrity. The legacy
 * `whisper:install-progress` channel is preserved for the existing UI, and
 * the legacy direct-download path remains as a fallback when the manager
 * fails unexpectedly.
 */
export async function downloadWhisperModel(name: WhisperModelName, win: BrowserWindow | null): Promise<void> {
  const asset = WHISPER_MODELS[name]
  const dest = whisperModelPath(name)
  if (existsSync(dest)) return
  return withInstallLock(`whisper-model-${name}`, async () => {
    if (existsSync(dest)) return
    // LANE U: the .part lives NEXT TO the final file (which resolveModelPath
    // points at the storage root for a new download) — the landing rename
    // cannot cross devices, and nothing multi-GB touches C: on the way.
    const tmp = partPathFor(dest)
    mkdirSync(dirname(dest), { recursive: true })
    push(win, { stage: 'downloading', message: `Downloading ${name} model`, percent: 0 })
    const managedId = whisperManagedId(name)
    try {
      await runManagedDownload({
        id:       managedId,
        name:     `Whisper ${name} (${asset.sizeLabel})`,
        kind:     'whisper-model',
        url:      asset.url,
        destPath: dest,
        partPath: tmp,
        expectedSha256:   isWhisperShaPlaceholder(asset.sha256) ? undefined : asset.sha256,
        approxTotalBytes: asset.sizeBytes ?? approxBytesFromSizeLabel(asset.sizeLabel),
      }, s => {
        if (s.state === 'active') {
          push(win, { stage: 'downloading', message: `Downloading ${name} model`, percent: s.percent })
        } else if (s.state === 'verifying') {
          push(win, { stage: 'verifying', message: `Verifying ${name} model…`, percent: -1 })
        }
      })
    } catch (err) {
      if (!shouldFallBackToLegacyDownload(err)) {
        // Deliberate outcome (pause/cancel/disk/integrity) — surface as-is.
        const m = err instanceof Error ? err.message : String(err)
        push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m)
      }
      // Manager failed unexpectedly — complete via the proven legacy path.
      // The queue row is handed over rather than abandoned: adopt on every
      // chunk, settle once (drop the row on success, honest error otherwise).
      console.warn(`[whisper] managed download failed for ${name} — falling back to direct download:`, err instanceof Error ? err.message : err)
      try {
        await legacyDownloadWhisperModel(name, win, tmp, dest, managedId)
      } catch (legacyErr) {
        settleExternalDownload(managedId, legacyErr)
        const m = legacyErr instanceof Error ? legacyErr.message : String(legacyErr)
        push(win, { stage: 'error', message: m, percent: 0 })
        throw legacyErr
      }
      settleExternalDownload(managedId) // legacy landed the file; the row is done talking
    }
    push(win, { stage: 'done', message: `${name} model ready`, percent: 100 })
  })
}

/**
 * The download-manager task id owning one whisper model file. Single source of
 * truth for BOTH the download (downloadWhisperModel) and the STOP below — a
 * second hand-built `whisper:${name}` string is exactly how a cancel silently
 * no-ops after an id-format change.
 */
export function whisperManagedId(name: WhisperModelName): string {
  return `whisper:${name}`
}

/**
 * "Stop" an in-flight whisper model download. PAUSE semantics, identical to
 * llama.cpp / sd.cpp: the `.part` bytes stay on disk, the DOWNLOADS strip
 * offers RESUME, and a Catalog re-click resumes from the same offset.
 *
 * Returns false when nothing was pausable for that name — either no download is
 * running, or it is already past the transfer (verifying/landing), which the
 * manager deliberately refuses to interrupt. Callers must surface that as
 * "nothing to stop", NOT as a successful cancel.
 */
export function cancelWhisperModelDownload(name: WhisperModelName): boolean {
  return pauseManagedDownload(whisperManagedId(name))
}

/**
 * Delete one downloaded ggml weight from BOTH storage roots — the Catalog's
 * Installed tab needs this to be able to reclaim the space it advertises
 * (`medium.en` alone is ~1.5 GB).
 *
 * The filename comes from the REGISTRY (`WHISPER_MODELS[name].file`) rather
 * than from re-deriving `ggml-<name>.bin` here, so a registry rename can never
 * leave this deleting the wrong path (or nothing at all). An unknown name is
 * refused instead of being turned into a path.
 */
export function removeWhisperModel(name: string): { ok: boolean; error?: string } {
  const asset = (WHISPER_MODELS as Record<string, { file: string } | undefined>)[name]
  if (!asset) return { ok: false, error: `Unknown whisper model: ${name}` }
  return removeResolved('whisper', asset.file)
}
