// apps/desktop/electron/services/tachi/skills-registry.ts
//
// Skills registry + installer + workspace marker scan (main process, but
// deliberately electron-FREE — node builtins + @tachi/core only, so the unit
// tests in test/unit/skillsRegistry.test.ts import it directly).
//
// Three responsibilities:
//   1. SKILL_REGISTRY — a STATIC, hash-pinned catalog of external skills. Every
//      entry pins BOTH the content (sha256) and the source (a raw.githubusercontent
//      URL at a 40-hex commit, never a branch). Install is fail-closed: any
//      mismatch, any non-pinned URL, any unknown id → nothing is written.
//   2. installSkill() — download → verify → write to <workspace>/.tachi/skills/<id>/SKILL.md
//      (the highest-precedence discovery root in skills-host.ts, so an installed
//      skill immediately shows up in <available_skills>).
//   3. scanWorkspaceMarkers() — the cheap top-2-level scan that feeds the pure
//      suggestSkills() table in @tachi/core.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { isValidSkillName, type WorkspaceMarkers } from '@tachi/core'

// ── Registry ──────────────────────────────────────────────────────────────────

/** One pinned catalog entry. `url` MUST point at a specific commit, not a branch. */
export interface SkillRegistryEntry {
  /** Skill id — becomes the install folder name; must satisfy isValidSkillName. */
  id: string
  /** Short human title for the Settings row. */
  title: string
  /** One-line description shown under the title. */
  description: string
  /** https://raw.githubusercontent.com/<owner>/<repo>/<40-hex-commit>/<path-to-SKILL.md> */
  url: string
  /** Lowercase hex sha256 of the exact file bytes at that commit. */
  sha256: string
}

/**
 * The shipped catalog. INTENTIONALLY EMPTY for now: an entry may only be added
 * after (a) the source repo's license is confirmed permissive (MIT/Apache-2.0/
 * BSD — verified by a human, recorded in the entry's comment) and (b) the
 * sha256 is computed from the actual bytes at the pinned commit. We do not
 * guess hashes and we do not point at branches; shipping zero entries keeps the
 * whole mechanism fail-closed instead of shipping unverifiable pins.
 *
 * To add an entry:
 *   1. Pick the file at a specific commit: raw.githubusercontent.com/o/r/<sha>/path/SKILL.md
 *   2. Download it, read the repo LICENSE, note both in the entry comment.
 *   3. sha256 the exact bytes; paste as lowercase hex.
 */
export const SKILL_REGISTRY: SkillRegistryEntry[] = []

/** Hosts install may fetch from. Single-host on purpose — pinned-commit raws only. */
export const ALLOWED_REGISTRY_HOSTS = ['raw.githubusercontent.com']

/** Hard cap for a downloaded SKILL.md — these are checklists, not models. */
export const MAX_SKILL_BYTES = 256 * 1024

// ── Pure verification helpers (unit-tested directly) ─────────────────────────

/** Lowercase hex sha256 of a string (UTF-8) or raw bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export interface VerifyResult {
  ok: boolean
  /** Hash actually computed from the payload. */
  actual: string
  /** Pin it was compared against (normalized to lowercase). */
  expected: string
}

/** Compare payload bytes against a pinned sha256. Case-insensitive on the pin. */
export function verifyPinnedSha256(payload: string | Uint8Array, expectedSha256: string): VerifyResult {
  const expected = (expectedSha256 ?? '').trim().toLowerCase()
  const actual = sha256Hex(payload)
  return { ok: expected.length === 64 && actual === expected, actual, expected }
}

/**
 * Validate a registry URL: https, allow-listed host, and — for github raws —
 * a 40-hex commit SHA as the ref segment (so the pin can never drift under a
 * moving branch). Returns an error string, or null when the URL is acceptable.
 */
export function validateRegistryUrl(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return `invalid URL: ${url}` }
  if (parsed.protocol !== 'https:') return `only https is allowed (got ${parsed.protocol})`
  if (!ALLOWED_REGISTRY_HOSTS.includes(parsed.hostname)) {
    return `host ${parsed.hostname} is not in the registry allowlist`
  }
  // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path...>
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 4) return 'URL is missing owner/repo/ref/path segments'
  const ref = segments[2]
  if (!/^[0-9a-f]{40}$/i.test(ref)) {
    return `ref "${ref}" is not a 40-hex commit SHA — registry URLs must pin a commit, not a branch`
  }
  return null
}

// ── Installer ─────────────────────────────────────────────────────────────────

/** Injectable fetch (tests pass a fake; production uses global fetch). */
export type SkillFetcher = (url: string) => Promise<{ status: number; body: Uint8Array }>

export interface InstallSkillResult {
  ok: boolean
  skillId: string
  /** Absolute path of the written SKILL.md (success only). */
  path?: string
  /** Human-readable failure reason (failure only). */
  error?: string
}

const defaultFetcher: SkillFetcher = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' })
    const buf = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, body: buf }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Install a registry skill into `<workspaceRoot>/.tachi/skills/<id>/SKILL.md`.
 * Fail-closed at every step: unknown id, invalid URL, oversized/short payload,
 * or a sha256 mismatch all return { ok: false } WITHOUT writing anything.
 * Never throws — IPC surfaces the error string to the UI.
 */
