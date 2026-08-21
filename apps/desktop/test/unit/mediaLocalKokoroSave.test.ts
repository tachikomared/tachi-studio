// apps/desktop/test/unit/mediaLocalKokoroSave.test.ts
//
// NIGHT QUEUE 2026-07-31, lane 1C, bug 1 — STUDIO (kokoro) TTS ARTIFACTS
// SURVIVE A RESTART.
//
// `kokoro.synthesize` only ever returns bytes in memory — there is no path on
// the wire it uses. MediaPage used to push the gallery entry straight off
// that b64 with no `path` at all, unlike every sd.cpp / piper artifact (which
// all carry one). Two consequences, both real:
//
//   1. SAVE IS DEAD. saveArtifactToFolder (mediaHelpers.ts) reads `a.path` and
//      shows "Nothing to save" when it is undefined.
//   2. THE ENTRY DIES ON RESTART. The gallery persists to localStorage, and
//      partialize (media.store) strips big b64 blobs on the way in — a kokoro
//      artifact had nothing else to fall back to, so it silently vanished.
//
// DesignPage's voiceover chain (DesignPage.tsx:264) already had the fix for
// design-audio: kokoro.synthesize → media.saveWav (writes under
// <userData>/media/kokoro) → keep the returned path. synthesizeKokoroTts is
// the same wire, extracted so the Media tab's gallery push can use it too.

import { describe, it, expect, vi } from 'vitest'
import { kokoroTtsFileName, synthesizeKokoroTts } from '../../src/pages/media/MediaPage'

describe('kokoroTtsFileName — deterministic, collision-resistant, filesystem-safe', () => {
  it('slugifies the prompt and appends the timestamp', () => {
    expect(kokoroTtsFileName('Hello there, welcome!', 1000)).toBe('tts-hello-there-welcome-1000.wav')
  })

  it('lowercases and strips punctuation to a single separator', () => {
    expect(kokoroTtsFileName('A -- B__C  D', 1)).toBe('tts-a-b-c-d-1.wav')
  })

  it('never leaves a leading or trailing dash from stripped punctuation', () => {
    expect(kokoroTtsFileName('!!!hello!!!', 1)).toBe('tts-hello-1.wav')
  })

  it('falls back to a plain "tts" stem for empty or fully-punctuation prompts', () => {
    expect(kokoroTtsFileName('', 5)).toBe('tts-tts-5.wav')
    expect(kokoroTtsFileName('   ', 5)).toBe('tts-tts-5.wav')
    expect(kokoroTtsFileName('!!!', 5)).toBe('tts-tts-5.wav')
  })

  it('caps the slug so a long prompt cannot produce an unwieldy filename', () => {
    const long = 'word '.repeat(40).trim()
    const name = kokoroTtsFileName(long, 42)
    // 'tts-' + up to 32 slug chars + '-42.wav'
    expect(name.startsWith('tts-')).toBe(true)
    expect(name.endsWith('-42.wav')).toBe(true)
    const slug = name.slice('tts-'.length, name.length - '-42.wav'.length)
    expect(slug.length).toBeLessThanOrEqual(32)
  })
})

describe('synthesizeKokoroTts — synth → save, mirroring DesignPage.tsx:264', () => {
  it('happy path: returns the b64 AND the saved path, in that order of calls', async () => {
    const calls: string[] = []
    const synth = vi.fn(async (input: { text: string; voice: string }) => {
      calls.push('synth')
      expect(input).toEqual({ text: 'hello world', voice: 'af_bella' })
      return { ok: true, b64: 'QUJD' }
    })
    const saveWav = vi.fn(async (input: { b64: string; name: string }) => {
      calls.push('save')
      expect(input.b64).toBe('QUJD')
      expect(input.name).toBe(kokoroTtsFileName('hello world', 123))
      return { ok: true, path: '/userData/media/kokoro/tts-hello-world-123.wav' }
    })

    const result = await synthesizeKokoroTts(synth, saveWav, { text: 'hello world', voice: 'af_bella', now: 123 })

    expect(calls).toEqual(['synth', 'save'])        // save happens AFTER synth, never before/instead
    expect(result).toEqual({
      b64: 'QUJD',
      path: '/userData/media/kokoro/tts-hello-world-123.wav',
      mime: 'audio/wav',
    })
  })

  it('throws when synth resolves ok:false — never silently returns a pathless artifact', async () => {
    const synth = vi.fn(async () => ({ ok: false, error: 'model not loaded' }))
    const saveWav = vi.fn(async () => ({ ok: true, path: '/x.wav' }))
    await expect(synthesizeKokoroTts(synth, saveWav, { text: 't', voice: 'v', now: 1 }))
      .rejects.toThrow('model not loaded')
    expect(saveWav).not.toHaveBeenCalled()          // no bytes, nothing to save
  })

  it('throws when synth resolves ok:true with no b64', async () => {
    const synth = vi.fn(async () => ({ ok: true }))
    const saveWav = vi.fn(async () => ({ ok: true, path: '/x.wav' }))
    await expect(synthesizeKokoroTts(synth, saveWav, { text: 't', voice: 'v', now: 1 }))
      .rejects.toThrow('Local TTS failed')
    expect(saveWav).not.toHaveBeenCalled()
  })

  it('throws when saveWav resolves ok:false — this is the bug: a b64-only artifact must never ship', async () => {
    const synth = vi.fn(async () => ({ ok: true, b64: 'QUJD' }))
    const saveWav = vi.fn(async () => ({ ok: false, error: 'disk full' }))
    await expect(synthesizeKokoroTts(synth, saveWav, { text: 't', voice: 'v', now: 1 }))
      .rejects.toThrow('disk full')
  })

  it('throws when saveWav resolves ok:true with no path', async () => {
    const synth = vi.fn(async () => ({ ok: true, b64: 'QUJD' }))
    const saveWav = vi.fn(async () => ({ ok: true }))
    await expect(synthesizeKokoroTts(synth, saveWav, { text: 't', voice: 'v', now: 1 }))
      .rejects.toThrow('Local TTS save failed')
  })
})
