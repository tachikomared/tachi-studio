// apps/desktop/src/pages/media/localGenParams.ts
//
// THE ONE PLACE THAT TURNS COMPOSER PARAMS INTO sd.cpp ARGUMENTS.
//
// Every function here used to live inside MediaPage.tsx, which made it
// unreachable from the app's SECOND generation surface — the canvas media node,
// whose local branch runs in MAIN (electron/services/graph-to-agentkit.ts) and
// therefore cannot import a React page. That split is the whole reason audit
// D3 exists: `size`, `duration`, `frames` and `negative_prompt` were fixed on
// MediaPage and left broken on the canvas, three bugs deep, in a file whose
// test suite never mentioned the other surface.
//
// So: PURE MODULE, no React, no electron, no window. MediaPage re-exports it
// (its own tests import through that door) and graph-to-agentkit imports it
// directly — the precedent for main reading a pure module out of src/ is
// electron/ipc/graph.ipc.ts importing src/pages/nodes/canvas/codexWriteGate.
//
// ── THE NAME CONTRACT (audit D1) ─────────────────────────────────────────────
//
// The schema names the generation params `steps` / `cfg` / `sampler`
// (surplus-media-service CURATED_SCHEMA — those are also the CLOUD wire names,
// which is why they cannot be renamed). Both local call sites read
// `cfgScale` / `samplingMethod` instead, names nothing but the preset picker
// ever wrote. Result: dragging "Guidance (CFG)" to 12 changed nothing, picking
// a sampler changed nothing, and the slider kept showing the number that did
// not run — the exact class of 73d461c / 2bd48fc, on two more params.
//
// The fix is ONE name at both ends, and the schema's name wins because it is
// also the wire name for every cloud provider. The legacy keys are still READ
// as a fallback: a params bag persisted by an older build (or restored from a
// PNG written by one) holds `cfgScale`, and silently dropping it would trade
// one silent lie for another.

import type { ParamSpec } from '../../types/electron'

// ── Local sd.cpp SIZE plumbing ───────────────────────────────────────────────
//
// The image composer exposes ONE dimension control: `size`, an enum of "WxH"
// STRINGS ("512x512", "1024x1024", …). It has no numeric width/height controls
// at all. The local sd.cpp call used to forward only `typeof params.width ===
// 'number'`, so the picked size was dropped on the floor and every local
// generation came out at the model's baseSize (512 for sd-turbo/sd15) no matter
// what the dropdown said — silently, since nothing errors on a missing -W/-H.
//
// Parsed values are snapped to a 64px grid and clamped to the range the curated
// tiers span. 64 is the coarsest divisor stable-diffusion.cpp has required, and
// it is a NO-OP for every value the dropdown can produce — every square tier
// (512/768/1024/1536/2048), every ORIENTED pair the local tiers now offer
// (768x512, 896x640, 1216x832, 1792x1280 and their portraits — see
// surplus-media-service's LOCAL_IMAGE_TIERS) and the chat composer's 1024x1792
// pair are all multiples of 64, and none exceeds SD_DIM_MAX. It only rescues a
// hand-edited or remixed param that would otherwise make sd-cli bail. A garbage
// string yields null and the call falls back to the engine default, exactly as
// it did before.
const SD_DIM_MIN  = 64
const SD_DIM_MAX  = 2048
const SD_DIM_STEP = 64

/** Snap one dimension onto sd-cli's 64px grid, clamped to a runnable range. */
function normalizeSdDim(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null
  const snapped = Math.round(n / SD_DIM_STEP) * SD_DIM_STEP
  return Math.min(SD_DIM_MAX, Math.max(SD_DIM_MIN, snapped))
}

/**
 * Parse the composer's `size` param ("1024x1024") into sd-cli dimensions.
 * Returns null for anything that is not a usable WxH pair, so the caller can
 * fall through instead of sending NaN down the IPC.
 */
export function parseSizeParam(raw: unknown): { width: number; height: number } | null {
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d+)\s*[x×X]\s*(\d+)\s*$/.exec(raw)
  if (!m) return null
  const width  = normalizeSdDim(Number(m[1]))
  const height = normalizeSdDim(Number(m[2]))
  if (width === null || height === null) return null
  return { width, height }
}

/**
 * Resolve the dimensions to send to sd.cpp from a run's params.
 *
 * `size` — the control the user can actually SEE — wins. Numeric width/height
 * are the fallback for params that never went through the dropdown (a gallery
 * Remix of a pre-fix entry, a restore whose exact WxH is not a curated tier).
 * Returns {} when neither is usable, which keeps the engine's baseSize default.
 */
export function resolveLocalSdSize(params: Record<string, unknown>): { width?: number; height?: number } {
  const fromSize = parseSizeParam(params.size)
  if (fromSize) return fromSize
  const width  = typeof params.width  === 'number' ? normalizeSdDim(params.width)  : null
  const height = typeof params.height === 'number' ? normalizeSdDim(params.height) : null
  if (width === null || height === null) return {}
  return { width, height }
}

// ── Local Wan VIDEO size plumbing ────────────────────────────────────────────
//
// The SAME defect as the image `size` bug above, one modality over. The video
// composer's dimension controls are `resolution` ('480p'|'720p'|'1080p') and
// `aspect_ratio` ('16:9'|'9:16'|'1:1') — the video schema declares NO numeric
// width/height at all — yet the local Wan call forwarded only
// `typeof runParams.width === 'number'`, so both pickers were dropped on the
// floor and every local render came out at sd-cpp-client's model-row fallback
// (832x480) no matter what the UI said.
//
// The grid here is 16px, NOT the image path's 64. Wan's VAE compresses 8x
// spatially and the DiT patchifies 2x2 on top, so pixel dims must be multiples
// of 16 — and 480 is NOT a multiple of 64, so reusing normalizeSdDim would snap
// the model's own native height to 512 and corrupt the one size it is sure of.
const WAN_DIM_MIN  = 128
const WAN_DIM_MAX  = 1280
const WAN_DIM_STEP = 16

/**
 * Wan 2.1's real size table (upstream SIZE_CONFIGS), by resolution label ×
 * orientation. 1080p is deliberately absent: it is not a Wan 2.1 size, so a
 * '1080p' param resolves to null and the model's native size stands instead of
 * the app inventing an untrained resolution.
 */
const WAN_SIZES: Record<string, { landscape: [number, number]; portrait: [number, number] }> = {
  '480p': { landscape: [832, 480],  portrait: [480, 832]  },
  '720p': { landscape: [1280, 720], portrait: [720, 1280] },
}

/** Snap one dimension onto Wan's 16px grid, clamped to a runnable range. */
function normalizeWanDim(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null
  const snapped = Math.round(n / WAN_DIM_STEP) * WAN_DIM_STEP
  return Math.min(WAN_DIM_MAX, Math.max(WAN_DIM_MIN, snapped))
}

/**
 * Orientation implied by a "W:H" aspect string. A SQUARE ratio yields null on
 * purpose: no Wan 2.1 variant lists a square size, so 1:1 must fall back to the
 * model's native pair rather than silently render at an untrained shape.
 */
function orientationOf(raw: unknown): 'landscape' | 'portrait' | null {
  if (typeof raw !== 'string') return null
  const m = /^\s*(\d+)\s*[:x×X/]\s*(\d+)\s*$/.exec(raw)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (!w || !h || w === h) return null
  return w > h ? 'landscape' : 'portrait'
}

/**
 * Map the composer's VISIBLE video controls onto Wan pixel dimensions.
 * Returns null for anything outside Wan's supported set, so the caller can fall
 * through to the model's native size instead of sending NaN down the IPC.
 */
export function parseVideoSizeParams(
  resolution: unknown,
  aspectRatio: unknown,
): { width: number; height: number } | null {
  if (typeof resolution !== 'string') return null
  const row = WAN_SIZES[resolution.trim().toLowerCase()]
  if (!row) return null
  const orient = orientationOf(aspectRatio)
  if (!orient) return null
  const [width, height] = row[orient]
  return { width, height }
}

/**
 * Resolve the dimensions to send to `sd-cli -M vid_gen` from a run's params.
 *
 * `resolution` + `aspect_ratio` — the controls the user can actually SEE — win.
 * `offered` is the resolution enum the LIVE schema advertises for the selected
 * model: composer params are persisted per MODALITY, not per provider, so a
 * '1080p' (or '720p') left over from a cloud run must not out-vote the installed
 * checkpoint's capability — when the stale value isn't offered we fall to the
 * smallest tier the model does support. Numeric width/height are the fallback
 * for params that never went through the pickers (a hand-edited bag, a Remix of
 * a pre-fix entry). Returns {} when nothing is usable, which keeps the model
 * row's native size in sd-cpp-client.
 */
export function resolveLocalWanSize(
  params: Record<string, unknown>,
  offered?: readonly string[],
): { width?: number; height?: number } {
  const wanted = typeof params.resolution === 'string' ? params.resolution : ''
  const resolution = offered && offered.length > 0 && !offered.includes(wanted) ? offered[0] : wanted
  const fromPickers = parseVideoSizeParams(resolution, params.aspect_ratio)
  if (fromPickers) return fromPickers
  const width  = typeof params.width  === 'number' ? normalizeWanDim(params.width)  : null
  const height = typeof params.height === 'number' ? normalizeWanDim(params.height) : null
  if (width === null || height === null) return {}
  return { width, height }
}

