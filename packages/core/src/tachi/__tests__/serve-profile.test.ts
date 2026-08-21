// packages/core/src/tachi/__tests__/serve-profile.test.ts
import { describe, it, expect } from 'vitest'
import { planGpuLayers, planServe, kvCacheMB, ALL_LAYERS, MIN_SERVE_CONTEXT_TOKENS } from '../serve-profile.js'

describe('planGpuLayers', () => {
  it('stays on CPU when no GPU build is installed (the pre-fix default)', () => {
    const p = planGpuLayers({ vramMB: 12288, modelSizeMB: 4700, gpuBuildInstalled: false })
    expect(p.nGpuLayers).toBe(0)
    expect(p.usesGpu).toBe(false)
    expect(p.reason).toMatch(/CPU build/i)
  })

  it('stays on CPU when no GPU is detected', () => {
    const p = planGpuLayers({ vramMB: 0, modelSizeMB: 4700, gpuBuildInstalled: true })
    expect(p.nGpuLayers).toBe(0)
    expect(p.usesGpu).toBe(false)
  })

  it('fully offloads a model that fits VRAM (RTX 3080 Ti 12GB, 4.7GB model)', () => {
    const p = planGpuLayers({ vramMB: 12288, modelSizeMB: 4700, profile: 'balanced', gpuBuildInstalled: true })
    expect(p.nGpuLayers).toBe(ALL_LAYERS)
    expect(p.usesGpu).toBe(true)
    expect(p.reason).toMatch(/full/i)
  })

  it('partially offloads when the model is bigger than the VRAM budget', () => {
    // 6GB card, 10GB model → tight; expect a partial (>0, < ALL) offload.
    const p = planGpuLayers({ vramMB: 6144, modelSizeMB: 10000, profile: 'balanced', gpuBuildInstalled: true })
    expect(p.usesGpu).toBe(true)
    expect(p.nGpuLayers).toBeGreaterThan(0)
    expect(p.nGpuLayers).toBeLessThan(ALL_LAYERS)
    expect(p.reason).toMatch(/partial/i)
  })

  it('quality packs more than speed for the same tight card', () => {
    const tight = { vramMB: 6144, modelSizeMB: 9000, gpuBuildInstalled: true }
    const q = planGpuLayers({ ...tight, profile: 'quality' })
    const s = planGpuLayers({ ...tight, profile: 'speed' })
    expect(q.nGpuLayers).toBeGreaterThanOrEqual(s.nGpuLayers)
  })

  it('offloads all when GPU present but model size unknown', () => {
    const p = planGpuLayers({ vramMB: 8192, modelSizeMB: 0, gpuBuildInstalled: true })
    expect(p.nGpuLayers).toBe(ALL_LAYERS)
  })
})

// ── Free VRAM, and the layer floor (2026-08-03) ─────────────────────────────
//
// From the koboldcpp source study: budget against what is FREE, not what is
// installed. Capacity is not a budget — on one card running chat and image
// generation, the memory another process holds is invisible to `memory.total`,
// and a plan built from capacity walks into it.
describe('the budget is bound by free VRAM when the probe can read it', () => {
  const base = { modelSizeMB: 6000, profile: 'balanced' as const, gpuBuildInstalled: true }

  it('a card with plenty installed but little free stops offloading everything', () => {
    // 24 GB card, 5 GB actually free: capacity says "full offload", free says no.
    const full = planGpuLayers({ ...base, vramMB: 24_576 })
    expect(full.nGpuLayers).toBe(ALL_LAYERS)

    const busy = planGpuLayers({ ...base, vramMB: 24_576, vramFreeMB: 5_000 })
    expect(busy.nGpuLayers).toBeLessThan(ALL_LAYERS)
    expect(busy.reason).toMatch(/free/i)
  })

  it('names which number bound the plan', () => {
    const busy = planGpuLayers({ ...base, vramMB: 24_576, vramFreeMB: 5_000 })
    // A surprisingly small offload has to be explainable without a debugger.
    expect(busy.reason).toMatch(/not ~24GB total/)
  })

  it('an UNREADABLE free figure changes nothing — unknown is not "all of it"', () => {
    const withoutField = planGpuLayers({ ...base, vramMB: 12_288 })
    for (const bad of [undefined, Number.NaN, -1]) {
      const withBad = planGpuLayers({ ...base, vramMB: 12_288, vramFreeMB: bad as number })
      expect(withBad).toEqual(withoutField)
    }
  })

  it('free ABOVE the profile slice does not raise the budget', () => {
    // The profile fraction still applies — free memory can only bind tighter,
    // never loosen. Otherwise 'speed' would silently become 'quality' on an
    // idle card.
    const idle = planGpuLayers({ ...base, vramMB: 12_288, vramFreeMB: 12_288, profile: 'speed' })
    const noFree = planGpuLayers({ ...base, vramMB: 12_288, profile: 'speed' })
    expect(idle.nGpuLayers).toBe(noFree.nGpuLayers)
  })
})

