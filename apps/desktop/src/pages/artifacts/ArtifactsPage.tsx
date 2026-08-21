// apps/desktop/src/pages/artifacts/ArtifactsPage.tsx
//
// Brutalist ARTIFACTS library — a filterable grid over EVERYTHING the user has
// ever generated as media. It reads the SAME persistent gallery the Media studio
// writes (media.store), so it surfaces both studio generations AND media-node
// runs from the Studio canvas (captured via media.store.addNodeRunArtifacts).
//
// This is a read-only LIBRARY view (not a composer): filter by modality, free-text
// search over the prompt, newest-first with favorites surfaced to the top. Each
// tile shows a thumbnail (mediaHelpers.artifactSrc), a modality badge, the prompt
// caption, and the same per-artifact actions the Media gallery uses — fullscreen
// preview, Save (copy to a folder), Reveal on disk, and favorite/pin. Generation
// itself stays in the Media tab; "+ Generate media" in the sidebar jumps there.
//
// Renderer-only: artifact bytes load via the tachi-media:// protocol (artifactSrc).

import React, { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageTopbar } from '../../components/layout/PageTopbar'
import type { Artifact, SurplusMediaModality } from '../../types/electron'
import { artifactSrc, saveArtifactToFolder, revealArtifact } from '../media/mediaHelpers'
import { useMediaStore, type MediaGalleryEntry } from '../../store/media.store'
import { modelDisplayName } from '../../utils/model-display'

// ── Modality filter chips (matches the Media studio's modality set) ─────────────
const FILTERS: { id: 'all' | SurplusMediaModality; labelKey: string }[] = [
  { id: 'all',   labelKey: 'filters.all' },
  { id: 'image', labelKey: 'filters.image' },
  { id: 'video', labelKey: 'filters.video' },
  { id: 'music', labelKey: 'filters.music' },
  { id: 'tts',   labelKey: 'filters.tts' },
]

// ── Shared brutalist styles ─────────────────────────────────────────────────────
const btnStyle: React.CSSProperties = {
  padding: '4px 10px', border: '2px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
}
const tileBtnStyle: React.CSSProperties = { ...btnStyle, padding: '3px 8px', fontSize: 9 }

/** The first previewable (image/video) artifact in an entry, for the tile thumb. */
function thumbArtifact(entry: MediaGalleryEntry): Artifact | undefined {
  return entry.artifacts.find(a => a.kind === 'image' || a.kind === 'video')
}

