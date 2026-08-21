// apps/desktop/test/unit/agentEventBridge.test.ts
//
// EVENT-SUBSCRIPTION LIFETIME. The bug, 2026-07-25:
//
// `window.tachi.agent.onEvent(...)` was subscribed from an effect inside
// AgentPage — the react-router element for /agent and /tachiapp. Navigating to
// ANY other tab unmounted the page and unsubscribed the ONLY listener of the
// agent event stream in the whole renderer. Every event after that moment was
// dropped: tool-calls, the terminal `done`, even the timeout `error`. The store
// kept status 'running' forever, the UI showed WORKING with nothing under it,
// and returning to the tab did not help — the events were already gone.
//
// The subscription is app-lifetime now (src/store/agentEventBridge.ts). NOTHING
// in this file renders a component: that IS the assertion. Every test drives the
// bridge with no AgentPage anywhere and proves the store still receives.
//
// Same shim dance as agentStore.test.ts / reconnectStores.test.ts: stub
// localStorage + window.tachi BEFORE importing the store, so the persist
// middleware's rehydrate is a silent in-memory no-op. `await import` (rather
// than a static import) is what actually guarantees that ordering — a static
// import is hoisted above the assignments.

import { describe, it, expect, beforeEach } from 'vitest'
import type { AgentEvent } from '@tachi/core'
import type { PermissionRequest } from '../../src/pages/agent/PermissionCard'
import type { ParallelEvent, ParallelTaskSnapshot } from '../../src/types/electron'

const _ls = new Map<string, string>()
;(globalThis as Record<string, unknown>).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}

// ── Fake preload: the three agent streams + the pending re-sync ───────────────
type EventCb  = (e: AgentEvent) => void
type PermCb   = (r: PermissionRequest) => void
type CancelCb = (p: { ids: string[]; reason: string }) => void

/** How many times each channel was SUBSCRIBED — the duplicate-guard assertion. */
const subs = { event: 0, perm: 0, cancel: 0 }
const cbs  = { event: [] as EventCb[], perm: [] as PermCb[], cancel: [] as CancelCb[] }
/** What main claims it is still blocked on when the bridge re-syncs. */
let pendingReply: PermissionRequest[] = []
let pendingCalls = 0

const agentApi = {
  onEvent(cb: EventCb) {
    subs.event++; cbs.event.push(cb)
    return () => { cbs.event = cbs.event.filter(c => c !== cb) }
  },
  onPermissionRequest(cb: PermCb) {
    subs.perm++; cbs.perm.push(cb)
    return () => { cbs.perm = cbs.perm.filter(c => c !== cb) }
  },
  onPermissionCancel(cb: CancelCb) {
    subs.cancel++; cbs.cancel.push(cb)
    return () => { cbs.cancel = cbs.cancel.filter(c => c !== cb) }
  },
  async permissionPending() { pendingCalls++; return pendingReply },
}

// ── Fake preload: the parallel-task stream (same hoist, second stream) ───────
type ParallelCb = (e: ParallelEvent) => void
const parallelSubs = { event: 0 }
let parallelCbs: ParallelCb[] = []
/** What main's authoritative `list()` returns to the one-time bootstrap. */
let parallelListReply: ParallelTaskSnapshot[] = []
let parallelListCalls = 0

const parallelApi = {
  onEvent(cb: ParallelCb) {
    parallelSubs.event++; parallelCbs.push(cb)
    return () => { parallelCbs = parallelCbs.filter(c => c !== cb) }
  },
  async list() { parallelListCalls++; return { tasks: parallelListReply } },
}

;(globalThis as Record<string, unknown>).window = {
  tachi: {
    safeStorage: {
      isAvailable: async () => ({ available: false }),
      encrypt:     async (v: string) => ({ encrypted: v }),
      decrypt:     async (v: string) => ({ plaintext: v }),
    },
    agent: agentApi,
    parallel: parallelApi,
  },
}

const { useAgentStore } = await import('../../src/store/agent.store')
const { useParallelAgentsStore } = await import('../../src/store/parallel-agents.store')
const {
  startAgentEventBridge, __stopAgentEventBridge, isAgentEventBridgeStarted, routeAgentEvent,
  startParallelEventBridge, isParallelEventBridgeStarted, routeParallelEvent,
} = await import('../../src/store/agentEventBridge')

