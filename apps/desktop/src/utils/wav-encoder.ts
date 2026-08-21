// apps/desktop/src/utils/wav-encoder.ts
//
// Encode Float32 PCM samples into a 16-bit mono PCM WAV (audit H3 follow-up).
// whisper.cpp's whisper-cli requires 16 kHz mono 16-bit PCM WAV; the old mic
// path produced webm/opus at the device's native rate and relied on
// nodejs-whisper's internal ffmpeg. Capturing at 16 kHz mono (Web Audio) and
// encoding here removes the ffmpeg dependency and feeds whisper-cli exactly what
// it wants — and is equally valid input for the nodejs-whisper fallback.
//
// Pure (no DOM) so it is unit-testable.

/** Clamp + convert [-1,1] floats to signed 16-bit PCM. */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
  }
  return out
}

/**
 * Build a complete mono 16-bit PCM WAV (44-byte header + samples) at the given
 * sample rate. Returns the WAV bytes.
 */
export function encodeWavPcm16Mono(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = floatTo16BitPCM(samples)
  const dataBytes = pcm.length * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buf)
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  // RIFF chunk descriptor
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeStr(8, 'WAVE')
  // fmt sub-chunk
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)            // sub-chunk size (16 for PCM)
  view.setUint16(20, 1, true)             // audio format 1 = PCM
  view.setUint16(22, 1, true)             // channels = mono
  view.setUint32(24, sampleRate, true)    // sample rate
  view.setUint32(28, sampleRate * 2, true)// byte rate = rate * channels * bytesPerSample
  view.setUint16(32, 2, true)             // block align = channels * bytesPerSample
  view.setUint16(34, 16, true)            // bits per sample
  // data sub-chunk
  writeStr(36, 'data')
  view.setUint32(40, dataBytes, true)
  let off = 44
  for (let i = 0; i < pcm.length; i++) { view.setInt16(off, pcm[i], true); off += 2 }
  return new Uint8Array(buf)
}

/** Concatenate Float32 chunks (e.g. ScriptProcessor frames) into one buffer. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Float32Array(len)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}
