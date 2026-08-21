// apps/desktop/test/unit/agentStore.test.ts
//
// The agent UI store (zustand + persist). The store wraps `persist` with the
// encrypted-storage adapter, which touches `window.tachi.safeStorage` and
// `localStorage` on every setState (async, fire-and-forget). The node vitest
// env has neither, so we stub a minimal in-memory `localStorage` and a
// `window.tachi.safeStorage` that reports unavailable — persistence then
// becomes a silent in-memory no-op and never raises an unhandled rejection.
// Stubs are installed BEFORE importing the store so the persist middleware sees
// them during its initial rehydrate. We exercise the pure mutators / selectors
// (setMode, setProvider, setDepth, …) via getState/setState; nothing here drives
// React or electron.
import { describe, it, expect, beforeEach } from 'vitest'

// ── In-memory localStorage shim ─────────────────────────────────────────────
const _ls = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}
// safeStorage reports unavailable → adapter falls back to plaintext localStorage
// (our shim) instead of calling window.tachi.safeStorage.encrypt/decrypt.
;(globalThis as any).window = {
  tachi: {
    safeStorage: {
      isAvailable: async () => ({ available: false }),
      encrypt:     async (v: string) => ({ encrypted: v }),
      decrypt:     async (v: string) => ({ plaintext: v }),
    },
  },
}

import {
  useAgentStore,
  getContextZone,
  migrateAgentPersisted,
  type AgentEvent,
} from '../../src/store/agent.store'

// Capture the pristine defaults once, before any test mutates the singleton.
const DEFAULTS = useAgentStore.getState()

/** Reset the live + archive state to defaults between tests (singleton store). */
function resetStore() {
  useAgentStore.setState({
    workingDir:          DEFAULTS.workingDir,
    sessionId:           DEFAULTS.sessionId,
    status:              DEFAULTS.status,
    messages:            [],
    error:               DEFAULTS.error,
    harness:             'tachi',
    mode:                'build',
    provider:            'default',
    bankrModel:          'claude-opus-5',
    surplusModel:        'claude-sonnet-4.5',
    surplusSmartRouting: false,
    activeWorkflow:      null,
    depth:               'normal',
    startedAt:           null,
    contextChars:        {},
    redZoneTriggered:    new Set<string>(),
    pastSessions:        [],
    viewingArchiveId:    null,
  })
}

const ev = (e: AgentEvent) => useAgentStore.getState().appendEvent(e)

beforeEach(resetStore)

// ── Defaults ────────────────────────────────────────────────────────────────
describe('initial defaults', () => {
  it('boots the live session idle with the documented preference defaults', () => {
    const s = useAgentStore.getState()
    expect(s.status).toBe('idle')
    expect(s.harness).toBe('tachi')
    expect(s.mode).toBe('build')
    expect(s.provider).toBe('default')
    expect(s.depth).toBe('normal')
    expect(s.bankrModel).toBe('claude-opus-5')
    expect(s.surplusModel).toBe('claude-sonnet-4.5')
    expect(s.surplusSmartRouting).toBe(false)
    expect(s.activeWorkflow).toBeNull()
    expect(s.workingDir).toBeNull()
    expect(s.sessionId).toBeNull()
    expect(s.startedAt).toBeNull()
    expect(s.messages).toEqual([])
    expect(s.pastSessions).toEqual([])
    expect(s.viewingArchiveId).toBeNull()
  })
})