/** Main pushes an event to the renderer. */
function emit(event: AgentEvent): void { for (const cb of [...cbs.event]) cb(event) }
function emitPermission(req: PermissionRequest): void { for (const cb of [...cbs.perm]) cb(req) }
function emitCancel(ids: string[]): void {
  for (const cb of [...cbs.cancel]) cb({ ids, reason: 'timeout' })
}
/** Let the permissionPending() promise + its .then settle. */
const flush = () => new Promise<void>(r => setTimeout(r, 0))

const card = (id: string): PermissionRequest => ({
  id,
  toolName: 'bash',
  toolInput: { command: 'pnpm run typecheck' },
  reason: 'Bash execution: `pnpm run typecheck`',
  recommendedDecision: 'allow',
})

const messages = () => useAgentStore.getState().messages
const texts = () => messages().map(m => (m.event as { text?: string }).text)

/** Main pushes a parallel-task event to the renderer. */
function emitParallel(event: ParallelEvent): void { for (const cb of [...parallelCbs]) cb(event) }

const task = (
  id: string,
  status: ParallelTaskSnapshot['status'] = 'idle',
  createdAt = 1,
): ParallelTaskSnapshot => ({
  id,
  name:         id,
  branchName:   `tachi/${id}`,
  worktreePath: `D:/wt/${id}`,
  sessionId:    `sess-${id}`,
  workingDir:   `D:/wt/${id}`,
  status,
  createdAt,
})

beforeEach(() => {
  __stopAgentEventBridge()   // also stops the parallel half
  subs.event = 0; subs.perm = 0; subs.cancel = 0
  cbs.event = []; cbs.perm = []; cbs.cancel = []
  pendingReply = []; pendingCalls = 0
  parallelSubs.event = 0; parallelCbs = []
  parallelListReply = []; parallelListCalls = 0
  useParallelAgentsStore.setState({
    tasks: new Map(), taskOrder: [], steps: new Map(),
    focusedTaskId: null, lastWarnings: [], bootstrapped: false,
    displayMode: new Map(),
  })
  useAgentStore.setState({
    messages: [], status: 'idle', error: null, startedAt: null,
    viewingArchiveId: null, pastSessions: [], permissionQueue: [],
    revertCheckpoint: null, reconnect: null, loop: null, endedIncomplete: null,
  })
})

describe('agent event bridge — the stream outlives the page', () => {
  it('appends events with NO AgentPage mounted (nothing here renders one)', async () => {
    startAgentEventBridge()
    await flush()

    emit({ type: 'text', text: 'reading files' } as AgentEvent)
    emit({ type: 'tool-call', name: 'read_file', input: 'src/a.ts' } as unknown as AgentEvent)

    expect(messages()).toHaveLength(2)
    expect(texts()[0]).toBe('reading files')
  })

  it('carries a run to its TERMINAL state off-tab — the old bug in one test', async () => {
    // Before the hoist: the operator sends a task on /agent, switches to /nodes,
    // the run times out — and nothing ever arrives. status stays 'running' and
    // the UI shows WORKING forever.
    startAgentEventBridge()
    await flush()
    useAgentStore.setState({ status: 'running' })

    emit({ type: 'error', message: 'harness timed out after 600s' } as AgentEvent)

    expect(useAgentStore.getState().status).toBe('error')
    expect(useAgentStore.getState().error).toContain('timed out')
  })

  it('a `done` off-tab still archives the session', async () => {
    startAgentEventBridge()
    await flush()
    emit({ type: 'user-text', text: 'build the thing' } as AgentEvent)
    emit({ type: 'done' } as AgentEvent)

    expect(useAgentStore.getState().status).toBe('done')
    expect(useAgentStore.getState().pastSessions).toHaveLength(1)
    expect(useAgentStore.getState().pastSessions[0].title).toBe('build the thing')
  })

  it('preserves the store-side text coalescing (one block, not one line per token)', async () => {
    startAgentEventBridge()
    await flush()
    emit({ type: 'text', text: 'hello ' } as AgentEvent)
    emit({ type: 'text', text: 'world' } as AgentEvent)

    expect(messages()).toHaveLength(1)
    expect(texts()[0]).toBe('hello world')
  })

  it('keeps live-status events (reconnect / loop) out of the transcript', async () => {
    startAgentEventBridge()
    await flush()
    emit({ type: 'reconnect', attempt: 2, maxAttempts: 10, delayMs: 4000, reason: 'stream closed' } as unknown as AgentEvent)
    emit({ type: 'loop', iteration: 3, cap: 20, goal: 'ship it' } as unknown as AgentEvent)

    expect(messages()).toEqual([])
    expect(useAgentStore.getState().reconnect?.attempt).toBe(2)
    expect(useAgentStore.getState().loop?.iteration).toBe(3)
  })
})

