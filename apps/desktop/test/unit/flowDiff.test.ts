// apps/desktop/test/unit/flowDiff.test.ts
//
// Structural diff between two saved flows (src/pages/nodes/flowDiff.ts) — the
// information half of n8n's side-by-side canvas diff, which the REVISIONS
// drawer renders as a flat "+2 nodes, -1 edge, 3 params" summary.
//
// Pure module: no IPC, no React, no zustand — just two stableFlowJson strings
// in, a diff out. The cases that matter are the ones that decide whether a
// revision row reads as SIGNAL: params yes, drag noise no, run output no.
import { describe, it, expect } from 'vitest'
import {
  diffFlows,
  diffCounts,
  isEmptyFlowDiff,
  relativeAge,
  VOLATILE_NODE_DATA_KEYS,
} from '../../src/pages/nodes/flowDiff'

// ── fixtures ─────────────────────────────────────────────────────────────────

interface TestNode { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown> }
interface TestEdge { id?: string; source: string; target: string }

function node(id: string, over: Partial<TestNode> & { data?: Record<string, unknown> } = {}): TestNode {
  return {
    id,
    type: over.type ?? 'agent',
    position: over.position ?? { x: 0, y: 0 },
    data: { label: id, ...(over.data ?? {}) },
  }
}

function flow(nodes: TestNode[], edges: TestEdge[] = [], savedAt = '2026-07-26T10:00:00.000Z'): string {
  return JSON.stringify({ version: 1, name: 'demo', nodes, edges, savedAt })
}

// ── identical ────────────────────────────────────────────────────────────────

describe('diffFlows — no change', () => {
  it('reports nothing for byte-identical flows', () => {
    const a = flow([node('n1'), node('n2')], [{ id: 'e1', source: 'n1', target: 'n2' }])
    const d = diffFlows(a, a)

    expect(d).toEqual({ nodesAdded: [], nodesRemoved: [], nodesChanged: [], edgesAdded: [], edgesRemoved: [] })
    expect(isEmptyFlowDiff(d)).toBe(true)
    expect(diffCounts(d).total).toBe(0)
  })

  it('ignores a different savedAt stamp (every save writes a fresh one)', () => {
    const nodes = [node('n1')]
    const d = diffFlows(flow(nodes, [], '2026-01-01T00:00:00.000Z'), flow(nodes, [], '2026-07-26T09:00:00.000Z'))
    expect(isEmptyFlowDiff(d)).toBe(true)
  })

  it('ignores node ORDER (an id sort is a save-format detail, not an edit)', () => {
    const d = diffFlows(flow([node('n1'), node('n2')]), flow([node('n2'), node('n1')]))
    expect(isEmptyFlowDiff(d)).toBe(true)
  })

  it('ignores nested key order inside a param', () => {
    const from = flow([node('n1', { data: { cfg: { a: 1, b: 2 } } })])
    const to   = flow([node('n1', { data: { cfg: { b: 2, a: 1 } } })])
    expect(isEmptyFlowDiff(diffFlows(from, to))).toBe(true)
  })

  it('ignores position — a dragged node is not a changed node', () => {
    const from = flow([node('n1', { position: { x: 0, y: 0 } })])
    const to   = flow([node('n1', { position: { x: 940, y: 312 } })])
    expect(isEmptyFlowDiff(diffFlows(from, to))).toBe(true)
  })

  it('ignores run state stamped onto node.data by a run', () => {
    const from = flow([node('n1')])
    const to   = flow([node('n1', { data: { lastOutput: 'hello', lastError: 'boom', lastArtifacts: [{ id: 'a' }], pinned: true } })])
    expect(isEmptyFlowDiff(diffFlows(from, to))).toBe(true)
    // Guard the list itself — silently dropping a key here would hide real edits.
    expect([...VOLATILE_NODE_DATA_KEYS].sort()).toEqual(['lastArtifacts', 'lastError', 'lastOutput', 'pinned'])
  })
})

// ── nodes ────────────────────────────────────────────────────────────────────

