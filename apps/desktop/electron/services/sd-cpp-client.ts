// apps/desktop/electron/services/sd-cpp-client.ts
//
// Runs the stable-diffusion.cpp `sd-cli` binary ONE-SHOT per generation (no
// persistent server — simplest + most reliable; the model reloads each run,
// which is a few seconds for SD 1.5 on GPU). Generations are SERIALIZED (one
// sd-cli at a time) to avoid VRAM thrash.
//
// The arg builder is a pure function (role → flags) so it's reviewable in
// isolation: single-file models use `-m`; Flux/multi-file use
// --diffusion-model/--vae/--clip_l/--t5xxl (+ --clip-on-cpu to keep the text
// encoders off the GPU).

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { type BrowserWindow } from 'electron'
import { ensureStorageDir } from './storage-root'
import {
  findSdRow, DEFAULT_VIDEO_FPS, DEFAULT_VIDEO_PIXEL_GRID, DEFAULT_VIDEO_FRAME_GRID,
  speedLoraSelections, findUpscaler, DEFAULT_UPSCALER_ID,
  type SdGenerationRow, type SdSpeedAdapter,
} from './sd-cpp-models'
import {
  getSdCliPath, isSdModelInstalled, listInstalledSdModels, listInstalledSdAdapters,
  modelComponentPaths, installedAdapterDirs, installedAdapterPath, installedLoraNames,
  findTaeFile, isCudaSdBuild, installedIpAdapterForFamily,
  installedSpeedAdapter, installedUpscalerPath, sdCppUpdateState,
} from './sd-cpp-installer'
// The prompt-tag builder is SHARED with the composer (see localGenParams): the
// tag the user sees in the prompt box and the tag sd-cli parses must be built by
// one function or they drift. Pure module — no React, no DOM (the precedent for
// a main-process service reading src/ is hotkey-manager's HOTKEY_ACTIONS).
// …and for the same reason the BOUNDS of the two capability flags below live
// there too: the schema that renders `n` / `hires` and the arg builder that
// emits `-b` / `--hires` are two files, and a ceiling spelled in each of them is
// a ceiling that drifts.
import {
  promptWithLoraTags, resolveTypedLoraTags, hasLoraTag,
  SD_BATCH_MAX, SD_HIRES_SCALE_DEFAULT, normalizeHiresScale,
  SD_IMG2IMG_STRENGTH_DEFAULT, SD_CLIP_SKIP_MAX,
  SD_IP_ADAPTER_STRENGTH_DEFAULT, normalizeIpAdapterStrength,
  type LocalMemoryFlags,
} from '../../src/pages/media/localGenParams'
import { isEngineMigrating } from './model-storage'
import { TaskFSM } from './util/task-fsm'
import { SdProgressParser, type SdProgress } from './util/sd-progress-parser'
import { killProcessTree } from './util/kill-tree'
import { embedTextChunk, readTextChunks } from './util/png-text'

// ── Generation metadata shape ─────────────────────────────────────────────────
// Written as JSON into the "tachi-gen" tEXt chunk of every locally-generated
// PNG.  Matches the set of params the MediaPage can restore via exifMeta.ts.
export interface TachiGenMeta {
  modelId:        string
  prompt:         string
  negative:       string
  steps:          number
  cfgScale:       number
  samplingMethod: string
  seed:           number
  width:          number
  height:         number
  /**
   * `--hires` was on, and the factor it ran at. Present only then.
   *
   * `width`/`height` above stay the BASE size — the `-W`/`-H` the run was given,
   * which is what reproducing it needs — so on a two-pass run they are
   * deliberately SMALLER than the PNG they are written into (the file is
   * base x scale). sd.cpp's own `parameters` chunk makes the identical
   * distinction on the identical file ("Size: 256x256 … Hires scale: 2.000000"
   * on a 512x512 PNG), so this is the engine's convention, not ours.
   */
  hires?:         boolean
  hiresScale?:    number
  /** WHICH image of a `--batch-count` run this file is (0-based), and how many
   *  there were. Present only for a batch: one image is not "1 of 1", it is the
   *  image. */
  batchIndex?:    number
  batchCount?:    number
  /**
   * THIS WAS AN img2img RUN, at this `--strength`. Present only then.
   *
   * The frame's own bytes are not recorded — a reference photo is megabytes and
   * this chunk rides inside every PNG — so the honest record is the MODE plus the
   * number that decided how much of the frame survived. Without it the file
   * claimed to be a text→image render of its prompt, which it was not.
   */
  initImage?:     boolean
  strength?:      number
  /**
   * A REFERENCE IMAGE steered this render, at this `--ip-adapter-strength`.
   * Present only then.
   *
   * Recorded for the same reason and with the same honesty as `initImage` above:
   * the reference's bytes are megabytes and this chunk rides inside every PNG, so
   * what is written is the MODE and the number. A file made with a reference and
   * no record of it claims to be a render of its prompt alone — which is the
   * bigger lie of the two, because the reference is often what the picture mostly
   * looks like.
   */
  ipAdapterImage?:    boolean
  ipAdapterStrength?: number
  /** `--clip-skip`, when one was passed. It changes the pixels, so it belongs
   *  beside the step count rather than nowhere. */
  clipSkip?:      number
  /** The memory/placement flags the run went out with, when it went out with any
   *  (`--vae-tiling` can leave faint tile seams, and `--auto-fit` moves modules
   *  between devices — both are things a later "why does this one look different"
   *  needs to be able to read). */
  memory?:        SdMemoryFlags
}

/** One LoRA as the composer selected it: the on-disk SLUG plus its weight. */
export interface SdLoraSelection {
  slug:    string
  weight?: number
  /** Aim this tag at a Wan 2.2 A14B HIGH-NOISE expert (`<lora:|high_noise|…>`).
   *  Only a curated speed pack sets it — see promptWithLoraTags. */
  highNoise?: boolean
}

export interface SdGenerateInput extends SdMemoryFlags {
  modelId:         string
  prompt:          string
  negative?:       string
  width?:          number
  height?:         number
  steps?:          number
  cfgScale?:       number
  seed?:           number
  samplingMethod?: string
  initImagePath?:  string  // img2img init frame
  strength?:       number  // img2img (0..1)
  /** `--scheduler`. Omitted ⇒ the ROW's, then sd-cli's own default. */
  scheduler?:      string
  /** `--flow-shift`. Omitted ⇒ the ROW's, then sd-cli's auto. */
  flowShift?:      number
  /** LoRAs to apply — emitted as `<lora:slug:weight>` IN THE PROMPT (there is
   *  no `--lora` flag) alongside `--lora-model-dir`. */
  loras?:          SdLoraSelection[]
  /** An installed VAE adapter's id — the `--vae` swap, which the single-file
   *  `-m` branch could never reach before (the SDXL fp16-VAE black-image trap). */
  vaeAdapterId?:   string
  /** `-b/--batch-count`: N images from ONE model load, each at its own seed.
   *  Absent / 1 ⇒ no flag at all (see buildSdArgs). */
  batchCount?:     number
  /** `--hires`: the engine's single-invocation latent two-pass. */
  hires?:          boolean
  /** `--hires-scale`, honoured only alongside `hires`. */
  hiresScale?:     number
  /**
   * `--clip-skip`: how many trailing CLIP layers to ignore. Absent / <1 ⇒ no
   * flag, i.e. the engine's own per-architecture choice. IMAGE ONLY, and only
   * meaningful on the families whose conditioning IS CLIP — see the schema gate.
   */
  clipSkip?:       number
  /**
   * `--ip-adapter-image`: a picture whose subject and style are carried into the
   * render alongside the words.
   *
   * NOT an init image, and the difference is the whole feature. img2img starts
   * from the reference's PIXELS and walks away from them; this never renders
   * those pixels at all — the reference is encoded by a CLIP-Vision tower and
   * injected as extra tokens through cross-attention, so "this character, new
   * pose" works. The two are independent and may be used together.
   */
  ipAdapterImagePath?: string
  /** `--ip-adapter-strength`. Absent ⇒ SD_IP_ADAPTER_STRENGTH_DEFAULT. Only ever
   *  emitted alongside an image, because alone it steers nothing. */
  ipAdapterStrength?:  number
}

// ── THE MEMORY LADDER ────────────────────────────────────────────────────────
//
// Five flags the pinned binary (commit b290693) has and the app had no way to
// ask for, which is why the committed 8 GB recipe — `--max-vram -1
// --stream-layers --clip-on-cpu --vae-tiling` (VIDEO-MODELS-RESEARCH §4) — could
// be written in a research file and not in the app.
//
// SOURCE-ASSERTED from `sd-cli --help` on that build, verbatim, because two of
// these sentences are the difference between a flag and a lie:
//
//   --max-vram <string>   maximum VRAM budget in GiB for graph-cut segmented
//                         execution. … 0 disables graph splitting; a negative
//                         value auto-detects free VRAM, sparing the specified
//                         value
//   --stream-layers       enable residency+prefetch streaming on top of
//                         --max-vram (NO EFFECT WITHOUT --max-vram; defaults to
//                         false)
//   --auto-fit            pick the diffusion/te/vae device placements
//                         automatically from the model size and the per-device
//                         memory budgets (--max-vram; defaults to free memory
//                         minus a small margin). OVERRIDES --backend and
//                         --params-backend; may split modules across GPUs
//   --vae-tiling          process vae in tiles to reduce memory usage
//   --vae-conv-direct     use ggml_conv2d_direct in the vae model
//
// `--auto-fit` overriding `--backend` matters here: `--clip-on-cpu` is this
// build's deprecated alias for `--backend te=cpu`, and the multi-component branch
// passes it unconditionally. So auto-fit hands OUR text-encoder placement to the
// engine. Both flags still travel — the engine resolves its own precedence, and
// dropping one on the app's say-so would be second-guessing it — and the schema
// description says so where a user can read it.

/** What the run asked the engine to do about memory. Shape shared with the
 *  composer (localGenParams' LocalMemoryFlags) so one bag fills it. */
export type SdMemoryFlags = LocalMemoryFlags

/** What the CALLING PATH already does about memory, whatever the run asked. */
export interface SdMemoryContext {
  /**
   * This path puts every parameter in RAM unconditionally — `buildSdVideoArgs`
   * does, because Wan does not survive on a consumer card otherwise.
   *
   * Passed rather than pushed by the caller so `--offload-to-cpu` has exactly
   * ONE emitter: the flag is also the precondition of `--stream-layers` (below),
   * and two places pushing it would either duplicate it on the video argv or
   * make "is it on the line" a question with two answers.
   */
  offloadToCpu?: boolean
}

// ── WHAT --stream-layers ACTUALLY NEEDS: A CONJUNCTION, NOT ONE FLAG ─────────
//
// The `--help` one-liner we source-asserted from ("no effect without
// --max-vram") is TRUE and INCOMPLETE, and `docs/performance.md` at the same
// commit names the half it omits. Read against the engine source at our pin
// (b290693) rather than against either sentence, there are two conditions and
// the flag needs BOTH:
//
//  1. A VRAM BUDGET. `stream_layers_enabled` reaches the executor through
//     exactly one call — `compute_graph_cut_segments(…, stream_layers_enabled,
//     …)` at ggml_extend.hpp:3127 — and that call sits behind
//     `can_attempt_graph_cut_segmented_compute()`, which is
//     `max_graph_vram_bytes > 0 && !cpu_runtime && !multi_device`. No budget ⇒
//     the segmenter is never attempted ⇒ the flag is inert. (`--max-vram -1`
//     counts: a negative value resolves to free-VRAM-minus-the-spare in
//     ggml_graph_cut.cpp:251, i.e. a positive byte budget.)
//
//  2. THE DIFFUSION PARAMS BACKEND ON CPU. stable-diffusion.cpp:874 —
//       if (stream_layers && !backend_manager.params_backend_is_cpu(DIFFUSION)) {
//           LOG_WARN("--stream-layers has no effect unless diffusion params
//                     backend is cpu; ignoring");
//           stream_layers = false;
//       }
//     `--offload-to-cpu` is what puts it there: common.cpp:770 prepends `*=cpu`
//     to `--params-backend`. Nothing else on our command line can.
//
// The image path emitted (1) and never (2) — `buildSdArgs` did not pass
// `--offload-to-cpu` at all — so EVERY image-path `--stream-layers` was dropped
// by the engine with that warning, and `effectiveMemoryFlags` stamped
// `streamLayers: true` into the PNG anyway. The video path was right by
// accident: buildSdVideoArgs has always passed `--offload-to-cpu`
// unconditionally for Wan's sake, which happens to satisfy (2).
//
// AND `--auto-fit` TAKES (2) AWAY AGAIN. backend_fit.cpp:326 logs "--auto-fit is
// enabled; ignoring --backend / --params-backend" and then OVERWRITES the params
// spec from its own plan, before the check at :874 runs. So with auto-fit on,
// `--offload-to-cpu` is discarded and whether streaming survives is decided by a
// device-fitting plan the app deliberately handed away. The command line can no
// longer promise the precondition, so the flag is not emitted and not stamped.
// That is not the app second-guessing the engine (cf. `--clip-on-cpu`, which
// still travels alongside auto-fit): it is declining to RECORD A FACT the argv
// cannot support. `--clip-on-cpu` reaches no provenance chunk; this does.

