/** The managed child processes. */
export type SidecarId = 'freellmapi' | 'openclaude' | 'freeclaudecode' | 'claude-code-router' | 'llama-cpp' | 'darksol'

/** Process lifecycle states. */
export type SidecarState = 'stopped' | 'starting' | 'running' | 'error'

/**
 * Snapshot of a sidecar's state, safe to serialize over IPC.
 * All fields are optional except `id` and `state`.
 */
export interface SidecarInfo {
  /** Which sidecar this describes. */
  id: SidecarId
  /** Current lifecycle state. */
  state: SidecarState
  /** Bound TCP port — present when `state` is `running`. */
  port?: number
  /** OS process id — present while the process is alive. */
  pid?: number
  /** Milliseconds since the sidecar reached `running` state. */
  uptimeMs?: number
  /** Human-readable error message — present when `state` is `error`. */
  error?: string
}

/**
 * Payload for `sidecar:start`. None of the currently managed sidecars need a
 * working directory (per-session workspaces are passed by the harness client),
 * so `workingDir` is a vestigial optional field kept for wire compatibility.
 */
export interface StartSidecarPayload {
  id: SidecarId
  /** Absolute path to the workspace directory. Unused by every current sidecar. */
  workingDir?: string
}