describe('agent event bridge — routing contract, no IPC', () => {
  it('routeAgentEvent is the whole behaviour: intercept checkpoints, append the rest', () => {
    routeAgentEvent({ type: 'text', text: 'a turn' } as AgentEvent)
    routeAgentEvent({
      type: 'checkpoint',
      checkpoint: { id: 'cp-0', label: 'l' },
      workspaceRoot: '/r',
    } as unknown as AgentEvent)

    expect(texts()).toEqual(['a turn'])
    expect(useAgentStore.getState().revertCheckpoint?.id).toBe('cp-0')
  })
})

describe('agent event bridge — duplicate-subscription guard', () => {
  it('is idempotent: StrictMode double-invoke subscribes exactly once', async () => {
    startAgentEventBridge()
    startAgentEventBridge()   // React 19 StrictMode runs the mount effect twice
    await flush()

    expect(subs.event).toBe(1)
    expect(subs.perm).toBe(1)
    expect(subs.cancel).toBe(1)
    expect(pendingCalls).toBe(1)
    expect(isAgentEventBridgeStarted()).toBe(true)
  })

  it('a second start cannot double-append (that would duplicate every token)', async () => {
    startAgentEventBridge()
    startAgentEventBridge()
    await flush()

    emit({ type: 'text', text: 'once' } as AgentEvent)

    expect(messages()).toHaveLength(1)
    expect(texts()[0]).toBe('once')
  })

  it('navigating /agent ⇄ /tachiapp (remount) does not add a listener', async () => {
    startAgentEventBridge()
    await flush()
    // Whatever the routes do, they never touch the bridge — re-entering start()
    // from any surface is the same no-op.
    startAgentEventBridge()
    startAgentEventBridge()

    expect(subs.event).toBe(1)
    emit({ type: 'text', text: 'x' } as AgentEvent)
    expect(texts()).toEqual(['x'])
  })
})

describe('agent event bridge — checkpoint intercept', () => {
  it('a checkpoint is captured for the revert button, never rendered as a turn', async () => {
    startAgentEventBridge()
    await flush()
    emit({
      type: 'checkpoint',
      checkpoint: { id: 'cp-1', label: 'before edits' },
      workspaceRoot: 'D:/projects/TachiDesk',
    } as unknown as AgentEvent)

    expect(messages()).toEqual([])   // NOT transcript
    expect(useAgentStore.getState().revertCheckpoint).toEqual({
      id: 'cp-1', root: 'D:/projects/TachiDesk', label: 'before edits',
    })
  })

  it('a malformed checkpoint (no id / no root) is dropped, never rendered as a turn', async () => {
    // The BRIDGE intercept still requires BOTH fields — so this one falls
    // through to appendEvent, exactly as before.
    //
    // CHANGED 2026-07-26 (plan A2): appendEvent now owns a second, deliberate
    // guard — `checkpoint` is workspace bookkeeping and NEVER transcript. Main
    // emits an id-less checkpoint on purpose now ("no snapshot could be taken
    // for this turn"), and letting that render as a mystery chat row was the
    // old behaviour's only reason for existing.
    startAgentEventBridge()
    await flush()
    emit({ type: 'checkpoint', checkpoint: { id: 'cp-2', label: 'x' } } as unknown as AgentEvent)

    expect(useAgentStore.getState().revertCheckpoint).toBeNull()
    expect(messages()).toHaveLength(0)
    // No workspaceRoot ⇒ nothing to bind a per-turn restore to either.
    expect(useAgentStore.getState().turnCheckpoints).toEqual([])
  })

  it('survives the tab switch that used to lose it (it is store state now)', async () => {
    startAgentEventBridge()
    await flush()
    emit({
      type: 'checkpoint',
      checkpoint: { id: 'cp-3', label: 'pre-write' },
      workspaceRoot: '/repo',
    } as unknown as AgentEvent)

    // …CODE → NODES → CODE. No component state exists to be thrown away.
    expect(useAgentStore.getState().revertCheckpoint?.id).toBe('cp-3')
  })

  it('is scoped to the live session — a new one never inherits ↺ REVERT', async () => {
    // Now that it outlives the unmount it must NOT outlive the session: ↺ REVERT
    // restores files, and a leftover would point at the previous workspace.
    startAgentEventBridge()
    await flush()
    emit({ type: 'user-text', text: 'edit folder A' } as AgentEvent)
    emit({
      type: 'checkpoint',
      checkpoint: { id: 'cp-A', label: 'before edits' },
      workspaceRoot: '/folder-A',
    } as unknown as AgentEvent)
    expect(useAgentStore.getState().revertCheckpoint?.root).toBe('/folder-A')

    useAgentStore.getState().startNewSession()      // "+ NEW" / opening folder B
    expect(useAgentStore.getState().revertCheckpoint).toBeNull()

    useAgentStore.getState().setRevertCheckpoint({ id: 'cp-B', root: '/folder-B', label: 'x' })
    useAgentStore.getState().reset()                // sidebar "new session"
    expect(useAgentStore.getState().revertCheckpoint).toBeNull()
  })
})

