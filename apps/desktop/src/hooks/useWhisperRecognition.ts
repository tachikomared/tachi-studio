// apps/desktop/src/hooks/useWhisperRecognition.ts
//
// Local speech-to-text via whisper.cpp (nodejs-whisper under the hood).
// Mirrors the public API of useSpeechRecognition so callers can swap with
// minimal changes — same { listening, supported, start, stop, interim, error }.
//
// Flow:
//   1. user calls start()
//   2. Web Audio captures the mic at 16 kHz MONO (AudioContext + ScriptProcessor)
//      until the caller calls stop() or the optional maxDurationMs elapses
//   3. Float32 frames → 16-bit mono PCM WAV → base64 → whisper.transcribe()
//   4. onFinal callback fires with the returned text
//
// Why 16 kHz mono PCM (audit H3): whisper.cpp's whisper-cli requires exactly
// that. The old path recorded webm/opus at the device's native rate and leaned
// on nodejs-whisper's internal ffmpeg; the prebuilt whisper-cli has no ffmpeg,
// so we now produce the correct format directly (also valid for the
// nodejs-whisper fallback). No ffmpeg dependency.
//
// The hook advertises `supported = false` when the whisper IPC surface or the
// Web Audio API is unavailable, letting the UI fall back gracefully.

import { useEffect, useRef, useState, useCallback } from 'react'
import type { WhisperModelName } from '../types/electron'
import { encodeWavPcm16Mono, concatFloat32 } from '../utils/wav-encoder'
// Pure registry helpers (no electron imports) — shared with the main process so
// the model/language contract cannot drift between the two sides.
import { normalizeWhisperLang, pickWhisperModel } from '../../electron/services/whisper-models'

// Older lib.dom typings omit the AudioContext sampleRate ctor option; declare it.
type AudioContextCtor = new (opts?: { sampleRate?: number }) => AudioContext

interface UseWhisperRecognitionOptions {
  /** Pin a model. Omit to auto-pick from what's downloaded + the `lang` hint. */
  modelName?:      WhisperModelName
  /** i18n locale hint (`i18n.language`: `en`, `ru`, `zh-Hans`, …). Unknown → auto. */
  lang?:           string
  maxDurationMs?:  number   // hard stop if user forgets to call stop() — default 60 s
  onFinal?:        (text: string) => void
}

export function useWhisperRecognition({
  modelName,
  lang,
  maxDurationMs  = 60_000,
  onFinal,
}: UseWhisperRecognitionOptions = {}) {
  const [listening,   setListening]   = useState(false)
  const [interim,     setInterim]     = useState('')   // always '' — whisper returns final only
  const [error,       setError]       = useState<string | null>(null)
  const [processing,  setProcessing]  = useState(false)
  // Auto-picked model when the caller didn't pin one (R10 — a Russian UI must
  // reach for the multilingual weights, not base.en).
  const [autoModel,   setAutoModel]   = useState<WhisperModelName | null>(null)

  const streamRef     = useRef<MediaStream | null>(null)
  const ctxRef        = useRef<AudioContext | null>(null)
  const sourceRef     = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef  = useRef<ScriptProcessorNode | null>(null)
  const samplesRef    = useRef<Float32Array[]>([])
  const onFinalRef    = useRef(onFinal)
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { onFinalRef.current = onFinal }, [onFinal])

  const AudioCtx: AudioContextCtor | undefined =
    typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext)
      : undefined

  // Feature-detect: IPC surface + Web Audio + getUserMedia.
  const supported =
    typeof window !== 'undefined' &&
    typeof window.tachi?.whisper?.transcribe === 'function' &&
    !!AudioCtx &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia

  // The language we send as the transcription hint (`auto` when unknown).
  const language = normalizeWhisperLang(lang)

  // Resolve the model once per (locale, pin) from what is actually downloaded.
  useEffect(() => {
    if (modelName || !supported) return
    let cancelled = false
    window.tachi.whisper.listModels()
      .then(models => { if (!cancelled) setAutoModel(pickWhisperModel(models, language)) })
      .catch(() => { /* keep the fallback below */ })
    return () => { cancelled = true }
  }, [modelName, supported, language])

  const effectiveModel: WhisperModelName =
    modelName ?? autoModel ?? pickWhisperModel([], language)

  // Tear down the capture graph; returns the captured WAV bytes (or null).
  const teardownCapture = useCallback((): Uint8Array | null => {
    try { processorRef.current?.disconnect() } catch { /* */ }
    try { sourceRef.current?.disconnect() } catch { /* */ }
    const ctx = ctxRef.current
    const sr = ctx?.sampleRate ?? 16000
    streamRef.current?.getTracks().forEach(t => t.stop())
    try { void ctx?.close() } catch { /* */ }
    processorRef.current = null
    sourceRef.current = null
    ctxRef.current = null
    streamRef.current = null
    const chunks = samplesRef.current
    samplesRef.current = []
    if (chunks.length === 0) return null
    return encodeWavPcm16Mono(concatFloat32(chunks), sr)
  }, [])

  const transcribeWav = useCallback(async (wav: Uint8Array) => {
    setProcessing(true)
    try {
      let binary = ''
      for (let i = 0; i < wav.length; i++) binary += String.fromCharCode(wav[i])
      const audioBase64 = btoa(binary)
      const result = await window.tachi.whisper.transcribe(audioBase64, effectiveModel, language)
      setInterim('')
      if (result.text.trim()) onFinalRef.current?.(result.text.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setInterim('')
    } finally {
      setProcessing(false)
    }
  }, [effectiveModel, language])

  const stop = useCallback(() => {
    if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
    if (!ctxRef.current) return
    setListening(false)
    setInterim('')
    const wav = teardownCapture()
    if (!wav) { setError('No audio recorded'); return }
    void transcribeWav(wav)
  }, [teardownCapture, transcribeWav])

  const start = useCallback(() => {
    setError(null)
    setInterim('')
    if (!supported || !AudioCtx) { setError('Local speech-to-text not available'); return }
    if (ctxRef.current) teardownCapture()   // stop any in-progress capture

    navigator.mediaDevices
      .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
      .then((stream) => {
        samplesRef.current = []
        streamRef.current = stream
        // 16 kHz context → the mic source is resampled to 16 kHz for us.
        const ctx = new AudioCtx({ sampleRate: 16000 })
        ctxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)
        sourceRef.current = source
        const processor = ctx.createScriptProcessor(4096, 1, 1)
        processorRef.current = processor
        processor.onaudioprocess = (e) => {
          // Copy — the event buffer is reused across callbacks.
          samplesRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
        }
        source.connect(processor)
        // Route through a muted gain so the ScriptProcessor fires without echoing
        // the mic back to the speakers.
        const mute = ctx.createGain()
        mute.gain.value = 0
        processor.connect(mute)
        mute.connect(ctx.destination)

        setListening(true)
        timerRef.current = setTimeout(() => { if (ctxRef.current) stop() }, maxDurationMs)
      })
      .catch((err) => {
        setError(
          err instanceof Error
            ? (err.name === 'NotAllowedError' ? 'Microphone permission denied' : err.message)
            : String(err),
        )
        setListening(false)
      })
  }, [supported, AudioCtx, maxDurationMs, teardownCapture, stop])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      if (ctxRef.current) { try { teardownCapture() } catch { /* swallow */ } }
    }
  }, [teardownCapture])

  return {
    listening:  listening || processing,
    supported,
    start,
    stop,
    interim,
    error,
    processing,
  }
}
