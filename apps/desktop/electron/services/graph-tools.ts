// apps/desktop/electron/services/graph-tools.ts
//
// Real tool runtime for compiled Nodes graphs. When an agent in a graph is
// wired to a Folder node (workspace) and/or an Internet node — plus a Role
// node that lists tools (Read/Write/Edit/Glob/Grep/Bash/WebFetch) — these
// factories produce actual @inngest/agent-kit tools whose handlers run in the
// Electron MAIN process (so fs + fetch are available).
//
// SECURITY (this file is the enforcement point — keep it strict):
//   - Every file path is resolved against workspaceRoot and REJECTED if it
//     escapes the sandbox (path traversal guard). No absolute paths out.
//   - `bash` runs with cwd = workspaceRoot, a hard timeout, and is gated by
//     egress-policy's PRIVATE-MODE network denylist.
//   - `web_fetch` is gated by egress-policy checkUrlEgress (PRIVATE MODE →
//     loopback only) plus an SSRF guard against private/internal hosts.
//   - `web_search` (Brave/Tavily) runs the same egress check against the fixed
//     provider API URL and wraps snippets in the prompt-injection sandbox.
//   - Tools are only built when the matching Role permission is present AND
//     (for files) a Folder node supplies the workspace root.

// R8b: agent-kit is loaded on first tool build, not at boot — same deferral as
// services/graph-to-agentkit.ts (which is this module's only importer). Leaving
// the value import here would keep the whole framework on the boot path and
// cancel that saving outright, because rollup inlines any module the entry
// chunk still reaches statically. `Tool` is a type and costs nothing.
import type { Tool } from '@inngest/agent-kit'
// IMPORTANT: build tool parameter schemas with zod's v4 API. agent-kit
// (peer dep: zod >=4) serializes them via z.toJSONSchema, which only exists in
// v4. The app pins zod 3.25 (v3 main export) but it ships the v4 API at
// 'zod/v4'. The shim below grafts v4's converter onto the shared zod instance
// so agent-kit's require('zod').z.toJSONSchema works on our schemas.
import { z, toJSONSchema as v4ToJSONSchema } from 'zod/v4'
import * as zodMain from 'zod'
import { promises as fs } from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import { checkUrlEgressSafe, checkBashCommandEgress } from './egress-policy'
import { resolveAndAssertSafe } from './ssrf-guard'
import { isDestructiveCommand } from './destructive-commands'

// ── Zod v3→v4 bridge (runs once at module load, before any tool is built) ─────
// agent-kit calls `require('zod').z.toJSONSchema(...)`. We only patch the shared
// `z` object (which IS extensible); the module namespace itself is frozen by the
// ESM interop, so we must NOT touch it. Wrapped in try/catch so a future
// zod-with-toJSONSchema (or a frozen z) can never crash app startup.
try {
  const zObj = (zodMain as unknown as { z?: Record<string, unknown> }).z
  if (zObj && typeof zObj.toJSONSchema !== 'function') {
    zObj.toJSONSchema = (schema: unknown, opts?: unknown) => {
      try {
        const out = v4ToJSONSchema(schema as never, opts as never) as Record<string, unknown>
        // Strip JSON-Schema meta keys that tool-calling APIs (esp. Anthropic via
        // Bankr) reject in a function's parameter schema: `$schema`, `$id`,
        // `$defs`/`definitions` refs are fine but the top-level `$schema` is not.
        if (out && typeof out === 'object') {
          delete out['$schema']
          delete out['$id']
        }
        return out
      } catch (e) {
        console.error('[graph:tool-schema] convert failed:', e)
        return { type: 'object', properties: {} }
      }
    }
  }
} catch { /* zod already has toJSONSchema, or z is frozen — agent-kit handles its own */ }

// Thin wrapper around createTool: our parameter schemas are zod v4 (for
// toJSONSchema), but agent-kit's .d.ts types `parameters` as a zod-v3 shape.
// Runtime is correct; this just relaxes the compile-time parameter/handler types.
/* eslint-disable @typescript-eslint/no-explicit-any */
function ct(def: {
  name: string
  description?: string
  parameters?: unknown
  handler: (input: any, opts: any) => unknown
}): Tool.Any {
  const { createTool } = require('@inngest/agent-kit') as typeof import('@inngest/agent-kit')
  return createTool(def as any) as Tool.Any
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const MAX_READ_BYTES = 256 * 1024 // 256 KB cap per read
const MAX_GREP_FILES = 2000
const BASH_TIMEOUT_MS = 20_000

// ── Sandbox helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a (possibly relative) path against the workspace root and guarantee
 * it stays inside. Returns null on any escape attempt.
 */
function safeResolve(workspaceRoot: string, rel: string): string | null {
  const root = path.resolve(workspaceRoot)
  const resolved = path.resolve(root, rel || '.')
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null
  return resolved
}

/** SSRF guard: reject internal/private hosts for web fetches (open mode). */
function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true            // link-local / cloud metadata
  if (/^(0\.0\.0\.0|::)$/.test(h)) return true
  return false
}

