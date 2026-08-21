import type { Profile } from './schema.js'

/** Profile shape (re-exported from schema.ts, the single source of truth). */
export type { Profile, ProfilePermissions } from './schema.js'

/**
 * Built-in factory profiles, seeded on first launch only.
 * Users can edit them; deleting marks as hidden, not literally erased (so updates can re-add).
 */
export const DEFAULT_PROFILES: ReadonlyArray<Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>> = [
  {
    name: 'General Chat', emoji: '💬',
    systemPrompt: 'You are a concise, helpful assistant. Answer in the user\'s language.',
    providerId: 'github-models', model: 'openai/gpt-4.1-mini', temperature: 0.7,
    tags: ['general'],
  },
  {
    name: 'Code Review', emoji: '🔍',
    systemPrompt: 'You are a strict senior code reviewer. Focus on correctness, security, and clarity. Cite line numbers. No fluff.',
    providerId: 'github-models', model: 'openai/gpt-4.1', temperature: 0.2,
    tags: ['coding', 'review'],
  },
  {
    name: 'Brainstorm', emoji: '💡',
    systemPrompt: 'You are a creative collaborator. Generate many ideas. Ask one clarifying question before going deep.',
    providerId: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', temperature: 1.0,
    tags: ['creative'],
  },
  {
    name: 'Cheap Daily', emoji: '⚡',
    systemPrompt: 'Be brief.',
    providerId: 'github-models', model: 'openai/gpt-4.1-mini', temperature: 0.7,
    tags: ['general', 'fast'],
  },
]
