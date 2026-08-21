// apps/desktop/src/pages/nodes/NodesPage.tsx
//
// Custom Nodes editor — visual canvas for wiring provider → agent → skill flows.
// Toolbar: New / Open / Save / Clear + flow-name input.
// Left sidebar: Node Palette.
// Center: pan/zoom ReactFlow canvas.

import React, { useRef, useCallback, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '../../components/ConfirmProvider'
import { SplitHandle } from '../../components/SplitHandle'
import { useResizablePanel } from '../../hooks/useResizablePanel'
import { useNavigate } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import { FlowCanvas }  from './canvas/FlowCanvas'
// The tachi-media:// URL builder for on-disk artifacts (see ArtifactRender).
import { fileUrl } from './canvas/NodeRunUI'
// The gallery entry's seed provenance — the same stamp MediaPage applies.
import { stampLocalSeed } from '../media/localGenParams'
import { SR_ONLY } from './a11y'
import { nearestHandlePair, APPROX_NODE_RECT } from './canvas/EightHandles'
import { NodePalette } from './sidebar/NodePalette'
import { FlowsRail } from './sidebar/FlowsRail'
import { useNodesStore } from './store/nodes.store'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { NodesHowTo } from './NodesHowTo'
import { NodeConfigPanel } from './NodeConfigPanel'
import { RepairBanner } from './RepairBanner'
import { runFlowDoctor } from './store/flow-doctor.store'
import { BlueprintImportDialog } from './BlueprintImportDialog'
import { buildCouncilGraph } from './councilGenerator'
import { STARTER_TEMPLATES, type StarterTemplate } from './starterTemplates'
import { saveFlowToApp, readFlowFile, FlowParseError, serializeFlow } from './serialization'
import { describeSaveFailure } from './flow-save'
import { estimateNodeRunCost, type RunCostBasis } from './run-cost'
import { useAgentStore, type HarnessId, type AgentProvider } from '../../store/agent.store'
import { useUIStore } from '../../store/ui.store'
import { useMediaStore } from '../../store/media.store'
import {
  useNodesRunStore,
  type NodesRunStatus,
  type NodesMediaResult,
  type GraphRunAgentResult as StoreGraphRunAgentResult,
} from '../../store/nodesRun.store'
import { useRunTraceStore } from '../../store/run-trace.store'
import type { TachiNode, TachiEdge, MediaNodeModality } from './types'
import type { Artifact } from '../../types/electron'
import { detectCycle } from './canvas/topo-order'
import { decideNodeRun, type UpstreamOutcome } from './canvas/errorBranch'
import { collectWriteConsentTargets, ensureCodexWriteConsent } from './canvas/codexWriteGate'
import { RUNNABLE_NODE_TYPES } from './run-eligibility'
import { mayAutoRun, onWebhookFired } from './webhookTrigger'
import { retryPolicy, runWithRetry } from './retryPolicy'

// Excalidraw whiteboard — lazy so the ~1MB excalidraw chunk (JS + CSS) only
// loads the first time the user toggles WHITEBOARD on, never on initial load.
const WhiteboardPanel = React.lazy(() => import('./WhiteboardPanel'))

// ── Run-flow result types (mirror graph.ipc.ts GraphRunResult) ────────────────
// The per-agent + media result shapes + the run STATUS now live in the global
// nodesRun store (so a run survives leaving the /nodes tab + shows an app-wide
// indicator). We alias them here to keep the rest of this file unchanged.
type GraphRunAgentResult = StoreGraphRunAgentResult
type MediaNodeResult = NodesMediaResult
type GraphRunResult =
  | { ok: true;  results: GraphRunAgentResult[]; final: string; media?: MediaNodeResult[] }
  | { ok: false; error: string }

// Result of a single per-node run (mirrors window.tachi.nodes.runNode). Named so
// the retry-on-fail loop in handleRunAll can carry it through runWithRetry.
type GraphNodeRunRes =
  | { ok: true; text?: string; artifacts?: Artifact[] }
  | { ok: false; error: string }

// ── Sequential "Run all" ordering ─────────────────────────────────────────────
// Which node types EXECUTE lives in a pure, unit-testable module now (the skip
// logic's single source of truth). Everything else — provider/folder/internet/
// mcp/skill/text/imageref/note — is config, a static source, or an annotation
// (a sticky NOTE): resolved by reference, never "run".

// Kahn topological order over the edge DAG so each node runs AFTER everything
// feeding it. Nodes left out by a cycle are appended in declaration order so we
// never silently drop one.
function topologicalNodeOrder(nodes: TachiNode[], edges: TachiEdge[]): string[] {
  const indeg = new Map<string, number>()
  const adj   = new Map<string, string[]>()
  for (const n of nodes) { indeg.set(n.id, 0); adj.set(n.id, []) }
  for (const e of edges) {
    if (!adj.has(e.source) || !indeg.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  }
  const queue: string[] = []
  for (const n of nodes) if ((indeg.get(n.id) ?? 0) === 0) queue.push(n.id)
  const order: string[] = []
  const seen = new Set<string>()
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id); order.push(id)
    for (const t of adj.get(id) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 1) - 1)
      if ((indeg.get(t) ?? 0) <= 0) queue.push(t)
    }
  }
  for (const n of nodes) if (!seen.has(n.id)) order.push(n.id)
  return order
}

// ── Toolbar button styles ─────────────────────────────────────────────────────

const btnBase: React.CSSProperties = {
  padding: '5px 12px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  flexShrink: 0,
}

const btnDanger: React.CSSProperties = {
  ...btnBase,
  border: '2px solid var(--danger)',
  color: 'var(--danger)',
}

const btnPrimary: React.CSSProperties = {
  ...btnBase,
  border: '2px solid var(--accent)',
  background: 'var(--accent)',
  color: '#ffffff',
  boxShadow: 'var(--shadow-hard)',
}

// ── NodesPage ─────────────────────────────────────────────────────────────────

