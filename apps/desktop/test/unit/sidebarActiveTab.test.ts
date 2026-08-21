// apps/desktop/test/unit/sidebarActiveTab.test.ts
//
// The sidebar's active pill used to be driven by `sidebarTab` alone — a
// preference set ONLY when a tile is explicitly clicked. The TACHIAPP row
// navigates with a bare `navigate('/tachiapp')` and never touches it, so
// whichever tile was clicked last (usually CODE) stayed highlighted on
// /tachiapp forever, alongside TACHIAPP's own correctly route-based
// highlight. `activeSidebarTab` fixes this: a route that maps to a known tab
// always wins over the stale preference, and /tachiapp maps to none.

import { describe, it, expect } from 'vitest'
import { activeSidebarTab, TAB_ROUTES, type TabId } from '../../src/components/layout/sidebarActiveTab'

describe('activeSidebarTab', () => {
  it('/agent is always CODE, whatever the stale sidebarTab preference says', () => {
    expect(activeSidebarTab('/agent', 'code')).toBe('code')
    // The bug, reversed: landing on /agent via a deep link / browser-back
    // while sidebarTab still says something else must NOT leave CODE dark.
    expect(activeSidebarTab('/agent', 'nook')).toBe('code')
  })

  it('/tachiapp lights up no primary/more tile — THE bug', () => {
    // Before the fix this returned whatever tile was clicked last (e.g.
    // 'code'), so CODE stayed highlighted on the TACHIAPP surface.
    expect(activeSidebarTab('/tachiapp', 'code')).toBe(null)
    expect(activeSidebarTab('/tachiapp', 'nook')).toBe(null)
  })

  it('is exact-or-segment-aware: a sub-path still matches, a longer word does not', () => {
    expect(activeSidebarTab('/agent/sub', 'chat')).toBe('code')
    // '/agentx' is a DIFFERENT route, not a sub-path of /agent.
    expect(activeSidebarTab('/agentx', 'chat')).toBe('chat')
    expect(activeSidebarTab('/tachiapp/anything', 'code')).toBe(null)
    expect(activeSidebarTab('/tachiappx', 'code')).toBe('code')
  })

  it('every tile-owning route resolves to its own tab, nothing else', () => {
    for (const tab of Object.keys(TAB_ROUTES) as TabId[]) {
      expect(activeSidebarTab(TAB_ROUTES[tab], 'chat')).toBe(tab)
    }
  })

  it('a route with no tab of its own falls back to the last-clicked tile (unchanged prior convention)', () => {
    expect(activeSidebarTab('/settings', 'design')).toBe('design')
    expect(activeSidebarTab('/home', 'swarm')).toBe('swarm')
  })

  it('the pinned TACHIAPP row and the tile pill are mutually exclusive by construction', () => {
    // Sidebar.tsx highlights the TACHIAPP row off `pathname === '/tachiapp'`
    // directly; this function returning null there is what keeps the two
    // rows from ever lighting up together.
    const tachiappRowActive = (pathname: string) => pathname === '/tachiapp'
    for (const pathname of ['/agent', '/tachiapp', '/chat', '/nodes']) {
      const tileActive = activeSidebarTab(pathname, 'code') !== null
      expect(tileActive && tachiappRowActive(pathname)).toBe(false)
    }
  })
})
