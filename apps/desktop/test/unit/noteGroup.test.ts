// apps/desktop/test/unit/noteGroup.test.ts
//
// NODES-RESEARCH #7 (parenting groups) — a NOTE tile that carries the nodes it
// describes. The geometry + drag-decision live in pure helpers (noteGroup.ts) so
// the whole rule is testable without React Flow: membership is by CENTER inside
// the note's rect (frozen at drag start), the note translates that set by its own
// delta, and Alt-drag opts out. Serialization is untouched — no parentId, no
// relative positions — so we only pin the pure geometry here; the byte-identical
// round-trip is proven by the noteNode + stableFlowJson suites.
import { describe, it, expect } from 'vitest'
import {
  noteRect,
  nodeCenter,
  isCenterInsideRect,
  nodesInsideNote,
  moveByDelta,
  shouldCarryMembers,
} from '../../src/pages/nodes/canvas/noteGroup'
import type { TachiNode } from '../../src/pages/nodes/types'

// Build a node with explicit dims so centers are deterministic.
function node(
  id: string,
  type: string,
  x: number,
  y: number,
  w = 40,
  h = 40,
  extra: Record<string, unknown> = {},
): TachiNode {
  return { id, type, position: { x, y }, width: w, height: h, data: { label: id }, ...extra } as unknown as TachiNode
}

// A note occupying the rect { x:0, y:0, w:200, h:100 }.
function note(id = 'note-1', x = 0, y = 0, w = 200, h = 100): TachiNode {
  return { id, type: 'note', position: { x, y }, width: w, height: h, zIndex: -1, data: { label: 'N', text: '' } } as unknown as TachiNode
}

describe('noteGroup — rect + center geometry', () => {
  it('noteRect prefers explicit width/height, then measured, then the sticky fallback', () => {
    expect(noteRect({ position: { x: 5, y: 7 } } as never)).toEqual({ x: 5, y: 7, w: 220, h: 150 })
    expect(noteRect({ position: { x: 0, y: 0 }, measured: { width: 250, height: 120 } } as never))
      .toEqual({ x: 0, y: 0, w: 250, h: 120 })
    // explicit wins over measured
    expect(noteRect({ position: { x: 0, y: 0 }, width: 300, height: 200, measured: { width: 1, height: 1 } } as never))
      .toEqual({ x: 0, y: 0, w: 300, h: 200 })
  })

  it('nodeCenter = top-left + half the footprint (fallback footprint when unmeasured)', () => {
    expect(nodeCenter({ position: { x: 100, y: 50 }, width: 40, height: 20 } as never)).toEqual({ x: 120, y: 60 })
    // no dims → APPROX_NODE_RECT fallback (180×84) → center offset (90, 42)
    expect(nodeCenter({ position: { x: 10, y: 10 } } as never)).toEqual({ x: 100, y: 52 })
  })

  it('isCenterInsideRect includes the borders', () => {
    const r = { x: 0, y: 0, w: 200, h: 100 }
    expect(isCenterInsideRect({ x: 100, y: 50 }, r)).toBe(true)   // interior
    expect(isCenterInsideRect({ x: 0, y: 0 }, r)).toBe(true)      // top-left corner
    expect(isCenterInsideRect({ x: 200, y: 100 }, r)).toBe(true)  // bottom-right corner
    expect(isCenterInsideRect({ x: 201, y: 50 }, r)).toBe(false)  // just outside right
    expect(isCenterInsideRect({ x: 100, y: -1 }, r)).toBe(false)  // just above
  })
})

