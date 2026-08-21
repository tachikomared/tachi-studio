// apps/desktop/electron/ipc/model-storage.ipc.ts
//
// Storage dashboard + weight relocation IPC (USER-PAINS T5+T6). Surfaces the
// per-engine disk usage, one-click REMOVE, and the "Move models to storage
// root" relocation (with live progress events) to Settings → Model Weights.

import { ipcMain, type BrowserWindow } from 'electron'
import {
  getStorageUsage, removeModelItem, migrateEngine, migrateEngines,
  abortModelMigration, isEngineMigrating, invalidateUsageCache,
} from '../services/model-storage'
import { scanStagingInventory, reclaimStaging } from '../services/staging-inventory'
import { MODEL_ENGINE_IDS, type ModelEngineId } from '../services/util/model-storage'

function asEngine(v: unknown): ModelEngineId | null {
  return typeof v === 'string' && (MODEL_ENGINE_IDS as readonly string[]).includes(v)
    ? (v as ModelEngineId)
    : null
}

export function registerModelStorageIpc(win: BrowserWindow): void {
  /** model-storage:usage — per-engine sizes + totals + disk (30 s cached; pass
   *  { force:true } to bypass the cache after a remove/move). */
  ipcMain.handle('model-storage:usage', (_e, payload: unknown) => {
    const force = !!(payload && typeof payload === 'object' && (payload as { force?: boolean }).force)
    return getStorageUsage(force)
  })

  /** model-storage:remove — delete one model from both roots. */
  ipcMain.handle('model-storage:remove', (_e, payload: unknown) => {
    const p = (payload ?? {}) as { engine?: unknown; id?: unknown }
    const engine = asEngine(p.engine)
    const id = typeof p.id === 'string' ? p.id : ''
    if (!engine || !id) return { ok: false, error: 'Invalid engine or model id.' }
    return removeModelItem(engine, id)
  })

  /** model-storage:migrate — relocate one engine (or all with legacy weights)
   *  to the storage root. Pushes 'model-storage:migrate-progress' events. */
  ipcMain.handle('model-storage:migrate', async (_e, payload: unknown) => {
    const p = (payload ?? {}) as { engine?: unknown }
    const engine = asEngine(p.engine)
    if (engine) {
      const r = await migrateEngine(engine, win)
      return { ok: r.ok, results: [r] }
    }
    // No engine → move every engine that still has legacy weights.
    const usage = getStorageUsage(true)
    const engines = usage.engines.filter(e => e.hasLegacy).map(e => e.engine)
    const results = await migrateEngines(engines, win)
    return { ok: results.every(r => r.ok || r.skipped), results }
  })

  /** model-storage:migrate-abort — request an in-flight move to stop. */
  ipcMain.handle('model-storage:migrate-abort', (_e, payload: unknown) => {
    const p = (payload ?? {}) as { engine?: unknown }
    const engine = asEngine(p.engine)
    if (engine) { abortModelMigration(engine); return { ok: true } }
    for (const e of MODEL_ENGINE_IDS) abortModelMigration(e)
    return { ok: true }
  })

  /** model-storage:staging — leftover download staging the usage walk cannot
   *  see (it counts model ITEMS; a `.tmp` is not a model). Never cached: the
   *  offer is only safe for as long as the scan is fresh. */
  ipcMain.handle('model-storage:staging', () => scanStagingInventory())

  /** model-storage:reclaim-staging — delete named staging files. The paths are
   *  a REQUEST: reclaimStaging re-scans and refuses anything the fresh offer
   *  does not contain, so the renderer cannot name a file of its choosing. */
  ipcMain.handle('model-storage:reclaim-staging', (_e, payload: unknown) => {
    const raw = (payload as { paths?: unknown } | null)?.paths
    const paths = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
    if (paths.length === 0) return { freedBytes: 0, removed: [], failed: [], refused: [] }
    const res = reclaimStaging(paths)
    // Freeing space changes the disk bars the dashboard prints beside it.
    if (res.removed.length > 0) invalidateUsageCache()
    return res
  })

  /** model-storage:is-migrating — quick guard for the UI. */
  ipcMain.handle('model-storage:is-migrating', (_e, payload: unknown) => {
    const engine = asEngine((payload as { engine?: unknown } | null)?.engine)
    if (engine) return { migrating: isEngineMigrating(engine) }
    return { migrating: MODEL_ENGINE_IDS.some(isEngineMigrating) }
  })
}
