// apps/desktop/test/unit/mcpFsTools.test.ts
//
// Integration test for the in-process MCP filesystem tools against a REAL temp
// workspace (real fs + real crypto + the real path sandbox — no electron, no
// MCP server, no mocks). The tool handlers are not exported individually, but
// register(registry, deps) IS exported and the registry is a plain Map, so we
// drive each handler exactly the way the MCP server does: register into a fresh
// registry and pull the handler out by name (same pattern as
// mcpFetchSandbox.test.ts).
//
// Covers the read/write/list/search/apply_diff happy paths AND — the part a
// green build cannot prove — the path sandbox: '..' traversal, absolute paths
// outside the root, NUL bytes, and symlink escape are all refused at the
// boundary before they reach an fs syscall.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
} from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import { register, type FsDeps } from '../../electron/mcp/tools/fs'
import { newRegistry, type ToolHandler } from '../../electron/mcp/registry'
import { resolveInside, SandboxViolation } from '../../electron/mcp/sandbox'

// ── harness ──────────────────────────────────────────────────────────────────

let ws: string
let outsideDir: string
let handlers: Record<string, ToolHandler>

function call(tool: string, args: unknown): Promise<unknown> {
  const h = handlers[tool]
  if (!h) throw new Error(`tool not registered: ${tool}`)
  return h(args, 'test')
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

// Probe once: can this host create a file symlink? Windows without developer
// mode / SeCreateSymbolicLinkPrivilege throws EPERM, in which case the
// symlink-escape case is skipped (the '..'/absolute cases still exercise the
// sandbox boundary).
function symlinksSupported(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'mcpfs-symprobe-'))
  try {
    const target = join(probe, 'target.txt')
    writeFileSync(target, 'x')
    symlinkSync(target, join(probe, 'link'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
const SYMLINKS_OK = symlinksSupported()

beforeEach(() => {
  // outsideDir is a SIBLING of ws (not nested) — the canonical escape target.
  const base = mkdtempSync(join(tmpdir(), 'mcpfs-'))
  ws = join(base, 'workspace')
  outsideDir = join(base, 'outside')
  mkdirSync(ws, { recursive: true })
  mkdirSync(outsideDir, { recursive: true })

  const registry = newRegistry()
  const deps: FsDeps = { workspaceRoot: () => ws }
  register(registry, deps)
  handlers = {}
  for (const [name, def] of registry) handlers[name] = def.handler
})

afterEach(() => {
  // base is the parent of both ws and outsideDir.
  rmSync(join(ws, '..'), { recursive: true, force: true })
})

// ── registration ──────────────────────────────────────────────────────────────

describe('mcp fs tools — registration', () => {
  it('register() wires all five tools into the registry', () => {
    for (const t of ['fs_list', 'fs_read', 'fs_write', 'fs_search', 'fs_apply_diff']) {
      expect(typeof handlers[t]).toBe('function')
    }
  })
})

// ── fs_write / fs_read round-trip ───────────────────────────────────────────────

describe('mcp fs tools — write/read round-trip', () => {
  it('writes a new file then reads identical content + sha back', async () => {
    const content = 'line one\nline two\n'
    const w = (await call('fs_write', { path: 'a/b/hello.txt', content })) as {
      path: string; sha256: string; bytes: number; created: boolean
    }
    expect(w.created).toBe(true)
    expect(w.path).toBe('a/b/hello.txt')
    expect(w.bytes).toBe(Buffer.byteLength(content, 'utf8'))
    expect(w.sha256).toBe(sha256(Buffer.from(content, 'utf8')))
    // mkdir recursive really created the nested dirs on disk.
    expect(existsSync(join(ws, 'a', 'b', 'hello.txt'))).toBe(true)

    const r = (await call('fs_read', { path: 'a/b/hello.txt' })) as {
      path: string; content: string; sha256: string; bytes: number; truncated: boolean
    }
    expect(r.content).toBe(content)
    expect(r.sha256).toBe(w.sha256)
    expect(r.truncated).toBe(false)
    expect(r.bytes).toBe(w.bytes)
  })

  it('writes atomically and leaves no .tmp sidecar behind', async () => {
    await call('fs_write', { path: 'atomic.txt', content: 'data' })
    expect(existsSync(join(ws, 'atomic.txt'))).toBe(true)
    expect(existsSync(join(ws, 'atomic.txt.tachi-mcp.tmp'))).toBe(false)
  })

  it('refuses to overwrite an existing file without expectedSha256', async () => {
    await call('fs_write', { path: 'f.txt', content: 'v1' })
    await expect(call('fs_write', { path: 'f.txt', content: 'v2' })).rejects.toThrow(
      /file exists; pass expectedSha256/,
    )
    // original untouched
    expect(readFileSync(join(ws, 'f.txt'), 'utf8')).toBe('v1')
  })

  it('overwrites when the correct expectedSha256 is supplied', async () => {
    await call('fs_write', { path: 'f.txt', content: 'v1' })
    const expectedSha256 = sha256(Buffer.from('v1', 'utf8'))
    const w = (await call('fs_write', {
      path: 'f.txt',
      content: 'v2',
      expectedSha256,
    })) as { created: boolean }
    expect(w.created).toBe(false)
    expect(readFileSync(join(ws, 'f.txt'), 'utf8')).toBe('v2')
  })

  it('rejects a stale expectedSha256 (optimistic-concurrency mismatch)', async () => {
    await call('fs_write', { path: 'f.txt', content: 'v1' })
    await expect(
      call('fs_write', { path: 'f.txt', content: 'v2', expectedSha256: 'deadbeef' }),
    ).rejects.toThrow(/expectedSha256 mismatch/)
    expect(readFileSync(join(ws, 'f.txt'), 'utf8')).toBe('v1')
  })

  it('fs_read truncates files larger than 256 KiB and flags truncated', async () => {
    const big = 'x'.repeat(256 * 1024 + 50)
    writeFileSync(join(ws, 'big.txt'), big)
    const r = (await call('fs_read', { path: 'big.txt' })) as {
      content: string; bytes: number; truncated: boolean; sha256: string
    }
    expect(r.truncated).toBe(true)
    expect(r.content.length).toBe(256 * 1024)
    expect(r.bytes).toBe(big.length) // reported byte count is the FULL size
    expect(r.sha256).toBe(sha256(Buffer.from(big, 'utf8'))) // hash is over full bytes
  })

  it('fs_read throws on a directory (not a file)', async () => {
    mkdirSync(join(ws, 'adir'))
    await expect(call('fs_read', { path: 'adir' })).rejects.toThrow(/not a file/)
  })

  it('fs_write requires content to be a string', async () => {
    await expect(call('fs_write', { path: 'x.txt' })).rejects.toThrow(/content must be a string/)
  })
})

// ── fs_list ──────────────────────────────────────────────────────────────────

describe('mcp fs tools — fs_list', () => {
  it('lists files and sub-directories with type + size', async () => {
    writeFileSync(join(ws, 'file.txt'), 'hello')
    mkdirSync(join(ws, 'sub'))
    const res = (await call('fs_list', {})) as {
      path: string
      entries: Array<{ name: string; type: string; size?: number }>
    }
    expect(res.path).toBe('.')
    const byName = Object.fromEntries(res.entries.map((e) => [e.name, e]))
    expect(byName['file.txt']?.type).toBe('file')
    expect(byName['file.txt']?.size).toBe(5)
    expect(byName['sub']?.type).toBe('dir')
  })

  it('lists a sub-path', async () => {
    mkdirSync(join(ws, 'sub'))
    writeFileSync(join(ws, 'sub', 'nested.txt'), 'n')
    const res = (await call('fs_list', { path: 'sub' })) as {
      path: string; entries: Array<{ name: string }>
    }
    expect(res.path).toBe('sub')
    expect(res.entries.map((e) => e.name)).toContain('nested.txt')
  })
})

// ── fs_search ────────────────────────────────────────────────────────────────

describe('mcp fs tools — fs_search', () => {
  it('finds a regex match and reports path + 1-based line', async () => {
    writeFileSync(join(ws, 'code.ts'), 'const x = 1\nconst needle = 2\nconst y = 3\n')
    const res = (await call('fs_search', { pattern: 'needle' })) as {
      hits: Array<{ path: string; line: number; text: string }>; truncated: boolean
    }
    expect(res.truncated).toBe(false)
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0]?.path).toBe('code.ts')
    expect(res.hits[0]?.line).toBe(2)
    expect(res.hits[0]?.text).toContain('needle')
  })

  it('honours ignoreCase', async () => {
    writeFileSync(join(ws, 'c.txt'), 'HELLO WORLD\n')
    const sensitive = (await call('fs_search', { pattern: 'hello' })) as { hits: unknown[] }
    expect(sensitive.hits).toHaveLength(0)
    const insensitive = (await call('fs_search', { pattern: 'hello', ignoreCase: true })) as {
      hits: unknown[]
    }
    expect(insensitive.hits).toHaveLength(1)
  })

  it('skips ignored directories like node_modules', async () => {
    mkdirSync(join(ws, 'node_modules'))
    writeFileSync(join(ws, 'node_modules', 'dep.js'), 'TARGETSTRING\n')
    writeFileSync(join(ws, 'src.js'), 'TARGETSTRING\n')
    const res = (await call('fs_search', { pattern: 'TARGETSTRING' })) as {
      hits: Array<{ path: string }>
    }
    expect(res.hits).toHaveLength(1)
    expect(res.hits[0]?.path).toBe('src.js')
  })

  it('rejects an invalid regex with a helpful message', async () => {
    await expect(call('fs_search', { pattern: '(' })).rejects.toThrow(/invalid regex/)
  })

  it('strips control chars from result text (no forged rows / ANSI escapes)', async () => {
    // A line whose content embeds a NUL + DEL + an ANSI escape sequence.
    writeFileSync(join(ws, 'evil.txt'), 'MATCH\x00\x07\x1b[31mred\x7f\n')
    const res = (await call('fs_search', { pattern: 'MATCH' })) as {
      hits: Array<{ text: string }>
    }
    expect(res.hits).toHaveLength(1)
    const text = res.hits[0]!.text
    expect(text).not.toMatch(/[\x00-\x1f\x7f]/)
    expect(text).toContain('MATCH')
  })
})

// ── fs_apply_diff ─────────────────────────────────────────────────────────────

describe('mcp fs tools — fs_apply_diff', () => {
  it('replaces a unique substring and reports before/after hashes', async () => {
    const before = 'const a = 1\nconst b = 2\n'
    writeFileSync(join(ws, 'code.ts'), before)
    const res = (await call('fs_apply_diff', {
      path: 'code.ts',
      find: 'const b = 2',
      replace: 'const b = 99',
    })) as { sha256Before: string; sha256After: string; bytesAfter: number }
    const after = 'const a = 1\nconst b = 99\n'
    expect(readFileSync(join(ws, 'code.ts'), 'utf8')).toBe(after)
    expect(res.sha256Before).toBe(sha256(before))
    expect(res.sha256After).toBe(sha256(after))
    expect(res.bytesAfter).toBe(Buffer.byteLength(after, 'utf8'))
  })

  it('refuses an ambiguous (multi-match) edit and leaves the file untouched', async () => {
    const before = 'x\nx\n'
    writeFileSync(join(ws, 'dup.txt'), before)
    await expect(
      call('fs_apply_diff', { path: 'dup.txt', find: 'x', replace: 'y' }),
    ).rejects.toThrow(/matches 2 times/)
    expect(readFileSync(join(ws, 'dup.txt'), 'utf8')).toBe(before)
  })

  it('refuses when find is not present', async () => {
    writeFileSync(join(ws, 'f.txt'), 'hello')
    await expect(
      call('fs_apply_diff', { path: 'f.txt', find: 'absent', replace: 'z' }),
    ).rejects.toThrow(/not found/)
  })

  it('refuses an empty find', async () => {
    writeFileSync(join(ws, 'f.txt'), 'hello')
    await expect(
      call('fs_apply_diff', { path: 'f.txt', find: '', replace: 'z' }),
    ).rejects.toThrow(/non-empty/)
  })
})

// ── THE SANDBOX — the load-bearing part ───────────────────────────────────────

describe('mcp fs tools — path sandbox (resolveInside)', () => {
  it("refuses '..' traversal that escapes the root", () => {
    expect(() => resolveInside(ws, '../outside/secret.txt')).toThrow(SandboxViolation)
    expect(() => resolveInside(ws, '../../etc/passwd')).toThrow(/escapes workspaceRoot/)
  })

  it('refuses an absolute path outside the root', () => {
    const abs = join(outsideDir, 'secret.txt')
    expect(isAbsolute(abs)).toBe(true)
    expect(() => resolveInside(ws, abs)).toThrow(SandboxViolation)
  })

  it('refuses a sibling that merely shares the root as a string prefix', () => {
    // ws is `<base>/workspace`; `<base>/workspace-evil` shares the prefix but
    // is NOT contained. relative()-based containment must reject it.
    const sibling = ws + '-evil'
    expect(() => resolveInside(ws, sibling)).toThrow(SandboxViolation)
  })

  it('refuses an embedded NUL byte', () => {
    expect(() => resolveInside(ws, 'a\0b')).toThrow(/NUL byte/)
  })

  it('refuses an empty path', () => {
    expect(() => resolveInside(ws, '')).toThrow(/path is required/)
  })

  it("accepts '.' and in-root relative paths, returning an absolute path inside root", () => {
    const dot = resolveInside(ws, '.')
    expect(isAbsolute(dot)).toBe(true)
    const inside = resolveInside(ws, 'sub/dir/file.txt')
    expect(isAbsolute(inside)).toBe(true)
    expect(inside.startsWith(ws)).toBe(true)
  })

  it("a '..' path that stays inside the root is allowed", () => {
    // sub/../keep.txt normalises back to <root>/keep.txt — still contained.
    const r = resolveInside(ws, 'sub/../keep.txt')
    expect(r).toBe(join(ws, 'keep.txt'))
  })

  // The tools themselves must surface the violation, not just resolveInside.
  it('fs_read refuses a traversal path through the tool boundary', async () => {
    writeFileSync(join(outsideDir, 'secret.txt'), 'TOP SECRET')
    await expect(call('fs_read', { path: '../outside/secret.txt' })).rejects.toThrow(
      /escapes workspaceRoot/,
    )
  })

  it('fs_write refuses a traversal path and never writes outside the root', async () => {
    const escapeTarget = join(outsideDir, 'pwned.txt')
    await expect(
      call('fs_write', { path: '../outside/pwned.txt', content: 'pwned' }),
    ).rejects.toThrow(/escapes workspaceRoot/)
    expect(existsSync(escapeTarget)).toBe(false)
  })

  it('fs_list refuses a traversal path through the tool boundary', async () => {
    await expect(call('fs_list', { path: '../outside' })).rejects.toThrow(
      /escapes workspaceRoot/,
    )
  })

  it.skipIf(!SYMLINKS_OK)(
    'refuses a symlink whose target escapes the root',
    () => {
      const secret = join(outsideDir, 'secret.txt')
      writeFileSync(secret, 'TOP SECRET')
      const link = join(ws, 'escape-link')
      symlinkSync(secret, link, 'file')
      // The symlink lives INSIDE the root, but its realpath target is outside.
      expect(() => resolveInside(ws, 'escape-link')).toThrow(/symlink target escapes/)
    },
  )

  it.skipIf(!SYMLINKS_OK)(
    'fs_read refuses to follow a symlink that escapes the root',
    async () => {
      const secret = join(outsideDir, 'secret.txt')
      writeFileSync(secret, 'TOP SECRET')
      symlinkSync(secret, join(ws, 'escape-link'), 'file')
      await expect(call('fs_read', { path: 'escape-link' })).rejects.toThrow(
        /symlink target escapes/,
      )
    },
  )
})
