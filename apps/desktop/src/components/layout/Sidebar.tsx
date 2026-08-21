// apps/desktop/src/components/layout/Sidebar.tsx
import React from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useUIStore } from '../../store/ui.store'
import { useChatStore } from '../../store/chat.store'
import { useThemeStore } from '../../store/theme.store'
import { useRuntimeStore } from '../../store/runtime.store'
import { useAgentStore } from '../../store/agent.store'
import { usePrivacyStore } from '../../store/privacy.store'
import { useAeonStore } from '../../store/aeon.store'
import { useSwarmStore } from '../../store/swarm.store'
import { useCapabilityStore } from '../../store/capability.store'
import { useNookStore } from '../../store/nook.store'
import { useNodesRunStore, nodesRunActive } from '../../store/nodesRun.store'
import { useDesignStore } from '../../store/design.store'
import { useParallelAgentsStore } from '../../store/parallel-agents.store'
import { pendingBySurface } from '../permissionOverlay'
import { WalletWidget } from '../WalletWidget'
import { ChassisSidebarPanel } from '../ChassisSidebarPanel'
import type { WalletInfoView } from '../../types/electron'
import {
  sortByStatus,
  filterDisplayableRuntimes,
  resolveLaunchUrl,
  resolveInAppRoute,
  actionLabel,
  runtimeNote,
} from '../../pages/studio/runtime-display'
import { SUPPORTED_LOCALES, LOCALE_LABELS, setLocale, type Locale } from '../../i18n'
import { PRIMARY_TABS, MORE_TABS, activeSidebarTab, type TabId } from './sidebarActiveTab'
export type { TabId } from './sidebarActiveTab'

// Two-tier sidebar (UX Top-10 #4): the 11 flat tiles had zero hierarchy —
// AEON (GH-Actions plumbing) ranked equal to CHAT. Primary group = the five
// daily-driver surfaces; everything else lives in a collapsible MORE group
// below (collapsed by default, persisted via ui.store / localStorage).
// PRIVATE MODE Tier 4: 'inbox' stays in the PRIMARY group even though it's
// low-traffic — it only renders when private mode is on or approvals are
// pending, and burying a pending-permission badge inside a collapsed group
// would hide exactly the thing that needs attention.
// Nodes is its own tab (3rd); Media is 5th. Artifacts is no longer a top-level
// tab — it's a sub-tab inside Media (see MediaPage). PRIMARY_TABS/MORE_TABS
// (and the active-pill decision below) live in sidebarActiveTab.ts — a leaf
// module with zero store imports, so the route logic is unit-testable
// without dragging in this whole component.
// Route prefixes owned by the MORE tabs — used to force-expand the group when
// the user lands on one via CommandPalette / deep link (which navigate without
// touching ui.store's sidebarTab). Never hide the active tab.
const MORE_ROUTES = ['/swarm', '/studio', '/catalog', '/aeon', '/nook', '/learn'] as const
// Display labels where the tab id would mislead: the 'studio' tab is the
// system DASHBOARD (the app itself is Tachi Studio — collision, user call
// 2026-07-05). Ids stay stable for routes/stores/tours.
const TAB_LABELS: Partial<Record<TabId, string>> = { studio: 'dashboard' }

// Wallet chip (UX F20): the pinned wallet card is mostly zeros outside the
// transacting surfaces, so it collapses to a one-line chip by default. The
// expanded pref survives restarts — same plain-localStorage try/catch pattern
// as 'tachi:sidebar-more' (ui.store). Collapsed by default for new users.
const WALLET_LS_KEY = 'tachi:wallet-expanded'
function readWalletExpanded(): boolean {
  try { return localStorage.getItem(WALLET_LS_KEY) === '1' } catch { return false }
}
// Routes where money actually moves — the full card auto-expands there
// (mirrors the MORE-group force-open pattern) WITHOUT flipping the stored pref.
const WALLET_ROUTES = ['/nook', '/aeon'] as const