// ── Local Wan VIDEO time plumbing ────────────────────────────────────────────
//
//  • THE FRAME RATE IS PER CHECKPOINT. Wan 2.1 generates at 16 fps — the rate
//    upstream's own generate.py writes its clips at — and Wan 2.2 TI2V-5B
//    generates at 24. So seconds↔frames is frames = fps × seconds, and `fps`
//    has to arrive from somewhere: it rides on the `duration` ParamSpec that
//    surplus-media-service builds from the model row, which is the one object
//    BOTH local surfaces already pass into resolveLocalWanFrames. WAN_FPS below
//    is the FALLBACK for a bag with no schema behind it, not the law.
//    (sd-cli's muxer defaults to `--fps 24`, so the client must pass the row's
//    rate explicitly or a 16 fps clip plays 1.5x fast — see sd-cpp-client.)
//  • Frame counts must be `grid*n + 1`, and THE GRID IS PER CHECKPOINT TOO.
//    A video VAE compresses the temporal axis with the first frame kept whole,
//    so F frames become (F-1)/grid + 1 latents. Wan compresses 4x; LTX-AV
//    compresses 8x, and the pinned engine branches on exactly that
//    (video_frames_to_latent_frames). It rides in on the same `duration` spec
//    as `fps`, for the same reason: both local surfaces already hand that spec
//    to resolveLocalWanFrames, so neither call site has to learn a new
//    argument. WAN_FRAME_GRID below is the FALLBACK for a bag with no schema
//    behind it, not the law. This part IS fps-independent.
//  • The ceiling is 81 FRAMES — upstream's own `--frame_num` default and the
//    length Wan 2.1 was trained on. In seconds that is ~5 s at 16 fps and ~3.4 s
//    at 24, which is why the cap lives in frames and the slider bound is
//    derived from the row.
const WAN_FPS = 16
/** The temporal compression of every Wan checkpoint, and the fallback for a
 *  params bag with no schema behind it. LTX-AV is 8 — see the block above. */
const WAN_FRAME_GRID = 4
/** Upstream Wan 2.1's own `--frame_num` default and trained clip length — and
 *  the ~80-frame consistency ceiling an unpatched Wan starts drifting past
 *  (LOWVRAM-META-RESEARCH DELTA ADDENDUM, "FLF CHAINING"). Exported because the
 *  flow-doctor warns about chained segments that ask for more, and both surfaces
 *  must mean the same 81.
 *
 *  It survives the arrival of an 8-grid row unchanged because 81 is on BOTH
 *  grids (4x20+1 = 8x10+1), so the clamp can never land off-law. */
export const WAN_FRAMES_MAX = 81

/** Coerce a temporal grid to a usable positive integer — the row's, or Wan's. */
function coerceFrameGrid(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : WAN_FRAME_GRID
}

/** Snap a frame count onto the checkpoint's `grid*n + 1` law, clamped to a
 *  runnable range. `grid + 1` is the floor: n=0 is a single still, and the
 *  shortest thing that is a CLIP is one full latent step (5 on Wan, 9 on LTX) —
 *  a fixed 5 would be off-law on an 8-grid row. */
function normalizeWanFrames(n: number, grid: number = WAN_FRAME_GRID): number | null {
  if (!Number.isFinite(n) || n <= 0) return null
  const g = coerceFrameGrid(grid)
  const k = Math.max(0, Math.round((n - 1) / g))
  return Math.min(WAN_FRAMES_MAX, Math.max(g + 1, g * k + 1))
}

/** Coerce a `duration` param to positive seconds. Null for anything unusable —
 *  the slider stores a number, but a remixed/hand-edited bag can hold "5". */
function coerceSeconds(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw)
    : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Coerce a frame rate to a usable positive number — the row's, or the fallback. */
function coerceFps(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : WAN_FPS
}

/**
 * Map the composer's VISIBLE length control (seconds) onto a frame count: the
 * nearest `grid*n + 1` to fps × seconds, clamped to a runnable range. Returns
 * null — never NaN — for garbage, so the caller can fall through to the engine
 * default.
 *
 * `fps` and `grid` default to Wan's so every existing call is unchanged; the
 * checkpoint's own pair arrives from the `duration` spec (see
 * resolveLocalWanFrames).
 */
export function durationSecondsToWanFrames(
  raw: unknown,
  fps: number = WAN_FPS,
  grid: number = WAN_FRAME_GRID,
): number | null {
  const seconds = coerceSeconds(raw)
  if (seconds === null) return null
  return normalizeWanFrames(seconds * coerceFps(fps), grid)
}

/**
 * The frame count a params bag ASKS FOR, before any clamp — the number
 * resolveLocalWanFrames would have produced if 81 were not a ceiling.
 *
 * resolveLocalWanFrames deliberately clamps, so a node set to 12 s does not
 * fail: it silently renders 5 s. Detecting the gap between what was asked and
 * what will render needs the UNCLAMPED request, which is what this returns
 * (still snapped to Wan's 4n+1 law, since that part is not negotiable). Null
 * for anything unusable, so a caller can stay fail-open.
 */
export function requestedWanFrames(
  params: Record<string, unknown>,
  fps: number = WAN_FPS,
  grid: number = WAN_FRAME_GRID,
): number | null {
  const g = coerceFrameGrid(grid)
  const seconds = coerceSeconds(params.duration)
  if (seconds !== null) {
    const k = Math.max(0, Math.round((seconds * coerceFps(fps) - 1) / g))
    return Math.max(g + 1, g * k + 1)
  }
  const frames = typeof params.frames === 'number' && Number.isFinite(params.frames) && params.frames > 0
    ? params.frames : null
  if (frames === null) return null
  return Math.max(g + 1, g * Math.max(0, Math.round((frames - 1) / g)) + 1)
}

/** The seconds a frame count actually plays for, as the int slider spells it. */
export function wanFramesToSeconds(frames: number, fps: number = WAN_FPS): number {
  return Math.max(1, Math.round(frames / coerceFps(fps)))
}

/**
 * Renderer mirror of the per-row frame rates that differ from WAN_FPS — the
 * flow-doctor runs on a static flow with no schema in hand, so it cannot read
 * the row's `fps` the way the runtime duration spec carries it. One entry per
 * exception; anything unlisted is the Wan default. Pinned against
 * sd-cpp-models by test so it cannot drift (the blockedLocalRows idiom).
 */
export const LOCAL_VIDEO_FPS_EXCEPTIONS: Record<string, number> = {
  'wan22-ti2v-5b': 24,
  'ltx-2-3-22b-distilled': 24,
}

/** The frame rate a local video row generates at, by model id; fail-open to 16. */
export function localVideoFpsFor(modelId: string | undefined): number {
  return (modelId && LOCAL_VIDEO_FPS_EXCEPTIONS[modelId]) || WAN_FPS
}

/**
 * The same mirror, one axis over: rows whose TEMPORAL grid is not Wan's 4.
 *
 * Separate table rather than a widened one because these are separate facts —
 * TI2V-5B is a 24 fps row on the 4-grid, LTX is 24 fps on the 8-grid — and a
 * single table of pairs would force every future row to restate a default it
 * does not deviate from. Same pin, same test, same exceptions-only rule.
 */
export const LOCAL_VIDEO_FRAME_GRID_EXCEPTIONS: Record<string, number> = {
  'ltx-2-3-22b-distilled': 8,
}

/** The temporal grid a local video row obeys, by model id; fail-open to 4. */
export function localVideoFrameGridFor(modelId: string | undefined): number {
  return (modelId && LOCAL_VIDEO_FRAME_GRID_EXCEPTIONS[modelId]) || WAN_FRAME_GRID
}

/**
 * Resolve the frame count to send to `sd-cli -M vid_gen` from a run's params.
 *
 * `duration` — the control the user can actually SEE — wins. `offered` is the
 * LIVE schema's bound for the selected model: composer params are persisted per
 * MODALITY, not per provider, so a 30 s left over from a cloud run must not
 * out-vote the installed checkpoint's ceiling. Numeric `frames` is the fallback
 * for params that never went through the slider. Returns {} when nothing is
 * usable, which keeps the model row's own frame count in sd-cpp-client.
 *
 * ── `offered.fps`: THE RATE THOSE SECONDS MEAN ───────────────────────────────
 *
 * The same spec that carries the bound now carries the checkpoint's frame rate
 * (surplus-media-service reads it off the model row). That is deliberate rather
 * than a second argument: BOTH local surfaces — the media tab and the canvas
 * media node in main — already hand this exact spec in as `offered`, so a 24 fps
 * row is converted correctly on both without either call site changing. A second
 * parameter would have been wired on one surface and forgotten on the other,
 * which is the split this whole module exists to close (audit D3).
 *
 * Absent ⇒ 16, so every cloud spec and every pre-existing bag behaves exactly as
 * it did.
 */
export function resolveLocalWanFrames(
  params: Record<string, unknown>,
  offered?: { min?: number; max?: number; fps?: number; frameGrid?: number },
): { frames?: number } {
  const fps  = coerceFps(offered?.fps)
  const grid = coerceFrameGrid(offered?.frameGrid)
  const seconds = coerceSeconds(params.duration)
  if (seconds !== null) {
    const lo = typeof offered?.min === 'number' && Number.isFinite(offered.min) ? offered.min : null
    const hi = typeof offered?.max === 'number' && Number.isFinite(offered.max) ? offered.max : null
    let s = seconds
    if (hi !== null) s = Math.min(hi, s)
    if (lo !== null) s = Math.max(lo, s)
    const frames = durationSecondsToWanFrames(s, fps, grid)
    if (frames !== null) return { frames }
  }
  // A raw `frames` needs no rate — but it DOES need the grid: grid*n+1 and the
  // 81-frame ceiling are counts, and 45 is on-law for Wan and off-law for LTX.
  const fromFrames = typeof params.frames === 'number' ? normalizeWanFrames(params.frames, grid) : null
  if (fromFrames !== null) return { frames: fromFrames }
  return {}
}

