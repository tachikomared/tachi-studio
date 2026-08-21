// apps/desktop/src/pages/nodes/templates/promptToImage.ts
//
// Prompt → Image — a free text model authors a vivid image prompt, wired into
// an Image node's typed `prompt` plug. Authoring is free; the image generation
// itself needs a funded Surplus key (or the local sd.cpp provider).
// Mirror: examples/flows/prompt-to-image.tachiflow.json.

import type { FlowTemplate } from './tachiflow'

export const promptToImage: FlowTemplate = {
  id: 'prompt-to-image',
  label: 'Prompt → Image',
  description: 'A free text model writes a vivid image prompt, then feeds an Image node. Type your idea and run.',
  file: {
    format: 'tachiflow',
    formatVersion: 1,
    app: 'tachi-studio',
    appVersion: '0.1.0',
    exportedAt: '2026-07-11T00:00:00.000Z',
    flow: {
      version: 1,
      name: 'Prompt to Image',
      savedAt: '2026-07-11T00:00:00.000Z',
      nodes: [
        {
          id: 'p2i-writer',
          type: 'prompt',
          position: { x: 60, y: 160 },
          data: {
            label: 'Prompt writer',
            providerId: 'freellmapi',
            endpoint: 'localhost:8080',
            model: 'auto',
            instruction: 'You are a prompt engineer for an IMAGE generator. Take the user\'s idea and write ONE vivid, concrete image prompt: subject, composition, lighting, lens, mood, and style. Output ONLY the prompt — no preamble.',
          },
        },
        {
          id: 'p2i-image',
          type: 'media',
          position: { x: 460, y: 120 },
          data: { label: 'Image', modality: 'image', prompt: '', params: {} },
        },
      ],
      edges: [
        { id: 'p2i-e1', source: 'p2i-writer', target: 'p2i-image', sourceHandle: 'E-src', targetHandle: 'prompt', type: 'link', data: {} },
      ],
    },
  },
}
