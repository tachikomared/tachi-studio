// apps/desktop/electron/services/util/model-fit.ts
//
// VRAM-aware fit scoring for local GGUF models. Pure module — no electron, no
// I/O — so the renderer can import it for its card badge and the service layer
// can annotate the catalog with it.
//
// Ported from odysseus' services/hwfit (fit.py + models.py): the per-quant
// bytes-per-param tables and the VRAM estimate
//   bytes = paramsB * bpp + kvCachePerTokenGb * contextLen + overhead
// drive a fit verdict against the user's GPU VRAM and system RAM.
//
// We keep our OWN verdict vocabulary (fits-gpu / fits-cpu / tight / no-fit)
// distinct from @tachi/core's size-bytes FitVerdict — this estimator works off
// params+quant+context rather than a download size, and the four labels carry
// the GPU-vs-CPU placement the badge wants to surface.

/**
 * Bytes per parameter for each GGUF quantization, plus the float/prequantized
 * formats odysseus carries. These are the realized on-disk/in-memory weights —
 * the GGUF k-quant numbers match QUANT_BYTES_PER_PARAM in hwfit/models.py
 * (the memory path, not the slightly-padded display BPP).
 */
export const QUANT_BYTES_PER_PARAM: Readonly<Record<string, number>> = {
  F32: 4.0, F16: 2.0, BF16: 2.0,
  FP8: 1.0, FP4: 0.5, NVFP4: 0.5, MXFP4: 0.5, NF4: 0.5,
  INT4: 0.5, INT8: 1.0,
  Q8_0: 1.0, Q6_K: 0.75, Q5_K_M: 0.625, Q5_K_S: 0.625, Q5_0: 0.625,
  Q4_K_M: 0.5, Q4_K_S: 0.5, Q4_0: 0.5,
  Q3_K_M: 0.375, Q3_K_S: 0.375, Q3_K_L: 0.375,
  Q2_K: 0.25,
  IQ4_XS: 0.5, IQ4_NL: 0.5, IQ3_XXS: 0.375, IQ2_XXS: 0.25,
}

/**
 * Relative generation-speed multiplier per quant (lower bit-width = faster
 * memory-bound decode). Carried from hwfit/models.py QUANT_SPEED_MULT for
 * callers that want a rough speed signal; the fit verdict itself does not use
 * it, but exporting it keeps the table port faithful.
 */
export const QUANT_SPEED_MULT: Readonly<Record<string, number>> = {
  F16: 0.6, BF16: 0.6, FP8: 0.85,
  FP4: 1.15, NVFP4: 1.15, MXFP4: 1.15, NF4: 1.1,
  INT4: 1.15, INT8: 0.85,
  Q8_0: 0.8, Q6_K: 0.95, Q5_K_M: 1.0, Q5_K_S: 1.0,
  Q4_K_M: 1.15, Q4_K_S: 1.15, Q4_0: 1.15,
  Q3_K_M: 1.25, Q3_K_S: 1.25, Q2_K: 1.35,
}

/**
 * Quality penalty (points off a 0-100 quality score) per quant — heavier
 * quantization loses more fidelity. From hwfit/models.py QUANT_QUALITY_PENALTY.
 * Exported for completeness; unused by the fit verdict.
 */
export const QUANT_QUALITY_PENALTY: Readonly<Record<string, number>> = {
  F16: 0.0, BF16: 0.0, FP8: 0.0,
  FP4: -3.0, NVFP4: -3.0, MXFP4: -3.0, NF4: -4.0,
  INT4: -4.0, INT8: 0.0,
  Q8_0: 0.0, Q6_K: -1.0, Q5_K_M: -2.0, Q5_K_S: -2.0,
  Q4_K_M: -5.0, Q4_K_S: -5.0, Q4_0: -5.0,
  Q3_K_M: -8.0, Q3_K_S: -8.0, Q2_K: -12.0,
}

// Conservative bytes-per-param when the quant is unknown. Equals the common
// Q4_K_M weight so an unrecognized label never UNDER-estimates memory (which
// would wrongly mark an oversized model as "fits"). hwfit defaults to 0.58
// (its padded display BPP); 0.5 matches our memory-path table and is still no
// lighter than the lightest plausible 4-bit weight, so we stay conservative
// without inflating known 4-bit models.
const DEFAULT_BPP = 0.5

// Runtime + KV-cache overhead floor (GB). Mirrors hwfit's flat +0.5 GB in
// estimate_memory_gb — the llama-server process, scratch buffers, and a small
// always-on KV allocation.
const OVERHEAD_GB = 0.5

// KV-cache cost per (param-billion x token), in GB. From hwfit: 0.000008 * pb *
// ctx, with pb in billions and the result in GB. KV scales with model width
// (which tracks param count) and context length.
const KV_GB_PER_BILLION_PARAM_TOKEN = 0.000008

// Default context length used for the estimate when a caller omits one — a
// modest 4K window matching hwfit's general-use CONTEXT_TARGET.
const DEFAULT_CONTEXT_LEN = 4096

// Verdict bands. A model that overflows VRAM by up to TIGHT_MARGIN still counts
// as "tight" (llama.cpp can usually squeeze it with a smaller context / a layer
// spilled to RAM); beyond that it must fit RAM to be "fits-cpu", else "no-fit".
const TIGHT_MARGIN = 0.1