/**
 * Stamp the frame count that ACTUALLY drove a local render into the params bag
 * the gallery entry snapshots. A .webm carries no tachi-gen tEXt chunk (that is
 * the PNG path's provenance), so the entry IS the provenance — and a Remix must
 * restore the length that rendered, not the stale 30 s a cloud run left behind.
 *
 * `fps` is the checkpoint's rate, from the same `duration` spec the frame count
 * was derived through. Without it a 49-frame clip off a 24 fps row would be
 * stamped as 3 s (49/16) when it played for 2 — provenance that cannot
 * reproduce its own artifact, which is the exact defect this function exists to
 * fix, one axis over.
 */
export function stampLocalWanTime(
  params: Record<string, unknown>,
  frames: number | undefined,
  fps: number = WAN_FPS,
): Record<string, unknown> {
  if (typeof frames !== 'number') return params
  return { ...params, frames, duration: wanFramesToSeconds(frames, fps) }
}

/**
 * Stamp the seed the ENGINE actually used into the params the gallery entry
 * snapshots — the same class of fix as stampLocalWanTime, on the other axis.
 *
 * -1 is left alone: it is the honest "the engine did not say", and writing it
 * over a concrete value the user typed would be the inverse bug.
 */
export function stampLocalSeed(
  params: Record<string, unknown>,
  seed: number | undefined,
): Record<string, unknown> {
  if (typeof seed !== 'number' || !Number.isFinite(seed) || seed < 0) return params
  return { ...params, seed }
}

/** The recipe MAIN reports the run went out with (sd-cpp-client's SdEffectiveParams). */
export interface LocalEngineParams {
  steps:          number
  cfgScale:       number
  samplingMethod: string
  scheduler?:     string
  flowShift?:     number
  /** `--hires` was passed — the run was a single-invocation two-pass. */
  hires?:         boolean
  /** The `--hires-scale` that went with it (never sent without `hires`). */
  hiresScale?:    number
  /** `-i` was on the command line: this was an img2img run, not a text→image
   *  one. See stampLocalEngineParams for why the entry has to say so. */
  initImage?:     boolean
  /** The `--strength` that went with it (never sent without a frame). */
  strength?:      number
  /** `--clip-skip` was passed, at this value. */
  clipSkip?:      number
  /**
   * `--ip-adapter-image` was on the command line: a REFERENCE IMAGE steered this
   * render alongside the words.
   *
   * A boolean, like `initImage` and for the same reason: the service's own
   * `SdEffectiveParams.ipAdapterImage` is a temp PATH that is deleted when the run
   * ends, so stamping it would hand Remix a file that no longer exists. What the
   * entry can honestly say is WHICH MODE ran.
   */
  ipAdapterImage?:    boolean
  /** The `--ip-adapter-strength` that went with it (never sent without one). */
  ipAdapterStrength?: number
}

/**
 * Stamp the RECIPE the engine was actually given — the third axis of the same
 * fix as stampLocalWanTime (frames) and stampLocalSeed (seed).
 *
 * Driver finding (speed A/B, 2026-07-31): with the 4-step pack on, sd-cli was
 * spawned `--steps 4 --cfg-scale 1` and the entry recorded `steps: 20, cfg: 6`
 * — the composer's own bag, because the pack's out-vote happened in MAIN and
 * nothing came back. Remix then reproduced the request instead of the render.
 *
 * THE KEYS ARE THE COMPOSER'S, not the engine's: the bag is keyed by
 * ParamSpec.name, so it is `cfg` and `sampler`, and writing `cfgScale` here
 * would add dead keys while leaving the composer showing the stale numbers.
 * `scheduler` / `flow_shift` are written only when the engine really passed
 * them — an absent flag is not the same claim as a defaulted one.
 *
 * `hires` / `hires_scale` ride the same rule and the same reason: the second
 * pass is what makes a 1024 tier come out at 2048, so an entry that does not
 * record it cannot be Remixed back into the image it shows. They are ABSENT, not
 * `false`, on a one-pass run — the composer's own toggle is what the user reads,
 * and writing `hires: false` over a bag the engine never saw a toggle for would
 * be inventing a decision.
 *
 * ── `img2img` / `strength`: THE OTHER HALF OF THE CHECKPOINT-A P1 ─────────────
 *
 * A local img2img entry recorded `steps: 20` and NOTHING about the reference
 * frame. Both halves of that were structural: the strength was never in the bag
 * at all (it was the arg builder's own `?? 0.6`), and `image_url` holds a `data:`
 * URL that media.store STRIPS before localStorage — a 3 MB photo is ~4 MB of
 * base64 and a handful of runs is the whole quota. So the persisted entry of an
 * img2img run was indistinguishable from a text→image one, and Remix silently
 * re-ran it as text→image.
 *
 * `img2img: true` is the DURABLE marker: a boolean survives the data-URL strip,
 * and it is deliberately NOT named `image_url` / `init_image` / `image` — those
 * are the names a gateway expects an actual image under (see modelParamSchema's
 * own alias table), and this bag is forwarded verbatim to whatever provider is
 * selected next. It says which MODE ran, which is a claim no gateway can
 * misread. The frame's BYTES are not recoverable from an entry by design; what
 * this fixes is the entry claiming a run that did not happen.
 *
 * `strength` and `clip_skip` are the composer's own ParamSpec names, so they
 * restore into the visible controls exactly like `steps` and `cfg`.
 */
export function stampLocalEngineParams(
  params: Record<string, unknown>,
  effective: LocalEngineParams | undefined,
): Record<string, unknown> {
  if (!effective) return params
  const out: Record<string, unknown> = {
    ...params,
    steps:   effective.steps,
    cfg:     effective.cfgScale,
    sampler: effective.samplingMethod,
  }
  if (effective.scheduler) out.scheduler = effective.scheduler
  if (typeof effective.flowShift === 'number') out.flow_shift = effective.flowShift
  if (effective.hires) {
    out.hires = true
    if (typeof effective.hiresScale === 'number') out.hires_scale = effective.hiresScale
  }
  if (effective.initImage) out.img2img = true
  if (typeof effective.strength === 'number') out.strength = effective.strength
  if (typeof effective.clipSkip === 'number') out.clip_skip = effective.clipSkip
  // THE REFERENCE IMAGE, the same two ways: a durable boolean for the MODE and the
  // strength under the composer's own ParamSpec name so it restores into the
  // visible slider. `reference_image: true` rather than `ip_adapter_image: true`
  // — that key holds an actual picture and this bag is forwarded verbatim to
  // whatever provider is selected next, so writing a boolean there would hand a
  // gateway `true` where it expects an image.
  if (effective.ipAdapterImage) out.reference_image = true
  if (typeof effective.ipAdapterStrength === 'number') out.ip_adapter_strength = effective.ipAdapterStrength
  return out
}

// ── Local sd.cpp INIT FRAME plumbing ─────────────────────────────────────────
//
// ParamFields' `image` control reads the File as a `data:` URL and stores it
// under the schema's param name, `image_url`. The renderer cannot produce a
// path (a browser File has none), so it forwards the reference and MAIN
// materialises it — see electron/ipc/sd-cpp.ipc.ts.
//
// THE OUT-VOTE, which is the reason this is a function and not a spread:
// composer params are persisted per MODALITY, so an `image_url` left over from
// an imgnAI/Venice video run sits in the bag long after the control that set it
// is gone. Handing that to a T2V checkpoint would be the same silent lie in the
// opposite direction, so the ACTIVE schema decides.

/** Does the schema the composer is CURRENTLY rendering offer an init image? */
export function schemaOffersInitImage(schema: ParamSpec[]): boolean {
  return schema.some(s => s.name === 'image_url' && s.kind === 'image')
}

/**
 * Resolve the init frame to send with a LOCAL generation. Returns {} (never
 * `{ initImage: undefined }`) so the spread adds no key when there is no frame.
 */
export function resolveLocalInitImage(
  params: Record<string, unknown>,
  offersInitImage: boolean,
): { initImage?: string } {
  if (!offersInitImage) return {}
  const raw = typeof params.image_url === 'string' ? params.image_url.trim() : ''
  return raw ? { initImage: raw } : {}
}

// ── img2img STRENGTH: ONE DEFAULT OWNER (the checkpoint-A P1) ────────────────
//
// Driver proof: two local image runs went out
//   `-i …\sd-init-….png --strength 0.6`
// while the visible IMG2IMG STRENGTH control read 0 and the help under it said
// "0 = keep init". The user was told the frame would be preserved; the engine was
// told to move 60% off it.
//
// Neither number was wrong on its own. `strength` was the ONLY param in the image
// schema with no `default`, and ParamFields renders `spec.min` for a default-less
// slider — so 0 was the CONTROL's idea of "unset". buildSdArgs read
// `input.strength ?? 0.6`, so 0.6 was the ARG BUILDER's idea of the same thing.
// Two components owned one knob and the params bag was empty in between, which is
// exactly why nothing on screen could show the disagreement.
//
// THE OWNER IS NOW THE SPEC DEFAULT — the idiom steps / cfg / sampler / size /
// negative_prompt already use: modelParamSchema declares it, healParamsForSchema
// SEEDS it into the bag, ParamFields renders the bag, this resolver reads the bag,
// and effectiveImageParams is what the argv prints. The number below is the last
// rung for a surface with no seeding effect (the canvas node), so both ends read
// ONE constant instead of each carrying its own.

