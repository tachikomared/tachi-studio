// apps/desktop/test/unit/sdBatchHiresTiers.test.ts
//
// THREE CAPABILITIES THE LOCAL IMAGE ROUTE HAD CONTROLS FOR AND NO WIRE TO.
//
//   1. BATCH COUNT. The composer's "Images: 1–4" (`n`) was DELIBERATELY HIDDEN,
//      with the reason written into surplus-media-service: buildSdArgs emitted no
//      `--batch-count` and nothing forwarded `n`, so setting 4 got you 1. Hiding
//      it was the honest move at the time; wiring it is the fix.
//   2. THE TWO-PASS. `--hires` runs the low-res sample, upscales the LATENT and
//      re-denoises INSIDE THE SAME INVOCATION — one model load, one VAE decode,
//      and the second pass reads the first one's latent rather than a re-encoded
//      PNG. The app could already express "generate small, then img2img big" by
//      hand; that pays the load twice and loses the latent in between.
//   3. ORIENTATION. Every LOCAL_IMAGE_SIZES tier was WxW, so the local route
//      could not produce a landscape or a portrait at all — which is why
//      `aspect_ratio` had to be dropped from the local schema to stop it lying.
//
// ── EVERY ENGINE FACT BELOW IS SOURCE-ASSERTED, NOT ASSUMED ──────────────────
//
// The pinned binary is stable-diffusion.cpp master-782-b290693 (the one the
// installer places, `sd-cli --help` reports commit b290693). Probes run against
// it directly, with the sd-turbo checkpoint the app itself downloads:
//
//   $ sd-cli -m …/sd-turbo/model.safetensors -p "a red cube" -W 256 -H 256 \
//            --steps 1 --cfg-scale 1 --sampling-method euler -s 42 -b 3 -o ./out.png
//     stable-diffusion.cpp:5321 - generating image: 1/3 - seed 42
//     stable-diffusion.cpp:5321 - generating image: 2/3 - seed 43
//     stable-diffusion.cpp:5321 - generating image: 3/3 - seed 44
//     main.cpp:490 - save result image 0 to './out_0.png' (success)
//     main.cpp:490 - save result image 1 to './out_1.png' (success)
//     main.cpp:490 - save result image 2 to './out_2.png' (success)
//     main.cpp:562 - 3/3 images saved
//   $ grep -ao "Seed: [0-9]*" out_0.png out_1.png out_2.png
//     out_0.png: Seed: 42   out_1.png: Seed: 43   out_2.png: Seed: 44
//
//   …the same run with `-s -1`: seeds 18002 / 18003 / 18004 (ONE random base,
//   incremented — a batch is not N independent draws), each again in its own
//   file's own `parameters` chunk.
//
//   …and with `-b 1`: `save result image 0 to './one.png'`, i.e. exactly the
//   path `-o` named, with no `_0` suffix. THE FILENAME RULE IS CONDITIONAL, and
//   getting it wrong is silent in both directions: read `-o` back after a batch
//   and there is no file at all, read `_0` back after a single and the same.
//
//   $ sd-cli … -s 42 --hires --hires-scale 2 --hires-steps 3 \
//              --hires-denoising-strength 0.5 -o ./hires.png   (256x256 base)
//     stable-diffusion.cpp:5378 - hires fix: upscaling to 512x512
//     stable-diffusion.cpp:5414 - hires fix: scheduler_steps=6, denoising_strength=0.50
//     stable-diffusion.cpp:5131 - hires Latent upscale 32x32 -> 64x64
//   → a 512x512 PNG whose own chunk reads "Size: 256x256 … Hires scale: 2.0",
//   which is why TachiGenMeta keeps width/height as the BASE and records the
//   factor beside them: that is the engine's own convention on the same file.
//
//   $ sd-cli --diffusion-model …/z-image-turbo/diffusion.gguf --llm … --vae … \
//            -W 1216 -H 832 …
//     stable-diffusion.cpp:5270 - generate_image 1216x832   → a 1216x832 PNG
//   (the oriented tiers are on a 64px grid, which every shipped family accepts —
//   Z-Image is the DiT that would have been the one to complain.)

import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdbatch-'))
})
afterAll(() => {
  try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
})
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  buildSdArgs, effectiveImageParams, collectSdImages,
  normalizeBatchCount, sdBatchOutputPath, sdBatchOutputPaths, sdBatchSeedRequest,
  parseSdSeed, parseSdSeedSequence,
  type SdGenerateInput, type TachiGenMeta,
} from '../../electron/services/sd-cpp-client'
import { findSdRow, SD_IMAGE_MODELS } from '../../electron/services/sd-cpp-models'
import { modelParamSchema } from '../../electron/services/surplus-media-service'
import {
  resolveLocalBatch, resolveLocalHires, normalizeHiresScale, stampLocalEngineParams, localImagesOf,
  parseSizeParam, resolveLocalSdSize, reseedRecipeParams, LOCAL_ROW_OWNED_PARAMS,
  SD_BATCH_MAX, SD_HIRES_SCALE_MIN, SD_HIRES_SCALE_MAX, SD_HIRES_SCALE_DEFAULT,
} from '../../src/pages/media/localGenParams'
import { embedTextChunk, readTextChunks } from '../../electron/services/util/png-text'

const TMP = mkdtempSync(join(tmpdir(), 'tachi-sdbatch-files-'))
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ } })

/** The 3-line log the probe above produced, verbatim in shape. */
const BATCH_LOG = [
  '[INFO ] stable-diffusion.cpp:5321 - generating image: 1/3 - seed 18002',
  '  |==================================================| 1/1 - 41.71it/s',
  '[INFO ] stable-diffusion.cpp:5321 - generating image: 2/3 - seed 18003',
  '[INFO ] stable-diffusion.cpp:5321 - generating image: 3/3 - seed 18004',
  '[INFO ] main.cpp:562  - 3/3 images saved',
].join('\n')

