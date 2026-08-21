import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * useResizablePanel (Twenty-style)
 *
 * A dependency-free pointer-drag hook for resizing a panel's width. Returns the
 * current `width`, an `onPointerDown` handler to attach to a drag handle, and an
 * `isDragging` flag (handy for styling the handle / disabling transitions while
 * dragging). The width is clamped to `[min, max]` and persisted to localStorage
 * under `storageKey` so it survives reloads.
 *
 * Uses Pointer Events + setPointerCapture so the drag keeps tracking even when
 * the cursor leaves the handle. No window resize listeners, no measuring loops.
 *
 * @example Resizable sidebar
 * function Layout() {
 *   const { width, onPointerDown, isDragging } = useResizablePanel({
 *     min: 200, max: 420, initial: 260, storageKey: 'tachi:sidebar-width',
 *   })
 *   return (
 *     <div style={{ display: 'flex', height: '100%' }}>
 *       <div style={{ width, position: 'relative', flexShrink: 0,
 *                     transition: isDragging ? 'none' : 'width 120ms cubic-bezier(0.2,0.8,0.2,1)' }}>
 *         <Sidebar />
 *         <ResizablePanelEdge onPointerDown={onPointerDown} isDragging={isDragging} side="right" />
 *       </div>
 *       <main style={{ flex: 1 }}>...</main>
 *     </div>
 *   )
 * }
 */
export interface UseResizablePanelOptions {
  /** Minimum width in px. The dragged width never goes below this. */
  min: number
  /** Maximum width in px. The dragged width never goes above this. */
  max: number
  /** Initial width in px, used when nothing is persisted yet. */
  initial: number
  /** localStorage key the width is persisted under. */
  storageKey: string
  /**
   * Drag direction. `'right'` (default) means the handle sits on the panel's
   * right edge and dragging right grows the panel (left-docked panel, e.g. a
   * sidebar). `'left'` means the handle is on the left edge and dragging left
   * grows the panel (right-docked panel, e.g. an inspector).
   */
  side?: 'left' | 'right'
  /**
   * Claude-Desktop-style collapse: dragging well below `min` snaps the panel
   * closed (width 0, restore width kept), and `toggleCollapsed` flips it —
   * wire it to the handle's double-click. Persists `{w,c}` JSON under the same
   * key (plain-number values from the non-collapsible format still load).
   */
  collapsible?: boolean
}

export interface UseResizablePanelResult {
  /** Current clamped panel width in px — 0 while collapsed. */
  width: number
  /** Attach to the drag handle's `onPointerDown`. Starts a drag gesture. */
  onPointerDown: (e: React.PointerEvent) => void
  /** True while a drag gesture is in progress. */
  isDragging: boolean
  /** Imperatively set the width (clamped + persisted). Useful for reset. */
  setWidth: (next: number) => void
  /** True when a collapsible panel is snapped closed. Always false otherwise. */
  collapsed: boolean
  /** Collapse/restore a collapsible panel (no-op unless `collapsible`). */
  toggleCollapsed: () => void
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Resolve a raw dragged width for a collapsible panel: snap closed when
 * dragged well below min (keeping `keepWidth` to restore to), else clamp.
 * Exported for unit tests.
 */
export function resolveSplitDrag(raw: number, min: number, max: number, keepWidth: number): { w: number; c: boolean } {
  if (raw < min * 0.5) return { w: keepWidth, c: true }
  return { w: clamp(raw, min, max), c: false }
}

function readPersisted(storageKey: string, fallback: number, min: number, max: number): { w: number; c: boolean } {
  if (typeof window === 'undefined') return { w: fallback, c: false }
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw == null) return { w: fallback, c: false }
    // Collapsible format: {"w":320,"c":false}. Legacy/simple format: "320".
    if (raw.trimStart().startsWith('{')) {
      const v = JSON.parse(raw)
      if (typeof v?.w === 'number' && Number.isFinite(v.w)) {
        return { w: clamp(v.w, min, max), c: v.c === true }
      }
      return { w: fallback, c: false }
    }
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) return { w: fallback, c: false }
    return { w: clamp(parsed, min, max), c: false }
  } catch {
    return { w: fallback, c: false }
  }
}

export function useResizablePanel({
  min,
  max,
  initial,
  storageKey,
  side = 'right',
  collapsible = false,
}: UseResizablePanelOptions): UseResizablePanelResult {
  // `w` is always the OPEN width (the restore target); `c` = collapsed.
  const [state, setState] = useState<{ w: number; c: boolean }>(() => {
    const saved = readPersisted(storageKey, clamp(initial, min, max), min, max)
    return collapsible ? saved : { w: saved.w, c: false }
  })
  const [isDragging, setIsDragging] = useState(false)

  // Drag bookkeeping kept in a ref so the move handler is stable and never
  // captures a stale width.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)

  const persist = useCallback(
    (next: { w: number; c: boolean }) => {
      try {
        // Collapsible panels persist {w,c}; plain panels keep the simple
        // number format (back-compat with existing keys, e.g. the AppShell
        // sidebar).
        window.localStorage.setItem(storageKey, collapsible ? JSON.stringify(next) : String(next.w))
      } catch {
        /* storage may be unavailable (private mode / quota) — ignore */
      }
    },
    [storageKey, collapsible],
  )

  const setWidth = useCallback(
    (next: number) => {
      const v = { w: clamp(next, min, max), c: false }
      setState(v)
      persist(v)
    },
    [min, max, persist],
  )

  const toggleCollapsed = useCallback(() => {
    if (!collapsible) return
    setState((s) => {
      const v = { ...s, c: !s.c }
      persist(v)
      return v
    })
  }, [collapsible, persist])

  // Re-clamp if min/max change after mount (e.g. responsive bounds).
  useEffect(() => {
    setState((s) => ({ ...s, w: clamp(s.w, min, max) }))
  }, [min, max])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Left button / primary pointer only.
      if (e.button !== 0) return
      e.preventDefault()
      dragRef.current = { startX: e.clientX, startWidth: state.c ? 0 : state.w }
      setIsDragging(true)
      // Iframes (Design preview, file previews) are OOPIFs that swallow
      // pointermove — even through setPointerCapture — killing the drag the
      // moment the cursor crosses them. Disable their hit-testing for the
      // duration of the gesture (globals.css scopes it to this class).
      document.body.classList.add('tachi-panel-resizing')

      const target = e.currentTarget as HTMLElement
      try {
        target.setPointerCapture(e.pointerId)
      } catch {
        /* setPointerCapture can throw if the pointer is gone — ignore */
      }

      const onMove = (ev: PointerEvent) => {
        const drag = dragRef.current
        if (!drag) return
        const deltaX = ev.clientX - drag.startX
        // For a right-docked panel, dragging left (negative delta) grows it.
        const signed = side === 'right' ? deltaX : -deltaX
        const raw = drag.startWidth + signed
        setState((s) => {
          const next = collapsible ? resolveSplitDrag(raw, min, max, s.w) : { w: clamp(raw, min, max), c: false }
          return next.w === s.w && next.c === s.c ? s : next
        })
      }

      const onUp = () => {
        dragRef.current = null
        setIsDragging(false)
        document.body.classList.remove('tachi-panel-resizing')
        // Persist the final state once at gesture end (avoids thrashing storage).
        setState((s) => {
          persist(s)
          return s
        })
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [state.w, state.c, min, max, side, persist, collapsible],
  )

  return {
    width: state.c ? 0 : state.w,
    onPointerDown,
    isDragging,
    setWidth,
    collapsed: state.c,
    toggleCollapsed,
  }
}

export default useResizablePanel
