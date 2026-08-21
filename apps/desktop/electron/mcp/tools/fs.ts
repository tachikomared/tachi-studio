// apps/desktop/electron/mcp/tools/fs.ts
//
// File-system tools for the in-process MCP server. All operate inside
// workspaceRoot() and refuse `..` traversal via resolveInside().
//
// Tools:
//   fs_list        — directory listing
//   fs_read        — UTF-8 read, 256 KiB cap
//   fs_write       — atomic write (tmp + rename), optional optimistic-concurrency
//                    via expectedSha256
//   fs_search      — content scan, 500-hit cap, ripgrep-style regex
//   fs_apply_diff  — find/replace that refuses ambiguous matches (find must match
//                    exactly once in the target file)

import { readdir, readFile, writeFile, stat, rename, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname, relative } from 'node:path'
import { resolveInside } from '../sandbox'
import { recordActivity } from '../activity'
import { stripControl, sanitizeName } from '../sanitize'
import type { ToolRegistry } from '../registry'
import { assertString, optionalString } from './args'

const MAX_READ_BYTES = 256 * 1024
const MAX_SEARCH_HITS = 500

export interface FsDeps {
  workspaceRoot: () => string
}

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function relPath(root: string, abs: string): string {
  const r = relative(root, abs)
  return r.length === 0 ? '.' : r.split(/[\\/]/).join('/')
}


