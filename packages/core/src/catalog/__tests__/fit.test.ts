// packages/core/src/catalog/__tests__/fit.test.ts
import { describe, it, expect } from 'vitest'
import { estimateFit } from '../fit.js'
import type { HardwareProfile } from '../types.js'

const GB = 1024 * 1024 * 1024

function hw(p: Partial<HardwareProfile>): HardwareProfile {
  return {
    platform: 'win32', arch: 'x64',
    ramTotalBytes: 32 * GB, ramFreeBytes: 24 * GB,
    cpuCores: 8, gpus: [], vramFreeBytes: null, isAppleSilicon: false,
    ...p,
  }
}

describe('estimateFit', () => {
  it('returns gpu when free VRAM covers size*1.2', () => {
    const r = estimateFit({ sizeBytes: 5 * GB, hardware: hw({ vramFreeBytes: 12 * GB }), layers: 32 })
    expect(r.verdict).toBe('gpu')
    expect(r.suggestedGpuLayers).toBe(32)
  })

  it('returns cpu when no VRAM but RAM covers size*1.2', () => {
    const r = estimateFit({ sizeBytes: 5 * GB, hardware: hw({ vramFreeBytes: null, ramFreeBytes: 24 * GB }) })
    expect(r.verdict).toBe('cpu')
    expect(r.suggestedGpuLayers).toBeNull()
  })

  it('suggests partial GPU layers when some VRAM but not enough for full offload', () => {
    const r = estimateFit({ sizeBytes: 8 * GB, hardware: hw({ vramFreeBytes: 4 * GB, ramFreeBytes: 24 * GB }), layers: 32 })
    expect(r.verdict).toBe('cpu')
    expect(r.suggestedGpuLayers).toBeGreaterThan(0)
    expect(r.suggestedGpuLayers).toBeLessThan(32)
  })

  it('returns tight when RAM is within 85-100% of need', () => {
    // need = 8*1.2 = 9.6 GB; 85% = 8.16 GB. Give 9 GB free.
    const r = estimateFit({ sizeBytes: 8 * GB, hardware: hw({ vramFreeBytes: null, ramFreeBytes: 9 * GB }) })
    expect(r.verdict).toBe('tight')
  })

  it('returns too-big when RAM is below the tight floor (need*0.85 = size*1.02)', () => {
    const r = estimateFit({ sizeBytes: 8 * GB, hardware: hw({ vramFreeBytes: null, ramFreeBytes: 4 * GB }) })
    expect(r.verdict).toBe('too-big')
  })
})
