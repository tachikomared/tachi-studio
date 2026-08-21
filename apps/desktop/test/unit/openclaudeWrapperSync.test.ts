// apps/desktop/test/unit/openclaudeWrapperSync.test.ts
//
// Pins the three invariants of the OpenClaude 0.15.0 → 0.27.0 bump (2026-08-01):
//
//   1. The wrapper's PRIVATE-MODE denylists are DERIVED from egress-policy.ts
//      at wrapper-generation time, never hand-copied. The hand-copy drifted
//      once (it was missing `browse` and `deep_research`, and never gained the
//      interpreter-exfil regex) — these tests parse the GENERATED wrapper and
//      compare it against the canonical exports, so they fail the moment the
//      two diverge again for any reason.
//   2. The sidecar spawn env sandboxes BOTH config-dir generations:
//      OPENCLAUDE_CONFIG_DIR (the only var SDK >= 0.23.0 honours — without it
//      the privacy sandbox silently no-ops and the agent reads the user's real
//      ~/.openclaude) AND the legacy CLAUDE_CONFIG_DIR / CLAUDE_HOME (pins
//      < 0.23.0, kept for rollback).
//   3. patchSdkMjs() stays deleted while the pin is >= 0.16.0: upstream fixed
//      the SandboxManager.annotateStderrWithSandboxFailures crash in 0.16.0
//      (#1452), so the old regex patch could only corrupt a healthy sdk.mjs.

import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Hoisted mutable box: the electron mock factory (hoisted above all imports)
// closes over it; beforeAll fills in the real temp dir before any test calls
// app.getPath. openclaude-installer only calls getPath inside functions, never
// at module scope, so import order is safe.
const h = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData },
}))
// egress-policy → privacy.ipc → electron ipcMain; mock the mirror like
// egressPolicy.test.ts does so no real ipc module loads.
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import {
  NETWORK_TOOLS_DENIED_IN_PRIVATE,
  BASH_NETWORK_DENY,
  BASH_INTERPRETER_EXFIL,
} from '../../electron/services/egress-policy'
import { writeOpenClaudeWrapper } from '../../electron/services/openclaude-installer'

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const readSrc = (p: string) => readFileSync(join(DESKTOP, 'electron', p), 'utf8')

beforeAll(() => {
  h.userData = mkdtempSync(join(tmpdir(), 'tachi-oc-wrapper-'))
})

let _wrapper: string | null = null
/** Generate start-server.mjs through the real installer path, once. */
function wrapper(): string {
  if (_wrapper) return _wrapper
  const base = join(h.userData, 'sidecars', 'openclaude')
  mkdirSync(base, { recursive: true })
  writeOpenClaudeWrapper()
  _wrapper = readFileSync(join(base, 'start-server.mjs'), 'utf8')
  return _wrapper
}

/** Match `const <name> = new RegExp("…", "…");` and rebuild the RegExp. */
function extractRegExp(src: string, name: string): { source: string; flags: string; re: RegExp } {
  const m = src.match(new RegExp(
    `const ${name} = new RegExp\\(("(?:[^"\\\\]|\\\\.)*"), ("(?:[^"\\\\]|\\\\.)*")\\);`,
  ))
  expect(m, `wrapper is missing the generated ${name}`).not.toBeNull()
  const source = JSON.parse(m![1]!) as string
  const flags = JSON.parse(m![2]!) as string
  return { source, flags, re: new RegExp(source, flags) }
}

