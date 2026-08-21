// apps/desktop/test/unit/codexWriteGate.test.ts
//
// Unit tests for the PURE Codex WRITE-MODE gate
// (src/pages/nodes/canvas/codexWriteGate.ts):
//   • collectWriteConsentTargets — which write-enabled codex nodes (with a wired
//     folder) a run must get consent for. Write node + wired folder → listed;
//     no folder → excluded (and read-only in main); toggle off → excluded.
//   • decideCodexSandbox — the main-side, fail-closed sandbox-mode decision.
//   • ensureCodexWriteConsent — one-per-session consent latch behaviour.
//
// Pure module (no xyflow / React / store / IPC), so this runs in the plain node
// environment with structural node/edge literals.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  CODEX_HARNESS_ID,
  isCodexNode,
  wiredFolderPaths,
  collectWriteConsentTargets,
  decideCodexSandbox,
  ensureCodexWriteConsent,
  resetCodexWriteConsentForTests,
  hasCodexWriteConsent,
  type CodexGateNode,
  type CodexGateEdge,
} from '../../src/pages/nodes/canvas/codexWriteGate'

// ── builders ────────────────────────────────────────────────────────────────

const codex = (id: string, extra: Record<string, unknown> = {}): CodexGateNode =>
  ({ id, type: 'agent', data: { label: id, harnessId: CODEX_HARNESS_ID, ...extra } })

const openclaude = (id: string, extra: Record<string, unknown> = {}): CodexGateNode =>
  ({ id, type: 'agent', data: { label: id, harnessId: 'openclaude', ...extra } })

const folder = (id: string, path: string): CodexGateNode =>
  ({ id, type: 'folder', data: { label: id, path } })

const edge = (source: string, target: string): CodexGateEdge => ({ source, target })

// ── isCodexNode ──────────────────────────────────────────────────────────────

describe('isCodexNode', () => {
  it('is true only for an agent node with harnessId codex', () => {
    expect(isCodexNode(codex('c'))).toBe(true)
    expect(isCodexNode(openclaude('a'))).toBe(false)
    expect(isCodexNode(folder('f', 'C:/x'))).toBe(false)
    expect(isCodexNode({ id: 'x', type: 'agent', data: {} })).toBe(false)
  })
})

// ── wiredFolderPaths ─────────────────────────────────────────────────────────

describe('wiredFolderPaths', () => {
  it('finds a folder wired in EITHER direction, with a non-blank path', () => {
    const nodes = [codex('c'), folder('f1', 'C:/work'), folder('f2', 'D:/data')]
    // f1 → c and c → f2 (both directions count)
    const edges = [edge('f1', 'c'), edge('c', 'f2')]
    expect(wiredFolderPaths('c', nodes, edges).sort()).toEqual(['C:/work', 'D:/data'])
  })

  it('ignores folders with a blank / whitespace path', () => {
    const nodes = [codex('c'), folder('f1', '   '), folder('f2', '')]
    const edges = [edge('f1', 'c'), edge('f2', 'c')]
    expect(wiredFolderPaths('c', nodes, edges)).toEqual([])
  })

  it('ignores non-folder neighbours and unrelated folders', () => {
    const nodes = [codex('c'), openclaude('a'), folder('unwired', 'C:/nope')]
    const edges = [edge('a', 'c')] // unwired folder has no edge to c
    expect(wiredFolderPaths('c', nodes, edges)).toEqual([])
  })

  it('dedupes identical paths and preserves first-seen order', () => {
    const nodes = [codex('c'), folder('f1', 'C:/same'), folder('f2', 'C:/same'), folder('f3', 'C:/other')]
    const edges = [edge('f1', 'c'), edge('f2', 'c'), edge('f3', 'c')]
    expect(wiredFolderPaths('c', nodes, edges)).toEqual(['C:/same', 'C:/other'])
  })
})

// ── collectWriteConsentTargets ───────────────────────────────────────────────

describe('collectWriteConsentTargets', () => {
  it('lists a write-enabled codex node WITH a wired folder', () => {
    const nodes = [codex('c', { codexAllowWrite: true, label: 'Coder' }), folder('f', 'C:/work')]
    const edges = [edge('f', 'c')]
    const targets = collectWriteConsentTargets(nodes, edges, ['c'])
    expect(targets).toEqual([{ nodeId: 'c', nodeLabel: 'Coder', folderPaths: ['C:/work'] }])
  })

  it('EXCLUDES a write-enabled codex node with NO wired folder (stays read-only)', () => {
    const nodes = [codex('c', { codexAllowWrite: true })]
    const edges: CodexGateEdge[] = []
    expect(collectWriteConsentTargets(nodes, edges, ['c'])).toEqual([])
  })

  it('EXCLUDES a codex node whose write toggle is OFF (absent or false)', () => {
    const nodesAbsent = [codex('c'), folder('f', 'C:/work')]
    const nodesFalse = [codex('c', { codexAllowWrite: false }), folder('f', 'C:/work')]
    const edges = [edge('f', 'c')]
    expect(collectWriteConsentTargets(nodesAbsent, edges, ['c'])).toEqual([])
    expect(collectWriteConsentTargets(nodesFalse, edges, ['c'])).toEqual([])
  })

  it('EXCLUDES a non-codex agent even with write flag + folder (flag is codex-only)', () => {
    const nodes = [openclaude('a', { codexAllowWrite: true }), folder('f', 'C:/work')]
    const edges = [edge('f', 'a')]
    expect(collectWriteConsentTargets(nodes, edges, ['a'])).toEqual([])
  })

  it('only considers nodes that are actually in runIds', () => {
    const nodes = [
      codex('c1', { codexAllowWrite: true }), folder('f1', 'C:/a'),
      codex('c2', { codexAllowWrite: true }), folder('f2', 'C:/b'),
    ]
    const edges = [edge('f1', 'c1'), edge('f2', 'c2')]
    // only c1 is scheduled to run
    const targets = collectWriteConsentTargets(nodes, edges, ['c1'])
    expect(targets.map(t => t.nodeId)).toEqual(['c1'])
  })

  it('falls back to a "codex" label when the node has none', () => {
    const nodes = [codex('c', { codexAllowWrite: true, label: '' }), folder('f', 'C:/work')]
    const edges = [edge('f', 'c')]
    expect(collectWriteConsentTargets(nodes, edges, ['c'])[0].nodeLabel).toBe('codex')
  })

  it('preserves runIds order across multiple write targets', () => {
    const nodes = [
      codex('a', { codexAllowWrite: true }), folder('fa', 'C:/a'),
      codex('b', { codexAllowWrite: true }), folder('fb', 'C:/b'),
    ]
    const edges = [edge('fa', 'a'), edge('fb', 'b')]
    expect(collectWriteConsentTargets(nodes, edges, ['b', 'a']).map(t => t.nodeId)).toEqual(['b', 'a'])
  })
})

