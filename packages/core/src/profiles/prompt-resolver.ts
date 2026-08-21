import type { Profile } from './schema.js'
import type { Workspace } from '../workspace/types.js'

/** Effective prompt + provider/model/temperature for a chat send, plus the mode that produced it. */
export interface ResolvedPrompt {
  systemMessage: string
  providerId: string
  model: string
  temperature?: number
  source: 'profile-only' | 'profile+workspace'
}

const SEPARATOR = '\n\n---\n\n'
const AGENTS_HEADER = '# Workspace instructions (from AGENTS.md)\n\n'

/**
 * Merge a Profile with an optional Workspace's AGENTS.md into a single system message
 * and the effective provider/model/temperature. Pure; spec §2.
 *
 * - No workspace / no AGENTS.md → `source: 'profile-only'`, profile values verbatim.
 * - AGENTS.md present → `source: 'profile+workspace'`; instructions are appended after the
 *   profile prompt with a separator and header. Empty sides collapse cleanly.
 * - `meta.providerId` / `meta.model` override the profile; temperature is profile-only in v1.
 */
export function resolvePrompt(profile: Profile, workspace?: Workspace): ResolvedPrompt {
  const agentsMd = workspace?.agentsMd
  if (!agentsMd) {
    return {
      systemMessage: profile.systemPrompt,
      providerId:    profile.providerId,
      model:         profile.model,
      temperature:   profile.temperature,
      source:        'profile-only',
    }
  }

  const profilePart = profile.systemPrompt.trim() === '' ? '' : profile.systemPrompt
  const agentsPart  = agentsMd.instructions.trim() === '' ? '' : agentsMd.instructions

  let systemMessage: string
  if (profilePart && agentsPart) {
    systemMessage = profilePart + SEPARATOR + AGENTS_HEADER + agentsPart
  } else if (agentsPart) {
    systemMessage = AGENTS_HEADER + agentsPart
  } else if (profilePart) {
    systemMessage = profilePart
  } else {
    systemMessage = ''
  }

  return {
    systemMessage,
    providerId:  agentsMd.meta?.providerId ?? profile.providerId,
    model:       agentsMd.meta?.model      ?? profile.model,
    temperature: profile.temperature,
    source:      'profile+workspace',
  }
}
