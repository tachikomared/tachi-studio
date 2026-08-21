// apps/desktop/test/unit/ragCitations.test.ts
//
// RAG SOURCE CITATIONS (USER-PAINS T20) — the renderer half of the seam.
//
// Main emits a `citations` chunk right after attached-folder retrieval, i.e.
// BEFORE any provider branch has minted a message id, so the chunk carries
// `conversationId` and an empty `messageId`. This covers:
//   • buffering into pendingCitations and stamping onto the message that the
//     next `start` creates (then consuming the pending entry),
//   • the direct-stamp path when the producer already knows the message id,
//   • zero-citation / failed-send hygiene (nothing leaks onto a later reply),
//   • a real persist → rehydrate ROUND-TRIP: a message with citations reloads
//     with them intact, and a legacy message without them loads unchanged.
//
// Renderer-global stubs mirror chatStore.test.ts: safeStorage reports
// "unavailable" so encryptedStorage falls back to plaintext in the localStorage
// shim — which is exactly what makes the round-trip assertable in the node env.
import { describe, it, expect, beforeEach } from 'vitest'
import type { RagCitation } from '@tachi/core'

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

const cite = (over: Partial<RagCitation> = {}): RagCitation => ({
  path: 'docs/spec.md',
  absPath: 'D:\\kb\\docs\\spec.md',
  startLine: 12,
  endLine: 48,
  score: 0.81,
  text: 'the retrieved chunk',
  ...over,
})

/** Let the persist middleware's async setItem land in the localStorage shim. */
const settleWrites = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  useChatStore.setState({
    conversations: [{
      id: 'c1', title: 'New Chat', messages: [],
      providerId: 'freellmapi-local', model: 'auto',
      createdAt: 't0', updatedAt: 't0', ragFolder: 'D:\\kb',
    }],
    activeConversationId: 'c1',
    streamingMessageId: null,
    streamingConversationId: null,
    chunkConversationIds: {},
    pendingAutoRoute: {},
    pendingCitations: {},
  })
})

function lastMessage(convId: string) {
  const conv = useChatStore.getState().conversations.find(c => c.id === convId)!
  return conv.messages[conv.messages.length - 1]
}

