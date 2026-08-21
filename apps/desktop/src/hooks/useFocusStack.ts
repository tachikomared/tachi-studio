import { create } from 'zustand'

/**
 * useFocusStack
 *
 * A tiny, self-contained focus-stack utility. UI regions push a focus id when
 * they take focus (a modal opening, a dropdown opening, an input gaining
 * focus, the canvas being clicked) and pop it when they release it. The region
 * on TOP of the stack owns focus.
 *
 * The primary use case is suppressing global hotkeys when an input or modal
 * owns focus: a global hotkey handler can call `shouldSuppressGlobalHotkeys()`
 * (or check `isTopFocus(...)`) and bail out so typing into an input does not
 * trigger app-level shortcuts.
 *
 * This is intentionally NOT wired into any existing component — it is a
 * primitive. See the `wiring` notes returned by the implementing agent for
 * suggested integration points.
 *
 * @example Push/pop on mount/focus
 * import { useFocusStack, useFocusRegion } from '../hooks/useFocusStack'
 *
 * function MyModal({ open }: { open: boolean }) {
 *   // auto push 'modal' while `open` is true, auto pop on close/unmount
 *   useFocusRegion('modal', open)
 *   return open ? <div role="dialog">...</div> : null
 * }
 *
 * @example Guard a global hotkey handler
 * import { shouldSuppressGlobalHotkeys } from '../hooks/useFocusStack'
 *
 * function onKeyDown(e: KeyboardEvent) {
 *   if (shouldSuppressGlobalHotkeys()) return // an input/modal owns focus
 *   // ...handle global shortcut
 * }
 *
 * @example Imperative push/pop (e.g. from an input's onFocus/onBlur)
 * const push = useFocusStack(s => s.push)
 * const pop = useFocusStack(s => s.pop)
 * <input onFocus={() => push('input')} onBlur={() => pop('input')} />
 */

/** Kinds of UI regions that can own focus. */
export type FocusKind = 'modal' | 'dropdown' | 'input' | 'canvas'

/** A unique entry on the focus stack. */
export interface FocusEntry {
  /** Stable id for this region instance (used to pop the exact entry). */
  id: string
  /** What kind of region this is. */
  kind: FocusKind
}

interface FocusStackState {
  /** Bottom-to-top stack; the LAST entry owns focus. */
  stack: FocusEntry[]
  /** Push a region onto the stack. Re-pushing the same id is a no-op move-to-top. */
  push: (id: string, kind: FocusKind) => void
  /** Pop a region by id (no-op if not present). */
  pop: (id: string) => void
  /** Replace the entire stack (mostly for tests/reset). */
  clear: () => void
}

export const useFocusStack = create<FocusStackState>((set) => ({
  stack: [],
  push: (id, kind) =>
    set((state) => {
      // Remove any existing entry with the same id, then push to top.
      const without = state.stack.filter((e) => e.id !== id)
      return { stack: [...without, { id, kind }] }
    }),
  pop: (id) =>
    set((state) => ({ stack: state.stack.filter((e) => e.id !== id) })),
  clear: () => set({ stack: [] }),
}))

/** Kinds that should suppress global hotkeys while they own (top) focus. */
const HOTKEY_BLOCKING_KINDS: ReadonlySet<FocusKind> = new Set<FocusKind>([
  'modal',
  'dropdown',
  'input',
])

/**
 * Returns the entry currently on top of the focus stack, or `null` if empty.
 * Non-reactive helper — reads the store snapshot. For reactive reads in a
 * component, select from `useFocusStack` directly.
 */
export function getTopFocus(): FocusEntry | null {
  const { stack } = useFocusStack.getState()
  return stack.length > 0 ? stack[stack.length - 1] : null
}

/**
 * True if the region with `id` is currently on top of the focus stack.
 * Non-reactive snapshot read.
 */
export function isTopFocus(id: string): boolean {
  const top = getTopFocus()
  return top != null && top.id === id
}

/**
 * Guard for global hotkey handlers. Returns true when an input/modal/dropdown
 * currently owns focus and global shortcuts should therefore be suppressed.
 * (Canvas focus does NOT suppress — canvas shortcuts are usually desired.)
 * Non-reactive snapshot read so it is safe to call inside a raw event handler.
 */
export function shouldSuppressGlobalHotkeys(): boolean {
  const top = getTopFocus()
  return top != null && HOTKEY_BLOCKING_KINDS.has(top.kind)
}

// ---------------------------------------------------------------------------
// React convenience hook (kept here so the primitive is fully self-contained).
// ---------------------------------------------------------------------------

// Lazy React import via require-style guard so this module can also be consumed
// in non-React contexts (the helpers above) without pulling React eagerly.
import { useEffect } from 'react'

/**
 * Declaratively own a focus region while `active` is true. Pushes on
 * activation, pops on deactivation/unmount. The `kind` defaults based on a
 * heuristic but should be passed explicitly for clarity.
 *
 * @param id stable id for this region instance
 * @param active whether the region currently owns focus
 * @param kind region kind (defaults to 'modal')
 */
export function useFocusRegion(id: string, active: boolean, kind: FocusKind = 'modal') {
  const push = useFocusStack((s) => s.push)
  const pop = useFocusStack((s) => s.pop)

  useEffect(() => {
    if (!active) return
    push(id, kind)
    return () => pop(id)
  }, [id, active, kind, push, pop])
}
