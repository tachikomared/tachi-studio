// apps/desktop/electron/services/surplus-media-service.ts
//
// Surplus Intelligence MEDIA engine (image / TTS / STT / video / music /
// embeddings). Surplus proxies Venice-backed media models behind an
// OpenAI-compatible surface at `…/api/inference/v1`. This service is the single
// foundation that Chat (Layer B) and the canvas nodes (Layer C) both call
// through IPC (electron/ipc/surplus-media.ipc.ts).
//
// Auth: `Authorization: Bearer <inf_*>` via retrieveKey('surplus') — the SAME
// key as the text provider. Egress is gated by egress-policy.ts: 'surplus' is
// classified cloud, so PRIVATE MODE blocks all media here (media is cloud-only).
//
// Modality matrix (all endpoints relative to SURPLUS_BASE_URL):
//   image  POST /images/generations         sync  → JSON { data:[{b64_json?|url?}] }
//   tts    POST /audio/speech               sync  → RAW BINARY audio bytes
//   stt    POST /audio/transcriptions       sync  → MULTIPART upload → { text }
//   video  POST /video/generations          async → submit → poll → artifacts
//   music  POST /music/generations          async → submit → poll → artifacts
//   embed  POST /embeddings                 sync  → { data:[{embedding:[]}] }
//   poll   GET  /video|music/generations/{id}      (same path + /{id})
//   art    GET  /media/artifacts/{jobId}/{index}   (binary OR 302 → signed URL)
//
// DEFENSIVE NOTES (success bodies for several routes are OpenAI/Venice
// conventions, not officially documented): read id||jobId, handle artifact
// binary OR 302 redirect, parse status enum leniently, tolerate missing fields,
// and always send `Accept-Encoding: identity` (gateway quirk).

import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'fs'
import { retrieveKey } from './keychain'
import { enforceProviderEgress } from './egress-policy'
import { storageDir, writeStorageFile } from './storage-root'
// The LOCAL registries. Used ONLY to narrow the composer schema when the picked
// model is one of ours — see localVideoOptionsFor / localImageOptionsFor below.
// `allSdModels()` is curated ∪ user-installed, so a Civitai checkpoint is
// narrowed by its DECLARED family exactly like a shipped row.
import { SD_VIDEO_MODELS, allSdModels, findSdRow, isDistilledRow, SD_SAMPLING_METHODS, DEFAULT_VIDEO_FPS, DEFAULT_VIDEO_PIXEL_GRID, DEFAULT_VIDEO_FRAME_GRID, blockedSpeedAdapterFor } from './sd-cpp-models'
// The SPEED PACK's install state — a DISK fact, so it comes from the installer
// (the registry only knows the pack exists). Soft-failing by construction:
// installedSpeedAdapter returns undefined when nothing is on disk, which is the
// same answer as "no pack for this row", and the schema simply omits the toggle.
import { installedSpeedAdapter, installedIpAdapterForFamily } from './sd-cpp-installer'
// The BOUNDS of the two capability flags on the local image route. Imported
// rather than restated because sd-cpp-client's arg builder clamps against these
// exact numbers — a max spelled once here and once there is a control that
// promises 8 images and gets 4 (the precedent for a main service reading this
// pure module is sd-cpp-client itself, for promptWithLoraTags).
import {
  SD_BATCH_MAX, SD_HIRES_SCALE_MIN, SD_HIRES_SCALE_MAX, SD_HIRES_SCALE_STEP, SD_HIRES_SCALE_DEFAULT,
  SD_IMG2IMG_STRENGTH_DEFAULT, SD_CLIP_SKIP_MAX, SD_MAX_VRAM_AUTO, SD_MAX_VRAM_OPTIONS,
  SD_IP_ADAPTER_STRENGTH_MIN, SD_IP_ADAPTER_STRENGTH_MAX, SD_IP_ADAPTER_STRENGTH_STEP,
  SD_IP_ADAPTER_STRENGTH_DEFAULT,
} from '../../src/pages/media/localGenParams'

const SURPLUS_BASE_URL = 'https://www.surplusintelligence.ai/api/inference/v1'
// Venice direct media (privacy-first, OpenAI-compatible image gen). Same response
// shape as Surplus's /images/generations. Surplus already PROXIES Venice media
// models; this lets a user generate directly on their OWN Venice key instead.
const VENICE_MEDIA_BASE = 'https://api.venice.ai/api/v1'
const CATALOG_TTL_MS   = 60_000
const POLL_TIMEOUT_MS  = 5 * 60_000   // cap async polling at ~5 minutes
const POLL_INTERVAL_MS = 3_000

// ─── Types ──────────────────────────────────────────────────────────────────

/** The six media classes we expose (text = ordinary LLM, surfaced for filters). */
export type MediaModality = 'text' | 'image' | 'video' | 'music' | 'tts' | 'stt' | 'embedding'

export interface SurplusMediaModelInfo {
  id:        string
  label:     string
  modality:  MediaModality
  /** Optional family hint for grouping ("Flux", "Whisper", "Kokoro", …). */
  family?:   string
  /** Whether the model came from the live API (vs. id/pattern inference). */
  live:      boolean
  /**
   * The parameter names this specific model advertises, when the live catalog
   * exposes them (architecture.supported_parameters / top-level
   * supported_parameters). When present, modelParamSchema intersects the curated
   * per-modality schema with this list (only show params the model supports);
   * when absent, the full curated schema is returned. Always defensive.
   */
  supportedParameters?: string[]
}

export interface MediaModelsResult {
  ok:      boolean
  models:  SurplusMediaModelInfo[]
  stale?:  boolean
  error?:  string
}

// ─── Param schema (UI renders controls from data, not code) ───────────────────
//
// Each media model exposes a set of generation params. The UI renders ONE control
// per ParamSpec (string→text, int/number+min/max/step→slider/number, enum→dropdown,
// boolean→toggle, image/audio→upload). Adding a param to a modality is a DATA edit
// here, not a UI code change. modelParamSchema(modality, modelId) returns the list:
// a CURATED per-modality default schema, optionally intersected with the model's
// advertised supported_parameters when the live catalog exposes them.
//
// This is the leapfrog value-add: Venice's gateway hides negative_prompt / seed /
// steps / cfg / sampler / strength / init image, but the underlying models still
// accept them — so we surface them and send them defensively (only when set).

export type ParamKind = 'string' | 'text' | 'int' | 'number' | 'enum' | 'boolean' | 'image' | 'audio'

export interface ParamSpec {
  /** Request-body key sent to the engine (merged into params). */
  name:         string
  /** Human label rendered above the control. */
  label:        string
  /** Control kind the UI renders. */
  kind:         ParamKind
  /** Default value pre-filled in the control (control-specific type). */
  default?:     unknown
  /** Numeric min (int/number). */
  min?:         number
  /** Numeric max (int/number). */
  max?:         number
  /** Numeric step (int/number; sliders). */
  step?:        number
  /** Allowed values for an enum dropdown. */
  enum?:        string[]
  /** Short helper text under the control. */
  description?: string
  /** When true, the field must be filled before a run. */
  required?:    boolean
  /** When true, hide behind an "Advanced" disclosure by default. */
  advanced?:    boolean
  /**
   * `duration` only: the frame rate the seconds on this slider MEAN.
   *
   * The composer's length control is SECONDS and the engine's is FRAMES, and the
   * rate between them is a property of the CHECKPOINT — Wan 2.1 generates at 16
   * fps, Wan 2.2 TI2V-5B at 24. It rides on the spec rather than on a widened
   * IPC payload because both local surfaces already hand this exact spec to
   * resolveLocalWanFrames as its bound, so one field reaches both of them and
   * neither call site has to learn that there is more than one answer.
   *
   * Never set on a CLOUD schema, where `duration` is a wire value and no frame
   * count is derived from it. Kept in lockstep with the renderer's ParamSpec in
   * src/types/electron.d.ts.
   */
  fps?:         number
  /**
   * `duration` only: the checkpoint's TEMPORAL grid — `--video-frames` must be
   * `frameGrid * n + 1`.
   *
   * Travels beside `fps` for exactly the same reason, and was added the day the
   * catalog stopped being all-Wan. Wan's VAE compresses the time axis 4x;
   * LTX-AV's compresses 8x, and the engine floors with integer division, so a
   * 45-frame request there renders 41 frames without a word. Both are facts of
   * the model, so both belong on the spec the composer already reads.
   *
   * Never set on a CLOUD schema. Absent ⇒ 4.
   */
  frameGrid?:   number
}

/**
 * A produced media artifact. Binary artifacts (image/audio/video) are written
 * to disk under <storage root>/Media/<jobId>/<index>.<ext> and surfaced via `path`.
 * Small images may ALSO carry inline `b64` for instant renderer preview. STT
 * results carry `text`.
 */
export interface Artifact {
  kind:      'image' | 'audio' | 'video' | 'text'
  mimeType:  string
  /** Absolute path on disk (binary artifacts). */
  path?:     string
  /** Inline base64 (no data: prefix) — small images only, for instant preview. */
  b64?:      string
  /** Text payload (STT transcripts). */
  text?:     string
  /** The seed the LOCAL engine actually rendered with (sd.cpp's own report),
   *  present only when it answered with a real one (never -1). A PNG also
   *  self-records it in its tachi-gen tEXt chunk, but a .webm has no such
   *  chunk — for canvas video this field is the ONLY provenance, and the
   *  gallery capture stamps it into the entry params so Remix can reproduce
   *  the clip (same rule as MediaPage's stampLocalSeed). */
  seed?:     number
}

export type MediaJobStatus = 'queued' | 'processing' | 'succeeded' | 'failed' | 'unknown'

export interface MediaJobResult {
  jobId:     string
  status:    MediaJobStatus
  /** 0..1 when the gateway reports it; omitted otherwise. */
  progress?: number
  artifacts?: Artifact[]
  error?:    string
}

/**
 * Arbitrary extra params merged into the request body. The schema-driven UI sends
 * the controls it rendered from modelParamSchema here (negative_prompt, seed, steps,
 * cfg, sampler, strength, image_url, aspect_ratio, …) WITHOUT per-param code. Only
 * keys with non-empty values are sent; `model` is NEVER overridden. The typed
 * fields (size/n/voice/duration/lyrics/…) still map through for back-compat.
 */
export type ExtraParams = Record<string, unknown>

export interface GenerateImageInput {
  model:        string
  prompt:       string
  size?:        string
  n?:           number
  /** Optional auto-save target dir; artifacts are copied here after generation. */
  autoSaveDir?: string
  /** Extra schema-driven params merged into the body (defensive). */
  params?:      ExtraParams
  /** Media provider. 'surplus' (default) routes via the marketplace; 'venice'
   *  hits api.venice.ai directly on the user's Venice key. */
  provider?:    'surplus' | 'venice'
}

export interface GenerateSpeechInput {
  model:        string
  input:        string
  voice?:       string
  /** mp3 (default) | opus | aac | flac | wav | pcm */
  format?:      string
  speed?:       number
  autoSaveDir?: string
  /** Media provider — 'surplus' (default) or 'venice' (direct, OpenAI-compatible /audio/speech). */
  provider?:    'surplus' | 'venice'
  /** Extra schema-driven params merged into the body (defensive). */
  params?:      ExtraParams
}

export interface TranscribeInput {
  model:       string
  /** Provide EITHER a path to an audio file OR raw bytes (one required). */
  audioPath?:  string
  audioBytes?: Uint8Array
  /** Filename used for the multipart part when audioBytes is given. */
  fileName?:   string
  language?:   string
  prompt?:     string
  /** Media provider — 'surplus' (default) or 'venice' (direct, OpenAI-compatible /audio/transcriptions). */
  provider?:   'surplus' | 'venice'
  /** Extra schema-driven params merged into the multipart form (defensive). */
  params?:     ExtraParams
}

