// apps/desktop/test/unit/flowSaveArtifactWeight.test.ts
//
// THE FLOW FILE THAT ATE A CLIP (FLF driver, finding 4).
//
// Measured: a 1.2 KB .tachi-flow.json became 3751 KB after ONE canvas run. The
// renderer stamps `lastArtifacts` onto the media node after every run, and an
// artifact carries BOTH `path` (the file sd-cli wrote) and `b64` (the inline
// copy the node card previews from) — so the save wrote the whole video, base64
// -inflated, into a JSON file. Every autosave after that re-stringified it: a
// flow switch, a template open, an import, a Save click.
//
// THE FIX IS AT THE SAVE SEAM, not at the producer: `b64` is exactly what makes
// an in-memory run fast (the canvas previews it without a disk round-trip, and
// resolveWiredImages hands it straight to the next stage), so it must keep
// flowing at RUN time — `serializeFlow` is untouched. What the FILE needs is
// the path, because every loader already prefers the path:
//   • NodeRunUI.ArtifactView / NodesPage's viewer → `b64 ? data: : tachi-media://<path>`
//   • main's resolveWiredImages                   → `img.b64 ?? readFileSync(img.path)`
//
// The one artifact that must KEEP its bytes is the one with no path at all
// (a small b64-only image from a cloud provider): dropping those would be
// deleting the result, not slimming the file.
//
// Migration is the same rule running once more: an old fat flow loads with its
// b64 intact and the next save writes the slim shape.

import { describe, it, expect, vi } from 'vitest'

// nodes.store persists through plain localStorage (no encryption — see its own
// header); shim it before the store module is pulled in, the same way
// nodesHistory.test.ts does.
const _ls = new Map<string, string>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}

import {
  stableFlowJson, stripArtifactB64, stripNodesArtifactB64, parseFlow, serializeFlow,
} from '../../src/pages/nodes/serialization'
import { downloadTachiflow } from '../../src/pages/nodes/templates/tachiflow'
import { useNodesStore } from '../../src/pages/nodes/store/nodes.store'
import type { TachiFlow, TachiNode } from '../../src/pages/nodes/types'

/** ~1 MB of base64, i.e. what a short clip actually looks like in the file. */
const FAT = 'A'.repeat(1_000_000)

function mediaNode(id: string, lastArtifacts: unknown[]): TachiNode {
  return {
    id, type: 'media', position: { x: 0, y: 0 },
    data: { label: id, modality: 'video', provider: 'local', model: 'wan21-t2v-1.3b', params: { duration: 2 }, lastArtifacts },
  } as TachiNode
}

function outputCard(id: string, artifacts: unknown[]): TachiNode {
  return {
    id, type: 'output', position: { x: 0, y: 0 },
    data: { label: 'out', auto: true, kind: 'media', sourceId: 'vid', artifacts },
  } as TachiNode
}

const flowOf = (nodes: TachiNode[]): TachiFlow =>
  ({ version: 1, name: 'weighty', nodes, edges: [], savedAt: '2026-07-28T00:00:00.000Z' } as TachiFlow)

const clip = (extra: Record<string, unknown> = {}) =>
  ({ kind: 'video', mimeType: 'video/webm', path: 'D:\\out\\sd-vid-1.webm', b64: FAT, ...extra })

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE SAVED SHAPE
// ═════════════════════════════════════════════════════════════════════════════