describe('diffFlows — nodes', () => {
  it('reports an added node with its type and label', () => {
    const d = diffFlows(flow([node('n1')]), flow([node('n1'), node('n2', { type: 'prompt', data: { label: 'Writer' } })]))
    expect(d.nodesAdded).toEqual([{ id: 'n2', type: 'prompt', label: 'Writer' }])
    expect(d.nodesRemoved).toEqual([])
    expect(diffCounts(d).total).toBe(1)
  })

  it('reports removed nodes by name — the acceptance case (delete two, save)', () => {
    const before = flow([
      node('n1', { data: { label: 'Planner' } }),
      node('n2', { data: { label: 'Writer' } }),
      node('n3', { data: { label: 'Reviewer' } }),
    ])
    const after = flow([node('n1', { data: { label: 'Planner' } })])

    const d = diffFlows(before, after)
    expect(d.nodesRemoved.map(n => n.label)).toEqual(['Writer', 'Reviewer'])
    expect(d.nodesAdded).toEqual([])
    expect(diffCounts(d)).toMatchObject({ nodesRemoved: 2, nodesAdded: 0, nodesChanged: 0, total: 2 })
  })

  it('is directional: added = present in the SECOND argument', () => {
    const one = flow([node('n1')])
    const two = flow([node('n1'), node('n2')])
    expect(diffFlows(one, two).nodesAdded.map(n => n.id)).toEqual(['n2'])
    expect(diffFlows(two, one).nodesRemoved.map(n => n.id)).toEqual(['n2'])
  })

  it('names exactly which params changed, sorted', () => {
    const from = flow([node('n1', { data: { systemPrompt: 'be brief', retries: 0, model: 'x' } })])
    const to   = flow([node('n1', { data: { systemPrompt: 'be thorough', retries: 2, model: 'x' } })])

    const d = diffFlows(from, to)
    expect(d.nodesChanged).toEqual([{ id: 'n1', type: 'agent', label: 'n1', params: ['retries', 'systemPrompt'] }])
    expect(diffCounts(d)).toMatchObject({ nodesChanged: 1, params: 2, total: 1 })
  })

  it('counts an added param and a removed param', () => {
    const d = diffFlows(
      flow([node('n1', { data: { retries: 2 } })]),
      flow([node('n1', { data: { retryDelayMs: 1500 } })]),
    )
    expect(d.nodesChanged[0]!.params).toEqual(['retries', 'retryDelayMs'])
  })

  it('detects a change inside a nested object / array param', () => {
    const from = flow([node('n1', { data: { cfg: { tools: ['a', 'b'] } } })])
    const to   = flow([node('n1', { data: { cfg: { tools: ['a', 'c'] } } })])
    expect(diffFlows(from, to).nodesChanged[0]!.params).toEqual(['cfg'])
  })

  it('reports a retyped node as the pseudo-param `type`', () => {
    const d = diffFlows(flow([node('n1', { type: 'agent' })]), flow([node('n1', { type: 'prompt' })]))
    expect(d.nodesChanged).toEqual([{ id: 'n1', type: 'prompt', label: 'n1', params: ['type'] }])
  })

  it('sums params across every changed node', () => {
    const from = flow([node('n1', { data: { a: 1, b: 1 } }), node('n2', { data: { c: 1 } })])
    const to   = flow([node('n1', { data: { a: 2, b: 2 } }), node('n2', { data: { c: 2 } })])
    expect(diffCounts(diffFlows(from, to))).toMatchObject({ nodesChanged: 2, params: 3, total: 2 })
  })

  it('falls back to the id when a node has no label', () => {
    const raw = JSON.stringify({ version: 1, nodes: [{ id: 'n9', type: 'note', position: { x: 0, y: 0 } }], edges: [] })
    expect(diffFlows(flow([]), raw).nodesAdded).toEqual([{ id: 'n9', type: 'note', label: '' }])
  })
})

// ── edges ────────────────────────────────────────────────────────────────────

