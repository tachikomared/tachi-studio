// apps/desktop/electron/services/pending-permissions.ts
//
// Registry of IN-FLIGHT permission prompts (the "immediate"/modal path).
//
// WHY THIS EXISTS (live-dogfood bug, 2026-07-25): the TACHI harness can emit
// two tool calls in the same step (parallel tool calling). Each one blocks on
// its own `await new Promise(resolve => pendingPermissions.set(id, resolve))`.
// The renderer used to hold ONE pending card, so the second request overwrote
// the first, the first resolver was never called — and because the await had NO
// timeout, the run hung in WORKING forever.
//
// The renderer now queues the cards; this registry is the defense in depth on
// the main side:
//   - every awaited request carries a timeout (default 10 min) after which it
//     resolves as DENIED with reason 'timeout' — a lost prompt can no longer
//     hang a run forever;
//   - aborting/stopping a run cancels every request in that run's scope
//     immediately (reason 'cancelled'), so no tool is left blocked on a card
//     the user can no longer see;
//   - a duplicate id supersedes (and denies) the older entry rather than
//     silently dropping its resolver.
//
// The caller receives an OUTCOME (decision + reason), not a bare decision, so
// the tool result handed back to the model can say *why* it was refused —
// "denied by the user" and "nobody answered in 10 minutes" are different facts.
//
// RE-SYNC (live-dogfood bug #2, same day): the renderer's queue used to be
// AgentPage component state, so navigating CODE → NODES → CODE unmounted the
// page and the card vanished FOREVER while this registry kept awaiting. The
// registry therefore also REMEMBERS each request's renderer payload and can
// hand the outstanding ones back (`listPending`) — a remount (or a full
// renderer reload) repopulates its queue instead of losing the prompt.
//
// Pure module: type-only imports from permission-service, no electron — testable.

import type { PermissionDecision, PermissionRequest } from './permission-service'

/** Why a pending permission settled. */
export type PermissionOutcomeReason =
  /** A human (app modal or remote surface) answered. */
  | 'user'
  /** Nobody answered within the timeout window. */
  | 'timeout'
  /** The run was aborted/stopped while the prompt was still open. */
  | 'cancelled'
  /** A second request reused the same id (should never happen — randomUUID). */
  | 'superseded'

export interface PermissionOutcome {
  decision: PermissionDecision
  reason: PermissionOutcomeReason
}

/** Generous by design: a human may be away from the keyboard, but not forever. */
export const PERMISSION_PROMPT_TIMEOUT_MS = 10 * 60 * 1000

/** Tool-result text for a timed-out prompt (the model reads this). */
export const PERMISSION_TIMEOUT_TOOL_MESSAGE =
  'Permission request timed out — nobody answered the prompt within 10 minutes, so the call was NOT executed. Re-issue the call if it is still needed.'

/** Tool-result text for a prompt cancelled by an abort/stop. */
export const PERMISSION_CANCELLED_TOOL_MESSAGE =
  'Permission request cancelled — the run was stopped before the prompt was answered, so the call was NOT executed.'

/** Tool-result text for the (defensive) duplicate-id case. */
export const PERMISSION_SUPERSEDED_TOOL_MESSAGE =
  'Permission request superseded by a newer request with the same id — the call was NOT executed.'

/** The message a denied call should hand back to the model, per reason. */
export function toolMessageForOutcome(outcome: PermissionOutcome, toolName: string): string {
  switch (outcome.reason) {
    case 'timeout':    return PERMISSION_TIMEOUT_TOOL_MESSAGE
    case 'cancelled':  return PERMISSION_CANCELLED_TOOL_MESSAGE
    case 'superseded': return PERMISSION_SUPERSEDED_TOOL_MESSAGE
    default:
      return `Permission denied: the user declined "${toolName}". Do not retry the same call; ask the user or try a different approach.`
  }
}

