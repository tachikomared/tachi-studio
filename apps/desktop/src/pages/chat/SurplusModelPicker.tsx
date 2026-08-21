// apps/desktop/src/pages/chat/SurplusModelPicker.tsx
//
// Brutalist dropdown listing Surplus Intelligence's marketplace catalog (100+
// models). Mounts next to the ProviderPicker when 'surplus' is the active chat
// provider, and is reused in the Agent page header + the Code-tab gateway when
// Surplus powers the harness.
//
// Pulls /api/inference/v1/models live via window.tachi.surplus.listModels —
// falls back to a curated catalog when no key is set or the gateway is
// unreachable. Grouped by model family for fast scan. Mirrors BankrModelPicker.
import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { SurplusModelInfo } from '../../types/electron'
import { TaskGroupedModelList, type ModelGroup } from './TaskGroupedModelList'
import { useModelWindowStore } from '../../store/modelWindow.store'

interface Props {
  value:    string
  onChange: (modelId: string) => void
  disabled?: boolean
  compact?: boolean
  openUp?: boolean
}

export function SurplusModelPicker({ value, onChange, disabled, compact, openUp }: Props) {
  const { t } = useTranslation('chat')
  const [models, setModels]   = useState<SurplusModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [stale, setStale]     = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.tachi.surplus.listModels({ force })
      if (!res.ok) {
        setError(res.error ?? t('surplus.loadError'))
        setModels([])
        return
      }
      setModels(res.models)
      // One source for the window (see modelWindow.store): what this list shows
      // is what the CTX chip and the send-time budget use.
      useModelWindowStore.getState().recordCatalogWindows('surplus', res.models)
      setStale(Boolean(res.stale))
      if (res.error) setError(res.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (open) load(true) }, [open, load])

  const selected = models.find(m => m.id === value)
  const currentLabel = selected?.label ?? value ?? t('picker.pickModel')

  // The `· 200k ctx` tail is resolved by TaskGroupedModelList from the window
  // recorded above — see VeniceModelPicker for why no picker formats its own.

  // Family grouping stays the DEFAULT view; the task filter sits above it.
  const familyGroups = useMemo<ModelGroup[]>(() => {
    const byFamily = models.reduce<Record<string, SurplusModelInfo[]>>((acc, m) => {
      const k = m.family ?? 'Other'
      ;(acc[k] ??= []).push(m)
      return acc
    }, {})
    const familyOrder = ['Claude', 'Gemini', 'GPT', 'Llama', 'DeepSeek', 'Qwen', 'Mistral', 'Grok', 'Other']
    return familyOrder
      .filter(f => (byFamily[f]?.length ?? 0) > 0)
      .map(f => ({
        key: f,
        label: f,
        models: byFamily[f].map(m => ({
          id: m.id,
          label: m.label,
          // EVIDENCE, live rows only.
          ...(m.live && typeof m.contextTokens === 'number' ? { contextTokens: m.contextTokens } : {}),
        })),
      }))
  }, [models])

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={t('surplus.pickTitle')}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          padding: '3px 10px',
          border: '2px solid var(--border)',
          background: 'var(--bg-elevated)',
          color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.04em',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          textTransform: 'lowercase',
          boxShadow: 'none',
          maxWidth: 260,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('picker.modelLabel')}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentLabel}</span>
        {!compact && stale && (
          <span title={t('picker.offlineTitle')} style={{
            fontSize: 8, color: 'var(--warning)', textTransform: 'uppercase',
            fontWeight: 700, letterSpacing: '0.05em',
          }}>{t('picker.offlineBadge')}</span>
        )}
        <span style={{ color: 'var(--text-dim)', fontSize: 8 }}>▾</span>
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 9, background: 'transparent' }}
          />
          <div
            style={{
              position: 'absolute',
              ...(openUp ? { bottom: 'calc(100% + 4px)' } : { top: 'calc(100% + 4px)' }),
              left: 0,
              minWidth: 300,
              maxHeight: 360,
              overflowY: 'auto',
              border: '2px solid var(--border)',
              background: 'var(--bg-surface)',
              boxShadow: 'var(--shadow-hard, 4px 4px 0 var(--border))',
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {loading && models.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-dim)' }}>
                {t('surplus.loadingCatalog')}
              </div>
            )}

            {error && stale && (
              <div style={{
                padding: '6px 10px',
                fontSize: 9,
                color: 'var(--warning)',
                background: 'var(--bg-inset)',
                borderBottom: 'var(--border-width) solid var(--border)',
                lineHeight: 1.4,
              }}>
                {t('picker.offlineCurated', { error })}
              </div>
            )}

            <TaskGroupedModelList
              providerId="surplus"
              groups={familyGroups}
              value={value}
              listLabel={t('surplus.pickTitle')}
              onPick={(id) => { onChange(id); setOpen(false) }}
            />
          </div>
        </>
      )}
    </div>
  )
}
