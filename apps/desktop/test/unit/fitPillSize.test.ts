// apps/desktop/test/unit/fitPillSize.test.ts
//
// The chat model-picker FIT pill: pure size-resolution (curated registry
// estimate vs REAL on-disk file size) + the estimateFit verdict it feeds.
// Regression anchor: an HF-searched GGUF (e.g. hf_…gemma…iq3_m.gguf, 2.92 GB
// on disk) is NOT in the curated registry — before the disk-size fallback the
// picker rendered no pill at all for it.

import { describe, it, expect } from 'vitest'
import { resolveGgufSizeBytes, diskSizesFromInstalled } from '../../src/pages/chat/fitPillSize'
import { estimateFit } from '@tachi/core/src/catalog/fit'
import type { HardwareProfile } from '@tachi/core'

const MB = 1024 * 1024
const GB = 1024 * MB

function hw(p: Partial<HardwareProfile>): HardwareProfile {
  return {
    platform: 'win32', arch: 'x64',
    ramTotalBytes: 32 * GB, ramFreeBytes: 24 * GB,
    cpuCores: 8, gpus: [], vramFreeBytes: null, isAppleSilicon: false,
    ...p,
  }
}

describe('resolveGgufSizeBytes', () => {
  it('prefers the curated registry estimate when present (matches Catalog cards)', () => {
    const r = resolveGgufSizeBytes(4400, 4_600 * MB)
    expect(r).toEqual({ sizeBytes: 4400 * MB, fromDisk: false })
  })

  it('falls back to the on-disk byte size for non-curated (HF-searched) GGUFs', () => {
    const disk = Math.round(2.92 * GB)
    const r = resolveGgufSizeBytes(undefined, disk)
    expect(r).toEqual({ sizeBytes: disk, fromDisk: true })
  })

  it('returns null when neither source knows the size (pill not rendered)', () => {
    expect(resolveGgufSizeBytes(undefined, undefined)).toBeNull()
    expect(resolveGgufSizeBytes(0, 0)).toBeNull()
    expect(resolveGgufSizeBytes(-1, -5)).toBeNull()
    expect(resolveGgufSizeBytes(NaN, NaN)).toBeNull()
  })

  it('skips a zero curated size and still uses the disk size', () => {
    const r = resolveGgufSizeBytes(0, 3 * GB)
    expect(r).toEqual({ sizeBytes: 3 * GB, fromDisk: true })
  })
})

describe('diskSizesFromInstalled', () => {
  it('maps llamacpp rows with positive sizes, dropping other runtimes and zeros', () => {
    const out = diskSizesFromInstalled([
      { runtime: 'llamacpp', ref: 'hf_x_gemma-iq3_m', sizeBytes: Math.round(2.92 * GB) },
      { runtime: 'llamacpp', ref: 'ghost',            sizeBytes: 0 },
      { runtime: 'ollama',   ref: 'llama3.2:3b',      sizeBytes: 2 * GB },
    ])
    expect(out).toEqual({ 'hf_x_gemma-iq3_m': Math.round(2.92 * GB) })
  })

  it('tolerates an absent list (older main build without the surface)', () => {
    expect(diskSizesFromInstalled(undefined)).toEqual({})
    expect(diskSizesFromInstalled(null)).toEqual({})
  })
})

describe('disk size → estimateFit verdict (the pill mapping end to end)', () => {
  const disk = Math.round(2.92 * GB) // the real HF gemma iq3_m case
  const size = resolveGgufSizeBytes(undefined, disk)!

  it('FITS on a GPU whose free VRAM covers size*1.2', () => {
    const r = estimateFit({ sizeBytes: size.sizeBytes, hardware: hw({ vramFreeBytes: 12 * GB }) })
    expect(r.verdict).toBe('gpu')
  })

  it('CPU-ONLY with no GPU but ample free RAM', () => {
    const r = estimateFit({ sizeBytes: size.sizeBytes, hardware: hw({ vramFreeBytes: null, ramFreeBytes: 24 * GB }) })
    expect(r.verdict).toBe('cpu')
  })

  it('TIGHT when free RAM is within 85–100% of the need', () => {
    // need = 2.92 * 1.2 ≈ 3.5 GB; 3.2 GB free is ~91% of it.
    const r = estimateFit({ sizeBytes: size.sizeBytes, hardware: hw({ vramFreeBytes: null, ramFreeBytes: 3.2 * GB }) })
    expect(r.verdict).toBe('tight')
  })

  it('NO FIT when free RAM is below the tight floor', () => {
    const r = estimateFit({ sizeBytes: size.sizeBytes, hardware: hw({ vramFreeBytes: null, ramFreeBytes: 2 * GB }) })
    expect(r.verdict).toBe('too-big')
  })
})
