// packages/core/src/tachi/tools/__tests__/truncate.test.ts
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { truncateOutput } from '../truncate.js'

const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

describe('truncateOutput — within limits (no truncation)', () => {
  it('returns short text unchanged with truncated:false and no hash', () => {
    const text = 'hello world\nsecond line\nthird line'
    const r = truncateOutput(text)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe(text)
    expect(r.contentHash).toBeUndefined()
    expect(r.originalChars).toBe(text.length)
    expect(r.keptChars).toBe(text.length)
  })

  it('returns empty string unchanged', () => {
    const r = truncateOutput('')
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('')
    expect(r.originalChars).toBe(0)
    expect(r.keptChars).toBe(0)
    expect(r.contentHash).toBeUndefined()
  })

  it('keeps text exactly at the line limit untouched', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    const r = truncateOutput(text)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe(text)
  })
})

describe('truncateOutput — too many lines (head+tail elision)', () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
  const r = truncateOutput(text)

  it('marks truncated and shrinks the output', () => {
    expect(r.truncated).toBe(true)
    expect(r.keptChars).toBeLessThan(r.originalChars)
    expect(r.originalChars).toBe(text.length)
    expect(r.keptChars).toBe(r.text.length)
  })

  it('keeps both head and tail content', () => {
    expect(r.text).toContain('line 0')
    expect(r.text).toContain('line 4999')
    // a deep-middle line must be gone
    expect(r.text).not.toContain('line 2500')
  })

  it('inserts the omission marker with a 12-hex sha256 receipt', () => {
    expect(r.text).toMatch(/\[\.\.\. \d+ lines \/ \d+ chars omitted — sha256:[0-9a-f]{12} — full output retained out of band; do not re-run to retrieve \.\.\.\]/)
  })

  it('the marker hash matches sha256(full).slice(0,12) and equals contentHash', () => {
    const expected = sha12(text)
    expect(r.contentHash).toBe(expected)
    expect(r.contentHash).toMatch(/^[0-9a-f]{12}$/)
    expect(r.text).toContain(`sha256:${expected}`)
  })

  it('respects a custom maxLines', () => {
    const small = truncateOutput(text, { maxLines: 100 })
    expect(small.truncated).toBe(true)
    expect(small.text.split('\n').length).toBeLessThan(text.split('\n').length)
    expect(small.text).toContain('line 0')
    expect(small.text).toContain('line 4999')
  })
})

describe('truncateOutput — too many bytes (few very long lines)', () => {
  // 3 lines, each ~30k chars => ~90k chars, well over the 50k byte cap but only 3 lines.
  // Tag BOTH ends of each line: the head keeps a line's START, the tail keeps a
  // line's END, so slicing into a long line still leaves a distinctive anchor.
  const long = (tag: string) => `<<${tag}-START` + 'x'.repeat(30_000) + `${tag}-END>>`
  const text = [long('A'), long('B'), long('C')].join('\n')
  const r = truncateOutput(text)

  it('still truncates despite being under the line cap', () => {
    expect(r.truncated).toBe(true)
    expect(r.keptChars).toBeLessThan(r.originalChars)
  })

  it('keeps the produced text within the byte cap (plus the marker)', () => {
    // kept content should be on the order of the 50k byte cap, not the full 90k.
    expect(r.keptChars).toBeLessThan(text.length)
    expect(Buffer.byteLength(r.text, 'utf8')).toBeLessThanOrEqual(50_000 + 400)
  })

  it('still carries a valid 12-hex hash and marker', () => {
    expect(r.contentHash).toMatch(/^[0-9a-f]{12}$/)
    expect(r.text).toContain(`sha256:${r.contentHash}`)
  })

  it('keeps the head (first line start) and tail (last line end)', () => {
    expect(r.text).toContain('<<A-START') // head of the first line survives
    expect(r.text).toContain('C-END>>')   // tail of the last line survives
  })
})

describe('truncateOutput — token budget cap', () => {
  it('truncates when token budget (chars/4) is exceeded even under line+byte caps', () => {
    // 100 lines, each 100 chars = ~10_000 chars => ~2500 tokens. Under defaults.
    // Force a tiny token budget so it must elide.
    const text = Array.from({ length: 100 }, (_, i) => `line${i}:` + 'y'.repeat(90)).join('\n')
    const r = truncateOutput(text, { maxTokens: 200 }) // 200 tokens => ~800 chars budget
    expect(r.truncated).toBe(true)
    expect(r.keptChars).toBeLessThan(r.originalChars)
    // ~800 char budget; produced kept content should be modest (allow marker overhead)
    expect(r.keptChars).toBeLessThan(2000)
  })

  it('token cap overrides a larger byte cap when smaller', () => {
    const text = 'z'.repeat(40_000) // 40k chars, 1 line: under 50k bytes but ~10k tokens
    const r = truncateOutput(text, { maxTokens: 1000 }) // 1000 tokens => 4000 char budget
    expect(r.truncated).toBe(true)
    expect(r.keptChars).toBeLessThan(text.length)
  })
})

describe('truncateOutput — determinism', () => {
  it('same input yields the same hash (deterministic)', () => {
    const text = Array.from({ length: 4000 }, (_, i) => `row ${i} data`).join('\n')
    const a = truncateOutput(text)
    const b = truncateOutput(text)
    expect(a.contentHash).toBe(b.contentHash)
    expect(a.text).toBe(b.text)
    expect(a.contentHash).toMatch(/^[0-9a-f]{12}$/)
  })

  it('different input yields a different hash', () => {
    const t1 = Array.from({ length: 4000 }, (_, i) => `row ${i}`).join('\n')
    const t2 = Array.from({ length: 4000 }, (_, i) => `ROW ${i}`).join('\n')
    const a = truncateOutput(t1)
    const b = truncateOutput(t2)
    expect(a.contentHash).not.toBe(b.contentHash)
  })
})
