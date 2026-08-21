// apps/desktop/src/pages/nodes/canvas/useUpstreamRefs.ts
//
// Computes the upstream-reference list for a canvas node (#2): every node that
// can feed `nodeId` by walking edges backwards, each carrying its label + a
// one-line preview of its `lastOutput`. Fed into <ReferenceField> for the @ /
// {{ autocomplete and the live "Resolves to:" preview.
//
// Subscribes to nodes+edges so the preview refreshes when an upstream node's
// `lastOutput` changes (e.g. after a per-node run / pin). The heavy BFS is
// memoised against a cheap structural signature so we don't re-walk the graph
// every render.

import { useMemo } from 'react'
import type { Node, Edge } from '@xyflow/react'
import { useNodesStore } from '../store/nodes.store'
import { listUpstreamRefs, type UpstreamRef } from '../../../lib/nodeRefs'

/**
 * `UpstreamRef[]` for `nodeId` (transitive predecessors, broad as the token
 * model allows). Reactive to node labels, edges, and upstream `lastOutput`s.
 */
export function useUpstreamRefs(nodeId: string): UpstreamRef[] {
  const nodes = useNodesStore(s => s.nodes)
  const edges = useNodesStore(s => s.edges)

  // Re-run the BFS only when something that affects it changes: edges, or any
  // node's id / label / lastOutput. A compact signature keeps this cheap.
  const sig = useMemo(() => {
    const e = edges.map(x => `${x.source}>${x.target}`).join('|')
    const n = nodes
      .map(x => {
        const d = (x.data ?? {}) as { label?: unknown; lastOutput?: unknown }
        const label = typeof d.label === 'string' ? d.label : ''
        const out = typeof d.lastOutput === 'string' ? d.lastOutput.length : 0
        return `${x.id}:${label}:${out}`
      })
      .join('|')
    return `${nodeId}#${e}#${n}`
  }, [nodeId, nodes, edges])

  return useMemo(
    () => listUpstreamRefs(nodeId, nodes as Node[], edges as Edge[]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  )
}
