// apps/desktop/src/components/ChassisSidebarPanel.tsx
//
// The one piece of chassis dressing that lives INSIDE the app: a small themed
// panel at the foot of the sidebar. Renders null on every theme except the two
// chassis themes, so every other theme's sidebar is byte-identical.
//
//   tachikoma-red → UNIT TELEMETRY. Instrument rows, every one of them a real
//                   reading of this process (CTX / MEM / SPEND).
//   tachi-opus5   → CHASSIS MAP. Three bay cells (NAV / RAIL / STAGE): the one
//                   the operator is working in is lit, and each cell is a
//                   BUTTON that jumps back to that bay's last surface.
//
// WHY IT IS RENDERED FROM Sidebar.tsx AND NOT AS A FIXED OVERLAY FROM THE CHROME
// COMPONENTS. The brief offered both. A `position: fixed` block floated over the
// sidebar would have to guess three things the sidebar owns and can change at
// runtime — its width (it is drag-resizable, see ResizablePanelEdge), its scroll
// position, and where its own footer blocks end — and getting any of them wrong
// paints decoration over live navigation, which is the exact class of defect the
// chrome components are written to avoid (their rule 3). Rendered here it is one
// import plus one gated element: it FLOWS with the sidebar, it cannot overlap a
// tile, it disappears with the sidebar, and it costs the other six themes a
// single `return null`.
//
// ── HONESTY RULES (v2, 2026-07-27) ──────────────────────────────────────────
// v1 shipped two INVENTED needles (SERVO 62, OPTIC 84 — fixed numbers behind a
// "decorative chassis readout" tooltip). A disclaimer nobody hovers does not
// make a fake instrument honest: the panel still read, at a glance, as four
// live measurements when only one was. The rule now has no decorative branch:
//
//   1. EVERY ROW IS A REAL READING or it is not rendered. There is no third
//      state — no placeholder, no "—", no dimmed fake.
//   2. A ROW THAT CANNOT BE MEASURED DISAPPEARS. `performance.memory` is a
//      Chromium extra (absent in tests and in any non-Chromium host) and the
//      cost ledger only has a percentage to report once a budget cap is set;
//      in both cases the row is omitted rather than zeroed. The panel is
//      allowed to be short. It is not allowed to make something up.
//   3. THE MAP CELLS ARE CONTROLS, AND SAY SO. The lit cell is the router's
//      answer (`opusActiveBay`) — the SAME call OpusChrome's flank stencils
//      make, which is why this stays route-derived rather than switching to
//      DOM focus: the frame's bay ticks would then contradict the map three
//      inches to their right, and the frame is not this lane's to change.
//      Clicking a cell navigates to that bay's last-visited surface, so the
//      map is a three-slot workspace switcher instead of a picture of one.
//
// Legends here are the same diegetic hardware markings as the frames (UNIT
// TELEMETRY, CHASSIS MAP, bay numbers, the three-letter row names) and are
// deliberately NOT i18n keys — see the header of TachikomaChrome.tsx for the
// full reasoning. The tooltips are kept to formatted READOUTS (numbers, units,
// route paths) for the same reason: an instrument's face is not prose.
import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useThemeStore } from '../store/theme.store'
import { useAgentStore, getContextZone, useAgentContextWindow } from '../store/agent.store'
import { contextSourceNote } from '../store/modelWindow.store'
import { TK_THEME } from './tachikoma/tachikomaChrome.helpers'
import { OPUS_THEME, opusActiveBay, type OpusBay } from './opus/opusChrome.helpers'
import { useVisibilityGatedInterval } from '../hooks/useVisibilityGatedInterval'

const MONO = 'JetBrains Mono, monospace'

const CAPTION: React.CSSProperties = {
  fontFamily: MONO,
  fontSize: 8,
  lineHeight: 1,
  letterSpacing: '0.18em',
  color: 'var(--text-dim)',
  whiteSpace: 'nowrap',
}

/** How often the heap row re-reads `performance.memory`. Two seconds: the
 *  number is bucketed by Chromium anyway, so a faster poll buys precision the
 *  source does not have and costs a render for nothing. Only ever armed while
 *  the TK panel is mounted AND the API exists — AND, since the idle audit, only
 *  ever fired while the window is actually being shown (see `useHeapPct`). */
const HEAP_POLL_MS = 2000

/** Instrument ink by severity — the same three-zone language the CTX badge uses
 *  everywhere else in the app, so a full bar means the same thing on the
 *  chassis as it does on the composer. */
