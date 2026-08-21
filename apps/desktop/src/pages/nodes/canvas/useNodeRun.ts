// apps/desktop/src/pages/nodes/canvas/useNodeRun.ts
//
// Per-node run ("execute step") for the canvas — shared by MediaNode and
// AgentNode (#3). Builds the full TachiFlow from the live nodes.store (so the
// node's prompt/{{node:<id>}} tokens resolve against upstream `lastOutput`s
// without re-running upstream), calls window.tachi.nodes.runNode(flow, nodeId),
// and stamps { lastOutput, lastArtifacts } back onto the node via updateNodeData.
//
// The main-process handler emits 'graph:node-active' (subscribed elsewhere, e.g.
// NodesPage) just like a full graph run, so the running node still glows. Async
// media (video/music) polling is handled in main — runNode resolves once settled.
//
// FAN-OUT xN (flowith batch quantity): runNode(count) runs the SAME single-run
// path `count` times SEQUENTIALLY. count === 1 is today's exact behavior. For
// count > 1 each iteration lands a SEPARATE sibling output card (keyed on the
// source + variant index — see fanout.ts / upsertOutputNode) fanned out in a row
// beside the source; MEDIA nodes vary a FIXED seed per variant so the siblings
// differ — and a SEEDLESS one varies through a per-variant runSeed instead (the
// engine's own default is a fixed 42, so nothing else would).
// Cancel (cancelFanout) stops cleanly AFTER the current variant.
//
// Returned `run` is a small state machine the node card renders an inline
// preview + spinner from. Pure renderer glue: no token logic here (that lives in
// the compiler + nodeRefs); we just shuttle the flow + result.

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { Artifact } from '../../../types/electron'
import { useConfirm } from '../../../components/ConfirmProvider'
import { useNodesStore, type OutputVariant } from '../store/nodes.store'
import { estimateNodeRunCost } from '../run-cost'
import { useMediaStore } from '../../../store/media.store'
import { useNodesRunStore, nodeRunOf, type NodeRunState, type FanoutProgress } from '../../../store/nodesRun.store'
import { useRunTraceStore } from '../../../store/run-trace.store'
import { serializeFlow } from '../serialization'
import { collectWriteConsentTargets, ensureCodexWriteConsent } from './codexWriteGate'
import { retryPolicy, runWithRetry } from '../retryPolicy'
import { fanoutSeed } from './fanout'
// The gallery entry's seed provenance — the same stamp MediaPage applies.
import { stampLocalSeed } from '../../media/localGenParams'
// A POST-PROCESS node's result is not a generation, so it cannot go through
// addNodeRunArtifacts (which files an entry under the node's model + params).
// It lands as what it is, through the SAME builder the gallery card uses.
import { canvasInterpolatedGalleryEntry } from '../../media/mediaHelpers'
// …resolved against the SAME wired-clip reader the rife card and main use.
import { rifeSourcePath } from '../rifeNode'
import type { MediaNodeData } from '../types'

/** The shape window.tachi.nodes.runNode resolves to (mirrors the IPC contract). */
type RunNodeRes =
  | { ok: true; text?: string; artifacts?: Artifact[] }
  | { ok: false; error: string }

// The run state types MOVED to src/store/nodesRun.store.ts (FLF driver, finding
// 3): they now describe a module-scoped slice that outlives this hook's
// component, so a tab switch cannot throw a 44-minute render's status away.
// Re-exported here because every node card imports them from this door.
export type { NodeRunState, FanoutProgress } from '../../../store/nodesRun.store'

export interface UseNodeRun {
  run: NodeRunState
  /** Trigger the per-node run. No-op while already running. `count > 1` fans out
   *  into `count` sequential sibling runs (default 1 = today's single run). */
  runNode: (count?: number) => Promise<void>
  /** Clear the inline result back to idle (does NOT touch persisted node data). */
  reset: () => void
  /** Ask an in-flight fan-out to stop after the current variant finishes. */
  cancelFanout: () => void
  /** Live fan-out progress (active=false when running a single node). */
  fanout: FanoutProgress
}

