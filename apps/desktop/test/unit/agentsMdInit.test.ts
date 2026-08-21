// apps/desktop/test/unit/agentsMdInit.test.ts
//
// Unit coverage for THE ONE AGENTS.md generator (services/agents-md-init.ts) that
// the workspace `/init` and agent:generate-agents-md call sites share. Drives it
// against real temp dirs (no electron), asserting: stack detection + npm-script
// derivation, the code-graph "## Architecture (generated)" section (deterministic
// for a synthetic graph), marker-scoped regeneration that preserves user prose,
// the never-clobber guard for hand-written files, and the invalid-input paths.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initAgentsMd,
  renderAgentsMd,
  renderArchitectureSection,
  replaceGeneratedSection,
  roleHint,
  GENERATED_START,
  GENERATED_END,
} from '../../electron/services/agents-md-init'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'agents-md-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const FIXED = new Date('2026-07-24T12:00:00.000Z')

describe('initAgentsMd — create + detect', () => {
  it('creates a starter AGENTS.md with the standard sections in a bare dir', () => {
    const r = initAgentsMd(ws)
    expect(r).toMatchObject({ ok: true, created: true, reason: 'created', path: join(ws, 'AGENTS.md') })
    expect(existsSync(join(ws, 'AGENTS.md'))).toBe(true)
    const md = readFileSync(join(ws, 'AGENTS.md'), 'utf8')
    expect(md).toContain('# AGENTS.md')
    expect(md).toContain('## Stack')
    expect(md).toContain('## Build, run, test')
    expect(md).toContain('## Conventions')
    // The generated block is always present, wrapped in the regen markers.
    expect(md).toContain(GENERATED_START)
    expect(md).toContain(GENERATED_END)
    expect(md).toContain('## Architecture (generated)')
    // bare dir → no stack detected → TODO placeholder
    expect(md).toContain('TODO: list the languages')
    expect(r.detected?.stack).toEqual([])
  })

  it('detects a Node/TypeScript + pnpm project and writes real commands', () => {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'my-app', scripts: { test: 'vitest run', build: 'vite build' } }))
    writeFileSync(join(ws, 'tsconfig.json'), '{}')
    writeFileSync(join(ws, 'pnpm-lock.yaml'), '')
    const r = initAgentsMd(ws)
    expect(r.created).toBe(true)
    expect(r.detected).toMatchObject({ name: 'my-app', packageManager: 'pnpm' })
    expect(r.detected?.stack).toContain('Node.js / TypeScript')
    const md = readFileSync(join(ws, 'AGENTS.md'), 'utf8')
    expect(md).toContain('my-app —')
    expect(md).toContain('pnpm install')
    expect(md).toContain('pnpm run test')
    expect(md).toContain('pnpm run build')
  })

  it('detects Rust + falls back to dev/start when no build script', () => {
    writeFileSync(join(ws, 'Cargo.toml'), '[package]\nname = "x"')
    const r = initAgentsMd(ws)
    expect(r.detected?.stack).toContain('Rust (Cargo)')
  })

  it('falls back to npm when only package.json is present (no lockfile)', () => {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'p', scripts: { start: 'node .' } }))
    const r = initAgentsMd(ws)
    expect(r.detected?.packageManager).toBe('npm')
    const md = readFileSync(join(ws, 'AGENTS.md'), 'utf8')
    expect(md).toContain('npm install')
    expect(md).toContain('npm run start') // build/run falls through to the start script
  })

  it('rejects no workspace / non-existent / non-absolute paths without writing', () => {
    expect(initAgentsMd(null)).toMatchObject({ ok: false, created: false, reason: 'no_workspace' })
    expect(initAgentsMd(undefined)).toMatchObject({ ok: false, reason: 'no_workspace' })
    expect(initAgentsMd('relative/path')).toMatchObject({ ok: false, reason: 'invalid_path' })
    expect(initAgentsMd('C:/foo/../bar')).toMatchObject({ ok: false, reason: 'invalid_path' })   // forward-slash '..' (Windows)
    expect(initAgentsMd('/srv/app/../etc')).toMatchObject({ ok: false, reason: 'invalid_path' }) // posix '..'
    expect(initAgentsMd(join(ws, 'does-not-exist'))).toMatchObject({ ok: false, reason: 'not_a_directory' })
  })

  it('treats a file (not a directory) as not_a_directory', () => {
    const f = join(ws, 'afile.txt')
    writeFileSync(f, 'x')
    expect(initAgentsMd(f)).toMatchObject({ ok: false, reason: 'not_a_directory' })
  })
})

