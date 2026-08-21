// apps/desktop/electron/ipc/surplus-media.ipc.ts
//
// Typed IPC router for the Surplus MEDIA engine (image / TTS / STT / video /
// music / embeddings). Wraps electron/services/surplus-media-service.ts with
// Zod-validated routes. Mirrors surplus.ipc.ts for style.
//
// Wire namespace "surplusMedia" → channels like "surplusMedia:generate-image".
// Renderer calls window.tachi.surplusMedia.<method>(input). This router is the
// CONTRACT that Layer B (Chat / Media tab) and Layer C (canvas nodes) import.
//
// Registration: registerRouter(surplusMediaRouter) in electron/main.ts.
// Preload bridge: preloadBridge('surplusMedia', [...]) in electron/preload.ts.
// Types mirror: apps/desktop/src/types/electron.d.ts (surplusMedia namespace).

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import {
  listMediaModels,
  modelParamSchema,
  generateImage,
  generateSpeech,
  transcribe,
  submitVideo,
  submitMusic,
  pollMediaJob,
  saveArtifact,
} from '../services/surplus-media-service'

// ── Shared schemas ──────────────────────────────────────────────────────────

const modalitySchema = z.enum(['text', 'image', 'video', 'music', 'tts', 'stt', 'embedding'])

const mediaModelSchema = z.object({
  id:       z.string(),
  label:    z.string(),
  modality: modalitySchema,
  family:   z.string().optional(),
  live:     z.boolean(),
})

const artifactSchema = z.object({
  kind:     z.enum(['image', 'audio', 'video', 'text']),
  mimeType: z.string(),
  path:     z.string().optional(),
  b64:      z.string().optional(),
  text:     z.string().optional(),
})

const jobStatusSchema = z.enum(['queued', 'processing', 'succeeded', 'failed', 'unknown'])

const paramKindSchema = z.enum(['string', 'text', 'int', 'number', 'enum', 'boolean', 'image', 'audio'])

const paramSpecSchema = z.object({
  name:        z.string(),
  label:       z.string(),
  kind:        paramKindSchema,
  default:     z.unknown().optional(),
  min:         z.number().optional(),
  max:         z.number().optional(),
  step:        z.number().optional(),
  enum:        z.array(z.string()).optional(),
  description: z.string().optional(),
  required:    z.boolean().optional(),
  advanced:    z.boolean().optional(),
})

/**
 * Arbitrary schema-driven extra params merged into the request body by the
 * engine (mergeExtraParams). z.record(z.unknown()) keeps the contract open so a
 * new ParamSpec needs NO IPC change — the renderer just sends another key.
 */
const extraParamsSchema = z.record(z.string(), z.unknown()).optional()

// ── Router ────────────────────────────────────────────────────────────────────

export const surplusMediaRouter = defineRouter('surplusMedia', {
  listModels: route({
    input: z.object({
      modality: modalitySchema.optional(),
      force:    z.boolean().optional(),
      provider: z.enum(['surplus', 'venice']).optional(),
    }),
    output: z.object({
      ok:     z.boolean(),
      models: z.array(mediaModelSchema),
      stale:  z.boolean().optional(),
      error:  z.string().optional(),
    }),
    handle: async ({ modality, force, provider }) => {
      return await listMediaModels(modality, { force, provider })
    },
  }),

  // Schema-driven controls: returns the ParamSpec[] the UI renders for a given
  // (modality, model). modality defaults to 'image' if omitted (callers always
  // pass it). Synchronous lookup wrapped in a Promise for the router contract.
  modelParams: route({
    input: z.object({
      modality: modalitySchema,
      modelId:  z.string(),
    }),
    output: z.object({ params: z.array(paramSpecSchema) }),
    handle: async ({ modality, modelId }) => {
      return { params: modelParamSchema(modality, modelId) }
    },
  }),

  generateImage: route({
    input: z.object({
      model:       z.string(),
      prompt:      z.string(),
      size:        z.string().optional(),
      n:           z.number().int().positive().optional(),
      autoSaveDir: z.string().optional(),
      provider:    z.enum(['surplus', 'venice']).optional(),
      params:      extraParamsSchema,
    }),
    output: z.object({ artifacts: z.array(artifactSchema) }),
    handle: async (input) => {
      return await generateImage(input)
    },
  }),

  generateSpeech: route({
    input: z.object({
      model:       z.string(),
      input:       z.string(),
      voice:       z.string().optional(),
      format:      z.string().optional(),
      speed:       z.number().positive().optional(),
      autoSaveDir: z.string().optional(),
      provider:    z.enum(['surplus', 'venice']).optional(),
      params:      extraParamsSchema,
    }),
    output: z.object({ artifacts: z.array(artifactSchema) }),
    handle: async (input) => {
      return await generateSpeech(input)
    },
  }),

  transcribe: route({
    input: z.object({
      model:      z.string(),
      audioPath:  z.string().optional(),
      audioBytes: z.instanceof(Uint8Array).optional(),
      fileName:   z.string().optional(),
      language:   z.string().optional(),
      prompt:     z.string().optional(),
      provider:   z.enum(['surplus', 'venice']).optional(),
      params:     extraParamsSchema,
    }),
    output: z.object({ text: z.string() }),
    handle: async (input) => {
      return await transcribe(input)
    },
  }),

  submitVideo: route({
    input: z.object({
      model:      z.string(),
      prompt:     z.string(),
      duration:   z.number().positive().optional(),
      resolution: z.string().optional(),
      params:     extraParamsSchema,
    }),
    output: z.object({ jobId: z.string() }),
    handle: async (input) => {
      return await submitVideo(input)
    },
  }),

  submitMusic: route({
    input: z.object({
      model:      z.string(),
      prompt:     z.string(),
      lyrics:     z.string().optional(),
      duration:   z.number().positive().optional(),
      resolution: z.string().optional(),
      params:     extraParamsSchema,
    }),
    output: z.object({ jobId: z.string() }),
    handle: async (input) => {
      return await submitMusic(input)
    },
  }),

  pollJob: route({
    input: z.object({ jobId: z.string() }),
    output: z.object({
      jobId:     z.string(),
      status:    jobStatusSchema,
      progress:  z.number().optional(),
      artifacts: z.array(artifactSchema).optional(),
      error:     z.string().optional(),
    }),
    handle: async ({ jobId }) => {
      return await pollMediaJob(jobId)
    },
  }),

  saveArtifact: route({
    input: z.object({
      jobId:   z.string(),
      index:   z.number().int().nonnegative(),
      destDir: z.string(),
      srcPath: z.string().optional(),
    }),
    output: z.object({ path: z.string() }),
    handle: async (input) => {
      return await saveArtifact(input)
    },
  }),
})
