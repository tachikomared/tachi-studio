// apps/desktop/src/pages/nodes/a11y.ts
//
// Accessibility primitives shared across the Nodes surface (batch34, a11y wave 1).
//
// Kept deliberately tiny: the canvas has no CSS framework, every style in this
// surface is an inline object, and a live region has to exist in the DOM without
// occupying a single pixel of a node card. `position:absolute` + a 1×1 clip is
// the canonical visually-hidden recipe — `display:none` / `visibility:hidden`
// would remove the node from the accessibility tree entirely and silence the
// announcement we are trying to make.

import type { CSSProperties } from 'react'

/**
 * Off-screen but readable by assistive tech.
 *
 * Use for live regions (`role="status"`) whose text must reach a screen reader
 * without changing the visual design of a node card.
 */
export const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
}
