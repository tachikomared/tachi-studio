// apps/desktop/electron/ipc/openrouter.ipc.ts
//
// Typed IPC router for the OpenRouter LIVE model catalog — the surface that
// carries the PER-MODEL free signal (pricing.prompt/completion both 0 in the
// live catalog; never the `:free` id suffix, never a provider-level billing
// flip — 322 of 336 OpenRouter models are paid). Backs the chat model picker
// mounted when 'openrouter-oauth' is the active provider.
// Renderer: window.tachi.openrouter.listModels(input). Mirrors venice.ipc's
// listModels in shape.
import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { listOpenrouterModels } from '../services/openrouter-service'

export const openrouterRouter = defineRouter('openrouter', {
  listModels: route({
    input: z.object({ force: z.boolean().optional() }),
    output: z.object({
      ok:     z.boolean(),
      models: z.array(z.object({
        id: z.string(), label: z.string(),
        contextTokens: z.number().optional(),
        free: z.boolean(),
        live: z.boolean(),
        // LIVE per-model $/M rates from the same `pricing` object `free` comes
        // from. Optional: a row whose price did not parse carries none, and the
        // picker then shows no band rather than inventing one.
        rates: z.object({
          inputPerM: z.number(),
          outputPerM: z.number(),
          cacheReadPerM: z.number().optional(),
          cacheWritePerM: z.number().optional(),
        }).optional(),
      })),
      stale: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handle: async ({ force }) => listOpenrouterModels({ force }),
  }),
})
