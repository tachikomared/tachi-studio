// apps/desktop/electron/services/llama-cpp-installer.ts
//
// llama.cpp sidecar — binary release downloader + GGUF model downloader.
//
// Architecture:
//   ${userData}/llama-cpp/
//     ├── bin/
//     │     └── llama-server[.exe]      (extracted from release zip)
//     │     └── <other dlls/libs>
//     ├── models/
//     │     └── <gguf-id>.gguf          (LEGACY weights — pre-LANE-U downloads)
//     └── downloads/                    (transient .tmp for the BINARY zips only)
//
// WEIGHTS (LANE U): a NEW GGUF download targets `<storage root>/Models/llama/`
// — resolveModelPath decides, and its `.part` sits in the same directory (the
// landing rename cannot cross devices). Weights already in `models/` keep
// resolving there until the user relocates them from the Settings dashboard.
//
// Both download paths share the same primitives:
//   1. https.get streaming to *.tmp / *.part
//   2. SHA256 verification (skipped only if registry entry has placeholder SHA)
//   3. Atomic rename to final path
//
// Extraction (release zips only):
//   - Windows: `powershell -Command "Expand-Archive ..."`
//   - macOS:   `unzip -q ...`
//   - If the shell tool isn't available, returns a clear error.
//
// SHA verification is the Vitalik-aligned promise: a poisoned mirror cannot
// silently swap in a backdoored binary. When the registry SHA is the literal
// placeholder string we log a STERN warning and proceed — this is only for
// the v1 ship where placeholder SHAs let us land the code before doing the
// hash-collection chore. Real users hit real SHAs once those are pasted in.

import { existsSync, mkdirSync, createWriteStream, renameSync, statSync, readdirSync, copyFileSync, rmSync } from 'fs'
import { join, dirname, basename } from 'path'
import { app, type BrowserWindow } from 'electron'
import { get as httpsGet, request as httpsRequest } from 'https'
import { URL } from 'url'
import { sha256File, extractArchive } from './util/installer-kit'
import {
  runManagedDownload,
  pauseManagedDownload,
  resolveHfExpected,
  type DownloadItemSnapshot,
} from './download-manager'
import {
  defaultReleaseAsset,
  getReleaseAsset,
  getGgufModel,
  isShaPlaceholder,
  LLAMA_CPP_VERSION,
  type LlamaCppReleaseAsset,
  type GgufModel,
} from './llama-cpp-models'
import { resolveModelPath, listEngineItemIds, removeResolved, partPathFor } from './model-storage'

// ─── Paths ────────────────────────────────────────────────────────────────────

function llamaCppRoot(): string {
  return join(app.getPath('userData'), 'llama-cpp')
}
export function llamaCppBinDir(): string {
  return join(llamaCppRoot(), 'bin')
}
// NOTE: there is deliberately no `llamaCppModelsDir()` here. It used to return
// `<userData>/llama-cpp/models` and was the second, hardcoded answer to a
// question model-storage.ts already owns — exactly the duplicated fact that put
// 7.7 GB of GGUF on the system drive. Weight paths come from `ggufModelPath()`
// (→ resolveModelPath) and nowhere else; the legacy dir survives only as
// model-storage's `engineLegacyBase('llama')`, i.e. a place to migrate FROM.
function llamaCppDownloadsDir(): string {
  return join(llamaCppRoot(), 'downloads')
}

/** Path to the llama-server binary inside our installed tree. Does NOT check existence. */
export function llamaServerBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  return join(llamaCppBinDir(), exe)
}

/**
 * Path to a GGUF model file by registry id. Dual-root: prefers the relocated
 * `<storage root>/Models/llama/<id>.gguf`, falls back to the legacy userData
 * dir, and — when the file exists in NEITHER — targets the storage root for
 * the NEW download (LANE U; legacy only if that root is unwritable). Does NOT
 * check existence beyond choosing the root.
 */
export function ggufModelPath(modelId: string): string {
  return resolveModelPath('llama', `${modelId}.gguf`)
}

/** True when our extracted llama-server binary exists on disk. */
export function isLlamaCppInstalled(): boolean {
  return existsSync(llamaServerBinaryPath())
}

