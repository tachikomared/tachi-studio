// apps/desktop/test/unit/audioOverviewVoices.test.ts
//
// Pure helpers behind the STUDIO/kokoro + piper voice split
// (src/pages/media/audioOverviewHelpers): engine-packed voice ids for the
// grouped pickers, the base64 encoder that feeds media:save-wav, and the
// transient-error classifier gating the audio-overview script auto-retry.
import { describe, it, expect } from 'vitest'
import {
  packVoice,
  unpackVoice,
  bytesToBase64,
  base64ToBytes,
  isTransientScriptError,
  KOKORO_HOST_A_DEFAULT,
  KOKORO_HOST_B_DEFAULT,
} from '../../src/pages/media/audioOverviewHelpers'

// ── packVoice / unpackVoice ──────────────────────────────────────────────────

describe('packVoice / unpackVoice', () => {
  it('round-trips a kokoro voice', () => {
    expect(unpackVoice(packVoice('kokoro', 'af_heart'))).toEqual({ engine: 'kokoro', id: 'af_heart' })
  })

  it('round-trips a piper voice', () => {
    expect(unpackVoice(packVoice('piper', 'en_US-lessac-medium'))).toEqual({ engine: 'piper', id: 'en_US-lessac-medium' })
  })

  it('falls back to piper for unprefixed legacy ids', () => {
    expect(unpackVoice('en_US-lessac-medium')).toEqual({ engine: 'piper', id: 'en_US-lessac-medium' })
  })

  it('keeps colons inside the raw voice id intact', () => {
    expect(unpackVoice('kokoro:weird:id')).toEqual({ engine: 'kokoro', id: 'weird:id' })
  })

  it('exposes the studio host defaults', () => {
    expect(KOKORO_HOST_A_DEFAULT).toBe('af_heart')
    expect(KOKORO_HOST_B_DEFAULT).toBe('am_michael')
  })
})

// ── bytesToBase64 ────────────────────────────────────────────────────────────

describe('bytesToBase64', () => {
  it('round-trips with base64ToBytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 82, 73, 70, 70])
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
  })

  it('handles buffers larger than one btoa chunk (0x8000)', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    const decoded = base64ToBytes(bytesToBase64(bytes))
    expect(decoded.length).toBe(bytes.length)
    expect(decoded[0x8000 * 2 + 16]).toBe(bytes[0x8000 * 2 + 16])
    expect(decoded[12345]).toBe(bytes[12345])
  })

  it('handles empty input', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })
})

// ── isTransientScriptError ───────────────────────────────────────────────────

describe('isTransientScriptError', () => {
  it.each([
    'HTTP 500 from upstream',
    'router returned 502 Bad Gateway',
    'status 503',
    'fetch failed',
    'TypeError: Failed to fetch',
    'FetchError: network error',
    'read ECONNRESET',
    'connect ECONNREFUSED 127.0.0.1:8787',
    'ETIMEDOUT',
    'socket hang up',
  ])('retries on %s', (msg) => {
    expect(isTransientScriptError(msg)).toBe(true)
  })

  it.each([
    'the model did not return a valid script',
    'empty reply',
    'freellm-not-running',
    'HTTP 404 not found',
    'HTTP 429 too many requests',
    'reply is not valid JSON',
  ])('does NOT retry on %s', (msg) => {
    expect(isTransientScriptError(msg)).toBe(false)
  })
})
