// apps/desktop/test/unit/wav-encoder.test.ts
//
// Audit H3 follow-up — proves the mic capture produces the EXACT format
// whisper-cli requires (16-bit mono PCM WAV). The capture pipeline itself
// (getUserMedia + AudioContext) needs a mic + GUI; this locks the encoder.

import { describe, it, expect } from 'vitest'
import { floatTo16BitPCM, encodeWavPcm16Mono, concatFloat32 } from '../../src/utils/wav-encoder'

const ascii = (u8: Uint8Array, off: number, len: number) =>
  String.fromCharCode(...u8.subarray(off, off + len))
const u32le = (u8: Uint8Array, off: number) => new DataView(u8.buffer).getUint32(off, true)
const u16le = (u8: Uint8Array, off: number) => new DataView(u8.buffer).getUint16(off, true)
const i16le = (u8: Uint8Array, off: number) => new DataView(u8.buffer).getInt16(off, true)

describe('floatTo16BitPCM', () => {
  it('maps [-1,1] to full int16 range and clamps overflow', () => {
    const out = floatTo16BitPCM(new Float32Array([0, 1, -1, 0.5, 2, -2]))
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(32767)   // +1 → 0x7fff
    expect(out[2]).toBe(-32768)  // -1 → -0x8000
    expect(out[4]).toBe(32767)   // +2 clamped
    expect(out[5]).toBe(-32768)  // -2 clamped
  })
})

describe('encodeWavPcm16Mono', () => {
  it('writes a valid 16 kHz mono 16-bit PCM WAV header', () => {
    const wav = encodeWavPcm16Mono(new Float32Array([0, 0.5, -0.5]), 16000)
    expect(ascii(wav, 0, 4)).toBe('RIFF')
    expect(ascii(wav, 8, 4)).toBe('WAVE')
    expect(ascii(wav, 12, 4)).toBe('fmt ')
    expect(u16le(wav, 20)).toBe(1)        // PCM
    expect(u16le(wav, 22)).toBe(1)        // mono
    expect(u32le(wav, 24)).toBe(16000)    // sample rate
    expect(u32le(wav, 28)).toBe(32000)    // byte rate = 16000 * 1 * 2
    expect(u16le(wav, 32)).toBe(2)        // block align
    expect(u16le(wav, 34)).toBe(16)       // bits/sample
    expect(ascii(wav, 36, 4)).toBe('data')
    expect(u32le(wav, 40)).toBe(3 * 2)    // 3 samples * 2 bytes
    expect(wav.length).toBe(44 + 6)
  })

  it('round-trips sample values into the data section', () => {
    const wav = encodeWavPcm16Mono(new Float32Array([1, -1, 0]), 16000)
    expect(i16le(wav, 44)).toBe(32767)
    expect(i16le(wav, 46)).toBe(-32768)
    expect(i16le(wav, 48)).toBe(0)
  })
})

describe('concatFloat32', () => {
  it('joins chunks in order', () => {
    const out = concatFloat32([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })
})