/**
 * The app's img2img strength when a frame is attached and nothing was typed.
 *
 * Deliberately NOT the engine's own (see below): 0.6 stays closer to the
 * reference frame, and it is what every img2img run this app has ever done went
 * out with. Changing it would silently change the output of an existing recipe,
 * which is a second change wearing the first one's clothes.
 */
export const SD_IMG2IMG_STRENGTH_DEFAULT = 0.6

/**
 * What sd-cli would use if we passed no `--strength` at all — `--help` on the
 * pinned build (commit b290693): "strength for noising/unnoising (default:
 * 0.75)". Recorded as a named constant so the divergence above is a documented
 * decision rather than a number nobody can account for.
 */
export const SD_CLI_STRENGTH_DEFAULT = 0.75

/**
 * img2img strength, which is only meaningful WITH an init image — sd-cli reads
 * `--strength` as "how far from the init frame".
 *
 * Returns {} for a bag that holds no usable number, so the spread adds no key
 * and the ONE default above applies at the engine. On the media tab the bag is
 * always seeded by then, so {} here means the canvas or a raw IPC call.
 */
export function resolveLocalStrength(
  params: Record<string, unknown>,
  hasInitImage: boolean,
): { strength?: number } {
  if (!hasInitImage) return {}
  const n = params.strength
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1 ? { strength: n } : {}
}

// ── THE REFERENCE IMAGE (IP-Adapter) ─────────────────────────────────────────
//
// Same "one owner for the number" rule the img2img strength above earned the hard
// way, applied before it can be broken: the bounds and the default live here, the
// schema renders them, the resolver reads the bag, and the arg builder prints
// what the resolver returned.
//
// THE BAND IS 0..1 AND THE DEFAULT IS 0.75, and both are decisions:
//  • upstream's docs/ip_adapter.md says "Lower values let the text prompt
//    dominate; 0.6 to 0.8 is a good starting range";
//  • the engine's own default is 1.0 — full injection, which on a busy prompt
//    reads as "it ignored what I wrote". Starting there would make the feature
//    look broken to the person trying it for the first time.
// 0.75 is the middle of upstream's range, and the flag is ALWAYS emitted so the
// number on screen is the number on the command line.

/** The reference-image strength control's band and its default. */
export const SD_IP_ADAPTER_STRENGTH_MIN = 0
export const SD_IP_ADAPTER_STRENGTH_MAX = 1
export const SD_IP_ADAPTER_STRENGTH_STEP = 0.05
export const SD_IP_ADAPTER_STRENGTH_DEFAULT = 0.75

/** What sd-cli would use if we passed no `--ip-adapter-strength` — `--help` on
 *  the pinned build: "strength to apply IP-Adapter (default: 1.0)". Named so the
 *  divergence above is a documented decision rather than an unaccountable number. */
export const SD_CLI_IP_ADAPTER_STRENGTH_DEFAULT = 1.0

/** Clamp + round one reference-image strength to what the flag may carry. */
export function normalizeIpAdapterStrength(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return SD_IP_ADAPTER_STRENGTH_DEFAULT
  const clamped = Math.min(SD_IP_ADAPTER_STRENGTH_MAX, Math.max(SD_IP_ADAPTER_STRENGTH_MIN, n))
  return Math.round(clamped * 100) / 100
}

/**
 * The reference image and its strength, from the params bag.
 *
 * `ipAdapterImage` is THE IPC NAME and carries whatever the control stored — a
 * `data:` URL from the picker, or a path a Remix restored. Main materialises it
 * into `ipAdapterImagePath` at the boundary, exactly as `initImage` becomes
 * `initImagePath`; a caller that talks to the service directly (the canvas node)
 * does its own materialisation.
 *
 * Returns {} unless there is a real reference — the strength alone steers
 * nothing, so a bag holding only a number must not put a flag on the command
 * line. Mirrors resolveLocalInitImage / resolveLocalStrength, which is the pair
 * this one is deliberately NOT part of: a run may carry both, and they do
 * different things to the picture.
 */
export function resolveLocalIpAdapter(
  params: Record<string, unknown>,
  offeredBySchema: boolean = true,
): { ipAdapterImage?: string; ipAdapterStrength?: number } {
  // THE OUT-VOTE, same as the CLIP-skip one: the bag is persisted per modality,
  // and this control exists only while compatible weights are installed. A path
  // left behind by a previous checkpoint must not ride onto a row whose schema no
  // longer offers the control. (The arg builder gates on the weights as well, so
  // this is the second of two — but provenance is written from the first.)
  if (!offeredBySchema) return {}
  const raw = params.ip_adapter_image
  const ref = typeof raw === 'string' ? raw.trim() : ''
  if (!ref) return {}
  return {
    ipAdapterImage:    ref,
    ipAdapterStrength: normalizeIpAdapterStrength(params.ip_adapter_strength),
  }
}

// ── THE MEMORY LADDER + CLIP SKIP ───────────────────────────────────────────
//
// Five flags the pinned engine has and the app had no way to ask for, so the
// committed 8 GB recipe (`--max-vram -1 --stream-layers --clip-on-cpu
// --vae-tiling`, VIDEO-MODELS-RESEARCH §4) was unsayable — and `--clip-skip`,
// which is the difference between a Civitai SD 1.5 anime merge looking right and
// looking washed out.
//
// The BOUNDS and the OPTION LIST live here for the same reason SD_BATCH_MAX does:
// the schema that renders the control (surplus-media-service) and the arg builder
// that emits the flag (sd-cpp-client) are two files, and a band spelled in each
// of them is a band that drifts.

/**
 * `--clip-skip`'s ceiling. `--help`: "ignore last layers of CLIP network; 1
 * ignores none, 2 ignores one layer (default: -1). <= 0 represents unspecified,
 * will be 1 for SD1.x, 2 for SD2.x". SD 1.x's text encoder has 12 layers, so 12
 * is where the control stops meaning anything; 0 is the engine's own
 * "unspecified" and is what the control defaults to.
 */
export const SD_CLIP_SKIP_MAX = 12

/**
 * The `--max-vram` value that means "auto".
 *
 * `--help`: "0 disables graph splitting; a negative value auto-detects free
 * VRAM, sparing the specified value". So -1 is "use what the driver reports as
 * free, keep 1 GiB spare" — the form the committed 8 GB recipe uses, and the one
 * a user cannot be expected to type as a negative number into a slider.
 */
export const SD_MAX_VRAM_AUTO = -1

/**
 * The VRAM-budget control's options — an ENUM rather than a slider precisely
 * because the engine's own encoding is not monotonic (0 = off, negative = auto,
 * positive = a budget). 'off' emits nothing at all.
 */
export const SD_MAX_VRAM_OPTIONS = ['off', 'auto', '4', '6', '8', '10', '12', '16', '24'] as const

/**
 * The memory/placement flags a local run asks for, under the sd.cpp IPC's names.
 *
 * `boolean` rather than `true` so a raw IPC caller can spell an explicit opt-out
 * without a cast; the resolver below never WRITES `false` (see its doc), and the
 * arg builder emits on truthiness, so the two spellings are one command line.
 */
export interface LocalMemoryFlags {
  vaeTiling?:     boolean
  vaeConvDirect?: boolean
  autoFit?:       boolean
  streamLayers?:  boolean
  maxVramGb?:     number
  /**
   * `--offload-to-cpu`: the parameters live in RAM and are staged to the GPU as
   * needed. NO SCHEMA CONTROL RENDERS THIS — resolveLocalMemoryFlags never sets
   * it — so on the way IN it is reachable only by a hand-written IPC payload.
   *
   * It is in this bag because it is the PRECONDITION of `streamLayers` (the
   * engine ignores that flag unless the diffusion params backend is CPU) and
   * because it therefore comes back OUT in the provenance stamp: an image whose
   * chunk says `streamLayers: true` must also say what made streaming possible,
   * or the recipe cannot be re-run. See the conjunction above sdMemoryArgs.
   */
  offloadToCpu?:  boolean
}

/**
 * The `--max-vram` request, from the enum the composer renders.
 *
 * Returns {} for 'off' and for anything unrecognised, so no flag is emitted and
 * the command line is byte-identical to every run before this control existed.
 */
export function resolveLocalVramBudget(params: Record<string, unknown>): { maxVramGb?: number } {
  const raw = params.max_vram
  const v = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
  if (!v || v === 'off') return {}
  if (v === 'auto') return { maxVramGb: SD_MAX_VRAM_AUTO }
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? { maxVramGb: Math.floor(n) } : {}
}

/**
 * The whole memory group, under the names the sd.cpp IPC takes, read from the
 * names the SCHEMA declares.
 *
 * A `false` toggle contributes NOTHING rather than `false`: the arg builder emits
 * on truthiness, so both produce the same command line, and a payload full of
 * explicit `false` would suggest the app asked for something it did not.
 * `streamLayers` is passed through as asked — the ENGINE's gate (a VRAM budget
 * AND the diffusion params on CPU, and neither survives `--auto-fit`) is enforced
 * in one place, sdMemoryArgs, so the argv and the provenance cannot disagree
 * about whether it was really in play. `offloadToCpu` has no control to read, and
 * is left to that same function to imply.
 */
export function resolveLocalMemoryFlags(params: Record<string, unknown>): LocalMemoryFlags {
  const out: LocalMemoryFlags = {}
  if (params.vae_tiling      === true) out.vaeTiling     = true
  if (params.vae_conv_direct === true) out.vaeConvDirect = true
  if (params.auto_fit        === true) out.autoFit       = true
  if (params.stream_layers   === true) out.streamLayers  = true
  const budget = resolveLocalVramBudget(params)
  if (budget.maxVramGb !== undefined) out.maxVramGb = budget.maxVramGb
  return out
}

