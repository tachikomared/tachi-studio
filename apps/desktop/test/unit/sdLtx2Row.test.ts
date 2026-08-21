// apps/desktop/test/unit/sdLtx2Row.test.ts
//
// THE LTX-2.3 ROW SHIPS, AND THE REGISTRY LEARNS TO SAY WHAT A USER IS
// ACCEPTING.
//
// b56c3d7 landed this row BLOCKED, and one of its five stated blockers was a
// licence claim about US: "the model registry has no way to surface a licence
// today". The owner's ruling is that the other half of that reasoning was
// wrong — this app is an MIT download CLIENT, not a distributor. The bytes move
// from Lightricks' and unsloth's HuggingFace repos to the user's own disk; the
// LTX-2 agreement's pass-through obligations ("provide a copy of this
// Agreement") and the Gemma Notice requirement bind whoever DISTRIBUTES the
// weights, which is those repos, not a client that fetches them.
//
// What remains genuinely ours is INFORMED CONSENT: a button that pulls 20.8 GB
// under a non-OSI licence with a revenue ceiling must say so before it is
// pressed. That is what `licenseName` / `licenseUrl` are, and this suite is
// what stops them from being decoration.
//
// ── EVERY NUMBER BELOW IS SOURCE-ASSERTED, and the sources differ ─────────────
//
//  • THE RECIPE — Lightricks' OWN model card (huggingface.co/Lightricks/LTX-2.3,
//    "Model Checkpoints"): "ltx-2.3-22b-distilled | The distilled version of the
//    full model, 8 steps, CFG=1". NOT upstream sd.cpp's docs/ltx2.md, whose
//    worked commands are all the DEV model at --cfg-scale 6.0.
//  • THE SIZE / LENGTH LAW — the same card, "General tips": "Width & height
//    settings must be divisible by 32. Frame count must be divisible by 8 + 1."
//    CONFIRMED INDEPENDENTLY in the pinned engine: vae.hpp's get_scale_factor()
//    returns 32 for VERSION_LTXAV, and stable-diffusion.cpp's
//    video_frames_to_latent_frames() computes ((frames - 1) / 8) + 1 for LTXAV
//    against ((frames - 1) / 4) + 1 for Wan.
//  • THE FLAGS — upstream docs/ltx2.md at OUR pin (master-782-b290693), which
//    ships worked T2V / I2V / FLF2V commands with output videos attached.
//  • THE FPS — that doc's T2V command passes `--fps 24`, and examples/common/
//    common.cpp declares `--fps  fps (default: 24)`. Two sources, same number.
//  • WHAT WE MUST *NOT* PASS — the engine picks LTX's schedule itself
//    (sd_get_default_scheduler → LTX2_SCHEDULER for LTXAV) and owns its own
//    shift (default_flow_shift = 2.37f for LTXAV). Passing --scheduler or
//    --flow-shift would OVERRIDE both with a number nobody derived.
//  • THE FILES — re-verified live against the HF tree API on 2026-07-31: every
//    sha256 and every byte count the previous lane pinned still matches.

import { describe, it, expect, vi } from 'vitest'

// hoisted: sd-cpp-client pulls storage-root, which reads app.getPath() at
// IMPORT time (the idiom every sd-cpp suite in this dir uses).
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-ltx2row-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildSdVideoArgs, type SdVideoInput } from '../../electron/services/sd-cpp-client'
import { modelParamSchema } from '../../electron/services/surplus-media-service'
import {
  SD_VIDEO_MODELS, SD_BLOCKED_MODELS, SD_IMAGE_MODELS, findSdRow,
  DEFAULT_VIDEO_FPS, DEFAULT_VIDEO_PIXEL_GRID, DEFAULT_VIDEO_FRAME_GRID,
  type SdGenerationRow, type SdVideoModel,
} from '../../electron/services/sd-cpp-models'
import { BLOCKED_LOCAL_ROWS } from '../../src/pages/catalog/blockedLocalRows'
import { sdRowLicense } from '../../src/pages/media/mediaHelpers'
import {
  durationSecondsToWanFrames, resolveLocalWanFrames, requestedWanFrames,
  LOCAL_VIDEO_FPS_EXCEPTIONS, LOCAL_VIDEO_FRAME_GRID_EXCEPTIONS,
  localVideoFrameGridFor,
} from '../../src/pages/media/localGenParams'

const ID  = 'ltx-2-3-22b-distilled'
const OUT = 'C:/out/clip.webm'

