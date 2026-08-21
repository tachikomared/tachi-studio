// apps/desktop/electron/ipc/nook-mining.ipc.ts
//
// Typed IPC for the real Mining tab (nook-mining-service.ts). Reads are public;
// solve/loop actions consume inference credits (gated in the UI).

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import * as svc from '../services/nook-mining-service'

export const nookMiningRouter = defineRouter('nookMining', {
  getTrackStats: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => svc.getTrackStats(),
  }),
  listChallenges: route({
    input: z.object({ limit: z.number().optional() }),
    output: z.any(),
    handle: async (input) => svc.listChallenges(input),
  }),
  getRewards: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => svc.getRewards(),
  }),
  solveOnce: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => svc.solveOnce(),
  }),
  startLoop: route({
    input: z.object({ maxCredits: z.number().optional() }),
    output: z.any(),
    handle: async (input) => svc.startLoop(input),
  }),
  stopLoop: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => svc.stopLoop(),
  }),
  stats: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => svc.miningStats(),
  }),
})
