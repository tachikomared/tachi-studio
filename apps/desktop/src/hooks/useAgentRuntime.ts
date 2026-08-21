// apps/desktop/src/hooks/useAgentRuntime.ts
//
// Sprint C2: renderer hook that subscribes to the main-process agent-runtime store.
//
// On mount it fetches the current snapshot via IPC (agent-runtime:get-state),
// then stays in sync by listening to the push channel (agent-runtime:state-changed)
// that the main store broadcasts on every mutation.
//
// Returns a read-only snapshot. All writes go through window.tachi.agentRuntime.*
// if needed by the component (for future writer surfaces). This hook is read-only.
//
// The subscription is cleaned up on unmount, so it is safe to mount in many
// windows simultaneously — each window subscribes independently and stays in
// lockstep thanks to the broadcast from the main store.

import { useState, useEffect } from 'react'

export interface AgentRuntimeSnapshot {
  sessionId:  string | null
  workingDir: string | null
  status:     'idle' | 'starting' | 'running' | 'done' | 'error'
  harness:    'openclaude' | 'darksol' | 'tachi' | 'codex'
  provider:   'default' | 'opengateway' | 'bankr' | 'surplus'
  bankrModel: string
}

const DEFAULT_SNAPSHOT: AgentRuntimeSnapshot = {
  sessionId:  null,
  workingDir: null,
  status:     'idle',
  harness:    'tachi',
  provider:   'default',
  bankrModel: 'claude-opus-5',
}

/**
 * Subscribe to the main-process agent-runtime store.
 *
 * Returns a read-only AgentRuntimeSnapshot. The value is:
 *   1. The DEFAULT_SNAPSHOT until the initial IPC fetch resolves.
 *   2. The current main-side snapshot after the first invoke completes.
 *   3. Updated in real-time via the "agent-runtime:state-changed" push channel.
 *
 * Cleans up the push-channel listener on unmount.
 */
export function useAgentRuntime(): AgentRuntimeSnapshot {
  const [snapshot, setSnapshot] = useState<AgentRuntimeSnapshot>(DEFAULT_SNAPSHOT)

  useEffect(() => {
    let cancelled = false

    // Fetch initial state
    window.tachi.agentRuntime
      .getState({})
      .then((s) => {
        if (!cancelled) setSnapshot(s as AgentRuntimeSnapshot)
      })
      .catch(() => {
        // Best-effort — keep DEFAULT_SNAPSHOT if IPC unavailable
      })

    // Subscribe to push channel
    const unsub = window.tachi.agentRuntime.onStateChanged((s) => {
      if (!cancelled) setSnapshot(s as AgentRuntimeSnapshot)
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  return snapshot
}
