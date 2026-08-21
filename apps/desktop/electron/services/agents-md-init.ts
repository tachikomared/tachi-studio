// apps/desktop/electron/services/agents-md-init.ts
//
// THE ONE AGENTS.md generator. AGENTS.md is parsed by @tachi/core's parseAgentsMd
// and fed to the agent as project context, so a good starter — real stack, real
// build/test commands, AND a real map of the code — gives the agent useful
// grounding from day one. This module is the single home for that content:
//   • initAgentsMd(root)      — the workspace `/init` entry point (create or regen)
//   • renderAgentsMd(root)    — the pure content builder (agent.ipc delegates here)
//   • renderArchitectureSection(files) — the code-graph → markdown core (pure)
//
// The "## Architecture (generated)" section is derived from the code-graph
// (@tachi/core buildCodeGraph/summarizeArchitecture) — top hub files, their
// role, and the entry points — so the agent knows where features are wired.
// Output is deterministic (sorted), bounded (~120 lines), and carried between
// <!-- tachi:generated:start --> / <!-- tachi:generated:end --> markers so a
// re-run REPLACES only that block and preserves everything the user wrote
// above/below it. A hand-written AGENTS.md with no markers is never touched.
//
// Deterministic + side-effect-isolated (one fs write), so it unit-tests cleanly
// against a temp dir — no LLM, no electron.

import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, basename, isAbsolute, relative, sep } from 'node:path'
import { buildCodeGraph, summarizeArchitecture, parseExportedSymbols, isSourceFile } from '@tachi/core'

export type InitAgentsMdReason =
  | 'created'
  | 'regenerated'
  | 'exists'
  | 'no_workspace'
  | 'invalid_path'
  | 'not_a_directory'

export interface InitAgentsMdResult {
  ok: boolean
  path: string
  created: boolean
  reason: InitAgentsMdReason
  detected?: { name?: string; stack: string[]; packageManager?: string }
}

interface Pkg { name?: string; scripts?: Record<string, string> }

/** The block a re-run replaces; everything outside it is the user's to keep. */
export const GENERATED_START = '<!-- tachi:generated:start -->'
export const GENERATED_END = '<!-- tachi:generated:end -->'

// ── Stack + npm-script detection ──────────────────────────────────────────────

/** Sniff the workspace's stack + package manager + npm scripts from marker files. */
function detectStack(root: string): { name?: string; stack: string[]; pm?: string; scripts: Record<string, string> } {
  const has = (f: string): boolean => existsSync(join(root, f))
  const stack: string[] = []
  let name: string | undefined
  let pm: string | undefined
  let scripts: Record<string, string> = {}

  if (has('package.json')) {
    stack.push(has('tsconfig.json') ? 'Node.js / TypeScript' : 'Node.js / JavaScript')
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Pkg
      if (typeof pkg.name === 'string' && pkg.name.trim()) name = pkg.name.trim()
      if (pkg.scripts && typeof pkg.scripts === 'object') scripts = pkg.scripts
    } catch { /* unparseable package.json — still note the stack */ }
    pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm'
  }
  if (has('Cargo.toml')) stack.push('Rust (Cargo)')
  if (has('go.mod')) stack.push('Go')
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) stack.push('Python')
  if (has('pom.xml')) stack.push('Java (Maven)')
  if (has('build.gradle') || has('build.gradle.kts')) stack.push('JVM (Gradle)')
  if (has('Gemfile')) stack.push('Ruby')
  if (has('composer.json')) stack.push('PHP (Composer)')
  if (has('Dockerfile') || has('compose.yaml') || has('docker-compose.yml')) stack.push('Docker')
  return { name, stack, pm, scripts }
}

// ── Code-graph source collection ──────────────────────────────────────────────
// git-tracked source first (skips vendored clones + ignored trees automatically),
// falling back to a filesystem walk when the workspace isn't a git repo. Bounded
// so a giant monorepo can't stall /init or blow up memory.

const GRAPH_SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', 'coverage', '.vite', '.cache'])
const GRAPH_MAX_FILES = 4000
const GRAPH_READ_MAX_BYTES = 256 * 1024

/** Tracked source paths via `git ls-files`, or null when this isn't a git repo. */
function gitTrackedSourceFiles(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    })
    const paths = out.split('\0').filter(Boolean).filter(isSourceFile)
    return paths.length > 0 ? paths : null
  } catch { return null }
}

