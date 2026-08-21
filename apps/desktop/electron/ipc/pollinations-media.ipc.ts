// apps/desktop/electron/ipc/pollinations-media.ipc.ts
//
// Typed IPC router for the Pollinations KEYLESS image engine. Mirrors
// imgnai-media.ipc.ts in style: renderer calls window.tachi.pollinationsMedia.*,
// the service (electron/services/pollinations-media.ts) paces + fetches in MAIN
// and resolves with a downloaded-on-disk artifact. Live 'queued'/'generating'
// ticks are pushed separately on the 'pollinations:gen-progress' channel (see
// preload.ts).
//
// Registration: registerRouter(pollinationsMediaRouter) in electron/main.ts.
// Preload bridge: preloadBridge('pollinationsMedia', [...]) in electron/preload.ts.
// Types mirror: apps/desktop/src/types/electron.d.ts (pollinationsMedia namespace).

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import {
  listPollinationsModels,
  pollinationsGenerateImage,
} from '../services/pollinations-media'

const model = z.object({
  id:       z.string(),
  label:    z.string(),
  modality: z.literal('image'),
  live:     z.boolean(),
})

const artifact = z.object({
  kind:     z.literal('image'),
  mimeType: z.string(),
  path:     z.string().optional(),
  b64:      z.string().optional(),
})

export const pollinationsMediaRouter = defineRouter('pollinationsMedia', {
  // Live GET /models (["sana"]) with the static snapshot as offline fallback —
  // a keyless fresh install always gets a non-empty list.
  listModels: route({
    input:  z.object({}),
    output: z.object({ ok: z.boolean(), models: z.array(model), error: z.string().optional() }),
    handle: async () => listPollinationsModels(),
  }),

  // Image — the pacing queue (1 request / 15 s) + the long GET run in MAIN;
  // resolves with the artifact and the seed that ACTUALLY ran (rolled from -1).
  generateImage: route({
    input: z.object({
      model:       z.string(),
      prompt:      z.string(),
      size:        z.string().optional(),
      seed:        z.number().optional(),
      autoSaveDir: z.string().optional(),
    }),
    output: z.object({ artifacts: z.array(artifact), seed: z.number(), completedAfterPrivate: z.boolean() }),
    handle: async (i) => pollinationsGenerateImage(i),
  }),
})
