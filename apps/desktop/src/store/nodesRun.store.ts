// apps/desktop/src/store/nodesRun.store.ts
//
// GLOBAL state for a Nodes "Run all" (sequential) / "Run as network" execution.
//
// Why global (not NodesPage component state): the run is a long-lived async loop
// that keeps going even if the user navigates away from the /nodes tab (which
// unmounts NodesPage). Holding the status here means:
//   1. the run is never "forgotten" — leaving the tab doesn't reset the panel;
//   2. a RUNNING indicator can show on the Nodes tab from ANYWHERE in the app;
//   3. returning to /nodes shows the live status (running / done / error).
//
// The orchestrator (NodesPage.handleRunAll) writes here; the Sidebar reads
// `status.kind === 'running'` for the tab badge; NodesPage reads the whole
// status for the Run panel.
import { create } from 'zustand'
import type { Artifact } from '../types/electron'
import type { MediaNodeModality } from '../pages/nodes/types'

export type GraphRunAgentResult = { agent: string; text: string }

/** Mirror of MediaNodeResult in graph-to-agentkit.ts (Phase-2 media output). */
export type NodesMediaResult = {
  nodeId:    string
  label:     string
  modality:  MediaNodeModality
  prompt:    string
  ok:        boolean
  artifacts: Artifact[]
  text?:     string
  error?:    string
}

export type NodesRunStatus =
  | { kind: 'idle' }
  // `attempt`/`attempts` are set only while RE-running a node (retry-on-fail):
  // attempt is 1-based and > 1 during a retry, attempts = total allowed.
  | { kind: 'running'; step?: number; total?: number; label?: string; attempt?: number; attempts?: number }
  | { kind: 'done'; results: GraphRunAgentResult[]; final: string; media?: NodesMediaResult[] }
  | { kind: 'error'; error: string }

// ── PER-NODE runs (the canvas RUN button / ↻ regen / fan-out) ────────────────
//
// These used to live in useNodeRun's own `useState` + refs, which is the second
// half of the driver's finding: a per-node run touched NOTHING global, so
// leaving /nodes threw the run away completely — no label, no stop, and a
// sidebar dot that read false while sd-cli held the GPU for 44 minutes. Same
// cause as the Run-all panel below, same fix as media.store's `run` slice: a
// module-scoped home the component binds to, never the other way round.
//
// NOT PERSISTED, for the reason that slice states out loud: a render dies with
// the app, so a restored `running` would offer to stop a process that is gone.

/** What a node card renders: its own last/current run. */
export type NodeRunState =
  | { kind: 'idle' }
  // `attempt`/`attempts` populated only while RE-running (retry-on-fail).
  | { kind: 'running'; attempt?: number; attempts?: number }
  | { kind: 'done'; text?: string; artifacts: Artifact[] }
  | { kind: 'error'; error: string }

/** Live progress of a fan-out (N>1) — stable across the whole loop, unlike
 *  `state`, which cycles running→done per variant. */
export interface FanoutProgress {
  active: boolean
  /** Variants completed so far (0..total). */
  done: number
  /** Total variants requested (0 when not fanning out). */
  total: number
}

export interface NodeRunSlice {
  state: NodeRunState
  fanout: FanoutProgress
  /**
   * A run is in flight for this node — set BEFORE the codex-consent await, so
   * it also covers the window where `state` is still idle. Global rather than a
   * ref because a remount used to reset the ref and a second RUN click could
   * start a duplicate run on top of the first.
   *
   * That "BEFORE" was aspirational for one commit: doRun actually claimed it
   * AFTER awaiting the consent dialog, which is the one window the flag exists
   * to cover — two RUN clicks while the dialog was up both walked past the
   * guard. It is claimed immediately after the guard read now, and everything
   * after that point (the consent CANCEL return included) runs inside the try
   * whose `finally` clears it, so a refusal cannot wedge the node.
   */
  inflight: boolean
  /**
   * Stop after the current fan-out variant. Global for the sharper version of
   * the same reason: the loop that polls it may have outlived the component
   * whose `cancelRef` it closed over, so the STOP on the REMOUNTED card has to
   * write somewhere the running loop can still read.
   */
  stopRequested: boolean
}

/** The reading for a node nothing has run. One frozen object, so a selector
 *  returning it is reference-stable and cannot spin a re-render loop. */
