// apps/desktop/src/pages/settings/ContextRecallSection.tsx
//
// Settings → Advanced → CONTEXT RECALL (batch33 stage 2).
//
// Two controls over one feature: whether the TACHI harness may (a) pack the
// older half of a long session into a relevance-ranked recap and (b) prepend
// excerpts recalled from the saved-chat index to the current task. Both are
// bounded by the SAME token budget, which is why they share one toggle — the
// user's question is "may the agent spend tokens remembering?", not "which of
// two recall mechanisms do I want".
//
// Styling follows PrivacySection (the brutalist card + square toggle) so the
// Advanced tab reads as one surface.

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '../../components/Switch'

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

/** Mirrors the zod bound in electron/services/settings-schema.ts. */
const BUDGET_MIN = 0
const BUDGET_MAX = 32_000
const BUDGET_FALLBACK = 1200

export function ContextRecallSection() {
  const { t } = useTranslation('settings')
  const [enabled, setEnabled] = React.useState(true)
  const [budget, setBudget] = React.useState(BUDGET_FALLBACK)
  // The raw text of the number field, so a half-typed value ("12") isn't
  // clamped out from under the cursor. Committed on blur.
  const [budgetText, setBudgetText] = React.useState(String(BUDGET_FALLBACK))

  React.useEffect(() => {
    window.tachi.settings.load()
      .then(s => {
        const on = s.tachiRecallEnabled !== false
        const b = Number.isFinite(s.tachiRecallBudgetTokens) ? Number(s.tachiRecallBudgetTokens) : BUDGET_FALLBACK
        setEnabled(on)
        setBudget(b)
        setBudgetText(String(b))
      })
      .catch(() => { /* unreadable settings → keep the defaults on screen */ })
  }, [])

  const toggle = async (v: boolean) => {
    setEnabled(v)
    try { await window.tachi.settings.save({ tachiRecallEnabled: v }) } catch { setEnabled(!v) }
  }

  const commitBudget = async () => {
    const parsed = Math.round(Number(budgetText))
    const next = Number.isFinite(parsed) ? Math.max(BUDGET_MIN, Math.min(BUDGET_MAX, parsed)) : budget
    setBudget(next)
    setBudgetText(String(next))
    if (next === budget) return
    try { await window.tachi.settings.save({ tachiRecallBudgetTokens: next }) } catch { setBudgetText(String(budget)) }
  }

  return (
    <div style={{
      border: '2px solid var(--border)',
      background: 'var(--bg-elevated)',
      boxShadow: 'var(--shadow-hard)',
      marginBottom: 24,
      ...MONO,
    }}>
      <div style={{
        padding: '10px 14px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-primary)' }}>
            {t('contextRecall.title')}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
            {t('contextRecall.description')}
          </div>
        </div>

        {/* Was role="switch" on a <div> with no tabIndex and no key handler:
            ANNOUNCED as a switch, unreachable as one. Same pixels, real button. */}
        <Switch
          checked={enabled}
          onChange={v => { void toggle(v) }}
          onLabel={t('contextRecall.on')}
          offLabel={t('contextRecall.off')}
          label={t('contextRecall.toggleAria')}
        />
      </div>

      <div style={{
        padding: '10px 14px',
        borderTop: '2px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        opacity: enabled ? 1 : 0.5,
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-primary)' }}>
            {t('contextRecall.budgetLabel')}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
            {t('contextRecall.budgetHint')}
          </div>
        </div>
        <input
          type="number"
          min={BUDGET_MIN}
          max={BUDGET_MAX}
          step={100}
          disabled={!enabled}
          value={budgetText}
          aria-label={t('contextRecall.budgetLabel')}
          onChange={e => setBudgetText(e.target.value)}
          onBlur={commitBudget}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          style={{
            ...MONO,
            width: 88, flexShrink: 0,
            padding: '5px 8px', fontSize: 10,
            border: '2px solid var(--border)',
            background: 'var(--bg-base)', color: 'var(--text-primary)',
          }}
        />
      </div>
    </div>
  )
}
