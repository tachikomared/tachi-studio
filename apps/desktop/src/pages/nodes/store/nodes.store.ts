// apps/desktop/src/pages/nodes/store/nodes.store.ts
//
// Zustand store for the Custom Nodes canvas. Follows the same persist-
// middleware pattern as agent.store.ts but uses plain localStorage (no
// encryption — flow graphs are not sensitive).

import { create } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react'
import type { TachiNode, TachiEdge, RunCostBasis } from '../types'
import type { Artifact } from '../../../types/electron'
import { nearestHandlePair, APPROX_NODE_RECT } from '../canvas/EightHandles'
import { ERR_HANDLE_ID } from '../canvas/errorBranch'
import { moveByDelta } from '../canvas/noteGroup'
import { mergeSelectionPlan } from '../canvas/mergeSelection'
import { fanoutPositions, fanoutVariantKey } from '../canvas/fanout'
import { sanitizeFlow, stripNodesArtifactB64 } from '../serialization'

/**
 * Node types whose ONLY source plug is the typed `out` — a media node and the
 * rife post-process node. An edge leaving one of these must name that handle;
 * the geometric 8-handle router would invent a spot id the card never renders
 * and React Flow would drop the edge with "couldn't create edge for handle id".
 */
const TYPED_OUT_NODE_TYPES: ReadonlySet<string> = new Set(['media', 'rife'])

/** The source handle for an edge leaving `type`, given the geometric fallback. */
function sourceHandleFor(type: string | undefined, fallback: string): string {
  return type !== undefined && TYPED_OUT_NODE_TYPES.has(type) ? 'out' : fallback
}

/** Result payload for upsertOutputNode — the produced text and/or media. */
export interface OutputResult {
  kind: 'text' | 'media'
  text?: string
  artifacts?: Artifact[]
  sourceLabel?: string
  /** Estimated USD cost of the run that produced this card (frozen per-card so
   *  fan-out siblings each show their own figure). null/undefined → no chip. */
  estUsd?: number | null
  /** WHY that number is what it is — frozen alongside it so the chip can say
   *  "local" only when it really was local (2026-08-01). */
  estBasis?: RunCostBasis | null
}

/** FAN-OUT xN: which sibling this run is (0-based index of `count` total). */
export interface OutputVariant {
  index: number
  count: number
}

let _nodeSeq = 0
function nextNodeId(): string {
  return `node-${Date.now()}-${++_nodeSeq}`
}

let _edgeSeq = 0
function nextEdgeId(): string {
  return `edge-${Date.now()}-${++_edgeSeq}`
}

/** Remove React Flow's `hidden` flag, keeping the object identity when it is
 *  already absent. Used by expandSubflow so an expand restores the exact
 *  pre-collapse shape (a node that never had `hidden` gets no leftover key). */
function stripHidden<T extends { hidden?: boolean }>(el: T): T {
  if (!('hidden' in el) || el.hidden === undefined) return el
  const { hidden: _drop, ...rest } = el
  return rest as T
}

// ── Throttled persistence ─────────────────────────────────────────────────────
// zustand's persist middleware runs its storage write inside EVERY set() call.
// onNodesChange fires per mousemove tick while dragging (60-120Hz), and with
// createJSONStorage that meant JSON.stringify of the WHOLE graph (multi-MB when
// an imageref node carries a base64 image) + a synchronous localStorage write
// per tick — measured at 147 writes / 18ms stringify each for one drag, the
// single biggest canvas-lag source. This storage coalesces writes: setItem only
// stashes the (immutable) snapshot; one trailing flush per THROTTLE_MS does the
// actual stringify+write, and pagehide/beforeunload flush keeps the last edit.
const PERSIST_THROTTLE_MS = 500

type PersistedSlice = { flowName: string; nodes: TachiNode[]; edges: TachiEdge[] }

// ── THE QUOTA FAILURE WAS SILENT (audit 3D-4) ────────────────────────────────
// flush()'s catch below has always existed to keep the app alive on a
// QuotaExceededError (a huge graph, an artifact that dodged partialize's
// strip), but the ONLY symptom was a console.warn — nothing the user is ever
// looking at. "The graph would just quietly stop persisting" (see the
// partialize comment further down) had no visible half. These two callbacks
// are wired to the store's own persistFailed flag once useNodesStore exists
// below (assigned, not called, from inside this module-scope closure — flush
// only ever RUNS later, via the throttle timer or a pagehide/beforeunload
// listener, by which time the `const useNodesStore = …` statement has long
// since completed) so RepairBanner can surface it instead of only main's log.
// GUARDED, not called bare (review while wiring this up): zustand's persist
// wrapper calls storage.setItem() on EVERY set(), even a value-preserving
// no-op (api.setState always does `set.apply(...); void setItem()`,
// unconditionally — see zustand/middleware.js). flush() runs INSIDE the
// storage adapter, so an unguarded `useNodesStore.getState().clearPersistFailed()`
// here would re-enter setItem() on every single successful flush (not just a
// real recovery), rescheduling ANOTHER timer before this one even returns —
// a flush that perpetually re-triggers itself, forever, on an idle canvas.
// Checking the flag first means `set()` — and the reentrant setItem() it
// causes — only fires on the rare transition (failure onset / actual
// recovery), not on every routine write.
let notifyPersistFailed: () => void = () => {}
let notifyPersistRecovered: () => void = () => {}

