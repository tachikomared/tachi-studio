// packages/core/src/tachi/serve-profile.ts
//
// Serve-profile math for local llama.cpp (STEAL 2026-07-08, odysseus pattern).
// llama-cpp-client historically hardcoded --n-gpu-layers 0, so every GPU owner
// served on CPU. These pure helpers turn a detected GPU (VRAM) + a model size +
// a user profile into a concrete GPU-offload layer count, so the sidecar
// actually uses the hardware. No electron/deps → unit-testable.
//
// llama.cpp semantics: --n-gpu-layers N offloads the first N transformer layers
// to the GPU; a value ≥ the model's layer count offloads EVERYTHING. We use a
// large sentinel (ALL_LAYERS) to mean "all", matching llama-server's behaviour
// of clamping to the real layer count.

export const ALL_LAYERS = 999

export type ServeProfile = 'quality' | 'balanced' | 'speed'

export interface GpuLayerInput {
  /** Detected usable VRAM in MB. 0 / undefined = no usable GPU. */
  vramMB?: number
  /**
   * VRAM actually FREE right now, in MB, when the probe could read it.
   *
   * Total capacity is not a budget. A browser holding 4 GB, or an image
   * generation still resident, is invisible to `vramMB` — so a plan built from
   * capacity alone offloads into memory somebody else is already using and the
   * load dies at the driver. Undefined means the probe could not tell (our
   * free-memory read is nvidia-smi only), and an unknown must not be treated as
   * "all of it": the budget then falls back to the capacity-based figure it has
   * always used, which is the behaviour this field improves on, never worsens.
   */
  vramFreeMB?: number
  /** On-disk GGUF size in MB (a good proxy for VRAM needed to fully offload). */
  modelSizeMB: number
  /**
   * Transformer blocks, read from the model's own GGUF header when available.
   *
   * Without it the partial-offload path divides by a NOMINAL 40, which is a
   * number nobody measured — and the first real model checked had 35. Being
   * wrong here is not academic: the fraction is turned straight into
   * `--n-gpu-layers`, so a nominal count above the truth offloads more of the
   * model than the budget was computed for. Absent means the nominal figure is
   * used exactly as before.
   */
  layerCount?: number
  /** User profile. Defaults to 'balanced'. */
  profile?: ServeProfile
  /** True only when a GPU-capable llama build (CUDA/Metal) is actually installed. */
  gpuBuildInstalled?: boolean
  /**
   * The context llama-server will actually be started with, in tokens.
   *
   * THE INPUT THIS FUNCTION DID NOT HAVE. A 4K run and a 128K run of the same
   * file got the same layer count, because the only allowance for the KV cache
   * was a flat 1200 MB — and the KV cache is the one thing in VRAM that grows
   * with context while the weights do not. At 128K on a 35-block model it is
   * measured in gigabytes, so the plan was offloading into memory the cache was
   * about to need.
   */
  contextTokens?: number
  /** KV heads (GQA): the cache is sized by these, not by the attention heads. */
  kvHeads?: number
  /** Per-head key and value dimensions, from the GGUF header. */
  keyDim?: number
  valueDim?: number
  /**
   * The K-cache precision that will be passed to llama-server. Only K is ever
   * quantised here (the V cache stays f16 without flash attention), which is
   * why the two halves of the cache are sized separately below.
   */
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0'
}

export interface GpuLayerPlan {
  /** Value to pass as --n-gpu-layers. 0 = pure CPU. */
  nGpuLayers: number
  /** Whether any layer will run on the GPU. */
  usesGpu: boolean
  /** Human reason (surfaced to the user / Doctor). */
  reason: string
}

// VRAM headroom the OS/other apps + KV-cache need beyond the weights (MB).
const VRAM_OVERHEAD_MB = 1200
// Fraction of VRAM a profile is willing to spend on weights.
const PROFILE_BUDGET: Record<ServeProfile, number> = {
  quality: 0.92,   // pack the card — best tokens/sec if it fits
  balanced: 0.80,  // leave room for a bigger context / other apps
  speed: 0.65,     // conservative — avoids thrashing on shared GPUs
}

