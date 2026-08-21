// apps/desktop/src/store/aeon.store.ts
import { create } from 'zustand'

/**
 * Which sub-view to render inside the Aeon tab when the user has a fork.
 *   - 'home'      = the default grid (Provider / Channels / Skills / Runs / Composer)
 *   - 'dashboard' = native skill-outputs feed (mirrors Aeon's Next.js dashboard
 *                   at localhost:5555 without requiring users to spawn it)
 */
export type AeonView = 'home' | 'dashboard'

export interface AeonStore {
  ghInstalled:        boolean
  ghAuthenticated:    boolean
  ghUsername?:        string
  forked:             boolean
  loginCode?:         string
  loginVerifyUri?:    string
  loginPending:       boolean
  view:               AeonView
  setGhStatus:        (s: Partial<AeonStore>) => void
  setForked:          (f: boolean) => void
  setLoginCode:       (c?: string, verifyUri?: string) => void
  setLoginPending:    (p: boolean) => void
  setView:            (v: AeonView) => void
}

export const useAeonStore = create<AeonStore>((set) => ({
  ghInstalled:        false,
  ghAuthenticated:    false,
  forked:             false,
  loginPending:       false,
  view:               'home',
  setGhStatus:        (s) => set(s),
  setForked:          (forked) => set({ forked }),
  setLoginCode:       (loginCode, loginVerifyUri) => set({ loginCode, loginVerifyUri }),
  setLoginPending:    (loginPending) => set({ loginPending }),
  setView:            (view) => set({ view }),
}))
