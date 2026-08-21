// apps/desktop/electron/services/util/resolve-binary.ts
//
// Binary-resolver cascade used by every sidecar service:
//   1. Environment variable (user override)
//   2. Bundled candidates — process.resourcesPath / app.asar.unpacked / app.getAppPath() / cwd
//   3. PATH  (where.exe on win32, which elsewhere)
//
// Pattern adapted from VidBee packages/downloader-core resolveYtDlpPath and
// Open-Generative-AI electron/lib/localInferencePaths.js. Ported to TypeScript
// without external deps.

import { existsSync, accessSync, constants as fsConstants } from 'fs'
import { join, resolve as resolvePath, isAbsolute } from 'path'
import { execFileSync } from 'child_process'
import { app } from 'electron'

export interface ResolveBinaryOptions {
  /** Environment variable whose value, if set, overrides everything else. */
  envVar?: string
  /**
   * Relative paths under each bundled root to try.
   * e.g. ['bin/sd-cli', 'sd-cli'] — the `.exe` suffix is appended on win32.
   */
  bundledCandidates: string[]
}

/**
 * Resolve an executable binary in priority order:
 *   env-var override → bundled paths → PATH
 *
 * Returns the first existing, executable path or null.
 * The `.exe` suffix is automatically appended on win32.
 */
export function resolveBinary(name: string, opts: ResolveBinaryOptions): string | null {
  const { envVar, bundledCandidates } = opts
  const exeSuffix = process.platform === 'win32' ? '.exe' : ''

  // 1. Environment variable override.
  if (envVar) {
    const envPath = process.env[envVar]
    if (envPath && existsSync(envPath) && isExecutable(envPath)) {
      return envPath
    }
  }

  // 2. Bundled candidates — try under each resource root.
  const roots = getBundledRoots()
  for (const candidate of bundledCandidates) {
    // Candidate may or may not already include the extension; try both.
    const candidateWithExt = candidate.endsWith(exeSuffix) ? candidate : `${candidate}${exeSuffix}`
    // ABSOLUTE candidates (userData installs: piper/sd-cpp/yt-dlp/whisper) are
    // checked as-is — join(root, absolute) mangles the path on Windows, which
    // silently hid every user-installed sidecar binary.
    if (isAbsolute(candidateWithExt)) {
      if (existsSync(candidateWithExt) && isExecutable(candidateWithExt)) return candidateWithExt
      continue
    }
    for (const root of roots) {
      const p = join(root, candidateWithExt)
      if (existsSync(p) && isExecutable(p)) return p
    }
  }

  // 3. PATH lookup.
  return resolveFromPath(name, exeSuffix)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the ordered set of root directories to search for bundled binaries. */
function getBundledRoots(): string[] {
  const roots: string[] = []

  // process.resourcesPath — available in packaged Electron (asar context).
  if (process.resourcesPath) {
    roots.push(process.resourcesPath)
    // Unpacked dir sits alongside the asar.
    roots.push(join(process.resourcesPath, 'app.asar.unpacked'))
  }

  // app.getAppPath() — resolves to the asar root in prod, or
  // apps/desktop/out/main in dev (electron-vite output dir).
  try {
    const appPath = app.getAppPath()
    roots.push(appPath)
    // go up one level in case the app lives inside out/main/
    roots.push(join(appPath, '..'))
  } catch { /* app may not be ready yet; skip */ }

  // process.cwd() — useful in dev when running node directly.
  roots.push(process.cwd())

  // Deduplicate while preserving order.
  const seen = new Set<string>()
  return roots.filter(r => { if (seen.has(r)) return false; seen.add(r); return true })
}

/** True when the path exists and is executable (or at least readable on Windows). */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    // Windows does not honour POSIX X_OK for .exe — fall back to readable.
    try {
      accessSync(p, fsConstants.R_OK)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Locate `name[.exe]` on PATH using `where.exe` (win32) or `which` (posix).
 * Returns null on any failure.
 */
function resolveFromPath(name: string, exeSuffix: string): string | null {
  const exe = name.endsWith(exeSuffix) ? name : `${name}${exeSuffix}`
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which'
    const out = execFileSync(cmd, [exe], { encoding: 'utf8', timeout: 5_000 })
    const first = out.split(/\r?\n/)[0]?.trim()
    if (first && existsSync(first)) return first
  } catch { /* not found on PATH */ }
  return null
}