export const IDLE_NODE_RUN: NodeRunSlice = Object.freeze({
  state: Object.freeze({ kind: 'idle' }) as NodeRunState,
  fanout: Object.freeze({ active: false, done: 0, total: 0 }) as FanoutProgress,
  inflight: false,
  stopRequested: false,
})

interface NodesRunState {
  status: NodesRunStatus
  setStatus: (status: NodesRunStatus) => void
  /**
   * Is the Run panel showing? This was NodesPage's own `useState(false)` — and
   * it is the panel that renders the RUNNING label, the step counter and the
   * STOP button. A tab switch unmounts the page, so a user who left a run
   * running came back to a closed panel and no way to stop it, while the
   * sidebar dot (which reads this same store) still said RUNNING. The status
   * was global; the only door to it was not.
   */
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  /**
   * The Run panel's typed initial message. Here for the SECOND half of the same
   * finding: only the panel's visibility moved into the store, so a tab switch
   * re-opened the panel — and it came back EMPTY, silently, because the text was
   * still NodesPage's own `useState('')`. Losing the panel and losing what you
   * typed into it are one bug. Session-only for the same reason as panelOpen: it
   * belongs to a run that dies with the app.
   */
  runInput: string
  setRunInput: (v: string) => void
  /** Per-node run state, keyed by canvas node id. Read with `nodeRunOf`. */
  nodeRuns: Record<string, NodeRunSlice>
  /** Merge a patch into one node's slice (missing fields keep their value). */
  setNodeRun: (nodeId: string, patch: Partial<NodeRunSlice>) => void
  /** Ask a fan-out to stop after the current variant. */
  requestNodeStop: (nodeId: string) => void
  /** Forget a node's run entirely (the × Clear on the card) — unless a run is
   *  still IN FLIGHT, in which case the run half of the slice is kept. See the
   *  action for why that exception is not optional. */
  resetNodeRun: (nodeId: string) => void
  /**
   * Forget EVERY settled node run — the flow lifecycle's broom (switch flow,
   * + New, import, open a template).
   *
   * Nothing pruned `nodeRuns` before, so every slice a session ever created
   * stayed alive: `done` states hold their artifacts, inline b64 bytes and all,
   * and the templates re-use FIXED node ids ('p2i-image'), so re-opening one
   * RE-ATTACHED the previous canvas's stale result to a node that had never run
   * here. A slice with `inflight === true` is deliberately SPARED: a 44-minute
   * render does not stop because the user opened another flow, its lamps must
   * stay honest, and its `finally` still has a result to stamp.
   */
  resetAllNodeRuns: () => void
  /** EDGE RUN-INFO: the node currently executing (from the main-process
   *  'graph:node-active' stream), or null when nothing is running. Session-only,
   *  never persisted — the canvas selects it so a running node's OUTGOING edges
   *  animate their dashes (data-flow direction) without touching the flow JSON. */
  activeNodeId: string | null
  setActiveNodeId: (id: string | null) => void
  /** Cooperative-cancel flag for a sequential "Run all". The orchestrator
   *  (NodesPage.handleRunAll) checks it between nodes and bails. An in-flight
   *  node finishes first — there is no mid-node abort — so this is effectively
   *  "stop after the current step". */
  stopRequested: boolean
  /** Ask the running "Run all" to stop after the current node finishes. */
  requestStop: () => void
  /** Clear the flag — called when a fresh "Run all" begins. */
  clearStop: () => void
  /** NODES-RESEARCH #4: hard estimated-spend cap for a Run-all (USD). null =
   *  off. The orchestrator stops BEFORE the node that would cross it —
   *  runaway-loop insurance (the $47k n8n story). Persisted via localStorage. */
  budgetUsd: number | null
  setBudgetUsd: (v: number | null) => void
}

function readStoredBudget(): number | null {
  try {
    const raw = localStorage.getItem('tachi:nodes-budget-usd')
    const n = raw == null ? NaN : Number(raw)
    return isFinite(n) && n > 0 ? n : null
  } catch { return null }
}

/**
 * One node's run slice, or the shared idle reading. Use this instead of
 * indexing `nodeRuns` directly: it keeps the "never run" answer a single frozen
 * object, so `useNodesRunStore(s => nodeRunOf(s, id).state)` is stable.
 */
