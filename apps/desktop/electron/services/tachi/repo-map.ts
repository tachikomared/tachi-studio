// apps/desktop/electron/services/tachi/repo-map.ts
//
// Auto-injected REPO MAP for the TACHI system prompt (aider's headline mechanic).
// A budgeted, structural overview of the workspace — the hub files most other
// files depend on (with their exports), plus the entry points — computed ONCE at
// session start from the SAME code graph the get_architecture tool uses. The
// agent starts oriented instead of blind-groping, but the map is explicitly
// framed as "generated — verify with tools" so it is a hint, never ground truth.
//
// Split in two:
//   • renderRepoMap()  — PURE + deterministic: an ArchitectureSummary-shaped
//     input → a budget-trimmed string. This is the unit under test.
//   • buildRepoMap()   — impure: collects source (git ls-files / FS walk), builds
//     the graph, and renders. Time-capped + big-workspace-guarded; on ANY skip
//     (huge repo, timeout, no source, error) it returns undefined and the prompt
//     simply omits the map. Local-only (no network) → runs in private mode too.

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { buildCodeGraph, summarizeArchitecture, parseExportedSymbols, isSourceFile } from '@tachi/core'

/** ~1200 tokens ≈ 4800 chars — the always-on cost we are willing to pay every run. */
export const DEFAULT_REPO_MAP_MAX_CHARS = 4800
/** Skip the map entirely on very large workspaces — the graph cost is not worth it. */
export const MAX_WORKSPACE_FILES = 8000
/** Best-effort wall-clock cap for the (local) build; see buildRepoMap for the caveat. */
export const REPO_MAP_TIMEOUT_MS = 3000

const MAX_HUBS = 50            // request generously; renderRepoMap trims to the char budget
const MAX_EXPORTS_PER_HUB = 8  // matches the get_architecture tool's export cap
const MAX_ENTRY_POINTS = 20
const GRAPH_MAX_FILES = 4000   // read cap (mirrors tools.ts collectSourceFiles)
const READ_MAX_BYTES = 256 * 1024
const GRAPH_SKIP = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', 'coverage'])

export interface RepoMapHub {
  path: string
  importedBy: number
  exports: string[]
}

/** The graph-summary shape renderRepoMap consumes (a superset of ArchitectureSummary's hubs). */
export interface RepoMapInput {
  fileCount: number
  edgeCount: number
  hubs: RepoMapHub[]
  entryPoints: string[]
}

/**
 * Render a budget-trimmed repo-map body from a graph summary. PURE + deterministic
 * (no time, no randomness, no I/O): identical input → byte-identical output, so it
 * is safe in the cache-stable prefix and is the unit the tests pin. The returned
 * string is the body only — buildTachiSystemPrompt wraps it under the header.
 * Never exceeds maxChars (except the unavoidable single header line on a pathological
 * tiny budget); sections are added whole so a tight budget never orphans a header.
 */
export function renderRepoMap(input: RepoMapInput, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_REPO_MAP_MAX_CHARS
  const capList = (xs: string[], n: number): string =>
    xs.length > n ? `${xs.slice(0, n).join(', ')}, +${xs.length - n} more` : xs.join(', ')

  const lines: string[] = [`${input.fileCount} source file(s), ${input.edgeCount} import edge(s).`]
  const fits = (additions: string[]): boolean => [...lines, ...additions].join('\n').length <= maxChars

  // Hub files, most-depended-upon first. The section header and its first entry are
  // committed together so a budget that fits neither never leaves a dangling header.
  for (let i = 0; i < input.hubs.length; i++) {
    const h = input.hubs[i]
    const exps = h.exports.length ? ` — exports ${capList(h.exports, MAX_EXPORTS_PER_HUB)}` : ''
    const hubLine = `  ${h.path} (imported by ${h.importedBy})${exps}`
    const additions = i === 0
      ? ['', 'Hub files (most depended-upon — read these first):', hubLine]
      : [hubLine]
    if (!fits(additions)) break
    lines.push(...additions)
  }

  // Entry points last, only if the whole line still fits.
  if (input.entryPoints.length > 0) {
    const additions = ['', `Entry points: ${capList(input.entryPoints, MAX_ENTRY_POINTS)}`]
    if (fits(additions)) lines.push(...additions)
  }

  return lines.join('\n')
}

