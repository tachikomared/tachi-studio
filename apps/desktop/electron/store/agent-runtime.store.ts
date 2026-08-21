// apps/desktop/electron/store/agent-runtime.store.ts
//
// Sprint C2: main-process Zustand store for agent runtime state.
//
// Mirrors the runtime-relevant fields of src/store/agent.store.ts.
// Messages are NOT stored here — they live in the renderer-only store because
// they can be arbitrarily large. This store tracks session identity, lifecycle
// status, and harness/provider config only.
//
// Uses Zustand's vanilla createStore (no React adapter — main proc has no React).
// Not persisted — app-restart resets to idle defaults.
//
// Broadcast: every mutation fires broadcastStateChanged(), which sends the
// current snapshot to ALL BrowserWindows via the "agent-runtime:state-changed"
// push channel. All windows stay in lockstep regardless of which triggered the
// change (ready for future second-window / overlay surfaces).

import { createStore } from 'zustand/vanilla'
import { BrowserWindow } from 'electron'

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentRuntimeStatus   = 'idle' | 'starting' | 'running' | 'done' | 'error'

/**
 * Harnesses a run can be on. 'goose' and 'both' were removed with the Goose
 * harness (TACHI supersedes it). This store is NOT persisted — every app start
 * resets it to the defaults below — so no legacy value can ever be read back
 * into it, and the zod enum in agent-runtime.ipc.ts can stay strict.
 */
export const AGENT_RUNTIME_HARNESSES = ['openclaude', 'darksol', 'tachi', 'codex'] as const
export type AgentRuntimeHarness  = typeof AGENT_RUNTIME_HARNESSES[number]
export type AgentRuntimeProvider = 'default' | 'opengateway' | 'bankr' | 'surplus' | 'venice' | 'imgnai'

export interface AgentRuntimeSnapshot {
  sessionId:  string | null
  workingDir: string | null
  status:     AgentRuntimeStatus
  harness:    AgentRuntimeHarness
  provider:   AgentRuntimeProvider
  bankrModel: string
}

export interface AgentRuntimeState extends AgentRuntimeSnapshot {
  setStatus(status: AgentRuntimeStatus): void
  setHarness(harness: AgentRuntimeHarness): void
  setProvider(provider: AgentRuntimeProvider, bankrModel?: string): void
  setSession(sessionId: string | null, workingDir: string | null): void
  reset(): void
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const agentRuntimeStore = createStore<AgentRuntimeState>((set, get) => ({
  // Initial snapshot — all idle defaults
  sessionId:  null,
  workingDir: null,
  status:     'idle',
  harness:    'tachi',
  provider:   'default',
  // Keep in sync with src/store/agent.store.ts DEFAULT_BANKR_MODEL (separate
  // process — no shared import) and the agent:start-session zod default.
  bankrModel: 'claude-opus-5',

  setStatus(status) {
    set({ status })
    broadcastStateChanged(getSnapshot(get()))
  },

  setHarness(harness) {
    set({ harness })
    broadcastStateChanged(getSnapshot(get()))
  },

  setProvider(provider, bankrModel) {
    set({ provider, ...(bankrModel !== undefined ? { bankrModel } : {}) })
    broadcastStateChanged(getSnapshot(get()))
  },

  setSession(sessionId, workingDir) {
    set({ sessionId, workingDir })
    broadcastStateChanged(getSnapshot(get()))
  },

  reset() {
    set({ sessionId: null, workingDir: null, status: 'idle' })
    broadcastStateChanged(getSnapshot(get()))
  },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the serialisable snapshot (no functions). */
export function getSnapshot(state: AgentRuntimeState): AgentRuntimeSnapshot {
  return {
    sessionId:  state.sessionId,
    workingDir: state.workingDir,
    status:     state.status,
    harness:    state.harness,
    provider:   state.provider,
    bankrModel: state.bankrModel,
  }
}

/**
 * Push the current snapshot to every live BrowserWindow.
 * Skips windows that are being destroyed to avoid Electron "Object is destroyed"
 * errors (same guard pattern used in agent.ipc.ts pushEvent()).
 */
function broadcastStateChanged(snapshot: AgentRuntimeSnapshot): void {
  const channel = 'agent-runtime:state-changed'
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, snapshot)
    }
  }
}