/**
 * Per-node run hook. On success stamps the node's `lastOutput` (text — STT
 * transcript / agent answer) and `lastArtifacts` so downstream token previews
 * and inline media render. `pinned` nodes keep whatever output they already had
 * (a pinned node is a fixed reference source), so re-running a pinned node still
 * refreshes it — pinning only affects how DOWNSTREAM runs treat this node.
 */
export function useNodeRun(nodeId: string, opts?: { outputTargetId?: string }): UseNodeRun {
  // When set (the ↻ Regenerate button ON a result card), the run refreshes THAT
  // card in place instead of appending a new one.
  const outputTargetId = opts?.outputTargetId
  const updateNodeData = useNodesStore(s => s.updateNodeData)
  const confirm = useConfirm()
  // 'nodes' stays the default namespace (every unprefixed key below is one of
  // its own); 'media' rides along so a derived clip captured HERE carries the
  // very sentence the Media tab writes, rather than a second translation of it.
  const { t } = useTranslation(['nodes', 'media'])
  // THE RUN LIVES IN THE STORE, not in this component (FLF driver, finding 3).
  // Both selectors return a frozen shared object for a node that never ran, so
  // they are reference-stable and this hook re-renders only on a real change.
  const run    = useNodesRunStore(s => nodeRunOf(s, nodeId).state)
  const fanout = useNodesRunStore(s => nodeRunOf(s, nodeId).fanout)

  /** Write this node's slice. Always through the store — a card that remounts
   *  mid-run must find the state its predecessor left. */
  const patch = useCallback(
    (p: Parameters<ReturnType<typeof useNodesRunStore.getState>['setNodeRun']>[1]) =>
      useNodesRunStore.getState().setNodeRun(nodeId, p),
    [nodeId],
  )
  const setRun = useCallback((state: NodeRunState) => patch({ state }), [patch])
  const setFanout = useCallback((f: FanoutProgress) => patch({ fanout: f }), [patch])

  const reset = useCallback(() => useNodesRunStore.getState().resetNodeRun(nodeId), [nodeId])
  const cancelFanout = useCallback(() => useNodesRunStore.getState().requestNodeStop(nodeId), [nodeId])

  // One variant execution (also the whole of a single non-fan-out run). Reuses
  // the exact single-run path: build flow → runNode (with retry) → stamp node +
  // drop/refresh the result card. `variant` (present only for N>1) routes the
  // card to a fanned-out sibling slot. Returns true on a successful run.
  //
  // `runSeed` is the fan-out's per-variant invocation entropy (see doRun). A
  // SINGLE run passes none and main invents none — that is the reproducibility
  // contract of a lone RUN button, and preload drops the argument when it is
  // undefined, so the IPC payload of a single run is byte-identical to before.
  const runOnce = useCallback(async (variant?: OutputVariant, runSeed?: string): Promise<boolean> => {
    const api = window.tachi?.nodes
    if (!api?.runNode) {
      setRun({ kind: 'error', error: 'Graph runtime IPC is not available.' })
      return false
    }
    setRun({ kind: 'running' })
    // Trace: one span per per-node run (RUN / ↻ REGEN / each fan-out variant) —
    // lights up the Trace console tab. Media nodes are tool-ish; prompt/agent are 'agent'.
    const trace = useRunTraceStore.getState()
    const srcNode0 = useNodesStore.getState().nodes.find(n => n.id === nodeId)
    const spanId = trace.startSpan({
      name: (srcNode0?.data as { label?: string } | undefined)?.label || srcNode0?.type || 'node',
      kind: srcNode0?.type === 'media' ? 'tool' : 'agent',
      attrs: {
        nodeId, type: srcNode0?.type ?? '?',
        via: outputTargetId ? 'regen' : (variant ? 'fanout' : 'run'),
        ...(variant ? { variant: variant.index + 1, variants: variant.count } : {}),
      },
    })
    let spanAttrs: Record<string, unknown> = { ok: false }
    try {
      // Snapshot the live canvas (NOT a subscribed selector) so we always send
      // the freshest upstream lastOutputs without re-rendering on every edit.
      const { flowName, nodes, edges } = useNodesStore.getState()
      const flow = serializeFlow(flowName, nodes, edges)
      // RETRY-ON-FAIL: run this node up to (retries + 1) times, waiting
      // retryDelayMs between failed attempts. A thrown IPC error counts as a
      // failed attempt (so a transient network blip retries too). The running
      // node's status line shows "retry N/M" from the 2nd attempt onward. Only
      // the FINAL outcome reaches the success/error handling below.
      const policy = retryPolicy(srcNode0?.data)
      const { outcome, attempts } = await runWithRetry<RunNodeRes>({
        retries: policy.retries,
        retryDelayMs: policy.retryDelayMs,
        onAttemptStart: (attempt, total) => {
          if (attempt > 1) setRun({ kind: 'running', attempt, attempts: total })
        },
        run: async () => {
          try {
            const r = (await api.runNode(flow, nodeId, runSeed)) as RunNodeRes
            return { ok: r.ok, value: r }
          } catch (err) {
            const e = err instanceof Error ? err.message : String(err)
            return { ok: false, value: { ok: false, error: e } as RunNodeRes }
          }
        },
      })
      const res = outcome.value
      if (res.ok) {
        const artifacts = res.artifacts ?? []
        spanAttrs = {
          ok: true, attempts, chars: (res.text ?? '').length, artifacts: artifacts.length,
          ...(variant ? { variant: variant.index + 1 } : {}),
        }
        setRun({ kind: 'done', artifacts, ...(res.text != null ? { text: res.text } : {}) })
        // Cache onto the node for inline preview + downstream token resolution.
        // NODES-RESEARCH #4: stamp the per-run cost estimate (null = no chip).
        const st0 = useNodesStore.getState()
        // The BASIS travels with the number: "$0" alone cannot tell local from
        // free-remote, and a null cost means "unpriced", not "free".
        const est = estimateNodeRunCost(st0.nodes, st0.edges, nodeId, res.text ?? '')
        const estUsd = est.usd
        updateNodeData(nodeId, {
          lastOutput: res.text ?? '',
          lastArtifacts: artifacts,
          lastCostUsd: estUsd ?? undefined,
          lastCostBasis: est.basis ?? undefined,
        })
        // flowith-style: drop/refresh a RESULT CARD on the canvas, wired from
        // this node, so the answer persists as its own node you can branch from.
        const srcNode = useNodesStore.getState().nodes.find(n => n.id === nodeId)
        const sourceLabel = (srcNode?.data as { label?: string } | undefined)?.label
        useNodesStore.getState().upsertOutputNode(nodeId, {
          kind: artifacts.length > 0 ? 'media' : 'text',
          ...(res.text != null ? { text: res.text } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          ...(sourceLabel ? { sourceLabel } : {}),
          // Each variant freezes its OWN estimate onto its own card.
          ...(estUsd != null ? { estUsd } : {}),
          ...(est.basis ? { estBasis: est.basis } : {}),
        }, outputTargetId, variant)
        // Capture into the persistent media gallery so the Artifacts library is
        // truly "everything generated" — but ONLY for media nodes (agent/prompt
        // runs share this hook and don't produce gallery media). Deduped on the
        // store side by artifact path-set, so a re-run of the same node is a no-op.
        if (artifacts.length > 0) {
          const node = useNodesStore.getState().nodes.find(n => n.id === nodeId)
          if (node?.type === 'media') {
            const d = node.data as MediaNodeData
            // The LOCAL engine's REAL seed rides the artifact (main sets it only
            // when the engine reported one, never -1). Stamp it into the params
            // snapshot the gallery keeps: for a .webm the entry IS the provenance
            // (no tEXt chunk to re-read), and without this a Run-all/fan-out clip
            // the user liked could never be Remixed back into existence — the
            // derived seed was a throwaway uuid three layers up.
            const engineSeed  = artifacts.find(a => typeof a.seed === 'number')?.seed
            const entryParams = stampLocalSeed({ ...(d.params ?? {}) }, engineSeed)
            useMediaStore.getState().addNodeRunArtifacts({
              id:        globalThis.crypto.randomUUID(),
              model:     d.model ?? '',
              modality:  d.modality,
              prompt:    typeof d.prompt === 'string' ? d.prompt : '',
              artifacts,
              ...(res.text != null ? { text: res.text } : {}),
              ...(Object.keys(entryParams).length > 0 ? { params: entryParams } : {}),
            })
          } else if (node?.type === 'rife') {
            // A DERIVED FILE THAT IS NOT IN THE GALLERY DOES NOT EXIST — and the
            // driver proved this half of it twice: `-rife2x.mp4` reached the
            // Output card and the disk, and the gallery held no rife entry,
            // because the capture above is gated on a MEDIA node.
            //
            // It cannot go through that gate: this node has no model, no prompt
            // and no params, and filing the clip under the source checkpoint's
            // would attribute frames no generator produced. So it lands through
            // the builder the Media-tab card already uses, whose entry says what
            // the frames were made FROM and by WHAT.
            const st = useNodesStore.getState()
            const src = rifeSourcePath(nodeId, st.nodes, st.edges)
            const gallery = useMediaStore.getState().gallery
            const derived = canvasInterpolatedGalleryEntry({
              ...(src ? { sourcePath: src } : {}),
              artifacts,
              gallery,
              now:   Date.now(),
              label: name => t('media:rife.derived', { source: name }),
            })
            // null = this exact file is already a row. One file, one entry,
            // however many surfaces report it.
            if (derived) useMediaStore.getState().addEntry(derived)
          }
        }
        return true
      } else {
        spanAttrs = { ok: false, attempts, error: res.error || 'Run failed.' }
        setRun({ kind: 'error', error: res.error || 'Run failed.' })
        return false
      }
    } catch (err) {
      spanAttrs = { ...spanAttrs, ok: false, error: err instanceof Error ? err.message : String(err) }
      setRun({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
      return false
    } finally {
      trace.endSpan(spanId, spanAttrs)
    }
  }, [nodeId, updateNodeData, outputTargetId, setRun, t])

  const doRun = useCallback(async (count = 1) => {
    // The double-run guard is READ FROM THE STORE: it used to be a ref, which a
    // tab switch reset — so returning to the canvas mid-render and pressing RUN
    // again started a SECOND run on top of the first.
    if (nodeRunOf(useNodesRunStore.getState(), nodeId).inflight) return
    const api = window.tachi?.nodes
    if (!api?.runNode) {
      setRun({ kind: 'error', error: 'Graph runtime IPC is not available.' })
      return
    }
    // CLAIM THE RUN BEFORE THE FIRST AWAIT.
    //
    // This used to sit AFTER the codex-consent dialog below, which is the exact
    // window the flag exists to cover: while that dialog was up the guard above
    // still read false, so a second RUN click went straight through and two runs
    // started on one node. Everything after this line — the consent gate
    // included — is inside the try whose `finally` clears it, so a CANCEL is
    // still a clean no-op rather than a wedged node.
    //
    // …and the stop flag is cleared HERE, at the start of the run it belongs to,
    // so a STOP pressed during the previous fan-out cannot leak into this one.
    patch({ inflight: true, stopRequested: false })
    const n = Math.max(1, Math.floor(count) || 1)
    try {
      // CODEX WRITE-MODE consent gate (single-node RUN / fan-out): if THIS node is
      // a write-enabled codex node with a wired folder, get one-per-session
      // explicit consent ONCE before running. Cancel → clean no-op.
      {
        const st0 = useNodesStore.getState()
        const targets = collectWriteConsentTargets(st0.nodes, st0.edges, [nodeId])
        const okToRun = await ensureCodexWriteConsent(targets, confirm, t)
        if (!okToRun) return
      }
      // Single run — today's exact path (no variant, no fan-out state, and NO
      // runSeed: a lone RUN stays reproducible by inventing nothing).
      if (n <= 1) {
        await runOnce()
        return
      }
      // FAN-OUT xN — run the node N times sequentially into N sibling cards.
      const node0 = useNodesStore.getState().nodes.find(x => x.id === nodeId)
      const isMedia = node0?.type === 'media'
      // Capture the media node's ORIGINAL params + seed once: every variant's
      // seed is derived from the ORIGINAL base (base+i, a clean 0..N-1 fan) —
      // never from the previous iteration's already-bumped value — and the
      // original params are restored afterwards so a fan-out never drifts the
      // persisted config (only if we actually touched the seed).
      const originalParams = isMedia ? (node0!.data as MediaNodeData).params : undefined
      const originalSeed = originalParams?.seed
      let seedTouched = false
      // ONE entropy draw for the whole click — the fan-out's answer to the
      // SEEDLESS case (review of the FLF fix lane, finding 3).
      //
      // fanoutSeed below varies an EXPLICIT seed and correctly returns null for
      // an absent one, on the premise that "the engine rerolls it each run". That
      // premise holds for the cloud providers and fails for the one provider
      // fan-out exists for: sd.cpp's default seed is a FIXED 42 (see
      // graph-to-agentkit's deriveStageSeed note), and a canvas media node is
      // born with `params: {}` — so ×4 on a fresh node rendered FOUR IDENTICAL
      // images and the chip promised variation it could not deliver.
      //
      // Rather than a second seeding scheme, this reuses the Run-all wire: one
      // draw here (outside the loop, so the variants of ONE click decorrelate
      // while two clicks decorrelate from each other), a per-variant value on the
      // IPC, and main's deriveStageSeed does the fanning. An explicit params.seed
      // still wins there byte-for-byte, so fanoutSeed keeps owning that case.
      const fanoutEntropy = globalThis.crypto.randomUUID()
      setFanout({ active: true, done: 0, total: n })
      try {
        for (let i = 0; i < n; i++) {
          // Cooperative cancel: the in-flight variant already finished — bail
          // BEFORE starting the next one (stop-after-current-variant). Read off
          // the STORE, so a STOP pressed on a card that remounted mid-fan-out
          // still reaches this loop (its component's ref died with it).
          if (nodeRunOf(useNodesRunStore.getState(), nodeId).stopRequested) break
          setFanout({ active: true, done: i, total: n })
          // MEDIA nodes with a FIXED seed → vary it per variant so the siblings
          // differ (sd.cpp "one prompt, four seeds"). A random/absent seed is
          // left alone HERE — bumping a `-1` would silently pin what the user
          // asked the engine to reroll; the absent case is handled by the
          // per-variant runSeed on the call below instead.
          if (isMedia) {
            const newSeed = fanoutSeed(originalSeed, i)
            if (newSeed != null) {
              updateNodeData(nodeId, { params: { ...originalParams, seed: newSeed } })
              seedTouched = true
            }
          }
          await runOnce({ index: i, count: n }, `${fanoutEntropy}#v${i}`)
        }
      } finally {
        if (seedTouched) updateNodeData(nodeId, { params: originalParams })
        setFanout({ active: false, done: n, total: n })
      }
    } finally {
      patch({ inflight: false })
    }
  }, [nodeId, updateNodeData, confirm, t, runOnce, patch, setFanout])

  return { run, runNode: doRun, reset, cancelFanout, fanout }
}
