// apps/desktop/test/unit/noteNode.test.ts
//
// NODES-RESEARCH #7 — sticky NOTE node. A brutalist annotation tile with NO run
// semantics: it sits BEHIND other nodes (zIndex -1), is skipped by Run-all /
// chains / cost estimation, and round-trips losslessly through the flow save.
// These assertions pin all three properties on pure/store surfaces.
//
// The nodes store uses plain localStorage — shim it for the node env (same
// pattern as nodesHistory.test.ts).
import { describe, it, expect, beforeEach } from 'vitest'

const _ls = new Map<string, string>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}

import { useNodesStore } from '../../src/pages/nodes/store/nodes.store'
import { stableFlowJson, parseFlow, KNOWN_NODE_TYPES } from '../../src/pages/nodes/serialization'
import { RUNNABLE_NODE_TYPES, isRunnableType } from '../../src/pages/nodes/run-eligibility'
import { estimateNodeRunCostUsd } from '../../src/pages/nodes/run-cost'
import type { TachiNode, TachiFlow } from '../../src/pages/nodes/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const S = () => useNodesStore.getState() as any
beforeEach(() => useNodesStore.setState({ nodes: [], edges: [], flowName: 'Untitled flow', undoStack: [], redoStack: [] }))

describe('note node — store add', () => {
  it('gives a new note zIndex -1 (behind other nodes) + a default sticky size, and keeps its data', () => {
    S().addNode({ type: 'note', data: { label: 'Note', text: 'hello', color: 'blue' } })
    const n = S().nodes[0]
    expect(n.type).toBe('note')
    expect(n.zIndex).toBe(-1)                // sits behind the runnable nodes
    expect(n.width).toBeGreaterThan(0)       // starts at a usable sticky size
    expect(n.height).toBeGreaterThan(0)
    expect(n.data.text).toBe('hello')
    expect(n.data.color).toBe('blue')
  })

  it('does NOT clobber a caller-provided size / zIndex (loaded or duplicated notes keep theirs)', () => {
    S().addNode({ type: 'note', width: 400, height: 300, zIndex: -5, data: { label: 'N', text: '', color: 'amber' } })
    const n = S().nodes[0]
    expect(n.width).toBe(400)
    expect(n.height).toBe(300)
    expect(n.zIndex).toBe(-5)
  })

  it('does not add zIndex/size defaults to non-note nodes', () => {
    S().addNode({ type: 'text', data: { label: 'T', text: '' } })
    const n = S().nodes[0]
    expect(n.zIndex).toBeUndefined()
    expect(n.width).toBeUndefined()
    expect(n.height).toBeUndefined()
  })
})

describe('note node — serialization round-trip', () => {
  it("'note' is a registered node type (never self-healed to 'unknown')", () => {
    expect(KNOWN_NODE_TYPES.has('note')).toBe(true)
  })

  it('stableFlowJson → parseFlow keeps text, color, and size (width/height + zIndex)', () => {
    const note = {
      id: 'note-1', type: 'note',
      position: { x: 12.7, y: 8.2 }, width: 260, height: 180, zIndex: -1,
      data: { label: 'N', text: 'remember this', color: 'green' },
    } as unknown as TachiNode
    const flow: TachiFlow = { version: 1, name: 'f', nodes: [note], edges: [], savedAt: '2026-07-21T00:00:00.000Z' }

    const parsed = parseFlow(JSON.parse(stableFlowJson(flow)))
    expect(parsed.nodes).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const back = parsed.nodes[0] as any
    expect(back.type).toBe('note')            // NOT remapped to 'unknown'
    expect(back.data.text).toBe('remember this')
    expect(back.data.color).toBe('green')
    expect(back.width).toBe(260)              // size preserved
    expect(back.height).toBe(180)
    expect(back.zIndex).toBe(-1)              // still behind other nodes
  })
})

describe('note node — no run semantics', () => {
  it('is NOT a runnable type → Run-all skips it', () => {
    expect(isRunnableType('note')).toBe(false)
    expect(RUNNABLE_NODE_TYPES.has('note')).toBe(false)
    // sanity: the executable kinds still are runnable
    expect(isRunnableType('agent')).toBe(true)
    expect(isRunnableType('prompt')).toBe(true)
    expect(isRunnableType('media')).toBe(true)
  })

  it('is excluded from cost estimation (never priced)', () => {
    const note = {
      id: 'n1', type: 'note', position: { x: 0, y: 0 },
      data: { label: 'N', text: 'x', color: 'amber' },
    } as unknown as TachiNode
    expect(estimateNodeRunCostUsd([note], [], 'n1', 'out')).toBeNull()
  })
})
