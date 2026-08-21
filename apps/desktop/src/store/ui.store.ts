import { create } from 'zustand'

export type SidebarTab = 'chat' | 'code' | 'nodes' | 'design' | 'media' | 'artifacts' | 'swarm' | 'inbox' | 'studio' | 'catalog' | 'aeon' | 'nook' | 'learn'

// Two-tier sidebar (UX Top-10 #4): the MORE group's expanded state survives
// restarts. This store has no persist middleware, so we follow the
// theme.store pattern — plain localStorage with try/catch (storage can be
// unavailable in tests / exotic setups). Collapsed by default for new users.
const MORE_LS_KEY = 'tachi:sidebar-more'
function readMoreExpanded(): boolean {
  try { return localStorage.getItem(MORE_LS_KEY) === '1' } catch { return false }
}

interface UIState {
  sidebarTab: SidebarTab
  setSidebarTab: (tab: SidebarTab) => void
  /** Two-tier sidebar: user preference for the MORE tab-group being expanded.
   *  NOTE: the Sidebar force-shows the group when the active route lives
   *  inside it (never hide the active tab) — this flag is the sticky
   *  user-chosen state, not necessarily what's on screen. */
  sidebarMoreExpanded: boolean
  setSidebarMoreExpanded: (open: boolean) => void
  /** App-wide wallet slide-out panel. */
  walletOpen: boolean
  setWalletOpen: (open: boolean) => void
  toggleWallet: () => void
  /** Privacy: hide wallet balance amounts on screen. */
  balancesHidden: boolean
  toggleBalances: () => void
}

export const useUIStore = create<UIState>((set) => ({
  sidebarTab: 'chat',
  setSidebarTab: (tab) => set({ sidebarTab: tab }),
  sidebarMoreExpanded: readMoreExpanded(),
  setSidebarMoreExpanded: (open) => {
    try { localStorage.setItem(MORE_LS_KEY, open ? '1' : '0') } catch { /* storage unavailable */ }
    set({ sidebarMoreExpanded: open })
  },
  walletOpen: false,
  setWalletOpen: (open) => set({ walletOpen: open }),
  toggleWallet: () => set((s) => ({ walletOpen: !s.walletOpen })),
  balancesHidden: false,
  toggleBalances: () => set((s) => ({ balancesHidden: !s.balancesHidden })),
}))
