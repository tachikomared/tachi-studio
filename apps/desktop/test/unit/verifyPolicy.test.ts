// apps/desktop/test/unit/verifyPolicy.test.ts
//
// VERIFY-AS-POLICY (harness item 5) — unit tests for the PURE helpers behind the
// policy: the derivation matrix (typecheck ▸ test ▸ null), mutation tracking,
// the trivially-true-check rejection, and the refusal-cap logic. These are the
// falsifiable core; the loop.ts wiring (complete() derives + runs the check,
// refuses, then finishes UNVERIFIED) is exercised live — see the note at the
// bottom of this file for exactly where.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isMutatingTool,
  deriveDefaultCheck,
  deriveWorkspaceDefaultCheck,
  isBareTrueCommand,
  isTrivialCheck,
  decideDerivedRefusal,
  type PackageManager,
} from '../../electron/services/tachi/verify-policy'

describe('isMutatingTool — mutation tracking', () => {
  it('write / edit / bash are mutating', () => {
    for (const t of ['write', 'edit', 'bash']) expect(isMutatingTool(t)).toBe(true)
  })
  it('read-only + analysis + meta tools are NOT mutating', () => {
    for (const t of [
      'read', 'grep', 'glob',
      'blast_radius', 'trace_path', 'get_architecture', 'find_definition', 'find_references', 'find_callers',
      'expand_compacted', 'bash_output', 'bash_kill',
      'complete', 'todo_write', 'set_success_check', 'skill_view',
      'consult_panel', 'fuse_plan', 'deep_research', 'browse', 'delegate',
    ]) expect(isMutatingTool(t)).toBe(false)
  })
  it('bash_output / bash_kill do not count as bash mutations (exact match only)', () => {
    // Guards against a substring/prefix match creeping in — reading a background
    // task's tail must not mark the run as having changed the workspace.
    expect(isMutatingTool('bash_output')).toBe(false)
    expect(isMutatingTool('bash_kill')).toBe(false)
  })
})

describe('deriveDefaultCheck — the derivation matrix (pure)', () => {
  const pms: PackageManager[] = ['pnpm', 'npm', 'yarn']

  it('typecheck present → `<pm> run typecheck` for every package manager', () => {
    for (const pm of pms) {
      expect(deriveDefaultCheck({ scripts: { typecheck: 'tsc --noEmit' } }, pm)).toEqual({
        command: `${pm} run typecheck`,
        kind: 'typecheck',
      })
    }
  })

  it('typecheck absent, test present → the pm-appropriate test command', () => {
    expect(deriveDefaultCheck({ scripts: { test: 'vitest run' } }, 'pnpm')).toEqual({ command: 'pnpm test --if-present', kind: 'test' })
    expect(deriveDefaultCheck({ scripts: { test: 'vitest run' } }, 'npm')).toEqual({ command: 'npm test --if-present', kind: 'test' })
    // yarn classic treats an unknown flag as a script arg → no --if-present.
    expect(deriveDefaultCheck({ scripts: { test: 'vitest run' } }, 'yarn')).toEqual({ command: 'yarn test', kind: 'test' })
  })

  it('typecheck WINS over test when both are present', () => {
    const d = deriveDefaultCheck({ scripts: { typecheck: 'tsc -p .', test: 'vitest run' } }, 'pnpm')
    expect(d).toEqual({ command: 'pnpm run typecheck', kind: 'typecheck' })
  })

  it('neither script present → null (caller falls back to the critic)', () => {
    expect(deriveDefaultCheck({ scripts: { build: 'vite build', lint: 'eslint .' } }, 'pnpm')).toBeNull()
  })

  it('no scripts / no pkg → null', () => {
    expect(deriveDefaultCheck({}, 'pnpm')).toBeNull()
    expect(deriveDefaultCheck({ scripts: {} }, 'npm')).toBeNull()
    expect(deriveDefaultCheck(null, 'npm')).toBeNull()
    expect(deriveDefaultCheck(undefined, 'yarn')).toBeNull()
  })

  it('empty / whitespace script bodies are ignored (typecheck blank → test wins)', () => {
    expect(deriveDefaultCheck({ scripts: { typecheck: '   ', test: 'vitest run' } }, 'pnpm')).toEqual({ command: 'pnpm test --if-present', kind: 'test' })
    expect(deriveDefaultCheck({ scripts: { typecheck: '', test: '' } }, 'pnpm')).toBeNull()
  })
})

describe('deriveWorkspaceDefaultCheck — fs wrapper + package-manager detection', () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'verify-policy-')) })
  afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('no package.json → null', () => {
    expect(deriveWorkspaceDefaultCheck(ws)).toBeNull()
  })

  it('reads scripts and detects pnpm from the lockfile', () => {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }))
    writeFileSync(join(ws, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    expect(deriveWorkspaceDefaultCheck(ws)).toEqual({ command: 'pnpm run typecheck', kind: 'typecheck' })
  })

  it('detects yarn from yarn.lock, falls to the test script', () => {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }))
    writeFileSync(join(ws, 'yarn.lock'), '# yarn lockfile v1')
    expect(deriveWorkspaceDefaultCheck(ws)).toEqual({ command: 'yarn test', kind: 'test' })
  })

  it('defaults to npm when no recognised lockfile is present', () => {
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }))
    expect(deriveWorkspaceDefaultCheck(ws)).toEqual({ command: 'npm test --if-present', kind: 'test' })
  })

  it('malformed package.json → null (never throws into the loop)', () => {
    writeFileSync(join(ws, 'package.json'), '{ this is not json')
    expect(deriveWorkspaceDefaultCheck(ws)).toBeNull()
  })
})

