// apps/desktop/src/pages/chat/SamplerChip.tsx
//
// PER-CHAT SAMPLER PRESET chip (USER-PAINS T19). A small labelled composer-footer
// chip that opens a popover with the three safe presets (FAST / BALANCED /
// CREATIVE) plus an ADVANCED section exposing the exact temperature / top-p
// knobs. Persisted per-conversation on the chat store; BALANCED is the default
// and sends nothing, so beginners stay safe while power users get precise
// control without leaving for LM Studio.
//
// Brutalist idiom: JetBrains Mono, hard-offset shadow, CSS vars, uppercase
// micro-labels — copied from the router-tune popover in InputBar.
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chat.store'
import {
  DEFAULT_SAMPLER, SAMPLER_PRESETS,
  ADVANCED_DEFAULT_TEMPERATURE, ADVANCED_DEFAULT_TOP_P,
  TEMPERATURE_MIN, TEMPERATURE_MAX, TEMPERATURE_STEP,
  TOP_P_MIN, TOP_P_MAX, TOP_P_STEP,
  clampTemperature, clampTopP,
  type SamplerPresetId, type SamplerSettings,
} from './samplerPresets'

export function SamplerChip({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation('chat')
  const activeConversationId = useChatStore(s => s.activeConversationId)
  const sampler = useChatStore(s =>
    s.conversations.find(c => c.id === s.activeConversationId)?.sampler,
  ) ?? DEFAULT_SAMPLER
  const setConversationSampler = useChatStore(s => s.setConversationSampler)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const preset = sampler.preset ?? 'balanced'
  const isCustom = preset !== 'balanced'
  // Advanced knob values (seeded from the setting, else neutral defaults).
  const advTemp = typeof sampler.temperature === 'number' ? sampler.temperature : ADVANCED_DEFAULT_TEMPERATURE
  const advTopP = typeof sampler.topP === 'number' ? sampler.topP : ADVANCED_DEFAULT_TOP_P

  const commit = (next: SamplerSettings | null) => {
    if (activeConversationId) setConversationSampler(activeConversationId, next)
  }
  const pickPreset = (p: SamplerPresetId) => {
    if (p === 'advanced') {
      // Enter ADVANCED seeding the current effective values so the knobs start
      // from something sensible rather than empty.
      commit({ preset: 'advanced', temperature: clampTemperature(advTemp), topP: clampTopP(advTopP) })
    } else {
      commit({ preset: p })
    }
  }
  const setTemp = (v: number) => commit({ preset: 'advanced', temperature: clampTemperature(v), topP: clampTopP(advTopP) })
  const setTopP = (v: number) => commit({ preset: 'advanced', temperature: clampTemperature(advTemp), topP: clampTopP(v) })

  const chipLabel = t(`sampler.preset.${preset}`)

  return (
    <span ref={ref} data-testid="sampler-chip" style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title={t('sampler.chipTitle')}
        aria-label={t('sampler.chipTitle')}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          height: 26, padding: '0 8px', border: '2px solid var(--border)',
          background: isCustom ? 'var(--accent-muted)' : 'var(--bg-inset)',
          color: isCustom ? 'var(--accent-text)' : 'var(--text-muted)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.06em', cursor: disabled ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 5,
        }}
      >
        <span style={{ color: 'var(--text-dim)', fontSize: 8 }}>{t('sampler.chip')}</span>
        {chipLabel}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('sampler.heading')}
          style={{
            position: 'absolute', bottom: 32, right: 0, zIndex: 1000, width: 236,
            border: '2px solid var(--border-strong)', background: 'var(--bg-surface)',
            boxShadow: '4px 4px 0 var(--border)',
            padding: 10, display: 'flex', flexDirection: 'column', gap: 6,
            fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--text-muted)',
          }}
        >
          <span style={{
            color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.12em',
            fontSize: 9, fontWeight: 700,
          }}>{t('sampler.heading')}</span>

          {SAMPLER_PRESETS.map(p => {
            const selected = preset === p
            return (
              <button
                key={p}
                data-testid={`sampler-preset-${p}`}
                onClick={() => pickPreset(p)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '5px 8px',
                  border: '2px solid var(--border)',
                  borderLeft: selected ? '3px solid var(--accent)' : '2px solid var(--border)',
                  background: selected ? 'var(--accent-muted)' : 'var(--bg-inset)',
                  color: selected ? 'var(--accent-text)' : 'var(--text-primary)',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, cursor: 'pointer',
                }}
              >
                <span style={{ fontWeight: 700, letterSpacing: '0.06em' }}>{t(`sampler.preset.${p}`)}</span>
                <br />
                <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>{t(`sampler.presetDesc.${p}`)}</span>
              </button>
            )
          })}

          {preset === 'advanced' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span>{t('sampler.temperature')}</span>
                <input
                  type="number" step={TEMPERATURE_STEP} min={TEMPERATURE_MIN} max={TEMPERATURE_MAX}
                  value={advTemp}
                  data-testid="sampler-temperature"
                  onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setTemp(v) }}
                  style={{
                    width: 66, background: 'var(--bg-inset)', color: 'var(--text-primary)',
                    border: '2px solid var(--border)', fontFamily: 'inherit', fontSize: 10, padding: '2px 4px',
                  }}
                />
              </label>
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span>{t('sampler.topP')}</span>
                <input
                  type="number" step={TOP_P_STEP} min={TOP_P_MIN} max={TOP_P_MAX}
                  value={advTopP}
                  data-testid="sampler-top-p"
                  onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setTopP(v) }}
                  style={{
                    width: 66, background: 'var(--bg-inset)', color: 'var(--text-primary)',
                    border: '2px solid var(--border)', fontFamily: 'inherit', fontSize: 10, padding: '2px 4px',
                  }}
                />
              </label>
            </div>
          )}

          <span style={{ color: 'var(--text-dim)', fontSize: 9, lineHeight: 1.4 }}>
            {preset === 'balanced' ? t('sampler.balancedNote') : t('sampler.advancedHint')}
          </span>
        </div>
      )}
    </span>
  )
}
