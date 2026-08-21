// apps/desktop/electron/services/util/gtrconfig.ts
//
// Pure parser + copy planner for a per-project `.gtrconfig` file. Ported from
// ccpocket's bridge/worktree.ts (parseGtrConfig / copyConfiguredFiles), trimmed
// to the friction it actually solves here: a fresh `git worktree` checkout is
// missing untracked-but-needed files (`.env`, local configs) and needs a couple
// of bootstrap commands. We deliberately drop ccpocket's glob/dir walking — this
// codebase already symlinks `node_modules`, so explicit declared files are
// enough and far easier to reason about.
//
// Both functions are pure: the parser takes raw text (the worktree-service does
// the fs read) and the planner takes an injected `fileExists` predicate, so unit
// tests need no filesystem and the planning logic stays deterministic.

/** Parsed shape of a `.gtrconfig` file. */
export interface ParsedGtrConfig {
  /** Project-relative paths declared for copy into a fresh worktree. */
  copy: string[]
  /** Shell commands to run (cwd = new worktree) after creation. */
  postCreate: string[]
  /** Shell commands to run (cwd = worktree) before removal. */
  preRemove: string[]
}

/**
 * Parse a gitconfig-style `.gtrconfig`. Minimal by design:
 *   - `# ...` and `; ...` lines are comments; blank lines are skipped.
 *   - `[section]` headers switch the active section (case-insensitive).
 *   - `key = value` lines append `value` (verbatim, trimmed) to a list.
 *   - Lines without `=`, lines outside a known section, and unknown keys are
 *     silently ignored (tolerant, never throws).
 *
 * Recognised sections/keys:
 *   [copy]            file       -> copy[]
 *   [hook] / [hooks]  postCreate -> postCreate[]
 *                     preRemove  -> preRemove[]
 */
export function parseGtrConfig(text: string): ParsedGtrConfig {
  const out: ParsedGtrConfig = { copy: [], postCreate: [], preRemove: [] }
  if (!text) return out

  let section = ''
  // Split on LF; trim handles trailing CR so CRLF files parse identically.
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue

    const sectionMatch = /^\[(\w+)\]$/.exec(line)
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase()
      continue
    }

    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    const value = line.slice(eq + 1).trim()
    if (key === '' || value === '') continue

    if (section === 'copy') {
      if (key === 'file') out.copy.push(value)
    } else if (section === 'hook' || section === 'hooks') {
      if (key === 'postcreate') out.postCreate.push(value)
      else if (key === 'preremove') out.preRemove.push(value)
    }
  }

  return out
}

/**
 * Given declared copy patterns (project-relative paths), return the subset that
 * actually exists, in declaration order and de-duplicated. File I/O is injected
 * via `fileExists(relPath, absPath)` so this stays pure and unit-testable; the
 * caller passes a predicate backed by `fs.existsSync`.
 *
 * Path joining uses a forward-slash join that is correct for the relative paths
 * a `.gtrconfig` declares; the caller's predicate receives both the relative and
 * an absolute form so it can stat against the real project root with `node:path`.
 */
export function resolveCopyList(
  patterns: string[],
  projectRoot: string,
  fileExists: (relPath: string, absPath: string) => boolean,
): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  const root = projectRoot.replace(/[\\/]+$/, '')

  for (const raw of patterns) {
    const rel = raw.trim()
    if (rel === '' || seen.has(rel)) continue
    seen.add(rel)
    // Forward-slash join is sufficient for the predicate's substring/stat use;
    // the worktree-service predicate re-joins with node:path for the real read.
    const abs = root + '/' + rel
    if (fileExists(rel, abs)) result.push(rel)
  }

  return result
}
