// apps/desktop/src/components/CommandPopup.tsx
//
// Slash-command autocomplete popup, shared by the Chat composer and the
// Code/harness composer so the two can never drift. Keyboard-first: the parent
// owns `cursor` and drives it through `navigatePopup()` (commands/popup-nav.ts);
// this component only paints and exposes hover/click as a convenience.
//
// Brutalist idiom: 2px border, hard shadow, no radius, JetBrains Mono.

import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

export interface CommandPopupItem {
  /** Stable react key AND the value handed back to onPick. */
  key:   string
  /** The verb as typed, e.g. "/cost". */
  label: string
  /** Argument hint, e.g. "<query>". */
  args?: string
  /** One-line description. */
  desc:  string
  /** Localized group heading; consecutive items sharing one are grouped. */
  group: string
}

export function CommandPopup({
  items,
  cursor,
  onHover,
  onPick,
}: {
  items:   CommandPopupItem[]
  cursor:  number
  onHover: (index: number) => void
  onPick:  (item: CommandPopupItem, index: number) => void
}) {
  const { t } = useTranslation('common')
  const rowRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => { rowRefs.current.get(cursor)?.scrollIntoView({ block: 'nearest' }) }, [cursor])

  if (items.length === 0) return null

  let lastGroup: string | null = null

  return (
    <div
      role="listbox"
      aria-label={t('commands.popupLabel')}
      data-testid="command-popup"
      style={{
        border: '2px solid var(--border)',
        background: 'var(--bg-surface)',
        boxShadow: 'var(--shadow-hard)',
        fontFamily: 'JetBrains Mono, monospace',
        marginBottom: 2,
        maxHeight: 260,
        overflowY: 'auto',
      }}
    >
      <div style={{
        padding: '4px 10px',
        borderBottom: '2px solid var(--border)',
        fontSize: 9, color: 'var(--text-dim)',
        textTransform: 'uppercase', letterSpacing: '0.12em',
        background: 'var(--bg-inset)',
      }}>
        {t('commands.popupHint')}
      </div>
      {items.map((it, i) => {
        const header = it.group !== lastGroup ? it.group : null
        lastGroup = it.group
        const active = i === cursor
        return (
          <div key={it.key}>
            {header && (
              <div style={{
                padding: '4px 12px',
                fontSize: 9, color: 'var(--text-dim)',
                textTransform: 'uppercase', letterSpacing: '0.12em',
                borderBottom: 'var(--border-width) solid var(--border)',
                background: 'var(--bg-inset)',
              }}>{header}</div>
            )}
            <button
              ref={el => { if (el) rowRefs.current.set(i, el) }}
              role="option"
              aria-selected={active}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(it, i)}
              style={{
                display: 'flex', alignItems: 'baseline', gap: 8,
                width: '100%', textAlign: 'left',
                padding: '6px 12px',
                border: 'none',
                borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
                background: active ? 'var(--accent-muted)' : 'transparent',
                color: 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12, cursor: 'pointer',
              }}
            >
              <span style={{ color: 'var(--accent)', fontWeight: 700, whiteSpace: 'nowrap' }}>{it.label}</span>
              {it.args && (
                <span style={{ color: 'var(--text-dim)', fontSize: 10, whiteSpace: 'nowrap' }}>{it.args}</span>
              )}
              <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 10 }}>{it.desc}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}
