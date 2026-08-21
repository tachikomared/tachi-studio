// apps/desktop/electron/ipc/router-stats.ipc.ts
//
// Read-only smart-router telemetry for the Observability tab: per-tier routed
// counts (the savings-breakdown substrate) + the top bandit buckets. No
// payload, no mutation — safe to expose as-is.

import { ipcMain } from 'electron'
import { getRouteStats, banditStats } from '../services/surplus-router-state'
import { getCompactionSavings } from '../services/compaction-stats'
import { getCacheSavings } from '../services/cache-stats'

export function registerRouterStatsIpc(): void {
  ipcMain.handle('router:stats', () => {
    const routes = getRouteStats()
    // Top bandit ARMS (bucket|model entries) by observation count — the
    // "what has the router learned" view. Bucket-level entries (no '|') are
    // skipped; they exist for coarse telemetry only.
    const arms = Object.entries(banditStats())
      .filter(([k]) => k.includes('|'))
      .map(([k, v]) => {
        const [bucket, model] = k.split('|') as [string, string]
        return { bucket, model, ok: v.a - 1, err: v.b - 1, mean: v.mean }
      })
      .filter(a => a.ok + a.err > 0)
      .sort((x, y) => (y.ok + y.err) - (x.ok + x.err))
      .slice(0, 8)
    // Ride the same read-only observability channel the tab already polls: the
    // compactor's "tokens saved" aggregate (headroom-inspired) and the provider
    // prompt-cache hits (CACHE-ALIGN 2026-07-21) travel alongside the router
    // savings breakdown rather than opening new IPC surfaces.
    return { routes, arms, compaction: getCompactionSavings(), cache: getCacheSavings() }
  })
}
