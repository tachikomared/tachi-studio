// apps/desktop/electron/services/sd-cpp-models.ts
//
// Pinned registries for the stable-diffusion.cpp sidecar (LOCAL image gen).
//   - SD_CPP_RELEASES: prebuilt `sd-cli` binary per platform (github releases).
//   - SD_IMAGE_MODELS: curated COMPONENT-BASED image models. A model is a SET of
//     files keyed by role, so single-file SD (one `model` file) and multi-file
//     Flux (diffusion + vae + clip_l + t5xxl) share one shape.
//
// SHA policy mirrors llama-cpp-models.ts: ship `__SHA_PLACEHOLDER_<id>__`; the
// installer SKIPS verification on a placeholder (logs the observed SHA) and
// ENFORCES it once real hashes are pasted. Real SHAs require downloading the
// asset once and hashing it — do that on a networked machine before release.
//
// Pinning policy: bump the release tag + filenames TOGETHER and re-collect all
// SHAs (asset filenames embed the upstream short-hash, so they change per release).

// user-sd-models.ts imports THIS module for TYPES ONLY (`import type`, erased at
// compile time), so this runtime import is a one-way edge, not a cycle.
import { listUserSdModels, listUserSdAdapters, type UserSdModel, type UserSdAdapter } from './user-sd-models'

/** Upstream release tag (github.com/leejet/stable-diffusion.cpp/releases).
 *  master-782 adds a generation-cancellation API + new model families upstream
 *  (pins only here — nothing new is wired). */
export const SD_CPP_VERSION = 'master-810-db99efd'
const REL = `https://github.com/leejet/stable-diffusion.cpp/releases/download/${SD_CPP_VERSION}`

export type SdPlatform = 'win-cuda' | 'win-vulkan' | 'win-rocm' | 'win-cpu' | 'mac-arm64'

export interface SdRelease {
  platform: SdPlatform
  filename: string
  url:      string
  sha256:   string
  /** win-cuda ships the CUDA runtime DLLs in a SEPARATE archive (like llama.cpp).
   *  Present only for the CUDA build. */
  cudartFilename?: string
  cudartUrl?:      string
  cudartSha256?:   string
}

// Asset filenames embed the short hash (db99efd) while the tag is master-810-db99efd.
//
// ── BUMPED master-782-b290693 → master-810-db99efd, 2026-08-03 ───────────────
//
// Every digest and size below is the release's own published `digest`/`size`
// from the GitHub API — the same rule the Vulkan/ROCm rows already followed.
// The CPU asset was additionally DOWNLOADED and hashed here: the computed
// sha256 equalled the published digest byte for byte, which is what makes
// quoting the API for the other five defensible rather than trusting.
//
// WHAT THE BINARY ACTUALLY GAINED, from diffing `sd-cli --help` between the two
// builds rather than from the release notes:
//   + `--ip-adapter`, `--ip-adapter-image`, `--ip-adapter-strength`
//     (IP-Adapter; requires `--clip_vision`, which we already pin for wan-i2v)
//   + sampler `lms`; scheduler param set gains `beta` (alpha, beta) and
//     `lms_divisions`
// NOTHING was renamed and nothing was removed: all 49 flags this app emits are
// still documented, checked one by one. A 512×512 sd-turbo render through our
// own argv shape — including the new `--preview` trio — completed on the new
// CPU build in 16.9 s and wrote both the image and the preview frame.
//
// Two asset NAMES moved and would have 404'd a blind bump:
//   · win-rocm 7.1.1 → 7.14.0, and upstream now ships only ONE rocm build
//     where master-782 shipped two.
//   · mac runner macOS-26.4 → macOS-26.5.2.
// The cudart companion is BYTE-IDENTICAL (same digest as master-782), so an
// existing CUDA install re-downloads the engine and not the 563 MB runtime.
//
// Re-verify with:
//   GET https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/master-810-db99efd
export const SD_CPP_RELEASES: SdRelease[] = [
  {
    platform: 'win-cuda',
    filename: 'sd-master-db99efd-bin-win-cuda12-x64.zip',
    url:      `${REL}/sd-master-db99efd-bin-win-cuda12-x64.zip`,
    // Upstream digest, asset size 362 013 051 B.
    sha256:   '5a71f975e82cfb809884910bdd7b39095525d4525cd1519994106c8c236d9062',
    cudartFilename: 'cudart-sd-bin-win-cu12-x64.zip',
    cudartUrl:      `${REL}/cudart-sd-bin-win-cu12-x64.zip`,
    // Unchanged from master-782 — same 563 452 046 B, same digest.
    cudartSha256:   'fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d',
  },
  // ── Alternate GPU backends (NIGHT-QUEUE 2026-07-31 lane 3C) ─────────────────
  // gpu-detect.ts has computed `backend: 'vulkan'` for every AMD / Intel / iGPU
  // since it was written, and the sd.cpp installer had NOTHING to serve that
  // verdict — every Radeon/Arc owner silently installed the CPU build for local
  // image/video gen while llama.cpp (a SEPARATE sidecar) already got a Vulkan
  // row in an earlier batch. Both rows below were verified LIVE against the
  // GitHub release API for the pinned tag (2026-07-31): the asset exists,
  // `size` is quoted verbatim, and `sha256` is the release's own published
  // `digest` — not a hash computed from a download and asked to be trusted.
  {
    platform: 'win-vulkan',
    filename: 'sd-master-db99efd-bin-win-vulkan-x64.zip',
    url:      `${REL}/sd-master-db99efd-bin-win-vulkan-x64.zip`,
    // Upstream digest, asset size 37 829 640 B.
    sha256:   'df95f86081ef7ed8978a36ce87fade6bb8537a6f4a3c3487727a025e5607e0a4',
    // No cudart-style companion: the Vulkan build links against the ICD loader
    // that ships with the GPU driver, so there is no second download.
  },
  {
    platform: 'win-rocm',
    // master-782 shipped TWO win-rocm builds (7.1.1 and 7.13.0 HIP SDK targets)
    // and we pinned 7.1.1 as the more broadly compatible one. master-810 ships
    // exactly ONE, targeting 7.14.0 — so there is no longer a choice to make,
    // and the old filename would 404. Still an explicit expert choice only
    // (like llama.cpp's win-hip): never auto-selected by sdReleaseForBackend
    // below, since Vulkan is the ~5x smaller download that already covers every
    // AMD card.
    filename: 'sd-master-db99efd-bin-win-rocm-7.14.0-x64.zip',
    url:      `${REL}/sd-master-db99efd-bin-win-rocm-7.14.0-x64.zip`,
    // Upstream digest, asset size 200 234 508 B.
    sha256:   'd2f88891b01222c99f8e59d97b5eb88693798eaf1f575a6ccdc53777462f6f59',
  },
  {
    platform: 'win-cpu',
    // Upstream renamed the CPU build: `win-avx2` -> `win-cpu` (as of master-782).
    filename: 'sd-master-db99efd-bin-win-cpu-x64.zip',
    url:      `${REL}/sd-master-db99efd-bin-win-cpu-x64.zip`,
    // DOWNLOADED AND HASHED (2026-08-03): computed sha256 == published digest,
    // asset size 23 834 751 B. This is the row that makes the other five's
    // API-quoted digests an inference from a checked sample rather than a hope.
    sha256:   '4a8cf09b71ec7f51c2c813316eb312d9058134ea08e73063edc02a2b709bc232',
  },
  {
    platform: 'mac-arm64',
    // Upstream's mac runner keeps moving: macOS-15.7.7 -> 26.4 -> 26.5.2.
    filename: 'sd-master-db99efd-bin-Darwin-macOS-26.5.2-arm64.zip',
    url:      `${REL}/sd-master-db99efd-bin-Darwin-macOS-26.5.2-arm64.zip`,
    // Upstream digest, asset size 49 595 370 B.
    sha256:   'd3ae42317c723b9e381d91bfe36edd14b5712737776f404d216eb326d750b5e8',
  },
]

/**
 * Map a DETECTED GPU backend (gpu-detect.ts `GpuBackend`) to the sd.cpp release
 * we should install. Pure — no probing, no I/O — so the whole 3-way selection
 * is assertable in a unit test instead of only on hardware. Mirrors
 * llama-cpp-models.ts's `releaseIdForBackend` exactly.
 *
 * Contract:
 *   cuda   → win-cuda   (NVIDIA; cudart companion handled by the installer)
 *   vulkan → win-vulkan (AMD + Intel + iGPU — one ~36 MB asset covers all)
 *   metal  → mac-arm64  (Apple Silicon; sd.cpp's arm64 build is Metal-capable)
 *   cpu    → the platform default
 *
 * `win-rocm` is deliberately NOT reachable from a detected backend: at ~313 MB
 * against Vulkan's ~36 MB it is an explicit expert choice, never automatic —
 * same tradeoff as llama.cpp's `win-hip`. It stays selectable by passing its
 * platform id to the installer directly.
 *
 * Returns null when the platform has no matching asset at all (Linux), so the
 * caller keeps its existing "unsupported platform" message.
 */
export function sdReleaseForBackend(
  backend: 'cuda' | 'metal' | 'vulkan' | 'cpu',
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): SdPlatform | null {
  const has = (p: SdPlatform): SdPlatform | null =>
    SD_CPP_RELEASES.some(r => r.platform === p) ? p : null

  if (platform === 'win32') {
    if (backend === 'cuda')   return has('win-cuda') ?? has('win-cpu')
    if (backend === 'vulkan') return has('win-vulkan') ?? has('win-cpu')
    return has('win-cpu')
  }
  if (platform === 'darwin' && arch === 'arm64') return has('mac-arm64')
  return null
}

// `tae` is the Tiny AutoEncoder (`--tae`, alias of `--taesd` on the pinned
// binary). It is a DECODER swap, not a VAE swap: 22.6 MB of weights that take
// the VAE-decode peak from the 6–9 GB that killed a 49-frame Wan render down to
// well under a gigabyte (VIDEO-MODELS-RESEARCH §2 lever 3, upstream issue #872
// measured a 19.3 GB compute buffer for 33 frames). No curated row ships one
// yet — the role exists so one CAN, and so a file dropped into a model's own
// directory is honoured (see findTaeFile in sd-cpp-installer).
//
// `llm` is the LLM TEXT ENCODER (`--llm` on the pinned binary, whose help text
// reads "path to the llm text encoder. For example: (qwenvl2.5 for qwen-image,
// mistral-small3.2 for flux2, ...)"). It is the newer conditioning shape: where
// SD 1.5 has CLIP and Flux.1 has T5-XXL, Z-Image / Flux.2 / Qwen-Image condition
// on a general-purpose LLM. `--qwen2vl` is the DEPRECATED alias of the same flag
// — emitting that spelling would work today and rot on the next pin bump.
//
// Adding the role is what unlocks the whole LLM-conditioned generation (research
// §3, "highest leverage-per-line item of both passes"): the download/verify/place
// machinery is role-agnostic, so only the union, the runtime ROLE_SET in
// user-sd-models and ONE line in buildSdArgs had to learn the name.
// `diffusion_high` is the SECOND diffusion file of a Wan 2.2 A14B MoE pair
// (`--high-noise-diffusion-model` on the pinned binary). The two experts are not
// alternatives: upstream's own docs/wan.md command at master-782-b290693 passes
// BOTH, the low-noise one through the ordinary `--diffusion-model`. A second
// ROLE (rather than a flag on the file entry) is what the existing machinery
// already understands — modelComponentPaths writes `<role><ext>` and
// user-sd-models enforces one file per role, so two files claiming `diffusion`
// would collide on disk before they ever reached the engine.
//
// `audio_vae` (`--audio-vae`) and `embeddings_connectors`
// (`--embeddings-connectors`, "path to LTXAV embeddings connectors") are the two
// roles an LTX-2.3 row needs and no Wan row has. They are here for the same
// reason `tae` and `llm` were before their first row: the download / verify /
// place machinery is role-agnostic, so naming the role is what lets a verified
// file be recorded as DATA instead of lost to prose. No SHIPPED row declares
// either — see SD_BLOCKED_MODELS.
export type SdFileRole =
  | 'model' | 'diffusion' | 'diffusion_high' | 'vae' | 'audio_vae'
  | 'clip_l' | 'clip_g' | 't5xxl' | 'clip_vision' | 'llm' | 'embeddings_connectors' | 'tae'
/**
 * `sizeMb` is MEBIbytes (MiB) — every consumer multiplies by 1_048_576
 * (installer preflight `approxTotalBytes`, the catalog's `/1024` GB label).
 *
 * It MUST NOT under-declare: the download manager's disk preflight is keyed on
 * it, so a low number means "started a download the volume cannot hold".
 * Values are `ceil(Content-Length / 1 MiB)`, measured against the live URLs —
 * see the MEASURED table below; test/unit/sdModelSizes.test.ts pins them.
 */
export interface SdModelFile {
  role: SdFileRole
  url: string
  sha256: string
  sizeMb: number
  /**
   * Upstream file name, when the URL does not carry one (risk R2).
   * A Civitai download URL is `…/api/download/models/<versionId>` — no
   * extension anywhere in the path — so the extension has to come from here or
   * from `format`, or a safetensors checkpoint lands on disk as `model.gguf`.
   */
  fileName?: string
  /**
   * Upstream container format: 'SafeTensor' | 'GGUF' | 'PickleTensor' | 'Other'.
   * Civitai's own metadata calls GGUF "Other", so `fileName` is consulted too —
   * see fileExtFor in sd-cpp-installer.ts.
   */
  format?: string
}

// MEASURED 2026-07-27 — HEAD + redirect to the HF CDN, `Content-Length` of the
// 200 response (`X-Linked-Size` on the 302 agrees, and every `X-Linked-ETag`
// matched the sha256 pinned below, so these URLs still serve the pinned bytes).
//
//   sd-turbo    / model      5_214_561_328   (was declared 2500 MiB → 4973)
//   sd15        / model      4_265_146_304   (4270 → 4068)
//   flux Q4     / diffusion  6_783_943_712   (6800 → 6470)
//   flux Q4     / vae          335_304_388   (320  → 320, unchanged)
//   flux Q4     / clip_l       246_144_152   (246  → 235)
//   flux Q4     / t5xxl      2_896_123_072   (2900 → 2762)
//   wan21 1.3b  / diffusion  1_535_768_800   (1465 → 1465, unchanged)
//   wan21 1.3b  / vae          253_815_318   (250  → 243)
//   wan21 1.3b  / t5xxl      6_043_068_256   (6000 → 5764)
//
// MEASURED 2026-07-28, same method, for the SDXL row added in this pass:
//
//   sdxl-base-1.0 / model    6_938_078_334   (→ 6617 MiB)
//
// The sd-turbo row was the dangerous one: it declared 2.5 GB for a 5.2 GB file,
// so the preflight under-reserved by ~2.5 GB and the aggregate percent ran to
// ~200%.

export interface SdImageModel extends SdLicensedRow, SdMachineNeeds {
  id:             string
  name:           string
  /** See SdModelFamily. NOT cosmetic: it is the LoRA/VAE compat gate
   *  (isAdapterCompatible is an equality test on it) and the pixel-grid key. */
  family:         SdModelFamily
  baseSize:       512 | 1024
  steps:          number
  cfgScale:       number
  samplingMethod: string
  /**
   * `--scheduler` (denoiser sigma schedule). OMITTED on every curated row on
   * purpose: sd-cli's default is model-specific and correct for a normal run,
   * and passing one where none is needed changes output for no reason.
   *
   * It exists because DISTILLED weights need it: sd.cpp's Wan default is the
   * DISCRETE schedule, which at 4 steps emits t=999/666/333/0 — not the
   * timesteps a 4-step distill was trained on — so the output looks bad and the
   * LoRA gets blamed (VIDEO-MODELS-RESEARCH §2, "THE SCHEDULER TRAP").
   * `simple` + `--flow-shift 5` reproduces the official schedule.
   *
   * Legal values at the pinned build (`sd-cli --help`, master-782-b290693):
   * discrete karras exponential ays gits smoothstep sgm_uniform simple
   * kl_optimal lcm bong_tangent ltx2 logit_normal flux2 flux beta.
   */
  scheduler?:     string
  /** `--flow-shift` for flow models (SD3.x / Wan). Omitted ⇒ sd-cli's auto. */
  flowShift?:     number
  /** See SdVideoModel.negativePrompt. No curated IMAGE row declares one. */
  negativePrompt?: string
  /**
   * `--clip-skip` this checkpoint was trained for. OMITTED ON EVERY CURATED ROW,
   * deliberately and for the same reason `scheduler` is: 2 is the community norm
   * for anime-class SD 1.5 merges, but "the norm" is not evidence about a
   * particular checkpoint, and a value set here changes the picture on every run
   * without appearing on screen as a decision anyone made.
   *
   * It exists so a USER row (a Civitai import whose model page states one) can
   * carry it as data, and so the composer's control has a rung to fall back to.
   */
  clipSkip?:      number
  notes?:         string
  files:          SdModelFile[]
}

// ── WHAT THE MACHINE NEEDS, AS NUMBERS ───────────────────────────────────────
//
// Both of these were already written down — in the `notes` PROSE, where nothing
// can compute with them: "~11.5 GB of VRAM in use" on a "12 GB card", "plan on
// 32 GB of RAM or more". The catalog card meanwhile ran `estimateFit(sizeBytes x
// 1.2)` and told a 12 GB owner that Flux was too big for a card that runs it,
// because file size is not peak memory for a staged pipeline.
//
// THE RULE FOR FILLING THEM IN: only from the row's OWN measured or sourced
// sentence. A row whose notes state no figure gets NO field, and the card falls
// back to prose — an absent number is honest, and a plausible-looking invented
// one is the same class of fabricated verdict that got the speech rows
// suppressed. This is asserted by test, not just asked for here.
export interface SdMachineNeeds {
  /**
   * The smallest card this row's own notes claim it runs on, in GiB. NOT a
   * computed figure and NOT a promise about any particular size or length: peak
   * memory on these pipelines is driven by resolution and frame count, and the
   * offload flags move it wholesale.
   */
  minVramGb?: number
  /**
   * System RAM in GiB, when RAM is the binding constraint rather than VRAM (the
   * LTX-AV row holds its weights in system memory, so a 24 GB card does not help
   * it and 32 GB of RAM does).
   */
  minRamGb?:  number
}

