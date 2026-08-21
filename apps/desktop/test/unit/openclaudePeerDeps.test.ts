// apps/desktop/test/unit/openclaudePeerDeps.test.ts
//
// Regression suite for the 2026-08-02 live breakage: the CODE tab printed
//
//     Installing OpenClaude (first run, ~1 min)…
//     process exited with code 1
//
// while the sidecar's own stderr — captured in userData/openclaude.log — said
//
//     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@anthropic-ai/sdk'
//     imported from …\node_modules\@gitlawb\openclaude\dist\sdk.mjs
//
// Two independent defects, pinned separately below:
//
//   1. INSTALL. @gitlawb/openclaude 0.27.0 declares @anthropic-ai/sdk and
//      @modelcontextprotocol/sdk as OPTIONAL peerDependencies while dist/sdk.mjs
//      still imports both statically. npm never installs optional peers, so
//      `npm install @gitlawb/openclaude@0.27.0` alone yields a tree that cannot
//      be imported. The installer must ask for them explicitly, and
//      isOpenClaudeInstalled() must NOT call such a tree installed — otherwise
//      the broken install is permanent, because nothing ever triggers a repair.
//
//   2. REPORTING. The child had already printed the diagnosis; the spawn
//      handler threw it away and reported the exit code. explainOpenClaudeExit()
//      is the seam that turns the child's own words into the user's message.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.userData } }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import { isOpenClaudeInstalled, missingOpenClaudePeers } from '../../electron/services/openclaude-installer'

const DESKTOP = fileURLToPath(new URL('../../', import.meta.url))
const INSTALLER_SRC = readFileSync(join(DESKTOP, 'electron', 'services', 'openclaude-installer.ts'), 'utf8')

/** The versions the installer pins, read from its own source (one authority). */
function pinnedPeers(): Record<string, string> {
  const block = INSTALLER_SRC.match(
    /const OPENCLAUDE_REQUIRED_PEERS: Readonly<Record<string, string>> = \{([\s\S]*?)\}/,
  )
  expect(block, 'installer no longer declares OPENCLAUDE_REQUIRED_PEERS').not.toBeNull()
  const out: Record<string, string> = {}
  for (const m of block![1]!.matchAll(/'([^']+)':\s*'([^']+)'/g)) out[m[1]!] = m[2]!
  return out
}

const SDK_VERSION = INSTALLER_SRC.match(/const OPENCLAUDE_SDK_VERSION = '([^']+)'/)![1]!

/** Lay down a fake sidecar tree: wrapper + the given installed packages. */
function fakeInstall(pkgs: Record<string, string | null>): void {
  const base = join(h.userData, 'sidecars', 'openclaude')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'start-server.mjs'), '// wrapper', 'utf8')
  for (const [name, version] of Object.entries(pkgs)) {
    if (version === null) continue
    const dir = join(base, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
  }
}

/** A complete, healthy tree at the current pins. */
function healthyTree(): Record<string, string> {
  return { '@gitlawb/openclaude': SDK_VERSION, ...pinnedPeers() }
}

beforeEach(() => {
  if (h.userData) { try { rmSync(h.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ } }
  h.userData = mkdtempSync(join(tmpdir(), 'tachi-oc-peers-'))
})

describe('the peers dist/sdk.mjs statically imports are pinned and installed', () => {
  it('pins BOTH packages sdk.mjs imports at the top level', () => {
    // Not a style check: each name here is a hard `import … from "<name>"` in
    // dist/sdk.mjs, and its absence is an ERR_MODULE_NOT_FOUND at link time.
    expect(Object.keys(pinnedPeers()).sort()).toEqual(['@anthropic-ai/sdk', '@modelcontextprotocol/sdk'])
  })

  it('pins EXACT versions — a range lets clients resolve different trees', () => {
    for (const [name, version] of Object.entries(pinnedPeers())) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('the npm install command asks for the peers, not just the SDK', () => {
    // The bug was one npm invocation that named only @gitlawb/openclaude.
    expect(INSTALLER_SRC).toMatch(/Object\.entries\(OPENCLAUDE_REQUIRED_PEERS\)[\s\S]{0,120}`\$\{n\}@\$\{v\}`/)
    expect(INSTALLER_SRC).toMatch(
      /runNpm\(\['install', `@gitlawb\/openclaude@\$\{OPENCLAUDE_SDK_VERSION\}`, \.\.\.peerSpecs\], dir\)/,
    )
  })

  it('the install verifies the SDK actually imports before declaring success', () => {
    // Result-shaped guard: catches the NEXT packaging surprise whatever it is.
    expect(INSTALLER_SRC).toMatch(/await verifySdkImports\(dir\)/)
    expect(INSTALLER_SRC).toContain("import('@gitlawb/openclaude/sdk')")
  })
})

describe('isOpenClaudeInstalled rejects the tree that actually shipped', () => {
  it('is true for a complete tree', () => {
    fakeInstall(healthyTree())
    expect(missingOpenClaudePeers()).toEqual([])
    expect(isOpenClaudeInstalled()).toBe(true)
  })

  it('THE BUG: SDK at the pin but no peers is NOT installed', () => {
    // Exactly the state on the owner's machine at 01:48 on 2026-08-02. Under
    // the old version-only check this returned true, so no reinstall was ever
    // attempted and the sidecar failed to import on every single run.
    fakeInstall({ '@gitlawb/openclaude': SDK_VERSION })
    expect(missingOpenClaudePeers().sort()).toEqual(['@anthropic-ai/sdk', '@modelcontextprotocol/sdk'])
    expect(isOpenClaudeInstalled()).toBe(false)
  })

  it.each(Object.keys(pinnedPeers()))('a tree missing only %s is NOT installed', (name) => {
    fakeInstall({ ...healthyTree(), [name]: null })
    expect(missingOpenClaudePeers()).toEqual([name])
    expect(isOpenClaudeInstalled()).toBe(false)
  })

  it('a peer at the WRONG version is NOT installed (forces a heal on bump)', () => {
    const [first] = Object.keys(pinnedPeers())
    fakeInstall({ ...healthyTree(), [first!]: '0.0.1-stale' })
    expect(missingOpenClaudePeers()).toEqual([first])
    expect(isOpenClaudeInstalled()).toBe(false)
  })

  it('a stale SDK version is still rejected (original behaviour preserved)', () => {
    fakeInstall({ ...healthyTree(), '@gitlawb/openclaude': '0.15.0' })
    expect(isOpenClaudeInstalled()).toBe(false)
  })

  it('no wrapper script → not installed, even with a perfect node_modules', () => {
    const base = join(h.userData, 'sidecars', 'openclaude')
    mkdirSync(base, { recursive: true })
    for (const [name, version] of Object.entries(healthyTree())) {
      const dir = join(base, 'node_modules', ...name.split('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }), 'utf8')
    }
    expect(isOpenClaudeInstalled()).toBe(false)
  })
})