describe('isBareTrueCommand — trivially-true detection', () => {
  it('flags the no-op class', () => {
    for (const c of ['true', ':', 'exit 0', 'echo done', 'echo', 'printf hi', '', '   ', 'TRUE', '  Echo ok  ']) {
      expect(isBareTrueCommand(c)).toBe(true)
    }
  })
  it('flags a chain where EVERY segment is a no-op', () => {
    expect(isBareTrueCommand('echo hi && true')).toBe(true)
    expect(isBareTrueCommand('echo a; echo b')).toBe(true)
    expect(isBareTrueCommand(': || echo x')).toBe(true)
  })
  it('does NOT flag a command that does real work', () => {
    for (const c of ['pnpm run typecheck', 'tsc --noEmit', 'vitest run x', 'npm test', 'test -f src/a.ts', 'node build.js']) {
      expect(isBareTrueCommand(c)).toBe(false)
    }
  })
  it('does NOT flag a mixed chain (echo + real command)', () => {
    expect(isBareTrueCommand('echo building && vitest run')).toBe(false)
    expect(isBareTrueCommand('true && tsc --noEmit')).toBe(false)
  })
})

describe('isTrivialCheck — reject a check that cannot falsify completion', () => {
  it('rejects a bare no-op with no changed paths', () => {
    expect(isTrivialCheck('echo ok')).toBe(true)
    expect(isTrivialCheck('true')).toBe(true)
    expect(isTrivialCheck('exit 0')).toBe(true)
  })
  it('accepts any command that does real work, even with no changed paths', () => {
    expect(isTrivialCheck('pnpm run typecheck')).toBe(false)
    expect(isTrivialCheck('vitest run test/unit/foo.test.ts')).toBe(false)
  })
  it('accepts a no-op that at least references a changed path (full path or basename)', () => {
    expect(isTrivialCheck('echo see src/foo.ts', ['src/foo.ts'])).toBe(false)
    expect(isTrivialCheck('echo foo.ts changed', ['src/foo.ts'])).toBe(false) // basename match
  })
  it('still rejects a no-op that references NONE of the changed paths', () => {
    expect(isTrivialCheck('echo unrelated', ['src/foo.ts'])).toBe(true)
  })
  it('normalises Windows separators when matching paths', () => {
    expect(isTrivialCheck('echo src/foo.ts', ['src\\foo.ts'])).toBe(false)
  })
})

describe('decideDerivedRefusal — refusal cap logic', () => {
  it('refuses (blocks completion) up to the cap, without marking unverified', () => {
    expect(decideDerivedRefusal(0)).toEqual({ refuse: true, unverified: false })
    expect(decideDerivedRefusal(1)).toEqual({ refuse: true, unverified: false })
  })
  it('at and beyond the cap, stops refusing and marks the run UNVERIFIED', () => {
    expect(decideDerivedRefusal(2)).toEqual({ refuse: false, unverified: true })
    expect(decideDerivedRefusal(3)).toEqual({ refuse: false, unverified: true })
  })
  it('honours a custom cap', () => {
    expect(decideDerivedRefusal(0, 1)).toEqual({ refuse: true, unverified: false })
    expect(decideDerivedRefusal(1, 1)).toEqual({ refuse: false, unverified: true })
  })
  it('models the exact "2 refusals then allow" sequence the loop drives', () => {
    // Emulate the loop: increment on each refusal, stop when it says so.
    let refusals = 0
    const trace: string[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      const d = decideDerivedRefusal(refusals)
      if (d.refuse) { refusals++; trace.push('blocked') }
      else { trace.push(d.unverified ? 'unverified-complete' : 'complete'); break }
    }
    expect(trace).toEqual(['blocked', 'blocked', 'unverified-complete'])
  })
})

// ── LOOP-WIRING NOTE (where the orchestrator should be live-tested) ────────────
//
// The complete() orchestration in apps/desktop/electron/services/tachi/loop.ts
// composes these helpers; drive it with ai/test MockLanguageModelV3 against a
// temp workspace CONTAINING a package.json (the existing tachi-loop-glue.test.ts
// harness uses a bare temp dir, so its mutating runs derive nothing and keep
// exercising the verifyCompletion critic — unchanged). To cover the new path add,
// alongside those, a case that:
//   1. writes package.json { scripts: { typecheck } } + pnpm-lock.yaml into ws,
//   2. scripts the model: write → complete,
//   3. injects verifyCheck returning { ok:false } twice then is never reached —
//      asserting complete() is refused twice (output contains the derived command
//      + "did not pass") and then, on the 3rd complete, accepted with the tool
//      result + a trailing `text` event both carrying "UNVERIFIED".
// A companion case with verifyCheck → { ok:true } asserts a single derived run
// then immediate completion (no critic tax). Kept out of THIS file because these
// pure-helper tests must not depend on the SDK/electron loop.
