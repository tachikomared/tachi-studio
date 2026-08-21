// apps/desktop/src/pages/nodes/serialization.ts
//
// Save / load .tachi-flow.json: saving goes through the nodes IPC into
// <userData>/nodes/, loading accepts a browser-picked File. The pure passes here
// (stable JSON, artifact-b64 strip, self-heal) are shared by every other seam
// that persists a graph — the ⇩ export and the localStorage autosave included.

import type { TachiFlow, TachiNode, TachiEdge } from './types'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Shape returned by nodes:save-flow IPC. */
export interface SaveFlowResult {
  ok:       boolean
  path?:    string
  filename?: string
  error?:   string
}

// ── Save ──────────────────────────────────────────────────────────────────────

export function serializeFlow(
  name: string,
  nodes: TachiNode[],
  edges: TachiEdge[],
): TachiFlow {
  return {
    version: 1,
    name,
    nodes,
    edges,
    savedAt: new Date().toISOString(),
  }
}

// ── Diff-friendly persistence (Rivet pattern, NODES-RESEARCH #11) ────────────
//
// The SAVED file must produce minimal, reviewable git diffs: nodes/edges in a
// stable id order (insertion order churns on copy/paste + undo), object keys
// sorted recursively (spread order churns), positions rounded to whole px
// (drag micro-noise otherwise touches every save). The RUN path keeps using
// serializeFlow directly — sorting there would be wasted work per node run.

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = sortKeysDeep(v)
    }
    return out
  }
  return value
}

function roundPosition<T extends { position?: { x: number; y: number } }>(n: T): T {
  if (!n.position) return n
  return { ...n, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }
}

// ── The artifact bytes that must not reach the FILE (FLF driver, finding 4) ──
//
// After one canvas run a 1.2 KB .tachi-flow.json measured 3751 KB: the renderer
// stamps `lastArtifacts` onto the media node (and `artifacts` onto its Output
// card) and each artifact carries `path` AND `b64` — so the whole clip went in,
// base64-inflated, twice, and was re-stringified by every autosave after that.
//
// `b64` earns its place at RUN time (the node card previews it with no disk
// round-trip, and main's resolveWiredImages hands it to the next stage), so
// serializeFlow keeps it. The FILE only needs the path, because every consumer
// already has a path-only route home: NodeRunUI's `fileUrl(path)` helper is the
// canonical one (`tachi-media://artifact/<path>` — the protocol main registered
// precisely because a localhost renderer cannot load file://), and main's
// resolveWiredImages falls back to readFileSync — the same move the
// Reference-Image node made when its inline data URLs became `filePath`.
//
// A pathless artifact KEEPS its bytes: for a small b64-only image the bytes are
// the result, and dropping them would be a delete dressed up as a saving.
//
// THREE seams answer to this rule, not one (review pass after 59c658a found the
// other two still fat): the FILE save (stableFlowJson), the ⇩ export
// (downloadTachiflow) and the localStorage canvas autosave (nodes.store's
// partialize). They all call the one pass below — hence the node-ARRAY entry
// point, which is what a zustand partialize actually holds.

/** Artifact fields this pass cares about; everything else travels verbatim. */
type SavedArtifact = { path?: unknown; b64?: unknown }

/** Node data keys that hold a produced-artifact list (media node / Output card). */
const ARTIFACT_KEYS = ['lastArtifacts', 'artifacts'] as const

/** True when the artifact's bytes are recoverable from disk without the b64. */
function hasUsablePath(a: SavedArtifact): boolean {
  return typeof a.path === 'string' && a.path.trim() !== ''
}

/**
 * Drop `b64` from every artifact in a NODE ARRAY that also carries an on-disk
 * path. This is the single implementation of the rule; every persistence seam
 * (file save, ⇩ export, localStorage autosave) goes through it or through the
 * flow-level wrapper below.
 * Pure: the input nodes (which the LIVE canvas is still rendering from) are
 * never mutated, and an array with nothing to strip is returned by IDENTITY so
 * a save that changes nothing still produces byte-identical JSON.
 */