// ── decideCodexSandbox (main-side, fail-closed) ──────────────────────────────

describe('decideCodexSandbox', () => {
  it('WRITE only when allowWrite && !private && a folder is wired', () => {
    expect(decideCodexSandbox({ allowWrite: true, privateMode: false, hasWiredFolder: true }))
      .toEqual({ mode: 'workspace-write', write: true, reason: 'write-enabled' })
  })

  it('read-only when the toggle is off (highest precedence)', () => {
    expect(decideCodexSandbox({ allowWrite: false, privateMode: false, hasWiredFolder: true }))
      .toEqual({ mode: 'read-only', write: false, reason: 'allow-write-off' })
  })

  it('read-only in private mode even with opt-in + folder', () => {
    expect(decideCodexSandbox({ allowWrite: true, privateMode: true, hasWiredFolder: true }))
      .toEqual({ mode: 'read-only', write: false, reason: 'private-mode' })
  })

  it('read-only with NO wired folder — never targets the storage root', () => {
    expect(decideCodexSandbox({ allowWrite: true, privateMode: false, hasWiredFolder: false }))
      .toEqual({ mode: 'read-only', write: false, reason: 'no-wired-folder' })
  })
})

// ── ensureCodexWriteConsent (one-per-session latch) ──────────────────────────

describe('ensureCodexWriteConsent', () => {
  // Faithful stub of react-i18next: return the defaultValue with every
  // {{placeholder}} replaced by its option (how the real `t` fills {{folders}}).
  const t = (_k: string, o?: Record<string, unknown>) => {
    let s = String(o?.defaultValue ?? _k)
    if (o) for (const [k, v] of Object.entries(o)) {
      if (k !== 'defaultValue') s = s.split(`{{${k}}}`).join(String(v))
    }
    return s
  }

  beforeEach(() => resetCodexWriteConsentForTests())

  it('proceeds WITHOUT prompting when there are no write targets', async () => {
    let called = 0
    const confirm = async () => { called++; return true }
    expect(await ensureCodexWriteConsent([], confirm, t)).toBe(true)
    expect(called).toBe(0)
    expect(hasCodexWriteConsent()).toBe(false)
  })

  it('prompts once, and a cancel returns false WITHOUT latching consent', async () => {
    const targets = [{ nodeId: 'c', nodeLabel: 'Coder', folderPaths: ['C:/work'] }]
    let called = 0
    const cancel = async () => { called++; return false }
    expect(await ensureCodexWriteConsent(targets, cancel, t)).toBe(false)
    expect(called).toBe(1)
    expect(hasCodexWriteConsent()).toBe(false)
    // a second run still prompts (no latch after a cancel)
    expect(await ensureCodexWriteConsent(targets, cancel, t)).toBe(false)
    expect(called).toBe(2)
  })

  it('after an approval, later runs proceed without re-prompting (one per session)', async () => {
    const targets = [{ nodeId: 'c', nodeLabel: 'Coder', folderPaths: ['C:/work'] }]
    let called = 0
    const ok = async () => { called++; return true }
    expect(await ensureCodexWriteConsent(targets, ok, t)).toBe(true)
    expect(hasCodexWriteConsent()).toBe(true)
    expect(await ensureCodexWriteConsent(targets, ok, t)).toBe(true)
    expect(called).toBe(1) // prompted only the first time
  })

  it('lists the folder paths (deduped) in the confirm message', async () => {
    const targets = [
      { nodeId: 'a', nodeLabel: 'A', folderPaths: ['C:/work', 'C:/data'] },
      { nodeId: 'b', nodeLabel: 'B', folderPaths: ['C:/work'] }, // dup path
    ]
    let seen = ''
    const confirm = async (opts: { message: string; danger?: boolean }) => {
      seen = opts.message
      expect(opts.danger).toBe(true)
      return true
    }
    await ensureCodexWriteConsent(targets, confirm, t)
    expect(seen).toContain('C:/work')
    expect(seen).toContain('C:/data')
    // deduped — 'C:/work' appears once
    expect(seen.match(/C:\/work/g)?.length).toBe(1)
  })
})
