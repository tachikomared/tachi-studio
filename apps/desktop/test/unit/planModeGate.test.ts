// apps/desktop/test/unit/planModeGate.test.ts
//
// PLAN-mode tool gate (STEAL 2026-06-12; odysseus tool_security pattern).
// Audit finding: the ModeToggle plan/build switch was prompt-prefix-only —
// the agent could still write files and shell out in "plan". This gate is the
// enforcement, called from tachiGate when mode === 'plan'. FAIL-CLOSED:
// anything not provably read-only is denied.

import { describe, it, expect } from 'vitest'
import { checkPlanModeTool } from '../../electron/services/plan-mode-gate'

describe('checkPlanModeTool — read tools', () => {
  it('allows read / grep / glob', () => {
    expect(checkPlanModeTool('read', { path: 'src/a.ts' }).allowed).toBe(true)
    expect(checkPlanModeTool('grep', { pattern: 'x' }).allowed).toBe(true)
    expect(checkPlanModeTool('glob', { pattern: '**/*.ts' }).allowed).toBe(true)
  })

  it('allows the read-only static-analysis tools (planning is exactly when impact analysis helps)', () => {
    expect(checkPlanModeTool('blast_radius', { path: 'src/a.ts' }).allowed).toBe(true)
    expect(checkPlanModeTool('trace_path', { from: 'src/a.ts', to: 'src/b.ts' }).allowed).toBe(true)
    expect(checkPlanModeTool('get_architecture', {}).allowed).toBe(true)
    expect(checkPlanModeTool('find_definition', { name: 'foo' }).allowed).toBe(true)
    expect(checkPlanModeTool('find_references', { name: 'foo' }).allowed).toBe(true)
    expect(checkPlanModeTool('find_callers', { name: 'foo' }).allowed).toBe(true)
    expect(checkPlanModeTool('expand_compacted', { id: 'c1' }).allowed).toBe(true)
  })
})

describe('checkPlanModeTool — mutators', () => {
  it('denies write and edit with a mode-switch hint', () => {
    const w = checkPlanModeTool('write', { path: 'a.ts', content: 'x' })
    expect(w.allowed).toBe(false)
    expect(w.reason).toMatch(/BUILD/i)
    expect(checkPlanModeTool('edit', { path: 'a.ts', oldString: 'a', newString: 'b' }).allowed).toBe(false)
  })
})

describe('checkPlanModeTool — bash', () => {
  it('allows simple read-only inspection commands', () => {
    expect(checkPlanModeTool('bash', { command: 'git status' }).allowed).toBe(true)
    expect(checkPlanModeTool('bash', { command: 'git log --oneline -5' }).allowed).toBe(true)
    expect(checkPlanModeTool('bash', { command: 'git diff HEAD~1' }).allowed).toBe(true)
    expect(checkPlanModeTool('bash', { command: 'ls -la src' }).allowed).toBe(true)
    expect(checkPlanModeTool('bash', { command: 'cat package.json' }).allowed).toBe(true)
    expect(checkPlanModeTool('bash', { command: 'rg "TODO" src' }).allowed).toBe(true)
  })

  it('denies mutating commands', () => {
    expect(checkPlanModeTool('bash', { command: 'git commit -m x' }).allowed).toBe(false)
    expect(checkPlanModeTool('bash', { command: 'npm install left-pad' }).allowed).toBe(false)
    expect(checkPlanModeTool('bash', { command: 'npm test' }).allowed).toBe(false) // scripts can mutate
    expect(checkPlanModeTool('bash', { command: 'rm -rf dist' }).allowed).toBe(false)
  })

  it('denies shell metacharacters even on read-only prefixes (fail-closed)', () => {
    expect(checkPlanModeTool('bash', { command: 'cat a.txt > b.txt' }).allowed).toBe(false)
    expect(checkPlanModeTool('bash', { command: 'ls | sh' }).allowed).toBe(false)
    expect(checkPlanModeTool('bash', { command: 'git status; rm -rf .' }).allowed).toBe(false)
    expect(checkPlanModeTool('bash', { command: 'echo $(rm -rf .)' }).allowed).toBe(false)
    expect(checkPlanModeTool('bash', { command: 'git log `rm x`' }).allowed).toBe(false)
  })

  it('denies empty / missing commands', () => {
    expect(checkPlanModeTool('bash', {}).allowed).toBe(false)
    expect(checkPlanModeTool('bash', { command: '   ' }).allowed).toBe(false)
  })
})

describe('checkPlanModeTool — unknown tools', () => {
  it('denies anything unrecognized (fail-closed)', () => {
    const d = checkPlanModeTool('future_tool', {})
    expect(d.allowed).toBe(false)
    expect(d.reason).toMatch(/plan/i)
  })
})
