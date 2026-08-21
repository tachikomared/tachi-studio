// apps/desktop/electron/ipc/imgnai-media.ipc.ts
//
// Typed IPC router for the imgnAI Katana MEDIA engine (image + video).
// Mirrors venice.ipc.ts in style: renderer calls window.tachi.imgnaiMedia.*,
// the service (electron/services/imgnai-media.ts) submits + polls in MAIN and
// resolves with downloaded-on-disk artifacts. Live progress is pushed
// separately on the 'imgnai:gen-progress' channel (see preload.ts).
//
// Registration: registerRouter(imgnaiMediaRouter) in electron/main.ts.
// Preload bridge: preloadBridge('imgnaiMedia', [...]) in electron/preload.ts.
// Types mirror: apps/desktop/src/types/electron.d.ts (imgnaiMedia namespace).

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import {
  listImgnaiMediaModels,
  imgnaiGenerateImage,
  imgnaiGenerateVideo,
} from '../services/imgnai-media'

const modality = z.enum(['image', 'video'])

const model = z.object({
  id:       z.string(),
  label:    z.string(),
  modality,
  live:     z.boolean(),
  durationSeconds: z.number().optional(),
})

const artifact = z.object({
  kind:     z.enum(['image', 'audio', 'video', 'text']),
  mimeType: z.string(),
  path:     z.string().optional(),
  b64:      z.string().optional(),
  text:     z.string().optional(),
})

export const imgnaiMediaRouter = defineRouter('imgnaiMedia', {
  // Static catalog (llms.txt) enriched best-effort from GET /v1/models.
  listModels: route({
    input:  z.object({ modality }),
    output: z.object({ ok: z.boolean(), models: z.array(model), error: z.string().optional() }),
    handle: async ({ modality: m }) => listImgnaiMediaModels(m),
  }),

  // Image — submit + poll (≤600s) happen in MAIN; resolves with artifacts.
  generateImage: route({
    input: z.object({
      model:        z.string(),
      prompt:       z.string(),
      aspectRatio:  z.string().optional(),
      outputFormat: z.string().optional(),
      imageUrls:    z.array(z.string()).optional(),
      isUhd:        z.boolean().optional(),
      isFast:       z.boolean().optional(),
      autoSaveDir:  z.string().optional(),
    }),
    output: z.object({ artifacts: z.array(artifact) }),
    handle: async (i) => imgnaiGenerateImage(i),
  }),

  // Video — submit + poll (≤6000s) happen in MAIN; resolves with artifacts.
  generateVideo: route({
    input: z.object({
      model:               z.string(),
      prompt:              z.string(),
      durationSeconds:     z.number().positive().optional(),
      aspectRatio:         z.string().optional(),
      firstFrameImageUrl:  z.string().optional(),
      autoSaveDir:         z.string().optional(),
    }),
    output: z.object({ artifacts: z.array(artifact) }),
    handle: async (i) => imgnaiGenerateVideo(i),
  }),
})
