// apps/desktop/electron/ipc/model-catalog.ipc.ts
//
// Plain ipcMain.handle wiring for the unified model catalog. Mirrors the
// style of ollama.ipc.ts / llama-cpp.ipc.ts (no typed router).
//
// This registrar also owns the Civitai handlers (registerCivitaiIpc). That is
// deliberate: main.ts's static import graph is the thing R8b's startup budget
// is measured against, so a new source tab in the SAME catalog surface hangs
// off the SAME registrar instead of adding an import to main.ts.
// test/unit/civitaiIpcWiring.test.ts pins both halves of that.

import { ipcMain } from 'electron'
import { detectHardware } from '../services/hardware-info'
import { buildCuratedCatalog, listInstalledModels } from '../services/catalog-service'
import { searchHuggingFace, validateHfToken } from '../services/hf-search'
import { enforceProviderEgress } from '../services/egress-policy'
import { registerCivitaiIpc } from './civitai.ipc'

export function registerModelCatalogIpc(): void {
  ipcMain.handle('catalog:hardware', async () => {
    return await detectHardware()
  })

  ipcMain.handle('catalog:curated', () => {
    return { ok: true as const, entries: buildCuratedCatalog() }
  })

  ipcMain.handle('catalog:installed', async () => {
    return { ok: true as const, models: await listInstalledModels() }
  })

  ipcMain.handle('catalog:search-hf', async (_event, payload: unknown) => {
    const { query } = (payload as { query?: string } | null | undefined) ?? {}
    if (!query) return { ok: false as const, error: 'query is required', entries: [] }
    try {
      // Belt AND braces with hf-search.ts's own gate: the handler is the IPC
      // boundary the renderer can reach directly, so it refuses here too rather
      // than depending on a service-layer line staying put.
      enforceProviderEgress('huggingface')
      return { ok: true as const, entries: await searchHuggingFace(query) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err), entries: [] }
    }
  })

  /**
   * hf:validate-token — the Settings card's "is this token live, and WHOSE?"
   * ping.
   *
   * Takes the TYPED token so the card can refuse to store a rejected one; the
   * answer carries only the account NAME, never the token back. Resolves
   * (never rejects) so a settings card renders a failure instead of catching.
   */
  ipcMain.handle('hf:validate-token', async (_event, payload: unknown) => {
    const { token } = (payload as { token?: unknown } | null | undefined) ?? {}
    if (typeof token !== 'string') return { ok: false as const }
    return await validateHfToken(token)
  })

  // civitai:search / civitai:install — same catalog surface, different source.
  registerCivitaiIpc()
}