describe('wrapper denylists are derived from egress-policy (invariant 1)', () => {
  it('generated tool denylist EQUALS the canonical set, byte for byte', () => {
    const m = wrapper().match(/const NETWORK_TOOLS_DENIED_IN_PRIVATE = new Set\((\[[^\]]*\])\);/)
    expect(m, 'wrapper is missing the generated denylist Set').not.toBeNull()
    expect(JSON.parse(m![1]!)).toEqual([...NETWORK_TOOLS_DENIED_IN_PRIVATE])
  })

  it('the canonical set still contains the names the old hand-copy lost', () => {
    // Guards the other direction: "fixing" a divergence by shrinking the
    // canonical list would pass a pure equality check.
    for (const name of ['WebFetch', 'WebSearch', 'browse', 'deep_research']) {
      expect(NETWORK_TOOLS_DENIED_IN_PRIVATE.has(name), name).toBe(true)
    }
  })

  it('generated bash regexes EQUAL the canonical sources and flags', () => {
    const deny = extractRegExp(wrapper(), 'BASH_NETWORK_DENY')
    const exfil = extractRegExp(wrapper(), 'BASH_INTERPRETER_EXFIL')
    expect(deny.source).toBe(BASH_NETWORK_DENY.source)
    expect(deny.flags).toBe(BASH_NETWORK_DENY.flags)
    expect(exfil.source).toBe(BASH_INTERPRETER_EXFIL.source)
    expect(exfil.flags).toBe(BASH_INTERPRETER_EXFIL.flags)
  })

  it('the regexes as reconstructed FROM THE WRAPPER enforce canonical semantics', () => {
    const deny = extractRegExp(wrapper(), 'BASH_NETWORK_DENY').re
    const exfil = extractRegExp(wrapper(), 'BASH_INTERPRETER_EXFIL').re

    expect(deny.test('curl http://x')).toBe(true)
    expect(deny.test('iwr http://x -OutFile y')).toBe(true)
    expect(deny.test('ls /tmp/curl-results/')).toBe(false)
    // The interpreter-exfil regex never existed in the old hand-copy — this
    // line is the regression alarm for that exact hole.
    expect(exfil.test('python -c "import urllib.request; urllib.request.urlopen(\'http://x\')"')).toBe(true)
    expect(exfil.test('node build.js')).toBe(false)
  })

  it('the private-mode preamble names every denied tool', () => {
    for (const name of NETWORK_TOOLS_DENIED_IN_PRIVATE) {
      expect(wrapper().includes(name), `preamble/denylist missing ${name}`).toBe(true)
    }
  })

  it('installer source interpolates the canonical exports (no hand list)', () => {
    const src = readSrc('services/openclaude-installer.ts')
    expect(src).toContain('JSON.stringify([...NETWORK_TOOLS_DENIED_IN_PRIVATE])')
    expect(src).toContain('JSON.stringify(BASH_NETWORK_DENY.source)')
    expect(src).toContain('JSON.stringify(BASH_INTERPRETER_EXFIL.source)')
    // A resurrected hand-written list would look like this:
    expect(src).not.toMatch(/new Set\(\s*\[\s*'WebFetch'/)
  })
})

describe('sidecar spawn env sandboxes both config-dir generations (invariant 2)', () => {
  // Source-level pin (same style as startupDeferredImports suite 2): the env
  // block is deep inside startOpenClaude() and not observable without spawning,
  // so we pin the source. All three vars must point at the SAME sandbox dir.
  const src = readSrc('services/sidecar-manager.ts')

  it.each([
    ['OPENCLAUDE_CONFIG_DIR', 'SDK >= 0.23.0 — the only var new SDKs honour'],
    ['CLAUDE_CONFIG_DIR', 'SDK < 0.23.0 (rollback safety)'],
    ['CLAUDE_HOME', 'belt-and-braces legacy guard'],
  ])('%s points at tachiSandboxDir (%s)', (envVar) => {
    expect(src).toMatch(new RegExp(`${envVar}:\\s*tachiSandboxDir`))
  })
})

describe('patchSdkMjs cannot run against a pin >= 0.16.0 (invariant 3)', () => {
  const src = readSrc('services/openclaude-installer.ts')

  it('the pin is at or above 0.16.0 (upstream fix for the SandboxManager crash)', () => {
    const m = src.match(/const OPENCLAUDE_SDK_VERSION = '(\d+)\.(\d+)\.(\d+)'/)
    expect(m).not.toBeNull()
    const [major, minor] = [Number(m![1]), Number(m![2])]
    expect(major > 0 || minor >= 16).toBe(true)
  })

  it('the sdk.mjs monkey-patch is gone from the installer', () => {
    expect(src).not.toMatch(/function patchSdkMjs/)
    // The regex bodies, not the prose comment that documents the removal:
    expect(src).not.toMatch(/replaceAll\(\s*'SandboxManager2/)
    expect(src).not.toMatch(/annotateStderrWithSandboxFailures\\\(/)
  })
})

// ── invariant 4: the permission posture the wrapper declares ──────────────────
//
// Added 2026-08-02 after the driver's first query on the repaired 0.27.0 install
// died with:
//
//   SDK permissionMode "bypassPermissions" requires allowDangerouslySkipPermissions: true
//
// 0.27.0's buildPermissionContext throws for BOTH dangerous modes unless the
// embedder opts in by name. The right answer is not to opt in — with a
// canUseTool supplied, 'default' routes every tool decision through OUR callback
// (createExternalCanUseTool consults the user fn first and its verdict is
// final), so the wrapper keeps the same reach with none of the mode's
// short-circuits. This suite exists so nobody "fixes" a future permission error
// by pasting the flag the error message names.
describe('wrapper asks for the least permission that works (invariant 4)', () => {
  it('declares permissionMode default — never a dangerous mode', () => {
    const w = wrapper()
    expect(w).toMatch(/permissionMode:\s*'default'/)
    expect(w).not.toMatch(/permissionMode:\s*'bypassPermissions'/)
    expect(w).not.toMatch(/permissionMode:\s*'fullAccess'/)
  })

  it('never sets allowDangerouslySkipPermissions', () => {
    // Prose is allowed to NAME the flag (the comment explains why we refuse it);
    // an assignment is not.
    expect(wrapper()).not.toMatch(/^\s*allowDangerouslySkipPermissions\s*:/m)
  })

  it('still supplies canUseTool — without it the SDK denies every tool', () => {
    // Secure-by-default upstream: no canUseTool and no onPermissionRequest means
    // ALL tool uses are denied. In 'default' mode this callback is also the ONLY
    // permission authority, so losing it is worse than a mode change.
    expect(wrapper()).toMatch(/canUseTool:\s*async/)
  })
})
