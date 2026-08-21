// apps/desktop/test/unit/tachi-loop-reconnect.test.ts
//
// CONNECTION RESILIENCE in the TACHI harness, proven end-to-end against a MOCK
// model (no network, no electron). The pain being fixed: a one-second internet
// drop used to kill the whole run. These tests assert the three things that
// make the fix trustworthy rather than merely present:
//
//   1. a round that dies before any tool ran is RE-REQUESTED, and the tool it
//      eventually calls executes EXACTLY ONCE (no double write);
//   2. completed rounds are not replayed — the re-request carries the finished
//      round's assistant/tool messages forward;
//   3. Stop during a backoff cancels instantly, and a non-retryable failure
//      still fails fast instead of burning 10 attempts.
//
// Timers are injected (`retry.sleep`) so nothing here waits on wall-clock time.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-reconnect-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
const MODEL_ID = 'claude-opus-4.8'

function econnreset(): Error {
  const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
  return Object.assign(new TypeError('fetch failed'), { cause })
}

/** Chunks for a round that calls `write` with the given content. */
function writeRound(content: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'tool-call' as const, toolCallId: 't1', toolName: 'write', input: JSON.stringify({ path: 'out.txt', content }) },
    { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE },
  ]
}

/** Chunks for a round that answers in plain text. */
function textRound(text: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 'a' },
    { type: 'text-delta' as const, id: 'a', delta: text },
    { type: 'text-end' as const, id: 'a' },
    { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE },
  ]
}

interface Harness {
  events: AgentEvent[]
  calls: number
  texts: string
  reconnects: Extract<AgentEvent, { type: 'reconnect' }>[]
}

async function run(model: MockLanguageModelV3, extra: Partial<Parameters<typeof runTachiLoop>[0]> = {}): Promise<Harness> {
  const events: AgentEvent[] = []
  const ac = new AbortController()
  await runTachiLoop({
    model,
    modelId: MODEL_ID,
    workspaceRoot: ws,
    task: 'write out.txt',
    signal: extra.signal ?? ac.signal,
    onEvent: (e) => events.push(e),
    gate: async () => true,
    maxSteps: 6,
    // Deterministic: no jitter, no real waiting.
    retry: { backoff: { rng: () => 0 }, sleep: async () => {} },
    ...extra,
  })
  return {
    events,
    calls: 0,
    texts: events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join(''),
    reconnects: events.filter(e => e.type === 'reconnect') as Extract<AgentEvent, { type: 'reconnect' }>[],
  }
}

