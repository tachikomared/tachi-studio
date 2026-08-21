// apps/desktop/test/unit/chatStreamReconnect.test.ts
//
// CONNECTION RESILIENCE for the chat streams. A chat turn is a single model
// request with no side effects, so recovery is "just ask again" — but the user
// has already SEEN the half-written answer, so the contract that matters is
// the ordering: `reset` (throw the partial away) must precede `reconnect`
// (announce the retry), or the reply renders twice.
//
// Drives the real helper with scripted fake Responses; no network, no timers.

import { describe, it, expect } from 'vitest'
import type { ChatChunk } from '@tachi/core'
import { streamOpenAiCompatWithReconnect } from '../../electron/services/chat-stream'

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n`
const delta = (text: string) => sse({ choices: [{ delta: { content: text } }] })

/** A Response whose body streams the given frames, then ends cleanly. */
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

/** A Response that streams a few frames and then ERRORS mid-body (socket death). */
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

function httpResponse(status: number, body = 'nope', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

function econnreset(): Error {
  const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

interface Harness {
  sent: ChatChunk[]
  chars: number
  requests: number
  delays: number[]
}

async function drive(
  responses: Array<() => Promise<Response>>,
  overrides: Partial<Parameters<typeof streamOpenAiCompatWithReconnect>[0]> = {},
) {
  const h: Harness = { sent: [], chars: 0, requests: 0, delays: [] }
  const abort = overrides.abort ?? new AbortController()
  const result = await streamOpenAiCompatWithReconnect({
    messageId: 'm1',
    model: 'test-model',
    abort,
    send: (c) => h.sent.push(c),
    recordUsageChunk: () => {},
    onChars: (n) => { h.chars += n },
    backoff: { rng: () => 0 },
    sleep: async (ms) => { h.delays.push(ms) },
    openRequest: async () => {
      const next = responses[Math.min(h.requests, responses.length - 1)]
      h.requests++
      return next()
    },
    ...overrides,
  })
  return { ...h, result }
}

const types = (sent: ChatChunk[]) => sent.map(c => c.type)
const text = (sent: ChatChunk[]) =>
  sent.filter(c => c.type === 'delta').map(c => (c as { text: string }).text).join('')

describe('streamOpenAiCompatWithReconnect', () => {
  it('streams straight through when nothing goes wrong', async () => {
    const h = await drive([async () => okResponse([delta('Hello'), delta(' world'), 'data: [DONE]\n'])])
    expect(h.result).toMatchObject({ ok: true, retries: 0 })
    expect(types(h.sent)).toEqual(['start', 'delta', 'delta'])
    expect(text(h.sent)).toBe('Hello world')
    expect(h.chars).toBe('Hello world'.length)
    expect(h.delays).toEqual([])
  })

  it('resets the partial answer BEFORE announcing the retry, then recovers', async () => {
    const h = await drive([
      async () => dyingResponse([delta('Half a')], econnreset()),
      async () => okResponse([delta('Complete answer'), 'data: [DONE]\n']),
    ])

    expect(h.requests).toBe(2)
    expect(h.result).toMatchObject({ ok: true, retries: 1 })
    // Ordering is the whole ballgame: start, the doomed delta, reset, reconnect,
    // the real delta, resolved.
    expect(types(h.sent)).toEqual(['start', 'delta', 'reset', 'reconnect', 'delta', 'reconnect-resolved'])
    // `start` is sent ONCE — the renderer must not create a second bubble.
    expect(h.sent.filter(c => c.type === 'start')).toHaveLength(1)
    // The discarded chars are rolled back, so the caller's total is the final answer only.
    expect(h.chars).toBe('Complete answer'.length)
    const rc = h.sent.find(c => c.type === 'reconnect') as { attempt: number; maxAttempts: number; delayMs: number }
    expect(rc).toMatchObject({ attempt: 1, maxAttempts: 10, delayMs: 1000 })
    expect(h.delays).toEqual([1000])
  })

  it('retries a 503 with the documented backoff and no partial-text bubble', async () => {
    const h = await drive([
      async () => httpResponse(503, 'upstream down'),
      async () => httpResponse(503, 'upstream down'),
      async () => okResponse([delta('Back.'), 'data: [DONE]\n']),
    ])
    expect(h.requests).toBe(3)
    expect(h.result).toMatchObject({ ok: true, retries: 2 })
    expect(h.delays).toEqual([1000, 2000])
    // Nothing had streamed yet, so there is no `reset` to send.
    expect(types(h.sent)).toEqual(['reconnect', 'reconnect', 'start', 'delta', 'reconnect-resolved'])
  })

  it('honours Retry-After on a 429 instead of its own curve', async () => {
    const h = await drive([
      async () => httpResponse(429, 'slow down', { 'retry-after': '5' }),
      async () => okResponse([delta('ok'), 'data: [DONE]\n']),
    ])
    expect(h.delays).toEqual([5000])
    expect(h.result).toMatchObject({ ok: true })
  })

  it('does not retry a 401 — one request, fatal', async () => {
    const h = await drive([async () => httpResponse(401, 'bad key')])
    expect(h.requests).toBe(1)
    expect(h.delays).toEqual([])
    expect(h.result).toMatchObject({ ok: false, kind: 'http', status: 401, body: 'bad key', retries: 0 })
    expect(types(h.sent)).toEqual([])
  })

  it('exhausts exactly 10 attempts then reports the network failure', async () => {
    const h = await drive([async () => { throw econnreset() }])
    expect(h.requests).toBe(11)          // 1 original + 10 reconnects
    expect(h.delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000])
    expect(h.result).toMatchObject({ ok: false, kind: 'network', retries: 10 })
    expect(h.sent.filter(c => c.type === 'reconnect')).toHaveLength(10)
    expect(h.sent.some(c => c.type === 'reconnect-resolved')).toBe(false)
  })

  it('reports the failure to onAttemptFailure only once it is final', async () => {
    const seen: Array<{ status?: number; willRetry: boolean }> = []
    await drive(
      [
        async () => httpResponse(500),
        async () => httpResponse(500),
        async () => okResponse([delta('fine'), 'data: [DONE]\n']),
      ],
      { onAttemptFailure: ({ status, willRetry }) => { seen.push({ status, willRetry }) } },
    )
    // Two failures, both recoverable — the model must not be parked for either.
    expect(seen).toEqual([{ status: 500, willRetry: true }, { status: 500, willRetry: true }])
  })

  it('treats Stop as terminal — no classification, no backoff', async () => {
    const abort = new AbortController()
    const h = await drive(
      [async () => { abort.abort(); throw econnreset() }],
      { abort },
    )
    expect(h.result).toMatchObject({ ok: false, kind: 'aborted' })
    expect(h.delays).toEqual([])
    expect(h.sent.some(c => c.type === 'reconnect')).toBe(false)
  })

  it('cancels instantly when Stop lands during the backoff', async () => {
    const abort = new AbortController()
    const h = await drive(
      [async () => { throw econnreset() }],
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
  })
})