export function NodesPage() {
  const { t } = useTranslation('nodes')
  const navigate    = useNavigate()
  const confirm     = useConfirm()
  const flowName    = useNodesStore(s => s.flowName)
  // PERF: never subscribe to the raw nodes/edges arrays here — they get a new
  // identity on EVERY drag tick, which re-rendered this whole 1700-line page at
  // mouse-move rate (a top canvas-lag source). The page only needs counts for
  // the toolbar; callbacks read fresh graphs via useNodesStore.getState().
  const nodeCount   = useNodesStore(s => s.nodes.length)
  const edgeCount   = useNodesStore(s => s.edges.length)
  const setFlowName = useNodesStore(s => s.setFlowName)
  const clearCanvas = useNodesStore(s => s.clearCanvas)
  const loadFlow    = useNodesStore(s => s.loadFlow)
  const setNodes    = useNodesStore(s => s.setNodes)
  const setEdges    = useNodesStore(s => s.setEdges)
  const clearSelection = useNodesStore(s => s.clearSelection)
  const updateNodeData = useNodesStore(s => s.updateNodeData)

  // The currently-selected node drives the slide-in config panel. ReactFlow
  // writes `node.selected` through applyNodeChanges (single-select by default).
  // Equality ignores position: dragging the selected node must not re-render
  // the page per tick — only id/data/type changes matter to the panel.
  const selectedNode = useStoreWithEqualityFn(
    useNodesStore,
    s => s.nodes.find(n => n.selected) ?? null,
    (a, b) => a?.id === b?.id && a?.data === b?.data && a?.type === b?.type,
  )

  // Interactive how-to walkthrough. Auto-opens on first ever visit to the
  // Nodes editor; afterwards available via the "How to build" toolbar button.
  const [howToOpen, setHowToOpen] = useState(false)
  useEffect(() => {
    try {
      if (!localStorage.getItem('tachi-nodes-howto-seen')) {
        setHowToOpen(true)
        localStorage.setItem('tachi-nodes-howto-seen', '1')
      }
    } catch { /* ignore storage errors */ }
  }, [])

  // Live execution: highlight whichever node is currently running. We toggle a
  // CSS class on the ReactFlow node element (it carries data-id=<nodeId>), so
  // the user watches the run move agent -> agent across the canvas.
  //
  // TWO HALVES NOW, and the split is the fix (review of the FLF fix lane,
  // finding 6). This was one effect that both subscribed to the stream AND
  // painted the DOM from inside the callback, with a cleanup that nulled
  // activeNodeId. But 'graph:node-active' is EDGE-triggered — it speaks only when
  // the run MOVES — so a tab switch away and back left the canvas with no
  // running node and no animated edges until the run reached the NEXT node,
  // which on a 44-minute i2v stage is the whole render. The store's own contract
  // says activeNodeId is null "when nothing is running", not "when nobody is
  // looking", so unmounting no longer touches it: the subscription MIRRORS, and
  // a second effect PAINTS from the mirrored value, which a remount re-reads.
  const activeNodeId = useNodesRunStore(s => s.activeNodeId)
  useEffect(() => {
    // EDGE RUN-INFO: mirror the active node into the run store so LinkEdge can
    // animate the running node's OUTGOING edges via a selector (session-only,
    // never persisted — the flow JSON is untouched). The end-of-run event carries
    // nodeId:'' / null and clears it, exactly as before.
    const off = window.tachi?.nodes?.onNodeActive?.(({ nodeId }) => {
      useNodesRunStore.getState().setActiveNodeId(nodeId || null)
    })
    return () => { off?.() }
  }, [])

  useEffect(() => {
    const clearAll = () => {
      document.querySelectorAll('.react-flow__node.tachi-node-running')
        .forEach(el => el.classList.remove('tachi-node-running'))
      document.querySelectorAll('.react-flow__edge.tachi-edge-running')
        .forEach(el => el.classList.remove('tachi-edge-running'))
    }
    const paint = () => {
      clearAll()
      if (!activeNodeId) return
      document.querySelector(`.react-flow__node[data-id="${activeNodeId}"]`)
        ?.classList.add('tachi-node-running')
      // Light up the wires feeding into the now-running node so the data flow
      // is visible as the run advances agent -> agent.
      for (const edge of useNodesStore.getState().edges) {
        if (edge.target === activeNodeId) {
          document.querySelector(`.react-flow__edge[data-id="${edge.id}"]`)
            ?.classList.add('tachi-edge-running')
        }
      }
    }
    paint()
    // …and once more on the next frame: on a REMOUNT this effect can run before
    // ReactFlow has put the node/edge elements back in the DOM, and a
    // querySelector that finds nothing would silently lose the highlight the
    // store just restored. Idempotent — a no-op when the first pass landed.
    const raf = requestAnimationFrame(paint)
    return () => { cancelAnimationFrame(raf); clearAll() }
  }, [activeNodeId])

  // One-time migration: legacy Reference-Image nodes stored the picked image
  // INLINE as a multi-MB base64 data URL, so every persist flush stringified
  // megabytes. Move any such image to disk (userData/media/refs) and keep only
  // its path — the run engine reads either shape (imageRefUrlsInto).
  useEffect(() => {
    const { nodes: allNodes, updateNodeData: update } = useNodesStore.getState()
    const legacy = allNodes.filter(n =>
      n.type === 'imageref'
      && typeof (n.data as { dataUrl?: unknown }).dataUrl === 'string'
      && ((n.data as { dataUrl: string }).dataUrl).startsWith('data:image/'),
    )
    if (legacy.length === 0) return
    void (async () => {
      for (const n of legacy) {
        const d = n.data as { dataUrl: string; fileName?: string }
        const saved = await window.tachi?.nodes?.saveRefImage?.(d.dataUrl, d.fileName).catch(() => null)
        // On failure the node keeps its inline copy — nothing is lost.
        if (saved?.ok) update(n.id, { filePath: saved.path, displayUrl: saved.url, dataUrl: undefined })
      }
    })()
  }, [])

  // Local editing state for the flow name input.
  // We keep a separate local value so the user can fully clear the field
  // without the store's persisted value jumping back in on every keystroke.
  // The store is only updated on blur; if the user leaves the field empty
  // we fall back to 'Untitled flow'.
  const [localFlowName, setLocalFlowName] = useState(flowName)

  // Sync local state when the store value changes externally (e.g. loadFlow).
  const prevFlowName = useRef(flowName)
  if (prevFlowName.current !== flowName) {
    prevFlowName.current = flowName
    setLocalFlowName(flowName)
  }

  // Hidden file input for the Open action
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Auto Layout — lazy-loads ELK on first click
  const [layouting, setLayouting] = useState(false)

  // ── Whiteboard (excalidraw) ─────────────────────────────────────────────
  // `whiteboardOpen` shows the sketch board OVER the flow canvas area;
  // `whiteboardMounted` flips true on first open and stays true so toggling
  // back and forth keeps the excalidraw instance alive (undo history, zoom)
  // — visibility:hidden hides it without unmounting. The flow canvas stays
  // mounted underneath the whole time, so neither canvas ever loses state.
  const [whiteboardOpen, setWhiteboardOpen]       = useState(false)
  const [whiteboardMounted, setWhiteboardMounted] = useState(false)
  const toggleWhiteboard = useCallback(() => {
    setWhiteboardMounted(true)
    setWhiteboardOpen(o => !o)
  }, [])

  // ── Run-flow panel state ────────────────────────────────────────────────
  // The slide-in panel that EXECUTES the graph (vs the legacy "apply to Agent
  // tab" Run). `runPanelOpen` controls visibility; `runInput` is the initial
  // message; `runStatus` is a small state machine for the result body.
  //
  // VISIBILITY IS GLOBAL TOO (FLF driver, finding 3). It was `useState(false)`,
  // and this page unmounts on a tab switch — so a user who started a Run all,
  // looked at another tab and came back found the panel CLOSED while the
  // sidebar dot still read RUNNING. The status had survived; the only door to
  // the RUNNING label and the STOP button had not. Not persisted: a run dies
  // with the app, so a restart must not reopen a panel for it.
  const runPanelOpen = useNodesRunStore(s => s.panelOpen)
  const setRunPanelOpen = useNodesRunStore(s => s.setPanelOpen)
  // …and so is what the user TYPED into it. Only the visibility moved the first
  // time round, so the panel came back open and EMPTY: a remount reset this
  // `useState('')` and silently threw the message away. Same store, same
  // session-only rationale — a run dies with the app, so does its prompt.
  const runInput = useNodesRunStore(s => s.runInput)
  const setRunInput = useNodesRunStore(s => s.setRunInput)
  // Run status lives in the GLOBAL nodesRun store so a "Run all" survives leaving
  // the /nodes tab (NodesPage unmounts) and an app-wide indicator can show it.
  const runStatus  = useNodesRunStore(s => s.status)
  const setRunStatus = useNodesRunStore(s => s.setStatus)
  const requestStop  = useNodesRunStore(s => s.requestStop)

  const running = runStatus.kind === 'running'

  // Execute the graph via the main-process compiler + agent-kit runtime.
  const handleRunFlow = useCallback(async () => {
    // Initial message is OPTIONAL — Prompt/agent nodes carry their own
    // instructions, so a flow can just be run with an empty seed.
    const message = runInput.trim()
    if (running) return
    setRunStatus({ kind: 'running' })
    try {
      const { nodes, edges } = useNodesStore.getState()
      const flow = serializeFlow(flowName, nodes, edges)
      const api = window.tachi?.nodes
      if (!api?.runGraph) {
        setRunStatus({ kind: 'error', error: t('run.errors.ipcUnavailable') })
        return
      }
      const res = (await api.runGraph(flow, message)) as GraphRunResult
      if (res.ok) {
        setRunStatus({ kind: 'done', results: res.results, final: res.final, ...(res.media ? { media: res.media } : {}) })
      } else {
        setRunStatus({ kind: 'error', error: res.error })
      }
    } catch (err) {
      setRunStatus({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }, [runInput, running, flowName, t])

  // ── Run ALL (sequential, flowith-style) ─────────────────────────────────────
  // Runs every runnable node ONCE, in topological order, via the per-node path
  // (window.tachi.nodes.runNode) — the same code each node's RUN button uses. We
  // stamp each result onto its node before the next call, so downstream nodes
  // resolve {{node:<id>}} tokens / prompt-plug feeds / the image plug against
  // FRESH upstream outputs. This sidesteps the agent-kit Network's limitation
  // (a chained 2nd+ agent gets no fresh user message → Venice returns empty):
  // the per-node path passes each node its upstream outputs AS the message, so a
  // Prompt → Prompt → Media pipeline runs end-to-end on one click.
  const handleRunAll = useCallback(async () => {
    if (running) return
    useNodesRunStore.getState().clearStop()
    const api = window.tachi?.nodes
    if (!api?.runNode) {
      setRunStatus({ kind: 'error', error: t('run.errors.ipcUnavailable') })
      setChatOpen(false); setRunPanelOpen(true)
      return
    }
    const snap = useNodesStore.getState()
    // Cycle guard: a cyclic graph has no valid run order — surface a clear
    // error instead of running in an undefined sequence.
    const cycleIds = detectCycle(snap.nodes, snap.edges)
    if (cycleIds !== null) {
      const cycleLabels = cycleIds
        .map(id => {
          const n = snap.nodes.find(x => x.id === id)
          return ((n?.data as { label?: string })?.label) || id
        })
        .join(' -> ')
      setRunStatus({ kind: 'error', error: t('run.errors.cycle', { nodes: cycleLabels }) })
      setChatOpen(false); setRunPanelOpen(true)
      return
    }
    const order = topologicalNodeOrder(snap.nodes, snap.edges)
    const runIds = order.filter(id => {
      const n = snap.nodes.find(x => x.id === id)
      return !!n && RUNNABLE_NODE_TYPES.has(n.type)
    })
    setChatOpen(false); setRunPanelOpen(true)
    if (runIds.length === 0) {
      setRunStatus({ kind: 'error', error: t('run.errors.nothingToRun') })
      return
    }

    // CODEX WRITE-MODE consent gate: if ANY write-enabled codex node (with a
    // wired folder) is about to run, get one-per-session explicit consent listing
    // the folders codex may modify BEFORE the run loop starts. Cancel aborts the
    // whole run cleanly (idle — nothing dispatched).
    const writeTargets = collectWriteConsentTargets(snap.nodes, snap.edges, runIds)
    const okToRun = await ensureCodexWriteConsent(writeTargets, confirm, t)
    if (!okToRun) {
      setRunStatus({ kind: 'idle' })
      return
    }

    // ONE entropy draw for the WHOLE click (FLF driver, finding 2).
    //
    // This loop calls the per-node IPC once per node, and that IPC deliberately
    // invents no seed — a lone RUN button must stay reproducible. So every
    // seedless LOCAL stage of an in-order Run-all was running on sd.cpp's fixed
    // default 42: the driver measured `--seed` ABSENT on both stages here while
    // "Run as one network" (which draws its own runSeed in main) produced two
    // distinct derived seeds for the same flow.
    //
    // Drawn HERE, outside the loop, because that is what makes the seeds
    // decorrelate the right way: hashing per node inside the loop would give
    // every RUN of the flow the same numbers. Explicit seeds still win in main.
    const runSeed = globalThis.crypto.randomUUID()

    // Trace: a root "Run all" phase span; each node runs as a child span. Lights
    // up the Trace console tab (a per-node duration timeline).
    const trace = useRunTraceStore.getState()
    const rootId = trace.startSpan({ name: `Run all · ${runIds.length} nodes`, kind: 'phase' })

    const results: GraphRunAgentResult[] = []
    const media: MediaNodeResult[] = []
    let estSpendUsd = 0
    // NODES-RESEARCH #6: per-node ERROR BRANCH. Track each runnable node's run
    // outcome so, before running the NEXT node, we can decide (via the pure
    // decideNodeRun helper) whether it should run and what upstream error text
    // to feed it. `skipResults` marks the informational "skipped …" lines so
    // they never become the flow's final answer.
    const outcomeById = new Map<string, UpstreamOutcome>()
    const skipResults = new Set<GraphRunAgentResult>()
    try {
      for (let i = 0; i < runIds.length; i++) {
        // Cooperative stop: the in-flight node (if any) has already finished;
        // bail before starting the next one, keeping the cards already on canvas.
        if (useNodesRunStore.getState().stopRequested) {
          trace.endSpan(rootId, { stopped: true, ran: results.length + media.length })
          setRunStatus({ kind: 'done', results, final: '[Run stopped]', ...(media.length ? { media } : {}) })
          return
        }
        const nodeId = runIds[i]
        // Re-read the store every step so each run sees the freshest upstream
        // lastOutputs we just stamped.
        const st = useNodesStore.getState()
        const node = st.nodes.find(n => n.id === nodeId)
        if (!node) continue
        const label = ((node.data as { label?: string }).label) || node.type
        // NODES-RESEARCH #1: a PINNED node with a cached output is SKIPPED —
        // its lastOutput feeds downstream via the serialized flow exactly as
        // if it had just run. Pinned-but-never-run nodes still execute.
        const nd = node.data as { pinned?: boolean; lastOutput?: string }
        if (nd.pinned && typeof nd.lastOutput === 'string' && nd.lastOutput.trim()) {
          results.push({ agent: label, text: `[pinned — cached output reused]` })
          // A pinned reuse counts as a SUCCESS for downstream error-branch logic.
          outcomeById.set(nodeId, { status: 'success' })
          continue
        }

        // NODES-RESEARCH #6: decide whether the error branch skips this node.
        // Static sources (Text/Provider/…) have no outcome → treated as normal
        // inputs, so ordinary flows are unaffected.
        const decision = decideNodeRun(nodeId, st.edges, (uid) => outcomeById.get(uid))
        if (!decision.run) {
          const skipText = decision.skipReason === 'no-error'
            ? t('run.skippedNoError', { defaultValue: 'Skipped — no error to handle' })
            : t('run.skippedUpstreamFailed', { defaultValue: 'Skipped — upstream failed' })
          const skipRes = { agent: label, text: skipText }
          results.push(skipRes)
          skipResults.add(skipRes)
          outcomeById.set(nodeId, { status: 'skipped' })
          continue
        }
        // NODES-RESEARCH #4: hard budget guard — stop BEFORE starting the next
        // node once the estimated spend crosses the cap (runaway-loop insurance).
        const capUsd = useNodesRunStore.getState().budgetUsd
        if (capUsd != null && capUsd > 0 && estSpendUsd >= capUsd) {
          trace.endSpan(rootId, { stopped: 'budget', ran: results.length + media.length })
          setRunStatus({ kind: 'done', results, final: t('run.budgetStop', { spent: estSpendUsd.toFixed(2), cap: capUsd.toFixed(2), defaultValue: 'Stopped: estimated spend ~${{spent}} reached the ${{cap}} budget cap. Raise or clear the cap in the run panel to continue.' }), ...(media.length ? { media } : {}) })
          return
        }
        const spanId = trace.startSpan({
          name: label, kind: node.type === 'media' ? 'tool' : 'agent',
          parentId: rootId, attrs: { nodeId, type: node.type, step: i + 1 },
        })

        // NODES-RESEARCH #6: when this node is an ERROR handler, override each
        // failed upstream node's transient lastOutput with its error text FOR
        // THIS RUN ONLY, so the handler receives the error through the same
        // upstream channel every input already flows through (outputsFromFlow in
        // main). Built fresh per node, so no other node's run is affected.
        const errIds = Object.keys(decision.errorInputs)
        const nodesForRun = errIds.length === 0
          ? st.nodes
          : st.nodes.map(n => errIds.includes(n.id)
              ? ({ ...n, data: { ...n.data, lastOutput: decision.errorInputs[n.id] } } as typeof n)
              : n)
        const flow = serializeFlow(st.flowName, nodesForRun, st.edges)
        // RETRY-ON-FAIL: run this node up to (retries + 1) times, waiting
        // retryDelayMs between failed attempts (a thrown IPC error counts as a
        // failed attempt). The run panel shows "retry N/M" from attempt 2 on.
        // Only the FINAL outcome below records lastError / feeds the error branch
        // (#6); EACH attempt counts toward est spend (#4) — the pre-node budget
        // guard above stops the run before the NEXT node once the cap is crossed.
        const policy = retryPolicy(node.data)
        let finalEstUsd: number | null = null
        let finalEstBasis: RunCostBasis | null = null
        const { outcome, attempts } = await runWithRetry<GraphNodeRunRes>({
          retries: policy.retries,
          retryDelayMs: policy.retryDelayMs,
          onAttemptStart: (attempt, total) => {
            setRunStatus({
              kind: 'running', step: i + 1, total: runIds.length, label,
              ...(attempt > 1 ? { attempt, attempts: total } : {}),
            })
          },
          onAttemptSettled: (_attempt, _total, oc) => {
            // Each attempt hit the provider → each counts toward est spend. On a
            // failed attempt there is no output, so it prices input-only.
            // NOTE: an 'unknown' basis contributes 0 to estSpendUsd because there
            // is no figure to add — the budget stop below therefore under-counts
            // unpriced nodes. The chip says "price unknown" so the gap is at
            // least visible; the ledger's own cap (cost-ledger.ts) is the one
            // that charges unknown usage an estimate.
            const est = estimateNodeRunCost(st.nodes, st.edges, nodeId, oc.ok ? ((oc.value as { text?: string }).text ?? '') : '')
            if (est.usd != null) { estSpendUsd += est.usd; finalEstUsd = est.usd }
            if (est.basis) finalEstBasis = est.basis
          },
          run: async () => {
            try {
              const r = await api.runNode(flow, nodeId, runSeed)
              return { ok: r.ok, value: r as GraphNodeRunRes }
            } catch (err) {
              return { ok: false, value: { ok: false, error: err instanceof Error ? err.message : String(err) } }
            }
          },
        })
        const res = outcome.value

        if (res.ok) {
          const artifacts = res.artifacts ?? []
          // NODES-RESEARCH #4: the per-node cost chip is the FINAL attempt's
          // estimate; the running total (estSpendUsd) already summed every
          // attempt in onAttemptSettled above.
          const estUsd = finalEstUsd
          // #6: success clears any prior error and marks the node succeeded so
          // downstream error-edge targets skip and normal targets receive output.
          updateNodeData(nodeId, { lastOutput: res.text ?? '', lastArtifacts: artifacts, lastError: undefined, lastCostUsd: estUsd ?? undefined, lastCostBasis: finalEstBasis ?? undefined })
          outcomeById.set(nodeId, { status: 'success' })
          // RUN FLOW parity with the per-node RUN button: spawn/refresh an on-canvas
          // result card for EVERY node (text AND media). Previously only per-node RUN
          // did this, so a clip generated by Run All landed in the gallery but never
          // appeared as a node on the canvas.
          useNodesStore.getState().upsertOutputNode(nodeId, {
            kind: artifacts.length > 0 ? 'media' : 'text',
            ...(res.text != null ? { text: res.text } : {}),
            ...(artifacts.length > 0 ? { artifacts } : {}),
            sourceLabel: label,
            ...(estUsd != null ? { estUsd } : {}),
            ...(finalEstBasis ? { estBasis: finalEstBasis } : {}),
          })
          if (node.type === 'media') {
            const d = node.data as { model?: string; modality: MediaNodeModality; prompt?: string; params?: Record<string, unknown> }
            media.push({
              nodeId, label, modality: d.modality,
              prompt: typeof d.prompt === 'string' ? d.prompt : '',
              ok: true, artifacts, ...(res.text != null ? { text: res.text } : {}),
            })
            // Mirror into the persistent gallery (parity with useNodeRun) — the
            // engine's real seed stamped into the params snapshot, because a
            // Run-all video stage's derived seed exists nowhere else the user
            // can reach (a .webm has no tEXt chunk; the runSeed uuid is gone).
            if (artifacts.length > 0) {
              const engineSeed  = artifacts.find(a => typeof a.seed === 'number')?.seed
              const entryParams = stampLocalSeed({ ...(d.params ?? {}) }, engineSeed)
              useMediaStore.getState().addNodeRunArtifacts({
                id: globalThis.crypto.randomUUID(),
                model: d.model ?? '', modality: d.modality,
                prompt: typeof d.prompt === 'string' ? d.prompt : '',
                artifacts, ...(res.text != null ? { text: res.text } : {}),
                ...(Object.keys(entryParams).length > 0 ? { params: entryParams } : {}),
              })
            }
          } else {
            results.push({ agent: label, text: res.text ?? '' })
          }
        } else {
          // Record + keep going: independent branches should still complete.
          // #6: record the failure so error-edge targets receive res.error and
          // normal targets are skipped. Clear lastOutput so a stale prior output
          // never leaks to a (skipped) normal target; stamp lastError.
          outcomeById.set(nodeId, { status: 'error', error: res.error })
          updateNodeData(nodeId, { lastError: res.error, lastOutput: '' })
          if (node.type === 'media') {
            const d = node.data as { modality: MediaNodeModality }
            media.push({ nodeId, label, modality: d.modality, prompt: '', ok: false, artifacts: [], error: res.error })
          } else {
            results.push({ agent: label, text: `[${t('run.errorPrefix')}] ${res.error}` })
          }
        }
        trace.endSpan(spanId, res.ok
          ? { ok: true, attempts, chars: (res.text ?? '').length, artifacts: (res.artifacts ?? []).length }
          : { ok: false, attempts, error: res.error })
      }

      trace.endSpan(rootId, { ok: true, nodes: runIds.length })
      const final =
        // #6: exclude "skipped …" lines from the final-answer search.
        [...results].reverse().find(r => r.text && !r.text.startsWith('[error]') && !skipResults.has(r))?.text
        ?? (media.some(m => m.ok) ? '[media generated — see the nodes]' : '')
      setRunStatus({ kind: 'done', results, final, ...(media.length ? { media } : {}) })
    } catch (err) {
      trace.endSpan(rootId, { ok: false, error: err instanceof Error ? err.message : String(err) })
      setRunStatus({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }, [running, updateNodeData, confirm, t])

  // ── BATCH35 lane B: webhook TRIGGER auto-run ─────────────────────────────
  //
  // A TradingView alert reaching an armed webhook node fires this. It is the
  // ONLY place an external party can start a run, so the gate is deliberately
  // narrow and lives in a pure predicate (mayAutoRun):
  //   · the user must have ticked auto-run ON THAT NODE (off by default),
  //   · the node must actually be armed and listening,
  //   · a run already in flight is never stacked on top of.
  // The existing per-node budget cap (#4) and the flow's own guards apply
  // unchanged — this starts the SAME Run-all path the button starts, nothing
  // privileged. The alert body is already on the node as `lastOutput`, so
  // downstream nodes read it through the ordinary reference paths.
  useEffect(() => onWebhookFired(({ nodeId }) => {
    const node = useNodesStore.getState().nodes.find(n => n.id === nodeId)
    if (!node || node.type !== 'webhook') return
    const d = node.data as { autoRun?: boolean; armed?: boolean }
    const allowed = mayAutoRun({
      autoRun: d.autoRun,
      // The node only emits while its route is live, so "listening" is implied
      // by the event itself; `armed` is re-read here so a disarm racing the
      // in-flight alert still wins.
      state: d.armed === false ? 'disarmed' : 'listening',
      running: useNodesRunStore.getState().status.kind === 'running',
    })
    if (!allowed) return
    setChatOpen(false); setRunPanelOpen(true)
    void handleRunAll()
  }), [handleRunAll])

  // ── Chat-with-flow state ────────────────────────────────────────────────
  // Interactive multi-agent chat / expert roundtable: each turn re-runs the
  // graph with the prior conversation threaded into the input. EVERY agent's
  // per-turn contribution is shown (the roundtable), and the "final"/MAIN
  // agent's answer is the synthesis the conversation remembers across turns.
  //   - text:       the synthesis (final agent's reply) — used for threading.
  //   - roundtable: each expert's contribution this turn (persona-labelled).
  //   - note:       optional system note (e.g. a timeout warning).
  type ChatMsg = {
    role: 'user' | 'assistant'
    text: string
    error?: boolean
    roundtable?: GraphRunAgentResult[]
    note?: string
    media?: MediaNodeResult[]
  }
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)

  const handleChatSend = useCallback(async () => {
    const message = chatInput.trim()
    if (!message || chatBusy) return
    const prior = chatMessages
    setChatMessages(prev => [...prev, { role: 'user', text: message }])
    setChatInput('')
    setChatBusy(true)
    try {
      const api = window.tachi?.nodes
      if (!api?.runGraph) {
        setChatMessages(prev => [...prev, { role: 'assistant', text: t('run.errors.ipcUnavailable'), error: true }])
        return
      }
      const { nodes, edges } = useNodesStore.getState()
      const flow = serializeFlow(flowName, nodes, edges)
      // Thread the conversation so far into the graph input so the agents have
      // memory of the chat (the graph itself is stateless between turns).
      const convo = prior
        .filter(m => !m.error)
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
        .join('\n')
      const input = convo ? `${convo}\nUser: ${message}` : message
      const res = (await api.runGraph(flow, input)) as GraphRunResult
      if (res.ok) {
        // Split the per-agent results into the experts' contributions (shown as
        // a roundtable) and any 'system' note (e.g. a timeout warning). The
        // synthesis (res.final) is the reply threaded into future turns.
        const experts = res.results.filter(r => r.agent !== 'system')
        const note = res.results.find(r => r.agent === 'system')?.text
        setChatMessages(prev => [...prev, {
          role: 'assistant',
          text: res.final || t('chat.noOutput'),
          roundtable: experts,
          ...(note ? { note } : {}),
          ...(res.media && res.media.length > 0 ? { media: res.media } : {}),
        }])
      } else {
        setChatMessages(prev => [...prev, { role: 'assistant', text: res.error, error: true }])
      }
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'assistant', text: err instanceof Error ? err.message : String(err), error: true }])
    } finally {
      setChatBusy(false)
    }
  }, [chatInput, chatBusy, chatMessages, flowName, t])

  // ── Add expert ────────────────────────────────────────────────────────────
  // One-click roundtable growth: drop a new persona agent onto the canvas,
  // wire it to the provider, and splice it into the discussion chain just
  // before the CEO/synthesizer (the MAIN node). Falls back gracefully when the
  // graph isn't a full roundtable yet (no MAIN node, or no agents at all).
  const handleAddExpert = useCallback(() => {
    const { nodes, edges } = useNodesStore.getState()
    const provider = nodes.find(n => n.type === 'provider')
    if (!provider) {
      dispatchToast(t('toast.addProviderFirst'), 'info')
      return
    }
    const agents = nodes.filter(n => n.type === 'agent')
    const finalAgent = agents.find(a => (a.data as { final?: boolean }).final === true)

    // Place the new expert below the existing agents (a stacked column).
    const baseY = agents.length ? Math.max(...agents.map(a => a.position.y)) + 150 : 160
    const baseX = finalAgent ? Math.max(360, finalAgent.position.x - 380) : 380
    const newId = `expert-${Date.now()}`
    const newExpert: TachiNode = {
      id: newId,
      type: 'agent',
      position: { x: baseX, y: baseY },
      data: {
        label: 'New expert',
        harnessId: 'openclaude',
        systemPrompt:
          'You are a [ROLE] expert. Describe the expertise, focus, and strong opinions ' +
          'this expert brings. Read the other experts\' takes above and build on them — ' +
          'agree, refine, or push back. Be concrete.',
      },
    } as TachiNode

    // Edge factory with auto-routed handles (same logic as the canvas/templates).
    const mkEdge = (eid: string, src: TachiNode, tgt: TachiNode, instruction?: string): TachiEdge => {
      const sRect = { x: src.position.x, y: src.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
      const tRect = { x: tgt.position.x, y: tgt.position.y, w: APPROX_NODE_RECT.w, h: APPROX_NODE_RECT.h }
      const { sourceHandle, targetHandle } = nearestHandlePair(sRect, tRect)
      return { id: eid, source: src.id, target: tgt.id, sourceHandle, targetHandle, type: 'link', data: instruction ? { instruction } : {} }
    }

    const ts = Date.now()
    const newEdges: TachiEdge[] = [mkEdge(`e-${ts}-prov`, provider, newExpert)]
    let edgesToSet = [...edges]

    if (finalAgent) {
      // Splice before the synthesizer: redirect the agent edge feeding MAIN.
      const feedEdge = edges.find(e => e.target === finalAgent.id && agents.some(a => a.id === e.source))
      if (feedEdge) {
        const lastExpert = agents.find(a => a.id === feedEdge.source)
        edgesToSet = edgesToSet.filter(e => e.id !== feedEdge.id)
        if (lastExpert) newEdges.push(mkEdge(`e-${ts}-in`, lastExpert, newExpert, 'build on this'))
      }
      newEdges.push(mkEdge(`e-${ts}-out`, newExpert, finalAgent, 'synthesize'))
    } else if (agents.length > 0) {
      // No synthesizer yet — append after the terminal agent (no outgoing agent edge).
      const terminal =
        agents.find(a => !edges.some(e => e.source === a.id && agents.some(x => x.id === e.target)))
        ?? agents[agents.length - 1]
      if (terminal) newEdges.push(mkEdge(`e-${ts}-in`, terminal, newExpert, 'build on this'))
    }
    // else: first agent in the graph — only the provider edge (it becomes entry).

    setNodes([...nodes, newExpert])
    setEdges([...edgesToSet, ...newEdges])
    dispatchToast(t('toast.expertAdded'), 'success')
  }, [setNodes, setEdges, t])

  const openRunPanel = useCallback(() => {
    setRunStatus({ kind: 'idle' })
    setChatOpen(false)
    setRunPanelOpen(true)
  }, [])

  const handleAutoLayout = useCallback(async () => {
    const { nodes, edges } = useNodesStore.getState()
    if (nodes.length === 0 || layouting) return
    setLayouting(true)
    try {
      const { autoLayout } = await import('./canvas/elk-layout')
      const result = await autoLayout(nodes, edges)
      setNodes(result.nodes as TachiNode[])
    } catch (err) {
      dispatchToast(t('toast.autoLayoutFailed', { error: String(err) }), 'error')
    } finally {
      setLayouting(false)
    }
  }, [setNodes, layouting, t])

  // ── RUN: turn the canvas graph into agent session config(s) ─────────────
  const handleRun = useCallback(() => {
    const { nodes, edges } = useNodesStore.getState()
    const result = chainScheduler(nodes, edges, t)
    if (!result.ok) {
      dispatchToast(result.error, 'error')
      return
    }

    const { chains } = result

    // Toast the chain count so the user sees multi-chain is detected.
    if (chains.length > 1) {
      dispatchToast(t('toast.chainsCompiled', { count: chains.length }), 'info')
    }

    // Apply chain[0] to agent.store (single-harness v1 behaviour).
    const first = chains[0]
    const a = useAgentStore.getState()
    a.setHarness(first.harness)
    a.setProvider(first.provider)
    if (first.bankrModel) a.setBankrModel(first.bankrModel)
    a.startNewSession()  // archive any active session, ready for fresh start

    const permTxt = first.permission
      ? t('toast.flowLoadedPerm', { permission: first.permission })
      : ''
    dispatchToast(
      t('toast.flowLoaded', { harness: first.harness, provider: first.providerLabel, perm: permTxt }),
      'success',
    )
    // Sync the sidebar highlight so the active tab matches the route (the Code
    // tab IS /agent — without this the sidebar stayed on STUDIO).
    useUIStore.getState().setSidebarTab('code')
    navigate('/agent')
  }, [navigate, t])

  const handleSave = useCallback(async () => {
    // Commit any pending local name edit to the store before saving.
    const nameToSave = localFlowName.trim() || 'Untitled flow'
    if (nameToSave !== flowName) {
      setLocalFlowName(nameToSave)
      setFlowName(nameToSave)
    }
    const { nodes, edges } = useNodesStore.getState()
    const result = await saveFlowToApp(nameToSave, nodes, edges)
    if (result.ok && result.path) {
      const savedPath = result.path
      window.dispatchEvent(new CustomEvent('tachi:flows-changed')) // refresh the FlowsRail
      dispatchToastWithReveal(t('toast.saved', { path: savedPath }), savedPath)
    } else {
      // Controlled Folder Access gets its own copy (LANE J) — the main process
      // tags a blocked Documents write, and "ENOENT" on a folder the user can
      // SEE in Explorer is the least useful thing we could print.
      const d = describeSaveFailure(result.error)
      dispatchToast(
        d.key === 'cfaBlocked'
          ? t('flowsRail.cfaBlocked', { fallback: d.fallback })
          : t('toast.saveFailed', { error: d.error || t('toast.unknownError') }),
        'error',
      )
    }
  }, [localFlowName, flowName, setFlowName, t])

  const handleNew = useCallback(async () => {
    if (useNodesStore.getState().nodes.length > 0) {
      const ok = await confirm({ message: t('confirm.discardFlow') })
      if (!ok) return
    }
    clearCanvas()
  }, [clearCanvas, confirm, t])

  // Save this whole graph and bind it as the Code tab's active workflow, so the
  // user can message it (and run the full multi-agent network) right from Code.
  // Distinct from "Open in Code tab" (handleRun), which collapses the flow into
  // a single-harness session and discards the rest of the graph.
  const handleUseInCode = useCallback(async () => {
    const nameToSave = localFlowName.trim() || 'Untitled flow'
    if (nameToSave !== flowName) {
      setLocalFlowName(nameToSave)
      setFlowName(nameToSave)
    }
    const { nodes, edges } = useNodesStore.getState()
    const result = await saveFlowToApp(nameToSave, nodes, edges)
    if (!result.ok || !result.filename) {
      dispatchToast(t('toast.useInCodeFailed', { error: result.error ?? t('toast.saveFailedShort') }), 'error')
      return
    }
    useAgentStore.getState().setActiveWorkflow({ filename: result.filename, name: nameToSave })
    dispatchToast(t('toast.activeInCode', { name: nameToSave }), 'success')
    useUIStore.getState().setSidebarTab('code')
    navigate('/agent')
  }, [localFlowName, flowName, setFlowName, navigate, t])

  // ── Council generator: fan-out deliberation graph ────────────────────────
  // Prompt source → Skeptic / Pragmatist / Critic → Synthesis (final). Appends
  // to the existing graph so it composes with whatever's already on the canvas.
  const handleCouncil = useCallback(() => {
    const { nodes, edges } = useNodesStore.getState()
    const council = buildCouncilGraph()
    setNodes([...nodes, ...council.nodes])
    setEdges([...edges, ...council.edges])
    dispatchToast(t('toast.councilAdded'), 'success')
  }, [setNodes, setEdges, t])

  // ── Blueprint import: numbered markdown → vertical agent chain ────────────
  const [blueprintOpen, setBlueprintOpen] = useState(false)
  const handleBlueprintImport = useCallback((newNodes: TachiNode[], newEdges: TachiEdge[]) => {
    const { nodes, edges } = useNodesStore.getState()
    setNodes([...nodes, ...newNodes])
    setEdges([...edges, ...newEdges])
    dispatchToast(t('toast.blueprintImported', { count: newNodes.length }), 'success')
  }, [setNodes, setEdges, t])

  // ── Starter templates: drop a complete, runnable example onto the canvas ──
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const templatesBtnRef = useRef<HTMLButtonElement>(null)
  // A11Y (batch34): the dropdown closed on outside-click only. Escape must close
  // whatever click-outside closes, and focus goes back to the trigger — a
  // keyboard user could otherwise never dismiss it.
  const closeTemplates = useCallback(() => {
    setTemplatesOpen(false)
    templatesBtnRef.current?.focus()
  }, [])
  useEffect(() => {
    if (!templatesOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); closeTemplates() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [templatesOpen, closeTemplates])

  // STARTER_TEMPLATES ships English-only label/description (starterTemplates.ts
  // is a data file, not a component — it has no i18n hook to call). Translated
  // here, by the template's stable `id`, with its own English text as the
  // defaultValue fallback — the confirm/toast copy below quotes this same
  // translated label; the dropdown row further down calls `t(...)` inline
  // (rather than through this helper) so the a11y button-name scanner's plain
  // `t(` heuristic still recognizes it as a named control.
  const templateLabel = useCallback(
    (tpl: StarterTemplate) => t(`templates.${tpl.id}.label`, { defaultValue: tpl.label }),
    [t],
  )

  const applyTemplate = useCallback(async (tpl: StarterTemplate) => {
    setTemplatesOpen(false)
    const s = useNodesStore.getState()
    const label = templateLabel(tpl)
    if (s.nodes.length > 0 || s.edges.length > 0) {
      const ok = await confirm({ message: t('confirm.replaceTemplate', { label }) })
      if (!ok) return
    }
    loadFlow(tpl.name, tpl.nodes, tpl.edges)
    // NODES-RESEARCH #4: self-healing check — surface missing keys/models/folders
    // in the just-opened template as one-click repairs (never blocks the open).
    runFlowDoctor()
    dispatchToast(t('toast.templateLoaded', { label }), 'success')
  }, [confirm, loadFlow, t, templateLabel])

  const handleOpenClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return
      // Reset so re-selecting same file fires change again
      e.target.value = ''
      try {
        const flow = await readFlowFile(file)
        loadFlow(flow.name, flow.nodes, flow.edges)
        runFlowDoctor() // NODES-RESEARCH #4: check the imported flow for missing deps
        dispatchToast(t('toast.loaded', { name: flow.name }), 'success')
      } catch (err) {
        const msg = err instanceof FlowParseError ? err.message : String(err)
        dispatchToast(t('toast.openFailed', { error: msg }), 'error')
      }
    },
    [loadFlow, t],
  )

  const handleClear = useCallback(async () => {
    const s = useNodesStore.getState()
    if (s.nodes.length === 0 && s.edges.length === 0) return
    const ok = await confirm({ message: t('confirm.clearAll', { count: s.nodes.length }) })
    if (!ok) return
    clearCanvas()
    // Destructive action gets an immediate escape hatch (UX #10d): the clear
    // is on the undo stack — surface that at the moment it matters.
    window.dispatchEvent(new CustomEvent('tachi:toast', {
      detail: {
        kind: 'info',
        text: t('toast.cleared', { count: s.nodes.length, defaultValue: 'Canvas cleared ({{count}} nodes)' }),
        ttl: 8000,
        actions: [{ label: t('toast.undo', { defaultValue: 'UNDO' }), onClick: () => useNodesStore.getState().undo() }],
      },
    }))
  }, [clearCanvas, confirm, t])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* ── Toolbar ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        borderBottom: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        flexShrink: 0,
        flexWrap: 'wrap',
      }}>
        {/* Page title */}
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
          marginRight: 4,
          flexShrink: 0,
        }}>
          {t('toolbar.title')}
        </span>

        <button
          style={btnPrimary}
          onClick={() => setHowToOpen(true)}
          title={t('toolbar.howToBuildTitle')}
        >
          {t('toolbar.howToBuild')}
        </button>

        {/* Starter templates dropdown — drop a complete, runnable example. */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            ref={templatesBtnRef}
            style={btnBase}
            onClick={() => setTemplatesOpen(o => !o)}
            title={t('toolbar.templatesTitle')}
            aria-haspopup="menu"
            aria-expanded={templatesOpen}
          >
            {t('toolbar.templates')}
          </button>
          {templatesOpen && (
            <>
              {/* Click-away backdrop. DECORATIVE: aria-hidden + no keyboard
                  affordance on purpose — Escape (above) is the keyboard twin of
                  clicking it, so this never needs to be reachable. */}
              <div
                onClick={closeTemplates}
                style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                aria-hidden="true"
              />
              <div
                role="menu"
                aria-label={t('toolbar.templatesMenuAria', { defaultValue: 'Starter templates' })}
                style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 41,
                  width: 280, border: '2px solid var(--accent)', background: 'var(--bg-surface)',
                  boxShadow: 'var(--shadow-hard)',
                }}
              >
                {/* NOTE: the map param is `tpl`, not `t` — this scope sits inside a
                    render block that also needs the outer i18n `t` (translated
                    label/description below), and `t` shadowing it here was the
                    bug: the toolbar's own translate function would have been
                    unreachable for every template row. */}
                {STARTER_TEMPLATES.map((tpl, i) => (
                  <button
                    key={tpl.id}
                    role="menuitem"
                    onClick={() => applyTemplate(tpl)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px',
                      border: 'none', borderTop: i === 0 ? 'none' : 'var(--border-width) solid var(--border)',
                      background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
                      fontFamily: 'JetBrains Mono, monospace',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 700 }}>{t(`templates.${tpl.id}.label`, { defaultValue: tpl.label })}</span>
                    <span style={{ display: 'block', fontSize: 10, color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.4 }}>
                      {t(`templates.${tpl.id}.description`, { defaultValue: tpl.description })}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Council generator — fan-out deliberation graph in one click. */}
        <button
          style={btnBase}
          onClick={handleCouncil}
          title={t('toolbar.councilTitle')}
        >
          {t('toolbar.council')}
        </button>

        {/* Blueprint import — paste a numbered plan, get a vertical agent chain. */}
        <button
          style={btnBase}
          onClick={() => setBlueprintOpen(true)}
          title={t('toolbar.importBlueprintTitle')}
        >
          {t('toolbar.importBlueprint')}
        </button>

        {/* Flow name input — uses local state so the user can fully clear
         *  the field without the persisted value snapping back on each key.
         *  Store is committed on blur; empty blur defaults to 'Untitled flow'. */}
        <input
          value={localFlowName}
          onChange={(e) => setLocalFlowName(e.target.value)}
          onBlur={(e) => {
            const committed = e.target.value.trim() || 'Untitled flow'
            setLocalFlowName(committed)
            setFlowName(committed)
          }}
          placeholder={t('toolbar.flowNamePlaceholder')}
          aria-label={t('toolbar.flowNameAria')}
          style={{
            padding: '4px 8px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            width: 200,
            outline: 'none',
            flexShrink: 0,
          }}
        />

        <div style={{ width: 1, height: 24, background: 'var(--border)', flexShrink: 0 }} />

        <button style={btnBase} onClick={handleNew}   title={t('toolbar.newTitle')}>
          {t('toolbar.new')}
        </button>
        <button style={btnBase} onClick={handleOpenClick} title={t('toolbar.openTitle')}>
          {t('toolbar.open')}
        </button>
        <button
          style={btnBase}
          onClick={handleSave}
          title={t('toolbar.saveTitle')}
          disabled={nodeCount === 0}
        >
          {t('toolbar.save')}
        </button>

        <div style={{ width: 1, height: 24, background: 'var(--border)', flexShrink: 0 }} />

        <button
          style={btnBase}
          onClick={handleAutoLayout}
          title={t('toolbar.autoLayoutTitle')}
          disabled={nodeCount === 0 || layouting}
        >
          {layouting ? t('toolbar.layingOut') : t('toolbar.autoLayout')}
        </button>

        {/* Whiteboard toggle — swaps the canvas area to an excalidraw sketch
            board. Accent style while active so the mode is obvious. */}
        <button
          style={whiteboardOpen ? btnPrimary : btnBase}
          onClick={toggleWhiteboard}
          title={t('toolbar.whiteboardTitle')}
          aria-pressed={whiteboardOpen}
        >
          {t('toolbar.whiteboard')}
        </button>

        <button
          data-howto="run-flow"
          style={btnPrimary}
          onClick={openRunPanel}
          title={t('toolbar.runFlowTitle')}
          disabled={nodeCount === 0}
        >
          {t('toolbar.runFlow')}
        </button>

        <button
          style={btnBase}
          onClick={handleAddExpert}
          title={t('toolbar.addExpertTitle')}
        >
          {t('toolbar.addExpert')}
        </button>

        <button
          style={btnBase}
          onClick={() => { setRunPanelOpen(false); setChatOpen(true) }}
          title={t('toolbar.chatWithFlowTitle')}
          disabled={nodeCount === 0}
        >
          {t('toolbar.chatWithFlow')}
        </button>

        <button
          style={btnBase}
          onClick={handleRun}
          title={t('toolbar.openInCodeTitle')}
          disabled={nodeCount === 0}
        >
          {t('toolbar.openInCode')}
        </button>

        <button
          style={btnBase}
          onClick={handleUseInCode}
          title={t('toolbar.runInCodeTitle')}
          disabled={nodeCount === 0}
        >
          {t('toolbar.runInCode')}
        </button>

        {/* Node / edge count badge */}
        <span style={{
          marginLeft: 'auto',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          color: 'var(--text-dim)',
          flexShrink: 0,
        }}>
          {t('toolbar.nodeCount', { count: nodeCount })}
          {' / '}
          {t('toolbar.edgeCount', { count: edgeCount })}
        </span>

        {/* CLEAR is destructive — parked at the extreme end of the toolbar,
            behind the count badge, far from SAVE and RUN (UX #10d). The
            confirm counts the nodes and the toast offers UNDO. */}
        <button style={btnDanger} onClick={handleClear} title={t('toolbar.clearTitle')} disabled={nodeCount === 0}>
          {t('toolbar.clear')}
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.tachi-flow.json"
          style={{ display: 'none' }}
          onChange={handleFileChange}
          aria-hidden="true"
        />
      </div>

      {/* ── Body: palette + canvas ── */}
      {/* position:relative anchors the absolute NodeConfigPanel (overlays the canvas). */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {/* Saved-canvas rail (like chat history) — switch flows / start new. */}
        <FlowsRail />
        <NodePalette />

        {/* Canvas column: the self-healing REPAIR banner (NODES-RESEARCH #4)
            sits at the top of the canvas and pushes it down — never overlaps,
            never blocks loading. */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
          <RepairBanner />
          {/* ReactFlowProvider scopes the ReactFlow context to this page */}
          <ReactFlowProvider>
            <FlowCanvas onTidyUp={handleAutoLayout} />
          </ReactFlowProvider>
        </div>

        {/* ── Run-flow panel (slide-in, right) ── */}
        {runPanelOpen && !chatOpen && (
          <RunFlowPanel
            input={runInput}
            onInputChange={setRunInput}
            status={runStatus}
            running={running}
            onRun={handleRunAll}
            onRunNetwork={handleRunFlow}
            onStop={requestStop}
            onClose={() => setRunPanelOpen(false)}
          />
        )}

        {/* ── Node config side-panel (slide-in, right, over the canvas) ── */}
        {/* Hidden while the Run / Chat panels own the right slot. */}
        {selectedNode && !runPanelOpen && !chatOpen && (
          <NodeConfigPanel
            node={selectedNode}
            onClose={clearSelection}
          />
        )}

        {/* ── Chat-with-flow panel (slide-in, right) ── */}
        {chatOpen && (
          <FlowChatPanel
            messages={chatMessages}
            input={chatInput}
            busy={chatBusy}
            onInputChange={setChatInput}
            onSend={handleChatSend}
            onClear={() => setChatMessages([])}
            onClose={() => setChatOpen(false)}
          />
        )}

        {/* ── Whiteboard overlay (excalidraw) ── */}
        {/* Mounted once on first open, then hidden with visibility (NOT
            display:none, NOT unmount) so BOTH canvases keep their state:
            the flow canvas stays laid out underneath at full size, and the
            excalidraw instance keeps its zoom/undo without resize churn.
            zIndex 45 sits above the NodeConfigPanel overlay (30). */}
        {whiteboardMounted && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 45,
              display: 'flex',
              visibility: whiteboardOpen ? 'visible' : 'hidden',
              background: 'var(--bg-base)',
            }}
            aria-hidden={!whiteboardOpen}
          >
            <React.Suspense
              fallback={
                <div style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: 'var(--text-dim)',
                }}>
                  {t('whiteboard.loading')}
                </div>
              }
            >
              <WhiteboardPanel />
            </React.Suspense>
          </div>
        )}
      </div>

      <NodesHowTo open={howToOpen} onClose={() => setHowToOpen(false)} />

      <BlueprintImportDialog
        open={blueprintOpen}
        onClose={() => setBlueprintOpen(false)}
        onImport={handleBlueprintImport}
      />
    </div>
  )
}

