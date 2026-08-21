// apps/desktop/electron/services/chat-stream.ts
//
// Shared OpenAI-compatible SSE streaming for the chat providers. The read loop —
// read → decode → split on `\n` → `data:` lines → `[DONE]` → extract delta →
// emit `delta`, parse `usage` → recordUsageChunk + emit `usage` — was copy-pasted
// across the openrouter / opengateway / venice / bankr branches of chat-service.ts
// (audit M2: "OpenAI-compat SSE loop duplicated 5×"). This is the single source of
// truth for those four.
//
// Surplus deliberately keeps its OWN loop: it defers the `start` chunk to the
// first non-empty delta and drives a failover chain — a genuinely different shape,
// not worth contorting this helper for.
//
// The helper owns ONLY the read loop. The caller still sends `start` before and
// `done` after, deletes its abort entry, and runs any provider-specific outcome
// recording (bandit/ELO/cooldown) in its own `finally`. Chars are reported via the
// `onChars` callback as they stream — so a caller's `finally` sees the partial
// count even when a read rejects mid-stream (idle-stall), exactly as the inline
// loops did.

import type { ChatChunk } from '@tachi/core'
import { extractReasoningDelta, createThinkWrapper } from '@tachi/core'
import { traverseObj } from './util/traverse-obj'
import { readOrIdleAbort } from './stream-idle'
import {
  classifyNetworkError, delayWithAbort, isAbortError, RetryBudget,
  MAX_RETRY_ATTEMPTS, type BackoffOptions, type NetErrorClassification,
} from './util/net-retry'

/** Minimal byte-stream reader shape — satisfied by `res.body!.getReader()`. */
export interface SseByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
}

/**
 * Extract the streamed text delta from an OpenAI-compatible SSE chunk.
 *
 * Tries the canonical chat-completions path first, then known gateway variants,
 * so a model/proxy that nests text slightly differently still streams instead of
 * silently dropping every chunk. Returns undefined for chunks that carry no text
 * (role-only opening chunk, usage-only final chunk) — callers guard with
 * `typeof delta === 'string'` and skip those.
 */
export function extractOpenAiStreamDelta(parsed: unknown): string | undefined {
  return traverseObj<string>(parsed, [
    'choices.0.delta.content',  // canonical chat-completions streaming
    'choices.0.delta.text',     // some OpenAI-compatible gateways
    'choices.0.text',           // legacy completions-style streaming
  ], { expectedType: 'string' })
}

/**
 * Drive an OpenAI-compatible SSE stream to completion: read frames, emit a
 * `delta` chunk per text fragment (via `send`), and a `usage` chunk when the
 * stream reports token usage (also forwarded to `recordUsageChunk`). Stops on
 * abort, `[DONE]`, or stream end.
 *
 * Does NOT emit `start`/`done` and does NOT touch the abort registry — the caller
 * owns those plus any provider outcome recording. Each streamed text fragment's
 * length is reported through `onChars` immediately, so the caller can total
 * response chars even if a read rejects (idle-stall) and unwinds through `finally`.
 */
