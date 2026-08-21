// apps/desktop/test/unit/tachi-tools.test.ts
//
// Integration test for the TACHI toolset against a REAL temp workspace (real
// fs + real child_process — no LLM, no electron, no mocks). This is the
// business end of the harness: the tools that actually do the work. It proves
// the sandbox, file ops, edit cascade, bash, grep and glob all function and
// that path-escape is refused — the runtime behavior a green build alone can't
// prove.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeTool, type ToolContext } from '../../electron/services/tachi/tools'
import { CompactedStore } from '@tachi/core'

// A CI runner spawning a real shell — under a virus scanner on windows-latest —
// routinely needs more than vitest's 5s default, and a test that times out while
// its child is still alive turns the next test's temp-directory cleanup into
// EBUSY. The allowance is per file on purpose: raising it globally was measured
// to break four sd/media suites that share real temp directories.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let ws: string
let ctx: ToolContext

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'tachi-tools-'))
  ctx = { workspaceRoot: ws }
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('TACHI tools — real workspace', () => {
  it('write creates a file, read reads it back with line numbers', async () => {
    const w = await executeTool('write', { path: 'hello.txt', content: 'line one\nline two' }, ctx)
    expect(w.isError).toBe(false)
    expect(existsSync(join(ws, 'hello.txt'))).toBe(true)

    const r = await executeTool('read', { path: 'hello.txt' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.output).toContain('line one')
    expect(r.output).toContain('line two')
    expect(r.output).toMatch(/^\s*1\t/) // cat -n style numbering
  })

  it('edit replaces an exact unique snippet via the cascade', async () => {
    writeFileSync(join(ws, 'code.ts'), 'const a = 1\nconst b = 2\n')
    const e = await executeTool('edit', { path: 'code.ts', oldString: 'const b = 2', newString: 'const b = 99' }, ctx)
    expect(e.isError).toBe(false)
    expect(readFileSync(join(ws, 'code.ts'), 'utf8')).toBe('const a = 1\nconst b = 99\n')
  })

  it('edit reports multiple-matches with an actionable hint instead of corrupting', async () => {
    writeFileSync(join(ws, 'dup.txt'), 'x\nx\n')
    const e = await executeTool('edit', { path: 'dup.txt', oldString: 'x', newString: 'y' }, ctx)
    expect(e.isError).toBe(true)
    expect(e.output.toLowerCase()).toContain('multiple')
    // file untouched on failure
    expect(readFileSync(join(ws, 'dup.txt'), 'utf8')).toBe('x\nx\n')
  })

  it('read returns an error (not a throw) for a missing file', async () => {
    const r = await executeTool('read', { path: 'nope.txt' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.output).toContain('not found')
  })

  it('grep finds matching lines with file:line prefixes', async () => {
    mkdirSync(join(ws, 'src'))
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const TARGET = 1\nconst other = 2\n')
    writeFileSync(join(ws, 'src', 'b.ts'), 'import { TARGET } from "./a"\n')
    const g = await executeTool('grep', { pattern: 'TARGET' }, ctx)
    expect(g.isError).toBe(false)
    expect(g.output).toContain('src/a.ts:1:')
    expect(g.output).toContain('src/b.ts:1:')
  })

  it('glob finds files by pattern over workspace-relative paths', async () => {
    mkdirSync(join(ws, 'src', 'deep'), { recursive: true })
    writeFileSync(join(ws, 'src', 'a.ts'), '')
    writeFileSync(join(ws, 'src', 'deep', 'b.ts'), '')
    writeFileSync(join(ws, 'readme.md'), '')
    const g = await executeTool('glob', { pattern: '**/*.ts' }, ctx)
    expect(g.isError).toBe(false)
    expect(g.output).toContain('src/a.ts')
    expect(g.output).toContain('src/deep/b.ts')
    expect(g.output).not.toContain('readme.md')
  })

  it('bash runs a command in the workspace and returns output', async () => {
    // Use a cross-platform echo that both /bin/sh and PowerShell handle.
    const b = await executeTool('bash', { command: 'echo tachi-ok' }, ctx)
    expect(b.isError).toBe(false)
    expect(b.output).toContain('tachi-ok')
    expect(b.output).toContain('Exit code: 0')
  })

  it('refuses to write outside the workspace (sandbox escape)', async () => {
    const e = await executeTool('write', { path: '../escape.txt', content: 'nope' }, ctx)
    expect(e.isError).toBe(true)
    expect(e.output.toLowerCase()).toContain('escape')
    expect(existsSync(join(ws, '..', 'escape.txt'))).toBe(false)
  })

  it('unknown tool name returns an error, never throws', async () => {
    const r = await executeTool('frobnicate', {}, ctx)
    expect(r.isError).toBe(true)
    expect(r.output).toContain('Unknown tool')
  })

  describe('blast_radius', () => {
    it('reports every file that transitively imports the changed file', async () => {
      mkdirSync(join(ws, 'src'), { recursive: true })
      writeFileSync(join(ws, 'src', 'a.ts'), `import { b } from './b'\nexport const a = b`)
      writeFileSync(join(ws, 'src', 'b.ts'), `import { c } from './c'\nexport const b = c`)
      writeFileSync(join(ws, 'src', 'c.ts'), `export const c = 1`)

      const r = await executeTool('blast_radius', { path: 'src/c.ts' }, ctx)
      expect(r.isError).toBe(false)
      expect(r.output).toContain('src/a.ts')
      expect(r.output).toContain('src/b.ts')
      expect(r.output).toContain('2 file(s)')
    })

    it('says so when nothing imports the file (a leaf)', async () => {
      writeFileSync(join(ws, 'lonely.ts'), 'export const x = 1')
      const r = await executeTool('blast_radius', { path: 'lonely.ts' }, ctx)
      expect(r.isError).toBe(false)
      expect(r.output).toMatch(/no file imports/i)
    })

    it('reports a non-source path as not indexed instead of erroring', async () => {
      writeFileSync(join(ws, 'notes.md'), '# hi')
      const r = await executeTool('blast_radius', { path: 'notes.md' }, ctx)
      expect(r.isError).toBe(false)
      expect(r.output).toMatch(/not an indexed source file/i)
    })
  })

  describe('find_references', () => {
    it('lists every file that imports a symbol (incl. renamed imports)', async () => {
      mkdirSync(join(ws, 'src'), { recursive: true })
      writeFileSync(join(ws, 'src', 'm.ts'), `export const TARGET = 1`)
      writeFileSync(join(ws, 'src', 'a.ts'), `import { TARGET } from './m'\nconsole.log(TARGET)`)
      writeFileSync(join(ws, 'src', 'b.ts'), `import { TARGET as T } from './m'\nconsole.log(T)`)
      const r = await executeTool('find_references', { name: 'TARGET' }, ctx)
      expect(r.isError).toBe(false)
      expect(r.output).toContain('src/a.ts')
      expect(r.output).toContain('src/b.ts')
      expect(r.output).toContain('2 file(s)')
    })

    it('says so when nothing imports the symbol', async () => {
      writeFileSync(join(ws, 'lonely.ts'), 'export const NOBODY = 1')
      const r = await executeTool('find_references', { name: 'NOBODY' }, ctx)
      expect(r.isError).toBe(false)
      expect(r.output).toMatch(/no file imports/i)
    })
  })

  describe('find_callers', () => {
    it('lists call sites of a function with the enclosing caller', async () => {
      mkdirSync(join(ws, 'src'), { recursive: true })
      writeFileSync(join(ws, 'src', 'a.ts'), `function helper() { return 1 }\nfunction main() {\n  helper()\n}`)
      const r = await executeTool('find_callers', { name: 'helper' }, ctx)
      expect(r.isError).toBe(false)
      expect(r.output).toContain('src/a.ts:3')
      expect(r.output).toContain('main() calls helper()')
    })

    it('says so when the function is never called', async () => {
      writeFileSync(join(ws, 'z.ts'), 'export function unused() { return 2 }')
      const r = await executeTool('find_callers', { name: 'unused' }, ctx)
      expect(r.isError).toBe(false)
      expect(r.output).toMatch(/no call sites/i)
    })
  })

  describe('CCR reversible compaction', () => {
    const bigOutputCmd = process.platform === 'win32'
      ? `1..300 | % { "row $_" }`
      : `for i in $(seq 300); do echo "row $i"; done`

    it('expand_compacted reads back a stored full output', async () => {
      const store = new CompactedStore()
      const id = store.save('FULL OUTPUT LINE A\nFULL OUTPUT LINE B')
      const c: ToolContext = { workspaceRoot: ws, compacted: store }
      const r = await executeTool('expand_compacted', { id }, c)
      expect(r.isError).toBe(false)
      expect(r.output).toContain('FULL OUTPUT LINE A')
      expect(r.output).toContain('FULL OUTPUT LINE B')
    })

    it('expand_compacted reports an unknown/evicted id gracefully (no throw)', async () => {
      const c: ToolContext = { workspaceRoot: ws, compacted: new CompactedStore() }
      const r = await executeTool('expand_compacted', { id: 'nope' }, c)
      expect(r.isError).toBe(false)
      expect(r.output).toMatch(/no stored output/i)
    })

    it('bash elides large output with a receipt, and expand recovers the elided middle', async () => {
      const c: ToolContext = { workspaceRoot: ws, compacted: new CompactedStore() }
      const b = await executeTool('bash', { command: bigOutputCmd }, c)
      expect(b.isError).toBe(false)
      expect(b.output).toContain('expand_compacted')   // receipt present
      expect(b.output).not.toContain('row 150')         // a low-signal middle line was elided
      const id = /expand_compacted\(\{ id: "([^"]+)" \}\)/.exec(b.output)?.[1]
      expect(id).toBeTruthy()
      const e = await executeTool('expand_compacted', { id: id! }, c)
      expect(e.isError).toBe(false)
      expect(e.output).toContain('row 150')             // full output recovered on demand
    })

    it('without a store, bash still works and omits the receipt', async () => {
      const b = await executeTool('bash', { command: bigOutputCmd }, ctx) // ctx has no store
      expect(b.isError).toBe(false)
      expect(b.output).not.toContain('expand_compacted')
    })
  })
})
