// apps/desktop/electron/ipc/agent-runtime.ipc.ts
//
// Sprint C2: typed IPC router for the main-process agent-runtime store.
//
// Exposes request/response routes (via the C1 router) for reading and mutating
// the main-side AgentRuntimeStore. Push events (state-changed) are broadcast
// directly from the store on every mutation — they do NOT go through the router
// because the router only covers ipcMain.handle (request/response).
//
// Routes:
//   agent-runtime:get-state   → returns the current snapshot
//   agent-runtime:set-status  → { status }
//   agent-runtime:set-harness → { harness }
//   agent-runtime:set-provider → { provider, bankrModel? }
//
// Push channel (NOT a router route):
//   agent-runtime:state-changed → snapshot fired on every mutation, to ALL windows

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import {
  agentRuntimeStore,
  getSnapshot,
  AGENT_RUNTIME_HARNESSES,
  type AgentRuntimeSnapshot,
} from '../store/agent-runtime.store'

// ── Zod schemas ───────────────────────────────────────────────────────────────

const statusSchema   = z.enum(['idle', 'starting', 'running', 'done', 'error'])
// Derived from the store so the wire schema can never drift from the type.
// 'goose'/'both' are gone; the store is not persisted, so nothing legacy is parsed here.
const harnessSchema  = z.enum(AGENT_RUNTIME_HARNESSES)
const providerSchema = z.enum(['default', 'opengateway', 'bankr', 'surplus', 'venice', 'imgnai'])

const snapshotSchema = z.object({
  sessionId:  z.string().nullable(),
  workingDir: z.string().nullable(),
  status:     statusSchema,
  harness:    harnessSchema,
  provider:   providerSchema,
  bankrModel: z.string(),
})

// ── Router definition ─────────────────────────────────────────────────────────

export const agentRuntimeRouter = defineRouter('agent-runtime', {

  /** Return the current main-side store snapshot. */
  getState: route({
    input:  z.object({}),
    output: snapshotSchema,
    handle: async (): Promise<AgentRuntimeSnapshot> => {
      return getSnapshot(agentRuntimeStore.getState())
    },
  }),

  /** Update agent lifecycle status. */
  setStatus: route({
    input:  z.object({ status: statusSchema }),
    output: snapshotSchema,
    handle: async ({ status }) => {
      agentRuntimeStore.getState().setStatus(status)
      return getSnapshot(agentRuntimeStore.getState())
    },
  }),

  /** Update the active harness. */
  setHarness: route({
    input:  z.object({ harness: harnessSchema }),
    output: snapshotSchema,
    handle: async ({ harness }) => {
      agentRuntimeStore.getState().setHarness(harness)
      return getSnapshot(agentRuntimeStore.getState())
    },
  }),

  /** Update the LLM provider (and optionally the Bankr model). */
  setProvider: route({
    input:  z.object({ provider: providerSchema, bankrModel: z.string().optional() }),
    output: snapshotSchema,
    handle: async ({ provider, bankrModel }) => {
      agentRuntimeStore.getState().setProvider(provider, bankrModel)
      return getSnapshot(agentRuntimeStore.getState())
    },
  }),
})
