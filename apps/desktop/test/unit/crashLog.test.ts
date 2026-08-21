// apps/desktop/test/unit/crashLog.test.ts
//
// Crash telemetry (userData/logs/crash.jsonl) — pure helpers only: entry
// shaping, the never-throws JSON-line formatter, the rotation predicate, and
// the path-injected append+rotate writer. The electron wiring
// (installCrashTelemetry / watchWebContentsHealth) is type-only here and
// exercised by the app itself.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  makeCrashEntry,
  formatCrashLine,
  shouldRotate,
  appendCrashLine,
  CRASH_LOG_MAX_BYTES,
  CRASH_LOG_OLD_SUFFIX,
  type CrashLogEntry,
} from '../../electron/services/crash-log'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crash-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('makeCrashEntry', () => {
  it('stamps ISO timestamp, pid and uptime from injected meta', () => {
    const entry = makeCrashEntry(
      'render-process-gone',
      { reason: 'oom', exitCode: -1 },
      { now: new Date('2026-07-11T12:00:00.000Z'), pid: 4242, uptimeS: 77 },
    )
    expect(entry).toEqual({
      ts: '2026-07-11T12:00:00.000Z',
      kind: 'render-process-gone',
      pid: 4242,
      uptimeS: 77,
      detail: { reason: 'oom', exitCode: -1 },
    })
  })

  it('defaults to the live process pid/uptime and a parseable ISO ts', () => {
    const entry = makeCrashEntry('before-quit', {})
    expect(entry.pid).toBe(process.pid)
    expect(entry.uptimeS).toBeGreaterThanOrEqual(0)
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false)
  })
})

describe('formatCrashLine', () => {
  it('produces exactly one newline-terminated JSON line that round-trips', () => {
    const line = formatCrashLine(
      makeCrashEntry('child-process-gone', { type: 'GPU', reason: 'crashed', exitCode: 5 }),
    )
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd()).not.toContain('\n') // stays a single JSONL record
    const parsed = JSON.parse(line) as CrashLogEntry
    expect(parsed.kind).toBe('child-process-gone')
    expect(parsed.detail).toMatchObject({ type: 'GPU', reason: 'crashed', exitCode: 5 })
  })

  it('serializes Error objects (multi-line stacks stay on one JSONL line)', () => {
    const err = new Error('boom')
    const line = formatCrashLine(makeCrashEntry('uncaught-exception', { origin: 'uncaughtException', error: err }))
    expect(line.trimEnd()).not.toContain('\n')
    const parsed = JSON.parse(line)
    expect(parsed.detail.error.name).toBe('Error')
    expect(parsed.detail.error.message).toBe('boom')
    expect(typeof parsed.detail.error.stack).toBe('string')
  })

  it('survives circular details instead of throwing', () => {
    const detail: Record<string, unknown> = { reason: 'killed' }
    detail.self = detail
    const line = formatCrashLine(makeCrashEntry('unhandled-rejection', { reason: detail }))
    const parsed = JSON.parse(line)
    expect(parsed.detail.reason.self).toBe('[circular]')
    expect(parsed.detail.reason.reason).toBe('killed')
  })

  it('survives bigints and functions (plain JSON.stringify would throw / drop)', () => {
    const line = formatCrashLine(
      makeCrashEntry('unhandled-rejection', { big: BigInt(9), fn: () => 1 }),
    )
    const parsed = JSON.parse(line)
    expect(parsed.detail.big).toBe('9n')
    expect(parsed.detail.fn).toBe('[function]')
  })

  it('degrades to a fallback line when the entry is fundamentally unserializable', () => {
    const evil: Record<string, unknown> = {}
    Object.defineProperty(evil, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter explodes mid-stringify')
      },
    })
    const entry = makeCrashEntry('uncaught-exception', evil, { pid: 7 })
    let line = ''
    expect(() => {
      line = formatCrashLine(entry)
    }).not.toThrow()
    const parsed = JSON.parse(line)
    expect(parsed.kind).toBe('uncaught-exception')
    expect(parsed.pid).toBe(7)
    expect(parsed.detail.note).toMatch(/not serializable/)
  })
})

describe('shouldRotate', () => {
  it('is false below the cap, true at and above it', () => {
    expect(shouldRotate(CRASH_LOG_MAX_BYTES - 1)).toBe(false)
    expect(shouldRotate(CRASH_LOG_MAX_BYTES)).toBe(true)
    expect(shouldRotate(CRASH_LOG_MAX_BYTES + 1)).toBe(true)
  })

  it('respects an explicit cap and never rotates on a nonsense cap', () => {
    expect(shouldRotate(100, 100)).toBe(true)
    expect(shouldRotate(99, 100)).toBe(false)
    expect(shouldRotate(100, 0)).toBe(false)
    expect(shouldRotate(100, -5)).toBe(false)
  })

  it('rotates at 1 MB per the spec', () => {
    expect(CRASH_LOG_MAX_BYTES).toBe(1024 * 1024)
  })
})

describe('appendCrashLine', () => {
  it('creates the logs directory on first write and appends lines in order', () => {
    const file = join(dir, 'logs', 'crash.jsonl')
    appendCrashLine(file, '{"n":1}\n')
    appendCrashLine(file, '{"n":2}\n')
    expect(readFileSync(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n')
  })

  it('rotates to exactly one .old once the cap is reached', () => {
    const file = join(dir, 'crash.jsonl')
    const old = file + CRASH_LOG_OLD_SUFFIX
    writeFileSync(file, 'x'.repeat(50)) // already at a 50-byte cap
    appendCrashLine(file, '{"n":1}\n', 50)
    expect(readFileSync(old, 'utf8')).toBe('x'.repeat(50))
    expect(readFileSync(file, 'utf8')).toBe('{"n":1}\n') // fresh file, new line only
  })

  it('keeps only the latest .old generation across repeated rotations', () => {
    const file = join(dir, 'crash.jsonl')
    const old = file + CRASH_LOG_OLD_SUFFIX
    writeFileSync(file, 'gen1'.repeat(5)) // 20 bytes ≥ cap of 10
    appendCrashLine(file, 'A\n', 10) // rotation #1: gen1 → .old
    writeFileSync(file, 'gen2'.repeat(5))
    appendCrashLine(file, 'B\n', 10) // rotation #2: gen2 replaces gen1 in .old
    expect(readFileSync(old, 'utf8')).toBe('gen2'.repeat(5))
    expect(readFileSync(file, 'utf8')).toBe('B\n')
  })

  it('does not rotate below the cap', () => {
    const file = join(dir, 'crash.jsonl')
    writeFileSync(file, 'small')
    appendCrashLine(file, '{"n":1}\n', 1024)
    expect(existsSync(file + CRASH_LOG_OLD_SUFFIX)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('small{"n":1}\n')
  })

  it('never throws on an unwritable path (parent is a file, not a dir)', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'i am a file')
    const impossible = join(blocker, 'nested', 'crash.jsonl')
    expect(() => appendCrashLine(impossible, '{"n":1}\n')).not.toThrow()
    expect(readFileSync(blocker, 'utf8')).toBe('i am a file') // untouched
  })
})
