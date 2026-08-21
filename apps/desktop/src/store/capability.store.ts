// apps/desktop/src/store/capability.store.ts
//
// PRIVATE MODE (Tier 4) — Inbox-style capability approval store.
//
// Background:
//   The agent loop gates each tool call through a permission check. Today,
//   when a request needs prompting (see electron/services/permission-service.ts),
//   it surfaces a blocking ConfirmDialog modal — the agent is paused until the
//   user reacts. This is fine for interactive flows but disruptive when the
//   user wants to let the agent run long, queue requests, and batch-approve
//   later (the "axel-style inbox" pattern).
//
// This store provides:
//   - `mode`: a user-controlled toggle between 'immediate' (modal — existing
//     behaviour) and 'inbox' (silent queue; user approves later).
//   - `queue`: in-memory list of recent capability requests + their status.
//     This is intentionally NOT persisted — stale pending requests are
//     useless after restart (the underlying agent Promises on the main side
//     have already been cancelled and re-issued, if at all).
//
// Persistence:
//   Only `mode` is persisted. We use the same encrypted Zustand storage
//   adapter as the other stores (chat / privacy / agent / artifacts) for
//   consistency. The mode value itself isn't sensitive, but every persisted
//   store in this repo goes through createEncryptedStorage, so we follow the
//   convention to avoid creating a new exception.
//
// Integration (wired in Tier 4 follow-up — apps/desktop/electron/ipc/inbox.ipc.ts):
//   The renderer-side IPC layer mirrors `mode` to the main-process
//   CapabilityService (electron/services/capability-service.ts) on every
//   setMode call, and on rehydrate. The shared shape of CapabilityRequest is
//   duplicated between this file and capability-service.ts — keep them in
//   sync.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { createEncryptedStorage } from './encryptedStorage'

export type CapabilityMode = 'immediate' | 'inbox'

export type CapabilityStatus = 'pending' | 'approved' | 'denied' | 'snoozed'

/**
 * A single agent tool-call request surfaced to the user for approval.
 *
 * Mirrors `CapabilityRequest` in
 * apps/desktop/electron/services/capability-service.ts (status/snoozedUntil
 * are renderer-only extensions). Keep field names in sync with the main-side
 * type so IPC payloads serialise cleanly via structured-clone.
 */
export interface CapabilityRequest {
  /** Stable UUID for correlating request <-> response across IPC. */
  id: string
  /** Tool name as known to the agent harness (e.g. "Bash", "Write"). */
  toolName: string
  /** Raw tool input — kept opaque (unknown) for forward-compat. */
  toolInput: unknown
  /** Human-readable explanation of why this requires review. */
  reason: string
  /** Service's pre-classification — UI surfaces it as a default action. */
  recommendedDecision: 'allow' | 'deny'
  /** Chat/agent session that originated the request. */
  sessionId: string
  /** Working directory of the agent at request time (for filesystem-scope UI). */
  workingDir: string
  /** Epoch ms timestamp of when the request was pushed. */
  pushedAt: number
  /** Lifecycle status. New requests start as 'pending'. */
  status: CapabilityStatus
  /** Epoch ms — set when status === 'snoozed', expiry of the snooze window. */
  snoozedUntil?: number
}

interface CapabilityStore {
  /** Canonical mode — switches between blocking modal and silent inbox. */
  mode: CapabilityMode
  /** All known requests (pending + resolved). Ordered newest-first. */
  queue: CapabilityRequest[]

  /** Set the approval mode. Mirroring to the main process is the IPC layer's job. */
  setMode: (mode: CapabilityMode) => void
  /**
   * Convenience computed selector — count of currently-pending requests.
   * NOTE: this is a method, not a reactive value. Components that need to
   * re-render on changes should select via
   *   useCapabilityStore(s => s.queue.filter(r => r.status === 'pending').length)
   * rather than calling this method.
   */
  unreadCount: () => number
  /** Append a new request to the front of the queue (newest-first). */
  enqueue: (req: CapabilityRequest) => void
  /**
   * Transition a request out of 'pending'. If status === 'snoozed', the
   * optional snoozeMs sets a relative expiry window (defaults to undefined,
   * meaning "indefinite snooze" — the UI is responsible for un-snoozing).
   */
  resolve: (
    id: string,
    status: 'approved' | 'denied' | 'snoozed',
    snoozeMs?: number,
  ) => void
  /** Drop everything that's already been approved/denied. Keeps pending + snoozed. */
  clearResolved: () => void
  /** Wipe the queue entirely. Intended for tests and a user-facing panic button. */
  clearAll: () => void
}

// Push the mode to the main process. Best-effort: a missing bridge (e.g. in
// tests, or before preload finishes) is silently swallowed. Mirrors the
// pattern in apps/desktop/src/store/privacy.store.ts so the main-process
// capabilityService can fork the agent permission flow synchronously without
// a renderer round-trip.
function pushModeToMain(mode: CapabilityMode): void {
  try {
    const bridge = (window as unknown as {
      tachi?: { inbox?: { setMode?: (m: CapabilityMode) => Promise<unknown> } }
    }).tachi?.inbox
    if (bridge?.setMode) {
      bridge.setMode(mode).catch(() => { /* main not ready yet — ignore */ })
    }
  } catch { /* tachi bridge not present (test env) */ }
}

export const useCapabilityStore = create<CapabilityStore>()(persist((set, get) => ({
  mode: 'immediate',
  queue: [],

  setMode(mode) {
    set({ mode })
    pushModeToMain(mode)
  },

  unreadCount() {
    return get().queue.filter((r) => r.status === 'pending').length
  },

  enqueue(req) {
    set((s) => ({ queue: [req, ...s.queue] }))
  },

  resolve(id, status, snoozeMs) {
    set((s) => ({
      queue: s.queue.map((r) =>
        r.id !== id
          ? r
          : {
              ...r,
              status,
              snoozedUntil: snoozeMs ? Date.now() + snoozeMs : undefined,
            },
      ),
    }))
  },

  clearResolved() {
    set((s) => ({
      queue: s.queue.filter(
        (r) => r.status === 'pending' || r.status === 'snoozed',
      ),
    }))
  },

  clearAll() { set({ queue: [] }) },
}), {
  name: 'tachi-capability-v1',
  storage: createJSONStorage(() => createEncryptedStorage('capability')),
  // Queue is ephemeral — stale pending requests after restart are meaningless
  // because the agent-side Promise has already been resolved (or cancelled).
  // Only persist the user-chosen mode.
  partialize: (s) => ({ mode: s.mode }) as Partial<CapabilityStore>,
  // After rehydrate, mirror the persisted mode to the main-process service so
  // the very first agent tool-permission decision after a cold launch uses
  // the user's saved preference instead of the 'immediate' default. The push
  // is best-effort; if the preload bridge isn't ready yet, the renderer will
  // re-send on the next setMode call.
  onRehydrateStorage: () => (state) => {
    if (state?.mode) pushModeToMain(state.mode)
  },
}))

/**
 * Convenience selector — true when the user has opted into the silent inbox.
 * Reads from the latest store snapshot; safe to call outside React.
 */
export function isInboxMode(): boolean {
  return useCapabilityStore.getState().mode === 'inbox'
}
