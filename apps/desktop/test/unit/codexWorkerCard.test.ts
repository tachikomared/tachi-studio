// Unit tests for the PURE parsing helpers behind the codex_worker transcript
// card (apps/desktop/src/pages/agent/CodexWorkerCard.tsx). They must be
// tolerant: a shape they can't read has to degrade to the generic tool block,
// never throw inside the transcript.
import { describe, it, expect } from 'vitest'
import {
  isCodexWorkerTool,
  parseCodexArgs,
  parseCodexResult,
  segmentCodexOutput,
  extractCodexFiles,
  isLongCodexBody,
} from '../../src/pages/agent/CodexWorkerCard'

describe('isCodexWorkerTool', () => {
  it('matches the delegation tool, including the fan-out child prefix', () => {
    expect(isCodexWorkerTool('codex_worker')).toBe(true)
    expect(isCodexWorkerTool('CODEX_WORKER')).toBe(true)
    expect(isCodexWorkerTool('[2] codex_worker')).toBe(true)
  })

  it('does not swallow neighbouring tools or junk', () => {
    expect(isCodexWorkerTool('codex_review')).toBe(false)
    expect(isCodexWorkerTool('Bash')).toBe(false)
    expect(isCodexWorkerTool('')).toBe(false)
    expect(isCodexWorkerTool(undefined)).toBe(false)
    expect(isCodexWorkerTool(42)).toBe(false)
  })
})

describe('parseCodexArgs', () => {
  it('extracts the task brief and defaults the sandbox to read-only', () => {
    const a = parseCodexArgs('{"task":"Audit the auth flow"}')
    expect(a).toEqual({ task: 'Audit the auth flow', write: false, model: undefined, resumeSession: undefined })
  })

  it('carries write / model / resume_session', () => {
    const a = parseCodexArgs(JSON.stringify({
      task: '  refactor the store  ', write: true, model: 'gpt-5-codex', resume_session: 'sess-abc',
    }))
    expect(a?.task).toBe('refactor the store')
    expect(a?.write).toBe(true)
    expect(a?.model).toBe('gpt-5-codex')
    expect(a?.resumeSession).toBe('sess-abc')
  })

  it('unwraps a double-encoded args object', () => {
    expect(parseCodexArgs(JSON.stringify(JSON.stringify({ task: 'x' })))?.task).toBe('x')
  })

  it('returns null for shapes the card cannot render (→ generic fallback)', () => {
    expect(parseCodexArgs('not json')).toBeNull()
    expect(parseCodexArgs('{"task":"   "}')).toBeNull()
    expect(parseCodexArgs('{"other":1}')).toBeNull()
    expect(parseCodexArgs('[1,2,3]')).toBeNull()
    expect(parseCodexArgs('null')).toBeNull()
    expect(parseCodexArgs(undefined)).toBeNull()
  })

  it('ignores a non-boolean write flag rather than guessing', () => {
    expect(parseCodexArgs('{"task":"t","write":"yes"}')?.write).toBe(false)
  })
})

describe('parseCodexResult', () => {
  it('splits the answer from the harness step + resume footers', () => {
    const out = [
      'Done. Updated the retry policy.',
      '',
      '[codex ran 12 step(s); last: $ rg retry · edit src/net.ts · $ npx vitest run]',
      '[codex session: 0199c-3f2a-44 — pass resume_session to continue this thread]',
    ].join('\n')
    const r = parseCodexResult(out)
    expect(r.ok).toBe(true)
    expect(r.body).toBe('Done. Updated the retry policy.')
    expect(r.stepCount).toBe(12)
    expect(r.steps).toEqual(['$ rg retry', 'edit src/net.ts', '$ npx vitest run'])
    expect(r.sessionId).toBe('0199c-3f2a-44')
  })

  it('detects the FAILED shape and keeps the partial output as the body', () => {
    const r = parseCodexResult(
      'Codex worker FAILED: codex exec exited 1.\nPartial output:\nGot halfway through the refactor.',
    )
    expect(r.ok).toBe(false)
    expect(r.error).toBe('codex exec exited 1.')
    expect(r.body).toBe('Got halfway through the refactor.')
  })

  it('detects the tool-seam throw shape', () => {
    const r = parseCodexResult('codex_worker failed: spawn ENOENT')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('spawn ENOENT')
    expect(r.body).toBe('')
  })

  it('treats a plain answer as a successful result with no meta', () => {
    const r = parseCodexResult('All good.')
    expect(r).toEqual({ ok: true, error: undefined, body: 'All good.', steps: [], stepCount: undefined, sessionId: undefined })
  })

  it('never throws on missing / non-string output', () => {
    expect(parseCodexResult(undefined).body).toBe('')
    expect(parseCodexResult(null).ok).toBe(true)
    expect(parseCodexResult({ nope: 1 }).steps).toEqual([])
  })

  it('handles a step footer with no "last:" list', () => {
    const r = parseCodexResult('answer\n[codex ran 3 step(s)]')
    expect(r.stepCount).toBe(3)
    expect(r.steps).toEqual([])
    expect(r.body).toBe('answer')
  })
})