export interface SubmitJobInput {
  model:    string
  prompt:   string
  /** Music models tagged lyrics_required expect this. */
  lyrics?:  string
  duration?:   number
  resolution?: string
  /** Extra schema-driven params merged into the body (defensive). */
  params?:     ExtraParams
}

export interface SaveArtifactInput {
  jobId:    string
  index:    number
  destDir:  string
  /** Optional explicit source path (e.g. a sync artifact already on disk). */
  srcPath?: string
}

export interface GenerateResult { artifacts: Artifact[] }
export interface SubmitResult   { jobId: string }
export interface SaveResult     { path: string }

// ─── Catalog (modality classification) ────────────────────────────────────────

// Raw model shape from /v1/models (OpenRouter-style envelope). We read the
// architecture block defensively; many fields may be absent.
interface RawModel {
  id?:   string
  name?: string
  architecture?: {
    modality?:             string
    input_modalities?:     string[]
    output_modalities?:    string[]
    supported_parameters?: string[]
  }
  /** Some catalogs surface the advertised param list at the top level instead. */
  supported_parameters?: string[]
  pricing?: { media_unit?: string | null }
}

let catalogCache: { at: number; models: SurplusMediaModelInfo[] } | null = null

/**
 * Classify a single /v1/models entry into a MediaModality.
 *
 * Primary signal (per research): architecture.output_modalities[0].
 *   image → image, video → video, music → music, embedding → embedding,
 *   audio → TTS, text → (input_modalities == ['audio'] ? STT : text).
 * Secondary: pricing.media_unit non-null ⇒ media model.
 * Fallback: id/family pattern when architecture is missing.
 */
function classifyModality(m: RawModel): MediaModality {
  const arch = m.architecture
  const out  = (arch?.output_modalities?.[0] ?? '').toLowerCase()
  const ins  = (arch?.input_modalities ?? []).map(s => s.toLowerCase())

  if (out === 'image')     return 'image'
  if (out === 'video')     return 'video'
  if (out === 'music')     return 'music'
  if (out === 'embedding') return 'embedding'
  if (out === 'audio')     return 'tts'
  if (out === 'text')      return ins.length === 1 && ins[0] === 'audio' ? 'stt' : 'text'

  // No architecture signal — fall back to id/family patterns.
  return classifyByIdPattern(m.id ?? '')
}

function classifyByIdPattern(id: string): MediaModality {
  const s = id.toLowerCase()
  // STT before TTS (whisper/asr/stt/parakeet are transcription).
  if (/whisper|parakeet|asr|stt|transcri/.test(s)) return 'stt'
  if (/tts|speech|kokoro|elevenlabs-tts/.test(s))  return 'tts'
  if (/video|t2v|runway|seedance|pixverse|veo|sora|kling/.test(s)) return 'video'
  if (/music|song|audio-25|stable-audio|ace-step|suno|minimax-music/.test(s)) return 'music'
  if (/flux|sdxl|sd35|image|nano-banana|qwen-image|gpt-image|dall|imagen/.test(s)) return 'image'
  if (/embed/.test(s)) return 'embedding'
  return 'text'
}

function familyOf(id: string): string | undefined {
  const s = id.toLowerCase()
  if (s.includes('flux'))       return 'Flux'
  if (s.includes('sdxl') || s.includes('sd35') || s.includes('sd-')) return 'Stable Diffusion'
  if (s.includes('whisper'))    return 'Whisper'
  if (s.includes('parakeet'))   return 'Parakeet'
  if (s.includes('kokoro'))     return 'Kokoro'
  if (s.includes('elevenlabs')) return 'ElevenLabs'
  if (s.includes('runway'))     return 'Runway'
  if (s.includes('seedance'))   return 'Seedance'
  if (s.includes('pixverse'))   return 'PixVerse'
  if (s.includes('minimax'))    return 'MiniMax'
  if (s.includes('ace-step'))   return 'ACE-Step'
  if (s.includes('nano-banana'))return 'Nano Banana'
  if (s.includes('qwen'))       return 'Qwen'
  if (s.includes('gpt-image'))  return 'GPT Image'
  if (s.includes('embed'))      return 'Embed'
  return undefined
}

