// apps/desktop/electron/services/capability-service.ts
//
// PRIVATE MODE (Tier 4) — main-process capability queue.
//
// Manages the pending-approval queue and resolves agent tool-call gates.
// This service is the counterpart to apps/desktop/src/store/capability.store.ts
// on the renderer side. The two files deliberately do NOT import each other
// (renderer / main isolation); they share a type shape that must be kept in
// sync by hand.
//
// Two operating modes (driven by the renderer via setMode):
//
//   - 'immediate':  awaitDecision returns a pending Promise; the IPC layer
//                   surfaces the request via the existing blocking
//                   ConfirmDialog flow. The service emits 'push' for
//                   observability but doesn't differentiate behaviour.
//
//   - 'inbox':      same Promise mechanic, but the IPC layer routes the
//                   request to InboxView instead of a modal. The agent still
//                   blocks until the user resolves the request.
//
// The Promise contract is identical in both modes — the caller (e.g. the
// openclaude canUseTool hook, or any future tool gate) just awaits and gets
// 'allow' | 'deny'. Mode is consulted by the IPC layer to decide UI
// presentation, not by this service.
//
// Lifecycle of one request:
//   1. canUseTool hook (or equivalent) calls awaitDecision(request).
//      A Promise is registered in `pending`, 'push' fires, the caller awaits.
//   2. IPC layer surfaces the request to the user (modal or inbox).
//   3. User resolves -> IPC calls deliverDecision(id, decision).
//      The Promise resolves with the decision, 'resolve' fires for observers.
//   4. Alternatively, the session aborts -> cancelPending(id) resolves the
//      Promise as 'deny' and removes it from the queue.
//   5. At app shutdown, cancelAll() releases any agents still blocked on
//      pending decisions so they unwind cleanly.

import { EventEmitter } from 'node:events'
import { approveForSession } from './permission-service'

export type CapabilityMode = 'immediate' | 'inbox'

export type ToolDecision = 'allow' | 'deny'

/**
 * Options the IPC layer may attach when delivering a decision.
 *
 * - `ttlMs`: when present alongside an 'allow' decision, the inbox "Approve for
 *   <N> min" action — records a TTL session approval (permission-service) keyed
 *   by the request's toolName + sessionId so identical follow-up calls
 *   auto-approve until it expires, instead of re-prompting. Ignored on 'deny'.
 */
export interface DecisionOptions {
  ttlMs?: number
}

/**
 * Shape of a request as it flows from the agent into this service.
 *
 * Mirrors `CapabilityRequest` in
 * apps/desktop/src/store/capability.store.ts (minus the renderer-only
 * `status` / `snoozedUntil` fields, which are lifecycle metadata owned by
 * the renderer store, not the agent gate). Keep field names in sync with
 * the renderer-side type so IPC payloads serialise cleanly via
 * structured-clone.
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
  /** Service's pre-classification — UI surfaces it as the default action. */
  recommendedDecision: ToolDecision
  /** Chat/agent session that originated the request. */
  sessionId: string
  /** Working directory of the agent at request time. */
  workingDir: string
  /** Epoch ms timestamp of when the request entered the queue. */
  pushedAt: number
}

/**
 * Strongly-typed event map for CapabilityService listeners.
 *
 * - 'push':    a new request entered the pending queue.
 * - 'resolve': a previously-pending request was decided (allow|deny) — either
 *              by the user via deliverDecision, or by an automated cancel.
 */
export interface CapabilityServiceEvents {
  push: (req: CapabilityRequest) => void
  resolve: (id: string, decision: ToolDecision) => void
}

interface PendingEntry {
  resolve: (decision: ToolDecision) => void
  request: CapabilityRequest
}

/**
 * Singleton-style queue + Promise broker. See file header for full lifecycle.
 *
 * Constructed once below as `capabilityService`. The class is exported for
 * testability (e.g. unit tests that need their own isolated instance).
 *
 * Typed-events note: we override `on`/`once`/`off`/`emit` to project the
 * untyped `EventEmitter` API onto `CapabilityServiceEvents`. The underlying
 * implementation is unchanged — this only narrows the types at the boundary.
 */
