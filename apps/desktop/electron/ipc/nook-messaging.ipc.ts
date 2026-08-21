// apps/desktop/electron/ipc/nook-messaging.ipc.ts
//
// Typed IPC router for nookplot messaging — inbox DMs + group channels. Thin
// Zod-validated wire surface over nook-messaging-service.ts, exposed to the
// renderer as window.tachi.nookMessaging.*. The runtime connection itself is
// owned by nook-service.ts; these handlers throw 'Connect first' if it's down.

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import * as svc from '../services/nook-messaging-service'

export const nookMessagingRouter = defineRouter('nookMessaging', {
  // ── Inbox (direct messages) ──────────────────────────────────────────────────
  inboxList: route({
    input: z.object({ unreadOnly: z.boolean().optional(), from: z.string().optional(), limit: z.number().optional() }),
    output: z.any(),
    handle: async (i) => svc.inboxList(i),
  }),
  unreadCount: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => svc.unreadCount(),
  }),
  sendDM: route({
    input: z.object({ toAddress: z.string(), content: z.string() }),
    output: z.any(),
    handle: async ({ toAddress, content }) => svc.sendDM(toAddress, content),
  }),
  markRead: route({
    input: z.object({ messageId: z.string() }),
    output: z.any(),
    handle: async ({ messageId }) => svc.markRead(messageId),
  }),

  // ── Channels (group messaging) ───────────────────────────────────────────────
  listChannels: route({
    input: z.object({ limit: z.number().optional(), isPublic: z.boolean().optional(), channelType: z.string().optional() }),
    output: z.any(),
    handle: async (i) => svc.listChannels(i),
  }),
  channelMessages: route({
    input: z.object({ channelId: z.string(), limit: z.number().optional(), before: z.string().optional() }),
    output: z.any(),
    handle: async ({ channelId, limit, before }) => svc.channelMessages(channelId, { limit, before }),
  }),
  channelMembers: route({
    input: z.object({ channelId: z.string() }),
    output: z.any(),
    handle: async ({ channelId }) => svc.channelMembers(channelId),
  }),
  sendChannel: route({
    input: z.object({ channelId: z.string(), content: z.string() }),
    output: z.any(),
    handle: async ({ channelId, content }) => svc.sendChannel(channelId, content),
  }),
  joinChannel: route({
    input: z.object({ channelId: z.string() }),
    output: z.any(),
    handle: async ({ channelId }) => svc.joinChannel(channelId),
  }),
  leaveChannel: route({
    input: z.object({ channelId: z.string() }),
    output: z.any(),
    handle: async ({ channelId }) => svc.leaveChannel(channelId),
  }),
})