function throttledJSONStorage(): PersistStorage<PersistedSlice> {
  let pendingName = ''
  let pending: StorageValue<PersistedSlice> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    if (timer != null) { clearTimeout(timer); timer = null }
    if (!pending) return
    try {
      localStorage.setItem(pendingName, JSON.stringify(pending))
      // A later, SMALLER write can succeed after an earlier QuotaExceeded (the
      // user deleted a node, an artifact aged out) — clear the latch so the
      // banner disappears the moment saving actually resumes, rather than
      // nagging for the rest of the session over one bad tick.
      notifyPersistRecovered()
    } catch (e) {
      // QuotaExceeded (huge graphs) — keep the app alive; the in-memory state
      // is intact and the next smaller flush may succeed. Latch the failure so
      // RepairBanner can say so — a silent console.warn is not a symptom
      // anyone editing a flow will ever see.
      console.warn('[nodes.store] persist write failed:', e)
      notifyPersistFailed()
    }
    pending = null
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
  }
  return {
    getItem: (name) => {
      const raw = localStorage.getItem(name)
      return raw ? (JSON.parse(raw) as StorageValue<PersistedSlice>) : null
    },
    setItem: (name, value) => {
      pendingName = name
      pending = value
      if (timer == null) timer = setTimeout(flush, PERSIST_THROTTLE_MS)
    },
    removeItem: (name) => {
      pending = null
      if (timer != null) { clearTimeout(timer); timer = null }
      localStorage.removeItem(name)
    },
  }
}

// ── Undo/redo (STEAL 2026-06-21 #3, excalidraw history.ts) ─────────────────────
// Full-graph snapshot stack (fine for the canvas's node counts; excalidraw uses
// element-level deltas, overkill here). History is captured on DISCRETE ops and
// keyboard `remove` changes — never on continuous drag/select ticks. Bounded so
// long editing sessions can't leak memory. Session-only (not persisted).
const MAX_HISTORY = 50

export interface HistorySnapshot {
  nodes: TachiNode[]
  edges: TachiEdge[]
  /** Present when the snapshot's flow name matters (e.g. before a full clear). */
  flowName?: string
}

/** Returns the history-field update that pushes the CURRENT graph as a new undo
 *  checkpoint and clears the redo stack. Spread into a mutating set() return. */
function captureHistory(s: { nodes: TachiNode[]; edges: TachiEdge[]; undoStack: HistorySnapshot[]; flowName?: string }): { undoStack: HistorySnapshot[]; redoStack: HistorySnapshot[] } {
  return {
    undoStack: [...s.undoStack, { nodes: s.nodes, edges: s.edges, flowName: s.flowName }].slice(-MAX_HISTORY),
    redoStack: [],
  }
}

interface NodesStore {
  // ── Canvas state ─────────────────────────────────────────────────────────
  flowName: string
  nodes: TachiNode[]
  edges: TachiEdge[]

  // ── Undo/redo history (session-only; never persisted) ──────────────────────
  undoStack: HistorySnapshot[]
  redoStack: HistorySnapshot[]

  /**
   * Latched true the moment a persist write throws (QuotaExceeded, most
   * commonly a graph too large for localStorage). Session-only — never
   * persisted (partialize below does not carry it) — so a fresh load always
   * starts clean and only a WRITE that actually fails during this session sets
   * it. RepairBanner surfaces it so "the canvas stopped saving" has a visible
   * symptom instead of only a console.warn (audit 3D-4).
   */
  persistFailed: boolean
  /** Latch the failure flag. Called from the storage adapter's flush(), not by
   *  UI code — exposed on the store only so that seam can reach `set()`. */
  latchPersistFailed(): void
  /** Clear the flag once a later flush actually succeeds. */
  clearPersistFailed(): void

  // ── Mutators ─────────────────────────────────────────────────────────────
  setFlowName(name: string): void
  /** Called by ReactFlow's onNodesChange — accepts the base NodeChange type. */
  onNodesChange(changes: NodeChange[]): void
  /** Called by ReactFlow's onEdgesChange — accepts the base EdgeChange type. */
  onEdgesChange(changes: EdgeChange[]): void
  onConnect(connection: Connection): void

  addNode(partial: Omit<TachiNode, 'id' | 'position'> & { position?: { x: number; y: number } }): void

  /**
   * Quick-add: create a new node positioned just below `sourceId` and auto-wire
   * an edge FROM the source node TO the new node. Handles are picked via the
   * same nearest-pair routing used by onConnect so the edge renders cleanly.
   * Powers the Twenty-style hover "+" affordance on canvas nodes.
   */
  addConnectedNode(
    sourceId: string,
    partial: Omit<TachiNode, 'id' | 'position'> & { position?: { x: number; y: number } },
  ): void

