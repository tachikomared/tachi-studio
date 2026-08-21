// apps/desktop/electron/ipc/llama-cpp.ipc.ts
//
// Plain ipcMain.handle wiring for the llama.cpp sidecar.
// Mirrors the style of freellmapi.ipc.ts — no typed router, direct
// invocations against the installer + client services.

import { ipcMain, type BrowserWindow } from 'electron'
import {
  installLlamaCppBinary,
  downloadGgufModel,
  downloadGgufFromUrl,
  cancelGgufDownload,
  removeGgufModel,
  isLlamaCppInstalled,
  isGgufModelDownloaded,
  listDownloadedModels,
} from '../services/llama-cpp-installer'
import {
  startLlamaCpp,
  stopLlamaCpp,
  getLlamaCppStatus,
  getLlamaCppLogs,
  isLlamaCacheType,
  type LlamaCacheType,
  type StartLlamaCppOptions,
} from '../services/llama-cpp-client'
import {
  GGUF_MODELS,
  LLAMA_CPP_RELEASES,
  LLAMA_CPP_VERSION,
  defaultReleaseAsset,
  releaseIdForBackend,
  getUnsupportedPlatformMessage,
  annotateGgufFit,
} from '../services/llama-cpp-models'
import { detectHardware } from '../services/hardware-info'
import { detectGpu, isGpuBuildInstalled } from '../services/gpu-detect'
import { getGgufModel } from '../services/llama-cpp-models'
import { ggufModelPath } from '../services/llama-cpp-installer'
import { readGgufHeader } from '../services/util/gguf-header'
import { planServe, type ServeProfile } from '@tachi/core'
import { loadSettings } from '../services/settings-store'
import { resolveLlamaContextSize } from '../services/llama-cpp-client'
import type { GgufHeaderFacts } from '../services/util/gguf-header'

/**
 * Per-head key/value dimensions for the KV-cache reservation, or null.
 *
 * `key_length` when the file states it — DeepSeek's MLA and friends carry dims
 * that are not the usual quotient, and those are precisely the models whose
 * caches are unusual. Otherwise embedding_length / head_count, which is the
 * standard relation and only used when both are present and it divides
 * cleanly: a fractional head dimension means one of the two numbers was
 * misread, and a misread must not become a reservation.
 */
