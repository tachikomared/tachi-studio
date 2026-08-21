// apps/desktop/test/unit/chatStore.test.ts
//
// The appendChunk reducer of the chat store (src/store/chat.store.ts), driven
// through the vanilla zustand API (useChatStore.getState()/setState). We exercise
// the streamed-chunk state machine WITHOUT touching IPC: start appends a streaming
// assistant message + arms the streaming flags; delta chunks are coalesced into a
// per-message buffer that only lands after a requestAnimationFrame flush (node has
// no rAF, so the store falls back to setTimeout(...,16) — fake timers drive it);
// usage/error/done all force a synchronous flush first so non-delta chunks observe
// the fully-assembled text. Covers a full start->delta->delta->usage->done run, an
// error chunk, streaming-flag toggling, model adoption, chunkConversationIds
// bookkeeping, the no-target-conversation guard, and done-time reasoning scrubbing.
//
// Import-safety: chat.store.ts pulls in encryptedStorage (window.tachi only inside
// its returned methods) and clean-reasoning (pure). The persist middleware does not
// read localStorage at import time, so the module loads in the node vitest env; we
// never invoke an action that reaches window.tachi.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ChatChunk, TokenUsage } from '@tachi/core'

// Minimal renderer-global stubs so the persist middleware's async write path
// (encryptedStorage.setItem) resolves quietly instead of throwing in the node
// env. We never assert on persistence — this only stops the debounced rehydrate/
// write from emitting unhandled rejections. safeStorage reports "unavailable" so
// the adapter falls back to a plain in-memory localStorage shim. Installed BEFORE
// importing the store so module-load rehydration sees them too.
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

const usage = (p: number, c: number, t: number): TokenUsage => ({
  promptTokens: p, completionTokens: c, totalTokens: t,
})

// Reset the singleton store to a clean, non-streaming baseline before each test.
// pendingDeltas is module-private; using fresh conversation/message ids per test
// keeps any stray buffer entry from a prior test from colliding.
beforeEach(() => {
  vi.useFakeTimers()
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    streamingMessageId: null,
    streamingConversationId: null,
    chunkConversationIds: {},
  })
})

afterEach(() => {
  // Drain any scheduled rAF/setTimeout flush so it can't bleed into the next test.
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

// Seed an empty conversation directly (newConversation only sets defaults; here we
// want a stable id) and make it active so a `start` chunk has a target.
function seedActiveConversation(id = 'conv-1') {
  useChatStore.setState({
    conversations: [{
      id, title: 'New Chat', messages: [],
      providerId: 'freellmapi-local', model: 'auto',
      createdAt: 't0', updatedAt: 't0',
    }],
    activeConversationId: id,
  })
  return id
}

function lastMessage(convId: string) {
  const conv = useChatStore.getState().conversations.find(c => c.id === convId)!
  return conv.messages[conv.messages.length - 1]
}

describe('appendChunk — start', () => {
  it('returns null and is a no-op when there is no active/streaming conversation', () => {
    const result = useChatStore.getState().appendChunk({ type: 'start', messageId: 'm1' })
    expect(result).toBeNull()
    expect(useChatStore.getState().streamingMessageId).toBeNull()
    expect(useChatStore.getState().conversations).toHaveLength(0)
  })

  it('appends an empty streaming assistant message and arms the streaming flags', () => {
    const cid = seedActiveConversation()
    const conv = useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1', model: 'gpt-x' })

    expect(conv?.id).toBe(cid)
    const msg = lastMessage(cid)
    expect(msg).toMatchObject({ id: 'a1', role: 'assistant', content: '', streaming: true, model: 'gpt-x' })

    const s = useChatStore.getState()
    expect(s.streamingMessageId).toBe('a1')
    expect(s.streamingConversationId).toBe(cid)
    expect(s.chunkConversationIds).toEqual({ a1: cid })
  })

  it('adopts a concrete model name but ignores the "auto" sentinel', () => {
    const cid = seedActiveConversation()
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1', model: 'claude-x' })
    expect(useChatStore.getState().conversations[0].model).toBe('claude-x')

    // A second start carrying model:'auto' must NOT overwrite the conversation model.
    seedActiveConversation('conv-2')
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'b1', model: 'auto' })
    expect(useChatStore.getState().conversations.find(c => c.id === 'conv-2')!.model).toBe('auto')
  })

  it('prefers streamingConversationId over activeConversationId as the target', () => {
    seedActiveConversation('conv-active')
    useChatStore.setState({
      conversations: [
        ...useChatStore.getState().conversations,
        { id: 'conv-stream', title: 'S', messages: [], providerId: 'p', model: 'auto', createdAt: 't', updatedAt: 't' },
      ],
      streamingConversationId: 'conv-stream',
    })
    const conv = useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1' })
    expect(conv?.id).toBe('conv-stream')
    expect(useChatStore.getState().chunkConversationIds).toEqual({ a1: 'conv-stream' })
  })
})