// ── THE LICENCE A DOWNLOAD LANDS UNDER (the LTX-2.3 unlock) ──────────────────
//
// SD_BLOCKED_MODELS held LTX-2.3 partly on the claim that "the model registry
// has no way to surface a licence today", and treated the LTX-2 agreement's
// pass-through duties ("provide a copy of this Agreement") as OURS. The owner's
// ruling corrected the second half: this app is an MIT download CLIENT, not a
// distributor. The bytes travel from Lightricks' and unsloth's own HuggingFace
// repos to the user's disk — those repos are the distributor, and both of them
// already ship the agreement text next to the weights (unsloth/LTX-2.3-GGUF has
// a LICENSE file in its tree). Nothing is re-hosted here.
//
// What IS ours is informed consent, and these two fields are the whole of it: a
// button that pulls 20.8 GB under a non-OSI licence with a revenue ceiling must
// name that licence and link it BEFORE it is pressed. They are optional because
// a row that has not had its source repo's licence read must not claim one —
// the same rule that keeps `steps` optional on a blocked row.
//
// NAME, not slug. `license: apache-2.0` is HF front-matter; "Apache-2.0" is
// what a person reads. The URL is the licence's own canonical text, and for LTX
// it is the exact `license_link` BOTH source repos declare on the HF model API.
//
// Deliberately NOT the same pair as SdSpeedAdapter's `license` / `source`: that
// one records WHICH REPO we checked and what slug it declared (an audit trail
// for curation), this one is what the user is shown. A repo URL is not a
// licence, and a slug is not a sentence.
export interface SdLicensedRow {
  /** Human-readable licence name, e.g. 'Apache-2.0'. */
  licenseName?: string
  /** Canonical text of that licence. https, and checked when the row landed. */
  licenseUrl?:  string
}

