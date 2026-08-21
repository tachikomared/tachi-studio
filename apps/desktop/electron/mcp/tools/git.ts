// apps/desktop/electron/mcp/tools/git.ts
//
// Git tools for the in-process MCP server. All run with cwd = workspaceRoot()
// so they implicitly inherit the user's gitconfig (identity, signing, etc).
// Each tool wraps `git` via child_process.execFile — we never invoke a shell,
// so quoting / injection isn't a concern.
//
// Tools:
//   git_status      — porcelain v2 parse → { branch, files: [{path, x, y}], ahead, behind }
//   git_diff        — diff against an optional range (default HEAD)
//   git_commit      — stages (selected files or `-A`) + commits
//   git_log_search  — search commit messages and touched paths

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { recordActivity } from '../activity'
import { sanitizeName } from '../sanitize'
import type { ToolRegistry } from '../registry'
import { assertString, optionalString } from './args'

const execFileP = promisify(execFile)

export interface GitDeps {
  workspaceRoot: () => string
}


function optionalNumber(args: unknown, field: string): number | undefined {
  const v = (args as Record<string, unknown> | null | undefined)?.[field]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number') throw new Error(`${field} must be a number when provided`)
  return v
}

async function git(cwd: string, args: string[], opts?: { maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd,
      maxBuffer: opts?.maxBuffer ?? 16 * 1024 * 1024,
      windowsHide: true,
    })
    return { stdout, stderr }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number }
    const msg = err.stderr?.trim() || err.message
    throw new Error(`git ${args[0]} failed: ${msg}`)
  }
}

