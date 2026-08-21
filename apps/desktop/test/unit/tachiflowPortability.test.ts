// test/unit/tachiflowPortability.test.ts
//
// Flow portability (.tachiflow.json) — envelope parse/validate, id remapping
// (incl. {{node:<id>}} token rewrite), curated-template integrity, and parity
// between the in-app template modules and the repo-root examples/flows gallery.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  wrapTachiflow,
  parseTachiflowFile,
  remapFlowIds,
  TachiflowParseError,
  TACHIFLOW_FORMAT,
  TACHIFLOW_VERSION,
  TACHIFLOW_APP,
} from '../../src/pages/nodes/templates/tachiflow'
import { FLOW_TEMPLATES, STARTER_CARD_TEMPLATES } from '../../src/pages/nodes/templates'
import type { TachiFlow, TachiNode, TachiEdge } from '../../src/pages/nodes/types'

const KNOWN_NODE_TYPES = new Set([
  'provider', 'agent', 'skill', 'folder', 'internet', 'mcp',
  'media', 'prompt', 'text', 'imageref', 'output',
])

function sampleFlow(): TachiFlow {
  return {
    version: 1,
    name: 'Sample',
    savedAt: '2026-07-11T00:00:00.000Z',
    nodes: [
      { id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { label: 'T', text: 'hi' } },
      { id: 'n2', type: 'prompt', position: { x: 200, y: 0 }, data: { label: 'P', providerId: 'freellmapi', model: 'auto', instruction: 'Use {{node:n1}} and also {{node:ghost}}.' } },
    ] as TachiNode[],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'E-src', targetHandle: 'W-tgt', type: 'link', data: {} },
      { id: 'e2', source: 'n2', target: 'missing', type: 'link', data: {} }, // dangling
    ] as TachiEdge[],
  }
}

describe('tachiflow envelope', () => {
  it('wrap → parse roundtrips the flow (self-healing drops the dangling edge)', () => {
    const flow = sampleFlow()
    const file = wrapTachiflow(flow)
    expect(file.format).toBe(TACHIFLOW_FORMAT)
    expect(file.formatVersion).toBe(TACHIFLOW_VERSION)
    expect(file.app).toBe(TACHIFLOW_APP)
    expect(typeof file.appVersion).toBe('string')
    expect(() => new Date(file.exportedAt)).not.toThrow()
    const parsed = parseTachiflowFile(JSON.parse(JSON.stringify(file)))
    // parseFlow now self-heals on load (NODES-RESEARCH #3): the dangling edge
    // (e2 → 'missing') is dropped; every node + the good edge round-trip intact.
    expect(parsed).toEqual({ ...flow, edges: flow.edges.filter(e => e.target !== 'missing') })
  })

  it('accepts a bare .tachi-flow.json (app-native save format)', () => {
    const flow = sampleFlow()
    const parsed = parseTachiflowFile(JSON.parse(JSON.stringify(flow)))
    expect(parsed.nodes).toHaveLength(2)
    expect(parsed.name).toBe('Sample')
  })

  it('rejects non-tachiflow JSON with code not-tachiflow', () => {
    for (const bad of [null, 42, 'x', {}, { hello: 'world' }, []]) {
      try {
        parseTachiflowFile(bad)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(TachiflowParseError)
        expect((err as TachiflowParseError).code).toBe('not-tachiflow')
      }
    }
  })

  it('rejects a future formatVersion with code unsupported-version', () => {
    const file = { ...wrapTachiflow(sampleFlow()), formatVersion: 2 }
    try {
      parseTachiflowFile(file)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as TachiflowParseError).code).toBe('unsupported-version')
    }
  })

  it('rejects an envelope with a broken inner flow with code bad-flow', () => {
    const file = { format: 'tachiflow', formatVersion: 1, app: 'tachi-studio', appVersion: '0.1.0', exportedAt: 'x', flow: { version: 1, nodes: 'nope' } }
    try {
      parseTachiflowFile(file)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as TachiflowParseError).code).toBe('bad-flow')
    }
  })
})

