import { describe, it, expect } from 'vitest'
import { ProfileSchema, parseProfile } from '../schema.js'

describe('ProfileSchema', () => {
  const valid = {
    id: 'p1', name: 'Test', systemPrompt: 'hi',
    providerId: 'github-models', model: 'openai/gpt-4.1-mini',
    tags: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }

  it('accepts a minimal valid profile', () => {
    const result = ProfileSchema.safeParse(valid)
    expect(result.success).toBe(true)
  })

  it('rejects empty name', () => {
    const result = ProfileSchema.safeParse({ ...valid, name: '' })
    expect(result.success).toBe(false)
  })

  it('rejects temperature outside [0, 2]', () => {
    expect(ProfileSchema.safeParse({ ...valid, temperature: 3 }).success).toBe(false)
    expect(ProfileSchema.safeParse({ ...valid, temperature: -1 }).success).toBe(false)
  })

  it('parseProfile throws on invalid input with helpful message', () => {
    expect(() => parseProfile({ name: 'x' })).toThrow(/profile/i)
  })

  it('rejects non-positive or non-integer maxTokens', () => {
    expect(ProfileSchema.safeParse({ ...valid, maxTokens: 0 }).success).toBe(false)
    expect(ProfileSchema.safeParse({ ...valid, maxTokens: -5 }).success).toBe(false)
    expect(ProfileSchema.safeParse({ ...valid, maxTokens: 1.5 }).success).toBe(false)
  })

  it('rejects empty id, providerId, or model', () => {
    expect(ProfileSchema.safeParse({ ...valid, id: '' }).success).toBe(false)
    expect(ProfileSchema.safeParse({ ...valid, providerId: '' }).success).toBe(false)
    expect(ProfileSchema.safeParse({ ...valid, model: '' }).success).toBe(false)
  })

  it('rejects empty-string tags', () => {
    expect(ProfileSchema.safeParse({ ...valid, tags: [''] }).success).toBe(false)
  })

  it('rejects non-string tag entries', () => {
    expect(ProfileSchema.safeParse({ ...valid, tags: [123] }).success).toBe(false)
  })

  it('rejects malformed datetime', () => {
    expect(ProfileSchema.safeParse({ ...valid, createdAt: 'yesterday' }).success).toBe(false)
  })

  it('rejects unknown permissions.mode', () => {
    expect(ProfileSchema.safeParse({ ...valid, permissions: { mode: 'partial' } }).success).toBe(false)
  })

  it('parseProfile returns a typed Profile that round-trips deep-equal to input', () => {
    const result = parseProfile(valid)
    expect(result).toEqual(valid)
  })

  it('parseProfile error message includes zod paths', () => {
    expect(() => parseProfile({ ...valid, maxTokens: -1 })).toThrow(/maxTokens/)
  })
})
