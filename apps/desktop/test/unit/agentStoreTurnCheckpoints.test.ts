// apps/desktop/test/unit/agentStoreTurnCheckpoints.test.ts
//
// PER-TURN FILE CHECKPOINTS in the STORE, driven through the real event flow
// (plan A2). Before this existed, main's `checkpoint` event landed in ONE slot
// (`revertCheckpoint`) that every turn overwrote — so the only affordance the
// UI could offer was a single global "undo whatever the agent last did".
//
// These tests assert the turn STAMP: the snapshot main takes immediately before
// a run is bound to the user turn that caused it, including the honest negative
// (main could take no snapshot), and that a `checkpoint` event NEVER reaches the
// transcript.
//
// Same shim dance as agentStore.test.ts: stub localStorage + window.tachi
// BEFORE importing the store, so persist's rehydrate is an in-memory no-op.

import { describe, it, expect, beforeEach } from 'vitest'
import type { AgentEvent } from '@tachi/core'

const _ls = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}
;(globalThis as Record<string, unknown>).window = {
  tachi: {
    safeStorage: {
      isAvailable: async () => ({ available: false }),
      encrypt:     async (v: string) => ({ encrypted: v }),
      decrypt:     async (v: string) => ({ plaintext: v }),
    },
  },
}

const { useAgentStore } = await import('../../src/store/agent.store')
// The APP-LIFETIME bridge's pure router — this is how a real `checkpoint` event
// reaches the store, so the stamp is asserted through it rather than around it.
const { routeAgentEvent } = await import('../../src/store/agentEventBridge')

/** A checkpoint event as main emits it (not part of the AgentEvent union). */
const checkpointEvent = (over: Record<string, unknown>): AgentEvent =>
  ({ type: 'checkpoint', workspaceRoot: 'D:/ws', ...over }) as unknown as AgentEvent

const userTurn = (text: string): AgentEvent => ({ type: 'user-text', text }) as AgentEvent

function reset() {
  useAgentStore.setState({
    messages: [], turnCheckpoints: [], revertCheckpoint: null,
    status: 'idle', viewingArchiveId: null, error: null, startedAt: null,
  })
}

describe('turn-stamp through the event flow', () => {
  beforeEach(reset)

  it('binds a snapshot to the user turn it precedes', () => {
    useAgentStore.getState().appendEvent(userTurn('fix the build'))
    const turnId = useAgentStore.getState().messages[0].id

    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-1', label: 'before: fix the build' } }))

    const st = useAgentStore.getState()
    expect(st.turnCheckpoints).toHaveLength(1)
    expect(st.turnCheckpoints[0]).toMatchObject({ messageId: turnId, cpId: 'cp-1', root: 'D:/ws' })
    expect(st.turnCheckpointFor(turnId)?.cpId).toBe('cp-1')
    // Back-compat: the single-slot global ↺ REVERT still works exactly as before.
    expect(st.revertCheckpoint).toEqual({ id: 'cp-1', root: 'D:/ws', label: 'before: fix the build' })
  })

  it('keeps one binding PER TURN across a multi-turn session', () => {
    const s = useAgentStore.getState()
    s.appendEvent(userTurn('turn one'))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-1', label: 'before: turn one' } }))
    s.appendEvent({ type: 'text', text: 'ok' } as AgentEvent)
    s.appendEvent(userTurn('turn two'))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-2', label: 'before: turn two' } }))

    const st = useAgentStore.getState()
    const ids = st.messages.filter(m => m.event.type === 'user-text').map(m => m.id)
    expect(st.turnCheckpoints).toHaveLength(2)
    expect(st.turnCheckpointFor(ids[0])?.cpId).toBe('cp-1')
    expect(st.turnCheckpointFor(ids[1])?.cpId).toBe('cp-2')
  })

  it('records the HONEST NEGATIVE when main could take no snapshot', () => {
    useAgentStore.getState().appendEvent(userTurn('edit in a non-git folder'))
    const turnId = useAgentStore.getState().messages[0].id

    routeAgentEvent(checkpointEvent({ checkpoint: null, unavailable: 'no-git-backup' }))

    const entry = useAgentStore.getState().turnCheckpointFor(turnId)
    expect(entry).not.toBeNull()
    expect(entry!.cpId).toBeNull()
    expect(entry!.unavailable).toBe('no-git-backup')
    // …and it must not masquerade as a working global revert.
    expect(useAgentStore.getState().revertCheckpoint).toBeNull()
  })

  it('never lets a checkpoint event into the transcript', () => {
    useAgentStore.getState().appendEvent(userTurn('hello'))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-1', label: 'l' } }))
    routeAgentEvent(checkpointEvent({ checkpoint: null, unavailable: 'snapshot-failed' }))
    const st = useAgentStore.getState()
    expect(st.messages).toHaveLength(1)
    expect(st.messages.every(m => m.event.type !== 'checkpoint')).toBe(true)
  })

  it('re-running the same turn replaces its binding', () => {
    useAgentStore.getState().appendEvent(userTurn('retry me'))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-1', label: 'l' } }))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-2', label: 'l' } }))
    const st = useAgentStore.getState()
    expect(st.turnCheckpoints).toHaveLength(1)
    expect(st.turnCheckpoints[0].cpId).toBe('cp-2')
  })

  it('no-ops when there is no user turn to bind to', () => {
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-1', label: 'l' } }))
    expect(useAgentStore.getState().turnCheckpoints).toHaveLength(0)
  })

  it('does not stamp while an archived session is being viewed', () => {
    useAgentStore.getState().appendEvent(userTurn('live turn'))
    useAgentStore.setState({ viewingArchiveId: 'arch-1' })
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-x', label: 'l' } }))
    expect(useAgentStore.getState().turnCheckpoints).toHaveLength(0)
  })
})

describe('rewind + lifecycle hygiene', () => {
  beforeEach(reset)

  it('rewindTo prunes bindings for turns it dropped, keeping the rest', () => {
    const s = useAgentStore.getState()
    s.appendEvent(userTurn('turn one'))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-1', label: 'l' } }))
    s.appendEvent(userTurn('turn two'))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-2', label: 'l' } }))

    const ids = useAgentStore.getState().messages.map(m => m.id)
    const text = useAgentStore.getState().rewindTo(ids[1])
    expect(text).toBe('turn two')

    const st = useAgentStore.getState()
    expect(st.messages).toHaveLength(1)
    expect(st.turnCheckpoints.map(c => c.cpId)).toEqual(['cp-1'])
  })

  it('reset() drops every binding — a cp id is meaningless in a new session', () => {
    useAgentStore.getState().appendEvent(userTurn('turn'))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-1', label: 'l' } }))
    useAgentStore.getState().reset()
    expect(useAgentStore.getState().turnCheckpoints).toEqual([])
    expect(useAgentStore.getState().revertCheckpoint).toBeNull()
  })

  it('startNewSession() drops every binding too', () => {
    useAgentStore.getState().appendEvent(userTurn('turn'))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-1', label: 'l' } }))
    useAgentStore.getState().startNewSession()
    expect(useAgentStore.getState().turnCheckpoints).toEqual([])
  })

  it('turn checkpoints are never persisted (live main-process state only)', () => {
    useAgentStore.getState().appendEvent(userTurn('turn'))
    routeAgentEvent(checkpointEvent({ checkpoint: { id: 'cp-1', label: 'l' } }))
    for (const [, v] of _ls) {
      expect(v).not.toContain('turnCheckpoints')
      expect(v).not.toContain('cp-1')
    }
  })
})
