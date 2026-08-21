// apps/desktop/electron/services/remotion-binaries-installer.ts
//
// THE VIDEO ENCODER IS FETCHED, NOT SHIPPED.
//
// Remotion renders MP4 by spawning its own Rust compositor plus an ffmpeg and an
// ffprobe, which live in a per-platform npm package
// (`@remotion/compositor-win32-x64-msvc` and friends). Those binaries used to
// ride inside our installer via the `asarUnpack` rule for `**/node_modules/
// @remotion/**`, and that was a mistake we can prove rather than suspect:
//
//     $ grep -a -o 'libavcodec license: [a-z ]*' avcodec-61.dll
//     libavcodec license: nonfree and unredistributable
//
// FFmpeg prints that when it was built with `--enable-nonfree`. It is FFmpeg's
// own statement about its own bytes, and it appears in FOURTEEN DLLs of the
// packaged tree — avcodec-60/61, avdevice-60/61, avfilter-9/10, avformat-60/61,
// avutil-58/59, swresample-4/5, swscale-7/8 — inside an installer we were about
// to publish under an MIT project page. (The first count was four, because the
// first grep only looked at avcodec and avformat. Counting them all is the
// difference between "two files to think about" and "the whole codec stack".)
// Shipping it makes US the distributor of something that says it may not be
// distributed.
//
// SO WE STOP BEING THE DISTRIBUTOR. The package is excluded from the build
// (see the `!**/node_modules/@remotion/compositor-*/**` rule in
// electron-builder.json) and the app fetches it, on an explicit click, from the
// official npm registry — the same place `npm install` would get it, published
// by Remotion themselves. What changes is not the bytes; it is who hands them to
// the user. That distinction is the whole point, and it is why this is a button
// and never an automatic background download.
//
// WHAT MAKES THIS POSSIBLE AT ALL (verified in the installed renderer, not
// assumed — @remotion/renderer 4.0.490,
// dist/compositor/get-executable-path.js:34):
//
//     const base = binariesDirectory ?? getExecutableDir(indent, logLevel);
//
// `getExecutableDir` is the function that does `require('@remotion/compositor-…')`,
// and it is ONLY reached when `binariesDirectory` is null. Pass a real directory
// and the platform package is never required — so it does not have to exist in
// the bundle. Remotion's own Electron guide says the same thing from the other
// side: "you may need to manually stage the compositor package". This is that
// staging, moved out of the installer and into a download the user authorises.
//
// The directory shape is Remotion's, not ours: a FLAT folder holding
// `remotion.exe`, `ffmpeg.exe` and `ffprobe.exe` (no extension off Windows).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { app, type BrowserWindow } from 'electron'
import { withInstallLock } from './util/install-lock'
import { resumableDownload, extractArchive } from './util/installer-kit'

const nodeRequire = createRequire(__filename)

/**
 * The version we must fetch — the SAME one `@remotion/renderer` was built
 * against. Remotion refuses a compositor whose version differs from the
 * renderer's, so this can never be a number of our own choosing.
 *
 * Read from the installed renderer's own package.json (which lives inside
 * app.asar in a packaged build — readFileSync handles asar paths) so a
 * dependency bump cannot leave this behind. The constant is only the floor for
 * the case where resolution fails entirely, and it is deliberately the value
 * pinned in apps/desktop/package.json.
 */
const REMOTION_VERSION_FALLBACK = '4.0.490'

export function remotionVersion(): string {
  try {
    const pkgPath = nodeRequire.resolve('@remotion/renderer/package.json')
    const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
    if (typeof raw.version === 'string' && /^\d+\.\d+\.\d+/.test(raw.version)) return raw.version
  } catch { /* fall through */ }
  return REMOTION_VERSION_FALLBACK
}

/**
 * The compositor package for THIS machine. Same table as design-render.ts and
 * design-hf-render.ts — those two resolve the directory, this one names the
 * thing to download, and all three must agree or the render spawns nothing.
 */
export function remotionCompositorPkg(): string {
  if (process.platform === 'win32') {
    return process.arch === 'arm64' ? 'compositor-win32-arm64-msvc' : 'compositor-win32-x64-msvc'
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'compositor-darwin-arm64' : 'compositor-darwin-x64'
  }
  return process.arch === 'arm64' ? 'compositor-linux-arm64-gnu' : 'compositor-linux-x64-gnu'
}

/** The three executables Remotion looks for, by the names it looks for. */
export function remotionBinaryNames(): { compositor: string; ffmpeg: string; ffprobe: string } {
  const ext = process.platform === 'win32' ? '.exe' : ''
  return { compositor: `remotion${ext}`, ffmpeg: `ffmpeg${ext}`, ffprobe: `ffprobe${ext}` }
}

