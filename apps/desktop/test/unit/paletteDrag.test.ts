// apps/desktop/test/unit/paletteDrag.test.ts
//
// NODES-RESEARCH #12 (palette drag-preview polish). Unit tests for the PURE
// drag-payload helpers (src/pages/nodes/sidebar/paletteDrag.ts) — the only
// non-DOM logic in the change: serialize / parse round-trips, the preview-label
// builder, and the category→colour map. The actual drag WIRING (setDragImage,
// onDrop) is DOM-only and covered by manual/E2E, not here.

import { describe, it, expect } from 'vitest'
import {
  NODE_DRAG_MIME,
  serializeNodeDrag,
  parseNodeDrag,
  dragPreviewLabel,
  paletteCategoryColor,
} from '../../src/pages/nodes/sidebar/paletteDrag'
import type { PaletteTemplate } from '../../src/pages/nodes/types'

const tpl = (over: Partial<PaletteTemplate> = {}): PaletteTemplate => ({
  type: 'agent',
  label: 'OpenClaude',
  data: { label: 'OpenClaude', harnessId: 'openclaude' },
  ...over,
}) as PaletteTemplate

describe('NODE_DRAG_MIME', () => {
  it('is a bespoke (non text/plain) mime type so foreign OS drags are ignored', () => {
    expect(NODE_DRAG_MIME).toBe('application/x-tachi-palette-node')
    expect(NODE_DRAG_MIME).not.toBe('text/plain')
  })
})

describe('serializeNodeDrag → parseNodeDrag round-trip', () => {
  it('round-trips type, label and data losslessly', () => {
    const t = tpl({ type: 'provider', label: 'Bankr', data: { label: 'Bankr', providerId: 'bankr', model: 'claude-sonnet-4.6' } })
    const parsed = parseNodeDrag(serializeNodeDrag(t))
    expect(parsed).toEqual({
      type: 'provider',
      label: 'Bankr',
      data: { label: 'Bankr', providerId: 'bankr', model: 'claude-sonnet-4.6' },
    })
  })

  it('preserves nested data structures', () => {
    const t = tpl({ type: 'media', label: 'Image', data: { label: 'Image', modality: 'image', params: { size: '1024x1024', n: 1 } } })
    const parsed = parseNodeDrag(serializeNodeDrag(t))
    expect((parsed!.data as { params: unknown }).params).toEqual({ size: '1024x1024', n: 1 })
  })

  it('serialize produces valid JSON', () => {
    expect(() => JSON.parse(serializeNodeDrag(tpl()))).not.toThrow()
  })
})

describe('parseNodeDrag (drop trust boundary)', () => {
  it('returns null for null / undefined / empty string', () => {
    expect(parseNodeDrag(null)).toBeNull()
    expect(parseNodeDrag(undefined)).toBeNull()
    expect(parseNodeDrag('')).toBeNull()
  })

  it('returns null for non-JSON garbage', () => {
    expect(parseNodeDrag('not json {')).toBeNull()
    expect(parseNodeDrag('<html>')).toBeNull()
  })

  it('returns null for JSON that is not an object', () => {
    expect(parseNodeDrag('42')).toBeNull()
    expect(parseNodeDrag('"a string"')).toBeNull()
    expect(parseNodeDrag('[1,2,3]')).toBeNull()
    expect(parseNodeDrag('null')).toBeNull()
  })

  it('returns null when type is missing or empty', () => {
    expect(parseNodeDrag('{"label":"x","data":{}}')).toBeNull()
    expect(parseNodeDrag('{"type":"","data":{}}')).toBeNull()
    expect(parseNodeDrag('{"type":123,"data":{}}')).toBeNull()
  })

  it('defaults data to {} when absent or not a plain object', () => {
    expect(parseNodeDrag('{"type":"text"}')).toEqual({ type: 'text', label: 'text', data: {} })
    expect(parseNodeDrag('{"type":"text","data":[1,2]}')?.data).toEqual({})
    expect(parseNodeDrag('{"type":"text","data":"nope"}')?.data).toEqual({})
  })

  it('falls back label to type when label is absent / non-string', () => {
    expect(parseNodeDrag('{"type":"note","data":{}}')?.label).toBe('note')
    expect(parseNodeDrag('{"type":"note","label":42,"data":{}}')?.label).toBe('note')
  })
})

describe('dragPreviewLabel', () => {
  it('returns short labels unchanged', () => {
    expect(dragPreviewLabel('Codex')).toBe('Codex')
    expect(dragPreviewLabel('Reference Image')).toBe('Reference Image')
  })

  it('collapses internal whitespace and trims the ends', () => {
    expect(dragPreviewLabel('  Reference   Image  ')).toBe('Reference Image')
    expect(dragPreviewLabel('a\t\nb')).toBe('a b')
  })

  it('truncates over-long labels with a single ellipsis, never exceeding max', () => {
    const long = 'Security Engineer with a very restrictive boundary set'
    const out = dragPreviewLabel(long, 24)
    expect(out.length).toBeLessThanOrEqual(24)
    expect(out.endsWith('…')).toBe(true)
    expect(long.startsWith(out.slice(0, -1).trimEnd())).toBe(true)
  })

  it('handles empty / whitespace-only input', () => {
    expect(dragPreviewLabel('')).toBe('')
    expect(dragPreviewLabel('   ')).toBe('')
  })

  it('returns empty string for a non-positive max', () => {
    expect(dragPreviewLabel('anything', 0)).toBe('')
    expect(dragPreviewLabel('anything', -3)).toBe('')
  })

  it('tolerates a null-ish label without throwing', () => {
    expect(dragPreviewLabel(undefined as unknown as string)).toBe('')
  })
})

describe('paletteCategoryColor', () => {
  it('maps known node types to their CSS-var colour', () => {
    expect(paletteCategoryColor('provider')).toBe('var(--accent)')
    expect(paletteCategoryColor('agent')).toBe('var(--warning)')
    expect(paletteCategoryColor('skill')).toBe('var(--success)')
    expect(paletteCategoryColor('note')).toBe('var(--warning)')
  })

  it('falls back to accent for an unknown type', () => {
    expect(paletteCategoryColor('brand-new-kind')).toBe('var(--accent)')
    expect(paletteCategoryColor('')).toBe('var(--accent)')
  })
})
