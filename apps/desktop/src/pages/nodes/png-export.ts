// apps/desktop/src/pages/nodes/png-export.ts
//
// Capture the live canvas to a PNG and embed the flow JSON in it
// (NODES-RESEARCH #5). Browser-only (touches the DOM + html-to-image) — the
// pure tEXt mechanics live in ./png-flow.ts, which this module reuses.
//
// Standard @xyflow/react screenshot pattern: compute the graph's bounds, derive
// a viewport transform that frames the whole graph into a fixed image size, then
// toPng() the `.react-flow__viewport` element with that transform applied. The
// resulting PNG carries stableFlowJson so dropping it back on the canvas
// reconstructs the graph.

import { toPng } from 'html-to-image'
import { getNodesBounds, getViewportForBounds, type Node } from '@xyflow/react'
import { serializeFlow, stableFlowJson } from './serialization'
import { embedFlowInPng } from './png-flow'
import type { TachiNode, TachiEdge } from './types'

const IMAGE_WIDTH  = 1600
const IMAGE_HEIGHT = 1000

/** Split a `data:image/png;base64,…` URL into raw bytes. */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const bin = atob(comma === -1 ? dataUrl : dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'flow'
}

/**
 * Render the current canvas to `<name>.png` with the flow JSON embedded, and
 * trigger a browser download. Returns the filename used (for a success toast).
 * Throws if the canvas isn't mounted or has no nodes.
 */
export async function exportFlowPng(
  name: string,
  nodes: TachiNode[],
  edges: TachiEdge[],
): Promise<string> {
  if (nodes.length === 0) throw new Error('empty canvas')

  const viewportEl = document.querySelector<HTMLElement>('.react-flow__viewport')
  if (!viewportEl) throw new Error('canvas not mounted')

  // Frame the whole graph into the fixed image. Store nodes carry `measured`
  // dimensions (the store applies ReactFlow dimension changes), so bounds are
  // accurate without the ReactFlow instance.
  const bounds = getNodesBounds(nodes as unknown as Node[])
  const viewport = getViewportForBounds(bounds, IMAGE_WIDTH, IMAGE_HEIGHT, 0.2, 2, 0.15)

  // Match the canvas background so the export isn't transparent behind nodes.
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim() || '#0a0a0a'

  const dataUrl = await toPng(viewportEl, {
    backgroundColor: bg,
    width: IMAGE_WIDTH,
    height: IMAGE_HEIGHT,
    // html-to-image can trip over cross-origin/inaccessible stylesheets; skip
    // them rather than aborting the whole capture.
    skipFonts: true,
    style: {
      width: `${IMAGE_WIDTH}px`,
      height: `${IMAGE_HEIGHT}px`,
      transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
    },
  })

  const pngBytes = dataUrlToBytes(dataUrl)
  const json = stableFlowJson(serializeFlow(name, nodes, edges))
  const embedded = embedFlowInPng(pngBytes, json)

  const filename = `${sanitizeName(name)}.png`
  const blob = new Blob([embedded as BlobPart], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return filename
}
