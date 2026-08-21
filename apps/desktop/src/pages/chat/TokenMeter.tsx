// apps/desktop/src/pages/chat/TokenMeter.tsx
//
// Small brutalist token/cost meter badge for the active conversation. Reads the
// accumulated token usage (provider-reported TokenUsage, chars/4 fallback) and
// color-steps the value:
//   --text-muted  (normal)  →  --warning  (busy)  →  --danger  (very long).
// Resets to zero automatically when the conversation changes (new chat has no
// messages → 0 tokens).

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore, conversationTokens } from '../../store/chat.store'

// Thresholds chosen against a ~8k effective context window for the small free
// models this app ships with. Tune freely — they only drive the color step.
const WARN_AT = 4000
const DANGER_AT = 8000

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

export function TokenMeter(): React.ReactElement | null {
  const { t } = useTranslation('chat')
  // Subscribe to the active conversation's messages so the meter updates live as
  // chunks/usage land. Selecting the conversation object keeps this reactive.
  const conv = useChatStore(s => s.conversations.find(c => c.id === s.activeConversationId) ?? null)
  const tokens = conversationTokens(conv)

  if (!conv) return null

  const color =
    tokens >= DANGER_AT ? 'var(--danger)'
    : tokens >= WARN_AT ? 'var(--warning)'
    : 'var(--text-muted)'

  return (
    <span
      title={tokens >= DANGER_AT
        ? t('meter.titleDanger', { count: tokens.toLocaleString() })
        : t('meter.title', { count: tokens.toLocaleString() })}
      aria-label={t('meter.ariaLabel', { count: tokens.toLocaleString() })}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        border: '2px solid var(--border)',
        background: 'var(--bg-inset)',
        color,
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          background: color,
          flexShrink: 0,
        }}
      />
      {formatTokens(tokens)} {t('meter.unit')}
    </span>
  )
}
