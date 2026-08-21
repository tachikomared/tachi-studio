// apps/desktop/test/unit/chatStreamOpenAi.test.ts
//
// Unit coverage for the shared OpenAI-compat SSE loop extracted from
// chat-service.ts (audit M2 dedup). Drives the helper with a scripted byte
// reader + a fake `send`, asserting the exact normalized chunk sequence — the
// "golden transcript" guard the refactor plan asked for, so the four provider
// branches can share one loop without silent drift.

import { describe, it, expect } from 'vitest'
import type { ChatChunk } from '@tachi/core'
import {
  extractOpenAiStreamDelta,
  streamOpenAiCompatDeltas,
  type SseByteReader,
} from '../../electron/services/chat-stream'

/** A reader that yields each string as one UTF-8 byte frame, then done. */
function frameReader(frames: string[]): SseByteReader {
  const enc = new TextEncoder()
  let i = 0
  return { read: async () => (i < frames.length ? { done: false, value: enc.encode(frames[i++]) } : { done: true }) }
}

function harness(reader: SseByteReader | undefined, abort = new AbortController()) {
  const sent: ChatChunk[] = []
  const usage: ChatChunk[] = []
  let chars = 0
  const run = () =>
    streamOpenAiCompatDeltas({
      reader,
      abort,
      messageId: 'm1',
      send: (c) => sent.push(c),
      recordUsageChunk: (c) => usage.push(c),
      onChars: (n) => { chars += n },
    })
  return { run, sent, usage, abort, chars: () => chars }
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n`

describe('extractOpenAiStreamDelta', () => {
  it('reads the canonical chat-completions path, then known fallbacks', () => {
    expect(extractOpenAiStreamDelta({ choices: [{ delta: { content: 'x' } }] })).toBe('x')
    expect(extractOpenAiStreamDelta({ choices: [{ delta: { text: 'y' } }] })).toBe('y')
    expect(extractOpenAiStreamDelta({ choices: [{ text: 'z' }] })).toBe('z')
  })
  it('returns undefined for textless chunks (role-only open, usage-only final)', () => {
    expect(extractOpenAiStreamDelta({ choices: [{ delta: { role: 'assistant' } }] })).toBeUndefined()
    expect(extractOpenAiStreamDelta({ usage: { total_tokens: 9 } })).toBeUndefined()
  })
})

describe('served-model provenance (gateway aliases resolve server-side)', () => {
  // Driver-proven 2026-08-01: a Kilo reply was labelled "Free" — the tail of
  // the alias `kilo-auto/free` — while the gateway had routed to a real model.
  // chat-service already documents that Kilo's response id can differ from the
  // request id, so the wire's `model` is the fact and the alias is the guess.
  function servedHarness(frames: string[]) {
    const served: string[] = []
    return {
      served,
      run: () => streamOpenAiCompatDeltas({
        reader: frameReader(frames),
        abort: new AbortController(),
        messageId: 'm1',
        send: () => {},
        recordUsageChunk: () => {},
        onChars: () => {},
        onServedModel: (m) => served.push(m),
      }),
    }
  }

  it('reports the model the provider says answered — ONCE, from the first chunk', async () => {
    const h = servedHarness([
      sse({ model: 'deepseek-v4-flash', choices: [{ delta: { content: 'a' } }] }),
      sse({ model: 'deepseek-v4-flash', choices: [{ delta: { content: 'b' } }] }),
      'data: [DONE]\n',
    ])
    await h.run()
    expect(h.served).toEqual(['deepseek-v4-flash'])
  })

  it('stays SILENT when the wire names no model — the alias is surfaced, never invented', async () => {
    const h = servedHarness([
      sse({ choices: [{ delta: { content: 'a' } }] }),
      sse({ model: '   ', choices: [{ delta: { content: 'b' } }] }),
      'data: [DONE]\n',
    ])
    await h.run()
    expect(h.served).toEqual([])
  })
})

describe('streamOpenAiCompatDeltas', () => {
  it('emits deltas in order, parses usage, and totals chars via onChars', async () => {
    const h = harness(frameReader([
      sse({ choices: [{ delta: { content: 'Hello' } }] }),
      sse({ choices: [{ delta: { content: ' world' } }] }),
      sse({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
      'data: [DONE]\n',
    ]))
    await h.run()
    expect(h.sent).toEqual([
      { type: 'delta', messageId: 'm1', text: 'Hello' },
      { type: 'delta', messageId: 'm1', text: ' world' },
      { type: 'usage', messageId: 'm1', usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } },
    ])
    // usage forwarded to the ledger sink exactly once
    expect(h.usage).toHaveLength(1)
    expect(h.usage[0]).toMatchObject({ type: 'usage' })
    expect(h.chars()).toBe('Hello'.length + ' world'.length)
  })

  it('buffers a frame split across two reads', async () => {
    const h = harness(frameReader([
      'data: {"choices":[{"delta":{"con',          // first read: incomplete line, no newline
      'tent":"split"}}]}\n',                         // second read: completes the line
    ]))
    await h.run()
    expect(h.sent).toEqual([{ type: 'delta', messageId: 'm1', text: 'split' }])
    expect(h.chars()).toBe('split'.length)
  })

  it('stops at [DONE] and ignores trailing lines in the same frame', async () => {
    const h = harness(frameReader([
      `${sse({ choices: [{ delta: { content: 'A' } }] })}data: [DONE]\n${sse({ choices: [{ delta: { content: 'AFTER' } }] })}`,
    ]))
    await h.run()
    expect(h.sent).toEqual([{ type: 'delta', messageId: 'm1', text: 'A' }])
  })

  it('skips malformed JSON lines without breaking the stream', async () => {
    const h = harness(frameReader([
      'data: {not json}\n',
      sse({ choices: [{ delta: { content: 'ok' } }] }),
    ]))
    await h.run()
    expect(h.sent).toEqual([{ type: 'delta', messageId: 'm1', text: 'ok' }])
  })

  it('does nothing when already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const h = harness(frameReader([sse({ choices: [{ delta: { content: 'never' } }] })]), ac)
    await h.run()
    expect(h.sent).toEqual([])
  })

  it('is a no-op when the body has no reader', async () => {
    const h = harness(undefined)
    await h.run()
    expect(h.sent).toEqual([])
  })

  it('propagates a mid-stream read rejection but keeps the already-streamed chars', async () => {
    let n = 0
    const reader: SseByteReader = {
      read: async () => {
        n++
        if (n === 1) return { done: false, value: new TextEncoder().encode(sse({ choices: [{ delta: { content: 'partial' } }] })) }
        throw new Error('socket reset')
      },
    }
    const h = harness(reader)
    await expect(h.run()).rejects.toThrow(/socket reset|stalled/)
    expect(h.sent).toEqual([{ type: 'delta', messageId: 'm1', text: 'partial' }])
    expect(h.chars()).toBe('partial'.length) // caller's finally would see this partial count
  })
})
