// apps/desktop/electron/services/tachi/knowledge.ts
//
// DURABLE KNOWLEDGE (harness item 7) — the "learn this convention" flywheel.
//
// A run that discovers a non-obvious project fact ("the packaged asar can't
// resolve function-body relative requires") currently loses it the moment the
// session ends. remember_convention (loop.ts) appends it to a fixed section of
// the workspace's project-context file, so the NEXT session reads it back for
// free: the file it writes is the one the existing injection wire already
// loads (agent.ipc.ts loadTachiProjectContext → prompt.ts "Project context"),
// so there is zero new injection plumbing and the knowledge travels with the
// repo instead of living in app-local state.
//
// Everything here is pure string work except resolveKnowledgeHost (one fs
// existence check per candidate) — the tool's actual WRITE goes back through
// loop.ts's permission gate + executeTool('write'), never from this module.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Candidate project-context files, in the order the injection wire picks them
 * (first existing one wins). Exported so agent.ipc.ts and the knowledge tool
 * can never drift into writing one file while injecting another.
 */
export const PROJECT_CONTEXT_FILES = ['AGENTS.md', 'TACHI.md', 'CLAUDE.md'] as const

/** How many chars of the project-context file the injection wire keeps. */
export const PROJECT_CONTEXT_CHAR_BUDGET = 6000

/** The one section TACHI owns. Everything above/below it is the user's prose. */
export const LEARNED_HEADING = '## Learned notes (TACHI)'

const LEARNED_PREAMBLE =
  '<!-- Appended by TACHI (remember_convention). Durable, project-specific facts only — one line each. Edit, merge or delete freely. -->'

export interface KnowledgeLimits {
  /** Max notes the section may hold. Overflow REJECTS (never evicts someone's note). */
  maxNotes: number
  /** Max chars of a single note. */
  maxNoteChars: number
  /** Max chars of the rendered section (heading + preamble + notes). */
  maxSectionChars: number
}

export const DEFAULT_KNOWLEDGE_LIMITS: KnowledgeLimits = {
  maxNotes: 40,
  maxNoteChars: 400,
  maxSectionChars: 6000,
}

/** Collapse a note to ONE line (the append format is one bullet per note). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Dedup key: case/punctuation/whitespace-insensitive. Two notes that differ
 * only in wording noise are the same note as far as the flywheel is concerned.
 */
export function normalizeNote(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Shortest normalized length at which "one note contains the other" counts as a duplicate. */
const CONTAINMENT_MIN_CHARS = 24

/** The existing note that makes `note` redundant, or null. */
export function findDuplicate(existing: readonly string[], note: string): string | null {
  const key = normalizeNote(note)
  if (!key) return null
  for (const prev of existing) {
    const prevKey = normalizeNote(prev)
    if (prevKey === key) return prev
    const shorter = key.length <= prevKey.length ? key : prevKey
    if (shorter.length < CONTAINMENT_MIN_CHARS) continue
    if (prevKey.includes(key) || key.includes(prevKey)) return prev
  }
  return null
}

/** Char range of the learned-notes section in `md` (heading start → next heading / EOF). */
function locateSection(md: string): { start: number; end: number } | null {
  const lines = md.split('\n')
  let offset = 0
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (start === -1) {
      if (line.trim() === LEARNED_HEADING) { start = offset }
    } else if (/^#{1,6}\s/.test(line)) {
      return { start, end: offset }
    }
    offset += line.length + 1
  }
  return start === -1 ? null : { start, end: md.length }
}

/** The notes currently recorded, in file order (bullet text, no "- " prefix). */
export function parseLearnedNotes(md: string): string[] {
  const at = locateSection(md)
  if (!at) return []
  return md.slice(at.start, at.end)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).trim())
    .filter(Boolean)
}

/** Render the canonical section body. THE append format — tests pin this. */
export function renderLearnedSection(notes: readonly string[]): string {
  return [LEARNED_HEADING, '', LEARNED_PREAMBLE, '', ...notes.map(n => `- ${n}`), ''].join('\n')
}

/** Replace the existing section, or append a fresh one at EOF (outside any generated block). */
function spliceSection(md: string, section: string): string {
  const at = locateSection(md)
  if (at) {
    const head = md.slice(0, at.start)
    const tail = md.slice(at.end)
    return `${head}${section}${tail}`.replace(/\n{3,}$/, '\n')
  }
  const base = md.trim()
  return base ? `${base}\n\n${section}` : `${section}`
}

