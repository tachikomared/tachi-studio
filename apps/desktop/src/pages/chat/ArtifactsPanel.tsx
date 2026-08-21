// apps/desktop/src/pages/chat/ArtifactsPanel.tsx
//
// Right-side 360px panel that renders extracted artifacts for the active
// conversation. Mirrors ChatHistory's brutalist open/close pattern.
//
// Rendering per kind (PREVIEW | CODE toggle):
//   html    → sandboxed <iframe srcdoc>            | Monaco
//   svg     → inline <svg> in a scrollable container | Monaco
//   mermaid → MermaidBlock diagram                 | Monaco
//   code    → Monaco only (no preview)
//
// Versions: regenerating an artifact stashes the old content (see
// artifact-versioning.ts). The header stepper walks older versions READ-ONLY;
// [RESTORE] makes one current again (pushing the present content to history).

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useArtifactsStore, type Artifact } from '../../store/artifacts.store'
import { showToast } from '../../components/Toaster'
import { CodeEditor } from '../../components/CodeEditor'
import { MermaidBlock } from '../../components/MermaidBlock'
import { monacoLangFromName } from '../../lib/monaco-lang'
import { SplitHandle } from '../../components/SplitHandle'
import { useResizablePanel } from '../../hooks/useResizablePanel'

// ── sub-components ────────────────────────────────────────────────────────────

// Editable, IDE-grade code view (Monaco). Edits are debounced back into the
// artifacts store so Copy/Download (and any HTML/SVG re-render) see the change.
// `editorKey` remounts the editor when content changes EXTERNALLY (regeneration
// merge → messageId changes; restore → epoch bump) but never on hand-edits, so
// the cursor is not yanked mid-typing.
function CodePreview({ conversationId, artifact, editorKey }: { conversationId: string; artifact: Artifact; editorKey: string }) {
  const updateArtifact = useArtifactsStore(s => s.updateArtifact)
  const lang = monacoLangFromName(artifact.language)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChange = useCallback((v: string) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => updateArtifact(conversationId, artifact.id, v), 350)
  }, [conversationId, artifact.id, updateArtifact])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  return (
    <div style={{ flex: 1, minHeight: 0, background: '#0a0a0a' }}>
      <CodeEditor key={editorKey} defaultValue={artifact.content} language={lang} onChange={onChange} minimap={false} />
    </div>
  )
}

// Read-only Monaco for viewing an older version — no write-back.
function ReadOnlyCode({ artifact, editorKey }: { artifact: Artifact; editorKey: string }) {
  const lang = monacoLangFromName(artifact.language)
  return (
    <div style={{ flex: 1, minHeight: 0, background: '#0a0a0a' }}>
      <CodeEditor key={editorKey} value={artifact.content} language={lang} readOnly minimap={false} />
    </div>
  )
}

function HtmlPreview({ artifact }: { artifact: Artifact }) {
  return (
    <iframe
      title={artifact.title}
      sandbox="allow-scripts"
      srcDoc={artifact.content}
      style={{
        flex: 1,
        width: '100%',
        border: 'none',
        background: '#fff',
      }}
    />
  )
}

function SvgPreview({ artifact }: { artifact: Artifact }) {
  return (
    <div
      style={{
        flex: 1,
        overflowX: 'auto',
        overflowY: 'auto',
        padding: 12,
        background: 'var(--bg-inset)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
      }}
      dangerouslySetInnerHTML={{ __html: artifact.content }}
    />
  )
}

function MermaidPreview({ artifact }: { artifact: Artifact }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '0 10px', background: 'var(--bg-inset)' }}>
      <MermaidBlock code={artifact.content} />
    </div>
  )
}

// ── action buttons ─────────────────────────────────────────────────────────────

