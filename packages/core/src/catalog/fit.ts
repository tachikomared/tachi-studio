// packages/core/src/catalog/fit.ts
//
// Pure RAM/VRAM heuristic. No I/O. Overhead factor 1.2 covers the runtime
// process + KV cache at a default context. Mirrors the LM Studio "will it
// fit" badge. Returns a locale-neutral `verdict` only — the UI maps it to a
// localized label (see the renderer's catalog i18n), so no UI strings live here.

import type { HardwareProfile, FitResult } from './types.js'

const OVERHEAD = 1.2
const TIGHT_FLOOR = 0.85

export interface EstimateFitArgs {
  sizeBytes: number
  hardware: HardwareProfile
  /** Estimated transformer layer count for partial-offload math. Default 32. */
  layers?: number
}

export function estimateFit({ sizeBytes, hardware, layers = 32 }: EstimateFitArgs): FitResult {
  const need = sizeBytes * OVERHEAD
  const ram = hardware.ramFreeBytes
  const vram = hardware.vramFreeBytes

  // Full GPU offload.
  if (vram != null && vram >= need) {
    return { verdict: 'gpu', suggestedGpuLayers: layers }
  }

  // Fits in RAM → CPU, with partial GPU offload if some VRAM is usable.
  if (ram >= need) {
    let gpuLayers: number | null = null
    if (vram != null && vram > sizeBytes * 0.15) {
      const frac = (vram * 0.9) / need
      gpuLayers = Math.max(1, Math.min(layers - 1, Math.floor(layers * frac)))
    }
    return { verdict: 'cpu', suggestedGpuLayers: gpuLayers }
  }

  // Within 85–100% of the RAM need → tight.
  if (ram >= need * TIGHT_FLOOR) {
    return { verdict: 'tight', suggestedGpuLayers: null }
  }

  // Otherwise too big.
  return { verdict: 'too-big', suggestedGpuLayers: null }
}
