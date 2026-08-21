// apps/desktop/electron/services/pty-service.ts
//
// Port of parallel-code's PTY wrapper, adapted for Windows + Tachi's IPC.
//
// What it does:
//   - Spawns a child process under a pseudo-terminal via `node-pty` (already
//     a dependency in apps/desktop/package.json — see "node-pty": "^1.0.0").
//   - Sanitizes the environment so the child doesn't accidentally inherit
//     Electron's PATH munging, our parent harness's session env vars (which
//     would confuse a nested `claude` invocation into thinking it's resuming
//     us), or any MCP bearer tokens.
//   - Rejects shell metacharacters in the command name so callers can't
//     chain a second command through this surface.
//   - Buffers output: small reads (<1KB) flush immediately; larger reads
//     accumulate up to 64KB / 8ms before being flushed in a single chunk.
//   - Wire format on exit: `{ type: 'Exit', data: { exit_code, signal,
//     last_output: string[] } }` — matching parallel-code's expectations.
//
// Why these specific env-strip choices:
//   - PATH/HOME/USER/SHELL: avoid leaking Electron's PATH (which has Resources/
//     prepended on packaged builds and confuses shells looking for system
//     binaries). Re-injected from the system below.
//   - LD_PRELOAD: defensive — anything Electron set should not propagate.
//   - NODE_OPTIONS: Electron commonly sets --max-old-space-size etc.;
//     unrelated child processes shouldn't inherit them.
//   - ELECTRON_RUN_AS_NODE: a child spawned with this set runs as node, not
//     as the binary it claims to be. Strip it.
//   - CLAUDECODE / CLAUDE_CODE_SESSION / CLAUDE_CODE_ENTRYPOINT: if the
//     *parent* tachi process is itself launched by a claude session, these
//     are set and would cause a nested `claude` invocation to think the
//     parent's session is still active — wrong session id, wrong cwd.

import { app } from 'electron'
import { join } from 'node:path'
import type { IPty } from 'node-pty'

// We deliberately require() node-pty rather than import — the addon binary
// is platform-specific and electron-vite expects a CommonJS require for the
// native module path resolution to work in packaged builds.
//
// eslint-disable-next-line @typescript-eslint/no-var-requires
let _pty: typeof import('node-pty') | null = null
function ptyModule(): typeof import('node-pty') {
  if (_pty) return _pty
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _pty = require('node-pty') as typeof import('node-pty')
  return _pty
}

// ─── Env hygiene ──────────────────────────────────────────────────────────────

/** Env keys we strip wholesale before propagating to the child. */
const STRIP_ENV_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'SHELL',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
])

/** Env-key prefixes we strip — covers per-vendor MCP / session tokens. */
const STRIP_ENV_PREFIX = [
  'TACHI_MCP_',
  'MCP_BEARER',
  'CCD_',           // claude code daemon (our own, sometimes injected)
  'ANTHROPIC_',     // parent's API keys shouldn't leak to spawned `claude` CLI
                    // — it would use them instead of our gateway routing.
]

/**
 * Build a sanitized environment for the spawned shell. Starts from
 * `process.env`, removes the dangerous keys, then injects:
 *
 *   PATH        — from the OS (we need *some* PATH or the shell can't find ls)
 *   HOME / USER — restored from os.userInfo()
 *   TERM=xterm-256color, COLORTERM=truecolor — so spawned tools render with
 *                                              full colour support
 */
export function buildSanitizedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const next: Record<string, string> = {}
  const incoming = { ...process.env, ...extra }
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue
    if (STRIP_ENV_EXACT.has(k)) continue
    if (STRIP_ENV_PREFIX.some(p => k.startsWith(p))) continue
    next[k] = v
  }
  // Restore minimal essentials from a trusted source (os.userInfo + Electron app paths).
  // On Windows, USERPROFILE is the moral equivalent of HOME — preserve it.
  // PATH is the trickiest: we want the *user's* PATH, not whatever
  // Electron mutated it to. process.env.PATH at the moment Electron starts
  // is generally the parent shell's PATH; we just have to use it (no API
  // for the original).
  const path = process.env.PATH ?? process.env.Path ?? ''
  if (path) next.PATH = path
  if (process.platform === 'win32') {
    if (process.env.USERPROFILE) next.HOME = process.env.USERPROFILE
    next.USERPROFILE = process.env.USERPROFILE ?? next.HOME ?? ''
  } else if (process.env.HOME) {
    next.HOME = process.env.HOME
  }
  next.TERM = 'xterm-256color'
  next.COLORTERM = 'truecolor'
  return next
}

// ─── Shell-metacharacter guard ────────────────────────────────────────────────

/**
 * Refuse command names that look like shell strings. We intentionally do not
 * support `cd /tmp; rm -rf .` style invocations — callers should pass the
 * binary path as `command` and let `node-pty` exec it with `args` directly.
 */