export async function streamOpenAiCompatDeltas(opts: {
  reader: SseByteReader | undefined
  abort: AbortController
  messageId: string
  /** Forward a chunk to the renderer (e.g. `(c) => win.webContents.send('chat:chunk', c)`). */
  send: (chunk: ChatChunk) => void
  /** Record token usage to the cost ledger / context tracker. */
  recordUsageChunk: (chunk: ChatChunk) => void
  /** Called with each streamed fragment's char length, as it arrives. */
  onChars: (n: number) => void
  /**
   * Idle-stall timeout override (see model-profiles profiledIdleMs) — reasoning
   * models think silently server-side, so callers pass 3× for those; omitted =
   * the standard STREAM_IDLE_TIMEOUT_MS.
   */
  idleMs?: number
  /**
   * PROVENANCE: fired ONCE with the model id the provider says actually served
   * the request (`model` on the first parsed SSE chunk). Gateways route aliases
   * to concrete models — Kilo answers `kilo-auto/free` with the real row, and
   * `deepseek-v4-flash-free` comes back as `deepseek-v4-flash` — so the id we
   * REQUESTED is not the id that answered. Callers use it to label the reply
   * with what ran instead of the alias. Never fires when the wire omits it: we
   * surface the alias honestly rather than invent a model.
   */
  onServedModel?: (model: string) => void
}): Promise<void> {
  const { reader, abort, messageId, send, recordUsageChunk, onChars, idleMs, onServedModel } = opts
  if (!reader) return
  let servedModelSeen = false

  // Reasoning models (R1/QwQ via OpenRouter/DeepSeek) stream chain-of-thought
  // in a SEPARATE delta field; fold it back into inline <think>…</think> so the
  // renderer's existing collapsed-thinking disclosure shows it.
  const think = createThinkWrapper()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    if (abort.signal.aborted) break
    const { done, value } = await readOrIdleAbort(() => reader.read(), abort, idleMs)
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') break
      try {
        const parsed = JSON.parse(data)
        if (!servedModelSeen && typeof parsed.model === 'string' && parsed.model.trim()) {
          servedModelSeen = true
          onServedModel?.(parsed.model.trim())
        }
        const content = extractOpenAiStreamDelta(parsed)
        const reasoning = extractReasoningDelta(parsed)
        const delta = think.next(reasoning, content)
        if (delta) {
          onChars(delta.length)
          send({ type: 'delta', messageId, text: delta } satisfies ChatChunk)
        }
        if (parsed.usage) {
          const usageChunk = {
            type: 'usage', messageId,
            usage: {
              promptTokens:     parsed.usage.prompt_tokens     ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens:      parsed.usage.total_tokens      ?? 0,
            },
          } satisfies ChatChunk
          recordUsageChunk(usageChunk)
          send(usageChunk)
        }
      } catch { /* skip malformed SSE lines */ }
    }
  }
  // Close a still-open <think> block if the stream ended mid-reasoning.
  const tail = think.flush()
  if (tail) { onChars(tail.length); send({ type: 'delta', messageId, text: tail } satisfies ChatChunk) }
}

/**
 * Drive an ANTHROPIC-NATIVE (`/v1/messages`) SSE stream: `content_block_delta`
 * text deltas, `message_delta` usage, and the `message_start` cache-token counts
 * (reported through `onCacheTokens` so the caller can patch its network-audit
 * entry). Same contract as the OpenAI-compat loop above — no `start`/`done`, no
 * abort-registry bookkeeping — so both can sit behind one reconnect driver.
 */
export async function streamAnthropicDeltas(opts: {
  reader: SseByteReader | undefined
  abort: AbortController
  messageId: string
  send: (chunk: ChatChunk) => void
  recordUsageChunk: (chunk: ChatChunk) => void
  onChars: (n: number) => void
  idleMs?: number
  /** Latest cache-hit counters seen on this attempt's `message_start`. */
  onCacheTokens?: (created: number, read: number) => void
}): Promise<void> {
  const { reader, abort, messageId, send, recordUsageChunk, onChars, idleMs, onCacheTokens } = opts
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    if (abort.signal.aborted) break
    const { done, value } = await readOrIdleAbort(() => reader.read(), abort, idleMs)
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') break
      try {
        const parsed = JSON.parse(data)
        // message_start carries the initial usage block including cache hits.
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          const u = parsed.message.usage
          onCacheTokens?.(u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0)
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          const text = parsed.delta.text as string
          onChars(text.length)
          send({ type: 'delta', messageId, text } satisfies ChatChunk)
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          const usageChunk = {
            type: 'usage', messageId,
            usage: {
              promptTokens:     parsed.usage.input_tokens  ?? 0,
              completionTokens: parsed.usage.output_tokens ?? 0,
              totalTokens:      (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
            },
          } satisfies ChatChunk
          recordUsageChunk(usageChunk)
          send(usageChunk)
        }
      } catch { /* skip malformed SSE lines */ }
    }
  }
}

