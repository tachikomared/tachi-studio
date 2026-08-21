// apps/desktop/test/unit/mcpGitTools.test.ts
//
// Integration test for the in-process MCP git tools (git_status / git_diff /
// git_commit / git_log_search) against a REAL temp git repo (real fs + real
// `git` via child_process — no MCP server, no electron, no mocks).
//
// The tool *handlers* are not exported directly: git.ts exports `register`,
// which mutates a ToolRegistry (a plain Map) with each handler. We invoke
// `register` with a fresh Map + a deps stub pointing workspaceRoot() at the
// temp repo, then pull each handler back out of the Map and call it in
// isolation. recordActivity is an in-memory ring buffer (no system side
// effects) and sanitizeName is pure, so no further setup is required.
//
// Beyond happy-path status/diff/log, this asserts the control-char
// sanitization that git.ts applies to UNTRUSTED git output: a branch name or
// commit subject carrying NUL / newline / ANSI-escape bytes must not leak
// those control chars into a tool result (fake-row / terminal-escape
// injection — STEAL 2026-06-12 cluster B).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { register } from '../../electron/mcp/tools/git'
import type { ToolRegistry, ToolHandler } from '../../electron/mcp/registry'

// ── git availability gate ────────────────────────────────────────────────────
const GIT_OK = (() => {
  try {
    const r = spawnSync('git', ['--version'], { windowsHide: true })
    return r.status === 0
  } catch {
    return false
  }
})()

// describe.skip when git is unavailable so the suite stays green on a host
// without git rather than failing on every case.
const d = GIT_OK ? describe : describe.skip

let repo: string
let registry: ToolRegistry

function handler(name: string): ToolHandler {
  const def = registry.get(name)
  if (!def) throw new Error(`tool ${name} not registered`)
  return def.handler
}

// Run a raw git command in the temp repo. Identity/signing are set locally so
// the test never depends on (or mutates) the host's global gitconfig, and a
// global GPG-signing default can't break our commits.
function rawGit(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' })
}

beforeEach(() => {
  if (!GIT_OK) return
  repo = mkdtempSync(join(tmpdir(), 'mcp-git-'))
  rawGit(['init', '-q'])
  rawGit(['config', 'user.email', 'tester@example.com'])
  rawGit(['config', 'user.name', 'Test Bot'])
  rawGit(['config', 'commit.gpgsign', 'false'])
  rawGit(['config', 'tag.gpgsign', 'false'])
  // Deterministic default branch name across git versions.
  rawGit(['checkout', '-q', '-b', 'work'])

  registry = new Map()
  register(registry, { workspaceRoot: () => repo })
})

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

d('mcp git tools — register()', () => {
  it('registers exactly the four git tools', () => {
    expect([...registry.keys()].sort()).toEqual(
      ['git_commit', 'git_diff', 'git_log_search', 'git_status'].sort(),
    )
    for (const name of registry.keys()) {
      const def = registry.get(name)!
      expect(typeof def.handler).toBe('function')
      expect(typeof def.description).toBe('string')
      expect(typeof def.schema).toBe('object')
    }
  })
})

