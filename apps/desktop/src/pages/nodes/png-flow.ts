// apps/desktop/src/pages/nodes/png-flow.ts
//
// Flow-in-the-artifact — embed / read a flow's JSON inside an exported PNG
// (NODES-RESEARCH #5, ComfyUI workflow-in-PNG). A canvas screenshot carries the
// whole graph in a tEXt ancillary chunk; dropping the image back on the canvas
// reconstructs the flow. Every shared output becomes a one-drag onboarding path.
//
// RENDERER-SAFE + PURE: this module is imported by the renderer (React) and by
// unit tests, so it uses ONLY Uint8Array / TextEncoder / TextDecoder — no Node
// `Buffer`. Do NOT import electron/services/util/png-text.ts here (that one is
// Buffer-based and main-process only); the CRC32 + chunk mechanics are mirrored
// below against plain typed arrays.
//
// PNG structure (per spec):
//   8-byte signature
//   then chunks: [4-byte length BE] [4-byte type] [<length> bytes data] [4-byte CRC32 BE]
//
// A tEXt chunk carries: keyword \x00 text (both Latin-1, no compression). The
// flow JSON is UTF-8 (node labels/prompts can be any language), so it is
// base64-encoded before storage — base64 is pure ASCII and survives the Latin-1
// tEXt payload byte-for-byte. We splice our chunk RIGHT BEFORE the IEND chunk so
// the file stays a valid PNG.

/** tEXt keyword under which the flow JSON lives. */
export const FLOW_KEYWORD = 'tachiflow'

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// ── CRC32 (standard PNG poly 0xEDB88320, reflected) ───────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[n] = c
  }
  return t
})()

function crc32(buf: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ── Big-endian uint32 helpers ─────────────────────────────────────────────────
function readUint32BE(buf: Uint8Array, offset: number): number {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0
}

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  const v = value >>> 0
  buf[offset]     = (v >>> 24) & 0xff
  buf[offset + 1] = (v >>> 16) & 0xff
  buf[offset + 2] = (v >>>  8) & 0xff
  buf[offset + 3] =  v         & 0xff
}

function isPng(buf: Uint8Array): boolean {
  if (buf.length < 8) return false
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) return false
  }
  return true
}

// ── Latin-1 (Uint8Array ⇄ ASCII/Latin-1 string) ───────────────────────────────
// Keyword + base64 payload are both ASCII, so a byte-for-byte Latin-1 mapping is
// exact and avoids TextDecoder allocation on the hot walk.
function latin1Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function latin1Decode(buf: Uint8Array): string {
  let out = ''
  for (let i = 0; i < buf.length; i++) out += String.fromCharCode(buf[i])
  return out
}

// ── base64 (Uint8Array ⇄ base64), no btoa/atob dependency ─────────────────────
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1)
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i
  return t
})()

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64_CHARS[(n >>> 18) & 63] + B64_CHARS[(n >>> 12) & 63] + B64_CHARS[(n >>> 6) & 63] + B64_CHARS[n & 63]
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const n = bytes[i] << 16
    out += B64_CHARS[(n >>> 18) & 63] + B64_CHARS[(n >>> 12) & 63] + '=='
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64_CHARS[(n >>> 18) & 63] + B64_CHARS[(n >>> 12) & 63] + B64_CHARS[(n >>> 6) & 63] + '='
  }
  return out
}

function base64ToBytes(b64: string): Uint8Array {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i)
    if (c === 0x3d /* '=' */) break
    const v = B64_LOOKUP[c]
    if (v < 0) continue // skip whitespace / stray bytes
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >>> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a single tEXt chunk: [length(4)] + "tEXt" + keyword + 0x00 + text + [CRC32(4)].
 * `text` is expected to be ASCII (base64) — it is stored Latin-1.
 */
