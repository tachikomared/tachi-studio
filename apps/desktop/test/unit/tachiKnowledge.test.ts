// apps/desktop/test/unit/tachiKnowledge.test.ts
//
// DURABLE KNOWLEDGE (harness item 7) — the append-back flywheel's pure core.
// The flywheel only works if THREE things hold: the append format is stable
// (a future session must be able to parse what a past one wrote), a note that
// is already recorded is a no-op (otherwise the section fills with restatements
// of the same fact), and an overflow REFUSES instead of trimming (silently
// dropping a note someone deliberately recorded is the one unrecoverable bug).
//
// The loop.ts wiring (gate('write') → executeTool('write')) is not exercised
// here — it is the same gated write path every other mutator uses.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendLearnedNote,
  parseLearnedNotes,
  renderLearnedSection,
  findDuplicate,
  normalizeNote,
  resolveKnowledgeHost,
  trimProjectContext,
  LEARNED_HEADING,
  PROJECT_CONTEXT_FILES,
  DEFAULT_KNOWLEDGE_LIMITS,
} from '../../electron/services/tachi/knowledge'

const NOTE = 'Function-body relative require() never resolves inside the packaged app.asar — use top-level static imports in electron/.'

describe('append format stability', () => {
  it('creates the section at EOF and round-trips through the parser', () => {
    const md = '# AGENTS.md\n\nSome hand-written prose.\n'
    const r = appendLearnedNote(md, NOTE)
    expect(r.status).toBe('appended')
    if (r.status !== 'appended') return
    // User prose is preserved verbatim, the section is appended below it.
    expect(r.content.startsWith('# AGENTS.md\n\nSome hand-written prose.')).toBe(true)
    expect(r.content).toContain(LEARNED_HEADING)
    expect(r.content).toContain(`- ${NOTE}`)
    expect(parseLearnedNotes(r.content)).toEqual([NOTE])
  })

  it('a second note extends the SAME section (no duplicate heading)', () => {
    const one = appendLearnedNote('# AGENTS.md\n', NOTE)
    expect(one.status).toBe('appended')
    if (one.status !== 'appended') return
    const two = appendLearnedNote(one.content, 'Tests live in apps/desktop/test/unit and run under vitest node env.')
    expect(two.status).toBe('appended')
    if (two.status !== 'appended') return
    expect(two.content.split(LEARNED_HEADING).length - 1).toBe(1)
    expect(parseLearnedNotes(two.content)).toHaveLength(2)
    expect(parseLearnedNotes(two.content)[0]).toBe(NOTE)
  })

  it('prose BELOW the section survives (a following heading bounds it)', () => {
    const md = `# AGENTS.md\n\n${LEARNED_HEADING}\n\n- old note about the build\n\n## Orientation\n\nkeep me\n`
    const r = appendLearnedNote(md, NOTE)
    expect(r.status).toBe('appended')
    if (r.status !== 'appended') return
    expect(r.content).toContain('## Orientation')
    expect(r.content).toContain('keep me')
    expect(parseLearnedNotes(r.content)).toEqual(['old note about the build', NOTE])
  })

  it('a multi-line note is stored as ONE line, and says so', () => {
    const r = appendLearnedNote('# AGENTS.md\n', 'line one\n   line two')
    expect(r.status).toBe('appended')
    if (r.status !== 'appended') return
    expect(r.note).toBe('line one line two')
    expect(r.content).toContain('- line one line two')
    expect(r.message).toContain('single line')
    // One bullet per note: the note must not be able to forge extra bullets.
    expect(parseLearnedNotes(r.content)).toHaveLength(1)
  })

  it('renderLearnedSection is the canonical format', () => {
    expect(renderLearnedSection(['a', 'b'])).toBe(
      `${LEARNED_HEADING}\n\n<!-- Appended by TACHI (remember_convention). Durable, project-specific facts only — one line each. Edit, merge or delete freely. -->\n\n- a\n- b\n`,
    )
  })
})

describe('dedup', () => {
  it('an identical note is a no-op that names the existing note', () => {
    const one = appendLearnedNote('# AGENTS.md\n', NOTE)
    if (one.status !== 'appended') throw new Error('setup failed')
    const again = appendLearnedNote(one.content, NOTE)
    expect(again.status).toBe('duplicate')
    expect(again.message).toContain('Already recorded')
    expect(again.message).toContain(NOTE.slice(0, 30))
    expect((again as { content?: string }).content).toBeUndefined()
  })

  it('near-identical (case / punctuation / whitespace) is also a no-op', () => {
    const one = appendLearnedNote('# AGENTS.md\n', 'Use pnpm, never npm, for installs in this monorepo.')
    if (one.status !== 'appended') throw new Error('setup failed')
    const variant = appendLearnedNote(one.content, '  use PNPM — never npm — for installs in this monorepo!!  ')
    expect(variant.status).toBe('duplicate')
  })

  it('a restatement that CONTAINS an existing note is a no-op', () => {
    const one = appendLearnedNote('# AGENTS.md\n', 'i18n keys must exist in all eight locale files')
    if (one.status !== 'appended') throw new Error('setup failed')
    const longer = appendLearnedNote(one.content, 'Remember: i18n keys must exist in all eight locale files or the parity test fails')
    expect(longer.status).toBe('duplicate')
  })

  it('a genuinely different note is NOT a duplicate', () => {
    const one = appendLearnedNote('# AGENTS.md\n', NOTE)
    if (one.status !== 'appended') throw new Error('setup failed')
    const other = appendLearnedNote(one.content, 'The Design tab renders MP4 through @remotion/renderer with the managed Chromium.')
    expect(other.status).toBe('appended')
  })

  it('short overlapping phrases do not collide (containment needs substance)', () => {
    expect(findDuplicate(['use pnpm'], 'use pnpm here and there for everything')).toBeNull()
    expect(normalizeNote('Foo-BAR, baz!')).toBe('foo bar baz')
  })
})

