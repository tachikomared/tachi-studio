// apps/desktop/src/hooks/useProviderHealth.ts
//
// Drives the background provider-health sweep for the lifetime of the calling
// component, and exposes the reactive per-provider health map. The store's
// refcounted start() ensures many mounted consumers share ONE 5-minute timer.

import { useEffect } from 'react'
import { useProviderHealthStore, type ProviderHealth } from '../store/provider-health.store'

/**
 * Subscribe to live provider health + keep the background sweep running.
 * Resilient by construction: the store never throws and the sweep is
 * fire-and-forget, so this hook can never break render.
 *
 * @returns the reactive providerId → health map ('unknown' default).
 */
export function useProviderHealth(): Record<string, ProviderHealth> {
  const health = useProviderHealthStore((s) => s.health)
  const start  = useProviderHealthStore((s) => s.start)

  useEffect(() => {
    const stop = start()
    return stop
  }, [start])

  return health
}