  /**
   * Drop a result card for a source node after it runs (flowith-style canvas).
   *   - A RUN on the source → APPENDS a new card (2nd/3rd run keep the old ones).
   *   - `targetOutputId` set (the ↻ Regenerate button ON a card) → UPDATES that
   *     specific card in place instead of spawning a new one.
   *   - `variant` set (FAN-OUT xN, N>1) → keys the card on (source, variant
   *     index) via fanoutVariantKey: the sibling card is placed in a row beside
   *     the source (fanoutPositions) and REFRESHED in place on a repeat fan-out
   *     instead of duplicated. Variant cards are excluded from the plain-append
   *     cascade so a later x1 run never touches them.
   * Cards are wired from the source and can be branched onward.
   */
  upsertOutputNode(sourceId: string, result: OutputResult, targetOutputId?: string, variant?: OutputVariant): void

  /** Merge partial data into a single node's data field. Used by inline
   *  in-node editors (e.g. provider model picker). */
  updateNodeData(id: string, partial: Record<string, unknown>): void

  /**
   * NODES-RESEARCH #7 (parenting groups): translate the given nodes by (dx, dy)
   * WITHOUT recording history — the caller (a note drag) already checkpointed on
   * drag-start, so the members riding along collapse into that same undo step.
   * Uses a functional set so it never clobbers the note's own position update
   * that React Flow applies through onNodesChange in the same drag tick.
   */
  moveNodesBy(ids: Iterable<string>, dx: number, dy: number): void
  /** NODES-RESEARCH #1: pin a node's cached output — Run-all reuses it instead
   *  of re-running (and re-paying for) the node; per-node RUN still refreshes. */
  toggleNodePinned(id: string): void

  /** Clear ReactFlow selection on every node (used to close the config panel
   *  via ESC / panel Close button — clicking the canvas pane already clears it). */
  clearSelection(): void

  /** Remove a node and any edges connected to it. */
  deleteNode(id: string): void

  /** Remove a single edge by id. */
  deleteEdge(id: string): void

  /** Update the prose label (instruction) on an edge. */
  setEdgeInstruction(id: string, text: string): void

  setNodes(nodes: TachiNode[]): void
  setEdges(edges: TachiEdge[]): void
  clearCanvas(): void

  /**
   * Clone the given nodes (by id) at a small offset — copy/paste & duplicate.
   * Edges whose BOTH endpoints are duplicated are cloned too (re-pointed to the
   * copies); edges to outside nodes are dropped. The copies become the selection
   * (originals deselected). Undoable.
   */
  duplicateNodes(ids: string[], offset?: { dx: number; dy: number }): void

  /**
   * NODES-RESEARCH #8 (subflows v1, VISUAL COLLAPSE ONLY — no edge re-wiring).
   * Collapse the given nodes into one 'subflow' proxy placed at the selection
   * centroid. Children (and every edge touching a child) get React Flow's
   * `hidden: true` so the group reads as one box; the edges are NOT removed, so
   * Run-all still executes the hidden children through them. Undoable. A no-op
   * when fewer than 2 of the ids resolve to real, non-subflow nodes.
   */
  collapseSelectionToSubflow(ids: string[]): void
  /**
   * Inverse of collapse: un-hide the subflow's children and their edges, then
   * delete the proxy — restoring the exact pre-collapse state. Undoable. A no-op
   * when `id` is not a subflow node.
   */
  expandSubflow(id: string): void

  /**
   * NODES-RESEARCH STEAL (flowith MERGE): create ONE new 'agent' node below the
   * centroid of the selected RUNNABLE-or-output nodes and wire an edge FROM each
   * of them into it, so the child receives every parent's `lastOutput` through
   * the existing upstream-input collection (graph.ipc outputsFromFlow). The child
   * is labeled "Merge" and carries a synthesize system prompt (both passed in so
   * the store stays i18n-free). Non-source selections (note/subflow/unknown and
   * config/static tiles) are excluded from the wiring + centroid math. The new
   * child becomes the selection. Undoable. A no-op when fewer than 2 eligible
   * sources resolve from `ids`.
   */
  mergeSelectionToFollowUp(ids: string[], opts?: { label?: string; systemPrompt?: string }): void

  /** Replace the entire flow (from load). */
  loadFlow(name: string, nodes: TachiNode[], edges: TachiEdge[]): void

  /** Capture the current graph as an undo checkpoint (canvas calls this on
   *  node drag-start so a whole drag is one undo step). */
  pushHistory(): void
  /** Restore the previous graph snapshot. No-op when there's nothing to undo. */
  undo(): void
  /** Re-apply the most recently undone snapshot. No-op when redo is empty. */
  redo(): void
}

