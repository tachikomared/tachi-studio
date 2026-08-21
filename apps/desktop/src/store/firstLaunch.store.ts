// apps/desktop/src/store/firstLaunch.store.ts
//
// Tiny UI store for the one-time first-launch LEARN hero. The decision to show
// it lives in FirstLaunchGate (which reads both persisted stores); this store
// only carries the on-screen visibility so LearnPage can render the hero and
// any control can dismiss it. Not persisted — the PERMANENT signal is the
// localStorage flag (see utils/firstLaunch.ts), set by dismissHero().

import { create } from 'zustand'
import { markFirstLaunchDone } from '../utils/firstLaunch'

interface FirstLaunchStore {
  /** Whether the welcome hero is currently shown at the top of the Learn page. */
  heroVisible: boolean
  /** Show the hero (called once by the gate on a fresh install). */
  showHero(): void
  /** Hide the hero AND permanently persist the done-flag. Idempotent — safe to
   *  call from a click handler and again from an unmount cleanup. */
  dismissHero(): void
}

export const useFirstLaunchStore = create<FirstLaunchStore>((set) => ({
  heroVisible: false,
  showHero: () => set({ heroVisible: true }),
  dismissHero: () => {
    markFirstLaunchDone()
    set({ heroVisible: false })
  },
}))
