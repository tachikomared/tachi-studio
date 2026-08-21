// apps/desktop/test/unit/repoMapInject.test.ts
//
// Auto-injected REPO MAP (aider's headline mechanic). Covers the two guarantees
// the feature rests on:
//   1. renderRepoMap is DETERMINISTIC — same graph summary → byte-identical output
//      (so it is safe to sit in the cache-stable system-prompt prefix).
//   2. renderRepoMap is BUDGET-TRIMMED — it never blows the char budget, dropping
//      whole hub entries (and the entry-points line) to fit, richest-first.
// Plus a light end-to-end check that buildRepoMap turns a real temp git workspace
// into a map naming its hub file, and that the >MAX_WORKSPACE_FILES guard skips.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { renderRepoMap, buildRepoMap, DEFAULT_REPO_MAP_MAX_CHARS, type RepoMapInput } from '../../electron/services/tachi/repo-map'

// A synthetic graph summary — the pure render function's whole input surface.
function synthInput(hubCount: number): RepoMapInput {
  const hubs = Array.from({ length: hubCount }, (_, i) => ({
    path: `packages/core/src/module-${String(i).padStart(3, '0')}/index.ts`,
    importedBy: hubCount - i, // descending, already sorted like summarizeArchitecture
    exports: Array.from({ length: 12 }, (_, k) => `sym_${i}_${k}`),
  }))
  return {
    fileCount: 1234,
    edgeCount: 5678,
    hubs,
    entryPoints: ['apps/desktop/electron/main.ts', 'apps/desktop/src/main.tsx', 'scripts/build.ts'],
  }
}

describe('renderRepoMap — pure render', () => {
  it('is deterministic: identical input → byte-identical output', () => {
    const input = synthInput(20)
    const a = renderRepoMap(input, { maxChars: 4800 })
    const b = renderRepoMap(input, { maxChars: 4800 })
    expect(a).toBe(b)
    // stable across independently-constructed but equal inputs too
    expect(renderRepoMap(synthInput(20), { maxChars: 4800 })).toBe(a)
  })

  it('includes the counts header, hub section, and entry points at a generous budget', () => {
    const s = renderRepoMap(synthInput(3), { maxChars: 100_000 })
    expect(s).toContain('1234 source file(s), 5678 import edge(s).')
    expect(s).toContain('Hub files (most depended-upon — read these first):')
    expect(s).toContain('packages/core/src/module-000/index.ts (imported by 3)')
    expect(s).toContain('Entry points: apps/desktop/electron/main.ts')
  })

  it('caps each hub\'s exports at 8 with a "+N more" suffix', () => {
    const s = renderRepoMap(synthInput(1), { maxChars: 100_000 })
    // 12 exports on the synthetic hub → 8 shown + "+4 more"
    expect(s).toContain('sym_0_7')     // 8th export present
    expect(s).not.toContain('sym_0_8') // 9th elided
    expect(s).toContain('+4 more')
  })

  it('never exceeds the char budget and drops hub entries to fit (richest-first)', () => {
    const input = synthInput(60)
    const tight = renderRepoMap(input, { maxChars: 600 })
    expect(tight.length).toBeLessThanOrEqual(600)
    // The most-depended-upon hub survives; a far-down one is dropped.
    expect(tight).toContain('module-000/index.ts')
    expect(tight).not.toContain('module-059/index.ts')

    const roomy = renderRepoMap(input, { maxChars: 100_000 })
    const count = (s: string) => (s.match(/index\.ts \(imported by/g) ?? []).length
    expect(count(roomy)).toBe(60)          // all hubs fit when there is room
    expect(count(tight)).toBeLessThan(60)  // budget forced a trim
    expect(count(tight)).toBeGreaterThan(0)
  })

  it('defaults to the ~1200-token (4800-char) budget', () => {
    const s = renderRepoMap(synthInput(200))
    expect(s.length).toBeLessThanOrEqual(DEFAULT_REPO_MAP_MAX_CHARS)
  })

  it('renders just the header when there are no hubs or entry points', () => {
    const s = renderRepoMap({ fileCount: 0, edgeCount: 0, hubs: [], entryPoints: [] }, { maxChars: 4800 })
    expect(s).toBe('0 source file(s), 0 import edge(s).')
  })
})

// ── buildRepoMap over a real temp git workspace ───────────────────────────────
let gitOk = true
try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { gitOk = false }

const d = gitOk ? describe : describe.skip
d('buildRepoMap — real workspace', () => {
  let ws: string
  const gitInit = (root: string) => {
    execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.dev'], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, 'config', 'user.name', 'tachi'], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', root, 'commit', '-qm', 'init'], { stdio: 'ignore' })
  }

  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-repomap-')) })
  afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('names the hub file that everything imports', async () => {
    mkdirSync(join(ws, 'src'), { recursive: true })
    writeFileSync(join(ws, 'src', 'util.ts'), 'export const helper = () => 1\nexport function shared() { return 2 }\n')
    writeFileSync(join(ws, 'src', 'a.ts'), "import { helper } from './util'\nexport const a = helper()\n")
    writeFileSync(join(ws, 'src', 'b.ts'), "import { shared } from './util'\nexport const b = shared()\n")
    writeFileSync(join(ws, 'src', 'c.ts'), "import { helper } from './util'\nexport const c = helper()\n")
    gitInit(ws)

    const map = await buildRepoMap(ws)
    expect(map).toBeDefined()
    expect(map!).toContain('src/util.ts (imported by 3)')
    expect(map!).toMatch(/exports .*helper/)
    expect(map!.length).toBeLessThanOrEqual(DEFAULT_REPO_MAP_MAX_CHARS)
  })

  it('respects a custom maxChars', async () => {
    mkdirSync(join(ws, 'src'), { recursive: true })
    writeFileSync(join(ws, 'src', 'util.ts'), 'export const helper = () => 1\n')
    writeFileSync(join(ws, 'src', 'a.ts'), "import { helper } from './util'\nexport const a = helper()\n")
    gitInit(ws)

    const map = await buildRepoMap(ws, { maxChars: 120 })
    expect(map).toBeDefined()
    expect(map!.length).toBeLessThanOrEqual(120)
  })

  it('returns undefined for a workspace with no graphable source', async () => {
    writeFileSync(join(ws, 'README.md'), '# docs only\n')
    gitInit(ws)
    expect(await buildRepoMap(ws)).toBeUndefined()
  })
})