// ── CONNECTION RESILIENCE ────────────────────────────────────────────────────
//
// Everything below turns the one-shot loop above into a reconnecting one. A
// chat turn is a SINGLE model request, so recovery is simpler than the
// harness's: nothing has executed, so the request can just be made again. The
// only thing that must be undone is what the user already saw — the partial
// answer — hence the `reset` chunk before every retry. Without it a flaky
// connection renders the reply twice.

/** Terminal outcome of a reconnecting stream. */
export type ReconnectingStreamResult =
  /** The answer streamed to completion (possibly after `retries` reconnects). */
  | { ok: true; chars: number; retries: number }
  /** The provider answered with a non-retryable (or retry-exhausted) status. */
  | { ok: false; kind: 'http'; status: number; body: string; chars: number; retries: number }
  /** The transport failed for good (or the retry budget ran out). */
  | { ok: false; kind: 'network'; error: unknown; chars: number; retries: number }
  /** The user pressed Stop. Nothing more should be emitted but `done`. */
  | { ok: false; kind: 'aborted'; chars: number; retries: number }

export interface ReconnectingStreamOptions {
  /**
   * Issue the request. Receives a PER-ATTEMPT signal — not the conversation's —
   * because the idle watchdog aborts the attempt it is watching, and an
   * already-aborted controller could never be reused for the retry.
   */
  openRequest: (signal: AbortSignal) => Promise<Response>
  /** The conversation-wide abort controller (Stop button). Never replaced. */
  abort: AbortController
  messageId: string
  /** Model id for the `start` chunk, sent once the first response is OK. */
  model?: string
  send: (chunk: ChatChunk) => void
  recordUsageChunk: (chunk: ChatChunk) => void
  /** Streamed chars, as they arrive. A retry reports a NEGATIVE delta that
   *  cancels the discarded attempt, so a caller's running total stays honest. */
  onChars: (n: number) => void
  idleMs?: number
  /** Per-attempt failure hook — lets a caller record provider cooldown/bandit stats. */
  onAttemptFailure?: (info: { status?: number; error?: unknown; willRetry: boolean }) => void
  // Test seams.
  maxAttempts?: number
  backoff?: BackoffOptions
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** What a drain gets handed for ONE attempt of a reconnecting stream. */
export interface ReconnectDrainContext {
  res: Response
  /** PER-ATTEMPT controller — the idle watchdog aborts this one, not the conversation. */
  abort: AbortController
  messageId: string
  send: (chunk: ChatChunk) => void
  /**
   * Emit the single `start` chunk (idempotent across attempts). Pass the model
   * the provider says actually served the request, when the wire reported one —
   * it labels the reply instead of the alias we asked with.
   */
  markStarted: (servedModel?: string) => void
  /** Report streamed chars; rolled back automatically if this attempt is discarded. */
  onChars: (n: number) => void
}

export interface GenericReconnectOptions extends Omit<ReconnectingStreamOptions, 'recordUsageChunk' | 'idleMs'> {
  /** Consume one successful response body to completion (or throw on transport death). */
  drain: (ctx: ReconnectDrainContext) => Promise<void>
  /**
   * When does the `start` chunk go out? `'response'` (default) = as soon as the
   * provider answers 2xx. `'first-delta'` = only when the drain says so — the
   * surplus failover chain needs that, so an empty 200 can be swapped for the
   * next model without the UI ever showing a bubble. `'served-model'` = hold
   * until the first parsed SSE chunk so the `start` can name the model that
   * ACTUALLY served the request (gateway aliases like `kilo-auto/free` resolve
   * server-side); a stream that ends without one still starts, so this mode can
   * never go silent.
   */
  startOn?: 'response' | 'first-delta' | 'served-model'
  /**
   * Retry 408/429/5xx like a transport blip (default true). Surplus sets this
   * false: it already answers a bad status by failing over to the NEXT model in
   * its chain, which beats waiting out ten backoffs on the same one.
   */
  retryHttp?: boolean
}

/**
 * Request → stream → (on a transport blip) reset, reconnect, re-request. Emits
 * `start` once, `reset`/`reconnect` around each retry, `reconnect-resolved`
 * when the answer finally flows, and NEVER `done`/`error` — the caller keeps
 * ownership of the terminal chunks and its own provider bookkeeping.
 *
 * Wire-format agnostic: the caller supplies the `drain`, so the OpenAI-compat,
 * Anthropic-native and surplus-failover paths all share ONE retry policy.
 */
export async function streamWithReconnect(opts: GenericReconnectOptions): Promise<ReconnectingStreamResult> {
  const {
    openRequest, abort, messageId, model, send, onChars,
    onAttemptFailure, drain, startOn = 'response', retryHttp = true,
  } = opts
  const maxAttempts = opts.maxAttempts ?? MAX_RETRY_ATTEMPTS
  const budget = new RetryBudget(maxAttempts, opts.backoff ?? {})
  const sleep = opts.sleep ?? ((ms: number, sig: AbortSignal) => delayWithAbort(ms, sig))

  let started = false
  let totalChars = 0
  let charsThisAttempt = 0
  let announced = false

  /** Throw away the partial answer the user is looking at before re-requesting. */
  const rollback = (): void => {
    if (charsThisAttempt > 0) {
      onChars(-charsThisAttempt)
      totalChars -= charsThisAttempt
      charsThisAttempt = 0
    }
    if (started) send({ type: 'reset', messageId } satisfies ChatChunk)
  }

  for (;;) {
    charsThisAttempt = 0
    // Per-attempt controller: the idle watchdog fires abort() on THIS one, so a
    // stalled attempt dies without poisoning the reconnect. Cancelling the
    // conversation cancels every attempt with it.
    const attemptAbort = new AbortController()
    const linkAbort = () => attemptAbort.abort()
    if (abort.signal.aborted) return { ok: false, kind: 'aborted', chars: totalChars, retries: budget.attemptsUsed }
    abort.signal.addEventListener('abort', linkAbort, { once: true })

    let failure: unknown = null
    let httpFailure: { status: number; body: string; retryAfter: string | null } | null = null
    try {
      const res = await openRequest(attemptAbort.signal)
      if (!res.ok) {
        httpFailure = {
          status: res.status,
          body: await res.text().catch(() => ''),
          retryAfter: res.headers?.get('retry-after') ?? null,
        }
      } else {
        const markStarted = (servedModel?: string): void => {
          if (started) return
          started = true
          // The served model wins when the provider reported one — that is the
          // model that ACTUALLY answered; `model` is only what we asked for.
          const label = servedModel?.trim() || model
          send({ type: 'start', messageId, ...(label ? { model: label } : {}) } satisfies ChatChunk)
        }
        if (startOn === 'response') markStarted()
        await drain({
          res,
          abort: attemptAbort,
          messageId,
          send,
          markStarted,
          onChars: (n) => { charsThisAttempt += n; totalChars += n; onChars(n) },
        })
        // SAFETY NET for 'served-model': a 200 that streamed nothing must still
        // produce a bubble. Without this, waiting for the served model would
        // turn an empty response into the silent hang we just finished fixing.
        // ('first-delta' is deliberately NOT covered — surplus relies on an
        // empty 200 producing no bubble so it can fail over to the next model.)
        if (startOn === 'served-model') markStarted()
      }
    } catch (e) {
      failure = e
    } finally {
      abort.signal.removeEventListener('abort', linkAbort)
    }

    // Stop always wins — no classification, no backoff.
    if (abort.signal.aborted) return { ok: false, kind: 'aborted', chars: totalChars, retries: budget.attemptsUsed }

    if (!failure && !httpFailure) {
      if (announced) send({ type: 'reconnect-resolved', messageId } satisfies ChatChunk)
      return { ok: true, chars: totalChars, retries: budget.attemptsUsed }
    }

    if (isAbortError(failure)) return { ok: false, kind: 'aborted', chars: totalChars, retries: budget.attemptsUsed }

    const cls: NetErrorClassification = httpFailure && !retryHttp
      ? { kind: 'fatal', reason: `http-${httpFailure.status}` }
      : classifyNetworkError(
        httpFailure
          ? { status: httpFailure.status, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? httpFailure!.retryAfter : null) } }
          : failure,
      )
    const slot = budget.next(cls)
    onAttemptFailure?.({ status: httpFailure?.status, error: failure, willRetry: slot !== null })
    if (!slot) {
      return httpFailure
        ? { ok: false, kind: 'http', status: httpFailure.status, body: httpFailure.body, chars: totalChars, retries: budget.attemptsUsed }
        : { ok: false, kind: 'network', error: failure, chars: totalChars, retries: budget.attemptsUsed }
    }

