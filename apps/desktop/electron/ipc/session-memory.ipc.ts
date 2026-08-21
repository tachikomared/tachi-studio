// apps/desktop/electron/ipc/session-memory.ipc.ts
//
// agent-session-memory — typed IPC router for cross-run session memory (ECC).
//
// Persists a compact session summary keyed by WORKSPACE PATH and loads the most
// recent one on a later agent start so the harness can inject it as
// "HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS" context.
//
// Mirrors the checkpoints.ipc.ts typed-router shape exactly.
//
// Routes (channel name = namespace : kebab(key)):
//   session-memory:save             { workspacePath, lastTask, ... } → SessionSummary
//   session-memory:load             { workspacePath }                → SessionSummary | null
//   session-memory:build-context    { workspacePath }                → { context: string }
//   session-memory:list             {}                               → SessionSummaryMeta[]
//   session-memory:delete           { workspacePath }                → { deleted: boolean }

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import {
  saveSummary,
  loadSummary,
  buildHistoricalContext,
  listSummaries,
  deleteSummary,
} from '../services/session-memory-service'
import type { SessionSummary, SessionSummaryMeta } from '../services/session-memory-service'

// ── Zod schemas ───────────────────────────────────────────────────────────────

const SessionSummarySchema = z.object({
  workspacePath: z.string(),
  lastTask:      z.string(),
  keyDecisions:  z.array(z.string()),
  filesChanged:  z.array(z.string()),
  timestamp:     z.string(),
  notes:         z.string().optional(),
})

const SessionSummaryMetaSchema = z.object({
  workspacePath: z.string(),
  lastTask:      z.string(),
  timestamp:     z.string(),
})

// ── Router ────────────────────────────────────────────────────────────────────

export const sessionMemoryRouter = defineRouter('session-memory', {

  /**
   * Persist (overwrite) the session summary for a workspace path.
   * Called on agent stop. The timestamp is stamped server-side.
   */
  save: route({
    input: z.object({
      workspacePath: z.string().min(1),
      lastTask:      z.string().min(1),
      keyDecisions:  z.array(z.string()).optional(),
      filesChanged:  z.array(z.string()).optional(),
      notes:         z.string().optional(),
    }),
    output: SessionSummarySchema,
    handle: async (input): Promise<SessionSummary> => {
      return saveSummary(input)
    },
  }),

  /**
   * Load the most recent session summary for a workspace path.
   * Returns null when none exists.
   */
  load: route({
    input:  z.object({ workspacePath: z.string().min(1) }),
    output: SessionSummarySchema.nullable(),
    handle: async ({ workspacePath }): Promise<SessionSummary | null> => {
      return loadSummary(workspacePath)
    },
  }),

  /**
   * Build the ready-to-prepend "HISTORICAL REFERENCE ONLY" context block for a
   * workspace path. Returns an empty string when there is nothing to inject.
   */
  buildContext: route({
    input:  z.object({ workspacePath: z.string().min(1) }),
    output: z.object({ context: z.string() }),
    handle: async ({ workspacePath }): Promise<{ context: string }> => {
      return { context: buildHistoricalContext(loadSummary(workspacePath)) }
    },
  }),

  /**
   * List all persisted session summaries, newest first.
   */
  list: route({
    input:  z.object({}),
    output: z.array(SessionSummaryMetaSchema),
    handle: async (): Promise<SessionSummaryMeta[]> => {
      return listSummaries()
    },
  }),

  /**
   * Delete the persisted summary for a workspace path.
   */
  delete: route({
    input:  z.object({ workspacePath: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
    handle: async ({ workspacePath }): Promise<{ deleted: boolean }> => {
      return { deleted: deleteSummary(workspacePath) }
    },
  }),

})

/**
 * @deprecated Use registerRouter(sessionMemoryRouter) instead.
 * No-op shim — kept for structural consistency with other IPC modules.
 */
export function registerSessionMemoryIpc(): void { /* no-op */ }