describe('segmentCodexOutput', () => {
  it('splits console commands from prose', () => {
    const segs = segmentCodexOutput([
      'Looking at the retry path.',
      '$ powershell -c "rg retry src"',
      '$ npx vitest run test/unit/net.test.ts',
      'All 12 tests pass.',
    ].join('\n'))
    expect(segs).toEqual([
      { kind: 'prose', text: 'Looking at the retry path.' },
      { kind: 'command', text: 'powershell -c "rg retry src"' },
      { kind: 'command', text: 'npx vitest run test/unit/net.test.ts' },
      { kind: 'prose', text: 'All 12 tests pass.' },
    ])
  })

  it('strips the "[codex] " stream prefix the run log adds', () => {
    const segs = segmentCodexOutput('[codex] $ git status\n[codex] edit src/a.ts')
    expect(segs[0]).toEqual({ kind: 'command', text: 'git status' })
    expect(segs[1]).toEqual({ kind: 'prose', text: 'edit src/a.ts' })
  })

  it('coalesces consecutive prose lines into one block and drops padding blanks', () => {
    const segs = segmentCodexOutput('\n\nfirst\nsecond\n\n\n$ ls\n\nthird\n\n')
    expect(segs).toEqual([
      { kind: 'prose', text: 'first\nsecond' },
      { kind: 'command', text: 'ls' },
      { kind: 'prose', text: 'third' },
    ])
  })

  it('does not mistake a mid-sentence dollar sign for a command', () => {
    const segs = segmentCodexOutput('the price is $ 5 per unit\ncost: $12')
    expect(segs).toEqual([{ kind: 'prose', text: 'the price is $ 5 per unit\ncost: $12' }])
  })

  it('returns nothing for empty / non-string output', () => {
    expect(segmentCodexOutput('')).toEqual([])
    expect(segmentCodexOutput('   \n  ')).toEqual([])
    expect(segmentCodexOutput(undefined)).toEqual([])
  })
})

describe('extractCodexFiles', () => {
  it('finds posix, windows and bare paths, first-seen order, deduped', () => {
    const files = extractCodexFiles(
      'Edited apps/desktop/src/net.ts and apps\\desktop\\test\\net.test.ts; also touched package.json. apps/desktop/src/net.ts again.',
    )
    expect(files).toEqual([
      'apps/desktop/src/net.ts',
      'apps\\desktop\\test\\net.test.ts',
      'package.json',
    ])
  })

  it('ignores version numbers, sentence noise and library names', () => {
    expect(extractCodexFiles('codex 0.144.5 exited 1, e.g. nothing here')).toEqual([])
    expect(extractCodexFiles('ran under Node.js and Next.js')).toEqual([])
  })

  it('never throws on missing / non-string input', () => {
    expect(extractCodexFiles(undefined)).toEqual([])
    expect(extractCodexFiles(123)).toEqual([])
  })
})

describe('isLongCodexBody', () => {
  it('is short for a one-liner and long for a many-segment answer', () => {
    expect(isLongCodexBody([{ kind: 'prose', text: 'ok' }], 'ok')).toBe(false)
    const many = Array.from({ length: 5 }, () => ({ kind: 'command' as const, text: 'ls' }))
    expect(isLongCodexBody(many, 'ls')).toBe(true)
    expect(isLongCodexBody([{ kind: 'prose', text: 'x' }], 'x'.repeat(401))).toBe(true)
  })
})
