import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { NookStatus } from '../types/electron'

export type NookView = 'dashboard' | 'bounties' | 'marketplace' | 'autonomous' | 'mining' | 'network' | 'messages' | 'wallet'

export interface NookFeedItem {
  type: string
  data: unknown
  at: number
}

interface NookState {
  // Live connection status, pushed from the main process (nook:status).
  status: NookStatus | null
  // Live network event feed (nook:event), newest first, capped.
  feed: NookFeedItem[]
  // Which sub-view is active (persisted).
  view: NookView
  // Which provider+model powers the agent's reasoning (persisted).
  brainProvider: string
  brainModel: string

  setStatus(s: NookStatus | null): void
  pushFeed(item: NookFeedItem): void
  clearFeed(): void
  setView(v: NookView): void
  setBrainProvider(p: string): void
  setBrainModel(m: string): void
}

const FEED_CAP = 100

export const useNookStore = create<NookState>()(
  persist(
    (set) => ({
      status: null,
      feed: [],
      view: 'dashboard',
      brainProvider: 'freellmapi',
      brainModel: '',

      setStatus: (s) => set({ status: s }),
      pushFeed: (item) => set((st) => ({ feed: [item, ...st.feed].slice(0, FEED_CAP) })),
      clearFeed: () => set({ feed: [] }),
      setView: (v) => set({ view: v }),
      setBrainProvider: (p) => set({ brainProvider: p }),
      setBrainModel: (m) => set({ brainModel: m }),
    }),
    {
      name: 'tachi-nook-v2',
      storage: createJSONStorage(() => localStorage),
      // Secrets live in the OS keychain (main process) — never persist them here.
      partialize: (s) => ({ view: s.view, brainProvider: s.brainProvider, brainModel: s.brainModel }),
    },
  ),
)
