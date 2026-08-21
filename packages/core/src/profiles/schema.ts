import { z } from 'zod'

/** Tool/command allow-lists controlling what a profile may execute. Ties into the future Plan/Build toggle. */
export const ProfilePermissionsSchema = z.object({
  mode: z.enum(['full', 'read-only']),
  toolAllowList: z.array(z.string()).optional(),
  toolDenyList:  z.array(z.string()).optional(),
})
export type ProfilePermissions = z.infer<typeof ProfilePermissionsSchema>

/** Runtime validator and type source for a Profile (id, name, prompt, provider/model, tags, optional permissions, timestamps). */
export const ProfileSchema = z.object({
  id:           z.string().min(1),
  name:         z.string().min(1).max(80),
  emoji:        z.string().max(8).optional(),
  systemPrompt: z.string().max(20_000),
  /** Free-form: bankr | github-models | openrouter | gitlawb-opengateway | any-future-preset-id */
  providerId:   z.string().min(1),
  /** Free-form: model id for the given provider (e.g. 'openai/gpt-4.1-mini'). */
  model:        z.string().min(1),
  temperature:  z.number().min(0).max(2).optional(),
  maxTokens:    z.number().int().positive().optional(),
  tags:         z.array(z.string().min(1)).max(32),
  permissions:  ProfilePermissionsSchema.optional(),
  createdAt:    z.string().datetime(),
  updatedAt:    z.string().datetime(),
})
export type Profile = z.infer<typeof ProfileSchema>

/**
 * Parse and validate an unknown value as a Profile.
 * @throws {Error} If validation fails. The message lists each zod issue as `path: message` joined by `; `.
 */
export function parseProfile(input: unknown): Profile {
  const r = ProfileSchema.safeParse(input)
  if (!r.success) {
    throw new Error(
      `Invalid profile: ${r.error.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`,
    )
  }
  return r.data
}