describe('agent event bridge — archive-view guard', () => {
  it('an event arriving while an archive is open does not touch the archived transcript', async () => {
    const archived = {
      id: 'past-1',
      title: 'yesterday',
      workingDir: '/repo',
      harness: 'tachi' as const,
      mode: 'build' as const,
      status: 'done' as const,
      error: null,
      messages: [{ id: 'a1', event: { type: 'text', text: 'original' } as AgentEvent, timestamp: 1 }],
      startedAt: 1,
      endedAt: 2,
    }
    useAgentStore.setState({ pastSessions: [archived] })
    useAgentStore.getState().viewArchive('past-1')
    expect(useAgentStore.getState().viewingArchiveId).toBe('past-1')

    startAgentEventBridge()
    await flush()

    // A live run keeps streaming while the user browses history.
    emit({ type: 'text', text: 'LIVE LEAK' } as AgentEvent)
    emit({ type: 'done' } as AgentEvent)

    // The viewed transcript is untouched…
    expect(texts()).toEqual(['original'])
    // …and so is the stored archive.
    const stored = useAgentStore.getState().pastSessions.find(p => p.id === 'past-1')!
    expect(stored.messages.map(m => (m.event as { text?: string }).text)).toEqual(['original'])
    // …and the terminal event did not spawn a second archive entry.
    expect(useAgentStore.getState().pastSessions).toHaveLength(1)
  })

  it('live-status events are suppressed while viewing an archive too', async () => {
    useAgentStore.setState({
      pastSessions: [{
        id: 'past-2', title: 'x', workingDir: null, harness: 'tachi', mode: 'build',
        status: 'done', error: null, messages: [], startedAt: 1, endedAt: 2,
      }],
    })
    useAgentStore.getState().viewArchive('past-2')

    startAgentEventBridge()
    await flush()
    emit({ type: 'reconnect', attempt: 1, maxAttempts: 10, delayMs: 1000, reason: 'drop' } as unknown as AgentEvent)

    expect(useAgentStore.getState().reconnect).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE SAME BUG, SECOND STREAM. `window.tachi.parallel.onEvent(...)` was still
// subscribed from an effect inside AgentPage, with the effect's cleanup
// unsubscribing on unmount — so every tile in the parallel grid froze the moment
// the operator left the tab: statuses, the steps.json watcher lines, and the
// `list` refresh that adds/removes tiles were all dropped, and nothing replays
// them. Hoisted to the same app-lifetime bridge; nothing below renders a page.
// ─────────────────────────────────────────────────────────────────────────────
describe('parallel event bridge — tiles keep updating off-tab', () => {
  it('applies a `list` refresh with NO AgentPage mounted', async () => {
    startAgentEventBridge()
    await flush()

    emitParallel({ kind: 'list', tasks: [task('a', 'running'), task('b', 'idle', 2)] })

    const st = useParallelAgentsStore.getState()
    expect(st.taskOrder).toEqual(['a', 'b'])
    expect(st.tasks.get('a')?.status).toBe('running')
  })

  it('a status change that lands off-tab is NOT lost (the old bug in one test)', async () => {
    startAgentEventBridge()
    await flush()
    emitParallel({ kind: 'list', tasks: [task('a', 'running')] })

    // …operator switches to /nodes. Before the hoist the listener died here and
    // the tile stayed 'running' forever.
    emitParallel({ kind: 'list', tasks: [task('a', 'done')] })

    expect(useParallelAgentsStore.getState().tasks.get('a')?.status).toBe('done')
  })

  it('appends steps-watcher lines with no page mounted', async () => {
    startAgentEventBridge()
    await flush()
    emitParallel({ kind: 'step', taskId: 'a', entry: { id: 's1' } })
    emitParallel({ kind: 'step', taskId: 'a', entry: { id: 's2' } })

    expect(useParallelAgentsStore.getState().steps.get('a')?.map(s => s.id)).toEqual(['s1', 's2'])
  })

  it('bootstraps ONCE from main\'s authoritative list', async () => {
    parallelListReply = [task('boot')]
    startAgentEventBridge()
    await flush()

    expect(parallelListCalls).toBe(1)
    expect(useParallelAgentsStore.getState().taskOrder).toEqual(['boot'])
    expect(useParallelAgentsStore.getState().bootstrapped).toBe(true)
  })

  it('does not re-bootstrap when the store is already hydrated', async () => {
    useParallelAgentsStore.setState({ bootstrapped: true })
    startAgentEventBridge()
    await flush()

    expect(parallelListCalls).toBe(0)
  })

  it('is idempotent: repeated starts subscribe exactly once (no double-apply)', async () => {
    startAgentEventBridge()
    startAgentEventBridge()      // StrictMode double-invoke
    startParallelEventBridge()   // …and a direct re-entry
    await flush()

    expect(parallelSubs.event).toBe(1)
    expect(parallelListCalls).toBe(1)
    expect(isParallelEventBridgeStarted()).toBe(true)

    // A duplicate subscription would apply every step entry twice.
    emitParallel({ kind: 'step', taskId: 'a', entry: { id: 'only-once' } })
    expect(useParallelAgentsStore.getState().steps.get('a')).toHaveLength(1)
  })

  it('routeParallelEvent is the whole contract — store applied, no IPC', () => {
    routeParallelEvent({ kind: 'list', tasks: [task('direct')] })
    expect(useParallelAgentsStore.getState().taskOrder).toEqual(['direct'])
  })
})

describe('agent event bridge — permission prompts arrive off-tab', () => {
  it('pushes an approval card with no page mounted', async () => {
    startAgentEventBridge()
    await flush()
    emitPermission(card('req-1'))

    expect(useAgentStore.getState().permissionQueue.map(q => q.id)).toEqual(['req-1'])
  })

  it('main settling a request (timeout / abort) drops the card', async () => {
    startAgentEventBridge()
    await flush()
    emitPermission(card('req-1'))
    emitPermission(card('req-2'))
    emitCancel(['req-1'])

    expect(useAgentStore.getState().permissionQueue.map(q => q.id)).toEqual(['req-2'])
  })

  it('re-syncs ONCE at startup against what main is still blocked on', async () => {
    pendingReply = [card('stranded')]
    startAgentEventBridge()
    await flush()

    expect(pendingCalls).toBe(1)
    expect(useAgentStore.getState().permissionQueue.map(q => q.id)).toEqual(['stranded'])
  })

  it('the startup re-sync never prunes a card pushed while it was in flight', async () => {
    // The bridge snapshots the queue, asks main, and only that snapshot may be
    // pruned by the answer — a push landing mid-flight is NEWER than main's
    // view, and dropping it would strand the tool blocked on it.
    useAgentStore.setState({ permissionQueue: [card('old')] })
    pendingReply = []               // main: "nothing outstanding"
    startAgentEventBridge()
    emitPermission(card('mid-flight'))   // arrives before the promise settles
    await flush()

    expect(useAgentStore.getState().permissionQueue.map(q => q.id)).toEqual(['mid-flight'])
  })

  it('a failing permissionPending() does not break the push channel', async () => {
    const original = agentApi.permissionPending
    agentApi.permissionPending = async () => { throw new Error('older main') }
    try {
      startAgentEventBridge()
      await flush()
      emitPermission(card('req-1'))
      expect(useAgentStore.getState().permissionQueue.map(q => q.id)).toEqual(['req-1'])
    } finally {
      agentApi.permissionPending = original
    }
  })
})
