// apps/desktop/electron/ipc/surplus.ipc.ts
//
// Typed IPC router for Surplus Intelligence's model catalog. Wire channel
// "surplus:list-models" — the renderer call window.tachi.surplus.listModels(opts)
// fetches the live catalog (or curated fallback). Mirrors bankr.ipc.ts.

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { listSurplusModels } from '../services/surplus-service'

export const surplusRouter = defineRouter('surplus', {
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
      return await listSurplusModels({ force })
    },
  }),
})