export function stripNodesArtifactB64(nodes: TachiNode[]): TachiNode[] {
  let changed = false
  const out = nodes.map((n) => {
    const data = n.data as Record<string, unknown> | undefined
    if (!data) return n
    let nextData: Record<string, unknown> | null = null
    for (const key of ARTIFACT_KEYS) {
      const list = data[key]
      if (!Array.isArray(list)) continue
      let listChanged = false
      const slim = list.map((a) => {
        if (!a || typeof a !== 'object') return a
        const art = a as SavedArtifact
        if (art.b64 === undefined || !hasUsablePath(art)) return a
        listChanged = true
        const { b64: _drop, ...rest } = a as Record<string, unknown>
        return rest
      })
      if (!listChanged) continue
      // Fold onto the accumulator, not onto `data` — a node carrying BOTH
      // lastArtifacts AND artifacts must keep the first key's slimming.
      nextData = { ...(nextData ?? data), [key]: slim }
    }
    if (!nextData) return n
    changed = true
    return { ...n, data: nextData } as TachiNode
  })
  return changed ? out : nodes
}

/** Flow-level wrapper around stripNodesArtifactB64 — identity when nothing changed. */
export function stripArtifactB64(flow: TachiFlow): TachiFlow {
  const nodes = stripNodesArtifactB64(flow.nodes)
  return nodes === flow.nodes ? flow : { ...flow, nodes }
}

/** Deterministic JSON for SAVING a flow — same graph in, byte-identical out. */
export function stableFlowJson(flow: TachiFlow): string {
  // Self-healing round-trip (NODES-RESEARCH #3): a node remapped to 'unknown' on
  // LOAD (its real type isn't registered in this build) is restored to its
  // original type on SAVE, so a flow that opened here writes back byte-for-byte
  // what came in — lossless even for node kinds this build can't render.
  // …and the produced-artifact bytes are left behind here (see above): a graph
  // is a graph, not a video container.
  const restored = stripArtifactB64(restoreUnknownNodeTypes(flow))
  const stable = {
    ...restored,
    nodes: [...restored.nodes].map(roundPosition).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...restored.edges].sort((a, b) => a.id.localeCompare(b.id)),
  }
  return JSON.stringify(sortKeysDeep(stable), null, 2)
}

// ── Self-healing flow load (NODES-RESEARCH #3) ────────────────────────────────
//
// A shared / old / hand-edited flow must never open broken. sanitizeFlow is a
// PURE pass run at EVERY load seam (JSON import via parseFlow; app-storage
// rehydrate in nodes.store) that repairs three classes of breakage WITHOUT
// dropping user data:
//   (a) a node whose `type` this build doesn't register → remapped to 'unknown'
//       (rendered as a preserved-but-inert tile); the real type is stashed in
//       data.originalType and every other field is kept verbatim, so a later
//       SAVE can restore it (restoreUnknownNodeTypes) → lossless round-trip.
//   (b) an edge whose source/target node is missing → dropped (a dangling edge
//       otherwise renders as a stray line and breaks auto-layout).
//   (c) a node missing its id or position → id generated, position → {x:0,y:0}.
// A structurally-valid flow passes through unchanged (healthy nodes keep their
// object identity), so this is safe to run on every load.

/**
 * Node types FlowCanvas registers in its `nodeTypes` map — keep in sync with it.
 * 'unknown' is the fallback tile a remapped node lands on (and is itself a
 * registered type, so a re-loaded already-healed node is left alone).
 */
export const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set([
  'provider', 'agent', 'skill', 'folder', 'internet', 'mcp',
  'media', 'rife', 'prompt', 'text', 'imageref', 'output', 'note', 'subflow', 'webhook', 'unknown',
])

let _healSeq = 0
function healedNodeId(): string {
  return `node-healed-${Date.now()}-${++_healSeq}`
}

/**
 * Repair a flow so it can never open broken. Pure — returns a new flow; healthy
 * nodes/edges keep their identity. See the block comment above for the rules.
 */
