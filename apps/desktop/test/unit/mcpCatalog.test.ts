// apps/desktop/test/unit/mcpCatalog.test.ts
//
// The curated MCP marketplace catalog (services/mcp-catalog.ts).
//
// The catalog is static data the UI trusts and the IPC layer turns directly
// into a spawned process, so it gets a real schema gate: every entry must
// validate, ids/names must be unique, every `<slot>` token in `args` must have
// a declared slot (and vice versa), and no entry may declare a secret env var
// that is missing a key. A typo here would otherwise ship as "server won't
// start" or, worse, a literal `<path>` handed to a child process.
//
// Pure data + pure helpers — no electron, no fs, no network.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  MCP_CATALOG,
  MCP_CATALOG_TAGS,
  getCatalogEntry,
  searchCatalog,
  resolveCatalogArgs,
  splitCatalogEnv,
  missingRequiredInputs,
} from '../../electron/services/mcp-catalog'
import type { McpCatalogEntry } from '../../electron/services/mcp-catalog'

const SlotSchema = z.object({
  token:    z.string().regex(/^<[a-z][a-z0-9_-]*>$/, 'slot tokens look like <path>'),
  label:    z.string().min(3),
  kind:     z.enum(['path', 'text']),
  required: z.boolean(),
  default:  z.string().optional(),
})

const EnvSchema = z.object({
  key:      z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'env keys are SCREAMING_SNAKE'),
  label:    z.string().min(3),
  required: z.boolean(),
  secret:   z.boolean(),
})

const EntrySchema = z.object({
  id:              z.string().regex(/^[a-z][a-z0-9-]*$/, 'ids are lowercase-kebab'),
  name:            z.string().min(2),
  description:     z.string().min(20).max(200),
  packageName:     z.string().min(3),
  runner:          z.enum(['npx', 'uvx']),
  command:         z.string().min(1),
  args:            z.array(z.string().min(1)).min(1),
  slots:           z.array(SlotSchema).optional(),
  env:             z.array(EnvSchema).optional(),
  tags:            z.array(z.enum(MCP_CATALOG_TAGS)).min(1),
  requiresNetwork: z.boolean(),
  homepage:        z.string().url(),
})

describe('MCP catalog — shape', () => {
  it('ships a usefully sized catalog', () => {
    expect(MCP_CATALOG.length).toBeGreaterThanOrEqual(15)
    expect(MCP_CATALOG.length).toBeLessThanOrEqual(30)
  })

  it('every entry validates against the schema', () => {
    for (const entry of MCP_CATALOG) {
      const parsed = EntrySchema.safeParse(entry)
      if (!parsed.success) {
        throw new Error(`catalog entry "${entry.id}" is invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`)
      }
    }
  })

  it('has unique ids, names and package names', () => {
    const ids   = MCP_CATALOG.map(e => e.id)
    const names = MCP_CATALOG.map(e => e.name)
    const pkgs  = MCP_CATALOG.map(e => e.packageName)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(pkgs).size).toBe(pkgs.length)
  })

  it("the runner matches the entry's command", () => {
    for (const e of MCP_CATALOG) expect(e.command).toBe(e.runner)
  })

  it('declares a slot for every <token> in args, and no orphan slots', () => {
    for (const e of MCP_CATALOG) {
      const tokensInArgs = e.args.filter(a => /^<.+>$/.test(a))
      const declared     = (e.slots ?? []).map(s => s.token)
      expect(new Set(tokensInArgs)).toEqual(new Set(declared))
      // A slot must appear exactly once, otherwise resolution is ambiguous.
      for (const tok of declared) {
        expect(e.args.filter(a => a === tok)).toHaveLength(1)
      }
    }
  })

  it('marks every credential-shaped env var as secret', () => {
    const CREDENTIAL = /(TOKEN|KEY|SECRET|PASSWORD)$/
    for (const e of MCP_CATALOG) {
      for (const v of e.env ?? []) {
        if (CREDENTIAL.test(v.key)) {
          expect(`${e.id}:${v.key}:secret=${v.secret}`).toBe(`${e.id}:${v.key}:secret=true`)
        }
      }
    }
  })

  it('classifies a meaningful set of servers as local-only (usable in PRIVATE MODE)', () => {
    const local = MCP_CATALOG.filter(e => !e.requiresNetwork).map(e => e.id)
    expect(local).toEqual(expect.arrayContaining(['filesystem', 'memory', 'sqlite', 'git', 'sequential-thinking']))
    // …and anything with a credential env var must be network-classified.
    for (const e of MCP_CATALOG) {
      if ((e.env ?? []).some(v => v.secret)) expect(e.requiresNetwork).toBe(true)
    }
  })

  it('resolves entries by id', () => {
    expect(getCatalogEntry('filesystem')?.name).toBe('Filesystem')
    expect(getCatalogEntry('nope')).toBeUndefined()
  })
})