/**
 * Bytes per stored element for a KV-cache precision.
 *
 * The quantised figures are not 1 and 0.5: llama.cpp's q8_0 block is 34 bytes
 * per 32 values (32 quants + an f16 scale) and q4_0 is 18 bytes per 32 (16
 * packed nibbles + an f16 scale). Rounding those down to the nominal bit width
 * would under-reserve by ~6% and ~12% respectively, and under-reserving is how
 * a plan turns into a failed load.
 */
const KV_BYTES_PER_ELEMENT: Record<'f16' | 'q8_0' | 'q4_0', number> = {
  f16:  2,
  q8_0: 34 / 32,
  q4_0: 18 / 32,
}

/**
 * The KV cache this run will actually allocate, in MB, or null when the model
 * did not tell us enough to say.
 *
 * cache = tokens × blocks × kv_heads × (key_dim × bytes_K + value_dim × 2)
 *
 * V is at two bytes regardless of the choice, because we only ever pass
 * `--cache-type-k` — quantising V without flash attention makes llama.cpp
 * unpack it on every attention step, which costs more than the memory saves.
 * Sizing V as if it were quantised would under-reserve by exactly the amount we
 * deliberately declined to save.
 *
 * Exported for unit tests.
 */
export function kvCacheMB(input: GpuLayerInput): number | null {
  const { contextTokens, kvHeads, layerCount } = input
  const pos = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  const tokens = pos(contextTokens)
  const heads  = pos(kvHeads)
  const blocks = pos(layerCount)
  const kDim   = pos(input.keyDim)
  const vDim   = pos(input.valueDim) ?? kDim
  // Every term or nothing. A cache sized from three of four facts and a guess
  // for the fourth is the kind of number this whole file exists to stop making.
  if (tokens === null || heads === null || blocks === null || kDim === null || vDim === null) return null
  const bytesK = KV_BYTES_PER_ELEMENT[input.kvCacheType ?? 'f16'] ?? 2
  const bytes = tokens * blocks * heads * (kDim * bytesK + vDim * 2)
  return bytes / (1024 * 1024)
}

/** The smallest context worth serving. Below this a chat is not usable. */
export const MIN_SERVE_CONTEXT_TOKENS = 4096

export interface ServePlan {
  plan: GpuLayerPlan
  /** The context to actually start the server with — may be BELOW the request. */
  contextTokens: number
  /** Set when the context was reduced to make the model fit the card. */
  contextReducedFrom?: number
}

/**
 * Choose the context AND the layer count together, because they compete for the
 * same memory.
 *
 * WHY THIS EXISTS. Reserving the KV cache (see kvCacheMB) made the planner
 * honest and immediately exposed the decision nobody was making: six curated
 * rows declare a 128k context, and `resolveLlamaContextSize` starts the server
 * at a row's full native context whenever the caller names none. Measured on a
 * 12 GB card with the owner's own model geometry (35 blocks, 1 KV head,
 * key_length 512):
 *
 *     4k ctx →   280 MB cache → 8350 MB for weights → full offload
 *    32k ctx →  2240 MB cache → 6390 MB for weights → full offload
 *   128k ctx →  8960 MB cache →    0 MB for weights → **CPU**
 *
 * So a 3 GB model that offloaded entirely would drop to the CPU the moment the
 * cache was counted. Both answers available before this function were wrong:
 * ignore the cache and llama.cpp allocates 8.9 GB it was not budgeted (OOM or
 * host-memory thrash), or count it and abandon the GPU over a context length
 * nobody asked for.
 *
 * The third answer is the obvious one and it is what every local runner does:
 * SERVE A SMALLER CONTEXT. Halve until the model fits or the floor is reached,
 * and say so, so a user who really wants 128k learns they must give up layers
 * rather than silently getting a CPU run at a context they never chose.
 *
 * A REQUEST IS NOT NEGOTIABLE. When the caller passed an explicit contextSize —
 * a user typing a number — it is honoured as-is and the layer count absorbs the
 * cost. Trimming a value somebody chose, to win back speed they did not ask
 * for, is the kind of helpfulness that reads as a bug.
 */
