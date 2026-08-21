// apps/desktop/src/pages/chat/VeniceModelPicker.tsx
//
// Brutalist dropdown listing Venice's text catalog. Mounts next to the
// ProviderPicker when 'venice' is the active chat provider (and reusable on the
// Agent page header). Pulls /api/v1/models?type=text live via
// window.tachi.venice.listModels — falls back to a curated catalog when no key
// is set or the API is unreachable. Grouped by family. Mirrors SurplusModelPicker.
//
// Venice is a STANDALONE provider — independent of Surplus.
import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { VeniceModelInfo } from '../../types/electron'
import { TaskGroupedModelList, type ModelGroup } from './TaskGroupedModelList'
import { useModelWindowStore } from '../../store/modelWindow.store'
import type { ModelCapability } from '@tachi/core/src/providers/registry'

interface Props {
  value:    string
  onChange: (modelId: string) => void
  disabled?: boolean
  compact?: boolean
  openUp?: boolean
}

export function VeniceModelPicker({ value, onChange, disabled, compact, openUp }: Props) {
  const { t } = useTranslation('chat')
  const [models, setModels]   = useState<VeniceModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [stale, setStale]     = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.tachi.venice.listModels({ force })
      if (!res.ok) {
        setError(res.error ?? t('venice.loadError'))
        setModels([])
        return
      }
      setModels(res.models)
      // Publish the windows Venice published, so the CTX chip and the smart-
      // attach decision answer with the SAME number this list prints. Rows that
      // carry none stay unknown everywhere (see modelWindow.store).
      useModelWindowStore.getState().recordCatalogWindows('venice', res.models)
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

  // Venice is the one picker that ships PER-MODEL capabilities: venice-service
  // builds `caps` from the API's own model_spec flags (supportsVision /
  // supportsFunctionCalling). Only 'vision' and 'tools' can cross into the
  // resolver — its LiveModelFacts type has no slot for Venice's 'code' or
  // 'reasoning' flags, and 'code' must NOT become the `coding` tag: that tag is
  // curated with a source and a date, and a boolean is neither.
  //
  // Forwarded ONLY when the row came from a live fetch (`m.live`). The static
  // fallback rows in venice-service carry hand-written caps, and the resolver
  // prints "the provider's own live catalog lists…" over whatever it is given.
  const liveCapsOf = (m: VeniceModelInfo): ModelCapability[] | undefined => {
    if (!m.live || !Array.isArray(m.caps)) return undefined
    const out = m.caps.filter((c): c is ModelCapability => c === 'vision' || c === 'tools')
    return out.length > 0 ? out : undefined
  }

  // The `· 200k ctx` tail is NOT built here any more: TaskGroupedModelList
  // resolves it from the window recorded above, through the same resolver the
  // chat chip and the CODE meter use. A picker that formatted its own fetched
  // number was the reason one screen could stay silent about a window another
  // screen was drawing a green zone from.
  const familyGroups = useMemo<ModelGroup[]>(() => {
    const byFamily = models.reduce<Record<string, VeniceModelInfo[]>>((acc, m) => {
      const k = m.family ?? 'Other'
      ;(acc[k] ??= []).push(m)
      return acc
    }, {})
    const familyOrder = ['GLM', 'Claude', 'Qwen', 'GPT', 'Llama', 'DeepSeek', 'Mistral', 'Gemini', 'Grok', 'Venice', 'Other']
    return familyOrder
      .filter(f => (byFamily[f]?.length ?? 0) > 0)
      .map(f => ({
        key: f,
        label: f,
        models: byFamily[f].map(m => ({
          id: m.id,
          label: m.label,
          capabilities: liveCapsOf(m),
          // Venice's own window, forwarded as EVIDENCE only for a live row —
          // it is what makes `long-context` provable for a Venice model rather
          // than left to a substring row that has no provider dimension.
          ...(m.live && typeof m.contextTokens === 'number' ? { contextTokens: m.contextTokens } : {}),
          // …and its own PRICE, same live-only rule. Venice publishes
          // `model_spec.pricing` already in $/M (its siblings publish per-token
          // strings, which is why the service does NOT multiply by 1e6 here —
          // copying that line would over-count a Venice run a millionfold).
          //
          // Without this the ledger got Venice's rates but the PICKER did not,
          // so 7 of the 9 fallback rows still showed no price band: the
          // user-facing path needs an exact rate row or a forwarded live one,
          // and Venice's ids (`zai-org-glm-4.7`, `openai-gpt-55`) match no
          // static row by design.
          ...(m.live && m.rates
            ? { pricing: { inUsdPerMTok: m.rates.inputPerM, outUsdPerMTok: m.rates.outputPerM } }
            : {}),
        })),
      }))
  }, [models])

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={t('venice.pickTitle')}
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
                {t('venice.loadingCatalog')}
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
              providerId="venice"
              groups={familyGroups}
              value={value}
              listLabel={t('venice.pickTitle')}
              onPick={(id) => { onChange(id); setOpen(false) }}
            />
          </div>
        </>
      )}
    </div>
  )
}
