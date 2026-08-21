// apps/desktop/test/unit/localFit.test.ts
//
// Renderer-side fit-badge adapter (src/pages/catalog/localFit.ts). Pure module:
// reuses the node-safe model-fit estimator + @tachi/core types, no electron/DOM
// at import time. Covers params-string parsing edge cases, the quant inference
// fallback when no full GGUF token is present, and verdict/reason/label mapping.

import { describe, it, expect } from 'vitest'
import { computeLocalFitBadge } from '../../src/pages/catalog/localFit'
import type { CatalogEntry, HardwareProfile, QuantOption, RuntimeId } from '@tachi/core'

const GB = 1024 * 1024 * 1024

function hw(p: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    platform: 'win32', arch: 'x64',
    ramTotalBytes: 32 * GB, ramFreeBytes: 24 * GB,
    cpuCores: 8, gpus: [], vramFreeBytes: null, isAppleSilicon: false,
    ...p,
  }
}

function quant(p: Partial<QuantOption> = {}): QuantOption {
  return { label: 'Q4_K_M', sizeBytes: 4 * GB, runtime: 'llamacpp', ref: 'x', ...p }
}

function entry(p: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: 'm', name: 'Model', family: 'fam', params: '7B', kind: 'text',
    source: 'curated', quants: [quant()], capabilities: ['chat'],
    ...p,
  }
}

describe('computeLocalFitBadge — null / degrade paths', () => {
  it('returns null when there is no hardware snapshot', () => {
    expect(computeLocalFitBadge(entry(), null)).toBeNull()
  })

  it('returns null when no quant is a local llamacpp/ollama runtime', () => {
    // sd.cpp / piper / whisper / remote rows have no GGUF quant to reason about.
    const e = entry({ quants: [quant({ runtime: 'sdcpp' as RuntimeId }), quant({ runtime: 'piper' as RuntimeId })] })
    expect(computeLocalFitBadge(e, hw({ vramFreeBytes: 8 * GB }))).toBeNull()
  })

  it('returns null when quants is empty', () => {
    expect(computeLocalFitBadge(entry({ quants: [] }), hw({ vramFreeBytes: 8 * GB }))).toBeNull()
  })

  it('returns null when quants is missing entirely', () => {
    const e = entry()
    // Exercise the `entry.quants ?? []` guard.
    delete (e as { quants?: unknown }).quants
    expect(computeLocalFitBadge(e, hw({ vramFreeBytes: 8 * GB }))).toBeNull()
  })

  it('accepts an ollama runtime quant (not just llamacpp)', () => {
    const e = entry({ quants: [quant({ runtime: 'ollama', label: 'qwen2.5:7b' })] })
    expect(computeLocalFitBadge(e, hw({ vramFreeBytes: 8 * GB }))).not.toBeNull()
  })
})

describe('computeLocalFitBadge — params string parsing', () => {
  it('returns null when params has no leading numeric token', () => {
    expect(computeLocalFitBadge(entry({ params: 'unknown' }), hw({ vramFreeBytes: 8 * GB }))).toBeNull()
    expect(computeLocalFitBadge(entry({ params: '' }), hw({ vramFreeBytes: 8 * GB }))).toBeNull()
  })

  it('returns null when params parses to zero (paramsB > 0 guard)', () => {
    expect(computeLocalFitBadge(entry({ params: '0B' }), hw({ vramFreeBytes: 8 * GB }))).toBeNull()
  })

  it('parses a fractional param size ("3.8B") into the estimate', () => {
    // 3.8 * 0.5 weights + 0.000008*3.8*4096 kv + 0.5 overhead = 2.5246..  → 2.5
    const badge = computeLocalFitBadge(entry({ params: '3.8B' }), hw({ vramFreeBytes: 8 * GB }))
    expect(badge).not.toBeNull()
    expect(badge!.estVramGb).toBeCloseTo(2.5, 5)
  })

  it('parses a bare numeric param string ("14") with no B suffix', () => {
    // 14 * 0.5 + 0.000008*14*4096 + 0.5 = 7.9587..  → 8
    const badge = computeLocalFitBadge(entry({ params: '14' }), hw({ vramFreeBytes: 24 * GB }))
    expect(badge).not.toBeNull()
    expect(badge!.estVramGb).toBeCloseTo(8, 1)
  })

  it('uses the first numeric run when params has surrounding text', () => {
    // "~7B (instruct)" → 7 → same estimate as a plain 7B model.
    const a = computeLocalFitBadge(entry({ params: '~7B (instruct)' }), hw({ vramFreeBytes: 8 * GB }))
    const b = computeLocalFitBadge(entry({ params: '7B' }), hw({ vramFreeBytes: 8 * GB }))
    expect(a).not.toBeNull()
    expect(a!.estVramGb).toBe(b!.estVramGb)
  })
})

