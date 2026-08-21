// apps/desktop/electron/services/sd-cpp-installer.ts
//
// stable-diffusion.cpp sidecar — prebuilt `sd-cli` downloader + COMPONENT-BASED
// model downloader. Mirrors llama-cpp-installer.ts (same download/SHA/extract
// primitives) with two differences:
//   1. the binary we look for is `sd-cli[.exe]` (fallback `sd[.exe]`);
//   2. a "model" is a SET of component files (single-file SD, or Flux's
//      diffusion+vae+clip_l+t5xxl) downloaded into models/<id>/<role>.<ext>.
//
//   ${userData}/sd-cpp/
//     ├── bin/        sd-cli[.exe] + dlls (extracted from release zip, + cudart on CUDA)
//     ├── models/<id>/<role>.<ext>   LEGACY component files (pre-LANE-U)
//     └── downloads/  transient BINARY archives only — the `.tmp` partial while
//                     it downloads, then the landed `.zip`, which is REUSED by a
//                     retry (canReuseLandedArchive) and SWEPT once the install
//                     fully lands (sweepLandedArchives).
//
// WEIGHTS (LANE U): a NEW model's components land in
// `<storage root>/Models/sd/<id>/`, chosen by resolveModelDir — the same
// resolver modelComponentPaths reads through — and each `.part` sits in that
// same directory (the landing rename cannot cross devices).
//
// SHA verification is skipped only when the registry SHA is a placeholder
// (logs the observed SHA) — identical policy to llama.cpp.
//
// MODEL component files (>50 MB weights) route through the central
// download-manager (pause/resume/cancel on the DownloadStrip, resume across
// restarts, disk preflight); the small release zips stay on the legacy direct
// path by design. The legacy path also remains as a per-file fallback when the
// manager fails unexpectedly.

import { existsSync, mkdirSync, renameSync, statSync, readdirSync, copyFileSync, linkSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'
import { join, extname } from 'path'
import { app, type BrowserWindow } from 'electron'
import { URL } from 'url'
import {
  SD_CPP_VERSION,
  SD_ADAPTER_DIR,
  SD_CPP_RELEASES,
  sdReleaseForBackend,
  isShaPlaceholder,
  findSdModel,
  findSdRow,
  findSdAdapter,
  allSdModels,
  allSdAdapters,
  sdFilesWithSha,
  findSpeedAdapter,
  speedAdapterForModel,
  SD_SPEED_ADAPTERS,
  findUpscaler,
  SD_UPSCALERS,
  findIpAdapter,
  ipAdapterForFamily,
  ipAdapterCatalogFiles,
  SD_IP_ADAPTERS,
  type SdIpAdapterFile,
  type SdAdapter,
  type SdAdapterKind,
  type SdPlatform,
  type SdRelease,
  type SdSpeedAdapter,
  type SdSpeedAdapterFile,
  type SdUpscalerFile,
} from './sd-cpp-models'
import { detectGpu, isGpuBuildMarker } from './gpu-detect'
import { resolveBinary } from './util/resolve-binary'
import { withInstallLock } from './util/install-lock'
import { cleanupStaleBackups } from './util/self-update'
import { DownloadProgressTracker, trackerFromSdFiles } from './util/download-progress'
import { resumableDownload, sha256File, extractArchive, prepareResumablePartial } from './util/installer-kit'
import {
  runManagedDownload,
  adoptExternalProgress,
  settleExternalDownload,
  pauseManagedDownload,
  listDownloads,
} from './download-manager'
import { shouldFallBackToLegacyDownload, sdManagedId, sdManagedIdPrefix } from './util/download-queue'
import { resolveModelDir, removeResolved, partPathFor } from './model-storage'

// ─── Paths ────────────────────────────────────────────────────────────────────

function sdRoot(): string { return join(app.getPath('userData'), 'sd-cpp') }
export function sdBinDir(): string { return join(sdRoot(), 'bin') }
// No `sdModelsDir()`: it returned `<userData>/sd-cpp/models` and was a second,
// hardcoded answer to a question model-storage.ts owns (see the note in
// llama-cpp-installer.ts). Every weight path here comes from resolveModelDir.
function sdDownloadsDir(): string { return join(sdRoot(), 'downloads') }

/** Absolute path to the sd-cli executable if installed, else null.
 *  Uses the binary-resolver cascade: env-var override → bundled paths → PATH. */
export function getSdCliPath(): string | null {
  // Primary name 'sd-cli'; fall back to older 'sd' binary.
  // bundledCandidates are relative to each resource root; the exe suffix is
  // added automatically by resolveBinary on win32.
  const binDir = sdBinDir()
  const result = resolveBinary('sd-cli', {
    envVar: 'SD_CLI_PATH',
    bundledCandidates: [
      join(binDir, 'sd-cli'),
      join(binDir, 'sd'),
    ],
  })
  if (result) return result
  // Fallback: older 'sd' name on PATH.
  return resolveBinary('sd', {
    bundledCandidates: [join(binDir, 'sd')],
  })
}

export function isSdCppInstalled(): boolean { return getSdCliPath() !== null }

// ─── IS THE INSTALLED ENGINE THE ONE WE PIN? ─────────────────────────────────
//
// `isSdCppInstalled` answers "is there a binary", and `installSdCppBinary`
// short-circuits on it. So bumping SD_CPP_VERSION shipped a new engine to FRESH
// installs and nothing at all to everyone who already had one — the pin moved,
// their bytes did not, and no surface said so. `updateSdCppBinary` (below) has
// been a complete atomic swap the whole time, described in its own comment as
// "dormant until an update flow calls it". This is that flow's missing half.
//
// The version is READ OFF THE BINARY, not stamped beside it at install time. A
// stamp is a second truth that drifts the moment anyone swaps a file by hand or
// restores a backup; sd-cli prints its own provenance on the first line of
// `--help`:
//
//   stable-diffusion.cpp version unknown, commit b290693
//
// so the binary is asked what it is. Note the literal words "version unknown" —
// upstream does not stamp a version, only the commit, which is exactly why our
// tag carries the short hash (`master-810-db99efd`) and why comparing hashes is
// the only comparison available.

/** The short commit `sd-cli` reports for itself, or null if it cannot be read. */
let _installedCommit: string | null | undefined

export function installedSdCppCommit(): string | null {
  if (_installedCommit !== undefined) return _installedCommit
  _installedCommit = null
  const bin = getSdCliPath()
  if (bin) {
    try {
      // `--help` rather than a version flag: the pinned builds have no
      // `--version`, and the banner is printed above the help either way.
      // Bounded hard — this runs on a catalog read, not in a render loop.
      const out = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      const text = `${out.stdout ?? ''}${out.stderr ?? ''}`
      const m = /commit\s+([0-9a-f]{7,40})/i.exec(text)
      if (m) _installedCommit = m[1].toLowerCase()
    } catch { /* an engine that will not answer is one we cannot date */ }
  }
  return _installedCommit
}

/** Drop the cache — the binary only changes through our own updater. */
export function forgetInstalledSdCppCommit(): void { _installedCommit = undefined }

/** The short hash the pinned tag names (`master-810-db99efd` → `db99efd`). */
export function pinnedSdCppCommit(): string {
  return (SD_CPP_VERSION.split('-').pop() ?? '').toLowerCase()
}

export interface SdCppUpdateState {
  installed: string | null
  pinned:    string
  /**
   * True ONLY when both are known and they differ. An engine whose commit could
   * not be read is NOT reported as out of date: offering an update on a guess
   * would hand the user a 400 MB download to fix a problem nobody established.
   */
  updateAvailable: boolean
}

/**
 * Do these two commits describe different builds?
 *
 * Pure and exported so the RULE can be tested without a binary to spawn — the
 * rule is the part with the failure modes, and all of them are "say yes when
 * you do not know":
 *
 *   · an engine that reported no commit is NOT stale. Offering a 400 MB
 *     download to fix a problem nobody established is worse than saying
 *     nothing.
 *   · a PREFIX match is the same build. Upstream tags carry a 7-char short
 *     hash and the binary may print a longer one (or the reverse), so
 *     `db99efd` and `db99efd1a2b3` are one commit, not two.
 *   · comparison is case-insensitive, because hex is.
 */
export function isSdCppEngineStale(installed: string | null, pinned: string): boolean {
  if (!installed || !pinned) return false
  const a = installed.toLowerCase()
  const b = pinned.toLowerCase()
  return !a.startsWith(b) && !b.startsWith(a)
}

export function sdCppUpdateState(): SdCppUpdateState {
  const installed = isSdCppInstalled() ? installedSdCppCommit() : null
  const pinned = pinnedSdCppCommit()
  return { installed, pinned, updateAvailable: isSdCppEngineStale(installed, pinned) }
}

/**
 * Is the INSTALLED engine the CUDA build? (`--diffusion-fa` is a CUDA kernel.)
 *
 * Read off the disk rather than re-probing the GPU: `_doInstallBinary` extracts
 * the cudart archive's DLLs into bin/ ONLY for the win-cuda asset, so their
 * presence is a fact about the binary that will actually be spawned. A machine
 * that has an NVIDIA card but installed the CPU build (or whose CUDA install
 * failed and rolled bin/ back) answers false, which is the truth — an
 * nvidia-smi probe would answer yes and pass a flag the binary has no kernel
 * for. Sync + cheap, so the generate path can call it per run.
 */
export function isCudaSdBuild(): boolean {
  let entries: string[] = []
  try { entries = readdirSync(sdBinDir()) } catch { return false }
  return entries.some(n => /^cudart64.*\.dll$/i.test(n))
}

/**
 * Whether the INSTALLED sd.cpp build is GPU-capable (CUDA / Vulkan / ROCm)
 * rather than the CPU-only build — the sd.cpp twin of gpu-detect's
 * `isGpuBuildInstalled` for llama.cpp (NIGHT-QUEUE 2026-07-31 lane 3C).
 *
 * Reuses the SAME marker regexes (`isGpuBuildMarker`): stable-diffusion.cpp is
 * built on the same ggml backend llama.cpp is, so its CUDA/Vulkan/HIP builds
 * carry the same `cudart64_*.dll` / `ggml-cuda` / `ggml-vulkan` / `ggml-hip` /
 * `rocblas`/`hipblas` companions next to the binary. The CUDA half is
 * OBSERVED (isCudaSdBuild above checks the identical cudart64 pattern); the
 * Vulkan/ROCm half is INFERRED the same way gpu-detect documents for
 * llama.cpp — a wrong guess can only produce a false negative (reports
 * CPU-only for a working GPU build), never a false claim of acceleration.
 */
export function isSdGpuBuildInstalled(): boolean {
  let entries: string[] = []
  try { entries = readdirSync(sdBinDir()) } catch { return false }
  return entries.some(isGpuBuildMarker)
}

// ─── Progress push ─────────────────────────────────────────────────────────────

export type SdStage = 'checking' | 'downloading-binary' | 'extracting' | 'downloading-model' | 'verifying' | 'done' | 'error'
export interface SdInstallProgress {
  stage: SdStage; message: string; percent: number; bytes?: number; totalBytes?: number
  /** Instantaneous transfer rate (bytes/sec) from the rolling window; omitted/0 when unknown. */
  speedBytesPerSec?: number
  /** Estimated seconds remaining; omitted/-1 when unknown. */
  etaSec?: number
}

function push(win: BrowserWindow | null, e: SdInstallProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('sd-cpp:install-progress', e)
}

// ─── Concurrency guards ──────────────────────────────────────────────────────
// withInstallLock() (install-lock.ts) provides module-singleton + lockfile
// protection.  The activeModelDownloads map keeps per-model in-flight promises
// so simultaneous model downloads for different models proceed in parallel while
// the SAME model is deduped (model download is not serialized with the binary
// install — both can run independently).
const activeModelDownloads = new Map<string, Promise<void>>()

// ─── Locate + lift the binary dir out of the extracted tree ───────────────────

function findBinaryDir(root: string): string | null {
  const names = process.platform === 'win32' ? ['sd-cli.exe', 'sd.exe'] : ['sd-cli', 'sd']
  let found: string | null = null
  const walk = (dir: string): void => {
    if (found) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let s; try { s = statSync(p) } catch { continue }
      if (s.isFile() && names.includes(name.toLowerCase())) { found = dir; return }
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

function collectFilesByExtInto(root: string, destDir: string, ext: string): number {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  const lowerExt = ext.toLowerCase()
  let count = 0
  const walk = (dir: string): void => {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let s; try { s = statSync(p) } catch { continue }
      if (s.isFile() && name.toLowerCase().endsWith(lowerExt)) { try { copyFileSync(p, join(destDir, name)); count++ } catch { /* ignore */ } }
      else if (s.isDirectory()) walk(p)
    }
  }
  walk(root)
  return count
}

/**
 * Drop leftover `<asset>.tmp*` files once the real archive has landed. Only
 * ever removes siblings of a COMPLETED download (the caller renamed its own
 * .tmp away first), so a resumable partial is never collected.
 */
function sweepStalePartials(assetFilename: string): void {
  const prefix = `${assetFilename}.tmp`
  let entries: string[] = []
  try { entries = readdirSync(sdDownloadsDir()) } catch { return }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    try { rmSync(join(sdDownloadsDir(), name), { force: true }) } catch { /* */ }
  }
}

/**
 * A COMPLETE, SHA-VERIFIED archive from a prior attempt must never be
 * downloaded a second time.
 *
 * The resume logic only ever protected the `<asset>.tmp`: once the bytes were
 * verified the tmp was renamed to the final `<asset>.zip`, so a failure LATER in
 * the same install (the cudart download is the live case) left a 345 MB proven-
 * good zip sitting in downloads/ that the next Install click ignored — no tmp
 * existed, so the whole engine came down the wire again.
 *
 * Verdict:
 *   • sha matches            → true. Hand `finalPath` straight to the extractor.
 *   • sha mismatch / 0 bytes → false, and the file is DELETED (proven-bad bytes
 *     must not be resumed onto, and must not shadow the fresh download).
 *   • absent                 → false.
 *   • sha unverifiable (placeholder / missing) → false, file KEPT. We cannot
 *     prove it is good and we cannot prove it is bad, so we neither trust nor
 *     destroy it. In practice every shipped release SHA is real, and a packaged
 *     build refuses placeholders outright a few lines later.
 */
export async function canReuseLandedArchive(finalPath: string, expectedSha: string | undefined): Promise<boolean> {
  let size = -1
  try { size = statSync(finalPath).size } catch { return false }   // absent
  if (size <= 0) { try { rmSync(finalPath, { force: true }) } catch { /* */ } return false }
  if (!expectedSha || isShaPlaceholder(expectedSha)) return false  // unverifiable — never trusted
  let actual: string
  try { actual = await sha256File(finalPath) } catch { return false }
  if (actual.toLowerCase() === expectedSha.toLowerCase()) return true
  try { rmSync(finalPath, { force: true }) } catch { /* */ }
  return false
}

/**
 * FULLY-SUCCESSFUL install only: drop the landed archives.
 *
 * sweepStalePartials only ever collected `.tmp*` siblings, so a finished install
 * left ~925 MB of extracted-and-never-read-again zips (engine + cudart) parked
 * on the userData volume — the drive users are most often short on.
 *
 * Deliberately NOT called on a partial install: a kept zip is exactly what makes
 * canReuseLandedArchive's skip work on the next Install click. `.tmp` partials
 * are also left alone (a `foo.zip.tmp` does not end in `.zip`), so a paused
 * download for another platform survives.
 *
 * Returns the number of archives removed.
 */
export function sweepLandedArchives(): number {
  let entries: string[] = []
  try { entries = readdirSync(sdDownloadsDir()) } catch { return 0 }
  let removed = 0
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.zip')) continue
    const p = join(sdDownloadsDir(), name)
    try { if (!statSync(p).isFile()) continue } catch { continue }
    try { rmSync(p, { force: true }); removed++ } catch { /* */ }
  }
  return removed
}

