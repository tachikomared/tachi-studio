import { create } from 'zustand'
import { RuntimeCardUpdate } from '@tachi/core'

interface RuntimeStore {
  cards: RuntimeCardUpdate[]
  scanning: boolean
  setScanning: (v: boolean) => void
  updateCard: (update: RuntimeCardUpdate) => void
  reset: () => void
  startScan: () => void
}

export const useRuntimeStore = create<RuntimeStore>((set) => ({
  cards: [],
  scanning: false,
  setScanning: (scanning) => set({ scanning }),
  updateCard: (update) => set(s => {
    const idx = s.cards.findIndex(c => c.runtimeId === update.runtimeId)
    if (idx >= 0) {
      const cards = [...s.cards]
      cards[idx] = update
      return { cards }
    }
    return { cards: [...s.cards, update] }
  }),
  reset: () => set({ cards: [], scanning: false }),
  startScan: () => set({ cards: [], scanning: true }),
}))
