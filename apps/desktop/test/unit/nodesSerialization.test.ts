// apps/desktop/test/unit/nodesSerialization.test.ts
//
// Unit tests for the PURE parse/serialize core of the Flow (.tachi-flow.json)
// serializer: serializeFlow, parseFlow, and FlowParseError. The DOM-bound path
// (readFlowFile → FileReader/File) is NOT exercised here — the vitest
// environment is 'node' and it needs the browser. (The ⇩ export lives in
// templates/tachiflow.ts and is stub-driven in flowSaveArtifactWeight.test.ts.)
// We test the framework-free core that round-trips a flow and validates input.

import { describe, it, expect } from 'vitest'
import {
  serializeFlow,
  parseFlow,
  FlowParseError,
} from '../../src/pages/nodes/serialization'
import type { TachiNode, TachiEdge } from '../../src/pages/nodes/types'

// Deterministic fixtures. Casts keep us honest about the runtime shape the
// serializer actually sees (it never inspects node/edge internals).
const NODES = [
  { id: 'n1', type: 'provider', position: { x: 0, y: 0 }, data: { label: 'P', providerId: 'bankr' } },
  { id: 'n2', type: 'agent', position: { x: 120, y: 40 }, data: { label: 'A', harnessId: 'openclaude' } },
] as unknown as TachiNode[]

const EDGES = [
  { id: 'e1', source: 'n1', target: 'n2', data: { instruction: 'use this model' } },
] as unknown as TachiEdge[]

describe('serializeFlow', () => {
  it('stamps version 1 and the given name/nodes/edges', () => {
    const flow = serializeFlow('My Flow', NODES, EDGES)
    expect(flow.version).toBe(1)
    expect(flow.name).toBe('My Flow')
    expect(flow.nodes).toBe(NODES)
    expect(flow.edges).toBe(EDGES)
  })

  it('records an ISO-8601 savedAt timestamp', () => {
    const flow = serializeFlow('t', [], [])
    expect(typeof flow.savedAt).toBe('string')
    expect(new Date(flow.savedAt).toISOString()).toBe(flow.savedAt)
  })
})

describe('serialize → parse round-trip', () => {
  it('preserves nodes and edges through JSON', () => {
    const flow = serializeFlow('Round Trip', NODES, EDGES)
    const reparsed = parseFlow(JSON.parse(JSON.stringify(flow)))
    expect(reparsed.version).toBe(1)
    expect(reparsed.name).toBe('Round Trip')
    expect(reparsed.nodes).toEqual(NODES)
    expect(reparsed.edges).toEqual(EDGES)
    expect(reparsed.savedAt).toBe(flow.savedAt)
  })

  it('round-trips an empty flow', () => {
    const flow = serializeFlow('Empty', [], [])
    const reparsed = parseFlow(JSON.parse(JSON.stringify(flow)))
    expect(reparsed.nodes).toEqual([])
    expect(reparsed.edges).toEqual([])
  })
})

describe('parseFlow — structural validation', () => {
  it('rejects a non-object (string)', () => {
    expect(() => parseFlow('not json')).toThrow(FlowParseError)
    expect(() => parseFlow('not json')).toThrow('File is not a JSON object')
  })

  it('rejects null', () => {
    expect(() => parseFlow(null)).toThrow(FlowParseError)
  })

  it('throws a FlowParseError that is also an Error', () => {
    try {
      parseFlow(42)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(FlowParseError)
      expect(err).toBeInstanceOf(Error)
    }
  })
})

describe('parseFlow — version validation', () => {
  it('rejects a missing version', () => {
    expect(() => parseFlow({ nodes: [], edges: [] })).toThrow(FlowParseError)
    expect(() => parseFlow({ nodes: [], edges: [] })).toThrow('Unsupported flow version: undefined')
  })

  it('rejects a wrong numeric version', () => {
    expect(() => parseFlow({ version: 2, nodes: [], edges: [] })).toThrow('Unsupported flow version: 2')
  })

  it('rejects a stringified "1" version (strict equality)', () => {
    expect(() => parseFlow({ version: '1', nodes: [], edges: [] })).toThrow('Unsupported flow version: 1')
  })
})

describe('parseFlow — node/edge array validation', () => {
  it('rejects non-array nodes', () => {
    expect(() => parseFlow({ version: 1, nodes: {}, edges: [] })).toThrow('Missing nodes array')
  })

  it('rejects missing nodes', () => {
    expect(() => parseFlow({ version: 1, edges: [] })).toThrow('Missing nodes array')
  })

  it('rejects non-array edges', () => {
    expect(() => parseFlow({ version: 1, nodes: [], edges: 'nope' })).toThrow('Missing edges array')
  })

  it('rejects missing edges', () => {
    expect(() => parseFlow({ version: 1, nodes: [] })).toThrow('Missing edges array')
  })

  it('checks version before nodes (version wins)', () => {
    expect(() => parseFlow({ version: 9, nodes: {}, edges: {} })).toThrow('Unsupported flow version: 9')
  })
})

describe('parseFlow — optional field normalization', () => {
  it('defaults a missing name to "Imported flow"', () => {
    const flow = parseFlow({ version: 1, nodes: [], edges: [] })
    expect(flow.name).toBe('Imported flow')
  })

  it('defaults a non-string name to "Imported flow"', () => {
    const flow = parseFlow({ version: 1, name: 123, nodes: [], edges: [] })
    expect(flow.name).toBe('Imported flow')
  })

  it('keeps a provided string name', () => {
    const flow = parseFlow({ version: 1, name: 'Kept', nodes: [], edges: [] })
    expect(flow.name).toBe('Kept')
  })

  it('keeps a provided string savedAt', () => {
    const flow = parseFlow({ version: 1, name: 'x', nodes: [], edges: [], savedAt: '2026-01-01T00:00:00.000Z' })
    expect(flow.savedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('synthesizes an ISO savedAt when missing', () => {
    const flow = parseFlow({ version: 1, nodes: [], edges: [] })
    expect(new Date(flow.savedAt).toISOString()).toBe(flow.savedAt)
  })

  it('synthesizes an ISO savedAt when non-string', () => {
    const flow = parseFlow({ version: 1, nodes: [], edges: [], savedAt: 999 })
    expect(typeof flow.savedAt).toBe('string')
    expect(new Date(flow.savedAt).toISOString()).toBe(flow.savedAt)
  })

  it('always normalizes the returned version to the literal 1', () => {
    const flow = parseFlow({ version: 1, name: 'x', nodes: [], edges: [] })
    expect(flow.version).toBe(1)
  })

  it('self-heals malformed node/edge arrays instead of trusting them (NODES-RESEARCH #3)', () => {
    // parseFlow now runs sanitizeFlow at the JSON-import seam: an object node
    // missing type/id/position is healed to an inert 'unknown' tile with
    // defaults; non-object garbage nodes and edges with unresolved (or null)
    // endpoints are dropped — so a broken/foreign flow never opens broken.
    const junkNodes = [{ anything: true }, 'string-node'] as unknown
    const junkEdges = [null] as unknown
    const flow = parseFlow({ version: 1, nodes: junkNodes, edges: junkEdges })
    // The object node is kept + healed; the string garbage node is dropped.
    expect(flow.nodes).toHaveLength(1)
    expect(flow.nodes[0]!.type).toBe('unknown')
    expect(typeof flow.nodes[0]!.id).toBe('string')
    expect(flow.nodes[0]!.position).toEqual({ x: 0, y: 0 })
    // The null edge is dropped (no endpoints resolve).
    expect(flow.edges).toEqual([])
  })
})
