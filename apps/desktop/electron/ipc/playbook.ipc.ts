// apps/desktop/electron/ipc/playbook.ipc.ts
//
// Migrated to the typed IPC router (Sprint C1).
// Wire channels "playbook:list", "playbook:load", "playbook:delete" are UNCHANGED.
//
// Legacy registerPlaybookIpc() kept as a no-op shim for incremental main.ts migration.

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { listPlaybooks, loadPlaybook, deletePlaybook, loadEntries } from '../services/playbook-service'

// ── Schema fragments ──────────────────────────────────────────────────────────

const PlaybookMetaSchema = z.object({
  workspaceHash: z.string(),
  workspacePath: z.string(),
  updatedAt:     z.string(),
  sizeBytes:     z.number(),
})

// ── Router definition ─────────────────────────────────────────────────────────

export const playbookRouter = defineRouter('playbook', {
  /** List all saved playbooks (metadata only). */
  list: route({
    input:  z.object({}),
    output: z.array(PlaybookMetaSchema),
    handle: async () => {
      return listPlaybooks()
    },
  }),

  /** Load playbook markdown for a workspace path. Returns null if not found. */
  load: route({
    input:  z.object({ workspacePath: z.string().min(1) }),
    output: z.union([z.string(), z.null()]),
    handle: async ({ workspacePath }) => {
      return loadPlaybook(workspacePath)
    },
  }),

  /** Delete playbook for a workspace path. Returns { deleted: boolean }. */
  delete: route({
    input:  z.object({ workspacePath: z.string().min(1) }),
    output: z.object({ deleted: z.boolean() }),
    handle: async ({ workspacePath }) => {
      const deleted = deletePlaybook(workspacePath)
      return { deleted }
    },
  }),

  /**
   * Load all structured PlaybookEntry objects for a workspace path (Sprint D3).
   * Returns an empty array if no entries exist yet.
   * Backward-compat: malformed lines in the JSONL are silently skipped.
   */
  loadEntries: route({
    input:  z.object({ workspacePath: z.string().min(1) }),
    output: z.array(z.unknown()),
    handle: async ({ workspacePath }) => {
      return loadEntries(workspacePath)
    },
  }),
})

// ── Legacy shim ───────────────────────────────────────────────────────────────
/** @deprecated Use registerRouter(playbookRouter) from ipc-router/router instead. */
export function registerPlaybookIpc(): void {
  // No-op: registerRouter(playbookRouter) is called from main.ts
}