export function ArtifactsPage() {
  const { t } = useTranslation('artifacts')
  const gallery        = useMediaStore(s => s.gallery)
  const toggleFavorite = useMediaStore(s => s.toggleFavorite)

  const [filter, setFilter] = useState<'all' | SurplusMediaModality>('all')
  const [query, setQuery]   = useState('')
  /** Fullscreen preview target (image/video artifact). */
  const [fullscreen, setFullscreen] = useState<Artifact | null>(null)

  // Esc closes the fullscreen preview.
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  // Filter (modality) → search (prompt, case-insensitive) → sort (favorites first,
  // newest within each group). The store already trims/caps; we never mutate it.
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return gallery
      .filter(e => filter === 'all' || e.modality === filter)
      .filter(e => q === '' || e.prompt.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => {
        const fa = a.favorite ? 1 : 0
        const fb = b.favorite ? 1 : 0
        if (fa !== fb) return fb - fa            // pinned favorites surface first
        return b.createdAt - a.createdAt          // newest first within a group
      })
  }, [gallery, filter, query])

  // Per-modality counts for the filter chips (over the unfiltered gallery).
  const countFor = (id: 'all' | SurplusMediaModality) =>
    id === 'all' ? gallery.length : gallery.filter(e => e.modality === id).length

  const totalEmpty = gallery.length === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageTopbar section="Artifacts" />

      {/* ── Filter + search toolbar ────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
        padding: '10px 16px', borderBottom: '2px solid var(--border)',
        background: 'var(--bg-surface)', fontFamily: 'JetBrains Mono, monospace',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {FILTERS.map(f => {
            const active = filter === f.id
            return (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                style={{
                  ...btnStyle,
                  border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  background: active ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                  color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                }}
              >
                {t(f.labelKey)} ({countFor(f.id)})
              </button>
            )
          })}
        </div>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
          style={{
            marginLeft: 'auto', minWidth: 200, flex: '0 1 280px', boxSizing: 'border-box',
            padding: '6px 8px', border: '2px solid var(--border)', background: 'var(--bg-inset)',
            color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12, outline: 'none',
          }}
        />
      </div>

      {/* ── Grid (or empty state) ──────────────────────────────────────────── */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: 16,
        background: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace',
      }}>
        {totalEmpty ? (
          <div style={{
            color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.6,
            border: '2px dashed var(--border)', padding: 32, textAlign: 'center',
          }}>
            {t('empty.none')}
            <div style={{ marginTop: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>{t('empty.noneHint')}</span>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div style={{
            color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.6,
            border: '2px dashed var(--border)', padding: 32, textAlign: 'center',
          }}>
            {t('empty.noMatch', {
              scope: filter === 'all' ? '' : `${filter} · `,
              query: query.trim() ? `"${query.trim()}"` : t('empty.noMatchFilter'),
            })}
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 16,
          }}>
            {items.map(entry => {
              const thumb = thumbArtifact(entry)
              const audio = entry.artifacts.find(a => a.kind === 'audio')
              return (
                <div key={entry.id} style={{
                  border: `2px solid ${entry.favorite ? 'var(--accent)' : 'var(--border)'}`,
                  background: 'var(--bg-surface)', display: 'flex', flexDirection: 'column',
                }}>
                  {/* Header: modality badge + pin */}
                  <div style={{
                    padding: '5px 8px', borderBottom: '2px solid var(--border)',
                    display: 'flex', alignItems: 'center', gap: 6, background: 'var(--bg-elevated)',
                  }}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                      textTransform: 'uppercase', color: 'var(--accent-text)',
                      border: '2px solid var(--accent)', background: 'var(--accent-muted)',
                      padding: '1px 6px',
                    }}>{entry.modality}</span>
                    {entry.source === 'node' && (
                      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                        NODE
                      </span>
                    )}
                    {entry.completedAfterPrivate && (
                      <span
                        title={t('tile.completedAfterPrivateTitle')}
                        style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)' }}
                      >
                        {t('tile.completedAfterPrivate')}
                      </span>
                    )}
                    <button
                      onClick={() => toggleFavorite(entry.id)}
                      title={entry.favorite ? t('tile.unpinTitle') : t('tile.pinTitle')}
                      style={{
                        ...tileBtnStyle, marginLeft: 'auto',
                        border: `2px solid ${entry.favorite ? 'var(--accent)' : 'var(--border)'}`,
                        background: entry.favorite ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                        color: entry.favorite ? 'var(--accent-text)' : 'var(--text-dim)',
                      }}
                    >
                      {entry.favorite ? t('tile.pinned') : t('tile.pin')}
                    </button>
                  </div>

                  {/* Thumbnail (image/video) or audio player or text */}
                  <div style={{
                    position: 'relative', background: 'var(--bg-inset)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    minHeight: 150, overflow: 'hidden',
                  }}>
                    {thumb?.kind === 'image' ? (
                      <img
                        src={artifactSrc(thumb)} alt={entry.prompt || t('tile.altFallback')}
                        onClick={() => setFullscreen(thumb)}
                        style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block', cursor: 'zoom-in' }}
                      />
                    ) : thumb?.kind === 'video' ? (
                      <video
                        src={artifactSrc(thumb)}
                        onClick={() => setFullscreen(thumb)}
                        style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block', cursor: 'zoom-in', background: '#000' }}
                      />
                    ) : audio ? (
                      <audio controls src={artifactSrc(audio)} style={{ width: '100%', padding: 8, boxSizing: 'border-box' }} />
                    ) : (
                      <div style={{
                        padding: 12, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflow: 'auto', width: '100%',
                      }}>
                        {entry.text ?? t('tile.noPreview')}
                      </div>
                    )}
                  </div>

                  {/* Caption: prompt + model */}
                  <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                    <div
                      title={entry.prompt}
                      style={{
                        fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.4,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {entry.prompt || t('tile.noPrompt')}
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', wordBreak: 'break-all' }} title={entry.model}>
                      {modelDisplayName(entry.model) || '—'}
                    </div>

                    {/* Per-artifact actions (reused from the Media gallery helpers) */}
                    {(thumb || audio) && (() => {
                      const target = thumb ?? audio!
                      return (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'auto' }}>
                          {(target.kind === 'image' || target.kind === 'video') && (
                            <button onClick={() => setFullscreen(target)} style={tileBtnStyle}>{t('actions.fullscreen')}</button>
                          )}
                          <button onClick={() => { saveArtifactToFolder(target) }} style={tileBtnStyle} disabled={!target.path}>{t('actions.save')}</button>
                          {target.path && (
                            <button onClick={() => revealArtifact(target)} style={tileBtnStyle}>{t('actions.reveal')}</button>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Fullscreen preview overlay (image/video) ───────────────────────── */}
      {fullscreen && (
        <div
          onClick={() => setFullscreen(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.88)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32,
          }}
        >
          <button
            onClick={() => setFullscreen(null)}
            style={{
              position: 'absolute', top: 16, right: 16, ...btnStyle, padding: '6px 12px',
              border: '2px solid var(--accent)', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            }}
          >
            {t('preview.close')}
          </button>
          {fullscreen.kind === 'image' ? (
            <img
              src={artifactSrc(fullscreen)} alt={t('preview.alt')}
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: '100%', maxHeight: '100%', border: '2px solid var(--border)', objectFit: 'contain' }}
            />
          ) : (
            <video
              src={artifactSrc(fullscreen)} controls autoPlay
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: '100%', maxHeight: '100%', border: '2px solid var(--border)' }}
            />
          )}
        </div>
      )}
    </div>
  )
}
