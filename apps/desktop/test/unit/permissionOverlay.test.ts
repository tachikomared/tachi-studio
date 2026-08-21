// apps/desktop/test/unit/permissionOverlay.test.ts
//
// GLOBAL PERMISSION OVERLAY — the decision function + the wiring.
//
// THE BUG (dogfood-4, 2026-07-26). The permission queue has been app-lifetime
// store state since batch13, and the app-lifetime bridge fills it with no page
// mounted — but the CARDS were JSX inside AgentPage. TACHI raised an approval
// mid-run, the driver navigated off /tachiapp, and the card had no renderer
// anywhere: main sat awaiting its resolver for 5.5 minutes. Store state that
// nothing renders is as unreachable as component state that was thrown away.
//
// The overlay is EXCLUSIVE, not additive: two live PermissionCards for one
// request id would mean two ALLOW buttons for one resolver. So the interesting
// assertions are all about WHEN it renders — including the quieter case of
// /agent with the parallel grid up, where AgentPage replaces the whole log
// branch (and the inline card with it).

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  CODE_ROUTE, TACHIAPP_ROUTE,
  inlinePermissionRendererMounted,
  permissionOverlayVisible,
  pendingBySurface,
  routeForSurface,
} from '../../src/components/permissionOverlay'
import type { PermissionRequest } from '../../src/pages/agent/PermissionCard'

const card = (id: string, sessionId?: string): PermissionRequest => ({
  id,
  toolName: 'bash',
  toolInput: { command: 'pnpm run typecheck' },
  reason: 'Bash execution',
  recommendedDecision: 'allow',
  ...(sessionId ? { sessionId } : {}),
})

describe('inlinePermissionRendererMounted', () => {
  it('TACHIAPP always renders inline (it never enters grid mode)', () => {
    expect(inlinePermissionRendererMounted({ pathname: TACHIAPP_ROUTE, parallelTaskCount: 0 })).toBe(true)
    expect(inlinePermissionRendererMounted({ pathname: TACHIAPP_ROUTE, parallelTaskCount: 3 })).toBe(true)
  })

  it('CODE renders inline only while no parallel task exists', () => {
    expect(inlinePermissionRendererMounted({ pathname: CODE_ROUTE, parallelTaskCount: 0 })).toBe(true)
    // Grid mode replaces the whole log branch — no inline card there.
    expect(inlinePermissionRendererMounted({ pathname: CODE_ROUTE, parallelTaskCount: 1 })).toBe(false)
  })

  it('every other route has no inline renderer at all', () => {
    for (const p of ['/nodes', '/chat', '/design', '/settings', '/home', '/media']) {
      expect(inlinePermissionRendererMounted({ pathname: p, parallelTaskCount: 0 }), p).toBe(false)
    }
  })

  it('is segment-aware, not prefix-sloppy', () => {
    expect(inlinePermissionRendererMounted({ pathname: '/agent/x', parallelTaskCount: 0 })).toBe(true)
    // A different route that merely starts with the same letters is NOT /agent.
    expect(inlinePermissionRendererMounted({ pathname: '/agentx', parallelTaskCount: 0 })).toBe(false)
  })
})

describe('permissionOverlayVisible', () => {
  it('stays hidden with an empty queue, on every route', () => {
    for (const p of ['/nodes', CODE_ROUTE, TACHIAPP_ROUTE]) {
      expect(permissionOverlayVisible({ pathname: p, pendingCount: 0, parallelTaskCount: 0 }), p).toBe(false)
    }
  })

  it('renders off-surface — THE fix: /nodes now shows the blocked card', () => {
    expect(permissionOverlayVisible({ pathname: '/nodes', pendingCount: 1, parallelTaskCount: 0 })).toBe(true)
    expect(permissionOverlayVisible({ pathname: '/design', pendingCount: 2, parallelTaskCount: 0 })).toBe(true)
  })

  it('stays hidden where the inline card already renders (no double ALLOW)', () => {
    expect(permissionOverlayVisible({ pathname: CODE_ROUTE, pendingCount: 1, parallelTaskCount: 0 })).toBe(false)
    expect(permissionOverlayVisible({ pathname: TACHIAPP_ROUTE, pendingCount: 1, parallelTaskCount: 0 })).toBe(false)
  })

  it('DOES render on /agent while the parallel grid has replaced the log', () => {
    expect(permissionOverlayVisible({ pathname: CODE_ROUTE, pendingCount: 1, parallelTaskCount: 2 })).toBe(true)
  })
})

