// apps/desktop/test/unit/agentStoreLoop.test.ts
//
// LOOP MODE in the agent UI store. The chip is LIVE STATUS, not transcript —
// the same contract the reconnect banner has — so the loop events must drive
// `loop` without ever entering `messages`, and every way a run can end must
// clear it (otherwise the UI keeps a "LOOP 3/5" chip next to a finished run).
//
// Same shims as agentStore.test.ts: the persist middleware touches
// localStorage + window.tachi.safeStorage on every setState.

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

beforeEach(() => {
  useAgentStore.setState({ messages: [], loop: null, reconnect: null, status: 'idle', error: null, viewingArchiveId: null, pastSessions: [] })
})

describe('agent store — loop events', () => {
  it('a loop event sets the chip and never enters the transcript', () => {
    useAgentStore.getState().appendEvent({ type: 'loop', iteration: 2, cap: 5, goal: 'make tests pass' })
    expect(useAgentStore.getState().loop).toEqual({ iteration: 2, cap: 5, goal: 'make tests pass' })
    expect(useAgentStore.getState().messages).toHaveLength(0)
  })

  it('later cycles replace the chip rather than stacking', () => {
    const { appendEvent } = useAgentStore.getState()
    appendEvent({ type: 'loop', iteration: 1, cap: 3, goal: 'g' })
    appendEvent({ type: 'loop', iteration: 2, cap: 3, goal: 'g' })
    expect(useAgentStore.getState().loop?.iteration).toBe(2)
    expect(useAgentStore.getState().messages).toHaveLength(0)
  })

  it('loop-ended clears the chip', () => {
    const { appendEvent } = useAgentStore.getState()
    appendEvent({ type: 'loop', iteration: 1, cap: 3, goal: 'g' })
    appendEvent({ type: 'loop-ended', iterations: 1, reason: 'the goal was reached' })
    expect(useAgentStore.getState().loop).toBeNull()
    expect(useAgentStore.getState().messages).toHaveLength(0)
  })

  it('a terminal done clears the chip even without loop-ended', () => {
    const { appendEvent } = useAgentStore.getState()
    appendEvent({ type: 'loop', iteration: 3, cap: 5, goal: 'g' })
    appendEvent({ type: 'done', reason: 'stop' })
    expect(useAgentStore.getState().loop).toBeNull()
  })

  it('an error clears the chip too (no chip next to a failed run)', () => {
    const { appendEvent } = useAgentStore.getState()
    appendEvent({ type: 'loop', iteration: 3, cap: 5, goal: 'g' })
    appendEvent({ type: 'error', message: 'gateway 503' })
    expect(useAgentStore.getState().loop).toBeNull()
  })

  it('setStatus keeps the chip only while running', () => {
    useAgentStore.setState({ loop: { iteration: 2, cap: 4, goal: 'g' } })
    useAgentStore.getState().setStatus('running')
    expect(useAgentStore.getState().loop).not.toBeNull()
    useAgentStore.getState().setStatus('idle')
    expect(useAgentStore.getState().loop).toBeNull()
  })

  it('reset() drops the chip', () => {
    useAgentStore.setState({ loop: { iteration: 1, cap: 2, goal: 'g' } })
    useAgentStore.getState().reset()
    expect(useAgentStore.getState().loop).toBeNull()
  })

  it('does not touch the chip while viewing an archived session', () => {
    useAgentStore.setState({ viewingArchiveId: 'past-1', loop: null })
    useAgentStore.getState().appendEvent({ type: 'loop', iteration: 1, cap: 3, goal: 'g' })
    expect(useAgentStore.getState().loop).toBeNull()
  })
})
