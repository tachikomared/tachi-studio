// apps/desktop/test/unit/autoRouteStamp.test.ts
//
// The chat store's AUTO-router stamping seam: setPendingAutoRoute() records a
// per-conversation decision at SEND time, and appendChunk('start') consumes it
// onto the newly-created assistant message's `autoRoute` meta (so the UI can
// render "AUTO → <model>"), clearing the pending entry so a later non-auto send
// in the same chat is NOT mislabeled. Mirrors chatStore.test.ts's renderer-
// global stubs so the persist middleware stays quiet in the node env.
import { describe, it, expect, beforeEach } from 'vitest'

const memStore = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
  setItem: (k: string, v: string) => void memStore.set(k, v),
  removeItem: (k: string) => void memStore.delete(k),
  clear: () => memStore.clear(),
}
;(globalThis as Record<string, unknown>).window = {
  tachi: { safeStorage: { isAvailable: async () => ({ available: false }) } },
}

const { useChatStore } = await import('../../src/store/chat.store')

beforeEach(() => {
  useChatStore.setState({
    conversations: [{
      id: 'c1', title: 'New Chat', messages: [],
      providerId: 'auto', model: 'auto', createdAt: 't0', updatedAt: 't0',
    }],
    activeConversationId: 'c1',
    streamingMessageId: null,
    streamingConversationId: null,
    chunkConversationIds: {},
    pendingAutoRoute: {},
  })
})

function lastMessage(convId: string) {
  const conv = useChatStore.getState().conversations.find(c => c.id === convId)!
  return conv.messages[conv.messages.length - 1]
}

describe('AUTO-route stamping', () => {
  it('stamps autoRoute onto the assistant message created by start, then clears the pending entry', () => {
    useChatStore.getState().setPendingAutoRoute('c1', { reason: 'local-fit', provider: 'llama-cpp' })
    expect(useChatStore.getState().pendingAutoRoute['c1']).toEqual({ reason: 'local-fit', provider: 'llama-cpp' })

    useChatStore.getState().appendChunk({ type: 'start', messageId: 'm1', model: 'qwen3-4b' })

    expect(lastMessage('c1').autoRoute).toEqual({ reason: 'local-fit', provider: 'llama-cpp' })
    // Consumed — a subsequent stream in this chat must not inherit it.
    expect(useChatStore.getState().pendingAutoRoute['c1']).toBeUndefined()
  })

  it('leaves autoRoute unset when there is no pending decision (direct, non-auto send)', () => {
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'm2', model: 'claude-sonnet-4.6' })
    expect(lastMessage('c1').autoRoute).toBeUndefined()
  })

  it('setAutoFallback records the last concrete provider+model and ignores auto', () => {
    useChatStore.getState().setAutoFallback('bankr-gateway', 'claude-sonnet-4.6')
    expect(useChatStore.getState().autoFallback).toEqual({ providerId: 'bankr-gateway', model: 'claude-sonnet-4.6' })
    // 'auto' must never overwrite the concrete fallback.
    useChatStore.getState().setAutoFallback('auto', 'auto')
    expect(useChatStore.getState().autoFallback).toEqual({ providerId: 'bankr-gateway', model: 'claude-sonnet-4.6' })
  })

  it('setProvider tracks the concrete selection as the auto fallback but a switch to auto does not', () => {
    useChatStore.getState().setProvider('c1', 'surplus', 'claude-sonnet-4.5')
    expect(useChatStore.getState().autoFallback).toEqual({ providerId: 'surplus', model: 'claude-sonnet-4.5' })
    useChatStore.getState().setProvider('c1', 'auto')
    // Fallback unchanged; conversation now on auto.
    expect(useChatStore.getState().autoFallback).toEqual({ providerId: 'surplus', model: 'claude-sonnet-4.5' })
    expect(useChatStore.getState().conversations.find(c => c.id === 'c1')!.providerId).toBe('auto')
  })
})
