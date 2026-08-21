import { describe, it, expect } from 'vitest'
import { resolvePrompt } from '../prompt-resolver.js'
import type { Profile } from '../schema.js'
import type { Workspace, AgentsMdFile } from '../../workspace/types.js'

const baseProfile: Profile = {
  id: 'p1',
  name: 'Test',
  systemPrompt: 'You are helpful.',
  providerId: 'github-models',
  model: 'openai/gpt-4.1-mini',
  temperature: 0.5,
  tags: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const makeAgents = (overrides: Partial<AgentsMdFile> = {}): AgentsMdFile => ({
  path: '/repo/AGENTS.md',
  raw: '',
  instructions: 'Follow repo conventions.',
  warnings: [],
  ...overrides,
})

describe('resolvePrompt', () => {
  it('returns profile-only when no workspace is provided', () => {
    const r = resolvePrompt(baseProfile)
    expect(r.source).toBe('profile-only')
    expect(r.systemMessage).toBe('You are helpful.')
    expect(r.providerId).toBe('github-models')
    expect(r.model).toBe('openai/gpt-4.1-mini')
    expect(r.temperature).toBe(0.5)
  })

  it('returns profile-only when workspace has no AGENTS.md', () => {
    const ws: Workspace = { rootPath: '/repo' }
    const r = resolvePrompt(baseProfile, ws)
    expect(r.source).toBe('profile-only')
    expect(r.systemMessage).toBe('You are helpful.')
    expect(r.providerId).toBe('github-models')
    expect(r.model).toBe('openai/gpt-4.1-mini')
  })

  it('composes profile + AGENTS.md with separator and header when no meta', () => {
    const ws: Workspace = { rootPath: '/repo', agentsMd: makeAgents() }
    const r = resolvePrompt(baseProfile, ws)
    expect(r.source).toBe('profile+workspace')
    expect(r.systemMessage).toBe(
      'You are helpful.\n\n---\n\n# Workspace instructions (from AGENTS.md)\n\nFollow repo conventions.',
    )
    expect(r.providerId).toBe('github-models')
    expect(r.model).toBe('openai/gpt-4.1-mini')
    expect(r.temperature).toBe(0.5)
  })

  it('AGENTS.md meta overrides providerId and model', () => {
    const ws: Workspace = {
      rootPath: '/repo',
      agentsMd: makeAgents({
        meta: { providerId: 'openrouter', model: 'anthropic/claude-opus-4' },
      }),
    }
    const r = resolvePrompt(baseProfile, ws)
    expect(r.source).toBe('profile+workspace')
    expect(r.providerId).toBe('openrouter')
    expect(r.model).toBe('anthropic/claude-opus-4')
    expect(r.temperature).toBe(0.5) // profile temperature preserved
  })

  it('AGENTS.md meta can override only model; provider falls through to profile', () => {
    const ws: Workspace = {
      rootPath: '/repo',
      agentsMd: makeAgents({ meta: { model: 'openai/gpt-5' } }),
    }
    const r = resolvePrompt(baseProfile, ws)
    expect(r.providerId).toBe('github-models')
    expect(r.model).toBe('openai/gpt-5')
  })

  it('empty profile prompt + AGENTS.md non-empty → header-only, no leading separator', () => {
    const profile: Profile = { ...baseProfile, systemPrompt: '   ' }
    const ws: Workspace = { rootPath: '/repo', agentsMd: makeAgents() }
    const r = resolvePrompt(profile, ws)
    expect(r.source).toBe('profile+workspace')
    expect(r.systemMessage).toBe(
      '# Workspace instructions (from AGENTS.md)\n\nFollow repo conventions.',
    )
  })

  it('non-empty profile + empty AGENTS.md instructions → profile prompt unchanged, source profile+workspace', () => {
    const ws: Workspace = {
      rootPath: '/repo',
      agentsMd: makeAgents({ instructions: '   \n  ' }),
    }
    const r = resolvePrompt(baseProfile, ws)
    expect(r.source).toBe('profile+workspace')
    expect(r.systemMessage).toBe('You are helpful.')
  })

  it('both empty → empty string, source profile+workspace', () => {
    const profile: Profile = { ...baseProfile, systemPrompt: '' }
    const ws: Workspace = {
      rootPath: '/repo',
      agentsMd: makeAgents({ instructions: '' }),
    }
    const r = resolvePrompt(profile, ws)
    expect(r.source).toBe('profile+workspace')
    expect(r.systemMessage).toBe('')
  })

  it('profile without temperature → result.temperature is undefined', () => {
    const { temperature: _t, ...rest } = baseProfile
    const profile = rest as Profile
    const r = resolvePrompt(profile)
    expect(r.temperature).toBeUndefined()
  })
})
