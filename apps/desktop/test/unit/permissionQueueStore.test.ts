// apps/desktop/test/unit/permissionQueueStore.test.ts
//
// PERMISSION LIFETIME — renderer half. Live /loop bug, 2026-07-25:
//
// The permission queue was AgentPage `useState`. A card for the derived verify
// check was pending when the operator navigated CODE → NODES → CODE; AgentPage
// unmounted, React threw the queue away, and the card was unanswerable forever
// while main kept awaiting its resolver.
//
// The queue now lives in the agent STORE. What is pinned here:
//   - it survives an unmount/remount (the store is not component state);
//   - a remount re-syncs from main (agent:permission-pending → syncPermissions)
//     and repopulates cards raised while NO page was mounted, without
//     duplicating the ones already on screen;
//   - re-sync drops cards main no longer awaits, and cards leave the queue ONLY
//     by a user decision or an explicit settle-from-main — reset()/
//     startNewSession() must never silently drop one (that IS the bug).
//
// Same shims as agentStore.test.ts: the persist middleware touches localStorage
// + window.tachi.safeStorage on every setState.

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const _ls = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem:    (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem:    (k: string, v: string) => { _ls.set(k, String(v)) },
  removeItem: (k: string) => { _ls.delete(k) },
  clear:      () => { _ls.clear() },
}
;(globalThis as any).window = {
  tachi: {
    safeStorage: {
      isAvailable: async () => ({ available: false }),
      encrypt:     async (v: string) => ({ encrypted: v }),
      decrypt:     async (v: string) => ({ plaintext: v }),
    },
  },
}

import { useAgentStore } from '../../src/store/agent.store'
import {
  activePermission, queuedBehind, permissionOwnerSurface, foreignPermissionOwner,
} from '../../src/pages/agent/permissionQueue'
import type { PermissionRequest } from '../../src/pages/agent/PermissionCard'

const card = (id: string, command: string, sessionId?: string): PermissionRequest => ({
  id,
  toolName: 'bash',
  toolInput: { command },
  reason: `Bash execution: \`${command}\``,
  recommendedDecision: 'allow',
  ...(sessionId ? { sessionId } : {}),
})

const VERIFY = card('req-verify', 'pnpm run typecheck')

/** What a route change does: the component goes away, the store does not. */
function remount(): PermissionRequest[] {
  return useAgentStore.getState().permissionQueue
}

beforeEach(() => {
  useAgentStore.setState({
    permissionQueue: [],
    messages: [], status: 'idle', error: null, viewingArchiveId: null, pastSessions: [],
  })
})

describe('agent store — permission queue survives an unmount', () => {
  it('keeps the pending card across CODE → NODES → CODE', () => {
    useAgentStore.getState().pushPermission(VERIFY)
    // …the operator navigates away and back. Nothing else happens.
    const afterRemount = remount()
    expect(afterRemount).toHaveLength(1)
    expect(activePermission(afterRemount)?.id).toBe('req-verify')
  })

  it('queues parallel prompts instead of overwriting (oldest first, +N behind)', () => {
    const { pushPermission } = useAgentStore.getState()
    pushPermission(card('a', 'pnpm run typecheck'))
    pushPermission(card('b', 'git status'))
    const q = remount()
    expect(activePermission(q)?.id).toBe('a')
    expect(queuedBehind(q)).toBe(1)
  })

  it('re-delivery of a queued id is a no-op (the push channel may repeat)', () => {
    const { pushPermission } = useAgentStore.getState()
    pushPermission(VERIFY)
    pushPermission({ ...VERIFY })
    expect(remount()).toHaveLength(1)
  })

  it('a user decision is the only way a card leaves by itself', () => {
    const { pushPermission, settlePermission } = useAgentStore.getState()
    pushPermission(VERIFY)
    settlePermission('req-verify')
    expect(remount()).toEqual([])
  })

  it('main settling it without us (timeout / abort) drops the card', () => {
    const { pushPermission, cancelPermissions } = useAgentStore.getState()
    pushPermission(VERIFY)
    pushPermission(card('b', 'git status'))
    cancelPermissions(['req-verify'])
    expect(remount().map(q => q.id)).toEqual(['b'])
  })

  it('reset() and startNewSession() do NOT silently drop an unanswered card', () => {
    // Dropping it in the renderer would not settle main's resolver — that is
    // precisely the hang this queue exists to prevent.
    useAgentStore.getState().pushPermission(VERIFY)
    useAgentStore.getState().reset()
    expect(remount()).toHaveLength(1)
    useAgentStore.getState().startNewSession()
    expect(remount()).toHaveLength(1)
  })
})

