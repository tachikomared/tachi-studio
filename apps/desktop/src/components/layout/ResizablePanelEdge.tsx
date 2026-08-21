import React, { useState } from 'react'

/**
 * ResizablePanelEdge (Twenty-style)
 *
 * A thin draggable handle pinned to a panel edge, designed to consume
 * {@link useResizablePanel}. On hover/drag a brutalist accent "pill" appears and
 * scales slightly to signal it's grabbable; otherwise the handle is invisible
 * but still hit-testable. Absolutely positioned, so the parent panel must be
 * `position: relative`. The grab strip ({@link RESIZE_HANDLE_WIDTH}) is wider
 * than the visible pill ({@link RESIZE_PILL_WIDTH}) on purpose — see those docs.
 *
 * The resize cursor comes from the `.tachi-resize-handle` class (globals.css),
 * which is `!important` so no theme's structure layer can override it; the
 * inline `cursor` is only a no-stylesheet fallback.
 *
 * The visual scale animation is guarded by `prefers-reduced-motion` via the
 * `.tachi-resize-pill` class (transition + transform live in globals.css — see
 * the implementing agent's `wiring` notes). Without that CSS the handle still
 * works; it just won't animate.
 *
 * @example Pair with the hook on a left-docked sidebar
 * const { width, onPointerDown, isDragging } = useResizablePanel({
 *   min: 200, max: 420, initial: 260, storageKey: 'tachi:sidebar-width',
 * })
 * <div style={{ width, position: 'relative' }}>
 *   <Sidebar />
 *   <ResizablePanelEdge side="right" onPointerDown={onPointerDown} isDragging={isDragging} />
 * </div>
 */
export interface ResizablePanelEdgeProps {
  /** `onPointerDown` from {@link useResizablePanel}. Starts the drag. */
  onPointerDown: (e: React.PointerEvent) => void
  /** `isDragging` from the hook — keeps the pill visible while dragging. */
  isDragging: boolean
  /**
   * Which edge of the parent panel the handle sits on. `'right'` (default) for
   * a left-docked panel (sidebar); `'left'` for a right-docked panel.
   */
  side?: 'left' | 'right'
  /** Accessible label for the separator. Default: "Resize panel". */
  ariaLabel?: string
  /** Optional className merged onto the handle. */
  className?: string
}

/**
 * Grab width (px) of the handle. It straddles the panel border (half in, half
 * out), and the AppShell wrapper that hosts it is `overflow: hidden` — so the
 * OUTER half is clipped away and the usable strip is `RESIZE_HANDLE_WIDTH / 2`.
 * At the original 4px that left a 2px target: technically hoverable, but easy to
 * miss, and a miss reads as "the resize cursor never appears". 8px keeps the
 * total the same as a VS Code sash while giving a 4px real target.
 */
export const RESIZE_HANDLE_WIDTH = 8
/**
 * Visible width (px) of the accent pill. Pinned independently of the grab width
 * so widening the hit area never widens the bar the user sees — the pill still
 * renders exactly on the panel border, as before.
 */
export const RESIZE_PILL_WIDTH = 4

export function ResizablePanelEdge({
  onPointerDown,
  isDragging,
  side = 'right',
  ariaLabel = 'Resize panel',
  className,
}: ResizablePanelEdgeProps) {
  const [hover, setHover] = useState(false)
  const active = hover || isDragging

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      // `.tachi-resize-handle` owns the col-resize cursor in globals.css with
      // !important, so a theme structure layer can never override it; the inline
      // `cursor` below stays as the no-stylesheet fallback. Any caller-supplied
      // className is appended, never replaced.
      className={className ? `tachi-resize-handle ${className}` : 'tachi-resize-handle'}
      onPointerDown={onPointerDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        // Pin to the chosen edge; pull half the width outward so the hit area
        // straddles the border for an easier grab.
        [side]: -RESIZE_HANDLE_WIDTH / 2,
        width: RESIZE_HANDLE_WIDTH,
        cursor: 'col-resize',
        // Above panel content so it's always grabbable.
        zIndex: 10,
        // Brutalist: hard edges, no radius. Transparent track.
        background: 'transparent',
        touchAction: 'none',
        userSelect: 'none',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
      }}
    >
      {/* The accent pill — centred in the (wider) grab strip so it still lands
          exactly on the panel border; scales on hover/drag. */}
      <div
        className="tachi-resize-pill"
        data-active={active ? 'true' : 'false'}
        style={{
          width: RESIZE_PILL_WIDTH,
          flexShrink: 0,
          background: active ? 'var(--accent)' : 'transparent',
          // border-radius 0 keeps it brutalist (a vertical bar, not a rounded pill).
          borderRadius: 0,
          // Fallback styling if the globals.css class isn't present yet:
          // a static accent bar on active, no animation.
          transformOrigin: 'center',
        }}
      />
    </div>
  )
}

export default ResizablePanelEdge
