// apps/desktop/src/store/privacy.store.ts
//
// PRIVATE MODE (Tier 1) — top-level privacy toggle.
//
// When mode === 'private':
//   - Cloud providers (Bankr, OpenRouter, Anthropic OAuth, OpenGateway) are
//     blocked from being configured in the UI (ProvidersCard locks them).
//   - Local providers (Ollama, freellmapi-local) remain unaffected.
//   - The TitleBar renders a red [PRIVATE] badge so the user is never
//     uncertain about the current posture.
//
// Persisted via the same encrypted localStorage adapter the chat store uses
// (Electron safeStorage / DPAPI on Windows). On every setMode we mirror the
// value to the main process (via window.tachi.privacy.setMode) so Tier 2
// can enforce provider routing at the IPC boundary without re-querying
// the renderer.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createEncryptedStorage } from './encryptedStorage'

export type PrivacyMode = 'open' | 'private'

interface PrivacyStore {
  /** Canonical privacy posture. */
  mode: PrivacyMode
  /** Set the privacy posture. Also mirrored to the main process for Tier 2. */
  setMode: (mode: PrivacyMode) => void
}

// Push the mode to the main process. Best-effort: a missing bridge (e.g. in
// tests, or before preload finishes) is silently swallowed.
function pushModeToMain(mode: PrivacyMode): void {
  try {
    const bridge = (window as unknown as {
      tachi?: { privacy?: { setMode?: (m: PrivacyMode) => Promise<unknown> } }
    }).tachi?.privacy
    if (bridge?.setMode) {
      bridge.setMode(mode).catch(() => { /* main not ready yet — ignore */ })
    }
  } catch { /* tachi bridge not present (test env) */ }
}

export const usePrivacyStore = create<PrivacyStore>()(persist((set) => ({
  mode: 'open',

  setMode(mode) {
    set({ mode })
    pushModeToMain(mode)
  },
}), {
  name: 'tachi-privacy-v1',
  storage: createJSONStorage(() => createEncryptedStorage('privacy')),
  partialize: (s) => ({ mode: s.mode }) as Partial<PrivacyStore>,
  // After rehydrate, mirror mode to the main process so Tier 2 enforcement
  // is in sync with the persisted renderer state.
  onRehydrateStorage: () => (state) => {
    if (state) {
      pushModeToMain(state.mode)
    }
  },
}))

/** Convenience selector — true when private mode is active. */
export function isPrivateMode(): boolean {
  return usePrivacyStore.getState().mode === 'private'
}
