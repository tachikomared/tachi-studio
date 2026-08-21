import { describe, it, expect } from 'vitest'
import { repairToolName, validateCompletionSummary, editDistance } from '../guards.js'

const TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'glob']

describe('repairToolName', () => {
  it('returns the name unchanged when already valid', () => {
    for (const t of TOOLS) expect(repairToolName(t, TOOLS)).toBe(t)
  })
  it('fixes case/punctuation variants', () => {
    expect(repairToolName('Read', TOOLS)).toBe('read')
    expect(repairToolName('BASH', TOOLS)).toBe('bash')
    expect(repairToolName('gr-ep', TOOLS)).toBe('grep')
  })
  it('maps common aliases other agents emit', () => {
    expect(repairToolName('read_file', TOOLS)).toBe('read')
    expect(repairToolName('writeFile', TOOLS)).toBe('write')
    expect(repairToolName('str_replace', TOOLS)).toBe('edit')
    expect(repairToolName('shell', TOOLS)).toBe('bash')
    expect(repairToolName('ripgrep', TOOLS)).toBe('grep')
    expect(repairToolName('find_files', TOOLS)).toBe('glob')
  })
  it('repairs a close (distance-1) typo via edit distance', () => {
    expect(repairToolName('reads', TOOLS)).toBe('read')  // extra char, d=1
    expect(repairToolName('grepp', TOOLS)).toBe('grep')  // extra char, d=1
  })
  it('returns null for no-confident-match / ambiguous / empty', () => {
    expect(repairToolName('frobnicate', TOOLS)).toBeNull()
    expect(repairToolName('reda', TOOLS)).toBeNull()  // transposition = d2 on a 4-char name → too far, stay conservative
    expect(repairToolName('', TOOLS)).toBeNull()
    expect(repairToolName(null, TOOLS)).toBeNull()
    expect(repairToolName('xyz', TOOLS)).toBeNull()
  })
  it('editDistance basics', () => {
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('abc', 'abc')).toBe(0)
    expect(editDistance('kitten', 'sitting')).toBe(3)
  })
})

describe('validateCompletionSummary', () => {
  it('accepts a substantive what+how summary', () => {
    expect(validateCompletionSummary('Extracted the SSE loop into chat-stream.ts and ran the desktop suite (all green).').ok).toBe(true)
  })
  it('rejects empty / whitespace', () => {
    expect(validateCompletionSummary('').ok).toBe(false)
    expect(validateCompletionSummary('   ').ok).toBe(false)
    expect(validateCompletionSummary(undefined).ok).toBe(false)
  })
  it('rejects placeholder + filler-only summaries', () => {
    expect(validateCompletionSummary('done').ok).toBe(false)
    expect(validateCompletionSummary('ok looks good').ok).toBe(false)
    expect(validateCompletionSummary('all done now').ok).toBe(false)
    expect(validateCompletionSummary('finished').ok).toBe(false)
  })
  it('rejects too-short summaries (few words / few chars)', () => {
    expect(validateCompletionSummary('fixed it').ok).toBe(false)        // 2 words
    expect(validateCompletionSummary('a b c d').ok).toBe(false)         // 4 words but <24 alnum
  })
  it('returns a reason on rejection', () => {
    const v = validateCompletionSummary('done')
    expect(v.ok).toBe(false)
    expect(typeof v.reason).toBe('string')
    expect(v.reason!.length).toBeGreaterThan(0)
  })
})
