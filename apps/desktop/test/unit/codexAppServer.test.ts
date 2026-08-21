// apps/desktop/test/unit/codexAppServer.test.ts
//
// Unit tests for the PURE Codex app-server transport helpers (no electron, no
// child process): newline-delimited JSON-RPC framing, message classification /
// id correlation, the pending-request registry (settle/fail/timeout), the
// exec-fallback decision, and thread-item progress summarization.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  encodeRpc,
  decodeFrames,
  classifyMessage,
  responseIdOf,
  summarizeThreadItem,
  shouldFallbackToExec,
  PendingRequests,
  type TransportAttempt,
  type RpcMessage,
} from '../../electron/services/codex-app-server'
import type { CodexTaskResult } from '../../electron/services/codex-worker-core'

describe('encodeRpc / decodeFrames (framing codec)', () => {
  it('round-trips a single message through encode → decode', () => {
    const msg = { jsonrpc: '2.0', id: 7, method: 'turn/start', params: { threadId: 'abc' } }
    const wire = encodeRpc(msg)
    expect(wire.endsWith('\n')).toBe(true)
    const { messages, rest } = decodeFrames('', wire)
    expect(messages).toEqual([msg])
    expect(rest).toBe('')
  })

  it('decodes several messages arriving in one chunk', () => {
    const wire = encodeRpc({ id: 1, result: {} }) + encodeRpc({ method: 'turn/completed', params: {} })
    const { messages, rest } = decodeFrames('', wire)
    expect(messages).toHaveLength(2)
    expect(rest).toBe('')
  })

  it('reassembles a message split across two chunks (partial-chunk reassembly)', () => {
    const full = encodeRpc({ id: 42, result: { thread: { id: 'T' } } })
    const cut = Math.floor(full.length / 2)
    const first = decodeFrames('', full.slice(0, cut))
    expect(first.messages).toEqual([])                 // nothing complete yet
    expect(first.rest).toBe(full.slice(0, cut))        // buffered
    const second = decodeFrames(first.rest, full.slice(cut))
    expect(second.messages).toEqual([{ id: 42, result: { thread: { id: 'T' } } }])
    expect(second.rest).toBe('')
  })

  it('carries a trailing partial line forward while emitting complete ones', () => {
    const complete = encodeRpc({ id: 1, result: 'ok' })
    const partial = '{"id":2,"resu'
    const { messages, rest } = decodeFrames('', complete + partial)
    expect(messages).toEqual([{ id: 1, result: 'ok' }])
    expect(rest).toBe(partial)
    // Finishing the partial in the next chunk yields the second message.
    const next = decodeFrames(rest, 'lt":"done"}\n')
    expect(next.messages).toEqual([{ id: 2, result: 'done' }])
  })

  it('handles CRLF and strips carriage returns', () => {
    const wire = JSON.stringify({ id: 9, result: 1 }) + '\r\n'
    const { messages, rest } = decodeFrames('', wire)
    expect(messages).toEqual([{ id: 9, result: 1 }])
    expect(rest).toBe('')
  })

  it('skips blank lines and non-JSON banner/log noise without desyncing', () => {
    const wire = '\n' + 'codex app-server starting…\n' + encodeRpc({ id: 3, result: true }) + '   \n'
    const { messages } = decodeFrames('', wire)
    expect(messages).toEqual([{ id: 3, result: true }])
  })

  it('drops a single malformed JSON line but keeps the surrounding valid ones', () => {
    const wire = encodeRpc({ id: 1, result: 'a' }) + '{ not valid json }\n' + encodeRpc({ id: 2, result: 'b' })
    const { messages } = decodeFrames('', wire)
    expect(messages).toEqual([{ id: 1, result: 'a' }, { id: 2, result: 'b' }])
  })
})

describe('classifyMessage / responseIdOf (id correlation)', () => {
  it('classifies a response (id + result)', () => {
    const m: RpcMessage = { id: 5, result: { ok: true } }
    expect(classifyMessage(m)).toBe('response')
    expect(responseIdOf(m)).toBe(5)
  })

  it('classifies an error response (id + error)', () => {
    const m: RpcMessage = { id: 'x', error: { code: -32601, message: 'nope' } }
    expect(classifyMessage(m)).toBe('response')
    expect(responseIdOf(m)).toBe('x')
  })

  it('classifies a server→client request (id + method)', () => {
    const m: RpcMessage = { id: 8, method: 'currentTime/read', params: {} }
    expect(classifyMessage(m)).toBe('serverRequest')
    expect(responseIdOf(m)).toBeNull()
  })

  it('classifies a notification (method, no id)', () => {
    const m: RpcMessage = { method: 'turn/completed', params: {} }
    expect(classifyMessage(m)).toBe('notification')
    expect(responseIdOf(m)).toBeNull()
  })

  it('treats junk as unknown', () => {
    expect(classifyMessage(null)).toBe('unknown')
    expect(classifyMessage({} as RpcMessage)).toBe('unknown')
    expect(responseIdOf({} as RpcMessage)).toBeNull()
  })

  it('correlates responses back to the request ids that produced them', () => {
    const wire = encodeRpc({ id: 1, result: 'a' }) + encodeRpc({ method: 'item/started', params: {} }) + encodeRpc({ id: 2, result: 'b' })
    const { messages } = decodeFrames('', wire)
    const ids = messages.map(responseIdOf).filter((x) => x !== null)
    expect(ids).toEqual([1, 2]) // the notification in the middle contributes no id
  })
})