export function Sidebar() {
  const navigate = useNavigate()
  const location = useLocation()
  const { t, i18n } = useTranslation('common')
  const { sidebarTab, setSidebarTab, sidebarMoreExpanded, setSidebarMoreExpanded } = useUIStore()
  const privateMode = usePrivacyStore(s => s.mode === 'private')
  // Tab visibility rules:
  //   - aeon  : hidden in PRIVATE MODE (it uses GitHub Actions — cloud).
  //   - inbox : it's the PRIVATE-MODE permission-approval queue, so it's only
  //             shown when private mode is on OR there are pending requests.
  //             Outside private mode it's always empty, so hiding it declutters
  //             the bar for normal users (computed below once inboxPending exists).
  // Recents/Sessions used to live here; they now live in the dedicated
  // ChatHistory / AgentHistory page rails. Sidebar reads chat only for
  // newConversation() (the "+ New chat" button).
  const newConversation = useChatStore(s => s.newConversation)
  const { theme, setTheme } = useThemeStore()
  // Sort: running first, installed next, not_installed last. The filter also
  // drops what isn't on this machine at all — every 'cloud_gateway' card, plus
  // the named exceptions (Aeon has its own tab) — see runtime-display.ts.
  const rawCards = useRuntimeStore(s => s.cards)
  const cards = sortByStatus(filterDisplayableRuntimes(rawCards))
  const swarmRecents = useSwarmStore(s => s.recentRepos)
  // Design-tab session history (user ask 2026-07-03): the sidebar's design
  // section had dead space below the actions — surface the session list there,
  // same shape as the swarm Recent rail.
  const designSessions   = useDesignStore(s => s.sessions)
  const designActiveId   = useDesignStore(s => s.activeId)
  const loadDesignSession = useDesignStore(s => s.loadSession)
  const newDesignSession  = useDesignStore(s => s.newSession)
  // PRIVATE MODE Tier 4: unread badge on the inbox tab. We read `queue.length`
  // (filtered to pending) directly so the subscription is reactive — the
  // store's `unreadCount()` method is a non-reactive helper.
  const inboxPending = useCapabilityStore(s => s.queue.filter(r => r.status === 'pending').length)
  // App-wide indicator: canvas work keeps running even off the /nodes tab —
  // a "Run all" AND a single media node's own RUN, which used to light nothing
  // at all (the driver's 44-minute i2v render read as idle here while sd-cli
  // held the GPU). One shared selector so the dot and the chassis lamps can
  // never disagree; still a boolean, so this re-renders only when it flips.
  const nodesRunning = useNodesRunStore(nodesRunActive)
  // PENDING HARNESS APPROVALS (dogfood-4). A blocked run is invisible from
  // anywhere but the surface that owns it — the operator has no reason to
  // suspect the run they left ten minutes ago is parked on a card. The global
  // overlay makes the card reachable; these dots make the WAIT discoverable at a
  // glance, on the tile that owns it. Counts come from the shared pure splitter,
  // so the dot and the overlay can never disagree about ownership.
  const permissionQueue    = useAgentStore(s => s.permissionQueue)
  const agentSessionId     = useAgentStore(s => s.sessionId)
  const agentSessionTag    = useAgentStore(s => s.sessionTag)
  const parallelTaskMap    = useParallelAgentsStore(s => s.tasks)
  const pendingApprovals   = React.useMemo(() => pendingBySurface(permissionQueue, {
    sessionId:  agentSessionId,
    sessionTag: agentSessionTag,
    parallelSessionIds: [...parallelTaskMap.values()].map(tk => tk.sessionId).filter(Boolean) as string[],
  }), [permissionQueue, agentSessionId, agentSessionTag, parallelTaskMap])

  const tabVisible = (tab: TabId) => {
    if (tab === 'aeon' && privateMode) return false
    if (tab === 'inbox' && !privateMode && inboxPending === 0) return false
    return true
  }
  const primaryTabs = PRIMARY_TABS.filter(tabVisible)
  const moreTabs = MORE_TABS.filter(tabVisible)

  // MORE group open-state: the persisted user preference, ORed with
  // "the active surface lives inside the group" (route-based, because
  // CommandPalette / deep links navigate without setting sidebarTab).
  const routeInMore = MORE_ROUTES.some(r =>
    location.pathname === r || location.pathname.startsWith(`${r}/`))
  const activeInMore = routeInMore || (MORE_TABS as readonly string[]).includes(sidebarTab)
  const moreOpen = sidebarMoreExpanded || activeInMore

  // F20: wallet chip expand state. Stored pref (sticky) OR route-forced open
  // on the transacting surfaces (/nook, /aeon) — forcing never writes the pref.
  const [walletExpanded, setWalletExpandedRaw] = React.useState<boolean>(readWalletExpanded)
  const setWalletExpanded = (open: boolean) => {
    try { localStorage.setItem(WALLET_LS_KEY, open ? '1' : '0') } catch { /* storage unavailable */ }
    setWalletExpandedRaw(open)
  }
  const routeInWallet = WALLET_ROUTES.some(r =>
    location.pathname === r || location.pathname.startsWith(`${r}/`))
  // TACHIAPP is route-driven (it owns no sidebar tab id) — highlight the pinned
  // row whenever that surface is open.
  const tachiappActive = location.pathname === '/tachiapp'
  // Which primary/more tile (if any) gets the active pill — route wins over
  // the stale `sidebarTab` preference whenever the two disagree (see
  // `activeSidebarTab`). null on /tachiapp: tachiappActive above owns that row.
  const activeTab = activeSidebarTab(location.pathname, sidebarTab)
  const walletOpen = walletExpanded || routeInWallet
  // Short address for the collapsed chip only — the full card (WalletWidget)
  // keeps fetching its own info/balances exactly as before.
  const [walletAddr, setWalletAddr] = React.useState<string | null>(null)
  React.useEffect(() => {
    let cancelled = false
    window.tachi.wallet.getInfo()
      .then(i => { if (!cancelled) setWalletAddr(i?.address ?? null) })
      .catch(() => { if (!cancelled) setWalletAddr(null) })
    const off = window.tachi.wallet.onChanged((i: WalletInfoView) => setWalletAddr(i?.address ?? null))
    return () => { cancelled = true; off?.() }
  }, [])
  const walletShortAddr = walletAddr ? `${walletAddr.slice(0, 6)}…${walletAddr.slice(-4)}` : ''

  const primaryButtonStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '8px 12px',
    border: 'var(--border-width) solid var(--accent)',
    background: 'var(--accent)',
    color: '#ffffff',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    fontWeight: 700,
    cursor: 'pointer',
    textAlign: 'left',
    boxShadow: 'var(--shadow-hard)',
  }

  const secondaryLinkStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    padding: '6px 12px',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
    cursor: 'pointer',
    textAlign: 'left',
  }

  // One tile — used verbatim by BOTH tiers so the MORE group can't drift
  // visually from the primary row.
  const renderTab = (tab: TabId) => {
    const active = activeTab === tab
    return (
      <button
        key={tab}
        onClick={() => {
          setSidebarTab(tab)
          if (tab === 'chat') navigate('/chat')
          else if (tab === 'code') navigate('/agent')
          else if (tab === 'nodes') navigate('/nodes')
          else if (tab === 'design') navigate('/design')
          else if (tab === 'media') navigate('/media')
          else if (tab === 'swarm') navigate('/swarm')
          else if (tab === 'inbox') navigate('/inbox')
          else if (tab === 'aeon') navigate('/aeon')
          else if (tab === 'nook') navigate('/nook')
          else if (tab === 'catalog') navigate('/catalog')
          else if (tab === 'learn') navigate('/learn')
          else navigate('/studio')
        }}
        style={{
          flex: '1 1 56px',
          minWidth: 52,
          padding: '8px 4px',
          border: 'none',
          borderRight: 'var(--border-width) solid var(--border)',
          borderBottom: 'var(--border-width) solid var(--border)',
          background: active ? 'var(--accent-muted)' : 'transparent',
          color: active ? 'var(--accent-text)' : 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: active ? 700 : 400,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
        }}
      >
        <span>{TAB_LABELS[tab] ?? tab}</span>
        {tab === 'nodes' && nodesRunning && (
          <span
            aria-label="flow running"
            title="A Nodes flow is running"
            className="tachi-run-dot"
            style={{
              width: 7, height: 7, flexShrink: 0,
              background: 'var(--success)',
              border: '1px solid var(--bg-base)',
            }}
          />
        )}
        {tab === 'code' && pendingApprovals.code > 0 && (
          <PendingApprovalDot n={pendingApprovals.code} label={t('actions.approvalPending', { n: pendingApprovals.code, defaultValue: '{{n}} approval waiting — a run is blocked until you answer' })} />
        )}
        {tab === 'inbox' && inboxPending > 0 && (
          <span
            aria-label={`${inboxPending} pending`}
            style={{
              display: 'inline-block',
              minWidth: 14,
              padding: '0 4px',
              border: 'var(--border-width) solid var(--accent)',
              background: 'var(--accent)',
              color: '#ffffff',
              fontSize: 9,
              fontWeight: 700,
              lineHeight: '12px',
              textAlign: 'center',
            }}
          >
            {inboxPending > 99 ? '99+' : inboxPending}
          </span>
        )}
      </button>
    )
  }

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: 'var(--bg-sidebar)',
      borderRight: 'var(--border-width) solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'JetBrains Mono, monospace',
      overflow: 'hidden',
    }}>

      {/* Brand header — drag region for frameless window */}
      <div style={{
        padding: '12px 16px',
        borderBottom: 'var(--border-width) solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}>
        {/* Brand mark → Home. The header row stays a window-drag region, so the
            clickable part must opt out with no-drag. */}
        <button
          onClick={() => navigate('/home')}
          title="Home"
          style={{
            display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0,
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          <div style={{
            width: 20,
            height: 20,
            background: 'var(--accent)',
            border: 'var(--border-width) solid var(--border-strong)',
            flexShrink: 0,
          }} />
          <span style={{
            fontFamily: 'Space Grotesk, sans-serif',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            color: 'var(--text-primary)',
          }}>TACHI_STUDIO</span>
        </button>
        <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>v0.1</span>
      </div>

      {/* Tab switcher — two tiers. Primary row = the five daily drivers
          (+ inbox when it's relevant), wrapping into a readable grid. Below
          it a collapsible MORE group holds the power-user surfaces. Tiles
          are IDENTICAL in both tiers (same styles, same click semantics).
          Active tab uses a filled background, not a 1px underline, so it
          stays legible when wrapped. */}
      <div style={{ flexShrink: 0, borderBottom: 'var(--border-width) solid var(--border)' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {primaryTabs.map(renderTab)}
        </div>
        {/* MORE group header — same brutalist idiom as the section headers
            (JetBrains Mono, uppercase, 0.1em tracking). Toggles the persisted
            preference; while the active tab lives in the group the row stays
            force-open regardless (never hide the active tab). */}
        <button
          onClick={() => setSidebarMoreExpanded(!moreOpen)}
          aria-expanded={moreOpen}
          title={t('sidebar.moreHint', { defaultValue: 'More tabs — Swarm, Dashboard, Catalog, Aeon, Nook, Learn' })}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            padding: '6px 12px',
            border: 'none',
            borderBottom: moreOpen ? 'var(--border-width) solid var(--border)' : 'none',
            background: 'transparent',
            color: 'var(--text-dim)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <span>{moreOpen ? '▾' : '▸'}</span>
          <span>{t('sidebar.more', { defaultValue: 'More' })}</span>
        </button>
        {moreOpen && (
          <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            {moreTabs.map(renderTab)}
          </div>
        )}
      </div>

      <style>{`@keyframes tachi-run-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.25 } } .tachi-run-dot { animation: tachi-run-pulse 1s ease-in-out infinite }`}</style>

      {/* Actions block */}
      <div style={{ padding: '8px 0', borderBottom: 'var(--border-width) solid var(--border)', flexShrink: 0 }}>
        {sidebarTab === 'chat' && (
          <>
            <button
              style={primaryButtonStyle}
              onClick={() => {
                const id = newConversation()
                navigate('/chat')
              }}
            >
              {t('actions.newChat')}
            </button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/notebook')}>Notebook</button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings?tab=appearance')}>{t('actions.customize')}</button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings?tab=connections')}>{t('actions.providers')}</button>
          </>
        )}
        {sidebarTab === 'code' && (
          <>
            <button
              style={primaryButtonStyle}
              onClick={() => {
                // Reset the agent session: clear messages, abort any in-flight
                // task, drop the harness session id, and clear working dir.
                window.tachi.agent.abort().catch(() => {})
                useAgentStore.getState().reset()
                useAgentStore.getState().setWorkingDir(null)
                useAgentStore.getState().setSession(null)
                useAgentStore.getState().setStatus('idle')
                navigate('/agent')
              }}
            >
              {t('sidebar.newSession')}
            </button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings?tab=appearance')}>{t('actions.customize')}</button>
          </>
        )}
        {sidebarTab === 'nodes' && (
          <>
            <button
              style={primaryButtonStyle}
              onClick={() => navigate('/nodes')}
            >
              {t('sidebar.openCanvas')}
            </button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/media')}>{t('sidebar.media')}</button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings?tab=appearance')}>{t('actions.customize')}</button>
          </>
        )}
        {sidebarTab === 'design' && (
          <>
            <button style={primaryButtonStyle} onClick={() => { newDesignSession(); navigate('/design') }}>{t('sidebar.newDesign')}</button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings?tab=connections')}>{t('actions.providers')}</button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings?tab=appearance')}>{t('actions.customize')}</button>
          </>
        )}
        {sidebarTab === 'media' && (
          <>
            <button
              style={primaryButtonStyle}
              onClick={() => navigate('/media')}
            >
              {t('sidebar.newMedia')}
            </button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/artifacts')}>{t('sidebar.artifacts')}</button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings?tab=connections')}>{t('actions.providers')}</button>
          </>
        )}
        {sidebarTab === 'swarm' && (
          <>
            <button
              style={primaryButtonStyle}
              onClick={() => navigate('/swarm')}
            >
              {t('sidebar.newSwarm')}
            </button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings?tab=appearance')}>{t('actions.customize')}</button>
          </>
        )}
        {sidebarTab === 'inbox' && (
          <>
            <button
              style={primaryButtonStyle}
              onClick={() => navigate('/inbox')}
            >
              {t('sidebar.openInbox')}
            </button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings?tab=appearance')}>{t('actions.customize')}</button>
          </>
        )}
        {sidebarTab === 'studio' && (
          <>
            <button style={primaryButtonStyle} onClick={() => navigate('/nodes')}>{t('sidebar.llmNodes')}</button>
            <button style={secondaryLinkStyle} onClick={() => window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'info', text: t('sidebar.toasts.addRuntimeHint') } }))}>{t('sidebar.addRuntime')}</button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings')}>{t('sidebar.settings')}</button>
          </>
        )}
        {sidebarTab === 'aeon' && (
          <>
            <button
              style={primaryButtonStyle}
              onClick={() => {
                useAeonStore.getState().setView('home')
                navigate('/aeon')
              }}
            >{t('sidebar.runSkill')}</button>
            <button
              style={secondaryLinkStyle}
              onClick={() => {
                useAeonStore.getState().setView('home')
                navigate('/aeon')
              }}
            >{t('sidebar.configure')}</button>
            <button
              style={secondaryLinkStyle}
              onClick={() => {
                useAeonStore.getState().setView('home')
                navigate('/aeon')
              }}
            >{t('sidebar.secrets')}</button>
            {/* Opens Aeon's native Next.js dashboard (the one on localhost:5555
                from `./aeon`) as an iframed tab inside our app. */}
            <button
              style={secondaryLinkStyle}
              onClick={() => {
                useAeonStore.getState().setView('dashboard')
                navigate('/aeon')
              }}
            >{t('sidebar.dashboard')}</button>
          </>
        )}
        {sidebarTab === 'nook' && (
          <>
            <button
              style={primaryButtonStyle}
              onClick={() => { useNookStore.getState().setView('bounties'); navigate('/nook'); window.dispatchEvent(new CustomEvent('nook:post-bounty')) }}
            >{t('sidebar.postBounty')}</button>
            <button style={secondaryLinkStyle} onClick={() => { useNookStore.getState().setView('network'); navigate('/nook') }}>{t('sidebar.browseNetwork')}</button>
            <button style={secondaryLinkStyle} onClick={() => { useNookStore.getState().setView('mining'); navigate('/nook') }}>{t('sidebar.mineNook')}</button>
            <button style={secondaryLinkStyle} onClick={() => navigate('/settings')}>{t('sidebar.settings')}</button>
          </>
        )}

        {/* TACHIAPP — pinned self-improvement chat. Lives at the bottom of this
            nav group (the empty space under Notebook/Customize/Providers) and
            stays put on every tab: it is the one row that is always the same
            thing. No folder to choose — it resolves the app's own source. */}
        <button
          style={{
            ...secondaryLinkStyle,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            color: tachiappActive ? 'var(--accent)' : 'var(--text-muted)',
            fontWeight: tachiappActive ? 700 : 400,
          }}
          title={t('actions.tachiappHint', { defaultValue: 'Ask about this app or tell it what to change — it edits its own source' })}
          onClick={() => navigate('/tachiapp')}
        >
          <span style={{
            width: 6, height: 6, flexShrink: 0,
            background: tachiappActive ? 'var(--accent)' : 'var(--text-dim)',
          }} />
          <span>{t('actions.tachiapp', { defaultValue: 'TACHIAPP' })}</span>
          {pendingApprovals.tachiapp > 0 && (
            <PendingApprovalDot n={pendingApprovals.tachiapp} label={t('actions.approvalPending', { n: pendingApprovals.tachiapp, defaultValue: '{{n}} approval waiting — a run is blocked until you answer' })} />
          )}
        </button>
      </div>

      {/* Recents / List (scrollable) */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/*
          History lives in the dedicated page rails — ChatHistory (in /chat)
          and AgentHistory (in /agent) — instead of being duplicated here.
          Each page rail has search/rename/delete/export the Sidebar lacked
          and renders the correct data shape (chat conversations vs agent
          sessions) for the active tab.
        */}

        {sidebarTab === 'design' && (
          <>
            <div style={{
              padding: '8px 12px 4px',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}>
              {t('sidebar.recentDesigns')}
            </div>
            {designSessions.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-dim)' }}>
                {t('sidebar.noRecentDesigns')}
              </div>
            )}
            {[...designSessions]
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 15)
              .map((sess) => {
                const isActive = sess.id === designActiveId
                return (
                  <button
                    key={sess.id}
                    onClick={() => { loadDesignSession(sess.id); navigate('/design') }}
                    title={sess.title || t('sidebar.untitledDesign')}
                    style={{
                      display:    'block',
                      width:      '100%',
                      textAlign:  'left',
                      padding:    '4px 12px',
                      border:     'none',
                      background: isActive ? 'var(--bg-elevated)' : 'transparent',
                      color:      isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize:   11,
                      cursor:     'pointer',
                      overflow:   'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {sess.title || t('sidebar.untitledDesign')}
                  </button>
                )
              })}
          </>
        )}

        {sidebarTab === 'swarm' && (
          <>
            <div style={{
              padding: '8px 12px 4px',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}>
              {t('sidebar.recent')}
            </div>
            {swarmRecents.length === 0 && (
              <div style={{
                padding: '8px 12px',
                fontSize: 11,
                color: 'var(--text-dim)',
              }}>
                {t('sidebar.noRecentSwarms')}
              </div>
            )}
            {swarmRecents.map((repo) => (
              <button
                key={repo}
                onClick={() => navigate(`/swarm/${encodeURIComponent(repo)}`)}
                title={repo}
                style={{
                  display:    'block',
                  width:      '100%',
                  textAlign:  'left',
                  padding:    '4px 12px',
                  border:     'none',
                  background: 'transparent',
                  color:      'var(--text-muted)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize:   11,
                  cursor:     'pointer',
                  overflow:   'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {repo}
              </button>
            ))}
          </>
        )}

        {sidebarTab === 'studio' && (
          <>
            <div style={{
              padding: '8px 12px 4px',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}>
              Running Now
            </div>
            {cards.length === 0 && (
              <div style={{
                padding: '8px 12px',
                fontSize: 11,
                color: 'var(--text-dim)',
              }}>
                Nothing detected on this machine
              </div>
            )}
            {cards.map(card => {
              const isRunning = card.status === 'running' || card.status === 'healthy' || card.status === 'connected'
              const isBusy = card.status === 'error' || card.status === 'unreachable'
              const dotColor = isRunning ? 'var(--success)' : isBusy ? 'var(--destructive)' : 'var(--text-dim)'
              const notInstalled = card.status === 'not_installed'
              // Resolve the URL we'd open for this row (live endpoint when running,
              // otherwise the per-runtime launch target — dashboard, docs, vscode://).
              const launchUrl = resolveLaunchUrl(card)
              const btnLabel  = actionLabel(card)
              // The detector's reason for this status, when it set one (e.g.
              // Bankr's degraded→'unknown' card explains itself instead of
              // just sitting there grey). Colored the same as the dot: dim
              // for the neutral 'unknown' case, red for a genuine error card.
              const note = runtimeNote(card)

              return (
                <div
                  key={card.runtimeId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 12px',
                    flexShrink: 0,
                  }}
                >
                  {/* Status dot */}
                  <div style={{
                    width: 6,
                    height: 6,
                    background: dotColor,
                    flexShrink: 0,
                  }} />
                  {/* Runtime name (+ optional status note below it) */}
                  <div style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 1,
                  }}>
                    <span style={{
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      fontFamily: 'JetBrains Mono, monospace',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {card.displayName ?? card.runtimeId}
                    </span>
                    {note && (
                      <span title={note} style={{
                        fontSize: 9,
                        color: dotColor,
                        fontFamily: 'JetBrains Mono, monospace',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {note}
                      </span>
                    )}
                  </div>
                  {/* Action link — one consistent rule:
                   *  1. if the runtime has an in-app dashboard view (openclaw),
                   *     navigate to it instead of dumping the user into a browser
                   *  2. otherwise external-open the launch URL via shell allowlist
                   *  3. otherwise show a "no launch target" hint */}
                  <button
                    onClick={() => {
                      const inAppRoute = resolveInAppRoute(card)
                      if (inAppRoute) {
                        navigate(inAppRoute)
                      } else if (launchUrl) {
                        window.tachi.shell.openExternal(launchUrl)
                      } else if (notInstalled) {
                        window.dispatchEvent(new CustomEvent('tachi:toast', {
                          detail: { kind: 'info', text: `${card.displayName ?? card.runtimeId} not installed — install it then click Rescan in Dashboard.` },
                        }))
                      } else {
                        window.dispatchEvent(new CustomEvent('tachi:toast', {
                          detail: { kind: 'info', text: `${card.displayName ?? card.runtimeId}: no launch target wired up yet.` },
                        }))
                      }
                    }}
                    title={launchUrl ?? undefined}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 10,
                      cursor: 'pointer',
                      padding: 0,
                      color: launchUrl ? 'var(--accent)' : (isBusy ? 'var(--destructive)' : 'var(--text-muted)'),
                      flexShrink: 0,
                    }}
                  >
                    {btnLabel}
                  </button>
                </div>
              )
            })}
          </>
        )}

        {sidebarTab === 'aeon' && (
          <>
            <div style={{
              padding: '8px 12px 4px',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}>
              GitHub Actions
            </div>
          </>
        )}
        {sidebarTab === 'nook' && (
          <>
            <div style={{
              padding: '8px 12px 4px',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.1em',
              color: 'var(--text-dim)',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}>
              Network
            </div>
            <div style={{
              padding: '4px 12px',
              fontSize: 11,
              color: 'var(--text-dim)',
              fontFamily: 'JetBrains Mono, monospace',
            }}>
              Base · gasless
            </div>
          </>
        )}
      </div>

      {/* App-wide wallet (Base) — UX F20. Default = one-line chip
          [▪ WALLET 0x1234…abcd]; click toggles the full card. The card JSX
          itself is untouched (WalletWidget renders exactly as before). /nook
          and /aeon force-expand (money moves there) via walletOpen — same
          idiom as the MORE tab-group header above. */}
      <div style={{ borderTop: 'var(--border-width) solid var(--border)', flexShrink: 0 }}>
        <button
          onClick={() => setWalletExpanded(!walletOpen)}
          aria-expanded={walletOpen}
          title={walletOpen
            ? t('sidebar.walletCollapse', { defaultValue: 'Hide wallet balances' })
            : t('sidebar.walletExpand', { defaultValue: 'Show wallet balances' })}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            width: '100%',
            padding: '6px 12px',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-dim)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <span>{walletOpen ? '▾' : '▸'}</span>
          <span style={{ width: 7, height: 7, background: 'var(--accent)', flexShrink: 0 }} />
          <span style={{ color: 'var(--text-primary)' }}>{t('sidebar.wallet', { defaultValue: 'Wallet' })}</span>
          {!walletOpen && walletShortAddr && (
            <span style={{
              marginLeft: 'auto',
              fontSize: 9,
              letterSpacing: 0,
              textTransform: 'none',
              color: 'var(--text-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>{walletShortAddr}</span>
          )}
        </button>
        {walletOpen && <WalletWidget />}
      </div>

      {/* CHASSIS THEMES ONLY — UNIT TELEMETRY (tachikoma-red) / CHASSIS MAP
          (tachi-opus5). Renders null on the other themes, so their sidebar is
          unchanged. Rendered here rather than floated over the sidebar from the
          chrome components: the sidebar is drag-resizable and scrolls, and a
          fixed overlay would have to guess both — see the component header. */}
      <ChassisSidebarPanel />

      {/* Theme toggle footer — a 4x2 GRID, not a flex row. Six chips in one flex
          row at the 224px default sidebar width give each ~26px (unreadable),
          and a wrapping row gives a ragged last line with the orphan stretched
          full width. Four fixed columns keep every chip the same size, and the
          ⋯ overflow into Settings → Appearance SPANS THE LAST TWO cells, so six
          chips + one wide overflow still fill the 4x2 rectangle exactly with no
          hole (it used to be seven chips + a 1-wide ⋯ until `tachi-crab` was
          retired). Imported themes live in Settings, not here. 9px type is what
          makes 5-char labels fit. */}
      <div style={{
        padding: '10px 13px',
        borderTop: 'var(--border-width) solid var(--border)',
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 5,
        flexShrink: 0,
      }}>
        {([['dark', 'tachi-dark'], ['light', 'bankr'], ['neon', 'tachi-neon'],
           ['comic', 'comic'],
           ['opus5', 'tachi-opus5'], ['tk05', 'tachikoma-red']] as const).map(([key, themeId]) => (
          <button
            key={themeId}
            onClick={() => setTheme(themeId)}
            style={{
              padding: '6px 0',
              border: 'var(--border-width) solid var(--border-strong)',
              background: theme === themeId ? 'var(--accent-muted)' : 'var(--bg-elevated)',
              color: theme === themeId ? 'var(--accent-text)' : 'var(--text-muted)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              fontWeight: theme === themeId ? 700 : 400,
              cursor: 'pointer',
              letterSpacing: '0.06em',
            }}
          >
            {t(`theme.${key}`)}
          </button>
        ))}
        {/* LAST cell — ghost overflow to the full theme gallery. Spans the two
            remaining columns so the 4x2 block stays a solid rectangle. */}
        <button
          onClick={() => navigate('/settings?tab=appearance')}
          title={t('theme.moreHint', { defaultValue: 'All themes — Settings → Appearance' })}
          aria-label={t('theme.moreHint', { defaultValue: 'All themes — Settings → Appearance' })}
          style={{
            gridColumn: 'span 2',
            padding: '6px 0',
            border: 'var(--border-width) solid var(--border)',
            background: 'transparent',
            color: 'var(--text-dim)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 9,
            cursor: 'pointer',
            letterSpacing: '0.06em',
          }}
        >
          ⋯
        </button>
      </div>

      {/* Language switcher — soft-standard locales + Russian (lazy-loaded, EN fallback) */}
      <div style={{
        padding: '10px 16px',
        borderTop: 'var(--border-width) solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t('language')}</span>
        <select
          value={(i18n.resolvedLanguage ?? i18n.language) as string}
          onChange={(e) => setLocale(e.target.value as Locale)}
          style={{
            flex: 1,
            padding: '5px 6px',
            background: 'var(--bg-elevated)',
            border: 'var(--border-width) solid var(--border-strong)',
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            cursor: 'pointer',
          }}
        >
          {SUPPORTED_LOCALES.map(loc => (
            <option key={loc} value={loc}>{LOCALE_LABELS[loc]}</option>
          ))}
        </select>
        {/* LEARN moved into the MORE group (two-tier sidebar) — this compact
            [?] keeps a persistent, always-visible path to it. Same navigation
            semantics as the LEARN tile. */}
        <button
          onClick={() => { setSidebarTab('learn'); navigate('/learn') }}
          title={t('sidebar.learnHint', { defaultValue: 'Learn — short walkthrough of every tab' })}
          aria-label={t('sidebar.learnHint', { defaultValue: 'Learn — short walkthrough of every tab' })}
          style={{
            width: 26,
            height: 26,
            flexShrink: 0,
            border: 'var(--border-width) solid var(--border-strong)',
            background: sidebarTab === 'learn' ? 'var(--accent-muted)' : 'var(--bg-elevated)',
            color: sidebarTab === 'learn' ? 'var(--accent-text)' : 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          ?
        </button>
      </div>
    </div>
  )
}

// ── PendingApprovalDot ────────────────────────────────────────────────────────
//
// Amber dot + count for a surface whose harness run is BLOCKED on a permission
// card. Amber (not the accent, not success) on purpose: it is the exact colour
// PermissionCard's border uses, so the sidebar cue and the card the operator
// lands on read as one thing.
//
// Rendered only for a surface with a KNOWN owning run (see `pendingBySurface`):
// a badge on the wrong tile sends the operator somewhere with nothing to
// approve. Cards whose owner cannot be determined are covered by the global
// overlay instead, which needs no ownership at all.
function PendingApprovalDot({ n, label }: { n: number; label: string }) {
  return (
    <span
      data-testid="sidebar-approval-dot"
      title={label}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        flexShrink: 0,
        color: 'var(--warning)',
        fontSize: 9,
        fontWeight: 800,
        lineHeight: 1,
      }}
    >
      <span
        className="tachi-run-dot"
        style={{
          width: 7, height: 7, flexShrink: 0,
          background: 'var(--warning)',
          border: '1px solid var(--bg-base)',
        }}
      />
      {n > 1 ? (n > 9 ? '9+' : n) : ''}
    </span>
  )
}
