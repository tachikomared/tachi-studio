// apps/desktop/test/unit/topoOrder.test.ts
import { describe, it, expect } from 'vitest'
import { topoOrder, detectCycle } from '../../src/pages/nodes/canvas/topo-order'

// topoOrder/detectCycle read only id (nodes) and source/target (edges).
const n = (id: string) => ({ id }) as unknown as Parameters<typeof topoOrder>[0][number]
const e = (source: string, target: string) =>
  ({ id: `${source}->${target}`, source, target }) as unknown as Parameters<typeof topoOrder>[1][number]

describe('topoOrder', () => {
  it('orders a linear chain sources-before-targets', () => {
    expect(topoOrder([n('A'), n('B'), n('C')], [e('A', 'B'), e('B', 'C')])).toEqual(['A', 'B', 'C'])
  })

  it('puts the root first and the sink last in a diamond', () => {
    const order = topoOrder(
      [n('A'), n('B'), n('C'), n('D')],
      [e('A', 'B'), e('A', 'C'), e('B', 'D'), e('C', 'D')],
    )
    expect(order[0]).toBe('A')
    expect(order[order.length - 1]).toBe('D')
    expect(new Set(order)).toEqual(new Set(['A', 'B', 'C', 'D']))
  })

  it('never drops nodes even when a cycle exists', () => {
    const order = topoOrder([n('A'), n('B')], [e('A', 'B'), e('B', 'A')])
    expect(order).toHaveLength(2)
    expect(new Set(order)).toEqual(new Set(['A', 'B']))
  })

  it('ignores edges that reference missing nodes', () => {
    expect(topoOrder([n('A'), n('B')], [e('A', 'B'), e('A', 'GHOST')])).toEqual(['A', 'B'])
  })
})

describe('detectCycle', () => {
  it('returns null for an acyclic graph', () => {
    expect(detectCycle([n('A'), n('B'), n('C')], [e('A', 'B'), e('B', 'C')])).toBeNull()
    expect(detectCycle(
      [n('A'), n('B'), n('C'), n('D')],
      [e('A', 'B'), e('A', 'C'), e('B', 'D'), e('C', 'D')],
    )).toBeNull()
  })

  it('detects a simple two-node cycle', () => {
    const cyc = detectCycle([n('A'), n('B')], [e('A', 'B'), e('B', 'A')])
    expect(cyc).not.toBeNull()
    expect(new Set(cyc!)).toEqual(new Set(['A', 'B']))
  })

  it('detects a self-loop', () => {
    expect(detectCycle([n('A')], [e('A', 'A')])).toEqual(['A'])
  })

  it('finds a cycle in a disconnected component', () => {
    const cyc = detectCycle(
      [n('A'), n('B'), n('X'), n('Y')],
      [e('A', 'B'), e('X', 'Y'), e('Y', 'X')],  // X<->Y cycle, A->B clean
    )
    expect(cyc).not.toBeNull()
    expect(cyc).toContain('X')
    expect(cyc).toContain('Y')
  })
})

// Run-All must never silently drop cyclic nodes: topoOrder appends them at the
// end and detectCycle flags the graph so the UI can surface an error first.
describe('cycle behavior gap (Run-All never drops nodes)', () => {
  it('keeps both nodes of a two-node cycle and flags it', () => {
    const nodes = [n('A'), n('B')]
    const edges = [e('A', 'B'), e('B', 'A')]
    const order = topoOrder(nodes, edges)
    expect(order).toHaveLength(2)
    expect(new Set(order)).toEqual(new Set(['A', 'B']))
    expect(detectCycle(nodes, edges)).not.toBeNull()
  })

  it('keeps a self-looping node and flags it', () => {
    const nodes = [n('A')]
    const edges = [e('A', 'A')]
    const order = topoOrder(nodes, edges)
    expect(order).toHaveLength(1)
    expect(new Set(order)).toEqual(new Set(['A']))
    expect(detectCycle(nodes, edges)).not.toBeNull()
  })

  it('keeps every node of a cycle-plus-tail graph and flags it', () => {
    // A->B->C->A is a cycle; C->D is a clean tail hanging off the cycle.
    const nodes = [n('A'), n('B'), n('C'), n('D')]
    const edges = [e('A', 'B'), e('B', 'C'), e('C', 'A'), e('C', 'D')]
    const order = topoOrder(nodes, edges)
    expect(order).toHaveLength(4)
    expect(new Set(order)).toEqual(new Set(['A', 'B', 'C', 'D']))
    expect(detectCycle(nodes, edges)).not.toBeNull()
  })
})
