// apps/desktop/src/pages/nodes/retryPolicy.ts
//
// NODES-RESEARCH (n8n "Retry on fail") — PER-NODE RETRY policy + the pure
// attempt-loop harness. Side-effect-free so it is unit-testable in isolation
// (test/unit/nodeRetry.test.ts): no store access, no React, no IPC — just node
// data → a clamped policy, and an injected-runner loop → the final outcome.
//
// A runnable node (agent / prompt / media) may carry:
//   • data.retries       — how many EXTRA attempts after the first (0-3, def 0)
//   • data.retryDelayMs   — wait between attempts in ms (def 1500)
//
// Total attempts = retries + 1. On a failed attempt with attempts left the run
// path waits retryDelayMs then re-runs the SAME node. Only the FINAL failure
// records lastError / feeds the error branch (#6); each attempt counts toward the
// est-spend budget guard (#4). See useNodeRun + NodesPage.handleRunAll.

/** Hard ceiling on extra attempts (the stepper caps here too). */
export const MAX_RETRIES = 3
/** Default inter-attempt delay when none is set on the node. */
export const DEFAULT_RETRY_DELAY_MS = 1500
/** Delay is clamped into this range (upper bound = runaway-wait insurance). */
export const MIN_RETRY_DELAY_MS = 0
export const MAX_RETRY_DELAY_MS = 60_000

/** A node's validated retry policy — always in-range, ready to drive the loop. */
export interface RetryPolicy {
  /** Extra attempts after the first, clamped to [0, MAX_RETRIES]. */
  retries: number
  /** Delay between attempts (ms), clamped to [MIN, MAX]. */
  retryDelayMs: number
}

/** Coerce to a finite number, or NaN when it is not parseable / blank. */
function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return NaN
    return Number(s)
  }
  return NaN
}

/** Clamp any input to a valid `retries` count (invalid / absent → 0). */
export function clampRetries(v: unknown): number {
  const n = num(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(MAX_RETRIES, Math.max(0, Math.floor(n)))
}

/** Clamp any input to a valid `retryDelayMs` (invalid / absent → default). */
export function clampDelay(v: unknown): number {
  const n = num(v)
  if (!Number.isFinite(n)) return DEFAULT_RETRY_DELAY_MS
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, Math.floor(n)))
}

/** Read + validate a node's retry policy from its (untyped) data bag. */
export function retryPolicy(data: unknown): RetryPolicy {
  const d = (data ?? {}) as { retries?: unknown; retryDelayMs?: unknown }
  return {
    retries: clampRetries(d.retries),
    retryDelayMs: clampDelay(d.retryDelayMs),
  }
}

/** True when a node with `retries` extra attempts should retry after a run. */
export function hasRetry(data: unknown): boolean {
  return retryPolicy(data).retries > 0
}

/**
 * Decide whether another attempt should follow a FAILED attempt.
 * `attempt` is the 1-based number of the attempt that just failed; `retries` is
 * the number of extra attempts allowed. Total attempts = retries + 1, so we
 * retry while `attempt <= retries` (attempt 1 with retries 2 → retry, … attempt
 * 3 with retries 2 → stop). Defensive against non-integer / negative inputs.
 */
export function shouldRetry(attempt: number, retries: number): boolean {
  if (!Number.isFinite(attempt) || !Number.isFinite(retries)) return false
  return Math.floor(attempt) <= Math.floor(retries) && Math.floor(retries) > 0
}

// ── Injected-runner attempt loop ──────────────────────────────────────────────
//
// The generic, testable core the two run seams (per-node RUN + Run-all) share:
// it drives `run(attempt)` up to `retries + 1` times, sleeping `retryDelayMs`
// between failed attempts, and reports progress via callbacks. `sleep` is
// injectable so tests advance time without real timers.

/** The result of ONE attempt: whether it succeeded + the caller's payload. */
export interface AttemptOutcome<T> {
  ok: boolean
  value: T
}

export interface RetryRunResult<T> {
  /** The last attempt's outcome (the success that broke the loop, or the final failure). */
  outcome: AttemptOutcome<T>
  /** How many attempts actually ran (1 = succeeded / gave up first try). */
  attempts: number
  /** retries + 1 (the ceiling). */
  totalAttempts: number
}

export interface RunWithRetryOptions<T> {
  /** Extra attempts after the first (clamped internally). */
  retries: number
  /** Delay between attempts, ms (clamped internally). */
  retryDelayMs: number
  /** Run one attempt. `attempt` is 1-based. Must NOT throw — return ok:false. */
  run: (attempt: number) => Promise<AttemptOutcome<T>>
  /** Sleep between attempts. Injected in tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Fired BEFORE each attempt (progress surface: "retry N/M" from attempt 2). */
  onAttemptStart?: (attempt: number, totalAttempts: number) => void
  /** Fired AFTER each attempt settles (budget: each attempt counts toward spend). */
  onAttemptSettled?: (attempt: number, totalAttempts: number, outcome: AttemptOutcome<T>) => void
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Run `opts.run` with retry-on-fail. Stops on the first success, or after the
 * final allowed attempt. Pure w.r.t. side effects except the injected `run` /
 * `sleep` / progress callbacks — so a fake runner + fake sleep fully exercise it.
 */
export async function runWithRetry<T>(opts: RunWithRetryOptions<T>): Promise<RetryRunResult<T>> {
  const retries = clampRetries(opts.retries)
  const retryDelayMs = clampDelay(opts.retryDelayMs)
  const totalAttempts = retries + 1
  const sleep = opts.sleep ?? defaultSleep

  let outcome: AttemptOutcome<T> | undefined
  let attempts = 0
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    attempts = attempt
    opts.onAttemptStart?.(attempt, totalAttempts)
    outcome = await opts.run(attempt)
    opts.onAttemptSettled?.(attempt, totalAttempts, outcome)
    if (outcome.ok) break
    if (!shouldRetry(attempt, retries)) break
    if (retryDelayMs > 0) await sleep(retryDelayMs)
  }
  // The loop always runs at least once (totalAttempts >= 1), so outcome is set.
  return { outcome: outcome as AttemptOutcome<T>, attempts, totalAttempts }
}
