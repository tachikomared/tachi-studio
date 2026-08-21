import { app } from 'electron'
import { join } from 'path'
import { appendFileSync, mkdirSync } from 'fs'
import { makeLogEvent, LogLevel, LogCategory } from '@tachi/core'

let winRef: Electron.BrowserWindow | null = null
// LAZY for the same reason as keychain's keysFile: an import-time read happens
// before portable-mode can redirect userData, and a portable install would have
// scattered logs into the user profile.
const logsDir = (): string => join(app.getPath('userData'), 'logs')

export function initLogService(win: Electron.BrowserWindow) {
  winRef = win
  mkdirSync(logsDir(), { recursive: true })
}

export function log(level: LogLevel, category: LogCategory, message: string, details?: Record<string, unknown>) {
  const event = makeLogEvent(level, category, message, details)
  const date = event.ts.slice(0, 10)
  const logFile = join(logsDir(), `${date}.jsonl`)
  try { appendFileSync(logFile, JSON.stringify(event) + '\n') } catch { /* disk full etc */ }
  winRef?.webContents.send('logs:event', event)
}
