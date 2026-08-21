// apps/desktop/electron/services/tachi/skills-host.ts
//
// SKILL.md skills v1 — the ELECTRON half of progressive disclosure. Discovers
// skill folders (each a SUBFOLDER holding a SKILL.md) across the app's layers
// and serves their content to the skill_view tool. The pure parsing/formatting
// half (frontmatter, <available_skills> block) lives in @tachi/core skills.ts.
//
// Layer precedence — later wins on a name collision:
//   1. bundled   — shipped with the app: <resourcesPath>/skills (packaged) or
//                  <appPath>/resources/skills (dev fallback)
//   2. workspace — the user's app-wide dir: <userData>/skills
//   3. project   — inside the open workspace: <root>/.tachi/skills, <root>/skills
//
// Everything is best-effort and fail-open-to-empty: a missing dir, unreadable
// file, or broken frontmatter never throws — the skill is simply absent.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { app } from 'electron'
import { parseSkillFrontmatter, stripSkillFrontmatter, isValidSkillName, type SkillMeta } from '@tachi/core'

/** Hard cap on discovered skills — bounds both scan work and prompt size. */
const MAX_SKILLS = 50
/** Cap on any file body handed to the model (SKILL.md or a referenced subfile). */
const VIEW_MAX_CHARS = 20_000

/** The layer roots to scan, in precedence order (later wins on name collision). */
function layerRoots(workspaceRoot: string): Array<{ dir: string; layer: SkillMeta['layer'] }> {
  const roots: Array<{ dir: string; layer: SkillMeta['layer'] }> = []
  // Bundled (packaged build): extraResources land next to the asar.
  try {
    const res = process.resourcesPath
    if (res && existsSync(join(res, 'skills'))) roots.push({ dir: join(res, 'skills'), layer: 'bundled' })
  } catch { /* no resourcesPath outside electron */ }
  // Bundled (dev fallback): the repo's resources/skills next to the app source.
  try {
    const devDir = join(app.getAppPath(), 'resources', 'skills')
    if (existsSync(devDir) && !roots.some(r => r.dir === devDir)) roots.push({ dir: devDir, layer: 'bundled' })
  } catch { /* app unavailable (tests without a mock) */ }
  // User's app-wide skills.
  try {
    roots.push({ dir: join(app.getPath('userData'), 'skills'), layer: 'workspace' })
  } catch { /* app unavailable */ }
  // Project-local skills (highest precedence). Besides our own dirs, read the
  // ecosystem conventions (autoskills/skills.sh install into .agents/skills
  // and symlink .claude/skills; Claude Code reads .claude/skills) so skills
  // installed by those tools Just Work in TACHI — read-only compat, we never
  // write there.
  if (workspaceRoot && typeof workspaceRoot === 'string') {
    roots.push({ dir: join(workspaceRoot, '.tachi', 'skills'), layer: 'project' })
    roots.push({ dir: join(workspaceRoot, 'skills'), layer: 'project' })
    roots.push({ dir: join(workspaceRoot, '.agents', 'skills'), layer: 'project' })
    roots.push({ dir: join(workspaceRoot, '.claude', 'skills'), layer: 'project' })
  }
  return roots
}

/** Read one candidate skill folder → SkillMeta, or null when it isn't a skill. */
function readSkillDir(dir: string, folderName: string, layer: SkillMeta['layer']): SkillMeta | null {
  try {
    const mdPath = join(dir, 'SKILL.md')
    if (!existsSync(mdPath) || !statSync(mdPath).isFile()) return null
    const fm = parseSkillFrontmatter(readFileSync(mdPath, 'utf8'))
    // Frontmatter name wins; fall back to the folder name when it's a legal id.
    const fallback = folderName.toLowerCase()
    const name = fm?.name ?? (isValidSkillName(fallback) ? fallback : undefined)
    if (!name) return null
    return { name, description: fm?.description ?? '', layer, dir }
  } catch {
    return null
  }
}

/**
 * Discover installed skills across all layers. Later layers override earlier
 * ones on a name collision (project > workspace/user > bundled). Capped at
 * MAX_SKILLS; never throws — worst case is an empty list.
 */
export function discoverSkills(workspaceRoot: string): SkillMeta[] {
  const byName = new Map<string, SkillMeta>()
  try {
    for (const { dir, layer } of layerRoots(workspaceRoot)) {
      let entries: import('node:fs').Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        const meta = readSkillDir(join(dir, e.name), e.name, layer)
        // Map.set on a repeat name replaces the earlier layer's entry (later wins).
        if (meta) byName.set(meta.name, meta)
      }
    }
  } catch { /* fail open to whatever was collected */ }
  return [...byName.values()].slice(0, MAX_SKILLS)
}

/**
 * Serve a skill's content to the model. Without filePath → the SKILL.md body
 * (frontmatter stripped). With filePath → that RELATIVE path inside the
 * skill's own folder ONLY (references/scripts subfiles); traversal outside the
 * folder is rejected. Always returns a model-facing string — never throws.
 */
export function viewSkill(workspaceRoot: string, name: string, filePath?: string): string {
  const wanted = (name ?? '').trim().toLowerCase()
  const skill = discoverSkills(workspaceRoot).find(s => s.name === wanted)
  if (!skill) {
    // Anti-hallucination contract: an unknown name must NOT send the model
    // hunting through the workspace for a folder that doesn't exist.
    return `No skill named "${name}" is installed. Do NOT search the filesystem for it — pick one from <available_skills> or proceed without a skill.`
  }

  try {
    if (filePath === undefined || filePath.trim() === '') {
      const body = stripSkillFrontmatter(readFileSync(join(skill.dir, 'SKILL.md'), 'utf8')).trim()
      return cap(body || '(this skill\'s SKILL.md has no body)')
    }

    // Containment: the requested path must resolve INSIDE the skill folder.
    const base = resolve(skill.dir)
    const abs = resolve(base, filePath)
    if (abs !== base && !abs.startsWith(base + sep)) {
      return `Rejected: "${filePath}" resolves outside the "${skill.name}" skill folder. Only relative paths inside the skill (e.g. "references/usage.md") are allowed.`
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return `The "${skill.name}" skill has no file at "${filePath}".`
    }
    return cap(readFileSync(abs, 'utf8'))
  } catch (e) {
    return `skill_view could not read that content: ${(e as Error).message}`
  }
}

function cap(text: string): string {
  return text.length > VIEW_MAX_CHARS
    ? text.slice(0, VIEW_MAX_CHARS) + `\n[... truncated at ${VIEW_MAX_CHARS} chars ...]`
    : text
}