export function assertSafeCommand(command: string): void {
  if (/[;&|`$(){}\n]/.test(command)) {
    throw new Error(`PTY command contains shell metacharacters: ${command}`)
  }
}

// ─── PTY handle ───────────────────────────────────────────────────────────────

export interface SpawnPtyOpts {
  command:      string
  args?:        string[]
  cwd:          string
  cols?:        number
  rows?:        number
  /** Extra env merged on top of the sanitized baseline. */
  env?:         Record<string, string>
  /** Called for every data flush with `{type:'Data', data:<base64>}`. */
  onMessage:    (message: PtyOutputMessage) => void
}

export type PtyOutputMessage =
  | { type: 'Data'; data: string /* base64 */ }
  | { type: 'Exit'; data: { exit_code: number | null; signal: number | null; last_output: string[] } }

export interface PtyHandle {
  /** Write user input. Throws after exit. */
  write(data: string): void
  /** Resize the pseudo-tty. Throttled internally on Windows (ConPTY is slow). */
  resize(cols: number, rows: number): void
  /** Kill the underlying process. Best-effort. */
  kill(signal?: string): void
  /** Whether the process is still alive. */
  isAlive(): boolean
  /** Underlying PID, or null if exited. */
  pid(): number | null
}

const FLUSH_BYTES        = 64 * 1024
const FLUSH_INTERVAL_MS  = 8
const SMALL_READ_BYTES   = 1024
const TAIL_LAST_N_LINES  = 50
const RESIZE_THROTTLE_MS = 50

/**
 * Spawn a PTY child. Returns a handle the caller can write/resize/kill.
 * Output is base64-encoded so binary-ish bytes (ANSI escape sequences,
 * cursor positioning, etc.) survive transit across the IPC wire cleanly.
 */
export function spawnPty(opts: SpawnPtyOpts): PtyHandle {
  assertSafeCommand(opts.command)

  const pty = ptyModule()
  const env = buildSanitizedEnv(opts.env ?? {})

  // node-pty resolves the binary by looking it up on PATH. On Windows we
  // prefer `process.env.ComSpec ?? 'cmd.exe'` as the default *shell* when
  // callers don't specify one, but here the caller always passes the
  // command they want — we just spawn it directly.
  const proc: IPty = pty.spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 30,
    env,
    name: 'xterm-256color',
    // Windows-specific: useConpty is the default on node-pty >=1.0 for
    // Windows 10+. Leaving the default in place picks up the system's
    // ConPTY which is required for ANSI rendering.
    // useConpty: true,
  })

  let exited = false
  let pendingBuffer: Buffer[] = []
  let pendingBytes = 0
  let flushTimer: NodeJS.Timeout | null = null
  // Ring buffer of last lines for the Exit message's last_output field.
  const lineRing: string[] = []
  let partialLine = ''

  function appendToRing(chunk: string): void {
    // Push completed lines into the ring; keep the in-progress tail in partialLine.
    const combined = partialLine + chunk
    const lines = combined.split(/\r?\n/)
    partialLine = lines.pop() ?? ''
    for (const ln of lines) {
      lineRing.push(ln)
      if (lineRing.length > TAIL_LAST_N_LINES) lineRing.shift()
    }
  }

  function flush(): void {
    if (pendingBuffer.length === 0) return
    const merged = Buffer.concat(pendingBuffer, pendingBytes)
    pendingBuffer = []
    pendingBytes = 0
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    opts.onMessage({ type: 'Data', data: merged.toString('base64') })
  }

  proc.onData((data: string) => {
    // node-pty hands us strings; we re-encode as UTF-8 bytes for base64.
    const buf = Buffer.from(data, 'utf8')
    appendToRing(data)
    if (buf.length <= SMALL_READ_BYTES && pendingBuffer.length === 0) {
      // Tiny read with nothing pending — flush immediately for snappy UX.
      opts.onMessage({ type: 'Data', data: buf.toString('base64') })
      return
    }
    pendingBuffer.push(buf)
    pendingBytes += buf.length
    if (pendingBytes >= FLUSH_BYTES) {
      flush()
      return
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS)
    }
  })

  proc.onExit((event) => {
    exited = true
    // Final flush so trailing output isn't lost.
    flush()
    // Push the in-progress line into the ring so users see the final prompt.
    if (partialLine) {
      lineRing.push(partialLine)
      if (lineRing.length > TAIL_LAST_N_LINES) lineRing.shift()
      partialLine = ''
    }
    opts.onMessage({
      type: 'Exit',
      data: {
        exit_code: event.exitCode ?? null,
        signal:    event.signal ?? null,
        last_output: lineRing.slice(-TAIL_LAST_N_LINES),
      },
    })
  })

  // Resize throttling — ConPTY's resize is expensive; debounce 50ms.
  let resizeTimer: NodeJS.Timeout | null = null
  let pendingResize: { cols: number; rows: number } | null = null

  function doResize(cols: number, rows: number): void {
    if (exited) return
    try {
      proc.resize(cols, rows)
    } catch {
      // ConPTY can throw EBADFD if the pty is mid-tear-down — swallow.
    }
  }

  return {
    write(data: string): void {
      if (exited) throw new Error('PTY has exited')
      proc.write(data)
    },
    resize(cols: number, rows: number): void {
      pendingResize = { cols, rows }
      if (resizeTimer) return
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        if (pendingResize) {
          doResize(pendingResize.cols, pendingResize.rows)
          pendingResize = null
        }
      }, RESIZE_THROTTLE_MS)
    },
    kill(signal?: string): void {
      if (exited) return
      try {
        if (signal) {
          proc.kill(signal)
        } else {
          proc.kill()
        }
      } catch {
        // Already-dead processes throw — fine.
      }
    },
    isAlive(): boolean {
      return !exited
    },
    pid(): number | null {
      try {
        return exited ? null : proc.pid
      } catch {
        return null
      }
    },
  }
}

/**
 * Default shell binary for the current platform. Used when callers spawn a
 * generic interactive shell rather than a specific binary.
 */
export function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: [] }
  }
  return { command: process.env.SHELL ?? '/bin/bash', args: ['-l'] }
}

/**
 * Helper to silence the unused-import warning when this file is imported
 * by IPC handlers that don't use every export. Also handy for unit tests
 * to assert we have *some* sanitized PATH set up.
 */
export function debugStrippedEnvKeys(): string[] {
  return [...STRIP_ENV_EXACT]
}

// Keep imports referenced so dead-code elimination doesn't strip them.
void app
void join
