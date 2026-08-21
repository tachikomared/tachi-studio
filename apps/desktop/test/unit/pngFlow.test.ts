// NODES-RESEARCH #5: flow-in-the-artifact — embed the flow JSON in an exported
// PNG (base64 in a `tachiflow` tEXt chunk) so a shared image reconstructs the
// graph when dropped back on the canvas. These tests pin the round-trip and the
// fail-closed contract (absent chunk / corrupted CRC / non-PNG → null).
import { describe, it, expect } from 'vitest'
import { embedFlowInPng, extractFlowFromPng, FLOW_KEYWORD } from '../../src/pages/nodes/png-flow'

// A minimal, valid 1×1 PNG (signature + IHDR + IDAT + IEND). 70 bytes.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function pngFixture(): Uint8Array {
  return new Uint8Array(Buffer.from(PNG_1x1_B64, 'base64'))
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Offset of the 4-byte CRC of the first tEXt chunk, or -1. */
function textChunkCrcOffset(png: Uint8Array): number {
  let off = 8
  const readLen = (o: number) => ((png[o] << 24) | (png[o + 1] << 16) | (png[o + 2] << 8) | png[o + 3]) >>> 0
  while (off + 12 <= png.length) {
    const len = readLen(off)
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7])
    if (type === 'tEXt') return off + 8 + len
    if (type === 'IEND') break
    off += 12 + len
  }
  return -1
}

describe('png-flow', () => {
  it('exposes the well-known keyword', () => {
    expect(FLOW_KEYWORD).toBe('tachiflow')
  })

  it('round-trips a unicode flow JSON through embed → extract', () => {
    // Non-ASCII everywhere (Cyrillic, CJK, emoji, accented, em-dash) exercises the
    // UTF-8 → base64 → Latin-1-tEXt → base64 → UTF-8 path.
    const json = JSON.stringify({
      version: 1,
      name: 'Поток 流程 🚀',
      nodes: [{ id: 'a', type: 'prompt', data: { label: 'café — テスト', instruction: 'Ω≈ç√∫' } }],
      edges: [],
    })
    const png = pngFixture()
    const embedded = embedFlowInPng(png, json)

    // A chunk was added, the input was not mutated, and it's still a valid PNG.
    expect(embedded.length).toBeGreaterThan(png.length)
    expect(png.length).toBe(70)
    expect(extractFlowFromPng(png)).toBeNull() // original untouched
    expect(Array.from(embedded.subarray(0, 8))).toEqual(PNG_SIG)
    // Ends with the IEND chunk (our tEXt is spliced BEFORE it).
    expect(String.fromCharCode(...embedded.subarray(embedded.length - 8, embedded.length - 4))).toBe('IEND')

    expect(extractFlowFromPng(embedded)).toBe(json)
  })

  it('returns null for a PNG with no tachiflow chunk', () => {
    expect(extractFlowFromPng(pngFixture())).toBeNull()
  })

  it('returns null when the tachiflow chunk CRC is corrupted (fail-closed)', () => {
    const json = '{"version":1,"nodes":[],"edges":[]}'
    const embedded = embedFlowInPng(pngFixture(), json)
    expect(extractFlowFromPng(embedded)).toBe(json) // sanity: clean CRC extracts

    const crcOff = textChunkCrcOffset(embedded)
    expect(crcOff).toBeGreaterThan(0)
    const corrupted = embedded.slice()
    corrupted[crcOff] ^= 0xff // flip a CRC byte; keyword + data left intact

    expect(extractFlowFromPng(corrupted)).toBeNull()
  })

  it('returns null for a non-PNG or empty buffer', () => {
    expect(extractFlowFromPng(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    expect(extractFlowFromPng(new Uint8Array(0))).toBeNull()
  })

  it('throws when asked to embed into a non-PNG buffer', () => {
    expect(() => embedFlowInPng(new Uint8Array([0, 1, 2]), '{}')).toThrow()
  })
})
