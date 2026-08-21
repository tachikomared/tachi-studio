// apps/desktop/src/pages/chat/ImgnaiModelPicker.tsx
//
// Brutalist dropdown listing the imgnAI Katana TEXT catalog. Mounts next to
// the ProviderPicker when 'imgnai' is the active chat provider (and reusable
// on the Agent page header). Pulls kat.imgnai.com /v1/models live via the
// generic window.tachi.provider.listModels('imgnai') (the endpoint answers
// even keyless) — falls back to the curated catalog when unreachable.
// Grouped by family. Mirrors VeniceModelPicker.
import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { TaskGroupedModelList, type ModelGroup } from './TaskGroupedModelList'

interface ImgnaiModel {
  id:     string
  label:  string
  family: string
}

interface Props {
  value:    string
  onChange: (modelId: string) => void
  disabled?: boolean
  compact?: boolean
  openUp?: boolean
}

const familyOf = (id: string): string => {
  const l = id.toLowerCase()
  if (l.startsWith('glm'))      return 'GLM'
  if (l.startsWith('gpt'))      return 'GPT'
  if (l.startsWith('grok'))     return 'Grok'
  if (l.startsWith('deepseek')) return 'DeepSeek'
  if (l.startsWith('claude'))   return 'Claude'
  if (l.startsWith('q-naifu'))  return 'Q'
  return 'Other'
}

// Curated fallback — mirrors useProviderModels.STATIC_MODELS['imgnai'] so the
// picker is never empty even fully offline.
const STATIC_IDS = [
  'glm-5-2', 'q-naifu-a3b', 'gpt-5-6-luna', 'gpt-5-6-sol', 'gpt-5-6-terra',
  'grok-4-5', 'deepseek-v4-flash', 'deepseek-v4-pro', 'claude-fable-5', 'claude-opus-4-8',
]
const STATIC_MODELS: ImgnaiModel[] = STATIC_IDS.map(id => ({ id, label: id, family: familyOf(id) }))

export function ImgnaiModelPicker({ value, onChange, disabled, compact, openUp }: Props) {
  const { t } = useTranslation('chat')
  const [models, setModels]   = useState<ImgnaiModel[]>(STATIC_MODELS)
  const [loading, setLoading] = useState(false)
  const [stale, setStale]     = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // ModelInfo[] straight from the discovery surface (no {ok} envelope).
      const r = await (window.tachi.provider?.listModels?.('imgnai') ?? Promise.resolve(null))
      if (Array.isArray(r) && r.length > 0) {
        setModels(r.map((m: { id: string; displayName?: string }) => ({
          id: m.id, label: m.displayName || m.id, family: familyOf(m.id),
        })))
        setStale(false)
      } else {
        setModels(STATIC_MODELS)
        setStale(true)
      }
    } catch (err) {
      setModels(STATIC_MODELS)
      setStale(true)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (open) load() }, [open, load])

  const selected = models.find(m => m.id === value)
  const currentLabel = selected?.label ?? value ?? t('picker.pickModel')

  // Family grouping stays the DEFAULT view; the task filter sits above it.
  const familyGroups = useMemo<ModelGroup[]>(() => {
    const byFamily = models.reduce<Record<string, ImgnaiModel[]>>((acc, m) => {
      ;(acc[m.family] ??= []).push(m)
      return acc
    }, {})
    const familyOrder = ['GLM', 'GPT', 'Grok', 'DeepSeek', 'Claude', 'Q', 'Other']
    return familyOrder
      .filter(f => (byFamily[f]?.length ?? 0) > 0)
      .map(f => ({ key: f, label: f, models: byFamily[f].map(m => ({ id: m.id, label: m.label })) }))
  }, [models])

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={t('imgnai.pickTitle')}
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
                {t('imgnai.loadingCatalog')}
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
              providerId="imgnai"
              groups={familyGroups}
              value={value}
              listLabel={t('imgnai.pickTitle')}
              onPick={(id) => { onChange(id); setOpen(false) }}
            />
          </div>
        </>
      )}
    </div>
  )
}