// ─── Public API: install binary ────────────────────────────────────────────────

/**
 * `platformId` lets a caller (an explicit "install the ROCm build" expert
 * flow) force a specific release; omitted, the install auto-selects via
 * gpu-detect (see `_resolveSdRelease` below).
 */
export function installSdCppBinary(win: BrowserWindow | null, platformId?: SdPlatform): Promise<void> {
  cleanupStaleBackups(sdBinDir())
  if (isSdCppInstalled()) {
    // Already-installed IS a fully successful install, so the same sweep applies —
    // this is what reclaims the archives an install from BEFORE this fix left
    // behind, without making the user reinstall the engine to get the space back.
    sweepLandedArchives()
    push(win, { stage: 'done', message: 'stable-diffusion.cpp already installed', percent: 100 }); return Promise.resolve()
  }
  return _runInstall(win, platformId)
}

/**
 * Atomic in-place update of the installed sd-cli binary (download .new -> SHA
 * verify -> swap; prior kept as .old and cleaned on next launch). Throws if
 * sd-cli is not installed. Dormant until an update flow calls it.
 */
/**
 * The one way the sd-cli binary is ever replaced — install or update.
 *
 * The cache invalidation is in a `finally`, and that is not defensive padding:
 * `installedSdCppCommit()` memoises per process, and the first version cleared
 * it only after a SUCCESSFUL update. A run that extracted the new engine and
 * then threw (or, as observed on 2026-08-03, one whose caller timed out and
 * abandoned the promise) left the app reporting the OLD commit while the new
 * binary was already on disk — so the UPDATE button stayed on screen offering
 * to install what was already installed.
 *
 * The binary may have changed even when the install FAILED, so the only safe
 * rule is: after this returns, whatever we thought we knew is stale.
 */
async function _runInstall(win: BrowserWindow | null, platformId?: SdPlatform): Promise<void> {
  return withInstallLock('sd-cpp-binary', async () => {
    try { await _doInstallBinary(win, platformId) }
    finally { forgetInstalledSdCppCommit() }
  })
}

// `updateSdCppBinary(url, sha256)` USED TO LIVE HERE and has been deleted,
// because it could never have been right for this engine and its name said
// otherwise. `updateBinary` (util/self-update) downloads a URL and rotates the
// bytes into place AS THE BINARY — correct for an engine shipped as one bare
// executable, and wrong twice over for sd.cpp:
//
//   1. the release asset is a ZIP. Pointing the swap at it writes a 362 MB
//      archive over `sd-cli.exe`. DRIVER-PROVEN, 2026-08-03: the update
//      "succeeded" (`{ok:true, from:'b290693', to:'db99efd'}`) and left an exe
//      beginning `PK\x03\x04` that Windows refused to execute. The next status
//      read reported `installed: null` — which is the only reason it was caught
//      before the owner tried to render.
//   2. even extracting just the exe would be wrong: the archive carries ~15
//      DLLs (`ggml-base`, `ggml-cpu-*`, `ggml-cuda`, …) versioned WITH it, so a
//      one-file swap produces an engine whose halves disagree.
//
// An sd.cpp update is therefore the same operation as an sd.cpp install:
// download the archive, verify its sha, extract over the bin directory. That
// path already exists, already resumes, already handles the cudart companion —
// the ONLY reason it did not run was the short-circuit in the public wrapper.

/**
 * Move an EXISTING install onto the pinned release.
 *
 * Runs the install path itself rather than a bespoke swap: same asset
 * resolution (so a CUDA machine gets the CUDA build and an AMD one Vulkan),
 * same sha verification, same resumable download, same extract — and, crucially,
 * the same DLLs, which no single-file update could have replaced.
 *
 * The cudart companion is skipped when its runtime is already on disk. That
 * archive is versioned by CUDA rather than by the sd.cpp tag and was
 * byte-identical across the 782 → 810 bump, so re-fetching 563 MB to update a
 * 362 MB engine would more than double the download for bytes that cannot have
 * changed. `_doInstallBinary`'s own `canReuseLandedArchive` gate covers the case
 * where the zip is still in the downloads dir; this covers the ordinary one
 * where it was swept after a successful install.
 */
export async function updateSdCppToPinned(
  win: BrowserWindow | null = null,
  platformId?: SdPlatform,
): Promise<{ from: string | null; to: string }> {
  if (!isSdCppInstalled()) throw new Error('stable-diffusion.cpp is not installed - install it first.')
  const from = installedSdCppCommit()
  const asset = await _resolveSdRelease(platformId)
  if (!asset) throw new Error(`No stable-diffusion.cpp prebuilt for ${process.platform}/${process.arch}.`)
  await _runInstall(win, asset.platform)
  const to = installedSdCppCommit()
  // REPORT WHAT THE BINARY SAYS, not what we asked for. The defect this replaced
  // returned the pinned hash unconditionally and so announced a successful
  // update over a corrupted exe.
  // NO `.old` IS PROMISED HERE. The first version of this message offered one,
  // inherited from the single-file swap it replaced — `updateBinary` really did
  // rotate the previous binary aside. The install path does not: it clears bin/
  // and extracts over it, so there is nothing to roll back to. Telling a user a
  // safety net exists when it does not is worse than telling them nothing.
  if (to === null) throw new Error('The engine was replaced but will not report its version. Click Install to re-extract it.')
  return { from, to }
}

/**
 * 3-WAY BACKEND SELECTION (NIGHT-QUEUE 2026-07-31 lane 3C).
 *
 * An explicit `platformId` always wins (an expert asking for `win-rocm` by
 * name). Otherwise the pick is gpu-detect's job: its `backend` verdict
 * (cuda/vulkan/metal/cpu) maps through `sdReleaseForBackend` to a release row.
 *
 * For an NVIDIA machine this reaches the exact same `win-cuda` row the old
 * `hasNvidiaGpu()` boolean probe picked — gpu-detect's own first rung IS
 * nvidia-smi, so the CUDA flow stays byte-identical for nvidia users. The
 * difference is only what happens on a NON-nvidia GPU: gpu-detect also names
 * `vulkan` for AMD/Intel, which the old boolean-only probe had no way to
 * express and silently mapped to `win-cpu` instead.
 */
async function _resolveSdRelease(platformId: string | undefined): Promise<SdRelease | null> {
  if (platformId) return SD_CPP_RELEASES.find(r => r.platform === platformId) ?? null
  let backend: 'cuda' | 'metal' | 'vulkan' | 'cpu' = 'cpu'
  try { backend = (await detectGpu()).backend } catch { backend = 'cpu' }
  const wanted = sdReleaseForBackend(backend, process.platform, process.arch)
  return wanted ? SD_CPP_RELEASES.find(r => r.platform === wanted) ?? null : null
}