function prettify(id: string): string {
  return id
    .replace(/^venice-/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Fetch + classify the live /v1/models catalog. Optionally filter to a single
 * modality. Cached for CATALOG_TTL_MS. The /models endpoint needs no auth, but
 * we still pass the key when present (some gateways gate the list). PRIVATE
 * MODE blocks the call (cloud egress).
 */
export async function listMediaModels(
  modality?: MediaModality,
  opts: { force?: boolean; provider?: 'surplus' | 'venice' } = {},
): Promise<MediaModelsResult> {
  if (opts.provider === 'venice') return listVeniceMediaModels(modality, opts)
  enforceProviderEgress('surplus')

  let models: SurplusMediaModelInfo[]
  if (!opts.force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    models = catalogCache.models
  } else {
    const key = retrieveKey('surplus')
    try {
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity' }
      if (key) headers.Authorization = `Bearer ${key}`
      const res = await fetch(`${SURPLUS_BASE_URL}/models`, {
        headers,
        signal: AbortSignal.timeout(8_000) as AbortSignal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as { data?: RawModel[] }
      const items = Array.isArray(body.data) ? body.data : []
      models = items
        .filter((m): m is RawModel & { id: string } => typeof m.id === 'string' && m.id.length > 0)
        .map(m => {
          const supported =
            (Array.isArray(m.architecture?.supported_parameters) ? m.architecture!.supported_parameters : undefined)
            ?? (Array.isArray(m.supported_parameters) ? m.supported_parameters : undefined)
          return {
            id:       m.id,
            label:    m.name || prettify(m.id),
            modality: classifyModality(m),
            family:   familyOf(m.id),
            live:     true,
            ...(supported && supported.length > 0
              ? { supportedParameters: supported.filter((s): s is string => typeof s === 'string') }
              : {}),
          }
        })
      if (models.length === 0) throw new Error('Empty model list')
      catalogCache = { at: Date.now(), models }
    } catch (err) {
      return {
        ok:     true,
        models: modality ? [] : [],
        stale:  true,
        error:  err instanceof Error ? err.message : String(err),
      }
    }
  }

  return { ok: true, models: modality ? models.filter(m => m.modality === modality) : models }
}

// Venice direct media catalog. Venice exposes its catalog at /models?type=<t>
// where t ∈ image|tts|asr|video|music|embedding. We support the modalities whose
// generation endpoints are OpenAI-compatible (image, tts, stt); video/music use
// Venice's queue API (/video/queue, /audio/queue — not yet wired) so they stay on
// Surplus, which already proxies Venice models. Cached per Venice type.
const VENICE_MEDIA_TYPE: Partial<Record<MediaModality, string>> = {
  image: 'image', tts: 'tts', stt: 'asr', video: 'video', music: 'music', embedding: 'embedding',
}
const veniceCatalogCache = new Map<string, { at: number; models: SurplusMediaModelInfo[] }>()

async function listVeniceMediaModels(
  modality?: MediaModality,
  opts: { force?: boolean } = {},
): Promise<MediaModelsResult> {
  enforceProviderEgress('venice')
  const mod    = modality ?? 'image'
  const type   = VENICE_MEDIA_TYPE[mod] ?? 'image'
  const cached = veniceCatalogCache.get(type)
  let models: SurplusMediaModelInfo[]
  if (!opts.force && cached && Date.now() - cached.at < CATALOG_TTL_MS) {
    models = cached.models
  } else {
    const key = retrieveKey('venice')
    try {
      const headers: Record<string, string> = { 'Accept-Encoding': 'identity' }
      if (key) headers.Authorization = `Bearer ${key}`
      const res = await fetch(`${VENICE_MEDIA_BASE}/models?type=${type}`, {
        headers,
        signal: AbortSignal.timeout(8_000) as AbortSignal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as { data?: Array<{ id?: string; name?: string }> }
      const items = Array.isArray(body.data) ? body.data : []
      models = items
        .filter((m): m is { id: string; name?: string } => typeof m.id === 'string' && m.id.length > 0)
        .map(m => ({
          id:       m.id,
          label:    m.name || prettify(m.id),
          modality: mod,
          family:   'Venice',
          live:     true,
        }))
      if (models.length === 0) throw new Error('Empty model list')
      veniceCatalogCache.set(type, { at: Date.now(), models })
    } catch (err) {
      return { ok: true, models: [], stale: true, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return { ok: true, models: modality ? models.filter(m => m.modality === modality) : models }
}

// ─── Param schema (curated per modality + live intersection) ──────────────────

// ── Image SIZE tiers (real, model-aware) ──────────────────────────────────────
//
// Three size declaration patterns exist across the families Surplus proxies:
//   (a) pixel width/height (Flux Dev/Schnell, Hidream, SDXL, Qwen, venice-sd35)
//       — typically 128–2048 step 64, default 1024x1024; SDXL/Qwen/Chroma cap 1536.
//   (b) aspect_ratio enum (Ideogram, GPT-4o, Imagen4 — ratios only).
//   (c) resolution enum "1K"/"2K"/"4K" + aspect_ratio (Seedream v4+, Imagen4,
//       GPT Image 2, Kling O1, Flux 2, Nano Banana Pro).
// We expose `size` as model-aware square pixel tiers (the universal pattern), and
// keep `aspect_ratio` for non-square framing. Square pixel strings double as the
// "1K/2K/4K" resolution intent (1024=1K, 2048=2K, 4096=4K). Only sizes a model can
// actually run are surfaced; the universal default is 1024x1024 (runnable by all).

/** Curated square-size tier list — exact request string → dropdown label. */
const SIZE_TIERS = {
  '512x512':   '512',
  '768x768':   '768',
  '1024x1024': '1K (1024)',
  '1536x1536': '1.5K',
  '2048x2048': '2K',
  '4096x4096': '4K',
} as const
type SizeTier = keyof typeof SIZE_TIERS

/** The universal default: runnable by every family. */
const DEFAULT_IMAGE_SIZE: SizeTier = '1024x1024'

/** Curated fallback set when we can't pin the family (square 512 → 2K). */
const CURATED_IMAGE_SIZES: SizeTier[] = ['512x512', '768x768', '1024x1024', '1536x1536', '2048x2048']

/**
 * Per-family square-size capability. Keyed by a lowercase id substring; first
 * match wins (order matters — list narrower ids first). `null` ⇒ this family
 * declares size by aspect_ratio / resolution only and has NO pixel size control,
 * so the `size` param is dropped entirely (aspect_ratio carries framing).
 */
const FAMILY_IMAGE_SIZES: Array<{ test: RegExp; sizes: SizeTier[] | null }> = [
  // ratio/resolution-only families (no pixel width/height) — drop `size`.
  { test: /ideogram|gpt-4o|gpt-image-1|gpt-image-2|imagen|seedream|nano-banana|kling|flux-2|flux2|midjourney/, sizes: null },
  // 1536-capped families (SDXL / Hunyuan / Pony / Qwen / Chroma / Z-Image).
  { test: /sdxl|hunyuan|\bpony\b|qwen|chroma|z-image|zimage|sd-?3\.?5|sd35/, sizes: ['512x512', '768x768', '1024x1024', '1536x1536'] },
  // 2K-capable pixel families (Flux Dev/Schnell, Hidream — 128–2048 step 64).
  { test: /flux|hidream|hi-dream/, sizes: ['512x512', '768x768', '1024x1024', '1536x1536', '2048x2048'] },
]

/**
 * ONE size tier for a local checkpoint: the square, plus the LANDSCAPE and
 * PORTRAIT pair of comparable area at the same tier.
 *
 * Shaped exactly like the video side's WAN_SIZES (localGenParams) — label →
 * orientation → pixel pair — because it is the same fact about a different
 * architecture, and the video table is the one that got it right first.
 *
 * The pairs are LITERAL, not derived from the square by arithmetic. A formula
 * would produce plausible numbers that no checkpoint was trained on; these are
 * the buckets the architectures actually saw:
 *   • 768x512 / 512x768   — SD 1.5's canonical landscape/portrait, the pair
 *     every SD 1.5 UI has shipped since 2022.
 *   • 896x640, 1216x832, and their portraits — three of SDXL's own multi-aspect
 *     training buckets (SDXL paper, "resolutions used during finetuning").
 *   • 1792x1280 / 1280x1792 — the same ~1.4:1 shape one tier up, for the
 *     families that render above 1024 at all.
 *
 * INVARIANTS, both of which localGenParams' normalizeSdDim would otherwise
 * silently "fix" into a different render (pinned by test):
 *   • every dimension is a multiple of 64 — the coarsest grid
 *     stable-diffusion.cpp has required, and a superset of the finer grids the
 *     DiT families use (Z-Image renders 1216x832 as asked: verified against the
 *     pinned engine, `generate_image 1216x832` → a 1216x832 PNG);
 *   • no dimension exceeds SD_DIM_MAX (2048), which is why the 2048 tier has no
 *     oriented pair — a landscape at that tier would need >2048 on the long
 *     side, and clamping it would make the dropdown lie about its own numbers.
 */
interface LocalImageTier {
  square:     SizeTier
  landscape?: string
  portrait?:  string
}

/**
 * Size tiers for a LOCAL checkpoint, keyed by its DECLARED family.
 *
 * FAMILY_IMAGE_SIZES above keys off an id SUBSTRING, which is fine for cloud
 * ids (they spell the family out) and wrong for ours: a user-installed row is
 * `civitai-812345`, so an SD 1.5 checkpoint from Civitai would have fallen to
 * the curated 512→2K list and DEFAULTED to 1024x1024 — the size at which SD 1.5
 * duplicates subjects. The row knows its family; ask it.
 *
 * `sd15` is narrow on purpose: 512 is what the architecture renders, 768 is the
 * honest stretch, and its 768 tier carries NO oriented pair because going wider
 * than 768 on both axes is exactly where SD 1.5 starts duplicating subjects.
 * `zimage` has a column of its own now rather than falling through to the
 * substring table — the table's /z-image/ match was a coincidence of the id, and
 * a coincidence cannot carry an orientation.
 */
const LOCAL_IMAGE_TIERS: Record<'sd15' | 'sdxl' | 'flux' | 'zimage', { tiers: LocalImageTier[]; default: SizeTier }> = {
  sd15: {
    tiers: [
      { square: '512x512', landscape: '768x512', portrait: '512x768' },
      { square: '768x768' },
    ],
    default: '512x512',
  },
  sdxl: {
    tiers: [
      { square: '512x512' },
      { square: '768x768',   landscape: '896x640',   portrait: '640x896'   },
      { square: '1024x1024', landscape: '1216x832',  portrait: '832x1216'  },
      { square: '1536x1536', landscape: '1792x1280', portrait: '1280x1792' },
    ],
    default: '1024x1024',
  },
  flux: {
    tiers: [
      { square: '512x512' },
      { square: '768x768',   landscape: '896x640',   portrait: '640x896'   },
      { square: '1024x1024', landscape: '1216x832',  portrait: '832x1216'  },
      { square: '1536x1536', landscape: '1792x1280', portrait: '1280x1792' },
      { square: '2048x2048' },
    ],
    default: '1024x1024',
  },
  // Z-Image Turbo: 1024 native, and upstream caps this family around 2048px, so
  // it gets SDXL's ladder rather than Flux's.
  zimage: {
    tiers: [
      { square: '512x512' },
      { square: '768x768',   landscape: '896x640',   portrait: '640x896'   },
      { square: '1024x1024', landscape: '1216x832',  portrait: '832x1216'  },
      { square: '1536x1536', landscape: '1792x1280', portrait: '1280x1792' },
    ],
    default: '1024x1024',
  },
}

/** Flatten a family's tiers into the dropdown's order: ascending by tier, with
 *  each tier's landscape and portrait immediately beside their own square, so
 *  the list reads as "this size, wide, tall" rather than as two ladders. */
function localImageSizeEnum(tiers: LocalImageTier[]): string[] {
  const out: string[] = []
  for (const t of tiers) {
    out.push(t.square)
    if (t.landscape) out.push(t.landscape)
    if (t.portrait)  out.push(t.portrait)
  }
  return out
}

/** "1024x1024" scaled 2x → "2048x2048" — the size the two-pass control's own
 *  description promises. Arithmetic on the ROW's native pair rather than a typed
 *  number, so it cannot go stale when a row's baseSize changes. Unparseable in,
 *  unchanged out (never a fabricated size). */
function scaledSizeLabel(native: string, scale: number): string {
  const m = /^\s*(\d+)\s*[x×X]\s*(\d+)\s*$/.exec(native)
  if (!m) return native
  return `${Math.round(Number(m[1]) * scale)}x${Math.round(Number(m[2]) * scale)}`
}

/** Size tiers for a LOCAL image model, or null when `modelId` is not one of
 *  ours (every cloud id falls through to the family-substring table). */
function localImageOptionsFor(modelId: string): { enum: string[]; default: SizeTier } | null {
  let row: { family: string } | undefined
  try { row = allSdModels().find(m => m.id === modelId && m.kind === 'image') }
  catch { return null }
  if (!row) return null
  const tier = LOCAL_IMAGE_TIERS[row.family as 'sd15' | 'sdxl' | 'flux' | 'zimage']
  if (!tier) return null
  return { enum: localImageSizeEnum(tier.tiers), default: tier.default }
}

// ── LOCAL generation params: steps / cfg / sampler (audit D2, D17, D6a) ──────
//
// `size` was narrowed per row above and the whole video block was narrowed per
// row too, but the three params that decide what the sampler ACTUALLY does were
// left as one global guess: steps 1–50 with NO default, cfg 1–20 with NO
// default, and a sampler enum spelled in A1111/diffusers names sd-cli does not
// accept. Every consequence of that is silent:
//
//  • ParamFields falls back to `min` when a spec has no default, so the Steps
//    slider read 1 and the CFG slider read 1 on EVERY local model while sd-cli
//    ran the row's 20 / 28 / 4. The composer displayed numbers that were not
//    the numbers that ran.
//  • SD-Turbo is a 1-step model and the slider offered 50 — and unlike cfg
//    (dead until now) the steps path was always live, so that is a real 50x
//    waste one drag away.
//  • A `steps: 40` left over from a CLOUD run is in-range, so healParamsForSchema
//    kept it and forwarded it to a distilled checkpoint. The Wan lane fixed
//    exactly this out-voting for resolution and duration; steps/cfg were left.
//
// Every bound here is DERIVED FROM THE ROW, so a new curated row or a
// user-installed Civitai checkpoint narrows the controls with no code change.

/** The honest step ceiling for a row: distilled weights degrade past their
 *  trained budget, so the band is tight there and generous everywhere else. */
function stepsCeilingFor(row: { steps: number; cfgScale: number }): number {
  return isDistilledRow(row)
    ? Math.max(4, row.steps * 4)          // sd-turbo 1 → 4 · schnell 4 → 16
    : Math.max(30, row.steps * 2)         // sd15 20 → 40 · sdxl 28 → 56 · wan 20 → 40
}

/**
 * steps / cfg / sampler for a LOCAL row, or null when `modelId` is not one of
 * ours (every cloud id falls through to the curated superset untouched).
 *
 * `cfg: null` means DROP THE CONTROL: a checkpoint whose recipe is guidance 1
 * is distilled without classifier-free guidance, and sd.cpp's resolve_guidance
 * only enables the unconditional pass when cfg ≠ 1 — so the slider would move a
 * number that changes nothing. The same fact makes the NEGATIVE PROMPT inert on
 * those rows, which is why this returns `negativeIsInert` for the caller to say
 * so out loud instead of rendering a textarea that does nothing.
 */
function localGenOptionsFor(modelId: string): {
  steps:   { min: number; max: number; default: number }
  cfg:     { min: number; max: number; default: number } | null
  sampler: { enum: string[]; default: string }
  negativeIsInert: boolean
  /**
   * The row's OWN negative conditioning, or '' when it declares none.
   *
   * '' rather than null on purpose: this becomes the ParamSpec `default`, and a
   * declared-but-empty default is what lets a model switch CLEAR a previous
   * row's negative (reseedRecipeParams skips a spec whose default is
   * undefined). Without it, Wan's official negative would ride onto the next
   * local checkpoint and condition an SDXL render at cfg 5 for real.
   */
  negative: string
  native:  string
  /**
   * The row's declared family — needed by the CLIP-SKIP gate, which is the one
   * control whose very existence depends on WHICH text encoder does the
   * conditioning. Passed through from the row rather than re-derived from the id:
   * an id-substring guess is exactly how a Z-Image row nearly inherited Flux's
   * table (see localImageOptionsFor).
   */
  family:  string
} | null {
  let row: ReturnType<typeof findSdRow>
  try { row = findSdRow(modelId) } catch { return null }
  if (!row) return null
  const inert = row.cfgScale <= 1
  // The row's own sampler must be IN the enum or the dropdown silently shows
  // something else as selected (curated rows are pinned to this list by test,
  // but a hand-edited user row is not).
  const samplers = SD_SAMPLING_METHODS.includes(row.samplingMethod)
    ? [...SD_SAMPLING_METHODS]
    : [row.samplingMethod, ...SD_SAMPLING_METHODS]
  return {
    steps:   { min: 1, max: stepsCeilingFor(row), default: row.steps },
    cfg:     inert ? null : { min: 1, max: 20, default: row.cfgScale },
    sampler: { enum: samplers, default: row.samplingMethod },
    negativeIsInert: inert,
    // Never offered on an inert row: at guidance 1 the engine encodes no
    // unconditional pass, so pre-filling a field that provably does nothing
    // would be the exact lie `negativeIsInert` exists to prevent.
    negative: inert ? '' : (row.negativePrompt ?? ''),
    native:  row.kind === 'video' ? `${row.width}x${row.height}` : `${row.baseSize}x${row.baseSize}`,
    family:  row.family,
  }
}

/**
 * The families whose conditioning IS a CLIP text encoder, i.e. the only ones
 * `--clip-skip` can do anything to.
 *
 * sd15 and sdxl load `clip_l` (+ `clip_g` on XL). Flux pairs clip_l with a T5 and
 * takes its conditioning from the T5; Z-Image goes through `--llm`; the video rows
 * use umt5 or Gemma. Skipping CLIP layers on any of those is at best a no-op.
 */
const CLIP_SKIP_FAMILIES = new Set(['sd15', 'sdxl'])

/** Per-family aspect-ratio sets (superset seen across families). */
const RATIOS_STANDARD  = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']
const RATIOS_RESTRICTED = ['1:1', '4:3', '3:4', '16:9', '9:16']  // Ideogram/GPT-image/Imagen4
const RATIOS_GPT4O     = ['1:1', '2:3', '3:2']                   // GPT-4o limited set
const RATIOS_MIDJOURNEY = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '1:2', '2:1', '5:6', '6:5']

/**
 * Resolve the square-size enum + default for an image model. Prefers the live
 * catalog: if the model advertises a `size` param we keep the curated tiers
 * (the gateway doesn't expose the per-model pixel range, so capability is keyed
 * off the family id). If the family is ratio/resolution-only we return null so
 * the caller drops the `size` control. Falls back to the curated tier list.
 */
function imageSizeOptionsFor(modelId: string): { enum: SizeTier[]; default: SizeTier } | null {
  const s = modelId.toLowerCase()
  for (const { test, sizes } of FAMILY_IMAGE_SIZES) {
    if (test.test(s)) {
      if (sizes === null) return null  // ratio/resolution-only — no pixel size control
      return { enum: sizes, default: DEFAULT_IMAGE_SIZE }
    }
  }
  return { enum: CURATED_IMAGE_SIZES, default: DEFAULT_IMAGE_SIZE }
}

// ── LOCAL (sd.cpp / Wan) video capability ─────────────────────────────────────
//
// The video schema is SHARED by every provider (the composer always asks
// modelParamSchema('video', <modelId>)), so it advertises the cloud superset:
// resolution 480p|720p|1080p × aspect 16:9|9:16|1:1. That is a promise the
// LOCAL engine cannot keep. Wan 2.1 T2V 1.3B — the only video checkpoint we
// ship — has upstream SUPPORTED_SIZES ('832*480', '480*832'): 480p landscape
// and 480p portrait, full stop. 720p is the 14B checkpoints' pair
// ('1280*720'/'720*1280'), and Wan 2.1 has NO 1080p variant at all. Square is
// in no Wan variant's supported list either.
//
// So the narrowing is PER MODEL, not global: a modelId that is in
// SD_VIDEO_MODELS gets the tiers its own row can render; every cloud model id
// falls through untouched and keeps the full curated enums.

/** Resolution labels, ascending, with the SHORT side each one denotes. */
const VIDEO_RESOLUTION_LADDER: Array<{ label: string; shortSide: number }> = [
  { label: '480p',  shortSide: 480  },
  { label: '720p',  shortSide: 720  },
  { label: '1080p', shortSide: 1080 },
]

// The TIME axis over-promises exactly like the size axis did: the curated
// `duration` slider runs to 30 s, and no local checkpoint can go anywhere near
// that. Frame counts must be 4n+1, and 81 frames — upstream Wan's own
// `--frame_num` default, the length the model was trained on, and the ~80-frame
// consistency ceiling an unpatched Wan drifts past — is the ceiling. sd-cli
// imposes none of its own (`--video-frames` defaults to 1 and has no cap), so
// this is the model's limit, not the CLI's.
//
// THE FRAME RATE IS NO LONGER A CONSTANT HERE. It was, while every shipped
// checkpoint was a 16 fps Wan 2.1 — and 81/16 ≈ 5.06 s is where the "5 s" offer
// came from. Wan 2.2 TI2V-5B generates at 24, where the same 81 frames are
// ~3.4 s, so both the ceiling and the default are read off the ROW now
// (DEFAULT_VIDEO_FPS is the fallback for a row that declares none). See
// localGenParams' durationSecondsToWanFrames for the other half of this
// contract, and the `fps` it is handed through the duration spec.
const WAN_FRAMES_MAX = 81

/**
 * Resolution + aspect + duration options for a LOCAL video model, or null when
 * `modelId` is not one of ours (cloud models keep the curated superset). Every
 * bound is derived from the model row itself, so adding a 720p-capable or
 * 81-frame Wan row to SD_VIDEO_MODELS widens the controls without touching this
 * code.
 */
function localVideoOptionsFor(modelId: string): {
  resolutions: string[]
  ratios: string[]
  native: string
  /** The row's own frame rate — what the seconds below actually mean. */
  fps: number
  /** The row's own temporal grid — `--video-frames` must be `frameGrid*n + 1`.
   *  4 on every Wan checkpoint, 8 on LTX-AV. */
  frameGrid: number
  seconds: { min: number; max: number; default: number }
  /** Can this checkpoint start from an image at all? (row.i2v — see below.) */
  i2v: boolean
  /**
   * The INSTALLED speed pack for this row, or null. Non-null is what puts the
   * speed toggle on screen: a control for weights that are not on disk would be
   * a switch that does nothing, and one for a row that has no pack at all would
   * be a promise we cannot keep (see SD_BLOCKED_SPEED_ADAPTERS).
   */
  speed: { steps: number; vanillaSteps: number; name: string } | null
} | null {
  const m = SD_VIDEO_MODELS.find(x => x.id === modelId)
  if (!m) return null
  const pack = installedSpeedAdapter(modelId)
  const fps  = m.fps ?? DEFAULT_VIDEO_FPS
  const grid = m.pixelGrid ?? DEFAULT_VIDEO_PIXEL_GRID
  const shortSide = Math.min(m.width, m.height)
  // A LADDER RUNG MEANS, FOR THIS ROW, THE RUNG ON THIS ROW'S PIXEL GRID.
  // Wan 2.2 TI2V-5B is a 720p-native model whose 720p pair is 1280x704, because
  // its VAE compresses 16x and the dimensions must be multiples of 32. Comparing
  // the label's nominal 720 against that native 704 would drop '720p' from the
  // picker of the one shipped checkpoint whose whole point is 720p — the model
  // would be installable and its native tier unreachable.
  const onGrid = (n: number) => Math.floor(n / grid) * grid
  const resolutions = VIDEO_RESOLUTION_LADDER.filter(r => onGrid(r.shortSide) <= shortSide).map(r => r.label)
  const maxSeconds = Math.max(1, Math.floor(WAN_FRAMES_MAX / fps))
  return {
    fps,
    frameGrid: m.frameGrid ?? DEFAULT_VIDEO_FRAME_GRID,
    // IMAGE→VIDEO IS A DIFFERENT CHECKPOINT, not a flag. Wan's i2v variants take
    // extra conditioning channels and ship a clip_vision encoder alongside the
    // DiT; the one video row we ship (wan21-t2v-1.3b) declares `i2v: false` and
    // has no clip_vision file, so an init frame cannot reach the model however
    // it is passed. The composer offered "INIT FRAME (IMAGE→VIDEO)" on it
    // anyway — the owner attached one, waited out the render, and got a pure
    // text→video of the prompt. Same class as the 480p/720p narrowing above:
    // the row is the authority on what it can do, and a row that CAN do i2v
    // brings the control back with no code change.
    i2v: m.i2v,
    // A row whose short side is under 480 still gets one honest option.
    resolutions: resolutions.length > 0 ? resolutions : [VIDEO_RESOLUTION_LADDER[0].label],
    // Landscape + portrait only — no Wan variant lists a square size.
    ratios: ['16:9', '9:16'],
    native: `${m.width}x${m.height}`,
    speed: pack ? { steps: pack.preset.steps, vanillaSteps: m.steps, name: pack.name } : null,
    // The default is the row's OWN frame count read at the row's OWN rate
    // (33 @ 16 fps → 2 s; 49 @ 24 fps → the same 2 s): that is what every local
    // render has been producing, so honouring the slider must not also silently
    // make the default run 2.5x longer.
    seconds: {
      min: 1,
      max: maxSeconds,
      default: Math.min(maxSeconds, Math.max(1, Math.round(m.frames / fps))),
    },
  }
}

/** Resolve the aspect-ratio enum + default for an image model. */
function imageRatioOptionsFor(modelId: string): { enum: string[]; default: string } {
  const s = modelId.toLowerCase()
  if (/gpt-4o/.test(s))                                   return { enum: RATIOS_GPT4O, default: '1:1' }
  if (/midjourney/.test(s))                               return { enum: RATIOS_MIDJOURNEY, default: '1:1' }
  if (/ideogram|gpt-image|imagen/.test(s))                return { enum: RATIOS_RESTRICTED, default: '1:1' }
  return { enum: RATIOS_STANDARD, default: '1:1' }
}

/**
 * Curated per-modality param schema. This is the SOURCE OF TRUTH for which
 * controls the UI renders. Order here = order rendered. `advanced: true` params
 * are tucked behind a disclosure. These are sent DEFENSIVELY (only when set), so
 * a model that ignores e.g. `sampler` simply drops it.
 */
const CURATED_SCHEMA: Record<MediaModality, ParamSpec[]> = {
  image: [
    { name: 'prompt',          label: 'Prompt',           kind: 'text',   required: true,
      description: 'What to generate. Wire a text agent into the prompt plug to author this.' },
    { name: 'negative_prompt', label: 'Negative prompt',  kind: 'text',
      description: 'What to avoid (artifacts, watermarks, extra limbs, …).' },
    // aspect_ratio + size enums below are the CURATED FALLBACK; modelParamSchema
    // rewrites both per-model (real tiers, may drop `size` for ratio-only families).
    { name: 'aspect_ratio',    label: 'Aspect ratio',     kind: 'enum',
      enum: RATIOS_STANDARD, default: '1:1' },
    { name: 'size',            label: 'Size',             kind: 'enum',   enum: CURATED_IMAGE_SIZES, default: DEFAULT_IMAGE_SIZE },
    { name: 'n',               label: 'Images',           kind: 'int',    min: 1, max: 4, step: 1, default: 1,
      description: 'How many variations to generate.' },
    { name: 'seed',            label: 'Seed',             kind: 'int',    min: -1, max: 2_147_483_647, step: 1, default: -1,
      description: '-1 = random. Lock a value to reproduce a result.' },
    { name: 'steps',           label: 'Steps',            kind: 'int',    min: 1, max: 50, step: 1, advanced: true,
      description: 'Denoising steps. Higher = more detail, slower.' },
    { name: 'cfg',             label: 'Guidance (CFG)',   kind: 'number', min: 1, max: 20, step: 0.5, advanced: true,
      description: 'How strictly to follow the prompt.' },
    { name: 'sampler',         label: 'Sampler',          kind: 'enum',   advanced: true,
      enum: ['euler', 'euler_a', 'dpmpp_2m', 'dpmpp_2m_karras', 'dpmpp_sde', 'ddim', 'heun', 'lms'] },
    // NO `default` HERE ON PURPOSE — see the LOCAL branch in modelParamSchema,
    // which supplies one. This bag is forwarded verbatim to whichever gateway is
    // selected (mergeExtraParams), so a default seeded here would put a
    // `strength` into every CLOUD text→image request that never asked for one.
    { name: 'strength',        label: 'img2img strength', kind: 'number', min: 0, max: 1, step: 0.05, advanced: true,
      description: 'Only with an init image. 0 = keep init, 1 = ignore it.' },
    { name: 'image_url',       label: 'Init image',       kind: 'image',  advanced: true,
      description: 'Optional starting image for img2img.' },
  ],
  video: [
    { name: 'prompt',          label: 'Prompt',          kind: 'text', required: true },
    { name: 'negative_prompt', label: 'Negative prompt', kind: 'text' },
    { name: 'aspect_ratio',    label: 'Aspect ratio',    kind: 'enum', enum: ['16:9', '9:16', '1:1'], default: '16:9' },
    { name: 'duration',        label: 'Duration (s)',    kind: 'int',  min: 1, max: 30, step: 1, default: 5 },
    { name: 'resolution',      label: 'Resolution',      kind: 'enum', enum: ['480p', '720p', '1080p'], default: '720p' },
    { name: 'image_url',       label: 'Init frame',      kind: 'image', advanced: true,
      description: 'Optional first frame (image→video).' },
    { name: 'seed',            label: 'Seed',            kind: 'int',  min: -1, max: 2_147_483_647, step: 1, default: -1, advanced: true },
  ],
  music: [
    { name: 'prompt',       label: 'Prompt',       kind: 'text',    required: true },
    { name: 'lyrics',       label: 'Lyrics',       kind: 'text',
      description: 'Optional. Required by lyrics_required models.' },
    { name: 'duration',     label: 'Duration (s)', kind: 'int',     min: 1, max: 120, step: 1, default: 30 },
    { name: 'instrumental', label: 'Instrumental', kind: 'boolean', default: false },
    { name: 'genre',        label: 'Genre',        kind: 'string' },
  ],
  tts: [
    { name: 'input',           label: 'Text',   kind: 'text',   required: true,
      description: 'The text to speak aloud.' },
    { name: 'voice',           label: 'Voice',  kind: 'string',
      description: 'Voice id (model-specific).' },
    { name: 'response_format', label: 'Format', kind: 'enum',   enum: ['mp3', 'opus', 'aac', 'flac', 'wav'], default: 'mp3' },
    { name: 'speed',           label: 'Speed',  kind: 'number', min: 0.25, max: 4, step: 0.05, default: 1 },
  ],
  stt: [
    { name: 'file',            label: 'Audio file', kind: 'audio',  required: true,
      description: 'The audio to transcribe.' },
    { name: 'language',        label: 'Language',   kind: 'string',
      description: 'ISO code hint (e.g. "en"). Leave blank to auto-detect.' },
    { name: 'response_format', label: 'Format',     kind: 'enum',   enum: ['json', 'verbose_json', 'text'], default: 'json' },
    { name: 'translate',       label: 'Translate to English', kind: 'boolean', default: false },
  ],
  // text / embedding have no media param schema.
  text:      [],
  embedding: [],
}

/**
 * Return the param schema for a given (modality, modelId). Starts from the
 * curated per-modality schema; when the LIVE catalog advertises this model's
 * supported_parameters, intersect with it (keep curated params the model
 * advertises, plus always keep `required` params so the UI can still collect
 * the prompt/input/file even if the gateway omits it from the list). When the
 * model isn't found or advertises nothing, the full curated schema is returned.
 *
 * Defensive throughout: an unknown modality returns []; lookups never throw.
 */
// Reference-image params (img2img init image + its strength). These are GATED by
// model capability (does this model accept an input image?), NOT by the generic
// supported_parameters intersection — Venice's t2i catalog entries usually don't
// list `image_url`, yet edit/i2i/i2v models DO accept one. So we detect capability
// from advertised params OR the model id, and surface the control prominently.
const IMAGE_INPUT_PARAMS = new Set(['image_url', 'strength'])

/**
 * Does this model accept an INPUT image? (img2img for image, image→video init
 * frame for video.) True when the catalog advertises an image input param, or
 * when the model id matches a known image-conditioned family.
 */
function modelSupportsImageInput(
  modality: MediaModality,
  _modelId: string,
  _advertised: Set<string>,
): boolean {
  // Image + video models can take a reference/init image. We offer the control on
  // ALL of them (optional) rather than guessing per-model — virtually every modern
  // image model does img2img and most video models do image→video, and the engine
  // sends `image_url` only when one is actually attached (a model that ignores it
  // simply drops it). Showing it everywhere beats hiding it where a user expects it
  // (e.g. gpt-image-2). text / music / tts / stt never take an input image.
  return modality === 'image' || modality === 'video'
}

export function modelParamSchema(modality: MediaModality, modelId: string): ParamSpec[] {
  const curated = CURATED_SCHEMA[modality] ?? []
  if (curated.length === 0) return []

  const model = catalogCache?.models.find(m => m.id === modelId)
  const supported = model?.supportedParameters
  const advertised = new Set((supported ?? []).map(s => s.toLowerCase()))
  const hasSupported = advertised.size > 0

  // Normalize advertised names for a lenient match (cfg/guidance_scale, n/num_images,
  // input/text, file/audio are common aliases — keep the curated param if EITHER
  // its own name OR a known alias is advertised).
  const aliases: Record<string, string[]> = {
    cfg:             ['guidance_scale', 'guidance'],
    n:               ['num_images'],
    image_url:       ['init_image', 'image'],
    response_format: ['format'],
    input:           ['text'],
    file:            ['audio'],
  }
  const isAdvertised = (name: string): boolean => {
    if (advertised.has(name.toLowerCase())) return true
    for (const alt of aliases[name] ?? []) if (advertised.has(alt)) return true
    return false
  }

  const imageInput = modelSupportsImageInput(modality, modelId, advertised)

  // Per-model image sizing: rewrite `size`/`aspect_ratio` enums to the family's
  // REAL tiers (and drop `size` for ratio/resolution-only families). Computed
  // once; applied inline below so the curated-fallback + intersection rules still
  // run for every other param.
  // A LOCAL row's declared family wins over the id-substring table (see
  // localImageOptionsFor); cloud ids get null here and fall through unchanged.
  const localImg  = modality === 'image' ? localImageOptionsFor(modelId) : null
  const sizeOpts  = modality === 'image' ? (localImg ?? imageSizeOptionsFor(modelId)) : null
  const ratioOpts = modality === 'image' ? imageRatioOptionsFor(modelId) : null
  // Per-model VIDEO sizing: narrow resolution/aspect to what a LOCAL checkpoint
  // can actually render. null for every cloud model id (superset preserved).
  const localVid  = modality === 'video' ? localVideoOptionsFor(modelId)  : null
  // Per-model steps / cfg / sampler — non-null for a LOCAL row of EITHER
  // modality (both send those three down the same sd-cli flags).
  const localGen  = (modality === 'image' || modality === 'video') ? localGenOptionsFor(modelId) : null

  const out: ParamSpec[] = []
  for (const p of curated) {
    if (localGen && p.name === 'steps') {
      out.push({ ...p, min: localGen.steps.min, max: localGen.steps.max, default: localGen.steps.default,
        description: `Denoising steps. This checkpoint's own recipe is ${localGen.steps.default}; past ${localGen.steps.max} it is out of what it was trained for.` })
      continue
    }
    if (localGen && p.name === 'cfg') {
      // DROPPED, not clamped, when the row runs at guidance 1 — see localGenOptionsFor.
      if (!localGen.cfg) continue
      out.push({ ...p, min: localGen.cfg.min, max: localGen.cfg.max, default: localGen.cfg.default })
      continue
    }
    if (localGen && p.name === 'sampler') {
      out.push({ ...p, enum: [...localGen.sampler.enum], default: localGen.sampler.default })
      continue
    }
    if (localGen && p.name === 'negative_prompt') {
      if (localGen.negativeIsInert) {
        // Honest rather than hidden: the control still collects text (a Remix or a
        // model switch keeps it), but it says why nothing will come of it here.
        // `default: ''` is what CLEARS a previous row's live negative on the way
        // in — carrying Wan's into a field that does nothing would be harmless
        // here and a real, silent conditioning change on the next row over.
        out.push({ ...p, default: '', description: `${p.description ?? ''} This checkpoint renders at guidance 1, where the engine skips the unconditional pass — a negative prompt has no effect on it.`.trim() })
        continue
      }
      // THE ROW'S OWN NEGATIVE (WAN_DEFAULT_NEGATIVE today), as a `default` and
      // nothing else. That single word is the whole feature: it makes the string
      // a row-owned param exactly like steps / cfg / sampler / size, so it seeds
      // an empty bag, re-seeds on a model switch, PRE-FILLS the visible field,
      // and loses to anything the user types — no run-time append, no invisible
      // second prompt, no special case in the arg builder.
      out.push({
        ...p,
        default: localGen.negative,
        ...(localGen.negative
          ? { description: `${p.description ?? ''} This checkpoint ships its OWN official negative prompt and was tuned against it, so the field starts pre-filled — edit or clear it freely; whatever is in this box is what runs.`.trim()
              // THE INERTNESS IS CONDITIONAL NOW, so it cannot be read off the
              // row's cfg alone. A speed pack pins guidance to 1 for the run,
              // and at guidance 1 sd.cpp encodes no unconditional pass — so on
              // a row whose OWN recipe is cfg 6 the field is live or dead
              // depending on one toggle, and the field itself has to say so.
              + (localVid?.speed ? ' While Speed (distilled) is on, guidance is 1 and this prompt does nothing — turn it off for it to take effect.' : '') }
          : {}),
      })
      continue
    }
    if (localGen && modality === 'image' && p.name === 'n') {
      // "Images: 1–4" WAS dead on the local route — buildSdArgs emitted no
      // --batch-count and the composer never forwarded `n`, so you set 4 and got
      // 1. It is live now (`-b`), and the description says the two things a
      // batch actually costs and gives, because neither is guessable: the model
      // loads ONCE (that is the saving) and the sampler still runs N times (that
      // is the bill), and the seeds are CONSECUTIVE from the first rather than N
      // independent draws — which is the engine's behaviour, verified, and the
      // reason a batch is a variation sweep and not four unrelated images.
      out.push({
        ...p, max: SD_BATCH_MAX,
        description: `How many images to generate in one run. The checkpoint loads once, but each image is sampled in full — 4 images take about 4x as long as 1. Each gets its own seed, counting up from the first.`,
      })
      continue
    }
    if (localImg && p.name === 'aspect_ratio') {
      // The local `size` enum carries ORIENTATION ITSELF now ('1216x832' is
      // landscape, in the pixels that will render), and resolveLocalSdSize reads
      // `size` alone. A ratio control on top of that would be a second,
      // APPROXIMATE name for a choice already made exactly — '16:9' over a
      // 1216x832 render is 1.46:1 — so the drop stands for a better reason than
      // the one it started with.
      continue
    }
    if (localVid && p.name === 'resolution') {
      // Default to the HIGHEST tier the row supports — that is its native size.
      out.push({
        ...p,
        enum: [...localVid.resolutions],
        default: localVid.resolutions[localVid.resolutions.length - 1],
        // The i2v sentence is here rather than nowhere: the INIT FRAME control
        // is REMOVED for a text→video row (below), and a control that simply
        // vanishes reads as another bug. This line says which checkpoint would
        // bring it back.
        // "a larger model", not "a larger WAN model": the catalog is no longer
        // all-Wan, and the one non-Wan row would have been told to go get a Wan
        // checkpoint it has nothing to do with. The i2v half below is still
        // Wan-worded on purpose — it names an actual shipped row.
        description: `Local engine: this checkpoint renders ${localVid.native}. Higher tiers need a larger model, which is not shipped.`
          + (localVid.i2v ? '' : ' It is text→video only: starting from an image needs a Wan i2v checkpoint, which is not shipped either.'),
      })
      continue
    }
    if (localVid && p.name === 'aspect_ratio') {
      out.push({ ...p, enum: [...localVid.ratios], default: '16:9' })
      continue
    }
    if (localVid && p.name === 'duration') {
      out.push({
        ...p,
        min:     localVid.seconds.min,
        max:     localVid.seconds.max,
        default: localVid.seconds.default,
        // THE RATE THESE SECONDS MEAN. resolveLocalWanFrames is handed this
        // spec as its bound by BOTH local surfaces, so putting the row's fps
        // here is what makes "2 s" turn into 33 frames on a 16 fps checkpoint
        // and 49 on a 24 fps one — without either call site knowing there is
        // more than one answer.
        fps:     localVid.fps,
        // …and THE TEMPORAL LAW those frames must land on, for the same reason
        // and by the same route. It was a constant (4) in two places until this
        // catalog stopped being all-Wan: LTX-AV compresses 8x, so 45 frames —
        // legal everywhere else — decodes to 41 there without a word.
        frameGrid: localVid.frameGrid,
        // The soft half of the ceiling: the hard cap above is the MODEL's, but a
        // length well under it can still die on the GPU — a driver's 49-frame
        // render overflowed 12 GB and sd-cli was reaped mid-run. No per-GPU
        // arithmetic is invented here (we do not know the free VRAM at schema
        // time); it says only which direction costs more.
        description: `Local engine: this checkpoint renders ${localVid.fps} fps clips of at most ${WAN_FRAMES_MAX} frames (~${localVid.seconds.max}s). Longer needs a different model, which is not shipped. Longer clips also need more GPU memory — one that exceeds what is free is killed mid-render and produces nothing.`,
      })
      continue
    }
    if (modality === 'image' && p.name === 'size') {
      // Drop the pixel-size control on families that size by ratio/resolution only.
      if (!sizeOpts) continue
      out.push({
        ...p, enum: [...sizeOpts.enum], default: sizeOpts.default,
        // The row's NATIVE grid, named. A 512x512 left over from an SD 1.5 run
        // is a legal SDXL option, so healParamsForSchema will not touch it and
        // the render silently comes out at half the size the checkpoint wants —
        // the one thing that can tell the user is the spec itself.
        //
        // …and now the second sentence, for the same reason: the WIDE and TALL
        // options are not arbitrary crops of the square, they are the shapes
        // these architectures were finetuned on, and a user who does not know
        // that will pick the square and crop it afterwards.
        ...(localGen ? { description: `Local engine: this checkpoint renders natively at ${localGen.native}. Other tiers work but drift from what it was trained on. The wide and tall options are shapes this family was trained on — pick one instead of cropping a square afterwards.` } : {}),
      })
      continue
    }
    if (modality === 'image' && p.name === 'aspect_ratio' && ratioOpts) {
      out.push({ ...p, enum: [...ratioOpts.enum], default: ratioOpts.default })
      continue
    }
    if (IMAGE_INPUT_PARAMS.has(p.name)) {
      // Reference-image params: shown ONLY on models that accept an input image,
      // and then PROMINENTLY (not buried under Advanced).
      if (!imageInput) continue
      // …and a LOCAL video row that is not an i2v checkpoint cannot use one at
      // all — offering the control there promises a mode the weights do not have.
      if (localVid && !localVid.i2v) continue
      // A LOCAL VIDEO row has no STRENGTH at all, i2v or not: `-M vid_gen` takes
      // `-i` and no `--strength` (buildSdVideoArgs, and every upstream i2v
      // command), so the slider on the Wan i2v row moved nothing. Dropped rather
      // than defaulted — a control that cannot reach the engine is the D1 class,
      // and giving it a visible default would have made it a louder lie.
      if (localVid && p.name === 'strength') continue
      out.push({
        ...p,
        advanced: false,
        label: p.name === 'image_url'
          ? (modality === 'video' ? 'Init frame (image→video)' : 'Reference image (img2img)')
          : p.label,
        // ── THE ONE img2img DEFAULT (the checkpoint-A P1) ─────────────────────
        //
        // `strength` was the only param in this schema with no `default`, and
        // ParamFields renders `spec.min` for a default-less slider — so the
        // control read 0 ("keep init", per its own help) while buildSdArgs
        // emitted its own private `?? 0.6`. Two owners, two numbers, and a driver
        // watched two runs go out at 0.6 with 0 on screen.
        //
        // Declaring it here makes the SPEC the owner, which is the same mechanism
        // steps / cfg / sampler / size / negative_prompt already use: it seeds an
        // empty bag (healParamsForSchema), it is what the control displays, and
        // resolveLocalStrength reads that same value back out. LOCAL ONLY, for
        // the reason written on the curated spec above.
        ...(localGen && p.name === 'strength'
          ? {
              default: SD_IMG2IMG_STRENGTH_DEFAULT,
              description: `How far the render may travel from the reference image. 0 keeps it, 1 ignores it; ${SD_IMG2IMG_STRENGTH_DEFAULT} is the default and only applies while an image is attached above.`,
            }
          : {}),
      })
      continue
    }
    // Everything else: always keep required; otherwise keep when the catalog
    // advertises nothing (curated fallback) OR explicitly advertises this param.
    if (p.required || !hasSupported || isAdvertised(p.name)) out.push(p)
  }
  // The VIDEO schema never had steps / cfg / sampler at all — they are cloud
  // video's business nowhere and sd-cli's business everywhere, and the local
  // route forwards all three. Without the specs the performance preset writes
  // numbers into a bag with no control to show them, which is the D2 display
  // bug in its purest form. Appended (advanced) for LOCAL video rows only, from
  // the image schema's own definitions so the two stay one control.
  if (localGen && modality === 'video') {
    const img = CURATED_SCHEMA.image
    const tpl = (name: string): ParamSpec | undefined => img.find(s => s.name === name)
    const steps = tpl('steps')
    if (steps) out.push({ ...steps, advanced: true, min: localGen.steps.min, max: localGen.steps.max, default: localGen.steps.default })
    const cfg = tpl('cfg')
    if (cfg && localGen.cfg) out.push({ ...cfg, advanced: true, min: localGen.cfg.min, max: localGen.cfg.max, default: localGen.cfg.default })
    const sampler = tpl('sampler')
    if (sampler) out.push({ ...sampler, advanced: true, enum: [...localGen.sampler.enum], default: localGen.sampler.default })
  }
  // ── THE TWO-PASS (highres fix) ─────────────────────────────────────────────
  //
  // LOCAL IMAGE ONLY, and not because cloud providers would mind: `--hires` is a
  // stable-diffusion.cpp feature. It runs the low-res sample, upscales the LATENT
  // and re-denoises it INSIDE THE SAME INVOCATION — one model load, one VAE
  // decode, and the second pass reads the first one's latent instead of a
  // re-encoded PNG. That is why it beats the "generate small, then img2img big"
  // loop the app could already express by hand (WORKFLOWS-RESEARCH §2).
  //
  // TWO CONTROLS, NOT NINE. The engine also takes --hires-steps,
  // --hires-denoising-strength, --hires-upscaler, --hires-sigmas and a tile size;
  // every one of them has an upstream default that is the right answer for a
  // first pass, and a control whose only job is to re-type a default is a control
  // that has to be explained forever. The toggle and the factor are what change
  // the picture.
  if (localGen && modality === 'image') {
    out.push({
      name: 'hires', label: 'Two-pass detail (hires fix)', kind: 'boolean', default: false, advanced: true,
      // Driver measurement (checkpoint-B, speed A/B): a 2x pass ran 4.2x, not
      // 2x — the second pass upscales BOTH dimensions, so its pixel count (and
      // roughly its cost) tracks the SQUARE of the scale factor, not the factor
      // itself. "Roughly doubles" was the honest-sounding number that was
      // actually the biggest understatement this control could make.
      description: `Sample at the size below, then upscale and re-denoise in the same run — sharper detail than rendering large in one pass, and without the duplicated subjects a big single pass produces. Cost tracks the SQUARE of the scale factor below, not the factor itself: at the default ${SD_HIRES_SCALE_DEFAULT}x scale, expect roughly ${SD_HIRES_SCALE_DEFAULT * SD_HIRES_SCALE_DEFAULT}x the render time and peak memory — not ${SD_HIRES_SCALE_DEFAULT}x.`,
    })
    out.push({
      name: 'hires_scale', label: 'Two-pass scale', kind: 'number', advanced: true,
      min: SD_HIRES_SCALE_MIN, max: SD_HIRES_SCALE_MAX, step: SD_HIRES_SCALE_STEP, default: SD_HIRES_SCALE_DEFAULT,
      description: `How much bigger the second pass finishes. Only applies while Two-pass detail is on: at this checkpoint's native ${localGen.native} a ${SD_HIRES_SCALE_DEFAULT}x pass ends at ${scaledSizeLabel(localGen.native, SD_HIRES_SCALE_DEFAULT)}.`,
    })
  }
  // ── THE REFERENCE IMAGE (IP-Adapter) ───────────────────────────────────────
  //
  // LOCAL IMAGE ONLY, and only where the weights are ON DISK. The gate is
  // installedIpAdapterForFamily — the SAME lookup sdArgEnvFor makes — so a control
  // that appears is a control whose flags will really go out. Offering it against
  // an absent 43 MB file would be the inert-download class one layer up: the user
  // attaches a picture, waits out a render, and gets a text-only image.
  //
  // Two controls: the picture and how strongly it counts. The engine also takes
  // ControlNet alongside this (upstream's own combined example), and that is a
  // separate feature with separate weights — not a knob to bury here.
  if (localGen && modality === 'image') {
    const ip = installedIpAdapterForFamily(localGen.family, modelId)
    if (ip) {
      out.push({
        name: 'ip_adapter_image', label: 'Reference image (style / subject)', kind: 'image', advanced: true,
        description: 'Attach a picture and its subject and style are carried into what you generate, alongside your words. This is not a starting image: the picture you attach is never redrawn, so you can keep a character and change the pose.',
      })
      out.push({
        name: 'ip_adapter_strength', label: 'Reference strength', kind: 'number', advanced: true,
        min: SD_IP_ADAPTER_STRENGTH_MIN, max: SD_IP_ADAPTER_STRENGTH_MAX,
        step: SD_IP_ADAPTER_STRENGTH_STEP, default: SD_IP_ADAPTER_STRENGTH_DEFAULT,
        description: `How much the reference counts against your words. Lower lets the text lead; ${SD_IP_ADAPTER_STRENGTH_DEFAULT} is the default and only applies while a reference image is attached above.`,
      })
    }
  }
  // ── CLIP SKIP ──────────────────────────────────────────────────────────────
  //
  // "The #1 why-does-it-look-wrong complaint waiting" for Civitai SD 1.5 merges:
  // a great many of them (anime-class ones especially) were finetuned with the
  // last CLIP layer skipped, and rendering them at layer 1 gives flat, washed-out
  // output that reads as a bad model rather than a wrong setting.
  //
  // ONLY WHERE THERE IS A CLIP TO SKIP. `--clip-skip` counts layers of the CLIP
  // text encoder, so it means something on sd15 / sdxl (clip_l, clip_g) and
  // NOTHING on the rows that condition on a T5 or an LLM — Z-Image goes through
  // `--llm`, Wan through umt5, LTX through Gemma. Offering it there would mint a
  // fresh dead control while removing one.
  //
  // DEFAULT 0 = the engine's own "unspecified" (`--help`: "<= 0 represents
  // unspecified, will be 1 for SD1.x, 2 for SD2.x"), so nothing changes for
  // anyone who does not touch it, and no curated row pre-sets a value.
  if (localGen && modality === 'image' && CLIP_SKIP_FAMILIES.has(localGen.family)) {
    out.push({
      name: 'clip_skip', label: 'CLIP skip', kind: 'int', advanced: true,
      min: 0, max: SD_CLIP_SKIP_MAX, step: 1, default: 0,
      description: `How many of the text encoder's last layers to ignore. 0 leaves it to the engine (1 for SD 1.x). Many Civitai SD 1.5 merges — anime ones especially — were trained at 2 and look flat and washed out at 1; if a checkpoint's own page names a CLIP skip, this is where it goes.`,
    })
  }
  // ── THE MEMORY LADDER: the flags that decide whether it runs at all ────────
  //
  // Every one of these existed in the engine and in the research and in NO
  // control, so the committed 8 GB recipe (`--max-vram -1 --stream-layers
  // --clip-on-cpu --vae-tiling`) was a sentence in a file rather than something a
  // user could ask for. They are the difference between "sd-cli was reaped
  // mid-render after 40 minutes and produced nothing" and a finished clip.
  //
  // ALL OFF BY DEFAULT and behind the Advanced disclosure: each one trades
  // something (time, a tile seam, the app's own device placement), and a memory
  // strategy switched on behind the user's back is how a render silently gets
  // slower. The descriptions say what is traded, not just what is gained.
  if (localGen) {
    out.push({
      name: 'vae_tiling', label: 'Tile the VAE decode', kind: 'boolean', default: false, advanced: true,
      description: `Decode the picture in tiles instead of all at once. This is the flag that turns an out-of-memory death in the final decode into a finished render — on video it is the step that actually gets killed. Costs a little time and can leave faint seams between tiles.`,
    })
    out.push({
      name: 'vae_conv_direct', label: 'Direct VAE convolutions', kind: 'boolean', default: false, advanced: true,
      description: `Use the direct convolution path in the autoencoder. Lower peak memory in the decode for the same maths — try it before tiling, since it has no seams to trade.`,
    })
    out.push({
      name: 'max_vram', label: 'VRAM budget', kind: 'enum', default: 'off', advanced: true,
      enum: [...SD_MAX_VRAM_OPTIONS],
      description: `Split each forward pass so the model does not have to fit in video memory at once — the engine's own answer to a model that is bigger than the card. "auto" uses the free VRAM the driver reports, keeping ${Math.abs(SD_MAX_VRAM_AUTO)} GiB spare; a number is a hard budget in GiB. Off means no splitting, which is what every run has done until now.`,
    })
    out.push({
      name: 'stream_layers', label: 'Stream layers', kind: 'boolean', default: false, advanced: true,
      description: `Keep only the layers in use resident and prefetch the next ones — the rung after the budget on upstream's own ladder. It needs a VRAM budget set above, and it needs the model's weights held in RAM, which this turns on for you. Auto-fit below takes that placement back, so the two cannot both be on: with auto-fit the engine decides, and this is left off.`,
    })
    out.push({
      name: 'auto_fit', label: 'Auto-fit to this machine', kind: 'boolean', default: false, advanced: true,
      description: `Let the engine place the diffusion model, the text encoder and the autoencoder itself, from the model's size and the memory each device has free. It replaces the app's own placement (including keeping the text encoders on the CPU) and may split the model across more than one GPU.`,
    })
  }
  // ── THE SPEED TOGGLE ───────────────────────────────────────────────────────
  //
  // Present ONLY when this row's curated distill pack is fully on disk, and
  // DEFAULT ON: someone who downloaded a speed pack for a model asked for the
  // fast path, and a default that made them find a switch afterwards would be
  // the slow render they complained about, one click further away.
  //
  // Default-on is honest here only because the control is VISIBLE and says what
  // it costs. The three things it changes that the user can otherwise see —
  // Steps, Guidance, and whether the negative prompt does anything — are all
  // named in this one description rather than left to be discovered from a
  // render that came out different.
  if (localVid?.speed) {
    out.push({
      name: 'speed_mode', label: 'Speed (distilled)', kind: 'boolean', default: true, advanced: false,
      description: `${localVid.speed.name} is installed: ${localVid.speed.steps} steps at guidance 1 instead of ${localVid.speed.vanillaSteps} — roughly ten times fewer passes through the model, because guidance 1 also skips the second pass on every step. It runs at those numbers whatever the Steps and Guidance controls below say, and at guidance 1 the negative prompt has no effect. The trade is real: distilled weights give up some motion range and fine detail against the same model run the slow way. Turn it off for the model's own full-quality recipe.`,
    })
  }
  return out
}

// ─── Shared fetch / error helpers ─────────────────────────────────────────────

function requireKey(): string {
  const key = retrieveKey('surplus')
  if (!key) {
    throw new Error(
      'No Surplus key configured. Add a key and fund USDC in Settings → Surplus (link: /buy).',
    )
  }
  return key
}

/** Turn a non-OK response into a friendly Error, surfacing 402 verbatim. */
async function toFriendlyError(res: Response): Promise<Error> {
  const bodyText = await res.text().catch(() => '')
  let message = bodyText
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string }
    message = (typeof j.error === 'object' ? j.error?.message : j.error) || j.message || bodyText
  } catch { /* keep raw text */ }
  if (res.status === 402) {
    return new Error(`Payment required (402) — insufficient funds. ${message || 'Fund USDC on Surplus to continue.'}`)
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`Surplus auth failed (${res.status}). Check your key. ${message}`)
  }
  return new Error(`Surplus media HTTP ${res.status}: ${message || res.statusText}`)
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization:     `Bearer ${requireKey()}`,
    'Accept-Encoding': 'identity',
    ...extra,
  }
}

/**
 * Merge schema-driven extra params into a request body, DEFENSIVELY:
 *   - never overrides a key the engine already set (typed fields win),
 *   - never lets a caller override `model`,
 *   - drops empty values (''/null/undefined/NaN) so we only send what's set.
 * Mutates and returns `body` for chaining.
 */
function mergeExtraParams(body: Record<string, unknown>, params?: ExtraParams): Record<string, unknown> {
  if (!params) return body
  for (const [key, value] of Object.entries(params)) {
    if (key === 'model') continue
    if (key in body) continue
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    if (typeof value === 'number' && Number.isNaN(value)) continue
    body[key] = value
  }
  return body
}

// ─── Disk helpers ─────────────────────────────────────────────────────────────

function mediaRoot(): string {
  return storageDir('media')  // user-visible Media folder (legacy userData/media still served read-only)
}

/** Strip path separators / traversal from gateway-supplied ids. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_') || 'job'
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif':  'gif',
  'audio/mpeg': 'mp3',
  'audio/mp3':  'mp3',
  'audio/wav':  'wav',
  'audio/x-wav':'wav',
  'audio/ogg':  'ogg',
  'audio/opus': 'opus',
  'audio/aac':  'aac',
  'audio/flac': 'flac',
  'video/mp4':  'mp4',
  'video/webm': 'webm',
}

function extFor(mime: string, fallback: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  return EXT_BY_MIME[base] ?? fallback
}

function kindFor(mime: string): Artifact['kind'] {
  const base = mime.split(';')[0].trim().toLowerCase()
  if (base.startsWith('image/')) return 'image'
  if (base.startsWith('audio/')) return 'audio'
  if (base.startsWith('video/')) return 'video'
  return 'text'
}

/**
 * Write bytes to <storage root>/Media/<jobId>/<index>.<ext>; return the absolute
 * path ACTUALLY written. writeStorageFile, not a bare writeFileSync: a root that
 * turned unwritable mid-session (Defender Controlled Folder Access on Documents
 * — LANE J/L) is re-probed once and the write retried against the healed root,
 * so a finished generation is never lost to a raw ENOENT.
 */
function writeArtifactBytes(jobId: string, index: number, bytes: Uint8Array, mime: string, extFallback: string): string {
  const ext = extFor(mime, extFallback)
  return writeStorageFile('media', join(sanitizeId(jobId), `${index}.${ext}`), bytes)
}

function copyToDir(srcPath: string, destDir: string): string {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  const base = srcPath.split(/[\\/]/).pop() || 'artifact'
  const dest = join(destDir, base)
  copyFileSync(srcPath, dest)
  return dest
}

// ─── Sync: image generation ───────────────────────────────────────────────────

export async function generateImage(input: GenerateImageInput): Promise<GenerateResult> {
  const provider = input.provider === 'venice' ? 'venice' : 'surplus'
  enforceProviderEgress(provider)
  const body: Record<string, unknown> = {
    model:           input.model,
    prompt:          input.prompt,
    response_format: 'b64_json',
  }
  if (input.size) body.size = input.size
  if (input.n)    body.n = input.n
  // Schema-driven extras (negative_prompt, seed, steps, cfg, sampler, strength,
  // aspect_ratio, image_url, …) merged in defensively — typed fields above win.
  mergeExtraParams(body, input.params)

  // Surplus and Venice both expose an OpenAI-compatible /images/generations with
  // the same { data:[{b64_json|url}] } response — only the base URL + key differ.
  const base = provider === 'venice' ? VENICE_MEDIA_BASE : SURPLUS_BASE_URL
  const veniceKey = provider === 'venice' ? retrieveKey('venice') : null
  const headers = provider === 'venice'
    ? {
        'Content-Type':    'application/json',
        Accept:            'application/json',
        'Accept-Encoding': 'identity',
        ...(veniceKey ? { Authorization: `Bearer ${veniceKey}` } : {}),
      }
    : authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' })

  const res = await fetch(`${base}/images/generations`, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  })
  if (!res.ok) throw await toFriendlyError(res)

  const json = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> }
  const data = Array.isArray(json.data) ? json.data : []
  const jobId = `img-${Date.now()}`
  const artifacts: Artifact[] = []

  for (let i = 0; i < data.length; i++) {
    const item = data[i]
    if (item.b64_json) {
      const bytes = Buffer.from(item.b64_json, 'base64')
      const path  = writeArtifactBytes(jobId, i, bytes, 'image/png', 'png')
      artifacts.push({ kind: 'image', mimeType: 'image/png', path, b64: item.b64_json })
    } else if (item.url) {
      const fetched = await fetchBinary(item.url)
      const path    = writeArtifactBytes(jobId, i, fetched.bytes, fetched.mime, 'png')
      const small   = fetched.bytes.byteLength <= 512 * 1024
      artifacts.push({
        kind:     'image',
        mimeType: fetched.mime,
        path,
        ...(small ? { b64: Buffer.from(fetched.bytes).toString('base64') } : {}),
      })
    }
  }

  if (input.autoSaveDir) {
    for (const a of artifacts) if (a.path) copyToDir(a.path, input.autoSaveDir)
  }
  return { artifacts }
}

// ─── Sync: text-to-speech (binary audio) ───────────────────────────────────────

export async function generateSpeech(input: GenerateSpeechInput): Promise<GenerateResult> {
  const provider = input.provider === 'venice' ? 'venice' : 'surplus'
  enforceProviderEgress(provider)
  const format = input.format || 'mp3'
  const body: Record<string, unknown> = {
    model:           input.model,
    input:           input.input,
    response_format: format,
  }
  if (input.voice) body.voice = input.voice
  if (typeof input.speed === 'number') body.speed = input.speed
  // Schema-driven extras merged in defensively. Note `response_format` is already
  // set from `format`, so a duplicate in params is ignored (mergeExtraParams skips
  // keys already present) — keeping the on-disk extension correct.
  mergeExtraParams(body, input.params)

  // Surplus + Venice share the OpenAI-compatible /audio/speech path — swap base+key.
  const base = provider === 'venice' ? VENICE_MEDIA_BASE : SURPLUS_BASE_URL
  const vKey = provider === 'venice' ? retrieveKey('venice') : null
  const headers = provider === 'venice'
    ? { 'Content-Type': 'application/json', Accept: 'audio/*', 'Accept-Encoding': 'identity', ...(vKey ? { Authorization: `Bearer ${vKey}` } : {}) }
    : authHeaders({ 'Content-Type': 'application/json', Accept: 'audio/*' })

  const res = await fetch(`${base}/audio/speech`, {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  })
  if (!res.ok) throw await toFriendlyError(res)

  const mime  = res.headers.get('content-type') || mimeForAudioFormat(format)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const jobId = `tts-${Date.now()}`
  const path  = writeArtifactBytes(jobId, 0, bytes, mime, format)
  const artifact: Artifact = { kind: 'audio', mimeType: mime, path }

  if (input.autoSaveDir) copyToDir(path, input.autoSaveDir)
  return { artifacts: [artifact] }
}

function mimeForAudioFormat(format: string): string {
  switch (format) {
    case 'mp3':  return 'audio/mpeg'
    case 'opus': return 'audio/opus'
    case 'aac':  return 'audio/aac'
    case 'flac': return 'audio/flac'
    case 'wav':  return 'audio/wav'
    case 'pcm':  return 'audio/wav'
    default:     return 'audio/mpeg'
  }
}

// ─── Sync: speech-to-text (multipart upload) ───────────────────────────────────

export async function transcribe(input: TranscribeInput): Promise<{ text: string }> {
  const provider = input.provider === 'venice' ? 'venice' : 'surplus'
  enforceProviderEgress(provider)

  let bytes: Uint8Array
  let fileName: string
  if (input.audioBytes) {
    bytes    = input.audioBytes
    fileName = input.fileName || 'audio.wav'
  } else if (input.audioPath) {
    if (!existsSync(input.audioPath)) throw new Error(`Audio file not found: ${input.audioPath}`)
    bytes    = new Uint8Array(readFileSync(input.audioPath))
    fileName = input.audioPath.split(/[\\/]/).pop() || 'audio.wav'
  } else {
    throw new Error('transcribe: provide audioPath or audioBytes')
  }

  // MULTIPART/form-data is REQUIRED — a JSON body returns "Invalid multipart form data".
  const form = new FormData()
  form.append('file', new Blob([bytes as BlobPart]), fileName)
  form.append('model', input.model)
  if (input.language) form.append('language', input.language)
  if (input.prompt)   form.append('prompt', input.prompt)
  // Schema-driven extras (response_format, translate, …) appended defensively.
  // Skip the keys we already set + `model`, drop empties, and stringify scalars
  // (FormData only takes strings/Blobs). A `file` param is ignored here — the
  // audio comes from audioPath/audioBytes above.
  if (input.params) {
    const skip = new Set(['model', 'file', 'language', 'prompt'])
    for (const [key, value] of Object.entries(input.params)) {
      if (skip.has(key)) continue
      if (value === undefined || value === null) continue
      if (typeof value === 'boolean') { if (value) form.append(key, 'true') ; continue }
      const s = String(value)
      if (s.trim() === '') continue
      form.append(key, s)
    }
  }

  // Do NOT set Content-Type — fetch derives the multipart boundary from FormData.
  const base    = provider === 'venice' ? VENICE_MEDIA_BASE : SURPLUS_BASE_URL
  const authKey = provider === 'venice' ? (retrieveKey('venice') ?? '') : requireKey()
  const res = await fetch(`${base}/audio/transcriptions`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${authKey}`, 'Accept-Encoding': 'identity' },
    body:    form,
  })
  if (!res.ok) throw await toFriendlyError(res)

  const json = await res.json() as { text?: string }
  return { text: json.text ?? '' }
}

// ─── Async: video / music submit + poll ───────────────────────────────────────

export async function submitVideo(input: SubmitJobInput): Promise<SubmitResult> {
  return submitAsync('video', input)
}

export async function submitMusic(input: SubmitJobInput): Promise<SubmitResult> {
  return submitAsync('music', input)
}

async function submitAsync(kind: 'video' | 'music', input: SubmitJobInput): Promise<SubmitResult> {
  enforceProviderEgress('surplus')
  const body: Record<string, unknown> = { model: input.model, prompt: input.prompt }
  if (input.lyrics)     body.lyrics = input.lyrics
  if (input.duration)   body.duration = input.duration
  if (input.resolution) body.resolution = input.resolution
  // Schema-driven extras (negative_prompt, aspect_ratio, image_url, seed, genre,
  // instrumental, …) merged in defensively — typed fields above win.
  mergeExtraParams(body, input.params)

  const res = await fetch(`${SURPLUS_BASE_URL}/${kind}/generations`, {
    method:  'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body:    JSON.stringify(body),
  })
  if (!res.ok) throw await toFriendlyError(res)

  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  // DIAGNOSTIC: surface exactly what Surplus returns for an async submit so we
  // can pin the real job-id field + shape (Venice's media API is undocumented).
  console.log(`[surplus-media] submit ${kind} http=${res.status} body=${JSON.stringify(json).slice(0, 800)}`)

  // Job-id field name is undocumented — read every plausible alias (id/jobId/
  // request_id/task_id), including one level of nesting under `data`.
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) { const v = json[k]; if (typeof v === 'string' && v) return v }
    const data = json.data as Record<string, unknown> | undefined
    if (data && typeof data === 'object') for (const k of keys) { const v = data[k]; if (typeof v === 'string' && v) return v }
    return undefined
  }
  const jobId = pick('id', 'jobId', 'job_id', 'request_id', 'requestId', 'task_id', 'taskId')
  if (!jobId) throw new Error(`Surplus ${kind} submit returned no job id. Raw: ${JSON.stringify(json).slice(0, 400)}`)

  // Capture a per-job token if present (header OR body) so poll/artifact can
  // authorize with X-Job-Token when the Bearer key alone is insufficient.
  const token = res.headers.get('x-job-token') || res.headers.get('X-Job-Token')
    || (typeof json.token === 'string' ? json.token : undefined)
    || (typeof json['x-job-token'] === 'string' ? json['x-job-token'] as string : undefined)
    || (typeof json.job_token === 'string' ? json.job_token as string : undefined)
  jobMeta.set(jobId, { kind, token: token || undefined })
  return { jobId }
}

// In-memory map of jobId → { kind, token } captured at submit time. Used so
// pollJob / saveArtifact know which endpoint family to hit and which job token
// to present. Lost on app restart (acceptable: re-submit on restart).
const jobMeta = new Map<string, { kind: 'video' | 'music'; token?: string }>()

function jobAuthHeaders(jobId: string): Record<string, string> {
  const meta = jobMeta.get(jobId)
  const headers: Record<string, string> = {
    Authorization:     `Bearer ${requireKey()}`,
    'Accept-Encoding': 'identity',
  }
  if (meta?.token) headers['X-Job-Token'] = meta.token
  return headers
}

function normalizeStatus(raw: unknown): MediaJobStatus {
  const s = String(raw ?? '').toLowerCase()
  if (/(queued|pending|waiting|submitted)/.test(s)) return 'queued'
  if (/(processing|in_progress|running|started)/.test(s)) return 'processing'
  if (/(succeeded|completed|complete|success|done|ready)/.test(s)) return 'succeeded'
  if (/(failed|error|cancell?ed|rejected)/.test(s)) return 'failed'
  return 'unknown'
}

/**
 * Poll a single time and return the current job state. The caller drives the
 * loop (so the renderer can show progress); pollMediaJobUntilSettled() below is
 * a convenience wrapper that loops with the 5-minute cap.
 *
 * Poll route (CONFIRMED): GET /<kind>/generations/{id} — same path as submit.
 */
export async function pollMediaJob(jobId: string): Promise<MediaJobResult> {
  enforceProviderEgress('surplus')
  const meta = jobMeta.get(jobId)
  const kind = meta?.kind ?? 'video'

  const res = await fetch(`${SURPLUS_BASE_URL}/${kind}/generations/${encodeURIComponent(jobId)}`, {
    method:  'GET',
    headers: jobAuthHeaders(jobId),
  })
  if (!res.ok) throw await toFriendlyError(res)

  const json = await res.json() as {
    status?:   string
    state?:    string
    progress?: number
    error?:    string
    artifacts?: Array<{ index?: number }>
    data?:      unknown[]
    output?:    unknown[]
  }
  const status = normalizeStatus(json.status ?? json.state)
  // DIAGNOSTIC: log each poll so we can see the real status field/values + when
  // (if ever) the gateway flips to a terminal/artifact-bearing response.
  console.log(`[surplus-media] poll ${kind} ${jobId} http=${res.status} status=${String(json.status ?? json.state ?? '(none)')} -> ${status} body=${JSON.stringify(json).slice(0, 600)}`)
  const result: MediaJobResult = { jobId, status }
  if (typeof json.progress === 'number') result.progress = json.progress
  // The gateway's `error` may be a string OR an object ({type,message}); always
  // store a STRING (an object here later crashes React when rendered).
  if (json.error != null) {
    const e = json.error as unknown
    result.error = typeof e === 'string'
      ? e
      : (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string')
        ? (e as { message: string }).message
        : JSON.stringify(e)
  }

  if (status === 'succeeded') {
    // Determine artifact count from whatever array the gateway returned (lenient).
    const count =
      (Array.isArray(json.artifacts) ? json.artifacts.length : 0) ||
      (Array.isArray(json.data) ? json.data.length : 0) ||
      (Array.isArray(json.output) ? json.output.length : 0) ||
      1
    const artifacts: Artifact[] = []
    for (let i = 0; i < count; i++) {
      try {
        artifacts.push(await fetchArtifact(jobId, i, kind))
      } catch {
        break  // stop at the first missing index
      }
    }
    result.artifacts = artifacts
  }
  return result
}

/**
 * Convenience: poll until the job settles (succeeded/failed) or the 5-minute
 * cap elapses. Returns the LAST observed state on timeout (status may still be
 * queued/processing — the caller can re-poll). `onTick` receives intermediate
 * states for progress UI.
 */
export async function pollMediaJobUntilSettled(
  jobId: string,
  onTick?: (state: MediaJobResult) => void,
): Promise<MediaJobResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let last: MediaJobResult = { jobId, status: 'queued' }
  while (Date.now() < deadline) {
    last = await pollMediaJob(jobId)
    onTick?.(last)
    if (last.status === 'succeeded' || last.status === 'failed') return last
    await delay(POLL_INTERVAL_MS)
  }
  return last  // timed out — return last status (likely queued/processing)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Artifact retrieval / save ─────────────────────────────────────────────────

/**
 * Fetch artifact bytes from GET /media/artifacts/{jobId}/{index}. The body is
 * either RAW BINARY or a 302 redirect to a signed URL — handle BOTH. Writes to
 * <storage root>/Media/<jobId>/<index>.<ext> and returns the Artifact.
 */
async function fetchArtifact(jobId: string, index: number, kind: 'video' | 'music'): Promise<Artifact> {
  const url = `${SURPLUS_BASE_URL}/media/artifacts/${encodeURIComponent(jobId)}/${index}`
  const res = await fetch(url, {
    method:   'GET',
    headers:  jobAuthHeaders(jobId),
    redirect: 'follow',  // transparently follow a 302 → signed URL
  })
  console.log(`[surplus-media] artifact ${kind} ${jobId}/${index} http=${res.status} type=${res.headers.get('content-type') ?? '(none)'} len=${res.headers.get('content-length') ?? '?'}`)
  if (!res.ok) throw await toFriendlyError(res)

  const mime  = res.headers.get('content-type') || (kind === 'video' ? 'video/mp4' : 'audio/mpeg')
  const bytes = new Uint8Array(await res.arrayBuffer())
  const fallbackExt = kind === 'video' ? 'mp4' : 'mp3'
  const path  = writeArtifactBytes(jobId, index, bytes, mime, fallbackExt)
  return { kind: kindFor(mime), mimeType: mime, path }
}

/** Fetch arbitrary binary (used for image `url` response_format). */
async function fetchBinary(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await fetch(url, { headers: { 'Accept-Encoding': 'identity' }, redirect: 'follow' })
  if (!res.ok) throw await toFriendlyError(res)
  const mime  = res.headers.get('content-type') || 'application/octet-stream'
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { bytes, mime }
}

/**
 * Copy a previously-produced artifact into a user-chosen folder. Either the
 * artifact was downloaded during polling (look it up on disk under its jobId)
 * or an explicit srcPath is supplied.
 */
export async function saveArtifact(input: SaveArtifactInput): Promise<SaveResult> {
  let src = input.srcPath
  if (!src) {
    const dir = join(mediaRoot(), sanitizeId(input.jobId))
    // We don't know the extension here; pick the first matching <index>.* file.
    src = findArtifactOnDisk(dir, input.index)
  }
  if (!src || !existsSync(src)) {
    throw new Error(`Artifact not found for job ${input.jobId} index ${input.index}`)
  }
  const path = copyToDir(src, input.destDir)
  return { path }
}

function findArtifactOnDisk(dir: string, index: number): string | undefined {
  if (!existsSync(dir)) return undefined
  // Cheap exact-extension probe across known media extensions.
  const exts = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp3', 'wav', 'ogg', 'opus', 'aac', 'flac', 'mp4', 'webm']
  for (const ext of exts) {
    const candidate = join(dir, `${index}.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

// ─── Embeddings (low priority, sync) ──────────────────────────────────────────

export interface EmbeddingsInput  { model: string; input: string | string[] }
export interface EmbeddingsResult { embeddings: number[][]; model: string }

export async function createEmbeddings(input: EmbeddingsInput): Promise<EmbeddingsResult> {
  enforceProviderEgress('surplus')
  const res = await fetch(`${SURPLUS_BASE_URL}/embeddings`, {
    method:  'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
    body:    JSON.stringify({ model: input.model, input: input.input }),
  })
  if (!res.ok) throw await toFriendlyError(res)
  const json = await res.json() as { data?: Array<{ embedding?: number[] }>; model?: string }
  const embeddings = (json.data ?? []).map(d => d.embedding ?? [])
  return { embeddings, model: json.model ?? input.model }
}

export function surplusMediaBaseUrl(): string { return SURPLUS_BASE_URL }
