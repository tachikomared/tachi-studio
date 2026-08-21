// apps/desktop/src/pages/chat/ReasoningBlock.tsx
//
// Brutalist collapsed "reasoning" disclosure for chain-of-thought emitted by
// thinking models. A thin bordered strip with a ▸/▾ toggle and a "reasoning"
// label (monospace, --text-dim). Collapsed by default; expands to show the raw
// reasoning text. While streaming (open === true) it shows an in-progress
// marker and defaults to expanded so the user can watch the model think.

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Markdown } from './Markdown'

interface ReasoningBlockProps {
  text: string
  /** True while the reasoning block is still streaming (tag not yet closed). */
  inProgress: boolean
}

export function ReasoningBlock({ text, inProgress }: ReasoningBlockProps): React.ReactElement {
  const { t } = useTranslation('chat')
  // Watch live reasoning by default; collapse finished reasoning by default.
  const [expanded, setExpanded] = useState(inProgress)

  return (
    <div
      style={{
        margin: '4px 0',
        border: '2px solid var(--border)',
        background: 'var(--bg-inset)',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          textAlign: 'left',
          padding: '3px 8px',
          border: 'none',
          background: 'transparent',
          color: 'var(--text-dim)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        <span style={{ width: 10, flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
        <span>{t('reasoning.label')}</span>
        {inProgress && (
          <span
            className="tachi-pulse-dot"
            style={{
              display: 'inline-block',
              width: 6,
              height: 6,
              background: 'var(--accent)',
              flexShrink: 0,
            }}
          />
        )}
        {inProgress && (
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, letterSpacing: '0.06em' }}>
            {t('reasoning.thinking')}
          </span>
        )}
      </button>
      {expanded && (
        <div
          style={{
            padding: '4px 8px 6px',
            borderTop: '2px solid var(--border)',
            color: 'var(--text-dim)',
            fontSize: 12,
            lineHeight: 1.55,
          }}
        >
          <Markdown source={text} />
        </div>
      )}
    </div>
  )
}
