// apps/desktop/test/unit/sidecarExitMessage.test.ts
//
// "process exited with code 1" is not a diagnosis.
//
// On 2026-08-02 that was the ENTIRE user-facing report of a dead OpenClaude
// sidecar, while the child had already printed the cause to stderr and the
// spawn handler piped it to a log file and dropped it. These tests pin the
// contract of the replacement: the message must carry the child's own words,
// must name the log file, and must not invent a cause it cannot see.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { explainSidecarExit } from '../../electron/services/util/sidecar-exit'

const LOG = 'C:\\Users\\x\\AppData\\Roaming\\tachi-studio-desktop\\openclaude.log'

// Verbatim from the owner's openclaude.log at the moment of the breakage.
const REAL_TAIL = `
node:internal/modules/package_json_reader:268
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
        ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@anthropic-ai/sdk' imported from C:\\Users\\x\\AppData\\Roaming\\tachi-studio-desktop\\sidecars\\openclaude\\node_modules\\@gitlawb\\openclaude\\dist\\sdk.mjs
    at Object.getPackageJSONURL (node:internal/modules/package_json_reader:268:9)
    at packageResolve (node:internal/modules/esm/resolve:768:81)
  code: 'ERR_MODULE_NOT_FOUND'
}

Node.js v22.14.0
`

describe('the message the user actually got on 2026-08-02', () => {
  const msg = explainSidecarExit(1, REAL_TAIL, LOG, 'OpenClaude')

  it('names the package that could not be loaded', () => {
    expect(msg).toContain('@anthropic-ai/sdk')
  })

  it('says the install is incomplete — the actionable classification', () => {
    // A missing module is an install problem, not a configuration problem: the
    // remedy is a reinstall, and isOpenClaudeInstalled() now triggers one.
    expect(msg).toMatch(/install is incomplete/i)
    expect(msg).toMatch(/reinstall/i)
  })

  it('still reports the exit code, and points at the full log', () => {
    expect(msg).toContain('exited with code 1')
    expect(msg).toContain(LOG)
  })

  it('does not dump the raw stack trace at the user', () => {
    expect(msg).not.toContain('node:internal/modules')
    expect(msg).not.toContain('    at ')
  })
})

describe('other failure shapes keep their own remedy', () => {
  it('a port collision blames the port, not the install', () => {
    const tail = "Error: listen EADDRINUSE: address already in use 127.0.0.1:50052"
    const msg = explainSidecarExit(1, tail, LOG, 'OpenClaude')
    expect(msg).toContain('EADDRINUSE')
    expect(msg).toMatch(/port/i)
    // Advising a reinstall here would send the user down a dead end.
    expect(msg).not.toMatch(/reinstall/i)
  })

  it('an unrecognised crash quotes the thrown line verbatim', () => {
    const tail = 'some boot noise\nTypeError: query is not a function\n    at file:///x.mjs:1:1'
    const msg = explainSidecarExit(1, tail, LOG, 'OpenClaude')
    expect(msg).toContain('TypeError: query is not a function')
    expect(msg).toContain(LOG)
  })

  it('with no error line it quotes the last thing the child printed', () => {
    const msg = explainSidecarExit(3, 'starting up\nloading config\n', LOG, 'OpenClaude')
    expect(msg).toContain('loading config')
    expect(msg).toContain('exited with code 3')
  })

  it('a silent death says so rather than pretending to know', () => {
    const msg = explainSidecarExit(1, '   \n\n', LOG, 'OpenClaude')
    expect(msg).toMatch(/without printing a reason/)
    expect(msg).toContain(LOG)
  })

  it('a killed process (null code) is still explained', () => {
    const msg = explainSidecarExit(null, REAL_TAIL, LOG, 'OpenClaude')
    expect(msg).toContain('exited with code null')
    expect(msg).toContain('@anthropic-ai/sdk')
  })

  it('a single pathological line cannot blow up the message', () => {
    const msg = explainSidecarExit(1, `Error: ${'x'.repeat(50_000)}`, LOG, 'OpenClaude')
    expect(msg.length).toBeLessThan(700)
    expect(msg).toContain(LOG)
  })
})

describe('the spawn path is wired to it', () => {
  const APP = fileURLToPath(new URL('../../', import.meta.url))
  const src = readFileSync(join(APP, 'electron', 'services', 'sidecar-manager.ts'), 'utf8')

  it('startOpenClaude captures the child output it later reports', () => {
    // The tail listeners must sit OUTSIDE the best-effort log-file try block:
    // when createWriteStream throws, the diagnosis must still survive.
    expect(src).toMatch(/const captureTail = /)
    expect(src).toMatch(/proc\.stderr\?\.on\('data', d => \{ captureTail\(d\)/)
  })

  it('the openclaude exit handler no longer reports a bare exit code', () => {
    expect(src).toContain("explainSidecarExit(code, outputTail, logPath, 'OpenClaude')")
  })
})
