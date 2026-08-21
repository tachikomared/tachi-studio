// apps/desktop/electron/services/util/net-retry.ts
//
// CONNECTION RESILIENCE — the shared, PURE policy behind "a one-second internet
// drop must not kill a running stream".
//
// A streamed LLM response is a long-lived HTTP body. Wi-Fi hiccups, laptop
// sleep, a proxy recycling a socket, a gateway 502 — any of them terminate the
// body mid-answer and, until now, surfaced as a hard error that threw away the
// whole run. Claude Code's answer is to treat that as what it is (a transport
// blip), reconnect with visible progress, and carry on. This module is the
// decision layer for that: what is worth retrying, and how long to wait.
//
// Deliberately dependency-free (no electron, no fetch, no timers of its own
// beyond `delayWithAbort`) so both the harness (tachi/loop.ts) and the chat
// service share ONE policy and it is exhaustively unit-testable.

/** Hard ceiling on reconnect attempts for a single round/request. */
export const MAX_RETRY_ATTEMPTS = 10
/** First backoff step; doubles per attempt. */
export const BASE_DELAY_MS = 1_000
/** Backoff never waits longer than this (before Retry-After / jitter). */
export const MAX_DELAY_MS = 30_000
/** Jitter band: 0-30% of the (already capped) base delay is added. */
export const JITTER_RATIO = 0.3
/** A server Retry-After longer than this is clamped — we still want to reconnect this decade. */
export const MAX_RETRY_AFTER_MS = 60_000

export type NetErrorKind = 'retryable' | 'fatal'

export interface NetErrorClassification {
  kind: NetErrorKind
  /**
   * Stable machine-ish tag for logs/tests and for the UI's reason line:
   * 'econnreset' | 'fetch-failed' | 'premature-close' | 'idle-stall' |
   * 'http-503' | 'abort' | 'auth' | 'policy' | 'unknown'.
   */
  reason: string
  /** Server-requested wait (from a Retry-After header), already normalised to ms. */
  retryAfterMs?: number
}

/** Minimal shape of anything response-like we can classify (real Response, or a test stub). */
interface ResponseLike {
  status: number
  ok?: boolean
  headers?: { get(name: string): string | null }
}

function isResponseLike(v: unknown): v is ResponseLike {
  return typeof v === 'object' && v !== null && typeof (v as ResponseLike).status === 'number'
    && !(v instanceof Error)
}

/**
 * True for a user/system cancellation. Abort MUST pass through instantly and
 * must NEVER be retried — pressing Stop has to stop.
 */
export function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (typeof err === 'object') {
    const e = err as { name?: unknown; code?: unknown; cause?: unknown }
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return true
    if (e.code === 'ABORT_ERR' || e.code === 20) return true
    if (e.cause && e.cause !== err) return isAbortError(e.cause)
  }
  return false
}

/** Make an AbortError that behaves like the platform one (name-sniffed everywhere). */
export function makeAbortError(message = 'The operation was aborted.'): Error {
  const e = new Error(message)
  e.name = 'AbortError'
  return e
}