    rollback()
    announced = true
    send({ type: 'reconnect', messageId, attempt: slot.attempt, maxAttempts, delayMs: slot.delayMs, reason: cls.reason } satisfies ChatChunk)
    try {
      await sleep(slot.delayMs, abort.signal)
    } catch {
      // Stop pressed during the backoff — cancel instantly, don't wait it out.
      return { ok: false, kind: 'aborted', chars: totalChars, retries: budget.attemptsUsed }
    }
  }
}

/** The OpenAI-compat wire on top of the generic driver (the original entry point). */
export async function streamOpenAiCompatWithReconnect(opts: ReconnectingStreamOptions): Promise<ReconnectingStreamResult> {
  const { recordUsageChunk, idleMs, ...rest } = opts
  return streamWithReconnect({
    ...rest,
    drain: (ctx) => streamOpenAiCompatDeltas({
      reader: ctx.res.body?.getReader(),
      abort: ctx.abort,
      messageId: ctx.messageId,
      send: ctx.send,
      recordUsageChunk,
      onChars: ctx.onChars,
      idleMs,
      // Label the reply with the model that ACTUALLY answered. No-op when start
      // already went out on the 2xx (the default 'response' mode).
      onServedModel: (m) => ctx.markStarted(m),
    }),
  })
}

