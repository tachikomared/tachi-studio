// apps/desktop/src/pages/media/AudioOverviewPanel.tsx
//
// AUDIO OVERVIEW — NotebookLM-style: paste notes/an article, get a two-host
// podcast dialogue voiced 100% locally.
//   SCRIPT — one-shot completion through the quick-ask surface (the keyless
//            FreeLLM router; same first-run path chat defaults to) with a
//            strict-JSON prompt; fence-tolerant parse + ONE corrective retry.
//            The router RUNS here but FORWARDS the notes to a free cloud
//            provider — the panel's subtitle says so, because "local" in this
//            app is read as "my data never left this machine" (see
//            registry.ts::providerLocality). Only the VOICES are local.
//   VOICES — local TTS, two engines in one grouped picker:
//            STUDIO (kokoro, window.tachi.kokoro) — 10 studio-grade English
//            voices behind a one-time ~92MB model download (honest download
//            card + real progress; the surface may be absent until the sidecar
//            wave lands, in which case the card simply doesn't render), and
//            PIPER (window.tachi.piper) — kept for multilingual/fallback.
//            Defaults: af_heart (Host A) / am_michael (Host B) once kokoro is
//            installed; per-turn synthesis routes by the picked voice's engine.
//   STITCH — each turn's WAV (returned as base64) is decoded with WebAudio,
//            concatenated with 350ms gaps, re-encoded to one PCM16 WAV and
//            SAVED TO DISK via media:save-wav → inline player + a real file.
// Honest state machine: DRAFTING SCRIPT → SYNTHESIZING n/m → STITCHING →
// SAVING → READY, with a per-stage error + retry (a script that parsed is
// reused on retry).
//
// ── THIS PANEL NO LONGER OWNS THE RUN ────────────────────────────────────────
//
// It used to. A cancel flag raised by its own unmount effect, plus the four
// checkpoints that read it, meant switching sub-tabs ABORTED a ~96-second
// render — and the same effect revoked the blob URL that was its only artifact.
// It was the one operation in this app that navigation actively killed rather
// than merely hid.
//
// The pipeline now lives in audioOverviewRun (module-scoped, registered on the
// activity rail, auto-saving) and its state in audioOverview.store — exactly as
// the sd.cpp render lives in media.store's `run` slice. What is left here is a
// VIEW: the composer, the voice pickers, and whatever the store says is
// happening. A remount re-attaches to a run in flight (progress, STOP and the
// finished result all come back) because none of it was ever this component's
// to lose.
//
// Composer state (notes, title, length, voices) stays local, but is seeded from
// the store's `input`, so a remount mid-run does not come back with an empty
// textarea and a dead Retry.
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageTopbar } from '../../components/layout/PageTopbar'
import { showToast } from '../../components/Toaster'
import { mediaArtifactUrl } from './mediaHelpers'
import { useAudioOverviewStore, isAudioOverviewBusy } from '../../store/audioOverview.store'
import {
  startAudioOverviewRun,
  cancelAudioOverviewRun,
  saveAudioOverviewFile,
  setAudioOverviewCopy,
} from './audioOverviewRun'
import {
  packVoice,
  subscribeKokoroProgress,
  hasUsableScriptModel,
  KOKORO_HOST_A_DEFAULT,
  KOKORO_HOST_B_DEFAULT,
  MAX_SOURCE_CHARS,
  type KokoroVoiceInfo,
  type OverviewLength,
  type PodcastScript,
} from './audioOverviewHelpers'

// ── Brutalist idioms (mirrors MediaPage) ─────────────────────────────────────
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 4,
}
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
  border: '2px solid var(--border)', background: 'var(--bg-inset)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12, outline: 'none',
}
const btnStyle: React.CSSProperties = {
  padding: '4px 10px', border: '2px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
}

interface VoiceOption { id: string; name: string }

