// apps/desktop/src/pages/chat/CustomModelPicker.tsx
//
// Model dropdown for a USER-ADDED custom OpenAI-compatible endpoint (USER-PAINS
// T17). Mounts next to the ProviderPicker when the active chat provider is a
// `custom:<id>` endpoint. Fetches the endpoint's own catalog live via
// window.tachi.provider.listCustomModels (60s main-process cache) and FAILS OPEN
// to a manual model text input — so an endpoint whose /models 404s (or returns
// nothing) is still usable by typing the model id. Mirrors VeniceModelPicker's
// brutalist idiom.
import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { TaskGroupedModelList, type ModelGroup } from './TaskGroupedModelList'

interface Props {
  /** `custom:<settingsId>` provider id of the active endpoint. */
  providerId: string
  value: string
  onChange: (modelId: string) => void
  disabled?: boolean
  openUp?: boolean
}

export function CustomModelPicker({ providerId, value, onChange, disabled, openUp }: Props) {
  const { t } = useTranslation('chat')
  const [models, setModels]   = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)
  const [manual, setManual]   = useState('')

  const load = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.tachi.provider.listCustomModels(providerId, force)
      if (!res.ok) {
        setError(res.error ?? t('customEndpoint.loadError', { defaultValue: 'Could not load models' }))
        setModels([])
        return
      }
      setModels(res.models)
      if (res.models.length === 0) {
        setError(t('customEndpoint.noModels', { defaultValue: 'Endpoint returned no models — type a model id below.' }))
      } else if ((!value || value === 'auto') && res.models[0]) {
        // Give a working default so the first send doesn't ship model:'auto'.
        onChange(res.models[0])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setModels([])
    } finally {
      setLoading(false)
    }
  }, [providerId, t, value, onChange])

  // Reset when the endpoint changes; (re)fetch each time the dropdown opens.
  useEffect(() => { setModels([]); setError(null) }, [providerId])
  useEffect(() => { if (open) load(true) }, [open, load])

  const currentLabel = value && value !== 'auto' ? value : t('picker.pickModel')

  // A custom endpoint publishes bare ids and no families, so it has ONE
  // unlabelled group — the task filter above it is the only grouping there is.
  // Whatever the resolver can still prove about a well-known id served from a
  // private endpoint (tool support, context size, an exact price row) shows up;
  // an id it has never seen shows nothing, which is the correct answer.
  const groups = useMemo<ModelGroup[]>(
    () => (models.length === 0 ? [] : [{ key: 'all', label: '', models: models.map(m => ({ id: m, label: m })) }]),
    [models],
  )

  const submitManual = () => {
    const m = manual.trim()
    if (!m) return
    onChange(m)
    setManual('')
    setOpen(false)
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={t('customEndpoint.pickTitle', { defaultValue: 'Pick or type a model for this endpoint' })}
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
            {/* Manual model entry — always available (fail-open path). */}
            <div style={{
              display: 'flex', gap: 6, padding: '8px 10px',
              borderBottom: '2px solid var(--border)', background: 'var(--bg-elevated)',
            }}>
              <input
                value={manual}
                onChange={e => setManual(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitManual() } }}
                placeholder={t('customEndpoint.modelPlaceholder', { defaultValue: 'type a model id…' })}
                style={{
                  flex: 1, padding: '4px 6px', fontSize: 10,
                  border: '2px solid var(--border)', background: 'var(--bg-base)',
                  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', outline: 'none',
                }}
              />
              <button
                onClick={submitManual}
                disabled={!manual.trim()}
                style={{
                  fontSize: 9, fontWeight: 700, padding: '4px 10px',
                  border: '2px solid var(--border)', background: 'var(--accent)', color: '#fff',
                  cursor: manual.trim() ? 'pointer' : 'not-allowed', opacity: manual.trim() ? 1 : 0.5,
                  fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.06em',
                }}
              >{t('customEndpoint.useModel', { defaultValue: 'Use' })}</button>
            </div>

            {loading && models.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-dim)' }}>
                {t('customEndpoint.loadingCatalog', { defaultValue: 'Loading models…' })}
              </div>
            )}

            {error && (
              <div style={{
                padding: '6px 10px', fontSize: 9, color: 'var(--warning)',
                background: 'var(--bg-inset)', borderBottom: 'var(--border-width) solid var(--border)',
                lineHeight: 1.4,
              }}>
                {error}
              </div>
            )}

            {groups.length > 0 && (
              <TaskGroupedModelList
                providerId={providerId}
                groups={groups}
                value={value}
                listLabel={t('customEndpoint.pickTitle', { defaultValue: 'Pick or type a model for this endpoint' })}
                onPick={(id) => { onChange(id); setOpen(false) }}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
