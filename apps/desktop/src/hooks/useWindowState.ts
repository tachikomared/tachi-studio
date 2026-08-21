// apps/desktop/src/hooks/useWindowState.ts
//
// Subscribe to the main-process window state: whether the window is maximized
// (live — updates on maximize/unmaximize) and whether it was created
// transparent (static — set once at construction; see TRANSPARENT_WINDOW in
// electron/main.ts). Both chassis frames read it: `maximized` picks the flush
// bezel, and `transparent` tells them whether their outer chamfers cut to the
// desktop or to an opaque shell.

import { useEffect, useState } from 'react'

export interface WindowState {
  maximized: boolean
  transparent: boolean
}

export function useWindowState(): WindowState {
  const [state, setState] = useState<WindowState>({ maximized: false, transparent: false })

  useEffect(() => {
    let live = true
    // Seed both fields from the current window state.
    window.tachi?.window?.getState?.()
      .then(s => { if (live) setState({ maximized: s.maximized, transparent: s.transparent }) })
      .catch(() => { /* window IPC unavailable — stays {false,false} */ })
    // `transparent` never changes at runtime, so the push channel only carries
    // `maximized`; keep the seeded `transparent` value.
    const off = window.tachi?.window?.onStateChanged?.(s =>
      setState(prev => ({ ...prev, maximized: s.maximized })),
    )
    return () => { live = false; off?.() }
  }, [])

  return state
}
