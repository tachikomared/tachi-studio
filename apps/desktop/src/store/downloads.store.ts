// apps/desktop/src/store/downloads.store.ts
//
// LIVE DOWNLOAD QUEUE for the persistent DownloadStrip (UX-benchmark #11).
//
// A thin Zustand mirror of the main-process download manager: the full queue
// arrives on every 'downloads:changed' broadcast (progress throttled main-side
// to ~4/s), and the actions are one-line IPC calls. Resilient like
// provider-health.store: a missing bridge (tests, storybook) leaves an empty
// queue and never throws.

import { create } from 'zustand'
import type { DownloadItemInfo } from '../types/electron'

interface DownloadsStore {
  items: DownloadItemInfo[]
  /**
   * Subscribe to the main-process queue. Idempotent — the first caller wires
   * the listener + initial fetch; later calls (or re-mounts) are no-ops.
   * Returns a disposer that only detaches when the last starter is gone.
   */
  init: () => () => void
  pause: (id: string) => Promise<void>
  resume: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
  dismiss: (id: string) => Promise<void>
}

function bridge(): Window['tachi']['downloads'] | null {
  try {
    return (window as unknown as { tachi?: { downloads?: Window['tachi']['downloads'] } }).tachi?.downloads ?? null
  } catch {
    return null
  }
}

// Module-scoped so multiple strip mounts (main window re-renders) share ONE
// IPC listener and the last unmount detaches it.
let offChanged: (() => void) | null = null
let starters = 0

export const useDownloadsStore = create<DownloadsStore>((set) => ({
  items: [],

  init() {
    starters += 1
    const api = bridge()
    if (api && offChanged === null) {
      offChanged = api.onChanged((items) => set({ items: Array.isArray(items) ? items : [] }))
      void api.list()
        .then((items) => set({ items: Array.isArray(items) ? items : [] }))
        .catch(() => { /* main not ready yet — the first broadcast will fill in */ })
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      starters = Math.max(0, starters - 1)
      if (starters === 0 && offChanged !== null) {
        try { offChanged() } catch { /* ignore */ }
        offChanged = null
      }
    }
  },

  async pause(id) {
    try { await bridge()?.pause(id) } catch { /* state comes back on the broadcast */ }
  },
  async resume(id) {
    try { await bridge()?.resume(id) } catch { /* ignore */ }
  },
  async cancel(id) {
    try { await bridge()?.cancel(id) } catch { /* ignore */ }
  },
  async dismiss(id) {
    try { await bridge()?.dismiss(id) } catch { /* ignore */ }
  },
}))