/**
 * Pure: the memory/placement flags for one run, in a fixed order.
 *
 * THE GATE IS HERE AND NOWHERE ELSE — see the conjunction above. A
 * `--stream-layers` whose preconditions we cannot put on the line is dropped
 * rather than emitted, and when we CAN, the precondition
 * (`--offload-to-cpu`) is emitted with it instead of being left to a path that
 * happens to pass it. The provenance stamp derives from this same array, so
 * "what the command line said" and "what the entry claims" cannot diverge.
 *
 * Returns [] when nothing was asked for and the path adds nothing, so every
 * existing run's argv is byte-identical.
 */
export function sdMemoryArgs(flags: SdMemoryFlags | undefined, ctx: SdMemoryContext = {}): string[] {
  const args: string[] = []
  const autoFit = flags?.autoFit === true
  const budget = typeof flags?.maxVramGb === 'number' && Number.isFinite(flags.maxVramGb) && flags.maxVramGb !== 0
    ? Math.trunc(flags.maxVramGb)
    : null
  // Both halves of the conjunction, and neither is negotiable.
  const streaming = flags?.streamLayers === true && budget !== null && !autoFit
  // …and the precondition, from whichever of the three reasons applies. First in
  // the block so the video argv (which used to push it immediately before this
  // call) is byte-identical.
  if (ctx.offloadToCpu || flags?.offloadToCpu === true || streaming) args.push('--offload-to-cpu')
  if (autoFit) args.push('--auto-fit')
  if (budget !== null) args.push('--max-vram', String(budget))
  if (streaming) args.push('--stream-layers')
  if (flags?.vaeTiling)     args.push('--vae-tiling')
  if (flags?.vaeConvDirect) args.push('--vae-conv-direct')
  return args
}

/**
 * The memory flags a run REALLY went out with, or undefined when it went out
 * with none.
 *
 * Derived from sdMemoryArgs rather than from the request, so an ignored
 * `--stream-layers` never reaches provenance as if it had been in play. Undefined
 * (not an empty object) so an existing run's stamp is byte-identical.
 *
 * NO SdMemoryContext, deliberately: the question this answers is "what did THIS
 * RUN ask the engine to do about memory", and buildSdVideoArgs' unconditional
 * `--offload-to-cpu` is a property of the video path, not of the run — it has
 * never been stamped and stamping it now would put an identical constant in
 * every video entry. The run's OWN `--offload-to-cpu` (explicit, or implied by
 * streaming) does reach the stamp, because there it is a choice with a cost.
 */
function effectiveMemoryFlags(flags: SdMemoryFlags | undefined): SdMemoryFlags | undefined {
  if (!flags) return undefined
  const emitted = sdMemoryArgs(flags)
  const out: SdMemoryFlags = {}
  if (emitted.includes('--offload-to-cpu'))   out.offloadToCpu  = true
  if (emitted.includes('--auto-fit'))         out.autoFit       = true
  if (emitted.includes('--stream-layers'))    out.streamLayers  = true
  if (emitted.includes('--vae-tiling'))       out.vaeTiling     = true
  if (emitted.includes('--vae-conv-direct'))  out.vaeConvDirect = true
  const at = emitted.indexOf('--max-vram')
  if (at >= 0) out.maxVramGb = Number(emitted[at + 1])
  return Object.keys(out).length > 0 ? out : undefined
}

/** Clamp one `--clip-skip` onto the band the control offers, or null for the
 *  engine's own "unspecified" (its `<= 0`). */
function normalizeClipSkip(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n) || n < 1) return null
  return Math.min(SD_CLIP_SKIP_MAX, Math.floor(n))
}

/** ONE image out of a run — a batch of N produces N of these, in engine order. */
export interface SdGeneratedImage {
  path: string
  b64:  string
  mime: string
  /** The seed THIS file was sampled at, read from THIS file — see collectSdImages. */
  seed: number
}

export interface SdGenerateResult {
  path: string
  b64: string
  mime: string
  /** The seed the ENGINE used — see resolveActualSeed. Absent = unknowable. */
  seed?: number
  /** The recipe the engine was actually given — see SdEffectiveParams. */
  effective?: SdEffectiveParams
  /**
   * EVERY image the run produced, always length >= 1.
   *
   * `path`/`b64`/`seed` above are `images[0]` — kept so every caller written
   * before `--batch-count` existed is byte-identical. A caller that renders a
   * gallery must read THIS: a 4-image run whose consumer only looks at the top
   * three fields silently discards three finished renders, which is a worse lie
   * than the dead `n` control this replaced.
   */
  images: SdGeneratedImage[]
}

// ── The seed the engine ACTUALLY used ────────────────────────────────────────
//
// Driver finding: every locally-generated PNG carried `"seed": -1` in its
// tachi-gen chunk. -1 is the REQUEST ("pick one for me"), not the answer, so
// the chunk could not reproduce its own image — the single thing generation
// metadata exists for. The real number was sitting in the file the whole time,
// in sd.cpp's OWN `parameters` tEXt chunk (driver read 16124 out of it by hand).
//
// The same hole swallowed the no-seed case: `buildSdArgs` omits `--seed`
// entirely when the caller passes none, and sd-cli's own default is a fixed
// number, not "random" — so those runs were reproducible and we still wrote -1.
//
// TWO SOURCES, IN THIS ORDER:
//  1. sd.cpp's `parameters` chunk. It is the engine's own record OF THIS FILE,
//    written by the same code path that seeded the sampler, and it survives
//    however the CLI's logging is reworked upstream. It has TWO layers — a
//    machine-readable `, SDCPP: {json}` tail and the A1111-style string it is
//    appended to — and the tail is read first; see SDCPP_TAIL_MARKER for why
//    that is a correctness fix and not a preference.
//  2. the run log. The only source for VIDEO, whose .webm has no chunk to read.

/** `Seed: 16124` inside sd.cpp's A1111-style `parameters` chunk. */
const SEED_IN_PARAMETERS = /\bSeed:\s*(\d+)/g
/** `generating image: 1/1 - seed 16124` on the CLI's own progress stream. */
const SEED_IN_LOG = /generating\s+(?:image|video)[^\n]*?\bseed\s+(\d+)/gi

/** Last capture of a global regex, or null. */
function lastCapture(re: RegExp, text: string): number | null {
  re.lastIndex = 0
  let out: number | null = null
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const n = Number(m[1])
    if (Number.isSafeInteger(n) && n >= 0) out = n
  }
  return out
}

// ── THE `, SDCPP: {json}` TAIL — WHY A PROMPT COULD OUT-VOTE THE SEED ────────
//
// sd.cpp appends a machine-readable copy of the whole recipe to the END of the
// same `parameters` string (common.cpp:3007 at our pin b290693):
//
//   … Sampler: euler, Version: stable-diffusion.cpp, SDCPP: {"schema":
//   "sdcpp.image.params/v1", …, "seed":16124, …, "prompt":{"positive":"…"}}
//
// That JSON ECHOES THE PROMPT, and it sits AFTER the genuine `Seed:` field. Our
// "last match wins" rule was built on the assumption that the prompt only ever
// comes FIRST (the chunk opens with it), so a prompt containing the literal text
// `Seed: 999` was harmless. With the tail there is a SECOND copy of the prompt
// after the metadata, and the last `Seed:` in the string is the one the user
// typed. A user who prompts "Seed: 999" got 999 recorded as the seed of an image
// nothing sampled — the exact failure resolveActualSeed exists to prevent, one
// source over.
//
// THE JSON IS THE BETTER SOURCE, and not merely a safer one:
//   • It is STRUCTURED. `root["seed"]` is a JSON number written by the same code
//     that wrote `Seed:` (the same `seed` argument), so nothing a user can type
//     into a prompt can be mistaken for it — the echo lands inside a JSON string
//     value, where it is data by construction rather than by regex luck.
//   • It declares its own SCHEMA (`sdcpp.image.params/v1`), so we can tell the
//     engine's block from anything else that happens to look like it.
//   • It is in bytes WE ALREADY HOLD. Upstream also ships `-M metadata
//     --metadata-format json` to read this back without loading a model, and
//     that is the wrong trade here: a process spawn per image, on a path that
//     already has the PNG in memory, to obtain the identical string.
//
// The A1111 field stays as the FALLBACK, for images written before the tail
// existed — but parsed only from the text BEFORE the tail, so the echo can never
// be the last match. Anchoring on the FIRST marker is deliberate: a prompt that
// itself contains `, SDCPP: ` truncates too much and yields NO seed, which falls
// through to the log. Losing a fact is recoverable; recording a wrong one is not.
const SDCPP_TAIL_MARKER = ', SDCPP: '
const SDCPP_SCHEMA_PREFIX = 'sdcpp.image.params/'

/**
 * The engine's own structured block out of a `parameters` string, or null.
 *
 * Every occurrence of the marker is tried, earliest first, and a candidate is
 * accepted only when the WHOLE remainder of the string parses as one JSON object
 * carrying the engine's schema. That is what makes it injection-proof: the real
 * tail is the only marker whose remainder runs to the end of the string, so a
 * copy of the marker inside the prompt is followed by `…\nSteps: 20, …` and
 * JSON.parse rejects it on the trailing text. (The escaped copy inside the tail's
 * own prompt echo cannot parse either — it begins `{\"`, and a backslash is never
 * valid at a JSON structural position.)
 */
export function parseSdcppMetadata(parameters: string | null | undefined): Record<string, unknown> | null {
  if (!parameters) return null
  for (let at = parameters.indexOf(SDCPP_TAIL_MARKER); at >= 0;
       at = parameters.indexOf(SDCPP_TAIL_MARKER, at + 1)) {
    try {
      const parsed: unknown = JSON.parse(parameters.slice(at + SDCPP_TAIL_MARKER.length))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
      const schema = (parsed as Record<string, unknown>).schema
      if (typeof schema === 'string' && schema.startsWith(SDCPP_SCHEMA_PREFIX)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* not the tail — keep looking */ }
  }
  return null
}

/** The `parameters` text with the engine's JSON tail cut off, for the A1111
 *  fallback. See the marker comment for why this cuts at the FIRST marker. */
function beforeSdcppTail(parameters: string): string {
  const at = parameters.indexOf(SDCPP_TAIL_MARKER)
  return at < 0 ? parameters : parameters.slice(0, at)
}

/**
 * The seed the engine used, from what it wrote about the run. Null when
 * neither source says — the caller then falls back to the REQUEST, and only
 * when that request was itself a concrete number.
 *
 * THREE SOURCES, IN THIS ORDER:
 *  1. the `, SDCPP:` JSON's `seed`, which a prompt cannot reach (above);
 *  2. the A1111 `Seed:` field, read from the text BEFORE that JSON. The LAST
 *     match there still wins, because the chunk OPENS with the prompt and a
 *     prompt containing "Seed: 7" must not out-vote the metadata after it;
 *  3. the run log, whose last match is the file we just read — and the only
 *     source at all for a .webm, which has no chunk.
 */
export function parseSdSeed(sources: { parameters?: string | null; log?: string | null }): number | null {
  if (sources.parameters) {
    const meta = parseSdcppMetadata(sources.parameters)
    const structured = typeof meta?.seed === 'number' ? meta.seed : NaN
    if (Number.isSafeInteger(structured) && structured >= 0) return structured
    const fromChunk = lastCapture(SEED_IN_PARAMETERS, beforeSdcppTail(sources.parameters))
    if (fromChunk !== null) return fromChunk
  }
  return sources.log ? lastCapture(SEED_IN_LOG, sources.log) : null
}

/**
 * What the tachi-gen chunk (and the gallery entry) may claim as the seed.
 *
 * THE PIN: a `-1` request must NEVER reach the chunk when the engine chose a
 * concrete seed. Requested-and-honoured is also a real answer (we passed
 * `--seed N`, so N IS what ran) — it is only the "pick one for me" case that
 * has no answer of its own, and there -1 stays, honestly, when neither the
 * chunk nor the log spoke.
 */
export function resolveActualSeed(observed: number | null, requested: number | undefined): number {
  if (observed !== null) return observed
  if (typeof requested === 'number' && requested >= 0) return requested
  return -1
}

// ── --batch-count: N images, N SEEDS, one model load ─────────────────────────
//
// The `n` ("Images: 1–4") control was dead on this route: nothing emitted
// `-b`, so setting 4 got 1. Un-hiding it needs three engine facts, and all
// three are SOURCE-ASSERTED against the pinned binary (master-782-b290693)
// rather than assumed, because getting any of them wrong is silent:
//
//   $ sd-cli -m sd-turbo/model.safetensors -p "a red cube" -W 256 -H 256 \
//            --steps 1 --cfg-scale 1 -s 42 -b 3 -o ./out.png
//     stable-diffusion.cpp:5321 - generating image: 1/3 - seed 42
//     stable-diffusion.cpp:5321 - generating image: 2/3 - seed 43
//     stable-diffusion.cpp:5321 - generating image: 3/3 - seed 44
//     main.cpp:490 - save result image 0 to './out_0.png' (success)
//     main.cpp:490 - save result image 1 to './out_1.png' (success)
//     main.cpp:490 - save result image 2 to './out_2.png' (success)
//     main.cpp:562 - 3/3 images saved
//
//  1. THE SEEDS INCREMENT: image i is sampled at `seed + i`. The same probe with
//     `-s -1` drew ONE random base and incremented from it (18002/18003/18004),
//     so a batch is not N independent draws and the app must not claim it is.
//  2. EVERY FILE CARRIES ITS OWN NUMBER. Reading all three PNGs back gave
//     `Seed: 18002` / `18003` / `18004` in each file's own `parameters` chunk —
//     so the honest per-image seed is READ, not computed, and the increment
//     above is only the last-resort fallback.
//  3. THE FILENAME CHANGES, and only for a batch. `-b 1` writes exactly what
//     `-o` said (`one.png`, verified); `-b N>1` writes `<stem>_0<ext> …
//     <stem>_{N-1}<ext>` and NEVER `<stem><ext>`. A collector that reads `-o`
//     back after a batch run finds no file at all — and the exit check that
//     asks "did anything get written" would call a perfectly good 3-image run a
//     silent failure.

/** `generating image: 2/3 - seed 43` — one capture per image, IN ENGINE ORDER. */
const SEED_SEQUENCE_IN_LOG = /generating\s+(?:image|video)[^\n]*?\bseed\s+(\d+)/gi

/**
 * Every seed the run log announced, in the order the engine sampled them.
 *
 * parseSdSeed deliberately returns the LAST match (the single file we just read);
 * a batch needs the whole sequence, positionally, so image 0 is not stamped with
 * image 3's seed. Kept separate rather than folding parseSdSeed into it because
 * that function's "last match wins" is a load-bearing rule of its own (a prompt
 * containing the literal text "Seed: 7") and this is a different question.
 */
export function parseSdSeedSequence(log: string | null | undefined): number[] {
  if (!log) return []
  SEED_SEQUENCE_IN_LOG.lastIndex = 0
  const out: number[] = []
  for (let m = SEED_SEQUENCE_IN_LOG.exec(log); m !== null; m = SEED_SEQUENCE_IN_LOG.exec(log)) {
    const n = Number(m[1])
    if (Number.isSafeInteger(n) && n >= 0) out.push(n)
  }
  return out
}

/** Coerce a batch request to a runnable count. Clamped to SD_BATCH_MAX — the
 *  same ceiling the composer's own control offers, so a hand-edited flow cannot
 *  ask for 400 images. */
export function normalizeBatchCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(n)) return 1
  return Math.min(SD_BATCH_MAX, Math.max(1, Math.floor(n)))
}

