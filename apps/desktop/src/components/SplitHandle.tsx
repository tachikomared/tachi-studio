// apps/desktop/src/components/SplitHandle.tsx
//
// Claude-Desktop-style pane resizer for FLEX-SIBLING panes, built on the
// existing useResizablePanel hook (Twenty-style, also behind the AppShell
// sidebar's ResizablePanelEdge). Unlike ResizablePanelEdge (absolutely
// positioned INSIDE the panel), this handle lives in the flex flow BETWEEN the
// panes — which keeps it grabbable when the pane is collapsed to width 0.
// Drag = resize (snaps collapsed below min/2), double-click = collapse/restore.
//
// Usage (pane LEFT of the handle → the handle sits on the pane's right edge):
//   const pane = useResizablePanel({ storageKey: 'tachi-split:design.thread',
//     initial: 380, min: 280, max: 720, side: 'right', collapsible: true })
//   <div style={{ width: pane.width, flexShrink: 0, overflow: 'hidden', ... }}>…</div>
//   <SplitHandle panel={pane} side="right" />
// Pane RIGHT of the handle (borderLeft panels): side="left", handle FIRST.
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UseResizablePanelResult } from '../hooks/useResizablePanel'

export function SplitHandle({ panel, side, dataId }: {
  panel: UseResizablePanelResult
  /** Which edge of the PANEL the handle sits on (same semantics as the hook's `side`). */
  side: 'left' | 'right'
  /** Optional data-split-handle marker for tests. */
  dataId?: string
}) {
  const { t } = useTranslation('common')
  const [hover, setHover] = useState(false)
  const active = hover || panel.isDragging
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title={t('split.hint')}
      data-split-handle={dataId}
      // The cursor lives in globals.css (`.tachi-resize-handle`, !important) so
      // no theme's structure layer can override it; the inline `cursor` below
      // stays as the no-stylesheet fallback.
      className="tachi-resize-handle"
      onPointerDown={panel.onPointerDown}
      onDoubleClick={panel.toggleCollapsed}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        width: 7,
        alignSelf: 'stretch',
        flexShrink: 0,
        position: 'relative',
        zIndex: 20,
        cursor: 'col-resize',
        touchAction: 'none',
        userSelect: 'none',
        // Open: overlay the pane's own 2px divider border so the layout keeps
        // its exact look until hovered ('right' = the panel is BEFORE the
        // handle → pull left). Collapsed: stay IN FLOW as a visible rail —
        // overlaying would sit on whatever is beside the closed pane (e.g. the
        // AppShell sidebar's own resize edge) and steal its double-clicks.
        ...(panel.collapsed ? {} : side === 'right' ? { marginLeft: -7 } : { marginRight: -7 }),
        background: panel.isDragging
          ? 'var(--accent)'
          : active
            ? 'color-mix(in srgb, var(--accent) 55%, transparent)'
            : panel.collapsed
              ? 'color-mix(in srgb, var(--accent) 30%, var(--bg-elevated))'
              : 'transparent',
        transition: 'background 80ms linear',
      }}
    />
  )
}
