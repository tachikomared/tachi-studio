// apps/desktop/src/pages/nodes/canvas/mergeSelection.ts
//
// NODES-RESEARCH STEAL — flowith's praised MERGE gesture: select N result/agent
// nodes and spawn ONE child with N parents that synthesizes them. This module is
// the PURE geometry+eligibility core (no store, no React, no i18n) so it can be
// unit-tested in isolation; the store action (mergeSelectionToFollowUp) and the
// FlowCanvas floating panel drive it.
//
// A node is an eligible MERGE SOURCE when it RUNS (agent/prompt/media/rife) or
// is an output RESULT card — i.e. it can carry a result the child will read via
// the existing upstream-input collection (graph.ipc outputsFromFlow). Config /
// static / annotation / inert tiles (provider, skill, folder, internet, mcp,
// text, imageref, note, subflow, unknown) are NOT sources and are excluded from
// both the trigger count and the wiring.

import { RUNNABLE_NODE_TYPES } from '../run-eligibility'

/** Minimal node shape the plan needs — a positional tile with a type. */
export interface MergeCandidate {
  id: string
  type?: string
  position: { x: number; y: number }
}

/** Result of planning a merge: where the child lands + who wires into it. */
export interface MergePlan {
  /** Top-left of the new Merge agent node — below the selection centroid. */
  position: { x: number; y: number }
  /** Ids of the eligible source nodes, wired FROM (parents of the child),
   *  in the input order they were given. */
  sourceIds: string[]
}

/**
 * Node types that can be a MERGE source: the RUNNABLE kinds plus the output
 * result card. Everything else is config / static / annotation / inert and is
 * excluded (note, subflow, unknown among them).
 */
export const MERGE_SOURCE_TYPES: ReadonlySet<string> = new Set([...RUNNABLE_NODE_TYPES, 'output'])

/** True when a node of this `type` can be a merge source (RUNNABLE-or-output). */
export function isMergeSource(type: string | undefined): boolean {
  return typeof type === 'string' && MERGE_SOURCE_TYPES.has(type)
}

/** Vertical drop below the centroid so the child clears the selected tiles. */
export const MERGE_DROP_OFFSET_Y = 220

/**
 * Plan the MERGE → FOLLOW-UP gesture from a set of (typically selected) nodes.
 * Keeps only eligible sources (RUNNABLE-or-output), and returns null when fewer
 * than 2 remain — the gesture needs at least two parents to synthesize.
 *
 * The child lands at the eligible sources' centroid, pushed straight down by
 * MERGE_DROP_OFFSET_Y so it reads as "the node below the group". `sourceIds`
 * preserves the input order of the eligible nodes (the caller passes them in
 * flow-node order, which matches outputsFromFlow's concatenation order).
 */
export function mergeSelectionPlan(selected: readonly MergeCandidate[]): MergePlan | null {
  const sources = selected.filter(n => isMergeSource(n.type))
  if (sources.length < 2) return null
  const n = sources.length
  const cx = sources.reduce((a, s) => a + s.position.x, 0) / n
  const cy = sources.reduce((a, s) => a + s.position.y, 0) / n
  return {
    position: { x: Math.round(cx), y: Math.round(cy + MERGE_DROP_OFFSET_Y) },
    sourceIds: sources.map(s => s.id),
  }
}
