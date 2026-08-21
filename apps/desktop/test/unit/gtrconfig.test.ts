// apps/desktop/test/unit/gtrconfig.test.ts
//
// Pure .gtrconfig parser + copy planner (ported from ccpocket's worktree.ts,
// trimmed to declared-file copies + lifecycle hooks). No fs here: parseGtrConfig
// takes raw text and resolveCopyList takes an injected fileExists predicate, so
// the planning logic is verified deterministically without touching disk.
import { describe, it, expect } from 'vitest'
import { parseGtrConfig, resolveCopyList } from '../../electron/services/util/gtrconfig'

describe('parseGtrConfig', () => {
  it('collects copy entries, postCreate and preRemove hooks under their sections', () => {
    const text = [
      '[copy]',
      'file = .env',
      'file = config/local.json',
      '',
      '[hook]',
      'postCreate = pnpm install',
      'postCreate = pnpm build',
      'preRemove = pnpm clean',
    ].join('\n')

    const cfg = parseGtrConfig(text)
    expect(cfg.copy).toEqual(['.env', 'config/local.json'])
    expect(cfg.postCreate).toEqual(['pnpm install', 'pnpm build'])
    expect(cfg.preRemove).toEqual(['pnpm clean'])
  })

  it('ignores comments (# and ;) and blank lines', () => {
    const text = [
      '# this is a comment',
      '; so is this',
      '[copy]',
      '   ',
      'file = .env   # trailing note kept as value? no — value is verbatim',
      '',
    ].join('\n')

    const cfg = parseGtrConfig(text)
    // Comment + blank lines never become entries.
    expect(cfg.copy).toEqual(['.env   # trailing note kept as value? no — value is verbatim'])
    expect(cfg.postCreate).toEqual([])
    expect(cfg.preRemove).toEqual([])
  })

  it('ignores malformed lines (no =, unknown section, stray header)', () => {
    const text = [
      'file = .env',           // outside any section — dropped
      '[copy]',
      'this line has no equals',
      'file = keep.txt',
      '[bogus]',
      'file = ignored-in-unknown-section',
      '[hook]',
      'notAHook = nope',
      'postCreate = real',
    ].join('\n')

    const cfg = parseGtrConfig(text)
    expect(cfg.copy).toEqual(['keep.txt'])
    expect(cfg.postCreate).toEqual(['real'])
    expect(cfg.preRemove).toEqual([])
  })

  it('is case-insensitive for section names and keys, and trims whitespace', () => {
    const text = [
      '[COPY]',
      '  FILE   =   spaced.env  ',
      '[Hooks]',          // both "hook" and "hooks" accepted
      'PostCreate = npm ci',
      'PreRemove = npm run teardown',
    ].join('\n')

    const cfg = parseGtrConfig(text)
    expect(cfg.copy).toEqual(['spaced.env'])
    expect(cfg.postCreate).toEqual(['npm ci'])
    expect(cfg.preRemove).toEqual(['npm run teardown'])
  })

  it('returns empty arrays for empty or whitespace-only input', () => {
    for (const t of ['', '   \n  \n', '# only a comment\n']) {
      const cfg = parseGtrConfig(t)
      expect(cfg.copy).toEqual([])
      expect(cfg.postCreate).toEqual([])
      expect(cfg.preRemove).toEqual([])
    }
  })

  it('tolerates CRLF line endings', () => {
    const text = '[copy]\r\nfile = .env\r\n[hook]\r\npostCreate = ls\r\n'
    const cfg = parseGtrConfig(text)
    expect(cfg.copy).toEqual(['.env'])
    expect(cfg.postCreate).toEqual(['ls'])
  })
})

describe('resolveCopyList', () => {
  it('keeps only declared files that exist (per the injected predicate)', () => {
    const present = new Set(['.env', 'config/local.json'])
    const fileExists = (rel: string) => present.has(rel)

    const got = resolveCopyList(
      ['.env', 'config/local.json', 'missing.txt'],
      '/proj',
      fileExists,
    )
    expect(got).toEqual(['.env', 'config/local.json'])
  })

  it('passes each pattern as a path joined to projectRoot to the predicate', () => {
    const seen: string[] = []
    const fileExists = (rel: string, abs: string) => {
      seen.push(abs)
      return true
    }
    resolveCopyList(['.env', 'a/b.json'], '/proj', fileExists)
    // Absolute path is projectRoot + relative; exact separator is platform join.
    expect(seen.some((p) => p.includes('.env'))).toBe(true)
    expect(seen.some((p) => p.includes('b.json'))).toBe(true)
  })

  it('returns empty for an empty pattern list', () => {
    expect(resolveCopyList([], '/proj', () => true)).toEqual([])
  })

  it('drops blank/whitespace patterns without consulting the predicate', () => {
    let calls = 0
    const fileExists = () => { calls++; return true }
    const got = resolveCopyList(['', '   ', '.env'], '/proj', fileExists)
    expect(got).toEqual(['.env'])
    expect(calls).toBe(1)
  })

  it('de-duplicates repeated declarations', () => {
    const got = resolveCopyList(['.env', '.env'], '/proj', () => true)
    expect(got).toEqual(['.env'])
  })
})
