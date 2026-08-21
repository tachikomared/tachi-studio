// Sprint D5 — Role-as-data registry.
// Mirrors the provider-registry.ts pattern from Sprint B3.
// Reads roles/roles.yaml at runtime; caches in a module-level Map.

import { readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

// R8b: `yaml` is loaded on first parse, not at boot. The package costs 13.8 ms
// of the 1317 ms pre-STARTUP_T0 prelude and is shared with aeon-service.ts /
// provider-registry.ts — whichever parses first pays it, and none of the three
// parses during boot. Bare specifier ⇒ `require()` is allowed here (see
// test/unit/noRuntimeRelativeRequire.test.ts) and keeps buildCache() sync.
function parseYaml(text: string): unknown {
  const { parse } = require('yaml') as typeof import('yaml')
  return parse(text)
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface RoleTriggers {
  keywords: string[]
  paths:    string[]
}

export interface RoleExample {
  user:       string
  commentary: string
}

export interface RoleBoundaries {
  denyWritePaths:    string[]
  denyToolPatterns:  string[]
}

export interface Role {
  id:           string
  label:        string
  description:  string
  triggers:     RoleTriggers
  examples:     RoleExample[]
  boundaries:   RoleBoundaries
  allowedTools: string[]
}

// ── YAML raw shape ────────────────────────────────────────────────────────────

interface RawRoleTriggers {
  keywords?: string[]
  paths?:    string[]
}

interface RawRoleExample {
  user?:       string
  commentary?: string
}

interface RawRoleBoundaries {
  'deny-write-paths'?:    string[]
  'deny-tool-patterns'?:  string[]
}

interface RawRole {
  label:           string
  description:     string
  triggers?:       RawRoleTriggers
  examples?:       RawRoleExample[]
  boundaries?:     RawRoleBoundaries
  'allowed-tools'?: string[]
}

interface RawYaml {
  roles: Record<string, RawRole>
}

// ── Lazy-loaded singleton ────────────────────────────────────────────────────

let _cache: Map<string, Role> | null = null

function resolveYamlPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'roles', 'roles.yaml')
  }

  const candidates = [
    // electron-vite dev: __dirname = out/main — walk back to source
    join(__dirname, '..', '..', 'electron', 'services', 'roles', 'roles.yaml'),
    // ts-node / unit tests running from services dir
    join(__dirname, 'roles', 'roles.yaml'),
    // cwd fallback for integration tests run from project root
    join(process.cwd(), 'apps', 'desktop', 'electron', 'services', 'roles', 'roles.yaml'),
  ]

  for (const p of candidates) {
    try {
      readFileSync(p)
      return p
    } catch {
      // try next
    }
  }

  throw new Error(
    `[role-registry] Cannot find roles.yaml. Tried:\n${candidates.join('\n')}`
  )
}

function buildCache(): Map<string, Role> {
  const yamlPath = resolveYamlPath()
  const raw = parseYaml(readFileSync(yamlPath, 'utf-8')) as RawYaml

  if (!raw?.roles || typeof raw.roles !== 'object') {
    throw new Error(`[role-registry] roles.yaml missing top-level "roles" map`)
  }

  const map = new Map<string, Role>()

  for (const [id, entry] of Object.entries(raw.roles)) {
    const role: Role = {
      id,
      label:       entry.label,
      description: entry.description,
      triggers: {
        keywords: entry.triggers?.keywords ?? [],
        paths:    entry.triggers?.paths    ?? [],
      },
      examples: (entry.examples ?? []).map(ex => ({
        user:       ex.user       ?? '',
        commentary: ex.commentary ?? '',
      })),
      boundaries: {
        denyWritePaths:   entry.boundaries?.['deny-write-paths']   ?? [],
        denyToolPatterns: entry.boundaries?.['deny-tool-patterns'] ?? [],
      },
      allowedTools: entry['allowed-tools'] ?? [],
    }
    map.set(id, role)
  }

  return map
}

// ── Path-glob matcher (no external dep) ──────────────────────────────────────
//
// Converts the simple glob patterns used in roles.yaml (* ** ? {}) to a RegExp.
// Covers: "**/*.pem", ".env*", "**/auth/**" etc. No dep on picomatch/minimatch
// since neither is present in the project's dependency tree.

