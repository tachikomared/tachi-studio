// apps/desktop/src/pages/nodes/flowDiff.ts
//
// Structural diff between two saved flows (A1, NODES-RESEARCH-2026-07-26).
//
// n8n 2.13 ships a side-by-side two-canvas diff; we adopt the INFORMATION, not
// the rendering — a flat list of "what changed" is what users actually read off
// that view, and it costs one pure function instead of a second canvas.
//
// Input is two `stableFlowJson` strings (see serialization.ts): keys sorted
// deep, nodes/edges in id order, positions rounded. That makes value comparison
// order-independent and drag-noise-free before we even start.
//
// Deliberately NOT diffed:
//   • node position — stableFlowJson already rounds it, and a moved node is not
//     a changed node (it would swamp every real edit);
//   • the run-state keys a run stamps onto node.data (`lastOutput` & friends are
//     documented transient in types.ts, but they DO ride along in the saved
//     file, so ignoring them here is what keeps a diff about the user's edits);
//   • node/edge ordering, `hidden` and other view-only flags.
//
// Tolerant by design: this feeds a read-only drawer, so malformed / truncated
// JSON yields an EMPTY side rather than an exception the UI has to model.

// ── Types ─────────────────────────────────────────────────────────────────────

/** A node as the diff identifies it in the UI. */
export interface DiffNodeRef {
  id:    string
  type:  string
  /** `data.label` when present — the rail shows this, not the raw id. */
  label: string
}

/** A node present on both sides whose type or params differ. */
export interface DiffNodeChange extends DiffNodeRef {
  /** Changed `data` keys, sorted; `type` is listed when the node type itself changed. */
  params: string[]
}

export interface DiffEdgeRef {
  id:     string
  source: string
  target: string
}

export interface FlowDiff {
  nodesAdded:   DiffNodeRef[]
  nodesRemoved: DiffNodeRef[]
  nodesChanged: DiffNodeChange[]
  edgesAdded:   DiffEdgeRef[]
  edgesRemoved: DiffEdgeRef[]
}

/** Flat counts for the rail's one-line summary ("+2 nodes, -1 edge, 3 params"). */
export interface FlowDiffCounts {
  nodesAdded:   number
  nodesRemoved: number
  nodesChanged: number
  /** Total changed params across all changed nodes. */
  params:       number
  edgesAdded:   number
  edgesRemoved: number
  /** Every change except the param breakdown — 0 means the flows are equivalent. */
  total:        number
}

/**
 * `node.data` keys that carry RUN state rather than user intent. They are
 * documented transient in types.ts yet still land in the saved file, so a diff
 * that counted them would report "3 params changed" for merely re-running.
 */
export const VOLATILE_NODE_DATA_KEYS: ReadonlySet<string> = new Set([
  'lastOutput', 'lastArtifacts', 'lastError', 'pinned',
])

// ── Parsing (tolerant) ────────────────────────────────────────────────────────

interface ParsedNode {
  id:    string
  type:  string
  label: string
  data:  Record<string, unknown>
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Nodes by id. First occurrence wins so a duplicated id is deterministic. */
function readNodes(raw: unknown): Map<string, ParsedNode> {
  const out = new Map<string, ParsedNode>()
  if (!Array.isArray(raw)) return out
  for (const n of raw) {
    const node = asRecord(n)
    const id = node['id']
    if (typeof id !== 'string' || !id || out.has(id)) continue
    const data = asRecord(node['data'])
    out.set(id, {
      id,
      type:  typeof node['type'] === 'string' ? (node['type'] as string) : '',
      label: typeof data['label'] === 'string' ? (data['label'] as string) : '',
      data,
    })
  }
  return out
}

/** Edges by id. An edge with no usable id falls back to `<source>-><target>`,
 *  so hand-written / older files still diff instead of vanishing. */
function readEdges(raw: unknown): Map<string, DiffEdgeRef> {
  const out = new Map<string, DiffEdgeRef>()
  if (!Array.isArray(raw)) return out
  for (const e of raw) {
    const edge = asRecord(e)
    const source = typeof edge['source'] === 'string' ? (edge['source'] as string) : ''
    const target = typeof edge['target'] === 'string' ? (edge['target'] as string) : ''
    const rawId  = edge['id']
    const id = typeof rawId === 'string' && rawId ? rawId : `${source}->${target}`
    if (id === '->' || out.has(id)) continue
    out.set(id, { id, source, target })
  }
  return out
}

function parseFlowJson(json: string): { nodes: Map<string, ParsedNode>; edges: Map<string, DiffEdgeRef> } {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { nodes: new Map(), edges: new Map() }
  }
  const obj = asRecord(raw)
  return { nodes: readNodes(obj['nodes']), edges: readEdges(obj['edges']) }
}

