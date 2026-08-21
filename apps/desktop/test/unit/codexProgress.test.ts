// apps/desktop/test/unit/codexProgress.test.ts
//
// The codex vertical's routing seam. loop.ts forwards worker progress as plain
// transcript text —
//
//   onProgress: (line) => onEventSafe(opts.onEvent, { type: 'text', text: `[codex] ${line}\n` })
//
// — and agent.store coalesces consecutive text chunks, so ONE text event
// typically carries a whole run's worth of progress. These helpers decide what
// belongs to a card and what stays transcript; getting them wrong either loses
// prose or leaves the old grey wall of "[codex] $ …" lines under the card.
import { describe, it, expect } from 'vitest'
import {
  CODEX_PROGRESS_PREFIX,
  PROGRESS_CAP,
  appendProgress,
  classifyProgress,
  codexToolKind,
  isCodexFamilyTool,
  progressBody,
  progressTail,
  shouldShowProgress,
  splitCodexProgress,
} from '../../src/pages/agent/codexProgress'

describe('codexToolKind', () => {
  it('separates the two codex tools, prefix and spelling tolerant', () => {
    expect(codexToolKind('codex_worker')).toBe('worker')
    expect(codexToolKind('CODEX_WORKER')).toBe('worker')
    expect(codexToolKind('codex-worker')).toBe('worker')
    expect(codexToolKind('[2] codex_worker')).toBe('worker')
    expect(codexToolKind('codex_review')).toBe('review')
    expect(codexToolKind('  Codex_Review  ')).toBe('review')
    expect(codexToolKind('[7] codex_review')).toBe('review')
  })

  it('claims nothing else', () => {
    expect(codexToolKind('codex_reviewer')).toBeNull()
    expect(codexToolKind('Bash')).toBeNull()
    expect(codexToolKind('')).toBeNull()
    expect(codexToolKind(undefined)).toBeNull()
    expect(codexToolKind(42)).toBeNull()
    expect(isCodexFamilyTool('codex_review')).toBe(true)
    expect(isCodexFamilyTool('Read')).toBe(false)
  })
})

describe('splitCodexProgress', () => {
  it('lifts every prefixed line out of a coalesced text blob', () => {
    const text = `${CODEX_PROGRESS_PREFIX}$ npm test\n[codex] edit src/foo.ts\n[codex] error: boom\n`
    const { progress, rest } = splitCodexProgress(text)
    expect(progress).toEqual(['$ npm test', 'edit src/foo.ts', 'error: boom'])
    expect(rest).toBe('')
  })

  it('keeps non-progress prose in a MIXED blob — routing must not eat transcript', () => {
    const { progress, rest } = splitCodexProgress('[codex] $ ls\nI will now summarize.\n[codex] done\n')
    expect(progress).toEqual(['$ ls', 'done'])
    expect(rest).toBe('I will now summarize.')
  })

  it('passes ordinary text straight through', () => {
    const { progress, rest } = splitCodexProgress('Here is the plan:\n1. do the thing')
    expect(progress).toEqual([])
    expect(rest).toBe('Here is the plan:\n1. do the thing')
  })

  it('drops empty progress lines and survives junk input', () => {
    expect(splitCodexProgress('[codex] \n[codex]   \n[codex] real').progress).toEqual(['real'])
    expect(splitCodexProgress(undefined)).toEqual({ progress: [], rest: '' })
    expect(splitCodexProgress('')).toEqual({ progress: [], rest: '' })
  })

  it('handles CRLF the same as LF', () => {
    expect(splitCodexProgress('[codex] $ a\r\n[codex] $ b\r\n').progress).toEqual(['$ a', '$ b'])
  })
})

describe('appendProgress', () => {
  it('appends in order and skips a repeat of the current tail', () => {
    expect(appendProgress(undefined, ['a', 'b'])).toEqual(['a', 'b'])
    expect(appendProgress(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('never mutates the buffer it was handed', () => {
    const existing = ['a']
    expect(appendProgress(existing, ['b'])).toEqual(['a', 'b'])
    expect(existing).toEqual(['a'])
  })

  it('caps the buffer at the worker cap, keeping the newest lines', () => {
    const many = Array.from({ length: PROGRESS_CAP + 25 }, (_, i) => `line ${i}`)
    const out = appendProgress([], many)
    expect(out).toHaveLength(PROGRESS_CAP)
    expect(out[out.length - 1]).toBe(`line ${PROGRESS_CAP + 24}`)
  })
})

describe('classifyProgress / progressBody', () => {
  it('reads the shapes summarizeEvent() emits', () => {
    expect(classifyProgress('$ npm run build')).toBe('command')
    expect(classifyProgress('edit src/app.tsx')).toBe('edit')
    expect(classifyProgress('error: spawn ENOENT')).toBe('error')
    expect(classifyProgress('agent_reasoning')).toBe('note')
    expect(classifyProgress(null)).toBe('note')
  })

  it('strips the "$ " marker so the row can draw its own glyph', () => {
    expect(progressBody('$ npm test')).toBe('npm test')
    expect(progressBody('edit a.ts')).toBe('edit a.ts')
  })
})

describe('progressTail', () => {
  it('keeps the newest lines and reports how many scrolled away', () => {
    expect(progressTail(['a', 'b', 'c'], 8)).toEqual({ shown: ['a', 'b', 'c'], hidden: 0 })
    expect(progressTail(['a', 'b', 'c', 'd'], 2)).toEqual({ shown: ['c', 'd'], hidden: 2 })
    expect(progressTail([], 8)).toEqual({ shown: [], hidden: 0 })
  })
})

describe('shouldShowProgress', () => {
  it('streams while the worker runs', () => {
    expect(shouldShowProgress({ running: true, hasResultDetail: false, progressCount: 3 })).toBe(true)
  })

  it('retires once the result lands — the card must END in its terminal state', () => {
    expect(shouldShowProgress({ running: false, hasResultDetail: true, progressCount: 30 })).toBe(false)
  })

  it('stays when the result carried no detail at all (progress is the only evidence)', () => {
    expect(shouldShowProgress({ running: false, hasResultDetail: false, progressCount: 30 })).toBe(true)
  })

  it('never shows an empty strip', () => {
    expect(shouldShowProgress({ running: true, hasResultDetail: false, progressCount: 0 })).toBe(false)
  })
})
