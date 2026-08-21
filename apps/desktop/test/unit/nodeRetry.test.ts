// apps/desktop/test/unit/nodeRetry.test.ts
//
// Unit tests for the PURE per-node RETRY policy + attempt loop
// (src/pages/nodes/retryPolicy.ts) — NODES-RESEARCH "retry on fail".
//
// Two surfaces:
//   1. clamp/validate — a node's untyped data → an in-range RetryPolicy, plus the
//      shouldRetry() loop-decision helper.
//   2. runWithRetry() — the injected-runner harness: a fake runner that fails N
//      times then succeeds, with a fake sleep, proving attempts/delay/progress.
//
// Pure module (no xyflow / React / store / real timers), so it runs in the plain
// node environment.

import { describe, it, expect, vi } from 'vitest'
import {
  MAX_RETRIES,
  DEFAULT_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  clampRetries,
  clampDelay,
  retryPolicy,
  hasRetry,
  shouldRetry,
  runWithRetry,
  type AttemptOutcome,
} from '../../src/pages/nodes/retryPolicy'

// ── clampRetries ────────────────────────────────────────────────────────────────

describe('clampRetries', () => {
  it('absent / invalid → 0', () => {
    expect(clampRetries(undefined)).toBe(0)
    expect(clampRetries(null)).toBe(0)
    expect(clampRetries('')).toBe(0)
    expect(clampRetries('abc')).toBe(0)
    expect(clampRetries(NaN)).toBe(0)
    expect(clampRetries({})).toBe(0)
  })

  it('clamps into [0, MAX_RETRIES]', () => {
    expect(clampRetries(-5)).toBe(0)
    expect(clampRetries(0)).toBe(0)
    expect(clampRetries(2)).toBe(2)
    expect(clampRetries(3)).toBe(MAX_RETRIES)
    expect(clampRetries(99)).toBe(MAX_RETRIES)
  })

  it('floors fractional + parses numeric strings', () => {
    expect(clampRetries(2.9)).toBe(2)
    expect(clampRetries('2')).toBe(2)
    expect(clampRetries(' 3 ')).toBe(3)
  })
})

// ── clampDelay ──────────────────────────────────────────────────────────────────

describe('clampDelay', () => {
  it('absent / invalid → default', () => {
    expect(clampDelay(undefined)).toBe(DEFAULT_RETRY_DELAY_MS)
    expect(clampDelay(null)).toBe(DEFAULT_RETRY_DELAY_MS)
    expect(clampDelay('')).toBe(DEFAULT_RETRY_DELAY_MS)
    expect(clampDelay('xyz')).toBe(DEFAULT_RETRY_DELAY_MS)
  })

  it('clamps into [0, MAX_RETRY_DELAY_MS]', () => {
    expect(clampDelay(-100)).toBe(0)
    expect(clampDelay(0)).toBe(0)
    expect(clampDelay(500)).toBe(500)
    expect(clampDelay(999999)).toBe(MAX_RETRY_DELAY_MS)
  })

  it('floors fractional + parses numeric strings', () => {
    expect(clampDelay(1500.7)).toBe(1500)
    expect(clampDelay('2000')).toBe(2000)
  })
})

// ── retryPolicy ─────────────────────────────────────────────────────────────────

describe('retryPolicy', () => {
  it('empty / nullish data → default policy (retries 0, default delay)', () => {
    expect(retryPolicy(undefined)).toEqual({ retries: 0, retryDelayMs: DEFAULT_RETRY_DELAY_MS })
    expect(retryPolicy(null)).toEqual({ retries: 0, retryDelayMs: DEFAULT_RETRY_DELAY_MS })
    expect(retryPolicy({})).toEqual({ retries: 0, retryDelayMs: DEFAULT_RETRY_DELAY_MS })
  })

  it('reads + clamps both fields off node data', () => {
    expect(retryPolicy({ retries: 2, retryDelayMs: 800 })).toEqual({ retries: 2, retryDelayMs: 800 })
    expect(retryPolicy({ retries: 99, retryDelayMs: -1 })).toEqual({ retries: MAX_RETRIES, retryDelayMs: 0 })
  })

  it('hasRetry reflects a positive clamped retries', () => {
    expect(hasRetry({ retries: 0 })).toBe(false)
    expect(hasRetry({})).toBe(false)
    expect(hasRetry({ retries: 1 })).toBe(true)
    expect(hasRetry({ retries: -3 })).toBe(false)
  })
})

// ── shouldRetry ─────────────────────────────────────────────────────────────────

