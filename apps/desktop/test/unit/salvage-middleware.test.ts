// apps/desktop/test/unit/salvage-middleware.test.ts
//
// Unit coverage for the salvage middleware transform: it converts tool calls
// emitted as TEXT (the DeepSeek/Qwen/Groq case) into native tool-call stream
// parts and rewrites the finish reason to 'tool-calls', while leaving ordinary
// prose and genuine native tool-calls untouched.

import { describe, it, expect } from 'vitest'
import { simulateReadableStream } from 'ai/test'
import { createSalvageMiddleware } from '../../electron/services/tachi/salvage-middleware'

async function collect(stream: ReadableStream): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  const reader = stream.getReader()
  for (;;) { const { done, value } = await reader.read(); if (done) break; out.push(value as Record<string, unknown>) }
  return out
}

async function runMw(chunks: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  const mw = createSalvageMiddleware()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (mw.wrapStream as any)({ doStream: async () => ({ stream: simulateReadableStream({ chunks }) }) })
  return collect(res.stream)
}

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage: USAGE })
const text = (t: string) => [{ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: t }, { type: 'text-end', id: 'a' }]
const tc = (parts: Array<Record<string, unknown>>) => parts.filter(p => p.type === 'tool-call')

describe('createSalvageMiddleware', () => {
  it('salvages a <tool_call> emitted as text into a tool-call part and rewrites finish to tool-calls', async () => {
    const out = await runMw([
      { type: 'stream-start', warnings: [] },
      ...text('<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>'),
      finish('stop'),
    ])
    const calls = tc(out)
    expect(calls.length).toBe(1)
    expect(calls[0]!.toolName).toBe('read')
    expect(JSON.parse(calls[0]!.input as string)).toEqual({ path: 'a.txt' })
    const fin = out.find(p => p.type === 'finish') as { finishReason: { unified: string } }
    expect(fin.finishReason.unified).toBe('tool-calls')
  })

  it('also handles the <function=NAME>{...}</function> encoding', async () => {
    const out = await runMw([
      { type: 'stream-start', warnings: [] },
      ...text('<function=write>{"path":"o.txt","content":"hi"}</function>'),
      finish('stop'),
    ])
    const calls = tc(out)
    expect(calls.length).toBe(1)
    expect(calls[0]!.toolName).toBe('write')
    expect(JSON.parse(calls[0]!.input as string)).toEqual({ path: 'o.txt', content: 'hi' })
  })

  it('leaves ordinary prose untouched (no tool-call, finish unchanged)', async () => {
    const out = await runMw([
      { type: 'stream-start', warnings: [] },
      ...text('Here is a normal answer. It mentions a function but is not a call.'),
      finish('stop'),
    ])
    expect(tc(out).length).toBe(0)
    const fin = out.find(p => p.type === 'finish') as { finishReason: { unified: string } }
    expect(fin.finishReason.unified).toBe('stop')
  })

  it('does NOT salvage when a native tool-call is already present', async () => {
    const out = await runMw([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'native1', toolName: 'read', input: JSON.stringify({ path: 'x' }) },
      ...text('<tool_call>{"name":"write","arguments":{"path":"y","content":"z"}}</tool_call>'),
      finish('tool-calls'),
    ])
    const calls = tc(out)
    expect(calls.length).toBe(1)            // only the native one passes through
    expect(calls[0]!.toolName).toBe('read') // salvage did NOT add 'write'
  })

  it('does NOT salvage twice when the stream emits two finish parts (latched)', async () => {
    const out = await runMw([
      { type: 'stream-start', warnings: [] },
      ...text('<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>'),
      finish('stop'),
      finish('stop'), // a misbehaving gateway/proxy double-finish must not double-execute
    ])
    expect(tc(out).length).toBe(1)
  })

  it('gives each salvaged call a unique synthetic id', async () => {
    const out = await runMw([
      { type: 'stream-start', warnings: [] },
      ...text('<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>\n<tool_call>{"name":"read","arguments":{"path":"b"}}</tool_call>'),
      finish('stop'),
    ])
    const ids = tc(out).map(p => p.toolCallId)
    expect(ids.length).toBe(2)
    expect(new Set(ids).size).toBe(2)
  })
})