export function sanitizeFlow(flow: TachiFlow): TachiFlow {
  const rawNodes = Array.isArray(flow.nodes) ? flow.nodes : []
  const rawEdges = Array.isArray(flow.edges) ? flow.edges : []

  const nodes: TachiNode[] = []
  for (const n of rawNodes) {
    // Non-object garbage (null, a string, a number) can't be a node — drop it.
    if (!n || typeof n !== 'object') continue
    const node = n as TachiNode & { id?: unknown; type?: unknown; position?: { x?: unknown; y?: unknown } }
    const needsId  = !(typeof node.id === 'string' && node.id)
    const pos      = node.position
    const goodPos  = !!pos && typeof pos === 'object'
      && typeof (pos as { x?: unknown }).x === 'number'
      && typeof (pos as { y?: unknown }).y === 'number'
    const type     = node.type
    const knownType = typeof type === 'string' && KNOWN_NODE_TYPES.has(type)

    // Fast path: a fully-valid node passes through untouched (same reference).
    if (!needsId && goodPos && knownType) { nodes.push(n as TachiNode); continue }

    const id       = needsId ? healedNodeId() : (node.id as string)
    const position = goodPos ? (pos as { x: number; y: number }) : { x: 0, y: 0 }

    if (!knownType) {
      // (a) unknown/unregistered type — preserve the original + all data verbatim.
      const originalType = typeof type === 'string' ? type : String(type ?? '')
      const data = { ...((node.data as Record<string, unknown>) ?? {}), originalType }
      nodes.push({ ...node, id, type: 'unknown', position, data } as TachiNode)
    } else {
      nodes.push({ ...node, id, position } as TachiNode)
    }
  }

  // (b) drop dangling edges — both endpoints must be strings resolving to a node
  // (this also drops null / non-object garbage edges).
  const ids = new Set(nodes.map((n) => n.id))
  const edges = rawEdges.filter((e): e is TachiEdge => {
    if (!e || typeof e !== 'object') return false
    const { source, target } = e as { source?: unknown; target?: unknown }
    return typeof source === 'string' && ids.has(source)
      && typeof target === 'string' && ids.has(target)
  })

  // (d) SUBFLOWS v1 (NODES-RESEARCH #8) — enforce the collapse invariant so a
  // loaded flow never opens with a stale proxy or an orphaned-invisible node.
  const normalized = normalizeSubflows(nodes, edges)
  return { ...flow, nodes: normalized.nodes, edges: normalized.edges }
}

// ── Subflow collapse invariant (NODES-RESEARCH #8) ────────────────────────────
//
// A "subflow" proxy node stands in for a set of collapsed children: those
// children (and every edge touching one) carry `hidden: true` so React Flow
// draws the group as one box. This pure pass — run at every load seam via
// sanitizeFlow — re-establishes the single invariant the whole feature rests on:
//
//   • a node is hidden  ⟺  it is a child of some SURVIVING subflow proxy
//   • an edge is hidden ⟺  it touches a hidden node
//
// Consequences that make load robust:
//   • a subflow whose childIds no longer resolve to ANY node is dropped, and its
//     formerly-hidden members are auto-revealed (graceful missing-children) — so
//     a broken/edited flow can never strand nodes permanently invisible;
//   • a subflow's childIds are pruned to the ids that still exist (honest count);
//   • the pass is idempotent, so save → load → save round-trips byte-for-byte.
// Flows with no subflow proxy and no hidden flag return unchanged (same refs).

/** Set/clear an element's `hidden` flag, preserving object identity when the
 *  desired state already holds (so unaffected nodes keep their reference). */
function setHiddenFlag<T extends { hidden?: boolean }>(el: T, hidden: boolean): T {
  const cur = el.hidden === true
  if (hidden) return cur ? el : ({ ...el, hidden: true } as T)
  // Want visible: drop the `hidden` key entirely (restores the pre-collapse shape).
  if (!('hidden' in el) || el.hidden === undefined) return el
  const { hidden: _drop, ...rest } = el
  return rest as T
}

function existingChildIds(node: TachiNode, nodeIds: ReadonlySet<string>): string[] {
  const raw = (node.data as { childIds?: unknown }).childIds
  return Array.isArray(raw)
    ? raw.filter((c): c is string => typeof c === 'string' && nodeIds.has(c))
    : []
}

export function normalizeSubflows(nodes: TachiNode[], edges: TachiEdge[]): { nodes: TachiNode[]; edges: TachiEdge[] } {
  const hasSubflow = nodes.some(n => n.type === 'subflow')
  const hasHidden =
    nodes.some(n => (n as { hidden?: boolean }).hidden) ||
    edges.some(e => (e as { hidden?: boolean }).hidden)
  // Nothing collapsed and nothing hidden → untouched (preserves object identity).
  if (!hasSubflow && !hasHidden) return { nodes, edges }

  const nodeIds = new Set(nodes.map(n => n.id))
  const hiddenNodeIds = new Set<string>()
  for (const n of nodes) {
    if (n.type !== 'subflow') continue
    for (const c of existingChildIds(n, nodeIds)) hiddenNodeIds.add(c)
  }

  const outNodes: TachiNode[] = []
  for (const n of nodes) {
    if (n.type === 'subflow') {
      const childIds = existingChildIds(n, nodeIds)
      // Graceful missing-children: a proxy wrapping nothing is dropped; its
      // (former) children are recovered below by the node-visibility invariant.
      if (childIds.length === 0) continue
      const orig = (n.data as { childIds?: unknown }).childIds
      const same = Array.isArray(orig) && orig.length === childIds.length && childIds.every((c, i) => c === orig[i])
      const visible = setHiddenFlag(n, false) // a proxy is never itself hidden
      outNodes.push(same ? visible : ({ ...visible, data: { ...visible.data, childIds } } as TachiNode))
      continue
    }
    outNodes.push(setHiddenFlag(n, hiddenNodeIds.has(n.id)))
  }

  const outEdges = edges.map(e =>
    setHiddenFlag(e, hiddenNodeIds.has(e.source) || hiddenNodeIds.has(e.target)),
  )

  return { nodes: outNodes, edges: outEdges }
}

