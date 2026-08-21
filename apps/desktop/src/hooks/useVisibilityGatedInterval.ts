// apps/desktop/src/hooks/useVisibilityGatedInterval.ts
//
// IDLE HONESTY (lane V, owner: "проверь что приложение просто так не гоняет GPU
// и лишнее дерьмо").
//
// The app is full of `useEffect(() => { const id = setInterval(tick, N); ... })`
// status pollers. Route unmount already stops the ones on a page you navigated
// away from — react-router renders only the matched <Route>, so a poller on
// /catalog dies the moment you leave /catalog. What NOTHING stopped was the
// other half of the problem: the window you MINIMISED. A minimised (or fully
// occluded) window keeps every mounted interval firing at full rate, so the app
// sitting in the taskbar was still doing IPC round-trips, `statfsSync` calls in
// main, and React re-renders nobody could see, several times a second.
//
// Electron marks the page hidden on minimise AND on occlusion, so
// `document.visibilityState` is the honest signal — this is not a browser-tab
// nicety, it is the difference between a backgrounded app that costs nothing
// and one that keeps a core warm.
//
// CONTRACT
//   - `tick` runs once on mount (a poller that shows nothing until its first
//     interval elapses is a bug, and every call site already did this by hand).
//   - While hidden, the interval keeps its handle but skips the work — cheaper
//     and far simpler than tearing the timer down and racing to rebuild it.
//   - On becoming visible again the hook runs a CATCH-UP tick immediately, so
//     restoring the window shows fresh data instead of stale data plus a wait.
//     That is what makes skipping safe: the user never observes the skip.
//   - `tick` is read through a ref, so a caller passing an inline arrow does not
//     reinstall the timer on every render. Only `intervalMs` re-arms it.

import { useEffect, useRef } from 'react'

/** True when the document is currently hidden (minimised / occluded / tabbed away). */
export function isDocumentHidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden'
  } catch {
    return false
  }
}

/**
 * Run `tick` immediately, then every `intervalMs` — but only while the window is
 * actually visible. Becoming visible again fires a catch-up tick.
 *
 * @param tick       the poll body. Read through a ref; may be an inline arrow.
 * @param intervalMs poll period. Pass `null` to disable the poller entirely
 *                   (the usual "only poll while this thing is running" gate),
 *                   which also skips the mount tick.
 */
export function useVisibilityGatedInterval(tick: () => void, intervalMs: number | null): void {
  const tickRef = useRef(tick)
  tickRef.current = tick

  useEffect(() => {
    if (intervalMs === null) return

    const run = () => { try { tickRef.current() } catch { /* a poll must never break the page */ } }

    run()

    const id = setInterval(() => {
      if (isDocumentHidden()) return
      run()
    }, intervalMs)

    // Catch-up on return so the skip is invisible to the user.
    let onVisible: (() => void) | null = null
    if (typeof document !== 'undefined' && document.addEventListener) {
      onVisible = () => { if (!isDocumentHidden()) run() }
      document.addEventListener('visibilitychange', onVisible)
    }

    return () => {
      clearInterval(id)
      if (onVisible && typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('visibilitychange', onVisible)
      }
    }
  }, [intervalMs])
}
