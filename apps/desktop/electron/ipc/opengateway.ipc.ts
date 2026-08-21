// apps/desktop/electron/ipc/opengateway.ipc.ts
//
// Typed IPC for OpenGateway's LIVE model catalog. Mirrors openrouter.ipc in
// shape, and carries two fields OpenRouter's does not:
//
//   · `promo.endsAt` — the gateway's OWN expiry date for a free-launch window.
//     pricing.ts::VERIFIED_FREE_MODELS hand-maintains the same dates (they
//     agreed exactly on 2026-08-02), so surfacing the source lets the two be
//     compared instead of drifting.
//   · `aliases` — recorded because the gateway publishes them, and never priced
//     from: `tencent/hy3` is PAID and ships the alias `tencent/hy3:free`.
//
// IMPORTING THIS FILE IS ALSO WHAT REGISTERS THE LIVE RATE RESOLVER, exactly as
// it is for OpenRouter: the service registers on module evaluation, and main.ts
// statically imports this router, so the ledger can price an OpenGateway run
// from the gateway's own numbers from boot onwards.
import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { listOpengatewayModels } from '../services/opengateway-service'

export const opengatewayRouter = defineRouter('opengateway', {
  listModels: route({
    input: z.object({ force: z.boolean().optional() }),
    output: z.object({
      ok: z.boolean(),
      models: z.array(z.object({
        id: z.string(),
        label: z.string(),
        contextTokens: z.number().optional(),
        free: z.boolean(),
        live: z.boolean(),
        rates: z.object({
          inputPerM: z.number(),
          outputPerM: z.number(),
          cacheReadPerM: z.number().optional(),
          cacheWritePerM: z.number().optional(),
        }).optional(),
        promo: z.object({
          endsAt: z.string(),
          note: z.string().optional(),
        }).optional(),
        aliases: z.array(z.string()).optional(),
      })),
      stale: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handle: async ({ force }) => listOpengatewayModels({ force }),
  }),
})