/** All tracked files (unfiltered) so the >8000 guard sees the true workspace size; null when not a git repo. */
function gitTrackedFiles(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const paths = out.split('\0').filter(Boolean)
    return paths.length > 0 ? paths : null
  } catch {
    return null
  }
}

/** Non-git fallback: a bounded FS walk yielding workspace-relative source paths (capped). */
function walkSourceFiles(root: string): string[] {
  const out: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0 && out.length < GRAPH_MAX_FILES) {
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (out.length >= GRAPH_MAX_FILES) break
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!GRAPH_SKIP.has(e.name) && !e.name.startsWith('.')) stack.push(full)
        continue
      }
      const rel = relative(root, full).split(sep).join('/')
      if (isSourceFile(rel)) out.push(rel)
    }
  }
  return out
}

/** Read the graphable source files, applying the workspace-size guard and read cap. */
function collectMapFiles(root: string): { path: string; text: string }[] | undefined {
  const tracked = gitTrackedFiles(root)
  let source: string[]
  if (tracked) {
    if (tracked.length > MAX_WORKSPACE_FILES) return undefined // giant workspace → skip (cost)
    source = tracked.filter(isSourceFile)
  } else {
    source = walkSourceFiles(root) // capped at GRAPH_MAX_FILES, which bounds the cost
  }
  const files: { path: string; text: string }[] = []
  for (const rel of source) {
    if (files.length >= GRAPH_MAX_FILES) break
    try {
      const abs = join(root, rel)
      if (statSync(abs).size <= READ_MAX_BYTES) files.push({ path: rel, text: readFileSync(abs, 'utf8') })
    } catch { /* skip unreadable / tracked-but-deleted */ }
  }
  return files.length > 0 ? files : undefined
}

/** Synchronous core of the build (all I/O + CPU); wrapped by buildRepoMap for the timeout. */
function computeRepoMap(root: string, maxChars?: number): string | undefined {
  const files = collectMapFiles(root)
  if (!files) return undefined
  const summary = summarizeArchitecture(buildCodeGraph(files), { topHubs: MAX_HUBS })
  if (summary.fileCount === 0) return undefined
  const textByPath = new Map(files.map(f => [f.path, f.text]))
  const hubs: RepoMapHub[] = summary.hubs.map(h => ({
    path: h.path,
    importedBy: h.importedBy,
    exports: parseExportedSymbols(textByPath.get(h.path) ?? ''),
  }))
  return renderRepoMap(
    { fileCount: summary.fileCount, edgeCount: summary.edgeCount, hubs, entryPoints: summary.entryPoints },
    { maxChars },
  )
}

/**
 * Build the repo map for a workspace, or undefined if it should be skipped (huge
 * workspace, no source, timeout, or any error). Async + time-capped so a
 * pathological workspace can never stall session start.
 *
 * Caveat: computeRepoMap is CPU-bound and synchronous, so the timeout can only
 * fire if the microtask is starved before it runs — the real cost bound is the
 * >MAX_WORKSPACE_FILES guard plus the GRAPH_MAX_FILES read cap, which keep a
 * normal repo's build well under the cap. The race is a belt-and-suspenders.
 */
export async function buildRepoMap(
  workspaceRoot: string,
  opts: { timeoutMs?: number; maxChars?: number } = {},
): Promise<string | undefined> {
  const timeoutMs = opts.timeoutMs ?? REPO_MAP_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const work = new Promise<string | undefined>((resolve) => {
      // Defer one macrotask so the timeout timer is armed before the sync build runs.
      setImmediate(() => {
        try { resolve(computeRepoMap(workspaceRoot, opts.maxChars)) }
        catch { resolve(undefined) }
      })
    })
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), timeoutMs)
    })
    return await Promise.race([work, timeout])
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}
