// apps/desktop/src/pages/chat/OpenRouterModelPicker.tsx
//
// Brutalist dropdown listing OpenRouter's LIVE catalog with the per-model FREE
// affordance. Mounts next to the ProviderPicker when 'openrouter-oauth' is the
// active chat provider. The `free` flag on each row comes from the live
// catalog's pricing (prompt AND completion exactly 0 — openrouter-service.ts);
// it is NEVER derived from the `:free` id suffix, and the provider stays
// billing 'paid' in the registry because 322 of its 336 models are paid.
//
// Free rows carry a FREE badge and the group header states the measured tier
// limits from OpenRouter's own docs: 20 requests/min, 50 requests/day without
// purchased credits (1000/day with ≥$10 credits) — quoted in
// docs/app/FREE-FLEET-SWEEP-2026-08-01.md §3. No throughput promises beyond that.
import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { OpenRouterModelInfo } from '../../types/electron'
import { TaskGroupedModelList, type ModelGroup, type PickableModel } from './TaskGroupedModelList'
import { useModelWindowStore } from '../../store/modelWindow.store'

interface Props {
  value:    string
  onChange: (modelId: string) => void
  disabled?: boolean
  compact?: boolean
  openUp?: boolean
}

export function OpenRouterModelPicker({ value, onChange, disabled, compact, openUp }: Props) {
  const { t } = useTranslation('chat')
  const [models, setModels]   = useState<OpenRouterModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [stale, setStale]     = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.tachi.openrouter.listModels({ force })
      if (!res.ok) {
        setError(res.error ?? t('openrouterPicker.loadError'))
        setModels([])
        return
      }
      setModels(res.models)
      // The "· 1049k ctx" suffix below and the composer's CTX chip must never
      // disagree again: both read this recording (see modelWindow.store). Kimi
      // K3 printed 1049k here while the chip claimed 128,000 for every
      // OpenRouter model, because the chip had a per-PROVIDER constant.
      useModelWindowStore.getState().recordCatalogWindows('openrouter-oauth', res.models)
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

  // Service pre-sorts: auto first, then free rows, then paid.
  const freeModels = models.filter(m => m.free)
  const paidModels = models.filter(m => !m.free && m.id !== 'openrouter/auto')
  const autoModel  = models.find(m => m.id === 'openrouter/auto')

  const FreeBadge = () => (
    <span style={{
      padding: '0 4px', border: '2px solid var(--success)', color: 'var(--success)',
      fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      lineHeight: 1.4, flexShrink: 0,
    }}>{t('openrouterPicker.freeBadge')}</span>
  )

  // LIVE FACTS, forwarded only for rows that really came from the live catalog.
  // `free` on an OpenRouter row means the catalog priced prompt AND completion
  // at exactly 0 (openrouter-service.ts) — the same fact the resolver's
  // strongest free-evidence branch reads, so handing it over restates the
  // measurement rather than adding a claim.
  //
  // 2026-08-02: the PAID rows now carry their live rate too. Previously only the
  // $0 rows forwarded a price, so 281 of 337 rows showed no band at all — not
  // because the price was unknown, but because the service kept a boolean and
  // discarded the numbers it was derived from. The resolver is right to refuse
  // the static table's keyword fallback for a user-facing claim; the fix was to
  // give it the real per-model number, which OpenRouter publishes for every row.
  //
  // `m.rates` is absent when a row's price did not parse, and then nothing is
  // forwarded and the row shows no band — the same refusal as before, now
  // reserved for genuine ignorance.
  const toPickable = (m: OpenRouterModelInfo): PickableModel => ({
    id: m.id,
    label: m.label,
    ...(m.live && typeof m.contextTokens === 'number' ? { contextTokens: m.contextTokens } : {}),
    ...(m.live && m.free
      ? { pricing: { inUsdPerMTok: 0, outUsdPerMTok: 0 } }
      : m.live && m.rates
        ? { pricing: { inUsdPerMTok: m.rates.inputPerM, outUsdPerMTok: m.rates.outputPerM } }
        : {}),
  })

  // The "· 128k ctx" suffix is resolved by TaskGroupedModelList from the window
  // recorded above — see VeniceModelPicker for why no picker formats its own.

  // OpenRouter has no family field, so its DEFAULT view is the free/paid split
  // it already shipped — handed to the shared list as its groups so the task
  // filter is additive here exactly as it is over the family pickers.
  const groups = useMemo<ModelGroup[]>(() => {
    const out: ModelGroup[] = []
    if (autoModel) out.push({ key: 'auto', label: '', models: [toPickable(autoModel)] })
    if (freeModels.length > 0) {
      out.push({
        key: 'free',
        label: t('openrouterPicker.freeGroup', { count: freeModels.length }),
        models: freeModels.map(toPickable),
        // Measured tier limits, from their docs — stated where the free rows
        // are picked, so "free" is never oversold.
        note: (
          <div style={{
            padding: '4px 10px',
            fontSize: 9,
            color: 'var(--text-dim)',
            background: 'var(--bg-inset)',
            borderBottom: 'var(--border-width) solid var(--border)',
            lineHeight: 1.4,
          }}>
            {t('openrouterPicker.freeLimits')}
          </div>
        ),
      })
    }
    if (paidModels.length > 0) {
      out.push({
        key: 'paid',
        label: t('openrouterPicker.paidGroup', { count: paidModels.length }),
        models: paidModels.map(toPickable),
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, t])

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={t('openrouterPicker.pickTitle')}
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
        {selected?.free && <FreeBadge />}
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
              minWidth: 340,
              maxHeight: 400,
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
                {t('openrouterPicker.loadingCatalog')}
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
              providerId="openrouter-oauth"
              groups={groups}
              value={value}
              listLabel={t('openrouterPicker.pickTitle')}
              onPick={(id) => { onChange(id); setOpen(false) }}
            />
          </div>
        </>
      )}
    </div>
  )
}
