// apps/desktop/electron/services/piper-installer.ts
//
// piper TTS sidecar — prebuilt binary downloader + ONNX voice downloader.
// Mirrors the sd-cpp / llama-cpp installers (same download/SHA/extract
// primitives). The piper release archive extracts a self-contained `piper/`
// folder (binary + espeak-ng-data + libs) which we lift into bin/.
//
//   ${userData}/piper/
//     ├── bin/        piper[.exe] + espeak-ng-data/ + libs
//     ├── voices/<id>/…   LEGACY voices (pre-LANE-U downloads)
//     └── downloads/  transient .tmp for the BINARY zip only
//
// VOICES (LANE U): a NEW voice lands in `<storage root>/Models/piper/<id>/`
// (resolveModelPath picks the root; both files anchor to the same one) with
// each `.part` beside its final file — the landing rename cannot cross devices.
//
// Voice .onnx MODEL files route through the central download-manager (strip
// pause/resume/cancel, resume across restarts, disk preflight); the release
// zip and the tiny .onnx.json sidecar stay on the legacy direct path by
// design. The legacy path also remains as a fallback when the manager fails
// unexpectedly.

import { existsSync, mkdirSync, renameSync, statSync, readdirSync, copyFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { app, type BrowserWindow } from 'electron'
import {
  PIPER_VOICES, PIPER_VERSION, defaultPiperRelease, findPiperVoice, isPiperShaPlaceholder,
  type PiperRelease,
} from './piper-models'
import { resolveBinary } from './util/resolve-binary'
import { withInstallLock } from './util/install-lock'
import { cleanupStaleBackups } from './util/self-update'
import { DownloadProgressTracker } from './util/download-progress'
import { resumableDownload, sha256File, extractArchive } from './util/installer-kit'
import { runManagedDownload, adoptExternalProgress, settleExternalDownload, pauseManagedDownload } from './download-manager'
import { shouldFallBackToLegacyDownload } from './util/download-queue'
import { resolveModelPath, removeResolved, partPathFor } from './model-storage'

function piperRoot(): string { return join(app.getPath('userData'), 'piper') }
export function piperBinDir(): string { return join(piperRoot(), 'bin') }
// NOTE: the legacy `<userData>/piper/voices` dir is no longer referenced here —
// voice paths come from resolveModelPath (model-storage owns both roots).
function piperDownloadsDir(): string { return join(piperRoot(), 'downloads') }

export function getPiperBinaryPath(): string | null {
  return resolveBinary('piper', {
    envVar: 'PIPER_PATH',
    bundledCandidates: [
      join(piperBinDir(), 'piper'),
    ],
  })
}
export function isPiperInstalled(): boolean { return getPiperBinaryPath() !== null }
/** espeak-ng phoneme data dir (bundled in the release, next to the binary). */
export function espeakDataDir(): string { return join(piperBinDir(), 'espeak-ng-data') }

// Dual-root voice paths: relocated `<storage root>/Models/piper/<id>/…` first,
// legacy userData `piper/voices/<id>/…` fallback (and the write target for new
// downloads, since neither exists yet then).
export function voiceOnnxPath(id: string): string { return resolveModelPath('piper', id, `${id}.onnx`) }
function voiceConfigPath(id: string): string { return resolveModelPath('piper', id, `${id}.onnx.json`) }
export function isVoiceInstalled(id: string): boolean { return existsSync(voiceOnnxPath(id)) && existsSync(voiceConfigPath(id)) }
/**
 * The download-manager task id owning a voice's `.onnx` weight file. ONE
 * source of truth for the download (_doDownloadVoice) and the STOP below.
 */
export function voiceManagedId(id: string): string { return `piper:${id}` }
/**
 * "Stop" an in-flight voice download. PAUSE semantics (llama.cpp / sd.cpp
 * contract): the `.onnx.part` stays on disk and a Catalog re-click or the
 * DOWNLOADS strip resumes from that offset.
 *
 * HONEST SCOPE: only the `.onnx` weight (97% of the bytes) goes through the
 * manager. The few-KB `.onnx.json` sidecar downloads FIRST on the legacy direct
 * path and is not pausable — a Stop pressed inside that sub-second window
 * returns false, and callers must report "nothing to stop" rather than claiming
 * a cancel. That ordering is deliberate (see _doDownloadVoice): with the config
 * already landed, a resumed `.onnx` completes the voice.
 */
export function cancelVoiceDownload(id: string): boolean {
  return pauseManagedDownload(voiceManagedId(id))
}
export function listInstalledVoices(): { id: string }[] { return PIPER_VOICES.filter(v => isVoiceInstalled(v.id)).map(v => ({ id: v.id })) }
export function removeVoice(id: string): { ok: boolean; error?: string } {
  // Remove the voice subdir from BOTH roots (relocated + legacy).
  return removeResolved('piper', id)
}

// ─── Progress ──────────────────────────────────────────────────────────────────
export type PiperStage = 'checking' | 'downloading-binary' | 'extracting' | 'downloading-voice' | 'verifying' | 'done' | 'error'
export interface PiperProgress {
  stage: PiperStage; message: string; percent: number; bytes?: number; totalBytes?: number
  /** Instantaneous transfer rate (bytes/sec); omitted/0 when unknown. */
  speedBytesPerSec?: number
  /** Estimated seconds remaining; omitted/-1 when unknown. */
  etaSec?: number
}
function push(win: BrowserWindow | null, e: PiperProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('piper:install-progress', e)
}

// withInstallLock() handles binary-install deduplication (module singleton +
// lockfile). Per-voice downloads use their own per-id map for parallel progress.
const activeVoiceDownloads = new Map<string, Promise<void>>()

function findBinaryDir(root: string): string | null {
  const exe = process.platform === 'win32' ? 'piper.exe' : 'piper'
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
    try { renameSync(src, dst) } catch { try { copyFileSync(src, dst) } catch { /* ignore (dir copy fallback skipped) */ } }
  }
}

