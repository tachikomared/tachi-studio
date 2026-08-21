// apps/desktop/electron/ipc/bankr.ipc.ts
//
// Migrated to the typed IPC router (Sprint C1).
// Wire channel "bankr:list-models" is UNCHANGED — the renderer call
// window.tachi.bankr.listModels(opts) continues to work identically.
//
// Legacy registerBankrIpc() kept as a no-op shim for incremental main.ts migration.

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { listBankrModels } from '../services/bankr-service'

// ── Router definition ─────────────────────────────────────────────────────────

export const bankrRouter = defineRouter('bankr', {
  listModels: route({
    input: z.object({ force: z.boolean().optional() }),
    output: z.object({
      ok:     z.boolean(),
      models: z.array(z.object({
        id:     z.string(),
        label:  z.string(),
        family: z.string().optional(),
        live:   z.boolean(),
      })),
      stale: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handle: async ({ force }) => {
      return await listBankrModels({ force })
    },
  }),
})

// ── Legacy shim ───────────────────────────────────────────────────────────────
/** @deprecated Use registerRouter(bankrRouter) from ipc-router/router instead. */
export function registerBankrIpc(): void {
  // No-op: registerRouter(bankrRouter) is called from main.ts
}
