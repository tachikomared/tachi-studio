// apps/desktop/src/pages/chat/CompactMarker.tsx
//
// CHAT COMPACT — the thin transcript marker shown once a conversation has been
// compacted. The full transcript stays on screen (compaction is
// non-destructive); this row just tells the user that the messages above it are
// represented by a summary in the OUTGOING context, and expands to reveal it.

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface CompactMarkerProps {
  /** Number of leading messages folded into the summary (= compactedUpTo). */
  count: number
  /** The dense summary that replaces those messages in the request context. */
  summary: string
}

export function CompactMarker({ count, summary }: CompactMarkerProps) {
  const { t } = useTranslation('chat')
  const [open, setOpen] = useState(false)

  return (
    <div style={{ padding: '4px 16px 10px' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        title={t('compact.markerTitle', { defaultValue: 'These earlier messages are sent as a summary to save context. Click to view it.' })}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '3px 8px',
          border: '2px solid var(--border)',
          background: 'var(--bg-inset)',
          color: 'var(--text-dim)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          cursor: 'pointer',
          lineHeight: 1.6,
        }}
      >
        <span style={{ flex: 1, borderTop: '2px dashed var(--border)', height: 0 }} />
        <span style={{ whiteSpace: 'nowrap' }}>
          {t('compact.marker', { defaultValue: '{{count}} messages compacted', count })}
        </span>
        <span style={{ color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1, borderTop: '2px dashed var(--border)', height: 0 }} />
      </button>
      {open && (
        <div
          style={{
            marginTop: 6,
            padding: '8px 12px',
            border: '2px solid var(--border)',
            background: 'var(--bg-base)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            lineHeight: 1.55,
            color: 'var(--text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <div style={{ color: 'var(--text-dim)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
            {t('compact.summaryLabel', { defaultValue: 'Context summary' })}
          </div>
          {summary}
        </div>
      )}
    </div>
  )
}
