// apps/desktop/src/pages/settings/WhisperSection.tsx
//
// Settings section for local speech-to-text via whisper.cpp.
// Brutalist style: 2px borders, JetBrains Mono, no border-radius, CSS vars.

import React from 'react'
import { useTranslation } from 'react-i18next'
import type { WhisperModelName, WhisperModelInfo, WhisperProgressEvent } from '../../types/electron'
import { encodeWavPcm16Mono, concatFloat32 } from '../../utils/wav-encoder'

type AudioContextCtor = new (opts?: { sampleRate?: number }) => AudioContext

// ─── Style constants ──────────────────────────────────────────────────────────

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace' }

const CARD: React.CSSProperties = {
  ...MONO,
  border: '2px solid var(--border)',
  background: 'var(--bg-elevated)',
  boxShadow: 'var(--shadow-hard)',
  padding: 12,
}

const BTN_BASE: React.CSSProperties = {
  ...MONO,
  fontSize: 9,
  fontWeight: 700,
  padding: '4px 10px',
  cursor: 'pointer',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.08em',
  border: '2px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-primary)',
}

const BTN_PRIMARY: React.CSSProperties = {
  ...BTN_BASE,
  background: 'var(--accent)',
  color: '#fff',
  border: '2px solid var(--accent)',
  boxShadow: 'var(--shadow-hard)',
}

const SELECT: React.CSSProperties = {
  ...MONO,
  fontSize: 10,
  padding: '5px 8px',
  border: '2px solid var(--border)',
  background: 'var(--bg-base)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
}

// Model name + size prefix stays verbatim (brand/format); the trailing descriptor
// is translated via whisper.modelDescriptions.<value> at render time.
const MODEL_OPTIONS: { value: WhisperModelName; prefix: string }[] = [
  { value: 'tiny.en',   prefix: 'tiny.en   (~75 MB)  — ' },
  { value: 'base.en',   prefix: 'base.en   (~142 MB) — ' },
  { value: 'small.en',  prefix: 'small.en  (~466 MB) — ' },
  { value: 'medium.en', prefix: 'medium.en (~1.5 GB) — ' },
  // R10 — the only multilingual option (and smaller than medium.en).
  { value: 'large-v3-turbo-q5_0', prefix: 'large-v3-turbo-q5_0 (~547 MB) — ' },
]

// ─── Status dot ───────────────────────────────────────────────────────────────

type DotStatus = 'not-ready' | 'downloading' | 'ready' | 'error'

function StatusDot({ status }: { status: DotStatus }) {
  const { t } = useTranslation('settings')
  const color =
    status === 'ready'       ? 'var(--success)' :
    status === 'downloading' ? 'var(--warning)' :
    status === 'error'       ? 'var(--danger)'  :
    'var(--text-muted)'

  const label =
    status === 'ready'       ? t('whisper.status.ready')       :
    status === 'downloading' ? t('whisper.status.downloading') :
    status === 'error'       ? t('whisper.status.error')       :
    t('whisper.status.notReady')

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        display: 'inline-block',
        width: 8, height: 8,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
      }} />
      <span style={{ fontSize: 9, color, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
    </span>
  )
}

// ─── Test microphone sub-component ───────────────────────────────────────────

