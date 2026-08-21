// apps/desktop/test/unit/pngText.test.ts
import { describe, it, expect } from 'vitest'
import { buildTextChunk, embedTextChunk, readTextChunks } from '../../electron/services/util/png-text'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// A real IEND chunk: length 0, type "IEND", CRC 0xAE426082.
const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
/** Smallest buffer embed/read accept: signature + IEND (chunk walk needs only IEND). */
const minimalPng = () => Buffer.concat([PNG_SIG, IEND])

/** Independent (bitwise, table-free) CRC32 to cross-check the module's table impl. */
function refCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('buildTextChunk', () => {
  it('writes a correct length prefix, type tag, and a spec-valid CRC', () => {
    const kw = 'tachi-gen'
    const text = '{"model":"sd-turbo","steps":4}'
    const chunk = buildTextChunk(kw, text)
    const dataLen = kw.length + 1 + text.length
    expect(chunk.readUInt32BE(0)).toBe(dataLen)
    expect(chunk.subarray(4, 8).toString('latin1')).toBe('tEXt')
    // CRC covers type+data (bytes 4 .. 8+dataLen); cross-check the table impl.
    const stored = chunk.readUInt32BE(8 + dataLen)
    expect(stored).toBe(refCrc32(chunk.subarray(4, 8 + dataLen)))
  })
})

describe('embed + read round-trip', () => {
  it('round-trips a single keyword/text pair', () => {
    const png = embedTextChunk(minimalPng(), 'tachi-gen', '{"model":"sd-turbo","steps":4,"cfg":1}')
    const map = readTextChunks(png)
    expect(map.get('tachi-gen')).toBe('{"model":"sd-turbo","steps":4,"cfg":1}')
  })

  it('round-trips multiple chunks', () => {
    let png = embedTextChunk(minimalPng(), 'a', 'alpha')
    png = embedTextChunk(png, 'b', 'beta')
    const map = readTextChunks(png)
    expect(map.get('a')).toBe('alpha')
    expect(map.get('b')).toBe('beta')
    expect(map.size).toBe(2)
  })

  it('does not mutate the input buffer', () => {
    const original = minimalPng()
    const copy = Buffer.from(original)
    embedTextChunk(original, 'k', 'v')
    expect(original.equals(copy)).toBe(true)
  })
})

describe('robustness', () => {
  it('readTextChunks returns an empty map for non-PNG / tiny input (no throw)', () => {
    expect(readTextChunks(Buffer.from('not a png at all')).size).toBe(0)
    expect(readTextChunks(Buffer.from([1, 2, 3])).size).toBe(0)
  })

  it('embedTextChunk throws on a non-PNG buffer', () => {
    expect(() => embedTextChunk(Buffer.from('nope'), 'k', 'v')).toThrow()
  })
})
