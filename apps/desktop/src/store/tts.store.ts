// apps/desktop/src/store/tts.store.ts
//
// Chat read-aloud (piper TTS) preference — renderer-only, persisted to
// localStorage. Intentionally NOT in packages/core AppSettings: this is a
// per-machine UX toggle with zero main-process involvement (piper synthesis is
// already a local sidecar). Keeping it renderer-local avoids a core rebuild and
// any IPC/settings plumbing.

import { create } from 'zustand'

const LS_KEY = 'tachi-tts'

interface Persisted { enabled: boolean; voiceId: string }

function load(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>
      return { enabled: Boolean(p.enabled), voiceId: typeof p.voiceId === 'string' ? p.voiceId : '' }
    }
  } catch { /* ignore corrupt value */ }
  return { enabled: false, voiceId: '' }
}

function persist(s: Persisted): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)) } catch { /* ignore quota/serialize errors */ }
}

interface TtsStore {
  /** Auto-read assistant replies aloud as they stream. */
  enabled: boolean
  /** piper voice id used for synthesis (e.g. 'en_US-amy-low'). */
  voiceId: string
  setEnabled: (v: boolean) => void
  setVoiceId: (id: string) => void
}

export const useTtsStore = create<TtsStore>((set, get) => ({
  ...load(),
  setEnabled(v) { set({ enabled: v }); persist({ enabled: v, voiceId: get().voiceId }) },
  setVoiceId(id) { set({ voiceId: id }); persist({ enabled: get().enabled, voiceId: id }) },
}))
