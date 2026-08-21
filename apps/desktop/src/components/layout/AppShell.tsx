import React, { useEffect, useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'
import { useResizablePanel } from '../../hooks/useResizablePanel'
import { ResizablePanelEdge } from './ResizablePanelEdge'
import { useGlobalShortcuts } from '../../hooks/useGlobalShortcuts'
import { CommandPalette } from '../CommandPalette'
import { ShortcutHelp } from '../ShortcutHelp'
import { ConsoleDock } from '../console/ConsoleDock'
import { Toaster, showToast } from '../Toaster'
import { ConfirmProvider } from '../ConfirmProvider'
import { WalletConfirmHost } from '../WalletConfirmHost'
import { TabTourHost } from '../TabTourHost'
import { useChatStore } from '../../store/chat.store'
import { useAgentStore } from '../../store/agent.store'
import { useNodesRunStore, nodesRunActive } from '../../store/nodesRun.store'
import { chassisRunActive } from '../opus/opusChrome.helpers'

export function AppShell() {
  useGlobalShortcuts()
  const navigate = useNavigate()
  const location = useLocation()
  const [paletteOpen, setPaletteOpen] = useState(false)
  // SCAN BAR SIGNAL — see the strip below. Three boolean selectors, so this
  // shell re-renders only when the answer FLIPS, never on a token or a step.
  const agentStatus = useAgentStore(s => s.status)
  const nodesRunning = useNodesRunStore(nodesRunActive)
  // BOTH chat ids, ORed — live-found: `streamingMessageId` is set only when the
  // PROVIDER's first chunk lands and cleared on done, so a short answer opened
  // and closed that window in ~0ms and the run bar never lit for a whole send.
  // `streamingConversationId` is armed at SEND (pages/chat/InputBar.tsx), which
  // is the same instant the chat's own WaitingIndicator starts, so the OR covers
  // the wait for first-token AND the stream itself. Still one boolean selector.
  const chatStreaming = useChatStore(s => s.streamingConversationId !== null || s.streamingMessageId !== null)
  const runActive = chassisRunActive({ agentStatus, nodesRunning, chatStreaming })
  // Resizable, persisted sidebar width (left-docked → drag the right edge to grow).
  const { width: sidebarWidth, onPointerDown: onSidebarResize, isDragging: sidebarDragging } = useResizablePanel({
    min: 200, max: 420, initial: 224, storageKey: 'tachi:sidebar-width', side: 'right',
  })

  useEffect(() => {
    const toggle = () => setPaletteOpen(o => !o)
    window.addEventListener('tachi:toggle-palette', toggle as EventListener)
    return () => window.removeEventListener('tachi:toggle-palette', toggle as EventListener)
  }, [])

  // ── IDLE GATE · the two :root signals the chassis sheets pause their motion on
  //
  // WINDOW FOCUS. Electron's `backgroundThrottling` only covers a page the
  // compositor has stopped showing — minimised or fully occluded. The owner runs
  // this app on a second monitor, where it is VISIBLE and UNFOCUSED for hours:
  // nothing throttles, so every infinite keyframe on the chassis (the LED iris
  // animates `box-shadow`, i.e. a full repaint of the LED rack) kept burning
  // frames for a screen nobody was looking at. This attribute is what the theme
  // sheets gate on — `:root:not([data-window-focused]) .tk-chassis * {
  // animation-play-state: paused }` — so the gate costs one attribute write per
  // alt-tab and nothing else.
  //
  // PRESENT OR ABSENT, NEVER "0". The rules are written as a `:not()`, so the
  // attribute has exactly two states and every environment that never fires a
  // `focus` event (a test DOM, a window launched into the background) degrades
  // to PAUSED — the safe direction. Cleanup removes it, so a shell unmount can
  // never strand the app in the focused state.
  useEffect(() => {
    const root = document.documentElement
    const onFocus = () => root.setAttribute('data-window-focused', '1')
    const onBlur = () => root.removeAttribute('data-window-focused')
    // SEED FROM THE TRUTH, not from an assumption: a window that opens behind
    // another one (autostart, a restore that lands in the back) never fires
    // `focus`, and a window that opens in front never fires it either — it was
    // already focused before this effect ran.
    let focused = true
    try { focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true } catch { focused = true }
    if (focused) onFocus(); else onBlur()
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      root.removeAttribute('data-window-focused')
    }
  }, [])

  // RUN-ACTIVE, MIRRORED ONTO :root. The scan-bar element below keeps its OWN
  // `data-run-active` stamp untouched — the OPUS-5 sweep rule reads it there
  // (`[data-scan-bar][data-run-active="1"]`, tachi-opus5-structure.css) and both
  // halves of that pair must stay byte-identical. What an element stamp cannot
  // do is gate a rule in a DIFFERENT subtree: the TK reticle is an `h1::after`
  // anywhere in the app, and it was animating on every heading forever. Mirrored
  // on the root, one boolean can gate motion anywhere the sheet can reach it
  // (`:root[data-run-active="1"] h1::after`). Same present-or-absent contract as
  // the focus attribute, and the same terminal guarantee `chassisRunActive`
  // already carries: 'done' / 'error' clear it, so nothing sweeps forever.
  useEffect(() => {
    const root = document.documentElement
    if (runActive) root.setAttribute('data-run-active', '1')
    else root.removeAttribute('data-run-active')
    return () => { root.removeAttribute('data-run-active') }
  }, [runActive])

  // Tray IPC: navigate to /chat (new conversation) when the user clicks "New Chat" in the tray menu.
  useEffect(() => {
    if (!window.tachi?.tray) return
    const off = window.tachi.tray.onNewChat(() => {
      const store = useChatStore.getState()
      const id = store.newConversation()
      store.setActive(id)
      navigate(`/chat/${id}`)
    })
    return off
  }, [navigate])

  // Tray IPC: navigate to /agent when the user clicks "Open Agent" in the tray menu.
  useEffect(() => {
    if (!window.tachi?.tray) return
    const off = window.tachi.tray.onOpenAgent(() => {
      navigate('/agent')
    })
    return off
  }, [navigate])

  // Auto-update: listen for update-status pushes and dispatch toasts.
  useEffect(() => {
    if (!window.tachi?.app?.onUpdateStatus) return
    const off = window.tachi.app.onUpdateStatus((status) => {
      if (status.state === 'available') {
        showToast({ kind: 'info', text: `Update available: v${status.version ?? '?'}`, ttl: 0 })
      } else if (status.state === 'ready') {
        showToast({ kind: 'success', text: `Update v${status.version ?? '?'} downloaded. Restart to install.`, ttl: 0 })
      }
    })
    return off
  }, [])

  // Receive a captured region from the main process. Create a new conversation,
  // attach the image as the user's first message, and route to /chat/:id.
  useEffect(() => {
    if (!window.tachi?.overlay) return
    const off = window.tachi.overlay.onCaptureDone(({ dataUrl }) => {
      if (!dataUrl) return
      const store = useChatStore.getState()
      const id = store.newConversation()
      store.setActive(id)
      store.renameConversation(id, 'Screen capture')
      store.addUserMessage(id, [
        { type: 'image', data: dataUrl, mimeType: 'image/png' },
      ])
      navigate(`/chat/${id}`)
      showToast({ kind: 'success', text: 'Captured region · sent to new chat' })
    })
    return off
  }, [navigate])

  // Quick-ask handoff (Ctrl+J in the launcher bar): seed a new conversation
  // with the turns already exchanged there, so follow-ups continue naturally
  // and the exchange lands in history/full-text search like any other chat.
  useEffect(() => {
    if (!window.tachi?.quickask?.onHandoff) return
    const off = window.tachi.quickask.onHandoff(({ turns }) => {
      if (!turns?.length) return
      const store = useChatStore.getState()
      // Provenance: the quick-ask bar always answers via the keyless local
      // router — seed the conversation with THAT provider, not the sticky
      // last-picked one (live-found: the seeded chat wore a [BANKR-GATEWAY]
      // badge on an answer Bankr never produced).
      const id = store.newConversation('freellmapi-local', 'auto')
      store.setActive(id)
      const firstUser = turns.find(x => x.role === 'user')?.content ?? 'Quick ask'
      store.renameConversation(id, firstUser.slice(0, 60))
      for (const turn of turns) {
        if (turn.role === 'user') store.addUserMessage(id, turn.content)
        else store.appendAssistantMedia(id, [{ type: 'text', text: turn.content }])
      }
      // Mirror to disk immediately — nothing streams here, so the usual
      // save-on-'done' path in App.tsx never fires for this conversation.
      const conv = useChatStore.getState().conversations.find(c => c.id === id)
      try { if (conv) window.tachi?.chat?.saveConversation?.(conv)?.catch(() => { /* best-effort */ }) } catch { /* non-electron env */ }
      navigate(`/chat/${id}`)
      showToast({ kind: 'success', text: 'Quick ask · continued in chat' })
    })
    return off
  }, [navigate])

  return (
    <ConfirmProvider>
      <WalletConfirmHost />
      <div className="app-body" style={{
        display: 'flex',
        flexDirection: 'column',
        // height lives in globals.css (.app-body) so the CRAB overflow effect
        // can shrink the plate to `100%` of an inset #root. Full-bleed 100vh
        // on every other theme.
        background: 'var(--bg-base)',
        color: 'var(--text-primary)',
        fontFamily: 'JetBrains Mono, monospace',
        overflow: 'hidden',
      }}>
        {/* Custom title bar (replaces Windows titleBarOverlay). 30px tall,
         *  fully drag-region except for the min/max/close buttons. */}
        <TitleBar />

        {/* HEADER SCAN BAR — the one element the chassis mock needs and the app
            never had (PATCH-01, "Not in this patch": a theme sheet cannot invent
            an element, so the sweep had nothing to attach to).

            IT PAINTS NOTHING BY ITSELF. Inline `background: transparent` is its
            guarantee of inertness on the six themes that carry no rule for it —
            and it is also why the OPUS-5 rule that DOES dress it needs
            `!important`: an inline shorthand resets background-image and
            outranks any normal author declaration (the same cascade note as
            GROUP A / GROUP O in tachi-opus5-structure.css).

            OUT OF FLOW, so it costs zero layout on every theme. Under a chassis
            theme globals.css makes `.app-body` `position: fixed`, so the strip
            pins to the top edge of the recessed PLATE — exactly where the mock
            draws it; with no chassis it resolves against the viewport, still
            invisible and still click-through.

            A LEAF, DELIBERATELY AND PERMANENTLY. The structure sheet animates
            it, and an element carrying an animation / transform / filter becomes
            the containing block for any `position: fixed` descendant — the trap
            that ate the maximized window keys. It contains nothing, so it never
            can; keep it childless. */}
        <div
          data-scan-bar=""
          data-run-active={runActive ? '1' : '0'}
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            pointerEvents: 'none',
            background: 'transparent',
          }}
        />

        {/* Main row: sidebar + content */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Sidebar: user-resizable width, persisted to localStorage. */}
          <div style={{
            width: sidebarWidth,
            flexShrink: 0,
            height: '100%',
            overflow: 'hidden',
            position: 'relative',
            transition: sidebarDragging ? 'none' : 'width 120ms cubic-bezier(0.2,0.8,0.2,1)',
          }}>
            <Sidebar />
            <ResizablePanelEdge side="right" onPointerDown={onSidebarResize} isDragging={sidebarDragging} />
          </div>

          {/* Main content: fills remaining space.
              Keyed by pathname so each route change remounts the wrapper and
              re-fires the .tachi-route-enter "drill-in" CSS animation. */}
          <div style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: 'var(--bg-base)',
          }}>
            <div
              key={location.pathname}
              className="tachi-route-enter"
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <Outlet />
            </div>
          </div>
        </div>

        {/* Console dock — collapsible bottom dock: Terminal / Agent Commands /
            Logs / Trace / Observability. Toggle with Ctrl+` ; collapsed by default. */}
        <ConsoleDock />

        {/* Global overlays */}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <ShortcutHelp />
        {/* First-visit walkthroughs for tabs whose pages are actively developed
            (Design, Catalog) — wired here, anchored to data-tour attributes. */}
        <TabTourHost />
        <Toaster />
      </div>
    </ConfirmProvider>
  )
}
