// apps/desktop/src/pages/nodes/templates/tachiflow.ts
//
// Flow portability — the `.tachiflow.json` interchange format (UX-benchmark #4).
//
// A .tachiflow.json file is a versioned ENVELOPE around the app's internal
// TachiFlow shape, so exported flows carry provenance (app + version + export
// time) and importers can validate/upgrade before touching the canvas:
//
//   { format: "tachiflow", formatVersion: 1, app: "tachi-studio",
//     appVersion: "0.1.0", exportedAt: "<ISO>", flow: <TachiFlow> }
//
// Import always REGENERATES node/edge ids (remapFlowIds) so a flow imported
// twice — or a template instantiated twice — can never collide with ids
// already living in another flow or the canvas history.
//
// Pure module: no React, no zustand — unit-testable in node (see
// test/unit/tachiflowPortability.test.ts).

import type { TachiFlow, TachiNode, TachiEdge } from '../types'
import { parseFlow, FlowParseError, restoreUnknownNodeTypes, stripArtifactB64 } from '../serialization'

export const TACHIFLOW_FORMAT  = 'tachiflow' as const
export const TACHIFLOW_VERSION = 1 as const
export const TACHIFLOW_APP     = 'tachi-studio' as const

/** Best-effort app version for export provenance. */
const APP_VERSION: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.['VITE_APP_VERSION']
  ?? '0.1.0'

export interface TachiflowFile {
  format: typeof TACHIFLOW_FORMAT
  formatVersion: typeof TACHIFLOW_VERSION
  app: typeof TACHIFLOW_APP
  appVersion: string
  exportedAt: string // ISO 8601
  flow: TachiFlow
}

/**
 * A curated starter flow shipped with the app (rendered in the FlowsRail
 * TEMPLATES section + the empty-canvas starter cards). `file` is a complete
 * .tachiflow.json document — the same files live in repo-root examples/flows/
 * as the shareable gallery seed. label/description are English fallbacks; the
 * UI translates via `templatesRail.items.<id>.*` keys in the nodes namespace.
 */
export interface FlowTemplate {
  id: string
  label: string
  description: string
  file: TachiflowFile
}

// ── Errors ────────────────────────────────────────────────────────────────────
// Machine-readable codes so the UI can map them to friendly i18n strings.

export type TachiflowErrorCode = 'not-tachiflow' | 'unsupported-version' | 'bad-flow' | 'read-failed'