describe('computeLocalFitBadge — quant inference + fallback', () => {
  it('falls back to Q4_K_M weight when the label has no full GGUF token', () => {
    // Bare "GGUF" yields no quant token → DEFAULT fallback Q4_K_M (0.5 bpp),
    // so the estimate matches an explicit Q4_K_M of the same size.
    const gguf = computeLocalFitBadge(entry({ quants: [quant({ label: 'GGUF' })] }), hw({ vramFreeBytes: 8 * GB }))
    const q4 = computeLocalFitBadge(entry({ quants: [quant({ label: 'Q4_K_M' })] }), hw({ vramFreeBytes: 8 * GB }))
    expect(gguf).not.toBeNull()
    expect(gguf!.estVramGb).toBe(q4!.estVramGb)
    expect(gguf!.estVramGb).toBeCloseTo(4.2, 5) // 7*0.5 + 0.000008*7*4096 + 0.5
  })

  it('honors a heavier explicit quant (Q8_0) over the Q4 fallback', () => {
    // Q8_0 = 1.0 bpp → weights 7.0, est ≈ 7.7 — strictly heavier than the Q4 path.
    const q8 = computeLocalFitBadge(entry({ quants: [quant({ label: 'Q8_0' })] }), hw({ vramFreeBytes: 24 * GB }))
    const q4 = computeLocalFitBadge(entry({ quants: [quant({ label: 'Q4_K_M' })] }), hw({ vramFreeBytes: 24 * GB }))
    expect(q8!.estVramGb).toBeGreaterThan(q4!.estVramGb)
    expect(q8!.estVramGb).toBeCloseTo(7.7, 1)
  })

  it('extracts a quant token embedded in a free-form label', () => {
    const e = entry({ quants: [quant({ label: 'My Model GGUF (Q6_K)' })] })
    // Q6_K = 0.75 bpp → weights 5.25, est ≈ 5.98 → 6.0
    const badge = computeLocalFitBadge(e, hw({ vramFreeBytes: 24 * GB }))
    expect(badge).not.toBeNull()
    expect(badge!.estVramGb).toBeCloseTo(6, 1)
  })
})

describe('computeLocalFitBadge — verdict / reason / label mapping', () => {
  it('maps fits-gpu → FITS with a GPU reason when VRAM holds it', () => {
    const badge = computeLocalFitBadge(entry({ params: '7B' }), hw({ vramFreeBytes: 8 * GB }))
    expect(badge!.verdict).toBe('fits-gpu')
    expect(badge!.label).toBe('FITS')
    expect(badge!.reason).toMatch(/Runs on GPU/)
    expect(badge!.reason).toContain('GB VRAM')
  })

  it('maps tight → TIGHT when the estimate is just over VRAM (within 10%)', () => {
    // 7B Q4 est ≈ 4.23; VRAM 4 GB → over but within 4*1.1=4.4 → tight.
    const badge = computeLocalFitBadge(entry({ params: '7B' }), hw({ vramFreeBytes: 4 * GB }))
    expect(badge!.verdict).toBe('tight')
    expect(badge!.label).toBe('TIGHT')
    expect(badge!.reason).toMatch(/Tight on GPU/)
  })

  it('maps fits-cpu → CPU-ONLY when GPU is too small but RAM holds it', () => {
    // est ≈ 4.23; VRAM 2 GB too small, RAM 16 GB holds it.
    const badge = computeLocalFitBadge(
      entry({ params: '7B' }),
      hw({ vramFreeBytes: 2 * GB, ramFreeBytes: 16 * GB }),
    )
    expect(badge!.verdict).toBe('fits-cpu')
    expect(badge!.label).toBe('CPU-ONLY')
    expect(badge!.reason).toMatch(/CPU\/RAM only/)
    expect(badge!.reason).toContain('GPU too small')
  })

  it('maps no-fit → NO FIT when neither VRAM nor RAM holds it', () => {
    // 70B Q4 est ≈ 37 GB; tiny VRAM + tiny RAM → no-fit.
    const badge = computeLocalFitBadge(
      entry({ params: '70B' }),
      hw({ vramFreeBytes: 2 * GB, ramFreeBytes: 4 * GB, ramTotalBytes: 4 * GB }),
    )
    expect(badge!.verdict).toBe('no-fit')
    expect(badge!.label).toBe('NO FIT')
    expect(badge!.reason).toMatch(/Too big/)
  })

  it('rounds estVramGb to one decimal place', () => {
    const badge = computeLocalFitBadge(entry({ params: '7B' }), hw({ vramFreeBytes: 8 * GB }))
    expect(badge!.estVramGb).toBe(4.2)
    expect(Number.isInteger(badge!.estVramGb * 10)).toBe(true)
  })
})

describe('computeLocalFitBadge — VRAM / RAM budget derivation', () => {
  it('treats vramFreeBytes null as no usable GPU (falls through to RAM)', () => {
    // No VRAM signal at all → cannot be fits-gpu; 7B fits RAM → fits-cpu w/ "no GPU".
    const badge = computeLocalFitBadge(entry({ params: '7B' }), hw({ vramFreeBytes: null, ramFreeBytes: 16 * GB }))
    expect(badge!.verdict).toBe('fits-cpu')
    expect(badge!.reason).toContain('no GPU')
  })

  it('falls back to ramTotalBytes when ramFreeBytes is non-positive', () => {
    // ramFree 0 → use ramTotal 16 GB; no GPU; 7B est ≈ 4.23 fits → fits-cpu.
    const badge = computeLocalFitBadge(
      entry({ params: '7B' }),
      hw({ vramFreeBytes: null, ramFreeBytes: 0, ramTotalBytes: 16 * GB }),
    )
    expect(badge!.verdict).toBe('fits-cpu')
  })

  it('ignores a non-positive vramFreeBytes (0) as no usable GPU', () => {
    const badge = computeLocalFitBadge(
      entry({ params: '7B' }),
      hw({ vramFreeBytes: 0, ramFreeBytes: 16 * GB }),
    )
    expect(badge!.verdict).toBe('fits-cpu')
    expect(badge!.reason).toContain('no GPU')
  })
})
