// apps/desktop/src/pages/chat/BankrModelPicker.tsx
//
// Brutalist dropdown listing Bankr's LLM Gateway catalog. Mounts next to the
// ProviderPicker when bankr-gateway is the active chat provider, and also
// gets reused in the Agent page header when Bankr powers the harness.
//
// Pulls /v1/models live via window.tachi.bankr.listModels — falls back to a
// static catalog when no key is set or the gateway is unreachable. The picker
// is grouped by model family (Claude / Gemini / GPT / Llama) for fast scan;
// the TASK filter strip above that list comes from TaskGroupedModelList, which
// owns the grouping, the ARIA and the tag derivation for every picker.
import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { BankrModelInfo } from '../../types/electron'
import { TaskGroupedModelList, type ModelGroup } from './TaskGroupedModelList'
import { useModelWindowStore } from '../../store/modelWindow.store'

interface Props {
  value:    string                                // currently selected model id
  onChange: (modelId: string) => void
  disabled?: boolean
  /** Hide the live/fallback badge — useful when embedded somewhere already tight. */
  compact?: boolean
  /** Open the dropdown UPWARD (for pickers near the bottom of the screen, e.g. the chat composer). Default: downward. */
  openUp?: boolean
}

export function BankrModelPicker({ value, onChange, disabled, compact, openUp }: Props) {
  const { t } = useTranslation('chat')
  const [models, setModels]   = useState<BankrModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [stale, setStale]     = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.tachi.bankr.listModels({ force })
      if (!res.ok) {
        setError(res.error ?? t('bankr.loadError'))
        setModels([])
        return
      }
      setModels(res.models)
      // One source for the window (see modelWindow.store): what this list shows
      // is what the CTX chip and the send-time budget use.
      useModelWindowStore.getState().recordCatalogWindows('bankr-gateway', res.models)
      setStale(Boolean(res.stale))
      if (res.error) setError(res.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => { load() }, [load])
  // Re-pull on dropdown open so newly enabled models appear without a chat restart.
  useEffect(() => { if (open) load(true) }, [open, load])

  const selected = models.find(m => m.id === value)
  const currentLabel = selected?.label ?? value ?? t('picker.pickModel')

  // The `· 200k ctx` tail is resolved by TaskGroupedModelList from the window
  // recorded above — see VeniceModelPicker for why no picker formats its own.

  // Group by family for the dropdown layout — UNCHANGED, and still the default
  // view: the task filter is an extra axis above it, not a replacement.
  const familyGroups = useMemo<ModelGroup[]>(() => {
    const byFamily = models.reduce<Record<string, BankrModelInfo[]>>((acc, m) => {
      const k = m.family ?? 'Other'
      ;(acc[k] ??= []).push(m)
      return acc
    }, {})
    const familyOrder = ['Claude', 'GPT', 'Gemini', 'GLM', 'DeepSeek', 'Qwen', 'Mistral', 'Grok', 'Kimi', 'Llama', 'Other']
    // Render the known families in order, then ANY family the live catalog
    // introduced that isn't listed yet — so a brand-new Bankr family (a model
    // added gateway-side) is never silently dropped from the picker.
    const renderFamilies = [...familyOrder, ...Object.keys(byFamily).filter(k => !familyOrder.includes(k))]
    return renderFamilies
      .filter(f => (byFamily[f]?.length ?? 0) > 0)
      .map(f => ({
        key: f,
        label: f,
        models: byFamily[f].map(m => ({
          id: m.id,
          label: m.label,
          // EVIDENCE, live rows only — the gateway's own window is what makes
          // `long-context` provable rather than guessed from the id.
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
        title={t('bankr.pickTitle')}
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
                {t('bankr.loadingCatalog')}
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
              providerId="bankr-gateway"
              groups={familyGroups}
              value={value}
              listLabel={t('bankr.pickTitle')}
              onPick={(id) => { onChange(id); setOpen(false) }}
            />
          </div>
        </>
      )}
    </div>
  )
}
