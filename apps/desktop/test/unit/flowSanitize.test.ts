// NODES-RESEARCH #3: self-healing flow load. sanitizeFlow repairs a shared /
// old / hand-edited flow so it never opens broken — unknown node types remap to
// an inert 'unknown' tile (original type preserved for a lossless save), dangling
// edges drop, and missing ids/positions get defaults — while a structurally-valid
// flow passes through untouched.
import { describe, it, expect } from 'vitest'
import { sanitizeFlow, restoreUnknownNodeTypes, KNOWN_NODE_TYPES } from '../../src/pages/nodes/serialization'
import type { TachiFlow, TachiNode, TachiEdge } from '../../src/pages/nodes/types'

function flowOf(nodes: TachiNode[], edges: TachiEdge[]): TachiFlow {
  return { version: 1, name: 'f', nodes, edges, savedAt: '2026-07-21T00:00:00.000Z' }
}

const provider = { id: 'p1', type: 'provider', position: { x: 0, y: 0 }, data: { label: 'P', providerId: 'bankr' } } as unknown as TachiNode
const agent    = { id: 'a1', type: 'agent',    position: { x: 200, y: 0 }, data: { label: 'A', harnessId: 'openclaude' } } as unknown as TachiNode
const edgePA   = { id: 'e1', type: 'link', source: 'p1', target: 'a1' } as unknown as TachiEdge

describe('sanitizeFlow', () => {
  it('remaps an unregistered node type to "unknown", preserving original type + data verbatim', () => {
    const weird = {
      id: 'w1', type: 'quantum-widget', position: { x: 40, y: 60 },
      data: { label: 'W', customField: 'keep-me', nested: { a: 1 } },
    } as unknown as TachiNode
    const out = sanitizeFlow(flowOf([weird], []))

    expect(out.nodes).toHaveLength(1)
    const n = out.nodes[0]!
    expect(n.type).toBe('unknown')
    expect((n.data as { originalType?: string }).originalType).toBe('quantum-widget')
    // Every other field is kept verbatim.
    expect((n.data as { label?: string }).label).toBe('W')
    expect((n.data as { customField?: string }).customField).toBe('keep-me')
    expect((n.data as { nested?: unknown }).nested).toEqual({ a: 1 })
    expect(n.id).toBe('w1')
    expect(n.position).toEqual({ x: 40, y: 60 })
    // 'unknown' is itself a registered type, so a re-sanitize is idempotent.
    expect(KNOWN_NODE_TYPES.has('unknown')).toBe(true)
  })

  it('round-trips losslessly: restoreUnknownNodeTypes(sanitizeFlow(flow)) deep-equals the original', () => {
    const weird = {
      id: 'w1', type: 'quantum-widget', position: { x: 40, y: 60 },
      data: { label: 'W', customField: 'keep-me' },
      width: 220, selected: false,
    } as unknown as TachiNode
    const original = flowOf([provider, weird], [])
    const restored = restoreUnknownNodeTypes(sanitizeFlow(original))
    expect(restored).toEqual(original)
  })

  it('is idempotent on an already-healed (type "unknown") node — original type not clobbered', () => {
    const healed = {
      id: 'w1', type: 'unknown', position: { x: 0, y: 0 },
      data: { label: 'W', originalType: 'quantum-widget' },
    } as unknown as TachiNode
    const out = sanitizeFlow(flowOf([healed], []))
    expect(out.nodes[0]!.type).toBe('unknown')
    expect((out.nodes[0]!.data as { originalType?: string }).originalType).toBe('quantum-widget')
  })

  it('drops edges whose endpoints are missing', () => {
    const dangling = { id: 'e-bad', type: 'link', source: 'p1', target: 'ghost' } as unknown as TachiEdge
    const orphanSrc = { id: 'e-bad2', type: 'link', source: 'nope', target: 'a1' } as unknown as TachiEdge
    const out = sanitizeFlow(flowOf([provider, agent], [edgePA, dangling, orphanSrc]))
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0]!.id).toBe('e1')
  })

  it('generates an id for a node missing one, and defaults a missing position to {x:0,y:0}', () => {
    const noId  = { type: 'agent', position: { x: 5, y: 5 }, data: { label: 'A', harnessId: 'openclaude' } } as unknown as TachiNode
    const noPos = { id: 'k1', type: 'agent', data: { label: 'K', harnessId: 'openclaude' } } as unknown as TachiNode
    const out = sanitizeFlow(flowOf([noId, noPos], []))

    expect(typeof out.nodes[0]!.id).toBe('string')
    expect(out.nodes[0]!.id.length).toBeGreaterThan(0)
    expect(out.nodes[0]!.position).toEqual({ x: 5, y: 5 })

    expect(out.nodes[1]!.id).toBe('k1')
    expect(out.nodes[1]!.position).toEqual({ x: 0, y: 0 })
  })

  it('defaults a non-numeric position to {x:0,y:0}', () => {
    const badPos = { id: 'b1', type: 'agent', position: { x: 'nan', y: null }, data: { label: 'B', harnessId: 'openclaude' } } as unknown as TachiNode
    const out = sanitizeFlow(flowOf([badPos], []))
    expect(out.nodes[0]!.position).toEqual({ x: 0, y: 0 })
  })

  it('passes a fully-valid flow through deep-equal untouched', () => {
    const valid = flowOf([provider, agent], [edgePA])
    const out = sanitizeFlow(valid)
    expect(out).toEqual(valid)
    // Healthy nodes keep their object identity (no needless churn).
    expect(out.nodes[0]).toBe(provider)
    expect(out.nodes[1]).toBe(agent)
  })

  it('tolerates missing nodes/edges arrays', () => {
    const out = sanitizeFlow({ version: 1, name: 'x', savedAt: '' } as unknown as TachiFlow)
    expect(out.nodes).toEqual([])
    expect(out.edges).toEqual([])
  })
})

describe('restoreUnknownNodeTypes', () => {
  it('returns the same flow object when there are no healed nodes', () => {
    const valid = flowOf([provider, agent], [edgePA])
    expect(restoreUnknownNodeTypes(valid)).toBe(valid)
  })

  it('restores the original type and strips the originalType marker', () => {
    const healed = {
      id: 'w1', type: 'unknown', position: { x: 1, y: 2 },
      data: { label: 'W', originalType: 'quantum-widget', keep: true },
    } as unknown as TachiNode
    const out = restoreUnknownNodeTypes(flowOf([healed], []))
    const n = out.nodes[0]!
    expect(n.type).toBe('quantum-widget')
    expect((n.data as { originalType?: unknown }).originalType).toBeUndefined()
    expect((n.data as { keep?: boolean }).keep).toBe(true)
  })
})
