// Drag resolution for collapsible resizable panels: clamped resize vs
// snap-to-collapsed (drag well below min), keeping the restore width.
import { describe, it, expect } from 'vitest'
import { resolveSplitDrag } from '../../src/hooks/useResizablePanel'

describe('resolveSplitDrag', () => {
  const MIN = 200
  const MAX = 500

  it('passes widths inside the range through unchanged', () => {
    expect(resolveSplitDrag(320, MIN, MAX, 320)).toEqual({ w: 320, c: false })
  })

  it('clamps to min and max', () => {
    expect(resolveSplitDrag(150, MIN, MAX, 320)).toEqual({ w: 200, c: false })
    expect(resolveSplitDrag(900, MIN, MAX, 320)).toEqual({ w: 500, c: false })
  })

  it('snaps to collapsed when dragged well below min, keeping the restore width', () => {
    expect(resolveSplitDrag(99, MIN, MAX, 320)).toEqual({ w: 320, c: true })
    expect(resolveSplitDrag(-40, MIN, MAX, 320)).toEqual({ w: 320, c: true })
  })

  it('threshold sits at min/2: just above stays open (clamped), just below collapses', () => {
    expect(resolveSplitDrag(100, MIN, MAX, 320)).toEqual({ w: 200, c: false })
    expect(resolveSplitDrag(99.9, MIN, MAX, 320)).toEqual({ w: 320, c: true })
  })
})
