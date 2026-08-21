// apps/desktop/src/pages/catalog/localFit.ts
//
// Renderer-side adapter for the VRAM-aware fit badge on local llama.cpp model
// cards. Reuses the SAME pure estimator the main process uses to annotate the
// catalog (electron/services/util/model-fit) — that module has zero electron
// imports, so it is safe to pull into the renderer bundle and we avoid
// duplicating the quant tables here.
//
// The curated catalog rows reach the renderer as plain CatalogEntry objects
// (no fit annotation field), so this recomputes the verdict from the entry's
// display params + quant label against the already-loaded hardware profile.
// Degrades to null when the entry is not a parseable local model.

import type { CatalogEntry, HardwareProfile } from '@tachi/core'
import {
  estimateModelVramGb,
  fitVerdict,
  parseParamsB,
  parseQuantFromLabel,
  type ModelFitVerdict,
} from '../../../electron/services/util/model-fit'

const BYTES_PER_GB = 1024 * 1024 * 1024

export interface LocalFitBadge {
  verdict: ModelFitVerdict
  reason: string
  /** Short brutalist label for the badge chip. */
  label: string
  estVramGb: number
}

const LABELS: Record<ModelFitVerdict, string> = {
  'fits-gpu': 'FITS',
  'tight':    'TIGHT',
  'fits-cpu': 'CPU-ONLY',
  'no-fit':   'NO FIT',
}

/**
 * Compute the fit badge for a catalog entry, or null when it can't (no
 * hardware snapshot, not a local llama.cpp/ollama text model, or unparseable
 * params). Callers render nothing on null — silent degrade.
 */
export function computeLocalFitBadge(entry: CatalogEntry, hw: HardwareProfile | null): LocalFitBadge | null {
  if (!hw) return null
  // Only local-runtime text models get the VRAM badge — sd.cpp/piper/whisper
  // rows and remote/hf rows have no GGUF quant to reason about.
  const local = (entry.quants ?? []).find(q => q.runtime === 'llamacpp' || q.runtime === 'ollama')
  if (!local) return null

  const paramsB = parseParamsB(entry.params)
  if (paramsB == null || !(paramsB > 0)) return null

  // Prefer a real GGUF quant token; fall back to Q4_K_M (the curated default
  // and what Ollama tags ship at) when the label is just "GGUF" / "Q4".
  const quant = parseQuantFromLabel(local.label) ?? 'Q4_K_M'

  const vramGb = hw.vramFreeBytes && hw.vramFreeBytes > 0 ? hw.vramFreeBytes / BYTES_PER_GB : 0
  const ramBytes = hw.ramFreeBytes > 0 ? hw.ramFreeBytes : hw.ramTotalBytes
  const ramGb = ramBytes > 0 ? ramBytes / BYTES_PER_GB : 0

  const estVramGb = estimateModelVramGb({ paramsB, quant })
  const { verdict, reason } = fitVerdict(estVramGb, { vramGb, ramGb })
  return { verdict, reason, label: LABELS[verdict], estVramGb: Math.round(estVramGb * 10) / 10 }
}
