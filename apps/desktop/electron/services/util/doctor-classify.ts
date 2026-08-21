// apps/desktop/electron/services/util/doctor-classify.ts
//
// Pure classification for the app-wide `doctor` health probe (STEAL 2026-07-07,
// Agent-Reach probe.py): a probe EXECUTES each external binary instead of
// checking existence, because "file exists" misses the whole broken class —
// mangled resolver paths, missing DLLs, dead shebangs. Five states:
//
//   ok      — executed, exit code accepted
//   missing — binary not found (resolver null / spawn ENOENT)
//   broken  — found but cannot run: EACCES/EPERM, exit 126/127 (shell's
//             not-executable/not-found), or a Windows NTSTATUS crash code
//             (>= 0xC0000000, e.g. 0xC0000135 STATUS_DLL_NOT_FOUND)
//   timeout — started but didn't finish inside the probe window
//   error   — executed but exited with an unexpected code
//
// Kept dependency-free (no electron) so it unit-tests in isolation.

export type DoctorStatus = 'ok' | 'missing' | 'broken' | 'timeout' | 'error'

export interface DoctorEntry {
  id:      string
  label:   string
  status:  DoctorStatus
  /** Resolved binary path or probed URL (absent when missing). */
  path?:   string
  /** One human line: version string, error reason, or exit code. */
  detail:  string
  /** Probe wall time in ms. */
  ms:      number
}

const NTSTATUS_ERROR_FLOOR = 0xC0000000 // Windows crash-class exit codes

export function classifyExit(exitCode: number, okExitCodes: number[] = [0]): DoctorStatus {
  if (okExitCodes.includes(exitCode)) return 'ok'
  if (exitCode === 126 || exitCode === 127) return 'broken'
  // Windows reports NTSTATUS crashes either unsigned (3221225781) or as the
  // signed 32-bit equivalent (-1073741515) depending on the API layer.
  const unsigned = exitCode < 0 ? exitCode + 0x100000000 : exitCode
  if (unsigned >= NTSTATUS_ERROR_FLOOR) return 'broken'
  return 'error'
}

/** Map a child_process spawn/exec error to a status, or null if it carries an exit code. */
export function classifySpawnError(err: { code?: string | number | null; killed?: boolean; signal?: string | null }): DoctorStatus | null {
  if (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') return 'timeout'
  if (err.code === 'ENOENT') return 'missing'
  if (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'UNKNOWN') return 'broken'
  if (typeof err.code === 'number') return null // real exit code — classifyExit decides
  return 'error'
}

/** First non-empty output line, truncated — the "version" a probe reports. */
export function pickDetailLine(stdout: string, stderr: string, max = 100): string {
  const line = `${stdout}\n${stderr}`.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