describe('a sliver of a model on the GPU is a loss, not a small win', () => {
  it('falls back to CPU rather than offloading one or two layers', () => {
    // Every token would pay a PCIe round trip to run a fraction of the model on
    // the GPU while the rest waits on the CPU. The old code guaranteed at least
    // one layer whenever ANY budget existed, including the near-zero budget a
    // busy card leaves.
    const plan = planGpuLayers({
      modelSizeMB: 40_000, vramMB: 12_288, vramFreeMB: 1_600,
      profile: 'balanced', gpuBuildInstalled: true,
    })
    expect(plan.nGpuLayers).toBe(0)
    expect(plan.usesGpu).toBe(false)
    expect(plan.reason).toMatch(/CPU/)
  })

  it('still offloads when the share is worth the transfer', () => {
    const plan = planGpuLayers({
      modelSizeMB: 20_000, vramMB: 12_288,
      profile: 'balanced', gpuBuildInstalled: true,
    })
    expect(plan.nGpuLayers).toBeGreaterThanOrEqual(3)
    expect(plan.usesGpu).toBe(true)
  })
})

describe('the layer count comes from the model, not from a nominal figure', () => {
  const busy = {
    modelSizeMB: 20_000, vramMB: 12_288, profile: 'balanced' as const, gpuBuildInstalled: true,
  }

  it('a real block count changes the plan', () => {
    // The owner's first model reports 35 blocks. The nominal 40 asks for
    // eight-sevenths of the layers the budget was computed for; llama-server
    // clamps an over-count but nothing rescues an over-ASK against a budget.
    const nominal = planGpuLayers(busy)
    const real = planGpuLayers({ ...busy, layerCount: 35 })
    expect(real.nGpuLayers).toBeLessThan(nominal.nGpuLayers)
  })

  it('a nonsense count is ignored rather than trusted', () => {
    const nominal = planGpuLayers(busy)
    for (const bad of [0, -5, 4000, Number.NaN, undefined]) {
      expect(planGpuLayers({ ...busy, layerCount: bad as number }).nGpuLayers).toBe(nominal.nGpuLayers)
    }
  })

  it('full offload does not care about the count — it is all of them either way', () => {
    const roomy = { modelSizeMB: 2_000, vramMB: 24_576, profile: 'quality' as const, gpuBuildInstalled: true }
    expect(planGpuLayers(roomy).nGpuLayers).toBe(planGpuLayers({ ...roomy, layerCount: 35 }).nGpuLayers)
  })
})

// ── THE KV CACHE, WHICH THE PLAN USED TO IGNORE ──────────────────────────────
//
// The only allowance was a flat 1200 MB, so a 4K run and a 128K run of the same
// file got the same layer count. The cache is the one thing in VRAM that grows
// with context while the weights do not.
//
// The fixture is the owner's real model, read from its own header on
// 2026-08-03 and confirmed against raw bytes:
//   blocks 35 · kv heads 1 (GQA 8:1) · key_length 512 · value_length 512
// At its DECLARED 131,072-token context that is 8.75 GB of cache on a 12 GB
// card — the flat allowance was short by seven and a half gigabytes.
const GEMMA4 = { layerCount: 35, kvHeads: 1, keyDim: 512, valueDim: 512 }

