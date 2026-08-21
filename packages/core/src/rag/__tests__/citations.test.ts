import { describe, it, expect } from 'vitest'
import {
  toCitations,
  joinUnderRoot,
  isSafeRelPath,
  citationFileName,
  citationLabel,
  CITATION_SNIPPET_CHARS,
  MAX_CITATIONS,
  type RagRetrievalHit,
} from '../citations.js'

const hit = (over: Partial<RagRetrievalHit> = {}): RagRetrievalHit => ({
  path: 'notes.md',
  startLine: 1,
  endLine: 20,
  score: 0.5,
  text: 'body',
  ...over,
})

describe('joinUnderRoot', () => {
  it('uses backslashes for a Windows root and forward slashes for a POSIX root', () => {
    expect(joinUnderRoot('D:\\projects\\kb', 'docs/spec.md')).toBe('D:\\projects\\kb\\docs\\spec.md')
    expect(joinUnderRoot('/home/me/kb', 'docs/spec.md')).toBe('/home/me/kb/docs/spec.md')
  })

  it('tolerates a trailing separator on the root', () => {
    expect(joinUnderRoot('D:\\kb\\', 'a.md')).toBe('D:\\kb\\a.md')
    expect(joinUnderRoot('/kb/', 'a.md')).toBe('/kb/a.md')
  })

  it('returns empty for escaping, absolute or missing paths', () => {
    expect(joinUnderRoot('/kb', '../secrets.env')).toBe('')
    expect(joinUnderRoot('/kb', 'a/../../b.md')).toBe('')
    expect(joinUnderRoot('/kb', '/etc/passwd')).toBe('')
    expect(joinUnderRoot('/kb', 'C:\\Windows\\win.ini')).toBe('')
    expect(joinUnderRoot('', 'a.md')).toBe('')
    expect(joinUnderRoot('/kb', '')).toBe('')
  })
})

describe('isSafeRelPath', () => {
  it('accepts ordinary nested relative paths', () => {
    expect(isSafeRelPath('a.md')).toBe(true)
    expect(isSafeRelPath('src/deep/x.ts')).toBe(true)
    // A file whose NAME merely contains dots is fine — only the `..` segment is not.
    expect(isSafeRelPath('src/..hidden/x.ts')).toBe(true)
  })

  it('rejects traversal, absolute and drive-qualified paths', () => {
    expect(isSafeRelPath('..')).toBe(false)
    expect(isSafeRelPath('../x')).toBe(false)
    expect(isSafeRelPath('a\\..\\b')).toBe(false)
    expect(isSafeRelPath('/abs')).toBe(false)
    expect(isSafeRelPath('\\abs')).toBe(false)
    expect(isSafeRelPath('C:/abs')).toBe(false)
    expect(isSafeRelPath('')).toBe(false)
  })
})

describe('citation labels', () => {
  it('reduces a nested path to its file name', () => {
    expect(citationFileName('src/deep/notes.md')).toBe('notes.md')
    expect(citationFileName('notes.md')).toBe('notes.md')
  })

  it('renders a line range, collapsing a single-line chunk', () => {
    expect(citationLabel({ path: 'src/a.ts', startLine: 12, endLine: 48 })).toBe('a.ts:12-48')
    expect(citationLabel({ path: 'src/a.ts', startLine: 7, endLine: 7 })).toBe('a.ts:7')
  })
})

describe('toCitations', () => {
  it('returns [] for missing or empty hits', () => {
    expect(toCitations('/kb', undefined)).toEqual([])
    expect(toCitations('/kb', null)).toEqual([])
    expect(toCitations('/kb', [])).toEqual([])
  })

  it('maps a hit to a citation with an absolute path', () => {
    const [c] = toCitations('/kb', [hit({ path: 'docs/spec.md', startLine: 4, endLine: 30, score: 0.812, text: 'hello' })])
    expect(c).toEqual({
      path: 'docs/spec.md',
      absPath: '/kb/docs/spec.md',
      startLine: 4,
      endLine: 30,
      score: 0.812,
      text: 'hello',
    })
  })

  it('preserves retriever order', () => {
    const out = toCitations('/kb', [
      hit({ path: 'b.md', score: 0.9 }),
      hit({ path: 'a.md', score: 0.8 }),
      hit({ path: 'c.md', score: 0.7 }),
    ])
    expect(out.map(c => c.path)).toEqual(['b.md', 'a.md', 'c.md'])
  })

  it('de-duplicates by path:startLine, keeping the best score', () => {
    const out = toCitations('/kb', [
      hit({ path: 'a.md', startLine: 1, score: 0.4, text: 'weak' }),
      hit({ path: 'a.md', startLine: 1, score: 0.9, text: 'strong' }),
      hit({ path: 'a.md', startLine: 61, score: 0.3, text: 'other window' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ startLine: 1, score: 0.9, text: 'strong' })
    expect(out[1]).toMatchObject({ startLine: 61 })
  })

  it('caps the number of citations', () => {
    const many = Array.from({ length: MAX_CITATIONS + 5 }, (_, i) => hit({ path: `f${i}.md` }))
    expect(toCitations('/kb', many)).toHaveLength(MAX_CITATIONS)
    expect(toCitations('/kb', many, { max: 2 })).toHaveLength(2)
  })

  it('truncates the stored snippet with an ellipsis', () => {
    const long = 'x'.repeat(CITATION_SNIPPET_CHARS + 50)
    const [c] = toCitations('/kb', [hit({ text: long })])
    expect(c!.text).toHaveLength(CITATION_SNIPPET_CHARS + 1)
    expect(c!.text.endsWith('…')).toBe(true)

    const [small] = toCitations('/kb', [hit({ text: 'abcdef' })], { snippetChars: 3 })
    expect(small!.text).toBe('abc…')
  })

  it('drops hits whose path escapes the folder root', () => {
    const out = toCitations('/kb', [
      hit({ path: '../../.ssh/id_rsa' }),
      hit({ path: '/etc/passwd' }),
      hit({ path: 'ok.md' }),
    ])
    expect(out.map(c => c.path)).toEqual(['ok.md'])
  })

  it('clamps and rounds the score and repairs degenerate line numbers', () => {
    const [a] = toCitations('/kb', [hit({ score: 1.7 })])
    expect(a!.score).toBe(1)
    const [b] = toCitations('/kb', [hit({ path: 'b.md', score: -0.2 })])
    expect(b!.score).toBe(0)
    const [c] = toCitations('/kb', [hit({ path: 'c.md', score: 0.123456 })])
    expect(c!.score).toBe(0.123)
    const [d] = toCitations('/kb', [hit({ path: 'd.md', startLine: 0, endLine: -5 })])
    expect(d).toMatchObject({ startLine: 1, endLine: 1 })
  })
})