export class TachiflowParseError extends Error {
  readonly code: TachiflowErrorCode
  constructor(code: TachiflowErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export function wrapTachiflow(flow: TachiFlow): TachiflowFile {
  return {
    format: TACHIFLOW_FORMAT,
    formatVersion: TACHIFLOW_VERSION,
    app: TACHIFLOW_APP,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    flow,
  }
}

/**
 * Trigger a browser download of the flow as `<flow-name>.tachiflow.json`.
 * Returns the filename used (for the success toast).
 */
export function downloadTachiflow(flow: TachiFlow): string {
  // ⇩ IS A SAVE SEAM (review pass after 59c658a). The rail calls this with the
  // LIVE serializeFlow() graph when you export the OPEN flow, and with a graph
  // read back from disk for any other row — so before the strip, the same
  // button produced a multi-MB base64 file for one flow and a path-only file
  // for the next. The contract is now the FILE contract, wherever the graph
  // came from: an artifact that has a path exports as the path (NodeRunUI's
  // fileUrl() loads it back over tachi-media://), and a PATHLESS artifact keeps
  // its bytes because for a b64-only image the bytes ARE the result. Same rule,
  // same words, as serializeFlow's doc block in ../serialization.
  // (Idempotent: re-exporting an already-slim disk flow strips nothing and the
  // graph passes through by identity.)
  //
  // Restore any self-healed 'unknown' node to its original type so the exported
  // file round-trips losslessly (NODES-RESEARCH #3).
  const file = wrapTachiflow(stripArtifactB64(restoreUnknownNodeTypes(flow)))
  const filename = `${sanitizeName(flow.name)}.tachiflow.json`
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return filename
}

// ── Import ────────────────────────────────────────────────────────────────────

/**
 * Parse an unknown JSON value as a tachiflow envelope. Also accepts a BARE
 * .tachi-flow.json (the app's own Save format, `{ version: 1, ... }`) so both
 * file kinds import through the same button.
 */
export function parseTachiflowFile(raw: unknown): TachiFlow {
  if (typeof raw !== 'object' || raw === null) {
    throw new TachiflowParseError('not-tachiflow')
  }
  const obj = raw as Record<string, unknown>

  if (obj['format'] === TACHIFLOW_FORMAT) {
    if (obj['formatVersion'] !== TACHIFLOW_VERSION) {
      throw new TachiflowParseError('unsupported-version', `formatVersion ${String(obj['formatVersion'])}`)
    }
    try {
      return parseFlow(obj['flow'])
    } catch (err) {
      throw new TachiflowParseError('bad-flow', err instanceof Error ? err.message : String(err))
    }
  }

  // Bare app-native flow file.
  if (obj['version'] === 1) {
    try {
      return parseFlow(obj)
    } catch (err) {
      throw new TachiflowParseError('bad-flow', err instanceof Error ? err.message : String(err))
    }
  }

  throw new TachiflowParseError('not-tachiflow')
}

/** Read a File chosen via <input type="file"> and parse it as tachiflow. */
export function readTachiflowFile(file: File): Promise<TachiFlow> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const text = e.target?.result
        if (typeof text !== 'string') { reject(new TachiflowParseError('read-failed')); return }
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          reject(new TachiflowParseError('not-tachiflow')); return
        }
        resolve(parseTachiflowFile(parsed))
      } catch (err) {
        if (err instanceof TachiflowParseError || err instanceof FlowParseError) reject(err)
        else reject(new TachiflowParseError('bad-flow', String(err)))
      }
    }
    reader.onerror = () => reject(new TachiflowParseError('read-failed'))
    reader.readAsText(file)
  })
}

// ── Id remapping ──────────────────────────────────────────────────────────────

/** `{{node:<id>}}` reference tokens embedded in instruction/prompt/text fields. */
const NODE_TOKEN_RE = /\{\{node:([^}]+)\}\}/g

/**
 * Rewrite `{{node:<id>}}` tokens inside string data values so references keep
 * pointing at the right node after an id remap. Walks plain nested objects
 * (e.g. media `params`) a few levels deep; arrays/other values pass through.
 */
function rewriteNodeTokens(value: unknown, idMap: Map<string, string>, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.replace(NODE_TOKEN_RE, (match, id: string) =>
      idMap.has(id) ? `{{node:${idMap.get(id)!}}}` : match)
  }
  if (depth < 3 && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteNodeTokens(v, idMap, depth + 1)
    }
    return out
  }
  return value
}

/**
 * Clone a graph with FRESH node + edge ids (edges re-pointed to the new node
 * ids, `{{node:<id>}}` tokens in node data rewritten to match). Edges
 * referencing nodes outside the graph are dropped. Any transient ReactFlow
 * selection is cleared on the copies.
 */
export function remapFlowIds(nodes: TachiNode[], edges: TachiEdge[]): { nodes: TachiNode[]; edges: TachiEdge[] } {
  const stamp = Date.now()
  const salt  = Math.random().toString(36).slice(2, 8)
  let seq = 0

  const idMap = new Map<string, string>()
  for (const n of nodes) idMap.set(n.id, `node-${stamp}-${salt}-${++seq}`)
  const newNodes = nodes.map(n => ({
    ...n,
    id: idMap.get(n.id)!,
    data: rewriteNodeTokens(n.data, idMap) as TachiNode['data'],
    selected: false,
  }) as TachiNode)
  let eseq = 0
  const newEdges = edges
    .filter(e => idMap.has(e.source) && idMap.has(e.target))
    .map(e => ({
      ...e,
      id: `edge-${stamp}-${salt}-${++eseq}`,
      source: idMap.get(e.source)!,
      target: idMap.get(e.target)!,
    }) as TachiEdge)

  return { nodes: newNodes, edges: newEdges }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'flow'
}