describe('shouldRetry', () => {
  it('retries=0 never retries', () => {
    expect(shouldRetry(1, 0)).toBe(false)
  })

  it('retries=2 retries after attempts 1 and 2, stops after 3', () => {
    expect(shouldRetry(1, 2)).toBe(true)
    expect(shouldRetry(2, 2)).toBe(true)
    expect(shouldRetry(3, 2)).toBe(false) // total attempts = 3, no more
  })

  it('is defensive against non-finite / negative inputs', () => {
    expect(shouldRetry(NaN, 2)).toBe(false)
    expect(shouldRetry(1, NaN)).toBe(false)
    expect(shouldRetry(1, -1)).toBe(false)
  })
})

// ── runWithRetry (injected-runner harness) ────────────────────────────────────

/** A fake runner that fails `failTimes` then succeeds; records each attempt no. */
function flakyRunner(failTimes: number) {
  const attemptsSeen: number[] = []
  const run = async (attempt: number): Promise<AttemptOutcome<string>> => {
    attemptsSeen.push(attempt)
    if (attempt <= failTimes) return { ok: false, value: `err-${attempt}` }
    return { ok: true, value: `ok-${attempt}` }
  }
  return { run, attemptsSeen }
}

describe('runWithRetry', () => {
  it('succeeds on the first attempt → no sleep, one run', async () => {
    const sleep = vi.fn(async () => {})
    const { run, attemptsSeen } = flakyRunner(0)
    const res = await runWithRetry({ retries: 3, retryDelayMs: 1000, run, sleep })
    expect(res.outcome).toEqual({ ok: true, value: 'ok-1' })
    expect(res.attempts).toBe(1)
    expect(res.totalAttempts).toBe(4)
    expect(attemptsSeen).toEqual([1])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries until success, sleeping between failed attempts', async () => {
    const sleep = vi.fn(async () => {})
    const { run, attemptsSeen } = flakyRunner(2) // fail 1,2 then succeed on 3
    const res = await runWithRetry({ retries: 3, retryDelayMs: 1500, run, sleep })
    expect(res.outcome).toEqual({ ok: true, value: 'ok-3' })
    expect(res.attempts).toBe(3)
    expect(attemptsSeen).toEqual([1, 2, 3])
    // slept after attempts 1 and 2, NOT after the success.
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1500)
  })

  it('exhausts retries and returns the FINAL failure', async () => {
    const sleep = vi.fn(async () => {})
    const { run, attemptsSeen } = flakyRunner(99) // always fails
    const res = await runWithRetry({ retries: 2, retryDelayMs: 500, run, sleep })
    expect(res.outcome).toEqual({ ok: false, value: 'err-3' }) // last attempt's payload
    expect(res.attempts).toBe(3) // retries + 1
    expect(attemptsSeen).toEqual([1, 2, 3])
    // slept between the 3 attempts (after 1 and 2), not after the last failure.
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('retries=0 runs exactly once even on failure (no sleep)', async () => {
    const sleep = vi.fn(async () => {})
    const { run, attemptsSeen } = flakyRunner(99)
    const res = await runWithRetry({ retries: 0, retryDelayMs: 1500, run, sleep })
    expect(res.outcome).toEqual({ ok: false, value: 'err-1' })
    expect(res.attempts).toBe(1)
    expect(attemptsSeen).toEqual([1])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('delay=0 skips the sleep call entirely between attempts', async () => {
    const sleep = vi.fn(async () => {})
    const { run } = flakyRunner(1)
    await runWithRetry({ retries: 2, retryDelayMs: 0, run, sleep })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('fires onAttemptStart with (attempt, total) for the progress surface', async () => {
    const starts: Array<[number, number]> = []
    const { run } = flakyRunner(1)
    await runWithRetry({
      retries: 3,
      retryDelayMs: 0,
      run,
      onAttemptStart: (a, total) => starts.push([a, total]),
    })
    expect(starts).toEqual([[1, 4], [2, 4]])
  })

  it('fires onAttemptSettled after EACH attempt (budget: every attempt counts)', async () => {
    const settled: Array<{ attempt: number; ok: boolean; value: string }> = []
    const { run } = flakyRunner(2)
    await runWithRetry({
      retries: 3,
      retryDelayMs: 0,
      run,
      onAttemptSettled: (attempt, _total, outcome) =>
        settled.push({ attempt, ok: outcome.ok, value: outcome.value }),
    })
    expect(settled).toEqual([
      { attempt: 1, ok: false, value: 'err-1' },
      { attempt: 2, ok: false, value: 'err-2' },
      { attempt: 3, ok: true, value: 'ok-3' },
    ])
  })

  it('clamps an out-of-range retries request before looping', async () => {
    const { run, attemptsSeen } = flakyRunner(99)
    const res = await runWithRetry({ retries: 99, retryDelayMs: 0, run })
    // clamped to MAX_RETRIES (3) → 4 total attempts.
    expect(res.totalAttempts).toBe(MAX_RETRIES + 1)
    expect(attemptsSeen).toEqual([1, 2, 3, 4])
  })
})
