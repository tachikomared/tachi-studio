// packages/core/src/tachi/tools/__tests__/signal-compact.test.ts
import { describe, it, expect } from 'vitest'
import { signalCompact, scoreLine } from '../signal-compact.js'

describe('scoreLine', () => {
  it('scores panics/errors/asserts highest', () => {
    expect(scoreLine('panic: runtime error')).toBe(1.0)
    expect(scoreLine('  Error: boom')).toBeGreaterThanOrEqual(0.9)
    expect(scoreLine('src/x.ts(3,1): error TS2322')).toBeGreaterThanOrEqual(0.9)
  })
  it('scores file:line refs and warnings in the middle', () => {
    expect(scoreLine('src/foo.ts:42: something')).toBeGreaterThanOrEqual(0.55)
    expect(scoreLine('warning: deprecated API')).toBe(0.6)
  })
  it('scores blank + progress noise lowest', () => {
    expect(scoreLine('')).toBe(0.05)
    expect(scoreLine('................')).toBe(0.15)
    expect(scoreLine('Downloading [=====>      ] 45%')).toBe(0.15)
    expect(scoreLine('ordinary prose line')).toBe(0.4)
  })
})

describe('signalCompact', () => {
  it('returns verbatim when within line + char budgets', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const r = signalCompact(text)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe(text)
  })

  it('KEEPS a high-signal error line buried in the middle that flat head/tail would drop', () => {
    // 400 noise lines with one error at index 200; head/tail = 24/24, so a flat
    // compactor (keeping only first/last 24) would lose the error entirely.
    const lines = Array.from({ length: 400 }, (_, i) => i === 200 ? 'src/buried.ts(7,3): error TS2345 the one that matters' : `noise progress ${i} ...`)
    const r = signalCompact(lines.join('\n'))
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('error TS2345 the one that matters')
    expect(r.text).toContain('src/buried.ts(7,3)')
    // the elision markers + receipt are present
    expect(r.text).toContain('low-signal lines elided')
    expect(r.text).toMatch(/sha256:[0-9a-f]{12}/)
    // far smaller than the original
    expect(r.keptChars).toBeLessThan(r.originalChars)
  })

  it('always keeps the head and tail', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `step ${i}`)
    lines[0] = 'FIRST_LINE_MARKER'
    lines[299] = 'LAST_LINE_MARKER'
    const r = signalCompact(lines.join('\n'))
    expect(r.text).toContain('FIRST_LINE_MARKER')
    expect(r.text).toContain('LAST_LINE_MARKER')
  })

  it('honors the char budget by dropping lowest-signal middle lines, keeping the highest-signal ones', () => {
    // Many medium lines + a few critical ones; tiny char budget forces dropping.
    const lines: string[] = []
    for (let i = 0; i < 500; i++) lines.push(`routine log entry number ${i} doing ordinary things`)
    lines[250] = 'panic: the critical failure'
    const r = signalCompact(lines.join('\n'), { maxChars: 2000, maxSignalLines: 80 })
    expect(r.keptChars).toBeLessThanOrEqual(3000) // budget honored (+ marker overhead)
    expect(r.text).toContain('panic: the critical failure') // the top-signal line survives the squeeze
  })

  it('caps an absurdly long single line', () => {
    const lines = Array.from({ length: 250 }, (_, i) => i === 5 ? 'x'.repeat(5000) : `line ${i}`)
    const r = signalCompact(lines.join('\n'), { maxLineChars: 200 })
    expect(r.text).toContain('…')
    // no single rendered line exceeds the clip (+ ellipsis)
    expect(Math.max(...r.text.split('\n').map(l => l.length))).toBeLessThanOrEqual(220)
  })
})