// ── RunFlowPanel ───────────────────────────────────────────────────────────────
//
// Slide-in panel on the right of the canvas that drives the EXECUTE path:
// an input for the initial message, a Run button, and a result body showing
// loading / per-agent outputs + final answer / error. Brutalist styling.

type RunStatus = NodesRunStatus

function RunFlowPanel(props: {
  input: string
  onInputChange: (v: string) => void
  status: RunStatus
  running: boolean
  /** Primary run — sequential, node-by-node in topological order. */
  onRun: () => void
  /** Secondary run — single agent-kit Network pass (shared state / roundtable). */
  onRunNetwork?: () => void
  /** Stop a sequential "Run all" after the current node finishes. */
  onStop?: () => void
  onClose: () => void
}) {
  const { input, onInputChange, status, running, onRun, onRunNetwork, onStop, onClose } = props
  const { t } = useTranslation('nodes')
  // NODES-RESEARCH #4: est-spend cap, persisted globally in the run store.
  const budgetUsd    = useNodesRunStore(s => s.budgetUsd)
  const setBudgetUsd = useNodesRunStore(s => s.setBudgetUsd)
  // RETRY-ON-FAIL: while a node is RE-running, tack " · retry N/M" onto the
  // running-step line so the user sees the retry happening (empty otherwise).
  const retrySuffix = status.kind === 'running' && status.attempt && status.attempt > 1
    ? t('runPanel.retrySuffix', { attempt: status.attempt, attempts: status.attempts ?? status.attempt, defaultValue: ' · retry {{attempt}}/{{attempts}}' })
    : ''

  return (
    <div
      // A11Y (batch34): named landmark — the run panel is a sibling region of
      // the canvas, not part of it.
      role="complementary"
      aria-label={t('runPanel.aria', { defaultValue: 'Run flow' })}
      style={{
        width: 360,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        overflow: 'hidden',
      }}
    >
      {/* Panel header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: '2px solid var(--border)',
        background: 'var(--bg-elevated)',
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
        }}>
          {t('runPanel.title')}
        </span>
        <button
          onClick={onClose}
          title={t('runPanel.close')}
          style={{
            ...btnBase,
            padding: '2px 8px',
            border: '2px solid var(--border)',
          }}
        >
          {t('runPanel.close')}
        </button>
      </div>

      {/* Input + run control */}
      <div style={{ padding: 12, borderBottom: '2px solid var(--border)', flexShrink: 0 }}>
        <label style={{
          display: 'block',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--text-dim)',
          marginBottom: 6,
        }}>
          {t('runPanel.initialMessage')}
        </label>
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter to run.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              if (!running) onRun()
            }
          }}
          placeholder={t('runPanel.initialPlaceholder')}
          // The <label> above is not wired with htmlFor, so without this the
          // textarea has no accessible name at all.
          aria-label={t('runPanel.initialMessage')}
          rows={3}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            padding: '6px 8px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            outline: 'none',
          }}
        />
        {/* NODES-RESEARCH #4: hard budget cap for this Run-all (est. spend). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            {t('runPanel.budgetLabel', { defaultValue: 'Budget cap $' })}
          </span>
          <input
            type="number"
            min={0}
            step="0.1"
            value={budgetUsd ?? ''}
            placeholder={t('runPanel.budgetOff', { defaultValue: 'off' })}
            aria-label={t('runPanel.budgetLabel', { defaultValue: 'Budget cap $' })}
            onChange={e => {
              const v = e.target.value.trim()
              setBudgetUsd(v === '' ? null : Number(v))
            }}
            title={t('runPanel.budgetTitle', { defaultValue: 'Stop the run before the estimated spend crosses this many dollars. Empty = no cap. Estimates use each node’s wired model rates; local models are free.' })}
            style={{
              width: 72, padding: '3px 6px', border: '2px solid var(--border)',
              background: 'var(--bg-elevated)', color: 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace', fontSize: 11, outline: 'none',
            }}
          />
        </div>
        <button
          onClick={onRun}
          disabled={running}
          title={t('runPanel.runAllTitle')}
          style={{
            ...btnPrimary,
            width: '100%',
            marginTop: 8,
            opacity: running ? 0.6 : 1,
            cursor: running ? 'not-allowed' : 'pointer',
          }}
        >
          {running
            ? (status.kind === 'running' && status.total
                ? t('runPanel.runningStep', { step: status.step, total: status.total, label: (status.label ? ` · ${status.label}` : '') + retrySuffix })
                : t('runPanel.running'))
            : t('runPanel.runAll')}
        </button>

        {running && onStop && (
          <button
            onClick={onStop}
            title={t('runPanel.stopTitle')}
            style={{
              ...btnBase,
              width: '100%',
              marginTop: 6,
              border: '2px solid var(--warning)',
              color: 'var(--warning)',
              fontWeight: 700,
            }}
          >
            {t('runPanel.stop')}
          </button>
        )}

        {onRunNetwork && (
          <button
            onClick={onRunNetwork}
            disabled={running}
            title={t('runPanel.runNetworkTitle')}
            style={{
              ...btnBase,
              width: '100%',
              marginTop: 6,
              opacity: running ? 0.6 : 1,
              cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {t('runPanel.runNetwork')}
          </button>
        )}
      </div>

      {/* Result body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {/* A11Y (batch34): ONE terse polite announcement when the run COMPLETES.
            The visible per-step "running 3/7" line below is deliberately NOT a
            live region — a 20-node flow would fire 20 interruptions. Failure is
            announced by the role="alert" error box instead, not twice here. */}
        <span role="status" aria-live="polite" aria-atomic="true" style={SR_ONLY}>
          {status.kind === 'done' ? t('runPanel.doneAria', { defaultValue: 'Run finished' }) : ''}
        </span>
        {status.kind === 'idle' && (
          <p style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: 'var(--text-dim)',
            margin: 0,
          }}>
            {t('runPanel.idleBefore')}<strong>{t('runPanel.idleStrong')}</strong>{t('runPanel.idleAfter')}
          </p>
        )}

        {status.kind === 'running' && (
          <p style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: 'var(--text-primary)',
            margin: 0,
          }}>
            {status.total
              ? t('runPanel.runningNode', { step: status.step, total: status.total, label: (status.label ? ` — ${status.label}` : '') + retrySuffix })
              : t('runPanel.runningFlow')}
          </p>
        )}

        {status.kind === 'error' && (
          <div role="alert" style={{
            border: '2px solid var(--danger)',
            background: 'var(--bg-elevated)',
            padding: 10,
          }}>
            <div style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--danger)',
              marginBottom: 6,
            }}>
              {t('runPanel.runFailed')}
            </div>
            <pre style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              color: 'var(--text-primary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              margin: 0,
            }}>
              {status.error}
            </pre>
          </div>
        )}

        {status.kind === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {status.results.length === 0 && (
              <p style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                color: 'var(--text-dim)',
                margin: 0,
              }}>
                {t('runPanel.noAgentOutput')}
              </p>
            )}

            {status.results.map((r, i) => (
              <div key={`${r.agent}-${i}`} style={{
                border: '2px solid var(--border)',
                background: 'var(--bg-elevated)',
              }}>
                <div style={{
                  padding: '4px 8px',
                  borderBottom: '2px solid var(--border)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  color: 'var(--text-dim)',
                  wordBreak: 'break-word',
                }}>
                  {/* Strip the "#nodeId" suffix from the agent name; show step order. */}
                  {t('runPanel.step', { n: i + 1, agent: String(r.agent).split('#')[0] })}
                  {i === status.results.length - 1 ? t('runPanel.finalSuffix') : ''}
                </div>
                <pre style={{
                  padding: 8,
                  margin: 0,
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {r.text || t('runPanel.noTextOutput')}
                </pre>
              </div>
            ))}

            {/* Media artifacts produced in Phase 2 (image/audio/video/transcript). */}
            {status.media && status.media.length > 0 && (
              <MediaResultsBlock media={status.media} />
            )}

            {status.results.length > 0 && (
              <div style={{
                border: '2px solid var(--accent)',
                background: 'var(--bg-elevated)',
              }}>
                <div style={{
                  padding: '4px 8px',
                  borderBottom: '2px solid var(--accent)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--accent)',
                }}>
                  {t('runPanel.finalAnswer')}
                </div>
                <pre style={{
                  padding: 8,
                  margin: 0,
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  color: 'var(--text-primary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {status.final || t('runPanel.empty')}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── FlowChatPanel ───────────────────────────────────────────────────────────────
//
// Interactive multi-agent chat: a conversation with the whole graph. Each turn
// re-runs the graph with the prior conversation threaded into the input, and the
// flow's "final" agent (marked, or last-in-chain) provides the reply.

function FlowChatPanel(props: {
  messages: {
    role: 'user' | 'assistant'
    text: string
    error?: boolean
    roundtable?: GraphRunAgentResult[]
    note?: string
    media?: MediaNodeResult[]
  }[]
  input: string
  busy: boolean
  onInputChange: (v: string) => void
  onSend: () => void
  onClear: () => void
  onClose: () => void
}) {
  const { messages, input, busy, onInputChange, onSend, onClear, onClose } = props
  const { t } = useTranslation('nodes')
  const pane = useResizablePanel({ storageKey: 'tachi-split:nodes.flowchat', initial: 360, min: 280, max: 640, side: 'left', collapsible: true })
  return (
    <>
    <SplitHandle panel={pane} side="left" dataId="nodes.flowchat" />
    <div
      role="complementary"
      aria-label={t('chatPanel.aria', { defaultValue: 'Chat with flow' })}
      style={{
        width: pane.width, flexShrink: 0, display: 'flex', flexDirection: 'column',
        borderLeft: '2px solid var(--border)', background: 'var(--bg-surface)', overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 12px', borderBottom: '2px solid var(--border)', background: 'var(--bg-elevated)', flexShrink: 0,
      }}>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
          {t('chatPanel.title')}
        </span>
        <span style={{ display: 'inline-flex', gap: 6 }}>
          <button onClick={onClear} title={t('chatPanel.clearTitle')} style={{ ...btnBase, padding: '2px 8px' }}>{t('chatPanel.clear')}</button>
          <button onClick={onClose} title={t('chatPanel.close')} style={{ ...btnBase, padding: '2px 8px' }}>{t('chatPanel.close')}</button>
        </span>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.length === 0 && (
          <p style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-dim)', margin: 0, lineHeight: 1.6 }}>
            {t('chatPanel.empty')}
          </p>
        )}
        {messages.map((m, i) => {
          // Roundtable view: when an assistant turn carries 2+ expert
          // contributions, show each persona's take, with the last (the
          // CEO/MAIN synthesizer) highlighted as the decision. Otherwise a
          // plain bubble (user message, error, or single-agent reply).
          const isRoundtable = m.role === 'assistant' && !m.error && !!m.roundtable && m.roundtable.length > 1
          if (!isRoundtable) {
            return (
              <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '92%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{
                  border: `2px solid ${m.error ? 'var(--danger)' : m.role === 'user' ? 'var(--accent)' : 'var(--border)'}`,
                  background: 'var(--bg-elevated)',
                }}>
                  <div style={{
                    padding: '2px 8px', borderBottom: `var(--border-width) solid ${m.error ? 'var(--danger)' : 'var(--border)'}`,
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                    textTransform: 'uppercase', color: m.error ? 'var(--danger)' : 'var(--text-dim)',
                  }}>
                    {m.role === 'user' ? t('chatPanel.you') : m.error ? t('chatPanel.error') : t('chatPanel.flow')}
                  </div>
                  <pre style={{ padding: 8, margin: 0, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {m.text}
                  </pre>
                </div>
                {m.media && m.media.length > 0 && <MediaResultsBlock media={m.media} />}
              </div>
            )
          }
          return (
            <div key={i} style={{ alignSelf: 'flex-start', width: '96%', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: 'var(--text-dim)',
              }}>
                {t('chatPanel.roundtable')}
              </div>
              {m.roundtable!.map((r, j) => {
                const persona = String(r.agent).split('#')[0]
                const isFinal = j === m.roundtable!.length - 1
                return (
                  <div key={`${r.agent}-${j}`} style={{
                    border: `2px solid ${isFinal ? 'var(--accent)' : 'var(--border)'}`,
                    background: 'var(--bg-elevated)',
                  }}>
                    <div style={{
                      padding: '2px 8px', borderBottom: `var(--border-width) solid ${isFinal ? 'var(--accent)' : 'var(--border)'}`,
                      fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                      textTransform: 'uppercase', color: isFinal ? 'var(--accent)' : 'var(--text-dim)',
                    }}>
                      {persona}{isFinal ? t('chatPanel.decisionSuffix') : ''}
                    </div>
                    <pre style={{ padding: 8, margin: 0, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {r.text || t('chatPanel.noOutput')}
                    </pre>
                  </div>
                )
              })}
              {m.note && (
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic', lineHeight: 1.5 }}>
                  {m.note}
                </div>
              )}
              {m.media && m.media.length > 0 && <MediaResultsBlock media={m.media} />}
            </div>
          )
        })}
        {busy && (
          <div style={{ alignSelf: 'flex-start', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-dim)' }}>
            {t('chatPanel.thinking')}
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: 12, borderTop: '2px solid var(--border)', flexShrink: 0 }}>
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              if (!busy && input.trim()) onSend()
            }
          }}
          placeholder={t('chatPanel.inputPlaceholder')}
          aria-label={t('chatPanel.inputPlaceholder')}
          rows={2}
          style={{
            width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '6px 8px',
            border: '2px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace', fontSize: 12, outline: 'none',
          }}
        />
        <button
          onClick={onSend}
          disabled={busy || input.trim().length === 0}
          style={{
            ...btnPrimary, width: '100%', marginTop: 8,
            opacity: busy || input.trim().length === 0 ? 0.6 : 1,
            cursor: busy || input.trim().length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? t('chatPanel.sending') : t('chatPanel.send')}
        </button>
      </div>
    </div>
    </>
  )
}

// ── Media results rendering (Phase 2 artifacts) ────────────────────────────────
//
// Renders the per-media-node output of a graph run: a preview for each node
// (image inline, audio/video player from the file path, STT transcript text) or
// the node's error. Binary audio/video are referenced by file:// path — never
// base64'd into the renderer (large-binary rule). Small images carry inline b64.

// i18n key suffix per modality → media.modalities.<key> for the result header word.
const MEDIA_LABEL: Record<MediaNodeModality, string> = {
  image: 'image', video: 'video', music: 'music', tts: 'speech', stt: 'transcript',
}

function MediaResultsBlock({ media }: { media: MediaNodeResult[] }) {
  const { t } = useTranslation('nodes')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
        textTransform: 'uppercase', color: 'var(--accent)',
      }}>
        {t('media.output')}
      </div>
      {media.map((r) => (
        <div key={r.nodeId} style={{ border: `2px solid ${r.ok ? 'var(--accent)' : 'var(--danger)'}`, background: 'var(--bg-elevated)' }}>
          <div style={{
            padding: '2px 8px', borderBottom: `var(--border-width) solid ${r.ok ? 'var(--accent)' : 'var(--danger)'}`,
            fontFamily: 'JetBrains Mono, monospace', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: r.ok ? 'var(--accent)' : 'var(--danger)',
          }}>
            {r.label} · {t(`media.modalities.${MEDIA_LABEL[r.modality]}`)}
          </div>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {!r.ok && (
              <pre style={{ margin: 0, fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--danger)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {r.error || t('media.failed')}
              </pre>
            )}
            {r.ok && r.modality === 'stt' && (
              <pre style={{ margin: 0, fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {r.text || t('media.noTranscript')}
              </pre>
            )}
            {r.ok && r.artifacts.map((a, i) => <ArtifactRender key={i} artifact={a} />)}
            {r.ok && r.modality !== 'stt' && r.artifacts.length === 0 && (
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--text-dim)' }}>
                {t('media.noArtifact')}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// The Run panel's artifact renderer. It built its OWN `file:///…` URLs, which
// this renderer cannot load at all — it is served over http://localhost, and
// NodeRunUI learned that the hard way and routes through the tachi-media://
// protocol registered in main. So every on-disk artifact the Run panel showed was
// a broken image / dead player, while the very same file rendered fine on the node
// card two inches away. One helper, one protocol, no second copy to rot.
function ArtifactRender({ artifact }: { artifact: Artifact }) {
  const { t } = useTranslation('nodes')
  const { kind, mimeType, b64, path } = artifact
  if (kind === 'image') {
    // Small images still carry inline b64 (instant, no protocol hop) — unchanged.
    const src = b64 ? `data:${mimeType};base64,${b64}` : (path ? fileUrl(path) : '')
    if (src) return <img src={src} alt={t('media.generatedAlt')} style={{ width: '100%', display: 'block', border: '2px solid var(--border)' }} />
  }
  if (kind === 'audio' && path) {
    return <audio controls src={fileUrl(path)} style={{ width: '100%' }} />
  }
  if (kind === 'video' && path) {
    return <video controls src={fileUrl(path)} style={{ width: '100%', display: 'block', border: '2px solid var(--border)' }} />
  }
  return (
    <div style={{ padding: 6, border: '2px solid var(--border)', fontSize: 9, color: 'var(--text-muted)', wordBreak: 'break-all', fontFamily: 'JetBrains Mono, monospace' }}>
      {path ?? `(${kind} artifact)`}
    </div>
  )
}

// ── Toast helpers ─────────────────────────────────────────────────────────────

function dispatchToast(text: string, kind: 'success' | 'error' | 'info') {
  window.dispatchEvent(
    new CustomEvent('tachi:toast', { detail: { kind, text } }),
  )
}

/** Toast that includes a [REVEAL] button to open the file in the OS file explorer. */
function dispatchToastWithReveal(text: string, absPath: string) {
  window.dispatchEvent(
    new CustomEvent('tachi:toast', {
      detail: {
        kind: 'success',
        text,
        ttl: 8000,
        actions: [
          {
            label: 'REVEAL',
            onClick: () => {
              window.tachi.shell.revealInFolder(absPath).catch(() => {/* swallow */})
            },
          },
        ],
      },
    }),
  )
}

// ── Chain config type (mirrors multi-chain-runner.ts ChainConfig) ─────────────
//
// We duplicate the minimal shape here rather than importing from the main
// process so the renderer bundle doesn't pull in Electron-only modules.

type ChainConfig = {
  harness: HarnessId
  provider: AgentProvider
  providerLabel: string
  bankrModel?: string
  permission?: string
  /** The agent node id — for UI tracing / future highlighting. */
  agentNodeId: string
}

type ChainSchedulerOk   = { ok: true;  chains: ChainConfig[] }
type ChainSchedulerFail = { ok: false; error: string }
type ChainSchedulerResult = ChainSchedulerOk | ChainSchedulerFail

// ── chainScheduler ────────────────────────────────────────────────────────────
//
// Walks ALL agent nodes in the graph. For each agent that has an incoming
// Provider edge it builds a ChainConfig. Agents not wired to a provider are
// silently skipped (partial flows are fine). Returns an error only when there
// are no agents or no providers at all, or when none of the agents are wired.
//
// Replaces the old `compileFlowToSession` which only returned the FIRST chain.
// Now returns the full array so the caller can log/launch all of them.

// Translator passed in from the calling component (chainScheduler is module-level
// and has no hook of its own). Loosely typed to accept i18next's t() shape.
type Translate = (key: string, opts?: Record<string, unknown>) => string

function chainScheduler(nodes: TachiNode[], edges: TachiEdge[], t: Translate): ChainSchedulerResult {
  if (nodes.length === 0) {
    return { ok: false, error: t('scheduler.addProviderAgent') }
  }

  const agents    = nodes.filter(n => n.type === 'agent')
  const providers = nodes.filter(n => n.type === 'provider')
  const perms     = nodes.filter(n => n.type === 'skill')

  if (agents.length === 0)    return { ok: false, error: t('scheduler.needAgent') }
  if (providers.length === 0) return { ok: false, error: t('scheduler.needProvider') }

  const chains: ChainConfig[] = []

  for (const agent of agents) {
    // Find an edge where this agent is the TARGET and the SOURCE is a provider.
    const incoming = edges.find(e => e.target === agent.id && providers.some(p => p.id === e.source))
    if (!incoming) continue  // agent not wired to a provider — skip, don't error

    const provider = providers.find(p => p.id === incoming.source)
    if (!provider) continue  // should not happen given the find above

    // Optional: outgoing edge from agent → permission node
    const outgoing = edges.find(e => e.source === agent.id && perms.some(p => p.id === e.target))
    const perm = outgoing ? perms.find(p => p.id === outgoing.target) : undefined

    const agentData    = agent.data as { harnessId: string }
    const providerData = provider.data as { providerId: string; model?: string; label?: string }
    const permData     = perm?.data as { skillId?: string } | undefined

    const harnessId = agentData.harnessId
    // Validate harness — only the sidecar engines can carry a CODE-tab session.
    // 'codex' agents are DELIBERATELY skipped here: workers ≠ engines (the CODE
    // toolbar has no Codex slot by design) — a Codex node runs ON the canvas
    // via graph:run-node instead.
    if (harnessId !== 'openclaude') {
      // Invalid harness — skip this agent with a warning toast (non-fatal)
      dispatchToast(t('scheduler.unknownHarness', { harness: agentData.harnessId }), 'info')
      continue
    }

    const isBankr = providerData.providerId === 'bankr'

    chains.push({
      harness:       harnessId,
      provider:      isBankr ? 'bankr' : 'default',
      providerLabel: (providerData.label as string | undefined) ?? providerData.providerId,
      bankrModel:    isBankr ? providerData.model : undefined,
      permission:    permData?.skillId,
      agentNodeId:   agent.id,
    })
  }

  if (chains.length === 0) {
    return {
      ok: false,
      error: t('scheduler.connectEdge'),
    }
  }

  return { ok: true, chains }
}
