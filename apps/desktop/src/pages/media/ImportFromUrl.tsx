// apps/desktop/src/pages/media/ImportFromUrl.tsx
//
// "Import from URL" panel (STEAL 2026-06-21 #8): paste a YouTube / Instagram / X
// (etc.) link → fetch info → pick a resolution → download into the local media
// library, where it can be remixed / used as an img2img or video reference.
// Personal-use only; the page URL is egress-gated on the main side (PRIVATE MODE
// + SSRF). All work routes through window.tachi.ytdlp.* (Layer-A IPC).
import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { showToast } from '../../components/Toaster'
import { useMediaStore } from '../../store/media.store'
import type { Artifact, SurplusMediaModality } from '../../types/electron'

const VIDEO_EXT = /\.(mp4|webm|mkv|mov|avi|m4v)$/i
const AUDIO_EXT = /\.(mp3|m4a|opus|wav|ogg|flac|aac)$/i

function kindFor(path: string): { kind: Artifact['kind']; mimeType: string; modality: SurplusMediaModality } {
  if (AUDIO_EXT.test(path)) return { kind: 'audio', mimeType: 'audio/mpeg', modality: 'music' }
  if (VIDEO_EXT.test(path)) return { kind: 'video', mimeType: 'video/mp4', modality: 'video' }
  return { kind: 'image', mimeType: 'image/png', modality: 'image' }
}

const label: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }
const input: React.CSSProperties = { flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '6px 8px', border: '2px solid var(--border)', background: 'var(--bg-inset)', color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, outline: 'none' }
const btn: React.CSSProperties = { padding: '6px 12px', border: '2px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', cursor: 'pointer' }

interface FormatOpt { id: string; label: string; height: number }

export function ImportFromUrl() {
  const { t } = useTranslation('media')
  const addEntry = useMediaStore(s => s.addEntry)
  const [url, setUrl] = useState('')
  const [fetching, setFetching] = useState(false)
  const [title, setTitle] = useState<string | null>(null)
  const [formats, setFormats] = useState<FormatOpt[]>([])
  const [formatId, setFormatId] = useState<string>('')
  const [downloading, setDownloading] = useState(false)
  const [audioOnly, setAudioOnly] = useState(false)
  const [progress, setProgress] = useState<{ percent: number; speed?: string; eta?: string } | null>(null)
  const offRef = useRef<(() => void) | null>(null)

  useEffect(() => () => { offRef.current?.() }, [])

  const fetchInfo = async () => {
    const u = url.trim()
    if (!u || fetching) return
    setFetching(true); setTitle(null); setFormats([]); setFormatId('')
    try {
      const r = await window.tachi.ytdlp.info(u)
      if (!r.ok || !r.info) { showToast({ kind: 'error', text: r.error || t('import.error.couldNotRead') }); return }
      setTitle(r.info.title)
      setFormats(r.info.formats)
      setFormatId(r.info.formats[0]?.id ?? '')
    } catch (e) {
      showToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setFetching(false)
    }
  }

  const download = async () => {
    const u = url.trim()
    if (!u || downloading) return
    setDownloading(true); setProgress({ percent: 0 })
    offRef.current?.()
    offRef.current = window.tachi.ytdlp.onDownloadProgress(p => {
      if (p.url === u) setProgress({ percent: p.percent, speed: p.speed, eta: p.eta })
    })
    try {
      const r = await window.tachi.ytdlp.download(u, audioOnly ? undefined : (formatId || undefined), audioOnly)
      if (!r.ok || !r.path) { showToast({ kind: 'error', text: r.error || t('import.error.downloadFailed') }); return }
      const { kind, mimeType, modality } = kindFor(r.path)
      addEntry({
        id: `import-${Date.now()}`,
        model: 'yt-dlp',
        modality,
        prompt: title || u,
        artifacts: [{ kind, mimeType, path: r.path } as Artifact],
        createdAt: Date.now(),
        source: 'import',
      })
      showToast({ kind: 'success', text: t('import.success') })
      setUrl(''); setTitle(null); setFormats([]); setFormatId('')
    } catch (e) {
      showToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setDownloading(false); setProgress(null)
      offRef.current?.(); offRef.current = null
    }
  }

  return (
    <div data-tour="media-import" style={{ border: '2px solid var(--border)', background: 'var(--bg-surface)', padding: 10, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={label}>⬇ {t('import.title')}</span>
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('import.subtitle')}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          style={input}
          placeholder={t('import.placeholder')}
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') fetchInfo() }}
          disabled={downloading}
        />
        <button style={btn} onClick={fetchInfo} disabled={!url.trim() || fetching || downloading}>
          {fetching ? '…' : t('import.fetch')}
        </button>
        <button
          style={{ ...btn, borderColor: 'var(--accent)', color: 'var(--accent)' }}
          onClick={download}
          disabled={!url.trim() || downloading}
          title={t('import.downloadTitle')}
        >
          {downloading ? `${progress?.percent ?? 0}%` : t('import.download')}
        </button>
      </div>

      {title && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-primary)' }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={title}>{title}</span>
          {formats.length > 0 && (
            <select
              value={formatId}
              onChange={e => setFormatId(e.target.value)}
              disabled={downloading || audioOnly}
              title={audioOnly ? t('import.audioOnlyOnTitle') : t('import.resolutionTitle')}
              style={{ ...input, flex: 'none', width: 'auto', fontSize: 11, padding: '3px 6px', opacity: audioOnly ? 0.5 : 1 }}
            >
              {formats.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-dim)', cursor: 'pointer', whiteSpace: 'nowrap' }} title={t('import.audioOnlyTitle')}>
            <input type="checkbox" checked={audioOnly} disabled={downloading} onChange={e => setAudioOnly(e.target.checked)} />
            {t('import.audioOnlyLabel')}
          </label>
        </div>
      )}

      {downloading && progress && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: 'var(--text-dim)' }}>
          <div style={{ flex: 1, height: 4, background: 'var(--bg-inset)', border: '1px solid var(--border)' }}>
            <div style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%`, height: '100%', background: 'var(--accent)' }} />
          </div>
          <span>{progress.percent}%{progress.speed ? ` · ${progress.speed}` : ''}{progress.eta ? ` · ETA ${progress.eta}` : ''}</span>
        </div>
      )}

      <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
        {t('import.disclaimer')}
      </div>
    </div>
  )
}
