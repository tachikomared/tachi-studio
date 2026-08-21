// apps/desktop/test/unit/resizeCursor.test.ts
//
// Regression cover for "the drag-resize cursor is missing in the new themes".
//
// Both handle components (ResizablePanelEdge = the AppShell sidebar edge,
// SplitHandle = the pane splitters from 407d868) set `cursor: col-resize` as an
// INLINE style. An inline declaration beats normal author rules but loses to any
// author `!important` — and the comic/chassis themes ship a structure layer
// (themes/<id>-structure.css) that restyles broad element selectors and already
// uses `box-shadow: none !important`. One `cursor`
// declaration in a theme sheet is all it takes to silently kill the affordance
// on that theme only, which is exactly how the bug was reported.
//
// So the cursor is now owned centrally by `.tachi-resize-handle` in globals.css
// with `!important`, and these tests pin the whole contract:
//   1. globals.css declares the winning rule (self + descendants, both axes),
//   2. no theme sheet declares `cursor` at all,
//   3. every handle component carries the class AND keeps its inline fallback,
//   4. the sidebar edge's grab strip survives the host's `overflow: hidden`.
//
// String-based, like the structure-layer guard in structureSheets.test.ts — the
// test env is node with no DOM, so there is no getComputedStyle to lean on.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  RESIZE_HANDLE_WIDTH,
  RESIZE_PILL_WIDTH,
} from '../../src/components/layout/ResizablePanelEdge'

const SRC = path.resolve(__dirname, '../../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** The class every drag-resize handle must carry. */
const HANDLE_CLASS = 'tachi-resize-handle'

/** Every stylesheet a theme may ship — palette sheets and structure layers. */
const THEME_SHEETS = [
  'bankr.css',
  'tachi-dark.css',
  'tachi-neon.css',
  'comic.css',
  'comic-structure.css',
  'tachi-opus5.css',
  'tachi-opus5-structure.css',
  'tachikoma-red.css',
  'tachikoma-red-structure.css',
]

describe('globals.css owns the resize-handle cursor', () => {
  const css = stripComments(read('globals.css'))

  it('declares the col-resize cursor on the handle class with !important', () => {
    // !important is the point: without it a theme's `cursor` rule outranks the
    // components' inline style and the affordance disappears on that theme.
    expect(css).toMatch(
      /\.tachi-resize-handle\s*,\s*\.tachi-resize-handle\s+\*\s*\{[^}]*cursor:\s*col-resize\s*!important/,
    )
  })

  it('pins the cursor on the handle DESCENDANTS too', () => {
    // `cursor` inherits, but inheritance loses to any rule matching the child —
    // and the sidebar edge nests `.tachi-resize-pill` inside the handle.
    expect(css).toContain(`.${HANDLE_CLASS} *`)
  })

  it('switches to row-resize for a horizontal separator', () => {
    expect(css).toMatch(
      /\.tachi-resize-handle\[aria-orientation="horizontal"\][^{]*\{[^}]*cursor:\s*row-resize\s*!important/,
    )
  })

  it('keeps the handle hit-testable (no cursor without a hover)', () => {
    expect(css).toMatch(/\.tachi-resize-handle\s*\{[^}]*pointer-events:\s*auto/)
  })
})

describe('theme sheets never touch the cursor', () => {
  // The convention: themes are palette (+ geometry in a structure layer). The
  // resize affordance is app-wide behaviour and belongs to globals.css. A theme
  // that sets `cursor` — especially with !important, which the structure layers
  // already use for box-shadow — reintroduces exactly the reported defect.
  for (const sheet of THEME_SHEETS) {
    it(`${sheet} declares no cursor`, () => {
      const css = stripComments(read(path.join('themes', sheet)))
      expect(
        /(^|[;{\s])cursor\s*:/.test(css),
        `${sheet} sets 'cursor' — themes must not; the resize handles' cursor is owned by globals.css (.tachi-resize-handle)`,
      ).toBe(false)
    })
  }

  it('no theme sheet resets the cursor through a universal selector', () => {
    for (const sheet of THEME_SHEETS) {
      const css = stripComments(read(path.join('themes', sheet)))
      expect(css, `${sheet} carries a universal cursor reset`).not.toMatch(
        /\*\s*\{[^}]*cursor/,
      )
    }
  })
})

describe('handle components opt into the global rule', () => {
  const COMPONENTS = [
    { file: 'components/layout/ResizablePanelEdge.tsx', label: 'sidebar edge' },
    { file: 'components/SplitHandle.tsx', label: 'pane splitter' },
  ]

  for (const { file, label } of COMPONENTS) {
    describe(`${label} (${file})`, () => {
      const src = read(file)

      it(`carries the ${HANDLE_CLASS} class`, () => {
        expect(src).toContain(HANDLE_CLASS)
      })

      it('keeps the inline col-resize fallback (works even with no stylesheet)', () => {
        expect(src).toMatch(/cursor:\s*'col-resize'/)
      })

      it('is exposed to assistive tech as a separator', () => {
        expect(src).toContain('role="separator"')
        expect(src).toContain('aria-orientation="vertical"')
      })
    })
  }

  it('the sidebar edge appends, never replaces, a caller className', () => {
    // Dropping the caller's class would be a silent regression; dropping OURS
    // would put the bug straight back.
    const src = read('components/layout/ResizablePanelEdge.tsx')
    expect(src).toMatch(/className\s*\?\s*`tachi-resize-handle \$\{className\}`/)
  })
})

describe('sidebar edge grab geometry', () => {
  // The handle straddles the panel border, but its host wrapper in AppShell is
  // `overflow: hidden` — the outer half is clipped away, so the strip the user
  // can actually hover is half the declared width. At the original 4px that was
  // a 2px target, and a missed hover looks exactly like a missing cursor.
  it('leaves at least a 4px hoverable strip after the host clips the outer half', () => {
    expect(RESIZE_HANDLE_WIDTH / 2).toBeGreaterThanOrEqual(4)
  })

  it('keeps the visible pill narrower than the grab strip (hit area grew, look did not)', () => {
    expect(RESIZE_PILL_WIDTH).toBeLessThan(RESIZE_HANDLE_WIDTH)
    // The pill is centred in the strip, so its visible half still lands exactly
    // on the border: (HANDLE - PILL) / 2 of clear track on each side.
    expect((RESIZE_HANDLE_WIDTH - RESIZE_PILL_WIDTH) / 2).toBe(2)
  })
})
