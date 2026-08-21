// apps/desktop/src/pages/nodes/sidebar/paletteDrag.ts
//
// NODES-RESEARCH #12 (palette drag-preview polish). PURE helpers shared by the
// palette drag SOURCE (NodePalette) and the canvas drop TARGET (FlowCanvas):
//   • a private DataTransfer mime type so the canvas only reacts to OUR drags,
//   • serialize / parse of the dragged template payload (safe, never throws),
//   • the preview-label builder for the offscreen brutalist drag ghost,
//   • the category → CSS-var colour map (also used by the palette group headers).
//
// No React, no xyflow, no DOM here — the DOM/drag WIRING lives in the two
// components; everything testable lives in this module.

import type { PaletteTemplate } from '../types'

/**
 * Private clipboard mime type. Using a bespoke type (not text/plain) means the
 * canvas can cheaply detect a palette drag via `dataTransfer.types.includes(...)`
 * during dragover (when the payload itself is unreadable for security reasons)
 * and never mistakes an unrelated OS drag (a file, selected text) for a node.
 */
export const NODE_DRAG_MIME = 'application/x-tachi-palette-node'

/** The minimal, plain-JSON shape carried across a palette→canvas drag. */
export interface NodeDragPayload {
  type: string
  label: string
  data: Record<string, unknown>
}

/** Serialize a palette template into the drag payload string. Pure. */
export function serializeNodeDrag(template: PaletteTemplate): string {
  const payload: NodeDragPayload = {
    type: template.type,
    label: template.label,
    data: template.data as Record<string, unknown>,
  }
  return JSON.stringify(payload)
}

/**
 * Parse a dropped payload back into a template descriptor. Returns null for any
 * malformed / foreign / empty string so the drop handler can bail safely — a
 * drop is a trust boundary (the string could be anything the OS handed us).
 */
export function parseNodeDrag(raw: string | null | undefined): NodeDragPayload | null {
  if (!raw || typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  if (typeof p.type !== 'string' || p.type === '') return null
  const data =
    p.data && typeof p.data === 'object' && !Array.isArray(p.data)
      ? (p.data as Record<string, unknown>)
      : {}
  const label = typeof p.label === 'string' ? p.label : p.type
  return { type: p.type, label, data }
}

/**
 * Build the label shown on the drag ghost: whitespace-collapsed and truncated
 * with an ellipsis so a long role label / description keeps the mini-card
 * compact. Pure — the single most test-worthy bit of the whole change.
 */
export function dragPreviewLabel(raw: string, max = 24): string {
  const clean = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (max <= 0) return ''
  if (clean.length <= max) return clean
  return clean.slice(0, max - 1).trimEnd() + '…'
}

/**
 * Category colour for a palette node type — a CSS custom-property reference.
 * Shared by the palette group headers, the drag ghost's border/swatch, and the
 * drop affordance so all three read as one system. Unknown types fall back to
 * the accent so a new node kind still gets a sensible colour.
 */
const PALETTE_TYPE_COLORS: Record<string, string> = {
  provider: 'var(--accent)',
  prompt:   'var(--accent)',
  agent:    'var(--warning)',
  skill:    'var(--success)',
  folder:   'var(--success)',
  internet: 'var(--warning)',
  mcp:      'var(--accent)',
  media:    'var(--accent)',
  // A post-process step, not a generator — it borrows the media family's accent
  // so it reads as part of the same vertical in the palette and on the minimap.
  rife:     'var(--accent)',
  text:     'var(--success)',
  imageref: 'var(--warning)',
  note:     'var(--warning)',
  webhook:  'var(--warning)',
}

export function paletteCategoryColor(type: string): string {
  return PALETTE_TYPE_COLORS[type] ?? 'var(--accent)'
}
