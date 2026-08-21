// apps/desktop/electron/ipc/nook.ipc.ts
//
// Typed IPC router for the first-class nookplot integration. The heavy lifting
// (runtime connection, signing, WebSocket events) lives in nook-service.ts;
// this file is the thin, Zod-validated wire surface the renderer calls through
// window.tachi.nook.*.
//
// Live pushes (NOT request/response) are emitted by nook-service via
// webContents.send on channels "nook:status" and "nook:event"; the renderer
// subscribes through window.tachi.nook.onStatus / onEvent (wired in preload).

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { checkUrlEgress } from '../services/egress-policy'
import * as nook from '../services/nook-service'
import * as nookMcp from '../services/nook-mcp'
import * as darksolMcp from '../services/darksol-mcp'

const GATEWAY = 'https://gateway.nookplot.com'

// Generic public-read proxy (kept from the first cut): lets the UI preview
// public endpoints before the runtime is connected. Path-allowlisted so a
// compromised renderer can't turn this into an open proxy.
const SAFE_PATH = /^\/(v1\/[A-Za-z0-9/_:.\-]*(\?[A-Za-z0-9/_:.\-=&%]*)?|health)$/

export const nookRouter = defineRouter('nook', {
  // ── Generic gateway GET proxy (public reads, no connection needed) ──────────
  get: route({
    input: z.object({ path: z.string(), apiKey: z.string().optional() }),
    output: z.object({ ok: z.boolean(), status: z.number(), body: z.unknown() }),
    handle: async ({ path, apiKey }) => {
      if (!SAFE_PATH.test(path)) throw new Error(`nook: refusing to fetch unsafe path "${path}"`)
      const url = GATEWAY + path
      const egress = checkUrlEgress(url)
      if (!egress.allowed) throw new Error(egress.reason!)
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) as AbortSignal })
      const text = await res.text()
      let body: unknown = null
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { ok: res.ok, status: res.status, body }
    },
  }),

  // ── Credentials + connection ────────────────────────────────────────────────
  getStatus: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nook.getStatus(),
  }),
  configure: route({
    input: z.object({ apiKey: z.string().optional(), privateKey: z.string().optional() }),
    output: z.any(),
    handle: async (input) => nook.configure(input),
  }),
  clearCredentials: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nook.clearCredentials(),
  }),
  generateWallet: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nook.generateWallet(),
  }),
  exportKeystore: route({
    input: z.object({ password: z.string() }),
    output: z.any(),
    handle: async ({ password }) => ({ keystore: await nook.exportKeystore(password) }),
  }),
  importKeystore: route({
    input: z.object({ json: z.string(), password: z.string() }),
    output: z.any(),
    handle: async ({ json, password }) => nook.importKeystore(json, password),
  }),
  register: route({
    input: z.object({ name: z.string().optional(), description: z.string().optional() }),
    output: z.any(),
    handle: async (input) => nook.register(input),
  }),
  registerInApp: route({
    input: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      model: z.object({ provider: z.string(), name: z.string() }).optional(),
      capabilities: z.array(z.string()).optional(),
    }),
    output: z.any(),
    handle: async (input) => nook.registerInApp(input),
  }),
  connect: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nook.connect(),
  }),
  disconnect: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nook.disconnect(),
  }),
  getProfile: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nook.getProfile(),
  }),

  // ── Bounties ─────────────────────────────────────────────────────────────────
  listBounties: route({
    input: z.object({ limit: z.number().optional(), community: z.string().optional() }),
    output: z.any(),
    handle: async (input) => nook.listBounties(input),
  }),
  claimBounty: route({
    input: z.object({ id: z.string() }),
    output: z.any(),
    handle: async ({ id }) => nook.claimBounty(id),
  }),
  submitWork: route({
    input: z.object({ id: z.string(), description: z.string(), deliverables: z.array(z.string()) }),
    output: z.any(),
    handle: async ({ id, description, deliverables }) => nook.submitWork(id, description, deliverables),
  }),

  // ── Marketplace ────────────────────────────────────────────────────────────
  listListings: route({
    input: z.object({ query: z.string().optional(), limit: z.number().optional() }),
    output: z.any(),
    handle: async (input) => nook.listListings(input),
  }),

  // ── Autonomy + proactive approvals ───────────────────────────────────────────
  goOnline: route({
    input: z.object({ provider: z.string().optional(), model: z.string().optional() }),
    output: z.any(),
    handle: async ({ provider, model }) => nook.goOnline(provider, model),
  }),
  setBrain: route({
    input: z.object({ provider: z.string(), model: z.string().optional() }),
    output: z.any(),
    handle: async ({ provider, model }) => { nook.setBrain(provider, model); return nook.getBrain() },
  }),
  listBrainProviders: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nook.listBrainProviders(),
  }),
  goOffline: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nook.goOffline(),
  }),
  getApprovals: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nook.getApprovals(),
  }),
  approveAction: route({
    input: z.object({ id: z.string() }),
    output: z.any(),
    handle: async ({ id }) => nook.approveAction(id),
  }),
  rejectAction: route({
    input: z.object({ id: z.string() }),
    output: z.any(),
    handle: async ({ id }) => nook.rejectAction(id),
  }),
  getActivity: route({
    input: z.object({ limit: z.number().optional() }),
    output: z.any(),
    handle: async ({ limit }) => nook.getActivity(limit),
  }),

  // ── MCP sidecar: expose the nookplot toolset to the app's LLM agents ──────────
  mcpStatus: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => nookMcp.status(),
  }),
  mcpEnable: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => { await nookMcp.enable(); return nookMcp.status() },
  }),
  mcpDisable: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => { await nookMcp.disable(); return nookMcp.status() },
  }),

  // ── darksol MCP shim: expose the darksol harness toolset to workflows/agents ──
  darksolMcpStatus: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => darksolMcp.status(),
  }),
  darksolMcpEnable: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => { await darksolMcp.enable(); return darksolMcp.status() },
  }),
  darksolMcpDisable: route({
    input: z.object({}).strict(),
    output: z.any(),
    handle: async () => { await darksolMcp.disable(); return darksolMcp.status() },
  }),
})

/** @deprecated registerRouter(nookRouter) is called from main.ts */
export function registerNookIpc(): void { /* no-op */ }