describe('initAgentsMd — regenerate vs. never-clobber', () => {
  it('NEVER overwrites a hand-written AGENTS.md that has no generated markers', () => {
    const original = '# my hand-written agents file\nleave me alone'
    writeFileSync(join(ws, 'AGENTS.md'), original)
    const r = initAgentsMd(ws)
    expect(r).toMatchObject({ ok: true, created: false, reason: 'exists' })
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(original)
  })

  it('regenerates ONLY the marked block and preserves user prose above/below', () => {
    const top = '# My Project\n\nCUSTOM INTRO the user wrote.\n\n## My rules\nKEEP THESE RULES\n\n'
    const stale = `${GENERATED_START}\n## Architecture (generated)\n\nSTALE OLD MAP that must be replaced.\n${GENERATED_END}`
    const bottom = '\n\n## Footnotes\nKEEP THIS FOOTNOTE too.\n'
    writeFileSync(join(ws, 'AGENTS.md'), top + stale + bottom)

    // Give the graph something real so the refreshed block has content.
    writeFileSync(join(ws, 'core.ts'), 'export const CORE = 1\n')
    writeFileSync(join(ws, 'a.ts'), "import { CORE } from './core'\nexport const A = CORE\n")

    const r = initAgentsMd(ws, { now: FIXED })
    expect(r).toMatchObject({ ok: true, created: false, reason: 'regenerated' })

    const md = readFileSync(join(ws, 'AGENTS.md'), 'utf8')
    // User content on both sides is untouched.
    expect(md).toContain('CUSTOM INTRO the user wrote.')
    expect(md).toContain('KEEP THESE RULES')
    expect(md).toContain('KEEP THIS FOOTNOTE too.')
    // Stale generated content is gone; a fresh, real map replaced it.
    expect(md).not.toContain('STALE OLD MAP')
    expect(md).toContain('## Architecture (generated)')
    expect(md).toContain('core.ts')
    // Exactly one marker pair survives (no duplication).
    expect(md.split(GENERATED_START).length - 1).toBe(1)
    expect(md.split(GENERATED_END).length - 1).toBe(1)
  })

  it('is idempotent across re-runs with a fixed clock (byte-for-byte)', () => {
    writeFileSync(join(ws, 'core.ts'), 'export const CORE = 1\n')
    writeFileSync(join(ws, 'a.ts'), "import { CORE } from './core'\nexport const A = CORE\n")
    initAgentsMd(ws, { now: FIXED })
    const first = readFileSync(join(ws, 'AGENTS.md'), 'utf8')
    const r2 = initAgentsMd(ws, { now: FIXED })
    expect(r2.reason).toBe('regenerated')
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(first)
  })
})

