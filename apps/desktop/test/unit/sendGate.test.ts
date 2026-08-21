// apps/desktop/test/unit/sendGate.test.ts
//
// "+ NEW" DEAD END (pre-existing bug, reproduced live 2026-07-25).
//
// The history rail's "+ NEW" archives the transcript and clears `sessionId`
// while KEEPING `workingDir`. Both send paths — the handler in AgentPage and
// the send button's disabled expression, written separately — required a live
// session id, and the lazy re-spawn branch that existed further down was
// unreachable because the guard returned first. One click on + NEW therefore
// made the composer permanently unusable: no send, no error, no hint; the only
// way out was re-picking the very same folder in the native dialog.
//
// The rule is now ONE pure function read by BOTH gates (that is the actual
// fix — two hand-written gates are what drifted), and a workspace the operator
// already chose resolves to 'start-then-send': spawn the session on demand.
//
// Wiring is asserted by reading the source, the same way tachiappSurface does:
// a helper nothing calls would pass its own tests forever.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { sendGate } from '../../src/pages/agent/sendGate'

const SRC = path.resolve(__dirname, '../../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

const base = {
  surfaceBlocked:   false,
  viewingArchive:   false,
  workflowMode:     false,
  parallelGridMode: false,
  sessionId:        null as string | null,
  workingDir:       null as string | null,
}

describe('sendGate — can this composer send, and does it need a session first', () => {
  it('THE BUG: a workspace with no session is "start-then-send", not a dead end', () => {
    // Exactly the post-"+ NEW" state: folder still picked, session cleared.
    expect(sendGate({ ...base, workingDir: 'D:\\projects\\thing' })).toBe('start-then-send')
  })

  it('a live session sends straight through', () => {
    expect(sendGate({ ...base, sessionId: 'sess-1', workingDir: 'D:\\projects\\thing' })).toBe('send')
  })

  it('workflow mode sends without any harness session (the graph runs instead)', () => {
    expect(sendGate({ ...base, workflowMode: true })).toBe('send')
  })

  it('no session and no workspace is blocked — there is nothing to run in', () => {
    expect(sendGate(base)).toBe('blocked')
  })

  it('never lazily starts for a parallel tile — tiles own their session lifecycle', () => {
    expect(sendGate({ ...base, parallelGridMode: true, workingDir: 'D:\\worktree\\a' })).toBe('blocked')
    // …a focused tile WITH a session still sends, as before.
    expect(sendGate({ ...base, parallelGridMode: true, sessionId: 'tile-1', workingDir: 'D:\\worktree\\a' })).toBe('send')
  })

  it('a foreign run holding the live session blocks every path (batch14)', () => {
    expect(sendGate({ ...base, surfaceBlocked: true, sessionId: 'sess-1', workingDir: 'D:\\x' })).toBe('blocked')
    expect(sendGate({ ...base, surfaceBlocked: true, workflowMode: true })).toBe('blocked')
    expect(sendGate({ ...base, surfaceBlocked: true, workingDir: 'D:\\x' })).toBe('blocked')
  })

  it('an archive being viewed is read-only, workspace or not', () => {
    expect(sendGate({ ...base, viewingArchive: true, workingDir: 'D:\\x' })).toBe('blocked')
    expect(sendGate({ ...base, viewingArchive: true, sessionId: 'sess-1' })).toBe('blocked')
  })
})

describe('sendGate wiring — one rule, both gates', () => {
  const page = read('pages/agent/AgentPage.tsx')

  it('AgentPage computes the gate once and renders the send button from it', () => {
    expect(page).toContain('const gate = sendGate({')
    expect(page).toContain("disabled={!task.trim() || gate === 'blocked'}")
    // The old hand-written duplicate must be gone — that duplication IS the bug.
    expect(page).not.toContain('(!workflowMode && !effectiveSessionId)')
  })

  it('the send handler starts a session lazily instead of returning early', () => {
    // The guard no longer refuses on a missing session id…
    expect(page).toContain('if (!hasContent || isRunning) return')
    expect(page).not.toContain('if (!hasContent || !effectiveSessionId || isRunning) return')
    // …it spawns one through the SAME helper the folder picker uses.
    expect(page).toContain("if (gate !== 'start-then-send' || !effectiveWorkingDir) return")
    expect(page).toContain('liveSessionId = await startSessionForWorkspace(effectiveWorkingDir)')
    expect(page).toContain('const startSessionForWorkspace = async (path: string)')
    // …and the message is routed to whatever session that produced.
    expect(page).toContain('let sendSessionId = liveSessionId')
  })

  it('the folder picker spawns through the same helper (no second spawn path)', () => {
    const activate = page.slice(page.indexOf('const activateFolder'), page.indexOf('const pickFolder'))
    expect(activate).toContain('await startSessionForWorkspace(path)')
    expect(activate).not.toContain('window.tachi.agent.startSession(')
  })
})