// ─── Public: install binary ────────────────────────────────────────────────────
export function installPiper(win: BrowserWindow | null): Promise<void> {
  cleanupStaleBackups(piperBinDir())
  if (isPiperInstalled()) { push(win, { stage: 'done', message: 'piper already installed', percent: 100 }); return Promise.resolve() }
  return withInstallLock('piper-binary', () => _doInstall(win))
}

/**
 * DELETED 2026-08-03, unused and unusable — do not bring it back in this shape.
 *
 * It was `updateBinary({ binPath, url, sha256 })`, which downloads a URL and
 * rotates those bytes into place AS THE BINARY. That is right for an engine
 * distributed as one bare executable and wrong for piper, whose releases are
 * `piper_windows_amd64.zip` / `piper_macos_aarch64.tar.gz` — archives carrying
 * the executable plus its espeak-ng data and DLLs.
 *
 * The identical helper was wired into sd.cpp the same way and PROVED the
 * failure on a real machine: the update reported success and left a 362 MB zip
 * where `sd-cli.exe` had been, unexecutable, with the working build surviving
 * only because of the `.old` backup.
 *
 * If piper ever needs an update flow, it is the same operation as an install —
 * download the archive, verify the sha, extract over the bin directory — so it
 * should call `_doInstall` under the install lock, exactly as
 * `updateSdCppToPinned` now does. Nothing ever called this function, so nothing
 * is lost by its absence.
 */
