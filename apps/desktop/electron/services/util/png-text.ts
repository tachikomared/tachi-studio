// apps/desktop/electron/services/util/png-text.ts
//
// Embed / read PNG tEXt ancillary chunks without an external dependency.
//
// PNG structure (per spec):
//   8-byte signature
//   then chunks: [4-byte length BE] [4-byte type] [<length> bytes data] [4-byte CRC32 BE]
//
// A tEXt chunk carries: keyword \x00 text (both latin-1, no compression).
// We splice our new chunk RIGHT BEFORE the IEND chunk so the file remains valid.
//
// Reference pattern: Fooocus modules/meta_parser.py  (stuffs params into EXIF/PNG);
// we use tEXt instead of EXIF because sd-cli outputs plain PNG.

// ── CRC32 table (standard PNG poly 0xEDB88320, reflected) ─────────────────────
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

function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ── Helpers for reading/writing big-endian uint32 ─────────────────────────────
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a single tEXt chunk Buffer.
 * Layout: [length(4)] + "tEXt" + keyword + 0x00 + text + [CRC32(4)]
 */
export function buildTextChunk(keyword: string, text: string): Buffer {
  const enc = new TextEncoder()
  const kwBytes   = enc.encode(keyword)
  const textBytes = enc.encode(text)

  // data = keyword + null separator + text
  const dataLen = kwBytes.length + 1 + textBytes.length
  const typeBytes = new Uint8Array([0x74, 0x45, 0x58, 0x74]) // "tEXt"

  // Total chunk = 4 (length) + 4 (type) + dataLen + 4 (CRC)
  const chunk = new Uint8Array(12 + dataLen)
  writeUint32BE(chunk, 0, dataLen)
  chunk.set(typeBytes, 4)
  chunk.set(kwBytes,   8)
  chunk[8 + kwBytes.length] = 0x00
  chunk.set(textBytes, 8 + kwBytes.length + 1)

  // CRC covers type + data (bytes 4 .. 4+4+dataLen)
  const chunkCrc = crc32(chunk, 4, 8 + dataLen)
  writeUint32BE(chunk, 8 + dataLen, chunkCrc)

  return Buffer.from(chunk)
}

/**
 * Splice a tEXt chunk into a PNG buffer immediately before the IEND chunk.
 * Returns a new Buffer; the input is not mutated.
 * Throws if the buffer is not a valid PNG (wrong signature or no IEND found).
 */
export function embedTextChunk(pngBuf: Buffer, keyword: string, text: string): Buffer {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (pngBuf[i] !== PNG_SIG[i]) throw new Error('embedTextChunk: not a valid PNG')
  }

  const u8 = new Uint8Array(pngBuf.buffer, pngBuf.byteOffset, pngBuf.byteLength)

  // Walk chunks to find IEND offset.
  let offset = 8
  let iendOffset = -1
  while (offset + 12 <= u8.length) {
    const chunkLen  = readUint32BE(u8, offset)
    const chunkType = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7])
    if (chunkType === 'IEND') { iendOffset = offset; break }
    offset += 12 + chunkLen
  }
  if (iendOffset === -1) throw new Error('embedTextChunk: PNG has no IEND chunk')

  const textChunk = buildTextChunk(keyword, text)

  // Concat: everything up to IEND + new tEXt chunk + IEND-to-end
  return Buffer.concat([
    pngBuf.slice(0, iendOffset),
    textChunk,
    pngBuf.slice(iendOffset),
  ])
}

/**
 * Read all tEXt chunks from a PNG buffer.
 * Returns a map of keyword → text. Non-PNG input returns an empty map (no throw).
 */
export function readTextChunks(pngBuf: Buffer | Uint8Array): Map<string, string> {
  const result = new Map<string, string>()
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const u8 = pngBuf instanceof Buffer
    ? new Uint8Array(pngBuf.buffer, pngBuf.byteOffset, pngBuf.byteLength)
    : pngBuf

  if (u8.length < 8) return result
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== PNG_SIG[i]) return result
  }

  let offset = 8
  const dec = new TextDecoder('latin1')
  while (offset + 12 <= u8.length) {
    const chunkLen  = readUint32BE(u8, offset)
    const chunkType = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7])
    if (chunkType === 'IEND') break
    if (chunkType === 'tEXt') {
      const data = u8.slice(offset + 8, offset + 8 + chunkLen)
      const sep  = data.indexOf(0)
      if (sep !== -1) {
        const keyword = dec.decode(data.slice(0, sep))
        const text    = dec.decode(data.slice(sep + 1))
        result.set(keyword, text)
      }
    }
    offset += 12 + chunkLen
    if (offset > u8.length) break  // truncated / corrupt
  }
  return result
}