/**
 * The path sd-cli will actually write for image `index` of a `count`-image run.
 *
 * `count <= 1` returns `outPath` UNCHANGED — that is the engine's behaviour
 * (fact 3 above) and it is what keeps every pre-batch run byte-identical.
 * Otherwise `_<index>` is spliced in before the extension.
 */
export function sdBatchOutputPath(outPath: string, index: number, count: number): string {
  if (count <= 1) return outPath
  const dot = outPath.lastIndexOf('.')
  const slash = Math.max(outPath.lastIndexOf('/'), outPath.lastIndexOf('\\'))
  // A dot before the last separator belongs to a DIRECTORY name, not this file.
  if (dot <= slash) return `${outPath}_${index}`
  return `${outPath.slice(0, dot)}_${index}${outPath.slice(dot)}`
}

/** Every path a `count`-image run will have written, in engine order. */
export function sdBatchOutputPaths(outPath: string, count: number): string[] {
  const n = Math.max(1, Math.floor(count))
  return Array.from({ length: n }, (_, i) => sdBatchOutputPath(outPath, i, n))
}

/**
 * The seed to FALL BACK to for image `index` when neither the file nor the log
 * said — i.e. the request, shifted the way the engine shifts it.
 *
 * A `-1` (or absent) request is left alone: "pick one for me" has no answer to
 * shift, and `-1 + 2` would be a number nothing ran at, written into provenance
 * as if it were fact.
 */
export function sdBatchSeedRequest(requested: number | undefined, index: number): number | undefined {
  if (typeof requested !== 'number' || requested < 0) return requested
  return requested + index
}

function outDir(): string {
  // Final artifact location — the returned `path` IS what the renderer reveals
  // and serves, so it lives in the user-visible Media folder (legacy
  // userData/sd-cpp/out files are unaffected; only new generations land here).
  //
  // ensureStorageDir, not a bare mkdir: sd-cli writes the PNG itself, so the
  // last moment we can heal a storage root that went unwritable mid-session
  // (Defender Controlled Folder Access on Documents — LANE J/L) is BEFORE the
  // process is spawned. The probe moves the whole generation to a writable root
  // instead of burning GPU minutes and dying on the output write.
  return ensureStorageDir('media', 'sd')
}

/**
 * Everything about the MACHINE and the DISK that the arg builder needs but must
 * not go looking for itself. Injected so buildSdArgs stays a pure function of
 * its inputs — the whole reason it is reviewable and unit-tested.
 */
export interface SdArgEnv {
  /** Registry row for `input.modelId`. Injected in tests; resolved by callers. */
  row?:         SdGenerationRow
  /** `--lora-model-dir` / `--embd-dir`, per kind that HAS an installed file. */
  adapterDirs?: Partial<Record<'lora' | 'embedding' | 'vae', string>>
  /**
   * Every installed LoRA's DISPLAY NAME and on-disk SLUG, so a `<lora:…>` tag
   * the user typed themselves can be pointed at the file that is really here —
   * see resolveTypedLoraTags. Injected rather than looked up so buildSdArgs stays
   * a pure function; absent ⇒ typed tags resolve against nothing, which is the
   * same as this env field not existing.
   */
  installedLoras?: ReadonlyArray<{ name: string; slug: string }>
  /**
   * The INSTALLED IP-Adapter for this row's family, both paths at once — see
   * installedIpAdapterForFamily. Absent ⇒ no reference-image flags at all, which
   * is byte-identical to every run before the feature existed.
   *
   * Both paths together because the engine's own help says
   * "--ip-adapter … (requires --clip_vision)": one without the other is a command
   * line it rejects, so they cannot be two optional fields.
   */
  ipAdapter?: { id: string; adapter: string; clipVision: string }
  /** Absolute path of the VAE adapter the run selected (`--vae`). */
  vaePath?:     string
  /** Absolute path of a TAE decoder for this model (`--tae`). */
  taePath?:     string
  /** The installed engine is the CUDA build (`--diffusion-fa`). */
  cuda?:        boolean
  /**
   * THE SPEED PACK, already resolved: present ONLY when this row's curated
   * distill LoRAs are on disk AND the run asked for them. Never a request —
   * sdArgEnvFor does the disk lookup so buildSdVideoArgs stays pure.
   */
  speed?:       SdSpeedAdapter
  /**
   * Where the engine should write its LIVE PREVIEW, and how often.
   *
   * Absent ⇒ no preview flags at all, which is byte-identical to every run
   * before this existed. Present ⇒ the caller has somewhere to watch and will
   * clean the file up.
   */
  preview?:     { path: string; intervalSteps: number }
}

// ── WHAT THE ENGINE WAS ACTUALLY TOLD ────────────────────────────────────────
//
// Driver finding (speed A/B, 2026-07-31): a speed-pack run spawned
// `--steps 4 --cfg-scale 1` (SDCLI-WATCH.log) and the gallery entry it produced
// recorded `steps: 20, cfg: 6` — the composer's bag, verbatim. Remixing that
// entry re-ran a 20-step render and called it a reproduction.
//
// The out-vote itself is correct and deliberate (buildSdVideoArgs says so, and
// so does the toggle that turns it on). The bug was that the RESOLUTION lived
// inline in the argv builder — `speed?.preset.steps ?? input.steps ?? m?.steps
// ?? 20`, evaluated into a string and thrown away with the array — so nothing
// downstream could see it. It is a named function now, and the argv builders
// call it rather than repeating the ladder, so provenance and command line
// cannot drift.
//
// Same shape as resolveActualSeed: ask what happened, never assume the request.

/** The recipe the run went out with, after every override has been applied. */
export interface SdEffectiveParams {
  steps:          number
  cfgScale:       number
  samplingMethod: string
  /** Only when a `--scheduler` was actually passed. */
  scheduler?:     string
  /** Only when a `--flow-shift` was actually passed. */
  flowShift?:     number
  /**
   * Only when `--hires` was actually passed, with the `--hires-scale` that went
   * with it. IMAGE ONLY — `-M vid_gen` has no highres-fix pass — which is why
   * effectiveVideoParams never sets it rather than setting it to false.
   *
   * It belongs on the RECIPE object rather than beside it because the second
   * pass is a recipe fact of the same weight as the step count: it decides the
   * pixels that come out. Being here is what makes it reach BOTH provenance
   * surfaces (the tEXt chunk and the gallery entry) through the seam that
   * already exists, instead of a third one that would drift.
   */
  hires?:         boolean
  hiresScale?:    number
  /**
   * `-i` was on the command line, and the `--strength` that went with it. IMAGE
   * ONLY — `-M vid_gen` takes an init frame and no strength at all.
   *
   * PRESENT ONLY ON AN img2img RUN, which is the point: the gallery entry of one
   * recorded `steps: 20` and nothing else, because the reference frame lives in
   * `params.image_url` as a `data:` URL that media.store strips before
   * localStorage, and the strength was never in the bag at all (it was the arg
   * builder's own `?? 0.6`). A persisted img2img entry was therefore
   * indistinguishable from a text→image one and Remix re-ran it as text→image.
   */
  initImage?:     boolean
  strength?:      number
  /** `--clip-skip`, when one was really passed. A recipe fact of the same weight
   *  as the step count: it changes the pixels. */
  clipSkip?:      number
  /**
   * `--ip-adapter-image` was on the command line, and the strength that went with
   * it. Present only on a run that had one — the same rule `initImage` follows,
   * for the same reason: a text-only render carrying an `ipAdapterStrength: 0.8`
   * in its provenance describes a run that never happened, and Remix would
   * restore it.
   *
   * A BOOLEAN, exactly like `initImage`, and not the path: the path is a temp file
   * this process deletes when the run ends, so a gallery entry holding it would
   * name a file that no longer exists. The argv reads the path from the REQUEST;
   * what the recipe records is which mode ran.
   */
  ipAdapterImage?:    boolean
  ipAdapterStrength?: number
  /** The memory/placement flags that were REALLY in play — see
   *  effectiveMemoryFlags. Absent when the run asked for none. */
  memory?:        SdMemoryFlags
}

/**
 * The speed pack, IF it is really in play.
 *
 * `--lora-model-dir` gates the WHOLE preset, not just the tags (see
 * buildSdVideoArgs: "four steps at guidance 1 without the distill weights
 * applied is not a fast render, it is noise"). The stamp has to make the same
 * call or it describes a 4-step run that went out at 20.
 */
function activeSpeed(env: SdArgEnv): SdSpeedAdapter | undefined {
  return env.adapterDirs?.lora ? env.speed : undefined
}

/** IMAGE: the composer, then the row, then sd-cli's own defaults. No speed
 *  packs exist for image rows today; the ladder is written once regardless. */
export function effectiveImageParams(input: SdGenerateInput, env: SdArgEnv = {}): SdEffectiveParams {
  const model = env.row ?? findSdRow(input.modelId)
  const out: SdEffectiveParams = {
    steps:          input.steps          ?? model?.steps          ?? 20,
    cfgScale:       input.cfgScale       ?? model?.cfgScale       ?? 7,
    samplingMethod: input.samplingMethod ?? model?.samplingMethod ?? 'euler',
  }
  const scheduler = input.scheduler ?? model?.scheduler
  if (scheduler) out.scheduler = scheduler
  const flowShift = input.flowShift ?? model?.flowShift
  if (typeof flowShift === 'number') out.flowShift = flowShift
  // THE SECOND PASS. The toggle is the gate and the scale is normalized here,
  // once, so the number in the provenance is the number on the command line even
  // when the bag carried something off-band. No row declares a hires recipe (no
  // checkpoint is "a hires model"), so there is no row rung in this ladder.
  if (input.hires) {
    out.hires = true
    out.hiresScale = normalizeHiresScale(input.hiresScale ?? SD_HIRES_SCALE_DEFAULT)
  }
  // THE INIT FRAME IS THE GATE for the strength, exactly as the argv has it:
  // `--strength` without `-i` is a flag the engine has nothing to apply it to,
  // and a provenance entry claiming a strength on a text→image run would be the
  // checkpoint-A lie in the opposite direction. SD_IMG2IMG_STRENGTH_DEFAULT is
  // the ONE default — the same constant the composer's spec renders — so the
  // number in the entry is the number on the command line is the number on
  // screen. Clamped here, once, because the bag comes out of localStorage.
  if (input.initImagePath) {
    out.initImage = true
    const asked = typeof input.strength === 'number' && Number.isFinite(input.strength)
      ? input.strength
      : SD_IMG2IMG_STRENGTH_DEFAULT
    out.strength = Math.min(1, Math.max(0, asked))
  }
  // THE REFERENCE IMAGE IS THE GATE FOR ITS OWN STRENGTH, same law as the init
  // frame one line up. Recorded on the recipe rather than beside it because it
  // decides the pixels: a Remix that restores the words and the seed and NOT the
  // reference reproduces a different picture and calls it the same one.
  //
  // …AND THE WEIGHTS ARE A GATE TOO (`env.ipAdapter`), which is the whole reason
  // this reads the env rather than the request alone. Without the adapter on disk
  // the argv carries no reference flags at all, so recording one here would stamp
  // a picture that never influenced this render — the same lie the img2img
  // strength told when it was resolved in two places.
  if (input.ipAdapterImagePath && env.ipAdapter) {
    out.ipAdapterImage    = true
    out.ipAdapterStrength = normalizeIpAdapterStrength(input.ipAdapterStrength)
  }
  // CLIP SKIP: the composer, then the ROW's own recipe. No engine rung — the
  // engine's default is "unspecified", which is the absence of the flag.
  const clipSkip = normalizeClipSkip(input.clipSkip ?? (model && model.kind === 'image' ? model.clipSkip : undefined))
  if (clipSkip !== null) out.clipSkip = clipSkip
  const memory = effectiveMemoryFlags(input)
  if (memory) out.memory = memory
  return out
}