describe('kvCacheMB', () => {
  it('sizes the owner\'s model at its declared context', () => {
    // 131072 × 35 × 1 × (512×2 + 512×2) bytes = 8.75 GiB.
    const mb = kvCacheMB({ ...GEMMA4, modelSizeMB: 3000, contextTokens: 131_072 })
    expect(mb).toBeCloseTo(8960, 0)
  })

  it('scales linearly with context — the whole reason it is an input', () => {
    const at8k  = kvCacheMB({ ...GEMMA4, modelSizeMB: 3000, contextTokens: 8_192 })!
    const at16k = kvCacheMB({ ...GEMMA4, modelSizeMB: 3000, contextTokens: 16_384 })!
    expect(at16k / at8k).toBeCloseTo(2, 5)
  })

  it('q8_0 shrinks the KEY half only, and by 34/32 not by 1/2', () => {
    const base = { ...GEMMA4, modelSizeMB: 3000, contextTokens: 131_072 }
    const f16  = kvCacheMB({ ...base, kvCacheType: 'f16' })!
    const q8   = kvCacheMB({ ...base, kvCacheType: 'q8_0' })!
    // V stays at two bytes (we never pass --cache-type-v), so the whole cache
    // shrinks by less than half even though the keys nearly halve.
    expect(q8 / f16).toBeCloseTo((34 / 32 + 2) / 4, 5)
    // And the block overhead is counted: taking "8 bits" at face value gives
    // (1 + 2)/4 of f16, which under-reserves. The real figure must exceed it.
    expect(q8).toBeGreaterThan(f16 * 0.75)
  })

  it('q4_0 is 18/32 per key element, not 0.5', () => {
    const base = { ...GEMMA4, modelSizeMB: 3000, contextTokens: 131_072 }
    const q4 = kvCacheMB({ ...base, kvCacheType: 'q4_0' })!
    const f16 = kvCacheMB({ ...base, kvCacheType: 'f16' })!
    expect(q4 / f16).toBeCloseTo((18 / 32 + 2) / 4, 5)
  })

  it('every term or nothing — three facts and a guess is not a measurement', () => {
    const full = { ...GEMMA4, modelSizeMB: 3000, contextTokens: 8_192 }
    expect(kvCacheMB(full)).not.toBeNull()
    for (const missing of ['layerCount', 'kvHeads', 'keyDim', 'contextTokens'] as const) {
      expect(kvCacheMB({ ...full, [missing]: undefined }), missing).toBeNull()
    }
  })

  it('a stated value dim that differs from the key dim is honoured', () => {
    const a = kvCacheMB({ ...GEMMA4, modelSizeMB: 3000, contextTokens: 8_192 })!
    const b = kvCacheMB({ ...GEMMA4, valueDim: 256, modelSizeMB: 3000, contextTokens: 8_192 })!
    expect(b).toBeLessThan(a)
  })
})

describe('the plan reserves the cache it is about to need', () => {
  const card = { vramMB: 12_288, profile: 'balanced' as const, gpuBuildInstalled: true, ...GEMMA4 }

  it('a long context turns a full offload into a partial one', () => {
    // Same 3 GB model, same card. The only difference is the context.
    const short = planGpuLayers({ ...card, modelSizeMB: 3_000, contextTokens: 4_096 })
    const long  = planGpuLayers({ ...card, modelSizeMB: 3_000, contextTokens: 131_072 })
    expect(short.nGpuLayers).toBe(ALL_LAYERS)
    // THE PIN: this was ALL_LAYERS too, planning a full offload with 8.75 GB of
    // cache still to allocate on a 12 GB card.
    expect(long.nGpuLayers).toBeLessThan(ALL_LAYERS)
  })

  it('names the cache in the reason when it is the surprise', () => {
    const long = planGpuLayers({ ...card, modelSizeMB: 3_000, contextTokens: 131_072 })
    expect(long.reason).toMatch(/KV cache/)
    expect(long.reason).toMatch(/131,072-token/)
  })

  it('a quantised K cache buys back layers', () => {
    // 96K on this model: 6.6 GB of f16 cache leaves too little for the 3 GB of
    // weights, 4.2 GB at q4_0 leaves enough. The setting earns its place here —
    // it is the difference between a partial offload and a full one.
    const f16 = planGpuLayers({ ...card, modelSizeMB: 3_000, contextTokens: 98_304, kvCacheType: 'f16' })
    const q4  = planGpuLayers({ ...card, modelSizeMB: 3_000, contextTokens: 98_304, kvCacheType: 'q4_0' })
    expect(f16.nGpuLayers).toBeLessThan(ALL_LAYERS)
    expect(q4.nGpuLayers).toBe(ALL_LAYERS)
    expect(q4.reason).toMatch(/at q4_0/)
  })

  it('a model that says nothing about itself plans exactly as before', () => {
    // The whole safety property: this can improve a plan or leave it alone, and
    // it must never be a new way to get a worse one.
    const bare = { vramMB: 12_288, modelSizeMB: 6_000, profile: 'balanced' as const, gpuBuildInstalled: true }
    expect(planGpuLayers({ ...bare, contextTokens: 131_072 })).toEqual(planGpuLayers(bare))
  })
})

