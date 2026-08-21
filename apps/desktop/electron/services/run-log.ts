// apps/desktop/electron/services/run-log.ts
//
// Per-task run log (STEAL 2026-06-21 #2, loop-engineering). One append-only
// JSONL line per completed agent RUN — distinct from cost-ledger (per-LLM-call
// $/tokens): this is "what task ran, on which harness, how it ended, how long".
// The durable record that powers a Recent-Runs panel today and offline session
// mining later. Mirrors cost-ledger's injected path/now shape so it's
// electron-free + unit-testable; getRunLog() is the lazy electron singleton.

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 'incomplete' = the run STOPPED without completing (gave-up classifier,
 * outcome.ts) — previously logged as 'done', which made offline mining count
 * give-ups as successes.
 */
export type RunOutcome = 'done' | 'incomplete' | 'error' | 'abort'

export interface RunLogEntry {
  ts: number
  /** First line / preview of the task prompt (capped). */
  task: string
  harness: string
  workingDir: string
  outcome: RunOutcome
  durationMs: number
  /** Present for outcome 'error' (message) and 'incomplete' (classifier detail). */
  error?: string
}

const DAY_MS = 86_400_000
const RETENTION_DAYS = 90
const TASK_PREVIEW_MAX = 200

export class RunLog {
  private entries: RunLogEntry[] = []
  private loaded = false

  constructor(
    private filePath: string,
    private now: () => number = Date.now,
  ) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.filePath)) return
    const cutoff = this.now() - RETENTION_DAYS * DAY_MS
    let dropped = 0
    try {
      for (const line of readFileSync(this.filePath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const e = JSON.parse(line) as RunLogEntry
          if (typeof e.ts === 'number' && e.ts >= cutoff) this.entries.push(e)
          else dropped++
        } catch { dropped++ }
      }
      if (dropped > 0) {
        writeFileSync(this.filePath, this.entries.map(e => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : ''), 'utf8')
      }
    } catch (e) {
      console.warn('[run-log] could not read/compact the log (starting fresh in memory):', (e as Error).message)
    }
  }

  record(entry: Omit<RunLogEntry, 'ts'>): RunLogEntry {
    this.load()
    const e: RunLogEntry = {
      ts: this.now(),
      ...entry,
      task: (entry.task ?? '').slice(0, TASK_PREVIEW_MAX),
    }
    this.entries.push(e)
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      appendFileSync(this.filePath, JSON.stringify(e) + '\n', 'utf8')
    } catch {
      // Best-effort: a run log that can't persist must never break the run that
      // just finished.
    }
    return e
  }

  /** The last `n` runs, newest first. */
  recent(n = 50): RunLogEntry[] {
    this.load()
    return this.entries.slice(-Math.max(0, n)).reverse()
  }
}

let singleton: RunLog | null = null

/** Electron-coupled accessor — lazy so vitest can import this module. */
export function getRunLog(): RunLog {
  if (!singleton) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('node:path') as typeof import('node:path')
    singleton = new RunLog(join(app.getPath('userData'), 'run-log.jsonl'))
  }
  return singleton
}
