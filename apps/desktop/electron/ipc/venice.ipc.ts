// apps/desktop/electron/ipc/venice.ipc.ts
//
// Typed IPC router for the STANDALONE Venice provider (NOT Surplus). Two areas:
//   - text catalog for the chat/agent/node model pickers (listModels)
//   - Venice's own MEDIA engine: image / tts / stt / video / music
// Renderer: window.tachi.venice.<method>(input). Mirrors surplus.ipc /
// surplus-media.ipc but talks to api.venice.ai directly on the Venice key.
import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { listVeniceModels } from '../services/venice-service'
import {
  listVeniceMediaModels,
  veniceGenerateImage,
  veniceSpeech,
  veniceTranscribe,
  veniceSubmitVideo,
  veniceSubmitMusic,
} from '../services/venice-media-service'

const mediaModality = z.enum(['image', 'tts', 'stt', 'video', 'music'])
const mediaModel = z.object({
  id: z.string(), label: z.string(), modality: mediaModality, live: z.boolean(),
})
const artifact = z.object({
  kind:     z.enum(['image', 'audio', 'video', 'text']),
  mimeType: z.string(),
  path:     z.string().optional(),
  b64:      z.string().optional(),
  text:     z.string().optional(),
})
const extra = z.record(z.string(), z.unknown()).optional()

export const veniceRouter = defineRouter('venice', {
  // Text catalog — chat / agent / node model pickers.
  listModels: route({
    input: z.object({ force: z.boolean().optional() }),
    output: z.object({
      ok:     z.boolean(),
      models: z.array(z.object({
        id: z.string(), label: z.string(), family: z.string().optional(), live: z.boolean(),
        vision: z.boolean().optional(),
        caps: z.array(z.string()).optional(),
        // Venice's own window and rates. Declared so the bridge's TYPE matches
        // what main has actually been sending — the router validates input
        // only, so these crossed at runtime while the contract stayed silent
        // about them.
        contextTokens: z.number().optional(),
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
    handle: async ({ force }) => listVeniceModels({ force }),
  }),

  // Media catalog — image / tts / asr(stt) / video / music.
  listMediaModels: route({
    input: z.object({ modality: mediaModality, force: z.boolean().optional() }),
    output: z.object({ ok: z.boolean(), models: z.array(mediaModel), error: z.string().optional() }),
    handle: async ({ modality, force }) => listVeniceMediaModels(modality, { force }),
  }),

  generateImage: route({
    input: z.object({
      model: z.string(), prompt: z.string(),
      size: z.string().optional(), n: z.number().int().positive().optional(), params: extra,
    }),
    output: z.object({ artifacts: z.array(artifact) }),
    handle: async (i) => veniceGenerateImage(i),
  }),

  generateSpeech: route({
    input: z.object({
      model: z.string(), input: z.string(),
      voice: z.string().optional(), format: z.string().optional(),
      speed: z.number().positive().optional(), params: extra,
    }),
    output: z.object({ artifacts: z.array(artifact) }),
    handle: async (i) => veniceSpeech(i),
  }),

  transcribe: route({
    input: z.object({
      model: z.string(),
      audioBytes: z.instanceof(Uint8Array).optional(),
      audioPath: z.string().optional(),
      fileName: z.string().optional(),
      language: z.string().optional(),
      prompt: z.string().optional(),
    }),
    output: z.object({ text: z.string() }),
    handle: async (i) => veniceTranscribe(i),
  }),

  // Video — queues + polls Venice's queue API server-side; resolves when ready.
  generateVideo: route({
    input: z.object({
      model: z.string(), prompt: z.string(),
      negativePrompt: z.string().optional(), duration: z.string().optional(), params: extra,
    }),
    output: z.object({ artifacts: z.array(artifact) }),
    handle: async (i) => veniceSubmitVideo(i),
  }),

  // Music — same queue/poll lifecycle as video.
  generateMusic: route({
    input: z.object({
      model: z.string(), prompt: z.string(),
      lyrics: z.string().optional(), durationSeconds: z.number().positive().optional(), params: extra,
    }),
    output: z.object({ artifacts: z.array(artifact) }),
    handle: async (i) => veniceSubmitMusic(i),
  }),
})
