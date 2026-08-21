// apps/desktop/test/unit/agentOriginProvenance.test.ts
//
// PROVENANCE IS PINNED AT WRITE TIME (driver, 2026-08-02).
//
// Clicking the OpenClaude agent chip retroactively rewrote a FINISHED TACHI
// transcript's badges to "[OPENCLAUDE · VENICE · …]" — same messages, same
// 33 ms / 10 ms tool timings, different attribution — because the badge took the
// harness/provider/model as props from the CURRENT store selection.
//
// The fix is the one chat took for its message chips on 2026-08-01 (4266c62):
// park the identity at SEND, stamp it on the message, read it from the message.
// These tests drive the store the way a send does and then move the picker
// underneath, which is the exact motion that used to rewrite history.
//
// Same localStorage / safeStorage shims as agentStoreIncomplete.test.ts — the
// persist middleware touches both on every setState.

import { describe, it, expect, beforeEach } from 'vitest'

const _ls = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}
;(globalThis as any).window = {
  tachi: {
    safeStorage: {
      isAvailable: async () => ({ available: false }),
      encrypt:     async (v: string) => ({ encrypted: v }),
      decrypt:     async (v: string) => ({ plaintext: v }),
    },
  },
}

import { useAgentStore } from '../../src/store/agent.store'
import { pairToolEvents } from '../../src/pages/agent/pairToolEvents'

beforeEach(() => {
  useAgentStore.setState({
    messages: [], status: 'idle', error: null, viewingArchiveId: null,
    pastSessions: [], runOrigin: null, endedIncomplete: null,
    harness: 'tachi', provider: 'venice', veniceModel: 'zai-org-glm-4.7',
  })
})

describe('agent store — origin stamping', () => {
  it('stamps the parked identity on every message appended after it', () => {
    const s = useAgentStore.getState()
    s.setRunOrigin({ harness: 'tachi', provider: 'venice', model: 'zai-org-glm-4.7' })
    s.appendEvent({ type: 'user-text', text: 'go' })
    s.appendEvent({ type: 'text', text: 'done thinking' })

    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(2)
    for (const m of msgs) {
      expect(m.origin).toEqual({ harness: 'tachi', provider: 'venice', model: 'zai-org-glm-4.7' })
    }
  })

  it('THE PIN — switching agent/provider does NOT relabel a finished transcript', () => {
    const s = useAgentStore.getState()
    s.setRunOrigin({ harness: 'tachi', provider: 'venice', model: 'zai-org-glm-4.7' })
    s.appendEvent({ type: 'text', text: 'the answer' })
    s.appendEvent({ type: 'done', reason: 'stop' })

    // The operator now clicks the OpenClaude chip and a different provider.
    useAgentStore.getState().setHarness('openclaude')
    useAgentStore.getState().setProvider('bankr')
    useAgentStore.getState().setBankrModel('claude-opus-5')

    const msgs = useAgentStore.getState().messages
    expect(msgs[0].origin).toEqual({ harness: 'tachi', provider: 'venice', model: 'zai-org-glm-4.7' })
    expect(msgs[0].origin?.harness).not.toBe('openclaude')
  })

  it('the NEXT send stamps the new identity — old messages keep the old one', () => {
    const s = useAgentStore.getState()
    s.setRunOrigin({ harness: 'tachi', provider: 'venice', model: 'zai-org-glm-4.7' })
    s.appendEvent({ type: 'text', text: 'first run' })
    // A real second send: park the new identity, then echo the user's message
    // (a non-text event, so nothing coalesces across the run boundary).
    useAgentStore.getState().setRunOrigin({ harness: 'openclaude', provider: 'bankr', model: 'claude-opus-5' })
    useAgentStore.getState().appendEvent({ type: 'user-text', text: 'again' })
    useAgentStore.getState().appendEvent({ type: 'text', text: 'second run' })

    const msgs = useAgentStore.getState().messages
    expect(msgs.map(m => m.origin?.harness)).toEqual(['tachi', 'openclaude', 'openclaude'])
    expect(msgs[2].origin?.model).toBe('claude-opus-5')
  })

  it('leaves messages UNSTAMPED when nothing was parked (no guess)', () => {
    useAgentStore.getState().appendEvent({ type: 'text', text: 'orphan' })
    expect(useAgentStore.getState().messages[0].origin).toBeUndefined()
  })

  it('a streamed answer keeps the stamp of its first chunk through coalescing', () => {
    const s = useAgentStore.getState()
    s.setRunOrigin({ harness: 'tachi', provider: 'venice', model: 'zai-org-glm-4.7' })
    s.appendEvent({ type: 'text', text: 'par' })
    // Mid-stream picker change: the coalesced message must not pick it up.
    useAgentStore.getState().setRunOrigin({ harness: 'openclaude', provider: 'bankr' })
    useAgentStore.getState().appendEvent({ type: 'text', text: 'tial' })

    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(1)
    expect((msgs[0].event as { text: string }).text).toBe('partial')
    expect(msgs[0].origin?.harness).toBe('tachi')
  })
})

describe('pairToolEvents — the stamp survives the transcript sweep', () => {
  it('carries origin onto event blocks and omits it when absent', () => {
    const blocks = pairToolEvents([
      { id: '1', event: { type: 'text', text: 'stamped' }, origin: { harness: 'tachi', provider: 'venice', model: 'm' } },
      { id: '2', event: { type: 'text', text: 'legacy' } },
    ])
    const evs = blocks.filter(b => b.kind === 'event') as Array<{ origin?: { harness: string } }>
    expect(evs[0].origin?.harness).toBe('tachi')
    expect(evs[1].origin).toBeUndefined()
  })
})

describe('agent store — a failed run keeps the error status', () => {
  it("done reason:'error' does not overwrite 'error' with 'done'", () => {
    const s = useAgentStore.getState()
    s.appendEvent({ type: 'error', message: 'OpenClaude run failed — boom.' })
    expect(useAgentStore.getState().status).toBe('error')
    useAgentStore.getState().appendEvent({ type: 'done', reason: 'error' })
    expect(useAgentStore.getState().status).toBe('error')
    expect(useAgentStore.getState().error).toContain('boom')
  })

  it("done reason:'stop' still resolves to done", () => {
    useAgentStore.getState().appendEvent({ type: 'done', reason: 'stop' })
    expect(useAgentStore.getState().status).toBe('done')
  })
})
