// apps/desktop/src/pages/chat/OllamaModelPicker.tsx
//
// Brutalist dropdown showing the user's pulled Ollama models. Mounts next to
// the provider picker when the active conversation is using ollama-local.
// On first open it auto-starts Ollama via the main process (zero terminal).
import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { OllamaModelInfo } from '../../types/electron'
// Direct subpath import — same idiom as pages/catalog/ModelCard.tsx (avoids
// pulling the node-only core barrel into the browser bundle).
import { estimateFit } from '@tachi/core/src/catalog/fit'
import type { HardwareProfile, FitVerdict } from '@tachi/core'

interface Props {
  value:    string                                // currently selected model (or 'auto')
  onChange: (model: string) => void
  disabled?: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

// ── Local-model fit pill (UX #2) ─────────────────────────────────────────────
// Same brutalist verdict pill the Catalog model cards render — labels/colors
// copied from pages/catalog (localFit LABELS + fitBadgeColor), driven by the
// core estimateFit heuristic against the live hardware snapshot.
const FIT_PILL_COLOR: Record<FitVerdict, string> = {
  'gpu':     'var(--accent)',
  'cpu':     'var(--text-muted)',
  'tight':   'var(--border-strong)',
  'too-big': 'var(--danger, var(--border-strong))',
}
const FIT_PILL_KEY: Record<FitVerdict, string> = {
  'gpu': 'gpu', 'cpu': 'cpu', 'tight': 'tight', 'too-big': 'tooBig',
}

function FitPill({ verdict }: { verdict: FitVerdict }) {
  const { t } = useTranslation('chat')
  return (
    <span
      title={t(`fitPill.${FIT_PILL_KEY[verdict]}Title`)}
      style={{
        padding: '1px 6px',
        border: `var(--border-width) solid ${FIT_PILL_COLOR[verdict]}`,
        color: FIT_PILL_COLOR[verdict],
        fontSize: 10, fontWeight: 700, letterSpacing: 0.5, whiteSpace: 'nowrap',
      }}
    >{t(`fitPill.${FIT_PILL_KEY[verdict]}`)}</span>
  )
}

export function OllamaModelPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation('chat')
  const [models, setModels]   = useState<OllamaModelInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)
  // Hardware snapshot for the fit pill (same source the Catalog tab uses).
  // Null = undetectable → pills silently don't render.
  const [hw, setHw]           = useState<HardwareProfile | null>(null)
  useEffect(() => {
    window.tachi.catalog.hardware().then(setHw).catch(() => setHw(null))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Auto-start Ollama if needed, then list models. The IPC handles both.
      const res = await window.tachi.ollama.listModels()
      if (!res.ok) {
        setError(res.error ?? t('ollama.notAvailable'))
        setModels([])
      } else {
        setModels(res.models)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  // Reload when dropdown opens so the user sees any newly pulled models.
  useEffect(() => {
    if (open) load()
  }, [open, load])

  const currentLabel = value === 'auto' || !value
    ? (models[0]?.name ? `auto (${models[0].name})` : 'auto')
    : value

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={t('ollama.pickTitle')}
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
          maxWidth: 240,
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
            role="listbox"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 4px)',
              left: 0,
              minWidth: 280,
              maxHeight: 320,
              overflowY: 'auto',
              border: '2px solid var(--border)',
              background: 'var(--bg-surface)',
              boxShadow: 'var(--shadow-hard, 4px 4px 0 var(--border))',
              zIndex: 10,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* Auto option */}
            <button
              role="option"
              aria-selected={value === 'auto' || !value}
              onClick={() => { onChange('auto'); setOpen(false) }}
              style={{
                textAlign: 'left',
                padding: '8px 12px',
                border: 'none',
                borderBottom: 'var(--border-width) solid var(--border)',
                background: value === 'auto' || !value ? 'var(--accent-muted)' : 'transparent',
                color: 'var(--text-primary)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              <span style={{ fontWeight: value === 'auto' || !value ? 700 : 500 }}>
                auto
              </span>
              <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                {t('ollama.firstInstalled')}
              </span>
            </button>

            {loading && (
              <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-dim)' }}>
                {t('ollama.probing')}
              </div>
            )}

            {error && !loading && (
              <div style={{
                padding: '8px 12px',
                fontSize: 10,
                color: 'var(--warning, #f59e0b)',
                background: 'var(--bg-inset)',
                borderBottom: 'var(--border-width) solid var(--border)',
                lineHeight: 1.4,
              }}>
                {error}
              </div>
            )}

            {!loading && !error && models.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                {t('ollama.noModelsPrefix')}{' '}
                <code style={{ fontFamily: 'JetBrains Mono, monospace', color: 'var(--text-primary)' }}>ollama pull llama3.2</code>{' '}
                {t('ollama.noModelsSuffix')}
              </div>
            )}

            {!loading && models.map(m => {
              const selected = m.name === value
              // Fit pill for EVERY pulled model — `size` is the real blob size
              // Ollama's own list API reports, so this never depends on the
              // curated registry (custom / community pulls get a pill too).
              const fit = hw && m.size > 0 ? estimateFit({ sizeBytes: m.size, hardware: hw }) : null
              return (
                <button
                  key={m.name}
                  role="option"
                  aria-selected={selected}
                  onClick={() => { onChange(m.name); setOpen(false) }}
                  style={{
                    textAlign: 'left',
                    padding: '8px 12px',
                    border: 'none',
                    borderBottom: 'var(--border-width) solid var(--border)',
                    background: selected ? 'var(--accent-muted)' : 'transparent',
                    color: 'var(--text-primary)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: selected ? 700 : 500 }}>{m.name}</span>
                    {fit && <FitPill verdict={fit.verdict} />}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                    {formatSize(m.size)}
                    {m.details?.parameter_size && ` · ${m.details.parameter_size}`}
                    {m.details?.quantization_level && ` · ${m.details.quantization_level}`}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