// ── Persist migration ────────────────────────────────────────────────────────
describe('migrateAgentPersisted', () => {
  it('bumps the previous stale default claude-opus-4.8 to claude-opus-5 (v1 → v2)', () => {
    // harness:'goose' is ALSO coerced — the Goose harness was removed (v2 → v3).
    expect(migrateAgentPersisted({ bankrModel: 'claude-opus-4.8', harness: 'goose' }))
      .toEqual({ bankrModel: 'claude-opus-5', harness: 'tachi' })
  })
  it('CHAINS the old 4.7 bump through to the current default in one pass', () => {
    // A user last on a 4.7-era build must land on 5, not one version behind.
    expect(migrateAgentPersisted({ bankrModel: 'claude-opus-4.7', harness: 'openclaude' }))
      .toEqual({ bankrModel: 'claude-opus-5', harness: 'openclaude' })
  })
  it('leaves a deliberate non-default model untouched (incl. other providers)', () => {
    expect(migrateAgentPersisted({ bankrModel: 'gpt-5.5' })).toEqual({ bankrModel: 'gpt-5.5' })
    expect(migrateAgentPersisted({ bankrModel: 'claude-sonnet-4.6' })).toEqual({ bankrModel: 'claude-sonnet-4.6' })
    // Non-Bankr persisted model fields are never rewritten.
    expect(migrateAgentPersisted({ bankrModel: 'claude-opus-4.8', surplusModel: 'claude-opus-4.8', veniceModel: 'zai-org-glm-4.7' }))
      .toEqual({ bankrModel: 'claude-opus-5', surplusModel: 'claude-opus-4.8', veniceModel: 'zai-org-glm-4.7' })
  })
  it('is idempotent — re-running on an already-migrated state is a no-op', () => {
    const once = migrateAgentPersisted({ bankrModel: 'claude-opus-4.8' })
    expect(migrateAgentPersisted(once)).toEqual({ bankrModel: 'claude-opus-5' })
    expect(migrateAgentPersisted(once)).toBe(once)   // unchanged → same reference
  })
  it('handles empty/undefined persisted state without throwing', () => {
    expect(migrateAgentPersisted(undefined)).toBeUndefined()
    expect(migrateAgentPersisted(null)).toBeNull()
    expect(migrateAgentPersisted({})).toEqual({})
    expect(migrateAgentPersisted({ bankrModel: 42 })).toEqual({ bankrModel: 42 })
  })
})

// ── Simple preference mutators ───────────────────────────────────────────────
describe('preference mutators', () => {
  it('setMode flips between plan and build', () => {
    useAgentStore.getState().setMode('plan')
    expect(useAgentStore.getState().mode).toBe('plan')
    useAgentStore.getState().setMode('build')
    expect(useAgentStore.getState().mode).toBe('build')
  })

  it('setProvider swaps the active gateway', () => {
    useAgentStore.getState().setProvider('bankr')
    expect(useAgentStore.getState().provider).toBe('bankr')
    useAgentStore.getState().setProvider('venice')
    expect(useAgentStore.getState().provider).toBe('venice')
  })

  it('setDepth sets the thinking budget level', () => {
    useAgentStore.getState().setDepth('ultra')
    expect(useAgentStore.getState().depth).toBe('ultra')
    useAgentStore.getState().setDepth('think')
    expect(useAgentStore.getState().depth).toBe('think')
  })

  it('setHarness selects the harness backend', () => {
    useAgentStore.getState().setHarness('tachi')
    expect(useAgentStore.getState().harness).toBe('tachi')
  })

  it('setBankrModel and setSurplusModel store the picked model ids', () => {
    useAgentStore.getState().setBankrModel('claude-sonnet-4.5')
    useAgentStore.getState().setSurplusModel('gpt-5')
    expect(useAgentStore.getState().bankrModel).toBe('claude-sonnet-4.5')
    expect(useAgentStore.getState().surplusModel).toBe('gpt-5')
  })

  it('setSurplusSmartRouting toggles the router flag', () => {
    useAgentStore.getState().setSurplusSmartRouting(true)
    expect(useAgentStore.getState().surplusSmartRouting).toBe(true)
    useAgentStore.getState().setSurplusSmartRouting(false)
    expect(useAgentStore.getState().surplusSmartRouting).toBe(false)
  })

  it('setActiveWorkflow binds and clears a saved node workflow', () => {
    useAgentStore.getState().setActiveWorkflow({ filename: 'flow.json', name: 'My Flow' })
    expect(useAgentStore.getState().activeWorkflow).toEqual({ filename: 'flow.json', name: 'My Flow' })
    useAgentStore.getState().setActiveWorkflow(null)
    expect(useAgentStore.getState().activeWorkflow).toBeNull()
  })

  it('setWorkingDir accepts a path and null', () => {
    useAgentStore.getState().setWorkingDir('/repo/x')
    expect(useAgentStore.getState().workingDir).toBe('/repo/x')
    useAgentStore.getState().setWorkingDir(null)
    expect(useAgentStore.getState().workingDir).toBeNull()
  })
})

