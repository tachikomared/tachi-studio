import { describe, expect, it } from 'vitest'
import { AGENTS_MD_MAX_BYTES, parseAgentsMd } from '../agents-md-parser.js'

const PATH = '/repo/AGENTS.md'

describe('parseAgentsMd', () => {
  it('returns whole body as instructions when there is no frontmatter', () => {
    const body = 'Just plain instructions.\nNo frontmatter here.'
    const r = parseAgentsMd(PATH, body)
    expect(r.path).toBe(PATH)
    expect(r.raw).toBe(body)
    expect(r.meta).toBeUndefined()
    expect(r.instructions).toBe(body)
    expect(r.warnings).toEqual([])
  })

  it('handles empty input', () => {
    const r = parseAgentsMd(PATH, '')
    expect(r.raw).toBe('')
    expect(r.instructions).toBe('')
    expect(r.meta).toBeUndefined()
    expect(r.warnings).toEqual([])
  })

  it('handles whitespace-only input', () => {
    const r = parseAgentsMd(PATH, '   \n\n\t  ')
    expect(r.instructions).toBe('')
    expect(r.meta).toBeUndefined()
  })

  it('parses all four recognised frontmatter keys', () => {
    const raw = [
      '---',
      'profile: Code Review',
      'model: openai/gpt-4.1-mini',
      'providerId: openrouter',
      'permissions.mode: read-only',
      '---',
      'Body instructions here.',
    ].join('\n')
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta).toEqual({
      profile: 'Code Review',
      model: 'openai/gpt-4.1-mini',
      providerId: 'openrouter',
      permissions: { mode: 'read-only' },
    })
    expect(r.instructions).toBe('Body instructions here.')
    expect(r.warnings).toEqual([])
  })

  it('strips matching quotes from values', () => {
    const raw = `---\nprofile: "Code Review"\nmodel: 'openai/gpt-4.1'\n---\nBody`
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta?.profile).toBe('Code Review')
    expect(r.meta?.model).toBe('openai/gpt-4.1')
  })

  it('ignores comment lines in frontmatter', () => {
    const raw = [
      '---',
      '# this is a comment',
      'profile: Reviewer',
      '# another comment',
      '---',
      'Body',
    ].join('\n')
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta).toEqual({ profile: 'Reviewer' })
    expect(r.warnings).toEqual([])
  })

  it('silently ignores unknown frontmatter keys', () => {
    const raw = [
      '---',
      'profile: P',
      'unknownKey: whatever',
      'anotherUnknown: 42',
      '---',
      'Body',
    ].join('\n')
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta).toEqual({ profile: 'P' })
    expect(r.warnings).toEqual([])
  })

  it('rejects invalid permissions.mode but preserves other keys with warning', () => {
    const raw = [
      '---',
      'profile: P',
      'permissions.mode: yolo',
      '---',
      'Body',
    ].join('\n')
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta?.profile).toBe('P')
    expect(r.meta?.permissions).toBeUndefined()
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings[0]).toContain('permissions.mode')
  })

  it('falls back to entire-file-as-body when closing --- is missing', () => {
    const raw = '---\nprofile: P\nmodel: m\n\nNo closing delimiter here.'
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta).toBeUndefined()
    expect(r.instructions).toBe(raw.trim())
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings[0]).toContain('missing closing --- delimiter')
  })

  it('warns when a frontmatter line lacks a colon, but still parses valid lines', () => {
    const raw = [
      '---',
      'profile: P',
      'profileCodeReview',
      'model: m',
      '---',
      'Body',
    ].join('\n')
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta?.profile).toBe('P')
    expect(r.meta?.model).toBe('m')
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(r.warnings[0]).toContain('profileCodeReview')
  })

  it('accumulates multiple warnings for multiple malformed lines', () => {
    const raw = [
      '---',
      'profile: P',
      'noColonHereOne',
      'permissions.mode: bogus',
      '---',
      'Body',
    ].join('\n')
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta?.profile).toBe('P')
    expect(r.warnings.length).toBe(2)
    expect(r.warnings.some((w) => w.includes('noColonHereOne'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('permissions.mode'))).toBe(true)
  })

  it('handles CRLF line endings the same as LF', () => {
    const raw =
      '---\r\nprofile: P\r\nmodel: m\r\n---\r\nBody line 1\r\nBody line 2'
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta).toEqual({ profile: 'P', model: 'm' })
    expect(r.instructions).toBe('Body line 1\r\nBody line 2')
  })

  it('trims leading/trailing whitespace and newlines from body', () => {
    const raw = '---\nprofile: P\n---\n\n\n  Body content  \n\n'
    const r = parseAgentsMd(PATH, raw)
    expect(r.instructions).toBe('Body content')
  })

  it('strips a leading UTF-8 BOM before detecting frontmatter', () => {
    const raw =
      '﻿---\nprofile: Code Review\nmodel: m\n---\nBody after BOM'
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta).toEqual({ profile: 'Code Review', model: 'm' })
    expect(r.instructions).toBe('Body after BOM')
    expect(r.warnings).toEqual([])
  })

  it('does not re-parse a literal --- line that appears in the body', () => {
    const raw = [
      '---',
      'profile: P',
      '---',
      'Body intro.',
      '',
      '---',
      '',
      'Body continues after a horizontal rule.',
    ].join('\n')
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta).toEqual({ profile: 'P' })
    expect(r.instructions).toContain('Body intro.')
    expect(r.instructions).toContain('---')
    expect(r.instructions).toContain('Body continues after a horizontal rule.')
  })

  it('accepts tabs around keys and values in frontmatter', () => {
    const raw = ['---', '\tprofile: P', 'model:\tm', '---', 'Body'].join('\n')
    const r = parseAgentsMd(PATH, raw)
    expect(r.meta).toEqual({ profile: 'P', model: 'm' })
    expect(r.warnings).toEqual([])
  })

  it('throws when raw exceeds the size cap', () => {
    const oversize = 'a'.repeat(AGENTS_MD_MAX_BYTES + 1)
    expect(() => parseAgentsMd(PATH, oversize)).toThrow(
      `AGENTS.md too large: ${AGENTS_MD_MAX_BYTES + 1} bytes`,
    )
  })

  it('does NOT throw when raw is exactly at the size cap', () => {
    const exact = 'a'.repeat(AGENTS_MD_MAX_BYTES)
    expect(() => parseAgentsMd(PATH, exact)).not.toThrow()
  })
})