export function register(registry: ToolRegistry, deps: FsDeps): void {
  // ── fs_list ────────────────────────────────────────────────────────────────
  registry.set('fs_list', {
    description: 'List entries (files + sub-directories) inside the workspace.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative subdir; omit for root.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const root = deps.workspaceRoot()
      const sub = optionalString(args, 'path') ?? '.'
      const abs = resolveInside(root, sub)
      const dirents = await readdir(abs, { withFileTypes: true })
      const entries: Array<{ name: string; type: string; size?: number }> = []
      for (const d of dirents) {
        let size: number | undefined
        if (d.isFile()) {
          try { size = (await stat(join(abs, d.name))).size } catch { /* ignore */ }
        }
        entries.push({
          name: sanitizeName(d.name),
          type: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'symlink' : 'other',
          ...(size !== undefined ? { size } : {}),
        })
      }
      return { path: relPath(root, abs), entries }
    },
  })

  // ── fs_read ────────────────────────────────────────────────────────────────
  registry.set('fs_read', {
    description: 'Read a UTF-8 text file. Max 256 KiB; larger files are truncated.',
    schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const root = deps.workspaceRoot()
      const abs = resolveInside(root, assertString(args, 'path'))
      const st = await stat(abs)
      if (!st.isFile()) throw new Error(`not a file: ${abs}`)
      const buf = await readFile(abs)
      const truncated = buf.length > MAX_READ_BYTES
      const used = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf
      return {
        path: relPath(root, abs),
        content: used.toString('utf8'),
        sha256: sha256(buf),
        bytes: buf.length,
        truncated,
      }
    },
  })

  // ── fs_write ───────────────────────────────────────────────────────────────
  registry.set('fs_write', {
    description: 'Atomically write a file (write tmp + rename). Pass expectedSha256 of the existing file to enforce optimistic concurrency on overwrite.',
    schema: {
      type: 'object',
      properties: {
        path:            { type: 'string' },
        content:         { type: 'string' },
        expectedSha256:  { type: 'string', description: 'Required when overwriting; omit when creating.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      const root = deps.workspaceRoot()
      const abs = resolveInside(root, assertString(args, 'path'))
      const content = assertString(args, 'content')
      const expected = optionalString(args, 'expectedSha256')

      // Optimistic concurrency: refuse to overwrite unless the caller proves
      // they read the current contents (we trust the SHA they hand us).
      let existed = false
      try {
        const cur = await readFile(abs)
        existed = true
        const curSha = sha256(cur)
        if (expected === undefined) {
          throw new Error(`file exists; pass expectedSha256 (current=${curSha}) to overwrite`)
        }
        if (expected !== curSha) {
          throw new Error(`expectedSha256 mismatch: passed ${expected}, current ${curSha}`)
        }
      } catch (e) {
        // ENOENT is fine — we're creating a new file. Other errors propagate.
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && !existed) {
          // Not an "exists" branch — only ENOENT is acceptable to swallow.
          if (code !== 'ENOENT') throw e
        }
        if (existed) throw e
      }

      await mkdir(dirname(abs), { recursive: true })
      const tmp = abs + '.tachi-mcp.tmp'
      await writeFile(tmp, content, { encoding: 'utf8' })
      await rename(tmp, abs)

      const newSha = sha256(Buffer.from(content, 'utf8'))
      recordActivity({ actor, tool: 'fs_write', target: relPath(root, abs), detail: { bytes: Buffer.byteLength(content, 'utf8') } })
      return { path: relPath(root, abs), sha256: newSha, bytes: Buffer.byteLength(content, 'utf8'), created: !existed }
    },
  })

  // ── fs_search ──────────────────────────────────────────────────────────────
  registry.set('fs_search', {
    description: 'Content scan (regex) across workspace files. Caps at 500 hits. Honours common ignore dirs (node_modules, .git, dist, out, build).',
    schema: {
      type: 'object',
      properties: {
        pattern:        { type: 'string', description: 'Regex (JS flavour).' },
        ignoreCase:     { type: 'boolean' },
        path:           { type: 'string', description: 'Sub-path to constrain the search; defaults to workspace root.' },
        maxFileBytes:   { type: 'integer', description: 'Skip files larger than this (default 1 MiB).' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const root = deps.workspaceRoot()
      const pattern = assertString(args, 'pattern')
      const ignoreCase = !!(args as { ignoreCase?: boolean })?.ignoreCase
      const sub = optionalString(args, 'path') ?? '.'
      const startAbs = resolveInside(root, sub)
      const maxBytes = Math.max(1024, ((args as { maxFileBytes?: number })?.maxFileBytes) ?? (1 << 20))
      let re: RegExp
      try { re = new RegExp(pattern, ignoreCase ? 'i' : '') } catch (e) {
        throw new Error(`invalid regex: ${(e as Error).message}`)
      }

      const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.turbo', '.cache', '.vscode', '.idea', 'target'])
      const hits: Array<{ path: string; line: number; text: string }> = []

      async function walk(dirAbs: string): Promise<void> {
        if (hits.length >= MAX_SEARCH_HITS) return
        let dirents
        try { dirents = await readdir(dirAbs, { withFileTypes: true }) } catch { return }
        for (const d of dirents) {
          if (hits.length >= MAX_SEARCH_HITS) return
          if (IGNORE.has(d.name)) continue
          const child = join(dirAbs, d.name)
          if (d.isDirectory()) {
            await walk(child)
          } else if (d.isFile()) {
            let st
            try { st = await stat(child) } catch { continue }
            if (st.size > maxBytes) continue
            let buf
            try { buf = await readFile(child, 'utf8') } catch { continue }
            const lines = buf.split('\n')
            for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
              if (re.test(lines[i] as string)) {
                const raw = lines[i] as string
                const text = raw.length > 240 ? raw.slice(0, 240) + '…' : raw
                hits.push({ path: sanitizeName(relPath(root, child)), line: i + 1, text: stripControl(text) })
              }
            }
          }
        }
      }

      await walk(startAbs)
      return { pattern, ignoreCase, hits, truncated: hits.length >= MAX_SEARCH_HITS }
    },
  })

  // ── fs_apply_diff ──────────────────────────────────────────────────────────
  registry.set('fs_apply_diff', {
    description: 'Replace `find` with `replace` in a file. Refuses unless `find` matches exactly once in the file (no ambiguous edits).',
    schema: {
      type: 'object',
      properties: {
        path:    { type: 'string' },
        find:    { type: 'string', description: 'Exact substring to locate. Must appear exactly once.' },
        replace: { type: 'string' },
      },
      required: ['path', 'find', 'replace'],
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      const root = deps.workspaceRoot()
      const abs = resolveInside(root, assertString(args, 'path'))
      const find = assertString(args, 'find')
      const replace = assertString(args, 'replace')
      if (find.length === 0) throw new Error('find must be non-empty')

      const before = await readFile(abs, 'utf8')

      // Count occurrences (literal substring, not regex).
      let count = 0
      let idx = 0
      while ((idx = before.indexOf(find, idx)) !== -1) { count++; idx += find.length }

      if (count === 0) throw new Error('find not found in file')
      if (count > 1) throw new Error(`find matches ${count} times; must match exactly once`)

      const next = before.replace(find, replace)
      const tmp = abs + '.tachi-mcp.tmp'
      await writeFile(tmp, next, { encoding: 'utf8' })
      await rename(tmp, abs)

      recordActivity({ actor, tool: 'fs_apply_diff', target: relPath(root, abs), detail: { findLen: find.length, replaceLen: replace.length } })
      return {
        path: relPath(root, abs),
        sha256Before: sha256(before),
        sha256After: sha256(next),
        bytesAfter: Buffer.byteLength(next, 'utf8'),
      }
    },
  })
}