// ── setSession: startedAt latch ──────────────────────────────────────────────
describe('setSession', () => {
  it('stamps startedAt on the first non-null assignment and keeps it stable', () => {
    expect(useAgentStore.getState().startedAt).toBeNull()
    useAgentStore.getState().setSession('sess-1')
    const first = useAgentStore.getState().startedAt
    expect(typeof first).toBe('number')
    expect(useAgentStore.getState().sessionId).toBe('sess-1')
    // A second assignment must NOT move startedAt.
    useAgentStore.getState().setSession('sess-2')
    expect(useAgentStore.getState().startedAt).toBe(first)
    expect(useAgentStore.getState().sessionId).toBe('sess-2')
  })

  it('does not stamp startedAt when the session id is null', () => {
    useAgentStore.getState().setSession(null)
    expect(useAgentStore.getState().startedAt).toBeNull()
    expect(useAgentStore.getState().sessionId).toBeNull()
  })
})

// ── setStatus + auto-archive ─────────────────────────────────────────────────
describe('setStatus', () => {
  it('records status and clears the error when none is passed', () => {
    useAgentStore.getState().setStatus('error', 'boom')
    expect(useAgentStore.getState().status).toBe('error')
    expect(useAgentStore.getState().error).toBe('boom')
    useAgentStore.getState().setStatus('running')
    expect(useAgentStore.getState().status).toBe('running')
    expect(useAgentStore.getState().error).toBeNull()
  })

  it('does NOT auto-archive a terminal status when there are no messages', () => {
    useAgentStore.getState().setStatus('done')
    expect(useAgentStore.getState().pastSessions).toHaveLength(0)
  })

  it('auto-archives the live session on a terminal status when messages exist', () => {
    ev({ type: 'user-text', text: 'do the thing' })
    useAgentStore.getState().setStatus('done')
    const past = useAgentStore.getState().pastSessions
    expect(past).toHaveLength(1)
    expect(past[0].title).toBe('do the thing')
    expect(past[0].status).toBe('done')
  })

  it('dedupes repeated terminal setStatus by startedAt (no duplicate archives)', () => {
    ev({ type: 'user-text', text: 'task' })
    useAgentStore.getState().setStatus('done')
    useAgentStore.getState().setStatus('done')
    expect(useAgentStore.getState().pastSessions).toHaveLength(1)
  })

  it('does not archive while viewing an archive', () => {
    // Seed one archived session, then enter viewing mode and fire a terminal status.
    ev({ type: 'user-text', text: 'seed' })
    useAgentStore.getState().setStatus('done')
    const id = useAgentStore.getState().pastSessions[0].id
    useAgentStore.getState().viewArchive(id)
    expect(useAgentStore.getState().viewingArchiveId).toBe(id)
    const before = useAgentStore.getState().pastSessions.length
    useAgentStore.getState().setStatus('error', 'x')
    expect(useAgentStore.getState().pastSessions).toHaveLength(before)
  })
})

