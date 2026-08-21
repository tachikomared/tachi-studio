// apps/desktop/electron/ipc/roles.ipc.ts
//
// Sprint D5 — Typed IPC router for the Role registry.
// Pattern: Sprint C1 typed router (see ipc-router/README.md).
// Wire channels: "roles:list", "roles:get", "roles:suggest".

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { listRoles, getRole, suggestRole } from '../services/role-registry'
import type { Role } from '../services/role-registry'

// ── Zod schema fragments ──────────────────────────────────────────────────────

const RoleTriggersSchema = z.object({
  keywords: z.array(z.string()),
  paths:    z.array(z.string()),
})

const RoleExampleSchema = z.object({
  user:       z.string(),
  commentary: z.string(),
})

const RoleBoundariesSchema = z.object({
  denyWritePaths:   z.array(z.string()),
  denyToolPatterns: z.array(z.string()),
})

const RoleSchema = z.object({
  id:           z.string(),
  label:        z.string(),
  description:  z.string(),
  triggers:     RoleTriggersSchema,
  examples:     z.array(RoleExampleSchema),
  boundaries:   RoleBoundariesSchema,
  allowedTools: z.array(z.string()),
})

const SuggestResultSchema = z.array(z.object({
  id:    z.string(),
  score: z.number(),
}))

// ── Router definition ─────────────────────────────────────────────────────────

export const rolesRouter = defineRouter('roles', {
  /** Return all registered roles, sorted by id. */
  list: route({
    input:  z.object({}),
    output: z.array(RoleSchema),
    handle: async (): Promise<Role[]> => {
      return listRoles()
    },
  }),

  /** Return a single role by id, or null if not found. */
  get: route({
    input:  z.object({ id: z.string().min(1) }),
    output: z.union([RoleSchema, z.null()]),
    handle: async ({ id }): Promise<Role | null> => {
      return getRole(id) ?? null
    },
  }),

  /**
   * Suggest roles ranked by keyword + path match score.
   * Always returns at least { id: 'generalist', score: 0 }.
   */
  suggest: route({
    input: z.object({
      workspaceFiles: z.array(z.string()),
      recentUserText: z.string(),
    }),
    output: SuggestResultSchema,
    handle: async ({ workspaceFiles, recentUserText }) => {
      return suggestRole({ workspaceFiles, recentUserText })
    },
  }),
})

// ── Legacy shim ───────────────────────────────────────────────────────────────
/** @deprecated Use registerRouter(rolesRouter) from ipc-router/router instead. */
export function registerRolesIpc(): void {
  // No-op: registerRouter(rolesRouter) is called from main.ts
}