function zoneInk(pct: number): string {
  if (pct >= 85) return 'var(--danger)'
  if (pct >= 60) return 'var(--warning)'
  return 'var(--success)'
}

export function ChassisSidebarPanel() {
  const theme = useThemeStore(s => s.theme)
  if (theme === TK_THEME) return <UnitTelemetry />
  if (theme === OPUS_THEME) return <ChassisMap />
  return null
}

// ── TK-05 · UNIT TELEMETRY ───────────────────────────────────────────────────

/** Renderer JS heap as a percentage of the engine's own limit, or null when the
 *  host does not expose it. `performance.memory` is non-standard (Chromium
 *  only), so the read is fully guarded and the ABSENCE is a first-class answer:
 *  the caller renders nothing rather than a zero. */
function readHeapPct(): number | null {
  try {
    const mem = (performance as unknown as {
      memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number }
    }).memory
    const used = mem?.usedJSHeapSize
    const limit = mem?.jsHeapSizeLimit
    if (typeof used !== 'number' || typeof limit !== 'number' || !(limit > 0)) return null
    return Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
  } catch {
    return null
  }
}

/**
 * The MEM row's source, on the shared visibility-gated poller.
 *
 * THIS PANEL IS ALWAYS MOUNTED under the TK theme — it lives in the sidebar
 * footer, so its timer outlived every route change and kept re-rendering a
 * minimised window twice a second, forever (the idle audit's renderer half).
 * `useVisibilityGatedInterval` keeps the handle but skips the work while the
 * document is hidden and fires a catch-up tick the moment it comes back, so the
 * skip is invisible: you never see a stale bar, you just stop paying for one
 * nobody is looking at.
 *
 * THE OLD GUARD IS PRESERVED EXACTLY, in the hook's own vocabulary: no
 * `performance.memory` → `intervalMs: null` → NO timer is ever armed and not
 * even a mount tick runs. A poll that can only produce `null` is a wake-up the
 * app pays for and nobody reads.
 *
 * Support is decided ONCE, in a state initialiser, rather than from `pct`:
 * deriving the gate from the reading itself would disarm the poll the first time
 * a read came back null and never re-arm it.
 */
function useHeapPct(): number | null {
  const [pct, setPct] = React.useState<number | null>(() => readHeapPct())
  const [supported] = React.useState(() => readHeapPct() !== null)
  useVisibilityGatedInterval(() => setPct(readHeapPct()), supported ? HEAP_POLL_MS : null)
  return pct
}

interface SpendReading { pct: number; title: string }

function costBridge(): Window['tachi']['cost'] | null {
  try {
    return (window as unknown as { tachi?: { cost?: Window['tachi']['cost'] } }).tachi?.cost ?? null
  } catch {
    return null
  }
}

/** 30-day LLM spend against the configured budget cap, from the SAME cost
 *  ledger HomePage's health strip reads (`window.tachi.cost.summary`).
 *
 *  ONE IPC CALL PER RUN, NOT A POLL: the ledger only moves when a run finishes,
 *  so the fetch is keyed on a two-valued SETTLED/BUSY token derived from the
 *  agent status (not the status itself — that would fire four times a run) and
 *  skipped entirely on the busy edge. Mount + each settle, nothing else. With no
 *  cap configured there is no denominator and therefore no percentage — the row
 *  is omitted rather than shown at 0%, because "0% of nothing" is exactly the
 *  kind of invented reading this panel was rewritten to remove. */
function useSpend(phase: 'busy' | 'settled'): SpendReading | null {
  const [reading, setReading] = React.useState<SpendReading | null>(null)
  React.useEffect(() => {
    if (phase === 'busy') return
    const cost = costBridge()
    if (!cost || typeof cost.summary !== 'function') return
    let live = true
    void cost.summary()
      .then(s => {
        if (!live) return
        const cap = typeof s?.budgetUsd === 'number' ? s.budgetUsd : 0
        const spent = typeof s?.totalUsd === 'number' ? s.totalUsd : 0
        if (!(cap > 0)) { setReading(null); return }
        const days = typeof s?.windowDays === 'number' ? s.windowDays : 30
        setReading({
          pct: Math.max(0, Math.min(100, Math.round((spent / cap) * 100))),
          title: `SPEND $${spent.toFixed(2)} / $${cap.toFixed(2)} · ${days}d ledger`,
        })
      })
      .catch(() => { /* bridge down or ledger unreadable — the row stays absent */ })
    return () => { live = false }
  }, [phase])
  return reading
}