// ── appendEvent ──────────────────────────────────────────────────────────────
describe('appendEvent', () => {
  it('appends a non-text event as its own message', () => {
    ev({ type: 'tool-call', name: 'bash', input: 'ls' })
    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0].event).toEqual({ type: 'tool-call', name: 'bash', input: 'ls' })
    expect(typeof msgs[0].id).toBe('string')
    expect(typeof msgs[0].timestamp).toBe('number')
  })

  it('coalesces consecutive text chunks into one message', () => {
    ev({ type: 'text', text: 'Hel' })
    ev({ type: 'text', text: 'lo' })
    ev({ type: 'text', text: ' world' })
    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0].event).toEqual({ type: 'text', text: 'Hello world' })
  })

  it('does NOT coalesce text across an interleaved non-text event', () => {
    ev({ type: 'text', text: 'A' })
    ev({ type: 'tool-call', name: 'bash', input: 'x' })
    ev({ type: 'text', text: 'B' })
    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(3)
    expect(msgs[0].event).toEqual({ type: 'text', text: 'A' })
    expect(msgs[2].event).toEqual({ type: 'text', text: 'B' })
  })

  it('sets startedAt on the first event', () => {
    expect(useAgentStore.getState().startedAt).toBeNull()
    ev({ type: 'text', text: 'first' })
    expect(typeof useAgentStore.getState().startedAt).toBe('number')
  })

  it('an error event flips status to error and captures the message', () => {
    ev({ type: 'error', message: 'kaboom' })
    expect(useAgentStore.getState().status).toBe('error')
    expect(useAgentStore.getState().error).toBe('kaboom')
  })

  it('a done event flips status to done and auto-archives', () => {
    ev({ type: 'user-text', text: 'a job' })
    ev({ type: 'done', reason: 'complete' })
    expect(useAgentStore.getState().status).toBe('done')
    const past = useAgentStore.getState().pastSessions
    expect(past).toHaveLength(1)
    expect(past[0].title).toBe('a job')
  })

  it('drops events while viewing an archive (read-only)', () => {
    ev({ type: 'user-text', text: 'seed' })
    useAgentStore.getState().setStatus('done')
    const id = useAgentStore.getState().pastSessions[0].id
    useAgentStore.getState().viewArchive(id)
    const before = useAgentStore.getState().messages.length
    ev({ type: 'text', text: 'ignored while viewing' })
    expect(useAgentStore.getState().messages).toHaveLength(before)
  })
})

// ── clearMessages / reset ────────────────────────────────────────────────────
describe('clearMessages + reset', () => {
  it('clearMessages empties only the live message log', () => {
    ev({ type: 'text', text: 'x' })
    useAgentStore.getState().setProvider('bankr')
    useAgentStore.getState().clearMessages()
    expect(useAgentStore.getState().messages).toEqual([])
    // preference untouched
    expect(useAgentStore.getState().provider).toBe('bankr')
  })

  it('reset returns the live session to idle but keeps preferences + archive', () => {
    ev({ type: 'user-text', text: 'job' })
    useAgentStore.getState().setStatus('done')   // archives one
    useAgentStore.getState().setProvider('surplus')
    useAgentStore.getState().reset()
    const s = useAgentStore.getState()
    expect(s.status).toBe('idle')
    expect(s.messages).toEqual([])
    expect(s.sessionId).toBeNull()
    expect(s.error).toBeNull()
    expect(s.startedAt).toBeNull()
    expect(s.viewingArchiveId).toBeNull()
    // archive + provider preference survive a reset
    expect(s.pastSessions).toHaveLength(1)
    expect(s.provider).toBe('surplus')
  })
})

// ── Context window tracking (D4) ─────────────────────────────────────────────
describe('context window tracking', () => {
  it('setContextChars overwrites and bumpContextChars accumulates per conversation', () => {
    useAgentStore.getState().setContextChars('c1', 100)
    expect(useAgentStore.getState().contextChars.c1).toBe(100)
    useAgentStore.getState().bumpContextChars('c1', 50)
    expect(useAgentStore.getState().contextChars.c1).toBe(150)
    // an unknown conversation starts from 0
    useAgentStore.getState().bumpContextChars('c2', 20)
    expect(useAgentStore.getState().contextChars.c2).toBe(20)
    // keys are independent
    expect(useAgentStore.getState().contextChars.c1).toBe(150)
  })

  it('markRedZoneTriggered records the conversation id once', () => {
    useAgentStore.getState().markRedZoneTriggered('c1')
    expect(useAgentStore.getState().redZoneTriggered.has('c1')).toBe(true)
    expect(useAgentStore.getState().redZoneTriggered.has('c2')).toBe(false)
  })

  // contextFillPct and the per-provider table it divided by were deleted on
  // 2026-08-03. Their tests went with them rather than being ported: they
  // pinned that an unknown provider falls back to a flat 32,000, which is the
  // behaviour four commits were spent removing from every live surface. The
  // store no longer computes a percentage at all — modelWindow.store does,
  // per model, and says when it cannot.
})

