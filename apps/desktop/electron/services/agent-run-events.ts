// apps/desktop/electron/services/agent-run-events.ts
//
// Tiny main-process bus decoupling agent-run lifecycle producers (agent.ipc)
// from remote observers (telegram-service, UX F19). agent.ipc emits
// run-started / run-finished / permission-requested and registers the ONE
// permission resolver (it owns the pendingPermissions map); telegram-service
// subscribes when enabled+paired and can resolve a pending permission from an
// inline-keyboard press. No electron imports — unit-testable.

export type AgentRunEvent =
  | { type: 'run-started'; harness: string; workingDir: string; task: string }
  | { type: 'run-finished'; harness: string; workingDir: string; ok: boolean; ms: number; error?: string }
  | { type: 'permission-requested'; id: string; toolName: string; reason: string }
  | { type: 'permission-resolved'; id: string; decision: string; via: 'app' | 'remote' }

type Listener = (e: AgentRunEvent) => void

const listeners = new Set<Listener>()

export function onAgentRunEvent(l: Listener): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function emitAgentRunEvent(e: AgentRunEvent): void {
  for (const l of listeners) {
    try { l(e) } catch { /* observers must never break the run */ }
  }
}

// ── Remote permission resolution ─────────────────────────────────────────────

type PermissionResolver = (id: string, decision: 'allow' | 'deny' | 'allow_30m') => boolean

let resolver: PermissionResolver | null = null

/** agent.ipc registers the single resolver over its pendingPermissions map. */
export function registerPermissionResolver(fn: PermissionResolver): void {
  resolver = fn
}

/**
 * Resolve a pending permission from a remote surface (Telegram button).
 * Returns false when the request is unknown/already resolved — the caller
 * should tell the remote user it expired rather than pretend success.
 */
export function resolveRemotePermission(id: string, decision: 'allow' | 'deny' | 'allow_30m'): boolean {
  if (!resolver) return false
  const ok = resolver(id, decision)
  if (ok) emitAgentRunEvent({ type: 'permission-resolved', id, decision, via: 'remote' })
  return ok
}