describe('provenance: a delivered reply records the provider that produced it', () => {
  // Driver-proven 2026-08-01: switching the chat's provider relabelled an
  // ALREADY-DELIVERED Kilo reply "[OPENROUTER-OAUTH · Free]" and back, because
  // the badge rendered the CONVERSATION's current provider. Provenance is a
  // fact about the run, not a function of mutable conversation state.
  it('stamps the send-time provider onto the message start creates', () => {
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()
    get().setPendingProvider(cid, 'kilo-gateway')
    get().appendChunk({ type: 'start', messageId: 'a1', model: 'kilo-auto/free' })

    expect(lastMessage(cid).providerId).toBe('kilo-gateway')
    // …and the park is consumed, so the NEXT send can't inherit it.
    expect(get().pendingProvider).toEqual({})
  })

  it('THE PIN: switching the conversation provider does NOT rewrite a delivered reply', () => {
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()
    get().setPendingProvider(cid, 'kilo-gateway')
    get().appendChunk({ type: 'start', messageId: 'a1', model: 'kilo-auto/free' })
    get().appendChunk({ type: 'done', messageId: 'a1' })

    // The user switches the picker — exactly the driver's repro.
    useChatStore.setState({
      conversations: get().conversations.map(c =>
        c.id !== cid ? c : { ...c, providerId: 'openrouter-oauth' }
      ),
    })

    // The DELIVERED message still records Kilo. The conversation moved on; the
    // message did not.
    const msg = get().conversations.find(c => c.id === cid)!.messages[0]
    expect(msg.providerId).toBe('kilo-gateway')
    expect(get().conversations.find(c => c.id === cid)!.providerId).toBe('openrouter-oauth')
  })

  it('a pre-stamp message carries NO provider — nothing beats a guess', () => {
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()
    // No setPendingProvider: an old transcript, or a surface that never parked.
    get().appendChunk({ type: 'start', messageId: 'a1', model: 'gpt-x' })
    expect(lastMessage(cid).providerId).toBeUndefined()
    // Its own recorded model survives — the honest half is kept.
    expect(lastMessage(cid).model).toBe('gpt-x')
  })

  it("'auto' is never recorded as provenance — it is a pseudo-provider", () => {
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()
    get().setPendingProvider(cid, 'auto')
    expect(get().pendingProvider).toEqual({})
    get().appendChunk({ type: 'start', messageId: 'a1' })
    expect(lastMessage(cid).providerId).toBeUndefined()
  })

  it('an abandoned send does not leak its provider onto the next reply', () => {
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()
    useChatStore.setState({ streamingConversationId: cid })
    get().setPendingProvider(cid, 'kilo-gateway')
    // The send dies before `start` (private-mode refusal).
    get().appendChunk({
      type: 'error', messageId: 'unknown',
      error: { code: 'PRIVATE_MODE_BLOCKED', message: 'PRIVATE MODE blocks cloud provider "kilo-gateway".' },
    })
    expect(get().pendingProvider).toEqual({})

    // A later, unrelated reply in the same chat must not inherit it.
    useChatStore.setState({ streamingConversationId: cid })
    get().appendChunk({ type: 'start', messageId: 'b1', model: 'llama' })
    expect(lastMessage(cid).providerId).toBeUndefined()
  })
})