const ltx = (): SdVideoModel => {
  const m = SD_VIDEO_MODELS.find(x => x.id === ID)
  if (!m) throw new Error('LTX-2.3 is not in SD_VIDEO_MODELS')
  return m
}
const row = (): SdGenerationRow => {
  const r = findSdRow(ID, [])
  if (!r || r.kind !== 'video') throw new Error('no LTX video row')
  return r
}

/** The full component set an installed LTX row resolves to. */
const C = {
  diffusion:             'C:/w/ltx/diffusion.gguf',
  vae:                   'C:/w/ltx/vae.safetensors',
  audio_vae:             'C:/w/ltx/audio_vae.safetensors',
  embeddings_connectors: 'C:/w/ltx/embeddings_connectors.safetensors',
  llm:                   'C:/w/ltx/llm.gguf',
}

const valueOf = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag)
  return at >= 0 ? args[at + 1] : undefined
}

const input = (over: Partial<SdVideoInput> = {}): SdVideoInput =>
  ({ modelId: ID, prompt: 'a glass flower blossom', ...over })

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

// ═══ 1. THE ROW LEAVES THE REFUSAL LIST ══════════════════════════════════════

describe('LTX-2.3 moves from SD_BLOCKED_MODELS to SD_VIDEO_MODELS', () => {
  it('is a real curated video row', () => {
    expect(ltx().id).toBe(ID)
    expect(row().kind).toBe('video')
  })

  it('is gone from the blocked registry AND from its renderer mirror', () => {
    expect(SD_BLOCKED_MODELS.some(m => m.id === ID)).toBe(false)
    expect(BLOCKED_LOCAL_ROWS.some(r => r.id === ID)).toBe(false)
  })

  it('Klein STAYS blocked, and the mirror still pins it both ways', () => {
    // The two refusals were never the same case. Klein is blocked because two
    // components cannot be pinned at all — no licence reasoning unblocks a file
    // that does not resolve.
    expect(SD_BLOCKED_MODELS.map(m => m.id)).toEqual(['flux2-klein-4b'])
    expect(BLOCKED_LOCAL_ROWS.map(r => r.id)).toEqual(['flux2-klein-4b'])
    expect(BLOCKED_LOCAL_ROWS[0].reason).toBe(SD_BLOCKED_MODELS[0].blocked)
  })

  it('declares its own architecture — the video registry is no longer Wan-only', () => {
    expect(ltx().family).toBe('ltx2')
    expect(SD_VIDEO_MODELS.filter(m => m.family === 'ltx2').map(m => m.id)).toEqual([ID])
    // …and every OTHER row is still Wan, so nothing was reclassified by accident.
    expect(SD_VIDEO_MODELS.filter(m => m.id !== ID).every(m => m.family === 'wan')).toBe(true)
  })
})

// ═══ 2. THE FIVE FILES, RE-VERIFIED ══════════════════════════════════════════
//
// HF tree API, 2026-07-31 (`lfs.oid` + `lfs.size`), byte-for-byte identical to
// what b56c3d7 pinned from the same source:
//   distilled/ltx-2.3-22b-distilled-Q3_K_M.gguf                 10_770_199_584
//   vae/ltx-2.3-22b-distilled_video_vae.safetensors              1_452_256_522
//   vae/ltx-2.3-22b-distilled_audio_vae.safetensors                364_853_140
//   text_encoders/…-distilled_embeddings_connectors.safetensors  2_312_144_712
//   gemma-3-12b-it-qat-UD-Q4_K_XL.gguf                           7_432_229_248