async function _doInstall(win: BrowserWindow | null): Promise<void> {
  push(win, { stage: 'checking', message: 'Resolving piper release...', percent: 0 })
  const asset: PiperRelease | null = defaultPiperRelease(process.platform, process.arch)
  if (!asset) { const e = `No piper prebuilt for ${process.platform}/${process.arch}. Supported: Windows, macOS.`; push(win, { stage: 'error', message: e, percent: 0 }); throw new Error(e) }
  mkdirSync(piperDownloadsDir(), { recursive: true }); mkdirSync(piperBinDir(), { recursive: true })
  const tmp = join(piperDownloadsDir(), `${asset.filename}.tmp`)
  const fin = join(piperDownloadsDir(), asset.filename)
  push(win, { stage: 'downloading-binary', message: `Downloading piper (${PIPER_VERSION})`, percent: 0 })
  try {
    const binTracker = new DownloadProgressTracker([{ id: 'binary' }])
    await resumableDownload(asset.url, tmp, (b, t) => {
      binTracker.tick('binary', b, t)
      const snap = binTracker.snapshot()
      push(win, { stage: 'downloading-binary', message: 'Downloading piper', percent: snap.percent, bytes: snap.receivedBytes, totalBytes: snap.totalBytes, speedBytesPerSec: snap.speedBytesPerSec, etaSec: snap.etaSec })
    })
  } catch (err) { try { rmSync(tmp, { force: true }) } catch { /* */ } const m = `Download failed: ${err instanceof Error ? err.message : String(err)}`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
  push(win, { stage: 'verifying', message: 'Verifying SHA256...', percent: -1 })
  const sha = await sha256File(tmp)
  if (isPiperShaPlaceholder(asset.sha256)) {
    if (app.isPackaged) { try { rmSync(tmp, { force: true }) } catch { /* */ } const m = `Refusing to install piper ${asset.platform} — placeholder SHA256 in a packaged build. Observed ${sha}; pin it in piper-models.ts.`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
    console.warn(`[piper] SHA256 SKIPPED for ${asset.platform} (placeholder). Observed: ${sha}.`)
  }
  else if (sha.toLowerCase() !== asset.sha256.toLowerCase()) { try { rmSync(tmp, { force: true }) } catch { /* */ } const m = `SHA256 mismatch for piper ${asset.platform}.`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
  try { renameSync(tmp, fin) } catch { /* */ }
  push(win, { stage: 'extracting', message: 'Extracting piper...', percent: -1 })
  const staging = join(piperDownloadsDir(), 'staging')
  try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }
  mkdirSync(staging, { recursive: true })
  await extractArchive(fin, staging)
  const binDir = findBinaryDir(staging)
  if (!binDir) { const m = `Could not locate piper in the archive (${staging}).`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
  // Lift the WHOLE piper/ folder (binary + espeak-ng-data + libs) into bin/.
  try { for (const n of readdirSync(piperBinDir())) { const p = join(piperBinDir(), n); try { if (statSync(p).isFile()) rmSync(p, { force: true }) } catch { /* */ } } } catch { /* */ }
  moveDirContents(binDir, piperBinDir())
  try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }
  if (!isPiperInstalled()) { const m = `Install reported success but piper is missing under ${piperBinDir()}.`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
  push(win, { stage: 'done', message: 'piper installed.', percent: 100 })
}

// ─── Public: download voice (onnx + onnx.json) ──────────────────────────────────
export function downloadVoice(win: BrowserWindow | null, id: string): Promise<void> {
  if (isVoiceInstalled(id)) { push(win, { stage: 'done', message: `Voice already on disk: ${id}`, percent: 100 }); return Promise.resolve() }
  const existing = activeVoiceDownloads.get(id)
  if (existing) return existing
  // withInstallLock provides cross-process lockfile dedup per voice id.
  const p = withInstallLock(`piper-voice-${id}`, () => _doDownloadVoice(win, id))
    .finally(() => activeVoiceDownloads.delete(id))
  activeVoiceDownloads.set(id, p)
  return p
}
/**
 * LEGACY direct download for one voice file (kept as the manager fallback).
 * When it takes over a managed task's .part (`managedId` set) it must ADOPT
 * that task on every chunk — otherwise the queue row sits frozen at 'error'
 * while the file on disk grows, which the IO lamp and DownloadStrip then
 * misreport (same contract as sd-cpp-installer's legacyDownloadComponent).
 */
async function legacyDownloadVoiceFile(
  win: BrowserWindow | null,
  voice: { name: string },
  id: string,
  f: { url: string; sha: string; dest: string; tmp: string; weight: number },
  tracker: DownloadProgressTracker,
  bytesBefore: number,
  done: number,
  managedId?: string,
): Promise<void> {
  try {
    await resumableDownload(f.url, f.tmp, (b, t) => {
      if (managedId) adoptExternalProgress(managedId, b, t)
      const filePct = t > 0 ? b / t : 0
      tracker.tick('voice', bytesBefore + b, t > 0 ? bytesBefore + t : undefined)
      const snap = tracker.snapshot()
      push(win, { stage: 'downloading-voice', message: `${voice.name}`, percent: Math.round((done + f.weight * filePct) * 100), bytes: bytesBefore + b, totalBytes: snap.totalBytes, speedBytesPerSec: snap.speedBytesPerSec, etaSec: snap.etaSec })
    })
  } catch (err) { const m = `Voice download failed: ${err instanceof Error ? err.message : String(err)} — partial kept, click Download to resume.`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
  const sha = await sha256File(f.tmp)
  if (isPiperShaPlaceholder(f.sha)) {
    if (app.isPackaged) { try { rmSync(f.tmp, { force: true }) } catch { /* */ } const m = `Refusing to install voice ${id} — placeholder SHA256 in a packaged build. Observed ${sha}; pin it in piper-models.ts.`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
    console.warn(`[piper] voice ${id} SHA256 SKIPPED (placeholder). Observed: ${sha}.`)
  }
  else if (sha.toLowerCase() !== f.sha.toLowerCase()) { try { rmSync(f.tmp, { force: true }) } catch { /* */ } const m = `SHA256 mismatch for voice ${id}.`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
  try { renameSync(f.tmp, f.dest) } catch (err) { const m = `Could not place voice file: ${err instanceof Error ? err.message : String(err)}`; push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m) }
}

async function _doDownloadVoice(win: BrowserWindow | null, id: string): Promise<void> {
  const voice = findPiperVoice(id)
  if (!voice) { const e = `Unknown piper voice: ${id}`; push(win, { stage: 'error', message: e, percent: 0 }); throw new Error(e) }
  // LANE U: BOTH voice files resolve through resolveModelPath, which anchors
  // them to the same root (storage root for a new voice), so the pair never
  // splits across drives; the dir is derived from that resolution rather than
  // hardcoded to legacy userData, and each .part sits inside it.
  const onnxDest   = voiceOnnxPath(id)
  const configDest = voiceConfigPath(id)
  const dir = dirname(onnxDest)
  mkdirSync(dir, { recursive: true })
  const files: { url: string; sha: string; dest: string; tmp: string; weight: number; managed: boolean }[] = [
    // ORDER MATTERS: the ~KB .onnx.json sidecar downloads FIRST (legacy path).
    // A strip PAUSE on the managed .onnx aborts this orchestration with a
    // deliberate PAUSED error; the strip's RESUME then completes ONLY the
    // manager's own task. With the sidecar already on disk, that resumed
    // .onnx completes the voice (isVoiceInstalled needs both files) — with the
    // old onnx-first order a paused+resumed voice ended up permanently
    // missing its config and never appeared in the voices list (found E2E).
    { url: voice.configUrl, sha: voice.configSha, dest: configDest, tmp: partPathFor(configDest), weight: 0.03, managed: false },
    // The .onnx is the MODEL file (~60 MiB for every curated voice — measured;
    // the old "28-63 MB" range came from the sizeMb figures that were wrong)
    // → central download-manager
    // (strip pause/resume/cancel, resume across restarts, disk preflight).
    { url: voice.onnxUrl,   sha: voice.onnxSha,   dest: onnxDest,   tmp: partPathFor(onnxDest),      weight: 0.97, managed: true  },
  ]
  let done = 0
  // Per-file byte sizes are not in the registry (only relative weights), so the
  // overall percent stays weight-based; the tracker is fed GLOBAL cumulative
  // bytes purely to derive speed + ETA for the active transfer.
  const tracker = new DownloadProgressTracker([{ id: 'voice' }])
  let bytesBefore = 0
  for (const f of files) {
    if (!existsSync(f.dest)) {
      // Fail CLOSED before any bandwidth in a packaged build (placeholder SHA).
      if (isPiperShaPlaceholder(f.sha) && app.isPackaged) {
        const m = `Refusing to install voice ${id} — placeholder SHA256 in a packaged build. Pin it in piper-models.ts.`
        push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m)
      }
      if (f.managed) {
        const managedId = voiceManagedId(id)
        try {
          const snap = await runManagedDownload({
            id:       managedId,
            name:     voice.name,
            kind:     'piper-voice',
            url:      f.url,
            destPath: f.dest,
            partPath: f.tmp,
            expectedSha256:   isPiperShaPlaceholder(f.sha) ? undefined : f.sha,
            approxTotalBytes: Math.round(voice.sizeMb * 1_048_576),
          }, s => {
            if (s.state === 'active') {
              const filePct = s.totalBytes > 0 ? s.receivedBytes / s.totalBytes : 0
              tracker.tick('voice', bytesBefore + s.receivedBytes, s.totalBytes > 0 ? bytesBefore + s.totalBytes : undefined)
              const agg = tracker.snapshot()
              push(win, { stage: 'downloading-voice', message: `${voice.name}`, percent: Math.round((done + f.weight * filePct) * 100), bytes: bytesBefore + s.receivedBytes, totalBytes: agg.totalBytes, speedBytesPerSec: s.speedBytesPerSec, etaSec: s.etaSec })
            } else if (s.state === 'verifying') {
              push(win, { stage: 'verifying', message: `Verifying ${voice.name}…`, percent: -1 })
            }
          })
          if (isPiperShaPlaceholder(f.sha)) console.warn(`[piper] voice ${id} SHA256 SKIPPED (placeholder). Observed: ${snap.observedSha256 ?? 'n/a'}.`)
        } catch (err) {
          if (!shouldFallBackToLegacyDownload(err)) {
            // Deliberate outcome (pause/cancel/disk/integrity) — surface as-is.
            const m = err instanceof Error ? err.message : String(err)
            push(win, { stage: 'error', message: m, percent: 0 }); throw new Error(m)
          }
          // Manager failed unexpectedly — complete via the proven legacy path.
          // The queue row is handed over rather than abandoned: adopt on every
          // chunk, settle once (drop the row on success, honest error otherwise).
          console.warn(`[piper] managed download failed for voice ${id} — falling back to direct download:`, err instanceof Error ? err.message : err)
          try {
            await legacyDownloadVoiceFile(win, voice, id, f, tracker, bytesBefore, done, managedId)
          } catch (legacyErr) {
            settleExternalDownload(managedId, legacyErr)
            throw legacyErr
          }
          settleExternalDownload(managedId) // legacy landed the file; the row is done talking
        }
      } else {
        await legacyDownloadVoiceFile(win, voice, id, f, tracker, bytesBefore, done)
      }
      try { bytesBefore += statSync(f.dest).size } catch { /* */ }
    } else {
      try { bytesBefore += statSync(f.dest).size } catch { /* */ }
    }
    done += f.weight
  }
  push(win, { stage: 'done', message: `Voice ready: ${voice.name}`, percent: 100 })
}
