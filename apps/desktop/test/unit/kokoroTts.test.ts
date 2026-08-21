// apps/desktop/test/unit/kokoroTts.test.ts
//
// PURE helpers of the kokoro local-TTS service: the curated voice catalog
// shape, WAV filename sanitization, RIFF/WAVE magic detection (b64 roundtrip),
// and download-progress folding. electron + privacy.ipc are mocked so the
// module imports without a main process (the model itself is never loaded).
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userData' } }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import {
  KOKORO_VOICES,
  sanitizeWavName,
  isWavBytes,
  foldDownloadProgress,
} from '../../electron/services/kokoro-tts'

// ── Voice catalog ─────────────────────────────────────────────────────────────

describe('KOKORO_VOICES catalog', () => {
  it('curates ~10 voices with unique ids', () => {
    expect(KOKORO_VOICES.length).toBe(10)
    expect(new Set(KOKORO_VOICES.map(v => v.id)).size).toBe(10)
  })

  it('every entry has the full contract shape', () => {
    for (const v of KOKORO_VOICES) {
      expect(v.id).toMatch(/^[ab][fm]_[a-z]+$/)          // kokoro id convention
      expect(['f', 'm']).toContain(v.gender)
      expect(['us', 'gb']).toContain(v.accent)
      expect(v.grade).toMatch(/^[A-D][+-]?$/)
      expect(v.label.length).toBeGreaterThan(5)
      expect(v.label).toContain(`(${v.grade})`)          // human label carries the grade
    }
  })

  it('id prefix agrees with the declared accent + gender', () => {
    for (const v of KOKORO_VOICES) {
      expect(v.id[0]).toBe(v.accent === 'us' ? 'a' : 'b')
      expect(v.id[1]).toBe(v.gender)
    }
  })

  it('includes the flagship A-grade voice af_heart', () => {
    expect(KOKORO_VOICES[0]).toMatchObject({ id: 'af_heart', grade: 'A' })
  })
})

// ── sanitizeWavName ───────────────────────────────────────────────────────────

describe('sanitizeWavName', () => {
  it('appends .wav and keeps a plain name', () => {
    expect(sanitizeWavName('narration take 1')).toBe('narration take 1.wav')
  })

  it('does not double the extension', () => {
    expect(sanitizeWavName('voice.wav')).toBe('voice.wav')
    expect(sanitizeWavName('voice.WAV')).toBe('voice.wav')
  })

  it('strips directory components (traversal-safe)', () => {
    expect(sanitizeWavName('../../etc/passwd')).toBe('passwd.wav')
    expect(sanitizeWavName('C:\\Users\\x\\take')).toBe('take.wav')
  })

  it('removes Windows-illegal characters and trailing dots', () => {
    expect(sanitizeWavName('a<b>c:d"e|f?g*h')).toBe('abcdefgh.wav')
    expect(sanitizeWavName('ending...')).toBe('ending.wav')
  })

  it('collapses whitespace and trims', () => {
    expect(sanitizeWavName('  hello   world  ')).toBe('hello world.wav')
  })

  it('falls back to a kokoro-<ts> name when nothing survives', () => {
    expect(sanitizeWavName('???')).toMatch(/^kokoro-\d+\.wav$/)
    expect(sanitizeWavName('')).toMatch(/^kokoro-\d+\.wav$/)
  })

  it('caps very long names at 80 chars (+ extension)', () => {
    const out = sanitizeWavName('x'.repeat(300))
    expect(out.endsWith('.wav')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(84)
  })
})

// ── isWavBytes + base64 roundtrip ────────────────────────────────────────────

/** Minimal valid 44-byte WAV header + a little PCM payload. */
function makeWav(): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + 8, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)          // fmt chunk size
  header.writeUInt16LE(1, 20)           // PCM
  header.writeUInt16LE(1, 22)           // mono
  header.writeUInt32LE(24000, 24)       // sample rate (kokoro outputs 24kHz)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(8, 40)
  return Buffer.concat([header, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])])
}

describe('isWavBytes', () => {
  it('accepts a real WAV after a base64 roundtrip (the IPC wire format)', () => {
    const wav = makeWav()
    const b64 = wav.toString('base64')
    const back = Buffer.from(b64, 'base64')
    expect(back.equals(wav)).toBe(true)      // lossless roundtrip
    expect(isWavBytes(back)).toBe(true)
  })

  it('rejects short buffers', () => {
    expect(isWavBytes(Buffer.from('RIFF'))).toBe(false)
    expect(isWavBytes(Buffer.alloc(0))).toBe(false)
  })

  it('rejects non-RIFF payloads of WAV-ish length', () => {
    expect(isWavBytes(Buffer.alloc(64, 7))).toBe(false)
  })

  it('rejects RIFF containers that are not WAVE (e.g. AVI)', () => {
    const avi = makeWav()
    avi.write('AVI ', 8, 'ascii')
    expect(isWavBytes(avi)).toBe(false)
  })

  it('accepts Uint8Array input (not just Buffer)', () => {
    const wav = makeWav()
    expect(isWavBytes(new Uint8Array(wav))).toBe(true)
  })
})

// ── foldDownloadProgress ─────────────────────────────────────────────────────

describe('foldDownloadProgress', () => {
  it('returns previous value while nothing is known', () => {
    const files = new Map<string, { loaded: number; total: number }>()
    expect(foldDownloadProgress(files, { status: 'initiate', file: 'a' }, 0)).toBe(0)
    expect(foldDownloadProgress(files, { status: 'download', file: 'a' }, 0.25)).toBe(0.25)
  })

  it('aggregates loaded/total across multiple files', () => {
    const files = new Map<string, { loaded: number; total: number }>()
    let p = 0
    p = foldDownloadProgress(files, { status: 'progress', file: 'model.onnx', loaded: 50, total: 100 }, p)
    expect(p).toBeCloseTo(0.5)
    p = foldDownloadProgress(files, { status: 'progress', file: 'tokenizer.json', loaded: 0, total: 100 }, p)
    // second file makes the overall smaller — but progress is monotonic (max with previous)
    expect(p).toBeCloseTo(0.5)
    p = foldDownloadProgress(files, { status: 'progress', file: 'tokenizer.json', loaded: 100, total: 100 }, p)
    expect(p).toBeCloseTo(0.75)
  })

  it('a done event completes that file', () => {
    const files = new Map<string, { loaded: number; total: number }>()
    let p = 0
    p = foldDownloadProgress(files, { status: 'progress', file: 'model.onnx', loaded: 10, total: 100 }, p)
    p = foldDownloadProgress(files, { status: 'done', file: 'model.onnx' }, p)
    expect(p).toBe(1)
  })

  it('never exceeds 1 and never regresses', () => {
    const files = new Map<string, { loaded: number; total: number }>()
    let p = 0
    p = foldDownloadProgress(files, { status: 'progress', file: 'a', loaded: 100, total: 100 }, p)
    expect(p).toBe(1)
    p = foldDownloadProgress(files, { status: 'progress', file: 'b', loaded: 0, total: 100 }, p)
    expect(p).toBe(1)
  })

  it('ignores malformed events (no file / zero total)', () => {
    const files = new Map<string, { loaded: number; total: number }>()
    expect(foldDownloadProgress(files, { status: 'progress', loaded: 5, total: 10 }, 0.1)).toBe(0.1)
    expect(foldDownloadProgress(files, { status: 'progress', file: 'x', loaded: 5, total: 0 }, 0.1)).toBe(0.1)
    expect(files.size).toBe(0)
  })
})