export async function installSkill(
  id: string,
  workspaceRoot: string,
  opts?: { fetcher?: SkillFetcher; registry?: SkillRegistryEntry[] },
): Promise<InstallSkillResult> {
  const skillId = (id ?? '').trim().toLowerCase()
  const fail = (error: string): InstallSkillResult => ({ ok: false, skillId, error })

  const registry = opts?.registry ?? SKILL_REGISTRY
  const entry = registry.find(e => e.id === skillId)
  if (!entry) return fail(`"${skillId}" is not in the skills registry`)
  // The id becomes a folder name — the strict skill-name shape doubles as
  // traversal protection (no dots, slashes, or separators can pass).
  if (!isValidSkillName(skillId)) return fail(`"${skillId}" is not a valid skill id`)

  if (!workspaceRoot || !isAbsolute(workspaceRoot)) return fail('no workspace open')
  try {
    if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
      return fail(`workspace root is not a directory: ${workspaceRoot}`)
    }
  } catch (e) {
    return fail(`cannot access workspace root: ${(e as Error).message}`)
  }

  const urlError = validateRegistryUrl(entry.url)
  if (urlError) return fail(`registry entry rejected: ${urlError}`)

  let payload: Uint8Array
  try {
    const res = await (opts?.fetcher ?? defaultFetcher)(entry.url)
    if (res.status !== 200) return fail(`download failed: HTTP ${res.status}`)
    payload = res.body
  } catch (e) {
    return fail(`download failed: ${(e as Error).message}`)
  }
  if (payload.byteLength === 0) return fail('download failed: empty body')
  if (payload.byteLength > MAX_SKILL_BYTES) {
    return fail(`downloaded file is ${payload.byteLength} bytes — over the ${MAX_SKILL_BYTES} byte skill cap`)
  }

  const verify = verifyPinnedSha256(payload, entry.sha256)
  if (!verify.ok) {
    // The single most important branch in this file: content changed under the
    // pin (or the pin is malformed) → REFUSE. Nothing is written.
    return fail(`sha256 mismatch — expected ${verify.expected || '(malformed pin)'}, got ${verify.actual}. Refusing to install.`)
  }

  // Containment: the target must resolve inside <workspaceRoot>/.tachi/skills.
  const skillsBase = resolve(workspaceRoot, '.tachi', 'skills')
  const targetDir = resolve(skillsBase, skillId)
  if (targetDir !== skillsBase && !targetDir.startsWith(skillsBase + sep)) {
    return fail('install path escaped the skills folder')
  }

  try {
    mkdirSync(targetDir, { recursive: true })
    const targetPath = join(targetDir, 'SKILL.md')
    writeFileSync(targetPath, Buffer.from(payload))
    return { ok: true, skillId, path: targetPath }
  } catch (e) {
    return fail(`could not write skill: ${(e as Error).message}`)
  }
}

// ── Workspace marker scan (feeds @tachi/core suggestSkills) ──────────────────

/** Dirs never descended into or reported — build output and vendored trees. */
const SCAN_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage',
  '.venv', 'venv', '__pycache__', '.next', '.turbo', '.cache', 'vendor',
])

/** Cap on collected paths — markers are a hint, not an index. */
const SCAN_MAX_PATHS = 400

/**
 * Collect WorkspaceMarkers from the top TWO directory levels of `root`:
 * relative paths of files and dirs (forward slashes), package.json dep names,
 * and the set of file extensions seen. Best-effort — any fs error yields
 * whatever was collected so far; a bad root yields empty markers.
 */
export function scanWorkspaceMarkers(root: string): WorkspaceMarkers {
  const empty: WorkspaceMarkers = { files: [], deps: [], languages: [] }
  if (!root || !isAbsolute(root)) return empty
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return empty
  } catch { return empty }

  const files: string[] = []
  const languages = new Set<string>()

  const record = (relPath: string, isFile: boolean): void => {
    if (files.length >= SCAN_MAX_PATHS) return
    files.push(relPath)
    if (isFile) {
      const ext = extname(relPath).slice(1).toLowerCase()
      if (ext) languages.add(ext)
    }
  }

  try {
    const top = readdirSync(root, { withFileTypes: true })
    for (const e of top) {
      if (SCAN_IGNORE.has(e.name.toLowerCase())) continue
      record(e.name, e.isFile())
      if (!e.isDirectory()) continue
      let second: import('node:fs').Dirent[]
      try { second = readdirSync(join(root, e.name), { withFileTypes: true }) } catch { continue }
      for (const s of second) {
        if (SCAN_IGNORE.has(s.name.toLowerCase())) continue
        record(`${e.name}/${s.name}`, s.isFile())
      }
    }
  } catch { /* fail open to what we have */ }

  const deps: string[] = []
  try {
    const pkgPath = join(root, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      for (const name of Object.keys(pkg.dependencies ?? {})) deps.push(name)
      for (const name of Object.keys(pkg.devDependencies ?? {})) deps.push(name)
    }
  } catch { /* unparseable package.json → no deps */ }

  return { files, deps, languages: [...languages] }
}
