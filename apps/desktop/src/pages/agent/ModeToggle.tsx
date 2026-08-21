// apps/desktop/src/pages/agent/ModeToggle.tsx
import React from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentMode } from '../../store/agent.store'

export function ModeToggle({
  value,
  onChange,
  disabled,
}: {
  value: AgentMode
  onChange: (m: AgentMode) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('agent')
  return (
    <div style={{
      display: 'flex', gap: 0,
      background: 'var(--bg-elevated)', border: 'var(--border-width) solid var(--border)',
      overflow: 'hidden',
      opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : undefined,
    }}>
      {(['plan', 'build'] as AgentMode[]).map((m, i) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          title={m === 'plan' ? t('modeToggle.planTooltip') : t('modeToggle.buildTooltip')}
          disabled={disabled}
          style={{
            padding: '3px 12px', border: 'none',
            borderRight: i === 0 ? 'var(--border-width) solid var(--border)' : 'none',
            cursor: 'pointer', fontSize: 11, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.06em',
            background: value === m ? 'var(--accent)' : 'transparent',
            color:      value === m ? '#fff' : 'var(--text-muted)',
            // PLAN/BUILD is mutually exclusive, so it swaps INSTANTLY — the same
            // rule the KV-cache picker in Settings follows and for the same
            // reason. globals.css eases background-color (and now `color`) on
            // every button, which is right for a hover but wrong here: for the
            // length of the ease BOTH modes are part-lit, and a control whose
            // whole promise is "exactly one of these is active" must not spend
            // 120ms contradicting itself. The press feel is kept.
            transition: 'transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 120ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        >
          {m === 'plan' ? `📋 ${t('modeToggle.plan')}` : `🔨 ${t('modeToggle.build')}`}
        </button>
      ))}
    </div>
  )
}
