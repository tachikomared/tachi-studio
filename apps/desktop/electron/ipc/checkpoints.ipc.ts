// apps/desktop/electron/ipc/checkpoints.ipc.ts
//
// Sprint C3 — typed IPC router for checkpoint read/list/delete operations.
//
// The WRITE path is intentionally internal — recordCheckpoint() is called
// directly from agent.ipc.ts inside pushEventWithNotify, no IPC round-trip
// needed. Only the read/management operations are exposed to the renderer.
//
// Routes:
//   checkpoints:load-checkpoint  { sessionId } → Turn[]
//   checkpoints:list-checkpoints {}            → CheckpointMeta[]
//   checkpoints:delete-checkpoint{ sessionId } → { deleted: boolean }

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import {
  loadCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
} from '../services/sidecar-checkpoints'
import type { CheckpointMeta } from '../services/sidecar-checkpoints'
import type { PlaybookTurn } from '../services/playbook-service'
import {
  createWorkspaceCheckpoint,
  listWorkspaceCheckpoints,
  restoreWorkspaceCheckpoint,
  deleteWorkspaceCheckpoint,
} from '../services/workspace-checkpoint'

// ── Zod schemas ───────────────────────────────────────────────────────────────

const TurnSchema = z.object({
  role:    z.enum(['user', 'assistant', 'tool-call', 'tool-result']),
  content: z.string(),
  name:    z.string().optional(),
  ts:      z.number(),
})

const CheckpointMetaSchema = z.object({
  sessionId: z.string(),
  sizeBytes: z.number(),
  updatedAt: z.string(),
})

// ── Router ────────────────────────────────────────────────────────────────────

export const checkpointsRouter = defineRouter('checkpoints', {

  /**
   * Load the full turn history for a session.
   * Returns an empty array when no checkpoint file exists for that sessionId.
   */
  loadCheckpoint: route({
    input:  z.object({ sessionId: z.string().min(1) }),
    output: z.array(TurnSchema),
    handle: async ({ sessionId }): Promise<PlaybookTurn[]> => {
      return loadCheckpoint(sessionId)
    },
  }),

  /**
   * List all checkpoint files, newest first.
   * Returns { sessionId, sizeBytes, updatedAt } per file.
   */
  listCheckpoints: route({
    input:  z.object({}),
    output: z.array(CheckpointMetaSchema),
    handle: async (): Promise<CheckpointMeta[]> => {
      return listCheckpoints()
    },
  }),

  /**
   * Delete the checkpoint (and its .old rotation) for a session.
   * Returns { deleted: true } if at least one file was removed.
   */
  deleteCheckpoint: route({
    input:  z.object({ sessionId: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
    handle: async ({ sessionId }): Promise<{ deleted: boolean }> => {
      const deleted = deleteCheckpoint(sessionId)
      return { deleted }
    },
  }),

  // ── Git-backed WORKSPACE checkpoints (STEAL 2026-07-08, agent-native) ──
  // Distinct from the conversation-turn checkpoints above: these snapshot the
  // working tree so the agent's file changes are one-click revertible.

  /** Snapshot the workspace's full working tree. Returns null outside a git repo. */
  snapshotWorkspace: route({
    input:  z.object({ root: z.string().min(1), label: z.string().optional() }),
    output: z.object({
      ok: z.boolean(),
      checkpoint: z.object({ id: z.string(), commit: z.string(), label: z.string(), createdAt: z.string() }).nullable(),
    }),
    handle: async ({ root, label }) => {
      const cp = await createWorkspaceCheckpoint(root, label ?? 'manual checkpoint')
      return { ok: !!cp, checkpoint: cp }
    },
  }),

  /** List workspace checkpoints for a root, newest first. */
  listWorkspaceCheckpoints: route({
    input:  z.object({ root: z.string().min(1) }),
    output: z.array(z.object({ id: z.string(), commit: z.string(), label: z.string(), createdAt: z.string() })),
    handle: async ({ root }) => listWorkspaceCheckpoints(root),
  }),

  /** Force the working tree back to a checkpoint (auto-snapshots current state first). */
  restoreWorkspace: route({
    input:  z.object({ root: z.string().min(1), id: z.string().min(1) }),
    output: z.object({ ok: z.boolean(), error: z.string().optional(), safetyId: z.string().optional() }),
    handle: async ({ root, id }) => restoreWorkspaceCheckpoint(root, id),
  }),

  /** Delete a workspace checkpoint (its dangling commit becomes GC-able). */
  deleteWorkspaceCheckpoint: route({
    input:  z.object({ root: z.string().min(1), id: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
    handle: async ({ root, id }) => ({ deleted: await deleteWorkspaceCheckpoint(root, id) }),
  }),

})

/**
 * @deprecated Use registerRouter(checkpointsRouter) instead.
 * No-op shim — kept for structural consistency with other IPC modules.
 */
export function registerCheckpointsIpc(): void { /* no-op */ }