// ── History actions ──────────────────────────────────────────────────────────
describe('history actions', () => {
  it('startNewSession archives the live session then clears the live area', () => {
    ev({ type: 'user-text', text: 'old task' })
    useAgentStore.getState().startNewSession()
    const s = useAgentStore.getState()
    expect(s.pastSessions).toHaveLength(1)
    expect(s.pastSessions[0].title).toBe('old task')
    expect(s.messages).toEqual([])
    expect(s.status).toBe('idle')
    expect(s.startedAt).toBeNull()
  })

  it('startNewSession with no messages does not create an archive', () => {
    useAgentStore.getState().startNewSession()
    expect(useAgentStore.getState().pastSessions).toHaveLength(0)
  })

  it('startNewSession while viewing exits viewing mode without re-archiving', () => {
    ev({ type: 'user-text', text: 'seed' })
    useAgentStore.getState().setStatus('done')   // archives the live session
    // reset() clears the live area the way "+ New" does, so re-entering view
    // mode below can't re-snapshot the (now empty) live session.
    useAgentStore.getState().reset()
    const id = useAgentStore.getState().pastSessions[0].id
    useAgentStore.getState().viewArchive(id)
    useAgentStore.getState().startNewSession()
    const s = useAgentStore.getState()
    expect(s.viewingArchiveId).toBeNull()
    expect(s.messages).toEqual([])
    expect(s.pastSessions).toHaveLength(1) // unchanged
  })

  it('viewArchive loads a past session read-only and closeArchive returns to a fresh slate', () => {
    ev({ type: 'user-text', text: 'archived task' })
    useAgentStore.getState().setWorkingDir('/repo')
    useAgentStore.getState().setStatus('done')
    const past = useAgentStore.getState().pastSessions[0]
    // clear the live area (mirrors "+ New") so the captured archive id is stable
    useAgentStore.getState().reset()
    useAgentStore.getState().viewArchive(past.id)
    let s = useAgentStore.getState()
    expect(s.viewingArchiveId).toBe(past.id)
    expect(s.messages).toEqual(past.messages)
    expect(s.status).toBe('done')
    expect(s.workingDir).toBe('/repo')

    useAgentStore.getState().closeArchive()
    s = useAgentStore.getState()
    expect(s.viewingArchiveId).toBeNull()
    expect(s.messages).toEqual([])
    expect(s.status).toBe('idle')
  })

  // Found while writing the batch14 tests: a run auto-archives on its terminal
  // event but STAYS in the live slot, so opening the session that just finished
  // snapshotted it a second time (new id, same startedAt) while the original was
  // re-appended — two rail entries for one conversation, both continuable.
  it('viewing a JUST-AUTO-ARCHIVED session leaves exactly ONE rail entry', () => {
    ev({ type: 'user-text', text: 'the run that just finished' })
    useAgentStore.getState().setWorkingDir('/repo')
    useAgentStore.getState().setStatus('done')          // auto-archives, live slot untouched
    const entry = useAgentStore.getState().pastSessions[0]

    useAgentStore.getState().viewArchive(entry.id)      // …the operator clicks it in the rail

    const s = useAgentStore.getState()
    expect(s.pastSessions).toHaveLength(1)
    // The entry keeps its identity — viewingArchiveId has to keep resolving.
    expect(s.pastSessions[0].id).toBe(entry.id)
    expect(s.pastSessions[0].startedAt).toBe(entry.startedAt)
    expect(s.viewingArchiveId).toBe(entry.id)
    expect(s.messages).toEqual(entry.messages)
    // …and closing the view still leaves exactly one.
    useAgentStore.getState().closeArchive()
    expect(useAgentStore.getState().pastSessions).toHaveLength(1)
  })

  it('the refreshed entry keeps its title (a rename must survive a view)', () => {
    ev({ type: 'user-text', text: 'raw first prompt' })
    useAgentStore.getState().setStatus('done')
    const id = useAgentStore.getState().pastSessions[0].id
    useAgentStore.getState().renameArchive(id, 'Parser refactor')
    useAgentStore.getState().viewArchive(id)
    const s = useAgentStore.getState()
    expect(s.pastSessions).toHaveLength(1)
    expect(s.pastSessions[0].title).toBe('Parser refactor')
  })

  it('viewing an OLDER archive still parks the unrelated live session (no work lost)', () => {
    // The dedup above must not swallow the live-session snapshot when the entry
    // being opened is a DIFFERENT conversation. Note both sessions here start in
    // the SAME millisecond — startedAt alone cannot tell them apart, which is
    // why session identity also checks the first message id.
    ev({ type: 'user-text', text: 'yesterday' })
    useAgentStore.getState().setStatus('done')
    const old = useAgentStore.getState().pastSessions[0]
    useAgentStore.getState().reset()                    // fresh live slate ("+ New")
    ev({ type: 'user-text', text: 'today, unsaved' })   // …a new, unarchived session

    useAgentStore.getState().viewArchive(old.id)

    const s = useAgentStore.getState()
    expect(s.pastSessions).toHaveLength(2)
    expect(s.pastSessions.map(p => p.title).sort()).toEqual(['today, unsaved', 'yesterday'])
  })

  it('viewArchive is a no-op for an unknown id', () => {
    const before = useAgentStore.getState()
    useAgentStore.getState().viewArchive('does-not-exist')
    expect(useAgentStore.getState().viewingArchiveId).toBe(before.viewingArchiveId)
  })

  it('deleteArchive forgets a past session', () => {
    ev({ type: 'user-text', text: 'gone soon' })
    useAgentStore.getState().setStatus('done')
    const id = useAgentStore.getState().pastSessions[0].id
    useAgentStore.getState().deleteArchive(id)
    expect(useAgentStore.getState().pastSessions).toHaveLength(0)
  })

  it('deleteArchive while viewing that archive drops back to live mode', () => {
    ev({ type: 'user-text', text: 'view then delete' })
    useAgentStore.getState().setStatus('done')   // archives the live session
    useAgentStore.getState().reset()             // clear live so viewArchive won't re-snapshot
    const id = useAgentStore.getState().pastSessions[0].id
    useAgentStore.getState().viewArchive(id)
    useAgentStore.getState().deleteArchive(id)
    const s = useAgentStore.getState()
    expect(s.pastSessions).toHaveLength(0)
    expect(s.viewingArchiveId).toBeNull()
    expect(s.status).toBe('idle')
    expect(s.messages).toEqual([])
  })

  it('renameArchive updates the title and trims; blank falls back to "Untitled"', () => {
    ev({ type: 'user-text', text: 'original' })
    useAgentStore.getState().setStatus('done')
    const id = useAgentStore.getState().pastSessions[0].id
    useAgentStore.getState().renameArchive(id, '  Renamed  ')
    expect(useAgentStore.getState().pastSessions[0].title).toBe('Renamed')
    useAgentStore.getState().renameArchive(id, '   ')
    expect(useAgentStore.getState().pastSessions[0].title).toBe('Untitled')
  })
})

