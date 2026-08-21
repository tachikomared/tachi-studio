// apps/desktop/src/app/App.tsx
import React, { useEffect, useState, lazy, Suspense } from 'react'
import { ChatChunk } from '@tachi/core'
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { OnboardingWizard } from '../pages/onboarding/OnboardingWizard'
import { HomePage } from '../pages/home/HomePage'
import { ChatPage } from '../pages/chat/ChatPage'
import { useChatStore } from '../store/chat.store'
import { startAgentEventBridge } from '../store/agentEventBridge'
import { initTheme } from '../store/theme.store'
import { useMemoryStore } from '../store/memory.store'
import { usePrivacyStore } from '../store/privacy.store'
import { usePiperTts } from '../hooks/usePiperTts'
import { OverlayWindow } from '../pages/overlay/OverlayWindow'
import { QuickAskWindow } from './QuickAskWindow'
import { AppControlBridge } from '../components/AppControlBridge'
import { FirstLaunchGate } from '../components/FirstLaunchGate'
import { TachikomaChrome } from '../components/TachikomaChrome'
import { OpusChrome } from '../components/OpusChrome'
import { PermissionOverlayHost } from '../components/PermissionOverlayHost'

const AgentPage    = lazy(() => import('../pages/agent/AgentPage').then(m => ({ default: m.AgentPage })))
const SettingsPage = lazy(() => import('../pages/settings/SettingsPage').then(m => ({ default: m.SettingsPage })))
const StudioPage   = lazy(() => import('../pages/studio/StudioPage').then(m => ({ default: m.StudioPage })))
const AeonPage     = lazy(() => import('../pages/aeon/AeonPage').then(m => ({ default: m.AeonPage })))
// /workflows was a non-executing legacy stub — its route now redirects to
// /nodes (the real graph runtime). The component file is kept but unrouted.
const NodesPage    = lazy(() => import('../pages/nodes/NodesPage').then(m => ({ default: m.NodesPage })))
const DesignPage   = lazy(() => import('../pages/design/DesignPage').then(m => ({ default: m.DesignPage })))
// Media + Artifacts share one tab now: MediaTabbed hosts a [Generate | Artifacts]
// sub-tab strip. /media opens Generate; /artifacts opens the Artifacts sub-tab.
const MediaTabbed  = lazy(() => import('../pages/media/MediaTabbed').then(m => ({ default: m.MediaTabbed })))
const OpenClawDashboardView = lazy(() =>
  import('../pages/openclaw/OpenClawDashboardView').then(m => ({ default: m.OpenClawDashboardView })))
const FreellmapiDashboardView = lazy(() =>
  import('../pages/freellmapi/FreellmapiDashboardView').then(m => ({ default: m.FreellmapiDashboardView })))
const SwarmPage    = lazy(() => import('../pages/swarm/SwarmPage').then(m => ({ default: m.SwarmPage })))
// PRIVATE MODE Tier 4 — silent inbox for agent tool-permission requests.
const InboxView    = lazy(() => import('../pages/inbox/InboxView').then(m => ({ default: m.InboxView })))
const NookPage     = lazy(() => import('../pages/nook/NookPage').then(m => ({ default: m.NookPage })))
const WalletPage   = lazy(() => import('../pages/wallet/WalletPage').then(m => ({ default: m.WalletPage })))
const LearnPage    = lazy(() => import('../pages/learn/LearnPage').then(m => ({ default: m.LearnPage })))
const CatalogPage  = lazy(() => import('../pages/catalog/CatalogPage').then(m => ({ default: m.CatalogPage })))
const NotebookPage = lazy(() => import('../pages/notebook/NotebookPage').then(m => ({ default: m.NotebookPage })))

const LazyFallback = (
  <div style={{
    padding: 24,
    color: 'var(--text-muted)',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11,
  }}>
    loading…
  </div>
)

