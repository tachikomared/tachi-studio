// apps/desktop/test/unit/netRetry.test.ts
//
// CONNECTION RESILIENCE — the policy layer, tested exhaustively because every
// other piece of the feature trusts its verdict. Two properties matter above
// all: (1) a user abort is NEVER classified retryable, and (2) a request-shape
// or auth failure is never retried into a 10× amplification of the same 401.
// Everything is deterministic: the RNG is injected, and the one timing test
// uses fake timers.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  classifyNetworkError, parseRetryAfterMs, backoffDelayMs, backoffSchedule,
  shouldRetry, isAbortError, delayWithAbort, makeAbortError, RetryBudget,
  MAX_RETRY_ATTEMPTS, BASE_DELAY_MS, MAX_DELAY_MS, MAX_RETRY_AFTER_MS,
} from '../../electron/services/util/net-retry'

afterEach(() => { vi.useRealTimers() })

/** An undici-shaped failure: bare `fetch failed` with the real reason nested. */
function undiciFailure(code: string, message = 'other side closed'): Error {
  const cause = Object.assign(new Error(message), { code })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

describe('isAbortError', () => {
  it('recognises a name-tagged AbortError, including through a cause chain', () => {
    expect(isAbortError(makeAbortError())).toBe(true)
    expect(isAbortError({ cause: makeAbortError() })).toBe(true)
    expect(isAbortError(new Error('econnreset'))).toBe(false)
    expect(isAbortError(null)).toBe(false)
  })

  it('treats a DOMException-style ABORT_ERR code as an abort', () => {
    expect(isAbortError(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }))).toBe(true)
  })
})

describe('classifyNetworkError — abort always wins', () => {
  it('never retries a user abort, even when it also looks network-shaped', () => {
    const abortish = Object.assign(makeAbortError('fetch failed: socket hang up'), { code: 'ECONNRESET' })
    const cls = classifyNetworkError(abortish)
    expect(cls).toEqual({ kind: 'fatal', reason: 'abort' })
  })
})

describe('classifyNetworkError — retryable transport failures', () => {
  const codes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']
  for (const code of codes) {
    it(`retries ${code}`, () => {
      const cls = classifyNetworkError(Object.assign(new Error('boom'), { code }))
      expect(cls.kind).toBe('retryable')
      expect(cls.reason).toBe(code.toLowerCase())
    })
    it(`retries ${code} nested inside undici's "fetch failed"`, () => {
      expect(classifyNetworkError(undiciFailure(code)).kind).toBe('retryable')
    })
  }

  it.each([
    ['fetch failed', 'fetch-failed'],
    ['socket hang up', 'network'],
    ['Premature close', 'premature-close'],
    ['terminated', 'premature-close'],
    ['Stream stalled — no data received for 120s.', 'idle-stall'],
  ])('retries %j as %s', (message, reason) => {
    const cls = classifyNetworkError(new Error(message))
    expect(cls.kind).toBe('retryable')
    expect(cls.reason).toBe(reason)
  })
})

describe('classifyNetworkError — HTTP status policy', () => {
  const mkRes = (status: number, headers: Record<string, string> = {}) => ({
    status,
    ok: status < 400,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  })

  it.each([408, 425, 429, 500, 502, 503, 504])('retries %i', (status) => {
    expect(classifyNetworkError(mkRes(status)).kind).toBe('retryable')
  })

  it.each([400, 401, 403, 404, 422])('does NOT retry %i', (status) => {
    expect(classifyNetworkError(mkRes(status)).kind).toBe('fatal')
  })

  it('tags 401/403 as auth so the UI can say "check the key"', () => {
    expect(classifyNetworkError(mkRes(401)).reason).toBe('auth')
    expect(classifyNetworkError(mkRes(403)).reason).toBe('auth')
  })

  it('reads Retry-After (delta-seconds) off a 429', () => {
    expect(classifyNetworkError(mkRes(429, { 'retry-after': '7' })).retryAfterMs).toBe(7000)
  })

  it('reads Retry-After as an HTTP-date relative to now', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    const at = new Date(now + 12_000).toUTCString()
    expect(classifyNetworkError(mkRes(503, { 'retry-after': at }), now).retryAfterMs).toBe(12_000)
  })

  it('classifies an error object carrying statusCode (AI SDK APICallError shape)', () => {
    expect(classifyNetworkError(Object.assign(new Error('gateway'), { statusCode: 503 })).kind).toBe('retryable')
    expect(classifyNetworkError(Object.assign(new Error('bad key'), { statusCode: 401 })).kind).toBe('fatal')
  })
})