// ── resumeArchive: continue an old session ───────────────────────────────────
describe('resumeArchive', () => {
  it('restores an archived session as an EDITABLE live session and removes it from the archive', () => {
    ev({ type: 'user-text', text: 'old work' })
    useAgentStore.getState().setWorkingDir('/repo')
    useAgentStore.getState().setHarness('tachi')
    useAgentStore.getState().setMode('plan')
    useAgentStore.getState().setStatus('done')   // archives the live session
    const past = useAgentStore.getState().pastSessions[0]
    useAgentStore.getState().reset()             // clear live area (mirrors "+ New")

    useAgentStore.getState().resumeArchive(past.id)
    const s = useAgentStore.getState()
    expect(s.viewingArchiveId).toBeNull()        // EDITABLE — not read-only viewing
    expect(s.sessionId).toBeNull()               // AgentPage starts a fresh harness session next
    expect(s.messages).toEqual(past.messages)    // transcript preserved
    expect(s.workingDir).toBe('/repo')
    expect(s.harness).toBe('tachi')
    expect(s.mode).toBe('plan')
    expect(s.status).toBe('idle')
    expect(s.error).toBeNull()
    expect(s.startedAt).toBe(past.startedAt)     // identity preserved → re-archive dedups
    expect(s.pastSessions).toHaveLength(0)       // moved out of the archive into live
  })

  it('is a no-op for an unknown id', () => {
    ev({ type: 'user-text', text: 'x' })
    useAgentStore.getState().setStatus('done')
    const before = useAgentStore.getState().pastSessions.length
    useAgentStore.getState().resumeArchive('does-not-exist')
    expect(useAgentStore.getState().pastSessions).toHaveLength(before)
  })

  it('exits read-only viewing mode when resuming the archive being viewed', () => {
    ev({ type: 'user-text', text: 'seed' })
    useAgentStore.getState().setStatus('done')
    useAgentStore.getState().reset()
    const id = useAgentStore.getState().pastSessions[0].id
    useAgentStore.getState().viewArchive(id)
    expect(useAgentStore.getState().viewingArchiveId).toBe(id)

    useAgentStore.getState().resumeArchive(id)
    expect(useAgentStore.getState().viewingArchiveId).toBeNull()
    expect(useAgentStore.getState().sessionId).toBeNull()
    expect(useAgentStore.getState().pastSessions).toHaveLength(0)
  })

  it('re-archives to the SAME logical session on the next terminal status (startedAt dedup)', () => {
    ev({ type: 'user-text', text: 'job' })
    useAgentStore.getState().setStatus('done')
    const past = useAgentStore.getState().pastSessions[0]
    useAgentStore.getState().reset()
    useAgentStore.getState().resumeArchive(past.id)
    // simulate continuing + finishing again
    ev({ type: 'text', text: 'more output' })
    useAgentStore.getState().setStatus('done')
    // still ONE archive entry for this logical session (same startedAt)
    const past2 = useAgentStore.getState().pastSessions
    expect(past2).toHaveLength(1)
    expect(past2[0].startedAt).toBe(past.startedAt)
  })
})