describe('the badge reads the message record, not conversation state', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

  it('MessageBubble binds the badge provider to message.providerId', () => {
    const src = read('src/pages/chat/MessageBubble.tsx')
    expect(src).toContain('provider={autoRoute?.provider ?? message.providerId}')
  })

  it('MessageBubble takes no provider prop at all — the guess has no way back in', () => {
    // (ChatStarters still reads conv.providerId, and should: suggested openers
    // are about the provider you are ABOUT to send with. Only delivered
    // provenance must be immutable.)
    const src = read('src/pages/chat/MessageBubble.tsx')
    expect(src).not.toMatch(/^\s*providerId\?: string/m)
    const list = read('src/pages/chat/MessageList.tsx')
    const bubbleEl = list.slice(list.indexOf('<MessageBubble'), list.indexOf('/>', list.indexOf('<MessageBubble')))
    expect(bubbleEl).not.toContain('providerId')
  })

  it('the composer parks the send-time provider', () => {
    const src = read('src/pages/chat/InputBar.tsx')
    expect(src).toContain('setPendingProvider(activeConversationId, sendProviderId)')
  })
})

describe('appendChunk — delta coalescing', () => {
  it('buffers delta text and only applies it after the rAF (setTimeout) flush', () => {
    const cid = seedActiveConversation()
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1' })

    useChatStore.getState().appendChunk({ type: 'delta', messageId: 'a1', text: 'Hel' })
    useChatStore.getState().appendChunk({ type: 'delta', messageId: 'a1', text: 'lo' })

    // Not yet flushed — content is still the empty string set by `start`.
    expect(lastMessage(cid).content).toBe('')

    vi.runOnlyPendingTimers() // fire the single coalesced flush
    expect(lastMessage(cid).content).toBe('Hello')
  })

  it('coalesces multiple deltas into a single flush (one buffer, ordered concat)', () => {
    const cid = seedActiveConversation()
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1' })
    for (const t of ['a', 'b', 'c', 'd']) {
      useChatStore.getState().appendChunk({ type: 'delta', messageId: 'a1', text: t })
    }
    vi.runOnlyPendingTimers()
    expect(lastMessage(cid).content).toBe('abcd')
  })

  it('returns the target conversation id resolved via chunkConversationIds', () => {
    const cid = seedActiveConversation()
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1' })
    // Clear active so resolution must come from chunkConversationIds.
    useChatStore.setState({ activeConversationId: null, streamingConversationId: null })
    const conv = useChatStore.getState().appendChunk({ type: 'delta', messageId: 'a1', text: 'x' })
    expect(conv?.id).toBe(cid)
  })

  it('returns null for a delta with no resolvable conversation', () => {
    const conv = useChatStore.getState().appendChunk({ type: 'delta', messageId: 'orphan', text: 'x' })
    expect(conv).toBeNull()
  })
})

describe('appendChunk — usage flushes then records', () => {
  it('flushes buffered deltas synchronously before stamping usage', () => {
    const cid = seedActiveConversation()
    useChatStore.getState().appendChunk({ type: 'start', messageId: 'a1' })
    useChatStore.getState().appendChunk({ type: 'delta', messageId: 'a1', text: 'pending' })

    // No timer run: usage must itself flush the buffer.
    const u = usage(10, 5, 15)
    useChatStore.getState().appendChunk({ type: 'usage', messageId: 'a1', usage: u })

    const msg = lastMessage(cid)
    expect(msg.content).toBe('pending')
    expect(msg.usage).toEqual(u)
    // usage does not end the stream
    expect(msg.streaming).toBe(true)
    expect(useChatStore.getState().streamingMessageId).toBe('a1')
  })
})

