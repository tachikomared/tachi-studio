// apps/desktop/test/unit/subflowCollapse.test.ts
//
// NODES-RESEARCH #8 — SUBFLOWS v1 (VISUAL COLLAPSE ONLY). Collapsing a selection
// hides its child nodes + every edge touching a child and drops a 'subflow' proxy
// at the centroid — the edges are HIDDEN, never re-wired, so Run-all still runs
// the collapsed nodes normally. Expanding restores the exact pre-collapse graph.
// The collapsed shape round-trips through stableFlowJson, and a proxy whose
// children have vanished heals gracefully on load.
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
import { stableFlowJson, parseFlow, normalizeSubflows } from '../../src/pages/nodes/serialization'
import { RUNNABLE_NODE_TYPES } from '../../src/pages/nodes/run-eligibility'
import type { TachiNode, TachiEdge, TachiFlow } from '../../src/pages/nodes/types'

const S = () => useNodesStore.getState()

// Three text nodes A → B → C (e1: A→B, e2: B→C).
function seed() {
  const nodes = [
    { id: 'A', type: 'text', position: { x: 0,   y: 0 }, data: { label: 'A', text: 'a' } },
    { id: 'B', type: 'text', position: { x: 100, y: 0 }, data: { label: 'B', text: 'b' } },
    { id: 'C', type: 'text', position: { x: 200, y: 0 }, data: { label: 'C', text: 'c' } },
  ] as unknown as TachiNode[]
  const edges = [
    { id: 'e1', type: 'link', source: 'A', target: 'B' },
    { id: 'e2', type: 'link', source: 'B', target: 'C' },
  ] as unknown as TachiEdge[]
  useNodesStore.setState({ nodes, edges, flowName: 'F', undoStack: [], redoStack: [] })
}
beforeEach(seed)

describe('collapseSelectionToSubflow', () => {
  it('hides the selected children + every edge touching one, and adds a proxy at the centroid', () => {
    S().collapseSelectionToSubflow(['A', 'B'])
    const st = S()

    const proxy = st.nodes.find(n => n.type === 'subflow')
    expect(proxy).toBeDefined()
    expect((proxy!.data as { childIds?: string[] }).childIds).toEqual(['A', 'B'])
    expect(proxy!.position).toEqual({ x: 50, y: 0 }) // centroid of (0,0) and (100,0)

    // Children hidden; the uninvolved node C untouched.
    expect((st.nodes.find(n => n.id === 'A') as { hidden?: boolean }).hidden).toBe(true)
    expect((st.nodes.find(n => n.id === 'B') as { hidden?: boolean }).hidden).toBe(true)
    expect((st.nodes.find(n => n.id === 'C') as { hidden?: boolean }).hidden).toBeUndefined()

    // e1 (A→B, both children) AND e2 (B→C, touches child B) hidden.
    expect((st.edges.find(e => e.id === 'e1') as { hidden?: boolean }).hidden).toBe(true)
    expect((st.edges.find(e => e.id === 'e2') as { hidden?: boolean }).hidden).toBe(true)
  })

  it('is a no-op for fewer than two collapsible nodes', () => {
    S().collapseSelectionToSubflow(['A'])
    expect(S().nodes.some(n => n.type === 'subflow')).toBe(false)
    expect((S().nodes.find(n => n.id === 'A') as { hidden?: boolean }).hidden).toBeUndefined()
  })

  it('hides but never removes nodes/edges, and keeps runnable children runnable (Run-all does not filter hidden)', () => {
    useNodesStore.setState({
      nodes: [
        { id: 'P',  type: 'provider', position: { x: 0,   y: 0 }, data: { label: 'P', providerId: 'bankr' } },
        { id: 'AG', type: 'agent',    position: { x: 100, y: 0 }, data: { label: 'AG', harnessId: 'openclaude' } },
      ] as unknown as TachiNode[],
      edges: [{ id: 'e', type: 'link', source: 'P', target: 'AG' }] as unknown as TachiEdge[],
      flowName: 'F', undoStack: [], redoStack: [],
    })
    S().collapseSelectionToSubflow(['P', 'AG'])
    const st = S()
    // Nothing removed — the edge is only hidden, so topological order + upstream
    // resolution in Run-all still see it (Run-all's include test is by TYPE only).
    expect(st.edges).toHaveLength(1)
    const ag = st.nodes.find(n => n.id === 'AG')!
    expect((ag as { hidden?: boolean }).hidden).toBe(true)
    expect(ag.type).toBe('agent')
    expect(RUNNABLE_NODE_TYPES.has(ag.type!)).toBe(true)
  })

  it('is undoable', () => {
    S().collapseSelectionToSubflow(['A', 'B'])
    expect(S().nodes.some(n => n.type === 'subflow')).toBe(true)
    S().undo()
    expect(S().nodes.some(n => n.type === 'subflow')).toBe(false)
    expect((S().nodes.find(n => n.id === 'A') as { hidden?: boolean }).hidden).toBeUndefined()
  })
})

