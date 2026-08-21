// apps/desktop/electron/ipc/memory-facts.ipc.ts
//
// Typed IPC router for the structured memory fact store (USER-PAINS T16).
// Mirrors the session-memory.ipc.ts router shape.
//
// Routes (channel = namespace : kebab(key)):
//   memory-facts:list      {}                          → MemoryFact[]
//   memory-facts:add       { text, source? }           → MemoryFact | null
//   memory-facts:edit      { id, text }                → MemoryFact | null
//   memory-facts:delete    { id }                      → { deleted: boolean }
//   memory-facts:toggle    { id, enabled }             → MemoryFact | null
//   memory-facts:preview   {}                          → { text, chars, overBudget, limit }

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { getMemoryFactsStore } from '../services/memory-facts-service'
import { factsBudget, type MemoryFact } from '@tachi/core'

const MemoryFactSchema = z.object({
  id:        z.string(),
  text:      z.string(),
  source:    z.enum(['user', 'auto']),
  createdAt: z.string(),
  enabled:   z.boolean(),
})

export const memoryFactsRouter = defineRouter('memory-facts', {

  /** All facts, in stored order. */
  list: route({
    input:  z.object({}),
    output: z.array(MemoryFactSchema),
    handle: async (): Promise<MemoryFact[]> => getMemoryFactsStore().list(),
  }),

  /** Append a new fact. `source` defaults to 'user' (auto-capture passes 'auto'). */
  add: route({
    input:  z.object({ text: z.string().min(1).max(2000), source: z.enum(['user', 'auto']).optional() }),
    output: MemoryFactSchema.nullable(),
    handle: async ({ text, source }): Promise<MemoryFact | null> =>
      getMemoryFactsStore().add(text, source ?? 'user'),
  }),

  /** Replace a fact's text. */
  edit: route({
    input:  z.object({ id: z.string().min(1), text: z.string().min(1).max(2000) }),
    output: MemoryFactSchema.nullable(),
    handle: async ({ id, text }): Promise<MemoryFact | null> =>
      getMemoryFactsStore().edit(id, text),
  }),

  /** Delete a fact. */
  delete: route({
    input:  z.object({ id: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
    handle: async ({ id }): Promise<{ deleted: boolean }> =>
      ({ deleted: getMemoryFactsStore().delete(id) }),
  }),

  /** Enable / disable a fact. */
  toggle: route({
    input:  z.object({ id: z.string().min(1), enabled: z.boolean() }),
    output: MemoryFactSchema.nullable(),
    handle: async ({ id, enabled }): Promise<MemoryFact | null> =>
      getMemoryFactsStore().toggle(id, enabled),
  }),

  /** "What the model sees": joined enabled facts + budget accounting. */
  preview: route({
    input:  z.object({}),
    output: z.object({
      text:       z.string(),
      chars:      z.number(),
      overBudget: z.boolean(),
      limit:      z.number(),
    }),
    handle: async (): Promise<{ text: string; chars: number; overBudget: boolean; limit: number }> => {
      const store = getMemoryFactsStore()
      const text = store.injection()
      const b = factsBudget(store.list())
      return { text, chars: b.chars, overBudget: b.overBudget, limit: b.limit }
    },
  }),

})
