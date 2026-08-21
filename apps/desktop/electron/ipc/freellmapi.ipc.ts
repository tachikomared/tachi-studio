// apps/desktop/electron/ipc/freellmapi.ipc.ts
//
// Plain ipcMain.handle wiring for freellmapi-specific routes.
// Uses no typed router — matches the existing freellmapi style
// (direct fetch against the sidecar HTTP API).

import { ipcMain } from 'electron'
import { getFreellmapiPort } from '../services/sidecar-manager'

export interface FallbackModel {
  platform:  string
  modelId:   string
  name:      string
  keyCount:  number
  priority:  number
  enabled:   boolean
}

/**
 * freellmapi:list-fallback-models
 *
 * Fetches GET /api/fallback from the freellmapi sidecar.
 * Returns only models where keyCount > 0 (router can actually use them),
 * in current priority order (what the fallback chain will try).
 *
 * Returns { ok: false, models: [] } when freellmapi is not running.
 */
ipcMain.handle('freellmapi:list-fallback-models', async () => {
  const port = getFreellmapiPort()
  if (!port) return { ok: false, models: [] as FallbackModel[], error: 'freellmapi not running' }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/fallback`, {
      signal: AbortSignal.timeout(5_000) as AbortSignal,
    })
    if (!res.ok) {
      return { ok: false, models: [] as FallbackModel[], error: `HTTP ${res.status}` }
    }
    // THE RELAY CALLS IT `displayName`. This mapper read `m.name`, which the
    // relay has never sent, so every row arrived with name === undefined and
    // every model in the composer's pin dropdown rendered as a platform tag
    // followed by nothing: "KILO", "OPENROUTER". The field name is the whole
    // bug; the `?? modelId` is the belt — a row can be pinned by a user who can
    // read what they are pinning, always.
    const data = await res.json() as Array<{
      platform:    string
      modelId:     string
      displayName: string
      keyCount:    number
      priority:    number
      enabled:     boolean
    }>
    const models: FallbackModel[] = data
      .filter(m => m.keyCount > 0 && m.enabled)
      .map(m => ({
        platform: m.platform,
        modelId:  m.modelId,
        name:     m.displayName || m.modelId,
        keyCount: m.keyCount,
        priority: m.priority,
        enabled:  m.enabled,
      }))
    return { ok: true, models }
  } catch (err) {
    return { ok: false, models: [] as FallbackModel[], error: String(err) }
  }
})

/**
 * What the relay ACTUALLY knows about — one row per platform it has in its own
 * catalog, with the key situation for each.
 *
 * This exists because the Free Providers card advertised OpenCode Zen with a
 * [FREE · NO KEY] badge on a build whose relay had never heard of `zen`. The
 * card was rendering a hardcoded expectation, and the anon seed that would have
 * failed loudly was swallowed by a bare catch. A UI claim about a system should
 * be derived from that system; this is the derivation.
 *
 * Both routes exist on the UNPATCHED upstream relay too, so a degraded install
 * reports honestly rather than erroring.
 */
export interface RelayPlatform {
  platform:     string
  /** Catalog rows the relay carries for this platform. */
  modelCount:   number
  /** Key rows the relay holds (a seeded 'anonymous' placeholder counts). */
  keyCount:     number
  healthyKeys:  number
  invalidKeys:  number
  /** The relay has a provider implementation registered for this platform. */
  hasProvider:  boolean
}

ipcMain.handle('freellmapi:list-platforms', async () => {
  const port = getFreellmapiPort()
  if (!port) return { ok: false, platforms: [] as RelayPlatform[], error: 'freellmapi not running' }

  try {
    const [fbRes, healthRes] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/fallback`,  { signal: AbortSignal.timeout(5_000) as AbortSignal }),
      fetch(`http://127.0.0.1:${port}/api/health`,    { signal: AbortSignal.timeout(5_000) as AbortSignal }),
    ])
    if (!fbRes.ok)     return { ok: false, platforms: [] as RelayPlatform[], error: `HTTP ${fbRes.status}` }
    if (!healthRes.ok) return { ok: false, platforms: [] as RelayPlatform[], error: `HTTP ${healthRes.status}` }

    const rows   = await fbRes.json()     as Array<{ platform: string }>
    const health = await healthRes.json() as {
      platforms: Array<{
        platform: string; hasProvider: boolean
        totalKeys: number; healthyKeys: number; invalidKeys: number; enabledKeys: number
      }>
    }

    const modelCounts = new Map<string, number>()
    for (const r of rows) modelCounts.set(r.platform, (modelCounts.get(r.platform) ?? 0) + 1)

    const healthByPlatform = new Map(health.platforms.map(p => [p.platform, p]))

    // Union: a platform with models but no keys is exactly the state worth
    // showing (the router skips it), and so is a key for a platform whose
    // catalog rows are all gone.
    const names = new Set<string>([...modelCounts.keys(), ...healthByPlatform.keys()])
    const platforms: RelayPlatform[] = [...names].sort().map(name => {
      const h = healthByPlatform.get(name)
      return {
        platform:    name,
        modelCount:  modelCounts.get(name) ?? 0,
        keyCount:    h?.enabledKeys ?? 0,
        healthyKeys: h?.healthyKeys ?? 0,
        invalidKeys: h?.invalidKeys ?? 0,
        hasProvider: h?.hasProvider ?? modelCounts.has(name),
      }
    })
    return { ok: true, platforms }
  } catch (err) {
    return { ok: false, platforms: [] as RelayPlatform[], error: String(err) }
  }
})

/**
 * freellmapi:set-sort-mode
 *
 * POSTs to /api/fallback/sort/{mode} to reorder the fallback chain.
 * mode: 'intelligence' | 'speed' | 'budget'
 *
 * Returns { ok: boolean }.
 */
ipcMain.handle('freellmapi:set-sort-mode', async (_event, payload: unknown) => {
  // `mode` is interpolated into the sidecar URL below — allowlist it so a
  // malformed/hostile payload can't path-inject into the local API
  // (e.g. mode = "../admin/keys").
  const rawMode = (payload as { mode?: unknown } | null | undefined)?.mode
  const MODES = ['intelligence', 'speed', 'budget'] as const
  const mode = MODES.find((m) => m === rawMode)
  if (!mode) return { ok: false, error: `invalid sort mode: ${String(rawMode)}` }
  const port = getFreellmapiPort()
  if (!port) return { ok: false, error: 'freellmapi not running' }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/fallback/sort/${mode}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000) as AbortSignal,
    })
    return { ok: res.ok }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
})

export function registerFreellmapiIpc(): void {
  // Handlers registered above at module load time via ipcMain.handle().
  // This function is intentionally a no-op kept for explicit registration
  // in main.ts to make the dependency graph visible.
}