function buildTextChunk(keyword: string, text: string): Uint8Array {
  const kw  = latin1Encode(keyword)
  const txt = latin1Encode(text)
  const dataLen = kw.length + 1 + txt.length

  const chunk = new Uint8Array(12 + dataLen)
  writeUint32BE(chunk, 0, dataLen)
  chunk[4] = 0x74; chunk[5] = 0x45; chunk[6] = 0x58; chunk[7] = 0x74 // "tEXt"
  chunk.set(kw, 8)
  chunk[8 + kw.length] = 0x00
  chunk.set(txt, 8 + kw.length + 1)

  // CRC covers type + data: bytes [4, 8 + dataLen).
  writeUint32BE(chunk, 8 + dataLen, crc32(chunk, 4, 8 + dataLen))
  return chunk
}

/**
 * Return a new PNG with the flow JSON embedded as a `tachiflow` tEXt chunk
 * (base64 of the UTF-8 JSON), spliced immediately before IEND with a correct
 * CRC32. The input is not mutated.
 *
 * Throws if `pngBytes` is not a valid PNG (wrong signature or no IEND) — callers
 * always feed a freshly-rendered canvas PNG, so an invalid one is a real bug.
 */
export function embedFlowInPng(pngBytes: Uint8Array, json: string): Uint8Array {
  if (!isPng(pngBytes)) throw new Error('embedFlowInPng: not a valid PNG')

  // Walk chunks to find the IEND offset.
  let offset = 8
  let iendOffset = -1
  const len = pngBytes.length
  while (offset + 12 <= len) {
    const chunkLen = readUint32BE(pngBytes, offset)
    const type = String.fromCharCode(pngBytes[offset + 4], pngBytes[offset + 5], pngBytes[offset + 6], pngBytes[offset + 7])
    if (type === 'IEND') { iendOffset = offset; break }
    offset += 12 + chunkLen
    if (offset > len) break // truncated / corrupt
  }
  if (iendOffset === -1) throw new Error('embedFlowInPng: PNG has no IEND chunk')

  const value = bytesToBase64(new TextEncoder().encode(json))
  const chunk = buildTextChunk(FLOW_KEYWORD, value)

  // Splice: [ .. IEND) + tEXt + [IEND .. end).
  const out = new Uint8Array(len + chunk.length)
  out.set(pngBytes.subarray(0, iendOffset), 0)
  out.set(chunk, iendOffset)
  out.set(pngBytes.subarray(iendOffset), iendOffset + chunk.length)
  return out
}

/**
 * Extract the flow JSON from a PNG's `tachiflow` tEXt chunk, or null.
 *
 * FAIL-CLOSED: returns null when the buffer is not a PNG, has no `tachiflow`
 * chunk, the chunk's CRC32 doesn't match (tampered / truncated), or the payload
 * can't be decoded — never throws, never returns partial data.
 */
export function extractFlowFromPng(pngBytes: Uint8Array): string | null {
  if (!isPng(pngBytes)) return null

  let offset = 8
  const len = pngBytes.length
  while (offset + 12 <= len) {
    const chunkLen = readUint32BE(pngBytes, offset)
    const dataEnd = offset + 8 + chunkLen
    // Guard against a length that overruns the buffer (truncated / corrupt).
    if (dataEnd + 4 > len) break

    const type = String.fromCharCode(pngBytes[offset + 4], pngBytes[offset + 5], pngBytes[offset + 6], pngBytes[offset + 7])
    if (type === 'IEND') break

    if (type === 'tEXt') {
      const data = pngBytes.subarray(offset + 8, dataEnd)
      const sep = data.indexOf(0)
      if (sep !== -1 && latin1Decode(data.subarray(0, sep)) === FLOW_KEYWORD) {
        // Verify CRC before trusting the payload — a bad CRC fails closed.
        const storedCrc = readUint32BE(pngBytes, dataEnd)
        const calcCrc = crc32(pngBytes, offset + 4, dataEnd)
        if (storedCrc !== calcCrc) return null
        try {
          const jsonBytes = base64ToBytes(latin1Decode(data.subarray(sep + 1)))
          return new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)
        } catch {
          return null
        }
      }
    }

    offset = dataEnd + 4
  }
  return null
}