// Overlay mode short-circuits everything: the screen-capture BrowserWindow
// loads index.html#overlay and only ever renders the marquee selector.
const IS_OVERLAY = typeof window !== 'undefined' && window.location.hash === '#overlay'
// Same trick for the global quick-ask launcher window (#quickask).
const IS_QUICKASK = typeof window !== 'undefined' && window.location.hash === '#quickask'

export function App() {
  if (IS_OVERLAY) return <OverlayWindow />
  if (IS_QUICKASK) return <QuickAskWindow />
  return <MainApp />
}

function MainApp() {
  const [ready, setReady]         = useState(false)
  const [onboarded, setOnboarded] = useState(false)
  const [initialRoute, setInitialRoute] = useState('/home')
  // Chunked LLM->TTS: stable callbacks fed from the chat onChunk stream below.
  const { feedDelta, finalizeTts } = usePiperTts()

  // AGENT STREAMS ARE APP-LIFETIME, not route-lifetime. They used to be
  // subscribed from inside AgentPage, so leaving /agent for any other tab
  // unsubscribed them and every subsequent event — tool-calls, `done`, the
  // timeout `error` — was dropped: the run looked like it was still WORKING
  // forever. Bound here instead, once, and never torn down (the bridge itself
  // is idempotent, so StrictMode's double-invoke cannot double-subscribe).
  // Runs before `ready`/`onboarded` on purpose: a resumed run must not have to
  // wait for settings to load. This one call covers the PARALLEL-TASK stream
  // too (same bug, same page, same fix — see startParallelEventBridge).
  useEffect(() => { startAgentEventBridge() }, [])

  useEffect(() => {
    window.tachi.settings.load()
      .then(s => {
        initTheme(s.theme)
        useMemoryStore.getState().setUserMemory(s.userMemory ?? '')
        // T16: load the structured fact list (migrates the legacy blob on first
        // access in main). Best-effort — a failure just leaves the badge off.
        window.tachi.memoryFacts.list()
          .then(facts => useMemoryStore.getState().setFacts(facts))
          .catch(() => { /* memory badge stays off; fact manager still loads on open */ })
        usePrivacyStore.getState().setMode(s.strictPrivacyMode ? 'private' : 'open')
        setOnboarded(Boolean(s.onboardingComplete))
        setReady(true)
      })
      .catch(() => {
        initTheme('tachi-dark')
        setReady(true)
      })
  }, [])

  useEffect(() => {
    if (!onboarded) return
    const off = window.tachi.chat.onChunk((chunk: ChatChunk) => {
      const conv = useChatStore.getState().appendChunk(chunk)
      if (chunk.type === 'delta') {
        feedDelta(chunk.text, chunk.messageId)
      } else if (chunk.type === 'done') {
        finalizeTts(chunk.messageId)
        if (conv) {
          window.tachi.chat.saveConversation(conv).catch(err => {
            console.warn('[chat] save-conversation failed:', err)
          })
        }
      }
    })
    return off
  }, [onboarded, feedDelta, finalizeTts])

  if (!ready) return <div style={{ background: 'var(--bg-base)', height: '100vh' }} />

  if (!onboarded) {
    return (
      // key: this router and the main app router below are the SAME element
      // type at the same tree position — without distinct keys React KEEPS the
      // wizard-era router instance across the onboarded flip, and since
      // MemoryRouter only reads initialEntries at construction, the finish
      // route ('/catalog' for RUN LOCAL) was silently ignored → users landed
      // on Home. Distinct keys force a fresh router with the right entry.
      <MemoryRouter key="onboarding">
        <OnboardingWizard
          onComplete={(route) => {
            if (route) setInitialRoute(route)
            setOnboarded(true)
          }}
        />
      </MemoryRouter>
    )
  }

  return (
    <MemoryRouter key="app" initialEntries={[initialRoute]}>
      <AppControlBridge />
      {/* One-time first-launch LEARN landing (fresh installs only). Renders
          nothing; may redirect to /learn once + show the welcome hero. */}
      <FirstLaunchGate />
      {/* TACHIKOMA-RED theme: the TK-05 chassis the app is recessed into —
          milled slab, window keys, LED rack, vents (renders null on every other
          theme; restages inward on narrow windows, never hides). */}
      <TachikomaChrome />
      {/* OPUS-5 theme: the CHASSIS REV 5 instrument frame — chartreuse
          perimeter, rail rulers, numbered compartments, in-frame window keys and
          the crab engraving inside the stage (renders null on every other theme;
          shares the recess mechanism with the TK-05 chassis above). */}
      <OpusChrome />
      {/* PENDING APPROVALS ARE APP-LIFETIME, not route-lifetime. The queue has
          lived in the store since batch13, but the CARDS were JSX inside
          AgentPage — so navigating off /tachiapp mid-run left a pending approval
          with no renderer and main blocked on its resolver for 5.5 minutes
          (dogfood-4). This host is mounted above the routes and renders the cards
          on every OTHER route; it stays silent wherever AgentPage renders them
          inline, so one request never gets two ALLOW buttons. Inside the router:
          it reads the location to make that call. */}
      <PermissionOverlayHost />
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/home"     element={<HomePage />} />
          <Route path="/chat"     element={<ChatPage />} />
          <Route path="/chat/:id" element={<ChatPage />} />
          <Route path="/agent"    element={<Suspense fallback={LazyFallback}><AgentPage key="code" /></Suspense>} />
          {/* TACHIAPP — the same agent surface pinned to this app's own source
              (no folder picker, ever). Distinct key so switching between the
              two routes remounts instead of re-using the other preset's state. */}
          <Route path="/tachiapp" element={<Suspense fallback={LazyFallback}><AgentPage key="tachiapp" appMode /></Suspense>} />
          <Route path="/workflows" element={<Navigate to="/nodes" replace />} />
          <Route path="/nodes"     element={<Suspense fallback={LazyFallback}><NodesPage /></Suspense>} />
          <Route path="/design"    element={<Suspense fallback={LazyFallback}><DesignPage /></Suspense>} />
          <Route path="/media"      element={<Suspense fallback={LazyFallback}><MediaTabbed /></Suspense>} />
          <Route path="/artifacts"  element={<Suspense fallback={LazyFallback}><MediaTabbed initialTab="artifacts" /></Suspense>} />
          <Route path="/openclaw"    element={<Suspense fallback={LazyFallback}><OpenClawDashboardView /></Suspense>} />
          <Route path="/freellmapi" element={<Suspense fallback={LazyFallback}><FreellmapiDashboardView /></Suspense>} />
          <Route path="/studio"   element={<Suspense fallback={LazyFallback}><StudioPage /></Suspense>} />
          <Route path="/aeon"     element={<Suspense fallback={LazyFallback}><AeonPage /></Suspense>} />
          <Route path="/swarm"             element={<Suspense fallback={LazyFallback}><SwarmPage /></Suspense>} />
          <Route path="/swarm/:repoPath"   element={<Suspense fallback={LazyFallback}><SwarmPage /></Suspense>} />
          <Route path="/inbox"             element={<Suspense fallback={LazyFallback}><InboxView /></Suspense>} />
          <Route path="/nook"   element={<Suspense fallback={LazyFallback}><NookPage /></Suspense>} />
          <Route path="/wallet" element={<Suspense fallback={LazyFallback}><WalletPage /></Suspense>} />
          <Route path="/learn"             element={<Suspense fallback={LazyFallback}><LearnPage /></Suspense>} />
          <Route path="/catalog"           element={<Suspense fallback={LazyFallback}><CatalogPage /></Suspense>} />
          <Route path="/notebook"          element={<Suspense fallback={LazyFallback}><NotebookPage /></Suspense>} />
          <Route path="/status"   element={<Navigate to="/studio" replace />} />
          <Route path="/runtime-hub" element={<Navigate to="/studio" replace />} />
          <Route path="/settings" element={<Suspense fallback={LazyFallback}><SettingsPage /></Suspense>} />
          <Route path="*"         element={<Navigate to="/home" />} />
        </Route>
      </Routes>
    </MemoryRouter>
  )
}