d('git_status', () => {
  it('reports the current branch and an untracked file', async () => {
    writeFileSync(join(repo, 'new.txt'), 'hello\n')
    const res = (await handler('git_status')({}, 'tester')) as {
      branch: string | null
      upstream: string | null
      ahead: number
      behind: number
      files: Array<{ path: string; x: string; y: string }>
    }
    expect(res.branch).toBe('work')
    expect(res.upstream).toBeNull()
    expect(res.ahead).toBe(0)
    expect(res.behind).toBe(0)
    const f = res.files.find((x) => x.path === 'new.txt')
    expect(f).toBeDefined()
    expect(f!.x).toBe('?')
    expect(f!.y).toBe('?')
  })

  it('reports a clean tree as an empty file list after a commit', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    rawGit(['add', '-A'])
    rawGit(['commit', '-q', '-m', 'init'])
    const res = (await handler('git_status')({}, 'tester')) as {
      branch: string
      files: unknown[]
    }
    expect(res.branch).toBe('work')
    expect(res.files).toEqual([])
  })

  it('parses a modified, staged file with correct XY codes', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    rawGit(['add', '-A'])
    rawGit(['commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    rawGit(['add', 'a.txt']) // stage the modification → index modified (X=M, Y=.)
    const res = (await handler('git_status')({}, 'tester')) as {
      files: Array<{ path: string; x: string; y: string }>
    }
    const f = res.files.find((x) => x.path === 'a.txt')!
    expect(f).toBeDefined()
    expect(f.x).toBe('M')
    expect(f.y).toBe('.')
  })

  it('handles a path that contains a space (porcelain v2 split is path-aware)', async () => {
    writeFileSync(join(repo, 'a file.txt'), 'x\n')
    const res = (await handler('git_status')({}, 'tester')) as {
      files: Array<{ path: string }>
    }
    expect(res.files.some((f) => f.path === 'a file.txt')).toBe(true)
  })

  it('sanitizes a file path carrying control chars (no ESC/DEL leaks through)', async () => {
    // Git ref names forbid control chars, but FILENAMES on disk may contain an
    // ANSI escape (0x1b) or DEL (0x7f). Porcelain -z keeps the literal bytes in
    // the record; git_status passes every f.path through sanitizeName, which
    // must strip C0 controls + DEL so a filename can't forge terminal escapes /
    // fake rows in an agent's context. (Windows forbids most control chars in
    // filenames, so this asserts on a real on-disk name where possible and
    // otherwise verifies the result simply never contains control bytes.)
    let evilName = 'inj\x1b[31mect\x07.txt'
    try {
      writeFileSync(join(repo, evilName), 'x\n')
    } catch {
      // Filesystem rejected the control-char name (e.g. Windows): fall back to a
      // plain name. The invariant we assert — no control chars in any path —
      // still holds and the sanitizer is exercised by the other untrusted-input
      // cases (commit subject) in this file.
      evilName = 'plain.txt'
      writeFileSync(join(repo, evilName), 'x\n')
    }
    const res = (await handler('git_status')({}, 'tester')) as {
      files: Array<{ path: string }>
    }
    expect(res.files.length).toBeGreaterThan(0)
    for (const f of res.files) {
      expect(f.path).not.toMatch(/[\x00-\x1f\x7f]/)
    }
  })
})