/**
 * Inverse of sanitizeFlow's type remap: turn each 'unknown' node back into its
 * data.originalType (removing the originalType marker) so a SAVE/EXPORT
 * round-trips losslessly. A flow with no healed nodes returns unchanged.
 */
export function restoreUnknownNodeTypes(flow: TachiFlow): TachiFlow {
  let changed = false
  const nodes = flow.nodes.map((n) => {
    if (n.type !== 'unknown') return n
    const data = n.data as { originalType?: unknown } | undefined
    const originalType = data?.originalType
    if (typeof originalType !== 'string' || !originalType) return n
    changed = true
    const rest = { ...(n.data as Record<string, unknown>) }
    delete rest['originalType']
    return { ...n, type: originalType, data: rest } as TachiNode
  })
  return changed ? { ...flow, nodes } : flow
}

/**
 * Save the flow to <userData>/nodes/ via main-process IPC.
 * Returns a SaveFlowResult with ok/path/error.
 */
export async function saveFlowToApp(
  name: string,
  nodes: TachiNode[],
  edges: TachiEdge[],
): Promise<SaveFlowResult> {
  const flow = serializeFlow(name, nodes, edges)
  const json = stableFlowJson(flow)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).tachi?.nodes
  if (!api?.saveFlow) {
    return { ok: false, error: 'nodes IPC not available' }
  }
  return api.saveFlow(name, json) as Promise<SaveFlowResult>
}

// There is no browser-download twin of saveFlowToApp here any more. The old
// `downloadFlow` was a "kept as a fallback" export with ZERO call sites — and
// the review pass after 59c658a found it doing real damage as dead code: the
// EVERY-SAVE-SEAM test pinned its `new Blob([stableFlowJson(flow)]` line, so
// the suite reported the export seam green while the LIVE ⇩ (FlowsRail →
// downloadTachiflow) was still writing the un-stripped graph. One ⇩, one
// implementation: templates/tachiflow.ts.

// ── Load ──────────────────────────────────────────────────────────────────────

export class FlowParseError extends Error {}

export function parseFlow(raw: unknown): TachiFlow {
  if (typeof raw !== 'object' || raw === null) {
    throw new FlowParseError('File is not a JSON object')
  }
  const obj = raw as Record<string, unknown>

  if (obj['version'] !== 1) {
    throw new FlowParseError(`Unsupported flow version: ${obj['version']}`)
  }
  if (!Array.isArray(obj['nodes'])) {
    throw new FlowParseError('Missing nodes array')
  }
  if (!Array.isArray(obj['edges'])) {
    throw new FlowParseError('Missing edges array')
  }

  // JSON-import load seam — self-heal before the graph reaches the canvas so an
  // old / shared / hand-edited file never opens broken (NODES-RESEARCH #3).
  return sanitizeFlow({
    version:  1,
    name:     typeof obj['name'] === 'string' ? obj['name'] : 'Imported flow',
    nodes:    obj['nodes'] as TachiNode[],
    edges:    obj['edges'] as TachiEdge[],
    savedAt:  typeof obj['savedAt'] === 'string' ? obj['savedAt'] : new Date().toISOString(),
  })
}

/**
 * Read a File object chosen via <input type="file"> and parse it.
 * Rejects with FlowParseError on bad content.
 */
export function readFlowFile(file: File): Promise<TachiFlow> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const text = e.target?.result
        if (typeof text !== 'string') { reject(new FlowParseError('Failed to read file')); return }
        const parsed = JSON.parse(text)
        resolve(parseFlow(parsed))
      } catch (err) {
        if (err instanceof FlowParseError) reject(err)
        else reject(new FlowParseError(`JSON parse failed: ${String(err)}`))
      }
    }
    reader.onerror = () => reject(new FlowParseError('FileReader error'))
    reader.readAsText(file)
  })
}

