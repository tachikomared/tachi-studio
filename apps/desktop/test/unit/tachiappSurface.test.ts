// apps/desktop/test/unit/tachiappSurface.test.ts
//
// The TACHIAPP surface = the SAME AgentPage + agent.store, pinned to the app's
// own source. Two things have to hold for that preset to be safe:
//
//   1. STORE — the live session carries the owning surface (`sessionTag`), the
//      archive snapshot inherits it, and each rail sees only its own sessions
//      (Code = untagged, which also covers every pre-tagging archive).
//   2. WIRING — /tachiapp really renders AgentPage in appMode with its own
//      remount key, and the pinned sidebar row navigates there. Asserted by
//      reading the source, the same way i18nConsistency asserts locale files:
//      these are one-line wirings that silently rot when someone refactors.
//
// Store stubs mirror agentStore.test.ts (persist middleware needs a
// localStorage + a window.tachi.safeStorage that reports unavailable).

import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ── In-memory localStorage shim (installed BEFORE the store import) ──────────
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

import {
  useAgentStore,
  sessionsForTag,
  surfaceBindDecision,
  type PastAgentSession,
  type AgentEvent,
} from '../../src/store/agent.store'

const SRC = path.resolve(__dirname, '../../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

const APP_REPO = 'D:\\projects\\TachiDesk'

beforeEach(() => {
  useAgentStore.setState({
    workingDir: null,
    lastCodeWorkingDir: null,
    sessionId:  null,
    status:     'idle',
    messages:   [],
    error:      null,
    startedAt:  null,
    sessionTag: null,
    pastSessions: [],
    viewingArchiveId: null,
    lastParkedSession: { code: null, tachiapp: null },
  })
})

describe('sessionsForTag — one archive, two rails', () => {
  const mk = (id: string, tag?: 'tachiapp'): PastAgentSession => ({
    id, title: id, workingDir: null, harness: 'tachi', mode: 'build',
    status: 'done', error: null, messages: [], startedAt: 1, endedAt: 2,
    ...(tag ? { tag } : {}),
  })

  it('the TACHIAPP rail lists only tachiapp sessions', () => {
    const all = [mk('a'), mk('b', 'tachiapp'), mk('c'), mk('d', 'tachiapp')]
    expect(sessionsForTag(all, 'tachiapp').map(s => s.id)).toEqual(['b', 'd'])
  })

  it('the Code rail lists only untagged sessions', () => {
    const all = [mk('a'), mk('b', 'tachiapp'), mk('c')]
    expect(sessionsForTag(all).map(s => s.id)).toEqual(['a', 'c'])
  })

  it('legacy archives (written before tagging existed) stay on the Code rail', () => {
    const legacy = { ...mk('legacy') } as PastAgentSession
    delete (legacy as { tag?: unknown }).tag
    expect(sessionsForTag([legacy]).map(s => s.id)).toEqual(['legacy'])
    expect(sessionsForTag([legacy], 'tachiapp')).toEqual([])
  })

  it('the two rails partition the archive — no session is lost or duplicated', () => {
    const all = [mk('a'), mk('b', 'tachiapp'), mk('c'), mk('d', 'tachiapp')]
    const code = sessionsForTag(all)
    const app  = sessionsForTag(all, 'tachiapp')
    expect(code.length + app.length).toBe(all.length)
    expect(new Set([...code, ...app].map(s => s.id)).size).toBe(all.length)
  })
})

describe('agent.store — session tagging', () => {
  it('defaults to no tag (the Code tab owns the live session)', () => {
    expect(useAgentStore.getState().sessionTag).toBe(null)
  })

  it('archives a tagged session so the TACHIAPP rail can find it', () => {
    const st = useAgentStore.getState()
    st.setSessionTag('tachiapp')
    st.setWorkingDir(APP_REPO)
    st.appendEvent({ type: 'user-text', text: 'add a keyboard shortcut' } as AgentEvent)
    st.setStatus('done')

    const archived = useAgentStore.getState().pastSessions
    expect(archived).toHaveLength(1)
    expect(archived[0].tag).toBe('tachiapp')
    expect(archived[0].workingDir).toBe(APP_REPO)
    expect(sessionsForTag(archived, 'tachiapp')).toHaveLength(1)
    expect(sessionsForTag(archived)).toHaveLength(0)
  })

  it('records the TACHI harness on a tachiapp archive, whatever the Code preference is', () => {
    const st = useAgentStore.getState()
    st.setHarness('openclaude')       // the Code tab's persisted preference
    st.setSessionTag('tachiapp')
    st.appendEvent({ type: 'user-text', text: 'why is startup slow?' } as AgentEvent)
    st.setStatus('done')

    // TACHIAPP always spawns + sends on 'tachi', so the rail must not label the
    // session 'openclaude' (and continuing it must not restart on openclaude either).
    expect(useAgentStore.getState().pastSessions[0].harness).toBe('tachi')

    // …while an untagged Code session still records the real preference.
    useAgentStore.setState({ messages: [], startedAt: null, pastSessions: [], sessionTag: null })
    const st2 = useAgentStore.getState()
    st2.appendEvent({ type: 'user-text', text: 'refactor this' } as AgentEvent)
    st2.setStatus('done')
    expect(useAgentStore.getState().pastSessions[0].harness).toBe('openclaude')
  })

  it('leaves the tag key OFF an untagged Code session', () => {
    const st = useAgentStore.getState()
    st.appendEvent({ type: 'user-text', text: 'audit this repo' } as AgentEvent)
    st.setStatus('done')

    const archived = useAgentStore.getState().pastSessions
    expect(archived).toHaveLength(1)
    expect('tag' in archived[0]).toBe(false)
    expect(sessionsForTag(archived)).toHaveLength(1)
  })

  it('startNewSession keeps the tag on the snapshot it archives', () => {
    const st = useAgentStore.getState()
    st.setSessionTag('tachiapp')
    st.appendEvent({ type: 'user-text', text: 'explain the harness' } as AgentEvent)
    st.startNewSession()

    const s = useAgentStore.getState()
    expect(s.pastSessions[0].tag).toBe('tachiapp')
    expect(s.messages).toHaveLength(0)
    // Still the TACHIAPP surface — the next session archives there too.
    expect(s.sessionTag).toBe('tachiapp')
  })

  it('resumeArchive restores the owning surface, so a continued session re-archives to the same rail', () => {
    const st = useAgentStore.getState()
    st.setSessionTag('tachiapp')
    st.appendEvent({ type: 'user-text', text: 'fix the sidebar' } as AgentEvent)
    st.setStatus('done')
    const archivedId = useAgentStore.getState().pastSessions[0].id

    // Simulate switching to the Code tab (which clears the tag), then continuing.
    useAgentStore.getState().setSessionTag(null)
    useAgentStore.getState().resumeArchive(archivedId)
    expect(useAgentStore.getState().sessionTag).toBe('tachiapp')

    useAgentStore.getState().setStatus('done')
    const re = useAgentStore.getState().pastSessions
    expect(re).toHaveLength(1)
    expect(re[0].tag).toBe('tachiapp')
  })

  it('does not persist the live tag (only the archive carries it)', () => {
    // partialize decides what survives a restart; sessionTag is live state.
    const src = fs.readFileSync(path.join(SRC, 'store/agent.store.ts'), 'utf8')
    const partialize = src.slice(src.indexOf('partialize:'))
    expect(partialize).not.toContain('sessionTag')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TRANSCRIPT BLEED (observed live). Switching CODE → TACHIAPP rendered the
// previous Code run under the TACHIAPP header until "+ NEW" was clicked: the
// two routes are distinct react-router elements but share ONE store, and the
// pinned keeper effect only binds when NO session is live — so the Code session
// simply stayed. Never cosmetic: the next send from TACHIAPP would have reused
// that sessionId, that workspace and that transcript as replayed history, then
// re-archived the merged conversation onto the CODE rail.
// ─────────────────────────────────────────────────────────────────────────────
describe('surfaceBindDecision — each surface owns its own conversation', () => {
  const base = {
    surface: null, sessionTag: null, status: 'idle' as const,
    hasSession: false, hasMessages: false, viewingArchive: false,
  }

  it('own: the live session already belongs to this surface', () => {
    expect(surfaceBindDecision({ ...base, surface: null, sessionTag: null })).toBe('own')
    expect(surfaceBindDecision({ ...base, surface: 'tachiapp', sessionTag: 'tachiapp' })).toBe('own')
    // …even mid-run: a surface never parks its OWN working session.
    expect(surfaceBindDecision({
      ...base, surface: 'tachiapp', sessionTag: 'tachiapp', status: 'running', hasSession: true,
    })).toBe('own')
  })

  it('park: CODE → TACHIAPP with a finished Code session (THE bug)', () => {
    expect(surfaceBindDecision({
      ...base, surface: 'tachiapp', sessionTag: null,
      status: 'done', hasSession: true, hasMessages: true,
    })).toBe('park')
  })

  it('park: TACHIAPP → CODE with a finished tachiapp session (same, reversed)', () => {
    expect(surfaceBindDecision({
      ...base, surface: null, sessionTag: 'tachiapp',
      status: 'done', hasSession: true, hasMessages: true,
    })).toBe('park')
  })

  it('busy: a foreign run in flight is NEVER yanked', () => {
    for (const status of ['running', 'starting'] as const) {
      expect(surfaceBindDecision({
        ...base, surface: 'tachiapp', sessionTag: null, status, hasSession: true, hasMessages: true,
      }), status).toBe('busy')
      expect(surfaceBindDecision({
        ...base, surface: null, sessionTag: 'tachiapp', status, hasSession: true,
      }), status).toBe('busy')
    }
  })

  it('claim: a foreign but EMPTY slate needs no archive, only the tag', () => {
    expect(surfaceBindDecision({ ...base, surface: 'tachiapp', sessionTag: null })).toBe('claim')
  })

  it('park: a foreign ARCHIVE left open — leaving the view is lossless', () => {
    // status on an archive snapshot is whatever it was when it ended, so the
    // viewing flag has to win over the running/starting check.
    expect(surfaceBindDecision({
      ...base, surface: 'tachiapp', sessionTag: null,
      status: 'running', hasMessages: true, viewingArchive: true,
    })).toBe('park')
  })
})

describe('surface hand-off — archive, never discard', () => {
  /** What the ownership effect in AgentPage does for a 'park'. */
  const park = (surface: 'tachiapp' | null) => {
    useAgentStore.getState().startNewSession()
    useAgentStore.getState().setSessionTag(surface)
  }

  it('CODE → TACHIAPP: the Code transcript leaves the live slot for the CODE rail', () => {
    const st = useAgentStore.getState()
    st.setWorkingDir('D:\\projects\\some-user-repo')
    st.setSession('code-session-1')
    st.appendEvent({ type: 'user-text', text: 'refactor the parser' } as AgentEvent)
    st.setStatus('done')

    park('tachiapp')

    const s = useAgentStore.getState()
    // Nothing bleeds through: empty transcript, no borrowed harness session.
    expect(s.messages).toEqual([])
    expect(s.sessionId).toBe(null)
    expect(s.sessionTag).toBe('tachiapp')
    // …and NOTHING was lost — it is on the Code rail, continuable.
    expect(sessionsForTag(s.pastSessions).map(p => p.title)).toEqual(['refactor the parser'])
    expect(sessionsForTag(s.pastSessions, 'tachiapp')).toEqual([])
  })

  it('TACHIAPP → CODE: the app-chat transcript stays on the TACHIAPP rail', () => {
    const st = useAgentStore.getState()
    st.setSessionTag('tachiapp')
    st.setWorkingDir(APP_REPO)
    st.setSession('app-session-1')
    st.appendEvent({ type: 'user-text', text: 'add a keyboard shortcut' } as AgentEvent)
    st.setStatus('done')

    park(null)

    const s = useAgentStore.getState()
    expect(s.messages).toEqual([])
    expect(s.sessionId).toBe(null)
    expect(s.sessionTag).toBe(null)
    expect(sessionsForTag(s.pastSessions, 'tachiapp').map(p => p.title)).toEqual(['add a keyboard shortcut'])
    expect(sessionsForTag(s.pastSessions)).toEqual([])
  })

  it('the parked session does not re-enter the next surface\'s send history', () => {
    // The send path replays `messages` as conversation history. If the foreign
    // transcript were still there, the first TACHIAPP turn would carry the whole
    // Code run into the model's context (and into the merged archive).
    const st = useAgentStore.getState()
    st.appendEvent({ type: 'user-text', text: 'delete the old migration' } as AgentEvent)
    st.appendEvent({ type: 'text', text: 'done, removed 4 files' } as AgentEvent)
    st.setStatus('done')

    park('tachiapp')
    useAgentStore.getState().appendEvent({ type: 'user-text', text: 'why is startup slow?' } as AgentEvent)

    const live = useAgentStore.getState().messages.map(m => (m.event as { text?: string }).text)
    expect(live).toEqual(['why is startup slow?'])
  })

  it('parking while browsing a foreign archive keeps the archive intact', () => {
    const st = useAgentStore.getState()
    st.appendEvent({ type: 'user-text', text: 'yesterday\'s code run' } as AgentEvent)
    st.setStatus('done')
    useAgentStore.getState().startNewSession()          // back to a clean live slate
    const id = useAgentStore.getState().pastSessions[0].id
    useAgentStore.getState().viewArchive(id)            // …then browse it read-only

    // Navigating to TACHIAPP while an archive is open: leaving the view must be
    // lossless — the entry stays exactly where it was, on its own rail.
    park('tachiapp')

    const s = useAgentStore.getState()
    expect(s.viewingArchiveId).toBe(null)
    expect(s.messages).toEqual([])
    expect(s.sessionTag).toBe('tachiapp')
    expect(sessionsForTag(s.pastSessions).map(p => p.id)).toEqual([id])
    expect(sessionsForTag(s.pastSessions)[0].messages).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-SELECT ON RETURN. When a foreign park happens (above), AgentPage's
// ownership effect records the freshly archived entry against the OWNING
// surface here; that surface's next mount reads + clears it to auto-open the
// entry instead of a blank composer. This block covers the store half only —
// record/consume/clear — the mount-effect wiring is a React effect and out of
// reach of a node-env test.
// ─────────────────────────────────────────────────────────────────────────────
describe('agent.store — lastParkedSession (auto-select record/consume/clear)', () => {
  it('starts empty for both surfaces', () => {
    const s = useAgentStore.getState()
    expect(s.lastParkedSession).toEqual({ code: null, tachiapp: null })
  })

  it('records under "code" for the untagged Code surface (tag = null)', () => {
    useAgentStore.getState().recordParkedSession(null, 'archive-1')
    expect(useAgentStore.getState().lastParkedSession).toEqual({ code: 'archive-1', tachiapp: null })
  })

  it('records under "tachiapp" for the TACHIAPP surface', () => {
    useAgentStore.getState().recordParkedSession('tachiapp', 'archive-2')
    expect(useAgentStore.getState().lastParkedSession).toEqual({ code: null, tachiapp: 'archive-2' })
  })

  it('take reads and clears in one step — a second take gets nothing', () => {
    useAgentStore.getState().recordParkedSession(null, 'archive-3')
    expect(useAgentStore.getState().takeParkedSession(null)).toBe('archive-3')
    expect(useAgentStore.getState().lastParkedSession.code).toBe(null)
    expect(useAgentStore.getState().takeParkedSession(null)).toBe(null)
  })

  it('take on a surface with nothing parked is a no-op null, not a throw', () => {
    expect(useAgentStore.getState().takeParkedSession('tachiapp')).toBe(null)
    expect(useAgentStore.getState().lastParkedSession).toEqual({ code: null, tachiapp: null })
  })

  it('the two surfaces are independent — taking one never touches the other', () => {
    const st = useAgentStore.getState()
    st.recordParkedSession(null, 'code-archive')
    st.recordParkedSession('tachiapp', 'app-archive')
    expect(useAgentStore.getState().takeParkedSession('tachiapp')).toBe('app-archive')
    // Code's marker survives the TACHIAPP take untouched.
    expect(useAgentStore.getState().lastParkedSession).toEqual({ code: 'code-archive', tachiapp: null })
    expect(useAgentStore.getState().takeParkedSession(null)).toBe('code-archive')
    expect(useAgentStore.getState().lastParkedSession).toEqual({ code: null, tachiapp: null })
  })

  it('re-recording for the same surface replaces the previous marker (never a queue)', () => {
    const st = useAgentStore.getState()
    st.recordParkedSession('tachiapp', 'first')
    st.recordParkedSession('tachiapp', 'second')
    expect(useAgentStore.getState().takeParkedSession('tachiapp')).toBe('second')
  })

  it('is never persisted — live state, like sessionTag/reconnect/permissionQueue', () => {
    const src = fs.readFileSync(path.join(SRC, 'store/agent.store.ts'), 'utf8')
    const partialize = src.slice(src.indexOf('partialize:'))
    expect(partialize).not.toContain('lastParkedSession')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AgentPage wiring for auto-select (source assertions — same idiom as the
// ownership/claim-order checks below: these are one-line wirings that rot
// silently on refactor, and the effect logic itself needs a DOM to exercise).
// ─────────────────────────────────────────────────────────────────────────────
describe('AgentPage — auto-select wiring', () => {
  it('records a park only for a REAL foreign park, never a "+ New" click or an archive-view close', () => {
    const page = read('pages/agent/AgentPage.tsx')
    const ownership = page.slice(page.indexOf('const surfaceTag:'), page.indexOf('AUTO-SELECT ON RETURN'))
    expect(ownership).toContain('recordParkedSession(owningTag, parkedId)')
    // Gated on realPark = not viewing an archive AND there were messages to
    // snapshot — the archive-view "close" park snapshots nothing new.
    expect(ownership).toContain('!st.viewingArchiveId && st.messages.length > 0')
  })

  it('the auto-select effect never fires over a session the operator already started', () => {
    const page = read('pages/agent/AgentPage.tsx')
    const autoSelectAt = page.indexOf('AUTO-SELECT ON RETURN')
    const effect = page.slice(autoSelectAt, page.indexOf('GAVE-UP DETECTION', autoSelectAt))
    expect(effect).toContain("if (status !== 'idle' || messages.length > 0 || viewingArchiveId) return")
    expect(effect).toContain('takeParkedSession(surfaceTag)')
    expect(effect).toContain('viewArchive(parkedId)')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WORKSPACE MEMORY (the cost of the park, found live 2026-07-25).
//
// Claiming the live slot for CODE drops an inherited workingDir on purpose —
// the app source must never become "the folder you are working in" just because
// you visited the self-improvement chat. But that also threw away the folder the
// operator picked THEMSELVES: a CODE → TACHIAPP → CODE round trip landed back on
// "Choose folder…". The Code surface therefore remembers its OWN last workspace.
// ─────────────────────────────────────────────────────────────────────────────
describe('agent.store — the Code surface remembers its own workspace', () => {
  const USER_REPO = 'D:\\projects\\some-user-repo'

  it('records a folder bound by the CODE surface', () => {
    useAgentStore.getState().setWorkingDir(USER_REPO)
    expect(useAgentStore.getState().lastCodeWorkingDir).toBe(USER_REPO)
  })

  it('never records the TACHIAPP app source (the tag is stamped before the bind)', () => {
    const st = useAgentStore.getState()
    st.setWorkingDir(USER_REPO)          // the operator's own pick, on CODE
    st.setSessionTag('tachiapp')         // …then TACHIAPP claims the slot
    st.setWorkingDir(APP_REPO)           // …and binds its resolved source
    expect(useAgentStore.getState().workingDir).toBe(APP_REPO)
    expect(useAgentStore.getState().lastCodeWorkingDir).toBe(USER_REPO)
  })

  it('a clear does not erase the memory — that IS the round trip', () => {
    const st = useAgentStore.getState()
    st.setWorkingDir(USER_REPO)
    // CODE → TACHIAPP → CODE: the returning Code surface drops the foreign dir…
    st.setSessionTag('tachiapp')
    st.setWorkingDir(APP_REPO)
    st.setWorkingDir(null)               // …the park's "never inherit" clear
    st.setSessionTag(null)
    const s = useAgentStore.getState()
    expect(s.workingDir).toBe(null)
    // …and the folder the operator picked here is still known, so it can be
    // re-resolved (AgentPage validates it on disk before restoring).
    expect(s.lastCodeWorkingDir).toBe(USER_REPO)
  })

  it('is persisted like the other preferences (survives a restart)', () => {
    const src = fs.readFileSync(path.join(SRC, 'store/agent.store.ts'), 'utf8')
    const partialize = src.slice(src.indexOf('partialize:'))
    expect(partialize).toContain('lastCodeWorkingDir')
    // …while the LIVE workspace still is not: a dead session's dir must not
    // come back unvalidated.
    expect(partialize).not.toContain('workingDir: s.workingDir')
  })

  it('AgentPage restores it only after re-validating the path on disk', () => {
    const page = read('pages/agent/AgentPage.tsx')
    const restore = page.slice(page.indexOf('const restoreCodeWorkspace'))
    // Existence check via the IPC that already stats the dir (and authorizes it).
    expect(restore.indexOf('window.tachi.agent.registerWorkspace(remembered)')).toBeGreaterThan(-1)
    const guardAt = restore.indexOf('if (!exists) return')
    const setAt   = restore.indexOf('setWorkingDir(remembered)')
    expect(guardAt).toBeGreaterThan(-1)
    expect(setAt).toBeGreaterThan(guardAt)
    // Only the CODE surface restores, and only AFTER the claim cleared the
    // foreign dir — never in appMode, which resolves its own source.
    expect(page).toContain('if (!appMode) void restoreCodeWorkspace()')
    const own = page.slice(page.indexOf('const surfaceTag:'))
    expect(own.indexOf('void restoreCodeWorkspace()')).toBeGreaterThan(own.indexOf('if (!appMode) setWorkingDir(null)'))
  })
})

describe('TACHIAPP wiring', () => {
  it('routes /tachiapp to AgentPage in appMode, with its own remount key', () => {
    const app = read('app/App.tsx')
    const route = app.split('\n').find(l => l.includes('path="/tachiapp"'))
    expect(route, '/tachiapp route missing from App.tsx').toBeTruthy()
    expect(route).toContain('AgentPage')
    expect(route).toContain('appMode')
    expect(route).toContain('key="tachiapp"')
    // The Code route must keep a DIFFERENT key or React reuses one preset's
    // state for the other (same component type, same tree position).
    const codeRoute = app.split('\n').find(l => l.includes('path="/agent"'))
    expect(codeRoute).toContain('key="code"')
    expect(codeRoute).not.toContain('appMode')
  })

  it('pins a sidebar row that navigates to /tachiapp', () => {
    const sidebar = read('components/layout/Sidebar.tsx')
    expect(sidebar).toContain("navigate('/tachiapp')")
    expect(sidebar).toContain('actions.tachiapp')
  })

  it('AgentPage accepts the appMode preset and pins the TACHI harness', () => {
    const page = read('pages/agent/AgentPage.tsx')
    expect(page).toContain('appMode = false')
    // The preset must never reach the folder machinery.
    expect(page).toContain('const workflowMode              = !appMode')
    expect(page).toContain('const parallelGridMode = !appMode')
    expect(page).toContain("appMode ? 'tachi' : harness")
    // …and it resolves its workspace instead of asking for one.
    expect(page).toContain('window.tachi.app.resolveAppRepo()')
    expect(page).toContain('window.tachi.app.chooseAppRepo()')
  })

  it('claims the surface AFTER archiving, so the outgoing session keeps its own rail', () => {
    const page = read('pages/agent/AgentPage.tsx')
    // TACHIAPP bind: archive the foreign session, THEN stamp 'tachiapp'.
    const pinned = page.slice(page.indexOf('const activatePinnedRepo'))
    const archiveAt = pinned.indexOf('startNewSession()')
    const tagAt     = pinned.indexOf("setSessionTag('tachiapp')")
    expect(archiveAt).toBeGreaterThan(-1)
    expect(tagAt).toBeGreaterThan(archiveAt)
    // Code bind: same rule in the other direction.
    const folder = page.slice(page.indexOf('const activateFolder'))
    expect(folder.indexOf('setSessionTag(null)')).toBeGreaterThan(folder.indexOf('startNewSession()'))
  })

  it('claims the live slot on mount, from BOTH surfaces', () => {
    const page = read('pages/agent/AgentPage.tsx')
    // The surface identity is derived from the preset, not hard-coded per route.
    expect(page).toContain("const surfaceTag: AgentSessionTag | null = appMode ? 'tachiapp' : null")
    expect(page).toContain('surfaceBindDecision({')
    // Archive BEFORE claiming — otherwise the outgoing session is filed under
    // the incoming surface's rail (same rule the two binds above follow).
    const own = page.slice(page.indexOf('const surfaceTag:'))
    const parkAt = own.indexOf('startNewSession()')
    const tagAt  = own.indexOf('setSessionTag(surfaceTag)')
    expect(parkAt).toBeGreaterThan(-1)
    expect(tagAt).toBeGreaterThan(parkAt)
  })

  it('never renders the foreign transcript while its run is in flight', () => {
    const page = read('pages/agent/AgentPage.tsx')
    // The transcript is swapped for a stable empty array, and the note explains
    // the wait — the mid-run session itself is left untouched.
    expect(page).toContain('messages={surfaceBlocked ? EMPTY_MESSAGES : messages}')
    expect(page).toContain('data-testid="surface-busy-note"')
    // …and no send can land in the other surface's session/workspace/history.
    expect(page).toContain('if (surfaceBlocked) return')
  })

  it('ships the TACHIAPP copy in every locale', () => {
    const LOCALES = path.resolve(__dirname, '../../src/i18n/locales')
    for (const lang of ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']) {
      const agent = JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'agent.json'), 'utf8'))
      expect(agent.appMode, `${lang}/agent.json appMode`).toBeTruthy()
      expect(agent.appMode.heroTitle).toBeTruthy()
      expect(agent.appMode.chips.featurePrompt).toBeTruthy()
      expect(agent.appMode.locate.action).toBeTruthy()
      // The surface hand-off note (shown while the OTHER surface's run holds
      // the live session) is user-visible copy too.
      expect(agent.surfaceBusy, `${lang}/agent.json surfaceBusy`).toBeTruthy()
      expect(agent.surfaceBusy.title).toBeTruthy()
      expect(agent.surfaceBusy.bodyCode).toBeTruthy()
      expect(agent.surfaceBusy.bodyApp).toBeTruthy()
      expect(agent.surfaceBusy.composerPlaceholder).toBeTruthy()
      const common = JSON.parse(fs.readFileSync(path.join(LOCALES, lang, 'common.json'), 'utf8'))
      expect(common.actions.tachiapp, `${lang}/common.json actions.tachiapp`).toBeTruthy()
      expect(common.actions.tachiappHint).toBeTruthy()
    }
  })
})
