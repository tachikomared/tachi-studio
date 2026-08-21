// apps/desktop/src/pages/nodes/canvas/elk-layout.ts
//
// ELK-based hierarchical auto-layout for the Nodes canvas.
//
// Exports a single async function `autoLayout` that accepts ReactFlow nodes
// and edges, runs the ELK `layered` algorithm with RIGHT direction, and
// returns the same nodes/edges with updated `position` values. Edge topology
// is preserved — only node x/y positions change.
//
// Lazy import of the ELK constructor ensures the 700 kB elk.bundled.js is
// only parsed when the "Auto Layout" button is clicked (not on page load).
//
// Reference: elkjs README + Understand-Anything src/utils/elk-layout.ts (MIT).

import type { Node, Edge } from '@xyflow/react'
import type { ElkNode } from 'elkjs/lib/elk-api'

/** Approximate node dimensions when ReactFlow hasn't measured them yet. */
const FALLBACK_W = 180
const FALLBACK_H = 84

/** Spacing between nodes on the same layer (horizontal gap). */
const NODE_GAP = 60

/** Spacing between layers (vertical gap in RIGHT-direction = horizontal distance). */
const LAYER_GAP = 100

/**
 * Reflow all nodes using ELK's `layered` algorithm with RIGHT direction.
 *
 * @param nodes   ReactFlow nodes (may carry `width`/`height` from DOM measurement)
 * @param edges   ReactFlow edges — only topology is used (source/target ids)
 * @returns       New node array with updated `position.x` / `position.y`, and
 *                the same edges unchanged (ELK doesn't mutate edge routing here).
 */
export async function autoLayout(
  nodes: Node[],
  edges: Edge[],
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  if (nodes.length === 0) return { nodes, edges }

  // Lazy-load the bundled ELK (avoids parsing on startup)
  const ElkModule = await import('elkjs/lib/elk.bundled.js')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ElkCtor = (ElkModule as any).default ?? ElkModule
  const elk = new ElkCtor()

  // Build the ELK graph. ELK expects all edges at the ROOT level (not inside
  // child nodes) when the graph is flat (no hierarchy).
  const elkNodes: ElkNode[] = nodes.map(n => ({
    id: n.id,
    width:  (n as { width?: number }).width  ?? FALLBACK_W,
    height: (n as { height?: number }).height ?? FALLBACK_H,
  }))

  const elkEdges = edges.map(e => ({
    id:      e.id,
    sources: [e.source],
    targets: [e.target],
  }))

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm':                      'layered',
      'elk.direction':                      'RIGHT',
      'elk.spacing.nodeNode':               String(NODE_GAP),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: elkNodes,
    edges:    elkEdges,
  }

  const laidOut = await elk.layout(graph)

  // Map ELK positions back onto ReactFlow nodes. Nodes not found in the
  // result (should never happen) fall through to their original position.
  const posMap = new Map<string, { x: number; y: number }>()
  for (const child of laidOut.children ?? []) {
    if (child.x !== undefined && child.y !== undefined) {
      posMap.set(child.id, { x: child.x, y: child.y })
    }
  }

  const updatedNodes = nodes.map(n => {
    const pos = posMap.get(n.id)
    if (!pos) return n
    return { ...n, position: pos }
  })

  return { nodes: updatedNodes, edges }
}
