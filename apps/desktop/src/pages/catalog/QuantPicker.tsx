// apps/desktop/src/pages/catalog/QuantPicker.tsx
import React, { useEffect } from 'react'
import type { CatalogEntry, QuantOption, HardwareProfile } from '@tachi/core'
// Direct subpath import — see note in CatalogPage.tsx (avoids pulling the
// node-only core barrel into the browser bundle).
import { estimateFit } from '@tachi/core/src/catalog/fit'
import { useTranslation } from 'react-i18next'

export function QuantPicker({
  entry, hw, onPick, onClose,
}: {
  entry: CatalogEntry
  hw: HardwareProfile | null
  onPick: (q: QuantOption) => void
  onClose: () => void
}) {
  const { t } = useTranslation('catalog')
  // aria-modal dialog contract: Escape must dismiss (backdrop click alone
  // strands keyboard users — found by the release-readiness a11y pass).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label={entry.name} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--bg-base)', border: 'var(--border-width) solid var(--border)',
        padding: 16, minWidth: 360, boxShadow: 'var(--shadow-hard)',
        fontFamily: 'JetBrains Mono, monospace',
      }}>
        <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-primary)' }}>{entry.name}</div>
        <div style={{ marginBottom: 12, color: 'var(--text-muted)', fontSize: 11 }}>{t('chooseQuant')}</div>
        {[...entry.quants].sort((a, b) => a.sizeBytes - b.sizeBytes).map(q => {
          const fit = hw ? estimateFit({ sizeBytes: q.sizeBytes, hardware: hw }) : null
          const size = q.sizeBytes > 0 ? `${(q.sizeBytes / (1024 ** 3)).toFixed(1)} GB` : '—'
          return (
            <button key={`${q.runtime}:${q.ref}:${q.label}`} onClick={() => onPick(q)} style={{
              display: 'flex', justifyContent: 'space-between', gap: 12, width: '100%',
              padding: '8px 10px', marginBottom: 6,
              border: `var(--border-width) solid ${q.recommended ? 'var(--accent)' : 'var(--border)'}`,
              background: 'transparent',
              color: 'var(--text-primary)', cursor: 'pointer', fontSize: 11, textAlign: 'left',
            }}>
              <span>{q.label} · {q.runtime} · {size}{q.recommended ? ` · ${t('recommended')}` : ''}</span>
              <span style={{ whiteSpace: 'nowrap' }}>{fit ? t(`fit.${fit.verdict}`) : ''}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