export function nodeRunOf(state: NodesRunState, nodeId: string): NodeRunSlice {
  return state.nodeRuns[nodeId] ?? IDLE_NODE_RUN
}

/**
 * IS ANYTHING RUNNING ON THE CANVAS — the one expression behind the sidebar
 * dot and the three chassis lamps.
 *
 * It used to be `status.kind === 'running'` copy-pasted into four files, which
 * answered only for a Run-all: a lone media node rendering for 44 minutes lit
 * nothing at all, so the app looked idle while it burned the GPU. Both shapes
 * of "running" belong to the same question, so they belong in one function —
 * and it stays a BOOLEAN selector, so those four components still re-render
 * only when the answer flips.
 *
 * A fan-out counts while it is between variants: `state` dips to `done` there,
 * and a lamp that blinked once per variant would be noise, not information.
 */
export function nodesRunActive(state: NodesRunState): boolean {
  if (state.status.kind === 'running') return true
  for (const id of Object.keys(state.nodeRuns)) {
    const slice = state.nodeRuns[id]!
    if (slice.state.kind === 'running' || slice.fanout.active) return true
  }
  return false
}

export const useNodesRunStore = create<NodesRunState>((set) => ({
  status: { kind: 'idle' },
  setStatus: (status) => set({ status }),
  panelOpen: false,
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  runInput: '',
  setRunInput: (runInput) => set({ runInput }),
  nodeRuns: {},
  setNodeRun: (nodeId, patch) => set(s => {
    const prev = s.nodeRuns[nodeId] ?? IDLE_NODE_RUN
    return { nodeRuns: { ...s.nodeRuns, [nodeId]: { ...prev, ...patch } } }
  }),
  requestNodeStop: (nodeId) => set(s => {
    const prev = s.nodeRuns[nodeId] ?? IDLE_NODE_RUN
    return { nodeRuns: { ...s.nodeRuns, [nodeId]: { ...prev, stopRequested: true } } }
  }),
  // × CLEAR CANNOT UNKNOW A RUNNING RUN.
  //
  // This deleted the whole slice, `inflight` and `stopRequested` with it. Pressed
  // during a 44-minute i2v render — which is exactly when a user pokes at the
  // card — it made the app forget the render was happening: doRun's guard reads
  // `inflight`, so RUN went live again and a SECOND render could start on the
  // same GPU, and nodesRunActive() went false, darkening the sidebar dot and all
  // three chassis lamps while sd-cli was still at 100%.
  //
  // So the split is by MEANING, not by field: clearing a RESULT is what the
  // button does, and a run in flight is not a result. A live slice therefore
  // keeps `inflight` (the guard), `stopRequested` (a STOP already asked for must
  // still reach the loop) and `fanout` (mid-loop progress the lamps read), and
  // only its `state` is cleared — and even that only when it is not `running`,
  // because nothing here is allowed to claim a running node is idle. A SETTLED
  // node is still forgotten entirely, which is the ordinary case.
  resetNodeRun: (nodeId) => set(s => {
    const prev = s.nodeRuns[nodeId]
    if (prev == null) return s
    if (!prev.inflight) {
      const next = { ...s.nodeRuns }
      delete next[nodeId]
      return { nodeRuns: next }
    }
    return {
      nodeRuns: {
        ...s.nodeRuns,
        [nodeId]: {
          ...prev,
          state: prev.state.kind === 'running' ? prev.state : { kind: 'idle' },
        },
      },
    }
  }),
  resetAllNodeRuns: () => set(s => {
    const kept: Record<string, NodeRunSlice> = {}
    for (const id of Object.keys(s.nodeRuns)) {
      const slice = s.nodeRuns[id]!
      if (slice.inflight) kept[id] = slice
    }
    return { nodeRuns: kept }
  }),
  activeNodeId: null,
  setActiveNodeId: (id) => set({ activeNodeId: id }),
  stopRequested: false,
  requestStop: () => set({ stopRequested: true }),
  clearStop: () => set({ stopRequested: false }),
  budgetUsd: readStoredBudget(),
  setBudgetUsd: (v) => {
    try {
      if (v == null || !(v > 0)) localStorage.removeItem('tachi:nodes-budget-usd')
      else localStorage.setItem('tachi:nodes-budget-usd', String(v))
    } catch { /* storage unavailable */ }
    set({ budgetUsd: v != null && v > 0 ? v : null })
  },
}))
