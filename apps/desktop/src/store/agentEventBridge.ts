// apps/desktop/src/store/agentEventBridge.ts
//
// APP-LIFETIME subscription to the agent streams (events + permission prompts)
// and to the parallel-task stream (see startParallelEventBridge at the bottom —
// same root cause, same fix, one entry point).
//
// THE BUG THIS EXISTS FOR (2026-07-25). `window.tachi.agent.onEvent(...)` was
// subscribed from an effect inside AgentPage — and AgentPage is a react-router
// element for /agent and /tachiapp. Navigating to ANY other tab unmounted it and
// unsubscribed. From that moment every agent event was dropped on the floor:
// tool-calls, the terminal `done`, even the timeout `error`. The store's status
// stayed 'running' forever, the UI showed WORKING with zero events, and a run
// that had actually failed minutes ago looked alive. Coming back to the tab did
// not help — the events were already gone, and nothing replays them.
//
// The subscription therefore belongs to the APP, not to a route. This module
// starts it ONCE (idempotent module guard: React StrictMode's double-invoke and
// the /agent ⇄ /tachiapp remount must not create a second listener, which would
// append every event twice) and feeds the agent store exactly as the page did.
// AgentPage now renders purely from the store.
//
// Semantics carried over verbatim from the old in-page handler:
//   • `checkpoint` events are INTERCEPTED, not transcript — they carry the
//     pre-edit workspace snapshot the ↺ REVERT button restores. They now land in
//     `agentStore.revertCheckpoint` (the bridge has no component to hand them to).
//   • everything else goes to `appendEvent`, which owns archive-view protection
//     (drops events while `viewingArchiveId` is set, so browsing history can
//     never be corrupted by a live run) and the streaming-text coalescing.
//   • permission requests/cancels push into the store queue, so approval cards
//     now arrive while the operator is on another tab.
//   • ONE re-sync at startup against main's outstanding list, covering the only
//     remaining gap: a full renderer reload while main is blocked on a prompt.

import type { AgentEvent } from '@tachi/core'
import { useAgentStore } from './agent.store'
import { useParallelAgentsStore } from './parallel-agents.store'
import type { PermissionRequest } from '../pages/agent/PermissionCard'
import type { ParallelEvent } from '../types/electron'

type Unsub = () => void

/**
 * Module guard. NOT a React ref and NOT store state: it must survive every
 * remount and every StrictMode double-invoke in the renderer's lifetime.
 */
let started = false
let unsubs: Unsub[] = []

/** Same guard, for the parallel-task stream (its own so either can no-op alone). */
let parallelStarted = false
let parallelUnsubs: Unsub[] = []

/** A `checkpoint` event — not a chat turn, so it never reaches the transcript. */
interface CheckpointEvent {
  type?: string
  checkpoint?: { id: string; label: string }
  workspaceRoot?: string
}

/**
 * Route ONE agent event. Exported for tests: it is the whole behavioural
 * contract of the bridge (intercept vs append) with no IPC involved.
 */
export function routeAgentEvent(event: AgentEvent): void {
  const ck = event as unknown as CheckpointEvent
  if (ck.type === 'checkpoint' && ck.checkpoint?.id && ck.workspaceRoot) {
    useAgentStore.getState().setRevertCheckpoint({
      id:    ck.checkpoint.id,
      root:  ck.workspaceRoot,
      label: ck.checkpoint.label,
    })
    return
  }
  // appendEvent is the single writer of the transcript and holds the
  // archive-view guard — do not pre-filter here.
  useAgentStore.getState().appendEvent(event)
}

/**
 * Start the app-lifetime subscriptions. Idempotent: the second and later calls
 * are no-ops, so mounting the app twice (StrictMode) or navigating between the
 * two AgentPage routes cannot double-subscribe.
 *
 * Deliberately NOT torn down by its caller's effect cleanup — these streams are
 * alive for as long as the renderer is. `__stopAgentEventBridge` exists only so
 * unit tests can get a clean slate.
 */
