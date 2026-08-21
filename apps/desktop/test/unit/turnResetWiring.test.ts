// apps/desktop/test/unit/turnResetWiring.test.ts
//
// SOURCE ASSERTIONS for the halves of the three-way RESET that cannot be driven
// in this repo's node-only test setup: the main-process turn boundary, the
// AgentPage menu wiring, and the i18n keys the menu renders. Same convention as
// promptQueueStore.test.ts — the pure logic is unit-tested for real elsewhere;
// this file guards the WIRING that connects it, which is otherwise only ever
// verified by clicking.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const APP  = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')

describe('main: the checkpoint is taken at the TURN boundary', () => {
  const src = () => read('electron/ipc/agent.ipc.ts')

  it('snapshots before the run starts, not after', () => {
    const s = src()
    const snap = s.indexOf('createWorkspaceCheckpoint(workingDir')
    const run  = s.indexOf('await runTachiSession(')
    expect(snap).toBeGreaterThan(-1)
    expect(run).toBeGreaterThan(-1)
    // The whole guarantee: the tree is captured BEFORE the agent can mutate it.
    expect(snap).toBeLessThan(run)
  })

  it('emits a checkpoint event in BOTH the success and the no-snapshot case', () => {
    const s = src()
    // Taken.
    expect(s).toContain("{ type: 'checkpoint', checkpoint: cp, workspaceRoot: workingDir }")
    // NOT taken — the renderer must be able to tell "no undo" from "no event".
    expect(s).toContain("type: 'checkpoint', checkpoint: null, workspaceRoot: workingDir")
    expect(s).toContain("'no-git-backup'")
    expect(s).toContain("'snapshot-failed'")
  })

  it('checkpointing still never blocks the run', () => {
    // The snapshot lives inside a try/catch whose catch only reports.
    const s = src()
    const i = s.indexOf('createWorkspaceCheckpoint(workingDir')
    const window = s.slice(i - 400, i + 1600)
    expect(window).toContain('} catch (e) {')
    expect(window).toContain("unavailable: 'snapshot-failed'")
  })
})

describe('AgentPage: the three-way RESET menu', () => {
  const page = () => read('src/pages/agent/AgentPage.tsx')

  it('renders one menu per user turn instead of the old single ↺ edit', () => {
    const src = page()
    expect(src).toContain('<TurnResetMenu eventId={eventId} />')
    expect(src).toContain('function TurnResetMenu(')
    // The three rows, all wired to the same dispatcher.
    expect(src).toContain("fire('chat')")
    expect(src).toContain("fire('code')")
    expect(src).toContain("fire('both')")
  })

  it('disables a row rather than offering a button that no-ops', () => {
    const src = page()
    expect(src).toContain('disabled={!avail.canResetChat}')
    expect(src).toContain('disabled={!avail.canResetCode}')
    // …and shows the reason where the hint would be.
    expect(src).toContain('reset.blocked.')
    expect(src).toContain('codeReason')
  })

  it('proves aged-out from the live index instead of assuming it', () => {
    const src = page()
    expect(src).toContain('window.tachi.checkpoints.listWorkspaceCheckpoints(root)')
    expect(src).toContain('setLiveIds(list.map(c => c.id))')
  })

  it('confirm-guards the reset and routes it through runTurnReset', () => {
    const src = page()
    expect(src).toContain('const confirmed = await confirmReset({')
    expect(src).toContain('danger:  shouldRestoreCode(choice)')
    expect(src).toContain('await runTurnReset(choice,')
    expect(src).toContain('restore:   (root, id) => window.tachi.checkpoints.restoreWorkspace(root, id)')
    expect(src).toContain('sliceChat: finishChat')
  })

  it('surfaces failures and offers UNDO THIS RESET from the safety snapshot', () => {
    const src = page()
    expect(src).toContain("onFailure: (error) => showToast({ kind: 'error'")
    expect(src).toContain("label: t('reset.undo')")
    expect(src).toContain('restoreWorkspace(cp.root, safetyId)')
    expect(src).toContain("t('reset.undoFailed')")
  })

  it('keeps the old event name working as a RESET CHAT alias', () => {
    const src = page()
    expect(src).toContain("window.addEventListener('tachi:agent-reset', onReset as EventListener)")
    expect(src).toContain("window.addEventListener('tachi:agent-edit', onReset as EventListener)")
  })
})

describe('i18n: every RESET string ships in all 8 locales', () => {
  const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const
  const KEYS = [
    'button', 'tooltip', 'chat', 'chatHint', 'code', 'codeHint', 'both', 'bothHint',
    'confirmTitle', 'confirmChat', 'confirmCode', 'confirmBoth',
    'codeRestored', 'codeFailed', 'noCheckpoint', 'undo', 'undone', 'undoFailed',
  ]
  // Must match CodeBlocker in src/pages/agent/turnReset.ts one-for-one, or a
  // blocked row renders a raw key instead of a reason.
  const BLOCKED = ['running', 'archive', 'harness', 'not-taken', 'aged-out']

  for (const lang of LANGS) {
    it(`${lang}/agent.json has the reset group`, () => {
      const ns = JSON.parse(read(`src/i18n/locales/${lang}/agent.json`)) as Record<string, Record<string, unknown>>
      expect(ns.reset, `${lang} reset group`).toBeTruthy()
      for (const k of KEYS) {
        expect(typeof ns.reset[k], `${lang} reset.${k}`).toBe('string')
        expect((ns.reset[k] as string).length, `${lang} reset.${k}`).toBeGreaterThan(0)
      }
      const blocked = ns.reset.blocked as Record<string, string>
      for (const k of BLOCKED) {
        expect(typeof blocked?.[k], `${lang} reset.blocked.${k}`).toBe('string')
      }
    })
  }

  it('the blocker keys cover exactly the CodeBlocker union', () => {
    const src = read('src/pages/agent/turnReset.ts')
    for (const k of BLOCKED) expect(src).toContain(`| '${k}'`)
  })
})