function UnitTelemetry() {
  // CTX — the same estimate AgentPage's ContextMeter shows: every event's
  // text/input/output/message length, chars/4 ≈ tokens. The selector returns the
  // array identity from the store, so this only recomputes when the log changes.
  const messages = useAgentStore(s => s.messages)
  const agentStatus = useAgentStore(s => s.status)
  const chars = React.useMemo(() => {
    let n = 0
    for (const m of messages) {
      const ev = m.event as { text?: unknown; input?: unknown; output?: unknown; message?: unknown }
      if (typeof ev.text === 'string') n += ev.text.length
      if (typeof ev.input === 'string') n += ev.input.length
      if (typeof ev.output === 'string') n += ev.output.length
      if (typeof ev.message === 'string') n += ev.message.length
    }
    return n
  }, [messages])
  // A GAUGE IS A PERCENTAGE, AND A PERCENTAGE NEEDS A DENOMINATOR WE HAVE.
  // This divided by DEFAULT_MAX_TOKENS — a flat 32k — so a 200k model read as
  // five times fuller than it was, on a panel whose own rule 1 says every row
  // is a real reading. The window now comes from the SAME resolver the CODE
  // tab's meter and the chat chip use, keyed by the provider and model this
  // session actually routes to; when nobody published one, the row is omitted
  // (rule 2), exactly as MEM is on a host without `performance.memory`.
  // AND A GAUGE SAYS WHERE ITS DENOMINATOR CAME FROM. The hook used to hand back
  // a bare number, so this face drew a coloured percentage off a row in our own
  // catalog with nothing left to disclose it with (2026-08-02). Rule 1 again: a
  // reading includes its provenance.
  const ctxWin = useAgentContextWindow()
  const ctxWindowTokens = ctxWin === null ? null : ctxWin.tokens
  const ctxPct = ctxWindowTokens === null
    ? null
    : Math.min(100, Math.round((chars / 4 / ctxWindowTokens) * 100))
  const ctxZone = ctxPct === null ? null : getContextZone(ctxPct / 100)
  const ctxInk = ctxZone === 'red' ? 'var(--danger)' : ctxZone === 'yellow' ? 'var(--warning)' : 'var(--success)'

  const heapPct = useHeapPct()
  const spend = useSpend(agentStatus === 'starting' || agentStatus === 'running' ? 'busy' : 'settled')

  return (
    <div style={{
      padding: '9px 12px 10px',
      borderTop: 'var(--border-width) solid var(--border)',
      flexShrink: 0,
      // The rose cross-hatch behind the block, as on the mock's telemetry panel.
      backgroundImage: [
        'repeating-linear-gradient(45deg, rgba(168,18,50,0.09) 0 1px, rgba(0,0,0,0) 1px 7px)',
        'repeating-linear-gradient(-45deg, rgba(168,18,50,0.09) 0 1px, rgba(0,0,0,0) 1px 7px)',
      ].join(','),
    }}>
      <div style={{ ...CAPTION, marginBottom: 7, color: 'var(--accent-text)' }}>UNIT TELEMETRY</div>
      {/* Every row below is a measurement of this process. A row with no
          measurable source is NOT rendered — see HONESTY RULES above. */}
      {ctxPct !== null && ctxWindowTokens !== null && ctxWin !== null && (
        <Gauge
          label="CTX"
          pct={ctxPct}
          ink={ctxInk}
          title={`CTX ${ctxPct}% · ~${Math.round(chars / 4).toLocaleString()} / ${ctxWindowTokens.toLocaleString()} tok`
            + `${contextSourceNote(ctxWin.source) === null ? '' : ` (window: ${contextSourceNote(ctxWin.source)})`}`
            + ' (estimate, live agent session)'}
        />
      )}
      {heapPct !== null && (
        <Gauge
          label="MEM"
          pct={heapPct}
          ink={zoneInk(heapPct)}
          title={`MEM ${heapPct}% · renderer JS heap / engine limit`}
        />
      )}
      {spend !== null && (
        <Gauge label="SPEND" pct={spend.pct} ink={zoneInk(spend.pct)} title={spend.title} />
      )}
    </div>
  )
}

