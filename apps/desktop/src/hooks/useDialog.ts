// useDialog — accessibility behavior for any modal/dialog/drawer.
//
// Attaches to the dialog's container element via the returned ref and provides,
// for as long as the dialog is mounted:
//   - Escape closes (calls onClose)
//   - Focus trap: Tab / Shift+Tab cycle within the dialog's focusable elements
//   - Initial focus moves into the dialog on open
//   - Focus restore: the previously-focused element is refocused on unmount
//
// It does NOT render anything or change markup — so it can be dropped into the
// many hand-rolled modals in the app without restructuring them. Pair it with
// role="dialog" aria-modal="true" on the same element (see <Modal> for a ready
// wrapper). onClose may be an inline closure — it's read through a ref, so the
// effect runs once on mount and never steals focus on re-render.
import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

// `enabled` lets dialogs that stay mounted and toggle via an `open` prop
// (rather than mounting/unmounting) re-initialize the trap when they open.
// Defaults true for the common mount-on-open case.
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void, enabled = true) {
  const ref = useRef<T>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!enabled) return
    const node = ref.current
    const prevFocus = (document.activeElement as HTMLElement | null) ?? null

    const focusables = (): HTMLElement[] =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.offsetParent !== null) : []

    // Move focus into the dialog on open (first focusable, else the container).
    const first = focusables()[0]
    if (first) first.focus()
    else node?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key === 'Tab') {
        const els = focusables()
        if (els.length === 0) {
          e.preventDefault()
          return
        }
        const firstEl = els[0]
        const lastEl = els[els.length - 1]
        const active = document.activeElement
        if (e.shiftKey && active === firstEl) {
          e.preventDefault()
          lastEl.focus()
        } else if (!e.shiftKey && active === lastEl) {
          e.preventDefault()
          firstEl.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      prevFocus?.focus?.()
    }
  }, [enabled])

  return ref
}
