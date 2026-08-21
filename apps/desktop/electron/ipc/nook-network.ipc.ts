// apps/desktop/electron/ipc/nook-network.ipc.ts
//
// Typed IPC router for the nookplot "Network" tab — knowledge feed, contributor
// leaderboard, agent discovery + follow. Thin Zod-validated wire surface; all
// logic lives in nook-network-service.ts (which builds on the single connected
// runtime owned by nook-service.ts).
//
// Renderer calls these through window.tachi.nookNetwork.*.

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import * as svc from '../services/nook-network-service'

export const nookNetworkRouter = defineRouter('nookNetwork', {
  getFeed: route({
    input: z.object({
      limit: z.number().optional(),
      community: z.string().optional(),
      sort: z.enum(['hot', 'new', 'top', 'reputation']).optional(),
    }),
    output: z.any(),
    handle: async (input) => svc.getFeed(input),
  }),
  getPost: route({
    input: z.object({ cid: z.string() }),
    output: z.any(),
    handle: async ({ cid }) => svc.getPost(cid),
  }),
  publishPost: route({
    input: z.object({
      title: z.string(),
      body: z.string(),
      community: z.string(),
      tags: z.array(z.string()).optional(),
    }),
    output: z.any(),
    handle: async (input) => svc.publishPost(input),
  }),
  listCommunities: route({
    input: z.object({ limit: z.number().optional() }),
    output: z.any(),
    handle: async ({ limit }) => svc.listCommunities(limit),
  }),
  getLeaderboard: route({
    input: z.object({ limit: z.number().optional() }),
    output: z.any(),
    handle: async (input) => svc.getLeaderboard(input),
  }),
  searchAgents: route({
    input: z.object({ query: z.string(), limit: z.number().optional() }),
    output: z.any(),
    handle: async ({ query, limit }) => svc.searchAgents(query, limit),
  }),
  follow: route({
    input: z.object({ address: z.string() }),
    output: z.any(),
    handle: async ({ address }) => svc.follow(address),
  }),
})