describe('appendChunk — full start->delta->delta->usage->done sequence', () => {
  it('assembles text, records usage, scrubs on done, and clears streaming state', () => {
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()

    get().appendChunk({ type: 'start', messageId: 'a1', model: 'm-1' })
    get().appendChunk({ type: 'delta', messageId: 'a1', text: '<think>plan</think>' })
    get().appendChunk({ type: 'delta', messageId: 'a1', text: 'Final answer' })
    get().appendChunk({ type: 'usage', messageId: 'a1', usage: usage(8, 4, 12) })

    // After usage: text assembled (usage flushed), usage stamped, NOT yet scrubbed.
    let msg = lastMessage(cid)
    expect(msg.content).toBe('<think>plan</think>Final answer')
    expect(msg.usage).toEqual(usage(8, 4, 12))
    expect(msg.streaming).toBe(true)

    get().appendChunk({ type: 'done', messageId: 'a1' })

    msg = lastMessage(cid)
    // done scrubs the leaked <think> block from the settled answer.
    expect(msg.content).toBe('Final answer')
    expect(msg.streaming).toBe(false)
    expect(msg.error).toBeUndefined()
    // usage survives the done transition.
    expect(msg.usage).toEqual(usage(8, 4, 12))

    // Streaming bookkeeping fully torn down.
    const s = get()
    expect(s.streamingMessageId).toBeNull()
    expect(s.streamingConversationId).toBeNull()
    expect(s.chunkConversationIds).toEqual({})
  })
})

describe('appendChunk — error', () => {
  it('flushes text, marks the message errored, and clears the current stream', () => {
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()
    get().appendChunk({ type: 'start', messageId: 'a1' })
    get().appendChunk({ type: 'delta', messageId: 'a1', text: 'partial' })

    get().appendChunk({
      type: 'error', messageId: 'a1',
      error: { code: 'rate_limit', message: 'too many requests' },
    })

    const msg = lastMessage(cid)
    expect(msg.content).toBe('partial') // buffered delta flushed by error
    expect(msg.streaming).toBe(false)
    expect(msg.error).toBe('too many requests')

    const s = get()
    expect(s.streamingMessageId).toBeNull()
    expect(s.streamingConversationId).toBeNull()
    // The message id is purged from chunkConversationIds so errors don't leak.
    expect(s.chunkConversationIds).toEqual({})
  })

  it('THE PIN: a pre-start refusal (messageId "unknown") RENDERS as an error bubble — never swallowed', () => {
    // Driver-proven 2026-08-01: PRIVATE MODE blocked kilo-gateway in main
    // (sendError fires BEFORE any `start`, messageId 'unknown'), but no message
    // with that id existed, so the refusal matched nothing and the chat hung
    // silently for minutes. Same path carries NO_PROVIDER (missing key) and
    // INTERNAL (IPC send failure) — all must render.
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()
    // The composer arms streamingConversationId at send time — before `start`.
    useChatStore.setState({ streamingConversationId: cid })

    get().appendChunk({
      type: 'error', messageId: 'unknown',
      error: { code: 'PRIVATE_MODE_BLOCKED', message: 'PRIVATE MODE blocks cloud provider "kilo-gateway". Toggle off in Command Palette or switch to a local provider (Ollama).' },
    })

    const msg = lastMessage(cid)
    expect(msg).toBeTruthy()
    expect(msg.role).toBe('assistant')
    expect(msg.error).toContain('PRIVATE MODE blocks cloud provider "kilo-gateway"')
    expect(msg.streaming).toBe(false)
    // The armed pre-start spinner state is released.
    expect(get().streamingConversationId).toBeNull()
    expect(get().streamingMessageId).toBeNull()
    // The synthesized bubble gets a REAL id, never the 'unknown' sentinel.
    expect(msg.id).not.toBe('unknown')
  })

  it('does not clear another in-flight stream when an unrelated message errors', () => {
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()
    // Active stream is a1; a stale message b1 from the same conversation errors.
    get().appendChunk({ type: 'start', messageId: 'a1' })
    // Pre-register b1 in a DIFFERENT conversation so the error's tcid != current stream.
    useChatStore.setState({
      conversations: [
        ...get().conversations,
        { id: 'conv-other', title: 'O', messages: [{ id: 'b1', role: 'assistant', content: '', streaming: true }], providerId: 'p', model: 'auto', createdAt: 't', updatedAt: 't' },
      ],
      chunkConversationIds: { ...get().chunkConversationIds, b1: 'conv-other' },
    })

    get().appendChunk({
      type: 'error', messageId: 'b1',
      error: { code: 'server_error', message: 'boom' },
    })

    const s = get()
    // a1's stream is untouched...
    expect(s.streamingMessageId).toBe('a1')
    expect(s.streamingConversationId).toBe(cid)
    // ...but b1 is still purged from the id map and marked errored.
    expect(s.chunkConversationIds).toEqual({ a1: cid })
    const other = s.conversations.find(c => c.id === 'conv-other')!
    expect(other.messages[0]).toMatchObject({ streaming: false, error: 'boom' })
  })
})

