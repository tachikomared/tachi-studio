// apps/desktop/src/pages/media/exifMeta.ts
//
// Renderer-side parser for the "tachi-gen" tEXt chunk that sd-cpp-client.ts
// embeds into every locally-generated PNG.  No IPC — runs entirely in the
// browser/Electron renderer process.
//
// The PNG tEXt chunk format (per spec):
//   chunk data = keyword (latin-1, no NUL) + 0x00 + text (latin-1)
// The length / type / CRC are stripped by the time the data bytes arrive here.
//
// We replicate just enough of the PNG walk to extract tEXt chunks from an
// ArrayBuffer obtained via FileReader.  This is a read-only path; embedding
// is done on the main-process side (png-text.ts).

export interface TachiGenMeta {
  modelId:        string
  prompt:         string
  negative:       string
  steps:          number
  cfgScale:       number
  samplingMethod: string
  seed:           number
  width:          number
  height:         number
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function readUint32BE(u8: Uint8Array, offset: number): number {
  return ((u8[offset] << 24) | (u8[offset + 1] << 16) | (u8[offset + 2] << 8) | u8[offset + 3]) >>> 0
}

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function isPng(u8: Uint8Array): boolean {
  if (u8.length < 8) return false
  for (let i = 0; i < 8; i++) if (u8[i] !== PNG_SIG[i]) return false
  return true
}

/**
 * Walk a PNG ArrayBuffer and return the value of the first tEXt chunk whose
 * keyword matches `targetKeyword`.  Returns null if not found or not a PNG.
 */
function readPngTextChunk(buf: ArrayBuffer, targetKeyword: string): string | null {
  const u8 = new Uint8Array(buf)
  if (!isPng(u8)) return null

  const dec = new TextDecoder('latin1')
  let offset = 8
  while (offset + 12 <= u8.length) {
    const dataLen   = readUint32BE(u8, offset)
    const chunkType = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7])
    if (chunkType === 'IEND') break
    if (chunkType === 'tEXt') {
      const data = u8.slice(offset + 8, offset + 8 + dataLen)
      const sep  = data.indexOf(0)
      if (sep !== -1) {
        const keyword = dec.decode(data.slice(0, sep))
        if (keyword === targetKeyword) {
          return dec.decode(data.slice(sep + 1))
        }
      }
    }
    offset += 12 + dataLen
    if (offset > u8.length) break  // guard against corrupt data
  }
  return null
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Parse the "tachi-gen" metadata from a PNG ArrayBuffer.
 * Returns the parsed TachiGenMeta or null if the chunk is absent / corrupt.
 */
export function parseTachiGenMeta(buf: ArrayBuffer): TachiGenMeta | null {
  const raw = readPngTextChunk(buf, 'tachi-gen')
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    // Validate the shape — all fields must be present and correctly typed.
    if (
      typeof obj.modelId        !== 'string' ||
      typeof obj.prompt         !== 'string' ||
      typeof obj.negative       !== 'string' ||
      typeof obj.steps          !== 'number' ||
      typeof obj.cfgScale       !== 'number' ||
      typeof obj.samplingMethod !== 'string' ||
      typeof obj.seed           !== 'number' ||
      typeof obj.width          !== 'number' ||
      typeof obj.height         !== 'number'
    ) return null
    return obj as unknown as TachiGenMeta
  } catch {
    return null
  }
}

/**
 * Read a File as an ArrayBuffer and parse the "tachi-gen" tEXt chunk.
 * Resolves to null on any error (wrong file type, no chunk, parse error).
 */
export function parseTachiGenMetaFromFile(file: File): Promise<TachiGenMeta | null> {
  return new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const buf = e.target?.result
      if (!(buf instanceof ArrayBuffer)) { resolve(null); return }
      resolve(parseTachiGenMeta(buf))
    }
    reader.onerror = () => resolve(null)
    reader.readAsArrayBuffer(file)
  })
}
