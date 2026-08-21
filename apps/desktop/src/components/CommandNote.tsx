// apps/desktop/src/components/CommandNote.tsx
//
// Inline, LOCAL-ONLY output strip for slash commands. Rendered directly above a
// composer. Nothing here ever reaches a model — /help, /cost, /memory and the
// "unknown command" hint all land in this strip, so the transcript stays clean
// and no accidental prompt is sent.
//
// Brutalist idiom: 2px border, no radius, JetBrains Mono, CSS variables only.

import React from 'react'
import { useTranslation } from 'react-i18next'

export interface CommandNoteData {
  kind: 'note' | 'error'
  text: string
}

export function CommandNote({ note, onDismiss }: { note: CommandNoteData | null; onDismiss: () => void }) {
  const { t } = useTranslation('common')
  if (!note) return null

  const color = note.kind === 'error' ? 'var(--danger)' : 'var(--accent)'

  return (
    <div
      role="status"
      data-testid="command-note"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '6px 8px',
        marginBottom: 4,
        border: `2px solid ${color}`,
        background: 'var(--bg-inset)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
        lineHeight: 1.55,
        color: 'var(--text-primary)',
        maxHeight: 220,
        overflowY: 'auto',
      }}
    >
      <span style={{ color, fontWeight: 700, flexShrink: 0 }}>{note.kind === 'error' ? '!' : '›'}</span>
      <pre
        style={{
          flex: 1, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit',
        }}
      >{note.text}</pre>
      <button
        onClick={onDismiss}
        title={t('commands.dismiss')}
        aria-label={t('commands.dismiss')}
        style={{
          border: 'none', background: 'transparent', color: 'var(--text-dim)',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, padding: 0, flexShrink: 0,
        }}
      >×</button>
    </div>
  )
}
