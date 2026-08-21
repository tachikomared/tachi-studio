// apps/desktop/src/components/permissionOverlay.ts
//
// Pure route/queue logic for the GLOBAL permission overlay, kept out of
// PermissionOverlayHost.tsx so it is unit-testable without a router, a store or
// a DOM (same reason `sidebarActiveTab.ts` and `pages/agent/permissionQueue.ts`
// are leaf modules).
//
// THE BUG THIS EXISTS FOR (dogfood-4, 2026-07-26). The permission QUEUE is
// app-lifetime store state and the app-lifetime bridge keeps filling it while no
// page is mounted — that half was fixed in batch13. What was still page-scoped
// was the RENDERER: the cards are JSX inside AgentPage. A live run raised an
// approval, the driver navigated off /tachiapp, and the pending card became
// unreachable — main sat awaiting its resolver for 5.5 minutes until the driver
// navigated back by luck.
//
// So the cards need a renderer that is mounted above the routes. The only design
// question is DOUBLE RENDER: two live PermissionCards for one request id means
// two ALLOW buttons for one resolver, and (worse) two `scrollIntoView` owners
// fighting over the viewport.
//
// DECISION: the overlay is EXCLUSIVE, not additive — it renders only when the
// mounted route does not already render the cards inline. Rejected
// alternatives:
//   • "always float, hide the inline card" — throws away the inline card's
//     context (it sits in the transcript, right after the tool call that asked)
//     and would rewrite the surface everyone already knows.
//   • "always float, keep both" — two ALLOW buttons per resolver. The second
//     click resolves nothing and looks broken.
// The inline card therefore stays authoritative wherever it renders, and the
// overlay is the fallback for every other route. Exactly one renderer, always.

import { routeMatches } from './layout/sidebarActiveTab'
import { permissionOwnerSurface, type RunSurface, type SurfaceSessions } from '../pages/agent/permissionQueue'
import type { PermissionRequest } from '../pages/agent/PermissionCard'

/** Route that AgentPage owns for the CODE surface. */
export const CODE_ROUTE = '/agent'
/** Route that AgentPage owns for the pinned TACHIAPP surface. */
export const TACHIAPP_ROUTE = '/tachiapp'

/**
 * Does the currently mounted route render the permission cards INLINE?
 *
 * /agent and /tachiapp mount AgentPage — but /agent stops rendering the log (and
 * with it the inline PermissionCard) the moment a PARALLEL TASK exists, because
 * the whole log branch is replaced by `<ParallelTaskGrid>`. That is a second,
 * quieter instance of the same unreachable-card bug: an approval raised while
 * the grid is up has no inline renderer either. Grid mode is CODE-only by
 * construction (`parallelGridMode = !appMode && parallelTaskCount >= 1`), so
 * TACHIAPP always renders inline.
 */
export function inlinePermissionRendererMounted(input: {
  pathname:          string
  parallelTaskCount: number
}): boolean {
  if (routeMatches(input.pathname, TACHIAPP_ROUTE)) return true
  if (routeMatches(input.pathname, CODE_ROUTE)) return input.parallelTaskCount === 0
  return false
}

/**
 * Should the floating overlay render? Pure so the exclusivity rule has one
 * definition and a test can pin every branch (see permissionOverlay.test.ts).
 */
export function permissionOverlayVisible(input: {
  pathname:          string
  pendingCount:      number
  parallelTaskCount: number
}): boolean {
  if (input.pendingCount <= 0) return false
  return !inlinePermissionRendererMounted(input)
}

/** Pending-approval counts per surface, for the sidebar badges. */
export interface PendingBySurface {
  code:     number
  tachiapp: number
  /** Cards whose owning surface cannot be determined — see below. */
  unknown:  number
  total:    number
}

/**
 * Split the queue by owning surface.
 *
 * UNKNOWN stays its own bucket and is NEVER folded into `code`. A badge on the
 * wrong tile sends the operator to a surface with nothing to approve, which is
 * the same lie the owner CHIP refuses to tell (`permissionOwnerSurface` returns
 * null rather than guessing). Unknown-owner cards are not lost: the overlay is
 * route-independent, so it shows them wherever the operator is.
 */
export function pendingBySurface(
  queue: readonly PermissionRequest[],
  live: SurfaceSessions,
): PendingBySurface {
  let code = 0, tachiapp = 0, unknown = 0
  for (const req of queue) {
    const owner: RunSurface | null = permissionOwnerSurface(req, live)
    if (owner === 'code') code++
    else if (owner === 'tachiapp') tachiapp++
    else unknown++
  }
  return { code, tachiapp, unknown, total: queue.length }
}

/** Route to navigate to when the operator clicks through from the overlay. */
export function routeForSurface(surface: RunSurface | null): string {
  return surface === 'tachiapp' ? TACHIAPP_ROUTE : CODE_ROUTE
}