describe('pendingBySurface', () => {
  const live = { sessionId: 'sess-code', sessionTag: null as null, parallelSessionIds: ['sess-p1'] }

  it('splits by the owning run', () => {
    const got = pendingBySurface([card('a', 'sess-code'), card('b', 'sess-p1')], live)
    expect(got).toEqual({ code: 2, tachiapp: 0, unknown: 0, total: 2 })
  })

  it('attributes the live session to TACHIAPP when that surface owns it', () => {
    const got = pendingBySurface([card('a', 'sess-app')], {
      sessionId: 'sess-app', sessionTag: 'tachiapp', parallelSessionIds: [],
    })
    expect(got.tachiapp).toBe(1)
    expect(got.code).toBe(0)
  })

  it('keeps UNKNOWN separate — a badge on the wrong tile is worse than none', () => {
    // No session id at all (a card re-synced from an older main), and a session
    // that has already left the live slot.
    const got = pendingBySurface([card('a'), card('b', 'sess-gone')], live)
    expect(got).toEqual({ code: 0, tachiapp: 0, unknown: 2, total: 2 })
  })

  it('an empty queue is all zeros', () => {
    expect(pendingBySurface([], live)).toEqual({ code: 0, tachiapp: 0, unknown: 0, total: 0 })
  })
})

describe('routeForSurface', () => {
  it('sends the operator to the owning surface, defaulting to CODE', () => {
    expect(routeForSurface('tachiapp')).toBe(TACHIAPP_ROUTE)
    expect(routeForSurface('code')).toBe(CODE_ROUTE)
    expect(routeForSurface(null)).toBe(CODE_ROUTE)
  })
})

// The decision function is worth nothing if nothing mounts the host, or if the
// sidebar cue disagrees with it about ownership.
describe('overlay wiring', () => {
  const APP  = path.resolve(__dirname, '../..')
  const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')

  it('App.tsx mounts the host INSIDE the router, above the routes', () => {
    const app = read('src/app/App.tsx')
    expect(app).toContain("import { PermissionOverlayHost } from '../components/PermissionOverlayHost'")
    expect(app).toContain('<PermissionOverlayHost />')
    // It reads useLocation, so it must sit inside MemoryRouter and before
    // <Routes> — i.e. not nested in any Route element.
    const routerAt = app.indexOf('<MemoryRouter key="app"')
    const hostAt   = app.indexOf('<PermissionOverlayHost />')
    const routesAt = app.indexOf('<Routes>')
    expect(routerAt).toBeGreaterThan(-1)
    expect(hostAt).toBeGreaterThan(routerAt)
    expect(hostAt).toBeLessThan(routesAt)
  })

  it('the host answers the queue with the real IPC and settles the store', () => {
    const host = read('src/components/PermissionOverlayHost.tsx')
    expect(host).toContain('permissionOverlayVisible({')
    expect(host).toContain('settlePermission(id)')
    expect(host).toContain('window.tachi.agent.permissionResponse(id, decision)')
    // Oldest first with a counter — same rule as the inline surface, so nobody
    // approves out of arrival order.
    expect(host).toContain('activePermission(permissionQueue)')
    expect(host).toContain('queuedBehind(permissionQueue)')
    // Reuses the card rather than forking a second one.
    expect(host).toContain("import { PermissionCard } from '../pages/agent/PermissionCard'")
  })

  it('the sidebar dots come from the SAME splitter as the overlay', () => {
    const sidebar = read('src/components/layout/Sidebar.tsx')
    expect(sidebar).toContain("import { pendingBySurface } from '../permissionOverlay'")
    expect(sidebar).toContain('pendingApprovals.code > 0')
    expect(sidebar).toContain('pendingApprovals.tachiapp > 0')
    expect(sidebar).toContain('data-testid="sidebar-approval-dot"')
    // The dot must NOT be driven by the raw queue length: that would light CODE
    // for a card owned by TACHIAPP (or by nothing at all).
    expect(sidebar).not.toContain('permissionQueue.length > 0')
  })

  it('ships the overlay + badge copy in every locale', () => {
    for (const lang of ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']) {
      const agent = JSON.parse(read(`src/i18n/locales/${lang}/agent.json`))
      expect(agent.permission.overlay, `${lang}/agent.json permission.overlay`).toBeTruthy()
      for (const k of ['title', 'hint', 'goto', 'gotoHint']) {
        expect(agent.permission.overlay[k], `${lang} permission.overlay.${k}`).toBeTruthy()
      }
      const common = JSON.parse(read(`src/i18n/locales/${lang}/common.json`))
      expect(common.actions.approvalPending, `${lang}/common.json actions.approvalPending`).toBeTruthy()
      expect(common.actions.approvalPending).toContain('{{n}}')
    }
  })
})