describe('agent store — re-sync from main on mount', () => {
  it('repopulates a card raised while no page was mounted', () => {
    expect(remount()).toEqual([])                       // renderer knows nothing
    useAgentStore.getState().syncPermissions([VERIFY])  // main: "I am still waiting on this"
    expect(remount().map(q => q.id)).toEqual(['req-verify'])
  })

  it('does not duplicate cards the queue already holds, and keeps their order', () => {
    const { pushPermission, syncPermissions } = useAgentStore.getState()
    pushPermission(card('a', 'pnpm run typecheck'))
    pushPermission(card('b', 'git status'))
    syncPermissions([card('a', 'pnpm run typecheck'), card('b', 'git status'), card('c', 'pnpm test')])
    expect(remount().map(q => q.id)).toEqual(['a', 'b', 'c'])
  })

  it('drops cards main no longer awaits (answered on the phone while we were away)', () => {
    const { pushPermission, syncPermissions } = useAgentStore.getState()
    pushPermission(card('a', 'pnpm run typecheck'))
    pushPermission(card('b', 'git status'))
    syncPermissions([card('b', 'git status')])
    expect(remount().map(q => q.id)).toEqual(['b'])
  })

  it('an empty outstanding list clears a stale queue', () => {
    useAgentStore.getState().pushPermission(VERIFY)
    useAgentStore.getState().syncPermissions([])
    expect(remount()).toEqual([])
  })

  it('an unchanged re-sync keeps the same array (no needless re-render)', () => {
    const { pushPermission, syncPermissions } = useAgentStore.getState()
    pushPermission(VERIFY)
    const before = remount()
    syncPermissions([VERIFY])
    expect(remount()).toBe(before)
  })

  it('carries the owning session id through a re-sync (the owner chip needs it)', () => {
    useAgentStore.getState().syncPermissions([card('a', 'rm -rf build', 'sess-code-1')])
    expect(remount()[0].sessionId).toBe('sess-code-1')
  })

  it('never prunes a card that arrived DURING the round-trip', () => {
    // The mount effect snapshots the queue, asks main, and only that snapshot
    // may be pruned. A push landing mid-flight is newer than main's answer —
    // dropping it would strand the tool blocked on it (the original hang).
    const { pushPermission, syncPermissions } = useAgentStore.getState()
    pushPermission(card('old', 'pnpm run typecheck'))
    const prunable = remount().map(q => q.id)          // ← what the effect captures
    pushPermission(card('mid-flight', 'git status'))   // ← arrives while main answers
    syncPermissions([], prunable)                      // main: "nothing outstanding"
    expect(remount().map(q => q.id)).toEqual(['mid-flight'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WHOSE RUN AM I APPROVING? (observed live, 2026-07-25)
//
// The queue is app-lifetime, so the active card renders on whichever surface is
// mounted — TACHIAPP showed the CODE run's bash card under its own "another run
// is in progress" note, with working ALLOW/DENY. The buttons STAY live (an
// operator on the wrong tab must be able to unblock the run — a stalled card is
// worse), so the card has to say which run it belongs to instead.
// ─────────────────────────────────────────────────────────────────────────────
describe('permission owner — which surface does this card belong to', () => {
  const CODE_SESSION = 'sess-code-1'
  const APP_SESSION  = 'sess-app-1'

  it('a card for the live CODE session is owned by CODE', () => {
    expect(permissionOwnerSurface(card('x', 'ls', CODE_SESSION), {
      sessionId: CODE_SESSION, sessionTag: null,
    })).toBe('code')
  })

  it('a card for the live TACHIAPP session is owned by TACHIAPP', () => {
    expect(permissionOwnerSurface(card('x', 'ls', APP_SESSION), {
      sessionId: APP_SESSION, sessionTag: 'tachiapp',
    })).toBe('tachiapp')
  })

  it('a parallel tile session is CODE — the grid never runs on TACHIAPP', () => {
    expect(permissionOwnerSurface(card('x', 'ls', 'sess-tile-3'), {
      sessionId: APP_SESSION, sessionTag: 'tachiapp', parallelSessionIds: ['sess-tile-3'],
    })).toBe('code')
  })

  it('is UNKNOWN (never guessed) without a session id, or for a session that left the live slot', () => {
    // An older main pushes no session id…
    expect(permissionOwnerSurface(card('x', 'ls'), { sessionId: CODE_SESSION, sessionTag: null })).toBe(null)
    // …and a card whose session is nowhere on screen must not be mislabelled.
    expect(permissionOwnerSurface(card('x', 'ls', 'sess-gone'), {
      sessionId: CODE_SESSION, sessionTag: null,
    })).toBe(null)
    expect(permissionOwnerSurface(null, { sessionId: CODE_SESSION, sessionTag: null })).toBe(null)
  })

  it('THE BUG: on TACHIAPP, a CODE run\'s card is labelled "CODE"', () => {
    // Exactly the live observation: the Code run holds the live session (mid-run,
    // so TACHIAPP is blocked and never yanks it) and its bash card renders here.
    expect(foreignPermissionOwner(card('x', 'rm -rf build', CODE_SESSION), {
      sessionId: CODE_SESSION, sessionTag: null,
    }, 'tachiapp')).toBe('code')
  })

  it('the reverse direction is symmetric', () => {
    expect(foreignPermissionOwner(card('x', 'git push', APP_SESSION), {
      sessionId: APP_SESSION, sessionTag: 'tachiapp',
    }, 'code')).toBe('tachiapp')
  })

  it('no chip when the card belongs to the surface you are looking at', () => {
    expect(foreignPermissionOwner(card('x', 'ls', CODE_SESSION), {
      sessionId: CODE_SESSION, sessionTag: null,
    }, 'code')).toBe(null)
    expect(foreignPermissionOwner(card('x', 'ls', APP_SESSION), {
      sessionId: APP_SESSION, sessionTag: 'tachiapp',
    }, 'tachiapp')).toBe(null)
  })

  it('no chip when ownership is unknown — a wrong owner is worse than none', () => {
    expect(foreignPermissionOwner(card('x', 'ls'), {
      sessionId: CODE_SESSION, sessionTag: null,
    }, 'tachiapp')).toBe(null)
  })
})

// The mapping above is worth nothing if main stops stamping the session id or
// the page stops rendering the chip — both are one-liners across three files.
describe('permission owner wiring', () => {
  const APP  = path.resolve(__dirname, '../..')
  const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')

  it('main stamps the owning session on the card payload it pushes AND remembers', () => {
    const ipc = read('electron/ipc/agent.ipc.ts')
    expect(ipc).toContain('const cardReq: PermissionRequestShape = { ...req, sessionId: ctx.sessionId }')
    expect(ipc).toContain("win.webContents.send('agent:permission-request', cardReq)")
    // The remembered payload feeds agent:permission-pending — a card recovered
    // after a reload must carry the owner too.
    expect(ipc).toContain('request: cardReq,')
  })

  it('the page labels the card only when the run belongs to the other surface', () => {
    const page = read('src/pages/agent/AgentPage.tsx')
    expect(page).toContain('foreignPermissionOwner(')
    expect(page).toContain('ownerLabel={permissionOwnerLabel}')
    // …and the card stays actionable: no disabled/readonly branch was added.
    const cardSrc = read('src/pages/agent/PermissionCard.tsx')
    expect(cardSrc).toContain('data-testid="permission-owner"')
    expect(cardSrc).not.toContain('disabled=')
  })

  it('ships the owner copy in every locale', () => {
    for (const lang of ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']) {
      const agent = JSON.parse(read(`src/i18n/locales/${lang}/agent.json`))
      expect(agent.permission.owner, `${lang}/agent.json permission.owner`).toBeTruthy()
      expect(agent.permission.owner.code).toBeTruthy()
      expect(agent.permission.owner.tachiapp).toBeTruthy()
      expect(agent.permission.owner.hint).toBeTruthy()
    }
  })
})