export function register(registry: ToolRegistry, deps: GitDeps): void {
  // ── git_status ─────────────────────────────────────────────────────────────
  registry.set('git_status', {
    description: 'Parsed `git status --porcelain=v2 --branch`. Returns current branch, ahead/behind, and per-file XY codes.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const cwd = deps.workspaceRoot()
      const { stdout } = await git(cwd, ['status', '--porcelain=v2', '--branch', '-z'])
      // -z gives NUL-separated records (preserves filenames containing newlines).
      const records = stdout.split('\0').filter(Boolean)
      let branch: string | null = null
      let upstream: string | null = null
      let ahead = 0
      let behind = 0
      const files: Array<{ path: string; x: string; y: string }> = []

      for (const rec of records) {
        if (rec.startsWith('# branch.head ')) branch = rec.slice('# branch.head '.length)
        else if (rec.startsWith('# branch.upstream ')) upstream = rec.slice('# branch.upstream '.length)
        else if (rec.startsWith('# branch.ab ')) {
          const m = rec.match(/\+(\-?\d+) \-(\-?\d+)/)
          if (m) { ahead = parseInt(m[1] ?? '0', 10); behind = parseInt(m[2] ?? '0', 10) }
        } else if (rec.startsWith('1 ') || rec.startsWith('2 ')) {
          // Porcelain v2 layout (without -z, single line per record):
          //   '1 XY sub mH mI mW hH hI <path>'                — 8 space-fields then path
          //   '2 XY sub mH mI mW hH hI X<score> <path>\t<origPath>' — 9 space-fields then path
          // Paths may contain spaces — split-by-' '.pop() is wrong for those.
          // Count headerFields space-separated tokens then take the remainder.
          const isRename = rec.startsWith('2 ')
          const headerFields = isRename ? 9 : 8
          let cursor = 0
          for (let n = 0; n < headerFields; n++) {
            const sp = rec.indexOf(' ', cursor)
            if (sp < 0) { cursor = -1; break }
            cursor = sp + 1
          }
          const xy = rec.slice(2, 4)
          let path = ''
          if (cursor >= 0) {
            const rest = rec.slice(cursor)
            // Rename records put origPath after a TAB. We only surface the new path.
            const tab = rest.indexOf('\t')
            path = tab >= 0 ? rest.slice(0, tab) : rest
          }
          files.push({ path, x: xy[0] ?? '?', y: xy[1] ?? '?' })
        } else if (rec.startsWith('? ')) {
          files.push({ path: rec.slice(2), x: '?', y: '?' })
        }
      }
      return {
        branch:   branch   !== null ? sanitizeName(branch)   : null,
        upstream: upstream !== null ? sanitizeName(upstream) : null,
        ahead, behind,
        files: files.map(f => ({ ...f, path: sanitizeName(f.path) })),
      }
    },
  })

  // ── git_diff ───────────────────────────────────────────────────────────────
  registry.set('git_diff', {
    description: 'Run `git diff [range] -- [paths]`. Output is capped at 256 KiB; pass a tighter range/path if truncated.',
    schema: {
      type: 'object',
      properties: {
        range:  { type: 'string', description: 'e.g. "HEAD", "main..HEAD", "<commit>". Default: working tree vs HEAD.' },
        paths:  { type: 'array', items: { type: 'string' }, description: 'Restrict to these paths.' },
        cached: { type: 'boolean', description: 'Diff index (staged) instead of working tree.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const cwd = deps.workspaceRoot()
      const range = optionalString(args, 'range')
      const cached = !!(args as { cached?: boolean })?.cached
      const paths = ((args as { paths?: unknown })?.paths as string[] | undefined) ?? []
      if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string')) {
        throw new Error('paths must be a string array')
      }
      const gitArgs = ['diff']
      if (cached) gitArgs.push('--cached')
      if (range) gitArgs.push(range)
      if (paths.length > 0) { gitArgs.push('--'); gitArgs.push(...paths) }
      const { stdout } = await git(cwd, gitArgs)
      const CAP = 256 * 1024
      const truncated = stdout.length > CAP
      return { diff: truncated ? stdout.slice(0, CAP) : stdout, truncated, bytes: stdout.length }
    },
  })

  // ── git_commit ─────────────────────────────────────────────────────────────
  registry.set('git_commit', {
    description: 'Stage files (default: all changes) then commit with message. Respects user.name/user.email from gitconfig. Returns the new commit SHA.',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        files:   { type: 'array', items: { type: 'string' }, description: 'If omitted, stages all working-tree changes (-A).' },
      },
      required: ['message'],
      additionalProperties: false,
    },
    handler: async (args, actor) => {
      const cwd = deps.workspaceRoot()
      const message = assertString(args, 'message')
      const files = ((args as { files?: unknown })?.files as string[] | undefined)
      if (files !== undefined && (!Array.isArray(files) || files.some(p => typeof p !== 'string'))) {
        throw new Error('files must be a string array when provided')
      }

      if (files && files.length > 0) {
        await git(cwd, ['add', '--', ...files])
      } else {
        await git(cwd, ['add', '-A'])
      }

      await git(cwd, ['commit', '-m', message])
      const { stdout: sha } = await git(cwd, ['rev-parse', 'HEAD'])
      const shaTrim = sha.trim()
      recordActivity({
        actor, tool: 'git_commit', target: sanitizeName(message.split('\n')[0] ?? '(empty)', 80),
        detail: { sha: shaTrim },
      })
      return { sha: shaTrim, message }
    },
  })

  // ── git_log_search ─────────────────────────────────────────────────────────
  registry.set('git_log_search', {
    description: 'Search commit subjects and paths. Returns up to `limit` (default 50, max 100) matching commits.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to grep in commit messages and touched paths.' },
        limit: { type: 'integer', description: 'Max commits to return (default 50, max 100).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cwd = deps.workspaceRoot()
      const query = assertString(args, 'query')
      const limitRaw = optionalNumber(args, 'limit') ?? 50
      const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)))

      // First: commits whose subject/body matches --grep.
      // Second: commits whose touched paths match (re-query log filtered by paths).
      const FMT = '%H%x09%an%x09%at%x09%s'
      const { stdout: grepOut } = await git(cwd, [
        'log', `--max-count=${limit}`, `--grep=${query}`, `--format=${FMT}`,
      ])
      const seen = new Map<string, { sha: string; author: string; ts: number; subject: string; matchedBy: 'grep' | 'path' }>()
      for (const line of grepOut.split('\n').filter(Boolean)) {
        const [sha, author, ts, subject] = line.split('\t')
        if (sha) seen.set(sha, { sha, author: sanitizeName(author ?? '', 100), ts: parseInt(ts ?? '0', 10), subject: sanitizeName(subject ?? '', 200), matchedBy: 'grep' })
      }

      if (seen.size < limit) {
        // Path search — run as separate pass. We use `--all-match -- <pathspec>`-style only
        // if it looks like a path, otherwise we skip path search (too noisy).
        const looksLikePath = /[\/.]/.test(query) || query.length >= 3
        if (looksLikePath) {
          try {
            const { stdout: pathOut } = await git(cwd, [
              'log', `--max-count=${limit}`, `--format=${FMT}`, '--', `*${query}*`,
            ])
            for (const line of pathOut.split('\n').filter(Boolean)) {
              if (seen.size >= limit) break
              const [sha, author, ts, subject] = line.split('\t')
              if (sha && !seen.has(sha)) {
                seen.set(sha, { sha, author: sanitizeName(author ?? '', 100), ts: parseInt(ts ?? '0', 10), subject: sanitizeName(subject ?? '', 200), matchedBy: 'path' })
              }
            }
          } catch { /* path query is best-effort */ }
        }
      }

      const commits = Array.from(seen.values()).sort((a, b) => b.ts - a.ts).slice(0, limit)
      return { query, commits, truncated: commits.length >= limit }
    },
  })
}