export class CapabilityService extends EventEmitter {
  private pending = new Map<string, PendingEntry>()
  private mode: CapabilityMode = 'immediate'

  /** Update the active mode. Called by the IPC layer when the renderer toggles. */
  setMode(mode: CapabilityMode): void {
    this.mode = mode
  }

  /** Read the active mode. The IPC layer uses this to choose modal vs inbox routing. */
  getMode(): CapabilityMode {
    return this.mode
  }

  /**
   * Push a request and block until the user (or auto-approval) decides.
   * Caller is the openclaude canUseTool hook or any future tool gate.
   *
   * The returned Promise resolves with the user's decision. It rejects only
   * if the underlying EventEmitter machinery throws (never under normal
   * operation). Use cancelPending(id) to force-resolve as 'deny'.
   */
  awaitDecision(request: CapabilityRequest): Promise<ToolDecision> {
    return new Promise<ToolDecision>((resolve) => {
      const existing = this.pending.get(request.id)
      if (existing) {
        console.warn(
          `[capability] duplicate request id: ${request.id} — denying the old pending request`,
        )
        this.pending.delete(request.id)
        existing.resolve('deny')
        this.emit('resolve', request.id, 'deny')
      }
      this.pending.set(request.id, { resolve, request })
      this.emit('push', request)
    })
  }

  /**
   * Resolve a pending request — called by the IPC layer when the user
   * approves or denies. No-op if `id` is not currently pending (idempotent
   * for double-deliveries; the agent has already moved on).
   *
   * When `opts.ttlMs` accompanies an 'allow', a TTL session approval is recorded
   * (keyed by the request's toolName + originating sessionId) so identical
   * follow-up calls auto-approve until it expires — the "Approve for <N> min"
   * affordance. Has no effect on 'deny'.
   */
  deliverDecision(id: string, decision: ToolDecision, opts?: DecisionOptions): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (decision === 'allow' && opts?.ttlMs && opts.ttlMs > 0) {
      approveForSession(
        { toolName: entry.request.toolName, actor: entry.request.sessionId },
        opts.ttlMs,
      )
    }
    entry.resolve(decision)
    this.emit('resolve', id, decision)
  }

  /**
   * Cancel a pending request — resolves it as 'deny' and removes it from the
   * queue. Called when a session aborts mid-flight or the user explicitly
   * dismisses a queued request.
   */
  cancelPending(id: string): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.resolve('deny')
    this.emit('resolve', id, 'deny')
  }

  /**
   * Snapshot of currently-pending requests. Intended for the inbox refresh
   * IPC handler — gives the renderer a starting point when it (re)connects.
   */
  listPending(): CapabilityRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  /**
   * Abort all pending requests — used at app shutdown to release any blocked
   * agents so they can unwind cleanly instead of dangling on a Promise.
   */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancelPending(id)
  }

  // ── Typed event API ────────────────────────────────────────────────────
  // These overrides keep the runtime behaviour of EventEmitter intact while
  // narrowing the signatures to CapabilityServiceEvents.

  override on<K extends keyof CapabilityServiceEvents>(
    event: K,
    listener: CapabilityServiceEvents[K],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  override once<K extends keyof CapabilityServiceEvents>(
    event: K,
    listener: CapabilityServiceEvents[K],
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void)
  }

  override off<K extends keyof CapabilityServiceEvents>(
    event: K,
    listener: CapabilityServiceEvents[K],
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void)
  }

  override emit<K extends keyof CapabilityServiceEvents>(
    event: K,
    ...args: Parameters<CapabilityServiceEvents[K]>
  ): boolean {
    return super.emit(event, ...args)
  }
}

/**
 * Singleton instance — the main process has one shared queue across all agent
 * sessions. Wire it into the IPC layer (later task); never construct your own
 * unless writing a unit test.
 */
export const capabilityService = new CapabilityService()