export const useNodesStore = create<NodesStore>()(
  persist(
    (set) => ({
      flowName: 'Untitled flow',
      nodes: [],
      edges: [],
      undoStack: [],
      redoStack: [],
      persistFailed: false,

      latchPersistFailed() {
        set(s => (s.persistFailed ? {} : { persistFailed: true }))
      },
      clearPersistFailed() {
        set(s => (s.persistFailed ? { persistFailed: false } : {}))
      },

      setFlowName(name) {
        // Allow empty string during editing — the UI applies the
        // 'Untitled flow' fallback only on blur / save (not on every keystroke).
        set({ flowName: name })
      },

      onNodesChange(changes) {
        // Capture history ONLY for keyboard deletes (type 'remove'); position/
        // dimension/select ticks fire continuously and must not flood the stack
        // (a drag's pre-state is captured once via pushHistory() on drag-start).
        const hasRemove = changes.some(c => c.type === 'remove')
        set(s => ({
          ...(hasRemove ? captureHistory(s) : {}),
          // applyNodeChanges returns Node[] — cast back to our union type since
          // we know the nodes were TachiNodes to begin with.
          nodes: applyNodeChanges(changes, s.nodes as Node[]) as TachiNode[],
        }))
      },

      onEdgesChange(changes) {
        const hasRemove = changes.some(c => c.type === 'remove')
        set(s => ({
          ...(hasRemove ? captureHistory(s) : {}),
          edges: applyEdgeChanges(changes, s.edges) as TachiEdge[],
        }))
      },

      onConnect(connection) {
        set(s => {
          // A4 — auto-routing: when the user drags between two 8-handle nodes we
          // ignore whichever of the 8 handles they grabbed and replace it with
          // the geometrically-closest source/target pair.
          //
          // BUT: some nodes use TYPED, NAMED plugs instead of the 8 spot handles
          // (the media node exposes target plugs `prompt`/`folder` + source `out`).
          // For those, nearestHandlePair would invent a spot id (e.g. `W-tgt`) the
          // node doesn't render → React Flow "couldn't create edge for handle id"
          // and the connection silently fails. So we only auto-route the 8-handle
          // endpoints, and preserve/coerce the named plug on a typed endpoint.
          const src = s.nodes.find(n => n.id === connection.source)
          const tgt = s.nodes.find(n => n.id === connection.target)

          // Nodes with typed plugs (named handle ids), keyed by type → valid ids.
          // The media `image` plug only renders for image/video modalities (see
          // MediaNode), so routing to it is gated on the target's modality below.
          // The rife node has exactly one of each: a `video` plug that takes the
          // clip and an `out` that hands the interpolated one onward. Listing it
          // here is what makes a loose drop land on `video` instead of a spot id
          // the card does not render.
          const TYPED_TARGETS: Record<string, string[]> = { media: ['prompt', 'folder', 'image'], rife: ['video'] }
          const TYPED_SOURCES: Record<string, string[]> = { media: ['out'], rife: ['out'] }
          const srcTyped = src ? TYPED_SOURCES[src.type] : undefined
          const tgtTyped = tgt ? TYPED_TARGETS[tgt.type] : undefined

          let sourceHandle: string | null = connection.sourceHandle ?? null
          let targetHandle: string | null = connection.targetHandle ?? null

          // 8-handle auto-route is only valid between non-typed nodes.
          if (src && tgt && !srcTyped && !tgtTyped) {
            const srcRect = { x: src.position.x, y: src.position.y,
                              w: (src as { width?: number }).width  ?? APPROX_NODE_RECT.w,
                              h: (src as { height?: number }).height ?? APPROX_NODE_RECT.h }
            const tgtRect = { x: tgt.position.x, y: tgt.position.y,
                              w: (tgt as { width?: number }).width  ?? APPROX_NODE_RECT.w,
                              h: (tgt as { height?: number }).height ?? APPROX_NODE_RECT.h }
            const pair = nearestHandlePair(srcRect, tgtRect)
            sourceHandle = pair.sourceHandle
            targetHandle = pair.targetHandle
          } else {
            // Mixed/typed connection: if one side is an 8-handle node we still want
            // a valid spot on it; pick the nearest pair and keep only that side.
            if (src && tgt && (srcTyped || tgtTyped)) {
              const srcRect = { x: src.position.x, y: src.position.y,
                                w: (src as { width?: number }).width  ?? APPROX_NODE_RECT.w,
                                h: (src as { height?: number }).height ?? APPROX_NODE_RECT.h }
              const tgtRect = { x: tgt.position.x, y: tgt.position.y,
                                w: (tgt as { width?: number }).width  ?? APPROX_NODE_RECT.w,
                                h: (tgt as { height?: number }).height ?? APPROX_NODE_RECT.h }
              const pair = nearestHandlePair(srcRect, tgtRect)
              if (!srcTyped) sourceHandle = pair.sourceHandle
              if (!tgtTyped) targetHandle = pair.targetHandle
            }
            // Coerce a typed endpoint to one of its named plugs. For a MEDIA
            // target, route by the SOURCE node type so the right plug is chosen
            // even on a loose drop (the user rarely hits the exact handle):
            //   Folder          → `folder`   (auto-save dir)
            //   Reference-Image → `image`    (init frame / style ref; image+video only)
            //   anything else   → `prompt`   (agent / Text / prompt chain)
            // Other typed targets keep the explicit-plug-or-primary behaviour.
            if (tgtTyped) {
              if (tgt?.type === 'media' && src) {
                const m = (tgt.data as { modality?: string }).modality
                const acceptsImage = m === 'image' || m === 'video'
                // An Output card holding a generated IMAGE feeds the `image` plug
                // too (branch a result into the next gen as a reference), not the
                // text prompt. Text outputs still go to `prompt`.
                const sd = src.data as { kind?: string; artifacts?: Array<{ kind?: string }> }
                const isImageOutput = src.type === 'output' && sd.kind === 'media'
                  && Array.isArray(sd.artifacts) && sd.artifacts.some(a => a.kind === 'image')
                targetHandle =
                  src.type === 'folder'                                           ? 'folder'
                  : ((src.type === 'imageref' || isImageOutput) && acceptsImage)  ? 'image'
                  : 'prompt'
              } else {
                targetHandle = tgtTyped.includes(connection.targetHandle ?? '') ? connection.targetHandle! : tgtTyped[0]
              }
            }
            if (srcTyped) sourceHandle = srcTyped.includes(connection.sourceHandle ?? '') ? connection.sourceHandle! : srcTyped[0]
          }

          // NODES-RESEARCH #6: the ERROR output handle ('err') is a fixed,
          // meaningful id — never let the geometric auto-router (or the typed-
          // plug coercion above) rewrite it, or the edge stops being an
          // error-edge. Only the source side is pinned; the target still routes.
          if (connection.sourceHandle === ERR_HANDLE_ID) sourceHandle = ERR_HANDLE_ID

          const nextConn = { ...connection, sourceHandle, targetHandle }
          return {
            ...captureHistory(s),
            edges: addEdge(nextConn, s.edges) as TachiEdge[],
          }
        })
      },

      addNode(partial) {
        const id = nextNodeId()
        const base = {
          ...partial,
          id,
          position: partial.position ?? { x: 300, y: 200 },
        }
        // NODES-RESEARCH #7 (sticky notes): a note sits BEHIND other nodes
        // (zIndex -1, so it reads as a background label) and starts at a default
        // sticky size — unless the caller already specified those (a loaded /
        // duplicated note keeps its own zIndex + width/height, since `base`
        // wins over the defaults when it carries them).
        const node = (
          partial.type === 'note'
            ? { zIndex: -1, width: 220, height: 150, ...base }
            : base
        ) as TachiNode
        set(s => ({ ...captureHistory(s), nodes: [...s.nodes, node] }))
      },

      addConnectedNode(sourceId, partial) {
        set(s => {
          const src = s.nodes.find(n => n.id === sourceId)
          // Position the new node just below the source. Fall back to a sane
          // default if the source somehow can't be located.
          const srcW = (src as { width?: number } | undefined)?.width  ?? APPROX_NODE_RECT.w
          const srcH = (src as { height?: number } | undefined)?.height ?? APPROX_NODE_RECT.h
          const basePos = src
            ? { x: src.position.x, y: src.position.y + srcH + 60 }
            : { x: 300, y: 280 }

          const id = nextNodeId()
          const node = {
            ...partial,
            id,
            position: partial.position ?? basePos,
          } as TachiNode

          // Auto-route the connecting edge: pick the geometrically-closest
          // source/target spot pair (matches onConnect's 8-handle logic).
          const srcRect = src
            ? { x: src.position.x, y: src.position.y, w: srcW, h: srcH }
            : { x: basePos.x, y: basePos.y - srcH - 60, w: srcW, h: srcH }
          const tgtRect = {
            x: node.position.x, y: node.position.y,
            w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h,
          }
          const pair = nearestHandlePair(srcRect, tgtRect)

          const edge = {
            id: nextEdgeId(),
            type: 'link',
            source: sourceId,
            target: id,
            sourceHandle: pair.sourceHandle,
            targetHandle: pair.targetHandle,
          } as TachiEdge

          return {
            ...captureHistory(s),
            nodes: [...s.nodes, node],
            edges: src ? [...s.edges, edge] : s.edges,
          }
        })
      },

      upsertOutputNode(sourceId, result, targetOutputId, variant) {
        set(s => {
          const src = s.nodes.find(n => n.id === sourceId)
          if (!src) return {}
          const lastOutput = typeof result.text === 'string' && result.text
            ? result.text
            : (result.kind === 'media' ? '[media result]' : '')
          const nextData = {
            label:       result.sourceLabel ? `${result.sourceLabel} output` : 'Output',
            auto:        true,
            kind:        result.kind,
            sourceId,
            ...(result.text != null ? { text: result.text } : { text: undefined }),
            ...(result.artifacts ? { artifacts: result.artifacts } : { artifacts: undefined }),
            ...(result.sourceLabel ? { sourceLabel: result.sourceLabel } : {}),
            // Frozen per-card cost estimate + its basis (fan-out siblings each
            // keep their own). Both are cleared together so a re-run can never
            // pair a stale number with a fresh basis, or vice versa.
            ...(typeof result.estUsd === 'number' ? { estUsd: result.estUsd } : { estUsd: undefined }),
            ...(result.estBasis ? { estBasis: result.estBasis } : { estBasis: undefined }),
            lastOutput,
          }

          const srcW = (src as { width?: number }).width  ?? APPROX_NODE_RECT.w
          const srcH = (src as { height?: number }).height ?? APPROX_NODE_RECT.h

          // ↻ REGENERATE on a card → update THAT card in place (it re-generates
          // an already-produced result; keep its position + wiring).
          if (targetOutputId && s.nodes.some(n => n.id === targetOutputId && n.type === 'output')) {
            return {
              nodes: s.nodes.map(n =>
                n.id === targetOutputId ? ({ ...n, data: { ...n.data, ...nextData } } as TachiNode) : n,
              ),
            }
          }

          // FAN-OUT xN sibling → key the card on (source, variant index). A
          // repeat fan-out refreshes the SAME card (kept in its row slot);
          // otherwise spawn it at its fan-out position, wired from the source.
          if (variant) {
            const key = fanoutVariantKey(sourceId, variant.index)
            const variantData = { ...nextData, variantKey: key, variant: variant.index + 1 }
            const existing = s.nodes.find(
              n => n.type === 'output' && (n.data as { variantKey?: unknown }).variantKey === key,
            )
            if (existing) {
              return {
                nodes: s.nodes.map(n =>
                  n.id === existing.id ? ({ ...n, data: { ...n.data, ...variantData } } as TachiNode) : n,
                ),
              }
            }
            const positions = fanoutPositions(src.position, variant.count, { srcWidth: srcW })
            const pos = positions[variant.index]
              ?? positions[positions.length - 1]
              ?? { x: src.position.x + srcW + 90, y: src.position.y }
            const id = nextNodeId()
            const node = { id, type: 'output', position: pos, data: variantData } as TachiNode
            const srcRect = { x: src.position.x, y: src.position.y, w: srcW, h: srcH }
            const tgtRect = { x: pos.x, y: pos.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
            const pair = nearestHandlePair(srcRect, tgtRect)
            const sourceHandle = sourceHandleFor(src.type, pair.sourceHandle)
            const edge = {
              id: nextEdgeId(), type: 'link', source: sourceId, target: id,
              sourceHandle, targetHandle: pair.targetHandle,
            } as TachiEdge
            return { nodes: [...s.nodes, node], edges: [...s.edges, edge] }
          }

          // A RUN on the source node → append a NEW result card each time (2nd,
          // 3rd run keep the OLD ones — a history of variations). Cascade down so
          // a new card doesn't cover the previous one. Fan-out siblings (they
          // carry a variantKey) are NOT counted, so an x1 run keeps its natural
          // slot regardless of how many variants sit beside the source.
          const priorCount = s.edges.filter(e => {
            if (e.source !== sourceId) return false
            const t = s.nodes.find(n => n.id === e.target)
            return t?.type === 'output' && (t.data as { variantKey?: unknown }).variantKey == null
          }).length

          const pos = { x: src.position.x + srcW + 90, y: src.position.y + priorCount * 240 }
          const id = nextNodeId()
          const node = { id, type: 'output', position: pos, data: nextData } as TachiNode

          const srcRect = { x: src.position.x, y: src.position.y, w: srcW, h: srcH }
          const tgtRect = { x: pos.x, y: pos.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
          const pair = nearestHandlePair(srcRect, tgtRect)
          // A media source feeds from its typed `out` plug; everything else from
          // the geometrically-closest 8-handle spot.
          const sourceHandle = sourceHandleFor(src.type, pair.sourceHandle)
          const edge = {
            id: nextEdgeId(), type: 'link', source: sourceId, target: id,
            sourceHandle, targetHandle: pair.targetHandle,
          } as TachiEdge

          return { nodes: [...s.nodes, node], edges: [...s.edges, edge] }
        })
      },

      toggleNodePinned(id) {
        set(s => ({
          nodes: s.nodes.map(n =>
            n.id === id ? ({ ...n, data: { ...n.data, pinned: !(n.data as { pinned?: boolean }).pinned } } as TachiNode) : n),
        }))
      },

      updateNodeData(id, partial) {
        set(s => ({
          nodes: s.nodes.map(n =>
            n.id === id
              ? ({ ...n, data: { ...n.data, ...partial } } as TachiNode)
              : n,
          ),
        }))
      },

      moveNodesBy(ids, dx, dy) {
        if (dx === 0 && dy === 0) return
        const idSet = ids instanceof Set ? ids : new Set(ids)
        if (idSet.size === 0) return
        // moveByDelta preserves object identity for untouched nodes and returns
        // the SAME array when nothing changed — so this set is a no-op-safe,
        // history-free position translate (see the interface doc).
        set(s => ({ nodes: moveByDelta(s.nodes, idSet, dx, dy) }))
      },

      clearSelection() {
        set(s => {
          if (!s.nodes.some(n => n.selected)) return s
          return { nodes: s.nodes.map(n => (n.selected ? { ...n, selected: false } : n)) as TachiNode[] }
        })
      },

      deleteNode(id) {
        set(s => ({
          ...captureHistory(s),
          nodes: s.nodes.filter(n => n.id !== id),
          // Also drop any edges touching the removed node.
          edges: s.edges.filter(e => e.source !== id && e.target !== id),
        }))
      },

      deleteEdge(id) {
        set(s => ({ ...captureHistory(s), edges: s.edges.filter(e => e.id !== id) }))
      },

      setEdgeInstruction(id, text) {
        set(s => ({
          edges: s.edges.map(e =>
            e.id === id
              ? ({ ...e, data: { ...e.data, instruction: text } } as TachiEdge)
              : e,
          ),
        }))
      },

      setNodes(nodes) { set({ nodes }) },
      setEdges(edges) { set({ edges }) },

      clearCanvas() {
        // Undoable — clearing the whole canvas is the easiest thing to do by
        // accident. loadFlow (switching flows) deliberately resets history below.
        set(s => ({ ...captureHistory(s), nodes: [], edges: [], flowName: 'Untitled flow' }))
      },

      loadFlow(name, nodes, edges) {
        // Loading a different flow is a context switch, not an edit — start its
        // history fresh so undo can't cross-contaminate between saved flows.
        set({ flowName: name, nodes, edges, undoStack: [], redoStack: [] })
      },

      // NODES-RESEARCH #8 — SUBFLOWS v1 (VISUAL COLLAPSE ONLY, no edge re-wiring).
      collapseSelectionToSubflow(ids) {
        set(s => {
          const idSet = new Set(ids)
          // Only fold in real, non-proxy nodes (collapsing a subflow proxy is a
          // no-op that would nest emptily). Need at least 2 to form a group.
          const children = s.nodes.filter(n => idSet.has(n.id) && n.type !== 'subflow')
          if (children.length < 2) return {}
          const childIds = children.map(n => n.id)
          const childSet = new Set(childIds)

          // Proxy lands at the centroid of the collapsed nodes.
          const cx = children.reduce((a, n) => a + n.position.x, 0) / children.length
          const cy = children.reduce((a, n) => a + n.position.y, 0) / children.length
          const proxy = {
            id: nextNodeId(),
            type: 'subflow',
            position: { x: Math.round(cx), y: Math.round(cy) },
            selected: true,
            data: { label: 'Subflow', childIds },
          } as TachiNode

          // Hide the children (clearing selection only where it was set, so an
          // expand restores the exact pre-collapse shape) and every edge that
          // touches a child. Edges are HIDDEN, never removed — Run-all still
          // walks them so the collapsed nodes execute normally.
          const nodes = s.nodes.map(n => {
            if (childSet.has(n.id)) {
              const base = n.selected ? { ...n, selected: false } : n
              return { ...base, hidden: true } as TachiNode
            }
            return n.selected ? ({ ...n, selected: false } as TachiNode) : n
          })
          const edges = s.edges.map(e =>
            childSet.has(e.source) || childSet.has(e.target)
              ? ({ ...e, hidden: true } as TachiEdge)
              : e,
          )
          return { ...captureHistory(s), nodes: [...nodes, proxy], edges }
        })
      },

      expandSubflow(id) {
        set(s => {
          const proxy = s.nodes.find(n => n.id === id && n.type === 'subflow')
          if (!proxy) return {}
          const raw = (proxy.data as { childIds?: unknown }).childIds
          const childSet = new Set(
            Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [],
          )
          const nodes = s.nodes
            .filter(n => n.id !== id)
            .map(n => (childSet.has(n.id) ? stripHidden(n) : n))
          const edges = s.edges.map(e =>
            childSet.has(e.source) || childSet.has(e.target) ? stripHidden(e) : e,
          )
          return { ...captureHistory(s), nodes, edges }
        })
      },

      // NODES-RESEARCH STEAL — flowith MERGE gesture (select N → one child with N
      // parents). Pure plan (centroid + eligibility) in mergeSelection.ts.
      mergeSelectionToFollowUp(ids, opts) {
        set(s => {
          const idSet = new Set(ids)
          // Keep the flow's node order for the eligible sources so the child's
          // wiring order matches outputsFromFlow's concatenation order (which
          // walks flow.nodes in array order).
          const selected = s.nodes.filter(n => idSet.has(n.id))
          const plan = mergeSelectionPlan(selected)
          if (!plan) return {}

          const mergeId = nextNodeId()
          const node = {
            id: mergeId,
            type: 'agent',
            position: plan.position,
            selected: true,
            data: {
              label:        opts?.label ?? 'Merge',
              harnessId:    'openclaude',
              systemPrompt: opts?.systemPrompt ?? 'Synthesize the upstream results into one answer.',
            },
          } as TachiNode

          // Wire an edge FROM each source INTO the merge node. Auto-route each to
          // the geometrically-closest 8-handle pair (matches onConnect); a media
          // source feeds from its typed `out` plug (mirrors upsertOutputNode).
          const tgtRect = { x: plan.position.x, y: plan.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
          const newEdges = plan.sourceIds.map(srcId => {
            const src = s.nodes.find(n => n.id === srcId)!
            const srcW = (src as { width?: number }).width  ?? APPROX_NODE_RECT.w
            const srcH = (src as { height?: number }).height ?? APPROX_NODE_RECT.h
            const srcRect = { x: src.position.x, y: src.position.y, w: srcW, h: srcH }
            const pair = nearestHandlePair(srcRect, tgtRect)
            const sourceHandle = sourceHandleFor(src.type, pair.sourceHandle)
            return {
              id: nextEdgeId(), type: 'link', source: srcId, target: mergeId,
              sourceHandle, targetHandle: pair.targetHandle,
            } as TachiEdge
          })

          // The new child becomes the selection (sources deselected) — same UX
          // as duplicate / collapse.
          const deselected = s.nodes.map(n => (n.selected ? { ...n, selected: false } : n)) as TachiNode[]
          return {
            ...captureHistory(s),
            nodes: [...deselected, node],
            edges: [...s.edges, ...newEdges],
          }
        })
      },

      duplicateNodes(ids, offset) {
        const dx = offset?.dx ?? 40
        const dy = offset?.dy ?? 40
        set(s => {
          const idSet = new Set(ids)
          const idMap = new Map<string, string>()
          const copies: TachiNode[] = []
          for (const n of s.nodes) {
            if (!idSet.has(n.id)) continue
            const nid = nextNodeId()
            idMap.set(n.id, nid)
            copies.push({ ...n, id: nid, position: { x: n.position.x + dx, y: n.position.y + dy }, selected: true } as TachiNode)
          }
          if (copies.length === 0) return {}
          // Clone only edges whose BOTH endpoints were duplicated (re-pointed to
          // the copies); edges to nodes outside the selection are dropped.
          const clonedEdges = s.edges
            .filter(e => idMap.has(e.source) && idMap.has(e.target))
            .map(e => ({ ...e, id: nextEdgeId(), source: idMap.get(e.source)!, target: idMap.get(e.target)! }) as TachiEdge)
          const deselected = s.nodes.map(n => (n.selected ? { ...n, selected: false } : n)) as TachiNode[]
          return {
            ...captureHistory(s),
            nodes: [...deselected, ...copies],
            edges: [...s.edges, ...clonedEdges],
          }
        })
      },

      pushHistory() {
        set(s => captureHistory(s))
      },

      undo() {
        set(s => {
          if (s.undoStack.length === 0) return {}
          const prev = s.undoStack[s.undoStack.length - 1]!
          return {
            undoStack: s.undoStack.slice(0, -1),
            redoStack: [...s.redoStack, { nodes: s.nodes, edges: s.edges, flowName: s.flowName }].slice(-MAX_HISTORY),
            nodes: prev.nodes,
            edges: prev.edges,
            // Undoing a CLEAR must bring the flow's name back too.
            ...(prev.flowName !== undefined ? { flowName: prev.flowName } : {}),
          }
        })
      },

      redo() {
        set(s => {
          if (s.redoStack.length === 0) return {}
          const next = s.redoStack[s.redoStack.length - 1]!
          return {
            redoStack: s.redoStack.slice(0, -1),
            undoStack: [...s.undoStack, { nodes: s.nodes, edges: s.edges, flowName: s.flowName }].slice(-MAX_HISTORY),
            nodes: next.nodes,
            edges: next.edges,
            ...(next.flowName !== undefined ? { flowName: next.flowName } : {}),
          }
        })
      },
    }),
    {
      name: 'tachi-nodes-v1',
      storage: throttledJSONStorage(),
      // The artifact bytes stop here too (review pass after 59c658a). 59c658a
      // took the clip out of the .tachi-flow.json FILE but this seam still wrote
      // `nodes` verbatim — so every canvas edit was base64-stringifying the whole
      // video into a ~5MB localStorage bucket, on the throttle above, and the
      // quota failure at `flush` is a console.warn: the graph would just quietly
      // stop persisting. media.store's partialize already stripped b64 for the
      // gallery; two persistence seams must not disagree about the same rule, so
      // both now run the ONE pass (serialization.stripNodesArtifactB64). The
      // pathless exception carries over: a b64-only artifact has nothing on disk
      // to reload from, so its bytes survive the reload.
      partialize: (s) => ({
        flowName: s.flowName,
        nodes:    stripNodesArtifactB64(s.nodes),
        edges:    s.edges,
      }),
      // App-storage load seam (NODES-RESEARCH #3): self-heal the persisted graph
      // the same way an imported file is healed — remap unknown node types (a
      // stale build no longer registers), drop dangling edges, default missing
      // ids/positions — so a stale localStorage graph never rehydrates broken.
      // THEN migrate persisted edges from earlier sessions: ensure each has the
      // 'link' type so the LinkEdge renders. Edges saved before B1.1 have either
      // undefined type or type='deletable' → upgrade both to 'link'.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const healed = sanitizeFlow({
          version: 1,
          name: state.flowName,
          nodes: Array.isArray(state.nodes) ? state.nodes : [],
          edges: Array.isArray(state.edges) ? state.edges : [],
          savedAt: '',
        })
        if (healed.nodes !== state.nodes) state.nodes = healed.nodes
        const migrated = healed.edges.map(e =>
          e.type === 'link' ? e : { ...e, type: 'link' },
        )
        if (migrated.length !== state.edges.length || migrated.some((e, i) => e !== state.edges[i])) {
          state.edges = migrated
        }
      },
    },
  ),
)

// Wire the storage adapter's flush() outcome to the store's own flag now that
// `useNodesStore` exists (throttledJSONStorage() ran BEFORE this line, as an
// argument to persist() above, but flush() itself only ever executes later —
// off the throttle timer or a pagehide/beforeunload listener — so by the time
// either callback actually runs, this assignment has long since completed).
notifyPersistFailed    = () => { if (!useNodesStore.getState().persistFailed) useNodesStore.getState().latchPersistFailed() }
notifyPersistRecovered = () => { if (useNodesStore.getState().persistFailed) useNodesStore.getState().clearPersistFailed() }
