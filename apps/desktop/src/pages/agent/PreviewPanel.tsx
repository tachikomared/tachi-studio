// apps/desktop/src/pages/agent/PreviewPanel.tsx
//
// Slide-in overlay that renders agent artifacts in-app:
//   .html / .htm  → sandboxed iframe (sandbox="allow-scripts", NOT allow-same-origin)
//   .png/.jpg/.jpeg/.gif/.webp/.svg → <img>
//   .md / .txt / .json / .csv       → <pre>
//   other                           → "Preview not supported"
//
// Data is loaded via the existing agent:read-file IPC
// (window.tachi.agent.readFile) — no new IPC needed.
//
// Style invariants: 2px brutalist borders, JetBrains Mono, semantic CSS vars,
// no border-radius, no emojis — ASCII labels only.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CodeEditor } from '../../components/CodeEditor'
import { monacoLangFromPath } from '../../lib/monaco-lang'
import { showToast } from '../../components/Toaster'

// ── Types ─────────────────────────────────────────────────────────────────────

type FileKind = 'html' | 'image' | 'text' | 'unsupported'

interface ReadFileResult {
  kind:      'text' | 'image' | 'binary'
  content?:  string
  sizeBytes: number
  truncated?: boolean
}

function detectKind(filePath: string): FileKind {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'html' || ext === 'htm') return 'html'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
  if (['md', 'txt', 'json', 'csv', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh'].includes(ext)) return 'text'
  return 'unsupported'
}

// ── Component ─────────────────────────────────────────────────────────────────

interface PreviewPanelProps {
  filePath: string
  onClose:  () => void
}

export function PreviewPanel({ filePath, onClose }: PreviewPanelProps) {
  const { t } = useTranslation('agent')
  const kind = detectKind(filePath)
  const filename = filePath.split(/[\\/]/).pop() ?? filePath

  const [loading, setLoading]   = useState(true)
  const [data,    setData]      = useState<ReadFileResult | null>(null)
  const [error,   setError]     = useState<string | null>(null)

  // Editable code view (text/code files): read-only until EDIT is pressed.
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState('')
  const [dirty,   setDirty]   = useState(false)
  const [saving,  setSaving]  = useState(false)
  const savedRef = useRef<string>('')
  const lang = monacoLangFromPath(filePath)

  // Blob URL for HTML preview — created once per filePath, revoked on unmount.
  const blobUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setData(null)
    setError(null)
    setEditing(false)
    setDirty(false)
    setSaving(false)

    // Revoke any previous blob URL.
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }

    const agent = (window.tachi as unknown as {
      agent: { readFile: (p: string) => Promise<ReadFileResult> }
    }).agent

    agent.readFile(filePath)
      .then((result) => {
        if (cancelled) return
        setData(result)
        if (result.kind === 'text' && typeof result.content === 'string') {
          savedRef.current = result.content
          setDraft(result.content)
        }
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })

    return () => {
      cancelled = true
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [filePath])

  // Build a blob URL for the HTML content (avoids CSP src restrictions for
  // data: URIs in iframes).
  let htmlBlobUrl: string | null = null
  if (kind === 'html' && data?.kind === 'text' && data.content) {
    if (!blobUrlRef.current) {
      blobUrlRef.current = URL.createObjectURL(
        new Blob([data.content], { type: 'text/html' }),
      )
    }
    htmlBlobUrl = blobUrlRef.current
  }

  const openInBrowser = () => {
    // Route through the shell IPC to open the file in the default browser.
    const shell = (window.tachi as unknown as {
      shell?: { openExternal?: (url: string) => void }
    }).shell
    shell?.openExternal?.(`file://${filePath.replace(/\\/g, '/')}`)
  }

  // Persist the edited buffer to disk via the guarded agent:write-file IPC.
  const onSave = useCallback(async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const api = (window.tachi as unknown as {
        agent: { writeFile: (p: string, c: string) => Promise<{ ok: boolean; error?: string }> }
      }).agent
      const r = await api.writeFile(filePath, draft)
      if (r.ok) {
        savedRef.current = draft
        setDirty(false)
        setEditing(false)
        showToast({ kind: 'success', text: 'Saved' })
      } else {
        showToast({ kind: 'error', text: r.error ?? 'Save failed' })
      }
    } catch (e) {
      showToast({ kind: 'error', text: e instanceof Error ? e.message : 'Save failed' })
    } finally {
      setSaving(false)
    }
  }, [dirty, saving, filePath, draft])

  // SAVE COPY → agent:save-artifact-copy IPC: copies the previewed file into
  // the user-visible <storage root>\Media\Artifacts folder.
  const onSaveCopy = useCallback(async () => {
    try {
      const api = (window.tachi as unknown as {
        agent: { saveArtifactCopy: (p: string) => Promise<{ ok: boolean; path: string; error?: string }> }
      }).agent
      const r = await api.saveArtifactCopy(filePath)
      if (r.ok) {
        showToast({ kind: 'success', text: t('filePreview.saveCopySuccess', { path: r.path }) })
      } else {
        showToast({ kind: 'error', text: r.error ?? t('filePreview.saveCopyFailed') })
      }
    } catch (e) {
      showToast({ kind: 'error', text: e instanceof Error ? e.message : t('filePreview.saveCopyFailed') })
    }
  }, [filePath, t])

  // Editable only for fully-loaded text/code (a truncated >1 MB read must not be
  // saved back — it would clobber the file with a partial buffer).
  const canEdit = kind === 'text' && data?.kind === 'text' && !data.truncated

  return (
    <div
      style={{
        position:   'fixed',
        top: 0, right: 0, bottom: 0,
        width: 640,
        zIndex: 1000,
        background: 'var(--bg-surface)',
        borderLeft: '2px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-8px 0 0 0 var(--border)',
      }}
    >
      {/* ── Header ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderBottom: '2px solid var(--border)',
        background: 'var(--bg-elevated)',
        flexShrink: 0,
      }}>
        <div style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 9, fontWeight: 700,
          letterSpacing: '0.12em', textTransform: 'uppercase',
          color: 'var(--text-dim)',
          flexShrink: 0,
        }}>
          {t('preview.label')}
        </div>
        <div style={{
          flex: 1,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          color: 'var(--text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }} title={filePath}>
          {filename}
        </div>
        {/* [EDIT] / [SAVE] — editable text/code files only */}
        {canEdit && !editing && (
          <button onClick={() => setEditing(true)} title="Edit this file" style={headerBtn}>
            EDIT
          </button>
        )}
        {canEdit && editing && (
          <button
            onClick={onSave}
            disabled={!dirty || saving}
            title="Save changes to disk"
            style={{ ...headerBtn, opacity: !dirty || saving ? 0.5 : 1, borderColor: dirty ? 'var(--accent, var(--border))' : 'var(--border)' }}
          >
            {saving ? 'SAVING…' : dirty ? 'SAVE *' : 'SAVED'}
          </button>
        )}
        {/* [SAVE COPY] — copy the artifact into the user's Tachi Studio folder */}
        {!loading && !error && data && (
          <button onClick={onSaveCopy} title={t('filePreview.saveCopyTooltip')} style={headerBtn}>
            {t('filePreview.saveCopy')}
          </button>
        )}
        {/* [OPEN IN BROWSER] — only for HTML / images */}
        {(kind === 'html' || kind === 'image') && (
          <button
            onClick={openInBrowser}
            title={t('preview.openInBrowserTooltip')}
            style={headerBtn}
          >
            {t('preview.openInBrowser')}
          </button>
        )}
        <button onClick={onClose} title={t('preview.closeTooltip')} style={headerBtn}>
          {t('preview.close')}
        </button>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {loading && (
          <div style={centeredMsg}>{t('preview.loading')}</div>
        )}
        {!loading && error && (
          <div style={{ ...centeredMsg, color: 'var(--danger, #ff5252)' }}>
            {t('preview.error', { error })}
          </div>
        )}
        {!loading && !error && data && (
          <>
            {/* HTML → sandboxed iframe */}
            {kind === 'html' && htmlBlobUrl && (
              <iframe
                src={htmlBlobUrl}
                title={filename}
                // allow-scripts: lets calculator/interactive HTML run JS.
                // NOT allow-same-origin: the page cannot reach window.tachi or
                // any renderer state — it is fully sandboxed.
                sandbox="allow-scripts allow-forms"
                style={{
                  flex: 1,
                  border: 'none',
                  width: '100%',
                  background: '#fff',
                }}
              />
            )}
            {/* HTML with no content (shouldn't happen) */}
            {kind === 'html' && !htmlBlobUrl && (
              <div style={centeredMsg}>{t('preview.emptyHtml')}</div>
            )}
            {/* Image → <img> */}
            {kind === 'image' && data.kind === 'image' && data.content && (
              <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
                <img
                  src={data.content}
                  alt={filename}
                  style={{
                    maxWidth: '100%',
                    border: '2px solid var(--border)',
                    boxShadow: '4px 4px 0 var(--border)',
                  }}
                />
              </div>
            )}
            {kind === 'image' && data.kind !== 'image' && (
              <div style={centeredMsg}>{t('preview.imageTooLarge')}</div>
            )}
            {/* Text → editable Monaco (read-only until EDIT) */}
            {kind === 'text' && data.kind === 'text' && (
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {data.truncated && (
                  <div style={{
                    padding: '4px 10px',
                    fontSize: 9, fontWeight: 700,
                    background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
                    borderBottom: 'var(--border-width) solid var(--warning)',
                    color: 'var(--warning)',
                    fontFamily: 'JetBrains Mono, monospace',
                  }}>
                    {t('preview.truncated', { total: (data.sizeBytes / 1024 / 1024).toFixed(1) })} — read-only
                  </div>
                )}
                <div style={{ flex: 1, minHeight: 0 }}>
                  <CodeEditor
                    key={filePath}
                    defaultValue={data.content ?? ''}
                    language={lang}
                    readOnly={!editing}
                    onChange={(v) => { setDraft(v); setDirty(v !== savedRef.current) }}
                  />
                </div>
              </div>
            )}
            {/* Unsupported */}
            {kind === 'unsupported' && (
              <div style={centeredMsg}>
                {t('preview.unsupported')}<br />
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {t('preview.supportedPrefix')} .html, .htm, .png, .jpg, .jpeg, .gif, .webp, .svg, .md, .txt, .json, .csv
                </span>
              </div>
            )}
            {/* binary fallback */}
            {kind !== 'unsupported' && data.kind === 'binary' && (
              <div style={centeredMsg}>
                {t('preview.binary', { bytes: data.sizeBytes.toLocaleString() })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const headerBtn: React.CSSProperties = {
  padding: '3px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 9, fontWeight: 700,
  letterSpacing: '0.06em',
  cursor: 'pointer',
  flexShrink: 0,
  textTransform: 'uppercase',
}

const centeredMsg: React.CSSProperties = {
  padding: '24px 16px',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  color: 'var(--text-muted)',
  textAlign: 'center',
  lineHeight: 1.7,
}