describe('the five components', () => {
  const fileFor = (role: string) => ltx().files.find(f => f.role === role)!

  it('declares exactly the five roles LTX-AV needs', () => {
    expect(ltx().files.map(f => f.role).sort())
      .toEqual(['audio_vae', 'diffusion', 'embeddings_connectors', 'llm', 'vae'])
    // clip_vision is a Wan 2.1 i2v component. LTX conditions on the LLM +
    // connectors instead, and declaring one would be 1.2 GB for nothing.
    expect(ltx().files.some(f => f.role === 'clip_vision')).toBe(false)
    expect(ltx().files.some(f => f.role === 't5xxl')).toBe(false)
  })

  it('every file has a real sha256 and a positive size', () => {
    for (const f of ltx().files) {
      expect(f.sha256, f.role).toMatch(/^[0-9a-f]{64}$/)
      expect(f.sizeMb, f.role).toBeGreaterThan(0)
      expect(f.url, f.role).toMatch(/^https:\/\/huggingface\.co\//)
    }
  })

  it('pins the exact bytes the previous lane verified', () => {
    expect(fileFor('diffusion').sha256).toBe('388614a12f3d38c8bb08e42e92e5c73cb8cc1a1e5368b4cf02687ffa42c75269')
    expect(fileFor('vae').sha256).toBe('e68d6d8f8a42942ac9b862cc315beb3bc30805a8876c7ad63ba5bf7a2b8e168a')
    expect(fileFor('audio_vae').sha256).toBe('3cd6a6eb8cb28f5ecc12f1f3126952b2a3d2b0b42ad3270e63cefafafe0d9b57')
    expect(fileFor('embeddings_connectors').sha256).toBe('c61cbb396e2a8175d8b2da51f0fdac885a4ccd22c9f64dafa5aa2c455dc8a507')
    expect(fileFor('llm').sha256).toBe('da98f81c86916ed1c76b3eeda56b25cb7b8352b01093e2edb8028110fe2cb53b')
  })

  it('pairs the DISTILLED trio BY NAME, never by size', () => {
    // The repo ships dev and distilled VAE / connector files that are
    // BYTE-IDENTICAL IN SIZE (1385 / 348 / 2205 MiB each) and differ only in
    // sha256 — a size check cannot catch a mismatched pair, and `distilled-1.1`
    // has its own companions that these are NOT.
    for (const f of ltx().files.filter(f => f.url.includes('LTX-2.3-GGUF'))) {
      expect(f.url, f.role).toContain('distilled')
      expect(f.url, f.role).not.toContain('-dev')
      expect(f.url, f.role).not.toContain('distilled-1.1')
    }
  })

  it('sources only from ungated repos that DECLARE a licence', () => {
    const urls = ltx().files.map(f => f.url).join(' ')
    // unsloth/LTX-2.3-GGUF is what upstream's own docs/ltx2.md points at, and
    // it re-declares license_name: ltx-2-community-license-agreement.
    expect(urls).toContain('unsloth/LTX-2.3-GGUF')
    // The Gemma encoder: unsloth's re-host declares `license: gemma` and is
    // ungated; google/* returns 401 anonymously, so a button on it could only
    // ever fail. Comfy-Org/ltx-2 and Kijai/* declare nothing at all.
    expect(urls).toContain('unsloth/gemma-3-12b-it-qat-GGUF')
    expect(urls).not.toContain('huggingface.co/google/')
    expect(urls).not.toContain('Comfy-Org/ltx-2')
    expect(urls).not.toContain('Kijai/')
  })

  it('totals ~20.8 GB, and NONE of it is shared with an existing row', () => {
    const mb = ltx().files.reduce((a, f) => a + f.sizeMb, 0)
    expect(mb).toBe(21_299)
    expect(mb / 1024).toBeCloseTo(20.8, 1)
    // Nothing here is a Wan file, so the incremental price is the full price —
    // the download panel must never quote a "shares files" saving on this row.
    const others = new Set(
      [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS]
        .filter(m => m.id !== ID)
        .flatMap(m => m.files.map(f => f.sha256)),
    )
    for (const f of ltx().files) expect(others.has(f.sha256), f.role).toBe(false)
  })
})

// ═══ 3. THE RECIPE IS LIGHTRICKS' OWN, NOT UPSTREAM'S DEV COMMAND ════════════

describe('the distilled recipe comes from the model card', () => {
  it('is 8 steps at CFG 1 — the card\'s own words for this checkpoint', () => {
    expect(ltx().steps).toBe(8)
    expect(ltx().cfgScale).toBe(1)
  })

  it('does NOT inherit docs/ltx2.md\'s cfg 6.0, which is the DEV model\'s number', () => {
    // Every worked command in upstream's doc runs ltx-2.3-22b-dev at
    // --cfg-scale 6.0. Copying that onto distilled weights would pay for an
    // unconditional pass they were distilled to not need — the scheduler-trap
    // failure in another costume, and double the wall-clock for worse output.
    expect(ltx().cfgScale).not.toBe(6)
  })

  it('samples with euler, which the pinned binary accepts', () => {
    expect(ltx().samplingMethod).toBe('euler')
  })

  it('passes NEITHER --scheduler NOR --flow-shift — the engine owns both for LTXAV', () => {
    // sd_get_default_scheduler() returns LTX2_SCHEDULER when the version is
    // LTXAV, and default_flow_shift is 2.37f for LTXAV. Declaring either on the
    // row would override an engine-derived number with a guessed one.
    expect(ltx().scheduler).toBeUndefined()
    expect(ltx().flowShift).toBeUndefined()
  })

  it('is a single-expert row — no high-noise pass exists on this architecture', () => {
    expect(ltx().highNoiseSteps).toBeUndefined()
    expect(ltx().highNoiseCfgScale).toBeUndefined()
    expect(ltx().highNoiseSamplingMethod).toBeUndefined()
    expect(ltx().files.some(f => f.role === 'diffusion_high')).toBe(false)
  })

  it('declares NO negative prompt — at guidance 1 one would be inert', () => {
    // sd.cpp only encodes the unconditional branch when cfg != 1. Wan's
    // official negative is live at cfg 6 and would be a lie here.
    expect(ltx().negativePrompt).toBeUndefined()
  })
})

// ═══ 4. THE SIZE LAW: 32, AND THE 720 TRAP AGAIN ═════════════════════════════

describe('W/H are multiples of 32', () => {
  it('the row declares the grid and sits on it', () => {
    expect(ltx().pixelGrid).toBe(32)
    expect(ltx().width  % 32).toBe(0)
    expect(ltx().height % 32).toBe(0)
  })

  it('the native pair is 1280x704 — the grid-32 floor of upstream\'s own 1280x720', () => {
    // docs/ltx2.md's commands all pass `-W 1280 -H 720`, and 720/32 = 22.5. The
    // ENGINE floors it (generate_init_latent divides by the scale factor with
    // integer division and decodes back at 22x32 = 704), so a row that declared
    // 720 would be promising a size the engine silently refuses to make. Same
    // trap, same answer as Wan 2.2 TI2V-5B.
    expect([ltx().width, ltx().height]).toEqual([1280, 704])
  })

  it('a 720p composer request lands on 704, never 720 and never 736', () => {
    const args = buildSdVideoArgs(C, input({ width: 1280, height: 720 }), OUT, { row: row() })
    expect(valueOf(args, '-W')).toBe('1280')
    expect(valueOf(args, '-H')).toBe('704')
  })

  it('the portrait pair snaps the same way', () => {
    const args = buildSdVideoArgs(C, input({ width: 720, height: 1280 }), OUT, { row: row() })
    expect(valueOf(args, '-W')).toBe('704')
    expect(valueOf(args, '-H')).toBe('1280')
  })
})

// ═══ 5. THE LENGTH LAW: 8n+1, NOT 4n+1 ═══════════════════════════════════════
//
// This is the one that could not be data before this lane. Both surfaces held
// Wan's temporal law as a CONSTANT — snapVideoFrames' `4 * floor((n-1)/4) + 1`
// in the engine client, normalizeWanFrames' identical arithmetic in the
// composer. LTX's VAE compresses the temporal axis 8x, so 45 frames (a legal
// 4n+1 count) decodes to 41 on this checkpoint: the composer would say 45, the
// gallery would stamp 45, and 41 would render.

describe('--video-frames is held to LTX\'s 8n+1 law', () => {
  it('the row declares its own frame grid, and Wan rows keep the default', () => {
    expect(ltx().frameGrid).toBe(8)
    expect(DEFAULT_VIDEO_FRAME_GRID).toBe(4)
    for (const m of SD_VIDEO_MODELS.filter(m => m.family === 'wan')) {
      expect(m.frameGrid ?? DEFAULT_VIDEO_FRAME_GRID, m.id).toBe(4)
    }
  })

  it('every curated row\'s own frame count sits on its OWN grid', () => {
    for (const m of SD_VIDEO_MODELS) {
      const grid = m.frameGrid ?? DEFAULT_VIDEO_FRAME_GRID
      expect((m.frames - 1) % grid, m.id).toBe(0)
    }
  })

  it('49 frames — 8x6+1, and ~2 s at this row\'s 24 fps', () => {
    expect(ltx().frames).toBe(49)
    expect((ltx().frames - 1) % 8).toBe(0)
  })

  it('a 4n+1 request that is NOT 8n+1 is floored onto the 8-grid at the engine', () => {
    // 45 is legal on every Wan row and illegal here. Floor, not nearest: a
    // longer clip than was asked for costs more of the thing users complain of.
    const args = buildSdVideoArgs(C, input({ frames: 45 }), OUT, { row: row() })
    expect(valueOf(args, '--video-frames')).toBe('41')
  })

  it('…and a Wan row is untouched by the same request', () => {
    const wan = findSdRow('wan21-t2v-1.3b', [])!
    const args = buildSdVideoArgs(
      { diffusion: 'd', vae: 'v', t5xxl: 't' },
      { modelId: 'wan21-t2v-1.3b', prompt: 'p', frames: 45 },
      OUT, { row: wan },
    )
    expect(valueOf(args, '--video-frames')).toBe('45')
  })

  it('the COMPOSER derives the same counts, so what is shown is what runs', () => {
    // The other half: the engine guard must never be the thing that changes the
    // number, or the gallery stamps a length the file does not have.
    expect(durationSecondsToWanFrames(2, 24, 8)).toBe(49)
    expect(durationSecondsToWanFrames(1, 24, 8)).toBe(25)
    expect(durationSecondsToWanFrames(3, 24, 8)).toBe(73)
    // Every one of those is 8n+1 and inside the 81-frame ceiling.
    for (const s of [1, 2, 3]) {
      const f = durationSecondsToWanFrames(s, 24, 8)!
      expect((f - 1) % 8, `${s}s`).toBe(0)
      expect(f, `${s}s`).toBeLessThanOrEqual(81)
    }
  })

  it('resolveLocalWanFrames reads the grid off the duration spec, like fps', () => {
    const spec = { min: 1, max: 3, fps: 24, frameGrid: 8 }
    expect(resolveLocalWanFrames({ duration: 2 }, spec)).toEqual({ frames: 49 })
    // A raw `frames` needs no rate but still obeys the law: 45 is on-law for
    // Wan and off-law here, so it moves to the NEAREST legal count (49). The
    // composer rounds where the engine guard floors, and that asymmetry is
    // harmless precisely because of the next assertion — the composer's answer
    // is always already on-grid, so the guard never gets to change it.
    expect(resolveLocalWanFrames({ frames: 45 }, spec)).toEqual({ frames: 49 })
    // …and the 16 fps / 4-grid default is byte-identical to before.
    expect(resolveLocalWanFrames({ duration: 2 })).toEqual({ frames: 33 })
    expect(resolveLocalWanFrames({ frames: 45 })).toEqual({ frames: 45 })
  })

  it('WHAT THE COMPOSER SENDS IS WHAT THE ENGINE RUNS — no silent re-snap', () => {
    // The property the whole grid-threading exists for. Before it, the composer
    // produced 4n+1 counts and the engine floored them onto 8n+1 for this row:
    // 45 shown, 41 rendered, 45 stamped into the gallery entry. Now every count
    // either surface can produce is already legal on the other.
    const spec = { min: 1, max: 3, fps: 24, frameGrid: 8 }
    for (const bag of [{ duration: 1 }, { duration: 2 }, { duration: 3 }, { frames: 45 }, { frames: 33 }, { frames: 70 }]) {
      const { frames } = resolveLocalWanFrames(bag, spec)
      const args = buildSdVideoArgs(C, input({ frames }), OUT, { row: row() })
      expect(valueOf(args, '--video-frames'), JSON.stringify(bag)).toBe(String(frames))
    }
  })

  it('the flow-doctor\'s renderer mirror knows this row\'s rate AND its grid', () => {
    // flow-doctor runs on a static flow with no schema in hand, so it cannot
    // read the row. Both exception tables are pinned against sd-cpp-models.
    expect(LOCAL_VIDEO_FPS_EXCEPTIONS[ID]).toBe(ltx().fps)
    expect(LOCAL_VIDEO_FRAME_GRID_EXCEPTIONS[ID]).toBe(ltx().frameGrid)
    expect(localVideoFrameGridFor(ID)).toBe(8)
    expect(localVideoFrameGridFor('wan21-t2v-1.3b')).toBe(4)
    expect(localVideoFrameGridFor(undefined)).toBe(4)
    // The tables describe EXCEPTIONS only — a row that matches the default must
    // not appear, or the mirror becomes a second registry to keep in sync.
    for (const [id, fps] of Object.entries(LOCAL_VIDEO_FPS_EXCEPTIONS)) {
      expect(SD_VIDEO_MODELS.find(m => m.id === id)?.fps, id).toBe(fps)
      expect(fps, id).not.toBe(DEFAULT_VIDEO_FPS)
    }
    for (const [id, grid] of Object.entries(LOCAL_VIDEO_FRAME_GRID_EXCEPTIONS)) {
      expect(SD_VIDEO_MODELS.find(m => m.id === id)?.frameGrid, id).toBe(grid)
      expect(grid, id).not.toBe(DEFAULT_VIDEO_FRAME_GRID)
    }
  })

  it('requestedWanFrames (the chain-length warning) uses the row\'s grid too', () => {
    // 12 s at 24 fps on the 8-grid = 289 frames, well past the 81 ceiling — the
    // warning must fire with an 8n+1 number, not a 4n+1 one.
    const asked = requestedWanFrames({ duration: 12 }, 24, 8)!
    expect((asked - 1) % 8).toBe(0)
    expect(asked).toBeGreaterThan(81)
  })
})

// ═══ 6. THE ARGV ═════════════════════════════════════════════════════════════
//
// docs/ltx2.md at master-782-b290693, "LTX-2.3 dev T2V", verbatim:
//   -M vid_gen --diffusion-model … --vae … --audio-vae … --llm …
//   --embeddings-connectors … -p "a lovely cat" --cfg-scale 6.0
//   --sampling-method euler -W 1280 -H 720 --diffusion-fa --offload-to-cpu
//   --video-frames 33 --fps 24 -o t2v.webm
// The I2V command differs by a single `-i`.

describe('the LTX argv', () => {
  it('emits the two roles no Wan row has', () => {
    const args = buildSdVideoArgs(C, input(), OUT, { row: row() })
    expect(valueOf(args, '--audio-vae')).toBe(C.audio_vae)
    expect(valueOf(args, '--embeddings-connectors')).toBe(C.embeddings_connectors)
  })

  it('conditions through --llm, not --t5xxl (a 12B Gemma, not a umt5)', () => {
    const args = buildSdVideoArgs(C, input(), OUT, { row: row() })
    expect(valueOf(args, '--llm')).toBe(C.llm)
    expect(args).not.toContain('--t5xxl')
    expect(args).not.toContain('--qwen2vl')   // the deprecated alias
    expect(args).not.toContain('--clip_vision')
  })

  it('is the full command upstream ships, with THIS checkpoint\'s numbers', () => {
    const args = buildSdVideoArgs(C, input(), OUT, { row: row() })
    expect(args.slice(0, 2)).toEqual(['-M', 'vid_gen'])
    expect(valueOf(args, '--diffusion-model')).toBe(C.diffusion)
    expect(valueOf(args, '--vae')).toBe(C.vae)
    expect(valueOf(args, '-W')).toBe('1280')
    expect(valueOf(args, '-H')).toBe('704')
    expect(valueOf(args, '--video-frames')).toBe('49')
    expect(valueOf(args, '--fps')).toBe('24')
    expect(valueOf(args, '--cfg-scale')).toBe('1')
    expect(valueOf(args, '--steps')).toBe('8')
    expect(valueOf(args, '--sampling-method')).toBe('euler')
    expect(args).toContain('--offload-to-cpu')
    expect(args.slice(-2)).toEqual(['-o', OUT])
  })

  it('passes NO --scheduler and NO --flow-shift, so the engine\'s own stand', () => {
    const args = buildSdVideoArgs(C, input(), OUT, { row: row() })
    expect(args).not.toContain('--scheduler')
    expect(args).not.toContain('--flow-shift')
  })

  it('passes NO high-noise flags — they configure a pass that does not exist', () => {
    const args = buildSdVideoArgs(C, input(), OUT, { row: row() })
    for (const f of ['--high-noise-diffusion-model', '--high-noise-steps', '--high-noise-cfg-scale', '--high-noise-sampling-method']) {
      expect(args, f).not.toContain(f)
    }
  })

  it('renders text→video with no frame, image→video with one', () => {
    expect(buildSdVideoArgs(C, input(), OUT, { row: row() })).not.toContain('-i')
    const i2v = buildSdVideoArgs(C, input({ initImagePath: 'C:/in/frame.png' }), OUT, { row: row() })
    expect(valueOf(i2v, '-i')).toBe('C:/in/frame.png')
  })

  it('i2v OFFERS the init frame and never requires it', () => {
    expect(ltx().i2v).toBe(true)
  })

  it('FLF is NOT claimed: --end-img exists upstream and this row does not emit it', () => {
    // docs/ltx2.md ships a worked FLF2V command (`--init-img` + `--end-img`),
    // so the capability is real at our pin — but nothing in our video input
    // carries an end frame, so the row ships t2v + i2v only and must not be
    // read as promising first/last-frame.
    const client = read('electron/services/sd-cpp-client.ts')
    expect(client).not.toContain('--end-img')
  })
})

// ═══ 7. THE SCHEMA THE ROW PRODUCES ══════════════════════════════════════════

describe('the composer options this row derives', () => {
  const spec = (name: string) => modelParamSchema('video', ID).find(s => s.name === name)

  it('offers its own 720p tier and defaults to it', () => {
    const res = spec('resolution')!
    expect(res.enum).toEqual(['480p', '720p'])
    expect(res.default).toBe('720p')
    expect(res.description).toContain('1280x704')
  })

  it('the duration slider carries BOTH the rate and the frame law', () => {
    const dur = spec('duration')!
    // 81 frames is a COUNT: ~3 s at 24 fps.
    expect(dur).toMatchObject({ min: 1, max: 3, default: 2, fps: 24, frameGrid: 8 })
  })

  it('DROPS the guidance slider — at cfg 1 it would move nothing', () => {
    // localGenOptionsFor keys `inert` off row.cfgScale <= 1, so this is the
    // z-image treatment arriving on a video row for free.
    expect(spec('cfg')).toBeUndefined()
  })

  it('says the negative prompt does nothing here, and pre-fills it EMPTY', () => {
    const neg = spec('negative_prompt')!
    expect(neg.default).toBe('')
    expect(neg.description).toMatch(/no effect|does nothing/i)
  })

  it('offers the init frame without requiring it', () => {
    const img = spec('image_url')!
    expect(img).toBeDefined()
    expect(img.required).toBeFalsy()
    expect(img.label).toBe('Init frame (image→video)')
  })

  it('the steps slider is centred on 8, this checkpoint\'s own budget', () => {
    expect(spec('steps')!.default).toBe(8)
  })
})

// ═══ 8. THE LICENCE SURFACE ══════════════════════════════════════════════════
//
// The product minimum, and the whole reason this row could ship: a user is told
// the licence NAME and given the LINK before they press a button that fetches
// 20.8 GB, plus the one term that can actually disqualify them (the $10M
// revenue threshold above which Lightricks require a paid licence).

describe('a row can state the licence it lands under', () => {
  it('LTX names the LTX-2 Community License and links the agreement', () => {
    expect(ltx().licenseName).toBe('LTX-2 Community License')
    // The link the SOURCE REPOS themselves declare (`license_link` on both
    // Lightricks/LTX-2.3 and unsloth/LTX-2.3-GGUF, read off the HF API).
    expect(ltx().licenseUrl).toBe('https://github.com/Lightricks/LTX-2/blob/main/LICENSE')
  })

  it('the notes carry the threshold, the acceptance, and the Gemma half', () => {
    const n = ltx().notes!
    expect(n).toMatch(/\$10 ?million|\$10,000,000/)
    expect(n).toMatch(/accept/i)          // downloading = accepting their terms
    expect(n).toMatch(/Gemma/)            // the encoder is under its own terms
  })

  it('…and the RAM bar, honestly, with no borrowed wall-clock', () => {
    const n = ltx().notes!
    expect(n).toMatch(/32 GB/)
    expect(n).toMatch(/pagefile/i)
    // House rule: no third-party timing quoted as ours.
    expect(n).toMatch(/not (yet )?(been )?(timed|measured)|unmeasured|tens of minutes/i)
    expect(n).not.toMatch(/ComfyUI/)
  })

  it('the Apache rows say so too — cheap honesty, same two fields', () => {
    for (const m of SD_VIDEO_MODELS.filter(m => m.family === 'wan')) {
      expect(m.licenseName, m.id).toBe('Apache-2.0')
      expect(m.licenseUrl, m.id).toBe('https://www.apache.org/licenses/LICENSE-2.0')
    }
    const z = SD_IMAGE_MODELS.find(m => m.id === 'z-image-turbo')!
    expect(z.licenseName).toBe('Apache-2.0')
    expect(z.licenseUrl).toBe('https://www.apache.org/licenses/LICENSE-2.0')
  })

  it('a row that declares a name must declare a resolvable https URL', () => {
    for (const m of [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS]) {
      if (!m.licenseName) continue
      expect(m.licenseUrl, m.id).toMatch(/^https:\/\//)
    }
  })

  it('EVERY curated row answers the question except the one whose source does not', () => {
    // The point of filling the field in everywhere: silence then MEANS
    // something. stabilityai/sd-turbo declares no `license`, no `license_name`
    // and no `license:` tag at all on the HF model API — so naming one would be
    // this app asserting a licence its source never granted. Every other row
    // was read off that same field and says so.
    const unanswered = [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS].filter(m => !m.licenseName).map(m => m.id)
    expect(unanswered).toEqual(['sd-turbo'])
    // …and the file records WHY, so the next lane does not "fix" it by guessing.
    const rows = read('electron/services/sd-cpp-models.ts')
    expect(rows).toMatch(/sd-turbo's model card front matter declares\s*\n?\s*\/\/ NOTHING/)
  })

  it('sdRowLicense is BOTH FIELDS OR NEITHER, and https only', () => {
    // A name with no link is a claim the user cannot check; a link with no name
    // is a bare URL under a download button. And the url is handed straight to
    // shell.openExternal, which will launch whatever protocol handler a
    // `file:` / custom scheme names — so the scheme is checked, not assumed.
    expect(sdRowLicense({ licenseName: 'Apache-2.0', licenseUrl: 'https://x.test/l' }))
      .toEqual({ name: 'Apache-2.0', url: 'https://x.test/l' })
    expect(sdRowLicense({ licenseName: 'Apache-2.0' })).toBeNull()
    expect(sdRowLicense({ licenseUrl: 'https://x.test/l' })).toBeNull()
    expect(sdRowLicense({})).toBeNull()
    expect(sdRowLicense({ licenseName: '  ', licenseUrl: 'https://x.test/l' })).toBeNull()
    expect(sdRowLicense({ licenseName: 'X', licenseUrl: 'http://x.test/l' })).toBeNull()
    expect(sdRowLicense({ licenseName: 'X', licenseUrl: 'file:///etc/passwd' })).toBeNull()
    // …and every shipped row survives its own gate, which is the point.
    for (const m of [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS]) {
      if (!m.licenseName) continue
      expect(sdRowLicense(m), m.id).not.toBeNull()
    }
  })

  it('the CATALOG IPC carries both fields to the renderer', () => {
    // Without this the download panel cannot render what the row knows, which
    // is exactly the gap the blocked row named ("no way to surface a licence").
    const ipc = read('electron/ipc/sd-cpp.ipc.ts')
    expect(ipc).toContain('licenseName: m.licenseName')
    expect(ipc).toContain('licenseUrl: m.licenseUrl')
    const dts = read('src/types/electron.d.ts')
    expect(dts).toContain('licenseName?: string')
    expect(dts).toContain('licenseUrl?: string')
  })

  it('the download panel renders the name as an EXTERNAL link, not a tooltip', () => {
    // A tooltip is where `notes` lives; a licence a user is accepting has to be
    // readable without hovering, and openable. The house idiom for an outbound
    // link in the renderer is shell.openExternal, never <a href>.
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('sdRowLicense')
    expect(page).toMatch(/shell\.openExternal\(\s*lic\.url\s*\)/)
    expect(page).toContain("t('local.modelLicense'")
  })

  it('the copy exists in every locale', () => {
    for (const loc of ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']) {
      const json = JSON.parse(read(`src/i18n/locales/${loc}/media.json`))
      expect(json.local.modelLicense, loc).toBeTruthy()
      expect(String(json.local.modelLicense), loc).toContain('{{name}}')
    }
  })
})

// ═══ 9. THE REGRESSION PIN ═══════════════════════════════════════════════════

describe('nothing about the Wan rows moved', () => {
  it('the 1.3B argv is byte-identical to before this lane', () => {
    const args = buildSdVideoArgs(
      { diffusion: 'C:/w/d.gguf', vae: 'C:/w/v.safetensors', t5xxl: 'C:/w/t5.gguf' },
      { modelId: 'wan21-t2v-1.3b', prompt: 'a lovely cat' },
      OUT, { row: findSdRow('wan21-t2v-1.3b', [])! },
    )
    expect(valueOf(args, '--fps')).toBe(String(DEFAULT_VIDEO_FPS))
    expect(valueOf(args, '-W')).toBe('832')
    expect(valueOf(args, '-H')).toBe('480')
    expect(valueOf(args, '--video-frames')).toBe('33')
    expect(valueOf(args, '--cfg-scale')).toBe('6')
    expect(valueOf(args, '--steps')).toBe('20')
  })

  it('a row-less run still keeps the Wan defaults, not sd-cli\'s', () => {
    const args = buildSdVideoArgs({ diffusion: 'd' }, { modelId: 'nope', prompt: 'p', frames: 45 }, OUT, {})
    expect(valueOf(args, '--fps')).toBe(String(DEFAULT_VIDEO_FPS))
    expect(valueOf(args, '--video-frames')).toBe('45')   // 4n+1, the default law
  })

  it('the 2.2 5B row keeps its own 32 grid and 24 fps', () => {
    const ti2v = SD_VIDEO_MODELS.find(m => m.id === 'wan22-ti2v-5b')!
    expect(ti2v.pixelGrid).toBe(32)
    expect(ti2v.fps).toBe(24)
    expect(ti2v.frameGrid).toBeUndefined()
    expect(DEFAULT_VIDEO_PIXEL_GRID).toBe(16)
  })
})