/**
 * Parse a Retry-After header value (delta-seconds OR an HTTP-date) into ms.
 * Returns undefined for anything unparseable, and never a negative number.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined
  const raw = String(value).trim()
  if (!raw) return undefined
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const ms = Math.round(Number(raw) * 1000)
    return Number.isFinite(ms) ? Math.max(0, ms) : undefined
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - nowMs)
}

// Node/undici socket-level codes that always mean "the pipe broke", never
// "your request was wrong". EAI_AGAIN + ENOTFOUND are DNS: exactly what a
// laptop coming back from a dropped Wi-Fi association reports for a second.
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET',
  'EHOSTDOWN', 'ESOCKETTIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_RESPONSE_STATUS_CODE',
])

// Message fragments (lower-cased) that identify a transport death. undici
// famously surfaces most of these as a bare `TypeError: fetch failed` with the
// real cause nested, and an SSE body that ends early as "terminated" /
// "other side closed" / "premature close".
const RETRYABLE_MESSAGES = [
  'fetch failed',
  'socket hang up',
  'premature close',
  'other side closed',
  'terminated',
  'connection closed',
  'connection reset',
  'network error',
  'networkerror',
  'failed to fetch',
  'stream stalled',            // our own stream-idle watchdog
  'no data received for',      // …its message body
  'unexpected end of',         // truncated SSE / JSON body
  'body timeout',
  'headers timeout',
  'client network socket disconnected',
  'read econnreset',
  'getaddrinfo',
]

// Fragments that mean "retrying will produce the identical failure": local
// policy refusals (private mode / egress / SSRF / secret scrubbing) and
// request-shape errors. These must fail FAST and loudly.
const FATAL_MESSAGES = [
  'private mode',
  'egress',
  'blocked by policy',
  'not permitted',
  'scrub',
  'ssrf',
  'invalid api key',
  'incorrect api key',
  'unauthorized',
  'authentication',
  'permission denied',
  'context length',
  'context_length_exceeded',
  'maximum context',
  'invalid_request_error',
  'unsupported',
]

function collectStrings(err: unknown, out: { codes: string[]; messages: string[] }, depth = 0): void {
  if (!err || depth > 5) return
  if (typeof err === 'string') { out.messages.push(err.toLowerCase()); return }
  if (typeof err !== 'object') return
  const e = err as { code?: unknown; errno?: unknown; message?: unknown; name?: unknown; cause?: unknown; errors?: unknown }
  if (typeof e.code === 'string') out.codes.push(e.code.toUpperCase())
  if (typeof e.errno === 'string') out.codes.push(e.errno.toUpperCase())
  if (typeof e.message === 'string') out.messages.push(e.message.toLowerCase())
  if (typeof e.name === 'string') out.messages.push(e.name.toLowerCase())
  if (e.cause && e.cause !== err) collectStrings(e.cause, out, depth + 1)
  if (Array.isArray(e.errors)) for (const sub of e.errors) collectStrings(sub, out, depth + 1)
}

/**
 * Decide whether a failure is a transport blip worth reconnecting through.
 *
 * Accepts EITHER a thrown error (any shape, `cause` chains walked) OR a
 * response-like object with a `status` — so the same call site can classify
 * "the fetch rejected" and "the gateway answered 503".
 *
 * Ordering matters:
 *   1. abort  → fatal, instantly (never retried, even if it also looks network-y)
 *   2. status → 408/429/5xx retryable (Retry-After honoured), other 4xx fatal
 *   3. policy/auth wording → fatal
 *   4. socket codes / transport wording → retryable
 *   5. anything else → fatal (don't retry a bug)
 */
export function classifyNetworkError(input: unknown, nowMs: number = Date.now()): NetErrorClassification {
  if (isAbortError(input)) return { kind: 'fatal', reason: 'abort' }

  if (isResponseLike(input)) {
    const status = input.status
    const retryAfterMs = parseRetryAfterMs(input.headers?.get('retry-after') ?? null, nowMs)
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return { kind: 'retryable', reason: `http-${status}`, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
    }
    if (status >= 400) return { kind: 'fatal', reason: status === 401 || status === 403 ? 'auth' : `http-${status}` }
    return { kind: 'fatal', reason: `http-${status}` }
  }

  const bag = { codes: [] as string[], messages: [] as string[] }
  collectStrings(input, bag)
  const blob = bag.messages.join(' | ')

  // An error carrying an explicit HTTP status (AI SDK APICallError etc.).
  const status = typeof (input as { statusCode?: unknown })?.statusCode === 'number'
    ? (input as { statusCode: number }).statusCode
    : typeof (input as { status?: unknown })?.status === 'number'
      ? (input as { status: number }).status
      : undefined
  if (typeof status === 'number' && status >= 400) {
    const hdrs = (input as { responseHeaders?: Record<string, string> }).responseHeaders
    const retryAfterMs = parseRetryAfterMs(hdrs?.['retry-after'] ?? hdrs?.['Retry-After'] ?? null, nowMs)
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      return { kind: 'retryable', reason: `http-${status}`, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
    }
    return { kind: 'fatal', reason: status === 401 || status === 403 ? 'auth' : `http-${status}` }
  }

  if (FATAL_MESSAGES.some(m => blob.includes(m))) return { kind: 'fatal', reason: 'policy' }

  for (const code of bag.codes) {
    if (RETRYABLE_CODES.has(code)) return { kind: 'retryable', reason: code.toLowerCase() }
  }
  for (const frag of RETRYABLE_MESSAGES) {
    if (blob.includes(frag)) {
      return {
        kind: 'retryable',
        reason: frag === 'stream stalled' || frag === 'no data received for' ? 'idle-stall'
          : frag === 'fetch failed' || frag === 'failed to fetch' ? 'fetch-failed'
            : frag === 'premature close' || frag === 'terminated' || frag === 'other side closed' ? 'premature-close'
              : 'network',
      }
    }
  }
  return { kind: 'fatal', reason: 'unknown' }
}

