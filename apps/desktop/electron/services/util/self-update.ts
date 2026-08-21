// apps/desktop/electron/services/util/self-update.ts
//
// Atomic binary self-update utility — adapted from the yt-dlp update.py
// "atomic replace" pattern (download → SHA-verify → rename old → rename new).
//
// The three-step rename keeps the running binary intact until the last possible
// moment, and leaves a .old backup that can be cleaned up on the NEXT launch
// (the OS may lock the currently-executing binary on Windows).
//
//   <binPath>         — the live binary (may be locked by the OS on win32)
//   <binPath>.new     — downloaded candidate; removed on verify failure
//   <binPath>.old     — previous version; best-effort deleted on next launch
//
// Usage:
//   await updateBinary({ binPath: getSdCliPath()!, url, sha256, onProgress })
//   // call early in app startup:
//   await cleanupStaleBackups(sdBinDir())
//
// Only node builtins + electron are used — no new npm deps.

import {
  existsSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  statSync,
  readdirSync,
} from 'fs'
import { join, dirname, basename } from 'path'
import { get as httpsGet } from 'https'
import { URL } from 'url'
import { app } from 'electron'
import { sha256File } from './installer-kit'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpdateBinaryOptions {
  /**
   * Absolute path to the binary that should be replaced.
   * Must already exist — this is an UPDATE, not a fresh install.
   */
  binPath: string
  /** HTTPS URL from which to download the new binary. */
  url: string
  /**
   * Expected lowercase hex SHA-256 of the downloaded file.
   * Pass the exact 64-char hex string from the release manifest.
   */
  sha256: string
  /**
   * Optional progress callback. receivedBytes and totalBytes are both 0
   * when the Content-Length header is absent (streaming archive without size).
   */
  onProgress?: (receivedBytes: number, totalBytes: number) => void
}

export interface UpdateBinaryResult {
  /** True when the binary was actually replaced. False when already up-to-date
   *  (reserved for future version-check short-circuit). */
  updated: boolean
  /** The path that is now live (same as binPath). */
  binPath: string
  /** Path of the .old backup left on disk, if any. */
  oldPath?: string
}

// ─── Public API: updateBinary ─────────────────────────────────────────────────

/**
 * Download a new binary to `<binPath>.new`, SHA-256 verify it, then atomically
 * rotate:  `<binPath>` → `<binPath>.old`  and  `<binPath>.new` → `<binPath>`.
 *
 * The old backup is NOT immediately deleted because the OS may still hold a
 * file lock (especially on Windows).  Call `cleanupStaleBackups(dir)` on the
 * next app startup to remove any surviving .old files.
 *
 * Throws on network error, SHA mismatch, or rename failure.
 */
export async function updateBinary(opts: UpdateBinaryOptions): Promise<UpdateBinaryResult> {
  const { binPath, url, sha256, onProgress } = opts
  const newPath = `${binPath}.new`
  const oldPath = `${binPath}.old`

  // Ensure the target directory exists (guard against misconfigured callers).
  const dir = dirname(binPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // Step 1 — download to .new, removing a stale .new if present.
  _tryUnlink(newPath)
  await _downloadBinary(url, newPath, onProgress)

  // Step 2 — SHA-256 verify.
  const actualSha = await sha256File(newPath)
  if (actualSha.toLowerCase() !== sha256.toLowerCase()) {
    _tryUnlink(newPath)
    throw new Error(
      `[self-update] SHA-256 mismatch for ${basename(binPath)}: ` +
      `expected ${sha256}, got ${actualSha}. Update aborted.`,
    )
  }

  // Step 3 — atomic rotate: live → .old, .new → live.
  // If a previous .old exists, remove it first (best-effort).
  _tryUnlink(oldPath)
  if (existsSync(binPath)) {
    renameSync(binPath, oldPath)
  }
  renameSync(newPath, binPath)

  return { updated: true, binPath, oldPath: existsSync(oldPath) ? oldPath : undefined }
}

// ─── Public API: cleanupStaleBackups ─────────────────────────────────────────

/**
 * Remove any `*.old` files in `dir` left over from a previous atomic update.
 * Intended to be called once per launch (e.g. from the app `ready` handler or
 * immediately after a service is confirmed running).
 *
 * Errors on individual files are silently ignored — the caller should not crash
 * startup just because a stale backup could not be deleted.
 */
export function cleanupStaleBackups(dir: string): void {
  if (!existsSync(dir)) return
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (!name.endsWith('.old')) continue
    const p = join(dir, name)
    let s; try { s = statSync(p) } catch { continue }
    if (s.isFile()) _tryUnlink(p)
  }
}

// ─── Download (https only, redirect-following, with progress) ────────────────

/**
 * Download `url` to `dest` (full overwrite).
 * HTTPS only; up to 10 redirects; 60 s socket idle timeout.
 */
function _downloadBinary(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let hops = 0
    // Import createWriteStream lazily to avoid a module-level import that
    // would run in renderer if this module were accidentally bundled there.
    const { createWriteStream } = require('fs') as typeof import('fs')

    const go = (currentUrl: string): void => {
      if (++hops > 10) { reject(new Error(`[self-update] Too many redirects: ${url}`)); return }
      let parsed: URL
      try { parsed = new URL(currentUrl) } catch { reject(new Error(`[self-update] Invalid URL: ${currentUrl}`)); return }
      if (parsed.protocol !== 'https:') {
        reject(new Error(`[self-update] Only HTTPS URLs are permitted (got ${parsed.protocol})`)); return
      }
      const headers: Record<string, string> = {
        'User-Agent': `TachiDesk/${_appVersion()} self-update`,
        'Accept': '*/*',
      }
      const req = httpsGet(
        { host: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search, headers },
        (res) => {
          const code = res.statusCode ?? 0
          if (code >= 300 && code < 400 && res.headers.location) {
            res.resume()
            go(new URL(res.headers.location, currentUrl).toString())
            return
          }
          if (code !== 200) {
            res.resume()
            reject(new Error(`[self-update] HTTP ${code} for ${currentUrl}`))
            return
          }
          const total = parseInt(res.headers['content-length'] ?? '0', 10) || 0
          let received = 0
          let ws: ReturnType<typeof createWriteStream>
          try { ws = createWriteStream(dest, { flags: 'w' }) } catch (err) { reject(err as Error); return }
          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            onProgress?.(received, total)
          })
          res.pipe(ws)
          ws.on('finish', () => ws.close(() => resolve()))
          ws.on('error', reject)
          res.on('error', reject)
        },
      )
      req.setTimeout(60_000, () => { req.destroy(new Error('[self-update] Socket idle timeout')) })
      req.on('error', reject)
      req.end()
    }
    go(url)
  })
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

function _tryUnlink(p: string): void {
  try { if (existsSync(p)) unlinkSync(p) } catch { /* best-effort */ }
}

/** Safe app version string for the User-Agent header. */
function _appVersion(): string {
  try { return app.getVersion() } catch { return 'dev' }
}