// ── THE CONTEXT AND THE LAYERS COMPETE, SO THEY ARE CHOSEN TOGETHER ─────────
//
// Found by an adversarial review of the reservation itself (2026-08-03). Six
// curated rows declare a 128k context, and `resolveLlamaContextSize` starts the
// server at a row's native context whenever the caller names none. Measured on
// a 12 GB card with the owner's own model geometry:
//
//     4k ctx →   280 MB cache → 8350 MB for weights → full offload
//    32k ctx →  2240 MB cache → 6390 MB for weights → full offload
//   128k ctx →  8960 MB cache →    0 MB for weights → CPU
//
// So counting the cache honestly — which is right — dropped a 3 GB model that
// offloaded entirely down to the CPU. Both prior answers were wrong: ignore the
// cache and llama.cpp allocates 8.9 GB nobody budgeted; count it and abandon the
// GPU over a context length the user never asked for. Serve a smaller context.
describe('planServe — trims the context rather than abandoning the GPU', () => {
  const card = {
    vramMB: 12_288, modelSizeMB: 3_000, profile: 'balanced' as const, gpuBuildInstalled: true,
    layerCount: 35, kvHeads: 1, keyDim: 512, valueDim: 512,
  }

  it('THE PIN: a 128k default no longer means CPU', () => {
    const bare = planGpuLayers({ ...card, contextTokens: 131_072 })
    expect(bare.usesGpu, 'the plan this replaced ran on the CPU').toBe(false)

    const served = planServe(card, { requestedTokens: 131_072 })
    expect(served.plan.usesGpu).toBe(true)
    expect(served.contextTokens).toBeLessThan(131_072)
    expect(served.contextReducedFrom).toBe(131_072)
    // …and it says so, because a context the user did not choose being changed
    // silently is how the next person loses an afternoon.
    expect(served.plan.reason).toMatch(/context trimmed to/)
  })

  it('trims no further than it must — halving stops at the FIRST fit', () => {
    const served = planServe(card, { requestedTokens: 131_072 })
    // One halving is enough and the loop must not take a second: at 64k the
    // cache is 65 536 × 35 × 1 × 2048 B = 4480 MB, leaving 9830 − 1200 − 4480 =
    // 4150 MB against a 3000 MB model. (I first wrote 32 768 here from a
    // hand-wave; the code was right and the guess was not.)
    expect(served.contextTokens).toBe(65_536)
  })

  it('leaves a context that already fits completely alone', () => {
    const served = planServe(card, { requestedTokens: 8_192 })
    expect(served.contextTokens).toBe(8_192)
    expect(served.contextReducedFrom).toBeUndefined()
    expect(served.plan.reason).not.toMatch(/trimmed/)
  })

  it('NEVER trims a context the caller asked for by name', () => {
    // A number somebody typed is a decision. Winning back speed they did not
    // ask for by quietly shortening it reads as a bug, so the layer count
    // absorbs the cost instead.
    const served = planServe(card, { requestedTokens: 131_072, contextIsExplicit: true })
    expect(served.contextTokens).toBe(131_072)
    expect(served.contextReducedFrom).toBeUndefined()
    expect(served.plan.usesGpu).toBe(false)
  })

  it('stops at the floor and reports the ORIGINAL request when trimming cannot help', () => {
    // The model has to be big enough that even the 4k floor cannot buy the
    // three-layer minimum: at 4k the cache is 280 MB, leaving 8350 MB, and
    // 3/35 of a model must exceed that — so ~97 GB is the threshold and 40 GB
    // (my first guess) still earns a 3-layer partial offload. Measured, not
    // assumed, which is the entire point of this file.
    const served = planServe({ ...card, modelSizeMB: 200_000 }, { requestedTokens: 131_072 })
    expect(served.contextTokens).toBe(131_072)
    expect(served.contextReducedFrom).toBeUndefined()
    expect(served.plan.usesGpu).toBe(false)
    expect(served.contextTokens).toBeGreaterThan(MIN_SERVE_CONTEXT_TOKENS)
  })

  it('does not negotiate when there is no GPU to keep', () => {
    const cpuOnly = planServe({ ...card, gpuBuildInstalled: false }, { requestedTokens: 131_072 })
    expect(cpuOnly.contextTokens).toBe(131_072)
    expect(cpuOnly.contextReducedFrom).toBeUndefined()
  })

  it('a model that says nothing about itself is planned exactly as before', () => {
    const bare = { vramMB: 12_288, modelSizeMB: 6_000, profile: 'balanced' as const, gpuBuildInstalled: true }
    const served = planServe(bare, { requestedTokens: 131_072 })
    expect(served.plan).toEqual(planGpuLayers({ ...bare, contextTokens: 131_072 }))
    expect(served.contextReducedFrom).toBeUndefined()
  })
})
