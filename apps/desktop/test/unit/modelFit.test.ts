// apps/desktop/test/unit/modelFit.test.ts
//
// Table math for the VRAM-aware fit estimator ported from odysseus hwfit
// (services/hwfit/fit.py + models.py). Pure module — no electron, no DOM.

import { describe, it, expect } from 'vitest'
import {
  estimateModelVramGb,
  fitVerdict,
  quantBytesPerParam,
  parseQuantFromLabel,
  parseParamsB,
} from '../../electron/services/util/model-fit'
import { annotateGgufFit, GGUF_MODELS } from '../../electron/services/llama-cpp-models'
import type { HardwareProfile } from '@tachi/core'

const GB = 1024 * 1024 * 1024

function hw(p: Partial<HardwareProfile>): HardwareProfile {
  return {
    platform: 'win32', arch: 'x64',
    ramTotalBytes: 32 * GB, ramFreeBytes: 24 * GB,
    cpuCores: 8, gpus: [], vramFreeBytes: null, isAppleSilicon: false,
    ...p,
  }
}

describe('quantBytesPerParam', () => {
  it('maps known GGUF quants to their bytes-per-param', () => {
    expect(quantBytesPerParam('Q4_K_M')).toBeCloseTo(0.5, 5)
    expect(quantBytesPerParam('Q8_0')).toBeCloseTo(1.0, 5)
    expect(quantBytesPerParam('Q6_K')).toBeCloseTo(0.75, 5)
    expect(quantBytesPerParam('F16')).toBeCloseTo(2.0, 5)
  })

  it('is case-insensitive', () => {
    expect(quantBytesPerParam('q4_k_m')).toBeCloseTo(0.5, 5)
  })

  it('falls back conservatively for an unknown quant (>= Q4_K_M weight)', () => {
    // Conservative = never under-estimate memory. Unknown quant must use a
    // bpp at least as large as the common Q4_K_M default so a card is never
    // wrongly marked as "fits".
    const fallback = quantBytesPerParam('TOTALLY_MADE_UP')
    expect(fallback).toBeGreaterThanOrEqual(0.5)
  })
})

describe('estimateModelVramGb', () => {
  it('estimates ~4-5 GB for a 7B Q4_K_M model at a modest context', () => {
    const est = estimateModelVramGb({ paramsB: 7, quant: 'Q4_K_M', contextLen: 4096 })
    expect(est).toBeGreaterThan(3.5)
    expect(est).toBeLessThan(5.5)
  })

  it('grows with parameter count', () => {
    const small = estimateModelVramGb({ paramsB: 3, quant: 'Q4_K_M' })
    const big = estimateModelVramGb({ paramsB: 14, quant: 'Q4_K_M' })
    expect(big).toBeGreaterThan(small)
  })

  it('grows with quant weight (Q8 needs more than Q4)', () => {
    const q4 = estimateModelVramGb({ paramsB: 7, quant: 'Q4_K_M' })
    const q8 = estimateModelVramGb({ paramsB: 7, quant: 'Q8_0' })
    expect(q8).toBeGreaterThan(q4)
  })

  it('adds context cost (longer context => more memory)', () => {
    const short = estimateModelVramGb({ paramsB: 7, quant: 'Q4_K_M', contextLen: 2048 })
    const long = estimateModelVramGb({ paramsB: 7, quant: 'Q4_K_M', contextLen: 32768 })
    expect(long).toBeGreaterThan(short)
  })

  it('defaults the context contribution when contextLen is omitted', () => {
    const est = estimateModelVramGb({ paramsB: 7, quant: 'Q4_K_M' })
    expect(est).toBeGreaterThan(0)
  })

  it('puts a 70B Q4 model well above a consumer 8GB card', () => {
    const est = estimateModelVramGb({ paramsB: 70, quant: 'Q4_K_M', contextLen: 4096 })
    expect(est).toBeGreaterThan(8)
    expect(est).toBeGreaterThan(30) // ~35 GB
  })

  it('returns 0 for non-positive params', () => {
    expect(estimateModelVramGb({ paramsB: 0, quant: 'Q4_K_M' })).toBe(0)
    expect(estimateModelVramGb({ paramsB: -1, quant: 'Q4_K_M' })).toBe(0)
  })
})