function kvDimsFromHeader(h: GgufHeaderFacts): { keyDim: number; valueDim: number } | null {
  if (h.keyLength !== undefined) {
    return { keyDim: h.keyLength, valueDim: h.valueLength ?? h.keyLength }
  }
  if (h.embeddingLength === undefined || h.headCount === undefined || h.headCount <= 0) return null
  const dim = h.embeddingLength / h.headCount
  if (!Number.isInteger(dim) || dim <= 0) return null
  return { keyDim: dim, valueDim: dim }
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerLlamaCppIpc(mainWindow: BrowserWindow | null): void {
  /**
   * llama-cpp:catalog
   *
   * One-shot read of static catalog data: which release variants exist,
   * which curated GGUF models are on offer, and which release is the
   * recommended default for this platform.
   */
  ipcMain.handle('llama-cpp:catalog', async () => {
    // Annotate each curated GGUF with a VRAM-aware fit verdict for the detected
    // hardware so the renderer can show a "will it fit" badge. Best-effort: if
    // the hardware probe fails, fall back to the un-annotated registry.
    let models: unknown = GGUF_MODELS
    try {
      const hw = await detectHardware()
      models = annotateGgufFit(hw)
    } catch {
      models = GGUF_MODELS
    }
    // GPU-truth (STEAL 2026-07-08): recommend the GPU build when a discrete GPU
    // is present, instead of always defaulting to CPU. The UI pre-selects
    // recommendedReleaseId so an RTX owner doesn't silently install the CPU build.
    let recommendedReleaseId = defaultReleaseAsset()?.id ?? null
    let gpuNote: string | null = null
    try {
      const gpu = await detectGpu()
      // 3-way selection (BATCH D / R12). The old code special-cased CUDA only,
      // so gpu-detect's `vulkan` verdict — which is what EVERY AMD, Intel and
      // iGPU resolves to — fell through to the CPU build. Now one pure map
      // (releaseIdForBackend) owns the whole decision.
      const wanted = releaseIdForBackend(gpu.backend)
      const asset = wanted
        ? LLAMA_CPP_RELEASES.find(r => r.platform === process.platform && r.id === wanted)
        : undefined
      if (asset && gpu.backend !== 'cpu') {
        recommendedReleaseId = asset.id
        // Names the build that is actually being recommended — the previous
        // string said "CUDA" unconditionally because CUDA was the only branch.
        gpuNote = `${gpu.name} detected — the ${gpuBuildName(asset.id)} build will use your GPU.`
      }
    } catch { /* keep the CPU default */ }
    return {
      version:                  LLAMA_CPP_VERSION,
      platform:                 process.platform,
      arch:                     process.arch,
      releases:                 LLAMA_CPP_RELEASES.filter(r => r.platform === process.platform),
      defaultReleaseId:         defaultReleaseAsset()?.id ?? null,
      recommendedReleaseId,
      gpuNote,
      unsupportedReason:        defaultReleaseAsset() === null ? getUnsupportedPlatformMessage() : null,
      models,
    }
  })

  /** llama-cpp:status — current sidecar state + installed/downloaded flags. */
  ipcMain.handle('llama-cpp:status', () => {
    return {
      ...getLlamaCppStatus(),
      installed:        isLlamaCppInstalled(),
      downloadedModels: listDownloadedModels(),
    }
  })

  /** llama-cpp:install — download + verify + extract platform binary. */
  ipcMain.handle('llama-cpp:install', async (_event, payload: unknown) => {
    const { assetId } = (payload as { assetId?: string } | null | undefined) ?? {}
    try {
      await installLlamaCppBinary(mainWindow, assetId)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** llama-cpp:download-model — fetch a curated GGUF by registry id. */
  ipcMain.handle('llama-cpp:download-model', async (_event, payload: unknown) => {
    const { modelId } = (payload as { modelId?: string } | null | undefined) ?? {}
    if (!modelId) return { ok: false as const, error: 'modelId is required' }
    try {
      await downloadGgufModel(mainWindow, modelId)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * llama-cpp:download-url — fetch an arbitrary GGUF by URL. Gated (audit S3):
   * the installer requires an allowlisted host (huggingface.co) OR a sha256
   * to verify against; an untrusted host without a checksum is refused.
   */
  ipcMain.handle('llama-cpp:download-url', async (_event, payload: unknown) => {
    const { id, url, sha256 } = (payload as { id?: string; url?: string; sha256?: string } | null | undefined) ?? {}
    if (!id || !url) return { ok: false as const, error: 'id and url are required' }
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      return { ok: false as const, error: 'url must be an https:// URL' }
    }
    try {
      await downloadGgufFromUrl(mainWindow, id, url, typeof sha256 === 'string' ? sha256 : undefined)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * llama-cpp:cancel-download — STOP an in-flight model download by id.
   * Now pause-semantics via the central download manager: the partial file +
   * offset are kept, and the DOWNLOADS strip (bottom bar) offers RESUME.
   */
  ipcMain.handle('llama-cpp:cancel-download', (_event, payload: unknown) => {
    const { id } = (payload as { id?: string } | null | undefined) ?? {}
    if (!id) return { ok: false as const, error: 'id is required' }
    return { ok: true as const, cancelled: cancelGgufDownload(id) }
  })

  /** llama-cpp:remove-model — delete a downloaded GGUF file. */
  ipcMain.handle('llama-cpp:remove-model', (_event, payload: unknown) => {
    const { modelId } = (payload as { modelId?: string } | null | undefined) ?? {}
    if (!modelId) return { ok: false as const, error: 'modelId is required' }
    return removeGgufModel(modelId)
  })

  /** llama-cpp:start — spawn llama-server for the chosen GGUF. */
  ipcMain.handle('llama-cpp:start', async (_event, payload: unknown) => {
    const p = (payload as Partial<StartLlamaCppOptions> | null | undefined) ?? {}
    if (!p.modelId || typeof p.modelId !== 'string') {
      return { ok: false as const, error: 'modelId is required' }
    }
    if (!isGgufModelDownloaded(p.modelId)) {
      return { ok: false as const, error: `Model "${p.modelId}" is not downloaded.` }
    }
    // The numeric tuning knobs end up as llama-server CLI args — coerce to
    // bounded integers (or drop) so a type-confused payload can't smuggle
    // arbitrary strings into the spawn argv.
    const num = (v: unknown, min: number): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= min ? Math.floor(v) : undefined

    // KV-cache precision: the caller's explicit value, else the user's stored
    // preference, else nothing (llama.cpp keeps its own default). Re-validated
    // on the way out of settings because a hand-edited tachi-settings.json
    // never passed through the write-side schema.
    //
    // Resolved BEFORE the offload plan, because the plan has to reserve VRAM
    // for the cache and the choice changes how big that cache is.
    const explicitCache = (p as { cacheType?: unknown }).cacheType
    let cacheType: LlamaCacheType | undefined = isLlamaCacheType(explicitCache) ? explicitCache : undefined
    if (!cacheType) {
      try {
        const stored = loadSettings().llamaKvCache
        if (isLlamaCacheType(stored)) cacheType = stored
      } catch { /* unreadable settings → the build's own default */ }
    }

    // GPU-truth (STEAL 2026-07-08): if the caller didn't pin nGpuLayers, DON'T
    // default to 0 (CPU) as before — plan the offload from the detected GPU +
    // model size + serve profile, so GPU owners actually use their card. An
    // explicit nGpuLayers from the caller still wins.
    let nGpuLayers = num(p.nGpuLayers, 0)
    let offloadReason = 'explicit nGpuLayers from caller'
    /** Set only when the planner chose a context; undefined leaves the client's own default. */
    let servedContext: number | undefined
    if (nGpuLayers === undefined) {
      const profileRaw = (p as { profile?: unknown }).profile
      const profile: ServeProfile = profileRaw === 'quality' || profileRaw === 'speed' ? profileRaw : 'balanced'
      try {
        const gpu = await detectGpu()
        const model = getGgufModel(p.modelId)
        // The model's own header beats every constant we could pick. ~1 ms for
        // a bounded read, and it returns nothing rather than throwing on any
        // file it cannot make sense of.
        const header = readGgufHeader(ggufModelPath(p.modelId))
        // planServe, not planGpuLayers: the context and the layer count compete
        // for the same VRAM, so they are chosen together. An explicit
        // contextSize from the caller is honoured as-is; a row's native default
        // may be trimmed to keep the model on the GPU. See planServe.
        const requestedCtx = resolveLlamaContextSize(p.modelId, num(p.contextSize, 256))
        const served = planServe({
          vramMB: gpu.vramMB,
          // Optional and probe-dependent: only nvidia-smi can see what other
          // processes hold. Absent means the planner falls back to the
          // capacity-based budget it has always used.
          ...(typeof gpu.vramFreeMB === 'number' ? { vramFreeMB: gpu.vramFreeMB } : {}),
          ...(header.blockCount !== undefined ? { layerCount: header.blockCount } : {}),
          modelSizeMB: model?.sizeMb ?? 0,
          profile,
          gpuBuildInstalled: isGpuBuildInstalled(),
          // THE KV CACHE, WHICH THIS PLAN USED TO IGNORE. A 4K run and a 128K
          // run of the same file got the same layer count, because the only
          // allowance was a flat 1200 MB — and the cache is the one thing in
          // VRAM that grows with context while the weights do not.
          //
          // The context comes from the SAME function the spawn uses, so the
          // reservation cannot be sized against a different number than the
          // server is given. The dims come from the file: `key_length` when it
          // states one, else embedding_length / head_count. Any missing piece
          // and the planner reserves nothing extra, exactly as before.
          ...(header.headCountKv !== undefined ? { kvHeads: header.headCountKv } : {}),
          ...(kvDimsFromHeader(header) ?? {}),
          ...(cacheType ? { kvCacheType: cacheType } : {}),
        }, {
          requestedTokens: requestedCtx,
          contextIsExplicit: num(p.contextSize, 256) !== undefined,
        })
        nGpuLayers = served.plan.nGpuLayers
        offloadReason = served.plan.reason
        // The server must be started at the context the plan was made for, or
        // the reservation is about a different run than the one that happens.
        servedContext = served.contextTokens
      } catch (e) {
        nGpuLayers = 0
        offloadReason = `GPU probe failed → CPU (${(e as Error).message})`
      }
    }
    console.log(`[llama-cpp] start ${p.modelId}: --n-gpu-layers ${nGpuLayers} — ${offloadReason}${cacheType && cacheType !== 'f16' ? ` — KV cache ${cacheType}` : ''}`)

    try {
      await startLlamaCpp({
        modelId:     p.modelId,
        contextSize: servedContext ?? num(p.contextSize, 256),
        nGpuLayers,
        threads:     num(p.threads, 1),
        // Validated against the closed set, never forwarded raw: this reaches
        // the spawn argv, and the same coercion rule as every other knob here.
        //
        // THE SETTING IS READ HERE, not at the four call sites. `start` is
        // invoked from the catalog page, the status row, the chat model picker
        // and the compare panel picker; a preference threaded through all four
        // is a preference three of them will eventually forget. One owner, and
        // an explicit cacheType from a caller still wins.
        ...(cacheType ? { cacheType } : {}),
      })
      return { ok: true as const, status: getLlamaCppStatus(), offload: { nGpuLayers, reason: offloadReason } }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** llama-cpp:gpu — detected GPU + whether a GPU build is installed (for UI/Doctor). */
  ipcMain.handle('llama-cpp:gpu', async () => {
    const gpu = await detectGpu()
    return { ...gpu, gpuBuildInstalled: isGpuBuildInstalled() }
  })

  /** llama-cpp:stop — kill the llama-server process. */
  ipcMain.handle('llama-cpp:stop', () => {
    stopLlamaCpp()
    return { ok: true as const, status: getLlamaCppStatus() }
  })

  /** llama-cpp:logs — tail of stderr/stdout for diagnostics. */
  ipcMain.handle('llama-cpp:logs', (_event, payload: unknown) => {
    const { lines } = (payload as { lines?: number } | null | undefined) ?? {}
    return { lines: getLlamaCppLogs(lines) }
  })
}

/** Short human name for a release id, used in the GPU-detected note. */
function gpuBuildName(id: string): string {
  switch (id) {
    case 'win-cuda':    return 'CUDA'
    case 'win-vulkan':  return 'Vulkan'
    case 'win-hip':     return 'ROCm/HIP'
    case 'macos-arm64': return 'Metal'
    default:            return 'CPU'
  }
}
