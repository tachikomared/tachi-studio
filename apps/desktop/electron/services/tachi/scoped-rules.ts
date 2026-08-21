// apps/desktop/electron/services/tachi/scoped-rules.ts
//
// GLOB-SCOPED RULES (harness item 8) — nested project context.
//
// The root project-context file is injected into the system prompt once per
// session (agent.ipc.ts → prompt.ts). A monorepo's REAL conventions, though,
// are per-package ("in apps/desktop, i18n keys must exist in all 8 locales"),
// and paying for all of them up front is exactly the always-on-token cost the
// narrow-waist doctrine refuses.
//
// So: ONE convention — a nested `AGENTS.md` in a subdirectory scopes to files
// under that subdirectory (conceptually what the root injection already does,
// one level down). When a tool touches a path, the nearest ancestor AGENTS.md
// STRICTLY BELOW the workspace root is injected once, at the tool-result
// boundary, and never again that session. The root file is excluded — it is
// already in the prompt.
//
// Pure + injectable fs so the resolution logic is unit-testable; the loop owns
// the wiring (and the default-ON flag that disables it).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { isPathWithin } from '../util/path-containment'

/** The nested-rules convention. Same filename as the root file, one level down. */
export const SCOPED_RULES_FILENAME = 'AGENTS.md'

/** Total chars of scoped rules one session may inject (across all rules files). */
export const DEFAULT_SCOPED_RULES_BUDGET = 6000

/** Chars kept from any single rules file. */
export const DEFAULT_SCOPED_RULE_FILE_CHARS = 2000

/** Tools whose `path` argument names a workspace file/dir worth scoping on. */
const PATH_TOOLS: ReadonlySet<string> = new Set(['read', 'write', 'edit', 'grep', 'blast_radius'])

/** The workspace path a tool call touches, or null when it touches none. */
export function scopedPathArg(toolName: string, args: Record<string, unknown>): string | null {
  if (!PATH_TOOLS.has(toolName)) return null
  const p = args?.path
  return typeof p === 'string' && p.trim() ? p : null
}

export interface ScopedRulesFs {
  exists(path: string): boolean
  read(path: string): string
}

const NODE_FS: ScopedRulesFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
}

/**
 * Nearest ancestor rules file for `userPath`, as an absolute path, or null.
 *
 * Walks up from the path itself (a directory argument is its own first
 * candidate) to — but NOT including — the workspace root: the root file is
 * already the prompt's project context. A path outside the workspace resolves
 * to null rather than reaching outside the sandbox.
 */
export function findNearestScopedRules(
  workspaceRoot: string,
  userPath: string,
  fs: ScopedRulesFs = NODE_FS,
): string | null {
  if (!userPath) return null
  const root = normalize(workspaceRoot)
  const abs = isAbsolute(userPath) ? normalize(userPath) : normalize(resolve(root, userPath))
  if (!isPathWithin(root, abs)) return null

  let dir = abs
  for (;;) {
    // Stop at (and exclude) the root: its AGENTS.md is the injected prompt context.
    if (relative(root, dir) === '' || !isPathWithin(root, dir)) return null
    const candidate = join(dir, SCOPED_RULES_FILENAME)
    // Reading the rules file itself must not echo its own body back as a note.
    if (candidate !== abs && fs.exists(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export interface ScopedRulesOptions {
  workspaceRoot: string
  /** Total chars this session may spend on scoped rules. */
  budgetChars?: number
  /** Chars kept from a single rules file. */
  maxFileChars?: number
  fs?: ScopedRulesFs
}

/**
 * Per-session scoped-rules state: which rules files have already been injected
 * and how much of the budget is spent. One instance per runTachiLoop call.
 */
export class ScopedRulesSession {
  private readonly root: string
  private readonly budget: number
  private readonly maxFileChars: number
  private readonly fs: ScopedRulesFs
  /** Rules files already handled this session (injected OR skipped) — once each, either way. */
  private readonly seen = new Set<string>()
  private spent = 0

  constructor(opts: ScopedRulesOptions) {
    this.root = opts.workspaceRoot
    this.budget = opts.budgetChars ?? DEFAULT_SCOPED_RULES_BUDGET
    this.maxFileChars = opts.maxFileChars ?? DEFAULT_SCOPED_RULE_FILE_CHARS
    this.fs = opts.fs ?? NODE_FS
  }

  /** Chars of scoped rules injected so far (test/observability). */
  get spentChars(): number { return this.spent }

  /**
   * The context note to append to this tool's result, or null (no scoped rules
   * apply / already injected / budget exhausted). Never throws — a failed read
   * simply yields no note.
   */
  noteFor(toolName: string, args: Record<string, unknown>): string | null {
    const userPath = scopedPathArg(toolName, args)
    if (!userPath) return null
    let rulesPath: string | null = null
    try {
      rulesPath = findNearestScopedRules(this.root, userPath, this.fs)
    } catch { return null }
    if (!rulesPath) return null
    const key = process.platform === 'win32' ? rulesPath.toLowerCase() : rulesPath
    if (this.seen.has(key)) return null
    // Marked before any early return: a rules file is considered ONCE per
    // session whether it fit the budget or not, so a big file can't be
    // re-read on every tool call for the rest of the run.
    this.seen.add(key)

    let body = ''
    try { body = this.fs.read(rulesPath).trim() } catch { return null }
    if (!body) return null

    const rel = relative(this.root, rulesPath).split('\\').join('/')
    const scope = rel.slice(0, rel.length - SCOPED_RULES_FILENAME.length) || './'
    if (body.length > this.maxFileChars) {
      body = `${body.slice(0, this.maxFileChars)}\n…[trimmed — read ${rel} for the rest]`
    }
    const note = [
      `[scoped rules — ${rel} · applies to files under ${scope} · shown once this session]`,
      body,
      '[end scoped rules]',
    ].join('\n')

    if (this.spent + note.length > this.budget) return null
    this.spent += note.length
    return note
  }
}
