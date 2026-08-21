// apps/desktop/src/pages/nodes/canvas/topo-order.ts
//
// Pure topological-sort utilities for the Nodes canvas Run-All path.
//
// Implements Kahn's algorithm over the ReactFlow edge DAG (source -> target),
// so every node executes AFTER all its upstream dependencies have finished.
//
// Reference: DevToys ExtensionOrderer pattern (topological sort + cycle
// detection in a single pass), adapted for TachiNode / TachiEdge shapes.
//
// Both functions are PURE (no side effects, no store access) and operate only
// on the node id / edge source+target fields — no node data is read.

import type { TachiNode, TachiEdge } from '../types'

// ── topoOrder ─────────────────────────────────────────────────────────────────

/**
 * Return node ids in a valid topological execution order (sources before
 * targets) using Kahn's algorithm over the edge DAG.
 *
 * Nodes not reachable by any edge (isolated) are included at the front in
 * their original array order (they have in-degree 0 from the start).
 *
 * If the graph contains a cycle, the nodes involved in the cycle are NOT
 * silently dropped — they are appended to the end of the returned order in
 * their original array order. This means Run-All always processes every node.
 * Use `detectCycle` to check for cycles and surface an error before running.
 *
 * @param nodes  All TachiNodes currently on the canvas.
 * @param edges  All TachiEdges currently on the canvas.
 * @returns      Array of node ids in dependency-safe execution order.
 */
export function topoOrder(nodes: TachiNode[], edges: TachiEdge[]): string[] {
  // Build an adjacency list (id -> list of successor ids) and an in-degree map.
  const inDeg = new Map<string, number>()
  const adj   = new Map<string, string[]>()

  for (const n of nodes) {
    inDeg.set(n.id, 0)
    adj.set(n.id, [])
  }

  for (const e of edges) {
    // Skip edges that reference nodes not in the current set (stale / corrupt).
    if (!adj.has(e.source) || !inDeg.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1)
  }

  // Seed the queue with all zero-in-degree nodes, in original array order so
  // the output is deterministic for graphs with multiple valid orderings.
  const queue: string[] = []
  for (const n of nodes) {
    if ((inDeg.get(n.id) ?? 0) === 0) queue.push(n.id)
  }

  const ordered: string[] = []
  const visited = new Set<string>()

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    ordered.push(id)

    // Decrement in-degree of all successors; enqueue those that become zero.
    for (const successor of adj.get(id) ?? []) {
      const newDeg = (inDeg.get(successor) ?? 1) - 1
      inDeg.set(successor, newDeg)
      if (newDeg <= 0) queue.push(successor)
    }
  }

  // Append any nodes that were not visited — these are part of a cycle.
  // We include them in original order so Run-All never silently drops a node.
  for (const n of nodes) {
    if (!visited.has(n.id)) ordered.push(n.id)
  }

  return ordered
}

// ── detectCycle ───────────────────────────────────────────────────────────────

/**
 * Detect whether the graph contains a directed cycle.
 *
 * Uses a standard DFS coloring approach (white / gray / black):
 *   - white (0): not yet visited
 *   - gray  (1): in the current DFS stack (back-edge = cycle)
 *   - black (2): fully processed
 *
 * @param nodes  All TachiNodes currently on the canvas.
 * @param edges  All TachiEdges currently on the canvas.
 * @returns      Array of node ids that form (or are part of) the first
 *               detected cycle, or `null` if the graph is acyclic.
 *               The returned ids are in the order they were encountered
 *               during DFS — not necessarily the minimal cycle.
 */
export function detectCycle(nodes: TachiNode[], edges: TachiEdge[]): string[] | null {
  // Build adjacency list (forward edges only).
  const adj = new Map<string, string[]>()
  for (const n of nodes) adj.set(n.id, [])
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
  }

  // 0 = white, 1 = gray (in stack), 2 = black (done)
  const color = new Map<string, 0 | 1 | 2>()
  for (const n of nodes) color.set(n.id, 0)

  // Stack of node ids that led to the current DFS frontier (the call stack
  // in a recursive formulation, flattened to an explicit array).
  const path: string[] = []

  function dfs(id: string): string[] | null {
    color.set(id, 1)
    path.push(id)

    for (const successor of adj.get(id) ?? []) {
      const c = color.get(successor) ?? 0
      if (c === 1) {
        // Back-edge found — extract the cycle from the current path.
        const cycleStart = path.indexOf(successor)
        return path.slice(cycleStart) // includes `id` at the end
      }
      if (c === 0) {
        const result = dfs(successor)
        if (result !== null) return result
      }
      // c === 2: already fully processed, no cycle through this edge
    }

    path.pop()
    color.set(id, 2)
    return null
  }

  // Visit every node so disconnected components are checked too.
  for (const n of nodes) {
    if ((color.get(n.id) ?? 0) === 0) {
      const result = dfs(n.id)
      if (result !== null) return result
    }
  }

  return null
}
