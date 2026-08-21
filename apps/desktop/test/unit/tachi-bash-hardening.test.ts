// apps/desktop/test/unit/tachi-bash-hardening.test.ts
//
// Audit gap "bash not OS-sandboxed" (dimension 6). toolBash already had a
// cwd-jail + timeout + output caps; this proves the THREE added hardening
// layers against a REAL temp workspace + real child_process (no mocks):
//
//   (a) DENY-LIST  — a catastrophic command is refused BEFORE any spawn.
//   (b) ENV SCRUB  — a secret on process.env is NOT inherited by the child.
//   (c) TREE KILL  — a long-sleeping command is killed by the timeout.
//
// These cross the process boundary so they can't be proven by a green build.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { executeTool, type ToolContext } from '../../electron/services/tachi/tools'

// A CI runner spawning a real shell — under a virus scanner on windows-latest —
// routinely needs more than vitest's 5s default, and a test that times out while
// its child is still alive turns the next test's temp-directory cleanup into
// EBUSY. The allowance is per file on purpose: raising it globally was measured
// to break four sd/media suites that share real temp directories.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const isWin = process.platform === 'win32'

let ws: string
let ctx: ToolContext

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'tachi-bash-hard-'))
  ctx = { workspaceRoot: ws }
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('toolBash hardening', () => {
  it('(a) refuses a catastrophic command WITHOUT spawning a child', async () => {
    const r = await executeTool('bash', { command: 'rm -rf /' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.output.toLowerCase()).toContain('refus')
    // The refusal short-circuits before spawn, so none of the spawn-path
    // markers ("Exit code", "timed out") can appear in the output.
    expect(r.output).not.toContain('Exit code')
    expect(r.output.toLowerCase()).not.toContain('timed out')
  })

  it('(a) refuses several catastrophic shapes', async () => {
    for (const cmd of ['mkfs.ext4 /dev/sda1', ':(){ :|:& };:', 'shutdown -h now', 'del /f /s /q C:\\*']) {
      const r = await executeTool('bash', { command: cmd }, ctx)
      expect(r.isError, `should refuse: ${cmd}`).toBe(true)
      expect(r.output.toLowerCase(), `should refuse: ${cmd}`).toContain('refus')
    }
  })

  it('(a) still allows ordinary dev commands (deny-list is conservative)', async () => {
    const r = await executeTool('bash', { command: 'echo dev-ok' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.output).toContain('dev-ok')
  })

  it('(b) does NOT leak a process.env secret to the spawned child', async () => {
    const SECRET = 'TACHI_TEST_SECRET_' + Math.random().toString(36).slice(2)
    process.env[SECRET] = 'super-secret-api-key'
    try {
      // Echo the variable through the platform shell. If env were inherited the
      // value would appear in stdout; with a scrubbed allow-list it must not.
      const cmd = isWin ? `echo $env:${SECRET}` : `echo "$${SECRET}"`
      const r = await executeTool('bash', { command: cmd }, ctx)
      expect(r.isError).toBe(false)
      expect(r.output).not.toContain('super-secret-api-key')
    } finally {
      delete process.env[SECRET]
    }
  })

  it('(b) still passes through PATH so binaries resolve', async () => {
    // node is on PATH; if PATH were scrubbed too this could not resolve.
    const r = await executeTool('bash', { command: 'node -e "process.stdout.write(\'path-ok\')"' }, ctx)
    expect(r.isError).toBe(false)
    expect(r.output).toContain('path-ok')
  })

  it('(c) kills a long-sleeping command at the timeout', async () => {
    const longSleep = isWin
      ? 'Start-Sleep -Seconds 60'
      : 'sleep 60'
    const started = Date.now()
    const r = await executeTool('bash', { command: longSleep, __timeoutMs: 1500 }, ctx)
    const elapsed = Date.now() - started
    expect(r.output.toLowerCase()).toContain('timed out')
    // Must return promptly after the timeout, not wait out the full 60s sleep.
    expect(elapsed).toBeLessThan(20_000)
  }, 30_000)
})