/** True when a given GGUF model has been downloaded successfully. */
export function isGgufModelDownloaded(modelId: string): boolean {
  return existsSync(ggufModelPath(modelId))
}

/** List all currently-downloaded GGUF model ids across BOTH roots (relocated
 *  storage-root dir + legacy userData dir), de-duplicated. */
export function listDownloadedModels(): string[] {
  return listEngineItemIds('llama')
}

// ─── Progress push ────────────────────────────────────────────────────────────

export type LlamaInstallStage =
  | 'checking'
  | 'downloading-binary'
  | 'extracting'
  | 'downloading-model'
  | 'verifying'
  | 'done'
  | 'error'

export interface LlamaInstallProgressEvent {
  stage:        LlamaInstallStage
  message:      string
  /** 0..100, monotonically increasing within a stage. -1 means indeterminate. */
  percent:      number
  /** Optional: bytes downloaded so far (for the renderer to render a precise bar). */
  bytes?:       number
  /** Optional: total bytes expected. */
  totalBytes?:  number
  /** Instantaneous transfer rate (bytes/sec) from the rolling window; omitted/0 when unknown. */
  speedBytesPerSec?: number
  /** Estimated seconds remaining; omitted/-1 when unknown. */
  etaSec?: number
}

function push(win: BrowserWindow | null, event: LlamaInstallProgressEvent): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('llama-cpp:install-progress', event)
}

// ─── Concurrency guards ──────────────────────────────────────────────────────

let activeBinaryInstall: Promise<void> | null = null
// Model downloads are deduplicated / paused / resumed by the central
// download-manager (services/download-manager.ts) — no local maps needed.

// ─── Download primitive ──────────────────────────────────────────────────────

/**
 * Stream an https URL to `dest`, following redirects up to 10 hops.
 * Resolves only after the file is fully written (writer 'finish').
 *
 * Calls `onChunk(bytesSoFar, totalBytes)` after every received chunk so
 * callers can drive a progress UI. `totalBytes` is 0 when the server
 * doesn't send Content-Length.
 */