// ── Pure exported helpers ────────────────────────────────────────────────────
describe('getContextZone', () => {
  it('maps fill pct to a colour zone at the documented thresholds', () => {
    expect(getContextZone(0)).toBe('green')
    // UX F15: amber starts at 60% — warn while there is still headroom to act.
    expect(getContextZone(0.59)).toBe('green')
    expect(getContextZone(0.60)).toBe('yellow')   // inclusive lower bound
    expect(getContextZone(0.84)).toBe('yellow')
    expect(getContextZone(0.85)).toBe('red')        // inclusive lower bound
    expect(getContextZone(1.5)).toBe('red')
  })
})

describe('the per-provider window table is gone and must stay gone', () => {
  it('exports no provider-keyed context table', async () => {
    // The positive test that used to live here asserted the caps were correct.
    // They were correct AS NUMBERS and wrong AS AN IDEA: a window is per model,
    // so a provider-keyed table is wrong for most rows however carefully its
    // values are maintained. This asserts the absence instead.
    const mod = await import('../../src/store/agent.store')
    expect('PROVIDER_MAX_TOKENS' in mod).toBe(false)
    expect('DEFAULT_MAX_TOKENS' in mod).toBe(false)
    expect(useAgentStore.getState()).not.toHaveProperty('contextFillPct')
  })
})