export interface AwaitPermissionOptions {
  /** Request id (correlates with the renderer card + remote surfaces). */
  id: string
  /**
   * Cancellation scope — the taskId whose abort should release this prompt.
   * Defaults to 'default' (the legacy single-session slot).
   */
  scope?: string
  /** Override the timeout window; `0`/negative disables the timer (tests only). */
  timeoutMs?: number
  /** Fired after a timeout settles the request (surface it to the user). */
  onTimeout?: (id: string, scope: string) => void
  /**
   * The card payload the renderer was sent. Supplied ONLY by the modal path, so
   * `listPending()` returns exactly the requests a re-mounted AgentPage should
   * put back on screen (inbox-mode requests are surfaced by InboxView instead).
   */
  request?: PermissionRequest
}

interface Entry {
  id: string
  scope: string
  settle: (outcome: PermissionOutcome) => void
  timer: ReturnType<typeof setTimeout> | null
  request?: PermissionRequest
}

export class PendingPermissionRegistry {
  private readonly pending = new Map<string, Entry>()

  /** Number of prompts currently awaiting an answer. */
  get size(): number {
    return this.pending.size
  }

  /** Ids currently awaiting an answer (stable insertion order). */
  ids(): string[] {
    return [...this.pending.keys()]
  }

  has(id: string): boolean {
    return this.pending.has(id)
  }

  /**
   * The outstanding MODAL requests, oldest first — what a (re)mounting renderer
   * must put back on screen. Requests raised without a card payload (the
   * PRIVATE-MODE inbox path) are omitted: their surface re-syncs separately.
   */
  listPending(scope?: string): PermissionRequest[] {
    const out: PermissionRequest[] = []
    for (const e of this.pending.values()) {
      if (!e.request) continue
      if (scope !== undefined && e.scope !== scope) continue
      out.push(e.request)
    }
    return out
  }

  /**
   * Block until the request is answered, times out, or is cancelled.
   * ALWAYS settles — the returned promise can never be left dangling.
   */
  awaitDecision(opts: AwaitPermissionOptions): Promise<PermissionOutcome> {
    const {
      id,
      scope = 'default',
      timeoutMs = PERMISSION_PROMPT_TIMEOUT_MS,
      onTimeout,
      request,
    } = opts

    // Defensive: never orphan a resolver by overwriting its map entry.
    this.settle(id, { decision: 'deny', reason: 'superseded' })

    return new Promise<PermissionOutcome>((resolve) => {
      let settled = false
      const settle = (outcome: PermissionOutcome): void => {
        if (settled) return
        settled = true
        resolve(outcome)
      }

      let timer: ReturnType<typeof setTimeout> | null = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const entry = this.pending.get(id)
          if (!entry) return
          this.pending.delete(id)
          entry.settle({ decision: 'deny', reason: 'timeout' })
          // Observers must never break the gate.
          try { onTimeout?.(id, scope) } catch { /* best-effort notification */ }
        }, timeoutMs)
        // Don't hold the process open just for a permission prompt.
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }

      this.pending.set(id, { id, scope, settle, timer, ...(request ? { request } : {}) })
    })
  }

  /**
   * Deliver a human decision (app modal or remote surface).
   * Returns false when the id is unknown/already settled — callers should tell
   * the user it expired rather than pretend it landed.
   */
  deliver(id: string, decision: PermissionDecision): boolean {
    return this.settle(id, { decision, reason: 'user' })
  }

  /** Deny every prompt in a scope (a run was aborted/stopped). Returns the ids. */
  cancelScope(scope: string): string[] {
    const ids = [...this.pending.values()].filter(e => e.scope === scope).map(e => e.id)
    for (const id of ids) this.settle(id, { decision: 'deny', reason: 'cancelled' })
    return ids
  }

  /** Deny every outstanding prompt (app shutdown). Returns the ids. */
  cancelAll(): string[] {
    const ids = this.ids()
    for (const id of ids) this.settle(id, { decision: 'deny', reason: 'cancelled' })
    return ids
  }

  private settle(id: string, outcome: PermissionOutcome): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.settle(outcome)
    return true
  }
}

/** App-wide registry — agent.ipc owns it; remote surfaces resolve through it. */
export const pendingPermissions = new PendingPermissionRegistry()
