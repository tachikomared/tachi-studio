import { describe, it, expect } from 'vitest'
import { parseWavFormat, whisperWavError } from '../../electron/services/util/wav-format'

/** Build a minimal canonical PCM WAV header (44 bytes) + n silent samples. */
function wav(opts: { sampleRate?: number; channels?: number; bits?: number; format?: number; samples?: number } = {}): Uint8Array {
  const { sampleRate = 16000, channels = 1, bits = 16, format = 1, samples = 4 } = opts
  const bytesPerSample = bits / 8
  const dataBytes = samples * channels * bytesPerSample
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const s = (off: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)) }
  s(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); s(8, 'WAVE')
  s(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, format, true); v.setUint16(22, channels, true)
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * bytesPerSample, true)
  v.setUint16(32, channels * bytesPerSample, true); v.setUint16(34, bits, true)
  s(36, 'data'); v.setUint32(40, dataBytes, true)
  return new Uint8Array(buf)
}

describe('parseWavFormat', () => {
  it('parses a canonical 16k mono 16-bit PCM header', () => {
    expect(parseWavFormat(wav())).toEqual({ audioFormat: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16 })
  })
  it('reads non-default rate/channels/bits', () => {
    expect(parseWavFormat(wav({ sampleRate: 48000, channels: 2, bits: 24 }))).toMatchObject({ sampleRate: 48000, channels: 2, bitsPerSample: 24 })
  })
  it('tolerates an extra JUNK chunk before fmt', () => {
    const base = wav()
    // splice a 4-byte JUNK chunk (8 header + 4 body) right after WAVE (offset 12)
    const junk = new Uint8Array(12)
    const jv = new DataView(junk.buffer)
    'JUNK'.split('').forEach((c, i) => jv.setUint8(i, c.charCodeAt(0)))
    jv.setUint32(4, 4, true)
    const out = new Uint8Array(base.length + 12)
    out.set(base.slice(0, 12), 0); out.set(junk, 12); out.set(base.slice(12), 24)
    expect(parseWavFormat(out)).toMatchObject({ sampleRate: 16000, channels: 1 })
  })
  it('returns null for non-WAV / too-short / wrong magic', () => {
    expect(parseWavFormat(new Uint8Array(10))).toBeNull()
    expect(parseWavFormat(new Uint8Array(44))).toBeNull() // all zero -> no RIFF
    const noWave = wav(); noWave[8] = 0 // corrupt 'WAVE'
    expect(parseWavFormat(noWave)).toBeNull()
  })
  it('rejects a malformed fmt chunk that declares < 16 bytes', () => {
    const b = wav()
    new DataView(b.buffer).setUint32(16, 12, true) // declare fmt size = 12 (< 16)
    expect(parseWavFormat(b)).toBeNull()
  })
})

describe('whisperWavError', () => {
  it('accepts 16k mono 16-bit PCM (null = ok)', () => {
    expect(whisperWavError(wav())).toBeNull()
  })
  it('rejects the wrong sample rate', () => {
    const e = whisperWavError(wav({ sampleRate: 44100 }))
    expect(e).toContain('16 kHz')
  })
  it('rejects stereo', () => {
    expect(whisperWavError(wav({ channels: 2 }))).toContain('mono')
  })
  it('rejects non-16-bit and non-PCM', () => {
    expect(whisperWavError(wav({ bits: 8 }))).toContain('16-bit')
    expect(whisperWavError(wav({ format: 3 }))).toContain('PCM') // 3 = IEEE float
  })
  it('lists every wrong dimension at once', () => {
    const e = whisperWavError(wav({ sampleRate: 48000, channels: 2, bits: 32, format: 3 }))!
    expect(e).toContain('PCM'); expect(e).toContain('mono'); expect(e).toContain('16 kHz'); expect(e).toContain('16-bit')
  })
  it('rejects a non-WAV buffer with a clear message', () => {
    expect(whisperWavError(new Uint8Array(8))).toContain('not a recognisable WAV')
  })
})