// ═══ 1. THE ENGINE FACTS, as pure functions ══════════════════════════════════

describe('sdBatchOutputPath — the filename rule is CONDITIONAL on the count', () => {
  it('a single image is written to exactly the path -o named', () => {
    // Verified: `-b 1 -o ./one.png` → `save result image 0 to './one.png'`.
    expect(sdBatchOutputPath('C:\\out\\sd-1.png', 0, 1)).toBe('C:\\out\\sd-1.png')
    expect(sdBatchOutputPaths('C:\\out\\sd-1.png', 1)).toEqual(['C:\\out\\sd-1.png'])
  })

  it('a batch splices _0 … _{N-1} in before the extension, 0-based', () => {
    expect(sdBatchOutputPaths('C:\\out\\sd-1.png', 3)).toEqual([
      'C:\\out\\sd-1_0.png', 'C:\\out\\sd-1_1.png', 'C:\\out\\sd-1_2.png',
    ])
    // …and never the un-suffixed name, which the engine does NOT write.
    expect(sdBatchOutputPaths('C:\\out\\sd-1.png', 3)).not.toContain('C:\\out\\sd-1.png')
  })

  it('a dot in a DIRECTORY name is not the extension', () => {
    expect(sdBatchOutputPath('C:\\Tachi 1.0\\out\\file', 2, 3)).toBe('C:\\Tachi 1.0\\out\\file_2')
    expect(sdBatchOutputPath('/home/a.b/out/file.png', 1, 2)).toBe('/home/a.b/out/file_1.png')
  })
})

describe('normalizeBatchCount — one clamp, shared by the argv and the collector', () => {
  it('anything unusable is one image', () => {
    for (const bad of [undefined, null, NaN, 0, -3, 'four', {}]) {
      expect(normalizeBatchCount(bad as unknown)).toBe(1)
    }
  })

  it('honours a real count and clamps to the ceiling the control offers', () => {
    expect(normalizeBatchCount(2)).toBe(2)
    expect(normalizeBatchCount(SD_BATCH_MAX)).toBe(SD_BATCH_MAX)
    expect(normalizeBatchCount(400)).toBe(SD_BATCH_MAX)
    expect(normalizeBatchCount(2.7)).toBe(2)
  })
})

describe('parseSdSeedSequence — the whole batch, positionally', () => {
  it('reads one seed per image, in the order the engine sampled them', () => {
    expect(parseSdSeedSequence(BATCH_LOG)).toEqual([18002, 18003, 18004])
  })

  it('THE BUG IT EXISTS FOR: parseSdSeed answers with the LAST one', () => {
    // That rule is correct for its own question ("which seed made the ONE file we
    // just read") and catastrophic for a batch: every image would be stamped
    // 18004, i.e. three files claiming a seed that reproduces only the third.
    expect(parseSdSeed({ log: BATCH_LOG })).toBe(18004)
    expect(parseSdSeedSequence(BATCH_LOG)[0]).toBe(18002)
  })

  it('says nothing rather than guessing, and never accepts a negative', () => {
    expect(parseSdSeedSequence(undefined)).toEqual([])
    expect(parseSdSeedSequence(null)).toEqual([])
    expect(parseSdSeedSequence('')).toEqual([])
    expect(parseSdSeedSequence('loading model from seed.gguf')).toEqual([])
    expect(parseSdSeedSequence('- generating image: 1/1 - seed -1')).toEqual([])
  })

  it('tolerates the video wording of the same line', () => {
    expect(parseSdSeedSequence('- generating video: 1/1 - seed 4242')).toEqual([4242])
  })
})

describe('sdBatchSeedRequest — the engine\'s own increment, as a LAST resort', () => {
  it('a concrete request shifts by the image index (verified: 42 → 42/43/44)', () => {
    expect([0, 1, 2].map(i => sdBatchSeedRequest(42, i))).toEqual([42, 43, 44])
    expect(sdBatchSeedRequest(0, 3)).toBe(3)
  })

  it('"pick one for me" has nothing to shift', () => {
    expect(sdBatchSeedRequest(-1, 2)).toBe(-1)
    expect(sdBatchSeedRequest(undefined, 2)).toBeUndefined()
  })
})

// ═══ 2. THE ARGV ═════════════════════════════════════════════════════════════

