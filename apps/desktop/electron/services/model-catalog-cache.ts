// apps/desktop/electron/services/model-catalog-cache.ts
//
// AUTO-UPDATING provider model catalogs. Two halves:
//
//   cache      every successful live /models fetch is recorded to
//              <userData>/model-catalogs/<provider>.json — pickers fall back
//              to the LAST GOOD catalog (not the frozen static list) when the
//              provider is unreachable, so "new models" survive offline.
//   refresher  a background loop (60s after boot, then every 12h) re-pulls
//              every provider that can answer (keyless ones always; keyed ones
//              when a key is stored) — newly released models appear in the
//              pickers WITHOUT the user ever opening one first. Failures are
//              silent (offline is normal); private mode skips cloud pulls.
//
// Static arrays in the renderer remain the LAST resort only (fresh install,
// nothing cached yet).

import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { retrieveKey } from './keychain'

export interface CachedCatalog {
  fetchedAt: string
  models: Array<{ id: string; label?: string }>
}

const REFRESH_MS = 12 * 60 * 60 * 1000
const BOOT_DELAY_MS = 60_000

function dir(): string {
  const d = join(app.getPath('userData'), 'model-catalogs')
  try { mkdirSync(d, { recursive: true }) } catch { /* first write surfaces it */ }
  return d
}

function fileFor(providerId: string): string {
  return join(dir(), providerId.replace(/[^a-z0-9-]/gi, '_') + '.json')
}

export function recordCatalog(providerId: string, models: Array<{ id: string; label?: string }>): void {
  if (!Array.isArray(models) || models.length === 0) return
  try {
    writeFileSync(fileFor(providerId), JSON.stringify({ fetchedAt: new Date().toISOString(), models } satisfies CachedCatalog, null, 2), 'utf8')
  } catch { /* cache is best-effort */ }
}

export function readCatalog(providerId: string): CachedCatalog | null {
  try {
    const f = fileFor(providerId)
    if (!existsSync(f)) return null
    const parsed = JSON.parse(readFileSync(f, 'utf8')) as CachedCatalog
    return Array.isArray(parsed?.models) && parsed.models.length > 0 ? parsed : null
  } catch {
    return null
  }
}

/**
 * Wrap a live catalog fetch: success → record to cache and return; failure or
 * empty → serve the last good cache (or rethrow/empty when none). The single
 * seam every list-models IPC path goes through.
 */
export async function withCatalogCache(
  providerId: string,
  fetchLive: () => Promise<Array<{ id: string; label?: string }>>,
): Promise<Array<{ id: string; label?: string }>> {
  try {
    const live = await fetchLive()
    if (live.length > 0) { recordCatalog(providerId, live); return live }
  } catch { /* fall through to cache */ }
  return readCatalog(providerId)?.models ?? []
}

// ── Background refresher ──────────────────────────────────────────────────────

/** One provider pull. Every branch is best-effort; throws are swallowed by the caller.
 *  The bankr/venice/surplus services read their own keychain keys and already
 *  cache in-memory with a `force` refresh knob — we force so a sweep really
 *  hits the network, then persist the last-good list to disk. */
async function pullOne(providerId: string): Promise<void> {
  if (providerId === 'bankr-gateway') {
    if (!retrieveKey('bankr-gateway')) return
    const { listBankrModels } = await import('./bankr-service')
    const r = await listBankrModels({ force: true })
    if (r.ok) recordCatalog('bankr-gateway', r.models.map(m => ({ id: m.id, label: m.id })))
  } else if (providerId === 'venice') {
    if (!retrieveKey('venice')) return
    const { listVeniceModels } = await import('./venice-service')
    const r = await listVeniceModels({ force: true })
    if (r.ok) recordCatalog('venice', r.models.map(m => ({ id: m.id, label: m.id })))
  } else if (providerId === 'imgnai') {
    const { listImgnaiTextModels } = await import('./imgnai-media')
    recordCatalog('imgnai', (await listImgnaiTextModels()).map(m => ({ id: m.id, label: m.label })))
  } else if (providerId === 'surplus') {
    if (!retrieveKey('surplus')) return
    const { listSurplusModels } = await import('./surplus-service')
    const r = await listSurplusModels({ force: true })
    if (r.ok) recordCatalog('surplus', r.models.map(m => ({ id: m.id, label: m.id })))
  }
}

let timer: ReturnType<typeof setInterval> | null = null

export function startCatalogRefresher(): void {
  if (timer) return
  const sweep = async () => {
    const { getCurrentPrivacyMode } = await import('../ipc/privacy.ipc')
    if (getCurrentPrivacyMode() === 'private') return // no cloud pulls in private mode
    for (const id of ['bankr-gateway', 'venice', 'imgnai', 'surplus']) {
      try { await pullOne(id) } catch { /* offline / bad key — next sweep */ }
    }
  }
  setTimeout(() => { void sweep() }, BOOT_DELAY_MS)
  timer = setInterval(() => { void sweep() }, REFRESH_MS)
}

export function stopCatalogRefresher(): void {
  if (timer) { clearInterval(timer); timer = null }
}
