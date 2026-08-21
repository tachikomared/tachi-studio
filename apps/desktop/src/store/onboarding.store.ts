import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type OnboardingVibe = 'chat' | 'code' | 'aeon'

/**
 * First-run three-card choice (UX-benchmark #1):
 *  - 'local'   → RUN LOCAL: privacy step, then finish routes to /catalog
 *  - 'cloud'   → BRING API KEY: provider key form, then finish to /chat
 *  - 'explore' → JUST EXPLORE: skip everything, straight into the app
 */
export type FirstRunChoice = 'local' | 'cloud' | 'explore'

interface OnboardingStore {
  complete: boolean
  selectedProvider: string | undefined
  selectedVibe: OnboardingVibe | undefined
  firstRunChoice: FirstRunChoice | undefined
  setComplete: (v: boolean) => void
  setSelectedProvider: (p: string | undefined) => void
  setSelectedVibe: (v: OnboardingVibe | undefined) => void
  setFirstRunChoice: (c: FirstRunChoice | undefined) => void
  reset: () => void
}

const INITIAL = {
  complete: false,
  selectedProvider: undefined as string | undefined,
  selectedVibe: undefined as OnboardingVibe | undefined,
  firstRunChoice: undefined as FirstRunChoice | undefined,
}

export const useOnboardingStore = create<OnboardingStore>()(
  persist(
    (set) => ({
      ...INITIAL,
      setComplete: (complete) => set({ complete }),
      setSelectedProvider: (selectedProvider) => set({ selectedProvider }),
      setSelectedVibe: (selectedVibe) => set({ selectedVibe }),
      setFirstRunChoice: (firstRunChoice) => set({ firstRunChoice }),
      reset: () => set({ ...INITIAL }),
    }),
    {
      name: 'tachi-onboarding',
    },
  ),
)
