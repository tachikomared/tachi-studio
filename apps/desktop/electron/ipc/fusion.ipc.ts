// apps/desktop/electron/ipc/fusion.ipc.ts
//
// Typed IPC router for the Fusion panel's RE-RUN affordance. Lets the renderer
// retry a SINGLE panel member (model) that failed (ERR) — re-running just that
// leg over the same gateway, metering its usage to the cost ledger exactly like
// the agent's consult_panel / fuse_plan legs do.
//
// Wire namespace "fusion" → channel "fusion:rerun-member".
// Renderer calls window.tachi.fusion.rerunMember({ providerId, model, brief }).
// Registration: registerRouter(fusionRouter) in electron/main.ts.
// Preload bridge: preloadBridge('fusion', ['rerunMember']) in electron/preload.ts.
// Types mirror: apps/desktop/src/types/electron.d.ts (fusion namespace).

import { z } from 'zod'
import { rerunFusionMember } from '@tachi/core'
import { defineRouter, route } from '../ipc-router/router'
import { getChatBackend } from '../services/provider-service'
import { getCostLedger } from '../services/cost-ledger'

/** Result returned to the renderer for a single re-run leg. */
export interface RerunMemberResult {
  ok:     boolean
  chars:  number
  error?: string
}

/**
 * Core re-run logic, decoupled from electron so it's unit-testable. Resolves a
 * backend for `providerId`, re-runs `model` with `brief` as a single user
 * message, and meters usage to the cost ledger under THE GATEWAY THAT SERVED IT
 * — `resolved.providerId`, the canonical registry id getChatBackend already
 * decided on. Dependencies are injected with real defaults so tests can pass
 * mocks.
 *
 * It used to record the literal 'tachi'. The harness is not a billing entity:
 * no registry entry carries that id, so the ledger's local/free check could
 * never match it and the dashboard grew a phantom 'tachi' provider row for
 * spend that belonged to Bankr/Venice/Surplus. Fixed the same way
 * tachi/loop.ts was in 64c837d — record the identity the resolver returned,
 * never a name derived from the caller's argument or the model.
 */
export async function rerunMember(
  input: { providerId: string; model: string; brief: string },
  deps: {
    resolveBackend?: typeof getChatBackend
    ledger?:         () => { record: (provider: string, model: string, promptTokens: number, completionTokens: number) => unknown }
  } = {},
): Promise<RerunMemberResult> {
  const resolveBackend = deps.resolveBackend ?? getChatBackend
  const resolved = resolveBackend(input.providerId)
  if (!resolved) return { ok: false, chars: 0, error: 'Provider unavailable: unknown gateway.' }
  if (!resolved.key) return { ok: false, chars: 0, error: 'Provider unavailable: no API key for the active gateway.' }

  const ledger = (deps.ledger ?? getCostLedger)()
  return rerunFusionMember({
    backend: resolved.backend,
    key:     resolved.key,
    model:   input.model,
    brief:   input.brief,
    meter:   (usage) => { try { ledger.record(resolved.providerId, input.model, usage.promptTokens, usage.completionTokens) } catch { /* best-effort */ } },
  })
}

// ── Router definition ─────────────────────────────────────────────────────────

export const fusionRouter = defineRouter('fusion', {
  rerunMember: route({
    input: z.object({
      providerId: z.string().min(1),
      model:      z.string().min(1),
      brief:      z.string().min(1),
    }),
    output: z.object({
      ok:    z.boolean(),
      chars: z.number(),
      error: z.string().optional(),
    }),
    handle: async ({ providerId, model, brief }) => {
      return await rerunMember({ providerId, model, brief })
    },
  }),
})
