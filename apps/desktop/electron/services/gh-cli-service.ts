// apps/desktop/electron/services/gh-cli-service.ts
//
// Zero-terminal bundler for the GitHub CLI (`gh`). The embedded Aeon dashboard
// is a Next.js app whose API routes shell out to `gh api`, `gh secret list`,
// `gh repo view`, etc. If `gh` isn't on the user's PATH, every dashboard tab
// shows "no skills / no runs / no auth" because each route returns empty.
//
// We download the appropriate platform asset from cli/cli's GitHub releases
// once per major version, extract to userData/gh-cli/, and let callers grab
// the bin dir to prepend onto a spawned child's PATH.
//
// Why not require the system gh? It's a manual install step that breaks the
// "TachiDesk is fully self-contained" promise. The release tarballs are
// ~10 MB and the install is a one-time cost.
import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

const execFileAsync = promisify(execFile)

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT       = () => join(app.getPath('userData'), 'gh-cli')
const VERSION_FILE = () => join(ROOT(), 'INSTALLED_VERSION')
const ARCHIVE_PATH = () => join(ROOT(),
  process.platform === 'win32' ? 'gh.zip' : 'gh.tar.gz',
)

// ── Progress hook ─────────────────────────────────────────────────────────────
export type GhProgress =
  | { stage: 'fetching-meta' }
  | { stage: 'downloading'; bytes?: number; total?: number }
  | { stage: 'extracting' }
  | { stage: 'ready' }

let listener: ((e: GhProgress) => void) | null = null
export function onGhProgress(cb: (e: GhProgress) => void): () => void {
  listener = cb
  return () => { if (listener === cb) listener = null }
}
function emit(e: GhProgress): void { listener?.(e) }

// ── Platform detection ────────────────────────────────────────────────────────
//
// Maps Node's platform/arch to the asset name suffix cli/cli uses. The
// suffix is matched as a substring against `release.assets[i].name`, so we
// don't need to know the exact version — `gh_2.x.x_windows_amd64.zip` matches
// suffix `windows_amd64.zip`.
function assetSuffix(): string {
  const a = process.arch
  if (process.platform === 'win32') {
    if (a === 'arm64') return 'windows_arm64.zip'
    if (a === 'x64')   return 'windows_amd64.zip'
    if (a === 'ia32')  return 'windows_386.zip'
  }
  if (process.platform === 'darwin') {
    if (a === 'arm64') return 'macOS_arm64.zip'
    return 'macOS_amd64.zip'
  }
  if (process.platform === 'linux') {
    if (a === 'arm64') return 'linux_arm64.tar.gz'
    if (a === 'arm')   return 'linux_armv6.tar.gz'
    return 'linux_amd64.tar.gz'
  }
  throw new Error(`Unsupported platform: ${process.platform}/${a}`)
}

// ── Binary discovery ──────────────────────────────────────────────────────────
//
// After extraction the asset has a top-level directory like `gh_2.65.0_windows_amd64/`
// containing `bin/gh` or `bin/gh.exe`. We search recursively (one level deep)
// to find that bin dir without hardcoding the version-stamped folder name.
function findBinDir(): string | null {
  if (!existsSync(ROOT())) return null
  // First check direct bin/ in case we've already flattened.
  const direct = join(ROOT(), 'bin')
  const exe = process.platform === 'win32' ? 'gh.exe' : 'gh'
  if (existsSync(join(direct, exe))) return direct

  // Otherwise look one level down (gh_X.Y.Z_platform/bin/gh).
  let entries: string[]
  try { entries = readdirSync(ROOT()) } catch { return null }
  for (const entry of entries) {
    const sub = join(ROOT(), entry)
    let isDir = false
    try { isDir = statSync(sub).isDirectory() } catch { continue }
    if (!isDir) continue
    const binDir = join(sub, 'bin')
    if (existsSync(join(binDir, exe))) return binDir
  }
  return null
}

export function ghBinaryPath(): string | null {
  const binDir = findBinDir()
  if (!binDir) return null
  const exe = process.platform === 'win32' ? 'gh.exe' : 'gh'
  return join(binDir, exe)
}

export function ghBinDir(): string | null { return findBinDir() }

// ── Public install/ensure ─────────────────────────────────────────────────────

export interface EnsureGhResult {
  installed: boolean
  binPath:   string | null
  binDir:    string | null
  version:   string | null
}

/**
 * Make sure a bundled gh CLI exists in userData/gh-cli/ and return its paths.
 * No-op when the binary is already on disk — checking existsSync is cheaper
 * than even one network call, so first launches that already cached gh skip
 * any release-API traffic.
 */
