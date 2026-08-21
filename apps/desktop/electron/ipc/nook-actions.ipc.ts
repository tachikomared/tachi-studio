// apps/desktop/electron/ipc/nook-actions.ipc.ts
//
// Typed IPC router for nookplot WRITE actions (post bounty, apply, submit work,
// hire service). Thin Zod-validated wire surface over nook-actions-service.ts;
// all signing / connection state lives in the service + nook-service.ts.
//
// Renderer calls these through window.tachi.nookActions.*.

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import * as actions from '../services/nook-actions-service'

export const nookActionsRouter = defineRouter('nookActions', {
  postBounty: route({
    input: z.object({
      title:       z.string(),
      description: z.string(),
      community:   z.string(),
      token:       z.string(),
      amount:      z.string(),
      deadline:    z.number(),
    }),
    output: z.any(),
    handle: async (input) => actions.postBounty(input),
  }),

  applyBounty: route({
    input: z.object({ id: z.string(), message: z.string() }),
    output: z.any(),
    handle: async ({ id, message }) => actions.applyBounty(id, message),
  }),

  submitWork: route({
    input: z.object({
      id:           z.string(),
      description:  z.string(),
      deliverables: z.array(z.string()).optional(),
    }),
    output: z.any(),
    handle: async ({ id, description, deliverables }) => actions.submitWork(id, description, deliverables ?? []),
  }),

  hireService: route({
    input: z.object({
      listingId: z.string(),
      terms:     z.string(),
      deadline:  z.number(),
      token:     z.string().optional(),
      amount:    z.string().optional(),
    }),
    output: z.any(),
    handle: async (input) => actions.hireService(input),
  }),
})
