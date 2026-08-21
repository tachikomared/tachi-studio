// apps/desktop/test/unit/reconnectStores.test.ts
//
// CONNECTION RESILIENCE, renderer side. The main process can reconnect
// perfectly and the feature still looks broken if the UI re-renders the
// discarded prefix — so these tests pin the exact property the `reset` chunk
// exists for: after a retry the bubble holds the FINAL answer once, not the
// partial concatenated with it. The agent-store half proves the retry banner
// is live status (never transcript) and always clears.
//
// Same import-safety dance as chatStore.test.ts / agentStore.test.ts: stub
// localStorage + window.tachi.safeStorage BEFORE importing the stores so the
// persist middleware's rehydrate is a silent in-memory no-op.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChatChunk, AgentEvent } from '@tachi/core'

const _ls = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem: (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear: () => { _ls.clear() },
}
;(globalThis as Record<string, unknown>).window = {
  tachi: {
    safeStorage: {
      isAvailable: async () => ({ available: false }),
      encrypt: async (v: string) => ({ encrypted: v }),
      decrypt: async (v: string) => ({ plaintext: v }),
    },
  },
}

const { useChatStore } = await import('../../src/store/chat.store')
const { useAgentStore } = await import('../../src/store/agent.store')

const CONV = 'conv-reconnect'
const MSG = 'msg-reconnect'

function seedConversation(): void {
  useChatStore.setState({
    conversations: [{
      id: CONV,
      title: 'test',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never],
    activeConversationId: CONV,
    streamingMessageId: null,
    streamingConversationId: CONV,
    chunkConversationIds: {},
  })
}

const feed = (chunk: ChatChunk) => useChatStore.getState().appendChunk(chunk)
const bubble = () =>
  useChatStore.getState().conversations.find(c => c.id === CONV)!.messages.find(m => m.id === MSG)!

describe('chat store — reset/reconnect chunks', () => {
  beforeEach(() => { vi.useFakeTimers(); seedConversation() })
  afterEach(() => { vi.useRealTimers() })

  it('does not double-render: the discarded prefix is gone after a retry', () => {
    feed({ type: 'start', messageId: MSG, model: 'test-model' })
    feed({ type: 'delta', messageId: MSG, text: 'Half an ans' })
    vi.advanceTimersByTime(20)             // flush the coalesced delta buffer
    expect(bubble().content).toBe('Half an ans')

    // …socket dies. The service resets, announces, then streams the real answer.
    feed({ type: 'reset', messageId: MSG })
    expect(bubble().content).toBe('')
    expect(bubble().streaming).toBe(true)  // still the same live bubble

    feed({ type: 'reconnect', messageId: MSG, attempt: 1, maxAttempts: 10, delayMs: 1000, reason: 'econnreset' })
    expect(bubble().reconnect).toMatchObject({ attempt: 1, maxAttempts: 10, delayMs: 1000, reason: 'econnreset' })

    feed({ type: 'reconnect-resolved', messageId: MSG })
    expect(bubble().reconnect).toBeUndefined()

    feed({ type: 'delta', messageId: MSG, text: 'The complete answer.' })
    vi.advanceTimersByTime(20)
    expect(bubble().content).toBe('The complete answer.')
    expect(bubble().content).not.toContain('Half an ans')
  })

  it('drops deltas still sitting in the coalescing buffer when reset arrives', () => {
    feed({ type: 'start', messageId: MSG, model: 'test-model' })
    feed({ type: 'delta', messageId: MSG, text: 'buffered-but-doomed' })
    // NOTE: no timer advance — the delta is still un-flushed, exactly the race
    // a naive "flush then clear" reset would lose.
    feed({ type: 'reset', messageId: MSG })
    vi.advanceTimersByTime(50)
    expect(bubble().content).toBe('')
  })

  it('clears the retry strip when the message ends, however it ends', () => {
    feed({ type: 'start', messageId: MSG, model: 'test-model' })
    feed({ type: 'reconnect', messageId: MSG, attempt: 2, maxAttempts: 10, delayMs: 2000, reason: 'http-503' })
    expect(bubble().reconnect).toBeDefined()
    feed({ type: 'done', messageId: MSG })
    expect(bubble().reconnect).toBeUndefined()
    expect(bubble().streaming).toBe(false)

    seedConversation()
    feed({ type: 'start', messageId: MSG, model: 'test-model' })
    feed({ type: 'reconnect', messageId: MSG, attempt: 9, maxAttempts: 10, delayMs: 30000, reason: 'fetch-failed' })
    feed({ type: 'error', messageId: MSG, error: { code: 'NETWORK_ERROR', message: 'gone' } })
    expect(bubble().reconnect).toBeUndefined()
    expect(bubble().error).toBe('gone')
  })
})

describe('agent store — reconnect events are live status, not transcript', () => {
  beforeEach(() => {
    useAgentStore.setState({ messages: [], status: 'running', error: null, reconnect: null, viewingArchiveId: null, startedAt: Date.now() })
  })

  const push = (e: AgentEvent) => useAgentStore.getState().appendEvent(e)

  it('never adds a reconnect event to the message log', () => {
    push({ type: 'text', text: 'working…' })
    push({ type: 'reconnect', attempt: 3, maxAttempts: 10, delayMs: 4000, reason: 'econnreset' })
    expect(useAgentStore.getState().messages).toHaveLength(1)
    expect(useAgentStore.getState().reconnect).toMatchObject({ attempt: 3, maxAttempts: 10, delayMs: 4000 })
    // …and the run is still considered running, not errored.
    expect(useAgentStore.getState().status).toBe('running')
  })

  it('clears on reconnect-resolved', () => {
    push({ type: 'reconnect', attempt: 1, maxAttempts: 10, delayMs: 1000, reason: 'idle-stall' })
    push({ type: 'reconnect-resolved' })
    expect(useAgentStore.getState().reconnect).toBeNull()
    expect(useAgentStore.getState().messages).toHaveLength(0)
  })

  it('clears on any terminal event, and when the session is reset', () => {
    push({ type: 'reconnect', attempt: 5, maxAttempts: 10, delayMs: 16000, reason: 'http-502' })
    push({ type: 'done', reason: 'stop' })
    expect(useAgentStore.getState().reconnect).toBeNull()

    useAgentStore.setState({ status: 'running', reconnect: { attempt: 1, maxAttempts: 10, delayMs: 1000, reason: 'x' } })
    push({ type: 'error', message: 'boom' })
    expect(useAgentStore.getState().reconnect).toBeNull()
    expect(useAgentStore.getState().status).toBe('error')

    useAgentStore.setState({ reconnect: { attempt: 1, maxAttempts: 10, delayMs: 1000, reason: 'x' } })
    useAgentStore.getState().reset()
    expect(useAgentStore.getState().reconnect).toBeNull()
  })

  it('drops the banner as soon as the run stops being "running"', () => {
    useAgentStore.setState({ status: 'running', reconnect: { attempt: 2, maxAttempts: 10, delayMs: 2000, reason: 'x' } })
    useAgentStore.getState().setStatus('idle')
    expect(useAgentStore.getState().reconnect).toBeNull()
  })
})