describe('PendingRequests (id correlation + timeout)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('settles the exact pending id and leaves others waiting', async () => {
    const p = new PendingRequests()
    const a = p.register(1, 1000)
    const b = p.register(2, 1000)
    expect(p.size).toBe(2)
    expect(p.settle(1, { ok: true })).toBe(true)
    await expect(a).resolves.toEqual({ ok: true })
    expect(p.size).toBe(1)
    // b is still pending; clean it up so the promise doesn't dangle.
    expect(p.fail(2, new Error('cleanup'))).toBe(true)
    await expect(b).rejects.toThrow('cleanup')
  })

  it('settle/fail on an unknown id is a no-op', () => {
    const p = new PendingRequests()
    expect(p.settle(99, 1)).toBe(false)
    expect(p.fail(99, new Error('x'))).toBe(false)
  })

  it('rejects a request that is never answered after its timeout', async () => {
    vi.useFakeTimers()
    const p = new PendingRequests()
    const req = p.register('slow', 5000)
    const assertion = expect(req).rejects.toThrow(/timed out after 5000ms/)
    await vi.advanceTimersByTimeAsync(5001)
    await assertion
    expect(p.size).toBe(0)
  })

  it('a settled request does not later fire its timeout', async () => {
    vi.useFakeTimers()
    const p = new PendingRequests()
    const req = p.register(1, 1000)
    p.settle(1, 'done')
    await expect(req).resolves.toBe('done')
    await vi.advanceTimersByTimeAsync(2000) // must not throw / double-settle
    expect(p.size).toBe(0)
  })

  it('failAll rejects every outstanding request (child-death path)', async () => {
    const p = new PendingRequests()
    const a = p.register(1, 10_000)
    const b = p.register(2, 10_000)
    p.failAll(new Error('app-server exited'))
    await expect(a).rejects.toThrow('app-server exited')
    await expect(b).rejects.toThrow('app-server exited')
    expect(p.size).toBe(0)
  })
})

describe('shouldFallbackToExec (fallback decision logic)', () => {
  const ranResult: CodexTaskResult = { ok: true, answer: 'hi', progress: [] }

  it('does NOT fall back when a turn actually ran (ok=true)', () => {
    const a: TransportAttempt = { kind: 'ran', result: ranResult }
    expect(shouldFallbackToExec(a)).toBe(false)
  })

  it('does NOT fall back when a turn ran but the model failed (ok=false)', () => {
    // A genuine codex failure (auth/usage/abort/timeout) must NOT re-run on exec.
    const a: TransportAttempt = { kind: 'ran', result: { ok: false, answer: '', progress: [], error: 'unauthorized' } }
    expect(shouldFallbackToExec(a)).toBe(false)
  })

  it('DOES fall back on a transport failure', () => {
    const a: TransportAttempt = { kind: 'transport-failed', reason: 'handshake timeout' }
    expect(shouldFallbackToExec(a)).toBe(true)
  })

  it('DOES fall back when the transport is disabled', () => {
    const a: TransportAttempt = { kind: 'disabled' }
    expect(shouldFallbackToExec(a)).toBe(true)
  })
})

describe('summarizeThreadItem (progress lines)', () => {
  it('summarizes a command execution', () => {
    expect(summarizeThreadItem({ type: 'commandExecution', command: 'pnpm test' })).toBe('$ pnpm test')
  })

  it('summarizes a single file change with its path', () => {
    expect(summarizeThreadItem({ type: 'fileChange', changes: [{ path: 'src/a.ts', kind: 'update', diff: '' }], status: 'completed' }))
      .toBe('edit src/a.ts')
  })

  it('notes extra files when a change touches many', () => {
    expect(summarizeThreadItem({ type: 'fileChange', changes: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }] }))
      .toBe('edit a.ts (+2 more)')
  })

  it('summarizes mcp + web-search + dynamic tool items', () => {
    expect(summarizeThreadItem({ type: 'mcpToolCall', server: 'fs', tool: 'read' })).toBe('mcp fs/read')
    expect(summarizeThreadItem({ type: 'webSearch' })).toBe('web search')
    expect(summarizeThreadItem({ type: 'dynamicToolCall', tool: 'grep' })).toBe('tool grep')
  })

  it('returns null for the answer + noise item types (not progress)', () => {
    expect(summarizeThreadItem({ type: 'agentMessage', text: 'the answer' })).toBeNull()
    expect(summarizeThreadItem({ type: 'reasoning', summary: [], content: [] })).toBeNull()
    expect(summarizeThreadItem({ type: 'userMessage' })).toBeNull()
    expect(summarizeThreadItem(null)).toBeNull()
    expect(summarizeThreadItem('nope')).toBeNull()
  })
})