function downloadStreaming(
  url: string,
  dest: string,
  onChunk?: (bytes: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Download cancelled')); return }
    let hops = 0
    const go = (currentUrl: string): void => {
      if (++hops > 10) { reject(new Error(`Too many redirects: ${url}`)); return }

      let parsed: URL
      try { parsed = new URL(currentUrl) }
      catch (err) { reject(new Error(`Invalid URL: ${currentUrl}`)); return }
      if (parsed.protocol !== 'https:') {
        reject(new Error(`Only https is allowed (got ${parsed.protocol})`))
        return
      }

      const req = httpsGet({
        host:    parsed.hostname,
        port:    parsed.port || 443,
        path:    parsed.pathname + parsed.search,
        headers: {
          // GitHub releases redirects to objects.githubusercontent.com which
          // expects a UA. HuggingFace too.
          'User-Agent': 'TachiDesk/llama-cpp-installer',
          'Accept':     '*/*',
        },
      }, (res) => {
        // Redirect
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()  // discard body
          const next = new URL(res.headers.location, currentUrl).toString()
          go(next)
          return
        }

        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`))
          return
        }

        const total = parseInt(res.headers['content-length'] ?? '0', 10) || 0
        let received = 0
        let ws: ReturnType<typeof createWriteStream>
        try { ws = createWriteStream(dest) }
        catch (err) { reject(err as Error); return }

        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          onChunk?.(received, total)
        })
        res.pipe(ws)
        ws.on('finish', () => { ws.close(() => resolve()) })
        ws.on('error', reject)
        res.on('error', reject)
      })
      if (signal) {
        if (signal.aborted) { req.destroy(new Error('Download cancelled')); return }
        signal.addEventListener('abort', () => req.destroy(new Error('Download cancelled')), { once: true })
      }
      req.on('error', reject)
      req.end()
    }
    go(url)
  })
}

/**
 * Recursively copy every file with the given extension from `root` into
 * `destDir` (flat). Returns the number copied. Used to lift CUDA runtime
 * DLLs out of the cudart archive (whose internal layout may nest them) into
 * the bin dir next to llama-server.exe.
 */
function collectFilesByExtInto(root: string, destDir: string, ext: string): number {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  const lowerExt = ext.toLowerCase()
  let count = 0
  const walk = (dir: string): void => {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isFile() && name.toLowerCase().endsWith(lowerExt)) {
        try { copyFileSync(p, join(destDir, name)); count++ } catch { /* ignore */ }
      } else if (s.isDirectory()) {
        walk(p)
      }
    }
  }
  walk(root)
  return count
}

// ─── Flatten extracted release tree ──────────────────────────────────────────
//
// llama.cpp release zips usually contain a top-level folder like
//   llama-bXXXX-bin-win-avx2-x64/llama-server.exe + dlls
// We want llama-server[.exe] directly under llamaCppBinDir(). After extracting
// into a staging directory, find llama-server[.exe] anywhere inside and lift
// the WHOLE directory containing it to bin/.

function findBinaryDir(root: string): string | null {
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  let found: string | null = null
  const walk = (dir: string): void => {
    if (found) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      let s
      try { s = statSync(p) } catch { continue }
      if (s.isFile() && name.toLowerCase() === exeName.toLowerCase()) {
        found = dir
        return
      }
      if (s.isDirectory()) walk(p)
    }
  }
  walk(root)
  return found
}

function moveDirContents(srcDir: string, destDir: string): void {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  const entries = readdirSync(srcDir)
  for (const name of entries) {
    const src = join(srcDir, name)
    const dst = join(destDir, name)
    // Best-effort: try rename; if it fails (cross-device or partial overwrite),
    // copy + remove. We don't recurse into subdirs — the release zips put all
    // DLLs / .so files / the binary itself flat in one folder.
    try {
      renameSync(src, dst)
    } catch {
      try { copyFileSync(src, dst) } catch { /* ignore */ }
    }
  }
}

// ─── Public API: install binary ──────────────────────────────────────────────

/**
 * Download + verify + extract the llama.cpp release asset for the user's platform.
 * If `assetId` is omitted, picks the default for the platform.
 *
 * Idempotent: no-op when llama-server is already on disk under llamaCppBinDir().
 * Deduplicates concurrent invocations so a renderer that double-clicks
 * [INSTALL] doesn't trigger two downloads.
 */
export function installLlamaCppBinary(
  win: BrowserWindow | null,
  assetId?: string,
): Promise<void> {
  if (isLlamaCppInstalled()) {
    push(win, { stage: 'done', message: 'llama.cpp already installed', percent: 100 })
    return Promise.resolve()
  }
  if (activeBinaryInstall) return activeBinaryInstall
  activeBinaryInstall = _doInstallBinary(win, assetId).finally(() => {
    activeBinaryInstall = null
  })
  return activeBinaryInstall
}

async function _doInstallBinary(
  win: BrowserWindow | null,
  assetId: string | undefined,
): Promise<void> {
  push(win, { stage: 'checking', message: 'Resolving llama.cpp release asset...', percent: 0 })

  const asset: LlamaCppReleaseAsset | null = assetId
    ? getReleaseAsset(assetId)
    : defaultReleaseAsset()
  if (!asset) {
    const err = `No llama.cpp release asset available for ${process.platform}/${process.arch}.`
    push(win, { stage: 'error', message: err, percent: 0 })
    throw new Error(err)
  }
  if (asset.platform !== process.platform) {
    const err = `Selected asset "${asset.id}" targets ${asset.platform}, not ${process.platform}.`
    push(win, { stage: 'error', message: err, percent: 0 })
    throw new Error(err)
  }

  // Ensure dirs exist
  mkdirSync(llamaCppDownloadsDir(), { recursive: true })
  mkdirSync(llamaCppBinDir(),       { recursive: true })

  const zipTmp   = join(llamaCppDownloadsDir(), `${asset.filename}.tmp`)
  const zipFinal = join(llamaCppDownloadsDir(), asset.filename)

  // ── Download ──
  push(win, {
    stage:   'downloading-binary',
    message: `Downloading ${asset.label} (${LLAMA_CPP_VERSION})`,
    percent: 0,
  })

  try {
    await downloadStreaming(asset.url, zipTmp, (bytes, total) => {
      const pct = total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : -1
      push(win, {
        stage:      'downloading-binary',
        message:    `Downloading ${asset.label}`,
        percent:    pct,
        bytes,
        totalBytes: total,
      })
    })
  } catch (err) {
    try { rmSync(zipTmp, { force: true }) } catch { /* ignore */ }
    const msg = `Download failed: ${err instanceof Error ? err.message : String(err)}`
    push(win, { stage: 'error', message: msg, percent: 0 })
    throw new Error(msg)
  }

  // ── Verify SHA ──
  push(win, { stage: 'verifying', message: 'Verifying SHA256...', percent: -1 })
  const actualSha = await sha256File(zipTmp)
  if (isShaPlaceholder(asset.sha256)) {
    // Fail CLOSED in a packaged build (audit S4): a release must never run an
    // unverified binary. Dev keeps warn-and-allow so SHAs can be observed.
    if (app.isPackaged) {
      try { rmSync(zipTmp, { force: true }) } catch { /* ignore */ }
      const msg = `Refusing to install "${asset.id}" — its registry SHA256 is a placeholder and this is a packaged build. Observed ${actualSha}; pin it in llama-cpp-models.ts.`
      push(win, { stage: 'error', message: msg, percent: 0 })
      throw new Error(msg)
    }
    console.warn(
      `[llama-cpp] WARNING: SHA256 verification SKIPPED for "${asset.id}" because `
      + `the registry still holds a placeholder. Real SHA observed: ${actualSha}. `
      + `Update llama-cpp-models.ts with this value before release.`,
    )
  } else if (actualSha.toLowerCase() !== asset.sha256.toLowerCase()) {
    try { rmSync(zipTmp, { force: true }) } catch { /* ignore */ }
    const msg =
      `SHA256 mismatch for ${asset.id}: expected ${asset.sha256}, got ${actualSha}. ` +
      `Aborting install — the downloaded file may be tampered with or the registry is stale.`
    push(win, { stage: 'error', message: msg, percent: 0 })
    throw new Error(msg)
  }

  // Move tmp → final-by-name
  try { renameSync(zipTmp, zipFinal) } catch { /* ignore */ }

  // ── Extract ──
  push(win, { stage: 'extracting', message: 'Extracting release zip...', percent: -1 })
  const stagingDir = join(llamaCppDownloadsDir(), `${asset.id}-staging`)
  try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignore */ }
  mkdirSync(stagingDir, { recursive: true })

  try {
    await extractArchive(zipFinal, stagingDir)
  } catch (err) {
    const msg =
      `Extraction failed: ${err instanceof Error ? err.message : String(err)}. ` +
      (process.platform === 'win32'
        ? `Ensure PowerShell (with Expand-Archive) or tar is on PATH.`
        : `Ensure /usr/bin/unzip and tar are installed.`)
    push(win, { stage: 'error', message: msg, percent: 0 })
    throw new Error(msg)
  }

  // Locate the binary inside the staging tree, then lift its directory to bin/.
  const binSourceDir = findBinaryDir(stagingDir)
  if (!binSourceDir) {
    const msg = `Could not locate llama-server inside the extracted archive at ${stagingDir}.`
    push(win, { stage: 'error', message: msg, percent: 0 })
    throw new Error(msg)
  }

  // Clear destination first (idempotency if a prior install left stragglers)
  // but only remove FILES — leave dirs alone (we keep models/ next to bin/).
  try {
    for (const name of readdirSync(llamaCppBinDir())) {
      const p = join(llamaCppBinDir(), name)
      const s = statSync(p)
      if (s.isFile()) {
        try { rmSync(p, { force: true }) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore — bin dir may not exist yet */ }
  moveDirContents(binSourceDir, llamaCppBinDir())

  // ── CUDA runtime (cudart) companion ──
  // The win-cuda zip ships llama binaries ONLY. The CUDA runtime DLLs live in
  // a separate `cudart-*` asset; without them llama-server.exe aborts at
  // startup with a missing cudart64_12.dll. Download + extract them into bin/.
  if (asset.needsCuda && asset.cudartUrl && asset.cudartFilename) {
    // On any cudart failure, remove the just-placed CUDA binary so
    // isLlamaCppInstalled() reports false and the user can cleanly retry
    // (CUDA or CPU) instead of being stuck with an installed-but-won't-start
    // half-install.
    const failCuda = (msg: string): never => {
      try {
        for (const name of readdirSync(llamaCppBinDir())) {
          const p = join(llamaCppBinDir(), name)
          try { if (statSync(p).isFile()) rmSync(p, { force: true }) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      push(win, { stage: 'error', message: msg, percent: 0 })
      throw new Error(msg)
    }

    push(win, { stage: 'downloading-binary', message: 'Downloading CUDA runtime (cudart)...', percent: -1 })
    const cudartTmp   = join(llamaCppDownloadsDir(), `${asset.cudartFilename}.tmp`)
    const cudartFinal = join(llamaCppDownloadsDir(), asset.cudartFilename)
    try {
      await downloadStreaming(asset.cudartUrl, cudartTmp, (bytes, total) => {
        const pct = total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : -1
        push(win, { stage: 'downloading-binary', message: 'Downloading CUDA runtime (cudart)', percent: pct, bytes, totalBytes: total })
      })
    } catch (err) {
      try { rmSync(cudartTmp, { force: true }) } catch { /* ignore */ }
      failCuda(`CUDA runtime download failed: ${err instanceof Error ? err.message : String(err)}. `
        + `llama-server will not start without it — use the CPU build, or install the CUDA Toolkit so the DLLs are on PATH.`)
    }

    const cudartSha = await sha256File(cudartTmp)
    if (asset.cudartSha256 && !isShaPlaceholder(asset.cudartSha256)) {
      if (cudartSha.toLowerCase() !== asset.cudartSha256.toLowerCase()) {
        try { rmSync(cudartTmp, { force: true }) } catch { /* ignore */ }
        failCuda(`cudart SHA256 mismatch: expected ${asset.cudartSha256}, got ${cudartSha}. Aborting.`)
      }
    } else {
      console.warn(
        `[llama-cpp] WARNING: cudart SHA256 verification SKIPPED (placeholder). `
        + `Real SHA observed: ${cudartSha}. Update llama-cpp-models.ts before release.`,
      )
    }
    try { renameSync(cudartTmp, cudartFinal) } catch { /* ignore */ }

    const cudartStaging = join(llamaCppDownloadsDir(), 'cudart-staging')
    try { rmSync(cudartStaging, { recursive: true, force: true }) } catch { /* ignore */ }
    mkdirSync(cudartStaging, { recursive: true })
    push(win, { stage: 'extracting', message: 'Extracting CUDA runtime...', percent: -1 })
    await extractArchive(cudartFinal, cudartStaging)
    const dllCount = collectFilesByExtInto(cudartStaging, llamaCppBinDir(), '.dll')
    try { rmSync(cudartStaging, { recursive: true, force: true }) } catch { /* ignore */ }
    if (dllCount === 0) {
      failCuda(`CUDA runtime archive yielded no DLLs — llama-server will fail to start. `
        + `The cudart asset name may have changed upstream; use the CPU build instead.`)
    }
    console.log(`[llama-cpp] cudart: copied ${dllCount} runtime DLLs into bin/`)
  }

  // ── Cleanup staging ──
  try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* ignore */ }
  // Keep the downloaded zip; it's useful if a future "verify install" path
  // wants to re-extract without re-downloading. Tiny on disk (avx2 is ~14 MB).

  if (!isLlamaCppInstalled()) {
    const msg =
      `Install reported success but ${llamaServerBinaryPath()} is missing. ` +
      `The release zip layout may have changed — inspect ${stagingDir} manually.`
    push(win, { stage: 'error', message: msg, percent: 0 })
    throw new Error(msg)
  }

  push(win, { stage: 'done', message: 'llama.cpp installed.', percent: 100 })
}

// ─── Public API: download model ──────────────────────────────────────────────
//
// Both model paths now run through the central download-manager
// (services/download-manager.ts): HTTP Range resume across drops AND app
// restarts, pause/resume/cancel from the DownloadStrip, disk preflight, and
// post-download integrity. This file keeps the llama-cpp-specific policy
// (placeholder-SHA fail-closed in packaged builds, HF host gating) and the
// legacy `llama-cpp:install-progress` pushes the Catalog/Status UIs consume.

/** Map a manager snapshot onto the legacy install-progress channel. */
function pushFromSnapshot(win: BrowserWindow | null, label: string, snap: DownloadItemSnapshot): void {
  switch (snap.state) {
    case 'active':
      push(win, {
        stage:      'downloading-model',
        message:    `Downloading ${label}`,
        percent:    snap.percent,
        bytes:      snap.receivedBytes,
        totalBytes: snap.totalBytes,
        speedBytesPerSec: snap.speedBytesPerSec,
        etaSec:     snap.etaSec,
      })
      break
    case 'verifying':
      push(win, { stage: 'verifying', message: 'Verifying model…', percent: -1 })
      break
    case 'done':
      push(win, { stage: 'done', message: `Model ready: ${label}`, percent: 100 })
      break
    case 'paused':
      push(win, { stage: 'error', message: 'Download paused — resume from the DOWNLOADS strip in the bottom bar.', percent: 0 })
      break
    case 'error':
      push(win, { stage: 'error', message: snap.error ?? 'Download failed', percent: 0 })
      break
    default:
      break
  }
}

/**
 * Download + verify a curated GGUF model by registry id.
 * Idempotent; concurrent invocations join the same managed task.
 */
export function downloadGgufModel(
  win: BrowserWindow | null,
  modelId: string,
): Promise<void> {
  if (isGgufModelDownloaded(modelId)) {
    push(win, { stage: 'done', message: `Model already on disk: ${modelId}`, percent: 100 })
    return Promise.resolve()
  }
  return _doDownloadModel(win, modelId)
}

async function _doDownloadModel(win: BrowserWindow | null, modelId: string): Promise<void> {
  const model: GgufModel | null = getGgufModel(modelId)
  if (!model) {
    const err = `Unknown GGUF model id: ${modelId}`
    push(win, { stage: 'error', message: err, percent: 0 })
    throw new Error(err)
  }

  // Fail CLOSED in a packaged build (audit S4) — and now BEFORE burning
  // gigabytes of bandwidth, not after.
  if (isShaPlaceholder(model.sha256) && app.isPackaged) {
    const msg = `Refusing to install "${model.id}" — its registry SHA256 is a placeholder and this is a packaged build. Pin it in llama-cpp-models.ts.`
    push(win, { stage: 'error', message: msg, percent: 0 })
    throw new Error(msg)
  }

  // LANE U: the weight lands wherever ggufModelPath resolves (storage root for
  // a NEW download, legacy for one already on disk there) and the .part sits
  // NEXT TO IT — the landing rename must not cross devices.
  const finalPath = ggufModelPath(modelId)
  const tmpPath   = partPathFor(finalPath)
  mkdirSync(dirname(finalPath), { recursive: true })

  push(win, {
    stage:   'downloading-model',
    message: `Downloading ${model.label} (~${model.sizeMb} MB)`,
    percent: 0,
  })

  try {
    const snap = await runManagedDownload({
      id:       modelId,
      name:     model.label,
      kind:     'gguf-model',
      url:      model.url,
      destPath: finalPath,
      partPath: tmpPath,
      expectedSha256:  isShaPlaceholder(model.sha256) ? undefined : model.sha256,
      approxTotalBytes: Math.round(model.sizeMb * 1_048_576),
    }, s => pushFromSnapshot(win, model.label, s))

    if (isShaPlaceholder(model.sha256)) {
      console.warn(
        `[llama-cpp] WARNING: GGUF SHA256 verification SKIPPED for "${model.id}" `
        + `because the registry holds a placeholder. Real SHA observed: ${snap.observedSha256 ?? 'n/a'}. `
        + `Update llama-cpp-models.ts before release.`,
      )
    }
  } catch (err) {
    const code = (err as { code?: string })?.code
    const msg = code === 'PAUSED' || code === 'CANCELLED'
      ? (err instanceof Error ? err.message : String(err))
      : `Model download failed: ${err instanceof Error ? err.message : String(err)}`
    throw new Error(msg)
  }
}

// Trusted model hosts for arbitrary-URL GGUF downloads (audit S3). The file is
// loaded straight into the inference engine, so an unverified URL into the
// models dir is an arbitrary-code-adjacent risk. We gate on EITHER an
// allowlisted host (HuggingFace, the documented source for community GGUFs)
// OR a caller-supplied SHA256 verified before the file is kept.
function isAllowedGgufHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'https:') return false
    const h = u.hostname.toLowerCase()
    return h === 'huggingface.co' || h.endsWith('.huggingface.co')
      || h === 'hf.co' || h.endsWith('.hf.co')
  } catch { return false }
}

/**
 * Download an arbitrary GGUF by URL into models/<id>.gguf. This is for
 * user-chosen HuggingFace files (e.g. community merges Ollama's puller
 * rejects). Gated (audit S3): the host must be allowlisted (HuggingFace) OR a
 * sha256 must be supplied and verified before the file is kept — never an
 * unverified file from an arbitrary host.
 */
export function downloadGgufFromUrl(
  win: BrowserWindow | null,
  id: string,
  url: string,
  sha256?: string,
): Promise<void> {
  if (!sha256 && !isAllowedGgufHost(url)) {
    const msg = `Refusing to download "${id}" from an untrusted host — use a huggingface.co URL, or supply a SHA256 to verify against.`
    push(win, { stage: 'error', message: msg, percent: 0 })
    return Promise.reject(new Error(msg))
  }
  if (isGgufModelDownloaded(id)) {
    push(win, { stage: 'done', message: `Model already on disk: ${id}`, percent: 100 })
    return Promise.resolve()
  }
  return _doDownloadFromUrl(win, id, url, sha256)
}

/**
 * "Stop" an in-flight GGUF model download by id (curated registry id or HF id).
 * Now maps to the manager's PAUSE: the partial file and its byte offset are
 * kept, and the DOWNLOADS strip offers RESUME (a catalog re-click resumes
 * too). Returns true iff a download was active for that id.
 */
export function cancelGgufDownload(id: string): boolean {
  return pauseManagedDownload(id)
}

async function _doDownloadFromUrl(win: BrowserWindow | null, id: string, url: string, sha256?: string): Promise<void> {
  const finalPath = ggufModelPath(id)
  const tmpPath   = partPathFor(finalPath) // same dir as the final file (LANE U)
  mkdirSync(dirname(finalPath), { recursive: true })

  push(win, { stage: 'downloading-model', message: 'Downloading model…', percent: 0 })

  // Integrity source, in order of preference: caller-supplied sha256 →
  // HuggingFace LFS oid (the LFS object id IS the file's sha256) + exact
  // size from the paths-info API → size-only verification. Best-effort and
  // fast (8s cap); a miss degrades honestly to verified:'size'/'none'.
  let expectedSha = sha256
  let expectedBytes: number | undefined
  if (!expectedSha) {
    const hf = await resolveHfExpected(url)
    if (hf?.sha256) expectedSha = hf.sha256
    if (hf?.sizeBytes) expectedBytes = hf.sizeBytes
  }

  try {
    await runManagedDownload({
      id,
      name:     id,
      kind:     'gguf-url',
      url,
      destPath: finalPath,
      partPath: tmpPath,
      expectedSha256: expectedSha,
      expectedBytes,
    }, s => pushFromSnapshot(win, id, s))
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code === 'PAUSED' || code === 'CANCELLED' || code === 'CHECKSUM_MISMATCH') {
      // These messages are already precise (incl. whether the file was kept).
      throw new Error(err instanceof Error ? err.message : String(err))
    }
    throw new Error(`Model download failed: ${err instanceof Error ? err.message : String(err)} — partial file kept, resume from the DOWNLOADS strip or click Download again.`)
  }
}

/** Delete a downloaded GGUF model by id from BOTH roots. No-op if not present. */
export function removeGgufModel(modelId: string): { ok: boolean; error?: string } {
  return removeResolved('llama', `${modelId}.gguf`)
}

/**
 * Suppress unused-import lint warnings for the destructured helpers we keep
 * imported for clarity even when not directly referenced inside this file.
 */
void httpsRequest
void dirname
void basename