describe('diffFlows — edges', () => {
  it('reports added and removed edges', () => {
    const from = flow([node('n1'), node('n2'), node('n3')], [{ id: 'e1', source: 'n1', target: 'n2' }])
    const to   = flow([node('n1'), node('n2'), node('n3')], [{ id: 'e2', source: 'n2', target: 'n3' }])

    const d = diffFlows(from, to)
    expect(d.edgesAdded).toEqual([{ id: 'e2', source: 'n2', target: 'n3' }])
    expect(d.edgesRemoved).toEqual([{ id: 'e1', source: 'n1', target: 'n2' }])
    expect(diffCounts(d)).toMatchObject({ edgesAdded: 1, edgesRemoved: 1, total: 2 })
  })

  it('keys an id-less edge by source->target so old files still diff', () => {
    const from = flow([node('n1'), node('n2')], [{ source: 'n1', target: 'n2' }])
    const to   = flow([node('n1'), node('n2')], [{ source: 'n1', target: 'n2' }])
    expect(isEmptyFlowDiff(diffFlows(from, to))).toBe(true)

    const moved = flow([node('n1'), node('n2')], [{ source: 'n2', target: 'n1' }])
    expect(diffCounts(diffFlows(from, moved))).toMatchObject({ edgesAdded: 1, edgesRemoved: 1 })
  })

  it('does not report edges for a node that merely moved', () => {
    const edges = [{ id: 'e1', source: 'n1', target: 'n2' }]
    const from = flow([node('n1'), node('n2', { position: { x: 0, y: 0 } })], edges)
    const to   = flow([node('n1'), node('n2', { position: { x: 500, y: 500 } })], edges)
    expect(isEmptyFlowDiff(diffFlows(from, to))).toBe(true)
  })
})

// ── malformed / hostile input ────────────────────────────────────────────────

describe('diffFlows — tolerance', () => {
  it('treats unparseable JSON as an empty flow instead of throwing', () => {
    const good = flow([node('n1')])
    expect(() => diffFlows('{not json', good)).not.toThrow()
    expect(diffFlows('{not json', good).nodesAdded.map(n => n.id)).toEqual(['n1'])
    expect(diffFlows(good, '').nodesRemoved.map(n => n.id)).toEqual(['n1'])
  })

  it('survives a missing / non-array nodes or edges field', () => {
    const d = diffFlows(JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, nodes: 'nope', edges: 7 }))
    expect(isEmptyFlowDiff(d)).toBe(true)
  })

  it('skips node entries with no usable id, and keeps the FIRST of a duplicated id', () => {
    const raw = JSON.stringify({
      version: 1,
      nodes: [null, 'garbage', { type: 'agent' }, { id: 'dup', type: 'agent', data: { label: 'first' } }, { id: 'dup', type: 'prompt', data: { label: 'second' } }],
      edges: [],
    })
    const d = diffFlows(flow([]), raw)
    expect(d.nodesAdded).toEqual([{ id: 'dup', type: 'agent', label: 'first' }])
  })
})

// ── relative age ─────────────────────────────────────────────────────────────

describe('relativeAge', () => {
  const NOW = Date.parse('2026-07-26T12:00:00.000Z')
  const ago = (ms: number) => relativeAge(NOW - ms, NOW)

  it('buckets seconds / minutes / hours / days', () => {
    expect(ago(5_000)).toEqual({ unit: 'now', count: 0 })
    expect(ago(59_000)).toEqual({ unit: 'now', count: 0 })
    expect(ago(60_000)).toEqual({ unit: 'minutes', count: 1 })
    expect(ago(59 * 60_000)).toEqual({ unit: 'minutes', count: 59 })
    expect(ago(60 * 60_000)).toEqual({ unit: 'hours', count: 1 })
    expect(ago(23 * 3_600_000)).toEqual({ unit: 'hours', count: 23 })
    expect(ago(24 * 3_600_000)).toEqual({ unit: 'days', count: 1 })
    expect(ago(9 * 24 * 3_600_000)).toEqual({ unit: 'days', count: 9 })
  })

  it('clamps a future timestamp to "now" instead of printing a negative age', () => {
    expect(relativeAge(NOW + 10 * 60_000, NOW)).toEqual({ unit: 'now', count: 0 })
    expect(relativeAge(Number.NaN, NOW)).toEqual({ unit: 'now', count: 0 })
  })
})