/** VIDEO: the PACK out-votes the composer, which out-votes the row. */
export function effectiveVideoParams(input: SdVideoInput, env: SdArgEnv = {}): SdEffectiveParams {
  const row = env.row ?? findSdRow(input.modelId)
  const m = row && row.kind === 'video' ? row : undefined
  const speed = activeSpeed(env)
  const out: SdEffectiveParams = {
    steps:          speed?.preset.steps          ?? input.steps          ?? m?.steps          ?? 20,
    cfgScale:       speed?.preset.cfgScale       ?? input.cfgScale       ?? m?.cfgScale       ?? 6,
    samplingMethod: speed?.preset.samplingMethod ?? input.samplingMethod ?? m?.samplingMethod ?? 'euler',
  }
  const scheduler = speed?.preset.scheduler ?? input.scheduler ?? m?.scheduler
  if (scheduler) out.scheduler = scheduler
  const flowShift = speed?.preset.flowShift ?? input.flowShift ?? m?.flowShift
  if (typeof flowShift === 'number') out.flowShift = flowShift
  // The memory ladder is not a video/image distinction — this path is the one
  // whose 6-9 GB VAE decode actually gets reaped mid-render — so the same
  // resolution runs here. No `initImage` / `strength` / `clipSkip`: `-M vid_gen`
  // takes a frame and no strength, and Wan/LTX condition on umt5/Gemma, not CLIP.
  const memory = effectiveMemoryFlags(input)
  if (memory) out.memory = memory
  return out
}

/**
 * Pure: build the sd-cli argv from a model's component paths + generation input.
 * Single-file models (role `model`) → `-m`. Flux/multi-file → the component flags.
 *
 * THE ROW (audit D4). `env.row` comes from findSdRow — curated ∪ USER — and
 * every fallback below reads it. The lookup this replaced was
 * `SD_IMAGE_MODELS.find`, i.e. CURATED ONLY: an installed Civitai SDXL
 * checkpoint fell through to 512x512 / 20 steps / cfg 7 / euler, which is the
 * SD 1.5 recipe, on a model whose own row says 1024 / 28 / 5 / dpm++2m. It then
 * wrote those same wrong numbers into the PNG's provenance chunk.
 */
export function buildSdArgs(
  components: Record<string, string>,
  input: SdGenerateInput,
  outPath: string,
  env: SdArgEnv = {},
): string[] {
  const model = env.row ?? findSdRow(input.modelId)
  const baseSize = model && model.kind === 'image' ? model.baseSize : undefined
  const args: string[] = []
  if (components.model) {
    args.push('-m', components.model)
    // THE SINGLE-FILE VAE SWAP. `--vae` used to be reachable only on the
    // multi-component branch, so a single-file SDXL checkpoint could never be
    // given one — the fp16-VAE black-image trap with no way out. A VAE adapter
    // the user selected wins; the model's own `vae` component is the fallback
    // for a row that ships one alongside a single-file checkpoint.
    const vae = env.vaePath ?? components.vae
    if (vae) args.push('--vae', vae)
  } else {
    if (components.diffusion) args.push('--diffusion-model', components.diffusion)
    const vae = env.vaePath ?? components.vae
    if (vae)                  args.push('--vae', vae)
    if (components.clip_l)    args.push('--clip_l', components.clip_l)
    if (components.clip_g)    args.push('--clip_g', components.clip_g)
    if (components.t5xxl)     args.push('--t5xxl', components.t5xxl)
    // THE LLM TEXT ENCODER (`--llm`). The newer conditioning shape: SD 1.5 has
    // CLIP, Flux.1 has T5-XXL, and Z-Image / Flux.2 / Qwen-Image condition on a
    // general-purpose LLM instead. Until this line existed the role could be
    // downloaded and placed but never reached the engine, so every
    // LLM-conditioned architecture at our pin was uncurateable.
    //
    // `--llm` and NOT `--qwen2vl`: the pinned binary's help lists the latter as
    // "alias of --llm. Deprecated." — it would work today and rot on a bump.
    if (components.llm)       args.push('--llm', components.llm)
    args.push('--clip-on-cpu')  // keep text encoders off the GPU to save VRAM (Flux, Z-Image)
  }
  // A LoRA is named IN THE PROMPT — `<lora:slug:weight>` — and the directory
  // flag only says where to look. BOTH HALVES OR NEITHER: a tag with no
  // `--lora-model-dir` is a scan the engine logs and moves past, i.e. the
  // silent no-op this whole feature exists to prevent, so the tags are only
  // written when there is a directory to resolve them in.
  //
  // The gate is now the FINISHED PROMPT rather than the picker's selection
  // count, because a tag can also arrive typed (a pasted prompt) — see
  // resolveTypedLoraTags. Every run that got the directory before still gets it;
  // a typed-only run stops being the silent no-op described above.
  const loraDir = env.adapterDirs?.lora
  const loras   = loraDir ? input.loras : undefined
  const typed   = resolveTypedLoraTags(input.prompt, env.installedLoras ?? [])
  const prompt  = promptWithLoraTags(typed.prompt, loras)
  args.push('-p', prompt)
  if (input.negative) args.push('-n', input.negative)
  if (loraDir && hasLoraTag(prompt)) args.push('--lora-model-dir', loraDir)
  // Textual inversions have no selection UI at all: the engine matches the
  // FILE STEM against words in the prompt, so the directory is the whole
  // mechanism and it is passed whenever one embedding is installed.
  if (env.adapterDirs?.embedding) args.push('--embd-dir', env.adapterDirs.embedding)
  args.push('-W', String(input.width  ?? baseSize ?? 512))
  args.push('-H', String(input.height ?? baseSize ?? 512))
  // ONE resolution, read by the argv AND by the provenance stamp — see
  // effectiveImageParams. `--scheduler` / `--flow-shift` stay OMITTED unless
  // something asks for them (the function returns them undefined): sd-cli's
  // default is model-specific and correct for a normal run, and they exist for
  // DISTILLED weights, where the default DISCRETE schedule emits timesteps the
  // distill was never trained on and the output gets blamed on the LoRA
  // (VIDEO-MODELS-RESEARCH §2, "THE SCHEDULER TRAP").
  const eff = effectiveImageParams(input, { ...env, row: model })
  args.push('--steps', String(eff.steps))
  args.push('--cfg-scale', String(eff.cfgScale))
  args.push('--sampling-method', eff.samplingMethod)
  if (eff.scheduler) args.push('--scheduler', eff.scheduler)
  if (typeof eff.flowShift === 'number') args.push('--flow-shift', String(eff.flowShift))
  if (eff.hires) {
    // THE SINGLE-INVOCATION TWO-PASS. `--hires` runs the low-res sample, upscales
    // the LATENT (`--hires-upscaler`, default `Latent`) and re-denoises inside the
    // SAME process — one model load, one VAE decode, and the second pass sees the
    // first one's latent rather than a re-encoded PNG. That is why it beats the
    // naive "generate small, then img2img big" loop this app could already
    // express: two invocations pay the load twice and lose the latent in between.
    //
    // Probe on the pinned build (256x256 base, --hires-scale 2 --hires-steps 3
    // --hires-denoising-strength 0.5):
    //   hires fix: upscaling to 512x512
    //   hires fix: scheduler_steps=6, denoising_strength=0.50, sigma_sched_size=5
    //   hires Latent upscale 32x32 -> 64x64
    // …and the PNG came out 512x512 with the base 256x256 in its own chunk.
    //
    // ONLY THE TWO FLAGS THE COMPOSER OFFERS ARE EMITTED. `--hires-steps` (0 =
    // reuse `--steps`), `--hires-denoising-strength` (0.7), `--hires-upscaler`
    // (Latent) and `--hires-sigmas` all have upstream defaults that are the right
    // answer for a first pass at this, and a flag we send at its own default is a
    // number the app would then have to defend in provenance forever.
    args.push('--hires')
    if (typeof eff.hiresScale === 'number') args.push('--hires-scale', String(eff.hiresScale))
  }
  if (typeof input.seed === 'number') args.push('--seed', String(input.seed))
  // N IMAGES, ONE LOAD. Emitted only above 1 so a single-image command line is
  // byte-identical to every run before this existed — and so the output-path
  // rewrite (sdBatchOutputPath) and this flag can never disagree about whether
  // this is a batch.
  const batch = normalizeBatchCount(input.batchCount)
  if (batch > 1) args.push('-b', String(batch))
  // THE INIT FRAME AND ITS STRENGTH, from the same resolution the provenance
  // reads. This line used to be `String(input.strength ?? 0.6)` — the arg
  // builder's own private default, which the composer's control (whose slider sat
  // at `min`, i.e. 0, for a bag with no value) knew nothing about. Two owners,
  // two numbers, and the run went out at 0.6 while the screen read 0.
  if (input.initImagePath) {
    args.push('-i', input.initImagePath)
    if (typeof eff.strength === 'number') args.push('--strength', String(eff.strength))
  }
  // ── THE REFERENCE IMAGE (IP-Adapter) ───────────────────────────────────────
  //
  // ALL THREE OR NONE, and the engine is the one that says so: `--ip-adapter`'s
  // own help reads "requires --clip_vision", and the weights with no picture to
  // encode steer nothing at all. So the flags go out only when the row's family
  // has an INSTALLED adapter (env.ipAdapter, one lookup that carries both paths)
  // AND the user attached an image. Any other combination is the both-halves
  // failure this file keeps naming, and would be a spawn the engine rejects.
  //
  // `--clip_vision` here and not in the component block above: on the single-file
  // `-m` branch there is no component map to carry it, and this is the only image
  // feature that needs one. The multi-file branch never sets it either — no image
  // architecture we curate takes a vision tower for its own conditioning.
  if (env.ipAdapter && input.ipAdapterImagePath) {
    args.push('--ip-adapter', env.ipAdapter.adapter)
    args.push('--clip_vision', env.ipAdapter.clipVision)
    args.push('--ip-adapter-image', input.ipAdapterImagePath)
    // ALWAYS with the flag, never bare: the engine's own default is 1.0 and the
    // range upstream recommends starting in is 0.6-0.8, so the app's default is
    // a real choice (SD_IP_ADAPTER_STRENGTH_DEFAULT) rather than the engine's,
    // and a choice has to be on the command line to be the truth.
    args.push('--ip-adapter-strength', String(eff.ipAdapterStrength ?? SD_IP_ADAPTER_STRENGTH_DEFAULT))
  }
  // CLIP SKIP. Emitted only from 1 up: `<= 0` is the engine's own "unspecified"
  // and passing it would be a flag at its own default, which is a number the app
  // then has to defend in provenance forever.
  if (typeof eff.clipSkip === 'number') args.push('--clip-skip', String(eff.clipSkip))
  // …and the MEMORY LADDER, which is the only reason an 8 GB card can run some of
  // these rows at all. Order is fixed by sdMemoryArgs; the engine's own gate
  // (`--stream-layers` needs a VRAM budget AND the diffusion params on CPU) lives
  // there so the argv and the entry cannot disagree about what was in play.
  //
  // NO `offloadToCpu` context here: unlike video, an image run does not offload
  // by default — that would put every checkpoint's weights in RAM and slow down
  // renders nobody asked to make smaller. When a run asks for `--stream-layers`,
  // sdMemoryArgs emits the offload it needs, and only then.
  args.push(...sdMemoryArgs(input))
  // TAE: a 22.6 MB decoder swap that takes the VAE-decode peak from gigabytes to
  // well under one. Passed only when a file is actually there, so absent ⇒
  // byte-identical behaviour to before.
  if (env.taePath) args.push('--tae', env.taePath)
  // Flash attention on the diffusion path — faster AND lower peak memory, and
  // in every upstream CUDA example. Gated on the CUDA build because it is a
  // CUDA kernel: passing it to the CPU build buys nothing.
  if (env.cuda) args.push('--diffusion-fa')

  // ── THE LIVE PREVIEW ───────────────────────────────────────────────────────
  // An eleven-minute render showed a bar and nothing else. The engine has been
  // able to decode the latents mid-run the whole time — `--preview` was in its
  // help text and we never passed it.
  //
  // METHOD. `tae` when a TAE decoder is on disk (`--tae` above), because it is
  // the cheap decoder we already ship for exactly this kind of work; `proj`
  // otherwise, which is a linear projection of the latents and needs no weights
  // at all. Never `vae`: that is the FULL decoder, the most expensive thing in
  // the run, and paying for it ten times to watch a picture appear would make
  // the render slower in order to show you that it is slow.
  //
  // Not `--preview-noisy`: previewing the model's noisy INPUT shows the run
  // working, but what a user wants to know is whether the image is going the
  // way they meant, and only the denoised estimate answers that.
  if (env.preview) {
    args.push('--preview', env.taePath ? 'tae' : 'proj')
    args.push('--preview-path', env.preview.path)
    args.push('--preview-interval', String(Math.max(1, Math.floor(env.preview.intervalSteps))))
  }

  args.push('-o', outPath)
  return args
}

