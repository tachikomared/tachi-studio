import React, { useState, useEffect } from 'react'
import { ConsoleTabs } from './ConsoleTabs'
import { FooterHints } from '../FooterHints'
import { DownloadStrip } from '../DownloadStrip'
import { ActivityStrip } from '../activity/ActivityStrip'

const isMac = (((navigator as any).userAgentData?.platform) ?? navigator.platform).includes('Mac')
const SHORTCUT = isMac ? '⌘`' : 'Ctrl+`'

export function ConsoleDock() {
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(240)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '`' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    // Also toggle on a global event so the command palette ("Toggle Console")
    // and any other surface can open the dock without the Ctrl+` keybinding
    // (which some keyboard layouts don't emit as a backtick).
    const toggle = () => setOpen(o => !o)
    window.addEventListener('keydown', handler)
    window.addEventListener('tachi:toggle-console', toggle)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('tachi:toggle-console', toggle)
    }
  }, [])

  return (
    <div style={{ borderTop: 'var(--border-width) solid var(--border)', background: 'var(--bg-surface)', flexShrink: 0 }}>
      {/* THE ACTIVITY RAIL. It sits here, above the collapsible console body,
          for the same reason DownloadStrip does: this dock renders on every
          route, so a generation started on Media stays visible — and stoppable
          — from any tab. Both strips return null when they have nothing to say,
          so an idle app shows neither. (They are two strips and not one only
          because unifying them means moving downloads onto the main-process
          ActivityRegistry — audit §3 step 0 — which owns DownloadStrip's markup
          and tests; rendering downloads in both would draw them twice.) */}
      <ActivityStrip />
      <DownloadStrip />
      <div style={{ display: 'flex', alignItems: 'center', height: 32, padding: '0 12px', gap: 8 }}>
        <button onClick={() => setOpen(o => !o)} style={{
          background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12,
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <span style={{ transform: open ? 'rotate(0deg)' : 'rotate(180deg)', display: 'inline-block' }}>∧</span>
          Console
        </button>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.6 }}>{SHORTCUT}</span>
        <FooterHints />
      </div>
      {open && (
        <div style={{ height, display: 'flex', flexDirection: 'column' }}>
          <ConsoleTabs />
        </div>
      )}
    </div>
  )
}
