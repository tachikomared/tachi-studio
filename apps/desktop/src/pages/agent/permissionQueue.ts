// apps/desktop/src/pages/agent/permissionQueue.ts
//
// Pure reducer for the pending-permission QUEUE shown in the CODE tab.
//
// WHY: the harness can emit several tool calls in one step (a live run fired two
// bash calls 10 ms apart). The page used to hold a single `pendingPermission`,
// so request #2 overwrote request #1's card — request #1 was never answered and
// the main process, which awaits the decision, blocked the run forever.
//
// Invariant enforced here: a request that ENTERS the queue only ever leaves it
// through an explicit decision (`resolvePermission`) or an explicit cancel from
// main (`dropPermissions`). Nothing silently overwrites anything.
//
// Kept out of AgentPage.tsx so the ordering/dedup rules are unit-testable.

import type { PermissionRequest } from './PermissionCard'

/**
 * Append a request. Re-delivery of an id already queued is a no-op (the same
 * array instance is returned, so React skips the re-render).
 */
export function enqueuePermission(
  queue: readonly PermissionRequest[],
  req: PermissionRequest,
): PermissionRequest[] {
  if (!req || typeof req.id !== 'string' || req.id === '') return queue as PermissionRequest[]
  if (queue.some(q => q.id === req.id)) return queue as PermissionRequest[]
  return [...queue, req]
}

/** Remove one request after the user decided it. */
export function resolvePermission(
  queue: readonly PermissionRequest[],
  id: string,
): PermissionRequest[] {
  if (!queue.some(q => q.id === id)) return queue as PermissionRequest[]
  return queue.filter(q => q.id !== id)
}

/**
 * Remove requests main has already settled without us (timeout / run aborted),
 * so the user never stares at a card whose answer would go nowhere.
 */
export function dropPermissions(
  queue: readonly PermissionRequest[],
  ids: readonly string[],
): PermissionRequest[] {
  if (ids.length === 0) return queue as PermissionRequest[]
  const drop = new Set(ids)
  if (!queue.some(q => drop.has(q.id))) return queue as PermissionRequest[]
  return queue.filter(q => !drop.has(q.id))
}

// ── Who is this card blocking? ───────────────────────────────────────────────
//
// The queue is APP-LIFETIME, so a card renders on whichever AgentPage surface
// happens to be mounted — including the one that does NOT own the run. Observed
// live: TACHIAPP showed the CODE run's bash approval underneath its own
// "another run is in progress" note.
//
// The card stays ACTIONABLE everywhere on purpose — an operator parked on the
// wrong tab must be able to unblock the run; a stalled card is worse than a
// foreign one. But it must say WHOSE run it unblocks, so nobody approves a bash
// command believing it belongs to the tab in front of them.
//
// Main stamps the owning harness session id on the request; the surface tag
// lives in the renderer (agent.store), so the mapping is done here, pure.

/** A run's owning surface, in the operator's language. */
export type RunSurface = 'code' | 'tachiapp'

/** What the renderer knows about which session belongs to which surface. */
export interface SurfaceSessions {
  /** The live harness session id (agent.store). */
  sessionId:  string | null
  /** Tag stamped on that live session — null = the Code tab. */
  sessionTag: 'tachiapp' | null
  /** Session ids of the parallel tiles. The grid is CODE-only, by construction. */
  parallelSessionIds?: readonly string[]
}

/**
 * Which surface owns the run this card is blocking — `null` when it cannot be
 * decided (a request from an older main that carries no session id, or a
 * session that has already left the live slot). Unknown MUST stay unlabelled:
 * a wrong owner chip is worse than none.
 */
export function permissionOwnerSurface(
  req: { sessionId?: string } | null | undefined,
  live: SurfaceSessions,
): RunSurface | null {
  const sid = req?.sessionId
  if (!sid) return null
  if (live.sessionId && sid === live.sessionId) return live.sessionTag === 'tachiapp' ? 'tachiapp' : 'code'
  if (live.parallelSessionIds?.some(p => p === sid)) return 'code'
  return null
}

/**
 * The owner to LABEL on `surface` — i.e. the owning surface when it is not this
 * one. Returns null when the card belongs here (no chip: the header already
 * says what tab you are on) or when ownership is unknown.
 */
export function foreignPermissionOwner(
  req: { sessionId?: string } | null | undefined,
  live: SurfaceSessions,
  surface: RunSurface,
): RunSurface | null {
  const owner = permissionOwnerSurface(req, live)
  return owner && owner !== surface ? owner : null
}

/** The card currently on screen (oldest first — answer them in arrival order). */
export function activePermission(
  queue: readonly PermissionRequest[],
): PermissionRequest | null {
  return queue.length > 0 ? queue[0] : null
}

/** How many requests are waiting BEHIND the active card. */
export function queuedBehind(queue: readonly PermissionRequest[]): number {
  return Math.max(0, queue.length - 1)
}
