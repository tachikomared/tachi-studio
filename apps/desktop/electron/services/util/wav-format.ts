// apps/desktop/electron/services/util/wav-format.ts
//
// Parse + validate a WAV header. The prebuilt whisper-cli (Windows, audit H3) has
// NO ffmpeg and needs EXACTLY 16 kHz mono 16-bit PCM WAV. The in-app mic path
// (useWhisperRecognition + wav-encoder) already produces that, but any other caller
// (a picked file, a future MediaRecorder path) could hand over the wrong format,
// which whisper-cli would transcribe as garbage or reject with a cryptic exit code.
// This lets the service fail fast with a clear, actionable message. Pure + tested.

export interface WavFormat {
  audioFormat: number // 1 = PCM
  channels: number
  sampleRate: number
  bitsPerSample: number
}

const tag = (b: Uint8Array, off: number): string =>
  String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3])

/**
 * Parse the `fmt ` chunk of a RIFF/WAVE buffer. Scans chunks so it tolerates
 * extra chunks (LIST/JUNK/fact) appearing before `fmt `. Returns null if the
 * buffer is not a WAV or has no readable fmt chunk.
 */
export function parseWavFormat(buf: Uint8Array): WavFormat | null {
  if (!buf || buf.length < 44) return null
  if (tag(buf, 0) !== 'RIFF' || tag(buf, 8) !== 'WAVE') return null
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let off = 12
  while (off + 8 <= buf.length) {
    const id = tag(buf, off)
    const size = dv.getUint32(off + 4, true)
    const body = off + 8
    if (id === 'fmt ') {
      // Reject a malformed fmt chunk (declared < 16 bytes) rather than reading
      // fields out of the following chunk.
      if (size < 16 || body + 16 > buf.length) return null
      return {
        audioFormat:   dv.getUint16(body, true),
        channels:      dv.getUint16(body + 2, true),
        sampleRate:    dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      }
    }
    off = body + size + (size % 2) // chunks are word-aligned
  }
  return null
}

/**
 * Returns an error message if `buf` is NOT a 16 kHz mono 16-bit PCM WAV (what the
 * prebuilt whisper-cli needs), or null if it is valid.
 */
export function whisperWavError(buf: Uint8Array): string | null {
  const fmt = parseWavFormat(buf)
  if (!fmt) return 'audio is not a recognisable WAV file (expected 16 kHz mono 16-bit PCM)'
  const wrong: string[] = []
  if (fmt.audioFormat !== 1) wrong.push('PCM')
  if (fmt.channels !== 1) wrong.push('mono')
  if (fmt.sampleRate !== 16000) wrong.push('16 kHz')
  if (fmt.bitsPerSample !== 16) wrong.push('16-bit')
  if (wrong.length === 0) return null
  return `audio must be 16 kHz mono 16-bit PCM WAV (needs: ${wrong.join(', ')}; got ${fmt.sampleRate} Hz, ${fmt.channels}ch, ${fmt.bitsPerSample}-bit, format ${fmt.audioFormat})`
}
