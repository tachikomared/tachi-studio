// apps/desktop/test/unit/runLog.test.ts
//
// Per-task run log (STEAL 2026-06-21 #2, loop-engineering loop-run-log). One
// append-only JSONL line per completed agent run — the durable record the
// cost-ledger (per-LLM-call) doesn't capture: what task ran, on which harness,
// how it ended, how long it took. Mirrors cost-ledger's injected-path/now shape
// so it's electron-free + unit-testable.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunLog } from '../../electron/services/run-log'

const DAY = 86_400_000
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'run-log-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const mk = (nowMs: { t: number }) => new RunLog(join(dir, 'run-log.jsonl'), () => nowMs.t)

describe('RunLog.record', () => {
  it('appends one parseable JSONL line and stamps ts', () => {
    const now = { t: 1_000_000 }
    const log = mk(now)
    const e = log.record({ task: 'fix the bug', harness: 'tachi', workingDir: '/repo', outcome: 'done', durationMs: 4200 })
    expect(e.ts).toBe(1_000_000)
    const lines = readFileSync(join(dir, 'run-log.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ task: 'fix the bug', harness: 'tachi', outcome: 'done', durationMs: 4200 })
  })

  it('caps the task preview so a huge prompt cannot bloat the log', () => {
    const e = mk({ t: 1 }).record({ task: 'x'.repeat(500), harness: 'tachi', workingDir: '/r', outcome: 'done', durationMs: 1 })
    expect(e.task.length).toBeLessThanOrEqual(200)
  })

  it("records an ENDED-INCOMPLETE give-up as 'incomplete', not 'done', with the classifier detail", () => {
    // Live-found (batch16 verify, M6): the durable line for a give-up said
    // outcome:"done" — offline mining would count it as a success.
    const now = { t: 42 }
    mk(now).record({
      task: 'fix the typo', harness: 'tachi', workingDir: '/r',
      outcome: 'incomplete', durationMs: 7,
      error: 'no-completion: the task asked for a change, but the run made none',
    })
    const back = mk(now).recent(1)[0]!
    expect(back.outcome).toBe('incomplete')
    expect(back.error).toContain('no-completion')
  })
})

describe('RunLog.recent', () => {
  it('returns the last n entries newest-first', () => {
    const now = { t: 0 }
    const log = mk(now)
    for (let i = 0; i < 5; i++) { now.t = i; log.record({ task: `t${i}`, harness: 'tachi', workingDir: '/r', outcome: 'done', durationMs: 1 }) }
    const recent = log.recent(3)
    expect(recent.map(r => r.task)).toEqual(['t4', 't3', 't2'])
  })
  it('returns [] for an empty log and tolerates n larger than size', () => {
    const log = mk({ t: 1 })
    expect(log.recent(10)).toEqual([])
    log.record({ task: 'only', harness: 'tachi', workingDir: '/r', outcome: 'error', durationMs: 1, error: 'boom' })
    expect(log.recent(10)).toHaveLength(1)
    expect(log.recent(10)[0]!.error).toBe('boom')
  })
})

describe('RunLog persistence + retention', () => {
  it('a new instance over the same file sees prior entries', () => {
    const now = { t: 5 * DAY }
    mk(now).record({ task: 'first', harness: 'tachi', workingDir: '/r', outcome: 'done', durationMs: 1 })
    expect(mk(now).recent(10).map(r => r.task)).toEqual(['first'])
  })
  it('drops entries older than the retention window on load', () => {
    const now = { t: 100 * DAY }
    const old = new RunLog(join(dir, 'run-log.jsonl'), () => 1 * DAY) // recorded long ago
    old.record({ task: 'ancient', harness: 'tachi', workingDir: '/r', outcome: 'done', durationMs: 1 })
    // A fresh instance "now" (100d later) must not surface the 99d-old entry.
    expect(mk(now).recent(10)).toEqual([])
  })
})

describe('RunLog robustness', () => {
  it('tolerates a garbage line without throwing', () => {
    const fp = join(dir, 'run-log.jsonl')
    mk({ t: 1 }).record({ task: 'good', harness: 'tachi', workingDir: '/r', outcome: 'done', durationMs: 1 })
    // append a corrupt line directly
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    appendFileSync(fp, 'not json\n')
    expect(mk({ t: 1 }).recent(10).map(r => r.task)).toEqual(['good'])
  })
  it('never throws when the path is unwritable (best-effort persistence)', () => {
    const log = new RunLog(join(dir, 'no\0pe', 'x.jsonl'))
    expect(() => log.record({ task: 't', harness: 'tachi', workingDir: '/r', outcome: 'done', durationMs: 1 })).not.toThrow()
  })
  it('does not create the file until something is recorded', () => {
    mk({ t: 1 })
    expect(existsSync(join(dir, 'run-log.jsonl'))).toBe(false)
  })
})