describe('TACHI loop — reconnect after a dropped stream', () => {
  it('re-requests a round that died twice, runs its tool ONCE, and reports progress', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        // Rounds 1-2 die: first before the stream starts (connect failure),
        // then mid-stream (socket reset while the body was flowing).
        if (call === 1) throw econnreset()
        if (call === 2) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'thinking abo' },
                { type: 'error', error: econnreset() },
              ],
            }),
          }
        }
        // Round 3 is the same request, answered properly.
        if (call === 3) return { stream: simulateReadableStream({ chunks: writeRound('hello') }) }
        return { stream: simulateReadableStream({ chunks: textRound('Done — wrote out.txt.') }) }
      },
    })

    const h = await run(model)

    // Three requests for the FIRST round + one for the round after the tool.
    expect(call).toBe(4)

    // The tool executed exactly once, with the right content.
    const writes = h.events.filter(e => e.type === 'tool-call' && (e as { name: string }).name === 'write')
    expect(writes).toHaveLength(1)
    expect(existsSync(join(ws, 'out.txt'))).toBe(true)
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('hello')

    // Two visible reconnect attempts, numbered 1 and 2 out of 10, with the
    // documented backoff (jitter pinned to 0).
    expect(h.reconnects.map(r => r.attempt)).toEqual([1, 2])
    expect(h.reconnects.map(r => r.maxAttempts)).toEqual([10, 10])
    expect(h.reconnects.map(r => r.delayMs)).toEqual([1000, 2000])
    expect(h.reconnects.every(r => r.reason.length > 0)).toBe(true)

    // Recovery is announced, and the run ends normally — not in error.
    expect(h.events.some(e => e.type === 'reconnect-resolved')).toBe(true)
    expect(h.events.some(e => e.type === 'error')).toBe(false)
    expect(h.events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
  })

  it('does not re-emit the partial text of a round it discarded', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'a' },
                { type: 'text-delta', id: 'a', delta: 'PARTIAL' },
                { type: 'error', error: econnreset() },
              ],
            }),
          }
        }
        return { stream: simulateReadableStream({ chunks: textRound('FULL ANSWER') }) }
      },
    })

    const h = await run(model)
    expect(call).toBe(2)
    // The discarded prefix streamed once (it was already on screen) and is NOT
    // repeated — the retried round contributes only its own text.
    expect(h.texts.match(/PARTIAL/g) ?? []).toHaveLength(1)
    expect(h.texts.match(/FULL ANSWER/g) ?? []).toHaveLength(1)
  })

  it('carries a COMPLETED round forward — its tool is not run a second time', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        call++
        if (call === 1) return { stream: simulateReadableStream({ chunks: writeRound('first') }) }
        if (call === 2) {
          // The round AFTER the tool dies mid-stream.
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'stream-start', warnings: [] },
                { type: 'error', error: econnreset() },
              ],
            }),
          }
        }
        // The re-request must already contain the tool result, i.e. the SDK is
        // resuming, not restarting from the bare task.
        const roles = prompt.map(m => m.role)
        expect(roles).toContain('tool')
        return { stream: simulateReadableStream({ chunks: textRound('Recovered.') }) }
      },
    })

    const h = await run(model)
    expect(call).toBe(3)
    expect(h.events.filter(e => e.type === 'tool-call')).toHaveLength(1)
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('first')
    expect(h.reconnects.map(r => r.attempt)).toEqual([1])
    expect(h.events.at(-1)).toEqual({ type: 'done', reason: 'stop' })
  })

  it('gives up after exactly 10 attempts and surfaces the error', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => { call++; throw econnreset() },
    })

    const h = await run(model)
    // 1 original + 10 reconnects.
    expect(call).toBe(11)
    expect(h.reconnects).toHaveLength(10)
    expect(h.reconnects.at(-1)!.attempt).toBe(10)
    const err = h.events.find(e => e.type === 'error') as { message: string } | undefined
    expect(err?.message).toMatch(/could not be restored after 10 attempt/i)
    expect(h.events.at(-1)).toEqual({ type: 'done', reason: 'error' })
  })

  it('fails fast on a non-retryable error — no attempts spent', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => { call++; throw Object.assign(new Error('Invalid API key provided'), { statusCode: 401 }) },
    })

    const h = await run(model)
    expect(call).toBe(1)
    expect(h.reconnects).toHaveLength(0)
    expect(h.events.some(e => e.type === 'error')).toBe(true)
    expect(h.events.at(-1)).toEqual({ type: 'done', reason: 'error' })
  })

  it('cancels instantly when the user aborts during the backoff', async () => {
    const ac = new AbortController()
    let call = 0
    let sleeps = 0
    const model = new MockLanguageModelV3({
      doStream: async () => { call++; throw econnreset() },
    })

    const events: AgentEvent[] = []
    await runTachiLoop({
      model,
      modelId: MODEL_ID,
      workspaceRoot: ws,
      task: 'write out.txt',
      signal: ac.signal,
      onEvent: (e) => events.push(e),
      gate: async () => true,
      maxSteps: 6,
      retry: {
        backoff: { rng: () => 0 },
        // Stand in for delayWithAbort: Stop lands mid-wait and must reject at once.
        sleep: async () => {
          sleeps++
          ac.abort()
          const e = new Error('The operation was aborted.'); e.name = 'AbortError'
          throw e
        },
      },
    })

    expect(sleeps).toBe(1)          // aborted inside the FIRST backoff
    expect(call).toBe(1)            // and never re-requested
    expect(events.filter(e => e.type === 'reconnect')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'abort' })
    expect(events.some(e => e.type === 'error')).toBe(false)
  })
})