export function planServe(
  input: GpuLayerInput,
  opts: { requestedTokens: number; contextIsExplicit?: boolean } = { requestedTokens: 0 },
): ServePlan {
  const requested = Number.isFinite(opts.requestedTokens) && opts.requestedTokens > 0
    ? Math.floor(opts.requestedTokens)
    : 0
  const at = (tokens: number): GpuLayerPlan =>
    planGpuLayers(tokens > 0 ? { ...input, contextTokens: tokens } : input)

  const first = at(requested)
  // Nothing to negotiate: no context to speak of, the user named one, the plan
  // already uses the GPU, or there is no GPU to lose.
  if (requested === 0 || opts.contextIsExplicit || first.usesGpu || !input.gpuBuildInstalled) {
    return { plan: first, contextTokens: requested }
  }

  let tokens = requested
  while (tokens > MIN_SERVE_CONTEXT_TOKENS) {
    tokens = Math.max(MIN_SERVE_CONTEXT_TOKENS, Math.floor(tokens / 2))
    const plan = at(tokens)
    if (plan.usesGpu) {
      return {
        plan: {
          ...plan,
          reason: `${plan.reason} — context trimmed to ${tokens.toLocaleString('en-US')} tokens `
            + `(from ${requested.toLocaleString('en-US')}) so the model could stay on the GPU`,
        },
        contextTokens: tokens,
        contextReducedFrom: requested,
      }
    }
  }
  // Even the floor does not help — the weights themselves do not fit. Report the
  // ORIGINAL request: trimming the context bought nothing, so claiming it was
  // trimmed would be a change with no effect dressed as a decision.
  return { plan: first, contextTokens: requested }
}

/**
 * Decide how many layers to offload to the GPU. Returns a pure plan; the caller
 * passes plan.nGpuLayers to llama-server. Fully offloads when the model
 * comfortably fits the profile's VRAM budget; partially offloads (proportional)
 * when it's tight; falls back to CPU (0) when there's no usable GPU or no
 * GPU-capable build installed.
 */