/**
 * Where a fetched copy lives. VERSIONED on purpose: a Remotion bump must not
 * silently keep using last version's compositor, which is exactly the class of
 * defect a flat directory invites.
 */
export function remotionBinariesDir(version = remotionVersion()): string {
  return join(app.getPath('userData'), 'remotion-binaries', version, remotionCompositorPkg())
}

/** Every file Remotion needs is present and non-empty. */
export function isRemotionBinariesInstalled(version = remotionVersion()): boolean {
  const dir = remotionBinariesDir(version)
  const names = remotionBinaryNames()
  for (const n of [names.compositor, names.ffmpeg, names.ffprobe]) {
    const p = join(dir, n)
    try { if (!statSync(p).isFile() || statSync(p).size === 0) return false } catch { return false }
  }
  return true
}

/**
 * A DEVELOPER's node_modules copy, when there is one.
 *
 * Kept so `pnpm dev` after `pnpm install` renders MP4 with no download at all —
 * the contributor already has the package, and asking them to fetch a second
 * copy would be noise. A PACKAGED build never has this (the exclusion rule
 * removes it), so there it is always the fetched directory or nothing.
 */
export function devRemotionBinariesDir(): string | null {
  if (app.isPackaged) return null
  try {
    const rendererEntry = nodeRequire.resolve('@remotion/renderer')
    const rendererRequire = createRequire(rendererEntry)
    const entry = rendererRequire.resolve(`@remotion/${remotionCompositorPkg()}`)
    const dir = dirname(entry)
    return existsSync(join(dir, remotionBinaryNames().ffmpeg)) ? dir : null
  } catch {
    return null
  }
}

/**
 * THE ONE LOOKUP every render path makes.
 *
 * Fetched copy first, developer copy second, otherwise null — and null means
 * "ask the user", never "download quietly behind their back".
 */
export function resolveRemotionBinariesDir(): string | null {
  if (isRemotionBinariesInstalled()) return remotionBinariesDir()
  return devRemotionBinariesDir()
}

export interface RemotionBinariesState {
  installed:  boolean
  /** Present when something is usable right now — fetched or developer copy. */
  dir:        string | null
  /** True when `dir` is a developer's node_modules, i.e. nothing was fetched. */
  fromDevTree: boolean
  version:    string
  packageName: string
  /** What the user is agreeing to download, in bytes, when known. */
  approxBytes: number | null
}

/**
 * ~47 MB measured on win32-x64 at 4.0.490 (the unpacked package; the .tgz is
 * smaller). Quoted to the user BEFORE the click, and deliberately approximate:
 * an exact number per platform would be four numbers that rot independently.
 */
const APPROX_DOWNLOAD_BYTES = 47 * 1024 * 1024

export function remotionBinariesState(): RemotionBinariesState {
  const installed = isRemotionBinariesInstalled()
  const dev = installed ? null : devRemotionBinariesDir()
  return {
    installed,
    dir: installed ? remotionBinariesDir() : dev,
    fromDevTree: !installed && dev !== null,
    version: remotionVersion(),
    packageName: `@remotion/${remotionCompositorPkg()}`,
    approxBytes: APPROX_DOWNLOAD_BYTES,
  }
}

export type RemotionInstallStage = 'checking' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'
export interface RemotionInstallProgress {
  stage:   RemotionInstallStage
  message: string
  percent: number
  bytes?:  number
  totalBytes?: number
}

function push(win: BrowserWindow | null, e: RemotionInstallProgress): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('remotion-binaries:progress', e)
}

