// apps/desktop/test/unit/execFailure.test.ts
//
// Silent (exit-0) execution-failure detection. Ported from agenticSeek's
// BashInterpreter.execution_failure_check, but with a CONSERVATIVE pattern set:
// agenticSeek matches weak words like "error"/"failed"/"invalid"/"missing"
// which fire on normal output; here we only match strong, unambiguous crash
// signals so we don't flip a successful run to a failure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectExecFailure } from '../../electron/services/util/exec-failure'
import { executeTool, type ToolContext } from '../../electron/services/tachi/tools'

// A CI runner spawning a real shell — under a virus scanner on windows-latest —
// routinely needs more than vitest's 5s default, and a test that times out while
// its child is still alive turns the next test's temp-directory cleanup into
// EBUSY. The allowance is per file on purpose: raising it globally was measured
// to break four sd/media suites that share real temp directories.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

describe('detectExecFailure — strong signals', () => {
  const cases: Array<[string, string]> = [
    ['Segmentation fault (core dumped)', 'segmentation fault'],
    ['./a.out: core dumped', 'core dumped'],
    ['Traceback (most recent call last):\n  File "x.py"', 'traceback (most recent call last)'],
    ['panic: runtime error: index out of range', 'panic:'],
    ['fatal error: stack overflow\n\ngoroutine 1', 'fatal error:'],
    ['bash: ./script: cannot execute binary file', 'cannot execute binary file'],
  ]
  for (const [output, matched] of cases) {
    it(`matches "${matched}"`, () => {
      const r = detectExecFailure(output)
      expect(r.failed).toBe(true)
      expect(r.matched).toBe(matched)
    })
  }

  it('is case-insensitive', () => {
    expect(detectExecFailure('SEGMENTATION FAULT').failed).toBe(true)
    expect(detectExecFailure('PANIC: nil dereference').failed).toBe(true)
  })
})

describe('detectExecFailure — benign output (no false positives)', () => {
  const benign = [
    '',
    '   \n  ',
    'Build succeeded with 0 errors',
    'No errors found.',
    'The error handling module compiled fine',
    'tests passed: handled error case correctly',
    'Downloading... done',
    'fatal: not a git repository', // git "fatal:" alone is not in our set; see note below
    // Ambiguous-on-exit-0 phrases intentionally NOT flagged (grep/find print these
    // to stderr while succeeding; a real missing command/file exits non-zero):
    'bash: foobar: command not found',
    'cat: nope.txt: No such file or directory',
    'grep: /sys/x: No such file or directory', // partial-success scan, exit 0
  ]
  for (const output of benign) {
    it(`does not match: ${JSON.stringify(output).slice(0, 40)}`, () => {
      expect(detectExecFailure(output).failed).toBe(false)
    })
  }

  it('returns no matched key when it does not fail', () => {
    const r = detectExecFailure('all good')
    expect(r.failed).toBe(false)
    expect(r.matched).toBeUndefined()
  })
})

describe('detectExecFailure — toolBash-shaped exit-0-with-crash', () => {
  // What toolBash hands us when a Go/Rust binary panics but the shell still
  // exits 0 (the panic went to stderr, merged into stdout via 2>&1).
  it('flags a panic captured under an Exit code: 0 banner', () => {
    const combined = 'Exit code: 0\npanic: nil pointer dereference\ngoroutine 1 [running]:'
    const r = detectExecFailure(combined)
    expect(r.failed).toBe(true)
    expect(r.matched).toBe('panic:')
  })

  it('flags a segfault captured under an Exit code: 0 banner', () => {
    const combined = 'Exit code: 0\nSegmentation fault (core dumped)'
    const r = detectExecFailure(combined)
    expect(r.failed).toBe(true)
    // first pattern to hit in scan order
    expect(r.matched).toBe('segmentation fault')
  })

  it('leaves a clean exit-0 run untouched', () => {
    const combined = 'Exit code: 0\nHello, world!\nDone in 12ms'
    expect(detectExecFailure(combined).failed).toBe(false)
  })
})

describe('toolBash wiring — exit-0 belt-and-suspenders', () => {
  // Real child_process against a temp workspace, proving detectExecFailure is
  // actually consulted on the exit-0/not-killed path (the orchestrator wires
  // nothing here — tools.ts owns this branch directly).
  let ws: string
  let ctx: ToolContext
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-execfail-')); ctx = { workspaceRoot: ws } })
  afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('flags a command that prints a panic but exits 0', async () => {
    // A wrapper that emits a crash signal then exits clean — the silent-failure
    // shape we care about. echo exits 0 on every shell we spawn.
    const b = await executeTool('bash', { command: 'echo "panic: nil pointer dereference"' }, ctx)
    expect(b.isError).toBe(true)
    expect(b.output).toContain('[exit 0 but output looks like a failure: panic:]')
    // original output is preserved after the prepended note
    expect(b.output).toContain('Exit code: 0')
  })

  it('leaves a clean exit-0 command as a success', async () => {
    const b = await executeTool('bash', { command: 'echo tachi-ok' }, ctx)
    expect(b.isError).toBe(false)
    expect(b.output).toContain('tachi-ok')
  })
})
