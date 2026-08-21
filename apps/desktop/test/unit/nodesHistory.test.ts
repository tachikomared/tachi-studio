// apps/desktop/test/unit/nodesHistory.test.ts
//
// Undo/redo for the Nodes canvas (STEAL 2026-06-21 #3, excalidraw history.ts —
// snapshot-stack variant). History is captured on DISCRETE structural ops
// (add / connect / delete / clear) and on keyboard-delete `remove` changes that
// arrive via onNodesChange — but NOT on the continuous position/select ticks a
// drag or click fires (those would flood the stack; drag history is captured
// once at drag-start by the canvas via pushHistory()).
//
// The store uses plain localStorage (no encryption), so we only shim that.
import { describe, it, expect, beforeEach } from 'vitest'

const _ls = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}

import { useNodesStore } from '../../src/pages/nodes/store/nodes.store'

function reset() {
  useNodesStore.setState({ nodes: [], edges: [], flowName: 'Untitled flow', undoStack: [], redoStack: [] })
}
beforeEach(reset)

// addNode takes a partial without id/position; cast keeps the test terse.
const add = (label: string) => useNodesStore.getState().addNode({ type: 'text', data: { label } } as never)
const S = () => useNodesStore.getState()

describe('nodes canvas undo/redo', () => {
  it('undo reverts addNode; redo re-applies it', () => {
    add('A')
    expect(S().nodes).toHaveLength(1)
    S().undo()
    expect(S().nodes).toHaveLength(0)
    S().redo()
    expect(S().nodes).toHaveLength(1)
  })

  it('undo reverts a deleteNode (and its edges) back into existence', () => {
    add('A')
    const id = S().nodes[0]!.id
    S().deleteNode(id)
    expect(S().nodes).toHaveLength(0)
    S().undo()
    expect(S().nodes).toHaveLength(1)
    expect(S().nodes[0]!.id).toBe(id)
  })

  it('undo reverts a keyboard delete arriving via onNodesChange("remove")', () => {
    add('A')
    const id = S().nodes[0]!.id
    S().onNodesChange([{ id, type: 'remove' }])
    expect(S().nodes).toHaveLength(0)
    S().undo()
    expect(S().nodes).toHaveLength(1)
  })

  it('does NOT record history for a pure selection change', () => {
    add('A')
    const before = S().undoStack.length
    S().onNodesChange([{ id: S().nodes[0]!.id, type: 'select', selected: true }])
    expect(S().undoStack.length).toBe(before)
  })

  it('does NOT record history for a drag position tick', () => {
    add('A')
    const before = S().undoStack.length
    S().onNodesChange([{ id: S().nodes[0]!.id, type: 'position', position: { x: 5, y: 5 }, dragging: true }])
    expect(S().undoStack.length).toBe(before)
  })

  it('a new edit after undo clears the redo stack', () => {
    add('A'); add('B')
    S().undo()                       // back to [A]
    expect(S().nodes).toHaveLength(1)
    add('C')                         // new branch — B is no longer redoable
    S().redo()
    expect(S().nodes).toHaveLength(2) // A + C, NOT A + B + ...
  })

  it('undo/redo on empty history is a safe no-op', () => {
    expect(() => S().undo()).not.toThrow()
    expect(() => S().redo()).not.toThrow()
    expect(S().nodes).toHaveLength(0)
  })

  it('caps the undo stack so unbounded editing cannot leak memory', () => {
    for (let i = 0; i < 60; i++) add(`n${i}`)
    expect(S().undoStack.length).toBeLessThanOrEqual(50)
    expect(S().nodes).toHaveLength(60) // the canvas itself is unaffected by the cap
  })

  it('pushHistory captures a manual checkpoint (used by the canvas on drag-start)', () => {
    add('A')
    S().pushHistory()                                  // canvas captures pre-drag state
    S().onNodesChange([{ id: S().nodes[0]!.id, type: 'position', position: { x: 99, y: 99 }, dragging: false }])
    expect(S().nodes[0]!.position).toEqual({ x: 99, y: 99 })
    S().undo()                                         // back to pre-drag position
    expect(S().nodes[0]!.position).not.toEqual({ x: 99, y: 99 })
  })
})

describe('nodes canvas copy/duplicate', () => {
  const selectAll = () => useNodesStore.setState({ nodes: S().nodes.map(n => ({ ...n, selected: true })) })

  it('duplicateNodes clones the given nodes with an offset, selecting the copies and deselecting originals', () => {
    add('A')
    const id = S().nodes[0]!.id
    selectAll()
    S().duplicateNodes([id])
    expect(S().nodes).toHaveLength(2)
    const orig = S().nodes.find(n => n.id === id)!
    const copy = S().nodes.find(n => n.id !== id)!
    expect(copy.selected).toBe(true)
    expect(orig.selected).toBe(false)
    expect(copy.position).not.toEqual(orig.position) // offset applied
    expect((copy.data as { label?: string }).label).toBe('A') // data cloned
  })

  it('clones edges whose BOTH endpoints are duplicated, and drops edges to outside nodes', () => {
    add('A'); add('B')
    const [a, b] = S().nodes.map(n => n.id)
    useNodesStore.getState().onConnect({ source: a!, target: b!, sourceHandle: null, targetHandle: null })
    const edgesBefore = S().edges.length
    expect(edgesBefore).toBe(1)
    // duplicate BOTH → a new internal edge between the copies
    S().duplicateNodes([a!, b!])
    expect(S().edges.length).toBe(2)
    // the new edge connects two NEW node ids (not a or b)
    const newEdge = S().edges.find(e => e.source !== a && e.target !== b && (e.source !== a || e.target !== b))
    expect(newEdge).toBeDefined()
  })

  it('dropping a single endpoint duplicate adds no edge', () => {
    add('A'); add('B')
    const [a, b] = S().nodes.map(n => n.id)
    useNodesStore.getState().onConnect({ source: a!, target: b!, sourceHandle: null, targetHandle: null })
    S().duplicateNodes([a!]) // only A duplicated → its a→b edge has no duplicated target
    expect(S().edges.length).toBe(1) // unchanged
    expect(S().nodes).toHaveLength(3)
  })

  it('is undoable and a no-op for empty/unknown ids', () => {
    add('A')
    const id = S().nodes[0]!.id
    S().duplicateNodes([id])
    expect(S().nodes).toHaveLength(2)
    S().undo()
    expect(S().nodes).toHaveLength(1)
    const before = S().nodes.length
    S().duplicateNodes([])
    S().duplicateNodes(['does-not-exist'])
    expect(S().nodes).toHaveLength(before)
  })
})
