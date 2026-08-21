// packages/core/src/codegraph/graph.ts
//
// Build a code-dependency graph from workspace files and answer "blast radius"
// (reverse-BFS: everything that transitively imports a changed file). Pure +
// environment-agnostic (hand-rolled POSIX path ops, no node:path) so it runs in
// the renderer and main alike and is trivially unit-testable.

import { parseImportSpecifiers } from './parse.js'

export interface CodeGraph {
  /** path → internal paths it imports. */
  forward: Map<string, Set<string>>
  /** path → internal paths that import it (the reverse index blastRadius walks). */
  reverse: Map<string, Set<string>>
}

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
const INDEXES = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs']

const SOURCE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/
// Never part of the project's own code graph: dependency/build output, plus any
// dot-DIRECTORY (.git, .research-tmp, .claude worktrees, .next, …). A leaf
// dotfile is fine; a dot-segment followed by `/` is a directory we skip.
const NON_SOURCE_SEGMENT = /(?:^|\/)(?:node_modules|dist|out|build|coverage)(?:\/|$)|(?:^|\/)\.[^/]+\//

/**
 * Whether a workspace-relative path (forward-slashed) is project source that
 * belongs in the code graph. Used to filter `git ls-files` output (and the FS
 * walk) so vendored/cloned/ignored trees never pollute blast_radius et al.
 */
export function isSourceFile(path: string): boolean {
  return SOURCE_EXT_RE.test(path) && !NON_SOURCE_SEGMENT.test(path)
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/** Join + normalise a relative specifier against a directory (resolves . and ..). */
function joinNormalize(dir: string, rel: string): string {
  const out: string[] = []
  for (const part of (dir ? dir.split('/') : []).concat(rel.split('/'))) {
    if (part === '' || part === '.') continue
    if (part === '..') { out.pop(); continue }
    out.push(part)
  }
  return out.join('/')
}

/**
 * Resolve a relative import specifier to the workspace-relative path it points
 * at (with TS/JS extension + directory-index inference), or null when it's a
 * bare (node_modules) specifier or no workspace file matches.
 */
export function resolveImport(fromPath: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null // external dependency — not an internal edge
  const base = joinNormalize(posixDirname(fromPath), specifier)
  // NodeNext/ESM TS writes `./x.js` but the source on disk is `./x.ts`. Try the
  // literal base first, then the same path with the JS extension stripped so a
  // `.js`/`.jsx`/`.mjs`/`.cjs` specifier also resolves to its `.ts` source.
  const stripped = base.replace(/\.(?:js|jsx|mjs|cjs)$/, '')
  const bases = stripped === base ? [base] : [base, stripped]
  for (const b of bases) {
    for (const ext of EXTS) {
      const cand = b + ext
      if (files.has(cand)) return cand
    }
  }
  for (const b of bases) {
    for (const idx of INDEXES) {
      const cand = b + idx
      if (files.has(cand)) return cand
    }
  }
  return null
}

export function buildCodeGraph(files: { path: string; text: string }[]): CodeGraph {
  const fileSet = new Set(files.map(f => f.path))
  const forward = new Map<string, Set<string>>()
  const reverse = new Map<string, Set<string>>()
  for (const p of fileSet) {
    forward.set(p, new Set())
    reverse.set(p, new Set())
  }
  for (const f of files) {
    for (const spec of parseImportSpecifiers(f.text)) {
      const target = resolveImport(f.path, spec, fileSet)
      if (target && target !== f.path) {
        forward.get(f.path)!.add(target)
        reverse.get(target)!.add(f.path)
      }
    }
  }
  return { forward, reverse }
}

/**
 * Reverse-BFS from `changed`: the transitive set of files that import it
 * (directly or indirectly) — i.e. what an edit could break. Cycle-safe via a
 * visited set; `maxDepth` caps how far the ripple is followed (1 = direct
 * importers only). Excludes `changed` itself. Returned sorted for stable output.
 */
export function blastRadius(graph: CodeGraph, changed: string, opts: { maxDepth?: number } = {}): string[] {
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY
  const seen = new Set<string>()
  let frontier = [changed]
  let depth = 0
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = []
    for (const node of frontier) {
      for (const importer of graph.reverse.get(node) ?? []) {
        if (importer !== changed && !seen.has(importer)) {
          seen.add(importer)
          next.push(importer)
        }
      }
    }
    frontier = next
    depth++
  }
  return [...seen].sort()
}

/**
 * Shortest dependency chain from `from` to `to` along forward (import) edges —
 * i.e. how `from` transitively depends on `to`. Returns the inclusive path
 * (`[from, …, to]`), `[from]` when they're the same node, or null when `from`
 * does not reach `to`. Neighbours are expanded in sorted order so the chosen
 * shortest path is deterministic. Powers the `trace_path` tool.
 */
export function tracePath(graph: CodeGraph, from: string, to: string): string[] | null {
  if (from === to) return [from]
  const prev = new Map<string, string>()
  const seen = new Set<string>([from])
  let frontier = [from]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const node of frontier) {
      for (const nb of [...(graph.forward.get(node) ?? [])].sort()) {
        if (seen.has(nb)) continue
        seen.add(nb)
        prev.set(nb, node)
        if (nb === to) {
          const path = [to]
          let cur = to
          while (cur !== from) { cur = prev.get(cur)!; path.push(cur) }
          return path.reverse()
        }
        next.push(nb)
      }
    }
    frontier = next
  }
  return null
}

export interface ArchitectureSummary {
  /** Total graphed files. */
  fileCount: number
  /** Total directed import edges (internal only). */
  edgeCount: number
  /** Most-depended-upon files first (highest in-degree); excludes in-degree 0. */
  hubs: { path: string; importedBy: number }[]
  /** Roots: files nobody imports but which import others (likely entrypoints). */
  entryPoints: string[]
  /** Fully isolated files: import nothing and are imported by nobody. */
  orphans: string[]
}

/**
 * A cheap structural overview of the graph — file/edge counts, the hub files an
 * agent should understand first (most imported), the entrypoints, and the
 * isolated orphans. Powers the `get_architecture` tool (codebase-memory-mcp).
 */
export function summarizeArchitecture(graph: CodeGraph, opts: { topHubs?: number } = {}): ArchitectureSummary {
  const topHubs = opts.topHubs ?? 10
  const files = [...graph.forward.keys()]
  const importedBy = (p: string): number => graph.reverse.get(p)?.size ?? 0
  const imports = (p: string): number => graph.forward.get(p)?.size ?? 0
  let edgeCount = 0
  for (const deps of graph.forward.values()) edgeCount += deps.size
  const hubs = files
    .map(path => ({ path, importedBy: importedBy(path) }))
    .filter(h => h.importedBy > 0)
    .sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path))
    .slice(0, topHubs)
  const entryPoints = files.filter(p => importedBy(p) === 0 && imports(p) > 0).sort()
  const orphans = files.filter(p => importedBy(p) === 0 && imports(p) === 0).sort()
  return { fileCount: files.length, edgeCount, hubs, entryPoints, orphans }
}
