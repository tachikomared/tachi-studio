// apps/desktop/src/pages/status/LlamaCppRow.tsx
//
// Brutalist row for the ProvidersCard that surfaces the llama.cpp sidecar.
//
// Lifecycle UX:
//   - NOT INSTALLED         → [ INSTALL llama.cpp ]
//   - INSTALLED, no models  → [ DOWNLOAD MODEL ▾ ]
//   - INSTALLED, models OK  → [ START ▾ ] (model picker) / [ STOP ] when running
//
// All actions push progress events on `llama-cpp:install-progress`; we
// subscribe via window.tachi.llamaCpp.onInstallProgress to update the inline
// progress bar.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  GgufModelInfo,
  LlamaCppCatalog,
  LlamaCppStatusInfo,
  LlamaCppInstallProgressEvent,
} from '../../types/electron'

export function LlamaCppRow() {
  const [catalog,   setCatalog]   = useState<LlamaCppCatalog | null>(null)
  const [status,    setStatus]    = useState<LlamaCppStatusInfo | null>(null)
  const [busy,      setBusy]      = useState<null | 'install' | 'download' | 'start' | 'stop'>(null)
  const [progress,  setProgress]  = useState<LlamaCppInstallProgressEvent | null>(null)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [errorMsg,  setErrorMsg]  = useState<string | null>(null)
  const [showModels, setShowModels] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([
        window.tachi.llamaCpp.catalog(),
        window.tachi.llamaCpp.status(),
      ])
      setCatalog(c)
      setStatus(s)
      // Pre-select first downloaded model or first catalog model
      if (!selectedModelId) {
        const first = s.downloadedModels[0] ?? c.models[0]?.id ?? null
        if (first) setSelectedModelId(first)
      }
    } catch (e) {
      console.warn('[llama-cpp-row] refresh failed', e)
    }
  }, [selectedModelId])

  useEffect(() => {
    void refresh()
    const off = window.tachi.llamaCpp.onInstallProgress((event) => {
      setProgress(event as LlamaCppInstallProgressEvent)
      if ((event as LlamaCppInstallProgressEvent).stage === 'done') {
        // Refresh installed/downloaded flags after success
        void refresh()
      }
    })
    return () => { off() }
  }, [refresh])

  // Periodic status poll so [ LOADING MODEL... ] → [ RUNNING ] transition shows up
  useEffect(() => {
    if (status?.state === 'starting' || status?.state === 'loading') {
      const t = setInterval(() => { void refresh() }, 1000)
      return () => clearInterval(t)
    }
    return undefined
  }, [status?.state, refresh])

  const onInstall = useCallback(async () => {
    if (!catalog) return
    setBusy('install'); setErrorMsg(null); setProgress(null)
    try {
      // GPU-truth: prefer the GPU build when one is recommended (NVIDIA → CUDA),
      // so a GPU owner doesn't silently install the CPU build.
      const assetId = catalog.recommendedReleaseId ?? catalog.defaultReleaseId ?? undefined
      const res = await window.tachi.llamaCpp.install(assetId)
      if (!res.ok) setErrorMsg(res.error)
      await refresh()
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [catalog, refresh])

  const onDownloadModel = useCallback(async (modelId: string) => {
    setBusy('download'); setErrorMsg(null); setProgress(null)
    try {
      const res = await window.tachi.llamaCpp.downloadModel(modelId)
      if (!res.ok) setErrorMsg(res.error)
      await refresh()
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [refresh])

  const onStart = useCallback(async () => {
    if (!selectedModelId) return
    setBusy('start'); setErrorMsg(null)
    try {
      const res = await window.tachi.llamaCpp.start({ modelId: selectedModelId })
      if (!res.ok) setErrorMsg(res.error)
      await refresh()
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [selectedModelId, refresh])

  const onStop = useCallback(async () => {
    setBusy('stop'); setErrorMsg(null)
    try {
      await window.tachi.llamaCpp.stop()
      await refresh()
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }, [refresh])

  // ── Render ─────────────────────────────────────────────────────────────────
  const isInstalled    = status?.installed === true
  const hasModels      = (status?.downloadedModels?.length ?? 0) > 0
  const running        = status?.state === 'running'
  const loading        = status?.state === 'loading' || status?.state === 'starting'
  const errored        = status?.state === 'error'

  const downloadedModelObjs = useMemo<GgufModelInfo[]>(() => {
    if (!catalog || !status) return []
    return status.downloadedModels
      .map(id => catalog.models.find(m => m.id === id))
      .filter((m): m is GgufModelInfo => Boolean(m))
  }, [catalog, status])

  const undownloadedModelObjs = useMemo<GgufModelInfo[]>(() => {
    if (!catalog || !status) return []
    return catalog.models.filter(m => !status.downloadedModels.includes(m.id))
  }, [catalog, status])

  const statusBadge = (() => {
    if (catalog?.unsupportedReason) return { label: '[ UNSUPPORTED ]', color: 'var(--text-muted)' }
    if (!isInstalled)               return { label: '[ NOT INSTALLED ]', color: 'var(--text-muted)' }
    if (errored)                    return { label: '[ ERROR ]', color: 'var(--danger, #d43f00)' }
    if (loading)                    return { label: '[ LOADING MODEL... ]', color: 'var(--accent, #22c55e)' }
    if (running)                    return { label: '[ RUNNING ]', color: 'var(--success, #22c55e)' }
    return { label: '[ STOPPED ]', color: 'var(--text-muted)' }
  })()

  const currentModelLabel = useMemo(() => {
    if (!status?.modelId || !catalog) return null
    return catalog.models.find(m => m.id === status.modelId)?.label ?? status.modelId
  }, [status?.modelId, catalog])

  return (
    <div style={rowOuter}>
      {/* Header line */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 13, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.04em' }}>
            LLAMA.CPP
          </span>
          <span style={{ ...badgeBase, borderColor: statusBadge.color, color: statusBadge.color }}>
            {statusBadge.label}
          </span>
          <span style={anonBadge}>[ TRULY LOCAL · SHA VERIFIED ]</span>
          {running && status?.port && (
            <span style={urlText}>http://127.0.0.1:{status.port}</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* GPU-truth: when a GPU was detected, tell the user the install will
              use it (the CUDA build is auto-selected in onInstall). */}
          {!isInstalled && catalog?.gpuNote ? (
            <span style={{ fontSize: 10, color: 'var(--accent)', marginRight: 8, alignSelf: 'center' }} title={catalog.gpuNote}>
              ⚡ {catalog.gpuNote}
            </span>
          ) : null}
          {/* Render action buttons based on lifecycle stage */}
          {catalog?.unsupportedReason ? null
            : !isInstalled ? (
              <button onClick={onInstall} disabled={busy !== null} style={btnPrimary}>
                {busy === 'install' ? '[ DOWNLOADING ]' : (catalog?.recommendedReleaseId === 'win-cuda' ? '[ INSTALL llama.cpp (GPU) ]' : '[ INSTALL llama.cpp ]')}
              </button>
            )
            : running ? (
              <button onClick={onStop} disabled={busy !== null} style={btn}>
                {busy === 'stop' ? '[ STOPPING ]' : '[ STOP ]'}
              </button>
            )
            : loading ? (
              <button onClick={onStop} disabled={busy !== null} style={btn}>
                [ CANCEL ]
              </button>
            )
            : hasModels ? (
              <>
                <select
                  value={selectedModelId ?? ''}
                  onChange={e => setSelectedModelId(e.target.value)}
                  style={modelSelect}
                  disabled={busy !== null}
                  aria-label="Select downloaded model"
                >
                  {downloadedModelObjs.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
                <button
                  onClick={onStart}
                  disabled={busy !== null || !selectedModelId}
                  style={btnPrimary}
                >
                  {busy === 'start' ? '[ STARTING ]' : '[ START ]'}
                </button>
                <button
                  onClick={() => setShowModels(v => !v)}
                  disabled={busy !== null}
                  style={btn}
                  title="Show / hide model catalog"
                >
                  {showModels ? '[ HIDE MODELS ]' : '[ MORE MODELS ]'}
                </button>
              </>
            ) : (
              <button onClick={() => setShowModels(v => !v)} disabled={busy !== null} style={btnPrimary}>
                {showModels ? '[ HIDE MODELS ]' : '[ DOWNLOAD MODEL ]'}
              </button>
            )
          }
        </div>
      </div>

      {/* Currently loaded model label */}
      {running && currentModelLabel && (
        <div style={metaLine}>model: {currentModelLabel}</div>
      )}

      {/* Unsupported platform message */}
      {catalog?.unsupportedReason && (
        <div style={infoText}>{catalog.unsupportedReason}</div>
      )}

      {/* Inline progress bar */}
      {progress && busy && progress.stage !== 'done' && progress.stage !== 'error' && (
        <div style={progressPanel}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
            [ {progress.stage.toUpperCase()} ]
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
            {progress.message}
            {progress.bytes !== undefined && progress.totalBytes !== undefined && progress.totalBytes > 0 && (
              <> · {Math.floor(progress.bytes / 1_000_000)} / {Math.floor(progress.totalBytes / 1_000_000)} MB</>
            )}
          </div>
          <div style={progressBarOuter}>
            <div style={{ ...progressBarFill, width: `${Math.max(0, Math.min(100, progress.percent))}%` }} />
          </div>
        </div>
      )}

      {/* Error message */}
      {errorMsg && (
        <div style={errorPanel}>{errorMsg}</div>
      )}
      {errored && status?.error && !errorMsg && (
        <div style={errorPanel}>{status.error}</div>
      )}

      {/* Model catalog panel */}
      {showModels && catalog && (
        <div style={modelsPanel}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
            [ CURATED GGUF MODELS · {catalog.models.length} ]
          </div>
          {catalog.models.map(m => {
            const downloaded = status?.downloadedModels.includes(m.id) ?? false
            return (
              <div key={m.id} style={modelRow}>
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}>
                  <span style={{ fontWeight: 700, fontSize: 12 }}>{m.label}</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {m.family} · {m.paramsB}B · {m.quant} · ctx {m.contextK}K · {Math.floor(m.sizeMb)} MB · ~{m.recommendedRamGb} GB RAM
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {downloaded ? (
                    <>
                      <span style={{ ...badgeBase, borderColor: 'var(--success, #22c55e)', color: 'var(--success, #22c55e)' }}>
                        [ READY ]
                      </span>
                      <button
                        onClick={async () => {
                          setBusy('download')
                          try {
                            await window.tachi.llamaCpp.removeModel(m.id)
                            await refresh()
                          } finally { setBusy(null) }
                        }}
                        disabled={busy !== null}
                        style={btn}
                        title="Delete this GGUF file"
                      >
                        [ REMOVE ]
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => void onDownloadModel(m.id)}
                      disabled={busy !== null}
                      style={btnPrimary}
                    >
                      {busy === 'download' ? '[ ... ]' : '[ DOWNLOAD ]'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {undownloadedModelObjs.length === 0 && downloadedModelObjs.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              All curated models downloaded.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Styles (brutalist: 2px borders, NO radius, JetBrains Mono) ───────────────

const rowOuter: React.CSSProperties = {
  border: '2px solid var(--border)',
  padding: '10px 12px',
  marginBottom: 14,
  background: 'transparent',
  fontFamily: 'JetBrains Mono, monospace',
}

const badgeBase: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 7px',
  border: '2px solid currentColor',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
}

const anonBadge: React.CSSProperties = {
  padding: '2px 7px',
  border: '2px solid var(--success, #22c55e)',
  background: 'transparent',
  color: 'var(--success, #22c55e)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
}

const urlText: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const btn: React.CSSProperties = {
  padding: '3px 8px',
  border: '2px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  cursor: 'pointer',
}

const btnPrimary: React.CSSProperties = {
  ...btn,
  borderColor: 'var(--accent, #22c55e)',
  color: 'var(--accent, #22c55e)',
}

const modelSelect: React.CSSProperties = {
  padding: '3px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-base)',
  color: 'var(--text-primary)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  maxWidth: 280,
}

const metaLine: React.CSSProperties = {
  marginTop: 6,
  fontSize: 10,
  color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace',
  letterSpacing: '0.04em',
}

const infoText: React.CSSProperties = {
  marginTop: 8,
  padding: '6px 8px',
  border: '2px solid var(--border)',
  background: 'transparent',
  fontSize: 11,
  color: 'var(--text-muted)',
  lineHeight: 1.5,
}

const progressPanel: React.CSSProperties = {
  marginTop: 8,
  padding: '6px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-base)',
}

const progressBarOuter: React.CSSProperties = {
  width: '100%',
  height: 6,
  border: '2px solid var(--border)',
  background: 'transparent',
}

const progressBarFill: React.CSSProperties = {
  height: '100%',
  background: 'var(--accent, #22c55e)',
  transition: 'width 200ms linear',
}

const errorPanel: React.CSSProperties = {
  marginTop: 8,
  padding: '6px 8px',
  border: '2px solid var(--danger, #d43f00)',
  color: 'var(--danger, #d43f00)',
  fontSize: 11,
  whiteSpace: 'pre-wrap',
}

const modelsPanel: React.CSSProperties = {
  marginTop: 10,
  padding: '8px 10px',
  border: '2px solid var(--border)',
  background: 'var(--bg-base)',
}

const modelRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  padding: '6px 0',
  borderBottom: 'var(--border-width) solid var(--border)',
}