/** `sha512-<base64>` as npm publishes it in `dist.integrity`. */
function sha512Base64(path: string): string {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

interface RegistryDist { tarball?: unknown; integrity?: unknown; shasum?: unknown }

/**
 * Ask the registry where the tarball is and what it should hash to.
 *
 * The URL is NOT hand-built. npm's own metadata is the authority on both the
 * location and the integrity, so a package that moves CDN or republishes cannot
 * leave a stale constant behind — the same reason the model registry reads HF's
 * API for its digests instead of transcribing them.
 */
async function fetchDist(pkg: string, version: string): Promise<{ tarball: string; integrity: string | null }> {
  const url = `https://registry.npmjs.org/@remotion/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`npm registry answered HTTP ${res.status} for @remotion/${pkg}@${version}`)
  const body = (await res.json()) as { dist?: RegistryDist }
  const dist = body.dist ?? {}
  const tarball = typeof dist.tarball === 'string' ? dist.tarball : null
  if (!tarball) throw new Error(`npm registry returned no tarball URL for @remotion/${pkg}@${version}`)
  if (!/^https:\/\//i.test(tarball)) throw new Error(`refusing a non-https tarball URL: ${tarball}`)
  const integrity = typeof dist.integrity === 'string' && dist.integrity.startsWith('sha512-')
    ? dist.integrity.slice('sha512-'.length)
    : null
  return { tarball, integrity }
}

/**
 * Fetch and stage the official compositor. CALLED ONLY FROM AN EXPLICIT USER
 * ACTION — there is no auto-install path into this function, by design.
 *
 * Staged through a temp directory and renamed into place, so an interrupted
 * download can never leave a half-populated directory that
 * `isRemotionBinariesInstalled` would later call complete.
 */
export async function installRemotionBinaries(win: BrowserWindow | null): Promise<string> {
  const version = remotionVersion()
  const pkg = remotionCompositorPkg()
  const finalDir = remotionBinariesDir(version)

  if (isRemotionBinariesInstalled(version)) {
    push(win, { stage: 'done', message: 'Video encoder already installed', percent: 100 })
    return finalDir
  }

  let out: string | null = null
  await withInstallLock('remotion-binaries', async () => {
    if (isRemotionBinariesInstalled(version)) { out = finalDir; return }

    push(win, { stage: 'checking', message: `Looking up @remotion/${pkg}@${version}…`, percent: 0 })
    const { tarball, integrity } = await fetchDist(pkg, version)

    const stageRoot = `${finalDir}.staging`
    try { rmSync(stageRoot, { recursive: true, force: true }) } catch { /* fresh start */ }
    mkdirSync(stageRoot, { recursive: true })
    const tgz = join(stageRoot, 'package.tgz')

    push(win, { stage: 'downloading', message: 'Downloading the video encoder…', percent: 0 })
    await resumableDownload(tarball, tgz, (bytes, total) => {
      push(win, {
        stage: 'downloading',
        message: 'Downloading the video encoder…',
        percent: total ? Math.round((bytes / total) * 100) : 0,
        bytes, totalBytes: total,
      })
    })

    // INTEGRITY BEFORE EXTRACTION, always: a tarball is executed by `tar`, and
    // verifying after unpacking would be verifying something already on disk.
    if (integrity) {
      push(win, { stage: 'verifying', message: 'Verifying the download…', percent: 100 })
      const actual = sha512Base64(tgz)
      if (actual !== integrity) {
        try { rmSync(stageRoot, { recursive: true, force: true }) } catch { /* */ }
        throw new Error(
          `The download did not match the checksum npm publishes for @remotion/${pkg}@${version}. ` +
          `Nothing was installed.`,
        )
      }
    }

    push(win, { stage: 'extracting', message: 'Unpacking…', percent: 100 })
    const unpacked = join(stageRoot, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    await extractArchive(tgz, unpacked)

    // An npm tarball unpacks under a single `package/` root. Resolve it rather
    // than assuming: a registry that ever changes that shape would otherwise
    // produce an "installed" directory holding nothing.
    const names = remotionBinaryNames()
    const candidates = [join(unpacked, 'package'), unpacked]
    let src: string | null = null
    for (const c of candidates) {
      if (existsSync(join(c, names.ffmpeg)) && existsSync(join(c, names.compositor))) { src = c; break }
    }
    if (!src) {
      let saw: string[] = []
      try { saw = readdirSync(unpacked) } catch { /* */ }
      try { rmSync(stageRoot, { recursive: true, force: true }) } catch { /* */ }
      throw new Error(
        `The downloaded package did not contain ${names.compositor} and ${names.ffmpeg}` +
        (saw.length ? ` (found: ${saw.slice(0, 6).join(', ')})` : '') + '.',
      )
    }

    if (process.platform !== 'win32') {
      for (const n of [names.compositor, names.ffmpeg, names.ffprobe]) {
        try { chmodSync(join(src, n), 0o755) } catch { /* best effort */ }
      }
    }

    mkdirSync(dirname(finalDir), { recursive: true })
    try { rmSync(finalDir, { recursive: true, force: true }) } catch { /* */ }
    renameSync(src, finalDir)
    try { rmSync(stageRoot, { recursive: true, force: true }) } catch { /* the tgz and its wrapper */ }

    if (!isRemotionBinariesInstalled(version)) {
      throw new Error('The video encoder was unpacked but is still incomplete — nothing was installed.')
    }
    push(win, { stage: 'done', message: 'Video encoder ready', percent: 100 })
    out = finalDir
  })

  if (!out) out = isRemotionBinariesInstalled(version) ? finalDir : null
  if (!out) throw new Error('The video encoder could not be installed.')
  return out
}

/** Remove a fetched copy. The developer tree is never touched. */
export function removeRemotionBinaries(): { ok: boolean; error?: string } {
  try {
    rmSync(join(app.getPath('userData'), 'remotion-binaries'), { recursive: true, force: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// The user-facing sentence lives in its own import-free module — see
// remotion-binaries-message.ts for why it cannot live here. Re-exported so the
// feature still reads as one thing from a caller's point of view.
export { REMOTION_BINARIES_MISSING } from './remotion-binaries-message'
