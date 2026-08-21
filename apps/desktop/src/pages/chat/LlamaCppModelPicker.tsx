// apps/desktop/src/pages/chat/LlamaCppModelPicker.tsx
//
// Brutalist dropdown of the GGUF models downloaded for llama.cpp. Mounts next
// to the provider picker when the active conversation uses llama-cpp. Picking a
// model STARTS it in llama-server (one model is loaded at a time), so the chat
// talks to it immediately — no trip to the Catalog/Status page needed.
import React, { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
// Direct subpath import — same idiom as pages/catalog/ModelCard.tsx (avoids
// pulling the node-only core barrel into the browser bundle).
import { estimateFit } from '@tachi/core/src/catalog/fit'
import type { HardwareProfile, FitVerdict } from '@tachi/core'
import { resolveGgufSizeBytes, diskSizesFromInstalled } from './fitPillSize'
import { modelDisplayName } from '../../utils/model-display'

interface Props {
  value: string                       // current modelId (or 'auto')
  onChange: (modelId: string) => void
  disabled?: boolean
}

interface GgufModelLite { id: string; label: string; sizeMb?: number }
interface LlamaStatus { state?: string; modelId?: string; installed?: boolean; downloadedModels?: string[] }

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

function FitPill({ verdict, fromDisk }: { verdict: FitVerdict; fromDisk?: boolean }) {
  const { t } = useTranslation('chat')
  // Disk-derived sizes (HF-searched GGUFs absent from the curated registry)
  // disclose the source in the tooltip so the verdict is honestly qualified.
  const title = t(`fitPill.${FIT_PILL_KEY[verdict]}Title`)
    + (fromDisk ? ` — ${t('fitPill.sizeFromDiskTitle')}` : '')
  return (
    <span
      title={title}
      style={{
        padding: '1px 6px',
        border: `var(--border-width) solid ${FIT_PILL_COLOR[verdict]}`,
        color: FIT_PILL_COLOR[verdict],
        fontSize: 10, fontWeight: 700, letterSpacing: 0.5, whiteSpace: 'nowrap',
      }}
    >{t(`fitPill.${FIT_PILL_KEY[verdict]}`)}</span>
  )
}

export function LlamaCppModelPicker({ value, onChange, disabled }: Props) {
  const { t } = useTranslation('chat')
  const [downloaded, setDownloaded] = useState<string[]>([])
  const [labels, setLabels]         = useState<Record<string, string>>({})
  const [sizesMb, setSizesMb]       = useState<Record<string, number>>({})
  // REAL on-disk byte sizes from catalog:installed — covers HF-searched GGUFs
  // that the curated registry (sizesMb) knows nothing about.
  const [diskSizes, setDiskSizes]   = useState<Record<string, number>>({})
  const [status, setStatus]         = useState<LlamaStatus>({})
  const [open, setOpen]             = useState(false)
  const [busy, setBusy]             = useState(false)
  const [error, setError]           = useState<string | null>(null)
  // Hardware snapshot for the fit pill (same source the Catalog tab uses).
  // Null = undetectable → pills silently don't render.
  const [hw, setHw]                 = useState<HardwareProfile | null>(null)
  useEffect(() => {
    window.tachi.catalog.hardware().then(setHw).catch(() => setHw(null))
  }, [])

  const load = useCallback(async () => {
    try {
      const [st, cat, inst] = await Promise.all([
        window.tachi.llamaCpp.status() as Promise<LlamaStatus>,
        window.tachi.llamaCpp.catalog() as Promise<{ models: GgufModelLite[] }>,
        // On-disk sizes for non-curated GGUFs. Best-effort: an older main build
        // without the surface just leaves the disk-size map empty.
        window.tachi.catalog.installed().catch(() => null),
      ])
      setStatus(st ?? {})
      setDownloaded(st?.downloadedModels ?? [])
      const map: Record<string, string> = {}
      const sizes: Record<string, number> = {}
      for (const m of cat?.models ?? []) {
        map[m.id] = m.label
        if (typeof m.sizeMb === 'number' && m.sizeMb > 0) sizes[m.id] = m.sizeMb
      }
      setLabels(map)
      setSizesMb(sizes)
      setDiskSizes(diskSizesFromInstalled(inst?.models))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (open) load() }, [open, load])

  // Curated catalog label when known; otherwise a humanized gguf name — the
  // raw "hf_..._iq3_m.gguf" filename must never be the primary UI copy.
  const label = (id?: string) => (id ? (labels[id] ?? modelDisplayName(id)) : null)

  async function pick(modelId: string) {
    setOpen(false)
    setBusy(true)
    setError(null)
    try {
      const res = await window.tachi.llamaCpp.start({ modelId }) as { ok?: boolean; error?: string }
      if (res && res.ok === false) setError(res.error ?? t('llamaCpp.startFailed'))
      else onChange(modelId)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runningId = status.modelId
  const running = status.state === 'running' || status.state === 'loading'
  const currentLabel = busy
    ? t('llamaCpp.loading')
    : running && runningId
      ? `${label(runningId)}${status.state === 'loading' ? ` ${t('llamaCpp.loadingParen')}` : ''}`
      : t('llamaCpp.selectModel')

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(o => !o)}
        disabled={disabled}
        title={t('llamaCpp.pickTitle')}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          padding: '3px 10px', border: '2px solid var(--border)',
          background: 'var(--bg-elevated)', color: 'var(--text-primary)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 600,
          letterSpacing: '0.04em', cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1, display: 'inline-flex', alignItems: 'center',
          gap: 6, boxShadow: 'none', maxWidth: 260, overflow: 'hidden', whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: 'var(--text-dim)', textTransform: 'uppercase' }}>{t('picker.modelLabel')}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentLabel}</span>
        <span style={{ color: 'var(--text-dim)', fontSize: 8 }}>▾</span>
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9, background: 'transparent' }} />
          <div
            role="listbox"
            style={{
              position: 'absolute', bottom: 'calc(100% + 4px)', left: 0,
              minWidth: 280, maxHeight: 320, overflowY: 'auto',
              border: '2px solid var(--border)', background: 'var(--bg-surface)',
              boxShadow: 'var(--shadow-hard, 4px 4px 0 var(--border))', zIndex: 10,
              display: 'flex', flexDirection: 'column',
            }}
          >
            {error && (
              <div style={{
                padding: '8px 12px', fontSize: 10, color: 'var(--warning, #f59e0b)',
                background: 'var(--bg-inset)', borderBottom: 'var(--border-width) solid var(--border)', lineHeight: 1.4,
              }}>{error}</div>
            )}

            {downloaded.length === 0 && (
              <div style={{ padding: '8px 12px', fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                {t('llamaCpp.noModelsPrefix')} <b style={{ color: 'var(--text-primary)' }}>{t('llamaCpp.noModelsLink')}</b>.
              </div>
            )}

            {downloaded.map(id => {
              const selected = id === runningId
              // Fit pill for EVERY model with a known size: curated registry
              // estimate first, REAL on-disk file size otherwise (HF-searched
              // GGUFs aren't in the curated catalog — the pill used to vanish
              // for them). Same estimateFit call either way.
              const size = resolveGgufSizeBytes(sizesMb[id], diskSizes[id])
              const fit = hw && size
                ? estimateFit({ sizeBytes: size.sizeBytes, hardware: hw })
                : null
              return (
                <button
                  key={id}
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(id)}
                  style={{
                    textAlign: 'left', padding: '8px 12px', border: 'none',
                    borderBottom: 'var(--border-width) solid var(--border)',
                    background: selected ? 'var(--accent-muted)' : 'transparent',
                    color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2,
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: selected ? 700 : 500 }}>{label(id)}</span>
                    {fit && size && <FitPill verdict={fit.verdict} fromDisk={size.fromDisk} />}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                    {selected ? (status.state === 'loading' ? t('llamaCpp.loading') : t('llamaCpp.running')) : t('llamaCpp.clickToLoad')}
                    {size ? ` · ${formatSize(size.sizeBytes)}` : ''}
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
