// apps/desktop/electron/services/codex-run-log.ts
//
// In-memory journal of Codex worker runs, surfaced as the CODEX tab in the
// in-app Console dock (the user asked: codex activity must be visible in OUR
// console, not a hidden child process). Bounded ring buffer + live push to
// every window; nothing persisted — it is a session activity feed, not a log
// file (codex keeps its own logs under CODEX_HOME).

import { BrowserWindow } from 'electron'

export interface CodexLogLine {
  at: number
  /** Short per-run id — groups lines of one exec/resume invocation. */
  runId: string
  kind: 'start' | 'progress' | 'answer' | 'error' | 'exit'
  text: string
}

const MAX_LINES = 600
const lines: CodexLogLine[] = []

export function recordCodexLog(line: Omit<CodexLogLine, 'at'>): void {
  const full: CodexLogLine = { at: Date.now(), ...line }
  lines.push(full)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
      w.webContents.send('codex:log-event', full)
    }
  }
}

export function getCodexLog(): CodexLogLine[] {
  return lines.slice()
}
