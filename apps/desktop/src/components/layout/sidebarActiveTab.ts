// apps/desktop/src/components/layout/sidebarActiveTab.ts
//
// Pure route → sidebar-tab logic for the active pill, pulled out of
// Sidebar.tsx so it is unit-testable without importing Sidebar.tsx itself
// (which drags in a dozen zustand stores + WalletWidget). Same reason
// AgentPage.tsx's own pure helpers live in separate leaf modules like
// pages/agent/permissionQueue.ts.

export const PRIMARY_TABS = ['chat', 'code', 'nodes', 'design', 'media', 'inbox'] as const
export const MORE_TABS = ['swarm', 'studio', 'catalog', 'aeon', 'nook', 'learn'] as const
export type TabId = (typeof PRIMARY_TABS)[number] | (typeof MORE_TABS)[number]

// The route each tile's onClick navigates to (Sidebar's renderTab) — one
// table so the two can't drift silently. A Record over TabId so TypeScript
// catches a tab left unmapped.
export const TAB_ROUTES: Record<TabId, string> = {
  chat: '/chat', code: '/agent', nodes: '/nodes', design: '/design',
  media: '/media', inbox: '/inbox',
  swarm: '/swarm', studio: '/studio', catalog: '/catalog', aeon: '/aeon',
  nook: '/nook', learn: '/learn',
}

export function routeMatches(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`)
}

/**
 * Which sidebar tile the active pill should light up for `pathname` — exact-
 * or segment-aware (`/agent` and `/agent/x` both hit `code`; `/agentx` does
 * not, and neither does `/tachiapp`, an unrelated route).
 *
 * BUG, observed live: the pill was driven by `sidebarTab` alone — a plain
 * preference set ONLY when a tile is explicitly clicked (Sidebar's renderTab
 * onClick). The TACHIAPP row navigates with a bare `navigate('/tachiapp')`
 * and never touches it, so whichever tile was clicked last (usually CODE)
 * stayed highlighted on /tachiapp forever — alongside the pinned row's own,
 * correctly route-based highlight (`tachiappActive` in Sidebar.tsx). Two rows
 * lit at once, and the reverse held too: landing on /agent any way other
 * than a tile click left CODE dark.
 *
 * A route that maps to a known tab now always wins over the stale
 * preference — /agent is always CODE, however you got there. /tachiapp maps
 * to nothing (it owns no tab id of its own; the pinned row lights itself off
 * the same route), so no primary/more tile lights up together with it. Any
 * OTHER route (settings, home, …) keeps the previous convention — whatever
 * tile was last clicked stays highlighted, since those pages are not tabs.
 *
 * Generic over the preference's type rather than pinned to `TabId`: the
 * store's `sidebarTab` is `ui.store`'s wider `SidebarTab` (it carries one
 * legacy value, 'artifacts', that predates Artifacts becoming a Media
 * sub-tab and is no longer one of these tiles) — this module stays a leaf
 * with zero store imports, so it takes whatever the caller's preference type
 * is and hands the same type back on the fallback path.
 */
export function activeSidebarTab<T extends string>(pathname: string, sidebarTab: T): TabId | T | null {
  if (routeMatches(pathname, '/tachiapp')) return null
  const hit = (Object.keys(TAB_ROUTES) as TabId[]).find(tab => routeMatches(pathname, TAB_ROUTES[tab]))
  return hit ?? sidebarTab
}