/**
 * How many sampler steps between previews, for a run of `steps` steps.
 *
 * The engine's own default is 1 — a decode on EVERY step. At 4 steps that is
 * fine and at 60 it is sixty decodes to fill a thumbnail nobody watched that
 * closely. Aiming at a fixed COUNT keeps the cost proportional to the run
 * rather than to its length, and a short run still gets every step because
 * there is nothing to thin out.
 *
 * Exported for unit tests.
 */
export const PREVIEW_TARGET_FRAMES = 8
export function previewIntervalFor(steps: number): number {
  if (!Number.isFinite(steps) || steps <= 0) return 1
  return Math.max(1, Math.floor(steps / PREVIEW_TARGET_FRAMES))
}

/**
 * The disk/machine facts for one run, read once per generation. Split out so
 * both generate paths (and nothing else) do this lookup, and so buildSdArgs
 * itself never touches the filesystem.
 */
function sdArgEnvFor(modelId: string, vaeAdapterId?: string, speed?: boolean): SdArgEnv {
  const env: SdArgEnv = {}
  const row = findSdRow(modelId)
  if (row) env.row = row
  const dirs = installedAdapterDirs()
  if (Object.keys(dirs).length > 0) env.adapterDirs = dirs
  // Read even when there is no lora directory: with nothing installed, a typed
  // tag is prompt pollution the engine will condition on verbatim (it only
  // extracts tags when it has a directory), so the resolver still has work.
  const loraNames = installedLoraNames()
  if (loraNames.length > 0) env.installedLoras = loraNames
  if (vaeAdapterId) {
    const p = installedAdapterPath(vaeAdapterId)
    if (p) env.vaePath = p
  }
  const tae = findTaeFile(modelId)
  if (tae) env.taePath = tae
  // THE REFERENCE-IMAGE WEIGHTS, keyed off the ROW's declared family — never an
  // id substring, the rule the clip-skip gate and the preset table follow. One
  // lookup that answers "installed?" and "which two paths?" together, and the
  // SAME one the composer's control is gated on, so an offered control and a
  // command line cannot disagree.
  if (row) {
    // The MODEL ID goes with the family: a checkpoint whose declared family has
    // an adapter but whose weights are a different architecture is refused by id
    // (SD_IP_ADAPTER_BLOCKED). Same lookup as the schema gate, same arguments.
    const ip = installedIpAdapterForFamily(row.family, modelId)
    if (ip) env.ipAdapter = ip
  }
  if (isCudaSdBuild()) env.cuda = true
  // THE ONLY PLACE THE DISK IS ASKED. `speed !== false` rather than
  // `speed === true`: an unset flag from an older surface still gets the fast
  // path once the weights are there, and an explicit opt-out is honoured.
  // installedSpeedAdapter returns undefined unless EVERY file of the pack is on
  // disk, so a half-finished download can never produce a 4-step run with one
  // expert un-adapted.
  if (speed !== false) {
    const pack = installedSpeedAdapter(modelId)
    if (pack) env.speed = pack
  }
  return env
}

/** Installed models carry their DISPLAY NAME and DECLARED FAMILY: the renderer
 *  had neither, so the local dropdown showed raw ids and the preset picker
 *  guessed the family from an id substring. */
export function sdStatus(): {
  installed: boolean
  models: ReturnType<typeof listInstalledSdModels>
  /** Every INSTALLED adapter. The composer offers only the ones whose family
   *  matches the ACTIVE checkpoint (compat-at-generate, spec §5-6). */
  adapters: ReturnType<typeof listInstalledSdAdapters>
  /**
   * Which engine build is on disk versus the one this app pins.
   *
   * Here because `installed: true` was the whole answer, and it is the answer
   * that made an engine bump a no-op for everyone who already had one: the
   * install short-circuits on "a binary exists", so the pin moved and their
   * bytes did not. `updateAvailable` is true only when BOTH commits are known
   * and differ — an engine that will not report its own commit is not accused
   * of being stale.
   */
  engine: ReturnType<typeof sdCppUpdateState>
  /**
   * Every name a `<lora:…>` tag in the prompt could resolve to — THE SAME LIST
   * THE ARG BUILDER RESOLVES AGAINST (installedLoraNames), which is the whole
   * point of shipping it here. The composer tells the user what their typed tag
   * will do; computing that from the `adapters` array above instead would leave
   * out the hand-placed files the engine can still find, and the hint would
   * confidently contradict the command line.
   */
  loraNames: ReturnType<typeof installedLoraNames>
} {
  return {
    installed: getSdCliPath() !== null,
    models:    listInstalledSdModels(),
    adapters:  listInstalledSdAdapters(),
    engine:    sdCppUpdateState(),
    loraNames: installedLoraNames(),
  }
}

// ── How a generation DIED ─────────────────────────────────────────────────────
//
// Driver finding: a 49-frame Wan render overflowed 12 GB of VRAM, the OS reaped
// sd-cli, and the app went back to an idle Generate button with nothing to show
// for 70 minutes — no error, no entry, no log line. Three distinct deaths have
// to be caught here or the renderer has nothing to surface:
//
//   • a NON-ZERO exit   — sd-cli refused the job or crashed itself;
//   • death by SIGNAL   — `close` reports code === null and a signal name; a
//     `code === 0` test reads that as "not zero" only by accident, and the
//     message it built said "exited null", which names neither the signal nor
//     the fact that the process was killed from outside;
//   • exit ZERO with NO OUTPUT FILE — the one that is silent by construction:
//     the process claims success and there is simply no file to read.
//
// Pure + exported so all three are pinned by tests instead of by a screenshot.
const STDERR_TAIL_LINES = 6

/**
 * Describe an sd-cli exit, or null when the run genuinely succeeded (exit 0 AND
 * the output file exists). The returned string is what the renderer shows, so
 * it carries the exit code / signal AND the tail of stderr — blank lines
 * dropped, because sd-cli ends its output with newlines and a naive last-N
 * slice hands back nothing but empties.
 */
export function describeSdExit(input: {
  label:        string
  code:         number | null
  signal:       NodeJS.Signals | null
  outputExists: boolean
  stderr:       string
  /**
   * The user pressed STOP. Same death (we killed the child), different truth:
   * it was not a crash, so the message says so and the stderr tail is dropped —
   * that tail is the last progress redraw, and pasting "step 7/20" under a red
   * FAILED heading reads like a diagnosis of something that went wrong.
   */
  cancelled?:   boolean
}): string | null {
  const { label, code, signal, outputExists, stderr, cancelled } = input
  if (code === 0 && outputExists) return null
  // A stop that lands AFTER the file was written is still a stop, but there is
  // nothing to apologise for — the run above already returned null for it.
  if (cancelled) return `${label} was stopped before it finished.`

  // \r is a SEPARATOR here, not noise: sd-cli redraws its progress bar in place
  // with carriage returns, so one "line" of stderr can hold dozens of rewrites.
  // Splitting on it keeps the newest state instead of gluing every redraw into a
  // single unreadable line — and drops the CR of a Windows CRLF for free.
  const tail = stderr
    .split(/\r\n|\r|\n/)
    .map(l => l.trim())
    .filter(l => l !== '')
    .slice(-STDERR_TAIL_LINES)
    .join('\n')

  const head = code === 0
    // Exit 0 and nothing on disk: the failure mode with no other evidence at all.
    ? `${label} exited 0 but wrote no output file.`
    : code !== null
      ? `${label} exited ${code}.`
      : signal
        // Killed from outside (OOM reaper, Task Manager, a crash handler).
        ? `${label} was killed (${signal}) before it finished.`
        : `${label} exited unexpectedly.`

  return tail ? `${head} ${tail}` : head
}

// Serialize generations — one sd-cli at a time (VRAM). Simple promise chain.
let queue: Promise<unknown> = Promise.resolve()

// ── STOP: the running child, and the only handle on it ───────────────────────
//
// Owner, live, at the machine: «i cant stop it». A local render is the one
// operation in the app that can hold the whole GPU for over an hour, and it was
// the one operation with no cancel — the 70-minute Wan job had to be killed
// from outside the app entirely.
//
// The queue above already serialises runs, so there is at most ONE spawned
// child at any moment and a single module-level handle is the whole mechanism.
// It is registered right after spawn and cleared on `close`, so it can never
// outlive the process it names (a stale handle would make Stop kill whatever
// the OS recycled that pid into).
interface ActiveRun {
  proc:      ChildProcess
  /** Set by cancelGeneration so the `close` handler knows this was deliberate. */
  cancelled: boolean
}
let active: ActiveRun | null = null

/** Is an sd-cli generation running right now? (The Stop control's condition.) */
export function isGenerating(): boolean {
  return active !== null
}

/**
 * Kill the running generation, image or video — one client, one child, one
 * button. `cancelled:false` means there was nothing running, which is not an
 * error: the run may have finished in the moment between the render and the
 * click.
 *
 * The queue is NOT touched. The killed run rejects through its own `close`
 * handler exactly like any other death, and the promise chain frees itself the
 * way it always has — a Stop that wedged the queue would be a worse bug than
 * the one it fixes.
 */
export function cancelGeneration(): { cancelled: boolean; pid?: number } {
  const run = active
  if (!run) return { cancelled: false }
  run.cancelled = true
  const pid = run.proc.pid
  killProcessTree(run.proc)
  return { cancelled: true, ...(typeof pid === 'number' ? { pid } : {}) }
}

// ── The channel's LAST WORD ──────────────────────────────────────────────────
//
// 'sd-cpp:gen-progress' used to tick every second for the whole of a render and
// then just stop: the success path pushed a final snapshot with nothing to mark
// it final, and the FAILURE path pushed nothing at all before throwing. The
// Media page survived that only because it also awaits the IPC promise — every
// other consumer of the same events (a canvas node run, a headless run, the
// chassis IO lamp, which names this exact gap as the reason it refuses to drive
// a lamp off `onGenProgress`) saw a run that started and never ended.
//
// So both generators now end the channel on EVERY exit path. The marker is an
// extra field rather than a new channel because every existing listener already
// ignores fields it does not know, and a second channel would be a second thing
// to forget to send.

/** The two ways a run can end. Absent on every mid-run tick. */
export type SdGenTerminalStage = 'done' | 'error'

/** One event on 'sd-cpp:gen-progress'. `stage` present ⇒ the run is over. */
export interface SdGenProgressEvent extends SdProgress {
  stage?:     SdGenTerminalStage
  /** Which generator ended, so a listener can say "Video ready" and mean it. */
  kind?:      'image' | 'video'
  /** Wall-clock duration of the run, measured here — the renderer has no start. */
  elapsedMs?: number
  /**
   * A LIVE LOOK AT THE LATENTS, as a `data:` URI, when the engine has written
   * one since the last tick. Absent on most events — a listener keeps showing
   * the newest one it received rather than expecting one per tick.
   *
   * It is deliberately NOT part of SdProgress: everything there is parsed from
   * the engine's log, and this is read off the disk.
   */
  preview?:   string
}

// ── WATCHING A FILE THE ENGINE IS STILL WRITING ─────────────────────────────
//
// sd-cli rewrites one PNG in place every `--preview-interval` steps, so there
// is no event to subscribe to and no atomic rename to rely on — polling the
// mtime is the whole mechanism, and a poll WILL sometimes land mid-write.
//
// A torn PNG is caught structurally rather than by guessing at timing: the file
// must start with the PNG signature and end with an IEND chunk, which is the
// last thing a writer emits. Anything else is skipped and the next tick tries
// again — at eight previews per render, losing one to a race costs nothing.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IEND  = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

