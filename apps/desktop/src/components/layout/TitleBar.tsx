// apps/desktop/src/components/layout/TitleBar.tsx
//
// Custom frameless-window title bar.
//
// Replaces the Windows `titleBarOverlay` so we get:
//   - Brutalist min/max/close buttons that match the rest of the app
//     (2px borders, JetBrains Mono "—" / "□" / "×", sharp corners, no
//     Windows-system colors)
//   - A drag region that doesn't overlap content (the bar reserves its
//     own 30px row above the rest of the layout, where the OS overlay
//     used to float on top of the renderer surface)
//
// The whole bar is `WebkitAppRegion: drag` so the user can grab anywhere
// to move the window. The buttons themselves are `no-drag` so they
// receive clicks.

import React, { useEffect, useState } from 'react'
import { usePrivacyStore } from '../../store/privacy.store'

const BAR_HEIGHT = 30

// ─── Drag-region helper ─────────────────────────────────────────────────────
//
// `WebkitAppRegion` is a non-standard CSS property only typed by @types/electron
// in renderer context — cast through `as React.CSSProperties` to avoid TS noise.
const dragStyle: React.CSSProperties = { ['WebkitAppRegion' as unknown as keyof React.CSSProperties]: 'drag' } as React.CSSProperties
const noDragStyle: React.CSSProperties = { ['WebkitAppRegion' as unknown as keyof React.CSSProperties]: 'no-drag' } as React.CSSProperties

export function TitleBar() {
  const [maximized, setMaximized] = useState(false)
  const privacyMode = usePrivacyStore(s => s.mode)

  useEffect(() => {
    // Seed from current state, then subscribe to live changes.
    window.tachi.window.getState().then(s => setMaximized(s.maximized)).catch(() => {})
    const off = window.tachi.window.onStateChanged(s => setMaximized(s.maximized))
    return off
  }, [])

  const onMin    = () => window.tachi.window.minimize().catch(() => {})
  const onMaxTog = () => window.tachi.window.maximizeToggle().catch(() => {})
  const onClose  = () => window.tachi.window.close().catch(() => {})

  return (
    <div
      style={{
        ...dragStyle,
        height: BAR_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        fontFamily: 'JetBrains Mono, monospace',
        // On Windows we need explicit user-select: none for the drag region
        // so double-clicks don't accidentally select text.
        userSelect: 'none',
      }}
    >
      {/* Spacer / brand region — fully draggable */}
      <div style={{ flex: 1 }} />

      {/* PRIVATE MODE badge — only rendered when the privacy store is in
          'private' mode. Sits between the drag region and window controls
          so it's always visible regardless of which page is open.
          no-drag so click-to-focus still works (no action wired here in
          Tier 1; users toggle via the Command Palette or Settings).      */}
      {privacyMode === 'private' && (
        <div
          aria-label="Private mode active"
          title="Private mode is active — cloud providers are blocked. Toggle off in the Command Palette."
          style={{
            ...noDragStyle,
            display: 'flex',
            alignItems: 'center',
            alignSelf: 'center',
            margin: '0 8px',
            padding: '4px 10px',
            border: '2px solid var(--border)',
            background: 'var(--danger, #d43f00)',
            color: '#ffffff',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            lineHeight: 1,
            borderRadius: 0,
            userSelect: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          [PRIVATE]
        </div>
      )}

      {/* Window controls — sit flush in the top-right corner. The chassis
          themes (tachikoma-red / tachi-opus5) render their OWN working keys on
          the frame flank wired to the same IPC — showing both sets 50px apart
          read as duplication (live-found), so the structure sheets hide this
          row via the data hook while every other theme keeps it. */}
      <div data-titlebar-controls="" style={{ ...noDragStyle, display: 'flex', alignItems: 'stretch' }}>
        <CtrlBtn label="—"        title="Minimize"           onClick={onMin} />
        <CtrlBtn label={maximized ? '❐' : '□'} title={maximized ? 'Restore' : 'Maximize'} onClick={onMaxTog} />
        <CtrlBtn label="×"        title="Close"  danger      onClick={onClose} />
      </div>
    </div>
  )
}

// ── Single control button ────────────────────────────────────────────────────

interface CtrlBtnProps {
  label:   string
  title:   string
  onClick: () => void
  danger?: boolean
}

function CtrlBtn({ label, title, onClick, danger }: CtrlBtnProps) {
  const [hover, setHover] = useState(false)

  // Hover colors: neutral hover = elevated bg, danger (close) = red bg + white text.
  const hoverBg = danger
    ? 'var(--danger, #d43f00)'
    : 'var(--bg-elevated)'
  const hoverFg = danger ? '#ffffff' : 'var(--text-primary)'

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      aria-label={title}
      style={{
        // Cast through `as` because WebkitAppRegion is not in React's CSS types.
        ['WebkitAppRegion' as unknown as keyof React.CSSProperties]: 'no-drag',
        width: 46,
        height: '100%',
        padding: 0,
        border: 'none',
        borderLeft: '2px solid var(--border)',
        background: hover ? hoverBg : 'transparent',
        color:      hover ? hoverFg : 'var(--text-muted)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize:   14,
        fontWeight: 700,
        lineHeight: 1,
        cursor:     'pointer',
        // No rounded corners — brutalist style.
        borderRadius: 0,
      } as React.CSSProperties}
    >
      {label}
    </button>
  )
}
