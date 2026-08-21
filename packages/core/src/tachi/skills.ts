// packages/core/src/tachi/skills.ts
//
// SKILL.md skills v1 — the PURE half of progressive disclosure for the TACHI
// harness. A "skill" is a folder holding a SKILL.md whose YAML frontmatter
// carries a name + description (Anthropic-community-compatible layout). The
// system prompt lists only the cheap metadata (<available_skills>); the model
// pulls a skill's full body into context on demand via the skill_view tool.
//
// This module owns the parsing + prompt-block formatting only. Discovery of
// skill folders on disk (electron paths: resources / userData / workspace) is
// electron-coupled and lives in apps/desktop .../tachi/skills-host.ts.
//
// Design priorities, in order:
//   1. No dependencies. Frontmatter is parsed as simple `key: value` lines
//      between --- fences — deliberately NOT full YAML (no nesting, no lists).
//      Anything fancier is silently ignored rather than mis-parsed.
//   2. Strict names. A skill name is a tool-facing identifier, so it must match
//      /^[a-z0-9][a-z0-9-]{0,63}$/ after lowercasing — anything else is treated
//      as absent (the host falls back or skips the skill).
//   3. Bounded prompt cost. buildAvailableSkillsBlock degrades gracefully under
//      a char budget: full lines → name-only compact mode → truncated list.
//
// Pure TypeScript: no electron / node / network.

/** One discovered skill: prompt-block metadata + where its folder lives. */
export interface SkillMeta {
  /** Identifier the model passes to skill_view. Lowercase, /^[a-z0-9][a-z0-9-]{0,63}$/. */
  name: string
  /** One-line "when to use this" from the frontmatter (may be ''). */
  description: string
  /** Which layer the skill came from (later layers win on name collision). */
  layer: 'bundled' | 'project' | 'workspace'
  /** Absolute path of the skill's folder (holds SKILL.md + optional references/). */
  dir: string
}

/** Valid skill-name shape (after lowercasing). Kept exported-adjacent via isValidSkillName. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** True when `name` (lowercased) is a legal skill identifier. */
export function isValidSkillName(name: string): boolean {
  return NAME_RE.test(name.toLowerCase())
}

/**
 * Parse the YAML frontmatter of a SKILL.md: the block between an opening `---`
 * line (first non-empty line of the file) and the next `---` line. Only simple
 * one-line `key: value` pairs are read — nested YAML, lists and multi-line
 * scalars are ignored, never mis-parsed. Surrounding single/double quotes on a
 * value are stripped. The name is lowercased and validated; an invalid name
 * comes back as undefined (caller decides the fallback).
 *
 * Returns null when the text has no frontmatter fences at all.
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } | null {
  if (typeof text !== 'string') return null
  const lines = text.split(/\r?\n/)

  // The opening fence must be the first non-empty line.
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i >= lines.length || lines[i].trim() !== '---') return null

  // Find the closing fence.
  let end = -1
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '---') { end = j; break }
  }
  if (end === -1) return null

  const out: { name?: string; description?: string } = {}
  for (let j = i + 1; j < end; j++) {
    const line = lines[j]
    // Simple `key: value` only. Continuation/nested lines (leading whitespace)
    // and comment lines are skipped.
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = stripQuotes(m[2].trim())
    if (key === 'name') {
      const name = value.toLowerCase()
      if (NAME_RE.test(name)) out.name = name
    } else if (key === 'description') {
      if (value !== '') out.description = value
    }
  }
  return out
}

/** Strip one layer of matching single or double quotes around a value. */
function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/**
 * Return the SKILL.md body with the frontmatter block removed (the model wants
 * the instructions, not the metadata it already saw). Text without frontmatter
 * comes back unchanged.
 */
export function stripSkillFrontmatter(text: string): string {
  if (typeof text !== 'string') return ''
  if (parseSkillFrontmatter(text) === null) return text
  const lines = text.split(/\r?\n/)
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  // parseSkillFrontmatter returned non-null → the fences exist; find the close.
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === '---') return lines.slice(j + 1).join('\n').replace(/^\n+/, '')
  }
  return text
}

const BLOCK_OPEN = '<available_skills>'
const BLOCK_CLOSE = '</available_skills>'
const BLOCK_HEADER = 'These are skill names for the skill_view tool — they are NOT callable tools themselves.'

/**
 * Render the <available_skills> prompt block. Degrades under `budgetChars`:
 *   1. Full mode: one `name — description (layer)` line per skill.
 *   2. Compact mode (over budget): descriptions dropped, name-only lines.
 *   3. Truncated (still over): the list is cut — always keeping the header and
 *      at least ONE entry — with an omission note so the model knows.
 * Empty input → '' (no block at all; an empty listing would only invite
 * hallucinated names).
 */
export function buildAvailableSkillsBlock(skills: SkillMeta[], budgetChars: number): string {
  if (!Array.isArray(skills) || skills.length === 0) return ''

  const assemble = (entries: string[], omitted: number): string => {
    const note = omitted > 0 ? [`[... ${omitted} more skill(s) omitted for budget ...]`] : []
    return [BLOCK_OPEN, BLOCK_HEADER, ...entries, ...note, BLOCK_CLOSE].join('\n')
  }

  // 1. Full mode.
  const full = skills.map(s => (s.description ? `${s.name} — ${s.description} (${s.layer})` : `${s.name} (${s.layer})`))
  let block = assemble(full, 0)
  if (block.length <= budgetChars) return block

  // 2. Compact mode: names only.
  const compact = skills.map(s => s.name)
  block = assemble(compact, 0)
  if (block.length <= budgetChars) return block

  // 3. Truncate the compact list, keeping >= 1 entry no matter how tight the
  // budget is (an over-budget-but-minimal block beats an empty/announced-then-
  // missing one).
  for (let keep = skills.length - 1; keep >= 1; keep--) {
    block = assemble(compact.slice(0, keep), skills.length - keep)
    if (block.length <= budgetChars) return block
  }
  return assemble(compact.slice(0, 1), skills.length - 1)
}
