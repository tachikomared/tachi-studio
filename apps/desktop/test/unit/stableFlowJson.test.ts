// NODES-RESEARCH #11: diff-friendly flow persistence — same graph in any
// insertion order must serialize byte-identically, so saved flows produce
// minimal reviewable git diffs and shared flows compare cleanly.
import { describe, it, expect } from 'vitest'
import { stableFlowJson, parseFlow } from '../../src/pages/nodes/serialization'
import type { TachiFlow, TachiNode, TachiEdge } from '../../src/pages/nodes/types'

const nodeA = { id: 'a1', type: 'agent', position: { x: 10.4, y: 20.6 }, data: { label: 'A', harnessId: 'openclaude' } } as unknown as TachiNode
const nodeB = { id: 'b1', type: 'provider', position: { x: 99.99, y: 0 }, data: { providerId: 'bankr', label: 'B' } } as unknown as TachiNode
const edge = { id: 'e1', source: 'b1', target: 'a1' } as unknown as TachiEdge

function flowOf(nodes: TachiNode[], edges: TachiEdge[]): TachiFlow {
  return { version: 1, name: 'f', nodes, edges, savedAt: '2026-07-20T00:00:00.000Z' }
}

describe('stableFlowJson', () => {
  it('is order-independent: shuffled nodes/edges → byte-identical JSON', () => {
    const j1 = stableFlowJson(flowOf([nodeA, nodeB], [edge]))
    const j2 = stableFlowJson(flowOf([nodeB, nodeA], [edge]))
    expect(j1).toBe(j2)
  })

  it('is key-order independent inside data objects', () => {
    const a1 = { ...nodeA, data: { label: 'A', harnessId: 'openclaude' } } as TachiNode
    const a2 = { ...nodeA, data: { harnessId: 'openclaude', label: 'A' } } as TachiNode
    expect(stableFlowJson(flowOf([a1], []))).toBe(stableFlowJson(flowOf([a2], [])))
  })

  it('rounds drag micro-noise out of positions', () => {
    const j = stableFlowJson(flowOf([nodeA], []))
    expect(j).toContain('"x": 10')
    expect(j).toContain('"y": 21')
    expect(j).not.toContain('10.4')
  })

  it('round-trips through parseFlow', () => {
    const parsed = parseFlow(JSON.parse(stableFlowJson(flowOf([nodeA, nodeB], [edge]))))
    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.edges).toHaveLength(1)
    expect(parsed.name).toBe('f')
  })

  it('drops undefined values instead of serializing junk', () => {
    const n = { ...nodeA, data: { label: 'A', ghost: undefined } } as unknown as TachiNode
    expect(stableFlowJson(flowOf([n], []))).not.toContain('ghost')
  })
})
