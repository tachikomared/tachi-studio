// apps/desktop/test/unit/skillsRegistry.test.ts
//
// Unit coverage for the skills registry/installer (electron-free service):
// sha256 pin verification (fail-closed), registry URL pinning rules, the
// install pipeline against a temp workspace with an injected fetcher, and the
// top-2-level workspace marker scan that feeds suggestSkills.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  sha256Hex,
  verifyPinnedSha256,
  validateRegistryUrl,
  installSkill,
  scanWorkspaceMarkers,
  SKILL_REGISTRY,
  MAX_SKILL_BYTES,
  type SkillRegistryEntry,
  type SkillFetcher,
} from '../../electron/services/tachi/skills-registry'

const PIN_SHA = 'a'.repeat(40) // fake commit sha for pinned URLs
const goodUrl = (path = 'skills/demo/SKILL.md') => `https://raw.githubusercontent.com/owner/repo/${PIN_SHA}/${path}`

const BODY = '---\nname: demo-skill\ndescription: Demo.\n---\nDo the thing.\n'
const BODY_SHA = sha256Hex(BODY)

const entry = (over: Partial<SkillRegistryEntry> = {}): SkillRegistryEntry => ({
  id: 'demo-skill',
  title: 'Demo skill',
  description: 'A demo.',
  url: goodUrl(),
  sha256: BODY_SHA,
  ...over,
})

const fetcherFor = (status: number, body: string | Uint8Array): SkillFetcher =>
  async () => ({ status, body: typeof body === 'string' ? new TextEncoder().encode(body) : body })

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'skills-reg-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

describe('sha256Hex / verifyPinnedSha256', () => {
  it('matches known sha256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('accepts a correct pin, case-insensitively', () => {
    expect(verifyPinnedSha256('abc', sha256Hex('abc')).ok).toBe(true)
    expect(verifyPinnedSha256('abc', sha256Hex('abc').toUpperCase()).ok).toBe(true)
  })

  it('rejects a wrong pin and reports both hashes', () => {
    const r = verifyPinnedSha256('abc', sha256Hex('abd'))
    expect(r.ok).toBe(false)
    expect(r.actual).toBe(sha256Hex('abc'))
    expect(r.expected).toBe(sha256Hex('abd'))
  })

  it('rejects malformed pins (empty / short) — fail closed', () => {
    expect(verifyPinnedSha256('abc', '').ok).toBe(false)
    expect(verifyPinnedSha256('abc', 'deadbeef').ok).toBe(false)
  })
})

describe('validateRegistryUrl', () => {
  it('accepts a raw.githubusercontent URL pinned to a 40-hex commit', () => {
    expect(validateRegistryUrl(goodUrl())).toBeNull()
  })

  it('rejects http, unknown hosts, branch refs, and malformed URLs', () => {
    expect(validateRegistryUrl(`http://raw.githubusercontent.com/o/r/${PIN_SHA}/f.md`)).toMatch(/https/)
    expect(validateRegistryUrl(`https://example.com/o/r/${PIN_SHA}/f.md`)).toMatch(/allowlist/)
    expect(validateRegistryUrl('https://raw.githubusercontent.com/o/r/main/f.md')).toMatch(/commit/)
    expect(validateRegistryUrl('https://raw.githubusercontent.com/o/r')).toMatch(/segments/)
    expect(validateRegistryUrl('not a url')).toMatch(/invalid/)
  })
})