describe('buildSdArgs — -b and --hires', () => {
  const COMPONENTS = { model: 'm.safetensors' }
  const base: SdGenerateInput = { modelId: 'sd-turbo', prompt: 'a lighthouse' }
  const env = () => ({ row: findSdRow('sd-turbo') })
  const args = (input: SdGenerateInput) => buildSdArgs(COMPONENTS, input, 'C:\\out\\sd.png', env())
  const flag = (a: string[], name: string) => { const i = a.indexOf(name); return i < 0 ? undefined : a[i + 1] }

  it('a one-image, one-pass run is byte-identical to before either flag existed', () => {
    const a = args(base)
    expect(a).not.toContain('-b')
    expect(a).not.toContain('--hires')
    expect(a).not.toContain('--hires-scale')
  })

  it('emits --batch-count only above 1, at the clamped count', () => {
    expect(args({ ...base, batchCount: 1 })).not.toContain('-b')
    expect(flag(args({ ...base, batchCount: 4 }), '-b')).toBe('4')
    expect(flag(args({ ...base, batchCount: 99 }), '-b')).toBe(String(SD_BATCH_MAX))
  })

  it('the count in the argv is the count the collector reads back', () => {
    // One normalizer, so "did it emit -b" and "which files exist" cannot disagree.
    const n = normalizeBatchCount(99)
    expect(flag(args({ ...base, batchCount: 99 }), '-b')).toBe(String(n))
    expect(sdBatchOutputPaths('C:\\out\\sd.png', n)).toHaveLength(n)
  })

  it('emits --hires + --hires-scale when the toggle is on', () => {
    const a = args({ ...base, hires: true })
    expect(a).toContain('--hires')
    expect(flag(a, '--hires-scale')).toBe(String(SD_HIRES_SCALE_DEFAULT))
  })

  it('a scale WITHOUT the toggle emits nothing — the toggle is the gate', () => {
    // `hires_scale` sits in the persisted bag forever once the disclosure has been
    // opened; sending it alone would be a flag the engine ignores, and sending
    // `--hires` because it is there would double every render silently.
    const a = args({ ...base, hiresScale: 1.5 })
    expect(a).not.toContain('--hires')
    expect(a).not.toContain('--hires-scale')
  })

  it('an off-band scale is clamped ONCE, and the argv carries the clamped number', () => {
    expect(flag(args({ ...base, hires: true, hiresScale: 9 }), '--hires-scale')).toBe(String(SD_HIRES_SCALE_MAX))
    expect(flag(args({ ...base, hires: true, hiresScale: 1 }), '--hires-scale')).toBe(String(SD_HIRES_SCALE_MIN))
  })

  it('the two flags compose (a 4-image two-pass sweep is one invocation)', () => {
    const a = args({ ...base, batchCount: 3, hires: true, hiresScale: 1.5 })
    expect(flag(a, '-b')).toBe('3')
    expect(flag(a, '--hires-scale')).toBe('1.5')
  })

  it('-o stays LAST, so the output path is never mistaken for a flag value', () => {
    const a = args({ ...base, batchCount: 3, hires: true })
    expect(a[a.length - 2]).toBe('-o')
    expect(a[a.length - 1]).toBe('C:\\out\\sd.png')
  })

  it('the stamp and the argv cannot disagree about the second pass', () => {
    const input: SdGenerateInput = { ...base, hires: true, hiresScale: 1.7 }
    const eff = effectiveImageParams(input, env())
    const a   = args(input)
    expect(eff.hires).toBe(true)
    expect(flag(a, '--hires-scale')).toBe(String(eff.hiresScale))
    // 1.7 snaps onto the control's own 0.25 step — and BOTH surfaces say 1.75.
    expect(eff.hiresScale).toBe(1.75)
  })

  it('a one-pass run reports no hires at all — absent, never `false`', () => {
    const eff = effectiveImageParams(base, env())
    expect('hires' in eff).toBe(false)
    expect('hiresScale' in eff).toBe(false)
  })
})

describe('normalizeHiresScale — the band the control offers', () => {
  it('snaps to the step, clamps to the band, and defaults for garbage', () => {
    expect(normalizeHiresScale(1.3)).toBe(1.25)
    expect(normalizeHiresScale(1.6)).toBe(1.5)
    expect(normalizeHiresScale(2)).toBe(2)
    expect(normalizeHiresScale(10)).toBe(SD_HIRES_SCALE_MAX)
    expect(normalizeHiresScale(0)).toBe(SD_HIRES_SCALE_MIN)
    expect(normalizeHiresScale('1.5')).toBe(1.5)
    for (const bad of [undefined, null, NaN, 'big', {}]) {
      expect(normalizeHiresScale(bad)).toBe(SD_HIRES_SCALE_DEFAULT)
    }
  })
})

// ═══ 3. THE COMPOSER'S BAG → THE IPC ═════════════════════════════════════════

describe('resolveLocalBatch / resolveLocalHires — schema names in, IPC names out', () => {
  it('`n` becomes batchCount, and 1 adds no key at all', () => {
    expect(resolveLocalBatch({})).toEqual({})
    expect(resolveLocalBatch({ n: 1 })).toEqual({})
    expect(resolveLocalBatch({ n: 4 })).toEqual({ batchCount: 4 })
    expect(resolveLocalBatch({ n: '3' })).toEqual({ batchCount: 3 })
    expect(resolveLocalBatch({ n: 99 })).toEqual({ batchCount: SD_BATCH_MAX })
    expect(resolveLocalBatch({ n: 'four' })).toEqual({})
  })

  it('`hires` + `hires_scale` become hires + hiresScale, gated on the toggle', () => {
    expect(resolveLocalHires({})).toEqual({})
    expect(resolveLocalHires({ hires: false, hires_scale: 2 })).toEqual({})
    expect(resolveLocalHires({ hires_scale: 2 })).toEqual({})
    expect(resolveLocalHires({ hires: true })).toEqual({ hires: true, hiresScale: SD_HIRES_SCALE_DEFAULT })
    expect(resolveLocalHires({ hires: true, hires_scale: 1.5 })).toEqual({ hires: true, hiresScale: 1.5 })
    expect(resolveLocalHires({ hires: true, hires_scale: 99 })).toEqual({ hires: true, hiresScale: SD_HIRES_SCALE_MAX })
  })

  it('the spread adds NO key when nothing was asked — the byte-identical rule', () => {
    const call = { modelId: 'sd-turbo', ...resolveLocalBatch({}), ...resolveLocalHires({}) }
    expect(Object.keys(call)).toEqual(['modelId'])
  })
})

