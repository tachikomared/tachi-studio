// apps/desktop/src/lib/nodeRefs.ts
//
// Reference-token utilities (RENDERER side) for the node editor's reference
// fields. Mirrors the compiler's token contract EXACTLY so the live "Resolves
// to:" preview an author sees in a ReferenceField matches what the
// graph-to-agentkit compiler produces at run time.
//
// TOKEN FORMAT (must stay byte-identical to the compiler — do NOT change):
//   {{node:<nodeId>}}
// whitespace-tolerant; id is any run of non-`}` chars. The compiler's resolver
// (graph-to-agentkit.ts → resolveTemplateTokens) replaces each token with that
// node's known output text, leaves unknown ids blank, and trims the result,
// fast-pathing to template.trim() when no '{{' is present. resolveTokens here
// reproduces that behaviour so client-side previews never drift from the server.
//
// Pure functions only — no store coupling, no IPC, no React. The node editor
// passes in the upstream node list (id + label + last-output preview); these
// helpers know nothing about the canvas store.

import type { Edge, Node } from '@xyflow/react'

/**
 * Matches `{{node:<id>}}` — id is any run of non-`}` chars, whitespace-tolerant.
 * IDENTICAL to graph-to-agentkit's NODE_TOKEN_RE. The `g` flag means callers
 * that reuse it across .exec() loops must reset .lastIndex; the helpers below
 * use it only with .replace()/fresh .exec loops that fully consume the string.
 */
const NODE_TOKEN_RE = /\{\{\s*node:\s*([^}]+?)\s*\}\}/g

/** True iff `s` contains at least one `{{node:<id>}}` reference token. */
export function hasNodeToken(s: string): boolean {
  return /\{\{\s*node:/.test(s)
}

/**
 * Extract the referenced node ids (in document order, including duplicates) from
 * a template. e.g. parseTokens("{{node:a}}, mood: {{ node:b }}") → ['a','b'].
 * Returns [] for a token-free template.
 */
export function parseTokens(template: string): { nodeId: string }[] {
  const out: { nodeId: string }[] = []
  if (!template.includes('{{')) return out
  // Fresh regex instance so concurrent callers don't trip over shared lastIndex.
  const re = new RegExp(NODE_TOKEN_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    out.push({ nodeId: m[1].trim() })
  }
  return out
}

/** Serialise a node id into its reference token: `{{node:<id>}}`. */
export function serializeToken(nodeId: string): string {
  return `{{node:${nodeId}}}`
}

/**
 * Resolve every `{{node:<id>}}` token in `template` against `outputsByNodeId`
 * (missing/unknown ids → ''). Returns the trimmed result. MIRRORS the compiler's
 * resolveTemplateTokens so the editor's live preview matches run-time output:
 *   - fast path: no '{{' → template.trim() (byte-identical modulo outer trim)
 *   - unknown token → '' (blank)
 *   - final result trimmed
 */
export function resolveTokens(template: string, outputsByNodeId: Map<string, string>): string {
  if (!template.includes('{{')) return template.trim()
  const re = new RegExp(NODE_TOKEN_RE.source, 'g')
  return template
    .replace(re, (_match, id: string) => {
      const text = outputsByNodeId.get(id.trim())
      return typeof text === 'string' ? text : ''
    })
    .trim()
}

/** A node that can be referenced from a downstream field. */
export interface UpstreamRef {
  id:       string
  label:    string
  /** Short single-line preview of the node's last output (for the preview map / dropdown hint). */
  preview?: string
}

/** Collapse a node's last output to a short single-line preview string. */
function previewOf(text: string | undefined, max = 80): string | undefined {
  if (typeof text !== 'string') return undefined
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (!oneLine) return undefined
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/**
 * Build the list of nodes whose output can be referenced from `currentNodeId`.
 *
 * "Connectable upstream" = every node that reaches `currentNodeId` by following
 * edges backwards (transitive predecessors), excluding the node itself. This is
 * deliberately broader than direct parents so an author can pull a value from
 * anywhere earlier in the chain (matching the token model, where any id is valid).
 *
 * Each entry carries the node's id, a human label (data.label ?? type ?? id),
 * and a short preview of its `lastOutput` (data.lastOutput) when present, so the
 * caller can both list connectables and feed a preview map into resolveTokens.
 *
 * Pure: operates on the passed nodes/edges arrays; no store/React Flow coupling.
 */
export function listUpstreamRefs(
  currentNodeId: string,
  nodes: Node[],
  edges: Edge[],
): UpstreamRef[] {
  // adjacency: target → its direct sources
  const directSources = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!e.source || !e.target) continue
    let set = directSources.get(e.target)
    if (!set) { set = new Set(); directSources.set(e.target, set) }
    set.add(e.source)
  }

  // BFS backwards from currentNodeId over predecessors.
  const reachable = new Set<string>()
  const queue: string[] = [currentNodeId]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    const srcs = directSources.get(cur)
    if (!srcs) continue
    for (const s of srcs) {
      if (s === currentNodeId || reachable.has(s)) continue
      reachable.add(s)
      queue.push(s)
    }
  }

  const byId = new Map(nodes.map(n => [n.id, n]))
  const out: UpstreamRef[] = []
  for (const id of reachable) {
    const n = byId.get(id)
    if (!n) continue
    const data = (n.data ?? {}) as { label?: unknown; lastOutput?: unknown }
    const label =
      (typeof data.label === 'string' && data.label.trim()) ||
      (typeof n.type === 'string' && n.type) ||
      id
    out.push({
      id,
      label,
      preview: previewOf(typeof data.lastOutput === 'string' ? data.lastOutput : undefined),
    })
  }
  // Stable order: by label then id, so the dropdown doesn't reshuffle each render.
  out.sort((a, b) => (a.label === b.label ? (a.id < b.id ? -1 : 1) : a.label < b.label ? -1 : 1))
  return out
}

/**
 * Convenience: turn an UpstreamRef[] into the `outputsByNodeId` map that
 * resolveTokens consumes for the live preview. Uses each ref's `preview` text
 * (the only output the renderer has cheaply on hand) keyed by node id.
 */
export function previewMap(upstream: UpstreamRef[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const u of upstream) if (typeof u.preview === 'string') m.set(u.id, u.preview)
  return m
}