// Curated starter set. URLs are the well-known HF re-hosts — verify each resolves
// (HTTP 200) when pinning SHAs; a wrong URL 404s clearly on first download.
export const SD_IMAGE_MODELS: SdImageModel[] = [
  {
    // THE ONE CURATED ROW WITH NO LICENCE FIELDS, and that is a finding rather
    // than an omission. stabilityai/sd-turbo's model card front matter declares
    // NOTHING — no `license`, no `license_name`, not even a `license:` tag
    // (checked against the HF model API on 2026-07-31; `cardData` holds only
    // `pipeline_tag` and `inference`). Every other curated row's licence was
    // read off that same field. Naming one here from the prose in its README
    // would be this app asserting a licence its source never declared, which is
    // the exact move SPEED_ADAPTER_SOURCE_LICENSES exists to forbid one hop
    // further out. So the field stays unanswered and the panel prints nothing.
    // Worth a driver check before this row is ever recommended commercially.
    id: 'sd-turbo', name: 'SD-Turbo (fast — recommended first try)', family: 'sd15', baseSize: 512,
    steps: 1, cfgScale: 1, samplingMethod: 'euler',
    notes: 'Near-instant: single ~5.2 GB file, 1 step. Runs even on CPU. Best to start with.',
    files: [
      { role: 'model', url: 'https://huggingface.co/stabilityai/sd-turbo/resolve/main/sd_turbo.safetensors', sha256: '3f067a1b943cf162f2b8f8588f6cf5824bd5b4c7d1d88d87164b9ca123616549', sizeMb: 4973 },
    ],
  },
  {
    id: 'sd15', name: 'Stable Diffusion 1.5', family: 'sd15', baseSize: 512,
    steps: 20, cfgScale: 7, samplingMethod: 'euler_a',
    licenseName: 'CreativeML OpenRAIL-M', licenseUrl: 'https://huggingface.co/spaces/CompVis/stable-diffusion-license',
    notes: 'Classic single-file SD. Runs on CPU; more steps than Turbo.',
    files: [
      { role: 'model', url: 'https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors', sha256: '6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa', sizeMb: 4068 },
    ],
  },
  {
    // THE 39% → 85% LEVER (spec §0 / §5-2). The engine has run SDXL all along —
    // the family union listed 'sdxl', the preset table has an sdxl column — but
    // no ROW existed, so every SDXL / Pony / Illustrious / NoobAI checkpoint on
    // Civitai (the majority of the top listings) mapped to a family we could
    // not actually offer. One row closes that.
    //
    // WHY THE PLAIN 1.0 FILE AND NOT `sd_xl_base_1.0_0.9vae.safetensors`:
    // upstream's own SDXL example (docs/sd.md at the pinned tag) passes
    // `--vae sdxl_vae-fp16-fix.safetensors`, and our single-file `-m` branch
    // cannot emit --vae today. That would be the fp16-VAE black-image trap —
    // except the pinned build handles it ITSELF: src/stable-diffusion.cpp
    // (master-782-b290693) applies a 1/32 Conv2D scale when the model is SDXL
    // and no --vae was given ("No valid VAE specified with --vae or
    // --force-sdxl-vae-conv-scale flag set, using Conv2D scale 0.031"). So the
    // canonical single file runs correctly here, and it is also the file whose
    // sha256 IS the Civitai/A1111 identity of SDXL 1.0 base (hash-first dedupe,
    // moat #2).
    //
    // sha256 = the LFS `X-Linked-ETag` of the 302, the same upstream-published
    // source every other row here was pinned from (cross-checked: sd15's
    // X-Linked-ETag equals the sha256 pinned above, byte for byte).
    // License: CreativeML Open RAIL++-M (`license: openrail++` in the model
    // card's front matter) — redistributable, commercial use permitted under
    // the use-restrictions.
    id: 'sdxl-base-1.0', name: 'Stable Diffusion XL 1.0 (base)', family: 'sdxl', baseSize: 1024,
    steps: 28, cfgScale: 5.0, samplingMethod: 'dpm++2m',
    licenseName: 'CreativeML Open RAIL++-M', licenseUrl: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md',
    notes: 'Much stronger than SD 1.5 and the base most Civitai checkpoints build on. Single ~6.5 GB file, renders at 1024x1024; GPU recommended.',
    files: [
      { role: 'model', url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors', sha256: '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b', sizeMb: 6617 },
    ],
  },
  {
    id: 'flux-schnell-q4', name: 'FLUX.1-schnell (Q4)', family: 'flux', baseSize: 1024,
    steps: 4, cfgScale: 1.0, samplingMethod: 'euler',
    licenseName: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    notes: 'High quality, ~4 steps. Large (~10 GB across 4 files); GPU recommended.',
    files: [
      { role: 'diffusion', url: 'https://huggingface.co/city96/FLUX.1-schnell-gguf/resolve/main/flux1-schnell-Q4_K_S.gguf',          sha256: '4fd16477b3a5296d0cf722c4b92a9fd7f30d09ac7495826e4465d8de9c9fd973', sizeMb: 6470 },
      { role: 'vae',       url: 'https://huggingface.co/second-state/FLUX.1-schnell-GGUF/resolve/main/ae.safetensors',                sha256: 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38', sizeMb: 320 },
      { role: 'clip_l',    url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors',            sha256: '660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd',    sizeMb: 235 },
      { role: 't5xxl',     url: 'https://huggingface.co/city96/t5-v1_1-xxl-encoder-gguf/resolve/main/t5-v1_1-xxl-encoder-Q4_K_M.gguf',  sha256: '6be2b0b7e2de7cf2919340c88cb802a103a997ce46c53131cec91958c1db1af4',        sizeMb: 2762 },
    ],
  },
  {
    // ★ THE ROW THE `llm` ROLE EXISTS FOR (LOWVRAM-META-RESEARCH §2/§6, rank 1).
    //
    // Z-Image = 6B S3-DiT, Tongyi/Alibaba, APACHE-2.0, 1.15M downloads/30d.
    // Turbo is the RL-distilled variant: 8 NFEs, CFG disabled, bilingual EN/ZH
    // text rendering, "run on 4GB VRAM or even less" in upstream's own doc.
    //
    // WHY THIS IS THE STRONGEST CURATION SIGNAL WE HAVE: the arch is IN OUR PIN
    // (src/model/diffusion/z_image.hpp, VERSION_Z_IMAGE in the enum), docs/
    // z_image.md ships a worked command, and leejet PERSONALLY maintains the
    // GGUF repo the diffusion file below comes from. Every number here is that
    // command, verbatim: `--cfg-scale 1.0 ... --steps 8`.
    //
    // THE VAE IS ALREADY ON DISK for a flux owner. Z-Image reuses the FLUX.1
    // autoencoder verbatim, so this declares the SAME url / sha / size as the
    // flux-schnell row above — one file identity, two rows. The installer's
    // sha-keyed reuse (findReusableComponent) then places it without a second
    // download: 6,388 MiB total, 6,068 MiB incremental. See sdComponentReuse.
    //
    // THREE TRAPS, all source-confirmed, all encoded above rather than in prose:
    //  1. BASE vs TURBO — the Base GGUF renders blank white images (upstream
    //     #1488, STILL OPEN). Turbo only, and the id says so.
    //  2. THE ENCODER — leejet pins Qwen3-4B-**Instruct-2507**; the community
    //     uses plain Qwen3-4B, a DIFFERENT checkpoint behind the same flag.
    //     Klein-4B wants the plain one, so these two rows must never be assumed
    //     to share an encoder download (architecturally shared, not byte-shared).
    //  3. CFG 1.0 — at guidance 1 sd.cpp encodes no unconditional pass, so the
    //     NEGATIVE PROMPT IS SILENTLY IGNORED. The composer already reads that
    //     off the row (localGenOptionsFor's `inert = row.cfgScale <= 1`) and
    //     drops the guidance slider + says so, because of this number.
    //
    // KNOWN, and NOT fixable by a pin bump: upstream #1818 — Turing (sm_75) runs
    // Z-Image ~2x slower than it should after a ggml bump. Ampere is unaffected.
    // Removing --diffusion-fa makes it WORSE, so that flag is never the thing to
    // "optimize" away.
    id: 'z-image-turbo', name: 'Z-Image Turbo (Apache-2.0, 8 steps)', family: 'zimage', baseSize: 1024,
    steps: 8, cfgScale: 1.0, samplingMethod: 'euler',
    licenseName: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    notes: 'Newest of the local image models and the best value: 6B, Apache-2.0, renders 1024x1024 in ~8 steps. ~6.2 GB across 3 files — and if you already have FLUX.1 it shares that model\'s autoencoder, so only ~5.9 GB is downloaded. Guidance is fixed at 1, so a negative prompt does nothing on this model.',
    files: [
      { role: 'diffusion', url: 'https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q4_K.gguf', sha256: '14b375ab4f226bc5378f68f37e899ef3c2242b8541e61e2bc1aff40976086fbd', sizeMb: 3686 },
      // BYTE-IDENTICAL to flux-schnell-q4's vae — same url, same sha, same size.
      { role: 'vae',       url: 'https://huggingface.co/second-state/FLUX.1-schnell-GGUF/resolve/main/ae.safetensors', sha256: 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38', sizeMb: 320 },
      { role: 'llm',       url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf', sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597', sizeMb: 2382 },
    ],
  },
]

// ── TAEF1 on z-image-turbo: SOURCE VERIFIED, NOT WIRED — a schema gap ────────
//
// The research claim (this lane's brief) is that TAEF1 works as Z-Image's
// `--tae` decoder swap. Checked two ways rather than taken on faith:
//
//  1. SOURCE: madebyollin/taef1 on the HF model API (fetched 2026-07-31) —
//     200 anonymous, `cardData.license: "mit"` (also tagged `license:mit`).
//     Reachable and redistributable, both required, both true.
//  2. THE ENGINE ITSELF, at our pin (master-782-b290693): src/model/vae/tae.hpp
//     builds its `TAESD` wrapper with `z_channels = 16` whenever
//     `sd_version_is_dit(version)` is true, and src/model.h lists
//     `sd_version_is_z_image(version)` as one of the `sd_version_is_dit`
//     arms — the SAME arm `sd_version_is_flux` sits in, and the same
//     z_channels the FLUX-trained TAEF1 checkpoint was trained at. That is
//     also why Z-Image reuses FLUX's real VAE verbatim two rows up:
//     `sd_version_uses_flux_vae` lists `sd_version_is_z_image` too. TAEF1 is
//     not a guess here, it is the FLUX decoder-approximation weights loaded
//     against the exact latent shape Z-Image already runs.
//     Upstream's own docs/taesd.md worked example is the analogous SD1.5 case
//     (`--taesd .../madebyollin/taesd/.../diffusion_pytorch_model.safetensors`)
//     — the SAME diffusers-layout single safetensors file shape, just the FLUX
//     repo instead of the SD1.5 one, so no format conversion is implied.
//
// The file, verified, would be:
//   { role: 'tae', url: 'https://huggingface.co/madebyollin/taef1/resolve/main/diffusion_pytorch_model.safetensors',
//     sha256: '47a6c2bff850da04b267cab70fe3553fef57255eb9a8e76852baa0a87850e54d', sizeMb: 10 }
//
// NOT ADDED to z-image-turbo.files, and that is the schema gap this comment
// reports rather than papers over: every entry in `SdImageModel.files` is
// MANDATORY — `modelComponentPaths` (sd-cpp-installer.ts) resolves one dest
// path per declared role with no way to mark one skippable, and
// `isSdModelInstalled` requires EVERY one of those paths to exist. There is no
// `optional?: boolean` anywhere on `SdModelFile`. Pushing this file into the
// row's `files` today would silently do two things nobody asked for: every
// z-image-turbo install already on a user's disk stops reading as installed
// until an unrequested 10 MB file also lands, and every FRESH install's
// preflight reserves + downloads bytes for a decoder swap that is a nicety,
// not a requirement (unlike Flux's vae, which the row cannot run without).
// Forcing it in is the exact "shipped a Download button that changes behaviour
// nobody asked for" failure this registry's other comments refuse elsewhere.
//
// It is NOT unreachable to a user today, though: findTaeFile
// (sd-cpp-installer.ts) already honours ANY `tae*.safetensors` dropped into the
// model's own directory by hand, with zero code change — that disk-driven path
// is what the `tae` role's original comment (above, near SdFileRole) says it
// exists for. What is missing is CURATION — an auto-download offered by this
// app — and that specifically is blocked on `SdModelFile` growing a way to say
// "fetch this, but do not gate installed-ness or the mandatory preflight on
// it." Until that field exists, this stays a comment instead of a row.

/**
 * A row whose DATA is verified but which we refuse to ship, with the reason.
 *
 * The alternative is worse in both directions: dropping the research means the
 * next lane re-pulls SHAs that were already triple-checked, and shipping the row
 * means a Download button that 404s or lands a model that cannot load. So the
 * verified half lives here, `blocked` says exactly what is missing, and nothing
 * merges it into SD_IMAGE_MODELS / allSdModels / the catalog IPC.
 */
export interface SdBlockedModel {
  id:             string
  name:           string
  /** Declared honestly even though the row is not offered — `flux2` is a
   *  different architecture from `flux` (different VAE latent format, LLM
   *  conditioning), so calling it 'flux' would poison the compat gate the day
   *  it ships. Widened to `string` because the union describes SHIPPABLE
   *  families only. */
  family:         string
  /** Which registry it would join, and the grid tag its card carries. Was
   *  implicit while every blocked row was an image model; a blocked VIDEO row
   *  has to say so or the renderer mirror has to guess. */
  kind:           'image' | 'video'
  /**
   * The row's recipe, WHEN WE HAVE ONE. All four are optional because a row can
   * be blocked precisely because its numbers are unverified — inventing a step
   * count so a field can be filled is the kind of confident fiction this list
   * exists to avoid. (`baseSize` is an image concept and never applies to a
   * video row at all.)
   */
  baseSize?:       512 | 1024
  steps?:          number
  cfgScale?:       number
  samplingMethod?: string
  /** WHY this is not in SD_IMAGE_MODELS / SD_VIDEO_MODELS. Written for the
   *  person who unblocks it. */
  blocked:        string
  /** Only the components that are actually resolved. Never a guessed URL. */
  files:          SdModelFile[]
}

export const SD_BLOCKED_MODELS: SdBlockedModel[] = [
  {
    // Rank 2 of the curation list (LOWVRAM-META-RESEARCH §6), and the pick that
    // CORRECTED the earlier Klein-9B one: 4.5x smaller, Apache-2.0 rather than
    // non-commercial, 381k downloads/30d, and leejet publishes the GGUF himself.
    //
    // The DiT below is pinned and HEAD-verified. The row is still blocked on the
    // other two components, and both blockers are LICENSE/IDENTITY problems that
    // no amount of code solves — they need a decision plus one driver check:
    //
    //  • VAE — docs/flux2.md at our pin passes `flux2_ae.safetensors` from
    //    black-forest-labs/FLUX.2-dev, which is a GATED repo under BFL's
    //    NON-COMMERCIAL licence: we cannot ship an anonymous download of it, and
    //    shipping it would put a non-commercial file inside an Apache row. BFL's
    //    own apache-2.0 klein-4B repo does ship a VAE, but in DIFFUSERS layout
    //    (vae/diffusion_pytorch_model.safetensors) — a container our own
    //    installer REFUSES by name (isRefusedWeightFormat) and which sd.cpp has
    //    not been shown to load. Upstream also names FLUX.2-small-decoder as an
    //    alternative. Which of the three actually loads is one driver check.
    //  • LLM ENCODER — upstream passes `qwen_3_4b.safetensors`: PLAIN Qwen3-4B,
    //    NOT the Qwen3-4B-Instruct-2507 the Z-Image row pins. No canonical
    //    re-host with a published sha was identified, so there is no file
    //    identity to pin and the two rows must NOT be assumed to share one.
    //
    // AND WHAT THE TWO FILES WOULD BUY — the half the refusal was missing.
    // Research (LOWVRAM-META-RESEARCH-2026-07-28, DELTA ADDENDUM §B, "KLEIN-4B
    // ROW UPGRADE — biggest item") establishes this is not another txt2img
    // checkpoint: Klein's marquee tricks (single-reference KV edit, two-image
    // face+pose swap, merge) are NATIVE multi-reference conditioning rather
    // than workflow-node magic, and OUR PIN already carries the plumbing —
    // docs/flux2.md at master-782-b290693 ships klein EDIT examples driven by
    // `-r ref.png`, and main.cpp parses the flag into a VECTOR, so `-r a.png
    // -r b.png` is a real two-reference call. No curated local row can edit a
    // photo against a reference today (every one is txt2img plus `--strength`
    // img2img, a different operation), so this is a capability class rather
    // than one more checkpoint.
    //
    // DATA ONLY. The row stays blocked, no reference-image slot is built, and
    // the sentence stays subjunctive — building UI for weights nobody can
    // obtain is the exact mistake this list exists to prevent.
    id: 'flux2-klein-4b', name: 'FLUX.2 Klein 4B (Q4_0)', family: 'flux2', kind: 'image', baseSize: 1024,
    steps: 4, cfgScale: 1.0, samplingMethod: 'euler',
    blocked:
      'Needs two components we cannot pin yet. VAE: upstream docs/flux2.md points at flux2_ae.safetensors in the GATED, NON-COMMERCIAL black-forest-labs/FLUX.2-dev repo; the apache-2.0 klein-4B repo ships one only in DIFFUSERS layout (a container the installer refuses), and FLUX.2-small-decoder is an untested alternative — pick one and prove it loads. LLM encoder: upstream uses qwen_3_4b.safetensors, PLAIN Qwen3-4B, which is a different checkpoint from the Qwen3-4B-Instruct-2507 the Z-Image row pins, and no re-host with a published sha256 was found. What unlocking it would buy: this is not another text-to-image model. Klein edits an existing picture against a reference image, and our pinned engine already speaks it — upstream docs/flux2.md ships Klein edit examples driven by `-r ref.png`, and the flag is parsed as a list, so two of them (`-r a.png -r b.png`) drive the face-swap and merge tricks the model is known for. Nothing we ship locally today can edit a photo against a reference at all, so these two files would add a capability, not just another checkpoint.',
    files: [
      { role: 'diffusion', url: 'https://huggingface.co/leejet/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q4_0.gguf', sha256: 'd1023499ef3f2f82ff7c50e6778495195c1b6cc34835741778868428111f9ff4', sizeMb: 2347 },
    ],
  },
]

/**
 * `--fps` when a video row does not declare its own, and the pixel grid every
 * Wan 2.1 checkpoint uses.
 *
 * BOTH ARE WAN 2.1 FACTS, not universal ones, which is why they are DEFAULTS
 * and not constants any more:
 *  • 16 fps is the rate Wan 2.1's own generate.py writes at. `sd-cli --help`
 *    lists `--fps <int>` with a default of **24**, so leaving the flag off muxes
 *    16 fps content into a 24 fps container and the clip plays 1.5x fast. Wan
 *    2.2 TI2V-5B is genuinely 24 fps, so the same constant is wrong the OTHER
 *    way for it — hence the per-row override.
 *  • 16 px because Wan 2.1's VAE compresses 8x spatially and the DiT patchifies
 *    2x2 on top. Wan 2.2's TI2V VAE compresses 16x, so that row is on 32 and its
 *    720p pair is 1280x704 — explicitly NOT 1280x720 (VIDEO-MODELS-RESEARCH §1,
 *    "PARAM TRAPS", the 73d461c/9db0dbd bug class pre-caught).
 */
export const DEFAULT_VIDEO_FPS = 16
export const DEFAULT_VIDEO_PIXEL_GRID = 16
/**
 * `--video-frames` must be `frameGrid * n + 1`, and 4 is WAN's number, not a
 * law of video — the same shape of mistake DEFAULT_VIDEO_FPS already corrects
 * one axis over.
 *
 * A video VAE compresses the temporal axis with the first frame kept whole, so
 * F frames become (F-1)/grid + 1 latents. Wan (2.1 and 2.2 alike) compresses
 * 4x; LTX-AV compresses 8x. Both numbers are in the PINNED engine, in one
 * function — stable-diffusion.cpp's video_frames_to_latent_frames:
 *
 *   if (sd_version_is_ltxav(version))  latent_frames = ((frames - 1) / 8) + 1;
 *   else if (sd_version_is_wan(...))   latent_frames = ((frames - 1) / 4) + 1;
 *
 * …and Lightricks' own model card says the same thing from the other side
 * ("Frame count must be divisible by 8 + 1"). It matters because the division
 * is INTEGER and the engine decodes back out (latent_frames_to_video_frames):
 * a request of 45 — a perfectly legal 4n+1 count — renders 41 frames on LTX,
 * silently. The composer would say 45, the gallery would stamp 45, and the file
 * would be 41.
 */
export const DEFAULT_VIDEO_FRAME_GRID = 4

export interface SdVideoModel extends SdLicensedRow, SdMachineNeeds {
  id:             string
  name:           string
  /** The DiT architecture, which is what decides the temporal/spatial laws
   *  below — `ltx2` is LTX-AV (VAE 32x spatial / 8x temporal, an LLM text
   *  encoder, an audio VAE and embeddings connectors), not a Wan dialect. It is
   *  also the LoRA/VAE compat key, so mislabelling one would let a Wan adapter
   *  load onto weights it cannot fit. */
  family:         'wan' | 'ltx2'
  width:          number
  height:         number
  frames:         number
  steps:          number
  cfgScale:       number
  samplingMethod: string
  /** Native frame rate. Omitted ⇒ DEFAULT_VIDEO_FPS (16, every Wan 2.1 row). */
  fps?:           number
  /** `-W`/`-H` must be a multiple of this. Omitted ⇒ DEFAULT_VIDEO_PIXEL_GRID. */
  pixelGrid?:     number
  /** `--video-frames` must be `frameGrid * n + 1`. Omitted ⇒
   *  DEFAULT_VIDEO_FRAME_GRID (4, every Wan row). LTX-AV is 8. */
  frameGrid?:     number
  /** See SdImageModel.scheduler — the distill trap lives on this side too.
   *
   *  OMITTED ON EVERY CURATED ROW, and on LTX that is load-bearing rather than
   *  merely tidy: sd_get_default_scheduler returns LTX2_SCHEDULER for an LTXAV
   *  checkpoint by itself, so naming one here could only ever REPLACE the
   *  engine's own choice with a guess. */
  scheduler?:     string
  /** `--flow-shift`. The official Self-Forcing/CausVid schedules use 5.
   *
   *  Same rule as `scheduler` for LTX: the engine derives 2.37 for LTXAV
   *  (default_flow_shift in stable-diffusion.cpp), and passing anything here
   *  overrides it. Upstream's own LTX commands pass none. */
  flowShift?:     number
  // ── The Wan 2.2 A14B MoE pair (`diffusion_high`) ───────────────────────────
  //
  // A row with two diffusion files runs TWO passes over the same latents: a
  // high-noise expert first, then a low-noise one. sd-cli takes a full parallel
  // parameter set for the first (`--help` on master-782-b290693 lists
  // --high-noise-steps / --high-noise-cfg-scale / --high-noise-sampling-method
  // alongside --high-noise-guidance / --high-noise-slg-scale / --high-noise-eta
  // / --high-noise-skip-layer-*), and the three below are the three the plain
  // pass already exposes. They are ROW-OWNED and have no composer control: the
  // visible Steps / Guidance / Sampler drive the LOW pass, where the research
  // says the quality lives ("low-noise expert owns facial identity, give it the
  // steps"). Omitted ⇒ the flag is not passed and sd-cli's own default stands
  // (`--high-noise-steps` defaults to -1 = auto, which is what enables
  // `--moe-boundary`'s timestep split).
  highNoiseSteps?:          number
  highNoiseCfgScale?:       number
  highNoiseSamplingMethod?: string
  /** image-to-video. CAN, never MUST: TI2V-5B is one checkpoint that does both,
   *  and upstream ships two commands for it that differ by a single `-i`. What
   *  this gates is whether the composer OFFERS the (optional) init-frame
   *  control at all — see surplus-media-service's localVideoOptionsFor. Wan 2.1
   *  i2v additionally needs a clip_vision component; Wan 2.2 does not. */
  i2v:            boolean
  /** See WAN_DEFAULT_NEGATIVE. The row's OWN negative conditioning, pre-filled
   *  into the composer's field and fully user-editable from there. */
  negativePrompt?: string
  notes?:         string
  files:          SdModelFile[]  // roles: diffusion, vae, t5xxl [, clip_vision for i2v]
}

// ── Wan's official negative prompt ───────────────────────────────────────────
//
// Not a "quality tags" habit and not ours: this is the string Wan's OWN
// inference code passes on every sample, so the checkpoint was tuned with it in
// the unconditional branch. Research (LOWVRAM-META-RESEARCH-2026-07-28, DELTA
// ADDENDUM §B) records that removing it MEASURABLY degrades output — the
// Chinese-language terms are not decoration, they work at model level.
//
// VERIFIED VERBATIM against upstream's own source, and the two generations
// agree byte for byte:
//   github.com/Wan-Video/Wan2.1 · wan/configs/shared_config.py · sample_neg_prompt
//   github.com/Wan-Video/Wan2.2 · wan/configs/shared_config.py · sample_neg_prompt
// test/unit/wanDefaultNegative.test.ts pins the exact characters (28 terms,
// U+FF0C separators) so an encoding accident cannot quietly replace it with
// mojibake that would still be forwarded and would still condition on garbage.
//
// LIVE, not inert: both Wan rows render at cfg 6, and sd.cpp only encodes the
// unconditional pass when guidance ≠ 1. The very fact that makes a negative
// prompt do NOTHING on z-image-turbo (cfg 1, see localGenOptionsFor's
// `negativeIsInert`) makes it fully effective here.
//
// It reaches sd-cli as `-n` through the ORDINARY row-owned-default path —
// localGenOptionsFor lifts it onto the negative_prompt ParamSpec's `default`,
// exactly like steps / cfg / sampler / size. So it PRE-FILLS the field the user
// can see and edit, rather than being appended behind their back at run time:
// whatever is in that box is what runs, and a user's own text simply replaces
// it.
export const WAN_DEFAULT_NEGATIVE =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'

// Curated local video (Wan). Heavy + slow on consumer GPUs — start with the
// small 1.3B t2v. URLs are best-known HF re-hosts; verify they resolve when
// pinning SHAs.
export const SD_VIDEO_MODELS: SdVideoModel[] = [
  {
    id: 'wan21-t2v-1.3b', name: 'Wan 2.1 T2V 1.3B', family: 'wan', width: 832, height: 480,
    frames: 33, steps: 20, cfgScale: 6, samplingMethod: 'euler', i2v: false,
    negativePrompt: WAN_DEFAULT_NEGATIVE,
    licenseName: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    notes: 'Text→video, small/fast Wan. Multi-file (~8 GB incl. t5); GPU strongly recommended.',
    files: [
      { role: 'diffusion', url: 'https://huggingface.co/samuelchristlie/Wan2.1-T2V-1.3B-GGUF/resolve/main/Wan2.1-T2V-1.3B-Q8_0.gguf', sha256: '30a44f695b4275a915810120360d6fd26152ec303c2226b5152ec33a93c380e4', sizeMb: 1465 },
      { role: 'vae',       url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', sha256: '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b', sizeMb: 243 },
      { role: 't5xxl',     url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q8_0.gguf', sha256: '2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc', sizeMb: 5764 },
    ],
  },
  {
    // THE INIT-FRAME CONTROL COMES BACK (VIDEO-MODELS-RESEARCH §6 / LOWVRAM §4).
    //
    // a403875 removed "INIT FRAME (IMAGE→VIDEO)" from the composer because it
    // was a lie: image→video is a DIFFERENT CHECKPOINT, not a flag — Wan's i2v
    // variants take extra conditioning channels and require a clip_vision
    // encoder alongside the DiT — and the one video row we shipped is t2v. The
    // owner attached a frame, waited out the render, and got pure text→video.
    //
    // The narrowing was keyed off `row.i2v` from the start, so this row is DATA
    // ONLY: no branch anywhere changes, the control simply comes back for THIS
    // model (surplus-media-service's `if (localVid && !localVid.i2v) continue`),
    // and the client already emits --clip_vision and -i.
    //
    // EVERY NUMBER IS UPSTREAM'S OWN i2v EXAMPLE at the pinned commit
    // (docs/wan.md): `--cfg-scale 6.0 --sampling-method euler --video-frames 33
    // --flow-shift 3.0` at the 480p pair. The example passes no --steps, so the
    // row takes sd-cli's documented default (`--steps <int> ... (default: 20)`)
    // rather than inventing a number.
    //
    // vae + t5xxl ARE the 2.1 files already curated above — byte-identical url /
    // sha / size, so a user who has the 1.3B t2v row downloads only the DiT and
    // the clip_vision (12,022 MiB of 18,029). See sdComponentReuse.
    //
    // HONEST COST, from the source that named this row: ~30 min for a 6 s clip on
    // a 4 GB card. This is the quality tier, not the "it runs" tier — the 1.3B
    // t2v row above stays the recommended first video model.
    id: 'wan21-i2v-14b-480p', name: 'Wan 2.1 I2V 14B 480P (image → video)', family: 'wan',
    width: 832, height: 480, frames: 33, steps: 20, cfgScale: 6, samplingMethod: 'euler',
    flowShift: 3, i2v: true,
    // MEASURED, by us, on this row: ~11.5 GB in use on a 12 GB card (see notes).
    minVramGb: 12,
    negativePrompt: WAN_DEFAULT_NEGATIVE,
    licenseName: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    notes: 'Animates a still image (Apache-2.0). The only local model that can start from a picture — pick one under Init frame. Big and slow: ~17.6 GB across 4 files, and if you already have the 1.3B Wan model it shares two of them, so only ~11.7 GB is downloaded. GPU strongly recommended. Measured here: 33 frames at the row default of 20 steps took ~44 min on a 12 GB card, GPU-bound the whole time (~11.5 GB of VRAM in use — this is the model working, not CPU offload thrashing). Tens of minutes per clip is normal, so plan it as a render you start and come back to rather than something to iterate on; a distilled few-step Wan row is the speed path, and this row is not it.',
    files: [
      { role: 'diffusion',   url: 'https://huggingface.co/city96/Wan2.1-I2V-14B-480P-gguf/resolve/main/wan2.1-i2v-14b-480p-Q4_K_M.gguf', sha256: 'd91f7139acadb42ea05cdf97b311e5099f714f11fbe4d90916500e2f53cbba82', sizeMb: 10816 },
      // BYTE-IDENTICAL to wan21-t2v-1.3b's vae + t5xxl.
      { role: 'vae',         url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', sha256: '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b', sizeMb: 243 },
      { role: 't5xxl',       url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q8_0.gguf', sha256: '2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc', sizeMb: 5764 },
      // REQUIRED for 2.1 i2v — the t2v row needs none, which is exactly why the
      // composer could tell the two apart before this row existed.
      { role: 'clip_vision', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors', sha256: '64a7ef761bfccbadbaa3da77366aac4185a6c58fa5de5f589b42a65bcc21f161', sizeMb: 1206 },
    ],
  },
  {
    // ★ THE STRONG RECOMMEND (VIDEO-MODELS-RESEARCH §1, ROW 1): ONE checkpoint
    // that does BOTH text→video and image→video, Apache-2.0, and 720p-native at
    // 5B — where the 2.1 line needs a 14B model and 17.6 GB to leave 480p.
    //
    // WHY IT IS CHEAP AT 720p: Wan 2.2's TI2V VAE compresses 16x spatially where
    // 2.1's compresses 8x, so a 1280x704 latent here is the size of a 640x352
    // one on the rows above. That same VAE is the reason for the two param traps
    // below, and it is why this row does NOT reuse the 2.1 autoencoder.
    //
    // EVERY NUMBER IS UPSTREAM'S OWN TI2V-5B EXAMPLE at the pinned commit
    // (docs/wan.md, master-782-b290693): `--cfg-scale 6.0 --sampling-method
    // euler --flow-shift 3.0`, and no `--steps`, so the row takes sd-cli's
    // documented default of 20 rather than inventing one — the same reading the
    // i2v row above was pinned from. Upstream also ships the I2V variant of that
    // command differing by a single `-i`, which is the source for `i2v: true`
    // meaning CAN and not MUST.
    //
    // ── THE TWO PARAM TRAPS, pre-caught by research and encoded as row data ───
    //  • fps: 24, not 16. The client used to pass a module constant of 16, which
    //    would have muxed this model's 24 fps output into a 16 fps container —
    //    the 2bd48fc bug class, mirrored.
    //  • pixelGrid: 32, not 16 — so the 720p pair is 1280x704 and NOT 1280x720.
    //    The composer's resolution picker speaks in labels and resolves them
    //    through a Wan 2.1 table, so 1280x720 is exactly what this row would
    //    have been handed; buildSdVideoArgs floors it onto the row's grid.
    // Frames stay 4n+1 (the temporal law is unchanged: 4x compression with the
    // first frame kept whole).
    //
    // WHY 49 FRAMES: the other two rows default to 33 frames at 16 fps = ~2 s,
    // and 49 at 24 fps is that same ~2 s expressed in THIS checkpoint's rate. It
    // is also the count that round-trips through the composer's seconds slider
    // (49/24 → 2 s → 49), which 33 at 24 fps does not (33/24 → 1 s → 25).
    //
    // THE t5xxl IS THE FILE ALREADY ON DISK: byte-identical url / sha / size to
    // both 2.1 rows, so a Wan owner downloads only the DiT and the 2.2 VAE —
    // 6,496 MiB of 12,260. The VAE is NOT shared: wan2.2_vae is a different
    // autoencoder from wan_2.1_vae, and upstream says so in one line ("wan_2.1_
    // vae (for all the wan model except Wan2.2 TI2V 5B)").
    //
    // SOURCED FROM QUANTSTACK FOR BOTH FILES, deliberately. The 2.2 VAE is also
    // in Comfy-Org/Wan_2.2_ComfyUI_Repackaged at the SAME sha256 (byte-identical,
    // verified) — but that repo declares NO license on its model card, while
    // QuantStack's ships `license: apache-2.0` and re-states it ("all original
    // licensing terms and usage restrictions remain in effect", over Wan-AI's
    // apache-2.0 base). Same bytes, declared licence: no reason to take the
    // other one.
    id: 'wan22-ti2v-5b', name: 'Wan 2.2 TI2V 5B (text or image → video)', family: 'wan',
    width: 1280, height: 704, frames: 49, steps: 20, cfgScale: 6, samplingMethod: 'euler',
    fps: 24, pixelGrid: 32, flowShift: 3, i2v: true,
    // The row's own sentence: "start at 480p if you are on 8 GB" — i.e. 8 is the
    // floor it claims, at the SMALLEST tier. Not a promise about 1280x704, which
    // is why the number stands alone and the card renders the notes beside it.
    minVramGb: 8,
    negativePrompt: WAN_DEFAULT_NEGATIVE,
    licenseName: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    notes: 'The one to try first for anything beyond 480p: a single 5 GB model that does BOTH text→video and image→video (attach a picture under Init frame, or leave it empty), renders 1280x704 natively, and is Apache-2.0. ~12 GB across 3 files, and if you already have a Wan model it shares the 5.6 GB text encoder, so only ~6.3 GB is downloaded. Runs at 24 fps, unlike the Wan 2.1 rows here. Not yet timed on our own hardware — treat the first render as the measurement, and start at 480p if you are on 8 GB.',
    files: [
      { role: 'diffusion', url: 'https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF/resolve/main/Wan2.2-TI2V-5B-Q8_0.gguf', sha256: '57bece983817ab2f957546683bb670f13be7d99022d45674840cd999a050ea8f', sizeMb: 5151 },
      // The 2.2 autoencoder. NOT the 2.1 one — different file, different repo,
      // and the single most likely thing to be "reused" by mistake.
      { role: 'vae',       url: 'https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF/resolve/main/VAE/Wan2.2_VAE.safetensors', sha256: 'e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156', sizeMb: 1345 },
      // BYTE-IDENTICAL to both 2.1 rows' t5xxl — one file, three declarations.
      { role: 't5xxl',     url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q8_0.gguf', sha256: '2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc', sizeMb: 5764 },
    ],
  },
  {
    // THE FIRST ROW WITH TWO DIFFUSION FILES (VIDEO-MODELS-RESEARCH §1 ROW 2 /
    // §6). Wan 2.2 A14B is a mixture-of-experts pair — a high-noise expert that
    // lays down structure and a low-noise one that resolves detail — and BOTH
    // files are required. It is the #1 video GGUF by downloads and the quality
    // tier above everything else we ship.
    //
    // EVERY NUMBER IS UPSTREAM'S OWN "Wan2.2 I2V A14B" COMMAND at the pinned
    // commit (docs/wan.md, master-782-b290693), which is also where the flag
    // names come from:
    //   --diffusion-model <LowNoise> --high-noise-diffusion-model <HighNoise>
    //   --cfg-scale 3.5 --sampling-method euler --steps 10
    //   --high-noise-cfg-scale 3.5 --high-noise-sampling-method euler
    //   --high-noise-steps 8 --flow-shift 3.0 -W 832 -H 480 --video-frames 33
    //
    // WHY NOT THE 2/4-STEP PRESET the research addendum records (euler high /
    // heun low, cfg 1.5/1.0): that preset comes from a workflow running the
    // lightx2v 4-step DISTILL LoRAs, and upstream's own LoRA example confirms it
    // — same model, `--steps 4 --high-noise-steps 4`, with the `<lora:...>` and
    // `<lora:|high_noise|...>` tags in the prompt. Six total steps at guidance
    // ~1 on the VANILLA weights this row pins is the SCHEDULER-TRAP failure in
    // another costume: the output looks broken and the model gets blamed. The
    // distill preset is the speed lane, and it arrives with the LoRAs, not here.
    //
    // NO clip_vision, and that is not an oversight: it is a Wan 2.1 i2v
    // requirement, and upstream's 2.2 command passes none. 1.2 GB not downloaded.
    //
    // vae + t5xxl ARE the 2.1 files (upstream: "wan_2.1_vae (for all the wan
    // model except Wan2.2 TI2V 5B)"), byte-identical url / sha / size, so a Wan
    // owner downloads only the pair: 12,428 MiB of 18,435.
    //
    // Q3_K_S, not Q4_K_M: the pair is what makes this expensive — Q4_K_M would
    // be 9,205 MiB TWICE (18 GB of DiT alone). Q3 is at the community quant
    // floor, which is the honest trade for a 14B-class model on a 12 GB card.
    id: 'wan22-i2v-a14b', name: 'Wan 2.2 I2V A14B (image → video, quality tier)', family: 'wan',
    width: 832, height: 480, frames: 33, steps: 10, cfgScale: 3.5, samplingMethod: 'euler',
    highNoiseSteps: 8, highNoiseCfgScale: 3.5, highNoiseSamplingMethod: 'euler',
    flowShift: 3, i2v: true,
    // The quant floor was PICKED for a 12 GB card (see the comment above the id),
    // and the notes say the same in prose.
    minVramGb: 12,
    negativePrompt: WAN_DEFAULT_NEGATIVE,
    licenseName: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    notes: 'The quality tier: Wan 2.2\'s 14B-class image→video pair (Apache-2.0). It runs TWO models over every clip — a high-noise pass then a low-noise one — so both files are required and it is the biggest local video download we offer: ~18 GB across 4 files, of which ~12.1 GB is new if you already have a Wan model. Expect the same class of wall-clock as the 2.1 14B row — tens of minutes for a few seconds on a 12 GB card — so plan it as a render you start and come back to. The speed path for this model is distilled few-step LoRAs, which are a user-installed extra and not part of this row.',
    files: [
      // LOW noise = the ordinary --diffusion-model, exactly as upstream orders
      // them. Getting these two the wrong way round produces a render, not an
      // error, so the roles are the only thing keeping them straight.
      { role: 'diffusion',      url: 'https://huggingface.co/QuantStack/Wan2.2-I2V-A14B-GGUF/resolve/main/LowNoise/Wan2.2-I2V-A14B-LowNoise-Q3_K_S.gguf', sha256: '3352289be6021c783df4716686fb3bb8ec09bf8e1230350145294c78d1ce55b0', sizeMb: 6214 },
      { role: 'diffusion_high', url: 'https://huggingface.co/QuantStack/Wan2.2-I2V-A14B-GGUF/resolve/main/HighNoise/Wan2.2-I2V-A14B-HighNoise-Q3_K_S.gguf', sha256: '2708962c357537c9f517fa49edd8397f3024057b059c3e8df827c774271e1161', sizeMb: 6214 },
      // BYTE-IDENTICAL to the 2.1 rows' vae + t5xxl.
      { role: 'vae',            url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', sha256: '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b', sizeMb: 243 },
      { role: 't5xxl',          url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q8_0.gguf', sha256: '2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc', sizeMb: 5764 },
    ],
  },
  {
    // THE TEXT-ONLY TWIN OF wan22-i2v-a14b — same MoE pair shape
    // (`diffusion_high`), same VAE/T5 dedup, different task head. lightx2v's
    // report on the T2V distill pair (0f7df10) named this row; the vanilla
    // recipe below is pinned fresh rather than copied from that report.
    //
    // EVERY NUMBER IS UPSTREAM'S OWN "Wan2.2 T2V A14B" COMMAND at the pinned
    // commit (docs/wan.md, master-782-b290693) — fetched and read verbatim
    // rather than assumed equal to the i2v row, because the two task heads
    // could easily have shipped different defaults:
    //   --diffusion-model <LowNoise> --high-noise-diffusion-model <HighNoise>
    //   --vae wan_2.1_vae.safetensors --t5xxl umt5-xxl-encoder-Q8_0.gguf
    //   --cfg-scale 3.5 --sampling-method euler --steps 10
    //   --high-noise-cfg-scale 3.5 --high-noise-sampling-method euler
    //   --high-noise-steps 8 -W 832 -H 480 --video-frames 33 --flow-shift 3.0
    // They are NOT different: this is the exact same 10/8-step, cfg-3.5,
    // flow-shift-3 recipe as wan22-i2v-a14b, at the same 480p/33-frame default —
    // confirmed by reading the command rather than by assuming symmetry.
    //
    // i2v: false — upstream ships a SEPARATE "T2V A14B T2I" section for the
    // no-motion still-frame variant of this same checkpoint, not an image INPUT
    // path; nothing here takes a `-i`. fps/pixelGrid/frameGrid all take their
    // DEFAULT_VIDEO_* values (16 / 16 / 4) — this is a Wan 2.1-grid checkpoint
    // like every other A14B/1.3B row, NOT the TI2V-5B one with its 16x VAE.
    //
    // SOURCE: QuantStack/Wan2.2-T2V-A14B-GGUF, `cardData.license: apache-2.0`
    // (HF model API, fetched 2026-07-31) — the same publisher and licence as the
    // i2v-a14b pair. Q3_K_S again, for the same reason the i2v row gives: Q4_K_M
    // would be two ~9 GB files, and Q3 is the honest floor for a 14B-class pair
    // on a 12 GB card.
    //
    // vae + t5xxl ARE the 2.1 files (byte-identical url/sha/size, confirmed
    // against THIS repo's own VAE/Wan2.1_VAE.safetensors — its sha256 matches
    // the already-pinned wan_2.1_vae.safetensors exactly) — a Wan owner
    // downloads only the two diffusion files: 12,424 MiB of 18,431.
    id: 'wan22-t2v-a14b', name: 'Wan 2.2 T2V A14B (text → video, quality tier)', family: 'wan',
    width: 832, height: 480, frames: 33, steps: 10, cfgScale: 3.5, samplingMethod: 'euler',
    highNoiseSteps: 8, highNoiseCfgScale: 3.5, highNoiseSamplingMethod: 'euler',
    flowShift: 3, i2v: false,
    // Same two-expert pair, same quant floor, same card as the I2V A14B row.
    minVramGb: 12,
    negativePrompt: WAN_DEFAULT_NEGATIVE,
    licenseName: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    notes: 'Text→video, the 14B-class quality tier (Apache-2.0). Same two-expert design as the I2V A14B row — a high-noise pass then a low-noise one — so both diffusion files are required: ~18 GB across 4 files, of which ~12.1 GB is new if you already have a Wan model (the VAE and text encoder are shared). Expect the same class of wall-clock as the other 14B rows here — tens of minutes for a few seconds on a 12 GB card — so plan it as a render you start and come back to. A 4-step speed pack is available for this row.',
    files: [
      // LOW noise = the ordinary --diffusion-model, matching upstream's order.
      { role: 'diffusion',      url: 'https://huggingface.co/QuantStack/Wan2.2-T2V-A14B-GGUF/resolve/main/LowNoise/Wan2.2-T2V-A14B-LowNoise-Q3_K_S.gguf', sha256: '1d97051aca3397f2188e2d51065eca06e15076046c2c013edc7f8c3525c9a60e', sizeMb: 6212 },
      { role: 'diffusion_high', url: 'https://huggingface.co/QuantStack/Wan2.2-T2V-A14B-GGUF/resolve/main/HighNoise/Wan2.2-T2V-A14B-HighNoise-Q3_K_S.gguf', sha256: 'f10a599aeec84a8633b75cfaf116c868e427b2b5e727151c9fc8d07e22f8fcca', sizeMb: 6212 },
      // BYTE-IDENTICAL to the 2.1 rows' + the I2V A14B row's vae + t5xxl.
      { role: 'vae',            url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors', sha256: '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b', sizeMb: 243 },
      { role: 't5xxl',          url: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q8_0.gguf', sha256: '2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc', sizeMb: 5764 },
    ],
  },
  {
    // ★ THE FIRST NON-WAN VIDEO ROW, and the row this registry grew a licence
    // field for. It landed in SD_BLOCKED_MODELS at b56c3d7 with five stated
    // blockers; four of them were real work that is now done, and the fifth was
    // a misreading the owner corrected.
    //
    // ── THE LICENCE, AND WHY THIS ROW MAY SHIP ───────────────────────────────
    //
    // The old refusal reasoned that the LTX-2 agreement's "provide a copy of
    // this Agreement" and the Gemma Terms' Notice-file requirement bound US.
    // They bind a DISTRIBUTOR. This app re-hosts nothing: it fetches, over
    // https, from Lightricks' and unsloth's own HuggingFace repos onto the
    // user's disk — those repos are the distributor, and unsloth/LTX-2.3-GGUF
    // literally ships a LICENSE file in the same tree as the weights.
    //
    // What is genuinely ours is telling the user what they are accepting, which
    // is what `licenseName` / `licenseUrl` + the notes below now do. Read off
    // the HF model API on 2026-07-31 and unchanged since the previous lane:
    // Lightricks/LTX-2.3 and unsloth/LTX-2.3-GGUF both declare
    //   license: other · license_name: ltx-2-community-license-agreement
    //   license_link: github.com/Lightricks/LTX-2/blob/main/LICENSE · gated: false
    // §3 grants reproduction and distribution; §5 leaves output ownership with
    // the user; commercial use is granted BELOW a $10,000,000 annual-revenue
    // threshold (affiliates aggregated), above which a paid licence is
    // required — and THAT is the one term that can actually disqualify a user,
    // so it is in the notes verbatim rather than behind the link. The Gemma-3
    // encoder is under Google's Gemma Terms, likewise redistributable and
    // likewise named. Attachment A's "directly competes with Licensor's
    // commercial products" clause governs USE and belongs to whoever renders,
    // which is another reason the link has to be in front of them.
    //
    // ── THE RECIPE IS LIGHTRICKS', NOT UPSTREAM'S ────────────────────────────
    //
    // Every worked command in sd.cpp's docs/ltx2.md at our pin runs the DEV
    // checkpoint at `--cfg-scale 6.0`. This row is the DISTILLED one, and its
    // numbers come from the model card's own checkpoint table:
    //   "ltx-2.3-22b-distilled | The distilled version of the full model,
    //    8 steps, CFG=1"
    // Copying dev's 6.0 onto distilled weights would pay for an unconditional
    // pass they were distilled not to need — double the wall-clock for output
    // that is off what they were trained on, i.e. the scheduler trap in another
    // costume. CFG 1 also means sd.cpp encodes no unconditional branch at all,
    // so the composer drops the guidance slider and says the negative prompt
    // does nothing here — automatically, off `row.cfgScale <= 1`. That is why
    // this row declares no negativePrompt: Wan's official string is live at
    // cfg 6 and would be a lie at cfg 1.
    //
    // ── THE TWO LAWS, EACH CONFIRMED FROM BOTH ENDS ──────────────────────────
    //
    // The model card's "General tips": "Width & height settings must be
    // divisible by 32. Frame count must be divisible by 8 + 1." The pinned
    // engine agrees independently — vae.hpp's get_scale_factor() returns 32 for
    // VERSION_LTXAV, and video_frames_to_latent_frames computes
    // ((frames - 1) / 8) + 1 for LTXAV where Wan gets /4.
    //
    //  • pixelGrid 32 ⇒ the 720p pair is 1280x704, NOT 1280x720 — even though
    //    upstream's own commands pass -H 720. They get away with it because the
    //    engine floors (integer division, then decode at 22x32), so 720 renders
    //    704 and says nothing. Declaring 720 would be promising a size the
    //    engine refuses to make. Identical trap, identical answer, as TI2V-5B.
    //  • frameGrid 8 ⇒ 45 frames, a legal count on every Wan row, decodes to 41
    //    here. That number could not be data before this lane: both surfaces
    //    held Wan's 4n+1 as a constant.
    //
    // 49 FRAMES because it is 8x6+1 and ~2 s at 24 fps — the same ~2 s every
    // other row defaults to — and because it ROUND-TRIPS through the composer's
    // integer seconds slider (49/24 → 2 s → 49). Upstream's own 33 does not
    // (33/24 → 1 s → 25), which would make the row's declared length one no
    // render ever produces.
    //
    // fps 24 from two sources: docs/ltx2.md's T2V command passes `--fps 24`,
    // and common.cpp declares `--fps  fps (default: 24)`. It is not merely
    // muxing here — build_ltxv_video_positions divides frame indices BY fps to
    // build the DiT's temporal positions, so on this architecture the rate is
    // conditioning.
    //
    // ── WHAT THIS ROW DOES NOT CLAIM ─────────────────────────────────────────
    //
    // t2v + i2v only. FLF2V is real at our pin (docs/ltx2.md ships a worked
    // `--init-img` + `--end-img` command with an output video) but no video
    // input we have carries an end frame, so it is not wired and must not be
    // read as offered. AUDIO INPUT (A2V / lipsync) stays UNVERIFIED — the
    // audio VAE below is what lets a clip come out WITH sound, and nothing at
    // our pin shows an audio-input flag. Neither is in the notes.
    //
    // ── AND THE MACHINE BAR, STATED BECAUSE IT CANNOT BE ENFORCED ────────────
    //
    // ~20.6 GB of weights live in system RAM behind `--offload-to-cpu`
    // (LOWVRAM-META-RESEARCH-2026-07-28): >= 32 GB of RAM plus a large pagefile.
    // computeLocalFitBadge returns null for every sd.cpp row by construction, so
    // a sentence is all there is — but a sentence in front of a 20.8 GB button
    // is worth more than silence, and the price is on the button either way.
    // NO BORROWED WALL-CLOCK: the only timing anyone has is a third-party
    // ComfyUI figure, and the house rule is our own number or none.
    id: 'ltx-2-3-22b-distilled', name: 'LTX-2.3 22B distilled (text or image → video)', family: 'ltx2',
    width: 1280, height: 704, frames: 49, steps: 8, cfgScale: 1, samplingMethod: 'euler',
    fps: 24, pixelGrid: 32, frameGrid: 8, i2v: true,
    // THE BINDING CONSTRAINT IS RAM, and the row already said so in prose: "the
    // weights are held in system RAM, so plan on 32 GB of RAM or more … 8 GB of
    // VRAM is not the binding constraint here, memory is." Both numbers travel, so
    // a card-sized verdict cannot be the only thing a reader sees.
    minVramGb: 8,
    minRamGb: 32,
    licenseName: 'LTX-2 Community License',
    licenseUrl:  'https://github.com/Lightricks/LTX-2/blob/main/LICENSE',
    notes: 'A 22B audio-video model that does BOTH text→video and image→video at 1280x704, distilled to 8 steps. The biggest thing we offer by a wide margin: ~20.8 GB across 5 files, none of them shared with any other model here. Guidance is fixed at 1, so a negative prompt does nothing on this checkpoint. LICENCE: this one is not Apache — the weights are under the LTX-2 Community License (link above) and the text encoder under Google\'s Gemma Terms, and downloading them from Lightricks\' and unsloth\'s repos means accepting those terms. Commercial use is granted only below $10 million in annual revenue; above that Lightricks require a paid licence. MACHINE: the weights are held in system RAM, so plan on 32 GB of RAM or more plus a large pagefile — 8 GB of VRAM is not the binding constraint here, memory is. We have not timed this model on our own hardware yet: expect tens of minutes for a couple of seconds of video, and treat your first render as the measurement.',
    files: [
      // unsloth/LTX-2.3-GGUF — the GGUF source upstream's own docs/ltx2.md
      // points at, ungated, re-declaring the same
      // ltx-2-community-license-agreement as the Lightricks base repo. NOT
      // Comfy-Org/ltx-2, which declares no licence at all (the Kijai rule).
      //
      // THE DISTILLED TRIO IS PAIRED BY NAME, and that is not cosmetic: the
      // repo's dev and distilled VAE / connector files are BYTE-IDENTICAL IN
      // SIZE and differ only in sha256, so no size check could catch a
      // mismatched pair. `distilled-1.1` is a different aesthetic with its own
      // companions and is deliberately not what these are.
      { role: 'diffusion',             url: 'https://huggingface.co/unsloth/LTX-2.3-GGUF/resolve/main/distilled/ltx-2.3-22b-distilled-Q3_K_M.gguf', sha256: '388614a12f3d38c8bb08e42e92e5c73cb8cc1a1e5368b4cf02687ffa42c75269', sizeMb: 10272 },
      { role: 'vae',                   url: 'https://huggingface.co/unsloth/LTX-2.3-GGUF/resolve/main/vae/ltx-2.3-22b-distilled_video_vae.safetensors', sha256: 'e68d6d8f8a42942ac9b862cc315beb3bc30805a8876c7ad63ba5bf7a2b8e168a', sizeMb: 1385 },
      // `--audio-vae`: LTX-2.3 generates video and audio jointly, and this is
      // the decoder for the audio half. It is an OUTPUT path — it does not make
      // the model accept audio IN.
      { role: 'audio_vae',             url: 'https://huggingface.co/unsloth/LTX-2.3-GGUF/resolve/main/vae/ltx-2.3-22b-distilled_audio_vae.safetensors', sha256: '3cd6a6eb8cb28f5ecc12f1f3126952b2a3d2b0b42ad3270e63cefafafe0d9b57', sizeMb: 348 },
      { role: 'embeddings_connectors', url: 'https://huggingface.co/unsloth/LTX-2.3-GGUF/resolve/main/text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors', sha256: 'c61cbb396e2a8175d8b2da51f0fdac885a4ccd22c9f64dafa5aa2c455dc8a507', sizeMb: 2206 },
      // The text encoder is a 12B LLM under Google's Gemma Terms — `--llm`, the
      // same role Z-Image's Qwen3 encoder uses, not `--t5xxl`. google/* re-hosts
      // are GATED (401 anonymously, so a Download button on them could only
      // fail); unsloth's declares `license: gemma` and is not, which is why
      // upstream points there too. The filename is the one in their command.
      { role: 'llm',                   url: 'https://huggingface.co/unsloth/gemma-3-12b-it-qat-GGUF/resolve/main/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf', sha256: 'da98f81c86916ed1c76b3eeda56b25cb7b8352b01093e2edb8028110fe2cb53b', sizeMb: 7088 },
    ],
  },
]

// ═════════════════════════════════════════════════════════════════════════════
// CURATED SPEED ADAPTERS — the 4-step distill LoRAs (THE SPEED PATH)
// ═════════════════════════════════════════════════════════════════════════════
//
// The owner's complaint, verbatim in the i2v row's own notes above: "~44 min on
// a 12 GB card" for 33 frames. This is the lever that answers it, and it is
// arithmetic rather than optimism (VIDEO-MODELS-RESEARCH §2, levers 1+2):
//
//   20 steps x 2 forward passes (cond + uncond at cfg 6)  = 40 passes
//    4 steps x 1 forward pass  (cfg 1 skips the uncond)   =  4 passes
//
// sd.cpp's resolve_guidance only encodes the unconditional branch when guidance
// != 1, and its own source logs "use cfg-scale=1 for distilled models". So the
// two levers MULTIPLY: a ~10x cut in forward passes, not 5x.
//
// ── WHY THIS IS A NEW REGISTRY AND NOT AN SdAdapter ──────────────────────────
//
// SdAdapter (below) is USER-INSTALLED by construction — "Never curated: every
// one of these arrives from a user-initiated install" — and its `family` field
// is an SdModelFamily, whose union is sd15 | sdxl | flux | zimage. There is no
// `wan` member and there must not be: that union keys FAMILY_DEFAULTS (a
// baseSize / steps / cfg table that is an IMAGE concept) and isAdapterCompatible
// (an equality gate the composer's LoRA picker runs). A Wan LoRA cannot be
// spelled in that shape at all, which is why this pass adds rows next to it
// rather than widening it.
//
// What IS shared is everything that matters: these land in the SAME `loras`
// directory the user adapters use, so ONE `--lora-model-dir` resolves both, and
// they are named in the prompt by the same `<lora:slug:weight>` syntax.
//
// ── THE LICENCE LAW, APPLIED ─────────────────────────────────────────────────
//
// Curated means WE fetch it, so only a repo that DECLARES a redistributable
// licence may appear here. Every `license` below was read off the HF model API
// (`cardData.license` + the `license:` tag) on 2026-07-31, and every sha256 is
// that repo's LFS oid from the tree API at the same moment.
//
// Kijai/WanVideo_comfy — where the famous Self-Forcing / CausVid 1.3B
// extractions live — DECLARES NO LICENCE. It is never curated, in either
// direction; a user may install those weights themselves.

/**
 * One file of a speed adapter.
 *
 * `role: 'model'` mirrors userSdAdapterFromCivitaiRow: an adapter's role is not
 * a component slot (adapterFilePath passes 'model' as the extension fallback),
 * it is a single file that lands under `<slug><ext>`.
 */
export interface SdSpeedAdapterFile extends SdModelFile {
  /**
   * THE ON-DISK STEM AND THE PROMPT TOKEN. `<lora:slug:weight>` names the FILE
   * STEM in the lora directory, so this is load-bearing twice over. Hand-written
   * rather than hash-derived (adapterSlug's job for untrusted upstream names)
   * because a curated row can afford a name a human can read in their own
   * prompt — and `[a-z0-9-]` is still enforced by test.
   */
  slug:       string
  /** The strength the tag carries. */
  weight:     number
  /** True ⇒ `<lora:|high_noise|slug:w>` — the A14B high-noise expert's tag. */
  highNoise?: boolean
}

/**
 * The ATOMIC recipe a distill needs. Every field travels together or none do:
 * 4 steps WITHOUT the LoRA is noise, and the LoRA without `--scheduler simple`
 * lands on timesteps it was never trained on and gets blamed for looking bad
 * (VIDEO-MODELS-RESEARCH §2, "THE SCHEDULER TRAP"). buildSdVideoArgs applies it
 * as one unit and a test pins the whole argv.
 */
export interface SdSpeedPreset {
  steps:          number
  cfgScale:       number
  samplingMethod: string
  scheduler:      string
  flowShift:      number
  highNoiseSteps?:          number
  highNoiseCfgScale?:       number
  highNoiseSamplingMethod?: string
}

export interface SdSpeedAdapter {
  /** `[a-z0-9-]`, same law as every other id here. */
  id:      string
  name:    string
  /** The curated video row these weights belong to. One row, one speed pack. */
  modelId: string
  /** The SOURCE REPO's OWN declared licence (HF `cardData.license`). */
  license: string
  /** That repo, so the declaration above can be re-checked in one click. */
  source:  string
  preset:  SdSpeedPreset
  files:   SdSpeedAdapterFile[]
  notes:   string
}

// ── THE SCHEDULE, DERIVED RATHER THAN QUOTED ─────────────────────────────────
//
// lightx2v publish the schedule their 4-step distills were trained on, as
// timesteps: `denoising_step_list` = [1000, 750, 500, 250] (their own README,
// "Inference Configuration"). Reproducing it on sd-cli is two flags, and the
// SECOND one is not what the committed research said.
//
// Read off src/runtime/denoiser.hpp at OUR PIN (master-782-b290693):
//
//   SimpleScheduler::get_sigmas(n)   picks timestep indices
//                                    999, 749, 499, 249 for n = 4
//   DiscreteFlowDenoiser::t_to_sigma(t) = time_snr_shift(shift, (t + 1)/1000)
//   time_snr_shift(a, t)             = a == 1 ? t : a*t / (1 + (a - 1)*t)
//   DiscreteFlowDenoiser::sigma_to_t(sigma) = sigma * 1000   ← what the MODEL
//                                                              is conditioned on
//
// So the timesteps the model actually sees are:
//   flow-shift 1 → sigmas 1.0000, 0.7500, 0.5000, 0.2500 → t 1000, 750, 500, 250
//   flow-shift 5 → sigmas 1.0000, 0.9375, 0.8333, 0.6250 → t 1000, 937, 833, 625
//
// **flow-shift 1 is the one that reproduces the published ladder bit for bit.**
// VIDEO-MODELS-RESEARCH §2 says "`--scheduler simple --steps 4 --flow-shift 5`
// reproduces the official schedule" — the scheduler half is right and the shift
// half is wrong, and getting only the first half right is the scheduler trap in
// a second costume: three of the four timesteps land off-distribution and the
// LoRA takes the blame. The correction is confirmed independently by lightx2v's
// OWN ComfyUI workflow, which ships in this very repo
// (wan2.2_i2v_scale_fp8_comfyui_with_lora.json): its sampler nodes carry
// shift = 1.0, cfg = 1.0, and LoRA strength 1.0 on BOTH experts.
// test/unit/sdSpeedDistill.test.ts mirrors the two upstream functions and pins
// the ladder, so "fixing" this back to 5 fails there with the numbers shown.
export const SPEED_SCHEDULER  = 'simple'
export const SPEED_FLOW_SHIFT = 1
/** lightx2v's published `denoising_step_list` — the target of the two above. */
export const LIGHTX2V_4STEP_TIMESTEPS: readonly number[] = [1000, 750, 500, 250]

// The Wan 2.1 i2v distill LoRA and the Wan 2.2 A14B LOW-NOISE distill LoRA are
// THE SAME 739,472,104 BYTES (sha256 8833bd4f…, HF LFS oid, verified against
// both repos' tree API on 2026-07-31 — lightx2v shipped one file under two
// names). Declaring one slug for both is the `sdFilesWithSha` idiom applied to
// adapters: whichever pack is installed second finds the file already on disk
// and downloads nothing. It also has to be one slug, not two: the tag names the
// FILE STEM, so two names would mean two copies of identical weights.
const LIGHTX2V_I2V_LOW_SLUG = 'lightx2v-wan-i2v-14b-4step'
const LIGHTX2V_I2V_LOW = {
  role:   'model' as const,
  url:    'https://huggingface.co/lightx2v/Wan2.1-Distill-Loras/resolve/main/wan2.1_i2v_lora_rank64_lightx2v_4step.safetensors',
  sha256: '8833bd4fd7c8eabebf0bc8ee5cfaf47f4f310ce116928a02c1adf8941dd4b0f1',
  sizeMb: 706,
  slug:   LIGHTX2V_I2V_LOW_SLUG,
  weight: 1,
}

/**
 * EVERY repo a speed-pack file may come from, with the licence THAT REPO
 * declares — read off the HF model API (`cardData.license`) on 2026-07-31.
 *
 * A per-pack `source` is not enough on its own, because one file is legitimately
 * served from a DIFFERENT lightx2v repo than the pack that references it (the
 * 2.1 i2v LoRA is the A14B pack's low-noise expert, byte for byte). This map is
 * what makes "every byte we fetch comes from a repo whose licence we checked" a
 * property a test can assert instead of a claim a comment makes.
 *
 * Kijai/WanVideo_comfy is deliberately ABSENT and must stay absent: it declares
 * no licence at all, and it is where every un-curatable Wan distill lives.
 */
export const SPEED_ADAPTER_SOURCE_LICENSES: Readonly<Record<string, string>> = {
  'https://huggingface.co/lightx2v/Wan2.2-Distill-Loras': 'apache-2.0',
  'https://huggingface.co/lightx2v/Wan2.1-Distill-Loras': 'apache-2.0',
}

export const SD_SPEED_ADAPTERS: SdSpeedAdapter[] = [
  {
    // ROW: wan22-i2v-a14b — the two-expert pair, and the only place the
    // `|high_noise|` tag syntax is used. Upstream's own docs/wan.md at our pin
    // ships the shape verbatim in its "Wan2.2 T2V 14B with Lora" command:
    //   -p "a lovely cat<lora:…_low_noise:1><lora:|high_noise|…_high_noise:1>"
    //   --steps 4 --high-noise-steps 4 --lora-model-dir …/loras
    // with an output video attached, so this is a worked example rather than an
    // inference from a workflow.
    //
    // WHERE WE DIVERGE FROM THAT COMMAND, AND WHY:
    //  • cfg 1 (upstream leaves 3.5 on both passes). These are CFG-DISTILLED
    //    weights — lightx2v's Wan 2.1 line is literally named
    //    "StepDistill-CfgDistill" — and the author's own ComfyUI workflow in
    //    this repo runs cfg 1.0. Upstream's number is the previous example's,
    //    carried over with only the step count changed. At 3.5 we would pay for
    //    an unconditional pass the weights were distilled to not need: DOUBLE
    //    the time for output that is off what they were trained on.
    //  • --scheduler simple + --flow-shift 1 (upstream passes no scheduler and
    //    flow-shift 3.0) — see the ladder derivation above.
    //  • steps 2 HIGH / 4 LOW rather than 4/4. Research addendum §B, from a
    //    workflow running exactly these weights: "low-noise expert owns facial
    //    identity, give it the steps". The same judgement the vanilla row's
    //    comment already states, at distill scale. It is also strictly faster
    //    than upstream's 4/4.
    id: 'wan22-i2v-a14b-speed', name: 'Wan 2.2 A14B — 4-step speed pack',
    modelId: 'wan22-i2v-a14b',
    license: 'apache-2.0',
    source:  'https://huggingface.co/lightx2v/Wan2.2-Distill-Loras',
    preset: {
      steps: 4, cfgScale: 1, samplingMethod: 'euler',
      scheduler: SPEED_SCHEDULER, flowShift: SPEED_FLOW_SHIFT,
      highNoiseSteps: 2, highNoiseCfgScale: 1, highNoiseSamplingMethod: 'euler',
    },
    notes: 'Turns the quality tier into something you can iterate on: 4 steps at guidance 1 instead of 10 steps at 3.5, which is ~10x fewer passes through the model (guidance 1 skips the second pass per step). 1.3 GB of LoRA weights, Apache-2.0, from the team that trained them. The trade is real: a distilled model gives up some motion range and fine detail against the same model run the slow way — it buys iteration speed, not free quality. Guidance is pinned to 1 while it is on, so the negative prompt does nothing.',
    files: [
      {
        role: 'model',
        url:  'https://huggingface.co/lightx2v/Wan2.2-Distill-Loras/resolve/main/wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors',
        sha256: '887c3bdeb74e83859c920438e16ca31f39ab18ce189abc5f0e36f8348c5bbb19',
        sizeMb: 606,
        slug: 'lightx2v-wan22-a14b-4step-high', weight: 1, highNoise: true,
      },
      // STRENGTH 1.0 ON BOTH, from the author. The research addendum records a
      // community "HIGH 1.5 / LOW 1.0"; lightx2v's own merge commands, their
      // online-loading config (`"strength": 1.0` twice) and their ComfyUI
      // workflow all say 1.0/1.0, and so does upstream's sd.cpp example. The
      // creator's number wins over a forum's.
      { ...LIGHTX2V_I2V_LOW },
    ],
  },
  {
    // ROW: wan22-t2v-a14b — the SAME repo as the i2v-a14b pack
    // (lightx2v/Wan2.2-Distill-Loras), a DIFFERENT pair of bytes.
    //
    // THE 0f7df10 REPORT NAMED THIS PAIR; this pass re-fetched the tree API
    // (2026-07-31) to pin real shas rather than trust the report's numbers:
    //   wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors
    //   wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors
    // Repo licence unchanged from the i2v pack (`cardData.license: apache-2.0`,
    // same HF model API read).
    //
    // FILE IDENTITY VS THE I2V PACK, CHECKED AND NOT SHARED: the i2v pair
    // (887c3bde…/8833bd4f…, 606/706 MiB) and this t2v pair (89003385…/4df7c206…,
    // 586/586 MiB) are four DIFFERENT sha256 values at three different sizes —
    // the "_1022" (i2v) vs "_1217" (t2v) suffixes are different training runs,
    // not a rename of the same weights. So `speedAdapterCatalogFiles`' sha
    // comparison naturally returns an EMPTY `sharedWith` for every file here;
    // there is no shared-bytes story to pin, and asserting one would be false.
    //
    // THE PRESET MIRRORS wan22-i2v-a14b-speed'S, NOT A FRESH DERIVATION, and
    // that is a stated limit rather than an oversight: this repo ships NO
    // t2v-specific ComfyUI workflow or loading config (only the i2v json from
    // the sibling pack), so there is nothing t2v-specific to read the exact
    // high/low step split off. What corroborates reusing the i2v preset rather
    // than upstream's naive lora example (wan.md's "Wan2.2 T2V 14B with Lora",
    // cfg 3.5/steps 4/4, a DIFFERENT lora release — the scheduler trap in the
    // same costume the i2v row's own comment already dismisses): LightX2V's own
    // engine config for this exact task head (github.com/ModelTC/LightX2V,
    // configs/wan22/wan_moe_t2v_distill.json, fetched 2026-07-31) declares
    // `"denoising_step_list": [1000, 750, 500, 250]` — BIT-IDENTICAL to the
    // ladder SPEED_SCHEDULER/SPEED_FLOW_SHIFT already reproduce — and
    // `"enable_cfg": false`, the same cfg-disabled behaviour the i2v pack's cfg
    // 1 encodes. Same team, same "_4step" convention, same target ladder,
    // independently confirmed for THIS task head — the step-split number is
    // mirrored because no per-artifact source exists to move it, not guessed.
    id: 'wan22-t2v-a14b-speed', name: 'Wan 2.2 T2V A14B — 4-step speed pack',
    modelId: 'wan22-t2v-a14b',
    license: 'apache-2.0',
    source:  'https://huggingface.co/lightx2v/Wan2.2-Distill-Loras',
    preset: {
      steps: 4, cfgScale: 1, samplingMethod: 'euler',
      scheduler: SPEED_SCHEDULER, flowShift: SPEED_FLOW_SHIFT,
      highNoiseSteps: 2, highNoiseCfgScale: 1, highNoiseSamplingMethod: 'euler',
    },
    notes: 'Turns the text→video quality tier into something you can iterate on: 4 steps at guidance 1 instead of 10 steps at 3.5, which is ~10x fewer passes through the model (guidance 1 skips the second pass per step). 1.1 GB of LoRA weights, Apache-2.0, from the team that trained them, and NOT the same bytes as the image→video speed pack — this row downloads its own pair. The trade is real: a distilled model gives up some motion range and fine detail against the same model run the slow way — it buys iteration speed, not free quality. Guidance is pinned to 1 while it is on, so the negative prompt does nothing.',
    files: [
      {
        role: 'model',
        url:  'https://huggingface.co/lightx2v/Wan2.2-Distill-Loras/resolve/main/wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_1217.safetensors',
        sha256: '89003385f8a9d53ba58fd6ede647fdc90292e8568a54683fcfe6db5556a31769',
        sizeMb: 586,
        slug: 'lightx2v-wan22-t2v-a14b-4step-high', weight: 1, highNoise: true,
      },
      {
        role: 'model',
        url:  'https://huggingface.co/lightx2v/Wan2.2-Distill-Loras/resolve/main/wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_1217.safetensors',
        sha256: '4df7c206f3189472da2f92c0a42dcf308f04433d9c14302d08d56e99a3f51322',
        sizeMb: 586,
        slug: 'lightx2v-wan22-t2v-a14b-4step-low', weight: 1,
      },
    ],
  },
  {
    // ROW: wan21-i2v-14b-480p — one file, one tag, no high-noise pass.
    // lightx2v/Wan2.1-Distill-Loras declares apache-2.0 and lists
    // Wan-AI/Wan2.1-I2V-14B-480P among its base models. The dedicated
    // Wan2.1-I2V-14B-480P-StepDistill-CfgDistill-Lightx2v repo (also
    // apache-2.0) ships the SAME BYTES under loras/ — verified sha-identical —
    // so either URL is the same file; the LoRA-only repo is the smaller ask.
    //
    // The repo NAME is the citation for cfg 1: Step distill AND Cfg distill.
    id: 'wan21-i2v-14b-480p-speed', name: 'Wan 2.1 I2V 14B — 4-step speed pack',
    modelId: 'wan21-i2v-14b-480p',
    license: 'apache-2.0',
    source:  'https://huggingface.co/lightx2v/Wan2.1-Distill-Loras',
    preset: {
      steps: 4, cfgScale: 1, samplingMethod: 'euler',
      scheduler: SPEED_SCHEDULER, flowShift: SPEED_FLOW_SHIFT,
    },
    notes: 'The answer to "44 minutes for two seconds": 4 steps at guidance 1 instead of 20 at 6, which is ~10x fewer passes through the model (guidance 1 skips the second pass per step). One 706 MB LoRA, Apache-2.0, from the team that trained it. The trade is real: a distilled model gives up some motion range and fine detail against the same model run the slow way — it buys iteration speed, not free quality. Guidance is pinned to 1 while it is on, so the negative prompt does nothing.',
    files: [{ ...LIGHTX2V_I2V_LOW }],
  },
]

/**
 * A row for which a speed pack was LOOKED FOR and honestly not found.
 *
 * Same premise as SD_BLOCKED_MODELS: the search is the expensive part, and a
 * verdict of "none exists that we may ship" is a research result worth keeping
 * next to the two that do — otherwise the next lane re-runs the same HF sweep
 * and the UI has nothing truthful to say about the fastest model we ship.
 */
export interface SdBlockedSpeedAdapter {
  modelId: string
  /** WHY there is no speed pack for this row, for the user AND for the next lane. */
  blocked: string
}

export const SD_BLOCKED_SPEED_ADAPTERS: SdBlockedSpeedAdapter[] = [
  {
    // Swept on 2026-07-31 via the HF model API: author=lightx2v (all 35 repos),
    // plus searches for "Wan 1.3B distill lora" / "Self-Forcing" / "StepDistill".
    //  • lightx2v publish NO 1.3B step-distill LoRA. Their one 1.3B distill repo
    //    (Wan2.1-T2V-1.3B-Distill-Models) declares NO licence and holds a single
    //    `model_iter6000.pt` — a pickle checkpoint, not a LoRA, and a container
    //    isRefusedWeightFormat rejects on sight.
    //  • The ORIGINAL Self-Forcing repo (gdhe17/Self-Forcing) IS apache-2.0, but
    //    ships `.pt` full checkpoints only. The safetensors LoRA extraction
    //    everyone actually uses lives in Kijai/WanVideo_comfy, which declares no
    //    licence at all.
    //  • The GGUF re-hosts (Nichonauta, lym00) are cc-by-nc-sa-4.0 —
    //    NON-COMMERCIAL, so not something this app may fetch for a user.
    //  • lightx2v/Wan2.1-T2V-1.3B-longcat-step1500 IS mit and IS a 1.3B LoRA —
    //    and it is NOT a speed adapter: it is a GRPO aesthetic fine-tune (rank
    //    128, four reward models) that changes nothing about the step count.
    //    Curating it here would be the honesty failure this list prevents.
    modelId: 'wan21-t2v-1.3b',
    blocked: 'No 4-step distill LoRA exists for the 1.3B that we may redistribute. LightX2V never trained one (their distills are the 14B-class models), and the Self-Forcing / CausVid extractions everyone uses are hosted in a repo that declares no licence at all, so this app will not fetch them for you — you can still install them yourself and select them in the LoRA picker. The GGUF re-hosts of the same weights are non-commercial licensed, which is not something we can hand out either.',
  },
  {
    // TI2V-5B: a distilled 5B DOES exist and is genuinely good on 4 GB cards —
    // and its provenance fails the licence law by one link.
    // hum-ma/Wan2.2-TI2V-5B-Turbo-GGUF declares apache-2.0 and ships
    // `Wan22_TI2V_5B_Turbo_lora_rank_64_fp16.safetensors` (332 MB) — but its own
    // README says the source was converted from Kijai/WanVideo_comfy's
    // Wan22-Turbo file, and its declared base model (quanhaol/Wan2.2-TI2V-5B-Turbo)
    // declares NO licence. An apache-2.0 tag added by a re-host, over an upstream
    // that never granted one, is a claim the re-host was not in a position to
    // make. Same rule as the Kijai case, one hop further away.
    modelId: 'wan22-ti2v-5b',
    blocked: 'The distilled 4-step TI2V-5B weights exist, but their licence does not survive the chain: the re-host that declares Apache-2.0 states in its own README that it converted the file from a repository which declares no licence at all, and the checkpoint it names as its base declares none either. A licence added downstream of a source that never granted one is not a licence, so this app will not fetch it for you.',
  },
  {
    // THE ONLY ENTRY HERE THAT IS NOT A LICENCE VERDICT, and it is the honest
    // shape of "no": there is nothing to add. Lightricks DO publish
    // `ltx-2.3-22b-distilled-lora-384` — but their own model card says what it
    // is, in one line: "A LoRA version of the distilled model applicable to the
    // full model". It exists to turn the DEV checkpoint into the distilled one.
    // Our row IS the distilled checkpoint: the distillation is already in the
    // weights, at 8 steps and CFG 1, which is the same place a speed pack would
    // be trying to get to. Shipping it would be 384 MB that changes nothing.
    //
    // The real speed lever on this row is the one the notes already name — it
    // is a memory-bound 22B model, so RAM and quantisation move it, not steps.
    modelId: 'ltx-2-3-22b-distilled',
    blocked: 'This row is already the distilled checkpoint — 8 steps at guidance 1, which is where a 4-step speed pack would be trying to get it. Lightricks do publish a distill LoRA for LTX-2.3, but their own model card says it is for applying to the FULL (dev) model, so on these weights it would be several hundred MB that changes nothing. The thing that actually decides how long this model takes is memory: it is 22B held in system RAM, so the levers are RAM and the quantisation, not the step count.',
  },
]

/** One speed adapter by id. */
export function findSpeedAdapter(id: string): SdSpeedAdapter | undefined {
  return SD_SPEED_ADAPTERS.find(a => a.id === id)
}

/** The speed pack for a model row, or undefined. At most one per row. */
export function speedAdapterForModel(modelId: string): SdSpeedAdapter | undefined {
  return SD_SPEED_ADAPTERS.find(a => a.modelId === modelId)
}

/** Why a row has NO speed pack, when we looked and said no. */
export function blockedSpeedAdapterFor(modelId: string): SdBlockedSpeedAdapter | undefined {
  return SD_BLOCKED_SPEED_ADAPTERS.find(a => a.modelId === modelId)
}

/**
 * The `<lora:…>` selections one speed pack contributes, in the order upstream's
 * own command writes them (low-noise first, then the high-noise tag).
 *
 * Pure and registry-owned so the composer, the arg builder and the provenance
 * chunk cannot each build a different tag list.
 */
export function speedLoraSelections(a: SdSpeedAdapter): Array<{ slug: string; weight: number; highNoise?: boolean }> {
  return [...a.files]
    .sort((x, y) => Number(x.highNoise ?? false) - Number(y.highNoise ?? false))
    .map(f => ({ slug: f.slug, weight: f.weight, ...(f.highNoise ? { highNoise: true as const } : {}) }))
}

/**
 * A speed pack's files as the CATALOG hands them over: which OTHER packs
 * declare the exact same bytes, so the download panel can quote the INCREMENTAL
 * price instead of the full one (the sdCatalogFiles idiom — a user who took the
 * 2.1 pack pays 606 MB, not 1,312, for the A14B one).
 */
export function speedAdapterCatalogFiles(a: SdSpeedAdapter): Array<{ slug: string; sizeMb: number; sharedWith: string[] }> {
  return a.files.map(f => ({
    slug:   f.slug,
    sizeMb: f.sizeMb,
    sharedWith: SD_SPEED_ADAPTERS
      .filter(o => o.id !== a.id && o.files.some(g => g.sha256.toLowerCase() === f.sha256.toLowerCase()))
      .map(o => o.id),
  }))
}

// ── THE UPSCALER: "MAKE IT BIGGER" ───────────────────────────────────────────
//
// The #1 follow-up to a finished render, and the app had no answer to it. The
// engine has had one all along: `-M upscale --upscale-model <esrgan>` is a
// documented mode at our pin (upstream's docs/esrgan.md), and it LOADS NO
// DIFFUSION MODEL — no checkpoint, no VAE, no text encoder, no prompt, no
// sampler. Verified live on the installed binary (see sdUpscale.test.ts for the
// full gate transcript): a 1024x1024 PNG became 4096x4096 in 26 s off 192
// tensors and a 416 MB compute buffer, with no `-m` on the command line at all.
//
// ── WHY ITS OWN REGISTRY, AND NOT A ROLE ON A MODEL ROW ──────────────────────
//
// An upscaler is MODEL-INDEPENDENT: it runs on pixels, so it belongs to no
// checkpoint. The two shapes it could have taken both misfile it:
//
//  • A new SdFileRole + a component on each model row would duplicate 64 MB per
//    checkpoint and imply the file is part of a pipeline it has no place in.
//    (The `tae` role is not a counter-example: a TAE decoder really IS a
//    component of one model's VAE stage.)
//  • A pseudo-row in SD_IMAGE_MODELS would put it in the COMPOSER'S MODEL
//    PICKER, because that list is what the picker iterates — offering "generate
//    an image with RealESRGAN" as a choice, which is the stale-model lie in a
//    new costume. It also has no honest value for `family`, `baseSize`,
//    `steps`, `cfgScale` or `samplingMethod`, all of which are required there.
//
// So this follows SD_SPEED_ADAPTERS exactly, for the same reason that registry
// exists: a curated asset that is neither a checkpoint nor a user adapter gets
// its own list, and `role: 'model'` means "a single file that lands under
// `<slug><ext>`" rather than a component slot (see SdSpeedAdapterFile).
//
// ── THE CONTAINER IS NOT AN ACCIDENT ─────────────────────────────────────────
//
// The canonical asset is xinntao's `RealESRGAN_x4plus.pth`, and this row does
// NOT point at it. `fileExtFor` returns null for `.pth` — "this component must
// never be written to disk", because a pickle can execute arbitrary code on
// load — and that refusal is deliberate, applied at two layers, and not a
// lane's to flip. Comfy-Org publish the same weights as safetensors under a
// DECLARED licence, and the gate proved the repackage is faithful: the .pth and
// the safetensors produced BYTE-IDENTICAL output PNGs. Same pixels, allowed
// container, nothing re-hosted by us.
//
// Comfy-Org is also already a pinned source in this file (the Wan 2.1 VAE and
// clip_vision components), so this is a repo whose licence declaration the
// registry has read before.

/** One file of an upscaler. Same "single file, one slug" shape as a speed pack. */
export interface SdUpscalerFile extends SdModelFile {
  /** THE ON-DISK STEM. `--upscale-model` takes a FILE, so unlike a LoRA this
   *  name is never typed by a user — but it is still hand-written and still
   *  `[a-z0-9-]`, so the file is identifiable in the folder. */
  slug: string
}

export interface SdUpscaler extends SdLicensedRow {
  /** `[a-z0-9-]`, same law as every other id here. */
  id:    string
  name:  string
  /**
   * The factor these weights were TRAINED at, and therefore the only factor
   * they produce. It is not a knob: RealESRGAN x4plus outputs 4x whatever it is
   * given, which the gate measured (1024 -> 4096). Carried as data because the
   * output file name and the provenance line both quote it, and a hardcoded 4
   * in either place would silently lie the day an x2 row is added.
   */
  scale: 2 | 4
  /** The SOURCE REPO's OWN declared licence (HF `cardData.license`). */
  license: string
  /** That repo, so the declaration above can be re-checked in one click. */
  source:  string
  files:   SdUpscalerFile[]
  notes:   string
}

/** The row the UPSCALE button uses when nothing else is chosen. */
export const DEFAULT_UPSCALER_ID = 'realesrgan-x4plus'

export const SD_UPSCALERS: SdUpscaler[] = [
  {
    id:    DEFAULT_UPSCALER_ID,
    name:  'Real-ESRGAN x4+',
    scale: 4,
    // BSD-3-Clause, read off Comfy-Org/Real-ESRGAN_repackaged's HF model API
    // (`cardData.license` = "bsd-3-clause", tag `license:bsd-3-clause`) on
    // 2026-07-31 — the same method every curated row's licence was read with.
    // It is also the licence of xinntao/Real-ESRGAN itself, which is what these
    // weights are, so the two agree.
    license:     'bsd-3-clause',
    source:      'https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged',
    licenseName: 'BSD-3-Clause',
    licenseUrl:  'https://opensource.org/license/bsd-3-clause',
    notes: 'Makes a finished image 4x bigger — 1024 becomes 4096 — without regenerating it. Runs on the picture alone: no checkpoint is loaded, so it works whatever made the image, and it needs no prompt. Measured ~26 s for one 1024x1024 image on a CUDA card.',
    files: [
      // MEASURED 2026-07-31: HTTP 200, Content-Length 66_857_836 (-> 64 MiB),
      // and the downloaded file's own sha256 equalled the tree API's LFS oid.
      {
        role:   'model',
        slug:   'realesrgan-x4plus',
        url:    'https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged/resolve/main/RealESRGAN_x4plus.safetensors',
        sha256: '37f9a931c215f040aa6d50f711f2cb115f713c46df1d0d6469a8bd7bfe9a60bb',
        sizeMb: 64,
      },
    ],
  },
]

/** One upscaler by id. */
export function findUpscaler(id: string): SdUpscaler | undefined {
  return SD_UPSCALERS.find(u => u.id === id)
}

/**
 * An upscaler's files as the CATALOG hands them over — the same shape (and the
 * same `sharedWith` cross-check) as speedAdapterCatalogFiles, so the download
 * panel prices this row with the code it already has. Nothing is shared today;
 * the field exists so an x2 row that reuses no bytes still says so honestly.
 */
export function upscalerCatalogFiles(u: SdUpscaler): Array<{ slug: string; sizeMb: number; sharedWith: string[] }> {
  return u.files.map(f => ({
    slug:   f.slug,
    sizeMb: f.sizeMb,
    sharedWith: SD_UPSCALERS
      .filter(o => o.id !== u.id && o.files.some(g => g.sha256.toLowerCase() === f.sha256.toLowerCase()))
      .map(o => o.id),
  }))
}

// ── IP-ADAPTER: A PICTURE AS PART OF THE PROMPT ──────────────────────────────
//
// The engine gained `--ip-adapter`, `--ip-adapter-image` and
// `--ip-adapter-strength` at the pin this app moved to, and they sat unwired: the
// bump's own note said so. What they do is the thing people mean when they say
// "make something in THIS style" — the reference picture is encoded by a
// CLIP-Vision tower and injected as extra tokens through a decoupled
// cross-attention on every attn2 layer, so it steers subject and appearance
// alongside the text, rather than being a starting canvas the way img2img is.
//
// THAT DISTINCTION IS THE WHOLE REASON THIS IS NOT `strength` ON AN INIT IMAGE.
// img2img starts from the reference's PIXELS and walks away from them; this
// never renders those pixels at all. A user who wants "this character, new pose"
// gets nothing from img2img and everything from here.
//
// SOURCE-ASSERTED from upstream's docs/ip_adapter.md at our pin, which is also
// where the numbers come from: SD 1.5 and SDXL only, ViT-H/14 encoder passed
// with `--clip_vision`, and "0.6 to 0.8 is a good starting range" for strength.
//
// ── WHY IT IS ITS OWN LIST, AGAIN ────────────────────────────────────────────
//
// Same three reasons SD_UPSCALERS is (see above): it is not a checkpoint, so a
// pseudo-row would put "generate an image with IP-Adapter" in the composer's
// model picker; it is not a user adapter, so it does not belong in the registry
// that Civitai writes; and `--ip-adapter` takes a FILE PATH, so it has no reason
// to sit in a directory the engine scans.
//
// ── THE 1.2 GB THAT IS ALREADY HERE ──────────────────────────────────────────
//
// Both rows need `clip_vision_h.safetensors`, and the app ALREADY pins that
// exact file — same URL, same sha256, same 1206 MiB — as the Wan 2.1 i2v row's
// `clip_vision` component. Declaring it here with that sha is what lets
// findReusableComponent hard-link the copy that is already on disk instead of
// pulling it again. A Wan i2v owner therefore pays 43 MiB for the SD 1.5 row,
// not 1,249.

/** One file of an IP-Adapter row. The upscaler's "single file, one slug" shape. */
export interface SdIpAdapterFile extends SdModelFile {
  /** THE ON-DISK STEM. `--ip-adapter` / `--clip_vision` take FILES, so this is
   *  never typed by a user — but it is hand-written and `[a-z0-9-]`, so the file
   *  is identifiable in the folder. */
  slug: string
}

export interface SdIpAdapter extends SdLicensedRow {
  /** `[a-z0-9-]`, same law as every other id here. */
  id:   string
  name: string
  /**
   * The checkpoint family these weights were TRAINED against.
   *
   * Not cosmetic and not a preference: an SD 1.5 IP-Adapter on an SDXL UNet is a
   * tensor-shape mismatch, the same class the LoRA compat gate exists for. This
   * is what that gate reads, so an incompatible row is never offered rather than
   * being offered and failing at spawn.
   */
  family:  Extract<SdModelFamily, 'sd15' | 'sdxl'>
  license: string
  source:  string
  /** roles: `model` (the adapter weights) + `clip_vision` (the ViT-H encoder). */
  files:   SdIpAdapterFile[]
  notes:   string
}

/**
 * The CLIP-Vision encoder BOTH rows use, and the Wan 2.1 i2v row already pins.
 *
 * MEASURED: url / sha256 / sizeMb are copied from that component verbatim, which
 * is the point — a different-but-equivalent mirror would defeat the reuse and
 * cost a 1.2 GB download to land the same bytes twice.
 */
const IP_ADAPTER_CLIP_VISION: SdIpAdapterFile = {
  role:   'clip_vision',
  slug:   'clip-vision-h',
  url:    'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors',
  sha256: '64a7ef761bfccbadbaa3da77366aac4185a6c58fa5de5f589b42a65bcc21f161',
  sizeMb: 1206,
}

export const SD_IP_ADAPTERS: SdIpAdapter[] = [
  {
    id:     'ip-adapter-sd15',
    name:   'Reference image for SD 1.5 models',
    family: 'sd15',
    // apache-2.0, read off h94/IP-Adapter's HF model API (`cardData.license`)
    // on 2026-08-05 — the same method every curated row's licence was read with.
    license:     'apache-2.0',
    source:      'https://huggingface.co/h94/IP-Adapter',
    licenseName: 'Apache-2.0',
    licenseUrl:  'https://www.apache.org/licenses/LICENSE-2.0',
    notes: 'Lets you attach a picture and have its subject and style carried into what you generate, alongside your words. Different from a starting image: the reference is never redrawn, so "this character, new pose" works. Strength 0.6-0.8 is the range upstream recommends. Works with SD 1.5 checkpoints.',
    files: [
      // MEASURED 2026-08-05 from the HF tree API: size 44,642,768 bytes
      // (-> 42.6 MiB, declared 43 so the disk preflight never under-books) and
      // the LFS oid below IS the sha256 the download verifies against.
      {
        role:   'model',
        slug:   'ip-adapter-sd15',
        url:    'https://huggingface.co/h94/IP-Adapter/resolve/main/models/ip-adapter_sd15.safetensors',
        sha256: '289b45f16d043d0bf542e45831f971dcdaabe18b656f11e86d9dfba7e9ee3369',
        sizeMb: 43,
      },
      IP_ADAPTER_CLIP_VISION,
    ],
  },
  {
    id:     'ip-adapter-sdxl-vit-h',
    name:   'Reference image for SDXL models',
    family: 'sdxl',
    license:     'apache-2.0',
    source:      'https://huggingface.co/h94/IP-Adapter',
    licenseName: 'Apache-2.0',
    licenseUrl:  'https://www.apache.org/licenses/LICENSE-2.0',
    notes: 'The same reference-image feature for SDXL checkpoints. Bigger than the SD 1.5 one because SDXL\'s attention layers are wider. Shares its image encoder with the SD 1.5 row and with Wan 2.1 image-to-video, so whichever you install second is much smaller.',
    files: [
      // THE `vit-h` VARIANT, DELIBERATELY. h94 publish two SDXL adapters:
      // `ip-adapter_sdxl.safetensors` (702,585,376 bytes) is trained against
      // ViT-BigG, and `ip-adapter_sdxl_vit-h.safetensors` (698,391,064 ->
      // 666.03 MiB, declared 667) against the SAME ViT-H tower the SD 1.5 row
      // and the Wan row use. Picking the BigG one would mean a SECOND 2.5 GB
      // encoder download for a feature the ViT-H variant delivers on bytes that
      // are already here — and upstream's own doc names this exact file.
      {
        role:   'model',
        slug:   'ip-adapter-sdxl-vit-h',
        url:    'https://huggingface.co/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter_sdxl_vit-h.safetensors',
        sha256: 'ebf05d918348aec7abb02a5e9ecef77e0aaea6914a5c4ea13f50d45eb1681831',
        sizeMb: 667,
      },
      IP_ADAPTER_CLIP_VISION,
    ],
  },
]

/**
 * Checkpoints whose DECLARED family has an IP-Adapter row that MEASURABLY does
 * not load on them. The SD_BLOCKED_SPEED_ADAPTERS shape, for the same reason:
 * an absence a user reads as a missing feature deserves the verdict instead.
 *
 * ── WHY THIS LIST EXISTS AT ALL ──────────────────────────────────────────────
 *
 * `sd-turbo` is declared `family: 'sd15'` in this file and it is not SD 1.5.
 * The engine says so on every load of it —
 *
 *     [INFO ] stable-diffusion.cpp:900  - Version: SD 2.x
 *
 * — because stabilityai/sd-turbo is a distilled SD **2.1**. Handing it the SD 1.5
 * IP-Adapter was measured on 2026-08-05 and dies in a flood of
 *
 *     [ERROR] model_manager.cpp:640 - CLIP vision tensor
 *             'cond_stage_model.transformer.vision_model.encoder.layers.0…'
 *
 * with no image written. The family field being wrong is a PRE-EXISTING defect
 * with a wider blast radius than this list (it is also why an SD 1.5 LoRA is
 * offered for SD-Turbo and silently no-ops, and fixing it means adding a family
 * value that ten closed sets — Civitai mapping, size tiers, catalog chips — do
 * not have). It is recorded in the handoff as its own task. What must NOT happen
 * meanwhile is a NEW feature inheriting the lie and offering a 1.2 GB download
 * that cannot run.
 */
export const SD_IP_ADAPTER_BLOCKED: Readonly<Record<string, string>> = {
  'sd-turbo': 'SD-Turbo is a distilled Stable Diffusion 2.1, not 1.5 — the engine reports "Version: SD 2.x" every time it loads. The reference-image weights are trained per architecture, and the 1.5 ones fail to load against it (measured). Pick Stable Diffusion 1.5 or an SDXL checkpoint to use a reference image.',
}

/** One IP-Adapter row by id. */
export function findIpAdapter(id: string): SdIpAdapter | undefined {
  return SD_IP_ADAPTERS.find(a => a.id === id)
}

/**
 * The IP-Adapter row for a checkpoint family, or undefined.
 *
 * The family string arrives from the ROW (curated or user-installed), never from
 * an id substring — the same rule the clip-skip gate and the preset table follow.
 */
export function ipAdapterForFamily(family: string, modelId?: string): SdIpAdapter | undefined {
  // The MEASURED refusal comes first: a row whose declared family has an adapter
  // but whose weights are a different architecture must not be offered one. See
  // SD_IP_ADAPTER_BLOCKED.
  if (modelId && SD_IP_ADAPTER_BLOCKED[modelId]) return undefined
  return SD_IP_ADAPTERS.find(a => a.family === family)
}

/** Why this checkpoint has no reference-image option, or undefined. */
export function ipAdapterBlockedFor(modelId: string): string | undefined {
  return SD_IP_ADAPTER_BLOCKED[modelId]
}

/**
 * An IP-Adapter's files as the CATALOG hands them over — the same shape and the
 * same `sharedWith` cross-check as upscalerCatalogFiles, so the download panel
 * prices this row with the code it already has.
 *
 * `sharedWith` spans the MODEL rows as well as the other IP-Adapter, because the
 * encoder really is the Wan i2v component: pricing that shows the full 1,249 MiB
 * to someone who already has those bytes is the over-count this field exists to
 * prevent.
 */
export function ipAdapterCatalogFiles(a: SdIpAdapter): Array<{ slug: string; sizeMb: number; sharedWith: string[] }> {
  return a.files.map(f => {
    const sha = f.sha256.toLowerCase()
    return {
      slug:   f.slug,
      sizeMb: f.sizeMb,
      sharedWith: [
        ...SD_IP_ADAPTERS.filter(o => o.id !== a.id && o.files.some(g => g.sha256.toLowerCase() === sha)).map(o => o.id),
        ...sdFilesWithSha(f.sha256).map(r => r.modelId),
      ],
    }
  })
}

// ── ADAPTERS: LoRA / LyCORIS, Textual Inversion, VAE ─────────────────────────
//
// The three artifact types the engine can run that were NOT wired at all
// (spec §3 run-truth matrix): a downloaded LoRA was INERT — buildSdArgs never
// emitted `--lora-model-dir` and there is no `--lora` flag to emit, because
// stable-diffusion.cpp applies a LoRA by NAME IN THE PROMPT. An embedding had
// no `--embd-dir`. A VAE could only ever reach the multi-component branch, so a
// single-file SDXL checkpoint could never swap one (the fp16-VAE black-image
// trap).
//
// ONE SHAPE FOR ALL THREE, deliberately: they differ only in which flag names
// their directory and whether the prompt has to mention them. Auto-slotting by
// ROLE rather than by folder is moat #4 in the spec — ComfyUI cannot retrofit
// it because 122k stars of workflows key models by filename.

export type SdAdapterKind = 'lora' | 'embedding' | 'vae'

/**
 * A user-installed adapter. Never curated: every one of these arrives from a
 * user-initiated install (Civitai today, any weights host later).
 */
export interface SdAdapter {
  /** `civitai-<versionId>` etc — `[a-z0-9-]` only (risk R10). */
  id:            string
  kind:          SdAdapterKind
  /** Display name, the creator's own words. NOT the on-disk name. */
  name:          string
  /**
   * THE ON-DISK NAME, and for a LoRA the token inside `<lora:slug:weight>`.
   *
   * The app owns it because upstream names cannot be trusted with this job:
   * 10.7% of real Civitai LoRA filenames contain SPACES, which the tag syntax
   * cannot carry at all, and the top 600 hold 54 outright collisions. Derived
   * from the hash (see adapterSlug), so it is stable, unique and typeable.
   */
  slug:          string
  /**
   * The checkpoint family this adapter was trained against. THE COMPAT GATE:
   * an SD 1.5 LoRA on an SDXL checkpoint is not "weak", it is a tensor-shape
   * mismatch that ComfyUI's ecosystem silently no-ops with a console-only
   * warning (comfy/lora.py:93). We hold the family per artifact and one engine,
   * so refusing it at generate time is trivial — and it is the single feature
   * InvokeAI users name first.
   */
  family:        SdModelFamily
  file:          SdModelFile
  /** Creator-declared prompt tokens the weights respond to (the chips). */
  triggerWords?: string[]
  /** LoRA only: the weight the picker starts at. */
  defaultWeight?: number
  notes?:        string
}

/** Which sd-cli flag names the DIRECTORY each kind is scanned from. */
export const SD_ADAPTER_FLAG: Record<SdAdapterKind, string> = {
  lora:      '--lora-model-dir',
  embedding: '--embd-dir',
  vae:       '--vae',
}

/** The shared subdirectory each kind lands in, under the sd engine's model root.
 *  ONE directory per kind is a requirement, not a preference: `--lora-model-dir`
 *  and `--embd-dir` take a DIRECTORY that the engine scans by file stem. */
export const SD_ADAPTER_DIR: Record<SdAdapterKind, string> = {
  lora:      'loras',
  embedding: 'embeddings',
  vae:       'vae',
}

// `adapterSlug` lives in user-sd-models.ts, not here: THIS module already
// imports that one at RUNTIME (listUserSdModels), so a runtime import back the
// other way would be a real cycle. Re-exported so the slug reads as part of the
// registry vocabulary wherever it is used.
export { adapterSlug } from './user-sd-models'

/** Every adapter the user has registered (soft-failing, like listUserSdModels). */
export function allSdAdapters(adapters: UserSdAdapter[] = listUserSdAdapters()): SdAdapter[] {
  return adapters
}

/** One adapter by id, or undefined. */
export function findSdAdapter(id: string, adapters: UserSdAdapter[] = listUserSdAdapters()): SdAdapter | undefined {
  return adapters.find(a => a.id === id)
}

/**
 * COMPAT AT GENERATE (spec §5-6). An adapter runs only on a checkpoint of the
 * family it was trained against — the engine will otherwise load it and apply
 * nothing, which is the failure mode the whole ecosystem tolerates.
 *
 * VAE is family-scoped for the same reason and one more: an SDXL fp16 VAE on an
 * SD 1.5 checkpoint is a different latent scale, not a style choice.
 */
export function isAdapterCompatible(adapter: { family: SdModelFamily }, checkpointFamily: string): boolean {
  return adapter.family === checkpointFamily
}

// ── Curated ∪ user-installed ─────────────────────────────────────────────────
//
// The two lookups below are the ONLY places the rest of the app asks "what
// models exist". Merging the user registry HERE (rather than teaching each
// consumer about it) is what makes an installed Civitai checkpoint visible to
// modelComponentPaths → isSdModelInstalled → sd-cpp:status → the MediaPage
// dropdown → generate, with no second code path. See user-sd-models.ts.
//
// CURATED WINS a collision, always: a user row can never shadow a pinned SHA /
// pinned size / pinned URL. In practice ids cannot collide (user ids are
// namespaced `civitai-<versionId>`), so this is a guard, not a mechanism.
//
// `userModels` is a PARAMETER with a live default so the merge is testable as a
// pure function; every production caller passes nothing.

/** Find a model (image OR video) by id — for the installer/client component lookup. */
export function findSdModel(
  id: string,
  userModels: UserSdModel[] = listUserSdModels(),
): { id: string; name: string; family?: string; files: SdModelFile[]; requiresKey?: boolean } | undefined {
  return [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS].find(m => m.id === id)
      ?? userModels.find(m => m.id === id)
}

/**
 * THE GENERATION ROW: the same merged lookup findSdModel does, but returning the
 * whole row — `steps` / `cfgScale` / `samplingMethod` / `baseSize` / `scheduler`
 * and the video row's `width|height|frames`.
 *
 * findSdModel deliberately narrows to the fields the DOWNLOADER needs, and that
 * narrowing is exactly what made audit D4 possible: sd-cpp-client could not use
 * it for the arg builder, so it kept its own `SD_IMAGE_MODELS.find` — CURATED
 * ONLY. Every user-installed row therefore ran at 512x512 / 20 steps / cfg 7 /
 * euler no matter what user-sd-models had stamped on it, and the tachi-gen
 * provenance chunk repeated those wrong numbers as fact.
 *
 * `kind` travels with the row so one call answers "image or video" too.
 */
export type SdGenerationRow =
  | ({ kind: 'image' } & SdImageModel)
  | ({ kind: 'video' } & SdVideoModel)

export function findSdRow(
  id: string,
  userModels: UserSdModel[] = listUserSdModels(),
): SdGenerationRow | undefined {
  const img = SD_IMAGE_MODELS.find(m => m.id === id)
  if (img) return { kind: 'image', ...img }
  const vid = SD_VIDEO_MODELS.find(m => m.id === id)
  if (vid) return { kind: 'video', ...vid }
  const user = userModels.find(m => m.id === id)
  // A user row is structurally an SdImageModel (user-sd-models' whole premise).
  return user ? { kind: 'image', ...user } : undefined
}

/**
 * `--sampling-method`'s REAL vocabulary at the pinned build.
 *
 * The composer's sampler dropdown used to offer A1111/diffusers spellings
 * (`dpmpp_2m`, `dpmpp_2m_karras`, `dpmpp_sde`, `ddim`, `lms`), which was
 * harmless ONLY because the control was dead (audit D1): the moment the name
 * mismatch was fixed, picking a sampler would have started feeding sd-cli names
 * it rejects. Fixing D1 without D17 is a regression, so they shipped together.
 *
 * ── AND THEN THE REPLACEMENT WAS SHORT BY EIGHT, 2026-08-03 ─────────────────
 *
 * This list said it was "read off src/stable-diffusion.cpp of
 * master-782-b290693". At that very tag `sd-cli --help` printed NINETEEN
 * samplers and this array held eleven. The eight nobody could pick —
 * `dpm++2s_a`, `dpm++2m_sde`, `dpm++2m_sde_bt`, `res_multistep`, `res_2s`,
 * `er_sde`, `euler_cfg_pp`, `euler_a_cfg_pp` — were shipped, working, and
 * unreachable from the UI for as long as the constant has existed.
 *
 * That is the same defect as everything else this file guards against: a list
 * nobody held against the thing it describes. So it is no longer transcribed
 * from reading source. It is the `--sampling-method` enum of the pinned binary,
 * extracted from its own `--help`, in the engine's own order:
 *
 *   sd-cli --help | grep -A2 -- --sampling-method
 *
 * `lms` is last because master-810 added it; the other nineteen were already
 * there. Re-extract on every SD_CPP_VERSION bump — the bump that found this one
 * is exactly when it is cheapest to notice.
 */
export const SD_SAMPLING_METHODS: readonly string[] = [
  'euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2',
  'dpm++2m_sde', 'dpm++2m_sde_bt', 'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing',
  'tcd', 'res_multistep', 'res_2s', 'er_sde', 'euler_cfg_pp', 'euler_a_cfg_pp',
  'lms',
]

/** All models with their kind — for status listing + the catalog. */
export function allSdModels(
  userModels: UserSdModel[] = listUserSdModels(),
): Array<{ id: string; name: string; kind: 'image' | 'video'; family: string; files: SdModelFile[] }> {
  const curated = [
    ...SD_IMAGE_MODELS.map(m => ({ id: m.id, name: m.name, kind: 'image' as const, family: m.family as string, files: m.files })),
    ...SD_VIDEO_MODELS.map(m => ({ id: m.id, name: m.name, kind: 'video' as const, family: m.family as string, files: m.files })),
  ]
  const taken = new Set(curated.map(m => m.id))
  return [
    ...curated,
    ...userModels
      .filter(m => !taken.has(m.id))
      .map(m => ({ id: m.id, name: m.name, kind: 'image' as const, family: m.family as string, files: m.files })),
  ]
}

// ── THE FILE IDENTITY INDEX (hash-first dedupe, moat #2) ─────────────────────
//
// `sha256` is not just a verification token, it is the file's IDENTITY — the
// same premise the SDXL row's comment states and the same one Civitai/A1111 use
// to recognise a checkpoint. Curated rows now SHARE files on purpose:
//
//   flux-schnell-q4/vae   ≡ z-image-turbo/vae        (the FLUX.1 autoencoder)
//   wan21-t2v-1.3b/vae    ≡ wan21-i2v-14b-480p/vae
//   wan21-t2v-1.3b/t5xxl  ≡ wan21-i2v-14b-480p/t5xxl (5.6 GB of umt5)
//
// so "which OTHER rows declare these exact bytes" is a question the installer
// has to be able to ask before it opens a socket. Pure and registry-only: it
// answers about DECLARATIONS, and sd-cpp-installer's findReusableComponent is
// what turns an answer into a path that exists on disk.

/** One row's declaration of a file. */
export interface SdFileRef {
  modelId: string
  role:    SdFileRole
  file:    SdModelFile
}

/**
 * Every curated ∪ user file declaring `sha`.
 *
 * A PLACEHOLDER never matches, in either direction: it is the marker for "we
 * could not verify these bytes", so treating two of them as the same file would
 * be reuse founded on nothing. Comparison is case-insensitive because a sha can
 * arrive from an upstream API in either case (Civitai answers uppercase).
 */
export function sdFilesWithSha(
  sha: string,
  userModels: UserSdModel[] = listUserSdModels(),
): SdFileRef[] {
  if (typeof sha !== 'string' || !sha || isShaPlaceholder(sha)) return []
  const want = sha.toLowerCase()
  const out: SdFileRef[] = []
  for (const m of [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS, ...userModels]) {
    for (const f of m.files) {
      if (isShaPlaceholder(f.sha256)) continue
      if (f.sha256.toLowerCase() === want) out.push({ modelId: m.id, role: f.role, file: f })
    }
  }
  return out
}

/**
 * One row's files as the CATALOG hands them to the renderer: the size, and the
 * OTHER rows that declare the exact same bytes.
 *
 * `sharedWith` exists because the download panel could not otherwise tell a
 * shared component from a fresh one. The I2V row's button read "17.6 GB" while
 * its own tooltip said ~11.7 GB (two of four components are the 2.1 files a Wan
 * owner already has) — the pessimistic number was the one on screen and the
 * honest one was hidden behind a hover. The renderer subtracts a file whose
 * `sharedWith` names an INSTALLED row, which is sound: `isSdModelInstalled` is
 * true only when EVERY component of that row is on disk.
 *
 * The sha itself deliberately does not cross: the renderer has no use for it,
 * and the identity question is answered here, next to the registry that owns it.
 */
export interface SdCatalogFile {
  role:       SdFileRole
  sizeMb:     number
  /** Other model ids declaring these exact bytes (sha-identical). */
  sharedWith: string[]
}

export function sdCatalogFiles(
  model: { id: string; files: SdModelFile[] },
  userModels: UserSdModel[] = listUserSdModels(),
): SdCatalogFile[] {
  return model.files.map(f => ({
    role:   f.role,
    sizeMb: f.sizeMb,
    // A row never "shares" with itself — that is its own file, not reuse (the
    // same distinction findReusableComponent draws).
    sharedWith: [...new Set(
      sdFilesWithSha(f.sha256, userModels)
        .map(r => r.modelId)
        .filter(id => id !== model.id),
    )],
  }))
}

// ── Performance-tier presets (Fooocus-style) ──────────────────────────────────
//
// Reference: Fooocus modules/flags.py Performance enum
// Maps a human tier name to the generation params that make sense for each
// model family. The renderer picks the best match for the active model at
// apply time (falls back to sd15 row when the family is unknown).
//
// These are DATA ONLY — the renderer fills existing step/sampler/cfg controls;
// no IPC is added or changed here.

/**
 * The families the PRESET TABLE below has a column for. Deliberately narrower
 * than SdModelFamily: a family only belongs here when three honest tiers exist
 * for it, and presetsForRow derives tiers from the ROW for everything else.
 */
export type SdPresetFamily = 'sd15' | 'sdxl' | 'flux'

/**
 * Every family a CHECKPOINT may declare.
 *
 * Not a label: `isAdapterCompatible` is an equality test on it, so this is the
 * gate that stops a Flux.1 LoRA loading onto Z-Image's S3-DiT and silently
 * applying nothing (the failure the whole ecosystem tolerates). `zimage` is
 * therefore its own family even though the row borrows Flux's autoencoder.
 *
 * ALL FOUR ARE USER-DECLARABLE, `zimage` included — `isFamily` in
 * user-sd-models accepts it and familyForBaseModel maps to it.
 *
 * This used to claim the upstream catalog had nothing to map here. It was
 * measurably wrong, and the measurement is recorded rather than just removed
 * because it is the sort of claim that gets re-derived from a guess:
 * `baseModels=ZImageTurbo` returns 100 models / 402 versions and `ZImageBase`
 * 99 / 194, echo-tested against the live API on 2026-07-31 (see the mapper's
 * own note — the guessable spelling `Z-Image Turbo` returns an empty page
 * rather than an error, which is how the wrong answer survived).
 *
 * What IS true is narrower: a Z-Image CHECKPOINT is still not installable as a
 * bundle (the verdict refuses it), so the mapping exists to let the measured
 * Z-Image LoRAs load onto the curated `z-image-turbo` row.
 */
export type SdModelFamily = SdPresetFamily | 'zimage'

export interface SdPresetParams {
  steps:          number
  samplingMethod: string
  cfgScale:       number
}

export interface SdPreset {
  /** Stable identifier, also used as i18n key suffix (`presets.<id>.label`). */
  id:     string
  /** Default params keyed by model family. `sd15` row is the fallback. */
  params: Record<SdPresetFamily, SdPresetParams>
}

/**
 * Performance-tier presets.  Applied renderer-side: fills the existing
 * steps / samplingMethod / cfgScale controls without touching IPC.
 *
 * Turbo tier uses 1-step euler (SD-Turbo / FLUX distilled);
 * Quality uses 28-step DPM++ (sweet spot for SD1.5 / FLUX);
 * Speed is the midpoint (10 steps).
 */
export const SD_PRESETS: SdPreset[] = [
  {
    id: 'lightning',
    params: {
      sd15: { steps: 1,  samplingMethod: 'euler',     cfgScale: 1.0 },
      sdxl: { steps: 1,  samplingMethod: 'euler',     cfgScale: 1.0 },
      flux: { steps: 1,  samplingMethod: 'euler',     cfgScale: 1.0 },
    },
  },
  {
    id: 'speed',
    params: {
      sd15: { steps: 10, samplingMethod: 'euler_a',   cfgScale: 5.0 },
      sdxl: { steps: 10, samplingMethod: 'euler_a',   cfgScale: 5.0 },
      flux: { steps: 4,  samplingMethod: 'euler',     cfgScale: 1.0 },
    },
  },
  {
    id: 'quality',
    params: {
      sd15: { steps: 28, samplingMethod: 'dpm++2m',   cfgScale: 7.0 },
      sdxl: { steps: 28, samplingMethod: 'dpm++2m',   cfgScale: 5.0 },
      flux: { steps: 20, samplingMethod: 'euler',     cfgScale: 1.0 },
    },
  },
]

// ── Which tiers a ROW may honestly offer (audit D5) ──────────────────────────
//
// The table above has three columns — sd15 / sdxl / flux — and the composer
// handed EVERY local row the column its family matched, falling through to
// sd15 for anything else. Two lies came out of that:
//
//  • WAN (video) has no column, so "Quality" handed a 20-step / cfg-6 model 28
//    steps at cfg 7, and "Lightning" handed it 1 step at cfg 1 — which on a
//    non-distilled checkpoint is not fast, it is NOISE.
//  • SD-TURBO is a 1-step distilled model with the family `sd15`, so it was
//    offered the full sd15 ladder including "Quality (20–28 steps)": 28x the
//    time for a WORSE image, because past its trained step count a distilled
//    model degrades. Same for FLUX.1-schnell (4 steps, cfg 1) against the flux
//    column's 20-step tier.
//
// So the question is not "what family is this" but "what can THIS ROW do".

/** A tier as OFFERED for one row — already resolved, no family lookup left. */
export interface SdPresetOffer {
  id:     string
  params: SdPresetParams
}

/**
 * A row is DISTILLED when its own recipe is a handful of steps at guidance ~1.
 * That is the shape of every step-distilled checkpoint we can install
 * (SD-Turbo 1/1, FLUX.1-schnell 4/1, an LCM/Lightning merge from Civitai), and
 * it is derived from the row rather than flagged by hand so a user-installed
 * turbo merge is treated the same way a curated one is.
 */
export function isDistilledRow(row: { steps: number; cfgScale: number }): boolean {
  return row.steps <= 4 && row.cfgScale <= 1.5
}

/**
 * The performance tiers this row can honestly offer.
 *
 *  • DISTILLED row → NONE. It has exactly one setting that works — its own —
 *    and every tier in the table would move it away from that. The composer
 *    hides the picker rather than offering three wrong answers.
 *  • An image family the table describes → that family's column, verbatim.
 *  • Anything else (wan today) → two tiers DERIVED FROM THE ROW: its own recipe
 *    as "quality", half its steps as "speed", its own sampler and guidance in
 *    both. No 1-step tier is invented, because nothing we ship can run one.
 */
export function presetsForRow(row: {
  family:         string
  steps:          number
  cfgScale:       number
  samplingMethod: string
}): SdPresetOffer[] {
  if (isDistilledRow(row)) return []
  if (row.family === 'sd15' || row.family === 'sdxl' || row.family === 'flux') {
    const fam = row.family
    return SD_PRESETS.map(p => ({ id: p.id, params: { ...p.params[fam] } }))
  }
  return [
    { id: 'speed',   params: { steps: Math.max(1, Math.round(row.steps / 2)), samplingMethod: row.samplingMethod, cfgScale: row.cfgScale } },
    { id: 'quality', params: { steps: row.steps,                              samplingMethod: row.samplingMethod, cfgScale: row.cfgScale } },
  ]
}

// ── Style presets (Fooocus-style) ─────────────────────────────────────────────
//
// Reference: Fooocus modules/sdxl_styles.py  (apply_style replaces {prompt})
// A style wraps the user's prompt with extra positive keywords and appends a
// negative prompt.  Renderer-side only: the wrapped strings are passed straight
// into the existing generate params; no IPC change needed.

export interface SdStyle {
  /** Stable identifier. Also the i18n key suffix (`styles.<id>.label`). */
  id:       string
  /** May contain `{prompt}` — replaced with the user's text at apply time.
   *  If omitted, the user prompt is appended to the end. */
  positive: string
  /** Appended to the model's own negative_prompt (if any). */
  negative: string
}

/**
 * Apply a style to a user prompt, mirroring Fooocus's apply_style logic.
 * Returns { positive, negative } ready to pass to the generate call.
 */
export function applyStyle(style: SdStyle, userPrompt: string, existingNegative = ''): {
  positive: string
  negative: string
} {
  const positive = style.positive.includes('{prompt}')
    ? style.positive.replace('{prompt}', userPrompt)
    : userPrompt ? `${style.positive}, ${userPrompt}` : style.positive
  const negative = [style.negative, existingNegative].filter(Boolean).join(', ')
  return { positive, negative }
}

/**
 * Curated style presets.  Loosely adapted from Fooocus's built-in style list
 * (see modules/sdxl_styles.py for the full upstream set) — shortened to the
 * most universally applicable entries that work across SD1.5, SDXL, and Flux.
 */
export const SD_STYLES: SdStyle[] = [
  {
    id:       'none',
    positive: '{prompt}',
    negative: '',
  },
  {
    id:       'cinematic',
    positive: '{prompt}, cinematic, dramatic lighting, anamorphic lens, film grain, color graded, 4k',
    negative: 'flat, cartoon, illustration, low quality, blurry',
  },
  {
    id:       'photorealistic',
    positive: '{prompt}, photorealistic, DSLR, sharp focus, high detail, natural lighting, 8k',
    negative: 'painting, illustration, anime, cartoon, sketch, rendering, low quality',
  },
  {
    id:       'digital-art',
    positive: '{prompt}, digital art, concept art, vibrant colors, detailed illustration, trending on artstation',
    negative: 'photo, photorealistic, low detail, blurry',
  },
  {
    id:       'anime',
    positive: '{prompt}, anime style, cel shading, clean lines, vibrant, high quality anime key visual',
    negative: 'photo, photorealistic, western art, 3d render, deformed',
  },
  {
    id:       'oil-painting',
    positive: '{prompt}, oil painting, classical art, impasto texture, masterpiece, detailed brushwork',
    negative: 'photo, digital art, flat, cartoon, 3d render',
  },
  {
    id:       'pixel-art',
    positive: '{prompt}, pixel art, retro 8-bit style, limited palette, crisp pixels, isometric',
    negative: 'photo, smooth gradients, realistic, blurry, high resolution',
  },
  {
    id:       'watercolor',
    positive: '{prompt}, watercolor painting, soft washes, delicate, paper texture, artistic',
    negative: 'photo, sharp edges, digital, 3d render, oil paint',
  },
  {
    id:       'neon-noir',
    positive: '{prompt}, neon noir, cyberpunk, rain-slicked streets, neon reflections, dark dramatic, high contrast',
    negative: 'daytime, bright, pastel, wholesome, low detail',
  },
  {
    id:       'fantasy-epic',
    positive: '{prompt}, epic fantasy illustration, detailed environment, volumetric light, mystical atmosphere',
    negative: 'modern, urban, realistic photo, low detail',
  },
]

/** True when a SHA entry is still the build-time placeholder (verification skipped). */
export function isShaPlaceholder(sha: string): boolean {
  return /^__SHA_PLACEHOLDER_.*__$/.test(sha)
}

/** Total download size (MB) for a model across all its component files. */
export function modelTotalMb(m: SdImageModel): number {
  return m.files.reduce((a, f) => a + f.sizeMb, 0)
}

/**
 * Pick the release asset for this platform. On Windows prefer the CUDA build when
 * an NVIDIA GPU is present (caller passes `cuda`), else the CPU/AVX2 build.
 * Linux / Intel-mac are unsupported in P1 (returns null — mirror llama.cpp's
 * getUnsupportedPlatformMessage at the call site).
 */
export function defaultReleaseAsset(platform: NodeJS.Platform, arch: string, cuda: boolean): SdRelease | null {
  if (platform === 'win32') return SD_CPP_RELEASES.find(r => r.platform === (cuda ? 'win-cuda' : 'win-cpu')) ?? null
  if (platform === 'darwin' && arch === 'arm64') return SD_CPP_RELEASES.find(r => r.platform === 'mac-arm64') ?? null
  return null
}