describe('classifyNetworkError — fatal by wording', () => {
  it.each([
    'Blocked by policy: PRIVATE MODE forbids network egress',
    'egress denied for this host',
    'Invalid API key provided',
    'context length exceeded for this model',
  ])('never retries %j', (message) => {
    expect(classifyNetworkError(new Error(message)).kind).toBe('fatal')
  })

  it('does not retry an unrecognised programming error', () => {
    const cls = classifyNetworkError(new TypeError('x.map is not a function'))
    expect(cls).toEqual({ kind: 'fatal', reason: 'unknown' })
  })

  it('prefers the policy verdict even when the message also mentions the network', () => {
    // A scrub/policy refusal that happens to say "network" must NOT be retried.
    expect(classifyNetworkError(new Error('blocked by policy: no network in private mode')).kind).toBe('fatal')
  })
})

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds, ignores junk, never goes negative', () => {
    expect(parseRetryAfterMs('3')).toBe(3000)
    expect(parseRetryAfterMs('0')).toBe(0)
    expect(parseRetryAfterMs('later')).toBeUndefined()
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs('')).toBeUndefined()
    const now = Date.UTC(2026, 0, 1)
    expect(parseRetryAfterMs(new Date(now - 60_000).toUTCString(), now)).toBe(0)
  })
})

describe('backoffDelayMs — the schedule', () => {
  it('is 1s,2s,4s…30s capped, before jitter', () => {
    expect(backoffSchedule(10)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000])
    expect(backoffSchedule(10)[0]).toBe(BASE_DELAY_MS)
    expect(backoffSchedule(10).at(-1)).toBe(MAX_DELAY_MS)
  })

  it('adds no jitter at rng()=0 and ~30% at rng()→1', () => {
    expect(backoffDelayMs(1, { rng: () => 0 })).toBe(1000)
    expect(backoffDelayMs(3, { rng: () => 0 })).toBe(4000)
    // 0.999999 * 30% of 4000 ≈ 1200
    expect(backoffDelayMs(3, { rng: () => 1 })).toBe(5200)
  })

  it('keeps jitter inside the 0-30% band for every attempt', () => {
    for (let n = 1; n <= MAX_RETRY_ATTEMPTS; n++) {
      const base = Math.min(BASE_DELAY_MS * 2 ** (n - 1), MAX_DELAY_MS)
      for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
        const d = backoffDelayMs(n, { rng: () => r })
        expect(d).toBeGreaterThanOrEqual(base)
        expect(d).toBeLessThanOrEqual(Math.round(base * 1.3))
      }
    }
  })

  it('lets a server Retry-After override the curve, clamped to one minute', () => {
    expect(backoffDelayMs(1, { rng: () => 0, retryAfterMs: 12_000 })).toBe(12_000)
    expect(backoffDelayMs(9, { rng: () => 0, retryAfterMs: 5_000 })).toBe(5_000)
    expect(backoffDelayMs(1, { rng: () => 0, retryAfterMs: 999_000 })).toBe(MAX_RETRY_AFTER_MS)
  })

  it('never exceeds the cap+jitter no matter how absurd the attempt number', () => {
    expect(backoffDelayMs(999, { rng: () => 0 })).toBe(MAX_DELAY_MS)
  })
})

describe('shouldRetry / RetryBudget', () => {
  const retryable = { kind: 'retryable', reason: 'econnreset' } as const
  const fatal = { kind: 'fatal', reason: 'auth' } as const

  it('allows exactly 10 attempts then stops', () => {
    expect(shouldRetry(0, retryable)).toBe(true)
    expect(shouldRetry(9, retryable)).toBe(true)
    expect(shouldRetry(10, retryable)).toBe(false)
    expect(shouldRetry(0, fatal)).toBe(false)
  })

  it('hands out 10 slots with a growing delay, then null', () => {
    const b = new RetryBudget(MAX_RETRY_ATTEMPTS, { rng: () => 0 })
    const delays: number[] = []
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      const slot = b.next(retryable)
      expect(slot).not.toBeNull()
      expect(slot!.attempt).toBe(i + 1)
      delays.push(slot!.delayMs)
    }
    expect(delays).toEqual(backoffSchedule(MAX_RETRY_ATTEMPTS))
    expect(b.next(retryable)).toBeNull()
    expect(b.attemptsUsed).toBe(MAX_RETRY_ATTEMPTS)
  })

  it('refuses a fatal classification without spending an attempt', () => {
    const b = new RetryBudget()
    expect(b.next(fatal)).toBeNull()
    expect(b.attemptsUsed).toBe(0)
  })

  it('gives the budget back once a round completes — 10 per round, not per run', () => {
    const b = new RetryBudget(MAX_RETRY_ATTEMPTS, { rng: () => 0 })
    b.next(retryable); b.next(retryable)
    expect(b.attemptsUsed).toBe(2)
    expect(b.retrying).toBe(true)
    b.reset()
    expect(b.attemptsUsed).toBe(0)
    expect(b.retrying).toBe(false)
    expect(b.next(retryable)!.delayMs).toBe(BASE_DELAY_MS)
  })

  it('honours a Retry-After carried on the classification', () => {
    const b = new RetryBudget(3, { rng: () => 0 })
    expect(b.next({ kind: 'retryable', reason: 'http-429', retryAfterMs: 9_000 })!.delayMs).toBe(9_000)
  })
})

describe('delayWithAbort', () => {
  it('resolves after the delay when nothing cancels it', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    let done = false
    const p = delayWithAbort(5_000, ac.signal).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await p
    expect(done).toBe(true)
  })

  it('rejects INSTANTLY on abort — no waiting out a 30s backoff after Stop', async () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    const p = delayWithAbort(30_000, ac.signal)
    ac.abort()
    // No timer advance at all: the rejection must already be pending.
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(delayWithAbort(1_000, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