export async function ensureGhCli(): Promise<EnsureGhResult> {
  const existing = ghBinaryPath()
  if (existing) {
    return {
      installed: true,
      binPath:   existing,
      binDir:    dirname(existing),
      version:   await tryReadVersion(),
    }
  }
  await downloadAndExtract()
  const binPath = ghBinaryPath()
  return {
    installed: !!binPath,
    binPath,
    binDir:    binPath ? dirname(binPath) : null,
    version:   await tryReadVersion(),
  }
}

async function tryReadVersion(): Promise<string | null> {
  const bin = ghBinaryPath()
  if (!bin) return null
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 5_000 })
    // Output starts with "gh version X.Y.Z (timestamp)" — pull the X.Y.Z.
    const m = stdout.match(/gh version ([\d.]+)/)
    return m?.[1] ?? null
  } catch { return null }
}

async function downloadAndExtract(): Promise<void> {
  mkdirSync(ROOT(), { recursive: true })

  emit({ stage: 'fetching-meta' })
  // Find the latest release's matching asset URL. The /releases/latest
  // endpoint returns 302→stable JSON; the API call yields assets[].
  const metaRes = await fetch('https://api.github.com/repos/cli/cli/releases/latest', {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'TachiDesk-Gh-Bootstrap',
    },
  })
  if (!metaRes.ok) {
    throw new Error(`Could not fetch cli/cli latest release metadata: HTTP ${metaRes.status}`)
  }
  const meta = await metaRes.json() as {
    tag_name?: string
    assets?:   Array<{ name?: string; browser_download_url?: string }>
  }
  const suffix = assetSuffix()
  const asset  = (meta.assets ?? []).find(a => a.name?.endsWith(suffix))
  if (!asset?.browser_download_url) {
    throw new Error(`No gh CLI asset found for this platform (looking for *${suffix})`)
  }

  // Stream the tarball/zip to disk with byte-count progress so the renderer
  // can show a meaningful "downloading 4.2 MB / 12 MB" pill.
  emit({ stage: 'downloading' })
  const dlRes = await fetch(asset.browser_download_url, {
    headers:  { 'User-Agent': 'TachiDesk-Gh-Bootstrap' },
    redirect: 'follow',
  })
  if (!dlRes.ok) throw new Error(`gh CLI download failed: HTTP ${dlRes.status}`)
  if (!dlRes.body) throw new Error('gh CLI download response had no body')

  const total = Number(dlRes.headers.get('content-length') || 0) || undefined
  let   bytes = 0
  const monitored = new ReadableStream({
    async start(controller) {
      const reader = dlRes.body!.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          bytes += value.byteLength
          emit({ stage: 'downloading', bytes, total })
          controller.enqueue(value)
        }
      }
      controller.close()
    },
  })

  await pipeline(
    Readable.fromWeb(monitored as unknown as import('stream/web').ReadableStream<Uint8Array>),
    createWriteStream(ARCHIVE_PATH()),
  )

  emit({ stage: 'extracting' })
  // Extract. The two platforms ship different archive formats:
  //   Windows → gh_*.zip            (extracted via PowerShell Expand-Archive)
  //   POSIX   → gh_*.tar.gz         (extracted via system tar)
  //
  // Why not tar.exe on Windows? Modern Win10/11 tar nominally supports `-xf`
  // on zips, but GitHub's release zips trip a tar bug ("Exiting with failure
  // status due to previous errors" on the first central directory entry).
  // PowerShell's Expand-Archive uses .NET's System.IO.Compression.ZipFile
  // and just works.
  if (process.platform === 'win32') {
    // Note: -Force overwrites if the destination exists; harmless on first
    // run, and lets a retry-after-failure proceed without manual cleanup.
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Single-quoted PowerShell string keeps the literal cwd-relative
        // path; -DestinationPath '.' lands the version-stamped folder
        // directly under ROOT(), where findBinDir() expects it.
        "Expand-Archive -Path 'gh.zip' -DestinationPath '.' -Force",
      ],
      {
        cwd:       ROOT(),
        timeout:   180_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    )
  } else {
    await execFileAsync('tar', ['-xzf', 'gh.tar.gz'], {
      cwd:       ROOT(),
      timeout:   120_000,
      maxBuffer: 16 * 1024 * 1024,
    })
  }
  // Cleanup the archive — keeping it would waste ~10 MB per install.
  rmSync(ARCHIVE_PATH(), { force: true })

  // Persist the installed version tag for tooltips/diagnostics.
  if (meta.tag_name) {
    try {
      const { writeFileSync } = await import('fs')
      writeFileSync(VERSION_FILE(), meta.tag_name, 'utf8')
    } catch { /* non-fatal */ }
  }

  if (!ghBinaryPath()) {
    throw new Error('gh CLI extracted but binary not found — release layout may have changed')
  }
  emit({ stage: 'ready' })
}

/** Wipe the bundled gh install so the next ensure() re-downloads. */
export function resetGhCli(): void {
  if (existsSync(ROOT())) rmSync(ROOT(), { recursive: true, force: true })
}