describe('fitVerdict', () => {
  it('fits-gpu when the estimate sits comfortably inside VRAM', () => {
    const est = estimateModelVramGb({ paramsB: 7, quant: 'Q4_K_M', contextLen: 4096 })
    const r = fitVerdict(est, { vramGb: 12, ramGb: 32 })
    expect(r.verdict).toBe('fits-gpu')
    expect(r.reason).toMatch(/GPU/i)
  })

  it('fits-cpu when VRAM is too small/absent but RAM covers it', () => {
    const est = estimateModelVramGb({ paramsB: 7, quant: 'Q4_K_M', contextLen: 4096 })
    // No GPU at all.
    const r = fitVerdict(est, { ramGb: 32 })
    expect(r.verdict).toBe('fits-cpu')
    expect(r.reason).toMatch(/RAM|CPU/i)
  })

  it('fits-cpu when a small GPU cannot hold it but system RAM can', () => {
    const est = estimateModelVramGb({ paramsB: 14, quant: 'Q4_K_M', contextLen: 4096 }) // ~7-8 GB
    const r = fitVerdict(est, { vramGb: 4, ramGb: 32 })
    expect(r.verdict).toBe('fits-cpu')
  })

  it('tight when the estimate is within 10% over VRAM', () => {
    // 8 GB card; build an estimate just above it (8.0..8.8).
    const r = fitVerdict(8.5, { vramGb: 8, ramGb: 32 })
    expect(r.verdict).toBe('tight')
    expect(r.reason).toMatch(/tight|barely|10%/i)
  })

  it('tight at the upper boundary (exactly 10% over) but no-fit beyond it', () => {
    expect(fitVerdict(8.8, { vramGb: 8, ramGb: 32 }).verdict).toBe('tight')
    // 11% over VRAM, and RAM also can't hold it -> no-fit
    expect(fitVerdict(8.9, { vramGb: 8, ramGb: 8 }).verdict).toBe('no-fit')
  })

  it('no-fit when neither VRAM nor RAM can hold it', () => {
    const est = estimateModelVramGb({ paramsB: 70, quant: 'Q4_K_M', contextLen: 4096 })
    const r = fitVerdict(est, { vramGb: 8, ramGb: 16 })
    expect(r.verdict).toBe('no-fit')
    expect(r.reason).toMatch(/too (big|large)|exceed|RAM/i)
  })

  it('prefers fits-gpu over fits-cpu when both apply', () => {
    const r = fitVerdict(5, { vramGb: 12, ramGb: 32 })
    expect(r.verdict).toBe('fits-gpu')
  })

  it('handles a zero/unknown estimate without crashing', () => {
    const r = fitVerdict(0, { vramGb: 8, ramGb: 16 })
    expect(['fits-gpu', 'fits-cpu', 'tight', 'no-fit']).toContain(r.verdict)
  })
})

describe('parseQuantFromLabel', () => {
  it('extracts the GGUF quant token from a quant label', () => {
    expect(parseQuantFromLabel('Q4_K_M')).toBe('Q4_K_M')
    expect(parseQuantFromLabel('Q5_K_S')).toBe('Q5_K_S')
  })

  it('returns undefined for a non-quant label', () => {
    expect(parseQuantFromLabel('GGUF')).toBeUndefined()
    expect(parseQuantFromLabel('')).toBeUndefined()
  })
})

describe('parseParamsB', () => {
  it('parses a "7B" display string', () => {
    expect(parseParamsB('7B')).toBe(7)
    expect(parseParamsB('3.8B')).toBeCloseTo(3.8, 5)
    expect(parseParamsB('70B')).toBe(70)
  })

  it('parses a bare numeric string', () => {
    expect(parseParamsB('14')).toBe(14)
  })

  it('returns undefined for an unparseable string', () => {
    expect(parseParamsB('')).toBeUndefined()
    expect(parseParamsB('Large')).toBeUndefined()
  })
})

describe('annotateGgufFit (service-layer wiring)', () => {
  it('annotates every curated GGUF with a verdict, reason, and estimate', () => {
    const out = annotateGgufFit(hw({ vramFreeBytes: 8 * GB }))
    expect(out).toHaveLength(GGUF_MODELS.length)
    for (const m of out) {
      expect(['fits-gpu', 'fits-cpu', 'tight', 'no-fit']).toContain(m.fitVerdict)
      expect(typeof m.fitReason).toBe('string')
      expect(m.estVramGb).toBeGreaterThan(0)
      // Annotation is additive — original fields survive.
      expect(m.id).toBeTruthy()
      expect(m.quant).toBeTruthy()
    }
  })

  it('marks a small 3B model as fits-gpu on an 8GB card', () => {
    const out = annotateGgufFit(hw({ vramFreeBytes: 8 * GB }))
    const phi = out.find(m => m.id === 'phi-3-mini-4k-instruct-q4')
    expect(phi?.fitVerdict).toBe('fits-gpu')
  })

  it('a 16B model does not fit an 8GB card but fits 24GB RAM (cpu)', () => {
    const out = annotateGgufFit(hw({ vramFreeBytes: 8 * GB, ramFreeBytes: 24 * GB }))
    const ds = out.find(m => m.id === 'deepseek-coder-v2-lite-instruct-q4')
    expect(ds?.fitVerdict).toBe('fits-cpu')
  })

  it('falls back to CPU placement when no GPU is present', () => {
    const out = annotateGgufFit(hw({ vramFreeBytes: null, ramFreeBytes: 24 * GB }))
    for (const m of out) {
      expect(['fits-cpu', 'no-fit']).toContain(m.fitVerdict)
    }
  })
})