function globToRegex(pattern: string): RegExp {
  // Normalize path separators to forward slash for matching
  const escaped = pattern
    // Temporarily encode ** before escaping
    .replace(/\*\*/g, '\x00DOUBLESTAR\x00')
    // Escape regex special chars (except * ? already handled and \x00 guard)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // Single * → match anything except /
    .replace(/\*/g, '[^/]*')
    // ? → single non-separator char. MUST run BEFORE the ** expansions below,
    // which inject "(?:.*/)?" containing literal '?' that this step would corrupt.
    .replace(/\?/g, '[^/]')
    // "**/" → optional leading segments, so "**/foo" matches "foo" at the root
    // too (standard glob semantics), not just "a/foo".
    .replace(/\x00DOUBLESTAR\x00\//g, '(?:.*/)?')
    // remaining ** guard → match anything including /
    .replace(/\x00DOUBLESTAR\x00/g, '.*')

  return new RegExp(`^${escaped}$`, 'i')
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  return globToRegex(pattern).test(normalized)
}

// ── Boundary enforcement (Sprint D5 follow-up) ───────────────────────────────
//
// Pure check of a tool call against a role's boundaries. Used by the agent
// permission gate. Three rules, in order:
//   1. allowed-tools  — if non-empty, the tool NAME must be in the allowlist.
//   2. deny-tool-patterns — "Tool:regex" denies that tool when its command/input
//      matches the regex (e.g. "Bash:rm.*"); a bare "Pattern" is a tool-name glob.
//   3. deny-write-paths — for write-ish tools, the path arg must not match a glob
//      (checked against both the full path and the basename, so ".env*" catches
//      "src/.env" too).
// Returns { allowed:true } when nothing trips. FAIL-OPEN by design: callers only
// invoke this when a role is actively selected, so no role => no restriction.

export interface RoleBoundaryCheck { allowed: boolean; reason?: string }

const WRITE_TOOL_NAMES = new Set([
  'write', 'edit', 'multiedit', 'str_replace_editor', 'create_file', 'apply_diff',
  'fs_write', 'fs_apply_diff', 'notebookedit',
])
const PATH_KEYS = ['path', 'file_path', 'filepath', 'file', 'filename', 'target', 'dest', 'destination']

function extractInputString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  for (const k of keys) {
    const v = o[k] ?? o[k.toLowerCase()]
    if (typeof v === 'string') return v
  }
  return undefined
}

export function checkRoleBoundary(role: Role, toolName: string, parsedInput?: unknown): RoleBoundaryCheck {
  const lname = toolName.toLowerCase()

  // 1. allowed-tools allowlist (exact name, case-insensitive)
  if (role.allowedTools.length > 0) {
    const ok = role.allowedTools.some(a => a.toLowerCase() === lname)
    if (!ok) {
      return { allowed: false, reason: `Role "${role.label}" permits only [${role.allowedTools.join(', ')}] — tool "${toolName}" is not allowed.` }
    }
  }

  // 2. deny-tool-patterns ("Tool:regex" | tool-name glob)
  for (const pat of role.boundaries.denyToolPatterns) {
    const sep = pat.indexOf(':')
    if (sep > 0) {
      const tool = pat.slice(0, sep)
      const rx   = pat.slice(sep + 1)
      if (tool.toLowerCase() === lname) {
        const cmd = extractInputString(parsedInput, ['command', 'cmd', 'script']) ?? ''
        try { if (new RegExp(rx, 'i').test(cmd)) return { allowed: false, reason: `Role "${role.label}" forbids "${pat}".` } }
        catch { /* malformed regex in role data — ignore this pattern */ }
      }
    } else if (matchesGlob(toolName, pat) || lname === pat.toLowerCase()) {
      return { allowed: false, reason: `Role "${role.label}" forbids tool "${pat}".` }
    }
  }

  // 3. deny-write-paths (write-ish tools only)
  if (role.boundaries.denyWritePaths.length > 0 && WRITE_TOOL_NAMES.has(lname)) {
    const p = extractInputString(parsedInput, PATH_KEYS)
    if (p) {
      const base = p.replace(/\\/g, '/').split('/').pop() ?? p
      for (const pat of role.boundaries.denyWritePaths) {
        if (matchesGlob(p, pat) || matchesGlob(base, pat)) {
          return { allowed: false, reason: `Role "${role.label}" cannot write to "${p}" (matches deny pattern "${pat}").` }
        }
      }
    }
  }

  return { allowed: true }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Load (or return the cached) registry. Reads roles.yaml once, then caches. */
export function loadRoles(): Role[] {
  if (!_cache) {
    _cache = buildCache()
  }
  return Array.from(_cache.values())
}

/** Look up a role by id. Returns undefined if not found. */
export function getRole(id: string): Role | undefined {
  if (!_cache) _cache = buildCache()
  return _cache.get(id)
}

/** Return all roles as a flat array, sorted by id. */
export function listRoles(): Role[] {
  return loadRoles().sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Suggest the best-fit role given workspace context.
 *
 * Score = (#keyword hits in recentUserText) + (#path glob hits in workspaceFiles).
 * Returns an array of { id, score } sorted descending. Always includes at least
 * one entry (generalist with score 0 if nothing else matches).
 *
 * TODO(D5-follow-up): surface the top suggestion as a "[ROLE SUGGESTED]" toast
 * in AgentPage when the user starts a new session.
 */
export function suggestRole(input: {
  workspaceFiles:  string[]
  recentUserText:  string
}): Array<{ id: string; score: number }> {
  const roles = listRoles()
  const textLower = input.recentUserText.toLowerCase()

  const scored = roles.map(role => {
    let score = 0

    // Keyword hits
    for (const kw of role.triggers.keywords) {
      if (textLower.includes(kw.toLowerCase())) score++
    }

    // Path glob hits
    for (const pattern of role.triggers.paths) {
      for (const file of input.workspaceFiles) {
        if (matchesGlob(file, pattern)) {
          score++
          break  // count each pattern at most once
        }
      }
    }

    return { id: role.id, score }
  })

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  // Ensure generalist is always included even if score is 0
  const hasGeneralist = scored.some(s => s.id === 'generalist')
  if (!hasGeneralist) {
    scored.push({ id: 'generalist', score: 0 })
  }

  return scored
}