describe('noteGroup — nodesInsideNote (membership by center-inside-rect)', () => {
  it('includes a node whose center is inside, excludes one whose center is outside', () => {
    const n = note()
    const inside  = node('A', 'agent', 80, 30)   // center (100, 50) ∈ rect
    const outside = node('B', 'agent', 300, 300)  // center (320, 320) ∉ rect
    const members = nodesInsideNote(n, [n, inside, outside]).map(m => m.id)
    expect(members).toEqual(['A'])
  })

  it('is CENTER-based, not overlap-based: a tile overlapping the edge but centered outside is NOT a member', () => {
    const n = note()
    // spans x 190..230 (overlaps the note's right edge at x=200) but center x=210 > 200
    const overlap = node('O', 'agent', 190, 40, 40, 20) // center (210, 50)
    expect(nodesInsideNote(n, [n, overlap])).toHaveLength(0)
  })

  it('counts a node whose center is exactly on the border (inclusive)', () => {
    const n = note()
    // center at (200, 50) — exactly on the right edge
    const border = node('E', 'agent', 180, 40, 40, 20) // center (200, 50)
    expect(nodesInsideNote(n, [n, border]).map(m => m.id)).toEqual(['E'])
  })

  it('excludes the note itself, other notes, and hidden nodes', () => {
    const n = note()
    const otherNote = note('note-2', 20, 10, 40, 40)                 // a second note inside
    const hidden    = node('H', 'agent', 80, 30, 40, 40, { hidden: true }) // inside but collapsed
    const real      = node('R', 'agent', 80, 30)                     // inside, visible → member
    const members = nodesInsideNote(n, [n, otherNote, hidden, real]).map(m => m.id)
    expect(members).toEqual(['R'])
  })

  it('empty note (nothing inside) yields no members', () => {
    const n = note()
    const far = node('F', 'agent', 500, 500)
    expect(nodesInsideNote(n, [n, far])).toEqual([])
  })
})

describe('noteGroup — moveByDelta (translate the carried set)', () => {
  it('shifts only the member ids and preserves identity of everyone else', () => {
    const a = node('A', 'agent', 10, 10)
    const b = node('B', 'agent', 50, 50)
    const nodes = [a, b]
    const out = moveByDelta(nodes, ['A'], 15, -5)
    expect(out.find(n => n.id === 'A')!.position).toEqual({ x: 25, y: 5 })
    // B untouched — same object reference (so React.memo skips its re-render)
    expect(out.find(n => n.id === 'B')).toBe(b)
  })

  it('a Set of ids works the same as an array', () => {
    const a = node('A', 'agent', 0, 0)
    const b = node('B', 'agent', 0, 0)
    const out = moveByDelta([a, b], new Set(['A', 'B']), 10, 10)
    expect(out.map(n => n.position)).toEqual([{ x: 10, y: 10 }, { x: 10, y: 10 }])
  })

  it('is a no-op (same array reference) for a zero delta', () => {
    const nodes = [node('A', 'agent', 0, 0)]
    expect(moveByDelta(nodes, ['A'], 0, 0)).toBe(nodes)
  })

  it('is a no-op (same array reference) for an empty id set — empty-note carry does nothing', () => {
    const nodes = [node('A', 'agent', 0, 0)]
    expect(moveByDelta(nodes, [], 10, 10)).toBe(nodes)
  })
})

describe('noteGroup — shouldCarryMembers (Alt-drag opt-out + guards)', () => {
  it('a lone note drag with no Alt carries', () => {
    expect(shouldCarryMembers({ nodeType: 'note', altKey: false, draggedCount: 1 })).toBe(true)
  })

  it('holding Alt moves ONLY the note (the escape hatch)', () => {
    expect(shouldCarryMembers({ nodeType: 'note', altKey: true, draggedCount: 1 })).toBe(false)
  })

  it('a multi-node drag skips carry (React Flow already moves the selection together)', () => {
    expect(shouldCarryMembers({ nodeType: 'note', altKey: false, draggedCount: 2 })).toBe(false)
  })

  it('only note nodes parent members', () => {
    expect(shouldCarryMembers({ nodeType: 'agent', altKey: false, draggedCount: 1 })).toBe(false)
    expect(shouldCarryMembers({ nodeType: undefined, altKey: false, draggedCount: 1 })).toBe(false)
  })
})