describe('installSkill', () => {
  it('downloads, verifies, and writes SKILL.md into <ws>/.tachi/skills/<id>/', async () => {
    const r = await installSkill('demo-skill', ws, { registry: [entry()], fetcher: fetcherFor(200, BODY) })
    expect(r.ok).toBe(true)
    const target = join(ws, '.tachi', 'skills', 'demo-skill', 'SKILL.md')
    expect(r.path).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe(BODY)
  })

  it('FAILS CLOSED on a sha256 mismatch and writes nothing', async () => {
    const r = await installSkill('demo-skill', ws, {
      registry: [entry({ sha256: sha256Hex('tampered') })],
      fetcher: fetcherFor(200, BODY),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/sha256 mismatch/)
    expect(existsSync(join(ws, '.tachi'))).toBe(false)
  })

  it('rejects an unknown id', async () => {
    const r = await installSkill('nope', ws, { registry: [entry()], fetcher: fetcherFor(200, BODY) })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not in the skills registry/)
  })

  it('rejects a registry entry whose URL is not commit-pinned', async () => {
    const r = await installSkill('demo-skill', ws, {
      registry: [entry({ url: 'https://raw.githubusercontent.com/o/r/main/SKILL.md' })],
      fetcher: fetcherFor(200, BODY),
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/commit/)
    expect(existsSync(join(ws, '.tachi'))).toBe(false)
  })

  it('rejects a bad workspace root and non-200 / empty / oversized downloads', async () => {
    const opts = { registry: [entry()], fetcher: fetcherFor(200, BODY) }
    expect((await installSkill('demo-skill', 'relative/path', opts)).ok).toBe(false)
    expect((await installSkill('demo-skill', join(ws, 'missing'), opts)).ok).toBe(false)

    const r404 = await installSkill('demo-skill', ws, { registry: [entry()], fetcher: fetcherFor(404, '') })
    expect(r404.ok).toBe(false)
    expect(r404.error).toMatch(/HTTP 404/)

    expect((await installSkill('demo-skill', ws, { registry: [entry()], fetcher: fetcherFor(200, '') })).ok).toBe(false)

    const big = new Uint8Array(MAX_SKILL_BYTES + 1)
    expect((await installSkill('demo-skill', ws, { registry: [entry()], fetcher: fetcherFor(200, big) })).ok).toBe(false)
  })

  it('reports a thrown fetcher as a failed download, never throws', async () => {
    const boom: SkillFetcher = async () => { throw new Error('network down') }
    const r = await installSkill('demo-skill', ws, { registry: [entry()], fetcher: boom })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/network down/)
  })

  it('ships with an empty registry until entries are license-checked and pinned', () => {
    // Deliberate: no entry may be added without a human license check + a real
    // sha256 of the bytes at a pinned commit (see the comment in the service).
    expect(SKILL_REGISTRY).toEqual([])
  })
})

describe('scanWorkspaceMarkers', () => {
  it('collects top-2-level paths, deps, and extensions; skips node_modules', () => {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({
      dependencies: { react: '^18.0.0' },
      devDependencies: { vitest: '^1.0.0' },
    }))
    writeFileSync(join(ws, 'Dockerfile'), 'FROM node:22-slim\n')
    mkdirSync(join(ws, '.github', 'workflows'), { recursive: true })
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'App.tsx'), 'export {}\n')
    mkdirSync(join(ws, 'node_modules', 'react'), { recursive: true })

    const m = scanWorkspaceMarkers(ws)
    expect(m.files).toContain('package.json')
    expect(m.files).toContain('Dockerfile')
    expect(m.files).toContain('.github/workflows') // depth-2 dir path is enough for the ci rule
    expect(m.files).toContain('src/App.tsx')
    expect(m.files.some(f => f.includes('node_modules'))).toBe(false)
    expect(m.deps).toEqual(expect.arrayContaining(['react', 'vitest']))
    expect(m.languages).toContain('tsx')
    expect(m.languages).toContain('json')
  })

  it('returns empty markers for a missing or relative root', () => {
    expect(scanWorkspaceMarkers(join(ws, 'gone'))).toEqual({ files: [], deps: [], languages: [] })
    expect(scanWorkspaceMarkers('not/absolute')).toEqual({ files: [], deps: [], languages: [] })
  })

  it('survives an unparseable package.json (paths still collected, deps empty)', () => {
    writeFileSync(join(ws, 'package.json'), '{ not json')
    const m = scanWorkspaceMarkers(ws)
    expect(m.files).toContain('package.json')
    expect(m.deps).toEqual([])
  })
})
