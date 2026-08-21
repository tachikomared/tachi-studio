// apps/desktop/test/unit/codexReviewCard.test.ts
//
// The PURE half of the codex_review transcript card
// (src/pages/agent/CodexReviewCard.tsx).
//
// The emitter (electron/services/tachi/loop.ts) takes
//   { summary: string, files?: string[], focus?: string }
// and asks the read-only worker for "file:line, severity
// (CRITICAL/MAJOR/MINOR), and a one-line failure scenario" — so the card's job
// is to read that structure back out of freeform markdown. The parser must be
// tolerant (models format the same brief five ways) AND conservative (lowercase
// prose like "a minor detail" must never manufacture a CRITICAL-looking row).
import { describe, it, expect } from 'vitest'
import {
  MAX_FINDINGS,
  isCodexReviewTool,
  parseCodexReviewArgs,
  parseReviewFindings,
  reviewVerdict,
  severityCounts,
  topSeverity,
} from '../../src/pages/agent/CodexReviewCard'

describe('isCodexReviewTool', () => {
  it('matches only the review tool, fan-out prefix included', () => {
    expect(isCodexReviewTool('codex_review')).toBe(true)
    expect(isCodexReviewTool('[3] codex_review')).toBe(true)
    expect(isCodexReviewTool('codex_worker')).toBe(false)
    expect(isCodexReviewTool('Bash')).toBe(false)
    expect(isCodexReviewTool(undefined)).toBe(false)
  })
})

describe('parseCodexReviewArgs', () => {
  it('reads the emitter shape: summary + optional files + optional focus', () => {
    const a = parseCodexReviewArgs(JSON.stringify({
      summary: '  I rewrote the retry loop  ',
      files: ['src/a.ts', ' src/b.ts ', '', 7],
      focus: ' concurrency ',
    }))
    expect(a).toEqual({ summary: 'I rewrote the retry loop', files: ['src/a.ts', 'src/b.ts'], focus: 'concurrency' })
  })

  it('defaults files to an empty list and focus to undefined', () => {
    expect(parseCodexReviewArgs('{"summary":"x"}')).toEqual({ summary: 'x', files: [], focus: undefined })
  })

  it('unwraps a double-encoded args object', () => {
    expect(parseCodexReviewArgs(JSON.stringify(JSON.stringify({ summary: 'y' })))?.summary).toBe('y')
  })

  it('returns null for shapes the card cannot render (→ generic fallback)', () => {
    expect(parseCodexReviewArgs('not json')).toBeNull()
    expect(parseCodexReviewArgs('{"summary":"  "}')).toBeNull()
    expect(parseCodexReviewArgs('{"task":"this is the worker tool"}')).toBeNull()
    expect(parseCodexReviewArgs('[1,2]')).toBeNull()
    expect(parseCodexReviewArgs(undefined)).toBeNull()
  })
})