export type AppendResult =
  | { status: 'appended'; content: string; note: string; message: string }
  | { status: 'duplicate'; message: string }
  | { status: 'rejected'; message: string }

export interface AppendOptions extends Partial<KnowledgeLimits> {
  /** Host file name, for the model-facing message only. */
  hostName?: string
}

/**
 * Compute the new file content for `note`. NOTHING is written here — the caller
 * gates the write. Overflow always REJECTS with guidance: silently trimming (or
 * evicting an older note) would lose knowledge someone deliberately recorded.
 */
export function appendLearnedNote(md: string, rawNote: string, opts: AppendOptions = {}): AppendResult {
  const limits: KnowledgeLimits = { ...DEFAULT_KNOWLEDGE_LIMITS, ...opts }
  const host = opts.hostName ?? PROJECT_CONTEXT_FILES[0]
  const note = oneLine(typeof rawNote === 'string' ? rawNote : '')

  if (!note) {
    return { status: 'rejected', message: 'remember_convention needs a non-empty note — one sentence stating the durable, project-specific fact you learned.' }
  }
  if (note.length > limits.maxNoteChars) {
    return {
      status: 'rejected',
      message: `remember_convention rejected: the note is ${note.length} chars (cap ${limits.maxNoteChars}). NOTHING was written. Shorten it to the one durable fact — put any long explanation in a doc and record a one-line pointer to it instead.`,
    }
  }

  const existing = parseLearnedNotes(md)
  const dup = findDuplicate(existing, note)
  if (dup) {
    return { status: 'duplicate', message: `Already recorded in ${host} — nothing written. Existing note: "${dup}"` }
  }
  if (existing.length >= limits.maxNotes) {
    return {
      status: 'rejected',
      message: `remember_convention rejected: "${LEARNED_HEADING}" in ${host} is full (${existing.length}/${limits.maxNotes} notes). NOTHING was written and no existing note was touched. Merge or delete stale notes there first (read + edit the file), then record this one.`,
    }
  }

  const next = [...existing, note]
  const section = renderLearnedSection(next)
  if (section.length > limits.maxSectionChars) {
    return {
      status: 'rejected',
      message: `remember_convention rejected: adding this note would push "${LEARNED_HEADING}" past its ${limits.maxSectionChars}-char cap. NOTHING was written. Shorten the note, or merge/prune existing notes in ${host} first.`,
    }
  }

  const content = spliceSection(md, section)
  const collapsed = oneLine(rawNote) !== rawNote.trim()
  return {
    status: 'appended',
    content,
    note,
    message: `Recorded in ${host} under "${LEARNED_HEADING}" (${next.length}/${limits.maxNotes} notes)${collapsed ? ' — stored as a single line' : ''}. Future sessions receive it as project context.`,
  }
}

/**
 * The project-context file this workspace already injects (first existing
 * candidate), or the default when none exists yet. Writing anywhere else would
 * either be invisible to future sessions or would HIJACK the injection (e.g.
 * creating AGENTS.md in a CLAUDE.md workspace silently swaps which file is read).
 */
export function resolveKnowledgeHost(workspaceRoot: string): { relPath: string; content: string } {
  for (const name of PROJECT_CONTEXT_FILES) {
    try {
      const p = join(workspaceRoot, name)
      if (!existsSync(p)) continue
      return { relPath: name, content: readFileSync(p, 'utf8') }
    } catch { /* unreadable candidate → try the next one */ }
  }
  return { relPath: PROJECT_CONTEXT_FILES[0], content: '' }
}

/**
 * Budget-trim the project-context file for injection, PRESERVING the learned
 * notes. They live at the end of the file, so a naive head-slice would drop
 * exactly the knowledge previous runs paid to record.
 */
export function trimProjectContext(raw: string, name: string, limit = PROJECT_CONTEXT_CHAR_BUDGET): string {
  if (raw.length <= limit) return raw
  const head = `${raw.slice(0, limit)}\n…[trimmed — read ${name} for the rest]`
  const at = locateSection(raw)
  // Already inside the kept head → nothing to re-attach (and no duplication).
  if (!at || at.start < limit) return head
  const notes = parseLearnedNotes(raw)
  if (notes.length === 0) return head
  let section = renderLearnedSection(notes)
  if (section.length > DEFAULT_KNOWLEDGE_LIMITS.maxSectionChars) {
    section = `${section.slice(0, DEFAULT_KNOWLEDGE_LIMITS.maxSectionChars)}\n…[trimmed — read ${name} for the rest]`
  }
  return `${head}\n\n${section}`
}
