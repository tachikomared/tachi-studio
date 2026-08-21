// apps/desktop/test/unit/chatReconnectGaps.test.ts
//
// CONNECTION RESILIENCE, part 2 — the three chat paths e97e9d4 left uncovered:
// anthropic-oauth (its own /v1/messages wire), surplus (a model-failover chain
// with bandit/Elo bookkeeping), and the legacy ChatBackend path (an
// AsyncIterable that SWALLOWS transport death into an `error` chunk).
//
// The invariants that matter per path:
//   • anthropic — a mid-answer socket death reconnects, the partial answer is
//     thrown away FIRST (`reset` before `reconnect`), and the request is re-issued
//     so a freshly-refreshed token is picked up.
//   • surplus  — a transport blip retries the SAME candidate and produces ONE
//     terminal verdict, so the branch records at most one outcome per candidate;
//     an HTTP status is NOT retried here (the chain fails over instead) and an
//     empty 200 still shows no bubble.
//   • legacy   — the yielded `error` chunk is held back while a retry is
//     possible, and the retried attempt refills the SAME message id.
//
// Same style as chatStreamReconnect.test.ts: real helpers, scripted fake
// Responses, injected sleep — no network, no timers.

import { describe, it, expect } from 'vitest'
import type { ChatChunk } from '@tachi/core'
import {
  streamWithReconnect, streamAnthropicDeltas, streamOpenAiCompatDeltas,
  streamChunksWithReconnect, classifyChunkError,
} from '../../electron/services/chat-stream'

// ── fixtures ─────────────────────────────────────────────────────────────────

