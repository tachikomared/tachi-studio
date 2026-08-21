// apps/desktop/test/unit/tool-output-compactor.test.ts
//
// Tests for the tokenjuice-inspired upgrades to the deterministic tool-output
// compactor (CONTEXT-ECONOMY P1):
//   1. Footer is appended ONLY when output was actually reduced (lossy) — not on
//      passthrough (today it was always appended, wasting tokens + diluting the
//      "do not re-run" signal on every tiny result).
//   2. Lossy results carry a stable content id (sha256:<12hex>) so the model can
//      recognise a re-run produced the same output.
//   3. matchOutput short-circuit: a whole-output regex collapses known-benign
//      verbose output to one line.

import { describe, it, expect } from 'vitest'
import { compactToolOutput, headTail } from '../../electron/services/tool-output-compactor'

describe('tool-output-compactor — footer gating', () => {
  it('does NOT append the authoritative footer when nothing was truncated', () => {
    const r = compactToolOutput({ toolName: 'Bash', stdout: 'hello\nworld', stderr: '', exitCode: 0 })
    expect(r.stats.ratio).toBeLessThanOrEqual(1)
    expect(r.inlineText).not.toContain('[tachi-compactor]')
    expect(r.footer).toBe('')
    expect(r.inlineText).toContain('hello')
  })

  it('appends the footer when output was truncated', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    const r = compactToolOutput({ toolName: 'Bash', stdout: big, stderr: '', exitCode: 0 })
    expect(r.inlineText).toContain('[tachi-compactor]')
    expect(r.footer).not.toBe('')
    expect(r.stats.reducedChars).toBeLessThan(r.stats.rawChars)
  })
})

describe('tool-output-compactor — hashed content id', () => {
  it('embeds a sha256:<12hex> id in truncated output, deterministic across runs', () => {
    const big = Array.from({ length: 500 }, (_, i) => `row ${i}`).join('\n')
    const a = compactToolOutput({ toolName: 'Bash', stdout: big, stderr: '', exitCode: 0 })
    const b = compactToolOutput({ toolName: 'Bash', stdout: big, stderr: '', exitCode: 0 })
    const m = a.inlineText.match(/sha256:([0-9a-f]{12})/)
    expect(m).not.toBeNull()
    expect(b.inlineText).toContain(m![0]) // same input → same id
  })

  it('does not add a content id when output is not truncated', () => {
    const r = compactToolOutput({ toolName: 'Bash', stdout: 'tiny', stderr: '', exitCode: 0 })
    expect(r.inlineText).not.toMatch(/sha256:/)
  })
})

describe('tool-output-compactor — matchOutput short-circuit', () => {
  it('collapses a known-benign whole-output match to one line', () => {
    // npm-install rule carries a matchOutput for "up to date".
    const r = compactToolOutput({
      toolName: 'Bash',
      stdout: 'npm WARN config\n\nup to date in 412ms\n\n123 packages are looking for funding',
      stderr: '',
      exitCode: 0,
    })
    expect(r.classification).toContain('npm')
    expect(r.inlineText.split('\n').filter(l => l.trim() && !l.includes('[tachi-compactor]')).length).toBeLessThanOrEqual(2)
    expect(r.inlineText.toLowerCase()).toContain('up to date')
  })
})

describe('tool-output-compactor — headTail unchanged', () => {
  it('keeps head + tail with an omission marker', () => {
    expect(headTail('a\nb\nc\nd\ne', 2, 2)).toBe('a\nb\n[... omitted 1 lines ...]\nd\ne')
  })
  it('returns short text unchanged', () => {
    expect(headTail('a\nb\nc', 2, 2)).toBe('a\nb\nc')
  })
})
