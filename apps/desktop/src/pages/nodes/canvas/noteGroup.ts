// apps/desktop/src/pages/nodes/canvas/noteGroup.ts
//
// NODES-RESEARCH #7 (parenting groups) — the geometry behind "a note carries the
// nodes it describes". We deliberately do NOT use React Flow's `parentId`/group
// mechanics: that would rewrite every child's position to be RELATIVE to the
// parent, churning the flow JSON and breaking stableFlowJson byte-round-trips.
//
// Instead we CAPTURE-ON-DRAG: at the moment a note's drag starts we snapshot the
// set of nodes whose CENTER lies inside the note's rect, then translate that set
// by the same delta the note moves. Membership is frozen at drag start (nodes
// don't join/leave mid-drag), positions stay absolute, and serialization is
// untouched. These helpers are pure so the whole rule is unit-testable.

import type { TachiNode } from '../types'

/** Axis-aligned rectangle in flow (canvas) coordinates. */
export interface Rect { x: number; y: number; w: number; h: number }

/** A note's default sticky size (mirrors nodes.store addNode note defaults) —
 *  used only until React Flow has measured the node. */
const NOTE_FALLBACK_W = 220
const NOTE_FALLBACK_H = 150
/** A generic node footprint, used only to locate a member's CENTER before it has
 *  been measured (matches APPROX_NODE_RECT in EightHandles). */
const NODE_FALLBACK_W = 180
const NODE_FALLBACK_H = 84

/** First finite number among the candidates, else the fallback. */
function firstNum(fallback: number, ...cands: Array<unknown>): number {
  for (const c of cands) if (typeof c === 'number' && Number.isFinite(c)) return c
  return fallback
}

/** The rect a note occupies — explicit top-level width/height (what the store
 *  stores + persists) win, then React Flow's `measured`, then the sticky size. */
export function noteRect(note: Pick<TachiNode, 'position'> & Record<string, unknown>): Rect {
  const measured = note['measured'] as { width?: unknown; height?: unknown } | undefined
  const w = firstNum(NOTE_FALLBACK_W, note['width'], measured?.width)
  const h = firstNum(NOTE_FALLBACK_H, note['height'], measured?.height)
  return { x: note.position.x, y: note.position.y, w, h }
}

/** The geometric center of a node (position is its top-left corner). */
export function nodeCenter(node: Pick<TachiNode, 'position'> & Record<string, unknown>): { x: number; y: number } {
  const measured = node['measured'] as { width?: unknown; height?: unknown } | undefined
  const w = firstNum(NODE_FALLBACK_W, node['width'], measured?.width)
  const h = firstNum(NODE_FALLBACK_H, node['height'], measured?.height)
  return { x: node.position.x + w / 2, y: node.position.y + h / 2 }
}

/** Point-in-rect, borders INCLUSIVE (a center exactly on the edge counts as in). */
export function isCenterInsideRect(pt: { x: number; y: number }, rect: Rect): boolean {
  return pt.x >= rect.x && pt.x <= rect.x + rect.w
    && pt.y >= rect.y && pt.y <= rect.y + rect.h
}

/**
 * The nodes a note currently "contains" — those whose CENTER is inside the note's
 * rect. Excludes the note itself, other note tiles (two overlapping background
 * notes must not drag each other), and hidden nodes (a collapsed subflow's
 * children — only the visible proxy should ride). Pure; input order preserved.
 */
export function nodesInsideNote(note: TachiNode, nodes: TachiNode[]): TachiNode[] {
  const rect = noteRect(note as Pick<TachiNode, 'position'> & Record<string, unknown>)
  return nodes.filter(n =>
    n.id !== note.id &&
    n.type !== 'note' &&
    !(n as { hidden?: boolean }).hidden &&
    isCenterInsideRect(nodeCenter(n as Pick<TachiNode, 'position'> & Record<string, unknown>), rect),
  )
}

/**
 * Translate every node in `ids` by (dx, dy), returning a new array. Non-member
 * nodes keep their exact object identity (so React.memo skips re-rendering them),
 * and a zero delta / empty id-set returns the SAME array reference — both make
 * the drag path cheap and a note-with-no-members a true no-op.
 */
export function moveByDelta(nodes: TachiNode[], ids: Iterable<string>, dx: number, dy: number): TachiNode[] {
  const idSet = ids instanceof Set ? ids : new Set(ids)
  if (idSet.size === 0 || (dx === 0 && dy === 0)) return nodes
  return nodes.map(n =>
    idSet.has(n.id)
      ? ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } as TachiNode)
      : n,
  )
}

/**
 * Whether a starting drag should carry the note's members. Pure so the Alt-drag
 * escape hatch is testable without React Flow:
 *   - only NOTE nodes parent their members;
 *   - holding Alt moves ONLY the note (the documented opt-out);
 *   - a multi-node drag (the note is part of a selection React Flow already moves
 *     together) skips carry, so members inside the note aren't shifted twice.
 */
export function shouldCarryMembers(opts: { nodeType?: string; altKey: boolean; draggedCount: number }): boolean {
  return opts.nodeType === 'note' && !opts.altKey && opts.draggedCount <= 1
}