describe('remapFlowIds', () => {
  it('generates fresh ids, re-points edges, drops dangling edges', () => {
    const flow = sampleFlow()
    const { nodes, edges } = remapFlowIds(flow.nodes, flow.edges)
    expect(nodes).toHaveLength(2)
    const oldIds = new Set(flow.nodes.map(n => n.id))
    for (const n of nodes) expect(oldIds.has(n.id)).toBe(false)
    expect(new Set(nodes.map(n => n.id)).size).toBe(2)
    // The dangling edge (→ 'missing') is dropped; the good one is re-pointed.
    expect(edges).toHaveLength(1)
    expect(edges[0]!.source).toBe(nodes[0]!.id)
    expect(edges[0]!.target).toBe(nodes[1]!.id)
    expect(edges[0]!.sourceHandle).toBe('E-src')
    expect(edges[0]!.targetHandle).toBe('W-tgt')
  })

  it('rewrites {{node:<id>}} tokens to the new ids (unknown ids untouched)', () => {
    const flow = sampleFlow()
    const { nodes } = remapFlowIds(flow.nodes, flow.edges)
    const textNodeId = nodes[0]!.id
    const instruction = (nodes[1]!.data as { instruction?: string }).instruction ?? ''
    expect(instruction).toContain(`{{node:${textNodeId}}}`)
    expect(instruction).toContain('{{node:ghost}}') // never referenced a real node → left alone
    expect(instruction).not.toContain('{{node:n1}}')
  })

  it('two instantiations of the same template never share ids', () => {
    const tpl = FLOW_TEMPLATES[0]!
    const a = remapFlowIds(tpl.file.flow.nodes, tpl.file.flow.edges)
    const b = remapFlowIds(tpl.file.flow.nodes, tpl.file.flow.edges)
    const aIds = new Set(a.nodes.map(n => n.id))
    for (const n of b.nodes) expect(aIds.has(n.id)).toBe(false)
  })
})

describe('curated templates', () => {
  it('ships 5-7 templates and 3 starter cards', () => {
    expect(FLOW_TEMPLATES.length).toBeGreaterThanOrEqual(5)
    expect(FLOW_TEMPLATES.length).toBeLessThanOrEqual(7)
    expect(STARTER_CARD_TEMPLATES).toHaveLength(3)
    expect(new Set(FLOW_TEMPLATES.map(t => t.id)).size).toBe(FLOW_TEMPLATES.length)
  })

  for (const tpl of FLOW_TEMPLATES) {
    describe(tpl.id, () => {
      const { flow } = tpl.file

      it('is a valid tachiflow envelope', () => {
        const parsed = parseTachiflowFile(JSON.parse(JSON.stringify(tpl.file)))
        expect(parsed.name).toBe(flow.name)
        expect(tpl.label.length).toBeGreaterThan(0)
        expect(tpl.description.length).toBeGreaterThan(0)
      })

      it('has a coherent graph (unique ids, known types, edges resolve)', () => {
        expect(flow.nodes.length).toBeGreaterThan(0)
        const ids = new Set(flow.nodes.map(n => n.id))
        expect(ids.size).toBe(flow.nodes.length)
        for (const n of flow.nodes) {
          expect(KNOWN_NODE_TYPES.has(n.type)).toBe(true)
          expect(typeof (n.data as { label?: unknown }).label).toBe('string')
        }
        for (const e of flow.edges) {
          expect(ids.has(e.source)).toBe(true)
          expect(ids.has(e.target)).toBe(true)
          expect(e.type).toBe('link')
        }
        // Edge ids unique too.
        expect(new Set(flow.edges.map(e => e.id)).size).toBe(flow.edges.length)
      })

      it('wires media nodes through their typed plugs', () => {
        const mediaIds = new Set(flow.nodes.filter(n => n.type === 'media').map(n => n.id))
        for (const e of flow.edges) {
          if (mediaIds.has(e.target)) {
            expect(['prompt', 'folder', 'image']).toContain(e.targetHandle)
          }
        }
      })

      it('gives every agent a provider and every prompt node a model', () => {
        const providerIds = new Set(flow.nodes.filter(n => n.type === 'provider').map(n => n.id))
        for (const n of flow.nodes) {
          if (n.type === 'agent') {
            const fed = flow.edges.some(e => e.target === n.id && providerIds.has(e.source))
            expect(fed, `agent ${n.id} needs a provider edge`).toBe(true)
            expect((n.data as { harnessId?: string }).harnessId).toBeTruthy()
          }
          if (n.type === 'prompt') {
            const d = n.data as { providerId?: string; model?: string; instruction?: string }
            expect(d.providerId).toBeTruthy()
            expect(d.model).toBeTruthy()
            expect(d.instruction).toBeTruthy()
          }
        }
      })
    })
  }
})

describe('examples/flows gallery parity', () => {
  const galleryDir = resolve(__dirname, '../../../../examples/flows')

  for (const tpl of FLOW_TEMPLATES) {
    it(`${tpl.id}.tachiflow.json mirrors the in-app template`, () => {
      const raw = readFileSync(resolve(galleryDir, `${tpl.id}.tachiflow.json`), 'utf8')
      const json = JSON.parse(raw)
      expect(json).toEqual(JSON.parse(JSON.stringify(tpl.file)))
    })
  }
})
