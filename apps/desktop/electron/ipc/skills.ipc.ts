// apps/desktop/electron/ipc/skills.ipc.ts
//
// Skills surface for Settings: list installed skills (reusing the skills-host
// discovery the TACHI loop already trusts), suggest skills for the current
// workspace (cheap top-2-level marker scan → the pure @tachi/core table), show
// the hash-pinned registry, and install a registry entry into the workspace's
// .tachi/skills. Channels: "skills:list" / "skills:suggest" / "skills:registry"
// / "skills:install".
//
// Read-mostly by design — install is the only write, and it is fail-closed
// inside installSkill (sha256 pin verified before anything touches disk).

import { z } from 'zod'
import { defineRouter, route } from '../ipc-router/router'
import { suggestSkills } from '@tachi/core'
import { discoverSkills } from '../services/tachi/skills-host'
import { installSkill, scanWorkspaceMarkers, SKILL_REGISTRY } from '../services/tachi/skills-registry'
import { currentWorkspace } from '../services/workspace-store'

// ── Schema fragments ──────────────────────────────────────────────────────────

const SkillInfoSchema = z.object({
  name:        z.string(),
  description: z.string(),
  layer:       z.enum(['bundled', 'workspace', 'project']),
  dir:         z.string(),
})

const SuggestionSchema = z.object({
  skillId:   z.string(),
  title:     z.string(),
  reason:    z.string(),
  layer:     z.literal('suggested'),
  installed: z.boolean(),
})

const RegistryEntrySchema = z.object({
  id:          z.string(),
  title:       z.string(),
  description: z.string(),
  url:         z.string(),
  sha256:      z.string(),
  installed:   z.boolean(),
})

/** The last-opened workspace root, or '' (skills-host treats '' as "no project layer"). */
function workspaceRoot(): string {
  try { return currentWorkspace()?.rootPath ?? '' } catch { return '' }
}

// ── Router definition ─────────────────────────────────────────────────────────

export const skillsRouter = defineRouter('skills', {
  /** Installed skills across all layers (bundled / user / project) for the current workspace. */
  list: route({
    input:  z.object({}),
    output: z.object({ workspaceRoot: z.string().nullable(), skills: z.array(SkillInfoSchema) }),
    handle: async () => {
      const root = workspaceRoot()
      return { workspaceRoot: root || null, skills: discoverSkills(root) }
    },
  }),

  /** Scan the current workspace's markers and run the suggestion table over them. */
  suggest: route({
    input:  z.object({}),
    output: z.object({ workspaceRoot: z.string().nullable(), suggestions: z.array(SuggestionSchema) }),
    handle: async () => {
      const root = workspaceRoot()
      if (!root) return { workspaceRoot: null, suggestions: [] }
      const installed = new Set(discoverSkills(root).map(s => s.name))
      const suggestions = suggestSkills(scanWorkspaceMarkers(root)).map(s => ({
        ...s,
        installed: installed.has(s.skillId),
      }))
      return { workspaceRoot: root, suggestions }
    },
  }),

  /** The static hash-pinned registry, with per-entry installed flags. */
  registry: route({
    input:  z.object({}),
    output: z.array(RegistryEntrySchema),
    handle: async () => {
      const installed = new Set(discoverSkills(workspaceRoot()).map(s => s.name))
      return SKILL_REGISTRY.map(e => ({ ...e, installed: installed.has(e.id) }))
    },
  }),

  /** Download + sha256-verify + write a registry skill into <workspace>/.tachi/skills/<id>. */
  install: route({
    input:  z.object({ id: z.string().min(1) }),
    output: z.object({
      ok:      z.boolean(),
      skillId: z.string(),
      path:    z.string().optional(),
      error:   z.string().optional(),
    }),
    handle: async ({ id }) => {
      const root = workspaceRoot()
      if (!root) return { ok: false, skillId: id, error: 'no workspace open — open one in the CODE tab first' }
      return installSkill(id, root)
    },
  }),
})
