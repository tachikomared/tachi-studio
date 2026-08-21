// apps/desktop/test/unit/tachiScopedRules.test.ts
//
// GLOB-SCOPED RULES (harness item 8). Three properties decide whether this is a
// feature or a token leak: the NEAREST ancestor wins (a package's own rules beat
// its parent's), each rules file is shown at most ONCE per session (the hook
// fires on every tool result, so a per-call injection would re-pay for the same
// bytes forever), and the per-session byte budget is enforced.
//
// The fs is injected, so resolution is tested against a synthetic tree — no temp
// dirs, and the same assertions hold on win32 and posix.

import { describe, it, expect } from 'vitest'
import { join, sep } from 'node:path'
import {
  findNearestScopedRules,
  scopedPathArg,
  ScopedRulesSession,
  SCOPED_RULES_FILENAME,
  type ScopedRulesFs,
} from '../../electron/services/tachi/scoped-rules'

const ROOT = join(sep === '\\' ? 'C:\\' : '/', 'ws')
const p = (...parts: string[]): string => join(ROOT, ...parts)

/** Synthetic fs: the given paths exist, each returning `<path> rules` as content. */
function fakeFs(files: Record<string, string>): ScopedRulesFs {
  return {
    exists: (path) => Object.prototype.hasOwnProperty.call(files, path),
    read: (path) => {
      if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`ENOENT: ${path}`)
      return files[path]
    },
  }
}

const TREE = fakeFs({
  [p('AGENTS.md')]: 'ROOT RULES',
  [p('apps', 'desktop', 'AGENTS.md')]: 'DESKTOP RULES: i18n keys in all 8 locales.',
  [p('apps', 'desktop', 'src', 'pages', 'nodes', 'AGENTS.md')]: 'NODES RULES: canvas state in nodes.store.ts.',
})

describe('findNearestScopedRules — nearest ancestor', () => {
  it('finds the closest ancestor rules file, not the outer one', () => {
    expect(findNearestScopedRules(ROOT, 'apps/desktop/src/pages/nodes/Canvas.tsx', TREE))
      .toBe(p('apps', 'desktop', 'src', 'pages', 'nodes', 'AGENTS.md'))
  })

  it('walks up past directories without rules', () => {
    expect(findNearestScopedRules(ROOT, 'apps/desktop/src/store/chat.store.ts', TREE))
      .toBe(p('apps', 'desktop', 'AGENTS.md'))
  })

  it('never returns the ROOT rules file (already in the system prompt)', () => {
    expect(findNearestScopedRules(ROOT, 'packages/core/src/index.ts', TREE)).toBeNull()
    expect(findNearestScopedRules(ROOT, 'README.md', TREE)).toBeNull()
  })

  it('accepts an absolute in-workspace path and refuses one outside it', () => {
    expect(findNearestScopedRules(ROOT, p('apps', 'desktop', 'electron', 'main.ts'), TREE))
      .toBe(p('apps', 'desktop', 'AGENTS.md'))
    expect(findNearestScopedRules(ROOT, join(sep === '\\' ? 'C:\\' : '/', 'elsewhere', 'x.ts'), TREE)).toBeNull()
    expect(findNearestScopedRules(ROOT, '../outside/x.ts', TREE)).toBeNull()
  })

  it('a directory argument is its own first candidate', () => {
    expect(findNearestScopedRules(ROOT, 'apps/desktop', TREE)).toBe(p('apps', 'desktop', 'AGENTS.md'))
  })

  it('reading a rules file does not echo that same file back', () => {
    expect(findNearestScopedRules(ROOT, join('apps', 'desktop', SCOPED_RULES_FILENAME), TREE)).toBeNull()
  })

  it('an empty path resolves to nothing', () => {
    expect(findNearestScopedRules(ROOT, '', TREE)).toBeNull()
  })
})

describe('scopedPathArg — which calls can scope', () => {
  it('path-bearing file tools scope', () => {
    for (const t of ['read', 'write', 'edit', 'grep', 'blast_radius']) {
      expect(scopedPathArg(t, { path: 'apps/desktop/x.ts' })).toBe('apps/desktop/x.ts')
    }
  })
  it('pathless / non-file tools never scope', () => {
    expect(scopedPathArg('bash', { command: 'ls apps/desktop' })).toBeNull()
    expect(scopedPathArg('glob', { pattern: '**/*.ts' })).toBeNull()
    expect(scopedPathArg('grep', { pattern: 'foo' })).toBeNull()
    expect(scopedPathArg('read', { path: '   ' })).toBeNull()
    expect(scopedPathArg('read', { path: 42 as unknown as string })).toBeNull()
  })
})