// ── LEGACY (ChatBackend) PATH ────────────────────────────────────────────────
//
// The legacy providers hand back an AsyncIterable<ChatChunk> instead of a
// Response, and they SWALLOW transport death — a socket that dies mid-answer
// surfaces as a yielded `error` chunk, not a throw. So the same reset-then-
// reconnect policy needs a second shell: one that classifies the error CHUNK,
// holds it back while a retry is still possible, and re-pins the message id so
// a second attempt refills the same bubble instead of opening a new one.

/**
 * Classify a legacy backend's `error` chunk. `HTTP_<n>` / `RATE_LIMITED` reuse
 * the shared status policy; `NETWORK_ERROR` (fetch threw) and `MALFORMED_SSE`
 * (the read loop threw mid-body) are transport deaths. Everything else —
 * NO_KEY, NO_MODEL, INTERNAL — would fail identically on a retry.
 */
export function classifyChunkError(error: { code?: string; message?: string } | undefined, nowMs: number = Date.now()): NetErrorClassification {
  const code = String(error?.code ?? '')
  const m = /^HTTP_(\d{3})$/.exec(code)
  if (m) return classifyNetworkError({ status: Number(m[1]) }, nowMs)
  if (code === 'RATE_LIMITED') return classifyNetworkError({ status: 429 }, nowMs)
  if (code === 'NETWORK_ERROR') return { kind: 'retryable', reason: 'fetch-failed' }
  if (code === 'MALFORMED_SSE') return { kind: 'retryable', reason: 'premature-close' }
  return { kind: 'fatal', reason: 'policy' }
}

export type ChunkStreamResult =
  | { ok: true; messageId: string; chars: number; retries: number }
  | { ok: false; kind: 'aborted'; messageId: string; chars: number; retries: number }
  | { ok: false; kind: 'failed'; messageId: string; chars: number; retries: number; errorChunk: ChatChunk }