describe('citations chunk — threading onto the assistant message', () => {
  it('buffers by conversationId, then stamps the message created by start and clears the buffer', () => {
    const citations = [cite(), cite({ path: 'README.md', startLine: 1, endLine: 30, score: 0.62 })]
    useChatStore.getState().appendChunk({ type: 'citations', messageId: '', conversationId: 'c1', citations })

    // Nothing rendered yet — no assistant message exists.
    expect(useChatStore.getState().pendingCitations['c1']).toEqual(citations)
    expect(useChatStore.getState().conversations[0].messages).toHaveLength(0)

    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1', model: 'qwen3-4b' })

    expect(lastMessage('c1').citations).toEqual(citations)
    expect(useChatStore.getState().pendingCitations['c1']).toBeUndefined()
  })

  it('does not leak onto the NEXT reply in the same conversation', () => {
    useChatStore.getState().appendChunk({ type: 'citations', messageId: '', conversationId: 'c1', citations: [cite()] })
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1' })
    useChatStore.getState().appendChunk({ type: 'done', messageId: 'a1' })

    // Second turn: no folder retrieval → no citations chunk at all.
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a2' })
    expect(lastMessage('c1').citations).toBeUndefined()
  })

  it('targets the conversation named in the chunk, not the globally-streaming one', () => {
    useChatStore.setState({
      conversations: [
        ...useChatStore.getState().conversations,
        { id: 'c2', title: 'Other', messages: [], providerId: 'p', model: 'auto', createdAt: 't', updatedAt: 't' },
      ],
      streamingConversationId: 'c2',
    })
    const citations = [cite()]
    useChatStore.getState().appendChunk({ type: 'citations', messageId: '', conversationId: 'c1', citations })

    expect(useChatStore.getState().pendingCitations['c1']).toEqual(citations)
    expect(useChatStore.getState().pendingCitations['c2']).toBeUndefined()
  })

  it('stamps directly when the message id is known and the message already exists', () => {
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1' })
    const citations = [cite()]
    useChatStore.getState().appendChunk({ type: 'citations', messageId: 'a1', conversationId: 'c1', citations })

    expect(lastMessage('c1').citations).toEqual(citations)
    // Nothing was buffered, so a later start in this chat stays clean.
    expect(useChatStore.getState().pendingCitations['c1']).toBeUndefined()
  })

  it('an empty citation list clears any buffered entry and never adds the field', () => {
    useChatStore.getState().appendChunk({ type: 'citations', messageId: '', conversationId: 'c1', citations: [cite()] })
    useChatStore.getState().appendChunk({ type: 'citations', messageId: '', conversationId: 'c1', citations: [] })
    expect(useChatStore.getState().pendingCitations['c1']).toBeUndefined()

    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1' })
    expect(lastMessage('c1').citations).toBeUndefined()
    expect('citations' in lastMessage('c1')).toBe(false)
  })

  it('a send that dies before start drops its buffered sources', () => {
    useChatStore.getState().appendChunk({ type: 'citations', messageId: '', conversationId: 'c1', citations: [cite()] })
    useChatStore.getState().appendChunk({
      type: 'error', messageId: 'unknown',
      error: { code: 'NO_MODEL', message: 'pick a model' },
    })
    expect(useChatStore.getState().pendingCitations['c1']).toBeUndefined()

    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1' })
    expect(lastMessage('c1').citations).toBeUndefined()
  })

  it('returns null for a citations chunk with no resolvable conversation', () => {
    useChatStore.setState({ conversations: [], activeConversationId: null, streamingConversationId: null })
    const conv = useChatStore.getState().appendChunk({
      type: 'citations', messageId: '', conversationId: '', citations: [cite()],
    })
    expect(conv).toBeNull()
  })
})

describe('citations survive a persist → rehydrate round-trip', () => {
  it('reloads a message with citations intact and leaves a legacy message untouched', async () => {
    const citations = [cite(), cite({ path: 'notes/a.txt', startLine: 3, endLine: 3, score: 0.5, text: 'one line' })]
    useChatStore.setState({
      conversations: [{
        id: 'c1', title: 'Grounded', providerId: 'freellmapi-local', model: 'auto',
        createdAt: 't0', updatedAt: 't1', ragFolder: 'D:\\kb',
        messages: [
          // Legacy shape — written by a build that predates citations.
          { id: 'u0', role: 'user', content: 'what does the spec say?' },
          { id: 'a0', role: 'assistant', content: 'old answer', model: 'm' },
          { id: 'a1', role: 'assistant', content: 'grounded answer', model: 'm', citations },
        ],
      }],
      activeConversationId: 'c1',
    })

    await settleWrites()
    // The persisted blob is a plain JSON string (safeStorage unavailable).
    const raw = memStore.get('tachi-chat-v1')
    expect(raw).toBeTruthy()
    expect(raw!).toContain('docs/spec.md')

    // Simulate a fresh launch: blow away in-memory state, then rehydrate.
    useChatStore.setState({ conversations: [], activeConversationId: null })
    await useChatStore.persist.rehydrate()

    const conv = useChatStore.getState().conversations.find(c => c.id === 'c1')!
    expect(conv.messages).toHaveLength(3)
    expect(conv.messages[1].citations).toBeUndefined()   // old message unchanged
    expect(conv.messages[2].citations).toEqual(citations)
    // Line ranges and the exact chunk text survive JSON serialization.
    expect(conv.messages[2].citations![0]).toMatchObject({
      path: 'docs/spec.md', absPath: 'D:\\kb\\docs\\spec.md', startLine: 12, endLine: 48, text: 'the retrieved chunk',
    })
    // pendingCitations is transient — never restored from disk.
    expect(useChatStore.getState().pendingCitations).toEqual({})
  })
})
