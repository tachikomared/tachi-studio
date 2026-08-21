// packages/core/src/catalog/types.ts
//
// Shared, runtime-agnostic catalog domain. Pure types only — no I/O.
// `kind` is carried from day one so a Phase-2 speech source slots in
// without reshaping the catalog.

export type RuntimeId = 'ollama' | 'llamacpp' | 'sdcpp' | 'piper' | 'whisper'
export type ModelKind = 'text' | 'speech'
export type FitVerdict = 'gpu' | 'cpu' | 'tight' | 'too-big'

/** What a model can do, for capability badges/filters. 'chat' is the text baseline.
 *  Media modalities let the catalog tag + filter image/video/audio generators too. */
export type Capability =
  | 'chat' | 'reasoning' | 'vision' | 'code' | 'tools'    // text-model capabilities
  | 'image-gen' | 'video-gen' | 'music' | 'tts' | 'stt'   // media modalities

export interface HardwareGpu {
  model: string
  vendor: string
  vramBytes: number | null
}

export interface HardwareProfile {
  platform: string
  arch: string
  ramTotalBytes: number
  ramFreeBytes: number
  cpuCores: number
  gpus: HardwareGpu[]
  /** Best-effort free VRAM across detected GPUs; null if undetectable. */
  vramFreeBytes: number | null
  isAppleSilicon: boolean
}

export interface QuantOption {
  /** Quant label, e.g. "Q4_K_M". */
  label: string
  sizeBytes: number
  runtime: RuntimeId
  /**
   * Runtime-specific download/run handle:
   *   llamacpp → curated GGUF registry id OR HuggingFace resolve URL
   *   ollama   → ollama tag, e.g. "qwen2.5:7b"
   */
  ref: string
  /**
   * Direct download source for llama.cpp (HF resolve URL). Present when the
   * quant is a single GGUF file fetched straight into llama.cpp; absent for
   * curated registry ids and Ollama tags.
   */
  url?: string
  /** Marks the suggested default quant (best size/quality tradeoff). */
  recommended?: boolean
}

export interface CatalogEntry {
  id: string
  name: string
  family: string
  /** Display param size, e.g. "7B". */
  params: string
  kind: ModelKind
  /**
   * Where the row came from. 'civitai' rows are built in the renderer from a
   * CivitaiSearchRow (main owns that shape) — they are weights, not an
   * inference provider, and they carry `quants[0].runtime === 'sdcpp'`.
   */
  source: 'curated' | 'hf' | 'civitai'
  quants: QuantOption[]
  /** Derived/curated capability tags for badges + filtering. */
  capabilities: Capability[]
  /**
   * Popularity signals. Present on HuggingFace and Civitai rows; absent on
   * curated ones. Read these fields to decide whether to render the ↓/♥ line —
   * NOT the `source`, which is how the Civitai tab silently lost its counts.
   */
  downloads?: number
  likes?: number
}

export interface InstalledModel {
  runtime: RuntimeId
  ref: string
  name: string
  /**
   * REAL disk usage attributable to this row, counted ONCE across the whole
   * installed list.
   *
   * Single-file runtimes (llama.cpp / piper / whisper / Ollama) have nothing to
   * share, so this is simply the file size. A multi-file sd.cpp row is
   * different: its components are hard-linked between rows on purpose (the
   * 5.6 GB umt5 encoder is ONE file with three names), and charging every row
   * for the same bytes would invent tens of gigabytes that are not on the disk.
   * Each physical file is therefore charged to the first row that holds it and
   * to no other, so summing this field over the list gives the true total.
   * `sharedWith` is what tells a row why it reads smaller than its download size.
   */
  sizeBytes: number
  /**
   * What REMOVE would actually free — components this row holds the ONLY name
   * for. Absent on single-file runtimes (there, removing frees `sizeBytes`).
   * Deliberately smaller than `sizeBytes` for a row that anchors shared bytes:
   * deleting one name for a hard-linked file frees nothing at all.
   */
  freeableBytes?: number
  /** Display names of the other installed rows that hold components in common
   *  with this one. Absent when nothing is shared. */
  sharedWith?: string[]
  /**
   * The Media-studio modality a LOCAL media row runs in — what the one-verb RUN
   * button selects before it opens the Media tab. Absent on text/STT rows,
   * which do not run there at all.
   */
  mediaKind?: 'image' | 'video' | 'tts'
}

export interface FitResult {
  verdict: FitVerdict
  /** Suggested llama.cpp --n-gpu-layers; null when not applicable. */
  suggestedGpuLayers: number | null
}