/** Collect { path (forward-slashed, workspace-relative), text } for the graph. */
function collectGraphFiles(root: string): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = []
  const push = (rel: string, abs: string): void => {
    try { if (statSync(abs).size <= GRAPH_READ_MAX_BYTES) files.push({ path: rel, text: readFileSync(abs, 'utf8') }) }
    catch { /* skip unreadable / tracked-but-deleted */ }
  }

  const tracked = gitTrackedSourceFiles(root)
  if (tracked) {
    for (const rel of tracked) { if (files.length >= GRAPH_MAX_FILES) break; push(rel, join(root, rel)) }
    return files
  }

  // Fallback (not a git repo): FS walk, skipping vendor + dot directories.
  const walk = (dir: string): void => {
    if (files.length >= GRAPH_MAX_FILES) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (files.length >= GRAPH_MAX_FILES) return
      const full = join(dir, e.name)
      if (e.isDirectory()) { if (!GRAPH_SKIP.has(e.name) && !e.name.startsWith('.')) walk(full); continue }
      const rel = relative(root, full).split(sep).join('/')
      if (isSourceFile(rel)) push(rel, full)
    }
  }
  walk(root)
  return files
}

// ── Architecture section (pure, deterministic, timestamp-free) ────────────────

/** First few of `xs`, comma-joined, with a `…` when truncated. */
function cap(xs: string[], n: number): string {
  return xs.length > n ? `${xs.slice(0, n).join(', ')}, …` : xs.join(', ')
}

/**
 * A one-line "where this feature is wired" hint for a hub file, inferred
 * deterministically from its path — enough to orient an agent without opening
 * the file. First matching rule wins; ordering is significant.
 */
