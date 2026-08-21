// apps/desktop/test/unit/agentStoreIncomplete.test.ts
//
// GAVE-UP DETECTION in the agent UI store. The verdict rides ALONGSIDE `status`
// rather than replacing it: everything downstream that reads `status === 'done'`
// means "the run is over", which stays true — but the status area must render
// the amber ENDED-INCOMPLETE badge instead of the success one, and must stop
// doing so the moment a new run starts.
//
// Same shims as agentStoreLoop.test.ts: the persist middleware touches
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
  useAgentStore.setState({
    messages: [], loop: null, reconnect: null, endedIncomplete: null,
    status: 'idle', error: null, viewingArchiveId: null, pastSessions: [],
  })
})

describe('agent store — ENDED-INCOMPLETE verdict', () => {
  it('an incomplete done sets the verdict but keeps status "done"', () => {
    useAgentStore.getState().appendEvent({
      type: 'done', reason: 'stop', incomplete: true,
      incompleteCode: 'empty-text', incompleteDetail: 'nothing was said', nudged: true,
    })
    const s = useAgentStore.getState()
    expect(s.status).toBe('done')
    expect(s.endedIncomplete).toEqual({ code: 'empty-text', detail: 'nothing was said', nudged: true })
  })

  it('an ordinary done leaves the verdict null', () => {
    useAgentStore.getState().appendEvent({ type: 'done', reason: 'stop' })
    expect(useAgentStore.getState().status).toBe('done')
    expect(useAgentStore.getState().endedIncomplete).toBeNull()
  })

  it('a later ordinary done clears a previous verdict', () => {
    const { appendEvent } = useAgentStore.getState()
    appendEvent({ type: 'done', reason: 'stop', incomplete: true })
    expect(useAgentStore.getState().endedIncomplete).not.toBeNull()
    appendEvent({ type: 'done', reason: 'stop' })
    expect(useAgentStore.getState().endedIncomplete).toBeNull()
  })

  it('starting a new run clears the verdict; a terminal status does not', () => {
    useAgentStore.setState({ endedIncomplete: { code: 'no-completion' } })
    useAgentStore.getState().setStatus('done')
    expect(useAgentStore.getState().endedIncomplete).not.toBeNull()
    useAgentStore.getState().setStatus('running')
    expect(useAgentStore.getState().endedIncomplete).toBeNull()
  })

  it('reset() drops the verdict', () => {
    useAgentStore.setState({ endedIncomplete: { code: 'empty-text' } })
    useAgentStore.getState().reset()
    expect(useAgentStore.getState().endedIncomplete).toBeNull()
  })

  it('does not set the verdict while viewing an archived session', () => {
    useAgentStore.setState({ viewingArchiveId: 'past-1' })
    useAgentStore.getState().appendEvent({ type: 'done', reason: 'stop', incomplete: true })
    expect(useAgentStore.getState().endedIncomplete).toBeNull()
  })
})