export interface ChunkStreamReconnectOptions {
  /** Start the backend stream. Called again — fresh — for every reconnect. */
  open: () => AsyncIterable<ChatChunk>
  abort: AbortController
  send: (chunk: ChatChunk) => void
  /** Every chunk that is actually forwarded (cost ledger / context tracking). */
  onChunk?: (chunk: ChatChunk) => void
  maxAttempts?: number
  backoff?: BackoffOptions
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Same contract as `streamWithReconnect`, for a ChatChunk iterable: forwards
 * `start`/`delta`/`usage`, holds `error`, never forwards the backend's `done`
 * (the caller owns the terminal chunk), and on a retryable failure emits
 * `reset` → `reconnect` → re-opens the stream.
 */
export async function streamChunksWithReconnect(opts: ChunkStreamReconnectOptions): Promise<ChunkStreamResult> {
  const { open, abort, send, onChunk } = opts
  const maxAttempts = opts.maxAttempts ?? MAX_RETRY_ATTEMPTS
  const budget = new RetryBudget(maxAttempts, opts.backoff ?? {})
  const sleep = opts.sleep ?? ((ms: number, sig: AbortSignal) => delayWithAbort(ms, sig))

  // The FIRST attempt's id owns the bubble; later attempts are rewritten onto it.
  let pinnedId = 'unknown'
  let started = false
  let announced = false
  let totalChars = 0

  for (;;) {
    let charsThisAttempt = 0
    let failure: { chunk: ChatChunk; cls: NetErrorClassification } | null = null
    let aborted = false
    if (abort.signal.aborted) return { ok: false, kind: 'aborted', messageId: pinnedId, chars: totalChars, retries: budget.attemptsUsed }

    try {
      for await (const raw of open()) {
        if (abort.signal.aborted) { aborted = true; break }
        if (pinnedId === 'unknown' && raw.messageId) pinnedId = raw.messageId
        const chunk = { ...raw, messageId: pinnedId } as ChatChunk
        if (chunk.type === 'done') break
        if (chunk.type === 'error') {
          failure = { chunk, cls: classifyChunkError(chunk.error) }
          break
        }
        if (chunk.type === 'start') {
          if (started) continue
          started = true
        }
        if (chunk.type === 'delta') { charsThisAttempt += chunk.text.length; totalChars += chunk.text.length }
        onChunk?.(chunk)
        send(chunk)
      }
    } catch (e) {
      if (isAbortError(e)) aborted = true
      else failure = {
        chunk: { type: 'error', messageId: pinnedId, error: { code: 'INTERNAL', message: 'Unexpected error in chat service.' } } satisfies ChatChunk,
        cls: classifyNetworkError(e),
      }
    }

    if (aborted || abort.signal.aborted) return { ok: false, kind: 'aborted', messageId: pinnedId, chars: totalChars, retries: budget.attemptsUsed }

    if (!failure) {
      if (announced) send({ type: 'reconnect-resolved', messageId: pinnedId } satisfies ChatChunk)
      return { ok: true, messageId: pinnedId, chars: totalChars, retries: budget.attemptsUsed }
    }

    const slot = budget.next(failure.cls)
    if (!slot) return { ok: false, kind: 'failed', messageId: pinnedId, chars: totalChars, retries: budget.attemptsUsed, errorChunk: failure.chunk }

    if (charsThisAttempt > 0) totalChars -= charsThisAttempt
    if (started) send({ type: 'reset', messageId: pinnedId } satisfies ChatChunk)
    announced = true
    send({ type: 'reconnect', messageId: pinnedId, attempt: slot.attempt, maxAttempts, delayMs: slot.delayMs, reason: failure.cls.reason } satisfies ChatChunk)
    try {
      await sleep(slot.delayMs, abort.signal)
    } catch {
      return { ok: false, kind: 'aborted', messageId: pinnedId, chars: totalChars, retries: budget.attemptsUsed }
    }
  }
}