describe('ScopedRulesSession — once per session, per rules file', () => {
  it('injects a formatted note the first time and NEVER again', () => {
    const s = new ScopedRulesSession({ workspaceRoot: ROOT, fs: TREE })
    const first = s.noteFor('read', { path: 'apps/desktop/src/store/chat.store.ts' })
    expect(first).toContain('[scoped rules — apps/desktop/AGENTS.md')
    expect(first).toContain('applies to files under apps/desktop/')
    expect(first).toContain('DESKTOP RULES')
    expect(first).toContain('[end scoped rules]')
    // Same file, same rules file → silent.
    expect(s.noteFor('read', { path: 'apps/desktop/src/store/chat.store.ts' })).toBeNull()
    // Different file, SAME rules file → still silent.
    expect(s.noteFor('edit', { path: 'apps/desktop/electron/main.ts' })).toBeNull()
  })

  it('a different rules file in the same session still gets its turn', () => {
    const s = new ScopedRulesSession({ workspaceRoot: ROOT, fs: TREE })
    expect(s.noteFor('read', { path: 'apps/desktop/electron/main.ts' })).toContain('DESKTOP RULES')
    const nodes = s.noteFor('read', { path: 'apps/desktop/src/pages/nodes/Canvas.tsx' })
    expect(nodes).toContain('NODES RULES')
  })

  it('emits nothing for paths with no scoped rules', () => {
    const s = new ScopedRulesSession({ workspaceRoot: ROOT, fs: TREE })
    expect(s.noteFor('read', { path: 'packages/core/src/index.ts' })).toBeNull()
    expect(s.noteFor('bash', { command: 'pnpm test' })).toBeNull()
    expect(s.spentChars).toBe(0)
  })

  it('an empty rules file produces no note', () => {
    const fs = fakeFs({ [p('pkg', 'AGENTS.md')]: '   \n' })
    const s = new ScopedRulesSession({ workspaceRoot: ROOT, fs })
    expect(s.noteFor('read', { path: 'pkg/a.ts' })).toBeNull()
  })

  it('an unreadable rules file degrades to no note (never throws)', () => {
    const fs: ScopedRulesFs = { exists: () => true, read: () => { throw new Error('EACCES') } }
    const s = new ScopedRulesSession({ workspaceRoot: ROOT, fs })
    expect(s.noteFor('read', { path: 'pkg/a.ts' })).toBeNull()
  })
})

describe('ScopedRulesSession — byte caps', () => {
  it('trims an oversized single file with an explicit marker', () => {
    const fs = fakeFs({ [p('pkg', 'AGENTS.md')]: 'R'.repeat(5000) })
    const s = new ScopedRulesSession({ workspaceRoot: ROOT, fs, maxFileChars: 100 })
    const note = s.noteFor('read', { path: 'pkg/a.ts' })
    expect(note).toContain('…[trimmed — read pkg/AGENTS.md for the rest]')
    expect(note!.length).toBeLessThan(400)
  })

  it('stops injecting once the session budget is spent', () => {
    const fs = fakeFs({
      [p('a', 'AGENTS.md')]: 'A'.repeat(300),
      [p('b', 'AGENTS.md')]: 'B'.repeat(300),
      [p('c', 'AGENTS.md')]: 'C'.repeat(300),
    })
    // Two notes fit (each ≈ 300 body + framing), the third crosses the line.
    const s = new ScopedRulesSession({ workspaceRoot: ROOT, fs, budgetChars: 900, maxFileChars: 1000 })
    expect(s.noteFor('read', { path: 'a/x.ts' })).toContain('AAA')
    expect(s.noteFor('read', { path: 'b/x.ts' })).toContain('BBB')
    expect(s.noteFor('read', { path: 'c/x.ts' })).toBeNull()
    expect(s.spentChars).toBeLessThanOrEqual(900)
    expect(s.spentChars).toBeGreaterThan(600)
  })

  it('a budget-skipped file is not retried on every later tool call', () => {
    let reads = 0
    const fs: ScopedRulesFs = {
      exists: (path) => path === p('big', 'AGENTS.md'),
      read: () => { reads++; return 'B'.repeat(400) },
    }
    const s = new ScopedRulesSession({ workspaceRoot: ROOT, fs, budgetChars: 10 })
    expect(s.noteFor('read', { path: 'big/one.ts' })).toBeNull()
    expect(s.noteFor('read', { path: 'big/two.ts' })).toBeNull()
    expect(s.noteFor('read', { path: 'big/three.ts' })).toBeNull()
    expect(reads).toBe(1)
  })
})
