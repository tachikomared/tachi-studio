import { create } from 'zustand'
import type { MemoryFact } from '@tachi/core'

interface MemoryStore {
  /**
   * Legacy free-form blob (kept for backward compat / migration backup). No
   * longer injected into chat — the enabled `facts` are (T16). Still set on
   * boot from settings.userMemory.
   */
  userMemory: string
  setUserMemory: (value: string) => void
  /** The structured fact list (source of truth for injection + the topbar badge). */
  facts: MemoryFact[]
  setFacts: (facts: MemoryFact[]) => void
}

export const useMemoryStore = create<MemoryStore>((set) => ({
  userMemory: '',
  setUserMemory: (userMemory) => set({ userMemory }),
  facts: [],
  setFacts: (facts) => set({ facts }),
}))

/** True when at least one fact is enabled (drives the "memory active" badge). */
export function hasActiveMemory(facts: MemoryFact[]): boolean {
  return facts.some(f => f.enabled && f.text.trim().length > 0)
}