/** A complete PNG, or null when the bytes are a partial write. Exported for tests. */
export function completePngOrNull(buf: Buffer): Buffer | null {
  if (buf.length < PNG_MAGIC.length + PNG_IEND.length) return null
  if (!buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null
  if (!buf.subarray(buf.length - PNG_IEND.length).equals(PNG_IEND)) return null
  return buf
}

/**
 * Poll `path` and call `onFrame` with a data URI each time a COMPLETE new PNG
 * appears there. Returns a stop function that also removes the file.
 *
 * Every failure is swallowed: a preview is a courtesy, and a render must not
 * die because a thumbnail could not be read.
 */
function watchPreviewFile(path: string, onFrame: (dataUri: string) => void, everyMs = 700): () => void {
  let lastMtime = 0
  let lastSize  = -1
  const timer = setInterval(() => {
    try {
      const st = statSync(path)
      const mtime = st.mtimeMs
      // Size as well as mtime: a same-millisecond rewrite is rare but free to
      // catch, and mtime granularity on some Windows volumes is coarse.
      if (mtime === lastMtime && st.size === lastSize) return
      const png = completePngOrNull(readFileSync(path))
      if (!png) return                     // caught mid-write; try again next tick
      lastMtime = mtime
      lastSize  = st.size
      onFrame(`data:image/png;base64,${png.toString('base64')}`)
    } catch { /* not written yet, or vanished — nothing to report */ }
  }, everyMs)
  return () => {
    clearInterval(timer)
    try { unlinkSync(path) } catch { /* never existed, or already gone */ }
  }
}

/**
 * Build the terminal event from the parser's final snapshot. Pure, and exported
 * so the payload contract is asserted directly instead of through a GPU.
 *
 * An ERROR reports `percent: -1`: a run that died is not 60% of anything, and
 * `percent` is a MEASUREMENT OF COMPLETION everywhere else in this app. The last
 * real step reading is kept as-is — that is where it stopped, which is true.
 */
export function sdTerminalEvent(
  snap: SdProgress,
  opts: { stage: SdGenTerminalStage; kind: 'image' | 'video'; startedAt: number; message?: string; now?: number },
): SdGenProgressEvent {
  const now = opts.now ?? Date.now()
  return {
    ...snap,
    // A terminal is never a heartbeat, and never claims completion it did not
    // reach.
    heartbeat: false,
    percent:   opts.stage === 'error' ? -1 : snap.percent,
    message:   opts.message ?? snap.message,
    stage:     opts.stage,
    kind:      opts.kind,
    // A host clock that jumped backwards is not a negative duration.
    elapsedMs: Math.max(0, now - opts.startedAt),
  }
}

/**
 * Read back everything a finished image run wrote, and stamp each file with its
 * OWN provenance.
 *
 * THE PER-IMAGE SEED, in the only honest order:
 *   1. THIS FILE's own `parameters` chunk — sd.cpp's record of THIS image,
 *      written by the code that seeded its sampler (probe: out_0/1/2.png carried
 *      42/43/44 individually).
 *   2. the log line for THIS INDEX — `generating image: 2/3 - seed 43`. The only
 *      source if metadata writing was disabled, and positional on purpose:
 *      parseSdSeed's "last match wins" would stamp every image in the batch with
 *      the LAST one's seed, which is the single-seed lie one axis over.
 *   3. the REQUEST, shifted the way the engine shifts it (`seed + i`) — and only
 *      when the request was a concrete number, never for -1.
 *
 * A missing file is SKIPPED rather than fatal: `N/N images saved` is the engine's
 * claim, and if it wrote 3 of 4 the user should get the 3 that exist.
 *
 * Split out and exported so the round-trip (engine chunk in → tachi-gen chunk
 * out, per image) is asserted on real bytes in a unit test instead of on a GPU.
 */
export function collectSdImages(
  outPaths: string[],
  ctx: {
    input:      SdGenerateInput
    effective:  SdEffectiveParams
    engineLog?: string
    /** The row the argv used — its baseSize is the width/height fallback. */
    row?:       SdGenerationRow
    /**
     * The `-p` value REALLY sent, read straight out of the argv.
     *
     * Recomputing it here is how the recipe and the command line drifted before
     * (the speed-pack finding above), and there is now a second reason: a typed
     * `<lora:…>` tag is rewritten to an on-disk slug or dropped
     * (resolveTypedLoraTags), so `input.prompt` is no longer what ran. Absent ⇒
     * the old recomputation, which is right for every caller that has no argv.
     */
    promptSent?: string
  },
): SdGeneratedImage[] {
  const { input, effective, row } = ctx
  const logSeeds = parseSdSeedSequence(ctx.engineLog)
  const count    = outPaths.length
  const rowSize  = row && row.kind === 'image' ? row.baseSize : undefined
  const images: SdGeneratedImage[] = []

  for (let i = 0; i < count; i++) {
    const path = outPaths[i]
    if (!existsSync(path)) continue
    let bytes: Buffer = readFileSync(path)

    // Ask the engine what it actually did, from its OWN record of THIS file,
    // before we write ours next to it.
    let actualSeed = -1
    try {
      const fromChunk = parseSdSeed({ parameters: readTextChunks(bytes).get('parameters') })
      actualSeed = resolveActualSeed(
        fromChunk ?? (i < logSeeds.length ? logSeeds[i] : null),
        sdBatchSeedRequest(input.seed, i),
      )
    } catch { actualSeed = resolveActualSeed(null, sdBatchSeedRequest(input.seed, i)) }

    // Embed generation metadata as a tEXt chunk ("tachi-gen"). If it fails we
    // continue without metadata rather than failing the whole generation.
    try {
      const meta: TachiGenMeta = {
        modelId:        input.modelId,
        // The prompt AS RUN, LoRA tags included — reproducing this image
        // requires them, and the tag text is what the user sees anyway.
        prompt:         ctx.promptSent ?? promptWithLoraTags(input.prompt, input.loras),
        negative:       input.negative ?? '',
        // THE RECIPE AS RUN, from the same function the argv read (audit:
        // the speed-pack finding). Repeating the ?? ladder here is how the
        // chunk and the command line drifted in the first place.
        steps:          effective.steps,
        cfgScale:       effective.cfgScale,
        samplingMethod: effective.samplingMethod,
        // THIS image's seed, never the request and never its neighbour's.
        seed:           actualSeed,
        width:          input.width  ?? rowSize ?? 512,
        height:         input.height ?? rowSize ?? 512,
        // …and the two-pass, which is what makes the file bigger than the
        // width/height above (see TachiGenMeta).
        ...(effective.hires
          ? { hires: true, ...(typeof effective.hiresScale === 'number' ? { hiresScale: effective.hiresScale } : {}) }
          : {}),
        // …and the img2img mode + its strength, the clip-skip and the memory
        // flags, all from the same `effective` the argv was built from. Each is
        // ABSENT rather than false/0 when it did not apply: a chunk that says
        // `initImage: false` on every text→image PNG is noise, and one that says
        // `strength: 0` is a claim about a frame there never was.
        ...(effective.initImage
          ? { initImage: true, ...(typeof effective.strength === 'number' ? { strength: effective.strength } : {}) }
          : {}),
        // …and the REFERENCE IMAGE the same way, absent-not-false for the same
        // reason. It is the last thing a "why does this one look different" read
        // of two PNGs would otherwise have to guess at.
        ...(effective.ipAdapterImage
          ? {
              ipAdapterImage: true,
              ...(typeof effective.ipAdapterStrength === 'number' ? { ipAdapterStrength: effective.ipAdapterStrength } : {}),
            }
          : {}),
        ...(typeof effective.clipSkip === 'number' ? { clipSkip: effective.clipSkip } : {}),
        ...(effective.memory ? { memory: effective.memory } : {}),
        ...(count > 1 ? { batchIndex: i, batchCount: count } : {}),
      }
      const withMeta: Buffer = embedTextChunk(bytes, 'tachi-gen', JSON.stringify(meta))
      writeFileSync(path, withMeta)
      bytes = withMeta
    } catch (e) {
      // Non-fatal (the image is still returned), but logged so the silent loss of
      // generation params (no Restore-from-image) is visible.
      console.warn('[sd-cpp] tachi-gen metadata embed failed (non-fatal):', (e as Error).message)
    }

    images.push({ path, b64: bytes.toString('base64'), mime: 'image/png', seed: actualSeed })
  }
  return images
}

/**
 * Generate an image.  Optionally pass a BrowserWindow to receive live progress
 * events on the 'sd-cpp:gen-progress' channel (step, percent, message), ending
 * with exactly one terminal event (`stage: 'done' | 'error'`).
 */
export function generateImage(input: SdGenerateInput, win?: BrowserWindow | null): Promise<SdGenerateResult> {
  const run = async (): Promise<SdGenerateResult> => {
    const cli = getSdCliPath()
    if (!cli) throw new Error('stable-diffusion.cpp is not installed. Click Install first.')
    if (isEngineMigrating('sd')) throw new Error('Stable Diffusion weights are being moved to the storage folder — try again in a moment.')
    if (!isSdModelInstalled(input.modelId)) throw new Error(`Model "${input.modelId}" is not downloaded.`)
    const components = modelComponentPaths(input.modelId)
    if (!components) throw new Error(`Model "${input.modelId}" components missing.`)
    const outPath = join(outDir(), `sd-${Date.now()}-${Math.floor(performance.now())}.png`)
    const env  = sdArgEnvFor(input.modelId, input.vaeAdapterId)
    // Resolved ONCE, from the same function the argv used, and carried to both
    // provenance surfaces (the tEXt chunk and the gallery entry).
    const effective = effectiveImageParams(input, env)
    // THE PREVIEW, only when someone is watching. No window means a headless or
    // node-graph run whose frames would go nowhere, and paying a decoder for
    // pictures nobody receives is pure loss.
    //
    // In the OS temp dir, not the gallery: the gallery is scanned, and a
    // half-denoised latent appearing there as an artwork would be a bug in a
    // feature meant to reassure.
    const previewPath = win
      ? join(tmpdir(), `tachi-sd-preview-${Date.now()}-${Math.floor(performance.now())}.png`)
      : null
    const args = buildSdArgs(components, input, outPath, {
      ...env,
      ...(previewPath
        ? { preview: { path: previewPath, intervalSteps: previewIntervalFor(effective.steps) } }
        : {}),
    })
    // THE PROMPT AS SENT, from the array itself. Read here rather than in the
    // metadata writer so provenance can never be a second computation of it.
    const pAt = args.indexOf('-p')
    // WHERE THE FILES WILL BE. Derived from the same normalizer the argv used, so
    // "did it emit -b" and "what does it read back" are one decision. For a
    // single image this is `[outPath]` and nothing below behaves differently.
    const batchCount = normalizeBatchCount(input.batchCount)
    const outPaths   = sdBatchOutputPaths(outPath, batchCount)

    const fsm       = new TaskFSM(`sd-image-${Date.now()}`)
    const parser    = new SdProgressParser()
    const startedAt = Date.now()

    // Heartbeat: emit "Starting..." every 1 s until real progress arrives.
    const pushProgress = (snap: SdGenProgressEvent): void => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send('sd-cpp:gen-progress', snap)
    }
    // The channel's last word — see sdTerminalEvent. Sent on BOTH exits.
    const pushTerminal = (stage: SdGenTerminalStage, message?: string): void => {
      pushProgress(sdTerminalEvent(parser.finish(), { stage, kind: 'image', startedAt, message }))
    }
    const hbTimer = setInterval(() => { pushProgress(parser.heartbeat()) }, 1_000)

    // A frame goes out the moment it lands, carrying the parser's CURRENT
    // snapshot unaltered — `heartbeat()` reads state, it does not invent any, so
    // the numbers beside the picture stay the numbers the engine last printed.
    // Overriding them to look further along would be inventing progress to
    // decorate a thumbnail.
    const stopPreview = previewPath
      ? watchPreviewFile(previewPath, frame => {
          pushProgress({ ...parser.heartbeat(), preview: frame })
        })
      : null

    // BOTH streams, kept for the run: sd-cli writes its progress (and the
    // `- seed N` line) to stderr on this build, but that is a logging choice,
    // not a contract — reading only one stream is how the seed goes missing
    // again on the next binary bump.
    let engineLog = ''
    try {
      fsm.transition('running')
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        const me: ActiveRun = { proc, cancelled: false }
        active = me
        let stderr = ''
        proc.stderr.on('data', (d: Buffer) => {
          stderr += String(d)
          engineLog += String(d)
          // Feed stderr into the progress parser (sd-cli writes progress there).
          const snap = parser.feed(d)
          if (snap) {
            clearInterval(hbTimer)
            pushProgress(snap)
          }
        })
        proc.stdout.on('data', (d: Buffer) => {
          engineLog += String(d)
          const snap = parser.feed(d)
          if (snap) { clearInterval(hbTimer); pushProgress(snap) }
        })
        // A spawn that never started owns no GPU — drop the Stop handle with it,
        // or the next click kills whatever the OS recycled that pid into.
        proc.on('error', () => { if (active === me) active = null })
        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          clearInterval(hbTimer)
          // The engine is gone, so no further frame can arrive; stopping here
          // (rather than in a finally further out) means the temp file is
          // removed even on the paths that throw between here and the end.
          stopPreview?.()
          if (active === me) active = null
          // ANY of the expected files. For `-b N>1` the engine never writes
          // `outPath` itself (it writes `outPath` with `_0…_{N-1}` spliced in), so
          // asking about that one path would have reported every batch run as the
          // silent "exited 0 but wrote no output file" death.
          const wrote = outPaths.some(p => existsSync(p))
          const died = describeSdExit({ label: 'sd-cli', code, signal, outputExists: wrote, stderr, cancelled: me.cancelled })
          if (died) reject(new Error(died))
          else resolve()
        })
      })
      fsm.transition('processing')
      // Read back every file the run wrote, each with ITS OWN seed and its own
      // tachi-gen chunk. `env.row` is the SAME row the arg builder used (audit
      // D4): provenance that repeats the curated fallback instead of the row that
      // ran cannot reproduce its own image.
      const images = collectSdImages(outPaths, {
        input, effective, engineLog, row: env.row,
        // Out of the argv, not recomputed — see collectSdImages.promptSent.
        ...(pAt >= 0 ? { promptSent: args[pAt + 1] } : {}),
      })
      if (images.length === 0) {
        // describeSdExit saw a file a moment ago (or we would not be here), so
        // this is the narrow race where it vanished — still a failure, and one
        // that must not be reported as a success with an empty gallery.
        throw new Error('sd-cli reported success but its output file could not be read.')
      }

      fsm.transition('completed')
      pushTerminal('done')
      // The gallery entry snapshots this too — a Remix has to restore the seed
      // that ran, and the renderer cannot read a tEXt chunk it never opens.
      // `images` is the whole truth; the three flat fields are images[0], kept so
      // every pre-batch caller is byte-identical.
      const first = images[0]
      return { path: first.path, b64: first.b64, mime: first.mime, seed: first.seed, effective, images }
    } catch (err) {
      clearInterval(hbTimer)
      // Belt and braces: a spawn that never reached 'close' (proc.on('error'))
      // leaves the watcher running, and a timer nobody clears outlives the run.
      stopPreview?.()
      if (!fsm.isTerminal) fsm.transition('failed', err instanceof Error ? err.message : String(err))
      // BEFORE the rethrow: the promise's rejection reaches exactly one caller,
      // and every other listener on the channel only learns the run is over from
      // this event.
      pushTerminal('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  const next = queue.then(run, run)  // run regardless of the prior result
  queue = next.catch(() => {})
  return next
}

// ── Video (Wan via `sd-cli -M vid_gen`) ──────────────────────────────────────

// The native frame rate and pixel grid a video row does not override live in
// sd-cpp-models now (DEFAULT_VIDEO_FPS / DEFAULT_VIDEO_PIXEL_GRID) — they were
// module constants here while every shipped checkpoint was Wan 2.1, and Wan 2.2
// TI2V-5B is 24 fps on a 32-pixel grid, so both had to become ROW data.
//
// `--fps` MUST still be passed on every run: `sd-cli --help` on the pinned build
// lists it with a default of **24**, so omitting it on a 16 fps Wan 2.1 row
// muxes the clip into a 24 fps container and it plays 1.5x fast.

export interface SdVideoInput extends SdMemoryFlags {
  modelId:        string
  prompt:         string
  negative?:      string
  width?:         number
  height?:        number
  frames?:        number
  steps?:         number
  cfgScale?:      number
  seed?:          number
  initImagePath?: string  // i2v init frame (Wan i2v models)
  /** The composer's Sampler, which this path used to drop on the floor: only
   *  the row's own value ever reached `--sampling-method`, so a preset that
   *  changed it was two-thirds wrong and one-third ignored (audit D5). */
  samplingMethod?: string
  /** `--scheduler` / `--flow-shift` — see SdGenerateInput. THE distill lever on
   *  this side: `simple` + shift 5 reproduces the official 4-step schedule. */
  scheduler?:     string
  flowShift?:     number
  /** `<lora:slug:weight>` + `--lora-model-dir`. The speed-distill LoRAs
   *  (Self-Forcing DMD / CausVid) are the whole reason the video path needs
   *  this at all — 20 steps → 4. */
  loras?:         SdLoraSelection[]
  vaeAdapterId?:  string
  /**
   * Run this row's CURATED SPEED PACK (4-step distill LoRAs + the whole preset
   * that goes with them). Honoured only when the pack is actually installed —
   * an uninstalled ask is a no-op, never a broken 4-step run.
   *
   * `undefined` means "the surface did not say", which is treated as ON when a
   * pack IS on disk: a user who downloaded a speed pack for a row asked for the
   * fast path, and every surface that can express the choice renders a toggle
   * whose default says so out loud (see localVideoOptionsFor). `false` is an
   * explicit opt-out and is respected.
   */
  speed?:         boolean
}
export interface SdVideoResult {
  path: string
  b64: string
  mime: string
  /**
   * The seed the engine used. A .webm has no tEXt chunk to hide it in, so the
   * run log is the ONLY source and the gallery entry is the only provenance —
   * exactly the split 2bd48fc settled for the frame count.
   */
  seed?: number
  /**
   * The recipe the engine was actually given (SdEffectiveParams). Same split as
   * the seed, and for video it is the one that mattered: with a speed pack the
   * pack out-votes the composer, so the entry's own `steps: 20, cfg: 6` was a
   * description of a render that never ran.
   */
  effective?: SdEffectiveParams
}

/**
 * Snap one video dimension onto the ROW's pixel grid.
 *
 * FLOOR, deliberately, and this is the whole point of the function: the
 * composer's resolution picker speaks in LABELS ('720p') that resolve through a
 * Wan 2.1 table, so a 32-grid checkpoint is handed 1280x720 — and 720/32 = 22.5,
 * where rounding to nearest gives 736. 736 is neither what was asked for nor a
 * size the checkpoint was trained on, and it costs MORE memory than the request.
 * 704 is both the floor and the model's documented native height.
 */
function snapVideoDim(n: number, grid: number): number {
  if (!Number.isFinite(n) || n <= 0 || grid <= 1) return n
  return Math.max(grid, Math.floor(n / grid) * grid)
}

/**
 * Snap a frame count onto the ROW's temporal law — a video VAE compresses the
 * time axis with the first frame kept whole, so F frames become
 * (F-1)/grid + 1 latents.
 *
 * THE GRID IS NO LONGER 4. It was, while every row was Wan: Wan 2.1 and 2.2
 * both compress 4x, and the constant was right by accident of the catalog.
 * LTX-AV compresses 8x — the pinned engine's own
 * video_frames_to_latent_frames branches on exactly this — so a request of 45,
 * a perfectly legal 4n+1 count, decodes to 41 frames there and says nothing.
 *
 * Floor again (49 rather than 53 for a request of 50): a clip longer than the
 * one that was asked for costs more of the thing users complain about. Both
 * composer resolvers already produce an on-grid count, so this is the guard for
 * a raw IPC call, not the mechanism.
 */
function snapVideoFrames(n: number, grid: number): number {
  if (!Number.isFinite(n) || n <= 0 || grid <= 1) return n
  return grid * Math.max(0, Math.floor((n - 1) / grid)) + 1
}

/**
 * Pure: build the `sd-cli -M vid_gen` argv.
 *
 * Extracted from generateVideo for the reason buildSdArgs was pure from the
 * start — "reviewable in isolation". It stopped being a formality the moment
 * the argv grew row-derived arithmetic (a per-row frame rate, a per-row pixel
 * grid) and a second diffusion pass: those were previously assertable only by
 * reading this file's source, which cannot catch a wrong NUMBER.
 */
export function buildSdVideoArgs(
  components: Record<string, string>,
  input: SdVideoInput,
  outPath: string,
  env: SdArgEnv = {},
): string[] {
  const c = components
  const row = env.row
  const m = row && row.kind === 'video' ? row : undefined
  const args: string[] = ['-M', 'vid_gen']
  if (c.diffusion) args.push('--diffusion-model', c.diffusion)
  // THE SECOND EXPERT (Wan 2.2 A14B). Upstream's own docs/wan.md command passes
  // the LOW-noise file as --diffusion-model and the high-noise one here; both
  // are required, and swapping them produces a render rather than an error.
  if (c.diffusion_high) args.push('--high-noise-diffusion-model', c.diffusion_high)
  const vae = env.vaePath ?? c.vae
  if (vae)             args.push('--vae', vae)
  // LTX-AV's two extra components, and the ltx-2-3-22b-distilled row is the one
  // that declares them (they waited here roleless for exactly one lane, the way
  // `--llm` waited for Z-Image). `--audio-vae` decodes the audio half of a
  // joint audio-video generation: an OUTPUT path, not an audio INPUT.
  if (c.audio_vae)             args.push('--audio-vae', c.audio_vae)
  if (c.embeddings_connectors) args.push('--embeddings-connectors', c.embeddings_connectors)
  if (c.t5xxl)       args.push('--t5xxl', c.t5xxl)
  if (c.llm)         args.push('--llm', c.llm)
  if (c.clip_vision) args.push('--clip_vision', c.clip_vision)
  // ── THE SPEED PRESET, ALL OR NOTHING ───────────────────────────────────────
  //
  // `--lora-model-dir` is the gate on the WHOLE preset, not just on the tags.
  // Four steps at guidance 1 WITHOUT the distill weights applied is not a fast
  // render, it is noise — so if the directory that resolves the tags is
  // missing, the run falls back to the row's own vanilla recipe entirely
  // rather than to a half-applied one. That is the same failure the scheduler
  // trap describes, and it is the reason this is one object and not five
  // independent overrides.
  const speed    = env.adapterDirs?.lora ? env.speed : undefined
  // Both halves or neither — see buildSdArgs.
  const vLoraDir = env.adapterDirs?.lora
  const vLoras   = vLoraDir
    // The pack's tags go FIRST, in upstream's own order (low-noise, then the
    // `|high_noise|` one); a user's own LoRA selection still rides along.
    ? [...(speed ? speedLoraSelections(speed) : []), ...(input.loras ?? [])]
    : undefined
  const vTyped  = resolveTypedLoraTags(input.prompt, env.installedLoras ?? [])
  const vPrompt = promptWithLoraTags(vTyped.prompt, vLoras)
  args.push('-p', vPrompt)
  if (input.negative) args.push('-n', input.negative)
  if (vLoraDir && hasLoraTag(vPrompt)) args.push('--lora-model-dir', vLoraDir)
  if (env.adapterDirs?.embedding) args.push('--embd-dir', env.adapterDirs.embedding)
  // ── The three row-derived numbers ──────────────────────────────────────────
  const grid = m?.pixelGrid ?? DEFAULT_VIDEO_PIXEL_GRID
  args.push('-W', String(snapVideoDim(input.width  ?? m?.width  ?? 832, grid)))
  args.push('-H', String(snapVideoDim(input.height ?? m?.height ?? 480, grid)))
  const frameGrid = m?.frameGrid ?? DEFAULT_VIDEO_FRAME_GRID
  args.push('--video-frames', String(snapVideoFrames(input.frames ?? m?.frames ?? 33, frameGrid)))
  // A row-less run keeps 16 rather than falling through to sd-cli's own 24:
  // every checkpoint installable today is a 16 fps Wan except the one that says
  // otherwise, so the default has to be the family's, not the CLI's.
  args.push('--fps', String(m?.fps ?? DEFAULT_VIDEO_FPS))
  // THE PRESET OUT-VOTES THE COMPOSER, and says so on the toggle that turned it
  // on ("runs at N steps and guidance 1 whatever the Steps and Guidance
  // controls say"). Those two controls describe the VANILLA recipe — a Steps
  // value of 10 is the row's own number for undistilled weights, and forwarding
  // it into a 4-step distill is the misuse the whole preset exists to prevent.
  //
  // ONE resolution, read by the argv AND by the provenance stamp — see
  // effectiveVideoParams. `env` is passed through unchanged so `activeSpeed`
  // applies the same lora-dir gate the `speed` const above already applied.
  const eff = effectiveVideoParams(input, { ...env, row })
  args.push('--cfg-scale', String(eff.cfgScale))
  args.push('--sampling-method', eff.samplingMethod)
  args.push('--steps', String(eff.steps))
  // ── The high-noise pass ────────────────────────────────────────────────────
  //
  // Gated on the COMPONENT, not on the row: these configure a pass that only
  // exists when a second DiT was loaded, and passing them otherwise describes a
  // model that is not there.
  //
  // ROW-OWNED, and not touched by a composer override. There is no high-noise
  // control in the UI, and the research is explicit about where extra steps
  // belong on this pair — "low-noise expert owns facial identity, give it the
  // steps" — so the visible Steps / Guidance / Sampler drive the LOW pass and
  // the row's own high-noise recipe stands. Scaling it behind the user's back
  // would be app-side arithmetic nobody asked for.
  //
  // …and with a SPEED PACK the pack's own split wins, for the same reason the
  // low pass takes the visible controls: 2 high / 4 low is that pack's recipe
  // (the high-noise expert lays down structure, which a distill resolves in
  // fewer steps than the identity work the low one does).
  const hi = speed?.preset ?? m
  if (c.diffusion_high && hi) {
    if (typeof hi.highNoiseSteps === 'number')    args.push('--high-noise-steps', String(hi.highNoiseSteps))
    if (typeof hi.highNoiseCfgScale === 'number') args.push('--high-noise-cfg-scale', String(hi.highNoiseCfgScale))
    if (hi.highNoiseSamplingMethod)               args.push('--high-noise-sampling-method', hi.highNoiseSamplingMethod)
  }
  // THE TRAP FLAGS. A 4-step distill on sd.cpp's default (DISCRETE) schedule
  // lands on t = 999/666/333/0 instead of the 1000/750/500/250 it was trained
  // on, and the output gets blamed on the LoRA. `simple` + the pack's flow
  // shift reproduces the published ladder — see SPEED_FLOW_SHIFT for the
  // derivation from upstream's own denoiser source.
  if (eff.scheduler) args.push('--scheduler', eff.scheduler)
  if (typeof eff.flowShift === 'number') args.push('--flow-shift', String(eff.flowShift))
  if (typeof input.seed === 'number') args.push('--seed', String(input.seed))
  // i2v / img2img init frame. OPTIONAL on every row, including the ones that
  // declare `i2v: true`: TI2V-5B does text→video and image→video from one
  // checkpoint, and upstream ships both commands differing by this flag alone.
  if (input.initImagePath) args.push('-i', input.initImagePath)
  // The 6–9 GB VAE decode is what killed the driver's 49-frame render, not the
  // 1.4 GB DiT — a TAE file in the model's folder is the single biggest lever
  // this path has (upstream #872 measured a 19.3 GB buffer for 33 frames).
  if (env.taePath) args.push('--tae', env.taePath)
  if (env.cuda)    args.push('--diffusion-fa')
  // THE WHOLE LADDER, from one emitter. Upstream's performance.md orders it
  // offload → --max-vram → --stream-layers (which needs offload AS WELL AS a
  // budget — see the conjunction above sdMemoryArgs) → per-module backends,
  // "3-4x larger than raw VRAM at a few % cost each".
  //
  // `offloadToCpu: true` is the first rung, unconditional on this path because
  // Wan is VRAM-heavy and does not survive on a consumer GPU without it. It is
  // PASSED rather than pushed here so the flag has exactly one emitter: it is
  // also `--stream-layers`' precondition, and pushing it in two places would put
  // it on this argv twice the moment a user asked for streaming.
  args.push(...sdMemoryArgs(input, { offloadToCpu: true }))
  args.push('-o', outPath)
  return args
}

/**
 * Generate a video.  Optionally pass a BrowserWindow to receive live progress
 * events on the 'sd-cpp:gen-progress' channel (step, percent, message), ending
 * with exactly one terminal event (`stage: 'done' | 'error'`).
 */
export function generateVideo(input: SdVideoInput, win?: BrowserWindow | null): Promise<SdVideoResult> {
  const run = async (): Promise<SdVideoResult> => {
    const cli = getSdCliPath()
    if (!cli) throw new Error('stable-diffusion.cpp is not installed. Click Install first.')
    if (isEngineMigrating('sd')) throw new Error('Stable Diffusion weights are being moved to the storage folder — try again in a moment.')
    if (!isSdModelInstalled(input.modelId)) throw new Error(`Model "${input.modelId}" is not downloaded.`)
    const c = modelComponentPaths(input.modelId)
    if (!c) throw new Error(`Model "${input.modelId}" components missing.`)
    const env = sdArgEnvFor(input.modelId, input.vaeAdapterId, input.speed)
    const outPath = join(outDir(), `sd-vid-${Date.now()}.webm`)
    const args = buildSdVideoArgs(c, input, outPath, env)

    const fsm       = new TaskFSM(`sd-video-${Date.now()}`)
    const parser    = new SdProgressParser()
    const startedAt = Date.now()

    const pushProgress = (snap: SdGenProgressEvent): void => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send('sd-cpp:gen-progress', snap)
    }
    const pushTerminal = (stage: SdGenTerminalStage, message?: string): void => {
      pushProgress(sdTerminalEvent(parser.finish(), { stage, kind: 'video', startedAt, message }))
    }
    const hbTimer = setInterval(() => { pushProgress(parser.heartbeat()) }, 1_000)

    let engineLog = ''
    try {
      fsm.transition('running')
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        const me: ActiveRun = { proc, cancelled: false }
        active = me
        let stderr = ''
        proc.stderr.on('data', (d: Buffer) => {
          stderr += String(d)
          engineLog += String(d)
          const snap = parser.feed(d)
          if (snap) { clearInterval(hbTimer); pushProgress(snap) }
        })
        proc.stdout.on('data', (d: Buffer) => {
          engineLog += String(d)
          const snap = parser.feed(d)
          if (snap) { clearInterval(hbTimer); pushProgress(snap) }
        })
        // A spawn that never started owns no GPU — drop the Stop handle with it,
        // or the next click kills whatever the OS recycled that pid into.
        proc.on('error', () => { if (active === me) active = null })
        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          clearInterval(hbTimer)
          if (active === me) active = null
          const died = describeSdExit({ label: 'sd-cli vid_gen', code, signal, outputExists: existsSync(outPath), stderr, cancelled: me.cancelled })
          if (died) reject(new Error(died))
          else resolve()
        })
      })
      fsm.transition('processing')
      const bytes = readFileSync(outPath)
      fsm.transition('completed')
      pushTerminal('done')
      return {
        path: outPath, b64: bytes.toString('base64'), mime: 'video/webm',
        seed: resolveActualSeed(parseSdSeed({ log: engineLog }), input.seed),
        // A .webm has no chunk to hide provenance in, so this IS the record of
        // what ran — and with a speed pack it is the only thing that knows the
        // render was 4 steps at guidance 1 rather than the composer's 20 at 6.
        effective: effectiveVideoParams(input, env),
      }
    } catch (err) {
      clearInterval(hbTimer)
      if (!fsm.isTerminal) fsm.transition('failed', err instanceof Error ? err.message : String(err))
      // See the image twin: the channel must end, not just the promise.
      pushTerminal('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}

// ── UPSCALE (`sd-cli -M upscale`) ────────────────────────────────────────────
//
// A THIRD ENTRY POINT, deliberately, rather than a flag on generateImage.
//
// `-M upscale` is a different mode of the same binary and it shares almost
// nothing with a generation: it loads NO diffusion model, NO VAE, NO text
// encoder; it takes no prompt, no seed, no sampler, no step count, no size. The
// gate ran it with no `-m` at all and the engine loaded 192 tensors from the
// ESRGAN file alone. Threading that through buildSdArgs would mean a builder
// whose every parameter is meaningless in one of its two modes, and an argv one
// forgotten `if` away from loading 6 GB of Flux to resize a PNG.
//
// AND IT MUST NOT REUSE THE POST-RUN READ-BACK. collectSdImages runs parseSdSeed
// over each output file; an upscale has no seed to find, so this path parses
// nothing, writes no tachi-gen chunk, and returns only facts it observed itself.
//
// The engine USED to hand it a tempting wrong answer — a `parameters` chunk of
// sd-cli defaults describing a run that never happened (Seed: 42 on an image
// nothing sampled). That is now suppressed at the source with
// `--disable-image-metadata` on the argv (see buildSdUpscaleArgs), so the file
// on disk no longer carries the lie for OTHER readers either. The separation
// below is not load-bearing for that any more and stands on its own merits: no
// diffusion model, no VAE, no text encoder, no prompt.
//
// What it DOES share is the machinery that must not be duplicated: the serialising
// queue (one sd-cli at a time — this one takes 416 MB of VRAM and 26 s), the
// single `active` handle so the existing Stop button kills it, the progress
// channel with its terminal event, and describeSdExit's three deaths.

export interface SdUpscaleInput {
  /** Absolute path of the image on disk. Never a data: URL — the engine reads bytes. */
  inputPath: string
  /** Which curated upscaler to run. Omitted ⇒ DEFAULT_UPSCALER_ID. */
  upscalerId?: string
  /**
   * `--upscale-repeats`: run the upscaler N times, each pass multiplying again
   * (two x4 passes = x16). Absent / 1 ⇒ no flag.
   */
  repeats?: number
  /** `--upscale-tile-size`: the engine's default is 128. Absent ⇒ no flag. */
  tileSize?: number
}

export interface SdUpscaleResult {
  /** The file the run wrote. */
  path: string
  mime: 'image/png'
  /** The factor the ROW declares and the engine ran at — quoted by the entry. */
  scale: number
  /** Which upscaler ran, for the provenance line. */
  upscalerId: string
  /** Wall-clock, measured here. The gate saw ~26 s for one 1024 -> 4096 pass. */
  elapsedMs: number
}

/**
 * Where an upscale lands: BESIDE THE SOURCE, named for what was done to it.
 *
 * Not in `outDir()` like a generation, because this file's identity is "that
 * picture, bigger" — keeping it next to the original is what makes the pair
 * legible in a file manager, and it is the choice rife-plan already made for
 * `-rife2x.mp4`.
 *
 * Always `.png`: the engine writes PNG whatever it was given, so the extension
 * is an observation rather than a guess. Pure + exported so the naming is pinned
 * by test instead of by a screenshot.
 */
export function upscaleOutputPath(inputPath: string, scale: number): string {
  const cut = Math.max(inputPath.lastIndexOf('/'), inputPath.lastIndexOf('\\'))
  const dir  = inputPath.slice(0, cut + 1)
  const base = inputPath.slice(cut + 1)
  const dot  = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return `${dir}${stem}-upscaled-x${scale}.png`
}

/**
 * The argv for one upscale. Pure, so the "no diffusion model, no prompt" promise
 * above is a property a test asserts rather than a comment.
 */
export function buildSdUpscaleArgs(input: {
  modelPath:  string
  inputPath:  string
  outputPath: string
  repeats?:   number
  tileSize?:  number
}): string[] {
  const args = [
    '-M', 'upscale',
    '--upscale-model', input.modelPath,
    '-i', input.inputPath,
    '-o', input.outputPath,
    // Kill the fabricated provenance AT THE SOURCE. UPSCALE mode funnels through
    // the same `write_image` lambda as a generation, which calls
    // `get_image_params()` whenever `embed_image_metadata` is true — and it
    // defaults to true — so an upscaled PNG shipped a `parameters` tEXt chunk
    // describing a run that never happened: "Steps: 20, CFG scale: 7, Seed: 42,
    // Sampler: NONE, mode: img_gen", with `Size: 1024x1024` written on a
    // 4096x4096 file. Nothing sampled anything; every number in it is a default.
    //
    // We used to only defend against reading it back (this path runs no
    // collectSdImages). That left the LIE ON DISK for anything else that reads
    // PNG text chunks — A1111, ComfyUI, a future feature of our own — so the flag
    // is the better fix: no chunk beats an ignored false one.
    //
    // `--disable-image-metadata` is a real flag at our pin, verified in the
    // INSTALLED binary's own `--help`, and takes no value. Nothing downstream
    // needs any part of the chunk it suppresses: `parameters` has exactly one
    // reader in this codebase (collectSdImages, generation paths only), and the
    // `tachi-gen` chunk Remix reads is written by US and was never written here.
    '--disable-image-metadata',
  ]
  // A repeat count of 1 is the default and the flag is noise; anything that is
  // not a whole number above 1 is a caller bug, and passing it on would make
  // sd-cli's own parser the place that reports it.
  const r = input.repeats
  if (typeof r === 'number' && Number.isInteger(r) && r > 1) args.push('--upscale-repeats', String(r))
  const t = input.tileSize
  if (typeof t === 'number' && Number.isInteger(t) && t > 0) args.push('--upscale-tile-size', String(t))
  return args
}

/**
 * Upscale one image on disk. Resolves with the file it wrote; rejects with a
 * described death (the same three describeSdExit knows) otherwise.
 */
export function upscaleImage(input: SdUpscaleInput, win?: BrowserWindow | null): Promise<SdUpscaleResult> {
  const run = async (): Promise<SdUpscaleResult> => {
    const cli = getSdCliPath()
    if (!cli) throw new Error('stable-diffusion.cpp is not installed. Click Install first.')
    if (isEngineMigrating('sd')) throw new Error('Stable Diffusion weights are being moved to the storage folder — try again in a moment.')
    const id = input.upscalerId ?? DEFAULT_UPSCALER_ID
    const row = findUpscaler(id)
    if (!row) throw new Error(`Unknown upscaler: ${id}`)
    // The one lookup: installed AND the path the argv gets, from the same call.
    const modelPath = installedUpscalerPath(id)
    if (!modelPath) throw new Error(`"${row.name}" is not downloaded yet.`)
    // The source is the user's own file; a missing one is a clearer error here
    // than sd-cli's, and it is the difference between "pick another image" and a
    // C++ stack trace.
    if (!existsSync(input.inputPath)) throw new Error('That image is no longer on disk.')

    const outputPath = upscaleOutputPath(input.inputPath, row.scale)
    const args = buildSdUpscaleArgs({
      modelPath, inputPath: input.inputPath, outputPath,
      ...(input.repeats  !== undefined ? { repeats:  input.repeats  } : {}),
      ...(input.tileSize !== undefined ? { tileSize: input.tileSize } : {}),
    })

    const fsm       = new TaskFSM(`sd-upscale-${Date.now()}`)
    const parser    = new SdProgressParser()
    const startedAt = Date.now()

    const pushProgress = (snap: SdGenProgressEvent): void => {
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send('sd-cpp:gen-progress', snap)
    }
    // 'image' is the honest `kind` here: an upscale produces a picture, and every
    // listener on this channel switches on that word to decide what to announce.
    const pushTerminal = (stage: SdGenTerminalStage, message?: string): void => {
      pushProgress(sdTerminalEvent(parser.finish(), { stage, kind: 'image', startedAt, message }))
    }
    const hbTimer = setInterval(() => { pushProgress(parser.heartbeat()) }, 1_000)

    try {
      fsm.transition('running')
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        const me: ActiveRun = { proc, cancelled: false }
        active = me
        let stderr = ''
        proc.stderr.on('data', (d: Buffer) => {
          stderr += String(d)
          const snap = parser.feed(d)
          if (snap) { clearInterval(hbTimer); pushProgress(snap) }
        })
        proc.stdout.on('data', (d: Buffer) => {
          const snap = parser.feed(d)
          if (snap) { clearInterval(hbTimer); pushProgress(snap) }
        })
        proc.on('error', () => { if (active === me) active = null })
        proc.on('error', reject)
        proc.on('close', (code, signal) => {
          clearInterval(hbTimer)
          if (active === me) active = null
          const died = describeSdExit({ label: 'sd-cli upscale', code, signal, outputExists: existsSync(outputPath), stderr, cancelled: me.cancelled })
          if (died) reject(new Error(died))
          else resolve()
        })
      })
      fsm.transition('completed')
      pushTerminal('done')
      // NO b64. A 4096x4096 PNG is 26 MB (measured) and the gallery renders it
      // from its path through the media:// scheme like every other local file —
      // base64-ing it would put 35 MB of string across the IPC boundary for
      // nothing. This is also why the result carries no seed and no params.
      return {
        path: outputPath, mime: 'image/png', scale: row.scale, upscalerId: id,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      }
    } catch (err) {
      clearInterval(hbTimer)
      if (!fsm.isTerminal) fsm.transition('failed', err instanceof Error ? err.message : String(err))
      pushTerminal('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => {})
  return next
}