describe('the saved file after one run', () => {
  it('does not carry the clip — the path is the artifact', () => {
    const json = stableFlowJson(flowOf([mediaNode('vid', [clip()])]))
    expect(json).not.toContain(FAT)
    expect(json).toContain('sd-vid-1.webm')
  })

  it('stays in the kilobytes a graph should weigh', () => {
    const json = stableFlowJson(flowOf([mediaNode('vid', [clip()])]))
    expect(json.length).toBeLessThan(4_000)
  })

  it('slims an OUTPUT card the same way (the same bytes, stored twice)', () => {
    const json = stableFlowJson(flowOf([mediaNode('vid', [clip()]), outputCard('out', [clip()])]))
    expect(json).not.toContain(FAT)
  })

  it('keeps every other field of the artifact', () => {
    const flow = flowOf([mediaNode('vid', [clip()])])
    const back = parseFlow(JSON.parse(stableFlowJson(flow)))
    const art = (back.nodes[0]!.data as { lastArtifacts: Array<Record<string, unknown>> }).lastArtifacts[0]!
    expect(art.kind).toBe('video')
    expect(art.mimeType).toBe('video/webm')
    expect(art.path).toBe('D:\\out\\sd-vid-1.webm')
    expect('b64' in art).toBe(false)
  })

  it('leaves the rest of the node data alone', () => {
    const back = parseFlow(JSON.parse(stableFlowJson(flowOf([mediaNode('vid', [clip()])]))))
    const d = back.nodes[0]!.data as { model?: string; params?: Record<string, unknown> }
    expect(d.model).toBe('wan21-t2v-1.3b')
    expect(d.params).toEqual({ duration: 2 })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 2. WHAT MUST SURVIVE
// ═════════════════════════════════════════════════════════════════════════════

describe('an artifact with NO path keeps its bytes', () => {
  it('a b64-only image is the whole result — dropping it would be a delete', () => {
    const json = stableFlowJson(flowOf([mediaNode('img', [{ kind: 'image', mimeType: 'image/png', b64: 'SMALL' }])]))
    expect(json).toContain('SMALL')
  })

  it('an empty-string path is not a path', () => {
    const json = stableFlowJson(flowOf([mediaNode('img', [{ kind: 'image', b64: 'SMALL', path: '   ' }])]))
    expect(json).toContain('SMALL')
  })

  it('mixed artifacts are judged one at a time', () => {
    const json = stableFlowJson(flowOf([mediaNode('vid', [
      clip(),
      { kind: 'image', mimeType: 'image/png', b64: 'KEEP-ME' },
    ])]))
    expect(json).not.toContain(FAT)
    expect(json).toContain('KEEP-ME')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 3. THE PURE PASS
// ═════════════════════════════════════════════════════════════════════════════

describe('stripArtifactB64', () => {
  it('never mutates its input (the LIVE canvas keeps previewing)', () => {
    const flow = flowOf([mediaNode('vid', [clip()])])
    stripArtifactB64(flow)
    const live = (flow.nodes[0]!.data as { lastArtifacts: Array<{ b64?: string }> }).lastArtifacts[0]!
    expect(live.b64).toBe(FAT)
  })

  it('returns the SAME object when there is nothing to strip (no churn)', () => {
    const flow = flowOf([mediaNode('vid', [{ kind: 'image', path: 'D:\\a.png' }])])
    expect(stripArtifactB64(flow)).toBe(flow)
  })

  it('survives junk where an artifact list should be', () => {
    const flow = flowOf([
      mediaNode('a', []),
      { id: 'b', type: 'media', position: { x: 0, y: 0 }, data: { lastArtifacts: 'not-an-array' } } as unknown as TachiNode,
      { id: 'c', type: 'text', position: { x: 0, y: 0 }, data: {} } as unknown as TachiNode,
    ])
    expect(() => stripArtifactB64(flow)).not.toThrow()
  })

  // The accumulator folds one key at a time ({...(nextData ?? data), [key]:…}),
  // so a node holding BOTH lists is the case where a wrong base object would
  // silently drop the FIRST key's slimming. Every review pass so far only ever
  // fed it one key per node.
  it('strips BOTH artifact keys on the same node without losing either', () => {
    const both = {
      id: 'vid', type: 'media', position: { x: 0, y: 0 },
      data: {
        label: 'vid', model: 'wan21-t2v-1.3b', params: { duration: 2 },
        lastArtifacts: [clip()],
        artifacts:     [clip({ path: 'D:\\out\\sd-vid-2.webm' })],
      },
    } as unknown as TachiNode
    const out = stripArtifactB64(flowOf([both]))
    const d = out.nodes[0]!.data as Record<string, unknown>
    const last = (d['lastArtifacts'] as Array<Record<string, unknown>>)[0]!
    const arts = (d['artifacts'] as Array<Record<string, unknown>>)[0]!
    expect('b64' in last).toBe(false)
    expect('b64' in arts).toBe(false)
    expect(last['path']).toBe('D:\\out\\sd-vid-1.webm')
    expect(arts['path']).toBe('D:\\out\\sd-vid-2.webm')
    // …and nothing else on the node data moved.
    expect(d['label']).toBe('vid')
    expect(d['model']).toBe('wan21-t2v-1.3b')
    expect(d['params']).toEqual({ duration: 2 })
    expect(JSON.stringify(out)).not.toContain(FAT)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 4. MIGRATION + THE RUN PATH
// ═════════════════════════════════════════════════════════════════════════════

describe('an old fat flow', () => {
  const fatFile = JSON.stringify(flowOf([mediaNode('vid', [clip()])]))

  it('still loads with its inline bytes (nothing is lost on open)', () => {
    const loaded = parseFlow(JSON.parse(fatFile))
    const art = (loaded.nodes[0]!.data as { lastArtifacts: Array<{ b64?: string }> }).lastArtifacts[0]!
    expect(art.b64).toBe(FAT)
  })

  it('slims itself on the NEXT save', () => {
    const loaded = parseFlow(JSON.parse(fatFile))
    expect(stableFlowJson(loaded)).not.toContain(FAT)
  })
})

describe('the RUN path is deliberately untouched', () => {
  it('serializeFlow still carries b64 — main reads it for the next stage', () => {
    const nodes = [mediaNode('vid', [clip()])]
    const flow = serializeFlow('run', nodes, [])
    const art = (flow.nodes[0]!.data as { lastArtifacts: Array<{ b64?: string }> }).lastArtifacts[0]!
    expect(art.b64).toBe(FAT)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 5. EVERY SAVE SEAM GOES THROUGH IT
// ═════════════════════════════════════════════════════════════════════════════
//
// The rail's own writes bypassed stableFlowJson entirely (`JSON.stringify(
// serializeFlow(...))`), and the rail is where the AUTOSAVES happen — every
// flow switch, import and template open. A fix that only covered the Save
// button would have left the balloon exactly where the driver found it.

describe('the save seams', () => {
  const src = (rel: string) =>
    require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', '..', rel), 'utf8') as string

  it('the flows rail autosave writes the stable (slim) JSON', () => {
    const rail = src('src/pages/nodes/sidebar/FlowsRail.tsx')
    expect(rail).not.toContain('JSON.stringify(serializeFlow(')
    expect((rail.match(/stableFlowJson\(serializeFlow\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('saveFlowToApp goes through the one serializer', () => {
    expect(src('src/pages/nodes/serialization.ts')).toContain('const json = stableFlowJson(flow)')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 6. THE ⇩ EXPORT IS A SAVE SEAM TOO
// ═════════════════════════════════════════════════════════════════════════════
//
// The section above used to pin `new Blob([stableFlowJson(flow)]` — a string
// that only ever existed inside the DEAD downloadFlow (zero call sites), so the
// seam it claimed to guard was never the LIVE one. The live ⇩ is FlowsRail's
// exportFlow → downloadTachiflow, and for the OPEN flow it passes a raw
// serializeFlow() result: full b64, the exact multi-MB balloon this file is
// about, while exporting a NON-open row (read back from the already-slimmed
// disk file) produced a path-only file. Two ⇩ buttons, two weights.
// So the assertion is behavioural now: drive downloadTachiflow and read the
// bytes it hands the Blob.

const src2 = (rel: string) =>
  require('node:fs').readFileSync(require('node:path').resolve(__dirname, '..', '..', rel), 'utf8') as string

/** Run downloadTachiflow against stubbed DOM globals; return the JSON text. */
function exportedJson(flow: TachiFlow): string {
  let captured = ''
  class CapturingBlob {
    constructor(parts: unknown[]) { captured = parts.map(String).join('') }
  }
  const anchor = { href: '', download: '', click: () => {} }
  vi.stubGlobal('Blob', CapturingBlob)
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:flow', revokeObjectURL: () => {} })
  vi.stubGlobal('document', { createElement: () => anchor })
  // downloadTachiflow schedules a revoke 1s out; keep it from ever firing
  // against the un-stubbed globals.
  vi.useFakeTimers()
  try {
    downloadTachiflow(flow)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
  return captured
}

describe('the ⇩ tachiflow export', () => {
  it('exports the path, not the clip', () => {
    const json = exportedJson(flowOf([mediaNode('vid', [clip()])]))
    expect(json).not.toContain(FAT)
    expect(json).toContain('sd-vid-1.webm')
  })

  it('slims the OUTPUT card too, and stays graph-sized', () => {
    const json = exportedJson(flowOf([mediaNode('vid', [clip()]), outputCard('out', [clip()])]))
    expect(json).not.toContain(FAT)
    expect(json.length).toBeLessThan(4_000)
  })

  it('keeps a pathless artifact whole — same rule as the file save', () => {
    const json = exportedJson(flowOf([mediaNode('img', [{ kind: 'image', mimeType: 'image/png', b64: 'SMALL' }])]))
    expect(json).toContain('SMALL')
  })

  it('still writes a valid tachiflow envelope around the slim graph', () => {
    const parsed = JSON.parse(exportedJson(flowOf([mediaNode('vid', [clip()])]))) as
      { format?: string; formatVersion?: number; flow?: TachiFlow }
    expect(parsed.format).toBe('tachiflow')
    expect(parsed.formatVersion).toBe(1)
    const art = (parsed.flow!.nodes[0]!.data as { lastArtifacts: Array<Record<string, unknown>> }).lastArtifacts[0]!
    expect(art['path']).toBe('D:\\out\\sd-vid-1.webm')
    expect('b64' in art).toBe(false)
  })

  it('the dead downloadFlow is gone (it was the only thing that seam test pinned)', () => {
    expect(src2('src/pages/nodes/serialization.ts')).not.toContain('export function downloadFlow')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 7. THE localStorage AUTOSAVE IS THE THIRD SEAM
// ═════════════════════════════════════════════════════════════════════════════
//
// nodes.store's partialize wrote `nodes` verbatim into localStorage on a 500ms
// throttle — so the clip that no longer reaches the FILE was still being
// base64-stringified into a ~5MB-quota bucket on every canvas edit, and the
// quota failure there is a console.warn (the graph silently stops persisting).
// media.store already stripped b64 in ITS partialize; these two seams
// disagreed. Same rule, one implementation: stripNodesArtifactB64.

describe('the localStorage canvas autosave', () => {
  const partialize = () => {
    const opts = useNodesStore.persist.getOptions()
    if (!opts.partialize) throw new Error('nodes.store has no partialize')
    return opts.partialize
  }

  it('persists the path, not the clip', () => {
    const fat = mediaNode('vid', [clip()])
    useNodesStore.setState({ nodes: [fat], edges: [], flowName: 'weighty' })
    const persisted = partialize()(useNodesStore.getState())
    expect(JSON.stringify(persisted)).not.toContain(FAT)
    expect(JSON.stringify(persisted)).toContain('sd-vid-1.webm')
  })

  it('leaves the LIVE canvas node previewing its bytes', () => {
    const fat = mediaNode('vid', [clip()])
    useNodesStore.setState({ nodes: [fat], edges: [], flowName: 'weighty' })
    partialize()(useNodesStore.getState())
    const live = (useNodesStore.getState().nodes[0]!.data as { lastArtifacts: Array<{ b64?: string }> }).lastArtifacts[0]!
    expect(live.b64).toBe(FAT)
  })

  it('a b64-only artifact survives a reload (no path to reload it from)', () => {
    const only = mediaNode('img', [{ kind: 'image', mimeType: 'image/png', b64: 'SMALL' }])
    useNodesStore.setState({ nodes: [only], edges: [], flowName: 'weighty' })
    expect(JSON.stringify(partialize()(useNodesStore.getState()))).toContain('SMALL')
  })

  it('still persists flowName and edges', () => {
    useNodesStore.setState({
      nodes: [], flowName: 'named',
      edges: [{ id: 'e1', source: 'a', target: 'b' }] as never,
    })
    const persisted = partialize()(useNodesStore.getState()) as { flowName?: string; edges?: unknown[] }
    expect(persisted.flowName).toBe('named')
    expect(persisted.edges).toHaveLength(1)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// 8. ONE IMPLEMENTATION OF THE RULE
// ═════════════════════════════════════════════════════════════════════════════

describe('stripNodesArtifactB64 (the shared node-array pass)', () => {
  it('is what stripArtifactB64 is built on — identical verdict', () => {
    const nodes = [mediaNode('vid', [clip()]), outputCard('out', [clip()])]
    const viaFlow = stripArtifactB64(flowOf(nodes)).nodes
    expect(stripNodesArtifactB64(nodes)).toEqual(viaFlow)
  })

  it('returns the SAME array when there is nothing to strip (no churn)', () => {
    const nodes = [mediaNode('vid', [{ kind: 'image', path: 'D:\\a.png' }])]
    expect(stripNodesArtifactB64(nodes)).toBe(nodes)
  })
})