function ActionBar({ artifact }: { artifact: Artifact }) {
  const { t } = useTranslation('chat')
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.content)
      showToast({ kind: 'success', text: t('artifacts.copied') })
    } catch {
      showToast({ kind: 'error', text: t('toast.copyFailed') })
    }
  }

  const onDownload = () => {
    const ext: Record<string, string> = { html: 'html', svg: 'svg', mermaid: 'mmd', code: artifact.language ?? 'txt' }
    const filename = `${artifact.title.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60)}.${ext[artifact.kind] ?? 'txt'}`
    const mime: Record<string, string> = { html: 'text/html', svg: 'image/svg+xml', mermaid: 'text/plain', code: 'text/plain' }
    const blob = new Blob([artifact.content], { type: mime[artifact.kind] ?? 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    showToast({ kind: 'success', text: t('artifacts.downloaded', { filename }) })
  }

  const btnStyle: React.CSSProperties = {
    padding: '2px 8px',
    border: '2px solid var(--border)',
    background: 'var(--bg-elevated)',
    color: 'var(--text-muted)',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.08em',
    cursor: 'pointer',
    textTransform: 'uppercase',
  }

  return (
    <div style={{ display: 'flex', gap: 4, padding: '4px 8px', background: 'var(--bg-elevated)', borderBottom: '2px solid var(--border)', alignItems: 'center' }}>
      <span style={{ flex: 1, fontSize: 10, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {artifact.title}
      </span>
      <button type="button" onClick={onCopy} style={btnStyle}>{t('actions.copy')}</button>
      <button type="button" onClick={onDownload} style={btnStyle}>{t('actions.download')}</button>
    </div>
  )
}

// ── tab strip ──────────────────────────────────────────────────────────────────

function TabStrip({ artifacts, activeId, onSelect }: {
  artifacts: Artifact[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  if (artifacts.length <= 1) return null
  return (
    <div style={{
      display: 'flex',
      overflowX: 'auto',
      borderBottom: '2px solid var(--border)',
      background: 'var(--bg-surface)',
      flexShrink: 0,
    }}>
      {artifacts.map((a, i) => {
        const isActive = a.id === activeId
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect(a.id)}
            title={a.title}
            style={{
              padding: '4px 10px',
              border: 'none',
              borderRight: '2px solid var(--border)',
              borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
              background: isActive ? 'var(--accent-muted)' : 'var(--bg-elevated)',
              color: isActive ? 'var(--accent-text)' : 'var(--text-dim)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 9,
              fontWeight: isActive ? 700 : 400,
              cursor: 'pointer',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              marginBottom: -2,
            }}
          >
            {i + 1}. {a.kind}
          </button>
        )
      })}
    </div>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Wrap a bare <svg> in a minimal page so the Design tab can iterate on it. */
function svgSeedDoc(title: string, svg: string): string {
  return `<!doctype html>\n<html>\n<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>\n<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#111">\n${svg}\n</body>\n</html>`
}

// ── main panel ────────────────────────────────────────────────────────────────

interface ArtifactsPanelProps {
  conversationId: string | undefined
  open: boolean
  onClose: () => void
}

export function ArtifactsPanel({ conversationId, open, onClose }: ArtifactsPanelProps) {
  const { t } = useTranslation('chat')
  const { t: ta } = useTranslation('artifacts')
  const navigate = useNavigate()
  const pane = useResizablePanel({ storageKey: 'tachi-split:chat.artifacts', initial: 360, min: 280, max: 720, side: 'left', collapsible: true })
  const getForConversation = useArtifactsStore(s => s.getForConversation)
  const activeArtifactId = useArtifactsStore(s => s.activeArtifactId)
  const setActive = useArtifactsStore(s => s.setActive)
  const restoreVersion = useArtifactsStore(s => s.restoreVersion)

  // Per-artifact UI state (session-only, not persisted):
  //   viewModes  — last PREVIEW|CODE choice per artifact id
  //   versionSel — 0-based index into versions[] being viewed (absent = latest)
  const [viewModes, setViewModes] = useState<Record<string, 'preview' | 'code'>>({})
  const [versionSel, setVersionSel] = useState<Record<string, number>>({})
  // Bumped on RESTORE so the uncontrolled Monaco remounts with the new content.
  const [restoreEpoch, setRestoreEpoch] = useState(0)

  const artifacts = conversationId ? getForConversation(conversationId) : []

  // When conversation changes or panel opens, default to the last artifact if
  // the current activeArtifactId isn't in this conversation's list.
  useEffect(() => {
    if (!open || artifacts.length === 0) return
    const isOwned = artifacts.some(a => a.id === activeArtifactId)
    if (!isOwned) {
      setActive(artifacts[artifacts.length - 1].id)
    }
  }, [open, conversationId, artifacts.length]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const activeArtifact = artifacts.find(a => a.id === activeArtifactId) ?? artifacts[artifacts.length - 1] ?? null

  // ── derived version/view state for the active artifact ─────────────────────
  const versions = activeArtifact?.versions ?? []
  const total = versions.length + 1 // +1 for the current content ("latest")
  const rawSel = activeArtifact ? versionSel[activeArtifact.id] : undefined
  const selIdx = rawSel !== undefined && rawSel >= 0 && rawSel < versions.length ? rawSel : undefined
  const viewingOld = selIdx !== undefined
  const cur = viewingOld ? selIdx + 1 : total // 1-based version number on display
  const effArtifact = activeArtifact && viewingOld
    ? { ...activeArtifact, content: versions[selIdx].content }
    : activeArtifact
  const previewable = activeArtifact ? activeArtifact.kind !== 'code' : false
  const mode: 'preview' | 'code' = activeArtifact && previewable
    ? (viewModes[activeArtifact.id] ?? 'preview')
    : 'code'

  const setMode = (id: string, m: 'preview' | 'code') => setViewModes(s => ({ ...s, [id]: m }))
  const selectVersion = (id: string, idx: number | undefined) => setVersionSel(s => {
    const next = { ...s }
    if (idx === undefined) delete next[id]
    else next[id] = idx
    return next
  })

  const onRestore = () => {
    if (!activeArtifact || !conversationId || selIdx === undefined) return
    restoreVersion(conversationId, activeArtifact.id, selIdx)
    selectVersion(activeArtifact.id, undefined)
    setRestoreEpoch(e => e + 1)
  }

  const onOpenInDesign = () => {
    if (!effArtifact) return
    const html = effArtifact.kind === 'svg' ? svgSeedDoc(effArtifact.title, effArtifact.content) : effArtifact.content
    try {
      sessionStorage.setItem('tachi:design-seed', JSON.stringify({ html, title: effArtifact.title }))
    } catch {
      return // storage unavailable — silently keep the user in chat
    }
    navigate('/design')
  }

  const chipStyle = (active: boolean, interactive = true): React.CSSProperties => ({
    padding: '2px 8px',
    border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'var(--accent-muted)' : 'var(--bg-elevated)',
    color: active ? 'var(--accent-text)' : 'var(--text-dim)',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.08em',
    cursor: interactive ? 'pointer' : 'default',
    textTransform: 'uppercase',
  })

  const stepBtnStyle = (enabled: boolean): React.CSSProperties => ({
    padding: '2px 5px',
    border: '2px solid var(--border)',
    background: 'var(--bg-elevated)',
    color: enabled ? 'var(--text-muted)' : 'var(--text-dim)',
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 9,
    fontWeight: 700,
    cursor: enabled ? 'pointer' : 'default',
    opacity: enabled ? 1 : 0.4,
  })

  const editorKey = activeArtifact ? `${activeArtifact.id}:${activeArtifact.messageId}:${restoreEpoch}` : ''

  return (
    <>
    <SplitHandle panel={pane} side="left" dataId="chat.artifacts" />
    <div style={{
      width: pane.width,
      borderLeft: '2px solid var(--border)',
      background: 'var(--bg-surface)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'JetBrains Mono, monospace',
      flexShrink: 0,
      overflow: 'hidden',
    }}>
      {/* Panel header */}
      <div style={{
        padding: '6px 10px',
        borderBottom: '2px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--bg-elevated)',
        flexShrink: 0,
      }}>
        <span style={{
          flex: 1,
          fontSize: 9,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          fontWeight: 700,
        }}>
          {t('artifacts.header', { count: artifacts.length })}
        </span>
        <button
          type="button"
          onClick={onClose}
          title={t('artifacts.closeTitle')}
          aria-label={t('artifacts.closeAria')}
          style={{
            padding: '2px 6px',
            border: '2px solid var(--border)',
            background: 'var(--bg-elevated)',
            color: 'var(--text-muted)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10,
            cursor: 'pointer',
          }}
        >×</button>
      </div>

      {/* Tab strip (only shown when multiple artifacts) */}
      {artifacts.length > 1 && (
        <TabStrip
          artifacts={artifacts}
          activeId={activeArtifactId}
          onSelect={setActive}
        />
      )}

      {/* Empty state */}
      {artifacts.length === 0 && (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          color: 'var(--text-dim)',
          fontSize: 11,
          textAlign: 'center',
        }}>
          {t('artifacts.empty')}
        </div>
      )}

      {/* Active artifact body */}
      {activeArtifact && effArtifact && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <ActionBar artifact={effArtifact} />

          {/* View bar: PREVIEW|CODE toggle · OPEN IN DESIGN · version stepper */}
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            padding: '4px 8px',
            alignItems: 'center',
            background: 'var(--bg-surface)',
            borderBottom: '2px solid var(--border)',
            flexShrink: 0,
          }}>
            {previewable ? (
              <>
                <button type="button" onClick={() => setMode(activeArtifact.id, 'preview')} style={chipStyle(mode === 'preview')}>
                  {ta('pane.preview', { defaultValue: 'PREVIEW' })}
                </button>
                <button type="button" onClick={() => setMode(activeArtifact.id, 'code')} style={chipStyle(mode === 'code')}>
                  {ta('pane.code', { defaultValue: 'CODE' })}
                </button>
              </>
            ) : (
              <span style={chipStyle(true, false)}>{ta('pane.code', { defaultValue: 'CODE' })}</span>
            )}
            <span style={{ flex: 1 }} />
            {(activeArtifact.kind === 'html' || activeArtifact.kind === 'svg') && (
              <button type="button" onClick={onOpenInDesign} style={chipStyle(false)}>
                {ta('pane.openInDesign', { defaultValue: 'OPEN IN DESIGN' })}
              </button>
            )}
            {versions.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button
                  type="button"
                  disabled={cur <= 1}
                  title={ta('pane.olderVersion', { defaultValue: 'Older version' })}
                  onClick={() => selectVersion(activeArtifact.id, cur - 2)}
                  style={stepBtnStyle(cur > 1)}
                >◀</button>
                <span style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  color: viewingOld ? 'var(--warning)' : 'var(--text-dim)',
                  padding: '0 4px',
                }}>
                  {ta('pane.versionLabel', { n: cur, max: total, defaultValue: 'v{{n}}/{{max}}' })}
                </span>
                <button
                  type="button"
                  disabled={cur >= total}
                  title={ta('pane.newerVersion', { defaultValue: 'Newer version' })}
                  onClick={() => selectVersion(activeArtifact.id, cur >= total - 1 ? undefined : cur)}
                  style={stepBtnStyle(cur < total)}
                >▶</button>
              </div>
            )}
          </div>

          {/* Amber read-only banner when viewing an older version */}
          {viewingOld && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 8px',
              borderBottom: '2px solid var(--warning)',
              background: 'var(--bg-elevated)',
              color: 'var(--warning)',
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}>
              <span style={{ flex: 1 }}>
                {ta('pane.viewingVersion', { n: cur, max: total, defaultValue: 'VIEWING v{{n}} OF {{max}} — READ-ONLY' })}
              </span>
              <button
                type="button"
                onClick={onRestore}
                style={{
                  padding: '2px 8px',
                  border: '2px solid var(--warning)',
                  background: 'transparent',
                  color: 'var(--warning)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: '0.08em',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                }}
              >{ta('pane.restore', { defaultValue: 'RESTORE' })}</button>
            </div>
          )}

          {mode === 'preview' && effArtifact.kind === 'html' && <HtmlPreview artifact={effArtifact} />}
          {mode === 'preview' && effArtifact.kind === 'svg' && <SvgPreview artifact={effArtifact} />}
          {mode === 'preview' && effArtifact.kind === 'mermaid' && <MermaidPreview artifact={effArtifact} />}
          {mode === 'code' && (viewingOld
            ? <ReadOnlyCode artifact={effArtifact} editorKey={`${editorKey}:v${cur}`} />
            : <CodePreview conversationId={conversationId ?? ''} artifact={activeArtifact} editorKey={editorKey} />)}
        </div>
      )}
    </div>
    </>
  )
}
