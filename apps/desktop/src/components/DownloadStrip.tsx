// apps/desktop/src/components/DownloadStrip.tsx
//
// PERSISTENT DOWNLOAD STRIP (UX-benchmark #11) — a compact row-per-download
// surface in the bottom console dock, visible from ANY tab while a model
// download is active / paused / failed. Collapses to nothing when idle.
//
// Per item: name · progress bar · % · MB/s · PAUSE/RESUME/RETRY · ✕.
// Backed by the main-process download manager (HTTP Range resume, disk
// preflight, sha256/size verification); this component is render-only —
// every action is one IPC call and truth comes back on the broadcast.

import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useDownloadsStore } from '../store/downloads.store'
import type { DownloadItemInfo } from '../types/electron'

const MONO = 'JetBrains Mono, monospace'

function fmtMb(bytes: number): string {
  return (bytes / 1_048_576).toFixed(bytes >= 10 * 1_048_576 ? 0 : 1)
}

function fmtSpeed(bps: number): string {
  return `${(bps / 1_048_576).toFixed(1)} MB/s`
}

const btnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid var(--border)',
  color: 'var(--text-muted)',
  fontFamily: MONO,
  fontSize: 9,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '1px 6px',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: '14px',
}

function Row({ item }: { item: DownloadItemInfo }) {
  const { t } = useTranslation('common')
  const s = useDownloadsStore.getState()

  const active = item.state === 'active' || item.state === 'queued'
  const showBar = item.state !== 'error'
  const pct = item.percent

  const stateLabel =
    item.state === 'paused' ? t('downloads.paused')
    : item.state === 'queued' ? t('downloads.queued')
    : item.state === 'verifying' ? t('downloads.verifying')
    : item.state === 'done' ? t('downloads.done')
    : item.state === 'error' ? t('downloads.error')
    : null

  let doneNote: string | null = null
  if (item.state === 'done') {
    if (item.verified === 'sha256') doneNote = t('downloads.verifiedSha')
    else if (item.verified === 'size') doneNote = t('downloads.verifiedSize')
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, height: 22 }}>
      <span
        title={item.name}
        style={{
          fontFamily: MONO, fontSize: 10, letterSpacing: '0.04em', textTransform: 'uppercase',
          color: item.state === 'error' ? 'var(--danger)' : 'var(--text-primary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          flexShrink: 1, minWidth: 60, maxWidth: 220,
        }}
      >
        {item.name}
      </span>

      {showBar && (
        <div style={{ flex: 1, minWidth: 40, height: 8, border: '1px solid var(--border)', position: 'relative' }}>
          <div
            style={{
              position: 'absolute', inset: 0,
              width: pct >= 0 ? `${pct}%` : '100%',
              background: item.state === 'done' ? 'var(--success)' : 'var(--accent)',
              opacity: item.state === 'paused' ? 0.35 : pct >= 0 ? 1 : 0.25,
              transition: 'width 0.25s linear',
            }}
          />
        </div>
      )}

      <span style={{ fontFamily: MONO, fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {item.state === 'error'
          ? <span title={item.error} style={{ color: 'var(--danger)', maxWidth: 320, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }}>{item.error ?? t('downloads.error')}</span>
          : (
            <>
              {pct >= 0 ? `${pct}%` : `${fmtMb(item.receivedBytes)} MB`}
              {item.totalBytes > 0 && ` · ${fmtMb(item.receivedBytes)}/${fmtMb(item.totalBytes)} MB`}
              {active && item.speedBytesPerSec > 0 && ` · ${fmtSpeed(item.speedBytesPerSec)}`}
              {doneNote && ` · ${doneNote}`}
            </>
          )}
      </span>

      {stateLabel && item.state !== 'done' && item.state !== 'error' && (
        <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', opacity: 0.7, flexShrink: 0 }}>
          {stateLabel}
        </span>
      )}

      {active && (
        <button style={btnStyle} onClick={() => { void s.pause(item.id) }}>{t('downloads.pause')}</button>
      )}
      {item.state === 'paused' && (
        <button style={{ ...btnStyle, color: 'var(--text-primary)' }} onClick={() => { void s.resume(item.id) }}>{t('downloads.resume')}</button>
      )}
      {item.state === 'error' && (
        <button style={{ ...btnStyle, color: 'var(--text-primary)' }} onClick={() => { void s.resume(item.id) }}>{t('downloads.retry')}</button>
      )}
      {(active || item.state === 'paused') && (
        <button
          style={btnStyle}
          title={t('downloads.cancel')}
          onClick={() => { void s.cancel(item.id) }}
        >✕</button>
      )}
      {(item.state === 'done' || item.state === 'error') && (
        <button
          style={btnStyle}
          title={t('downloads.dismiss')}
          onClick={() => { void s.dismiss(item.id) }}
        >✕</button>
      )}
    </div>
  )
}

export function DownloadStrip() {
  const { t } = useTranslation('common')
  const items = useDownloadsStore((st) => st.items)

  useEffect(() => useDownloadsStore.getState().init(), [])

  if (items.length === 0) return null

  return (
    <div style={{
      borderBottom: 'var(--border-width) solid var(--border)',
      background: 'var(--bg-surface)',
      padding: '3px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', opacity: 0.6 }}>
          {t('downloads.title')}
        </span>
      </div>
      {items.map((it) => <Row key={it.id} item={it} />)}
    </div>
  )
}