describe('searchCatalog', () => {
  it('returns everything for an empty query', () => {
    expect(searchCatalog('')).toHaveLength(MCP_CATALOG.length)
    expect(searchCatalog('   ')).toHaveLength(MCP_CATALOG.length)
  })

  it('matches name, id, description, package and tag case-insensitively', () => {
    expect(searchCatalog('FILESYSTEM').map(e => e.id)).toContain('filesystem')
    expect(searchCatalog('@modelcontextprotocol/server-memory').map(e => e.id)).toEqual(['memory'])
    expect(searchCatalog('knowledge graph').map(e => e.id)).toEqual(['memory']) // description hit
    expect(searchCatalog('zzz-no-such-server').map(e => e.id)).toEqual([])
    expect(searchCatalog('browser').map(e => e.id)).toEqual(expect.arrayContaining(['playwright', 'puppeteer']))
  })

  it('filters by tag, and combines tag with the query', () => {
    const local = searchCatalog('', 'local')
    expect(local.length).toBeGreaterThan(0)
    expect(local.every(e => e.tags.includes('local'))).toBe(true)
    expect(searchCatalog('sqlite', 'local').map(e => e.id)).toEqual(['sqlite'])
    expect(searchCatalog('sqlite', 'cloud')).toEqual([])
  })

  it('preserves the curated catalog order', () => {
    const ids = searchCatalog('').map(e => e.id)
    expect(ids).toEqual(MCP_CATALOG.map(e => e.id))
  })
})

describe('resolveCatalogArgs', () => {
  const fs = getCatalogEntry('filesystem')!

  it('substitutes the user answer for the slot token', () => {
    expect(resolveCatalogArgs(fs, { '<path>': 'D:/work' }))
      .toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'D:/work'])
  })

  it('trims the answer and never leaks a literal token', () => {
    const args = resolveCatalogArgs(fs, { '<path>': '  D:/work  ' })
    expect(args).toContain('D:/work')
    expect(args.some(a => a.includes('<'))).toBe(false)
  })

  it('throws when a REQUIRED slot is unanswered', () => {
    expect(() => resolveCatalogArgs(fs, {})).toThrow(/requires a value for <path>/)
    expect(() => resolveCatalogArgs(fs, { '<path>': '   ' })).toThrow(/<path>/)
  })

  it('falls back to a declared default', () => {
    const pg = getCatalogEntry('postgres')!
    expect(resolveCatalogArgs(pg, {}).at(-1)).toBe('postgresql://localhost/mydb')
  })

  it('drops an unanswered OPTIONAL slot rather than passing the token through', () => {
    const entry: McpCatalogEntry = {
      ...fs,
      args:  ['-y', 'pkg', '<opt>'],
      slots: [{ token: '<opt>', label: 'Optional thing', kind: 'text', required: false }],
    }
    expect(resolveCatalogArgs(entry, {})).toEqual(['-y', 'pkg'])
  })

  it('leaves entries without slots untouched', () => {
    const mem = getCatalogEntry('memory')!
    expect(resolveCatalogArgs(mem, {})).toEqual([...mem.args])
  })
})

describe('splitCatalogEnv', () => {
  const gitlab = getCatalogEntry('gitlab')!

  it('routes declared secrets to `secrets` and the rest to `env`', () => {
    const { env, secrets } = splitCatalogEnv(gitlab, {
      GITLAB_PERSONAL_ACCESS_TOKEN: 'glpat-xxx',
      GITLAB_API_URL:               'https://git.example.com/api/v4',
    })
    expect(secrets).toEqual({ GITLAB_PERSONAL_ACCESS_TOKEN: 'glpat-xxx' })
    expect(env).toEqual({ GITLAB_API_URL: 'https://git.example.com/api/v4' })
  })

  it('drops blank values so an untouched optional field is not persisted as ""', () => {
    const { env, secrets } = splitCatalogEnv(gitlab, {
      GITLAB_PERSONAL_ACCESS_TOKEN: 'glpat-xxx',
      GITLAB_API_URL:               '   ',
    })
    expect(env).toEqual({})
    expect(secrets).toEqual({ GITLAB_PERSONAL_ACCESS_TOKEN: 'glpat-xxx' })
  })

  it('treats an undeclared key as plaintext', () => {
    const { env, secrets } = splitCatalogEnv(gitlab, { SOMETHING_ELSE: 'v' })
    expect(env).toEqual({ SOMETHING_ELSE: 'v' })
    expect(secrets).toEqual({})
  })
})

describe('missingRequiredInputs', () => {
  it('reports an unanswered required slot', () => {
    expect(missingRequiredInputs(getCatalogEntry('filesystem')!, {}, {})).toEqual(['<path>'])
  })

  it('reports an unanswered required env var', () => {
    expect(missingRequiredInputs(getCatalogEntry('brave-search')!, {}, {})).toEqual(['BRAVE_API_KEY'])
  })

  it('ignores optional inputs and accepts declared defaults', () => {
    expect(missingRequiredInputs(getCatalogEntry('postgres')!, {}, {})).toEqual([])
    expect(missingRequiredInputs(getCatalogEntry('context7')!, {}, {})).toEqual([])
  })

  it('returns nothing once every required input is filled', () => {
    expect(missingRequiredInputs(getCatalogEntry('slack')!, {}, {
      SLACK_BOT_TOKEN: 'xoxb-1', SLACK_TEAM_ID: 'T1',
    })).toEqual([])
  })
})