export function roleHint(path: string): string {
  const base = path.split('/').pop() ?? path
  const lower = path.toLowerCase()
  if (/(?:^|\/)index\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return 'barrel — re-exports this module\'s public API'
  if (/\.ipc\.(?:ts|js)$/.test(base)) return 'IPC bridge — wires renderer↔main for this feature'
  if (/Store\.(?:tsx?|js)$/.test(base) || /(?:^|[-._])store\.(?:tsx?|js)$/i.test(base) || /\.(?:store|slice)\.(?:tsx?|js)$/.test(base) || /\/(?:state|stores)\//.test(lower)) return 'state store — shared app/UI state'
  if (/(?:^|\/)tools\.(?:ts|js)$/.test(path) || /\/tools\//.test(lower)) return 'agent tool definitions'
  if (/\.service\.(?:ts|js)$/.test(base) || /-service\.(?:ts|js)$/.test(base) || /\/services\//.test(lower)) return 'service — backend / main-process logic'
  if (/\/hooks?\//.test(lower) || /^use[A-Z]/.test(base)) return 'React hook'
  if (/(?:config|constants)\.(?:ts|tsx|js)$/.test(base)) return 'shared config / constants'
  if (/(?:^|\/)types?\.(?:ts|tsx)$/.test(path) || /\.types\.(?:ts|tsx)$/.test(base)) return 'shared type definitions'
  if (/(?:util|utils|helpers?)\.(?:ts|tsx|js)$/.test(base) || /\/(?:utils|helpers|lib)\//.test(lower)) return 'shared utilities'
  if (/\.tsx$/.test(base)) return 'UI component'
  return 'core module — imported across the codebase'
}

/**
 * Render the "## Architecture (generated)" markdown from a set of source files:
 * the code-graph's most-depended-upon hubs (with export + importer counts and a
 * role hint) plus the entry points. Pure and deterministic — hubs are sorted by
 * importer count then path by summarizeArchitecture, entry points are sorted, and
 * no timestamp is emitted here (the caller stamps the wrapping block). Bounded to
 * a handful of dozen lines regardless of repo size.
 */
export function renderArchitectureSection(files: { path: string; text: string }[]): string {
  if (files.length === 0) {
    return '## Architecture (generated)\n\nNo source files detected yet — re-run `/init` once the codebase has TypeScript/JavaScript files and this map will populate.'
  }
  const graph = buildCodeGraph(files)
  const summary = summarizeArchitecture(graph, { topHubs: 15 })
  const textByPath = new Map(files.map((f) => [f.path, f.text]))
  const plural = (n: number, s: string): string => `${n} ${s}${n === 1 ? '' : 's'}`

  const lines: string[] = ['## Architecture (generated)', '']
  lines.push(`${plural(summary.fileCount, 'source file')}, ${plural(summary.edgeCount, 'internal import edge')}. Derived from the import graph.`)

  if (summary.hubs.length > 0) {
    lines.push('', '**Hub files** — the most depended-upon modules; read these first:')
    for (const h of summary.hubs) {
      const exps = parseExportedSymbols(textByPath.get(h.path) ?? '')
      const expNote = exps.length > 0 ? `${plural(exps.length, 'export')} (${cap(exps, 4)})` : 'no named exports'
      lines.push(`- \`${h.path}\` — imported by ${h.importedBy}, ${expNote} · ${roleHint(h.path)}`)
    }
  }

  if (summary.entryPoints.length > 0) {
    const shown = summary.entryPoints.slice(0, 12).map((p) => `\`${p}\``).join(', ')
    const extra = summary.entryPoints.length > 12 ? ` … (+${summary.entryPoints.length - 12} more)` : ''
    lines.push('', `**Entry points** — imported by nobody (roots / mains): ${shown}${extra}`)
  }

  return lines.join('\n')
}

/** Wrap the architecture section in the regen markers + a timestamped comment. */
function generatedBlock(files: { path: string; text: string }[], now: Date): string {
  return [
    GENERATED_START,
    `<!-- Generated by TACHI /init · ${now.toISOString()} · edits inside this block are replaced on re-run. -->`,
    renderArchitectureSection(files),
    GENERATED_END,
  ].join('\n')
}

/**
 * Replace the content between the generated markers with `block`, preserving
 * everything the user wrote above/below. Returns null when the file has no
 * markers (a hand-written AGENTS.md we must not touch).
 */
export function replaceGeneratedSection(existing: string, block: string): string | null {
  const start = existing.indexOf(GENERATED_START)
  const end = existing.indexOf(GENERATED_END)
  if (start === -1 || end === -1 || end < start) return null
  return existing.slice(0, start) + block + existing.slice(end + GENERATED_END.length)
}

// ── Full-file template ────────────────────────────────────────────────────────

function renderTemplate(root: string, d: ReturnType<typeof detectStack>, files: { path: string; text: string }[], now: Date): string {
  const project = d.name ?? (basename(root) || 'this project')
  const stackBlock = d.stack.length
    ? d.stack.map((s) => `- ${s}`).join('\n')
    : '- TODO: list the languages / frameworks used here.'
  const run = (script: string): string | null => (d.pm && d.scripts[script] ? `${d.pm} run ${script}` : null)
  const install = d.pm ? `${d.pm} install` : 'TODO: add your install command'
  const test = run('test') ?? 'TODO: add your test command'
  const build = run('build') ?? run('dev') ?? run('start') ?? 'TODO: add your build/run command'

  return `# AGENTS.md

Guidance for AI coding agents working in this repository. This file is loaded into
the agent's context on every task — keep it short, true, and useful. Edit freely,
except inside the generated block, which \`/init\` overwrites.

## Project
${project} — TODO: one line on what this project does and who it is for.

## Stack
${stackBlock}

## Build, run, test
- install: ${install}
- test: ${test}
- build/run: ${build}

## Conventions
- TODO: code style, naming, and file layout the agent should follow.
- TODO: anything the agent must NOT touch (generated files, vendored dirs, secrets).

${generatedBlock(files, now)}

## Notes
- Starter generated by TACHI_STUDIO — replace the TODOs with real project specifics.
- Re-run \`/init\` to refresh the "Architecture (generated)" block; your edits outside it are kept.
`
}

/**
 * The pure content builder for a fresh AGENTS.md — stack detection + npm scripts
 * + the code-graph architecture block. agent.ipc's generate-agents-md handler
 * delegates here so there is exactly one generator. `now` is injectable for
 * deterministic tests.
 */
export function renderAgentsMd(root: string, opts: { now?: Date } = {}): string {
  const d = detectStack(root)
  const files = collectGraphFiles(root)
  return renderTemplate(root, d, files, opts.now ?? new Date())
}

/**
 * The workspace `/init` entry point. Creates a starter AGENTS.md when none
 * exists; when one exists WITH the generated markers, refreshes only that block
 * and preserves the user's prose; when one exists WITHOUT markers (a hand-written
 * file), leaves it untouched. Never throws; `now` is injectable for tests.
 */
export function initAgentsMd(rootPath: string | null | undefined, opts: { now?: Date } = {}): InitAgentsMdResult {
  if (!rootPath) return { ok: false, path: '', created: false, reason: 'no_workspace' }
  // Reject any '..' segment — normalise both separators first so forward-slash
  // paths (which Node accepts on Windows, e.g. C:/a/../b) can't slip past.
  if (!isAbsolute(rootPath) || rootPath.replace(/\\/g, '/').split('/').includes('..')) {
    return { ok: false, path: '', created: false, reason: 'invalid_path' }
  }
  if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
    return { ok: false, path: '', created: false, reason: 'not_a_directory' }
  }

  const now = opts.now ?? new Date()
  const target = join(rootPath, 'AGENTS.md')
  const d = detectStack(rootPath)
  const detected = { name: d.name, stack: d.stack, packageManager: d.pm }

  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf8')
    const files = collectGraphFiles(rootPath)
    const replaced = replaceGeneratedSection(existing, generatedBlock(files, now))
    if (replaced === null) {
      // Hand-written AGENTS.md (no markers) — never clobber it.
      return { ok: true, path: target, created: false, reason: 'exists' }
    }
    if (replaced !== existing) writeFileSync(target, replaced, 'utf8')
    return { ok: true, path: target, created: false, reason: 'regenerated', detected }
  }

  writeFileSync(target, renderAgentsMd(rootPath, { now }), 'utf8')
  return { ok: true, path: target, created: true, reason: 'created', detected }
}
