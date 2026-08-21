// apps/desktop/electron/services/util/kill-tree.ts
//
// STOP MEANS THE GPU STOPS.
//
// Driver finding: a 70-minute Wan render had no cancel affordance at all — the
// owner watched sd-cli hold the GPU at 95% and could only reach for Task
// Manager. Adding a Stop button is only honest if the kill actually lands, and
// on Windows `proc.kill()` signals the process we spawned while any child it
// started keeps running (sd-cli itself is a single process today, but the same
// call is what a future sd-server wrapper would need).
//
// The three private copies of this in the repo (tachi/tools.ts killTree +
// bgKillTree, codex-app-server.ts killTree) are left alone deliberately — this
// is the shared, INJECTABLE one, so the kill path can be pinned by a test
// instead of by "trust me, taskkill works".

import { spawn } from 'child_process'

/** The slice of ChildProcess this needs — so a test can pass a plain object. */
export interface KillableProcess {
  pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface KillTreeDeps {
  platform?: NodeJS.Platform
  /** How a helper process is launched (Windows `taskkill`). */
  spawnFn?:  (cmd: string, args: string[], opts: { windowsHide: boolean }) => unknown
  /** POSIX group kill (`process.kill(-pid, sig)`). */
  killPid?:  (pid: number, signal: NodeJS.Signals) => void
}

/**
 * Kill the whole tree rooted at `proc`. Returns true when a kill was ISSUED —
 * not a promise that the process is already gone; the caller learns that from
 * the child's own `close` event, which is the only authority on it.
 *
 * Never throws: a process that died on its own between the check and the call
 * is the normal race, and it must not turn a Stop click into an error dialog.
 */
export function killProcessTree(proc: KillableProcess | null | undefined, deps: KillTreeDeps = {}): boolean {
  if (!proc) return false
  const platform = deps.platform ?? process.platform
  const spawnFn  = deps.spawnFn  ?? ((cmd: string, args: string[], opts: { windowsHide: boolean }) => spawn(cmd, args, opts))
  const killPid  = deps.killPid  ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal) })

  const pid = proc.pid
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    // Already reaped (or never spawned): the bare kill is the only thing left,
    // and it is allowed to be a no-op.
    try { return proc.kill() } catch { return false }
  }

  if (platform === 'win32') {
    // /T = the tree, /F = force. Windows has no process groups to signal.
    try { spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); return true }
    catch { /* fall through to the direct kill below */ }
    try { return proc.kill('SIGKILL') } catch { return false }
  }

  // POSIX: a negative pid signals the whole group (the spawn must be detached
  // for that to reach grandchildren). Fall back to the bare child.
  try { killPid(-pid, 'SIGKILL'); return true }
  catch {
    try { return proc.kill('SIGKILL') } catch { return false }
  }
}