/** Does the schema the composer is CURRENTLY rendering offer a CLIP skip? */
export function schemaOffersClipSkip(schema: ParamSpec[]): boolean {
  return schema.some(s => s.name === 'clip_skip')
}

/** …and a REFERENCE IMAGE (IP-Adapter)? Present only while compatible weights
 *  are installed, which is what makes it worth asking. */
export function schemaOffersIpAdapter(schema: ParamSpec[]): boolean {
  return schema.some(s => s.name === 'ip_adapter_image')
}

/**
 * `--clip-skip`, under the name the IPC takes (`clipSkip`), read from the name
 * the schema declares (`clip_skip`).
 *
 * 0 (the control's default) and anything below it return {} — that is the
 * engine's own "unspecified", and emitting it would be a flag at its own default
 * the app then has to defend in provenance forever.
 *
 * THE ACTIVE SCHEMA DECIDES, the same out-vote resolveLocalInitImage exists for
 * and for a sharper reason: the params bag is persisted per MODALITY, and this
 * control is offered ONLY on the families whose conditioning is CLIP. So a `2`
 * set for a Civitai SD 1.5 merge sits in the bag after a switch to Z-Image, whose
 * schema drops the control entirely — and sending it there would be an invisible
 * flag from a control that is no longer on screen. Pass
 * `schemaOffersClipSkip(shownSchema)`; a caller that omits it (a raw IPC path
 * with no schema in hand) gets the value, which is the honest reading of "I asked
 * for this explicitly".
 */
export function resolveLocalClipSkip(
  params: Record<string, unknown>,
  offeredBySchema: boolean = true,
): { clipSkip?: number } {
  if (!offeredBySchema) return {}
  const raw = params.clip_skip
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(n) || n < 1) return {}
  return { clipSkip: Math.min(SD_CLIP_SKIP_MAX, Math.floor(n)) }
}

// ── steps / cfg / sampler: THE DEAD CONTROLS (audit D1) ──────────────────────
//
// `cfg` and `sampler` are the SCHEMA's names — the names ParamFields renders,
// the names the store persists, and the names every cloud provider is sent.
// Both local call sites read `cfgScale` / `samplingMethod`, which only the
// preset picker and the PNG-restore ever wrote, so the two controls were
// decorative on every local model. `steps` was always right and is included
// here so all three travel together and cannot drift apart again.
//
// The LEGACY keys are read as a fallback, in second place: a bag persisted by
// an older build holds `cfgScale`, and a params bag is long-lived (localStorage,
// per modality). They are never WRITTEN by anything after this change.

/** Schema name → the legacy key an older build persisted under. */
export const LOCAL_GEN_LEGACY_KEYS: Readonly<Record<'cfg' | 'sampler', string>> = {
  cfg:     'cfgScale',
  sampler: 'samplingMethod',
}