describe('parseReviewFindings', () => {
  it('mines the bulleted severity + file:line + scenario shape', () => {
    const body = [
      'I inspected the diff.',
      '',
      '- **CRITICAL** `src/retry.ts:42` — the counter is never reset, so the third failure loops forever.',
      '- MAJOR src/retry.ts:88: the abort signal is ignored while sleeping.',
      '- MINOR: naming is inconsistent.',
    ].join('\n')
    const f = parseReviewFindings(body)
    expect(f).toHaveLength(3)
    expect(f[0].severity).toBe('critical')
    expect(f[0].location).toBe('src/retry.ts:42')
    expect(f[0].text).toContain('counter is never reset')
    expect(f[0].text).not.toContain('CRITICAL')
    expect(f[1].severity).toBe('major')
    expect(f[1].location).toBe('src/retry.ts:88')
    expect(f[2].severity).toBe('minor')
    expect(f[2].location).toBeUndefined()
  })

  it('reads a numbered list with the severity written inline', () => {
    const f = parseReviewFindings('1. apps/desktop/src/x.tsx:10 — CRITICAL — null deref on first render')
    expect(f).toHaveLength(1)
    expect(f[0].severity).toBe('critical')
    expect(f[0].location).toBe('apps/desktop/src/x.tsx:10')
    expect(f[0].text).toBe('null deref on first render')
  })

  it('lifts a parenthesised location into the chip without leaving orphan brackets', () => {
    const f = parseReviewFindings('2. **MAJOR** (src/pages/agent/CodexReviewCard.tsx:88) — the parser drops tab-indented lines.')
    expect(f[0].location).toBe('src/pages/agent/CodexReviewCard.tsx:88')
    expect(f[0].text).toBe('the parser drops tab-indented lines.')
  })

  it('ignores the reviewer\'s own section headings and checklist', () => {
    const f = parseReviewFindings([
      '## Findings',
      '- CRITICAL src/a.ts:1 — boom',
      '',
      '## What I checked',
      '- ran npm test',
      '- read the router',
    ].join('\n'))
    expect(f).toHaveLength(1)
    expect(f[0].text).toBe('boom')
  })

  it('treats BLOCKER as critical', () => {
    expect(parseReviewFindings('- BLOCKER: the migration drops the table')[0].severity).toBe('critical')
  })

  it('folds an indented continuation line into the finding above it', () => {
    const f = parseReviewFindings([
      '- MAJOR src/a.ts:3 — the cache key omits the locale',
      '    so two languages share one entry',
      '',
      'Unrelated closing paragraph.',
    ].join('\n'))
    expect(f).toHaveLength(1)
    expect(f[0].text).toContain('omits the locale')
    expect(f[0].text).toContain('two languages share one entry')
    expect(f[0].text).not.toContain('Unrelated')
  })

  it('does NOT invent findings from lowercase prose', () => {
    expect(parseReviewFindings('This is a minor stylistic point and not a defect.')).toEqual([])
    expect(parseReviewFindings('The change is critical to the feature working at all.')).toEqual([])
  })

  it('returns nothing for a clean review or junk input', () => {
    expect(parseReviewFindings('I tried to refute the claim. The work holds.')).toEqual([])
    expect(parseReviewFindings('')).toEqual([])
    expect(parseReviewFindings(undefined)).toEqual([])
    expect(parseReviewFindings(42)).toEqual([])
  })

  it('caps a runaway list rather than rendering thousands of rows', () => {
    const body = Array.from({ length: MAX_FINDINGS + 20 }, (_, i) => `- MINOR: nit ${i}`).join('\n')
    expect(parseReviewFindings(body)).toHaveLength(MAX_FINDINGS)
  })
})

describe('severityCounts / topSeverity', () => {
  const findings = parseReviewFindings([
    '- MINOR: nit',
    '- MAJOR: real',
    '- MINOR: nit two',
  ].join('\n'))

  it('tallies per severity', () => {
    expect(severityCounts(findings)).toEqual({ critical: 0, major: 1, minor: 2 })
  })

  it('reports the worst severity present', () => {
    expect(topSeverity(findings)).toBe('major')
    expect(topSeverity([])).toBeNull()
    expect(topSeverity(parseReviewFindings('- CRITICAL: boom\n- MINOR: nit'))).toBe('critical')
  })
})

describe('reviewVerdict', () => {
  const base = { hasOutput: true, ok: true, findings: [], body: '' }

  it('is running until the tool result arrives', () => {
    expect(reviewVerdict({ ...base, hasOutput: false })).toBe('running')
  })

  it('is failed when the worker envelope reported a failure', () => {
    expect(reviewVerdict({ ...base, ok: false, body: 'boom' })).toBe('failed')
  })

  it('is findings whenever the reviewer raised one — even alongside "holds" prose', () => {
    const findings = parseReviewFindings('- CRITICAL src/a.ts:1 — boom')
    expect(reviewVerdict({ ...base, findings, body: 'otherwise the work holds' })).toBe('findings')
  })

  it('is holds when the reviewer says it could not refute the claim', () => {
    expect(reviewVerdict({ ...base, body: 'I checked the retry path and the diff. The work holds.' })).toBe('holds')
    expect(reviewVerdict({ ...base, body: 'No defects found after inspecting git diff.' })).toBe('holds')
  })

  it('falls back to reviewed when the answer is neither a finding nor a verdict', () => {
    expect(reviewVerdict({ ...base, body: 'I looked at three files.' })).toBe('reviewed')
  })
})