describe('renderArchitectureSection — deterministic code-graph map', () => {
  // A synthetic graph: `hub` is imported by three modules; `main` imports but is
  // imported by nobody (entry point); `lonely` is isolated.
  const files = [
    { path: 'src/hub.ts', text: 'export const HUB = 1\nexport function help() {}\n' },
    { path: 'src/a.ts', text: "import { HUB } from './hub'\nexport const A = HUB\n" },
    { path: 'src/b.ts', text: "import { HUB } from './hub'\nexport const B = HUB\n" },
    { path: 'src/main.ts', text: "import { HUB } from './hub'\nimport { A } from './a'\nconsole.log(A)\n" },
    { path: 'src/lonely.ts', text: 'const x = 1\n' },
  ]

  it('is byte-for-byte deterministic for the same input', () => {
    expect(renderArchitectureSection(files)).toBe(renderArchitectureSection(files))
  })

  it('does not depend on input ordering (graph is unordered)', () => {
    const shuffled = [files[3], files[0], files[4], files[2], files[1]]
    expect(renderArchitectureSection(shuffled)).toBe(renderArchitectureSection(files))
  })

  it('ranks the hub first with its importer count, lists exports, and names entry points', () => {
    const out = renderArchitectureSection(files)
    expect(out).toContain('## Architecture (generated)')
    expect(out).toContain('`src/hub.ts` — imported by 3')
    expect(out).toContain('HUB, help')            // exports surfaced
    expect(out).toContain('**Entry points**')
    expect(out).toContain('`src/main.ts`')        // imported-by-nobody root
    // Contains no timestamp — the wrapper stamps that, keeping this pure.
    expect(out).not.toContain('Generated by TACHI')
  })

  it('degrades gracefully with no source files', () => {
    const out = renderArchitectureSection([])
    expect(out).toContain('## Architecture (generated)')
    expect(out).toContain('No source files detected yet')
  })

  it('stays bounded — a 200-file fan-in produces well under 120 lines', () => {
    const many = [{ path: 'src/core.ts', text: 'export const C = 1\n' }]
    for (let i = 0; i < 200; i++) many.push({ path: `src/m${i}.ts`, text: "import { C } from './core'\n" })
    const lines = renderArchitectureSection(many).split('\n').length
    expect(lines).toBeLessThan(120)
    // Top-hub list is capped (~15), not 200.
    expect(renderArchitectureSection(many).match(/imported by/g)?.length ?? 0).toBeLessThanOrEqual(15)
  })
})

describe('replaceGeneratedSection', () => {
  it('returns null when there are no markers (leave the file alone)', () => {
    expect(replaceGeneratedSection('# hand written\nno markers here', 'BLOCK')).toBeNull()
  })

  it('swaps only the marked region', () => {
    const before = `TOP\n${GENERATED_START}\nOLD\n${GENERATED_END}\nBOTTOM`
    const out = replaceGeneratedSection(before, `${GENERATED_START}\nNEW\n${GENERATED_END}`)
    expect(out).toBe(`TOP\n${GENERATED_START}\nNEW\n${GENERATED_END}\nBOTTOM`)
  })
})

describe('roleHint — deterministic "where it is wired" per path', () => {
  it('classifies common file roles', () => {
    expect(roleHint('packages/core/src/index.ts')).toContain('barrel')
    expect(roleHint('apps/desktop/electron/ipc/agent.ipc.ts')).toContain('IPC bridge')
    expect(roleHint('apps/desktop/electron/services/tachi/tools.ts')).toContain('agent tool')
    expect(roleHint('apps/desktop/electron/services/chat-service.ts')).toContain('service')
    expect(roleHint('apps/desktop/src/state/agentStore.ts')).toContain('state store')
    expect(roleHint('apps/desktop/src/components/Sidebar.tsx')).toContain('UI component')
  })
})

describe('renderAgentsMd — consolidated content builder (agent.ipc delegate)', () => {
  it('produces the full doc: stack + npm scripts + generated architecture block', () => {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest', build: 'tsc' } }))
    writeFileSync(join(ws, 'tsconfig.json'), '{}')
    writeFileSync(join(ws, 'pnpm-lock.yaml'), '')
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'hub.ts'), 'export const HUB = 1\n')
    writeFileSync(join(ws, 'src', 'a.ts'), "import { HUB } from './hub'\nexport const A = HUB\n")

    const md = renderAgentsMd(ws, { now: FIXED })
    expect(md).toContain('demo —')
    expect(md).toContain('Node.js / TypeScript')
    expect(md).toContain('pnpm run test')
    expect(md).toContain(GENERATED_START)
    expect(md).toContain('Generated by TACHI /init · 2026-07-24T12:00:00.000Z')
    expect(md).toContain('## Architecture (generated)')
    expect(md).toContain('src/hub.ts')
    expect(md).toContain(GENERATED_END)
  })
})
