// apps/desktop/src/pages/chat/SurplusMediaModelPicker.tsx
//
// Brutalist dropdown listing Surplus Intelligence's MEDIA catalog (image / tts /
// stt / video / music). Mounts next to the text SurplusModelPicker in the chat
// composer so a Surplus chat can switch between text and media models. Pulls the
// classified catalog via window.tachi.surplusMedia.listModels and groups by
// modality. Empty list => no key / fetch failed (no curated media fallback).
import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { SurplusMediaModelInfo, SurplusMediaModality } from '../../types/electron'

interface Props {
  value:    string
  onChange: (modelId: string, modality: SurplusMediaModality) => void
  disabled?: boolean
  openUp?:  boolean
}

// Order media modalities for a stable scan. Embedding/text excluded (not chat media).
const MODALITY_ORDER: SurplusMediaModality[] = ['image', 'video', 'music', 'tts', 'stt']

export function SurplusMediaModelPicker({ value, onChange, disabled, openUp }: Props) {
  const { t } = useTranslation('chat')
  const [models, setModels]   = useState<SurplusMediaModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.tachi.surplusMedia.listModels({ force })
      if (!res.ok) {
        setError(res.error ?? t('surplusMedia.loadError'))
        setModels([])
        return
      }
      // Drop text/embedding — chat media composer only handles generatable media.
      setModels(res.models.filter(m => MODALITY_ORDER.includes(m.modality)))
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
  const currentLabel = selected?.label ?? t('surplusMedia.pickModel')

  const groups = models.reduce<Record<string, SurplusMediaModelInfo[]>>((acc, m) => {
    (acc[m.modality] ??= []).push(m)
    return acc
  }, {})

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={t('surplusMedia.pickTitle')}
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
        <span style={{ color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('surplusMedia.mediaLabel')}</span>
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
            role="listbox"
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
                {t('surplusMedia.loadingCatalog')}
              </div>
            )}

            {!loading && models.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--warning)', lineHeight: 1.4 }}>
                {error ?? t('surplusMedia.noModels')}
              </div>
            )}

            {MODALITY_ORDER.map(modality => {
              const items = groups[modality]
              if (!items || items.length === 0) return null
              return (
                <div key={modality}>
                  <div style={{
                    padding: '4px 10px',
                    fontSize: 8,
                    color: 'var(--text-dim)',
                    background: 'var(--bg-elevated)',
                    borderBottom: 'var(--border-width) solid var(--border)',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    fontWeight: 700,
                  }}>
                    {t(`surplusMedia.modality.${modality}`)}
                  </div>
                  {items.map(m => {
                    const isSelected = m.id === value
                    return (
                      <button
                        key={m.id}
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => { onChange(m.id, m.modality); setOpen(false) }}
                        style={{
                          textAlign: 'left',
                          padding: '8px 12px',
                          border: 'none',
                          borderBottom: 'var(--border-width) solid var(--border)',
                          background: isSelected ? 'var(--accent-muted)' : 'transparent',
                          color: 'var(--text-primary)',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 11,
                          cursor: 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                          width: '100%',
                        }}
                      >
                        <span style={{ fontWeight: isSelected ? 700 : 500 }}>{m.label}</span>
                        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{m.id}</span>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