async function _doInstallBinary(win: BrowserWindow | null, platformId?: SdPlatform): Promise<void> {
  push(win, { stage: 'checking', message: 'Resolving stable-diffusion.cpp release...', percent: 0 })
  const asset: SdRelease | null = await _resolveSdRelease(platformId)
  if (!asset) {
    const err = `No stable-diffusion.cpp prebuilt for ${process.platform}/${process.arch}. Supported: Windows (CUDA/Vulkan/ROCm/CPU), macOS arm64.`
    push(win, { stage: 'error', message: err, percent: 0 }); throw new Error(err)
  }

  mkdirSync(sdDownloadsDir(), { recursive: true })
  mkdirSync(sdBinDir(), { recursive: true })
  const zipFinal = join(sdDownloadsDir(), asset.filename)

  // A complete, SHA-verified zip from an attempt that died LATER (cudart, or the
  // extract) is reused instead of re-downloaded — see canReuseLandedArchive.
  push(win, { stage: 'verifying', message: 'Checking for an already-downloaded archive...', percent: -1 })
  if (!(await canReuseLandedArchive(zipFinal, asset.sha256))) {
    // A previous attempt's partial is RESUMED, not discarded (this is what the
    // model downloader always did, and why it survived the same network failure
    // the engine install used to wedge on). prepareResumablePartial also un-wedges
    // a .tmp that an earlier build left un-openable, so a failed engine install is
    // recoverable IN-PROCESS — no app restart.
    const zipTmp = prepareResumablePartial(join(sdDownloadsDir(), `${asset.filename}.tmp`)).path

    push(win, { stage: 'downloading-binary', message: `Downloading sd.cpp (${SD_CPP_VERSION}, ${asset.platform})`, percent: 0 })
    try {
      const binTracker = new DownloadProgressTracker([{ id: 'binary' }])
      await resumableDownload(asset.url, zipTmp, (bytes, total) => {
        binTracker.tick('binary', bytes, total)
        const snap = binTracker.snapshot()
        push(win, { stage: 'downloading-binary', message: `Downloading sd.cpp (${asset.platform})`, percent: snap.percent, bytes: snap.receivedBytes, totalBytes: snap.totalBytes, speedBytesPerSec: snap.speedBytesPerSec, etaSec: snap.etaSec })
      })
    } catch (err) {
      // KEEP the partial — the next Install click resumes from these bytes.
      // (Only integrity failures below delete it: those bytes are proven bad.)
      const msg = `Download failed: ${err instanceof Error ? err.message : String(err)} — partial kept, click Install to resume.`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }

    push(win, { stage: 'verifying', message: 'Verifying SHA256...', percent: -1 })
    const actualSha = await sha256File(zipTmp)
    if (isShaPlaceholder(asset.sha256)) {
      // Fail CLOSED in a packaged build (audit C2): a release must never run an
      // unverified binary. Dev keeps warn-and-allow so SHAs can be observed.
      if (app.isPackaged) {
        try { rmSync(zipTmp, { force: true }) } catch { /* */ }
        const msg = `Refusing to install sd-cpp "${asset.platform}" — its registry SHA256 is a placeholder and this is a packaged build. Observed ${actualSha}; pin it in sd-cpp-models.ts.`
        push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
      }
      console.warn(`[sd-cpp] SHA256 verification SKIPPED for "${asset.platform}" (placeholder). Observed: ${actualSha}. Paste into sd-cpp-models.ts before release.`)
    } else if (actualSha.toLowerCase() !== asset.sha256.toLowerCase()) {
      try { rmSync(zipTmp, { force: true }) } catch { /* */ }
      const msg = `SHA256 mismatch for ${asset.platform}: expected ${asset.sha256}, got ${actualSha}. Aborting.`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    try { renameSync(zipTmp, zipFinal) } catch { /* */ }
  } else {
    console.info(`[sd-cpp] reusing the verified archive already on disk: ${asset.filename} (skipping the download).`)
  }
  sweepStalePartials(asset.filename)

  push(win, { stage: 'extracting', message: 'Extracting release...', percent: -1 })
  const staging = join(sdDownloadsDir(), 'staging')
  try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }
  mkdirSync(staging, { recursive: true })
  try { await extractArchive(zipFinal, staging) }
  catch (err) {
    const msg = `Extraction failed: ${err instanceof Error ? err.message : String(err)}.`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }
  const binSourceDir = findBinaryDir(staging)
  if (!binSourceDir) {
    const msg = `Could not locate sd-cli in the extracted archive (${staging}). The release layout may have changed.`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }
  // ── THE CUDA RUNTIME MUST SURVIVE THIS CLEAR ────────────────────────────────
  //
  // Read BEFORE anything is deleted, because the clear below used to remove the
  // very marker the cudart short-circuit tests for. Reachable only since
  // `updateSdCppToPinned` started running this function against a POPULATED
  // bin/ (a fresh install has nothing here), and the consequence was silent:
  // every CUDA engine update re-downloaded 563 MB of runtime that cannot have
  // changed, because the skip could never fire. Confirmed on the owner's
  // machine — the update at 11:31 left `downloads/` swept at 11:32, which only
  // happens after a real download.
  const hadCudaRuntime = existsSync(join(sdBinDir(), 'cudart64_12.dll'))

  // Clear stale FILES in bin/ (keep dirs), then lift the binary's folder in.
  //
  // …except the CUDA redistributable DLLs, which no sd.cpp archive carries and
  // which this loop would therefore delete with nothing to replace them. That
  // is what made `hadCudaRuntime` a lie the moment it was believed: skip the
  // download AND delete the runtime and the engine cannot start at all.
  //
  // MEASURED, not guessed (2026-08-03): diffing the installed bin/ against the
  // engine archive's own contents leaves exactly `cudart64_12.dll`,
  // `cublas64_12.dll`, `cublasLt64_12.dll` — the cu12 redist set. `ggml-cuda.dll`
  // also showed up in that diff and is NOT in this set: it ships inside the
  // win-cuda ENGINE archive and must keep being replaced. The pattern is the
  // NVIDIA redist FAMILY rather than those three names, so a future cu13 or an
  // added cufft/curand does not reopen this.
  const CUDA_REDIST_RE = /^(cudart|cublas|cublasLt|cufft|curand|cusparse|cusolver|nvrtc|nvJitLink)64_\d+\.dll$/i
  try {
    for (const name of readdirSync(sdBinDir())) {
      if (CUDA_REDIST_RE.test(name)) continue
      const p = join(sdBinDir(), name)
      if (statSync(p).isFile()) { try { rmSync(p, { force: true }) } catch { /* */ } }
    }
  } catch { /* */ }
  moveDirContents(binSourceDir, sdBinDir())

  // CUDA runtime companion (separate archive on win-cuda, like llama.cpp).
  if (asset.cudartUrl && asset.cudartFilename) {
    const failCuda = (msg: string): never => {
      try { for (const name of readdirSync(sdBinDir())) { const p = join(sdBinDir(), name); try { if (statSync(p).isFile()) rmSync(p, { force: true }) } catch { /* */ } } } catch { /* */ }
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    const cFinal = join(sdDownloadsDir(), asset.cudartFilename)
    // ALREADY-EXTRACTED RUNTIME SHORT-CIRCUIT. The reuse gate below saves a
    // re-download when the ZIP is still in the downloads dir; after a
    // successful install that zip has been swept, so an ENGINE UPDATE would
    // pull 563 MB of CUDA runtime again — more than doubling a 362 MB update
    // for bytes that cannot have changed, because this archive is versioned by
    // CUDA and not by the sd.cpp tag (it was byte-identical across 782 → 810).
    //
    // `hadCudaRuntime` is read at the TOP of this function, before the stale-file
    // clear — testing it here would have tested a file the clear had just
    // deleted, which is exactly the bug this comment used to describe wrongly.
    // A fresh install has no runtime, so it downloads; an update has one, so it
    // does not. `failCuda`'s bin/-wipe therefore only runs on the fresh path,
    // where there is no previously-working engine to destroy.
    if (hadCudaRuntime) {
      push(win, { stage: 'extracting', message: 'CUDA runtime already installed - skipping', percent: -1 })
    } else {
    // Same reuse gate as the engine zip: a verified cudart archive left behind by
    // an attempt that died in the extract must not come down the wire again.
    push(win, { stage: 'verifying', message: 'Checking for an already-downloaded CUDA runtime...', percent: -1 })
    if (!(await canReuseLandedArchive(cFinal, asset.cudartSha256))) {
      push(win, { stage: 'downloading-binary', message: 'Downloading CUDA runtime (cudart)...', percent: -1 })
      const cTmp = prepareResumablePartial(join(sdDownloadsDir(), `${asset.cudartFilename}.tmp`)).path
      try {
        const cudaTracker = new DownloadProgressTracker([{ id: 'cudart' }])
        await resumableDownload(asset.cudartUrl, cTmp, (bytes, total) => {
          cudaTracker.tick('cudart', bytes, total)
          const snap = cudaTracker.snapshot()
          push(win, { stage: 'downloading-binary', message: 'Downloading CUDA runtime', percent: snap.percent, bytes: snap.receivedBytes, totalBytes: snap.totalBytes, speedBytesPerSec: snap.speedBytesPerSec, etaSec: snap.etaSec })
        })
      } catch (err) {
        // Partial kept — the next Install click resumes it (see the engine zip).
        failCuda(`CUDA runtime download failed: ${err instanceof Error ? err.message : String(err)} — partial kept, click Install to resume. Or use the CPU build instead.`)
      }
      const cSha = await sha256File(cTmp)
      if (asset.cudartSha256 && !isShaPlaceholder(asset.cudartSha256) && cSha.toLowerCase() !== asset.cudartSha256.toLowerCase()) {
        try { rmSync(cTmp, { force: true }) } catch { /* */ }
        failCuda(`cudart SHA256 mismatch: expected ${asset.cudartSha256}, got ${cSha}. Aborting.`)
      } else if (isShaPlaceholder(asset.cudartSha256 ?? '')) {
        if (app.isPackaged) {
          try { rmSync(cTmp, { force: true }) } catch { /* */ }
          failCuda(`Refusing to install cudart — its registry SHA256 is a placeholder and this is a packaged build. Observed ${cSha}; pin it in sd-cpp-models.ts.`)
        }
        console.warn(`[sd-cpp] cudart SHA256 verification SKIPPED (placeholder). Observed: ${cSha}.`)
      }
      try { renameSync(cTmp, cFinal) } catch { /* */ }
    } else {
      console.info(`[sd-cpp] reusing the verified CUDA runtime already on disk: ${asset.cudartFilename} (skipping the download).`)
    }
    sweepStalePartials(asset.cudartFilename)
    const cStaging = join(sdDownloadsDir(), 'cudart-staging')
    try { rmSync(cStaging, { recursive: true, force: true }) } catch { /* */ }
    mkdirSync(cStaging, { recursive: true })
    push(win, { stage: 'extracting', message: 'Extracting CUDA runtime...', percent: -1 })
    await extractArchive(cFinal, cStaging)
    const dllCount = collectFilesByExtInto(cStaging, sdBinDir(), '.dll')
    try { rmSync(cStaging, { recursive: true, force: true }) } catch { /* */ }
    if (dllCount === 0) failCuda('CUDA runtime archive yielded no DLLs — use the CPU build instead.')
    } // ← closes the "runtime not already extracted" branch
  }

  try { rmSync(staging, { recursive: true, force: true }) } catch { /* */ }
  if (!isSdCppInstalled()) {
    const msg = `Install reported success but sd-cli is missing under ${sdBinDir()}.`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }
  // ONLY here — past every failure exit above. Everything the archives carried is
  // now extracted into bin/, so holding ~925 MB of zips on the userData volume
  // buys nothing. A partial install deliberately keeps them (see the reuse gate).
  const swept = sweepLandedArchives()
  if (swept > 0) console.info(`[sd-cpp] install complete — swept ${swept} landed archive(s) from ${sdDownloadsDir()}.`)
  push(win, { stage: 'done', message: 'stable-diffusion.cpp installed.', percent: 100 })
}

// ─── Public API: model download (MULTI-FILE) ─────────────────────────────────

/**
 * The on-disk extension for one component file (risk R2).
 *
 * THE .gguf TRAP this replaces: the old signature was `(url, role)` and guessed
 * from `extname(url)`, falling back to `.gguf` for the roles the CURATED rows
 * happen to ship as GGUF. Every curated URL ends in `.safetensors` or `.gguf`,
 * so the guess was never wrong — until a Civitai URL arrives. Those are
 * `https://civitai.com/api/download/models/<versionId>`: NO extension anywhere
 * in the path, so a 6 GB SDXL safetensors checkpoint would have landed as
 * `model.gguf` and sd-cli would have refused a file whose bytes contradict its
 * name.
 *
 * Precedence — declared format, then the declared file name, then the URL, then
 * the legacy role guess:
 *   • `format` is upstream's own word for the container. Civitai reports GGUF
 *     as "Other", so "Other"/unknown deliberately falls THROUGH rather than
 *     mapping to anything.
 *   • PickleTensor (and .ckpt / .pt / .bin) are REFUSED here as well as at the
 *     mapper — `null` means "this component must never be written to disk".
 *     Defense in depth: this is the last layer before a path is handed out.
 */
export function fileExtFor(
  file: { url: string; fileName?: string; format?: string },
  role: string,
): string | null {
  const fmt = (file.format ?? '').trim().toLowerCase()
  if (fmt === 'safetensor' || fmt === 'safetensors') return '.safetensors'
  if (fmt === 'gguf') return '.gguf'
  if (fmt === 'pickletensor' || fmt === 'pickle' || fmt === 'ckpt' || fmt === 'diffusers') return null

  for (const candidate of [file.fileName, safePathname(file.url)]) {
    if (!candidate) continue
    const e = extname(candidate).toLowerCase()
    if (!e) continue
    if (e === '.safetensors' || e === '.sft') return '.safetensors'
    if (e === '.gguf') return '.gguf'
    if (e === '.ckpt' || e === '.pt' || e === '.pth' || e === '.bin' || e === '.pickle') return null
    return e                                  // an extension we do not classify, kept verbatim
  }
  // Nothing declared anything: the legacy role guess, which is right for every
  // curated row (their GGUF components carry these roles). `llm` joins the GGUF
  // side for the same reason `t5xxl` is there — a text encoder that big is
  // published quantized, and every one we can install is a .gguf. So does
  // `diffusion_high`, which is the second half of a diffusion pair and is
  // published by the same quantizer, in the same container, as the first.
  return (role === 'model' || role === 'diffusion' || role === 'diffusion_high' || role === 't5xxl' || role === 'llm')
    ? '.gguf' : '.safetensors'
}

function safePathname(url: string): string {
  try { return new URL(url).pathname } catch { return '' }
}

/** role → absolute file path inside models/<id>/, for the client's arg builder.
 *  null when the model is unknown OR any component is a refused container. */
export function modelComponentPaths(id: string): Record<string, string> | null {
  const model = findSdModel(id)
  if (!model) return null
  // Dual-root: relocated storage-root dir first, legacy userData fallback.
  const dir = resolveModelDir('sd', id)
  const out: Record<string, string> = {}
  for (const f of model.files) {
    const ext = fileExtFor(f, f.role)
    if (!ext) {
      console.warn(`[sd-cpp] model "${id}/${f.role}" declares an unsupported weights container (${f.format ?? f.fileName ?? f.url}) — refusing to place it.`)
      return null
    }
    out[f.role] = join(dir, `${f.role}${ext}`)
  }
  return out
}

// ── REUSE: the same bytes are never downloaded twice ─────────────────────────
//
// Curated rows SHARE component files by design (sd-cpp-models' identity index):
// Z-Image Turbo's autoencoder IS FLUX.1's, and the Wan i2v row's vae + umt5
// encoder ARE the 2.1 row's — 5.9 GB of encoder alone. The download loop only
// ever asked `existsSync(dest)` inside the model's OWN directory, so every one
// of those came down the wire a second time onto a volume that already held it.
//
// The registry has carried the answer all along: `sha256` IS the file identity.
//
// TRUST, BUT RE-HASH. The twin is verified again before it is placed, exactly as
// canReuseLandedArchive re-hashes a landed zip rather than assuming the bytes
// are still the bytes that were verified at download. Hashing 5.6 GB costs
// seconds; re-downloading it costs minutes, and placing a silently-corrupt file
// under a second model would turn one broken install into two.

/**
 * An already-downloaded component with the same sha256, belonging to a DIFFERENT
 * model, or null.
 *
 * `forModelId` is excluded deliberately: a model's own file existing is the
 * `existsSync(dest)` case the caller already handles, and matching it here would
 * make the reuse path try to link a file onto itself.
 */
export async function findReusableComponent(
  file: { sha256: string },
  forModelId: string,
): Promise<string | null> {
  if (isShaPlaceholder(file.sha256)) return null
  for (const ref of sdFilesWithSha(file.sha256)) {
    if (ref.modelId === forModelId) continue
    const paths = modelComponentPaths(ref.modelId)
    const p = paths?.[ref.role]
    if (!p || !existsSync(p)) continue
    let actual: string
    try { actual = await sha256File(p) } catch { continue }
    if (actual.toLowerCase() !== file.sha256.toLowerCase()) {
      console.warn(`[sd-cpp] "${ref.modelId}/${ref.role}" no longer matches its registry sha — not reusing it (expected ${file.sha256}, got ${actual}).`)
      continue
    }
    return p
  }
  return null
}

/**
 * Place a verified twin at `dest` without a download.
 *
 * A HARD LINK first: it costs zero bytes and, unlike anything that points at
 * the other model's directory, it survives that model being removed — a hard
 * link is a second NAME for the bytes, so removeSdModel on one row cannot empty
 * the other. It fails across volumes (the legacy userData root vs a relocated
 * storage root are commonly different drives), and on filesystems that have no
 * hard links at all, so a copy is the fallback.
 *
 * The copy goes through `part` and is renamed, so an interruption leaves a
 * partial that is not mistaken for an installed component.
 */
export function placeReusedComponent(src: string, dest: string, part: string): 'link' | 'copy' {
  try { rmSync(part, { force: true }) } catch { /* */ }
  try {
    linkSync(src, dest)
    return 'link'
  } catch { /* cross-device, or no hard links here — fall through to a copy */ }
  copyFileSync(src, part)
  renameSync(part, dest)
  return 'copy'
}

/**
 * MiB of THIS row already on disk, per component role. Absent roles have
 * nothing; an id we do not know answers `{}`.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Driver finding (owner, live, rows5): the TI2V-5B install died mid-file twice
 * on network flake, and both times the panel went back to the plain download
 * label as though nothing had ever happened — while 5-6.5 GB of verified
 * partials sat on disk and the button still quoted the full remaining transfer.
 *
 * Resume itself was never broken: a re-click skips a completed component and
 * appends to the `.part`. What was missing is that the FACT of those bytes never
 * left this process. The only thing that knew was a transient
 * `sd-cpp:install-progress` event — and a multi-GB download outlives the tab
 * that subscribed to it, so the error was pushed to nobody and the panel
 * remounted innocent.
 *
 * The bytes are the durable evidence: they survive a tab switch, a restart and a
 * crash, which is exactly what an event does not. So the catalog carries this
 * per row and the panel derives its state from it.
 *
 * Both halves of a component count, because the installer treats both as
 * already-paid: a LANDED file is skipped outright, and a `.part` is resumed from
 * its offset. The landed file wins when somehow both exist — that is the one
 * the next run will use, and a stale `.part` beside it is not additional bytes.
 */
export function sdModelOnDiskMb(id: string): Record<string, number> {
  const paths = modelComponentPaths(id)
  if (!paths) return {}
  const out: Record<string, number> = {}
  for (const [role, dest] of Object.entries(paths)) {
    let bytes = 0
    try { bytes = statSync(dest).size } catch {
      try { bytes = statSync(partPathFor(dest)).size } catch { bytes = 0 }
    }
    if (bytes > 0) out[role] = Math.round(bytes / 1_048_576)
  }
  return out
}

/** A model is installed only when EVERY component file exists. */
export function isSdModelInstalled(id: string): boolean {
  const paths = modelComponentPaths(id)
  if (!paths) return false
  return Object.values(paths).every(p => existsSync(p))
}

/**
 * Every model whose components are all on disk.
 *
 * Carries `name` and `family` because the renderer needs BOTH and had neither:
 * the MediaPage model dropdown was rendering raw ids ('civitai-812345'), and
 * its preset picker GUESSED the family from an id substring ('xl') — which
 * would have handed sd15 presets and a 512 grid to an SDXL checkpoint. The row
 * declares its family; nothing downstream has to guess.
 */
export function listInstalledSdModels(): {
  id: string; name: string; kind: 'image' | 'video'; family: string
  /** The row's OWN recipe. The composer needs all three: the preset picker has
   *  to know whether this row can honestly offer tiers at all (a 1-step
   *  distilled checkpoint cannot), and the LoRA picker gates on `family`. */
  steps: number; cfgScale: number; samplingMethod: string
}[] {
  return allSdModels()
    .filter(m => isSdModelInstalled(m.id))
    .map(m => {
      const row = findSdRow(m.id)
      return {
        id: m.id, name: m.name, kind: m.kind, family: m.family,
        steps:          row?.steps          ?? 20,
        cfgScale:       row?.cfgScale       ?? 7,
        samplingMethod: row?.samplingMethod ?? 'euler',
      }
    })
}

export function removeSdModel(id: string): { ok: boolean; error?: string } {
  // Remove the model subdir from BOTH roots (relocated + legacy).
  return removeResolved('sd', id)
}

// ─── ADAPTERS: LoRA / LyCORIS, Textual Inversion, VAE (spec §4-5) ────────────
//
// A CHECKPOINT is a directory of role-named component files (`<id>/model.safetensors`).
// An ADAPTER is the opposite shape, and it has to be: stable-diffusion.cpp does
// not take `--lora <file>` — there is NO such flag. It takes
// `--lora-model-dir <dir>` and then looks inside that directory for the FILE
// STEM named in the prompt (`<lora:my-lora:0.8>` ⇒ `my-lora.safetensors`).
// `--embd-dir` works the same way for textual inversions, whose token IS the
// stem. So all adapters of a kind must share ONE directory, and the file name
// is load-bearing rather than cosmetic.
//
// That is why the app owns the slug (adapterSlug): 10.7% of real Civitai LoRA
// filenames contain SPACES — which `<lora:name:weight>` cannot carry at all —
// and the top 600 hold 54 outright name collisions. `slug` is hash-derived and
// `[a-z0-9-]`, so it is stable, unique, typeable and safe in a prompt.
//
//   <storage root>/Models/sd/loras/<slug>.safetensors
//                          /embeddings/<slug>.safetensors
//                          /vae/<slug>.safetensors

/** The shared directory one adapter kind lives in (dual-root, like models). */
export function sdAdapterDir(kind: SdAdapterKind): string {
  return resolveModelDir('sd', SD_ADAPTER_DIR[kind])
}

/**
 * Absolute path for one adapter's weights, or null when its container is one we
 * refuse to place (pickle / diffusers — same gate modelComponentPaths applies).
 */
export function adapterFilePath(a: Pick<SdAdapter, 'kind' | 'slug' | 'file'>): string | null {
  const ext = fileExtFor(a.file, 'model')
  if (!ext) return null
  return join(sdAdapterDir(a.kind), `${a.slug}${ext}`)
}

/** True when this adapter's file is on disk. */
export function isSdAdapterInstalled(id: string): boolean {
  const a = findSdAdapter(id)
  if (!a) return false
  const p = adapterFilePath(a)
  return p !== null && existsSync(p)
}

/**
 * Every INSTALLED adapter, with the fields the composer needs to offer it:
 * `family` is the compat gate (an SD 1.5 LoRA on an SDXL checkpoint is a tensor
 * shape mismatch the whole ecosystem silently no-ops), `slug` is what goes in
 * the prompt tag, `triggerWords` are the chips.
 */
export function listInstalledSdAdapters(): Array<{
  id: string; kind: SdAdapterKind; name: string; slug: string; family: string
  triggerWords: string[]; defaultWeight?: number; notes?: string
}> {
  return allSdAdapters()
    .filter(a => isSdAdapterInstalled(a.id))
    .map(a => ({
      id: a.id, kind: a.kind, name: a.name, slug: a.slug, family: a.family,
      triggerWords: a.triggerWords ?? [],
      ...(typeof a.defaultWeight === 'number' ? { defaultWeight: a.defaultWeight } : {}),
      ...(a.notes ? { notes: a.notes } : {}),
    }))
}

/**
 * The directories to hand sd-cli, for kinds that actually have an installed
 * file. Empty for a kind with nothing in it — pointing `--lora-model-dir` at a
 * directory that does not exist makes the engine log a scan failure for no
 * reason, and every flag we pass has to be one that does something.
 */
export function installedAdapterDirs(): Partial<Record<SdAdapterKind, string>> {
  const out: Partial<Record<SdAdapterKind, string>> = {}
  for (const a of allSdAdapters()) {
    if (out[a.kind]) continue
    if (!isSdAdapterInstalled(a.id)) continue
    out[a.kind] = sdAdapterDir(a.kind)
  }
  // A CURATED SPEED PACK IS A LORA ON DISK TOO. It is not in the user adapter
  // registry (see SD_SPEED_ADAPTERS for why it cannot be), so without this line
  // a machine whose ONLY loras are speed packs would get no
  // `--lora-model-dir` — and buildSdVideoArgs, honouring both-halves-or-
  // neither, would then drop the whole preset and silently render the slow way.
  if (!out.lora && SD_SPEED_ADAPTERS.some(p => isSpeedAdapterInstalled(p.id))) {
    out.lora = sdAdapterDir('lora')
  }
  return out
}

/**
 * Every LoRA a `<lora:…>` tag in the prompt could legitimately name.
 *
 * TWO SOURCES, because the engine's authority and ours differ:
 *  1. the REGISTRY — display name + our hash-derived slug, so a tag naming the
 *     original Civitai title can be pointed at the file we actually wrote
 *     (resolveTypedLoraTags);
 *  2. the FILE STEMS REALLY IN THE DIRECTORY, which is what sd.cpp itself
 *     matches on. A user who dropped `sparkle_v2.safetensors` in by hand has no
 *     registry row, and their own correct tag must not be treated as a typo and
 *     stripped. That is also how the curated speed packs are seen: they are
 *     deliberately not registry rows.
 *
 * The stems come from `sdAdapterDir('lora')` — THE SAME single directory that
 * goes out as `--lora-model-dir`, and therefore the only one the engine can
 * resolve a tag in. A stray file in the other storage root is invisible to the
 * engine, so treating it as resolvable here would be the app disagreeing with
 * the command line it just wrote.
 */
export function installedLoraNames(): Array<{ name: string; slug: string }> {
  const out: Array<{ name: string; slug: string }> = []
  const seen = new Set<string>()
  const push = (name: string, slug: string) => {
    const key = slug.toLowerCase()
    if (!slug || seen.has(key)) return
    seen.add(key)
    out.push({ name, slug })
  }
  for (const a of allSdAdapters()) {
    if (a.kind !== 'lora' || !isSdAdapterInstalled(a.id)) continue
    push(a.name, a.slug)
  }
  const dir = sdAdapterDir('lora')
  try {
    for (const f of readdirSync(dir)) {
      const stem = f.replace(/\.(safetensors|gguf|ckpt|pt)$/i, '')
      if (stem === f) continue   // not a weights file
      push(stem, stem)
    }
  } catch { /* no lora directory yet — the registry half still stands */ }
  return out
}

/** Absolute path of an installed adapter by id (the client's `--vae` swap). */
export function installedAdapterPath(id: string): string | null {
  const a = findSdAdapter(id)
  if (!a) return null
  const p = adapterFilePath(a)
  return p !== null && existsSync(p) ? p : null
}

/** Remove one adapter's weights from BOTH roots (the registry row is separate). */
export function removeSdAdapterFile(id: string): { ok: boolean; error?: string } {
  const a = findSdAdapter(id)
  if (!a) return { ok: false, error: `Unknown adapter id: ${id}` }
  const ext = fileExtFor(a.file, 'model')
  if (!ext) return { ok: false, error: `Adapter "${id}" has no placeable file.` }
  return removeResolved('sd', SD_ADAPTER_DIR[a.kind], `${a.slug}${ext}`)
}

/**
 * Download one adapter's single file. Deliberately the SAME managed path a
 * checkpoint component takes (resume across restarts, SHA verification, disk
 * preflight, the DownloadStrip, the gated-host credential rule) — an adapter is
 * 20 MB–400 MB, not a special case. The managed id reuses the `sd:<id>:` shape
 * so the existing Stop sweep covers it with no new code.
 */
export function downloadSdAdapter(
  win: BrowserWindow | null,
  id: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<void> {
  if (isSdAdapterInstalled(id)) { push(win, { stage: 'done', message: `Already on disk: ${id}`, percent: 100 }); return Promise.resolve() }
  const existing = activeModelDownloads.get(id)
  if (existing) return existing
  const p = withInstallLock(`sd-cpp-adapter-${id}`, () => _doDownloadAdapter(win, id, opts.headers))
    .finally(() => activeModelDownloads.delete(id))
  activeModelDownloads.set(id, p)
  return p
}

async function _doDownloadAdapter(win: BrowserWindow | null, id: string, headers?: Record<string, string>): Promise<void> {
  const a = findSdAdapter(id)
  if (!a) { const err = `Unknown sd.cpp adapter id: ${id}`; push(win, { stage: 'error', message: err, percent: 0 }); throw new Error(err) }
  const dest = adapterFilePath(a)
  if (!dest) {
    const msg = `Refusing to install "${a.name}" — ${a.file.format ?? a.file.fileName ?? 'this file'} is not a weights container this engine loads (pickle formats execute code on load).`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }
  mkdirSync(sdAdapterDir(a.kind), { recursive: true })
  if (existsSync(dest)) { push(win, { stage: 'done', message: `Already on disk: ${a.name}`, percent: 100 }); return }
  if (isShaPlaceholder(a.file.sha256) && app.isPackaged) {
    const msg = `Refusing to install "${a.name}" — its SHA256 is a placeholder and this is a packaged build.`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }
  const tmp = partPathFor(dest)
  const tracker = new DownloadProgressTracker([{ id: a.kind, totalBytes: Math.round(a.file.sizeMb * 1_048_576) }])
  const managedId = sdManagedId(id, a.kind)
  try {
    await runManagedDownload({
      id:       managedId,
      name:     `${a.name} — ${a.kind}`,
      kind:     'sd-model',
      url:      a.file.url,
      destPath: dest,
      partPath: tmp,
      expectedSha256:   isShaPlaceholder(a.file.sha256) ? undefined : a.file.sha256,
      approxTotalBytes: Math.round(a.file.sizeMb * 1_048_576),
      ...(headers ? { headers } : {}),
    }, s => {
      if (s.state === 'active') {
        tracker.tick(a.kind, s.receivedBytes, s.totalBytes > 0 ? s.totalBytes : undefined)
        const agg = tracker.snapshot()
        push(win, {
          stage: 'downloading-model', message: `${a.name}`,
          percent: agg.percent, bytes: agg.receivedBytes, totalBytes: agg.totalBytes,
          speedBytesPerSec: agg.speedBytesPerSec, etaSec: agg.etaSec,
        })
      } else if (s.state === 'verifying') {
        push(win, { stage: 'verifying', message: `Verifying ${a.name}…`, percent: -1 })
      }
    })
  } catch (err) {
    if (!shouldFallBackToLegacyDownload(err)) {
      const msg = err instanceof Error ? err.message : String(err)
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    try {
      await legacyDownloadComponent(
        win, { name: a.name }, id,
        { role: a.kind, url: a.file.url, sha256: a.file.sha256, sizeMb: a.file.sizeMb },
        dest, tmp, tracker, 0, a.file.sizeMb || 1, managedId, headers,
      )
    } catch (legacyErr) {
      settleExternalDownload(managedId, legacyErr)
      throw legacyErr
    }
    settleExternalDownload(managedId)
  }
  push(win, { stage: 'done', message: `Ready: ${a.name}`, percent: 100 })
}

// ── CURATED SPEED PACKS: the 4-step distill LoRAs ────────────────────────────
//
// Same bytes-on-disk shape as a user adapter and the same directory (one
// `--lora-model-dir` has to resolve both), but a CURATED registry rather than
// the user one — see SD_SPEED_ADAPTERS for why a Wan LoRA cannot be spelled as
// an SdAdapter. What differs mechanically is only that a pack is SEVERAL files
// that are worthless apart: a two-expert row with one of its two LoRAs applied
// renders at 4 steps with half the model un-adapted, which is exactly the
// "distilled output looks broken" misdiagnosis. So `installed` means ALL files.

/** Absolute path for one speed-pack file, or null for a container we refuse. */
export function speedAdapterFilePath(f: Pick<SdSpeedAdapterFile, 'slug' | 'role' | 'url' | 'sha256' | 'sizeMb' | 'fileName' | 'format'>): string | null {
  const ext = fileExtFor(f, 'model')
  if (!ext) return null
  return join(sdAdapterDir('lora'), `${f.slug}${ext}`)
}

/** True only when EVERY file of the pack is on disk (see the note above). */
export function isSpeedAdapterInstalled(id: string): boolean {
  const a = findSpeedAdapter(id)
  if (!a) return false
  return a.files.every(f => {
    const p = speedAdapterFilePath(f)
    return p !== null && existsSync(p)
  })
}

/**
 * This model's speed pack IF it is fully installed — the one lookup
 * sd-cpp-client's env resolver makes. Undefined covers every honest "no": no
 * pack for this row, or a pack that is not (yet) on disk.
 */
export function installedSpeedAdapter(modelId: string): SdSpeedAdapter | undefined {
  const a = speedAdapterForModel(modelId)
  return a && isSpeedAdapterInstalled(a.id) ? a : undefined
}

/** Every curated speed pack with its install state — for the catalog / composer. */
export function listSpeedAdapters(): Array<{
  id: string; modelId: string; name: string; license: string; source: string
  sizeMbTotal: number; installed: boolean; notes: string
}> {
  return SD_SPEED_ADAPTERS.map(a => ({
    id: a.id, modelId: a.modelId, name: a.name, license: a.license, source: a.source,
    sizeMbTotal: a.files.reduce((s, f) => s + f.sizeMb, 0),
    installed:   isSpeedAdapterInstalled(a.id),
    notes:       a.notes,
  }))
}

/**
 * Download one speed pack's files. Deliberately the SAME managed path a
 * checkpoint component takes (resume across restarts, SHA verification, disk
 * preflight, the DownloadStrip), and the same `sd:<id>:` managed-id shape so
 * the existing Stop sweep covers it with no new code.
 *
 * A file that is ALREADY THERE is skipped rather than re-fetched: the 2.1 pack
 * and the A14B pack share one byte-identical 706 MB LoRA under one slug, so
 * taking the second pack after the first costs only what is new.
 */
export function downloadSdSpeedAdapter(win: BrowserWindow | null, id: string): Promise<void> {
  if (isSpeedAdapterInstalled(id)) { push(win, { stage: 'done', message: `Already on disk: ${id}`, percent: 100 }); return Promise.resolve() }
  const existing = activeModelDownloads.get(id)
  if (existing) return existing
  const p = withInstallLock(`sd-cpp-speed-${id}`, () => _doDownloadSpeedAdapter(win, id))
    .finally(() => activeModelDownloads.delete(id))
  activeModelDownloads.set(id, p)
  return p
}

async function _doDownloadSpeedAdapter(win: BrowserWindow | null, id: string): Promise<void> {
  const a = findSpeedAdapter(id)
  if (!a) { const err = `Unknown sd.cpp speed pack id: ${id}`; push(win, { stage: 'error', message: err, percent: 0 }); throw new Error(err) }
  mkdirSync(sdAdapterDir('lora'), { recursive: true })
  const tracker = new DownloadProgressTracker(a.files.map(f => ({ id: f.slug, totalBytes: Math.round(f.sizeMb * 1_048_576) })))
  for (const f of a.files) {
    const dest = speedAdapterFilePath(f)
    if (!dest) {
      const msg = `Refusing to install "${a.name}" — ${f.fileName ?? f.url} is not a weights container this engine loads.`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    if (existsSync(dest)) { tracker.tick(f.slug, Math.round(f.sizeMb * 1_048_576)); continue }
    if (isShaPlaceholder(f.sha256) && app.isPackaged) {
      const msg = `Refusing to install "${a.name}" — its SHA256 is a placeholder and this is a packaged build.`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    const tmp = partPathFor(dest)
    const managedId = sdManagedId(id, f.slug)
    try {
      await runManagedDownload({
        id:       managedId,
        name:     `${a.name} — ${f.slug}`,
        kind:     'sd-model',
        url:      f.url,
        destPath: dest,
        partPath: tmp,
        expectedSha256:   isShaPlaceholder(f.sha256) ? undefined : f.sha256,
        approxTotalBytes: Math.round(f.sizeMb * 1_048_576),
      }, s => {
        if (s.state === 'active') {
          tracker.tick(f.slug, s.receivedBytes, s.totalBytes > 0 ? s.totalBytes : undefined)
          const agg = tracker.snapshot()
          push(win, {
            stage: 'downloading-model', message: `${a.name}`,
            percent: agg.percent, bytes: agg.receivedBytes, totalBytes: agg.totalBytes,
            speedBytesPerSec: agg.speedBytesPerSec, etaSec: agg.etaSec,
          })
        } else if (s.state === 'verifying') {
          push(win, { stage: 'verifying', message: `Verifying ${a.name}…`, percent: -1 })
        }
      })
    } catch (err) {
      if (!shouldFallBackToLegacyDownload(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
      }
      try {
        await legacyDownloadComponent(
          // `role: f.slug` and not 'model': legacy ticks the tracker by this
          // string, and THIS tracker is keyed by slug (a pack is several files
          // of one role). A mismatch would leave the strip frozen at 0%.
          win, { name: a.name }, id,
          { role: f.slug, url: f.url, sha256: f.sha256, sizeMb: f.sizeMb },
          dest, tmp, tracker, 0, f.sizeMb || 1, managedId,
        )
      } catch (legacyErr) {
        settleExternalDownload(managedId, legacyErr)
        throw legacyErr
      }
      settleExternalDownload(managedId)
    }
  }
  push(win, { stage: 'done', message: `Ready: ${a.name}`, percent: 100 })
}

// ── THE UPSCALER, ON DISK ────────────────────────────────────────────────────
//
// Its own directory rather than `loras/`, and that is a real difference from the
// speed packs: `--lora-model-dir` takes a DIRECTORY THE ENGINE SCANS by file
// stem, so anything dropped in there is a candidate LoRA the composer may offer.
// `--upscale-model` takes a FILE PATH, so the upscaler has no reason to be in a
// scanned folder — and a 64 MB ESRGAN sitting in `loras/` would show up wherever
// that directory is enumerated, as a LoRA that would silently do nothing.
//
// Storage-root aware (resolveModelDir) like every other weights directory, so a
// user who moved their models folder takes this with them.

export function sdUpscalerDir(): string {
  return resolveModelDir('sd', 'upscalers')
}

/** Absolute path for one upscaler file, or null for a container we refuse. */
export function upscalerFilePath(
  f: Pick<SdUpscalerFile, 'slug' | 'role' | 'url' | 'sha256' | 'sizeMb' | 'fileName' | 'format'>,
): string | null {
  const ext = fileExtFor(f, 'model')
  if (!ext) return null
  return join(sdUpscalerDir(), `${f.slug}${ext}`)
}

/** True only when EVERY file of the row is on disk (one today, by construction). */
export function isUpscalerInstalled(id: string): boolean {
  const u = findUpscaler(id)
  if (!u) return false
  return u.files.every(f => {
    const p = upscalerFilePath(f)
    return p !== null && existsSync(p)
  })
}

/**
 * The path `--upscale-model` should be given for this row, or null when it is
 * not (fully) installed. The ONE lookup the client makes — so "is it installed"
 * and "what path does the argv get" can never disagree.
 *
 * Gated on isUpscalerInstalled rather than on files[0] alone: today every row
 * has exactly one file, and the day one does not, "the first file is here" is
 * not the same claim as "this row can run".
 */
export function installedUpscalerPath(id: string): string | null {
  const u = findUpscaler(id)
  if (!u || !isUpscalerInstalled(id)) return null
  return upscalerFilePath(u.files[0])
}

/** Every curated upscaler with its install state — for the catalog / the button. */
export function listUpscalers(): Array<{
  id: string; name: string; scale: number; license: string; source: string
  licenseName?: string; licenseUrl?: string
  sizeMbTotal: number; installed: boolean; notes: string
}> {
  return SD_UPSCALERS.map(u => ({
    id: u.id, name: u.name, scale: u.scale, license: u.license, source: u.source,
    licenseName: u.licenseName, licenseUrl: u.licenseUrl,
    sizeMbTotal: u.files.reduce((s, f) => s + f.sizeMb, 0),
    installed:   isUpscalerInstalled(u.id),
    notes:       u.notes,
  }))
}

/**
 * Download one upscaler. The SAME managed path a checkpoint component takes
 * (resume across restarts, SHA verification, disk preflight, the DownloadStrip)
 * and the same `sd:<id>:` managed-id shape, so the existing Stop sweep covers it
 * with no new code — the downloadSdSpeedAdapter shape, one file instead of two.
 */
export function downloadSdUpscaler(win: BrowserWindow | null, id: string): Promise<void> {
  if (isUpscalerInstalled(id)) { push(win, { stage: 'done', message: `Already on disk: ${id}`, percent: 100 }); return Promise.resolve() }
  const existing = activeModelDownloads.get(id)
  if (existing) return existing
  const p = withInstallLock(`sd-cpp-upscaler-${id}`, () => _doDownloadUpscaler(win, id))
    .finally(() => activeModelDownloads.delete(id))
  activeModelDownloads.set(id, p)
  return p
}

async function _doDownloadUpscaler(win: BrowserWindow | null, id: string): Promise<void> {
  const u = findUpscaler(id)
  if (!u) { const err = `Unknown sd.cpp upscaler id: ${id}`; push(win, { stage: 'error', message: err, percent: 0 }); throw new Error(err) }
  mkdirSync(sdUpscalerDir(), { recursive: true })
  const tracker = new DownloadProgressTracker(u.files.map(f => ({ id: f.slug, totalBytes: Math.round(f.sizeMb * 1_048_576) })))
  for (const f of u.files) {
    const dest = upscalerFilePath(f)
    if (!dest) {
      // The `.pth` guard, reached as a real error rather than a silent skip: the
      // canonical Real-ESRGAN asset IS a pickle, so a future row that points at
      // one must fail loudly here instead of downloading to nowhere.
      const msg = `Refusing to install "${u.name}" — ${f.fileName ?? f.url} is not a weights container this engine loads.`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    if (existsSync(dest)) { tracker.tick(f.slug, Math.round(f.sizeMb * 1_048_576)); continue }
    if (isShaPlaceholder(f.sha256) && app.isPackaged) {
      const msg = `Refusing to install "${u.name}" — its SHA256 is a placeholder and this is a packaged build.`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    const tmp = partPathFor(dest)
    const managedId = sdManagedId(id, f.slug)
    try {
      await runManagedDownload({
        id:       managedId,
        name:     `${u.name} — ${f.slug}`,
        kind:     'sd-model',
        url:      f.url,
        destPath: dest,
        partPath: tmp,
        expectedSha256:   isShaPlaceholder(f.sha256) ? undefined : f.sha256,
        approxTotalBytes: Math.round(f.sizeMb * 1_048_576),
      }, s => {
        if (s.state === 'active') {
          tracker.tick(f.slug, s.receivedBytes, s.totalBytes > 0 ? s.totalBytes : undefined)
          const agg = tracker.snapshot()
          push(win, {
            stage: 'downloading-model', message: `${u.name}`,
            percent: agg.percent, bytes: agg.receivedBytes, totalBytes: agg.totalBytes,
            speedBytesPerSec: agg.speedBytesPerSec, etaSec: agg.etaSec,
          })
        } else if (s.state === 'verifying') {
          push(win, { stage: 'verifying', message: `Verifying ${u.name}…`, percent: -1 })
        }
      })
    } catch (err) {
      if (!shouldFallBackToLegacyDownload(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
      }
      try {
        // `role: f.slug` — the tracker is keyed by slug. See the speed-pack note.
        await legacyDownloadComponent(
          win, { name: u.name }, id,
          { role: f.slug, url: f.url, sha256: f.sha256, sizeMb: f.sizeMb },
          dest, tmp, tracker, 0, f.sizeMb || 1, managedId,
        )
      } catch (legacyErr) {
        settleExternalDownload(managedId, legacyErr)
        throw legacyErr
      }
      settleExternalDownload(managedId)
    }
  }
  push(win, { stage: 'done', message: `Ready: ${u.name}`, percent: 100 })
}

// ── IP-ADAPTER: the reference-image weights ──────────────────────────────────
//
// Its own directory, for the reason the upscaler has one: `--ip-adapter` and
// `--clip_vision` take FILE PATHS, so there is nothing to scan and nothing that
// should turn up wherever a scanned folder is enumerated.
//
// The ENCODER is the interesting part. Both rows declare the same 1,206 MiB
// `clip_vision_h.safetensors` the Wan 2.1 i2v row already pins, byte for byte,
// so the download loop asks findReusableComponent first and hard-links the copy
// that is already on disk. That is not a new mechanism: it is the one Z-Image
// uses to skip FLUX's autoencoder, pointed at a row that is not a checkpoint.

export function sdIpAdapterDir(): string {
  return resolveModelDir('sd', 'ipadapters')
}

/** Absolute path for one IP-Adapter file, or null for a container we refuse. */
export function ipAdapterFilePath(
  f: Pick<SdIpAdapterFile, 'slug' | 'role' | 'url' | 'sha256' | 'sizeMb' | 'fileName' | 'format'>,
): string | null {
  const ext = fileExtFor(f, 'model')
  if (!ext) return null
  return join(sdIpAdapterDir(), `${f.slug}${ext}`)
}

/** True only when EVERY file of the row is on disk — the adapter AND its encoder. */
export function isIpAdapterInstalled(id: string): boolean {
  const a = findIpAdapter(id)
  if (!a) return false
  return a.files.every(f => {
    const p = ipAdapterFilePath(f)
    return p !== null && existsSync(p)
  })
}

/**
 * The two paths the argv needs, or null when this row is not (fully) installed.
 *
 * BOTH OR NEITHER, in one lookup, because the engine says so: `--ip-adapter`'s
 * own help reads "requires --clip_vision". Returning the adapter alone would let
 * a half-installed row produce a command line the engine rejects — and returning
 * them from two functions would let one of them be forgotten at the call site.
 */
export function installedIpAdapterPaths(id: string): { adapter: string; clipVision: string } | null {
  const a = findIpAdapter(id)
  if (!a || !isIpAdapterInstalled(id)) return null
  const model = a.files.find(f => f.role === 'model')
  const clip  = a.files.find(f => f.role === 'clip_vision')
  if (!model || !clip) return null
  const adapter    = ipAdapterFilePath(model)
  const clipVision = ipAdapterFilePath(clip)
  if (!adapter || !clipVision) return null
  return { adapter, clipVision }
}

/**
 * The INSTALLED IP-Adapter for a checkpoint family, or null.
 *
 * The one lookup both the schema gate and the arg builder make, so "is the
 * control offered" and "does the argv carry the flags" can never disagree.
 */
export function installedIpAdapterForFamily(family: string, modelId?: string): { id: string; adapter: string; clipVision: string } | null {
  const row = ipAdapterForFamily(family, modelId)
  if (!row) return null
  const paths = installedIpAdapterPaths(row.id)
  return paths ? { id: row.id, ...paths } : null
}

/** Every curated IP-Adapter with its install state — for the catalog / the button. */
export function listIpAdapters(): Array<{
  id: string; name: string; family: string; license: string; source: string
  licenseName?: string; licenseUrl?: string
  sizeMbTotal: number; installed: boolean; notes: string
  files: ReturnType<typeof ipAdapterCatalogFiles>
}> {
  return SD_IP_ADAPTERS.map(a => ({
    id: a.id, name: a.name, family: a.family, license: a.license, source: a.source,
    licenseName: a.licenseName, licenseUrl: a.licenseUrl,
    sizeMbTotal: a.files.reduce((s, f) => s + f.sizeMb, 0),
    installed:   isIpAdapterInstalled(a.id),
    notes:       a.notes,
    files:       ipAdapterCatalogFiles(a),
  }))
}

/**
 * Download one IP-Adapter row. The downloadSdUpscaler shape, plus the reuse the
 * 1.2 GB encoder makes worth having.
 */
export function downloadSdIpAdapter(win: BrowserWindow | null, id: string): Promise<void> {
  if (isIpAdapterInstalled(id)) { push(win, { stage: 'done', message: `Already on disk: ${id}`, percent: 100 }); return Promise.resolve() }
  const existing = activeModelDownloads.get(id)
  if (existing) return existing
  const p = withInstallLock(`sd-cpp-ipadapter-${id}`, () => _doDownloadIpAdapter(win, id))
    .finally(() => activeModelDownloads.delete(id))
  activeModelDownloads.set(id, p)
  return p
}

async function _doDownloadIpAdapter(win: BrowserWindow | null, id: string): Promise<void> {
  const a = findIpAdapter(id)
  if (!a) { const err = `Unknown sd.cpp IP-Adapter id: ${id}`; push(win, { stage: 'error', message: err, percent: 0 }); throw new Error(err) }
  mkdirSync(sdIpAdapterDir(), { recursive: true })
  const tracker = new DownloadProgressTracker(a.files.map(f => ({ id: f.slug, totalBytes: Math.round(f.sizeMb * 1_048_576) })))
  for (const f of a.files) {
    const dest = ipAdapterFilePath(f)
    if (!dest) {
      const msg = `Refusing to install "${a.name}" — ${f.fileName ?? f.url} is not a weights container this engine loads.`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    if (existsSync(dest)) { tracker.tick(f.slug, Math.round(f.sizeMb * 1_048_576)); continue }
    // THE BYTES MAY ALREADY BE HERE under a model that shares them (the Wan i2v
    // encoder). Re-hashed before it is placed, like every other reuse.
    const twin = await findReusableComponent(f, id)
    if (twin) {
      const how = placeReusedComponent(twin, dest, partPathFor(dest))
      tracker.tick(f.slug, Math.round(f.sizeMb * 1_048_576))
      push(win, {
        stage: 'downloading-model',
        message: `${a.name} — reused ${f.slug} already on disk (${how === 'link' ? 'linked' : 'copied'})`,
        percent: tracker.snapshot().percent,
      })
      continue
    }
    if (isShaPlaceholder(f.sha256) && app.isPackaged) {
      const msg = `Refusing to install "${a.name}" — its SHA256 is a placeholder and this is a packaged build.`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    const tmp = partPathFor(dest)
    const managedId = sdManagedId(id, f.slug)
    try {
      await runManagedDownload({
        id:       managedId,
        name:     `${a.name} — ${f.slug}`,
        kind:     'sd-model',
        url:      f.url,
        destPath: dest,
        partPath: tmp,
        expectedSha256:   isShaPlaceholder(f.sha256) ? undefined : f.sha256,
        approxTotalBytes: Math.round(f.sizeMb * 1_048_576),
      }, s => {
        if (s.state === 'active') {
          tracker.tick(f.slug, s.receivedBytes, s.totalBytes > 0 ? s.totalBytes : undefined)
          const agg = tracker.snapshot()
          push(win, {
            stage: 'downloading-model', message: `${a.name}`,
            percent: agg.percent, bytes: agg.receivedBytes, totalBytes: agg.totalBytes,
            speedBytesPerSec: agg.speedBytesPerSec, etaSec: agg.etaSec,
          })
        } else if (s.state === 'verifying') {
          push(win, { stage: 'verifying', message: `Verifying ${a.name}…`, percent: -1 })
        }
      })
    } catch (err) {
      if (!shouldFallBackToLegacyDownload(err)) {
        const msg = err instanceof Error ? err.message : String(err)
        push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
      }
      try {
        await legacyDownloadComponent(
          win, { name: a.name }, id,
          { role: f.slug, url: f.url, sha256: f.sha256, sizeMb: f.sizeMb },
          dest, tmp, tracker, 0, f.sizeMb || 1, managedId,
        )
      } catch (legacyErr) {
        settleExternalDownload(managedId, legacyErr)
        throw legacyErr
      }
      settleExternalDownload(managedId)
    }
  }
  push(win, { stage: 'done', message: `Ready: ${a.name}`, percent: 100 })
}

// ── TAE: the decoder swap that survives a 49-frame render (research §2 lever 3)
//
// `--tae` (alias `--taesd`) replaces the VAE DECODE with a 22.6 MB Tiny
// AutoEncoder. Upstream issue #872 measured a 19.3 GB compute buffer for a
// 33-frame Wan decode; that peak — not the model weights — is what killed this
// repo's own 49-frame render on a 12 GB card. Nothing in the curated registry
// ships one yet, so this is deliberately DISK-DRIVEN rather than registry-
// driven: a `tae.safetensors` (or a `taew2_1.safetensors` etc) dropped into the
// model's own folder is honoured on the next render, and no file means the flag
// is simply not passed. Zero risk: absent ⇒ unchanged behaviour.

const TAE_EXTS = ['.safetensors', '.gguf', '.sft']

/**
 * A TAE decoder for this model, or null. Two sources, in order: the model's own
 * `tae` component (a registry row that declares one), then any file in the
 * model's directory whose name starts with "tae" — the upstream naming for
 * every published one (`taesd`, `taesdxl`, `taef1`, `taew2_1`, `taew2_2`).
 */
export function findTaeFile(modelId: string): string | null {
  const paths = modelComponentPaths(modelId)
  if (paths?.tae && existsSync(paths.tae)) return paths.tae
  const dir = resolveModelDir('sd', modelId)
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return null }
  for (const name of entries.sort()) {
    const lower = name.toLowerCase()
    if (!lower.startsWith('tae')) continue
    if (!TAE_EXTS.some(e => lower.endsWith(e))) continue
    const p = join(dir, name)
    try { if (statSync(p).isFile()) return p } catch { /* */ }
  }
  return null
}

/**
 * Download a model's components.
 *
 * `opts.headers` carries a credential for a GATED weights host (Civitai's
 * `Authorization: Bearer …`). It is passed PER CALL and never stored: the
 * registry file is plaintext under userData while the key's home is the
 * DPAPI-encrypted keychain, so the caller re-attaches a fresh header each time
 * (the same rule ManagedDownloadSpec.headers states, and the same reason
 * user-sd-models' add() strips it). installer-kit drops these on every
 * cross-origin redirect hop — the presigned CDN URL signs `host` only, so
 * forwarding the header there is both a 400 and a key leak.
 */
export function downloadSdModel(
  win: BrowserWindow | null,
  id: string,
  opts: { headers?: Record<string, string> } = {},
): Promise<void> {
  if (isSdModelInstalled(id)) { push(win, { stage: 'done', message: `Model already on disk: ${id}`, percent: 100 }); return Promise.resolve() }
  const existing = activeModelDownloads.get(id)
  if (existing) return existing
  // withInstallLock provides cross-process lockfile dedup for this model id.
  const p = withInstallLock(`sd-cpp-model-${id}`, () => _doDownloadModel(win, id, opts.headers))
    .finally(() => activeModelDownloads.delete(id))
  activeModelDownloads.set(id, p)
  return p
}

/**
 * "Stop" an in-flight sd.cpp model download. Like llama.cpp's cancelDownload
 * this maps to the manager's PAUSE — every `.part` is KEPT and the DOWNLOADS
 * strip (or a Catalog re-click) resumes from the byte offset on disk. A model
 * is a SET of component files, so every `sd:<id>:*` task is paused.
 *
 * Returns false when nothing was pausable: no active component, or a component
 * that the legacy fallback is driving (the manager holds no abort handle for
 * an externally-owned transfer — see adoptExternalProgress).
 */
export function cancelSdModelDownload(id: string): boolean {
  const prefix = sdManagedIdPrefix(id)
  let paused = false
  for (const d of listDownloads()) {
    if (!d.id.startsWith(prefix)) continue
    if (pauseManagedDownload(d.id)) paused = true
  }
  return paused
}

/**
 * LEGACY direct download for one component file (resumableDownload + SHA +
 * rename). This was the only path before the central download-manager took
 * over model files; it is kept as the fallback when the manager fails
 * unexpectedly, so an install never breaks on a manager bug.
 *
 * It writes to the SAME .part the manager's task owns, so it must ADOPT that
 * task (`managedId`) — otherwise the queue row sits frozen at 'error' while
 * the file on disk grows, which is exactly what the IO lamp and the
 * DownloadStrip then misreport.
 */
async function legacyDownloadComponent(
  win: BrowserWindow | null,
  model: { name: string },
  id: string,
  f: { role: string; url: string; sha256: string; sizeMb: number },
  dest: string,
  tmp: string,
  tracker: DownloadProgressTracker,
  doneMb: number,
  totalMb: number,
  managedId: string,
  headers?: Record<string, string>,
): Promise<void> {
  try {
    // The credential has to survive the fallback too, or a gated model that
    // trips a manager bug fails with a 401 that looks like a dead link.
    // installer-kit applies these ONLY while the request origin still matches
    // the original url's (same-origin guard) — the presigned CDN hop gets none.
    await resumableDownload(f.url, tmp, (bytes, total) => {
      adoptExternalProgress(managedId, bytes, total)
      tracker.tick(f.role, bytes, total)
      const snap = tracker.snapshot()
      // Defensive fallback to the sizeMb-weighted estimate if the tracker
      // ever reports an unknown total.
      const fallback = Math.round(((doneMb + f.sizeMb * (total > 0 ? bytes / total : 0)) / totalMb) * 100)
      push(win, {
        stage: 'downloading-model', message: `${model.name}: ${f.role}`,
        percent: snap.percent >= 0 ? snap.percent : fallback,
        bytes: snap.receivedBytes, totalBytes: snap.totalBytes,
        speedBytesPerSec: snap.speedBytesPerSec, etaSec: snap.etaSec,
      })
    }, 6, undefined, headers ? { headers } : undefined)
  } catch (err) {
    const msg = `Download failed (${f.role}): ${err instanceof Error ? err.message : String(err)} — partial kept, click Download to resume.`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }
  // SHA-verify (skip on placeholder).
  const actual = await sha256File(tmp)
  if (isShaPlaceholder(f.sha256)) {
    // Fail CLOSED in a packaged build (audit C2). The only placeholders left
    // are gated models (FLUX vae, Wan) that an anonymous installer can't
    // download anyway — refusing them with a clear message is correct.
    if (app.isPackaged) {
      try { rmSync(tmp, { force: true }) } catch { /* */ }
      const msg = `Refusing to install model "${id}/${f.role}" — its registry SHA256 is a placeholder and this is a packaged build (this model may be gated). Observed ${actual}; pin it in sd-cpp-models.ts.`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    console.warn(`[sd-cpp] model "${id}/${f.role}" SHA256 SKIPPED (placeholder). Observed: ${actual}.`)
  } else if (actual.toLowerCase() !== f.sha256.toLowerCase()) {
    try { rmSync(tmp, { force: true }) } catch { /* */ }
    const msg = `SHA256 mismatch for ${id}/${f.role}: expected ${f.sha256}, got ${actual}.`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }
  try { renameSync(tmp, dest) } catch (err) {
    const msg = `Could not place ${f.role}: ${err instanceof Error ? err.message : String(err)}`
    push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
  }
}

async function _doDownloadModel(win: BrowserWindow | null, id: string, headers?: Record<string, string>): Promise<void> {
  const model = findSdModel(id)
  if (!model) { const err = `Unknown sd.cpp model id: ${id}`; push(win, { stage: 'error', message: err, percent: 0 }); throw new Error(err) }
  if (!headers && model.requiresKey) {
    // The registry remembers that this host wanted an Authorization header; the
    // header itself lives in the keychain and is passed per call. Without it a
    // gated file answers 401, which otherwise reads like a dead link.
    console.warn(`[sd-cpp] model "${id}" was registered from a host that required a key, but this download carries no credential — a gated file will answer 401.`)
  }
  // LANE U: the SAME resolver modelComponentPaths reads through — the storage
  // root for a new model, the root that already holds this id otherwise. Was
  // `join(sdModelsDir(), id)`, which hardcoded legacy userData and so wrote a
  // missing component of an ALREADY-RELOCATED model back onto the C: drive.
  const dir = resolveModelDir('sd', id)
  mkdirSync(dir, { recursive: true })
  const totalMb = model.files.reduce((a, f) => a + f.sizeMb, 0) || 1
  // Aggregate tracker across all component files (real bytes + speed + ETA).
  // Totals are pre-seeded from the registry sizeMb so the combined percent is
  // valid from the first tick (no "any-file-unknown -> -1" gap), and corrected
  // upward if a real Content-Length exceeds the estimate.
  const tracker = trackerFromSdFiles(model.files)
  let doneMb = 0
  for (const f of model.files) {
    const ext = fileExtFor(f, f.role)
    if (!ext) {
      // Refused container (pickle / diffusers). Never fetched, never written.
      const msg = `Refusing to install model "${id}/${f.role}" — ${f.format ?? f.fileName ?? 'this file'} is not a weights container this engine loads (pickle formats execute code on load).`
      push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
    }
    const dest = join(dir, `${f.role}${ext}`)
    const tmp = partPathFor(dest) // same dir as the final file (LANE U)
    // THE BYTES MAY ALREADY BE ON THIS DISK, under another model. Z-Image's
    // autoencoder is FLUX.1's; the Wan i2v row's vae + umt5 are the 2.1 row's.
    // Asked BEFORE the fetch, or it saves nothing (see findReusableComponent).
    if (!existsSync(dest)) {
      let twin: string | null = null
      try { twin = await findReusableComponent(f, id) } catch { twin = null }
      if (twin) {
        push(win, { stage: 'verifying', message: `${model.name}: reusing ${f.role} already on disk…`, percent: -1 })
        try {
          const how = placeReusedComponent(twin, dest, tmp)
          console.info(`[sd-cpp] "${id}/${f.role}" reused from ${twin} (${how}) — ${f.sizeMb} MiB not downloaded.`)
        } catch (err) {
          // Never fatal: a failed link/copy just means we download it after all.
          console.warn(`[sd-cpp] could not reuse ${twin} for "${id}/${f.role}" — downloading instead:`, err instanceof Error ? err.message : err)
          try { rmSync(tmp, { force: true }) } catch { /* */ }
        }
      }
    }
    if (!existsSync(dest)) {
      // Fail CLOSED before burning bandwidth (audit C2): a packaged build never
      // downloads a component whose registry SHA is still a placeholder.
      if (isShaPlaceholder(f.sha256) && app.isPackaged) {
        const msg = `Refusing to install model "${id}/${f.role}" — its registry SHA256 is a placeholder and this is a packaged build (this model may be gated). Pin it in sd-cpp-models.ts.`
        push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
      }
      // Model files route through the central download-manager: resume across
      // drops/restarts, pause/cancel from the DownloadStrip, disk preflight,
      // integrity. The legacy sd-cpp:install-progress channel is preserved via
      // the snapshot callback so the Catalog UI keeps working unchanged.
      const managedId = sdManagedId(id, f.role)
      try {
        const snap = await runManagedDownload({
          id:       managedId,
          name:     `${model.name} — ${f.role}`,
          kind:     'sd-model',
          url:      f.url,
          destPath: dest,
          partPath: tmp,
          expectedSha256:   isShaPlaceholder(f.sha256) ? undefined : f.sha256,
          approxTotalBytes: Math.round(f.sizeMb * 1_048_576),
          // Gated host credential — origin-scoped and never persisted (see
          // downloadSdModel's doc + ManagedDownloadSpec.headers).
          ...(headers ? { headers } : {}),
        }, s => {
          if (s.state === 'active') {
            tracker.tick(f.role, s.receivedBytes, s.totalBytes > 0 ? s.totalBytes : undefined)
            const agg = tracker.snapshot()
            const filePct = s.totalBytes > 0 ? s.receivedBytes / s.totalBytes : 0
            const fallback = Math.round(((doneMb + f.sizeMb * filePct) / totalMb) * 100)
            push(win, {
              stage: 'downloading-model', message: `${model.name}: ${f.role}`,
              percent: agg.percent >= 0 ? agg.percent : fallback,
              bytes: agg.receivedBytes, totalBytes: agg.totalBytes,
              speedBytesPerSec: agg.speedBytesPerSec, etaSec: agg.etaSec,
            })
          } else if (s.state === 'verifying') {
            push(win, { stage: 'verifying', message: `Verifying ${f.role}…`, percent: -1 })
          }
        })
        if (isShaPlaceholder(f.sha256)) {
          console.warn(`[sd-cpp] model "${id}/${f.role}" SHA256 SKIPPED (placeholder). Observed: ${snap.observedSha256 ?? 'n/a'}.`)
        }
      } catch (err) {
        if (!shouldFallBackToLegacyDownload(err)) {
          // Deliberate outcome (pause/cancel/disk/integrity) — surface as-is.
          const msg = err instanceof Error ? err.message : String(err)
          push(win, { stage: 'error', message: msg, percent: 0 }); throw new Error(msg)
        }
        // Manager failed unexpectedly (network drop after retries, or a manager
        // bug) — the proven legacy path must still complete the install. The
        // queue row is handed over rather than abandoned: adopt on every chunk,
        // settle once (drop the row on success, honest error otherwise).
        console.warn(`[sd-cpp] managed download failed for ${id}/${f.role} — falling back to direct download:`, err instanceof Error ? err.message : err)
        try {
          await legacyDownloadComponent(win, model, id, f, dest, tmp, tracker, doneMb, totalMb, managedId, headers)
        } catch (legacyErr) {
          settleExternalDownload(managedId, legacyErr)
          throw legacyErr
        }
        settleExternalDownload(managedId) // legacy landed the file; the row is done talking
      }
      // Pin this file to its real on-disk size so the aggregate stays accurate.
      try { const sz = statSync(dest).size; tracker.tick(f.role, sz, sz) } catch { /* */ }
    } else {
      // Already on disk (resumed / prior partial install) — count it toward the
      // aggregate so the combined percent and ETA reflect reality.
      try { const sz = statSync(dest).size; tracker.tick(f.role, sz, sz) } catch { /* */ }
    }
    doneMb += f.sizeMb
  }
  push(win, { stage: 'done', message: `Model ready: ${model.name}`, percent: 100 })
}