function TestMicSection({ modelName }: { modelName: WhisperModelName }) {
  const { t } = useTranslation('settings')
  const [phase,  setPhase]  = React.useState<'idle' | 'recording' | 'transcribing' | 'done' | 'error'>('idle')
  const [result, setResult] = React.useState<string | null>(null)

  // Capture 3 s of mic as 16 kHz mono PCM WAV (the format whisper-cli needs),
  // mirroring useWhisperRecognition — no MediaRecorder/webm, no ffmpeg.
  const run = async () => {
    setPhase('recording')
    setResult(null)

    const AudioCtx = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as AudioContextCtor | undefined
    if (!AudioCtx) { setPhase('error'); setResult('Web Audio not available'); return }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    } catch {
      setPhase('error')
      setResult(t('whisper.testMic.permissionDenied'))
      return
    }

    const ctx = new AudioCtx({ sampleRate: 16000 })
    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    const frames: Float32Array[] = []
    processor.onaudioprocess = (e) => { frames.push(new Float32Array(e.inputBuffer.getChannelData(0))) }
    const mute = ctx.createGain(); mute.gain.value = 0
    source.connect(processor); processor.connect(mute); mute.connect(ctx.destination)

    const finish = async () => {
      try { processor.disconnect() } catch { /* */ }
      try { source.disconnect() } catch { /* */ }
      const sr = ctx.sampleRate
      stream.getTracks().forEach(t => t.stop())
      try { void ctx.close() } catch { /* */ }
      setPhase('transcribing')
      try {
        const wav = encodeWavPcm16Mono(concatFloat32(frames), sr)
        let bin = ''
        for (let i = 0; i < wav.length; i++) bin += String.fromCharCode(wav[i])
        const res = await window.tachi.whisper.transcribe(btoa(bin), modelName)
        setResult(res.text.trim() || t('whisper.testMic.noSpeech'))
        setPhase('done')
      } catch (err) {
        setResult(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    }

    // Auto-stop after 3 s
    setTimeout(() => { void finish() }, 3_000)
  }

  const busy = phase === 'recording' || phase === 'transcribing'

  return (
    <div style={{ marginTop: 12, borderTop: 'var(--border-width) solid var(--border)', paddingTop: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
        {t('whisper.testMic.title')}
      </div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 8 }}>
        {t('whisper.testMic.description')}
      </div>
      <button
        onClick={run}
        disabled={busy}
        style={{ ...BTN_PRIMARY, opacity: busy ? 0.5 : 1 }}
      >
        {phase === 'recording'     ? t('whisper.testMic.recording')     :
         phase === 'transcribing'  ? t('whisper.testMic.transcribing')  :
         t('whisper.testMic.record')}
      </button>
      {result !== null && (
        <div style={{
          ...MONO,
          marginTop: 8,
          padding: '6px 8px',
          border: `2px solid ${phase === 'error' ? 'var(--danger)' : 'var(--border)'}`,
          background: 'var(--bg-base)',
          fontSize: 10,
          color: phase === 'error' ? 'var(--danger)' : 'var(--text-primary)',
          wordBreak: 'break-word',
        }}>
          {result}
        </div>
      )}
    </div>
  )
}

// ─── Main section component ───────────────────────────────────────────────────

export function WhisperSection() {
  const { t } = useTranslation('settings')
  const [models,      setModels]      = React.useState<WhisperModelInfo[]>([])
  const [selected,    setSelected]    = React.useState<WhisperModelName>('base.en')
  const [dotStatus,   setDotStatus]   = React.useState<DotStatus>('not-ready')
  const [progress,    setProgress]    = React.useState<WhisperProgressEvent | null>(null)
  const [downloading, setDownloading] = React.useState(false)
  const [dlError,     setDlError]     = React.useState<string | null>(null)
  const [canInstall,  setCanInstall]  = React.useState(false)
  const [cliInstalled,setCliInstalled]= React.useState(false)
  const [installing,  setInstalling]  = React.useState(false)
  const [installMsg,  setInstallMsg]  = React.useState<string | null>(null)

  // ── Load initial state ──────────────────────────────────────────────────────
  const reload = React.useCallback(async () => {
    try {
      const info = await window.tachi.whisper.checkInstalled()
      setModels(info.models)
      setCanInstall(Boolean(info.canInstall))
      setCliInstalled(Boolean(info.cliInstalled))
      const sel = info.models.find(m => m.name === selected)
      setDotStatus(sel?.ready ? 'ready' : 'not-ready')
    } catch {
      setDotStatus('error')
    }
  }, [selected])

  // ── Install the prebuilt engine (audit H3, Windows) ──────────────────────────
  const installEngine = async () => {
    setInstalling(true)
    setInstallMsg(null)
    const unsub = window.tachi.whisper.onInstallProgress((evt) => {
      const e = evt as { stage: string; message: string }
      setInstallMsg(e.message)
    })
    try {
      const res = await window.tachi.whisper.install()
      if (!res.ok) setInstallMsg(res.error ?? 'Install failed')
      else { setInstallMsg(null); await reload() }
    } catch (err) {
      setInstallMsg(err instanceof Error ? err.message : String(err))
    } finally {
      unsub()
      setInstalling(false)
    }
  }

  React.useEffect(() => { reload() }, [reload])

  // Refresh dot when selection changes
  React.useEffect(() => {
    const m = models.find(m => m.name === selected)
    if (m) setDotStatus(m.ready ? 'ready' : 'not-ready')
  }, [selected, models])

  // ── Download ────────────────────────────────────────────────────────────────
  const download = async () => {
    setDlError(null)
    setDownloading(true)
    setDotStatus('downloading')
    setProgress(null)

    const unsub = window.tachi.whisper.onProgress((evt: unknown) => {
      const e = evt as WhisperProgressEvent
      setProgress(e)
      if (e.stage === 'error') {
        setDlError(e.message)
        setDotStatus('error')
      }
    })

    try {
      const res = await window.tachi.whisper.downloadModel(selected)
      setModels(res.models)
      const m = res.models.find(m => m.name === selected)
      setDotStatus(m?.ready ? 'ready' : 'error')
    } catch (err) {
      setDlError(err instanceof Error ? err.message : String(err))
      setDotStatus('error')
    } finally {
      unsub()
      setDownloading(false)
    }
  }

  const selectedModel = models.find(m => m.name === selected)
  const selectedReady = selectedModel?.ready ?? false

  return (
    <div style={{ ...CARD, marginTop: 24 }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-primary)' }}>
          {t('whisper.heading')}
        </div>
        <StatusDot status={dotStatus} />
      </div>

      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 12 }}>
        {t('whisper.description.before')}{' '}
        <a
          href="#"
          onClick={e => { e.preventDefault(); window.tachi.shell.openExternal('https://github.com/ggerganov/whisper.cpp') }}
          style={{ color: 'var(--accent)' }}
        >
          whisper.cpp
        </a>
        {' '}{t('whisper.description.after')}
      </div>

      {/* Install prebuilt engine — shown on platforms with a prebuilt (Windows)
          that haven't installed it yet. No C++ toolchain needed. */}
      {canInstall && !cliInstalled && (
        <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={installEngine}
            disabled={installing}
            style={{ ...BTN_PRIMARY, opacity: installing ? 0.5 : 1 }}
          >
            {installing ? 'Installing…' : 'Install local speech-to-text'}
          </button>
          <span style={{ ...MONO, fontSize: 9, color: 'var(--text-muted)' }}>
            {installMsg ?? 'Prebuilt whisper binary — no build tools required.'}
          </span>
        </div>
      )}

      {/* Model picker */}
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 4 }}>
          {t('whisper.modelLabel')}
        </label>
        <select
          value={selected}
          onChange={e => setSelected(e.target.value as WhisperModelName)}
          disabled={downloading}
          style={SELECT}
        >
          {MODEL_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>
              {o.prefix}{t(`whisper.modelDescriptions.${o.value}`)}
              {models.find(m => m.name === o.value)?.ready ? t('whisper.downloadedSuffix') : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Download button + status */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          onClick={download}
          disabled={downloading || selectedReady}
          style={{ ...BTN_PRIMARY, opacity: (downloading || selectedReady) ? 0.5 : 1 }}
        >
          {downloading ? t('whisper.downloading') : selectedReady ? t('whisper.downloaded') : t('whisper.downloadModel')}
        </button>
        {downloading && progress && (
          <span style={{ ...MONO, fontSize: 9, color: 'var(--text-muted)' }}>
            {progress.message}
          </span>
        )}
      </div>

      {/* Error */}
      {dlError && (
        <div style={{ ...MONO, fontSize: 9, color: 'var(--danger)', marginTop: 6, wordBreak: 'break-word' }}>
          {dlError}
        </div>
      )}

      {/* Downloaded models list */}
      {models.some(m => m.ready) && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
            {t('whisper.downloadedModels')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {models.filter(m => m.ready).map(m => (
              <span key={m.name} style={{
                ...MONO,
                fontSize: 9,
                padding: '2px 7px',
                border: '2px solid var(--border)',
                background: 'var(--bg-surface)',
                color: 'var(--accent)',
              }}>
                {m.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Test microphone — only show when at least the selected model is ready */}
      {selectedReady && <TestMicSection modelName={selected} />}
    </div>
  )
}
