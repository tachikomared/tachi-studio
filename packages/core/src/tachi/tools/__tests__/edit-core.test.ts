// packages/core/src/tachi/tools/__tests__/edit-core.test.ts
//
// Tests for the edit cascade (applyEdit). Real inputs, no mocks. Covers the
// happy path for each strategy plus the tricky edges enumerated in the module
// spec: exact-vs-fuzzy preference, duplicate -> multiple-matches, whitespace /
// indentation fuzzy hits, not-found, the disproportionate guard, CRLF
// preservation, and create-via-empty-oldString.
import { describe, it, expect } from 'vitest'
import { applyEdit } from '../edit-core.js'
import type { EditResult } from '../../contract.js'

// Narrow an EditResult to its success branch (throws if it failed) so the
// assertions below read cleanly.
function ok(r: EditResult): Extract<EditResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}: ${r.detail}`)
  return r
}

describe('applyEdit — exact strategy', () => {
  it('replaces a unique exact substring and preserves the rest byte-for-byte', () => {
    const content = 'const a = 1\nconst b = 2\nconst c = 3\n'
    const r = ok(applyEdit(content, 'const b = 2', 'const b = 20'))
    expect(r.strategy).toBe('exact')
    expect(r.content).toBe('const a = 1\nconst b = 20\nconst c = 3\n')
  })

  it('replaces a whole multi-line region exactly', () => {
    const content = 'a\nfoo\nbar\nb\n'
    const r = ok(applyEdit(content, 'foo\nbar', 'baz\nqux'))
    expect(r.strategy).toBe('exact')
    expect(r.content).toBe('a\nbaz\nqux\nb\n')
  })

  it('returns multiple-matches when the exact oldString appears more than once', () => {
    const content = 'x = 1\nx = 1\n'
    const r = applyEdit(content, 'x = 1', 'x = 2')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('multiple-matches')
  })

  it('handles replacement at the very start of the file', () => {
    const r = ok(applyEdit('hello world', 'hello', 'goodbye'))
    expect(r.content).toBe('goodbye world')
    expect(r.strategy).toBe('exact')
  })

  it('handles replacement at the very end of the file', () => {
    const r = ok(applyEdit('hello world', 'world', 'there'))
    expect(r.content).toBe('hello there')
  })

  it('supports deletion (newString empty) of a unique region', () => {
    const r = ok(applyEdit('keep\nremove\nkeep\n', 'remove\n', ''))
    expect(r.content).toBe('keep\nkeep\n')
  })
})

describe('applyEdit — exact is preferred over fuzzy', () => {
  it('uses exact even when a line-trimmed match would also exist', () => {
    // The exact string "  return x" appears once verbatim. A trimmed match
    // would also hit it, but exact must win and be reported as the strategy.
    const content = 'function f() {\n  return x\n}\n'
    const r = ok(applyEdit(content, '  return x', '  return y'))
    expect(r.strategy).toBe('exact')
    expect(r.content).toBe('function f() {\n  return y\n}\n')
  })
})

describe('applyEdit — line-trimmed strategy', () => {
  it('matches when only leading/trailing whitespace differs per line', () => {
    // File line is TAB-indented; oldString is SPACE-indented. Neither is a
    // verbatim substring of the other (different leading chars), so exact must
    // fail and line-trimmed (which compares per-line after .trim()) must fire.
    const content = 'function f() {\n\tconst x = 1\n}\n'
    const r = ok(applyEdit(content, '    const x = 1', '    const x = 2'))
    expect(r.strategy).toBe('line-trimmed')
    // The matched span is the WHOLE file line (its tab indentation included),
    // replaced wholesale by newString.
    expect(r.content).toBe('function f() {\n    const x = 2\n}\n')
  })

  it('matches a multi-line block where each line has different indentation', () => {
    const content = 'start\n      alpha\n      beta\nend\n'
    const r = ok(applyEdit(content, 'alpha\nbeta', 'ALPHA\nBETA'))
    expect(r.strategy).toBe('line-trimmed')
    expect(r.content).toBe('start\nALPHA\nBETA\nend\n')
  })

  it('reports multiple-matches when the trimmed block occurs twice', () => {
    const content = 'a\n   foo\nb\n   foo\nc\n'
    const r = applyEdit(content, 'foo', 'bar')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('multiple-matches')
  })
})

describe('applyEdit — indentation-flexible strategy', () => {
  it('matches a block whose relative indentation is preserved but base shifted', () => {
    // oldString has its own 2-space relative indent; file has 6 extra spaces of
    // base indent. line-trimmed would NOT match (relative indent differs after
    // trim? it trims fully so it could) — use a body where inner lines keep
    // relative structure that survives only de-indentation.
    const content = 'outer:\n        if cond:\n            do_thing()\n'
    const old = 'if cond:\n    do_thing()'
    const r = ok(applyEdit(content, old, 'if other:\n    do_other()'))
    // Either indentation-flexible or line-trimmed may catch this; both are
    // acceptable fuzzy hits, but it must NOT be exact and must replace the block.
    expect(r.ok).toBe(true)
    expect(['line-trimmed', 'indentation-flexible']).toContain(r.strategy)
    expect(r.content).toContain('do_other()')
    expect(r.content.startsWith('outer:\n')).toBe(true)
  })
})

describe('applyEdit — block-anchor strategy', () => {
  it('matches a 3+ line block by first/last anchors with a drifted middle line', () => {
    // First + last lines match exactly; the middle line drifted but stays
    // similar enough (Levenshtein ratio >= 0.65). line-trimmed cannot match
    // because the middle differs, so block-anchor should fire.
    const content = 'function foo() {\n  const value = computeValue()\n  return value\n}\n'
    // middle differs slightly ("compute()" vs "computeValue()") but anchors match
    const old = 'function foo() {\n  const value = compute()\n  return value\n}'
    const r = applyEdit(content, old, 'REPLACED')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.strategy).toBe('block-anchor')
      expect(r.content).toBe('REPLACED\n')
    }
  })

  it('does NOT match via block-anchor when middle line is wildly dissimilar', () => {
    const content = 'open {\n  aaaaaaaaaaaaaaaaaaaa\n}\n'
    const old = 'open {\n  zzzzz qqqqq wwwww\n}'
    const r = applyEdit(content, old, 'X')
    // anchors match but similarity < 0.65 -> nothing else matches -> not-found
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })
})

describe('applyEdit — whitespace-normalized strategy', () => {
  it('matches a single line that differs only by internal whitespace runs', () => {
    const content = 'const    x   =    1\n'
    const r = applyEdit(content, 'const x = 1', 'const x = 2')
    expect(r.ok).toBe(true)
    if (r.ok) {
      // line-trimmed only trims edges, not internal runs, so this should be
      // whitespace-normalized.
      expect(r.strategy).toBe('whitespace-normalized')
      expect(r.content).toBe('const x = 2\n')
    }
  })
})

describe('applyEdit — escape-normalized strategy', () => {
  it('matches when oldString uses literal backslash-n but file has a real newline', () => {
    const content = 'line1\nline2\n'
    // oldString written with an escaped newline sequence (two chars: \\ n)
    const old = 'line1\\nline2'
    const r = applyEdit(content, old, 'X\nY')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.strategy).toBe('escape-normalized')
      expect(r.content).toBe('X\nY\n')
    }
  })
})

describe('applyEdit — trimmed-boundary strategy', () => {
  it('matches when oldString has stray leading/trailing blank lines', () => {
    const content = 'header\nthe-body-line\nfooter\n'
    // oldString is the body wrapped in extra blank lines that do not exist in
    // the file; exact fails, but trimming the whole block matches.
    const old = '\n\nthe-body-line\n\n'
    const r = applyEdit(content, old, 'NEW')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content).toContain('NEW')
      expect(r.content).toContain('header')
      expect(r.content).toContain('footer')
    }
  })
})

describe('applyEdit — not-found', () => {
  it('returns not-found when nothing matches under any strategy', () => {
    const r = applyEdit('alpha\nbeta\n', 'this is absent', 'X')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })
})

describe('applyEdit — disproportionate guard', () => {
  it('rejects a fuzzy match whose span dwarfs oldString (char length >= 4x)', () => {
    // whitespace-normalized would collapse a 3000-space run so a tiny "a b"
    // oldString "matches" a 3000+ char file line. The matched span is hundreds
    // of times the oldString char length -> the guard must reject it rather
    // than blow away the whole line.
    const content = 'a' + ' '.repeat(3000) + 'b\n'
    const old = 'a b'
    const r = applyEdit(content, old, 'Z')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('disproportionate')
  })

  it('rejects a fuzzy match whose span has >= 2x the line count of oldString', () => {
    // escape-normalized unescapes a SINGLE-line oldString full of literal "\n"
    // into a tall multi-line block. oldString is 1 line; the matched span is 10
    // lines (>> 2x + the line floor) -> the guard must reject it.
    const body = Array.from({ length: 10 }, (_, i) => `m${i}`).join('\n')
    const content = `${body}\n`
    // 1 physical line containing literal backslash-n separators.
    const old = Array.from({ length: 10 }, (_, i) => `m${i}`).join('\\n')
    expect(old.split('\n').length).toBe(1) // sanity: oldString really is 1 line
    const r = applyEdit(content, old, 'Z')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('disproportionate')
  })

  it('does NOT reject an exact match even if it is large', () => {
    // Exact matches are never disproportionate (the span IS oldString).
    const body = Array.from({ length: 50 }, (_, i) => `row ${i}`).join('\n')
    const content = `top\n${body}\nbottom\n`
    const r = applyEdit(content, body, 'collapsed')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.strategy).toBe('exact')
      expect(r.content).toBe('top\ncollapsed\nbottom\n')
    }
  })
})

describe('applyEdit — ambiguity is not silently rescued by fuzzy strategies', () => {
  it('reports multiple-matches when exact is duplicated and fuzzy would also be ambiguous', () => {
    // Both exact and every fuzzy strategy see the same two occurrences; none can
    // pin a unique span, so the cascade must surface multiple-matches (not pick
    // one arbitrarily, and not fall through to not-found).
    const content = 'log(x)\nlog(x)\n'
    const r = applyEdit(content, 'log(x)', 'log(y)')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('multiple-matches')
  })
})

describe('applyEdit — empty oldString', () => {
  it('creates content when oldString is empty and content is empty', () => {
    const r = applyEdit('', '', 'brand new file\nsecond line\n')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.content).toBe('brand new file\nsecond line\n')
      expect(r.strategy).toBe('exact')
    }
  })

  it('rejects empty oldString when content is non-empty', () => {
    const r = applyEdit('existing content', '', 'whatever')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty-old-string')
  })
})

describe('applyEdit — line-ending preservation', () => {
  it('preserves CRLF when the file is CRLF-dominant', () => {
    const content = 'const a = 1\r\nconst b = 2\r\nconst c = 3\r\n'
    const r = ok(applyEdit(content, 'const b = 2', 'const b = 20'))
    expect(r.content).toBe('const a = 1\r\nconst b = 20\r\nconst c = 3\r\n')
    // No stray bare-LF introduced.
    expect(r.content.includes('\n') && !r.content.includes('\r\n\r')).toBe(true)
    expect(/[^\r]\n/.test(r.content)).toBe(false)
  })

  it('keeps a CRLF newString aligned to CRLF when the file is CRLF', () => {
    const content = 'one\r\ntwo\r\nthree\r\n'
    // newString supplied with LF; result must use CRLF to match the file.
    const r = ok(applyEdit(content, 'two', 'TWO\nEXTRA'))
    expect(r.content).toBe('one\r\nTWO\r\nEXTRA\r\nthree\r\n')
  })

  it('keeps LF when the file is LF-dominant even if oldString carried CRLF', () => {
    const content = 'one\ntwo\nthree\n'
    const r = ok(applyEdit(content, 'two\r\n', 'TWO\n'))
    expect(r.content.includes('\r')).toBe(false)
    expect(r.content).toBe('one\nTWO\nthree\n')
  })

  it('matches an LF oldString against a CRLF file (normalises for comparison)', () => {
    const content = 'alpha\r\nbeta\r\ngamma\r\n'
    const r = ok(applyEdit(content, 'beta', 'BETA'))
    expect(r.content).toBe('alpha\r\nBETA\r\ngamma\r\n')
  })

  it('deletes a whole line in a CRLF file without leaving a stray LF', () => {
    const content = 'keep1\r\ndrop\r\nkeep2\r\n'
    const r = ok(applyEdit(content, 'drop\r\n', ''))
    expect(r.content).toBe('keep1\r\nkeep2\r\n')
    expect(/[^\r]\n/.test(r.content)).toBe(false) // no bare LF anywhere
  })
})

describe('applyEdit — failure results carry a detail string', () => {
  it('always includes a non-empty detail on failure', () => {
    const notFound = applyEdit('abc', 'xyz', 'q')
    expect(notFound.ok).toBe(false)
    if (!notFound.ok) expect(typeof notFound.detail).toBe('string')
    if (!notFound.ok) expect(notFound.detail.length).toBeGreaterThan(0)

    const empty = applyEdit('abc', '', 'q')
    if (!empty.ok) expect(empty.detail.length).toBeGreaterThan(0)
  })
})