// ── Value comparison ──────────────────────────────────────────────────────────

/** Structural equality. Object key ORDER is irrelevant, so this stays correct
 *  even for input that never went through stableFlowJson. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a !== 'object') return false
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false
  return true
}

/** Changed keys between two nodes: `data` keys (minus volatile run state) plus
 *  the pseudo-param `type` when the node type itself changed. Sorted. */
function changedParams(from: ParsedNode, to: ParsedNode): string[] {
  const params: string[] = []
  if (from.type !== to.type) params.push('type')
  const keys = new Set([...Object.keys(from.data), ...Object.keys(to.data)])
  for (const k of keys) {
    if (VOLATILE_NODE_DATA_KEYS.has(k)) continue
    if (!deepEqual(from.data[k], to.data[k])) params.push(k)
  }
  return params.sort()
}

// ── Diff ──────────────────────────────────────────────────────────────────────

/**
 * Diff two `stableFlowJson` strings. Direction matters: `added` means present
 * in `toJson` and not in `fromJson`, so `diffFlows(revision, current)` reads as
 * "what changed since that revision".
 *
 * Nodes are matched by id (which is exactly why n8n 2.28's "preserve node ids
 * when the AI edits a workflow" rule matters to us — a regenerated id turns one
 * param edit into an add + a remove).
 */
export function diffFlows(fromJson: string, toJson: string): FlowDiff {
  const from = parseFlowJson(fromJson)
  const to   = parseFlowJson(toJson)

  const nodesAdded:   DiffNodeRef[]    = []
  const nodesRemoved: DiffNodeRef[]    = []
  const nodesChanged: DiffNodeChange[] = []

  for (const [id, node] of to.nodes) {
    const before = from.nodes.get(id)
    if (!before) { nodesAdded.push({ id, type: node.type, label: node.label }); continue }
    const params = changedParams(before, node)
    if (params.length > 0) nodesChanged.push({ id, type: node.type, label: node.label, params })
  }
  for (const [id, node] of from.nodes) {
    if (!to.nodes.has(id)) nodesRemoved.push({ id, type: node.type, label: node.label })
  }

  const edgesAdded:   DiffEdgeRef[] = []
  const edgesRemoved: DiffEdgeRef[] = []
  for (const [id, edge] of to.edges)   if (!from.edges.has(id)) edgesAdded.push(edge)
  for (const [id, edge] of from.edges) if (!to.edges.has(id))   edgesRemoved.push(edge)

  return { nodesAdded, nodesRemoved, nodesChanged, edgesAdded, edgesRemoved }
}

export function diffCounts(diff: FlowDiff): FlowDiffCounts {
  const params = diff.nodesChanged.reduce((sum, n) => sum + n.params.length, 0)
  return {
    nodesAdded:   diff.nodesAdded.length,
    nodesRemoved: diff.nodesRemoved.length,
    nodesChanged: diff.nodesChanged.length,
    params,
    edgesAdded:   diff.edgesAdded.length,
    edgesRemoved: diff.edgesRemoved.length,
    total:
      diff.nodesAdded.length + diff.nodesRemoved.length + diff.nodesChanged.length +
      diff.edgesAdded.length + diff.edgesRemoved.length,
  }
}

/** True when the two flows are structurally equivalent (what the rail labels
 *  "no changes" — a revision identical to the state on screen). */
export function isEmptyFlowDiff(diff: FlowDiff): boolean {
  return diffCounts(diff).total === 0
}

// ── Relative age (drawer labels) ──────────────────────────────────────────────

export type AgeUnit = 'now' | 'minutes' | 'hours' | 'days'

/**
 * Coarse "how long ago" bucket for a revision timestamp, as a unit + count the
 * caller renders through i18n (never a pre-baked English string). Future or
 * unparseable timestamps collapse to `now` — a clock skew must not print
 * "-3m ago".
 */
export function relativeAge(tsMs: number, nowMs: number): { unit: AgeUnit; count: number } {
  const delta = nowMs - tsMs
  if (!Number.isFinite(delta) || delta < 60_000) return { unit: 'now', count: 0 }
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return { unit: 'minutes', count: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hours', count: hours }
  return { unit: 'days', count: Math.floor(hours / 24) }
}