describe('appendChunk — streaming-flag toggling across a stream', () => {
  it('flag is set on start, stays set through delta/usage, and clears on done', () => {
    const cid = seedActiveConversation()
    const get = () => useChatStore.getState()

    expect(get().streamingMessageId).toBeNull()

    get().appendChunk({ type: 'start', messageId: 'a1' })
    expect(get().streamingMessageId).toBe('a1')
    expect(lastMessage(cid).streaming).toBe(true)

    get().appendChunk({ type: 'delta', messageId: 'a1', text: 'x' })
    expect(get().streamingMessageId).toBe('a1') // delta doesn't toggle

    get().appendChunk({ type: 'usage', messageId: 'a1', usage: usage(1, 1, 2) })
    expect(get().streamingMessageId).toBe('a1') // usage doesn't toggle

    get().appendChunk({ type: 'done', messageId: 'a1' })
    expect(get().streamingMessageId).toBeNull()
    expect(get().streamingConversationId).toBeNull()
    expect(lastMessage(cid).streaming).toBe(false)
  })
})

describe('newConversation - provider stickiness', () => {
  // Live-found (batch16 verify): every ""+ NEW"" reset the chat to the local
  // router even when the user had explicitly picked Bankr - autoFallback
  // already tracks the last explicit pick, so a new chat now inherits it.
  const get = () => useChatStore.getState()

  it('inherits the last explicitly-picked provider/model when called bare', () => {
    useChatStore.setState({ autoFallback: { providerId: 'bankr-gateway', model: 'claude-opus-4.8' } })
    const id = get().newConversation()
    const conv = get().conversations.find(c => c.id === id)!
    expect(conv.providerId).toBe('bankr-gateway')
    expect(conv.model).toBe('claude-opus-4.8')
  })

  it('explicit args still win over the fallback', () => {
    useChatStore.setState({ autoFallback: { providerId: 'bankr-gateway', model: 'claude-opus-4.8' } })
    const id = get().newConversation('venice', 'llama-3.3-70b')
    const conv = get().conversations.find(c => c.id === id)!
    expect(conv.providerId).toBe('venice')
    expect(conv.model).toBe('llama-3.3-70b')
  })

  it('falls back to the local router when nothing was ever picked', () => {
    useChatStore.setState({ autoFallback: { providerId: '', model: '' } })
    const id = get().newConversation()
    const conv = get().conversations.find(c => c.id === id)!
    expect(conv.providerId).toBe('freellmapi-local')
    expect(conv.model).toBe('auto')
  })
})