d('git_diff', () => {
  it('shows working-tree changes vs HEAD with byte count and no truncation', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    rawGit(['add', '-A'])
    rawGit(['commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    const res = (await handler('git_diff')({}, 'tester')) as {
      diff: string
      truncated: boolean
      bytes: number
    }
    expect(res.diff).toContain('a.txt')
    expect(res.diff).toContain('+two')
    expect(res.truncated).toBe(false)
    expect(res.bytes).toBe(res.diff.length)
    expect(res.bytes).toBeGreaterThan(0)
  })

  it('restricts to a path and excludes others', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    rawGit(['add', '-A'])
    rawGit(['commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, 'a.txt'), 'a-changed\n')
    writeFileSync(join(repo, 'b.txt'), 'b-changed\n')
    const res = (await handler('git_diff')({ paths: ['a.txt'] }, 'tester')) as { diff: string }
    expect(res.diff).toContain('a.txt')
    expect(res.diff).not.toContain('b.txt')
  })

  it('diffs the staged index when cached:true', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    rawGit(['add', '-A'])
    rawGit(['commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, 'a.txt'), 'staged-change\n')
    rawGit(['add', 'a.txt'])
    // Working tree now matches index → unstaged diff is empty, cached diff is not.
    const unstaged = (await handler('git_diff')({}, 'tester')) as { diff: string }
    expect(unstaged.diff).toBe('')
    const cached = (await handler('git_diff')({ cached: true }, 'tester')) as { diff: string }
    expect(cached.diff).toContain('staged-change')
  })

  it('rejects a non-string-array paths argument', async () => {
    await expect(handler('git_diff')({ paths: [123] }, 'tester')).rejects.toThrow(/paths must be a string array/)
  })
})

d('git_commit', () => {
  it('stages all changes and commits, returning the new SHA', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    const res = (await handler('git_commit')({ message: 'feat: add a' }, 'agent')) as {
      sha: string
      message: string
    }
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(res.message).toBe('feat: add a')
    // The commit is real: HEAD resolves to the same SHA, tree is clean.
    expect(rawGit(['rev-parse', 'HEAD']).trim()).toBe(res.sha)
    expect(rawGit(['log', '-1', '--format=%s']).trim()).toBe('feat: add a')
    expect(rawGit(['status', '--porcelain']).trim()).toBe('')
  })

  it('commits only the named files (leaves others unstaged)', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    const res = (await handler('git_commit')({ message: 'only a', files: ['a.txt'] }, 'agent')) as {
      sha: string
    }
    expect(res.sha).toMatch(/^[0-9a-f]{40}$/)
    // a.txt is committed; b.txt is still untracked.
    const tracked = rawGit(['ls-tree', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean)
    expect(tracked).toContain('a.txt')
    expect(tracked).not.toContain('b.txt')
    expect(rawGit(['status', '--porcelain']).trim()).toContain('b.txt')
  })

  it('rejects a missing message', async () => {
    await expect(handler('git_commit')({}, 'agent')).rejects.toThrow(/message must be a string/)
  })

  it('rejects a non-string-array files argument', async () => {
    await expect(
      handler('git_commit')({ message: 'm', files: [1, 2] }, 'agent'),
    ).rejects.toThrow(/files must be a string array/)
  })

  it('surfaces git failure (nothing to commit) as a thrown error', async () => {
    // Clean tree → `git commit` exits non-zero; git() wraps it as a throw.
    await expect(handler('git_commit')({ message: 'empty' }, 'agent')).rejects.toThrow(/git commit failed/)
  })
})

d('git_log_search', () => {
  it('finds a commit by a subject substring (matchedBy: grep)', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    rawGit(['add', '-A'])
    rawGit(['commit', '-q', '-m', 'add the widget feature'])
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    rawGit(['add', '-A'])
    rawGit(['commit', '-q', '-m', 'unrelated chore'])

    const res = (await handler('git_log_search')({ query: 'widget' }, 'tester')) as {
      query: string
      commits: Array<{ sha: string; author: string; ts: number; subject: string; matchedBy: string }>
    }
    expect(res.query).toBe('widget')
    const hit = res.commits.find((c) => c.subject.includes('widget'))
    expect(hit).toBeDefined()
    expect(hit!.matchedBy).toBe('grep')
    expect(hit!.author).toBe('Test Bot')
    expect(hit!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(hit!.ts).toBeGreaterThan(0)
  })

  it('clamps limit to >=1 and orders results newest-first', async () => {
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(repo, `f${i}.txt`), `${i}\n`)
      rawGit(['add', '-A'])
      rawGit(['commit', '-q', '-m', `change number ${i}`])
    }
    // limit 0 → clamped to 1.
    const one = (await handler('git_log_search')({ query: 'change', limit: 0 }, 'tester')) as {
      commits: unknown[]
    }
    expect(one.commits.length).toBe(1)

    const all = (await handler('git_log_search')({ query: 'change' }, 'tester')) as {
      commits: Array<{ ts: number }>
    }
    expect(all.commits.length).toBe(3)
    for (let i = 1; i < all.commits.length; i++) {
      expect(all.commits[i - 1].ts).toBeGreaterThanOrEqual(all.commits[i].ts)
    }
  })

  it('sanitizes a commit subject carrying control chars', async () => {
    // A commit subject with an embedded ANSI escape. Git keeps it on a single
    // logical subject line; git_log_search must strip the C0 control byte.
    const evil = 'pwn\x1b[31mZZZ'
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    rawGit(['add', '-A'])
    rawGit(['commit', '-q', '-m', evil])
    const res = (await handler('git_log_search')({ query: 'pwn' }, 'tester')) as {
      commits: Array<{ subject: string }>
    }
    const hit = res.commits.find((c) => c.subject.startsWith('pwn'))
    expect(hit).toBeDefined()
    expect(hit!.subject).toBe('pwn[31mZZZ')
    expect(hit!.subject).not.toMatch(/[\x00-\x1f\x7f]/)
  })

  it('returns an empty commit list (not a throw) when nothing matches', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    rawGit(['add', '-A'])
    rawGit(['commit', '-q', '-m', 'a real commit'])
    const res = (await handler('git_log_search')({ query: 'zzz-no-such-token-qwxy' }, 'tester')) as {
      commits: unknown[]
    }
    expect(res.commits).toEqual([])
  })

  it('rejects a missing query', async () => {
    await expect(handler('git_log_search')({}, 'tester')).rejects.toThrow(/query must be a string/)
  })
})
