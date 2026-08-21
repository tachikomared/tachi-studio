// apps/desktop/electron/services/util/install-lock.ts
//
// Single-instance guard for sidecar binary installs.
//
// Two-layer protection:
//   1. Module-level in-flight singleton (Promise reuse) — covers the common case
//      where two IPC calls arrive in the same process within milliseconds.
//   2. Lockfile in userData — covers the edge case where two Electron windows
//      (or a crash-restart) try to concurrently install the same binary.
//      The lockfile holds the PID of the installing process; a stale lock
//      (PID no longer running) is treated as expired.
//
// Pattern: main-side module singleton + lockfile, analogous to how nocodb /
// Open-Generative-AI guard their native inference builds.  We do NOT use
// localStorage (renderer-side) — this is main-process only.

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

// Module-level registry of in-flight install promises (keyed by a lock name).
const _inFlight = new Map<string, Promise<void>>()

// ─── Lockfile helpers ─────────────────────────────────────────────────────────

function lockDir(): string {
  const d = join(app.getPath('userData'), 'install-locks')
  mkdirSync(d, { recursive: true })
  return d
}

function lockPath(name: string): string {
  return join(lockDir(), `${name}.lock`)
}

/**
 * Write a lockfile containing the current PID.
 * Best-effort: any write failure is silently ignored (we still hold the
 * in-process singleton, which is the stronger guard).
 */
function acquireLockfile(name: string): void {
  try { writeFileSync(lockPath(name), String(process.pid), { encoding: 'utf8' }) } catch { /* ignore */ }
}

/**
 * Remove the lockfile.  Best-effort.
 */
function releaseLockfile(name: string): void {
  try { unlinkSync(lockPath(name)) } catch { /* ignore */ }
}

/**
 * True when the lockfile exists AND the PID it contains is still running.
 * A stale lock (dead PID, leftover from a crash) is treated as "not locked".
 */
function isLockfileActive(name: string): boolean {
  const p = lockPath(name)
  if (!existsSync(p)) return false
  try {
    const pid = parseInt(readFileSync(p, 'utf8').trim(), 10)
    if (!pid) return false
    // `kill(pid, 0)` throws when the process does not exist; otherwise it's alive.
    process.kill(pid, 0)
    return true
  } catch {
    // Either the PID is gone or readFile failed — treat as stale.
    try { unlinkSync(p) } catch { /* best-effort cleanup */ }
    return false
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run `fn` at most once at a time for the given `name`.
 *
 * - If `fn` is already running in THIS process, returns the existing Promise.
 * - If the lockfile indicates another process is installing, waits up to
 *   `lockTimeoutMs` (default 5 min) for the lock to clear, then runs.
 * - Releases all locks when `fn` settles.
 *
 * Usage:
 *   await withInstallLock('sd-cpp-binary', () => _doInstallBinary(win))
 */
export function withInstallLock(
  name: string,
  fn: () => Promise<void>,
  lockTimeoutMs = 5 * 60 * 1000,
): Promise<void> {
  // 1. Module-level singleton: return existing in-flight promise if present.
  const existing = _inFlight.get(name)
  if (existing) return existing

  // 2. Lockfile check: another process may be installing.
  const p = _withLockfile(name, fn, lockTimeoutMs).finally(() => {
    _inFlight.delete(name)
  })

  _inFlight.set(name, p)
  return p
}

async function _withLockfile(
  name: string,
  fn: () => Promise<void>,
  lockTimeoutMs: number,
): Promise<void> {
  // Wait for a foreign lockfile to clear, polling every 500 ms.
  if (isLockfileActive(name)) {
    const deadline = Date.now() + lockTimeoutMs
    while (isLockfileActive(name)) {
      if (Date.now() > deadline) {
        // Stale lock that somehow survived — force-clear and proceed.
        releaseLockfile(name)
        break
      }
      await new Promise<void>(r => setTimeout(r, 500))
    }
  }

  acquireLockfile(name)
  try {
    await fn()
  } finally {
    releaseLockfile(name)
  }
}