function okResponse(frames: string[]): Response {
  const enc = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]))
      else controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function dyingResponse(frames: string[], error: unknown): Response {
  const enc = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(enc.encode(frames[i++]))
      else controller.error(error)
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function econnreset(): Error {
  const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

// Anthropic /v1/messages SSE events.
const aStart = (created: number, read: number) =>
  `data: ${JSON.stringify({ type: 'message_start', message: { usage: { cache_creation_input_tokens: created, cache_read_input_tokens: read } } })}\n`
const aDelta = (text: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n`
const aUsage = (input: number, output: number) =>
  `data: ${JSON.stringify({ type: 'message_delta', usage: { input_tokens: input, output_tokens: output } })}\n`

// OpenAI-compat SSE (surplus wire).
const oDelta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`

const types = (sent: ChatChunk[]) => sent.map(c => c.type)
const text = (sent: ChatChunk[]) =>
  sent.filter(c => c.type === 'delta').map(c => (c as { text: string }).text).join('')

// ── anthropic-oauth ──────────────────────────────────────────────────────────

describe('anthropic-oauth stream (streamWithReconnect + streamAnthropicDeltas)', () => {
  /** Mirrors the chat-service branch: same drain, same options, scripted responses. */
  async function driveAnthropic(
    responses: Array<() => Promise<Response>>,
    opts: { abort?: AbortController; sleep?: (ms: number, s: AbortSignal) => Promise<void> } = {},
  ) {
    const sent: ChatChunk[] = []
    const usage: ChatChunk[] = []
    const cache: Array<[number, number]> = []
    const delays: number[] = []
    let chars = 0
    let requests = 0
    const abort = opts.abort ?? new AbortController()
    const result = await streamWithReconnect({
      abort,
      messageId: 'm1',
      model: 'claude-sonnet-4.6',
      send: (c) => sent.push(c),
      onChars: (n) => { chars += n },
      backoff: { rng: () => 0 },
      sleep: opts.sleep ?? (async (ms) => { delays.push(ms) }),
      openRequest: async () => {
        const next = responses[Math.min(requests, responses.length - 1)]!
        requests++
        return next()
      },
      drain: (ctx) => streamAnthropicDeltas({
        reader: ctx.res.body?.getReader(),
        abort: ctx.abort,
        messageId: ctx.messageId,
        send: ctx.send,
        recordUsageChunk: (c) => usage.push(c),
        onChars: ctx.onChars,
        onCacheTokens: (created, read) => cache.push([created, read]),
      }),
    })
    return { sent, usage, cache, delays, chars, requests, result }
  }

  it('streams Anthropic events straight through and reports cache + usage', async () => {
    const h = await driveAnthropic([async () => okResponse([aStart(120, 4_000), aDelta('Hi'), aDelta(' there'), aUsage(10, 2)])])
    expect(h.result).toMatchObject({ ok: true, retries: 0 })
    expect(types(h.sent)).toEqual(['start', 'delta', 'delta', 'usage'])
    expect(text(h.sent)).toBe('Hi there')
    expect(h.cache).toEqual([[120, 4_000]])
    expect(h.usage).toHaveLength(1)
    expect(h.usage[0]).toMatchObject({ usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } })
  })

  it('resumes after ONE simulated network drop, resetting the partial answer first', async () => {
    const h = await driveAnthropic([
      async () => dyingResponse([aStart(0, 0), aDelta('Half an ans')], econnreset()),
      async () => okResponse([aStart(0, 900), aDelta('Complete answer'), aUsage(9, 3)]),
    ])
    // The request is re-issued — that is what re-reads the OAuth token per attempt.
    expect(h.requests).toBe(2)
    expect(h.result).toMatchObject({ ok: true, retries: 1 })
    expect(types(h.sent)).toEqual(['start', 'delta', 'reset', 'reconnect', 'delta', 'usage', 'reconnect-resolved'])
    expect(h.sent.filter(c => c.type === 'start')).toHaveLength(1)
    expect(text(h.sent)).toBe('Half an ansComplete answer')  // the renderer drops the pre-`reset` half
    expect(h.chars).toBe('Complete answer'.length)           // …and the caller's total already has
    expect(h.sent.find(c => c.type === 'reconnect')).toMatchObject({ attempt: 1, maxAttempts: 10, delayMs: 1000 })
  })

  it('does not retry a 401 — an expired OAuth token must surface, not spin', async () => {
    const h = await driveAnthropic([async () => new Response('token expired', { status: 401 })])
    expect(h.requests).toBe(1)
    expect(h.result).toMatchObject({ ok: false, kind: 'http', status: 401, retries: 0 })
    expect(h.sent).toEqual([])
  })

  it('stops cleanly when Stop lands DURING the reconnect backoff', async () => {
    const abort = new AbortController()
    const h = await driveAnthropic(
      [async () => dyingResponse([aDelta('partial')], econnreset())],
      {
        abort,
        sleep: async () => {
          abort.abort()
          const e = new Error('The operation was aborted.'); e.name = 'AbortError'
          throw e
        },
      },
    )
    expect(h.requests).toBe(1)
    expect(h.result).toMatchObject({ ok: false, kind: 'aborted', retries: 1 })
    // The partial was rolled back before the (cancelled) wait; nothing streams after.
    expect(types(h.sent)).toEqual(['start', 'delta', 'reset', 'reconnect'])
  })
})

// ── surplus failover chain ───────────────────────────────────────────────────

describe('surplus candidate stream (deferred start + no HTTP retry)', () => {
  /** Mirrors the chat-service surplus branch options for ONE chain candidate. */
  async function driveCandidate(
    candidate: string,
    responses: Array<() => Promise<Response>>,
  ) {
    const sent: ChatChunk[] = []
    const bodies: string[] = []
    const delays: number[] = []
    let chars = 0
    let requests = 0
    const abort = new AbortController()
    const result = await streamWithReconnect({
      abort,
      messageId: 'm1',
      model: candidate,
      send: (c) => sent.push(c),
      onChars: (n) => { chars += n },
      startOn: 'first-delta',
      retryHttp: false,
      backoff: { rng: () => 0 },
      sleep: async (ms) => { delays.push(ms) },
      openRequest: async () => {
        bodies.push(JSON.stringify({ model: candidate, stream: true }))
        const next = responses[Math.min(requests, responses.length - 1)]!
        requests++
        return next()
      },
      drain: (ctx) => streamOpenAiCompatDeltas({
        reader: ctx.res.body?.getReader(),
        abort: ctx.abort,
        messageId: ctx.messageId,
        send: (chunk) => { if (chunk.type === 'delta') ctx.markStarted(); ctx.send(chunk) },
        recordUsageChunk: () => {},
        onChars: ctx.onChars,
      }),
    })
    return { sent, bodies, delays, chars, requests, result }
  }

  it('reconnects to the SAME candidate on a transport blip and yields ONE success verdict', async () => {
    const h = await driveCandidate('claude-sonnet-4.5', [
      async () => dyingResponse([oDelta('half')], econnreset()),
      async () => okResponse([oDelta('whole answer'), 'data: [DONE]\n']),
    ])
    expect(h.requests).toBe(2)
    // Same model on the retry — never a silent fail-over to the next chain entry.
    expect(new Set(h.bodies.map(b => JSON.parse(b).model))).toEqual(new Set(['claude-sonnet-4.5']))
    // ONE terminal verdict. The branch records outcome/cooldown/Elo from this
    // result alone, so the recovered blip contributes exactly zero failures.
    expect(h.result).toMatchObject({ ok: true, retries: 1 })
    expect(h.chars).toBe('whole answer'.length)
    // `start` stays single across attempts (one bubble); `reset` clears the partial.
    expect(types(h.sent)).toEqual(['start', 'delta', 'reset', 'reconnect', 'delta', 'reconnect-resolved'])
  })

  it('emits the RETRYING banner chunk verbatim (attempt/maxAttempts/delayMs/reason)', async () => {
    const h = await driveCandidate('m', [
      async () => dyingResponse([oDelta('x')], econnreset()),
      async () => okResponse([oDelta('y'), 'data: [DONE]\n']),
    ])
    expect(h.sent.find(c => c.type === 'reconnect')).toEqual({
      type: 'reconnect', messageId: 'm1', attempt: 1, maxAttempts: 10, delayMs: 1000, reason: 'econnreset',
    })
  })

  it('does NOT retry a 503 — the chain fails over instead, one verdict, no backoff', async () => {
    const h = await driveCandidate('m', [async () => new Response('busy', { status: 503 })])
    expect(h.requests).toBe(1)
    expect(h.delays).toEqual([])
    expect(h.result).toMatchObject({ ok: false, kind: 'http', status: 503, body: 'busy', retries: 0 })
    expect(h.sent).toEqual([])
  })

  it('shows no bubble at all for an empty (degraded) 200 so failover stays invisible', async () => {
    const h = await driveCandidate('m', [async () => okResponse(['data: [DONE]\n'])])
    expect(h.result).toMatchObject({ ok: true, retries: 0 })
    expect(h.chars).toBe(0)
    expect(h.sent).toEqual([])
  })

  it('spends the whole budget on the same candidate before giving the chain its verdict', async () => {
    const h = await driveCandidate('m', [async () => { throw econnreset() }])
    expect(h.requests).toBe(11)                       // 1 original + 10 reconnects
    expect(h.result).toMatchObject({ ok: false, kind: 'network', chars: 0, retries: 10 })
    expect(h.sent.filter(c => c.type === 'reconnect')).toHaveLength(10)
  })
})

// ── legacy ChatBackend path ──────────────────────────────────────────────────

describe('classifyChunkError', () => {
  it('treats a swallowed transport death as retryable', () => {
    expect(classifyChunkError({ code: 'NETWORK_ERROR' })).toMatchObject({ kind: 'retryable' })
    expect(classifyChunkError({ code: 'MALFORMED_SSE' })).toMatchObject({ kind: 'retryable' })
    expect(classifyChunkError({ code: 'RATE_LIMITED' })).toMatchObject({ kind: 'retryable', reason: 'http-429' })
    expect(classifyChunkError({ code: 'HTTP_503' })).toMatchObject({ kind: 'retryable', reason: 'http-503' })
  })

  it('never retries a request the provider will refuse identically', () => {
    expect(classifyChunkError({ code: 'HTTP_401' })).toMatchObject({ kind: 'fatal' })
    expect(classifyChunkError({ code: 'NO_KEY' })).toMatchObject({ kind: 'fatal' })
    expect(classifyChunkError(undefined)).toMatchObject({ kind: 'fatal' })
  })
})

describe('legacy backend stream (streamChunksWithReconnect)', () => {
  function backendScript(...attempts: ChatChunk[][]) {
    let n = 0
    const opened: number[] = []
    const open = () => {
      const frames = attempts[Math.min(n, attempts.length - 1)]!
      opened.push(n)
      n++
      return (async function* () { for (const c of frames) yield c })()
    }
    return { open, opened }
  }

  const start = (id: string): ChatChunk => ({ type: 'start', messageId: id, model: 'legacy-model' })
  const delta = (id: string, t: string): ChatChunk => ({ type: 'delta', messageId: id, text: t })
  const done = (id: string): ChatChunk => ({ type: 'done', messageId: id })
  const err = (id: string, code: string): ChatChunk => ({ type: 'error', messageId: id, error: { code, message: code } })

  async function drive(script: ReturnType<typeof backendScript>, abort = new AbortController()) {
    const sent: ChatChunk[] = []
    const delays: number[] = []
    const result = await streamChunksWithReconnect({
      abort,
      open: script.open,
      send: (c) => sent.push(c),
      backoff: { rng: () => 0 },
      sleep: async (ms) => { delays.push(ms) },
    })
    return { sent, delays, result }
  }

  it('forwards a clean stream and never leaks the backend `done` (the caller owns it)', async () => {
    const h = await drive(backendScript([start('a'), delta('a', 'hello'), done('a')]))
    expect(h.result).toMatchObject({ ok: true, messageId: 'a', chars: 5, retries: 0 })
    expect(types(h.sent)).toEqual(['start', 'delta'])
  })

  it('reconnects on a swallowed NETWORK_ERROR and refills the SAME bubble', async () => {
    const h = await drive(backendScript(
      [start('a'), delta('a', 'half'), err('a', 'NETWORK_ERROR')],
      [start('b'), delta('b', 'the whole answer'), done('b')],
    ))
    expect(h.result).toMatchObject({ ok: true, messageId: 'a', retries: 1 })
    // `reset` precedes `reconnect`, the retry's `start` is suppressed, and every
    // chunk carries the FIRST attempt's id — one bubble, not two.
    expect(types(h.sent)).toEqual(['start', 'delta', 'reset', 'reconnect', 'delta', 'reconnect-resolved'])
    expect(h.sent.every(c => c.messageId === 'a')).toBe(true)
    expect(h.result).toMatchObject({ chars: 'the whole answer'.length })
    expect(h.delays).toEqual([1000])
  })

  it('holds the error chunk back only while a retry is possible, then hands it over', async () => {
    const h = await drive(backendScript([start('a'), err('a', 'HTTP_401')]))
    expect(h.result).toMatchObject({ ok: false, kind: 'failed', retries: 0 })
    // The error is NOT forwarded inline — the caller emits it, then `done`.
    expect(types(h.sent)).toEqual(['start'])
    expect((h.result as { errorChunk: ChatChunk }).errorChunk).toMatchObject({ type: 'error', messageId: 'a' })
  })

  it('stops cleanly when Stop lands during the reconnect backoff', async () => {
    const abort = new AbortController()
    const script = backendScript([start('a'), delta('a', 'partial'), err('a', 'NETWORK_ERROR')])
    const sent: ChatChunk[] = []
    const result = await streamChunksWithReconnect({
      abort,
      open: script.open,
      send: (c) => sent.push(c),
      backoff: { rng: () => 0 },
      sleep: async () => {
        abort.abort()
        const e = new Error('The operation was aborted.'); e.name = 'AbortError'
        throw e
      },
    })
    expect(result).toMatchObject({ ok: false, kind: 'aborted', messageId: 'a', retries: 1 })
    expect(script.opened).toHaveLength(1)
    expect(types(sent)).toEqual(['start', 'delta', 'reset', 'reconnect'])
  })

  it('treats Stop mid-stream as terminal — no retry, no error chunk', async () => {
    const abort = new AbortController()
    let n = 0
    const sent: ChatChunk[] = []
    const result = await streamChunksWithReconnect({
      abort,
      open: () => (async function* () {
        yield start('a')
        yield delta('a', 'x')
        abort.abort()
        yield delta('a', 'never rendered')
      })(),
      send: (c) => { sent.push(c); n++ },
      sleep: async () => { throw new Error('must not sleep') },
    })
    expect(result).toMatchObject({ ok: false, kind: 'aborted', messageId: 'a' })
    expect(types(sent)).toEqual(['start', 'delta'])
    expect(n).toBe(2)
  })
})