export interface BackoffOptions {
  /** Injectable RNG for deterministic tests. Must return [0, 1). Default Math.random. */
  rng?: () => number
  baseMs?: number
  capMs?: number
  jitterRatio?: number
  /** Server-requested wait; when present it WINS (clamped to MAX_RETRY_AFTER_MS). */
  retryAfterMs?: number
}

/**
 * Backoff for attempt `n` (1-based): `min(base * 2^(n-1), cap)` plus 0-30%
 * jitter of that value. A Retry-After from the server overrides the schedule
 * outright (clamped) — the gateway knows better than our curve.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const {
    rng = Math.random,
    baseMs = BASE_DELAY_MS,
    capMs = MAX_DELAY_MS,
    jitterRatio = JITTER_RATIO,
    retryAfterMs,
  } = opts
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(Math.round(retryAfterMs), MAX_RETRY_AFTER_MS)
  }
  const n = Math.max(1, Math.floor(attempt))
  // 2^(n-1) overflows to Infinity long before it matters; the min() clamps it.
  const raw = Math.min(baseMs * Math.pow(2, n - 1), capMs)
  const jitter = raw * jitterRatio * Math.min(Math.max(rng(), 0), 0.999999)
  return Math.round(raw + jitter)
}

/** The deterministic (jitter-free) schedule — handy for docs and table tests. */
export function backoffSchedule(maxAttempts: number = MAX_RETRY_ATTEMPTS, baseMs = BASE_DELAY_MS, capMs = MAX_DELAY_MS): number[] {
  return Array.from({ length: maxAttempts }, (_, i) => Math.min(baseMs * Math.pow(2, i), capMs))
}

/** Whether another attempt is allowed. `attemptsUsed` = reconnects already spent. */
export function shouldRetry(attemptsUsed: number, cls: NetErrorClassification, maxAttempts: number = MAX_RETRY_ATTEMPTS): boolean {
  return cls.kind === 'retryable' && attemptsUsed < maxAttempts
}

/**
 * Sleep that CANCELS INSTANTLY on abort (rejecting with an AbortError) instead
 * of making the user watch out a 30s backoff after pressing Stop.
 */
export function delayWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(makeAbortError())
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, Math.max(0, ms))
    const onAbort = () => { cleanup(); reject(makeAbortError()) }
    function cleanup(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Per-round reconnect budget. One instance per logical unit of work (a harness
 * round, a chat message): `next()` yields the wait for the next attempt or null
 * when the budget is spent; `reset()` is called once a round completes
 * successfully so a long run gets a fresh 10 attempts per round, not per run.
 */
export class RetryBudget {
  private used = 0
  constructor(
    private readonly maxAttempts: number = MAX_RETRY_ATTEMPTS,
    private readonly backoffOpts: BackoffOptions = {},
  ) {}

  /** Reconnect attempts already spent on the current round. */
  get attemptsUsed(): number { return this.used }
  get max(): number { return this.maxAttempts }
  /** True while a reconnect is in flight (used to decide whether to announce recovery). */
  get retrying(): boolean { return this.used > 0 }

  /** Consume one attempt; returns `{ attempt, delayMs }`, or null when exhausted/fatal. */
  next(cls: NetErrorClassification): { attempt: number; delayMs: number } | null {
    if (!shouldRetry(this.used, cls, this.maxAttempts)) return null
    this.used++
    return {
      attempt: this.used,
      delayMs: backoffDelayMs(this.used, { ...this.backoffOpts, retryAfterMs: cls.retryAfterMs }),
    }
  }

  /** A round finished cleanly — the next round starts with a full budget. */
  reset(): void { this.used = 0 }
}
