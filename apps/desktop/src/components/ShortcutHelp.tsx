// apps/desktop/src/components/ShortcutHelp.tsx
//
// Brutalist keyboard-shortcut cheatsheet. Shows on Cmd+/ or via command palette.

import React, { useEffect, useState } from 'react'

const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: 'Cmd K',     label: 'Open command palette' },
  { keys: 'Cmd N',     label: 'New chat' },
  { keys: 'Cmd ,',     label: 'Open settings' },
  { keys: 'Cmd /',     label: 'Show this cheatsheet' },
  { keys: 'Cmd ⇧ Space', label: 'Capture screen region → new chat' },
  { keys: 'Enter',     label: 'Send message' },
  { keys: 'Shift ↵',   label: 'Newline in composer' },
  { keys: 'Esc',       label: 'Close modal / stop generation' },
  { keys: '↑ ↓',       label: 'Navigate palette items' },
  { keys: 'Ctrl C',    label: 'Cancel selected file/image attach' },
]

export function ShortcutHelp() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onShow = () => setOpen(o => !o)
    window.addEventListener('tachi:show-shortcut-help', onShow as EventListener)
    return () => window.removeEventListener('tachi:show-shortcut-help', onShow as EventListener)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 9998,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 'min(420px, 92vw)',
          background: 'var(--bg-surface)',
          border: '2px solid var(--border)',
          boxShadow: 'var(--shadow-hard)',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        <div style={{
          padding: '6px 12px',
          borderBottom: '2px solid var(--border)',
          fontSize: 9,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ color: 'var(--accent)' }}>⌨</span>
          <span>Keyboard Shortcuts</span>
          <div style={{ flex: 1 }} />
          <kbd>esc</kbd>
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {SHORTCUTS.map(s => (
            <li key={s.keys} style={{
              display: 'flex',
              alignItems: 'center',
              padding: '8px 14px',
              borderBottom: 'var(--border-width) solid var(--border)',
              fontSize: 12,
              color: 'var(--text-primary)',
              gap: 12,
            }}>
              <span style={{ flex: 1 }}>{s.label}</span>
              {s.keys.split(/\s+/).map((k, i) => (
                <kbd key={i}>{k}</kbd>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