describe('size caps — reject, never trim', () => {
  it('an over-long note is rejected and nothing is written', () => {
    const long = 'x'.repeat(DEFAULT_KNOWLEDGE_LIMITS.maxNoteChars + 1)
    const r = appendLearnedNote('# AGENTS.md\n', long)
    expect(r.status).toBe('rejected')
    expect(r.message).toContain('NOTHING was written')
    expect(r.message).toContain(String(DEFAULT_KNOWLEDGE_LIMITS.maxNoteChars))
    expect((r as { content?: string }).content).toBeUndefined()
  })

  it('an empty note is rejected', () => {
    expect(appendLearnedNote('# AGENTS.md\n', '   ').status).toBe('rejected')
    expect(appendLearnedNote('# AGENTS.md\n', undefined as unknown as string).status).toBe('rejected')
  })

  it('a full section rejects with guidance and touches no existing note', () => {
    const notes = Array.from({ length: 5 }, (_, i) => `note number ${i} about something project specific`)
    const md = `# AGENTS.md\n\n${renderLearnedSection(notes)}`
    const r = appendLearnedNote(md, 'a brand new fact worth keeping around', { maxNotes: 5 })
    expect(r.status).toBe('rejected')
    expect(r.message).toContain('full (5/5')
    expect(r.message).toContain('no existing note was touched')
    // The caller writes nothing → the file keeps all five.
    expect(parseLearnedNotes(md)).toHaveLength(5)
  })

  it('the section byte cap rejects rather than truncating the section', () => {
    const notes = Array.from({ length: 4 }, (_, i) => `${i} ${'y'.repeat(200)}`)
    const md = `# AGENTS.md\n\n${renderLearnedSection(notes)}`
    const r = appendLearnedNote(md, 'z'.repeat(300), { maxSectionChars: 1000 })
    expect(r.status).toBe('rejected')
    expect(r.message).toContain('1000-char cap')
    expect(r.message).toContain('NOTHING was written')
  })

  it('exactly at the note cap is accepted (boundary is inclusive)', () => {
    const exact = 'a'.repeat(DEFAULT_KNOWLEDGE_LIMITS.maxNoteChars)
    expect(appendLearnedNote('# AGENTS.md\n', exact).status).toBe('appended')
  })
})

describe('host resolution — write where the injection wire reads', () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-knowledge-')) })
  afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('picks AGENTS.md when it exists', () => {
    writeFileSync(join(ws, 'AGENTS.md'), '# AGENTS.md\nhello\n')
    expect(resolveKnowledgeHost(ws)).toEqual({ relPath: 'AGENTS.md', content: '# AGENTS.md\nhello\n' })
  })

  it('falls back to the SAME order the injection wire uses (no host hijack)', () => {
    writeFileSync(join(ws, 'CLAUDE.md'), '# CLAUDE.md\n')
    // AGENTS.md absent → must NOT invent one, or the injected file would change.
    expect(resolveKnowledgeHost(ws).relPath).toBe('CLAUDE.md')
    expect(PROJECT_CONTEXT_FILES).toEqual(['AGENTS.md', 'TACHI.md', 'CLAUDE.md'])
  })

  it('defaults to AGENTS.md in a workspace with no context file at all', () => {
    expect(resolveKnowledgeHost(ws)).toEqual({ relPath: 'AGENTS.md', content: '' })
  })
})

describe('trimProjectContext — the notes survive the injection budget', () => {
  it('short files pass through untouched', () => {
    expect(trimProjectContext('# AGENTS.md\n', 'AGENTS.md')).toBe('# AGENTS.md\n')
  })

  it('a note past the budget is re-attached after the trim marker', () => {
    const filler = `# AGENTS.md\n\n${'prose line\n'.repeat(200)}`
    const withNote = appendLearnedNote(filler, NOTE)
    if (withNote.status !== 'appended') throw new Error('setup failed')
    const trimmed = trimProjectContext(withNote.content, 'AGENTS.md', 500)
    expect(trimmed).toContain('…[trimmed — read AGENTS.md for the rest]')
    expect(trimmed).toContain(NOTE)
    expect(trimmed).toContain(LEARNED_HEADING)
  })

  it('a section INSIDE the kept head is not duplicated', () => {
    const md = `${renderLearnedSection([NOTE])}\n${'tail line\n'.repeat(300)}`
    const trimmed = trimProjectContext(md, 'AGENTS.md', 1000)
    expect(trimmed.split(LEARNED_HEADING).length - 1).toBe(1)
  })
})