describe('expandSubflow', () => {
  it('restores the exact pre-collapse graph and drops the proxy', () => {
    const before = structuredClone({ nodes: S().nodes, edges: S().edges })
    S().collapseSelectionToSubflow(['A', 'B'])
    const proxyId = S().nodes.find(n => n.type === 'subflow')!.id
    S().expandSubflow(proxyId)
    const after = { nodes: S().nodes, edges: S().edges }

    expect(after.nodes.some(n => n.type === 'subflow')).toBe(false)
    expect(after.nodes).toEqual(before.nodes)
    expect(after.edges).toEqual(before.edges)
  })

  it('is a no-op for a non-subflow id', () => {
    S().expandSubflow('A')
    expect(S().nodes).toHaveLength(3)
  })
})

describe('stableFlowJson round-trip with a collapsed subflow', () => {
  it('preserves hidden flags + the proxy, and reserializes byte-identically', () => {
    S().collapseSelectionToSubflow(['A', 'B'])
    const flow: TachiFlow = {
      version: 1, name: 'F', nodes: S().nodes, edges: S().edges,
      savedAt: '2026-07-21T00:00:00.000Z',
    }
    const json1 = stableFlowJson(flow)
    const reparsed = parseFlow(JSON.parse(json1))

    expect((reparsed.nodes.find(n => n.id === 'A') as { hidden?: boolean }).hidden).toBe(true)
    const proxy = reparsed.nodes.find(n => n.type === 'subflow')
    expect(proxy).toBeDefined()
    expect((proxy!.data as { childIds?: string[] }).childIds).toEqual(['A', 'B'])

    // The heal pass is idempotent → a second serialization is byte-identical.
    expect(stableFlowJson(reparsed)).toBe(json1)
  })
})

describe('normalizeSubflows — graceful missing-children handling on load', () => {
  it('prunes dead child ids but keeps a proxy that still wraps ≥1 node', () => {
    const nodes = [
      { id: 'A', type: 'text',    position: { x: 0,  y: 0 }, hidden: true, data: { label: 'A', text: 'a' } },
      { id: 'P', type: 'subflow', position: { x: 50, y: 0 }, data: { label: 'S', childIds: ['A', 'GONE'] } },
    ] as unknown as TachiNode[]
    const { nodes: healed } = normalizeSubflows(nodes, [])
    const proxy = healed.find(n => n.type === 'subflow')!
    expect((proxy.data as { childIds?: string[] }).childIds).toEqual(['A'])
    expect((healed.find(n => n.id === 'A') as { hidden?: boolean }).hidden).toBe(true)
  })

  it('drops a proxy whose children all vanished and reveals orphaned hidden nodes', () => {
    const nodes = [
      { id: 'A', type: 'text',    position: { x: 0,  y: 0 }, hidden: true, data: { label: 'A', text: 'a' } },
      { id: 'P', type: 'subflow', position: { x: 50, y: 0 }, data: { label: 'S', childIds: ['X', 'Y'] } },
    ] as unknown as TachiNode[]
    const edges = [{ id: 'e', type: 'link', source: 'A', target: 'A', hidden: true }] as unknown as TachiEdge[]
    const { nodes: healed, edges: healedEdges } = normalizeSubflows(nodes, edges)
    // Proxy dropped (wraps nothing) → its formerly-hidden member auto-revealed.
    expect(healed.some(n => n.type === 'subflow')).toBe(false)
    expect((healed.find(n => n.id === 'A') as { hidden?: boolean }).hidden).toBeUndefined()
    // The edge no longer touches any hidden node → also revealed.
    expect((healedEdges[0] as { hidden?: boolean }).hidden).toBeUndefined()
  })

  it('leaves an ordinary flow (no subflow, no hidden) untouched by identity', () => {
    const nodes = [{ id: 'A', type: 'text', position: { x: 0, y: 0 }, data: { label: 'A' } }] as unknown as TachiNode[]
    const edges: TachiEdge[] = []
    const out = normalizeSubflows(nodes, edges)
    expect(out.nodes).toBe(nodes)
    expect(out.edges).toBe(edges)
  })
})