export function planGpuLayers(input: GpuLayerInput): GpuLayerPlan {
  const { vramMB = 0, modelSizeMB, profile = 'balanced', gpuBuildInstalled = false } = input
  const freeMB = typeof input.vramFreeMB === 'number' && Number.isFinite(input.vramFreeMB) && input.vramFreeMB >= 0
    ? input.vramFreeMB
    : null

  if (!gpuBuildInstalled) {
    return { nGpuLayers: 0, usesGpu: false, reason: 'CPU build installed — no GPU offload. Install the GPU (CUDA/Metal) build to use your graphics card.' }
  }
  if (vramMB <= 0) {
    return { nGpuLayers: 0, usesGpu: false, reason: 'No GPU detected — running on CPU.' }
  }
  if (modelSizeMB <= 0) {
    // Unknown size but a GPU + GPU build exist → offload all and let llama clamp.
    return { nGpuLayers: ALL_LAYERS, usesGpu: true, reason: 'GPU detected — offloading all layers.' }
  }

  // THE BUDGET IS THE SMALLER OF: the profile's slice of CAPACITY, and what is
  // actually FREE right now (less the same overhead). Capacity alone plans
  // against memory another process already owns — on a machine that runs chat
  // and image generation on one card, that is not an edge case but the normal
  // afternoon. When free memory is unreadable the second term drops out and
  // this is exactly the old calculation.
  //
  // AND THE CACHE IS RESERVED ON TOP OF THAT. `VRAM_OVERHEAD_MB` is unchanged
  // and keeps doing what it did — driver context, compute buffers, the OS's
  // slice — but it is a FLAT number, and a flat number cannot have contained a
  // KV cache that runs from a few hundred megabytes at 4K to several gigabytes
  // at 128K. When the model states enough about itself to size the cache, that
  // size comes off the budget too.
  //
  // At small contexts this is CONSERVATIVE by roughly the cache 1200 MB already
  // implied, and that is the direction to be wrong in: over-reserving costs
  // offloaded layers (slower), under-reserving costs the load (dead). When the
  // model does not say, the second term is absent and this is exactly the
  // calculation as it was.
  const cacheMB = kvCacheMB(input) ?? 0
  const reserveMB = VRAM_OVERHEAD_MB + cacheMB
  const capacityBudgetMB = Math.max(0, vramMB * PROFILE_BUDGET[profile] - reserveMB)
  const freeBudgetMB = freeMB === null ? null : Math.max(0, freeMB - reserveMB)
  const budgetMB = freeBudgetMB === null ? capacityBudgetMB : Math.min(capacityBudgetMB, freeBudgetMB)
  // Say WHICH number bound the plan, so a surprisingly small offload is
  // explainable without a debugger.
  const boundBy = freeBudgetMB !== null && freeBudgetMB < capacityBudgetMB
    ? ` — bound by ~${Math.round(freeMB! / 1024)}GB free, not ~${Math.round(vramMB / 1024)}GB total`
    : ''
  // Named in the reason whenever it is big enough to be the surprise: a user
  // who set a 128K context and got four layers deserves to see the cache in the
  // sentence, not to go looking for a bug.
  const cacheNote = cacheMB >= 512
    ? ` — ~${(cacheMB / 1024).toFixed(1)}GB reserved for the ${input.contextTokens!.toLocaleString('en-US')}-token KV cache`
      + `${input.kvCacheType && input.kvCacheType !== 'f16' ? ` at ${input.kvCacheType}` : ''}`
    : ''

  if (budgetMB >= modelSizeMB) {
    return { nGpuLayers: ALL_LAYERS, usesGpu: true, reason: `GPU offload: full (${profile}) — model ~${Math.round(modelSizeMB / 1024)}GB fits in ~${Math.round(vramMB / 1024)}GB VRAM${cacheNote}.` }
  }
  // Partial: offload the fraction of layers the budget covers. We don't know the
  // exact layer count here, so express as a fraction of a nominal 40-layer model
  // rounded down — llama clamps to the real count. Never 0 if any budget exists.
  const frac = Math.max(0, Math.min(1, budgetMB / modelSizeMB))
  // The model's own block count when the GGUF header gave us one; the old
  // nominal figure otherwise. `llama-server` clamps either way, but clamping
  // rescues an over-count, not an under-count — a nominal 40 against a real 35
  // asks for eight-sevenths of the layers the budget was computed for.
  const NOMINAL_LAYERS = 40
  const layers = typeof input.layerCount === 'number' && Number.isFinite(input.layerCount)
    && input.layerCount > 0 && input.layerCount <= 1000
    ? Math.floor(input.layerCount)
    : NOMINAL_LAYERS
  const n = Math.floor(frac * layers)
  // A one- or two-layer offload is not a small win, it is a loss: every token
  // pays a PCIe round trip to run a sliver of the model on the GPU while the
  // rest waits on the CPU. Below the floor, stay on the CPU and say why. (This
  // replaces a `Math.max(1, …)` that guaranteed at least one layer whenever any
  // budget at all existed — including the near-zero budget a busy card leaves.)
  const MIN_WORTHWHILE_LAYERS = 3
  if (n < MIN_WORTHWHILE_LAYERS) {
    return {
      nGpuLayers: 0,
      usesGpu: false,
      reason: `Running on CPU — only ~${Math.round(budgetMB / 1024)}GB of VRAM is spendable, `
        + `not enough of a ~${Math.round(modelSizeMB / 1024)}GB model to be worth the transfer${boundBy}${cacheNote}.`,
    }
  }
  return { nGpuLayers: n, usesGpu: true, reason: `GPU offload: partial (~${Math.round(frac * 100)}%) — model ~${Math.round(modelSizeMB / 1024)}GB doesn't fully fit ~${Math.round(vramMB / 1024)}GB VRAM at the ${profile} budget${boundBy}${cacheNote}.` }
}