function Gauge({ label, pct, ink, title }: {
  label: string; pct: number; ink: string; title: string
}) {
  return (
    <div title={title} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
      <span style={{ ...CAPTION, width: 34, flexShrink: 0 }}>{label}</span>
      <span style={{
        position: 'relative', flex: 1, height: 5, minWidth: 0,
        background: 'var(--bg-inset)',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6)',
      }}>
        <span style={{
          position: 'absolute', inset: '0 auto 0 0',
          width: `${Math.max(2, Math.min(100, pct))}%`,
          background: ink,
          // Segmented fill so the bar reads as an LED ladder, not a progress bar.
          backgroundImage: 'repeating-linear-gradient(90deg, rgba(0,0,0,0.45) 0 1px, rgba(0,0,0,0) 1px 4px)',
        }} />
      </span>
      <span style={{ ...CAPTION, width: 22, textAlign: 'right', flexShrink: 0 }}>{pct}</span>
    </div>
  )
}

// ── OPUS-5 · CHASSIS MAP ─────────────────────────────────────────────────────
const BAYS: readonly { bay: OpusBay; id: string; label: string }[] = [
  { bay: 'nav',   id: '01', label: 'NAV' },
  { bay: 'rail',  id: '02', label: 'RAIL' },
  { bay: 'stage', id: '03', label: 'STAGE' },
]

/** Where a bay goes the first time you press it, before you have been there.
 *  Each one is a route `opusActiveBay` classifies INTO that bay — so pressing a
 *  cell always lights that cell, and the frame's matching stencil with it. */
const BAY_HOME: Record<OpusBay, string> = {
  nav:   '/home',
  rail:  '/chat',
  stage: '/nodes',
}

function ChassisMap() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const active = opusActiveBay(pathname)

  // THE MAP IS A SWITCHER. Remembering the last surface per bay is what makes a
  // press useful rather than merely legal: leaving /nodes for a chat and back
  // returns you to the canvas you were on, not to a bay's front door. A ref, not
  // state — writing it must never schedule a render (the value is only ever read
  // inside a click handler).
  const lastByBay = React.useRef<Record<OpusBay, string>>({ ...BAY_HOME })
  React.useEffect(() => {
    if (typeof pathname === 'string' && pathname) lastByBay.current[opusActiveBay(pathname)] = pathname
  }, [pathname])

  return (
    <div style={{
      padding: '9px 12px 10px',
      borderTop: 'var(--border-width) solid var(--border)',
      flexShrink: 0,
    }}>
      <div style={{ ...CAPTION, marginBottom: 7, color: 'var(--accent-text)' }}>CHASSIS MAP</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
        {BAYS.map(cell => {
          const lit = cell.bay === active
          // The LIT cell reads the router directly rather than the ref: the ref
          // is written in an effect, which schedules no render, so a tooltip fed
          // from it would print the bay's PREVIOUS route until something else
          // re-rendered the panel. The label a user reads must be this frame's
          // truth, not last frame's.
          const target = lit ? pathname : (lastByBay.current[cell.bay] || BAY_HOME[cell.bay])
          return (
            <button
              key={cell.bay}
              type="button"
              onClick={() => navigate(target)}
              aria-pressed={lit}
              aria-label={`${cell.id} ${cell.label} · ${target}`}
              title={`${cell.id} ${cell.label} · ${target}`}
              style={{
                // Button reset — the cell must look exactly as it did when it
                // was a div; only its BEHAVIOUR changed.
                appearance: 'none',
                font: 'inherit',
                border: 'none',
                margin: 0,
                cursor: 'pointer',
                padding: '5px 4px 4px',
                background: lit ? 'var(--accent-muted)' : 'var(--bg-inset)',
                boxShadow: lit
                  ? 'inset 0 0 0 1px var(--opus-signal, #b8f227)'
                  : 'inset 0 0 0 1px rgba(0,0,0,0.55)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              }}
            >
              {/* The bay's own mini floor plan: a plate outline with the region
                  this bay names blocked in. */}
              <span style={{
                width: '100%', height: 12,
                backgroundColor: 'rgba(0,0,0,0.5)',
                backgroundImage: lit
                  ? 'linear-gradient(to right, rgba(184,242,39,0.5) 0 34%, rgba(0,0,0,0) 34%)'
                  : 'linear-gradient(to right, rgba(160,172,150,0.22) 0 34%, rgba(0,0,0,0) 34%)',
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
              }} />
              <span style={{
                ...CAPTION, fontSize: 7, letterSpacing: '0.1em',
                color: lit ? 'var(--accent-text)' : 'var(--text-dim)',
              }}>{cell.id} {cell.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
