// apps/desktop/src/hooks/useSpeechRecognition.ts
//
// Thin wrapper around the browser Web Speech API (works in Electron via Chromium).
// Returns a controller: { listening, supported, start, stop, interim, error }
//
// Interim transcript is the partial recognition (updates as the user speaks).
// Final transcript is emitted via the onFinal callback.

import { useEffect, useRef, useState } from 'react'

type SR = typeof window extends { SpeechRecognition: infer T } ? T : unknown

interface UseSpeechRecognitionOptions {
  lang?:    string
  onFinal?: (text: string) => void
}

interface SpeechRecognitionAlternative { transcript: string }
interface SpeechRecognitionResult {
  isFinal: boolean
  [index: number]: SpeechRecognitionAlternative
  length: number
}
interface SpeechRecognitionEvent {
  resultIndex: number
  results: { [index: number]: SpeechRecognitionResult; length: number }
}
interface SpeechRecognitionErrorEvent {
  error:   string
  message?: string
}

interface SpeechRecognitionLike {
  lang:               string
  continuous:         boolean
  interimResults:     boolean
  start():            void
  stop():             void
  abort():            void
  onresult:           ((ev: SpeechRecognitionEvent) => void) | null
  onend:              (() => void) | null
  onerror:            ((ev: SpeechRecognitionErrorEvent) => void) | null
  onstart:            (() => void) | null
}

function getSR(): { new (): SpeechRecognitionLike } | null {
  const w = window as unknown as {
    SpeechRecognition?:      { new (): SpeechRecognitionLike }
    webkitSpeechRecognition?: { new (): SpeechRecognitionLike }
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function useSpeechRecognition({ lang = 'en-US', onFinal }: UseSpeechRecognitionOptions = {}) {
  const SRClass = getSR()
  const supported = SRClass !== null
  const [listening, setListening] = useState(false)
  const [interim,   setInterim]   = useState('')
  const [error,     setError]     = useState<string | null>(null)
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const onFinalRef = useRef(onFinal)
  useEffect(() => { onFinalRef.current = onFinal }, [onFinal])

  const stop = () => {
    try { recRef.current?.stop() } catch { /* swallow */ }
  }

  const start = () => {
    setError(null)
    setInterim('')
    if (!SRClass) {
      setError('Speech recognition not supported in this build')
      return
    }
    if (recRef.current) {
      try { recRef.current.abort() } catch { /* swallow */ }
    }
    const rec = new SRClass()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.onstart = () => { setListening(true) }
    rec.onend   = () => {
      setListening(false)
      setInterim('')
    }
    rec.onerror = (ev) => {
      setError(ev.message ?? ev.error ?? 'speech error')
      setListening(false)
    }
    rec.onresult = (ev) => {
      let interimText = ''
      let finalText   = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]
        const t = r[0]?.transcript ?? ''
        if (r.isFinal) finalText += t
        else           interimText += t
      }
      if (finalText.trim()) {
        onFinalRef.current?.(finalText.trim())
        setInterim('')
      } else {
        setInterim(interimText)
      }
    }
    recRef.current = rec
    try { rec.start() }
    catch (e) {
      setError(String(e))
      setListening(false)
    }
  }

  useEffect(() => () => { try { recRef.current?.abort() } catch { /* swallow */ } }, [])

  return { listening, supported, start, stop, interim, error }
}