describe('localImagesOf — the renderer seam that must not drop three renders', () => {
  it('a batch is N images, each with its OWN seed', () => {
    const r = {
      path: 'a_0.png', b64: 'AAA', mime: 'image/png', seed: 18002,
      images: [
        { path: 'a_0.png', b64: 'AAA', mime: 'image/png', seed: 18002 },
        { path: 'a_1.png', b64: 'BBB', mime: 'image/png', seed: 18003 },
        { path: 'a_2.png', b64: 'CCC', mime: 'image/png', seed: 18004 },
      ],
    }
    expect(localImagesOf(r).map(i => i.seed)).toEqual([18002, 18003, 18004])
    expect(localImagesOf(r).map(i => i.path)).toEqual(['a_0.png', 'a_1.png', 'a_2.png'])
  })

  it('an OLD result (flat fields only) still yields its one image', () => {
    // A main process from before this change, or a mocked IPC in a test.
    expect(localImagesOf({ path: 'a.png', b64: 'AAA', mime: 'image/png', seed: 7 }))
      .toEqual([{ path: 'a.png', b64: 'AAA', mime: 'image/png', seed: 7 }])
    expect(localImagesOf({ b64: 'AAA' })).toEqual([{ b64: 'AAA', mime: 'image/png' }])
  })

  it('nothing to show is [] — the caller raises the run\'s own error', () => {
    expect(localImagesOf({})).toEqual([])
    expect(localImagesOf({ b64: '' })).toEqual([])
    expect(localImagesOf({ images: [] })).toEqual([])
  })

  it('the flat fields and images[0] are the same image (the back-compat rule)', () => {
    const paths  = layOutRun([41, 42])
    const images = collectSdImages(paths, { input: INPUT, effective: EFFECTIVE })
    const asIpcReturns = { path: images[0].path, b64: images[0].b64, mime: images[0].mime, seed: images[0].seed, images }
    expect(localImagesOf(asIpcReturns)).toHaveLength(2)
    expect(localImagesOf(asIpcReturns)[0].seed).toBe(asIpcReturns.seed)
  })
})

describe('stampLocalEngineParams — the entry records the second pass', () => {
  it('writes the COMPOSER\'s key names, so Remix reads them back', () => {
    const out = stampLocalEngineParams({ steps: 20 }, {
      steps: 8, cfgScale: 1, samplingMethod: 'euler', hires: true, hiresScale: 1.5,
    })
    expect(out).toMatchObject({ steps: 8, cfg: 1, sampler: 'euler', hires: true, hires_scale: 1.5 })
  })

  it('a one-pass run leaves the keys ABSENT rather than writing false', () => {
    const out = stampLocalEngineParams({}, { steps: 8, cfgScale: 1, samplingMethod: 'euler' })
    expect('hires' in out).toBe(false)
    expect('hires_scale' in out).toBe(false)
  })
})

// ═══ 4. THE ROUND TRIP: per-image seed through the tEXt chunk ════════════════

/** The smallest byte string embedTextChunk / readTextChunks accept as a PNG: the
 *  signature and a real IEND (length 0, correct CRC). The pixels are irrelevant
 *  — this section is about the CHUNK, and committing three 130 KB renders to
 *  assert a text splice would be a binary fixture for a string test. */
function emptyPng(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,   // signature
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,   // len 0 + "IEND"
    0xae, 0x42, 0x60, 0x82,                           // IEND CRC
  ])
}

/** sd.cpp's own `parameters` chunk, in the shape the probe read back off disk. */
function engineChunk(seed: number, size = '512x512'): string {
  return `a red cube\nSteps: 1, CFG scale: 1.000000, Seed: ${seed}, Size: ${size}, `
    + 'Model: model.safetensors, RNG: cuda, Sampler: euler discrete, Version: stable-diffusion.cpp'
}

/** …the SAME chunk with the `, SDCPP: {json}` tail the engine really appends
 *  (common.cpp:3007 / build_sdcpp_image_metadata_json at :2737), which ECHOES
 *  THE PROMPT after the genuine `Seed:` field. */
function engineChunkWithTail(seed: number, prompt: string): string {
  return `${prompt}\nSteps: 1, CFG scale: 1.000000, Seed: ${seed}, Size: 512x512, `
    + 'Model: model.safetensors, RNG: cuda, Sampler: euler discrete, Version: stable-diffusion.cpp'
    + ', SDCPP: ' + JSON.stringify({
      schema: 'sdcpp.image.params/v1', mode: 'img_gen',
      generator: { name: 'stable-diffusion.cpp', version: 'master', commit: 'b290693' },
      seed, width: 512, height: 512,
      prompt: { positive: prompt, negative: '' },
      models: { model: 'model.safetensors' },
    })
}

let caseId = 0
/** Lay out one finished run on disk: N files at the paths sd-cli would have
 *  written, each carrying `seeds[i]` in its own engine chunk (null = the engine
 *  wrote no metadata, i.e. --disable-image-metadata or an older build). */
function layOutRun(seeds: Array<number | null>): string[] {
  const outPath = join(TMP, `run-${caseId++}.png`)
  const paths = sdBatchOutputPaths(outPath, seeds.length)
  paths.forEach((p, i) => {
    const seed = seeds[i]
    writeFileSync(p, seed === null ? emptyPng() : embedTextChunk(emptyPng(), 'parameters', engineChunk(seed)))
  })
  return paths
}

const metaOf = (path: string): TachiGenMeta =>
  JSON.parse(readTextChunks(readFileSync(path)).get('tachi-gen')!) as TachiGenMeta

const INPUT: SdGenerateInput = { modelId: 'sd-turbo', prompt: 'a red cube', seed: -1, width: 512, height: 512 }
const EFFECTIVE = { steps: 1, cfgScale: 1, samplingMethod: 'euler' }

