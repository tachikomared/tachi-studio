// apps/desktop/src/pages/agent/useDefaultAgentRoute.ts
//
// What would the 'default' provider actually run right now? The DECISION is
// pickDefaultAgentRoute (@tachi/core agent-route.ts) — the same pure function
// resolveTachiRouting consumes in main — so the label and the route share one
// ladder. The only main-side fact the renderer needs is key PRESENCE, fetched
// via the existing settings.listKeys() IPC.
//
// Returns null until the keys have loaded: consumers must claim NOTHING while
// null — in particular a FREE label may only render from a loaded route with
// `free === true` (never as a default), because the ladder prefers a stored
// paid key.

import { useEffect, useState } from 'react'
import { pickDefaultAgentRoute, type DefaultAgentRoute } from '@tachi/core/src/providers/agent-route'

// Module-level cache: instant paint on remount, refreshed by every mount's
// fetch (keys change in Settings/Studio while this page is elsewhere).
let cached: DefaultAgentRoute | null = null

export function useDefaultAgentRoute(): DefaultAgentRoute | null {
  const [route, setRoute] = useState<DefaultAgentRoute | null>(cached)
  useEffect(() => {
    let alive = true
    window.tachi?.settings?.listKeys?.()
      .then(keys => {
        if (!alive || !Array.isArray(keys)) return
        cached = pickDefaultAgentRoute({
          opengateway: keys.includes('opengateway'),
          bankr:       keys.includes('bankr-gateway'),
        })
        setRoute(cached)
      })
      .catch(() => { /* keys unknown → keep claiming nothing */ })
    return () => { alive = false }
  }, [])
  return route
}