async function walkFiles(root: string, onFile: (abs: string) => void, limit: number): Promise<void> {
  let count = 0
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'out', '.cache'])
  async function rec(dir: string): Promise<void> {
    if (count >= limit) return
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (count >= limit) return
      if (e.name.startsWith('.') && e.name !== '.env.example') { /* skip dotfiles except a couple */ }
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue
        await rec(abs)
      } else if (e.isFile()) {
        onFile(abs)
        count++
      }
    }
  }
  await rec(root)
}

// ── Tool factory ─────────────────────────────────────────────────────────────

export interface BuildToolsOptions {
  /** Sandbox root for file tools. If absent, file tools are not built. */
  workspaceRoot?: string
  /** Lowercased Role permission names: read/write/edit/glob/grep/bash/webfetch. */
  allowed: Set<string>
  /** True when an Internet node is wired (grants web_fetch even without WebFetch role). */
  internet: boolean
}

/**
 * Build the concrete tool set for one agent based on its wired Folder/Internet
 * nodes and Role permissions. Returns [] when nothing is granted.
 */
export function buildAgentTools(opts: BuildToolsOptions): Tool.Any[] {
  const { workspaceRoot, allowed, internet } = opts
  const has = (k: string) => allowed.has(k)
  const tools: Tool.Any[] = []

  // ---- File tools (require a workspace root) -------------------------------
  if (workspaceRoot) {
    const root = workspaceRoot
    const denied = (p: string) =>
      ({ ok: false as const, error: `Path "${p}" is outside the workspace sandbox and was blocked.` })

    if (has('read')) {
      // Folder-wide MEANING search (local RAG: MiniLM embeddings + cosine, all
      // in-process). Lets an agent find the relevant part of a big workspace
      // without read_file-ing everything. First call on a folder builds the
      // index (one-time model download ~25MB, then fully offline).
      tools.push(ct({
        name: 'semantic_search',
        description: 'Search the workspace by MEANING (local embeddings). Returns the most relevant text chunks with file paths and line ranges. Use this FIRST on large workspaces instead of reading files one by one.',
        parameters: z.object({
          query: z.string().describe('What you are looking for, phrased naturally'),
          k: z.number().int().min(1).max(12).default(6).describe('How many chunks to return'),
        }),
        handler: async ({ query, k }) => {
          const { searchFolder } = await import('./rag-service')
          const r = await searchFolder(root, query, k)
          if (!r.ok) return { ok: false, error: r.error }
          return { ok: true, indexed: r.indexed, hits: r.hits }
        },
      }) as Tool.Any)

      tools.push(ct({
        name: 'read_file',
        description: 'Read a UTF-8 text file from the workspace. Path is relative to the workspace root.',
        parameters: z.object({ path: z.string().describe('Relative path to the file') }),
        handler: async ({ path: rel }) => {
          const abs = safeResolve(root, rel)
          if (!abs) return denied(rel)
          try {
            const buf = await fs.readFile(abs)
            const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8')
            return { ok: true, path: rel, truncated: buf.length > MAX_READ_BYTES, content: text }
          } catch (err) {
            return { ok: false, error: `read failed: ${err instanceof Error ? err.message : String(err)}` }
          }
        },
      }) as Tool.Any)

      tools.push(ct({
        name: 'list_dir',
        description: 'List entries in a workspace directory (relative path; "." for root).',
        parameters: z.object({ path: z.string().default('.').describe('Relative directory path') }),
        handler: async ({ path: rel }) => {
          const abs = safeResolve(root, rel || '.')
          if (!abs) return denied(rel)
          try {
            const entries = await fs.readdir(abs, { withFileTypes: true })
            return { ok: true, path: rel || '.', entries: entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)) }
          } catch (err) {
            return { ok: false, error: `list failed: ${err instanceof Error ? err.message : String(err)}` }
          }
        },
      }) as Tool.Any)
    }

    if (has('glob')) {
      tools.push(ct({
        name: 'glob',
        description: 'Find files in the workspace whose path contains a substring or matches a simple *.ext pattern.',
        parameters: z.object({ pattern: z.string().describe('e.g. ".ts", "component", "*.json"') }),
        handler: async ({ pattern }) => {
          const needle = pattern.replace(/^\*/, '').toLowerCase()
          const hits: string[] = []
          await walkFiles(root, (abs) => {
            const relp = path.relative(root, abs)
            if (relp.toLowerCase().includes(needle)) hits.push(relp)
          }, MAX_GREP_FILES)
          return { ok: true, pattern, matches: hits.slice(0, 500) }
        },
      }) as Tool.Any)
    }

    if (has('grep')) {
      tools.push(ct({
        name: 'grep',
        description: 'Search workspace file contents for a regular expression. Returns matching lines with file + line number.',
        parameters: z.object({
          pattern: z.string().describe('Regular expression'),
          glob: z.string().optional().describe('Optional path substring filter, e.g. ".ts"'),
        }),
        handler: async ({ pattern, glob }) => {
          let re: RegExp
          try { re = new RegExp(pattern, 'i') } catch { return { ok: false, error: `invalid regex: ${pattern}` } }
          const filt = (glob || '').toLowerCase()
          const results: Array<{ file: string; line: number; text: string }> = []
          const files: string[] = []
          await walkFiles(root, (abs) => {
            const relp = path.relative(root, abs)
            if (!filt || relp.toLowerCase().includes(filt)) files.push(abs)
          }, MAX_GREP_FILES)
          for (const abs of files) {
            if (results.length >= 200) break
            let content: string
            try { content = await fs.readFile(abs, 'utf8') } catch { continue }
            const lines = content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i]!)) {
                results.push({ file: path.relative(root, abs), line: i + 1, text: lines[i]!.slice(0, 240) })
                if (results.length >= 200) break
              }
            }
          }
          return { ok: true, pattern, count: results.length, matches: results }
        },
      }) as Tool.Any)
    }

    if (has('write')) {
      tools.push(ct({
        name: 'write_file',
        description: 'Create or overwrite a workspace text file. Creates parent directories as needed.',
        parameters: z.object({
          path: z.string().describe('Relative path'),
          content: z.string().describe('Full file content'),
        }),
        handler: async ({ path: rel, content }) => {
          const abs = safeResolve(root, rel)
          if (!abs) return denied(rel)
          try {
            await fs.mkdir(path.dirname(abs), { recursive: true })
            await fs.writeFile(abs, content, 'utf8')
            return { ok: true, path: rel, bytes: Buffer.byteLength(content) }
          } catch (err) {
            return { ok: false, error: `write failed: ${err instanceof Error ? err.message : String(err)}` }
          }
        },
      }) as Tool.Any)
    }

    if (has('edit') || has('multiedit')) {
      tools.push(ct({
        name: 'edit_file',
        description: 'Replace an exact string in a workspace file with a new string (first occurrence, or all).',
        parameters: z.object({
          path: z.string(),
          old_string: z.string().describe('Exact text to find'),
          new_string: z.string().describe('Replacement text'),
          replace_all: z.boolean().optional().default(false),
        }),
        handler: async ({ path: rel, old_string, new_string, replace_all }) => {
          const abs = safeResolve(root, rel)
          if (!abs) return denied(rel)
          try {
            const before = await fs.readFile(abs, 'utf8')
            if (!before.includes(old_string)) return { ok: false, error: 'old_string not found in file' }
            const after = replace_all
              ? before.split(old_string).join(new_string)
              : before.replace(old_string, new_string)
            await fs.writeFile(abs, after, 'utf8')
            return { ok: true, path: rel, replacements: replace_all ? before.split(old_string).length - 1 : 1 }
          } catch (err) {
            return { ok: false, error: `edit failed: ${err instanceof Error ? err.message : String(err)}` }
          }
        },
      }) as Tool.Any)
    }

    // bash is built ONLY when the wired Role explicitly grants it.
    if (has('bash')) {
      tools.push(ct({
        name: 'bash',
        description: 'Run a shell command in the workspace directory. Returns stdout/stderr. No network commands.',
        parameters: z.object({ command: z.string().describe('Shell command to run') }),
        handler: async ({ command }) => {
          const egress = checkBashCommandEgress(command)
          if (!egress.allowed) return { ok: false, error: egress.reason }
          // Same catastrophic-command hard-deny the first-party harness bash applies
          // (rm -rf /, disk wipe, fork bomb…) — defense-in-depth, not an OS sandbox.
          const dverdict = isDestructiveCommand(command)
          if (dverdict.destructive) return { ok: false, error: `Refused: catastrophic command blocked (${dverdict.reason ?? 'destructive'}).` }
          return await new Promise(resolve => {
            exec(command, { cwd: root, timeout: BASH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
              (err, stdout, stderr) => {
                resolve({
                  ok: !err,
                  exitCode: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0,
                  stdout: String(stdout).slice(0, 8000),
                  stderr: String(stderr).slice(0, 4000),
                  ...(err && (err as { killed?: boolean }).killed ? { timedOut: true } : {}),
                })
              })
          })
        },
      }) as Tool.Any)
    }
  }

  // ---- Web tool (Internet node, or WebFetch role) --------------------------
  if (internet || has('webfetch')) {
    tools.push(ct({
      name: 'web_fetch',
      description: 'Fetch the text content of a public URL (http/https). Returns the response body (truncated).',
      parameters: z.object({ url: z.string().describe('Absolute http(s) URL') }),
      handler: async ({ url }) => {
        // PRIVATE MODE gate (loopback-only) + always-on SSRF guard (DNS resolve
        // + non-global/encoded-IP block) — see egress-policy.checkUrlEgressSafe.
        const decision = await checkUrlEgressSafe(url)
        if (!decision.allowed) return { ok: false, error: decision.reason }
        let host = ''
        try { host = new URL(url).hostname } catch { return { ok: false, error: `invalid URL: ${url}` } }
        if (isInternalHost(host)) return { ok: false, error: `Blocked fetch to internal host "${host}".` }
        // DNS-rebind TOCTOU guard (STEAL 2026-06-12; same as mcp/tools/fetch.ts):
        // resolve+validate once, re-resolve immediately before fetch, fail closed
        // if the address set changed (a rebind that swaps to a private/loopback IP
        // between validation and connect).
        try {
          const validated = await resolveAndAssertSafe(url)
          const recheck = await resolveAndAssertSafe(url)
          if (validated.join(',') !== recheck.join(',')) {
            return { ok: false, error: `Blocked fetch: DNS for "${host}" changed between validation and fetch (possible DNS-rebind).` }
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        try {
          const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
          const text = (await res.text()).slice(0, 20_000)
          return { ok: res.ok, status: res.status, url, content: text }
        } catch (err) {
          return { ok: false, error: `fetch failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    }) as Tool.Any)

    tools.push(ct({
      name: 'web_search',
      description:
        'Search the web for current information. Returns top results with title, URL, and a short snippet. Needs a Brave or Tavily API key (Settings → Connections). Prefer this over web_fetch when you do not know the URL yet.',
      parameters: z.object({
        query: z.string().describe('Search query. Be specific.'),
        count: z.number().int().min(1).max(10).optional().describe('Number of results (default 5)'),
      }),
      handler: async ({ query, count }) => {
        const { activeWebSearchProvider, webSearch, WEB_SEARCH_PROVIDERS } = await import('./web-search-tool')
        const provider = activeWebSearchProvider()
        if (!provider) return { ok: false, error: 'No web search key set. Add a Brave or Tavily key in Settings → Connections.' }
        // PRIVATE MODE gate — same egress policy as web_fetch, checked against the
        // provider's fixed API endpoint (no user-controlled URL → no SSRF surface).
        const decision = await checkUrlEgressSafe(WEB_SEARCH_PROVIDERS[provider].apiUrl)
        if (!decision.allowed) return { ok: false, error: decision.reason }
        try {
          const results = await webSearch(query, count ?? 5)
          // Prompt-injection sandbox: search snippets are attacker-controllable web
          // content entering the model's context as a tool result.
          const { wrapUntrusted } = await import('./prompt-sandbox')
          return { ok: true, provider, results: wrapUntrusted(JSON.stringify(results, null, 2), 'web_search') }
        } catch (err) {
          return { ok: false, error: `search failed: ${err instanceof Error ? err.message : String(err)}` }
        }
      },
    }) as Tool.Any)
  }

  return tools
}
