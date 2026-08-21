// apps/desktop/src/pages/agent/IncompleteBadge.tsx
//
// GAVE-UP DETECTION — the Code / TACHIAPP "it stopped, it did not finish" badge.
//
// A provider finish-reason `stop` used to render as "✓ Done (stop)" whether the
// agent had finished the task or simply given up: two 8-minute runs read files,
// said nothing, changed nothing, and the UI called them a success. The harness
// now classifies the END STATE (electron/services/tachi/outcome.ts) and marks
// that case ENDED-INCOMPLETE; this is the surface for it — amber, never a
// checkmark, and carrying the one control that turns a dead end into progress:
// CONTINUE, which sends a continue message to the SAME session.
//
// Presentational + self-contained, in the shape of its neighbours
// (ReconnectBanner / LoopChip): the store owns when it appears, and CONTINUE is
// a window CustomEvent so the badge needs no props from AgentPage.

import React from 'react'
import { useTranslation } from 'react-i18next'

export function IncompleteBadge({
  detail,
  nudged,
  disabled,
  compact,
}: {
  /** One line from the classifier explaining what was missing. */
  detail?: string
  /** The harness already spent its one automatic continuation on this run. */
  nudged?: boolean
  /** No live session to continue into (viewing an archive, or mid-run). */
  disabled?: boolean
  /** Inline-in-transcript variant (slightly roomier than the header chip). */
  compact?: boolean
}): React.ReactElement {
  const { t } = useTranslation('agent')
  const title = [
    detail || t('incomplete.detailFallback', { defaultValue: 'The run stopped without completing or summarizing.' }),
    nudged ? t('incomplete.nudgedHint', { defaultValue: 'It was already asked once to continue.' }) : '',
  ].filter(Boolean).join(' ')

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="ended-incomplete"
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        padding: compact ? '4px 10px' : '3px 8px',
        border: 'var(--border-width) solid var(--warning, var(--accent-alt))',
        background: 'var(--bg-inset)',
        color: 'var(--warning, var(--accent-alt))',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span aria-hidden style={{ fontSize: 12 }}>⚠</span>
      <span>{t('incomplete.badge', { defaultValue: 'Ended without completing' })}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => window.dispatchEvent(new CustomEvent('tachi:agent-continue'))}
        title={t('incomplete.continueHint', { defaultValue: 'Send a continue message to this session' })}
        style={{
          padding: '1px 6px',
          border: 'var(--border-width) solid var(--accent)',
          background: 'transparent',
          color: 'var(--accent)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {t('incomplete.continue', { defaultValue: 'Continue' })}
      </button>
    </span>
  )
}