export function startAgentEventBridge(): void {
  // Same lifetime, same reason — see startParallelEventBridge. Called first so
  // a window without the agent API (the early return below) still gets it.
  startParallelEventBridge()
  if (started) return
  const api = (globalThis as { window?: { tachi?: { agent?: unknown } } }).window?.tachi?.agent as {
    onEvent?:             (cb: (e: AgentEvent) => void) => Unsub
    onPermissionRequest?: (cb: (r: PermissionRequest) => void) => Unsub
    onPermissionCancel?:  (cb: (p: { ids: string[]; reason: string }) => void) => Unsub
    permissionPending?:   () => Promise<PermissionRequest[]>
  } | undefined
  if (!api?.onEvent) return   // no preload (tests / overlay windows) — nothing to bind

  started = true

  unsubs.push(api.onEvent(routeAgentEvent))

  // APPEND, never replace: each request has its own resolver waiting in main,
  // so losing one hangs the run that is blocked on it.
  if (api.onPermissionRequest) {
    unsubs.push(api.onPermissionRequest(req => { useAgentStore.getState().pushPermission(req) }))
  }
  // Main settled these without the user (10-min timeout, run aborted, or a
  // remote surface answered) — drop the cards so nobody answers into the void.
  if (api.onPermissionCancel) {
    unsubs.push(api.onPermissionCancel(({ ids }) => { useAgentStore.getState().cancelPermissions(ids) }))
  }

  // RE-SYNC ONCE at startup: ask main which prompts it is STILL blocked on.
  // With the push channel now app-lifetime the only way to miss one is a
  // renderer reload, which is exactly what this covers. Only the cards we
  // already showed when the round-trip STARTED may be pruned by the answer — a
  // card pushed while it was in flight is newer than main's snapshot, and
  // dropping it would strand its resolver.
  if (api.permissionPending) {
    const prunable = useAgentStore.getState().permissionQueue.map(q => q.id)
    api.permissionPending()
      .then(reqs => { if (Array.isArray(reqs)) useAgentStore.getState().syncPermissions(reqs, prunable) })
      .catch(() => { /* older main / no session — the push channel still works */ })
  }
}

/**
 * Route ONE parallel-task event. Exported for tests — the whole behavioural
 * contract of the parallel half of the bridge, with no IPC involved.
 */
export function routeParallelEvent(event: ParallelEvent): void {
  useParallelAgentsStore.getState().applyEvent(event)
}

/**
 * APP-LIFETIME subscription to the parallel-task stream.
 *
 * SAME BUG, SECOND STREAM (2026-07-25). `window.tachi.parallel.onEvent(...)`
 * was still subscribed from an effect inside AgentPage, with the effect's own
 * cleanup unsubscribing it on unmount. So every tile in the parallel grid went
 * STALE the moment the operator left the tab: statuses, the steps.json watcher
 * lines, and the `list` refresh that adds/removes tiles were all dropped, and
 * nothing replays them — coming back showed whatever the grid looked like when
 * it was last mounted. Identical fix, identical guarantees: bound once for the
 * renderer's lifetime, idempotent, feeding the same store the page reads.
 *
 * Semantics carried over verbatim from the in-page effect: bootstrap ONCE if
 * the store has not hydrated (`window.tachi.parallel.list()` — worktrees on
 * disk are the durable record), then apply every pushed event to the store.
 */
export function startParallelEventBridge(): void {
  if (parallelStarted) return
  const api = (globalThis as { window?: { tachi?: { parallel?: unknown } } }).window?.tachi?.parallel as {
    onEvent?: (cb: (e: ParallelEvent) => void) => Unsub
  } | undefined
  if (!api?.onEvent) return   // no preload (tests / overlay windows) — nothing to bind

  parallelStarted = true

  // Hydrate from main's authoritative list. The store guards its own failure
  // (it still marks itself bootstrapped so the grid never hangs on a spinner).
  if (!useParallelAgentsStore.getState().bootstrapped) {
    void useParallelAgentsStore.getState().bootstrap()
  }

  parallelUnsubs.push(api.onEvent(routeParallelEvent))
}

/** True once the subscriptions are live. Test/diagnostic helper. */
export function isAgentEventBridgeStarted(): boolean {
  return started
}

/** True once the parallel stream is live. Test/diagnostic helper. */
export function isParallelEventBridgeStarted(): boolean {
  return parallelStarted
}

/** Tear down + clear the guard. TESTS ONLY — the app never stops the bridge. */
export function __stopAgentEventBridge(): void {
  for (const off of unsubs) { try { off() } catch { /* already gone */ } }
  unsubs = []
  started = false
  __stopParallelEventBridge()
}

/** Tear down + clear the parallel guard. TESTS ONLY. */
export function __stopParallelEventBridge(): void {
  for (const off of parallelUnsubs) { try { off() } catch { /* already gone */ } }
  parallelUnsubs = []
  parallelStarted = false
}