function firstNumber(params: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = params[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function firstString(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = params[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/**
 * The generation params to send with a LOCAL run, under the names the sd.cpp
 * IPC takes (`steps` / `cfgScale` / `samplingMethod`), read from the names the
 * SCHEMA declares (`steps` / `cfg` / `sampler`).
 *
 * Returns {} for anything the bag does not hold, so the spread adds no key and
 * sd-cpp-client falls back to the MODEL ROW's own numbers — which, after the
 * findSdModel fix (audit D4), is finally the row the user actually picked.
 */
export function resolveLocalGenParams(params: Record<string, unknown>): {
  steps?: number
  cfgScale?: number
  samplingMethod?: string
} {
  const steps    = firstNumber(params, ['steps'])
  const cfgScale = firstNumber(params, ['cfg', LOCAL_GEN_LEGACY_KEYS.cfg])
  const sampler  = firstString(params, ['sampler', LOCAL_GEN_LEGACY_KEYS.sampler])
  return {
    ...(steps    !== undefined ? { steps } : {}),
    ...(cfgScale !== undefined ? { cfgScale } : {}),
    ...(sampler  !== undefined ? { samplingMethod: sampler } : {}),
  }
}

/**
 * The SPEED-PACK choice for a LOCAL video run, under the name the sd.cpp IPC
 * takes (`speed`), read from the name the SCHEMA declares (`speed_mode`).
 *
 * Returns {} when the bag holds no boolean — which is NOT the same as `false`:
 * main treats an absent flag as "use the pack if it is installed" (see
 * SdVideoInput.speed), so a saved canvas flow from before this control existed
 * still gets the fast path once the weights are there, while an explicit
 * opt-out on screen still travels as one.
 *
 * Lives here, next to resolveLocalGenParams, for the same reason the negative
 * resolver does: BOTH local video surfaces (the media tab and the canvas node)
 * assemble their call from this module, and a rule spelled at only one of them
 * is a rule the other one silently lacks.
 */
export function resolveLocalSpeedMode(params: Record<string, unknown>): { speed?: boolean } {
  return typeof params.speed_mode === 'boolean' ? { speed: params.speed_mode } : {}
}

// ── BATCH COUNT and HIRES FIX: the two flags the composer already had a control
//    for and the engine was never told about ────────────────────────────────────
//
// The bounds live HERE, in the module both ends already import, for the same
// reason the LoRA tag builder does: the SCHEMA that renders the control
// (surplus-media-service) and the ARG BUILDER that emits the flag
// (sd-cpp-client) are two files, and a max spelled in each of them is a max that
// drifts. Nothing else may invent a third number.
//
// SOURCE: `sd-cli --help` on the pinned build (master-782-b290693):
//   -b, --batch-count <int>              batch count
//   --hires                              enable highres fix
//   --hires-scale <float>                highres fix scale when target size is
//                                        not set (default: 2.0)
//   --hires-steps <int>                  second pass sample steps, 0 to reuse
//                                        --steps (default: 0)
//   --hires-denoising-strength <float>   second pass denoising strength (0.7)
//   --hires-upscaler <string>            … or a model under
//                                        --hires-upscalers-dir (default: Latent)

/** The ceiling on `n` / `-b`. 4 is the curated schema's own max, and four images
 *  is already 4x the sampling time of one — the model loads once, the sampler
 *  still runs N times. */
export const SD_BATCH_MAX = 4

/** `--hires-scale` bounds. The DEFAULT is upstream's own 2.0, so the toggle
 *  alone reproduces the engine's documented behaviour and the number beside it
 *  is not a second opinion. The floor is 1.25 because a scale of 1 is a second
 *  pass that upscales nothing — pure cost, no pixels. */
export const SD_HIRES_SCALE_MIN     = 1.25
export const SD_HIRES_SCALE_MAX     = 2
export const SD_HIRES_SCALE_STEP    = 0.25
export const SD_HIRES_SCALE_DEFAULT = 2

/**
 * How many images this run asks for, under the name the sd.cpp IPC takes
 * (`batchCount`), read from the name the SCHEMA declares (`n`).
 *
 * Returns {} for 1 and for anything unusable, so the spread adds no key and the
 * arg builder emits no `-b` at all — a single-image run's command line stays
 * byte-identical to every run before this existed.
 */
export function resolveLocalBatch(params: Record<string, unknown>): { batchCount?: number } {
  const raw = params.n
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return {}
  const count = Math.min(SD_BATCH_MAX, Math.max(1, Math.floor(n)))
  return count > 1 ? { batchCount: count } : {}
}

/** Clamp + snap one `--hires-scale` onto the band the control offers. */
export function normalizeHiresScale(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return SD_HIRES_SCALE_DEFAULT
  const snapped = Math.round(n / SD_HIRES_SCALE_STEP) * SD_HIRES_SCALE_STEP
  return Math.min(SD_HIRES_SCALE_MAX, Math.max(SD_HIRES_SCALE_MIN, snapped))
}

/**
 * The two-pass request, under the names the sd.cpp IPC takes.
 *
 * THE TOGGLE IS THE GATE, not the presence of a factor: `hires_scale` is a
 * row-independent number that sits in the persisted bag forever once the
 * disclosure has been opened, and sending a scale with no `--hires` would be a
 * flag the engine ignores while sending one WITHOUT the toggle having been
 * turned on would double the render time behind the user's back.
 *
 * Returns {} when the toggle is off or absent, so every existing caller and
 * every saved flow is byte-identical.
 */
export function resolveLocalHires(params: Record<string, unknown>): { hires?: boolean; hiresScale?: number } {
  if (params.hires !== true) return {}
  return { hires: true, hiresScale: normalizeHiresScale(params.hires_scale) }
}

/** One image as the sd.cpp IPC hands it back. */
export interface LocalGeneratedImage {
  path?: string
  /** Absent on a path-only result (a caller that never asked for bytes). */
  b64?:  string
  mime:  string
  /** The seed THIS file was sampled at — distinct per image in a batch. */
  seed?: number
}

/**
 * EVERY image a local run produced, from the result the IPC returned.
 *
 * A batch of 4 comes back as `images: [4]`; the flat `path`/`b64`/`seed` beside
 * it are `images[0]`, kept so callers written before batching existed did not
 * change. This function is the ONE place that rule is spelled, because a
 * renderer that reads only the flat fields silently drops three finished renders
 * — which is a worse failure than the dead `n` control this replaced, and it
 * would be invisible in exactly the same way.
 *
 * Returns [] when there is nothing to show, so the caller raises the run's own
 * error rather than filing an empty gallery entry.
 */
export function localImagesOf(result: {
  path?:   string
  b64?:    string
  mime?:   string
  seed?:   number
  images?: ReadonlyArray<{ path: string; b64: string; mime: string; seed: number }>
}): LocalGeneratedImage[] {
  if (result.images && result.images.length > 0) {
    return result.images.map(i => ({ path: i.path, b64: i.b64, mime: i.mime, seed: i.seed }))
  }
  // Legacy single-image shape. A path WITHOUT b64 is still an image (the
  // canvas branch and several tests hand path-only results) — requiring b64
  // here silently dropped a finished render, the exact failure this function
  // exists to prevent.
  const hasB64  = typeof result.b64 === 'string' && result.b64.length > 0
  const hasPath = typeof result.path === 'string' && result.path.length > 0
  if (hasB64 || hasPath) {
    return [{
      ...(hasPath ? { path: result.path } : {}),
      ...(hasB64 ? { b64: result.b64 } : {}),
      mime: result.mime ?? 'image/png',
      ...(result.seed !== undefined ? { seed: result.seed } : {}),
    }]
  }
  return []
}

// ── Switching checkpoint: the row owns these three (the mush incident) ───────
//
// Driver finding (owner, live): SD-Turbo selected (recipe: 1 step, guidance
// inert), then a user-installed SD 1.5 checkpoint picked from the same
// dropdown. The Steps control re-derived — max 40, hint "This checkpoint's own
// recipe is 20" — but the VALUE stayed 1 and the sampler stayed 'euler'. The
// run went out at steps:1/euler on a 20-step checkpoint and produced mush; the
// PNG's own tEXt says "Steps: 1 ... Sampler: euler discrete".
//
// healParamsForSchema could not catch it: 1 is INSIDE 1..40 and 'euler' IS in
// the enum, so neither is "excluded" and neither is missing. And Steps lives in
// an Advanced disclosure that re-collapses on model change, so nothing on
// screen showed the stale number.
//
// These three params are OWNED BY THE ROW, not by the bag: their spec `default`
// IS the row's recipe (surplus-media-service's localGenOptionsFor returns
// `steps.default = row.steps`, `cfg.default = row.cfgScale`, `sampler.default =
// row.samplingMethod`). So a MODEL SWITCH re-seeds them — which is exactly what
// the hint text already claims is happening.
//
// `flow_shift` / `scheduler` are NOT here: the new video rows carry them on the
// model row and sd-cpp-client applies them from there, no composer control
// declares them, and they never enter the params bag.

/** The composer params whose value belongs to the MODEL ROW's recipe. */
export const RECIPE_OWNED_PARAMS: readonly string[] = ['steps', 'cfg', 'sampler']

// ── …and SIZE, which the same switch left behind (driver, second pass) ───────
//
// Same incident, one control over: civitai-142421 (sd15, native 512) →
// z-image-turbo (native 1024) left `size` at 512x512 while the hint under the
// dropdown read "this checkpoint renders natively at 1024x1024". The render came
// out at a QUARTER of the native area — soft, and 6.4 s of GPU spent on a shape
// the checkpoint was never trained to make. healParamsForSchema could not catch
// it for the same reason it could not catch steps:1: 512x512 is a LEGAL z-image
// tier, so the spec excludes nothing.
//
// `size` is row-owned by exactly the same mechanism as the recipe three: the
// spec's `default` IS the row's native grid (surplus-media-service picks it per
// row — localImageOptionsFor for our own checkpoints, imageSizeOptionsFor for
// the family table).
//
// SO WHY A SECOND LIST INSTEAD OF A FOURTH ENTRY: a CLOUD image schema declares
// a `size` default too (the curated '1024x1024'), where the three recipe params
// declare none. Adding `size` to RECIPE_OWNED_PARAMS would therefore reset a
// deliberate 1536x1536 on every cloud model switch — a fix that breaks a route
// that was never broken. The LOCAL route asks for this list; everything else
// keeps the recipe-only one.
//
// `aspect_ratio` is NOT here: the local image schema DROPS it, and the cloud
// schemas that do offer it are the ones this list must not touch. The local drop
// survived the arrival of ORIENTED tiers on purpose — orientation is expressed
// by the `size` option itself now ('1216x832' is landscape and says so in
// pixels), so a ratio control would be a second, approximate name for a choice
// the user has already made exactly. resolveLocalSdSize still reads `size`
// alone, which is why that stays true rather than becoming the next silent lie.
//
// ── …and NEGATIVE_PROMPT, for the Wan rows (research: DELTA ADDENDUM §B) ─────
//
// Wan ships an official negative prompt — the string its own inference code
// passes on every sample, which the checkpoint was tuned against and whose
// removal measurably degrades output (WAN_DEFAULT_NEGATIVE in sd-cpp-models,
// verified against Wan2.1/2.2 `wan/configs/shared_config.py`). Our Wan rows run
// at cfg 6, so it is LIVE there, and we were sending none.
//
// It is row-owned by the same mechanism as the four above: the spec `default`
// IS the row's own string (localGenOptionsFor → the negative_prompt ParamSpec),
// so SEED pre-fills the visible field and a MODEL SWITCH re-seeds it. The
// switch half is not a nicety — the params bag persists per modality, so an
// existing user arrives with `negative_prompt: ''` already in it and SEED alone
// would never fire for them.
//
// AND IT MUST BE ON THE LOCAL LIST ONLY, for a sharper reason than `size`: every
// LOCAL row declares this default ('' for the ones with no recipe negative of
// their own), which is what CLEARS Wan's string on the way to another
// checkpoint. A cloud schema declares none, so the cloud path leaves a
// deliberate negative alone — which is exactly right, and would not survive
// this entry moving up into RECIPE_OWNED_PARAMS.
export const LOCAL_ROW_OWNED_PARAMS: readonly string[] = [...RECIPE_OWNED_PARAMS, 'size', 'negative_prompt']

/** Every key a bag may hold this param under (schema name first, legacy after). */
function aliasesOf(name: string): string[] {
  const legacy = (LOCAL_GEN_LEGACY_KEYS as Record<string, string | undefined>)[name]
  return legacy ? [name, legacy] : [name]
}

/**
 * Re-seed the recipe-owned params from the schema that just arrived for a
 * DIFFERENT model.
 *
 * Three cases, one pass:
 *   • the new spec declares a DEFAULT → the value becomes the new row's recipe;
 *   • the new spec does not declare the param AT ALL → the stale value is
 *     DROPPED. A distilled row's schema omits `cfg` on purpose (sd.cpp only
 *     enables the unconditional pass when cfg ≠ 1), and leaving 7 in the bag
 *     would forward guidance to a checkpoint trained without it — the same
 *     silent lie, other direction;
 *   • the new spec declares it with no default (every CLOUD schema) → untouched.
 *
 * A param the bag does not hold at all is left to healParamsForSchema's SEED
 * job. Legacy aliases (`cfgScale` / `samplingMethod`, which an older build
 * persisted and resolveLocalGenParams still reads as a fallback) are removed
 * whenever their param is re-seeded or dropped, so they cannot win by default.
 *
 * An EMPTY schema is a no-op: a failed or still-pending fetch must not clear a
 * bag. Pure — the input is never mutated.
 */
export function reseedRecipeParams(
  values: Record<string, unknown>,
  schema: ParamSpec[],
  names: readonly string[] = RECIPE_OWNED_PARAMS,
): { next: Record<string, unknown>; changed: boolean; reseeded: string[] } {
  if (schema.length === 0) return { next: values, changed: false, reseeded: [] }
  const next: Record<string, unknown> = { ...values }
  const reseeded: string[] = []
  let changed = false
  for (const name of names) {
    const keys = aliasesOf(name)
    if (!keys.some(k => k in values)) continue          // absent — that is the SEED job
    const spec = schema.find(s => s.name === name)
    if (spec && spec.default === undefined) continue    // cloud spec: no recipe to read
    let touched = false
    if (spec) {
      if (!Object.is(values[name], spec.default)) { next[name] = spec.default; touched = true }
    } else if (name in next) {
      delete next[name]
      touched = true
    }
    for (const legacy of keys.slice(1)) {
      if (legacy in next) { delete next[legacy]; touched = true }
    }
    if (touched) { reseeded.push(name); changed = true }
  }
  return { next, changed, reseeded }
}

/** Every key a params bag may carry a negative prompt under (schema name first).
 *  Exported because the CANVAS's edit path has to special-case them by name —
 *  see applyParamEdit, which is the other half of the fix below. */
export const NEGATIVE_KEYS = ['negative_prompt', 'negative'] as const

/**
 * Apply ONE control edit to a params bag — what a node's `setParam` does.
 *
 * ── THE PREMISE THAT WAS FALSE ON THE CANVAS (review of the FLF fix lane) ─────
 *
 * resolveLocalNegative below rests on "ParamFields writes '' when the user
 * clears", and that is only true of the MEDIA TAB: media.store's setParam
 * ASSIGNS (`{ ...bag, [name]: value }`), so the empty string lands in the bag.
 * The canvas media node did the opposite — `if (value == null || value === '')
 * delete next[name]` — and DELETING the key is not the same statement:
 * ParamFields then renders `asString(undefined, spec.default)`, so Wan's
 * official negative snapped straight back into the textarea, negativeWasTouched
 * read an untouched bag, and the engine was handed `-n <WAN_DEFAULT_NEGATIVE>`
 * from a user who had just deleted it. The absent-vs-empty distinction this
 * module is built on was unreachable from the surface that needed it most.
 *
 * So an EMPTY NEGATIVE IS KEPT — for that param '' is a decision. Delete-on-
 * empty stays for every other key, where blank means "no opinion" and the row's
 * own number must win (a cleared `size` has to fall through to the checkpoint's
 * native grid, not travel as ''). null / undefined deletes even a negative key:
 * that is the honest "back to untouched", which is what a control's own Clear
 * button means (ParamFields' image/audio controls `set(undefined)`).
 *
 * Pure — the input bag is never mutated.
 */
export function applyParamEdit(
  params: Record<string, unknown>,
  name: string,
  value: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...params }
  const keepsEmpty = (NEGATIVE_KEYS as readonly string[]).includes(name)
  if (value == null || (value === '' && !keepsEmpty)) delete next[name]
  else next[name] = value
  return next
}

/**
 * The ROW's own negative prompt, read off the live schema — `''` for every row
 * (and every CLOUD model) that declares none.
 *
 * This is deliberately the same table the control is rendered from rather than
 * a second lookup into sd-cpp-models: `localGenOptionsFor` already decides when
 * a row's negative is offered at all (a distilled checkpoint runs at guidance 1,
 * where sd.cpp skips the unconditional pass entirely and the spec default is set
 * to `''` on purpose). Reading the row directly would re-implement that
 * judgement and could hand `-n` to a checkpoint the schema just told the user it
 * does nothing on.
 *
 * Lives HERE (not in graph-to-agentkit, where it was born) because it is one
 * half of the ONE rule — `resolveLocalNegative(bag, schemaNegativeDefault(schema))`
 * — and that rule now runs on three assemblies: the canvas media node (main),
 * the media tab's video call and its image call. Two of those are renderer
 * code, and a rule that lives in an electron service is a rule the renderer
 * re-implements by hand until it drifts (that is exactly how the image path
 * ended up reading `runParams.negative_prompt` raw).
 */
export function schemaNegativeDefault(schema: ParamSpec[]): string {
  const spec = schema.find(s => s.name === 'negative_prompt')
  return typeof spec?.default === 'string' ? spec.default : ''
}

/**
 * Has this bag's negative prompt ever been TOUCHED?
 *
 * The key's PRESENCE is the signal, not its value: ParamFields writes `''` when
 * the user clears the textarea (`onChange={e => set(e.target.value)}`), so an
 * empty string is a decision, while a missing key is a control the user never
 * went near. An explicitly-`undefined` value counts as absent — the same rule
 * healParamsForSchema already applies ("it renders as the default already").
 */
export function negativeWasTouched(params: Record<string, unknown>): boolean {
  return NEGATIVE_KEYS.some(k => k in params && params[k] !== undefined)
}

/**
 * The negative prompt to send with a LOCAL run.
 *
 * The schema param is `negative_prompt` (surplus-media-service). The canvas
 * branch read `params.negative` — a key nothing writes — so a negative prompt
 * typed on a media node was dropped entirely and only the style preset's own
 * negative survived (audit D3). `negative` stays as the legacy fallback for the
 * same reason the cfg/sampler aliases do.
 *
 * ── `rowDefault`: THE CANVAS FIX (FLF driver, finding 1) ─────────────────────
 *
 * `negative_prompt` is ROW-OWNED: the local schema carries the checkpoint's own
 * string as the spec `default` (localGenOptionsFor → WAN_DEFAULT_NEGATIVE), and
 * ParamFields renders a spec default for a value the bag does not hold. So the
 * media node DISPLAYED Wan's official negative while the bag stayed empty — and
 * MediaPage was honest only because its schema effect re-seeds
 * LOCAL_ROW_OWNED_PARAMS into the bag; the canvas has no such effect and a saved
 * flow reads `params: { duration: 2 }`. Three Wan invocations from the canvas,
 * zero `-n` flags.
 *
 * Passing the row's default here makes the rule "what the field shows is what
 * runs" true at ENGINE ASSEMBLY, so it holds for every surface at once instead
 * of once per re-seeding effect. The absent/empty distinction is what keeps it
 * from being a run-time append behind the user's back:
 *   • no key at all → the row's default (exactly what is on screen);
 *   • `''`          → nothing, because clearing the field is a decision;
 *   • text          → that text.
 */
export function resolveLocalNegative(
  params: Record<string, unknown>,
  rowDefault?: string,
): string {
  const typed = firstString(params, [...NEGATIVE_KEYS])
  if (typed !== undefined) return typed
  if (negativeWasTouched(params)) return ''
  return typeof rowDefault === 'string' ? rowDefault.trim() : ''
}

// ── Persisted params vs the schema that is now ACTIVE ────────────────────────
//
// Composer params are persisted per MODALITY (tachi-media-v1), not per provider
// or per model. So the LOCAL Wan composer opens showing whatever the last CLOUD
// video run left behind: duration = 10 on a slider whose max is 5, resolution =
// '1080p' selected in a dropdown that only offers '480p'.
//
// Deliberately narrow, so it cannot fight a user mid-edit:
//   • only values the ACTIVE spec EXCLUDES are touched;
//   • the replacement is the spec's own DEFAULT when the spec allows it;
//   • kinds with no declared domain are never healed;
//   • an EXPLICIT restore/remix is exempt (see MediaPage's schema effect).

/** The replacement for a value the spec EXCLUDES, or undefined to leave it alone. */
function healValue(spec: ParamSpec, value: unknown): unknown {
  if (spec.kind === 'enum') {
    const options = spec.enum ?? []
    if (options.length === 0) return undefined          // no declared domain — nothing to exclude
    const current = typeof value === 'string' ? value
      : typeof value === 'number' || typeof value === 'boolean' ? String(value)
      : null                                            // null/object/array: not a selectable option
    if (current !== null && options.includes(current)) return undefined
    const def = typeof spec.default === 'string' ? spec.default : null
    return def !== null && options.includes(def) ? def : options[0]
  }
  if (spec.kind === 'int' || spec.kind === 'number') {
    // Only a real number can be out of range. A string/null in a slider slot is
    // left alone: ParamFields renders the default for it and the resolvers coerce.
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    const min = typeof spec.min === 'number' && Number.isFinite(spec.min) ? spec.min : null
    const max = typeof spec.max === 'number' && Number.isFinite(spec.max) ? spec.max : null
    const inRange = (n: number) => (min === null || n >= min) && (max === null || n <= max)
    if (inRange(value)) return undefined
    const def = typeof spec.default === 'number' && Number.isFinite(spec.default) ? spec.default : null
    if (def !== null && inRange(def)) return def
    let out = value
    if (max !== null) out = Math.min(max, out)
    if (min !== null) out = Math.max(min, out)
    return out
  }
  return undefined
}

/**
 * Reconcile a persisted params bag with the schema that just arrived.
 *
 * Two jobs, one pass:
 *   1. SEED — a param the bag is missing takes the spec default.
 *   2. HEAL — a param the ACTIVE spec excludes takes a value the spec allows.
 *      Pass `healExcluded: false` to run job 1 only (an explicit restore/remix).
 *
 * Pure: the input bag is never mutated.
 */
export function healParamsForSchema(
  values: Record<string, unknown>,
  schema: ParamSpec[],
  opts?: { healExcluded?: boolean },
): { next: Record<string, unknown>; changed: boolean; healed: string[] } {
  const healExcluded = opts?.healExcluded !== false
  const next: Record<string, unknown> = { ...values }
  const healed: string[] = []
  let changed = false
  for (const spec of schema) {
    // An explicitly-undefined value is treated as absent — it renders as the
    // default already, so seeding it makes the store agree with the control.
    if (values[spec.name] === undefined) {
      if (spec.default !== undefined) { next[spec.name] = spec.default; changed = true }
      continue
    }
    if (!healExcluded) continue
    const fixed = healValue(spec, values[spec.name])
    if (fixed !== undefined && !Object.is(fixed, values[spec.name])) {
      next[spec.name] = fixed
      healed.push(spec.name)
      changed = true
    }
  }
  return { next, changed, healed }
}

// ── LoRA prompt tags (spec §4-5) ─────────────────────────────────────────────
//
// stable-diffusion.cpp has NO `--lora` flag. A LoRA is applied by naming it IN
// THE PROMPT — `<lora:name:weight>` — while `--lora-model-dir` says where to
// look. `name` is the FILE STEM, which is why the app owns the on-disk slug
// (adapterSlug in sd-cpp-models): 10.7% of real Civitai LoRA filenames contain
// spaces, which cannot survive this syntax at all, and the top-600 hold 54
// name collisions.
//
// Weight is clamped to a sane band and printed with at most two decimals: the
// tag is parsed by the engine, so "0.7500000000000001" (a float the slider can
// produce) is not a value to hand it.

/** The band the weight control offers, and the clamp the tag is built with. */
export const LORA_WEIGHT_MIN = -2
export const LORA_WEIGHT_MAX = 2
export const LORA_WEIGHT_DEFAULT = 1

/** Clamp + round one LoRA weight to what the tag may carry. */
export function normalizeLoraWeight(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return LORA_WEIGHT_DEFAULT
  const clamped = Math.min(LORA_WEIGHT_MAX, Math.max(LORA_WEIGHT_MIN, n))
  return Math.round(clamped * 100) / 100
}

/**
 * The prefix that aims a tag at the HIGH-NOISE expert of a Wan 2.2 A14B pair.
 *
 * A two-expert row runs TWO models over the same latents, and a LoRA is trained
 * against ONE of them. Upstream's own docs/wan.md command at our pinned build
 * (master-782-b290693) writes exactly this, in one prompt:
 *
 *   -p "a lovely cat<lora:…_low_noise:1><lora:|high_noise|…_high_noise:1>"
 *
 * An unprefixed tag goes to the ordinary (low-noise) pass. Getting this wrong
 * does not error — it applies the wrong weights, or none.
 */
export const LORA_HIGH_NOISE_PREFIX = '|high_noise|'

/**
 * Append `<lora:slug:weight>` for every selected LoRA to a prompt.
 *
 * A weight of 0 is DROPPED rather than emitted: it is the engine's own no-op,
 * and a tag that does nothing in a prompt the user can read is noise. An empty
 * list returns the prompt byte-identical, so the non-LoRA path is untouched.
 *
 * `highNoise` emits the `|high_noise|` form above. It is opt-in per selection,
 * so every existing caller is byte-identical.
 */
export function promptWithLoraTags(
  prompt: string,
  loras: ReadonlyArray<{ slug: string; weight?: number; highNoise?: boolean }> | undefined,
): string {
  if (!loras || loras.length === 0) return prompt
  const tags: string[] = []
  for (const l of loras) {
    if (!l || typeof l.slug !== 'string' || !l.slug) continue
    const w = normalizeLoraWeight(l.weight ?? LORA_WEIGHT_DEFAULT)
    if (w === 0) continue
    tags.push(`<lora:${l.highNoise ? LORA_HIGH_NOISE_PREFIX : ''}${l.slug}:${w}>`)
  }
  if (tags.length === 0) return prompt
  return prompt.trim() ? `${prompt} ${tags.join(' ')}` : tags.join(' ')
}

// ── TAGS THE USER TYPED THEMSELVES ───────────────────────────────────────────
//
// `<lora:name:0.8>` is the convention the whole image ecosystem writes, so a
// prompt pasted from Civitai, Reddit or a friend arrives with the tags already
// in it. Two things were wrong with that prompt before this section existed:
//
//  1. `name` is the ORIGINAL file stem on the machine it was written on. Ours is
//     the hash-derived slug (adapterSlug) — `character-design-sheet-…-b316b482`
//     — which nobody types by hand. So the tag named a file that is not on this
//     disk and the engine scanned past it.
//  2. `--lora-model-dir` was passed only when the PICKER had a selection, so a
//     typed tag alone got no directory at all — the "both halves or neither"
//     rule enforced from the wrong end.
//
// A tag that cannot be resolved is REMOVED rather than left in place, and that
// is the part worth being exact about. SOURCE-ASSERTED from the engine's own
// extractor at our pin (`SDGenerationParams::extract_and_remove_lora`,
// examples/common/common.cpp — the file and warning our installed binary prints
// from, `common.cpp:2132 - can not found lora …`):
//
//   • `if (lora_model_dir.empty()) return;` — WITH NO DIRECTORY THE TAGS ARE
//     NEVER EXTRACTED AT ALL, so `<lora:sparkle_v2:0.8>` stays in the prompt as
//     literal text and is conditioned on. That was the app's own output for a
//     typed tag, so a tag that "did nothing" was in fact quietly steering the
//     image. This is the defect, and it is why the directory gate below moved
//     from the picker's selection count to the finished prompt.
//   • With a directory, a tag whose file is missing IS stripped (`regex_replace`
//     to empty) after the warning. So passing the directory is also what makes
//     the engine's own clean-up happen.
//   • The regex is `<lora:([^:>]+):([^>]+)>` — THE WEIGHT IS MANDATORY.
//     `<lora:name>` never matches, so it is never removed either: pure prompt
//     pollution. Rewriting it with an explicit weight (below) is what makes the
//     shorthand people type actually work.
//   • `lora_map[key] += mul` — the same LoRA named twice SUMS. Not our problem
//     to fix, but it is why a duplicate tag is left alone rather than deduped.

/** One `<lora:…>` tag exactly as it appeared in a prompt. */
export interface TypedLoraTag {
  /** The whole tag, for a literal replace. */
  raw:       string
  /** What was typed where the name goes, `|high_noise|` already stripped. */
  typed:     string
  weight:    number
  highNoise: boolean
}

/**
 * Every `<lora:…>` in a prompt.
 *
 * Deliberately permissive about the inside: A1111 also writes
 * `<lora:name:0.8:0.6>` (separate text-encoder and unet weights) and sd.cpp
 * takes one number, so extra segments are dropped rather than making the tag
 * unreadable. The FIRST numeric segment is the weight; a tag with no number at
 * all means weight 1, which is what every surface that omits it intends.
 */
export function loraTagsIn(prompt: string): TypedLoraTag[] {
  const out: TypedLoraTag[] = []
  const re = /<lora:([^<>]+)>/gi
  for (let m = re.exec(prompt); m !== null; m = re.exec(prompt)) {
    const segs = m[1].split(':')
    let name = (segs.shift() ?? '').trim()
    const highNoise = name.startsWith(LORA_HIGH_NOISE_PREFIX)
    if (highNoise) name = name.slice(LORA_HIGH_NOISE_PREFIX.length).trim()
    if (!name) continue
    const num = segs.map(s => Number(s.trim())).find(n => Number.isFinite(n))
    out.push({
      raw:    m[0],
      typed:  name,
      weight: normalizeLoraWeight(num ?? LORA_WEIGHT_DEFAULT),
      highNoise,
    })
  }
  return out
}

/**
 * The comparison key for a LoRA the user named by hand.
 *
 * THIS IS THE NAME HALF OF `adapterSlug`, which imports it — the two must be
 * the same transformation or a typed name can never match the file the app
 * wrote. See the test that asserts the slug's own prefix equals this.
 */
export function loraNameKey(name: string): string {
  return (name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

/** What became of the tags in one prompt. */
export interface LoraTagResolution {
  /** The prompt to send: resolved tags rewritten to slugs, the rest removed. */
  prompt:    string
  /** Tags that will really apply, in the order they appeared. */
  applied:   Array<{ typed: string; slug: string; name: string; weight: number }>
  /** Typed names with no installed LoRA. Removed from the prompt. */
  unknown:   string[]
  /** Typed names matching TWO OR MORE installed LoRAs. Also removed. */
  ambiguous: string[]
}

/**
 * Point the `<lora:…>` tags in a prompt at the files that are actually here.
 *
 * A tag is kept as-is when it already names an installed slug (the app's own
 * preview text, and a re-run of a prompt this function already fixed). Otherwise
 * the typed name is matched by `loraNameKey` against every installed slug's name
 * half and display name.
 *
 * An AMBIGUOUS name is removed, not guessed: the top 600 Civitai LoRAs hold 54
 * outright name collisions, and applying the wrong one at weight 0.8 produces a
 * confidently wrong image, which is worse than an image with no LoRA and a line
 * of text saying so.
 */
export function resolveTypedLoraTags(
  prompt: string,
  installed: ReadonlyArray<{ name: string; slug: string }>,
): LoraTagResolution {
  const tags = loraTagsIn(prompt)
  const res: LoraTagResolution = { prompt, applied: [], unknown: [], ambiguous: [] }
  if (tags.length === 0) return res

  const bySlug = new Map(installed.map(a => [a.slug.toLowerCase(), a]))
  // One key can hold several adapters — that is the collision this reports.
  const byKey = new Map<string, Array<{ name: string; slug: string }>>()
  for (const a of installed) {
    for (const key of new Set([loraNameKey(a.name), loraNameKey(a.slug.replace(/-[0-9a-f]{8}$/i, ''))])) {
      if (!key) continue
      const at = byKey.get(key)
      if (at) at.push(a)
      else byKey.set(key, [a])
    }
  }

  let text = prompt
  for (const tag of tags) {
    const exact = bySlug.get(tag.typed.toLowerCase())
    if (exact) {
      res.applied.push({ typed: tag.typed, slug: exact.slug, name: exact.name, weight: tag.weight })
      continue
    }
    const hits = byKey.get(loraNameKey(tag.typed)) ?? []
    if (hits.length === 1) {
      const a = hits[0]
      const rewritten = `<lora:${tag.highNoise ? LORA_HIGH_NOISE_PREFIX : ''}${a.slug}:${tag.weight}>`
      text = text.replace(tag.raw, rewritten)
      res.applied.push({ typed: tag.typed, slug: a.slug, name: a.name, weight: tag.weight })
      continue
    }
    text = text.replace(tag.raw, '')
    // DE-DUPLICATED, because these are read out to the user: the same bad name
    // typed twice is one thing to fix, not two lines saying it. `applied` is NOT
    // deduped — the engine SUMS a repeated tag's weight, so two entries is what
    // really happens.
    const bucket = hits.length > 1 ? res.ambiguous : res.unknown
    if (!bucket.some(n => n.toLowerCase() === tag.typed.toLowerCase())) bucket.push(tag.typed)
  }
  // Removals leave double spaces and dangling commas behind; the prompt is
  // something the user reads back in the gallery entry, not just argv.
  res.prompt = text.replace(/[ \t]{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*(,|$)/g, '$1').trim()
  return res
}

/** Does this prompt carry a `<lora:…>` tag at all? (the `--lora-model-dir` gate) */
export function hasLoraTag(prompt: string): boolean {
  return /<lora:[^<>]+>/i.test(prompt)
}

/**
 * Toggle one trigger word in a prompt (the applyStyle machinery, one token at a
 * time). Comma-separated, whole-token match, case-insensitive — Civitai's
 * `trainedWords` arrive as one comma-joined string with trailing junk, so a
 * substring match would let "girl" hide "1girl" and the chip would go dead.
 */
export function toggleTriggerWord(prompt: string, word: string): string {
  const w = word.trim()
  if (!w) return prompt
  const parts = prompt.split(',').map(p => p.trim()).filter(Boolean)
  const at = parts.findIndex(p => p.toLowerCase() === w.toLowerCase())
  if (at >= 0) parts.splice(at, 1)
  else parts.push(w)
  return parts.join(', ')
}

/** Is this trigger word already in the prompt? (the chip's ON state) */
export function hasTriggerWord(prompt: string, word: string): boolean {
  const w = word.trim().toLowerCase()
  if (!w) return false
  return prompt.split(',').some(p => p.trim().toLowerCase() === w)
}