/** Canonicalize a quant key for table lookup (upper-case, trimmed). */
function quantKey(quant: string): string {
  return (quant ?? '').trim().toUpperCase()
}

/**
 * Bytes-per-param for a quant label. Unknown labels fall back to a conservative
 * weight (never lighter than Q4_K_M) so memory is never under-estimated.
 */
export function quantBytesPerParam(quant: string): number {
  return QUANT_BYTES_PER_PARAM[quantKey(quant)] ?? DEFAULT_BPP
}

export interface EstimateVramArgs {
  /** Parameter count in billions. */
  paramsB: number
  /** GGUF quant label, e.g. "Q4_K_M". */
  quant: string
  /** Context window in tokens. Defaults to 4096. */
  contextLen?: number
}

/**
 * Estimate the memory (GB) needed to serve a model:
 *   weights (paramsB * bpp) + KV cache (scales with params x context) + overhead.
 * Returns 0 for non-positive param counts (unknown size).
 */
export function estimateModelVramGb({ paramsB, quant, contextLen }: EstimateVramArgs): number {
  if (!(paramsB > 0)) return 0
  const bpp = quantBytesPerParam(quant)
  const ctx = contextLen && contextLen > 0 ? contextLen : DEFAULT_CONTEXT_LEN
  const weights = paramsB * bpp
  const kv = KV_GB_PER_BILLION_PARAM_TOKEN * paramsB * ctx
  return weights + kv + OVERHEAD_GB
}

export type ModelFitVerdict = 'fits-gpu' | 'fits-cpu' | 'tight' | 'no-fit'

export interface FitVerdictResult {
  verdict: ModelFitVerdict
  /** One-line human reason for the badge tooltip / row. */
  reason: string
}

export interface FitBudget {
  /** Usable GPU VRAM in GB. Omit/0 when there is no usable GPU. */
  vramGb?: number
  /** Usable system RAM in GB. */
  ramGb: number
}

/**
 * Classify an estimate against a hardware budget.
 *
 *   fits-gpu  estimate <= VRAM (runs fully on the GPU)
 *   tight     estimate is within TIGHT_MARGIN over VRAM (squeezable)
 *   fits-cpu  GPU too small/absent, but system RAM holds it (CPU / partial offload)
 *   no-fit    neither VRAM nor RAM can hold it
 *
 * A zero/unknown estimate is treated as "fits" wherever a budget exists, since
 * we can't prove it won't (degrade gracefully rather than scaring the user).
 */
export function fitVerdict(estGb: number, budget: FitBudget): FitVerdictResult {
  const vram = budget.vramGb && budget.vramGb > 0 ? budget.vramGb : 0
  const ram = budget.ramGb > 0 ? budget.ramGb : 0
  const est = estGb > 0 ? estGb : 0

  const round = (n: number) => Math.round(n * 10) / 10

  // Full GPU offload.
  if (vram > 0 && est <= vram) {
    return { verdict: 'fits-gpu', reason: `Runs on GPU (~${round(est)} GB / ${round(vram)} GB VRAM)` }
  }

  // Just over VRAM — squeezable with a smaller context or one spilled layer.
  if (vram > 0 && est <= vram * (1 + TIGHT_MARGIN)) {
    return { verdict: 'tight', reason: `Tight on GPU (~${round(est)} GB vs ${round(vram)} GB VRAM, within 10%)` }
  }

  // GPU can't hold it, but system RAM can — CPU or partial-offload path.
  if (ram > 0 && est <= ram) {
    const why = vram > 0 ? 'GPU too small' : 'no GPU'
    return { verdict: 'fits-cpu', reason: `CPU/RAM only (~${round(est)} GB in RAM, ${why})` }
  }

  // Nothing holds it.
  const budgetGb = Math.max(vram, ram)
  return { verdict: 'no-fit', reason: `Too big (~${round(est)} GB exceeds ${round(budgetGb)} GB available)` }
}

// ─── Label parsing helpers (for callers holding display strings) ────────────

const QUANT_LABEL_RE = /\b((?:IQ|Q)\d(?:_[A-Z0-9]+)*|F16|F32|BF16|FP8|FP4|NF4|INT4|INT8)\b/i

/**
 * Pull a GGUF quant token out of a free-form label (e.g. a quant option's
 * `label`). Returns the canonical upper-case token, or undefined when none is
 * present (e.g. a bare "GGUF" / "Q4" without the k-quant suffix won't match a
 * full token — callers treat undefined as "unknown quant").
 */
export function parseQuantFromLabel(label: string): string | undefined {
  const m = QUANT_LABEL_RE.exec(label ?? '')
  return m ? m[1].toUpperCase() : undefined
}

/**
 * Parse a display param string ("7B", "3.8B", "70B", bare "14") into a billions
 * number. Returns undefined when there's no leading numeric token.
 */
export function parseParamsB(params: string): number | undefined {
  const m = /([\d.]+)/.exec(params ?? '')
  if (!m) return undefined
  const v = parseFloat(m[1])
  return Number.isFinite(v) ? v : undefined
}