export function AudioOverviewPanel() {
  const { t } = useTranslation('media')
  const { t: tc } = useTranslation('common')

  // ── The run — read straight out of the store, never mirrored here ────────
  const stage    = useAudioOverviewStore(s => s.stage)
  const progress = useAudioOverviewStore(s => s.progress)
  const script   = useAudioOverviewStore(s => s.script)
  const error    = useAudioOverviewStore(s => s.error)
  const result   = useAudioOverviewStore(s => s.result)
  const stopping = useAudioOverviewStore(s => s.stopping)
  const busy     = isAudioOverviewBusy({ stage })

  // ── Composer state, seeded from the run in flight (the re-attach) ────────
  const seed = () => useAudioOverviewStore.getState().input
  const [source, setSource] = useState(() => seed()?.source ?? '')
  const [title, setTitle]   = useState(() => seed()?.title ?? '')
  const [length, setLength] = useState<OverviewLength>(() => seed()?.length ?? 'short')

  // ── voices (STUDIO/kokoro + piper) ───────────────────────────────────────
  // voiceA/voiceB hold ENGINE-PACKED ids ("kokoro:af_heart" / "piper:<id>").
  const [piperInstalled, setPiperInstalled] = useState<boolean | null>(null) // null = probing
  const [voices, setVoices]   = useState<VoiceOption[]>([])
  const [voiceA, setVoiceA]   = useState(() => seed()?.voiceA ?? '')
  const [voiceB, setVoiceB]   = useState(() => seed()?.voiceB ?? '')
  /** null = kokoro surface absent (pre-sidecar build) or still probing. */
  const [kokoro, setKokoro]   = useState<{ installed: boolean; downloading: boolean; voices: KokoroVoiceInfo[] } | null>(null)
  const [kokoroBusy, setKokoroBusy] = useState(false)   // ensure() in flight
  const [kokoroPct, setKokoroPct]   = useState(0)       // 0..1 real download progress
  const [savingToLibrary, setSavingToLibrary] = useState(false)

  // ── SCRIPT MODEL preflight (freellmapi's fallback catalog) ───────────────
  // A PRESENCE check, not a live ping: this panel promises a script "drafted by
  // the keyless FreeLLM router", yet nothing ever confirmed one was actually
  // configured before enabling Create — a fresh install with every free
  // provider unconfigured (or the one auto-picked model 401ing) could only
  // ever draft into a router error. Same shape as refreshVoices: probe on
  // mount, and degrade to "assume ready" (never block) when the surface is
  // simply absent (an older build, a test host) rather than inventing a
  // health-ping this app has no way to run.
  // null = still probing (Create stays gated, same as an unresolved voices
  // check); true = at least one enabled fallback model; false = none.
  const [scriptModelReady, setScriptModelReady] = useState<boolean | null>(null)
  const refreshScriptModel = useCallback(async () => {
    try {
      const list = window.tachi.freellmapi?.listFallbackModels
      if (typeof list !== 'function') { setScriptModelReady(true); return }
      const res = await list()
      setScriptModelReady(res?.ok ? hasUsableScriptModel(res.models) : true)
    } catch {
      setScriptModelReady(true)
    }
  }, [])

  useEffect(() => { void refreshScriptModel() }, [refreshScriptModel])

  // ── The rail speaks the UI language ──────────────────────────────────────
  // The runner outlives this component, so it cannot hold a `t` of its own: the
  // localized phrases are registered here on every locale change (the setter
  // contract mediaProgressBridge and activityNotify already use). The stage
  // phrases are common.json — they render on the RAIL, from a page that may be
  // unmounted — while the failure lines stay this panel's existing media.json
  // copy, so a failure reads the same wherever it is shown.
  useEffect(() => {
    setAudioOverviewCopy({
      stageScript:     () => tc('audioOverview.stage.script'),
      stageVoices:     (n, m) => tc('audioOverview.stage.voices', { n, m }),
      stageMix:        () => tc('audioOverview.stage.mix'),
      stageSaving:     () => tc('audioOverview.stage.saving'),
      errNoAudio:      () => t('audioOverview.error.noAudioReturned'),
      errLlmDown:      () => t('audioOverview.error.llmDown'),
      errEmptyReply:   () => t('audioOverview.error.emptyReply'),
      errParseFailed:  (reason) => t('audioOverview.error.parseFailed', { reason }),
      errScriptFailed: (reason) => t('audioOverview.error.scriptFailed', { reason }),
      errScriptUnreachable: () => t('audioOverview.error.scriptUnreachable'),
      errSynthFailed:  (n, m, reason) => t('audioOverview.error.synthFailed', { n, m, reason }),
      errStitchFailed: (reason) => t('audioOverview.error.stitchFailed', { reason }),
    })
  }, [t, tc])

  const refreshVoices = useCallback(async () => {
    // STUDIO (kokoro) — optional surface; absence is a normal state, not an error.
    let studio: KokoroVoiceInfo[] = []
    let kokoroInstalled = false
    try {
      const ks = await window.tachi.kokoro?.status()
      if (ks) {
        kokoroInstalled = ks.installed
        setKokoro({ installed: ks.installed, downloading: ks.downloading, voices: ks.voices })
        if (ks.installed) studio = ks.voices
      } else {
        setKokoro(null)
      }
    } catch {
      setKokoro(null)
    }
    try {
      const [status, catalog] = await Promise.all([
        window.tachi.piper.status(),
        window.tachi.piper.catalog().catch(() => ({ ok: false as const, voices: [], releases: [] })),
      ])
      setPiperInstalled(status.installed)
      const names = new Map((catalog.ok ? catalog.voices : []).map(v => [v.id, v.name]))
      const installed = status.voices.map(v => ({ id: v.id, name: names.get(v.id) ?? v.id }))
      setVoices(installed)
      // Default assignment across BOTH engines. STUDIO wins for English:
      // af_heart (Host A) / am_michael (Host B); else two distinct piper voices
      // when available, else share one. A still-valid manual pick is kept — and
      // after a remount `prev` is the pick the RUN IN FLIGHT is using, so the
      // pickers come back showing the voices actually being spoken.
      const all = [
        ...studio.map(v => packVoice('kokoro', v.id)),
        ...installed.map(v => packVoice('piper', v.id)),
      ]
      const defA = kokoroInstalled && studio.some(v => v.id === KOKORO_HOST_A_DEFAULT)
        ? packVoice('kokoro', KOKORO_HOST_A_DEFAULT)
        : (all[0] ?? '')
      const defB = kokoroInstalled && studio.some(v => v.id === KOKORO_HOST_B_DEFAULT)
        ? packVoice('kokoro', KOKORO_HOST_B_DEFAULT)
        : (all[1] ?? all[0] ?? '')
      setVoiceA(prev => all.includes(prev) ? prev : defA)
      setVoiceB(prev => all.includes(prev) ? prev : defB)
    } catch (err) {
      setPiperInstalled(false)
      setVoices([])
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  useEffect(() => { void refreshVoices() }, [refreshVoices])

  // A download started from another surface (Media → SPEECH) still shows live
  // progress here: while status says downloading and WE didn't start it, poll.
  useEffect(() => {
    if (!kokoro?.downloading || kokoroBusy) return
    const id = window.setInterval(() => {
      window.tachi.kokoro?.status()
        .then(s => {
          if (typeof s.progress === 'number') setKokoroPct(prev => Math.max(prev, Math.min(1, s.progress ?? 0)))
          if (s.installed || !s.downloading) { window.clearInterval(id); void refreshVoices() }
        })
        .catch(() => {})
    }, 1000)
    return () => window.clearInterval(id)
  }, [kokoro?.downloading, kokoroBusy, refreshVoices])

  // ── STUDIO VOICES one-time download (kokoro:ensure) ─────────────────────────
  // Real progress only: 'kokoro:progress' events when the preload exposes them,
  // plus a kokoro:status poll (status carries downloading/progress) as fallback.
  const startKokoroDownload = async () => {
    if (kokoroBusy || !window.tachi.kokoro) return
    setKokoroBusy(true)
    setKokoroPct(0)
    const offEvents = subscribeKokoroProgress(p => {
      setKokoroPct(prev => Math.max(prev, Math.min(1, Math.max(0, p.progress))))
    })
    const poll = window.setInterval(() => {
      window.tachi.kokoro?.status()
        .then(s => {
          if (typeof s.progress === 'number') setKokoroPct(prev => Math.max(prev, Math.min(1, s.progress ?? 0)))
        })
        .catch(() => {})
    }, 1000)
    try {
      const r = await window.tachi.kokoro.ensure()
      if (!r.ok) throw new Error(r.error || t('audioOverview.kokoro.downloadFailed'))
      await refreshVoices() // flips the card to the grouped pickers + studio defaults
      showToast({ kind: 'info', text: t('audioOverview.kokoro.installedToast') })
    } catch (err) {
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      window.clearInterval(poll)
      offEvents()
      setKokoroBusy(false)
    }
  }

  // ── Start / stop ─────────────────────────────────────────────────────────
  // The run is deliberately fire-and-forget: it belongs to the module, not to
  // this component, and it keeps going when the user navigates away. Only the
  // REFUSALS (which resolve immediately) are reported here, in this panel's own
  // copy — the runner names causes, never sentences.
  const start = (existingScript?: PodcastScript | null) => {
    void startAudioOverviewRun({ source, title, length, voiceA, voiceB, script: existingScript ?? null })
      .then(out => {
        if (out.reason === 'empty-source') showToast({ kind: 'error', text: t('audioOverview.error.emptySource') })
        else if (out.reason === 'no-voices') showToast({ kind: 'error', text: t('audioOverview.voices.none') })
      })
  }

  const retry = () => {
    const s = useAudioOverviewStore.getState()
    // A parsed script survives a synth/stitch failure — reuse it on retry.
    start(s.error && s.error.stage !== 'script' ? s.script : null)
  }

  // The blob is the instant, in-memory copy; the PATH is the durable one. Either
  // is a real source of audio — an absent one is simply not offered.
  const playbackSrc = result
    ? (result.url ?? (result.path ? mediaArtifactUrl(result.path) : null))
    : null

  const download = () => {
    if (!playbackSrc) return
    const a = document.createElement('a')
    a.href = playbackSrc
    const safe = (result?.title ?? 'audio-overview').replace(/[^\p{L}\p{N}\- _]/gu, '').trim().replace(/\s+/g, '-')
    a.download = `${safe || 'audio-overview'}.wav`
    a.click()
  }

  // The run already saved the WAV on completion. This is the RETRY for the run
  // whose save failed (a full disk, a folder that went unwritable): the stitched
  // bytes are still held by the runner, so nothing is re-rendered.
  const canSaveToLibrary = typeof window.tachi.media?.saveWav === 'function'
  const saveToLibrary = async () => {
    if (savingToLibrary) return
    setSavingToLibrary(true)
    try {
      const r = await saveAudioOverviewFile()
      if (!r.ok) throw new Error(r.error || t('audioOverview.saveFailed'))
      showToast({ kind: 'info', text: t('toast.savedTo', { path: r.path ?? '' }) })
    } catch (err) {
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSavingToLibrary(false)
    }
  }

  const statusLine =
    stage === 'scripting'      ? t('audioOverview.status.drafting')
    : stage === 'synthesizing' ? t('audioOverview.status.synthesizing', { n: progress.n, m: progress.m })
    : stage === 'stitching'    ? t('audioOverview.status.stitching')
    : stage === 'saving'       ? tc('audioOverview.stage.saving')
    : stage === 'ready'        ? t('audioOverview.status.ready')
    : null

  const studioVoices = kokoro?.installed ? kokoro.voices : []
  const kokoroDownloading = kokoroBusy || kokoro?.downloading === true
  const voicesReady = studioVoices.length > 0 || (piperInstalled === true && voices.length > 0)
  // The one gate behind Create: voices, the script-model preflight (null =
  // still probing, treated the same as "not ready" yet) and a non-empty
  // source all have to hold — disabled, the dimmed style and the cursor all
  // read this SAME expression, so none of the three can drift from the rest.
  const cannotGenerate = !voicesReady || scriptModelReady !== true || source.trim().length === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageTopbar section="Media" />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0 }}>
        {/* ── Left: composer ─────────────────────────────────────────────── */}
        <div style={{
          width: 340, flexShrink: 0, borderRight: '2px solid var(--border)',
          background: 'var(--bg-surface)', padding: 16, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 14,
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {t('audioOverview.subtitle')}
          </div>

          {/* Title (optional) */}
          <div>
            <span style={labelStyle}>{t('audioOverview.titleLabel')}</span>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={t('audioOverview.titlePlaceholder')}
              disabled={busy}
              style={inputStyle}
            />
          </div>

          {/* Source notes */}
          <div>
            <span style={labelStyle}>{t('audioOverview.sourceLabel')}<span style={{ color: 'var(--warning)', marginLeft: 4 }}>*</span></span>
            <textarea
              value={source}
              onChange={e => setSource(e.target.value)}
              placeholder={t('audioOverview.sourcePlaceholder')}
              disabled={busy}
              rows={12}
              style={{ ...inputStyle, resize: 'vertical', minHeight: 160, lineHeight: 1.5 }}
            />
            <div style={{ marginTop: 4, fontSize: 9, color: source.length > MAX_SOURCE_CHARS ? 'var(--warning)' : 'var(--text-dim)' }}>
              {t('audioOverview.sourceHint', { max: MAX_SOURCE_CHARS, current: source.length })}
            </div>
          </div>

          {/* Length */}
          <div>
            <span style={labelStyle}>{t('audioOverview.lengthLabel')}</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['short', 'standard'] as OverviewLength[]).map(l => {
                const active = length === l
                return (
                  <button
                    key={l}
                    onClick={() => setLength(l)}
                    disabled={busy}
                    style={{
                      ...btnStyle, flex: 1,
                      border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      background: active ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                      color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                    }}
                  >
                    {t(`audioOverview.length.${l}`)}
                  </button>
                )
              })}
            </div>
          </div>

          {/* STUDIO VOICES — one-time model download (only when the kokoro
              surface exists and the model is not installed yet). */}
          {kokoro && !kokoro.installed && (
            <div style={{ border: '2px solid var(--accent)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent-text)' }}>
                {t('audioOverview.kokoro.cardTitle')}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {t('audioOverview.kokoro.cardBody')}
              </span>
              {kokoroDownloading ? (
                <div>
                  <div style={{ border: '2px solid var(--border)', height: 12, background: 'var(--bg-inset)' }}>
                    <div style={{ height: '100%', width: `${Math.round(kokoroPct * 100)}%`, background: 'var(--accent)', transition: 'width 300ms linear' }} />
                  </div>
                  <div style={{ marginTop: 4, fontSize: 9, color: 'var(--accent-text)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t('audioOverview.kokoro.downloading', { percent: Math.round(kokoroPct * 100) })}
                  </div>
                </div>
              ) : (
                <button onClick={() => void startKokoroDownload()} style={{ ...btnStyle, border: '2px solid var(--accent)', color: 'var(--accent-text)' }}>
                  {t('audioOverview.kokoro.download')}
                </button>
              )}
            </div>
          )}

          {/* Voices */}
          <div>
            <span style={labelStyle}>{t('audioOverview.voices.label')}</span>
            {piperInstalled === null ? (
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>{t('audioOverview.voices.probing')}</div>
            ) : !voicesReady ? (
              <div style={{ fontSize: 10, color: 'var(--warning)', lineHeight: 1.5 }}>
                {piperInstalled ? t('audioOverview.voices.none') : t('audioOverview.voices.notInstalled')}
                <div style={{ marginTop: 6 }}>
                  <button onClick={() => void refreshVoices()} style={btnStyle}>{t('audioOverview.voices.refresh')}</button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {([['A', voiceA, setVoiceA], ['B', voiceB, setVoiceB]] as const).map(([host, value, setValue]) => (
                  <div key={host}>
                    <span style={{ ...labelStyle, marginBottom: 2 }}>{t(`audioOverview.voices.host${host}`)}</span>
                    <select value={value} onChange={e => setValue(e.target.value)} disabled={busy} style={inputStyle}>
                      {studioVoices.length > 0 && (
                        <optgroup label={t('audioOverview.voices.groupStudio')}>
                          {studioVoices.map(v => <option key={v.id} value={packVoice('kokoro', v.id)}>{v.label}</option>)}
                        </optgroup>
                      )}
                      {voices.length > 0 && (
                        <optgroup label={t('audioOverview.voices.groupPiper')}>
                          {voices.map(v => <option key={v.id} value={packVoice('piper', v.id)}>{v.name}</option>)}
                        </optgroup>
                      )}
                    </select>
                  </div>
                ))}
                {studioVoices.length === 0 && voices.length === 1 && (
                  <div style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                    {t('audioOverview.voices.single')}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* SCRIPT MODEL — a presence/config check, not a live ping: this
              panel promises "drafted by the keyless FreeLLM router", so Create
              stays gated until freellmapi's own fallback catalog names at
              least one enabled model to draft with (see refreshScriptModel). */}
          {scriptModelReady === false && (
            <div style={{ fontSize: 10, color: 'var(--warning)', lineHeight: 1.5 }}>
              {t('audioOverview.scriptModel.notConfigured')}
              <div style={{ marginTop: 6 }}>
                <button onClick={() => void refreshScriptModel()} style={btnStyle}>{t('audioOverview.voices.refresh')}</button>
              </div>
            </div>
          )}

          {/* Generate / Cancel. STOP latches — the pipeline unwinds at its next
              checkpoint, and nothing here claims it has already stopped. */}
          <button
            onClick={() => (busy ? cancelAudioOverviewRun() : start())}
            disabled={busy ? stopping : cannotGenerate}
            style={{
              padding: '10px 12px',
              border: '2px solid var(--accent)',
              background: busy ? 'var(--bg-elevated)' : cannotGenerate ? 'var(--bg-elevated)' : 'var(--accent)',
              color: busy ? 'var(--accent-text)' : cannotGenerate ? 'var(--text-dim)' : '#ffffff',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
              cursor: (!busy && cannotGenerate) ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? (stopping ? tc('activity.stopping') : t('audioOverview.cancel')) : t('audioOverview.generate')}
          </button>

          {statusLine && stage !== 'ready' && (
            <div style={{ fontSize: 10, color: 'var(--accent-text)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              {statusLine}
            </div>
          )}
        </div>

        {/* ── Right: result ──────────────────────────────────────────────── */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: 16,
          background: 'var(--bg-base)', fontFamily: 'JetBrains Mono, monospace',
        }}>
          {stage === 'idle' && !script && !result ? (
            <div style={{
              color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.6,
              border: '2px dashed var(--border)', padding: 24, textAlign: 'center',
            }}>
              {t('audioOverview.empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Error banner + retry */}
              {stage === 'error' && error && (
                <div style={{ border: '2px solid var(--danger)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--danger)', wordBreak: 'break-word', lineHeight: 1.5 }}>
                    {error.message}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={retry} style={{ ...btnStyle, border: '2px solid var(--accent)', color: 'var(--accent-text)' }}>
                      {t('audioOverview.retry')}
                    </button>
                    <button onClick={() => useAudioOverviewStore.getState().clearError()} style={btnStyle}>
                      {t('audioOverview.dismiss')}
                    </button>
                  </div>
                </div>
              )}

              {/* Live status while working */}
              {busy && statusLine && (
                <div style={{ border: '2px solid var(--border)', padding: 12, fontSize: 11, color: 'var(--accent-text)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {statusLine}
                </div>
              )}

              {/* Player */}
              {result && playbackSrc && stage === 'ready' && (
                <div style={{ border: '2px solid var(--accent)', background: 'var(--bg-surface)' }}>
                  <div style={{
                    padding: '6px 10px', borderBottom: '2px solid var(--border)',
                    display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-elevated)',
                  }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent-text)' }}>
                      {t('audioOverview.status.ready')}
                    </span>
                    <span style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {result.title}
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                      {t('audioOverview.result.meta', { seconds: result.durationSec, turns: result.turns })}
                    </span>
                  </div>
                  <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <audio controls src={playbackSrc} style={{ display: 'block', width: '100%', maxWidth: 560 }} />

                    {/* WHERE THE FILE IS. The run saved it on completion, so this
                        is a fact about the disk — never rendered without a path. */}
                    {result.path && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', flexShrink: 0 }}>
                          {tc('audioOverview.saved')}
                        </span>
                        <span
                          title={result.path}
                          style={{
                            fontSize: 10, color: 'var(--text-muted)', flex: 1, minWidth: 0,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          {result.path}
                        </span>
                      </div>
                    )}
                    {result.saveError && (
                      <span style={{ fontSize: 10, color: 'var(--warning)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                        {tc('audioOverview.saveFailed', { reason: result.saveError })}
                      </span>
                    )}

                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={download} style={{ ...btnStyle, border: '2px solid var(--accent)', color: 'var(--accent-text)' }}>
                        {t('audioOverview.download')}
                      </button>
                      {result.path && (
                        <button
                          onClick={() => { window.tachi.shell.revealInFolder(result.path as string).catch(() => { /* moved / deleted */ }) }}
                          style={btnStyle}
                        >
                          {tc('audioOverview.reveal')}
                        </button>
                      )}
                      {/* Only when the file is NOT on disk — the auto-save failed
                          or the surface is absent. Never a second button for work
                          that is already done. */}
                      {!result.path && canSaveToLibrary && (
                        <button onClick={() => void saveToLibrary()} disabled={savingToLibrary} style={{ ...btnStyle, opacity: savingToLibrary ? 0.6 : 1 }}>
                          {savingToLibrary ? t('audioOverview.savingToLibrary') : t('audioOverview.saveToLibrary')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Transcript */}
              {script && (
                <div style={{ border: '2px solid var(--border)', background: 'var(--bg-surface)' }}>
                  <div style={{ padding: '6px 10px', borderBottom: '2px solid var(--border)', background: 'var(--bg-elevated)' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                      {t('audioOverview.transcript')} — {script.title}
                    </span>
                  </div>
                  <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {script.turns.map((turn, i) => (
                      <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                        <span style={{
                          flexShrink: 0, padding: '1px 6px',
                          border: `2px solid ${turn.host === 'A' ? 'var(--accent)' : 'var(--border)'}`,
                          fontSize: 9, fontWeight: 700,
                          color: turn.host === 'A' ? 'var(--accent-text)' : 'var(--text-muted)',
                        }}>
                          {turn.host}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6, wordBreak: 'break-word' }}>
                          {turn.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
