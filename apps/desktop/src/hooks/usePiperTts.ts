// apps/desktop/src/hooks/usePiperTts.ts
//
// Chunked LLM->TTS pipeline (airi packages/pipelines-audio pattern, adapted to
// our local piper sidecar). Instead of waiting for a full assistant message,
// we accumulate streamed deltas, flush each COMPLETE sentence/clause to piper
// as soon as its boundary arrives, and play the resulting WAV chunks in order.
// Result: the voice starts speaking while the model is still generating.
//
// Fully local + dep-free: window.tachi.piper.synthesize spawns a local binary
// (no network, no keychain, no PRIVATE MODE gating). Returns stable callbacks so
// the App-level chat onChunk subscription does not re-bind on every render.

import { useCallback, useRef } from 'react'
import { useTtsStore } from '../store/tts.store'

/** Strip <think>/<thought>/<reasoning> blocks (and stray tags) before speaking. */
function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/<\/?(?:think|thought|reasoning)\s*>/gi, '')
    .trim()
}

/**
 * Scan backwards for the last sentence/clause boundary in the buffer. Returns
 * the index JUST AFTER the boundary char, or -1 if none. Avoids splitting
 * decimals like "3.14".
 */
function findLastBoundary(buf: string): number {
  for (let i = buf.length - 1; i >= 0; i--) {
    const ch = buf[i]
    if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= buf.length || /\s/.test(buf[i + 1] ?? ''))) {
      const prev = i > 0 ? (buf[i - 1] ?? '') : ''
      if (ch === '.' && /\d/.test(prev)) continue
      return i + 1
    }
    if (ch === '\n' || ch === ';') return i + 1
  }
  return -1
}

export interface PiperTtsControls {
  /** Feed one streamed delta for a message; speaks each completed sentence. */
  feedDelta: (text: string, msgId: string) => void
  /** Flush any buffered tail for a message when its stream ends. */
  finalizeTts: (msgId: string) => void
  /** Stop playback + drop all buffers (e.g. on mute or conversation switch). */
  stopAll: () => void
}

export function usePiperTts(): PiperTtsControls {
  // Per-message rolling buffer of text not yet flushed to piper.
  const bufRef = useRef<Record<string, string>>({})
  // Serialized playback chain so WAV chunks play strictly in order.
  const playRef = useRef<Promise<void>>(Promise.resolve())
  // Most recent <audio> element, so stopAll() can interrupt it.
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const enqueuePlay = useCallback((b64: string) => {
    playRef.current = playRef.current.then(() => new Promise<void>((resolve) => {
      try {
        const audio = new Audio(`data:audio/wav;base64,${b64}`)
        audioRef.current = audio
        audio.onended = () => resolve()
        audio.onerror = () => resolve()
        void audio.play().catch(() => resolve())
      } catch { resolve() }
    }))
  }, [])

  const speak = useCallback(async (raw: string) => {
    const text = stripThinkTags(raw)
    // Skip empties and fragments that still contain an unbalanced tag opener
    // (a <think> split across deltas can land a lone '<' in a flushed chunk).
    if (!text || text.includes('<')) return
    const voiceId = useTtsStore.getState().voiceId
    if (!voiceId) return
    try {
      const r = await window.tachi.piper.synthesize({ voiceId, text })
      if (r.ok && r.b64) enqueuePlay(r.b64)
    } catch { /* synthesis failure is non-fatal — just stay silent */ }
  }, [enqueuePlay])

  const feedDelta = useCallback((text: string, msgId: string) => {
    if (!useTtsStore.getState().enabled) return
    const buf = (bufRef.current[msgId] ?? '') + text
    const boundary = findLastBoundary(buf)
    if (boundary === -1) { bufRef.current[msgId] = buf; return }
    const chunk = buf.slice(0, boundary).trim()
    bufRef.current[msgId] = buf.slice(boundary)
    if (chunk) void speak(chunk)
  }, [speak])

  const finalizeTts = useCallback((msgId: string) => {
    const remainder = bufRef.current[msgId] ?? ''
    delete bufRef.current[msgId]
    if (useTtsStore.getState().enabled && remainder.trim()) void speak(remainder)
  }, [speak])

  const stopAll = useCallback(() => {
    bufRef.current = {}
    try { audioRef.current?.pause() } catch { /* ignore */ }
    playRef.current = Promise.resolve()
  }, [])

  return { feedDelta, finalizeTts, stopAll }
}