describe('collectSdImages — N files, N REAL seeds, N chunks', () => {
  it('THE GATE: each image carries the seed from ITS OWN file, in order', () => {
    const paths  = layOutRun([18002, 18003, 18004])
    const images = collectSdImages(paths, { input: INPUT, effective: EFFECTIVE, engineLog: BATCH_LOG })

    expect(images).toHaveLength(3)
    expect(images.map(i => i.seed)).toEqual([18002, 18003, 18004])
    expect(images.map(i => i.path)).toEqual(paths)
    // …and the round trip: the number is IN the file we hand back, readable by
    // the restore-from-PNG path, per image.
    expect(paths.map(p => metaOf(p).seed)).toEqual([18002, 18003, 18004])
    // Three distinct seeds — the single-seed lie, in the form it would have taken.
    expect(new Set(images.map(i => i.seed)).size).toBe(3)
    expect(images[0].seed).not.toBe(parseSdSeed({ log: BATCH_LOG }))
  })

  it('every image comes back with real bytes and its mime, not just a path', () => {
    const images = collectSdImages(layOutRun([7, 8]), { input: INPUT, effective: EFFECTIVE })
    for (const img of images) {
      expect(img.mime).toBe('image/png')
      expect(Buffer.from(img.b64, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      // The b64 is the file AFTER the stamp — a renderer that saves it must be
      // saving provenance, not the pre-metadata bytes.
      expect(readTextChunks(Buffer.from(img.b64, 'base64')).has('tachi-gen')).toBe(true)
    }
  })

  it('stamps WHICH image of how many — but only when there was a batch', () => {
    const paths = layOutRun([1, 2, 3])
    collectSdImages(paths, { input: INPUT, effective: EFFECTIVE })
    expect(paths.map(p => metaOf(p).batchIndex)).toEqual([0, 1, 2])
    expect(paths.map(p => metaOf(p).batchCount)).toEqual([3, 3, 3])

    const single = layOutRun([99])
    collectSdImages(single, { input: INPUT, effective: EFFECTIVE })
    const m = metaOf(single[0])
    expect(m.seed).toBe(99)
    expect('batchIndex' in m).toBe(false)   // one image is not "1 of 1"
    expect('batchCount' in m).toBe(false)
  })

  it('falls back to the LOG line for THIS index when the engine wrote no chunk', () => {
    const paths  = layOutRun([null, null, null])
    const images = collectSdImages(paths, { input: INPUT, effective: EFFECTIVE, engineLog: BATCH_LOG })
    expect(images.map(i => i.seed)).toEqual([18002, 18003, 18004])
  })

  it('…and to the REQUEST, shifted the way the engine shifts it', () => {
    const paths  = layOutRun([null, null, null])
    const images = collectSdImages(paths, { input: { ...INPUT, seed: 100 }, effective: EFFECTIVE })
    expect(images.map(i => i.seed)).toEqual([100, 101, 102])
  })

  it('a -1 request with nothing to read stays -1 on every image', () => {
    // The honest "we do not know" — NOT -1, 0, 1, which would be three numbers
    // nothing ran at, written into provenance as fact.
    const paths  = layOutRun([null, null])
    const images = collectSdImages(paths, { input: INPUT, effective: EFFECTIVE })
    expect(images.map(i => i.seed)).toEqual([-1, -1])
  })

  it('the FILE out-votes the log, per image', () => {
    // The chunk was written by the code that seeded that sampler; the log is a
    // line about a run. If they disagree, the file is what happened.
    const paths  = layOutRun([500, 501, 502])
    const images = collectSdImages(paths, { input: INPUT, effective: EFFECTIVE, engineLog: BATCH_LOG })
    expect(images.map(i => i.seed)).toEqual([500, 501, 502])
  })

  it('A HOSTILE PROMPT CANNOT SET THE SEED, on real bytes, per image of a batch', () => {
    // THE BUG, end to end. Upstream appends `, SDCPP: {json}` to the SAME
    // `parameters` string (common.cpp:3007), and that JSON echoes the prompt —
    // AFTER the genuine `Seed:` field. Our last-match-wins parse therefore read
    // the user's own text as the answer: a prompt of "Seed: 999" wrote 999 into
    // every one of these files' tachi-gen chunks, as the seed of an image nothing
    // sampled. Each batch file carries its own chunk, so the trap fires N times.
    const outPath = join(TMP, `run-hostile-${caseId++}.png`)
    const paths   = sdBatchOutputPaths(outPath, 3)
    const seeds   = [18002, 18003, 18004]
    paths.forEach((p, i) => {
      writeFileSync(p, embedTextChunk(emptyPng(), 'parameters', engineChunkWithTail(seeds[i], 'Seed: 999')))
    })
    const images = collectSdImages(paths, {
      input: { ...INPUT, prompt: 'Seed: 999' }, effective: EFFECTIVE, engineLog: BATCH_LOG,
    })
    expect(images.map(i => i.seed)).toEqual(seeds)
    expect(paths.map(p => metaOf(p).seed)).toEqual(seeds)
    // …and 999 is nowhere near any of them.
    expect(paths.map(p => metaOf(p).seed)).not.toContain(999)
  })

  it('a file the engine did not write is SKIPPED, not fatal', () => {
    // `N/N images saved` is the engine's claim. If it wrote 2 of 3, the user gets
    // the 2 that exist — with the seeds of the files they actually are.
    const paths = layOutRun([70, 71, 72])
    rmSync(paths[1])
    const images = collectSdImages(paths, { input: INPUT, effective: EFFECTIVE })
    expect(images.map(i => i.path)).toEqual([paths[0], paths[2]])
    expect(images.map(i => i.seed)).toEqual([70, 72])
  })

  it('nothing on disk at all returns nothing — the caller turns that into an error', () => {
    const paths = layOutRun([1, 2])
    paths.forEach(p => rmSync(p))
    expect(collectSdImages(paths, { input: INPUT, effective: EFFECTIVE })).toEqual([])
  })

  it('the chunk records the recipe AS RUN, per image, from one resolution', () => {
    const paths = layOutRun([11, 12])
    const eff = { steps: 4, cfgScale: 1.5, samplingMethod: 'dpm++2m', scheduler: 'simple' }
    collectSdImages(paths, { input: INPUT, effective: eff })
    for (const p of paths) {
      expect(metaOf(p)).toMatchObject({ steps: 4, cfgScale: 1.5, samplingMethod: 'dpm++2m' })
    }
  })

  it('the two-pass is IN the chunk, with the BASE size beside it', () => {
    // The engine's own convention on the same file: "Size: 256x256 … Hires scale:
    // 2.0" on a 512x512 PNG. width/height are the -W/-H that reproduce it; the
    // factor is what makes the file bigger than they say.
    const paths = layOutRun([21])
    collectSdImages(paths, {
      input: { ...INPUT, width: 1024, height: 1024, hires: true },
      effective: { ...EFFECTIVE, hires: true, hiresScale: 2 },
    })
    expect(metaOf(paths[0])).toMatchObject({ hires: true, hiresScale: 2, width: 1024, height: 1024 })
  })

  it('a one-pass chunk does not carry a hires key at all', () => {
    const paths = layOutRun([22])
    collectSdImages(paths, { input: INPUT, effective: EFFECTIVE })
    expect('hires' in metaOf(paths[0])).toBe(false)
  })

  it('an unwritable file costs the metadata, never the image', () => {
    // A corrupt/locked PNG must not turn a finished render into an error — the
    // embed sits in its own try/catch and the bytes still come back.
    const paths = layOutRun([31])
    writeFileSync(paths[0], Buffer.from('not a png at all'))
    const images = collectSdImages(paths, { input: INPUT, effective: EFFECTIVE })
    expect(images).toHaveLength(1)
    expect(images[0].seed).toBe(-1)                     // nothing to read, honestly
    expect(existsSync(paths[0])).toBe(true)
  })
})

// ═══ 5. ORIENTATION-AWARE TIERS ══════════════════════════════════════════════

/** Every LOCAL image row the app ships, by family. */
const localSizeEnum = (id: string): string[] => modelParamSchema('image', id).find(s => s.name === 'size')?.enum ?? []
const dims = (s: string): [number, number] => { const [w, h] = s.split('x').map(Number); return [w, h] }

describe('the local size tiers carry landscape and portrait', () => {
  const ROWS: Array<[string, string]> = [
    ['sd15',   'sd15'],
    ['sdxl',   'sdxl-base-1.0'],
    ['flux',   'flux-schnell-q4'],
    ['zimage', 'z-image-turbo'],
  ]

  it.each(ROWS)('%s offers a non-square pair at all', (_family, id) => {
    const opts = localSizeEnum(id)
    expect(opts.length).toBeGreaterThan(0)
    expect(opts.some(s => { const [w, h] = dims(s); return w > h })).toBe(true)   // landscape
    expect(opts.some(s => { const [w, h] = dims(s); return h > w })).toBe(true)   // portrait
  })

  it.each(ROWS)('%s mirrors every oriented pair (no one-way shapes)', (_family, id) => {
    const opts = localSizeEnum(id)
    for (const s of opts) {
      const [w, h] = dims(s)
      if (w === h) continue
      expect(opts, s).toContain(`${h}x${w}`)
    }
  })

  it.each(ROWS)('%s stays on the 64px grid and under the ceiling', (_family, id) => {
    for (const s of localSizeEnum(id)) {
      const [w, h] = dims(s)
      expect(w % 64, s).toBe(0)
      expect(h % 64, s).toBe(0)
      expect(Math.max(w, h), s).toBeLessThanOrEqual(2048)
    }
  })

  it.each(ROWS)('%s: every option survives parseSizeParam UNCHANGED', (_family, id) => {
    // THE LOAD-BEARING INVARIANT between the two files. normalizeSdDim snaps to
    // 64 and clamps to 2048, silently — so a tier that was off-grid or over the
    // ceiling would render at a size the dropdown never offered, which is the
    // whole class of bug this lane is closing.
    for (const s of localSizeEnum(id)) {
      const [w, h] = dims(s)
      expect(parseSizeParam(s), s).toEqual({ width: w, height: h })
      expect(resolveLocalSdSize({ size: s }), s).toEqual({ width: w, height: h })
    }
  })

  /** The area of an oriented option ÷ the area of the nearest square tier. */
  const tierRatio = (id: string, s: string): number => {
    const [w, h] = dims(s)
    const squares = localSizeEnum(id).filter(o => { const [a, b] = dims(o); return a === b }).map(o => dims(o)[0])
    const area = w * h
    const nearest = squares.reduce((best, side) =>
      Math.abs(side * side - area) < Math.abs(best * best - area) ? side : best, squares[0])
    return area / (nearest * nearest)
  }

  it('no oriented option is a stealth TIER JUMP (never past ~1.5x its square)', () => {
    // A "landscape" that were 2x the pixels of its own tier would be a resolution
    // change wearing a shape's clothes: the user picks a framing and pays for a
    // bigger render, on a checkpoint that may not survive the size.
    for (const [, id] of ROWS) {
      for (const s of localSizeEnum(id)) {
        if (dims(s)[0] === dims(s)[1]) continue
        expect(tierRatio(id, s), `${id} ${s}`).toBeLessThanOrEqual(1.5)
      }
    }
  })

  it('the DiT/SDXL families\' pairs are their own trained buckets, area-matched', () => {
    // 896x640, 1216x832, 1792x1280 are within a few percent of their squares —
    // they ARE the multi-aspect buckets those families were finetuned on.
    for (const id of ['sdxl-base-1.0', 'flux-schnell-q4', 'z-image-turbo']) {
      for (const s of localSizeEnum(id)) {
        if (dims(s)[0] === dims(s)[1]) continue
        expect(Math.abs(tierRatio(id, s) - 1), `${id} ${s}`).toBeLessThan(0.15)
      }
    }
  })

  it('sd15 is the deliberate exception, and it is the canonical pair', () => {
    // 768x512 / 512x768 is 1.5x the area of 512x512 — and it is THE SD 1.5
    // landscape/portrait, the pair every SD 1.5 UI has shipped since 2022. An
    // area-matched 640x448 would be a technically neater number that nobody
    // asks for, on the one family whose users know exactly what they want.
    expect(localSizeEnum('sd15')).toContain('768x512')
    expect(localSizeEnum('sd15')).toContain('512x768')
    expect(tierRatio('sd15', '768x512')).toBeCloseTo(1.5, 5)
  })

  it('sd15 never exceeds 768 on either axis, in any orientation', () => {
    // 1024 is where SD 1.5 duplicates subjects — the reason its column exists.
    for (const s of localSizeEnum('sd15')) expect(Math.max(...dims(s)), s).toBeLessThanOrEqual(768)
  })

  it('zimage has a column of its OWN, not the substring table\'s square ladder', () => {
    // /z-image|zimage/ in FAMILY_IMAGE_SIZES matched by coincidence of the id and
    // could not carry an orientation. Its landscape is the 1024-tier bucket.
    expect(localSizeEnum('z-image-turbo')).toContain('1216x832')
    expect(localSizeEnum('z-image-turbo')).not.toContain('2048x2048')  // family cap, unchanged
  })

  it('the DEFAULT is still the row\'s native square (the f19ffdd contract)', () => {
    for (const row of SD_IMAGE_MODELS) {
      const spec = modelParamSchema('image', row.id).find(s => s.name === 'size')
      if (!spec) continue
      expect(spec.default, row.id).toBe(`${row.baseSize}x${row.baseSize}`)
    }
  })

  it('a CLOUD image model is untouched — square tiers, as before', () => {
    // The substring table still answers for every hosted id, and nothing there
    // learned about orientation (cloud framing is `aspect_ratio`, which the local
    // schema is the only one that drops).
    for (const s of localSizeEnum('flux-1-dev-hosted')) {
      const [w, h] = dims(s)
      expect(w, s).toBe(h)
    }
  })

  it('aspect_ratio stays dropped on local image — orientation is IN the size', () => {
    expect(modelParamSchema('image', 'sdxl-base-1.0').find(s => s.name === 'aspect_ratio')).toBeUndefined()
    // …and present for the cloud model whose framing really is a ratio.
    expect(modelParamSchema('image', 'flux-1-dev-hosted').find(s => s.name === 'aspect_ratio')).toBeDefined()
  })
})

describe('the model switch still owns `size` — with orientation in play', () => {
  it('a portrait picked on SDXL is re-seeded to sd15\'s native square', () => {
    // The real schemas this time, not fixtures: the re-seed reads the spec
    // DEFAULT, so the tier table and the switch are one contract.
    const sdxl = modelParamSchema('image', 'sdxl-base-1.0')
    const sd15 = modelParamSchema('image', 'sd15')
    const portrait = localSizeEnum('sdxl-base-1.0').find(s => { const [w, h] = dims(s); return h > w })!

    const bag = { prompt: 'a cat', size: portrait }
    expect(sdxl.find(s => s.name === 'size')!.enum).toContain(portrait)

    const { next, reseeded } = reseedRecipeParams(bag, sd15, LOCAL_ROW_OWNED_PARAMS)
    expect(reseeded).toContain('size')
    expect(next.size).toBe('512x512')
    expect(resolveLocalSdSize(next)).toEqual({ width: 512, height: 512 })
  })

  it('and the hires toggle is NOT row-owned — it is the user\'s, across switches', () => {
    // `hires` describes what the USER wants done to the render, not something the
    // checkpoint declares, so no row default may reset it. (`size` is on the list;
    // `hires`/`hires_scale` deliberately are not.)
    expect(LOCAL_ROW_OWNED_PARAMS).not.toContain('hires')
    expect(LOCAL_ROW_OWNED_PARAMS).not.toContain('hires_scale')
    const bag = { prompt: 'a cat', hires: true, hires_scale: 1.5, size: '1024x1024' }
    const { next } = reseedRecipeParams(bag, modelParamSchema('image', 'sd15'), LOCAL_ROW_OWNED_PARAMS)
    expect(next.hires).toBe(true)
    expect(next.hires_scale).toBe(1.5)
  })
})

// ═══ 6. THE SCHEMA SAYS WHAT THE ENGINE DOES ═════════════════════════════════

describe('the local image schema offers exactly what is wired', () => {
  const specOf = (id: string, name: string) => modelParamSchema('image', id).find(s => s.name === name)

  it('`n` is live, capped where the arg builder caps it, and says what it costs', () => {
    const n = specOf('sd-turbo', 'n')!
    expect(n.kind).toBe('int')
    expect(n.min).toBe(1)
    expect(n.max).toBe(SD_BATCH_MAX)
    expect(n.default).toBe(1)
    expect(n.description).toMatch(/loads once/i)
    expect(n.description).toMatch(/own seed/i)
  })

  it('the two-pass is a toggle plus ONE number, both advanced, both off by default', () => {
    const hires = specOf('sd-turbo', 'hires')!
    expect(hires.kind).toBe('boolean')
    expect(hires.default).toBe(false)
    expect(hires.advanced).toBe(true)

    const scale = specOf('sd-turbo', 'hires_scale')!
    expect(scale.min).toBe(SD_HIRES_SCALE_MIN)
    expect(scale.max).toBe(SD_HIRES_SCALE_MAX)
    expect(scale.default).toBe(SD_HIRES_SCALE_DEFAULT)
    expect(scale.advanced).toBe(true)
    // The description quotes THIS row's native size and the size a 2x pass ends
    // at — arithmetic on the row, so it cannot go stale.
    expect(scale.description).toContain('512x512')
    expect(scale.description).toContain('1024x1024')
  })

  it('the toggle\'s own copy is honest about the cost — SQUARE of the scale, not the scale itself', () => {
    // Checkpoint-B driver measurement (speed A/B): a 2x hires pass ran 4.2x,
    // not 2x — "roughly doubles the render time" was the understatement this
    // control could make. The second pass upscales BOTH dimensions, so cost
    // tracks scale^2. Pinned by arithmetic on the named constant, not a
    // restated magic number, so a future default change cannot leave this
    // description quoting the old one.
    const hires = specOf('sd-turbo', 'hires')!
    expect(hires.description).not.toMatch(/roughly doubles/i)
    expect(hires.description).toContain(`${SD_HIRES_SCALE_DEFAULT}x scale`)
    expect(hires.description).toContain(`${SD_HIRES_SCALE_DEFAULT * SD_HIRES_SCALE_DEFAULT}x the render time`)
  })

  it('the sub-flags we deliberately do NOT expose have no control', () => {
    // Each has an upstream default that is the right answer for a first pass; a
    // control whose only job is to re-type a default has to be explained forever.
    for (const name of ['hires_steps', 'hires_denoise', 'hires_upscaler', 'hires_sigmas']) {
      expect(specOf('sd-turbo', name), name).toBeUndefined()
    }
  })

  it('the batch bounds are ONE number, imported, not restated', () => {
    // The schema renders the ceiling and the arg builder clamps against it. Two
    // copies is a control that promises 8 images and delivers 4.
    const svc = readFileSync(resolve(__dirname, '..', '..', 'electron/services/surplus-media-service.ts'), 'utf8')
    const cli = readFileSync(resolve(__dirname, '..', '..', 'electron/services/sd-cpp-client.ts'), 'utf8')
    for (const src of [svc, cli]) {
      expect(src).toMatch(/import \{[\s\S]{0,400}?SD_BATCH_MAX[\s\S]{0,400}?\} from '\.\.\/\.\.\/src\/pages\/media\/localGenParams'/)
    }
  })

  it('neither control appears on a CLOUD image model, or on local VIDEO', () => {
    // `--hires` is a stable-diffusion.cpp feature, and `-b` on the video path
    // would be N clips nothing collects.
    expect(specOf('flux-1-dev-hosted', 'hires')).toBeUndefined()
    expect(specOf('flux-1-dev-hosted', 'hires_scale')).toBeUndefined()
    expect(modelParamSchema('video', 'wan21-t2v-1.3b').find(s => s.name === 'hires')).toBeUndefined()
    expect(modelParamSchema('video', 'wan21-t2v-1.3b').find(s => s.name === 'n')).toBeUndefined()
  })
})

// ═══ 7. THE WIRING inside generateImage (the part a node suite cannot spawn) ══

describe('generateImage threads the batch through, or a good run reads as a failure', () => {
  const CLIENT = readFileSync(resolve(__dirname, '..', '..', 'electron/services/sd-cpp-client.ts'), 'utf8')
  const imagePath = () => {
    const at = CLIENT.indexOf('export function generateImage')
    return CLIENT.slice(at, CLIENT.indexOf('// ── Video (Wan via', at))
  }

  it('the exit check asks about ALL the expected files, not just -o', () => {
    // THE SILENT ONE. sd-cli writes `_0…_{N-1}` for a batch and never the
    // un-suffixed name, so `existsSync(outPath)` on a perfectly good 3-image run
    // is false — and describeSdExit turns that into "exited 0 but wrote no output
    // file", the failure mode with no other evidence at all.
    expect(imagePath()).toContain('const wrote = outPaths.some(p => existsSync(p))')
    expect(imagePath()).toContain('outputExists: wrote')
    expect(imagePath()).not.toContain('outputExists: existsSync(outPath)')
  })

  it('the paths it reads back come from the SAME normalizer the argv used', () => {
    expect(imagePath()).toContain('const batchCount = normalizeBatchCount(input.batchCount)')
    expect(imagePath()).toContain('const outPaths   = sdBatchOutputPaths(outPath, batchCount)')
  })

  it('the collector gets the row the argv used, and every image is returned', () => {
    expect(imagePath()).toContain('input, effective, engineLog, row: env.row,')
    // …and the PROMPT AS SENT, read out of the argv rather than recomputed: a
    // typed `<lora:…>` tag is rewritten or dropped before the run, so
    // `input.prompt` is no longer what the engine was given.
    expect(imagePath()).toContain('...(pAt >= 0 ? { promptSent: args[pAt + 1] } : {}),')
    expect(imagePath()).toContain('const first = images[0]')
    expect(imagePath()).toMatch(/return \{ path: first\.path, b64: first\.b64, mime: first\.mime, seed: first\.seed, effective, images \}/)
  })

  it('zero readable files is an ERROR, never a success with an empty gallery', () => {
    expect(imagePath()).toContain('if (images.length === 0)')
  })
})
