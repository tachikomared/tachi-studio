// apps/desktop/test/unit/mediaLocalSdSize.test.ts
//
// THE SIZE DROPDOWN ACTUALLY CHANGES THE IMAGE.
//
// Driver finding: picking 1024x1024 for a LOCAL sd.cpp generation still produced
// a 512x512 PNG. The composer's only dimension control is `size`, an enum of
// "WxH" STRINGS — there are no numeric width/height controls in the image
// schema at all (electron/services/surplus-media-service.ts CURATED_SCHEMA) —
// but MediaPage forwarded `typeof runParams.width === 'number'` and nothing
// else, so `-W`/`-H` were never passed and sd-cli fell back to the model's
// baseSize. Nothing errored: a dropped dimension is indistinguishable from
// "user didn't set one".
//
// Pinned here: the string parses, garbage does not become NaN on the wire, the
// values land on the 64px grid sd-cli demands, and the VISIBLE control wins over
// stale numeric params (or the same bug returns the moment someone Remixes).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseSizeParam, resolveLocalSdSize,
  parseVideoSizeParams, resolveLocalWanSize,
  durationSecondsToWanFrames, wanFramesToSeconds, resolveLocalWanFrames, stampLocalWanTime,
  healParamsForSchema,
} from '../../src/pages/media/MediaPage'
import type { ParamSpec } from '../../src/types/electron'

describe('parseSizeParam — "WxH" string → sd-cli dimensions', () => {
  it('parses every curated square tier the composer can offer', () => {
    expect(parseSizeParam('512x512')).toEqual({ width: 512, height: 512 })
    expect(parseSizeParam('768x768')).toEqual({ width: 768, height: 768 })
    expect(parseSizeParam('1024x1024')).toEqual({ width: 1024, height: 1024 })
    expect(parseSizeParam('1536x1536')).toEqual({ width: 1536, height: 1536 })
    expect(parseSizeParam('2048x2048')).toEqual({ width: 2048, height: 2048 })
  })

  it('parses non-square pairs (the aspect presets the chat composer offers)', () => {
    expect(parseSizeParam('1024x1792')).toEqual({ width: 1024, height: 1792 })
    expect(parseSizeParam('1792x1024')).toEqual({ width: 1792, height: 1024 })
  })

  it('tolerates the separator and whitespace variants a pasted value carries', () => {
    expect(parseSizeParam(' 1024 x 1024 ')).toEqual({ width: 1024, height: 1024 })
    expect(parseSizeParam('1024X1024')).toEqual({ width: 1024, height: 1024 })
    expect(parseSizeParam('1024×1024')).toEqual({ width: 1024, height: 1024 })
  })

  it('returns null — never NaN — for anything that is not a WxH pair', () => {
    for (const bad of ['', 'x', '1024x', 'x1024', 'axb', 'NaNxNaN', '1024', '1:1', '1024x1024x1024',
                       '-512x512', '1024.5x1024', null, undefined, 1024, {}, ['1024x1024']]) {
      expect(parseSizeParam(bad)).toBeNull()
    }
  })

  it('clamps 0 up and absurd values down instead of handing sd-cli a bad -W', () => {
    expect(parseSizeParam('0x0')).toBeNull()                                  // no dimension at all
    expect(parseSizeParam('16x16')).toEqual({ width: 64, height: 64 })        // below the floor
    expect(parseSizeParam('4096x4096')).toEqual({ width: 2048, height: 2048 })// above the ceiling
    expect(parseSizeParam('99999x99999')).toEqual({ width: 2048, height: 2048 })
  })

  it('snaps onto the 64px grid — stable-diffusion.cpp rejects anything else', () => {
    expect(parseSizeParam('700x500')).toEqual({ width: 704, height: 512 })
    expect(parseSizeParam('833x481')).toEqual({ width: 832, height: 512 })
    for (const s of ['512x512', '700x500', '833x481', '1500x900', '2048x2048']) {
      const d = parseSizeParam(s)!
      expect(d.width  % 64).toBe(0)
      expect(d.height % 64).toBe(0)
    }
  })
})

describe('resolveLocalSdSize — what actually goes over the sd-cpp:generate IPC', () => {
  it('THE BUG: a params bag holding only `size` now yields dimensions', () => {
    // Pre-fix this produced {} and every generation came out at baseSize.
    expect(resolveLocalSdSize({ size: '1024x1024', prompt: 'a fox' }))
      .toEqual({ width: 1024, height: 1024 })
  })

  it('the VISIBLE control wins over stale numeric params', () => {
    // A restored/remixed run carries width/height AND size. If the numbers won,
    // changing the dropdown afterwards would be silently ignored — the original
    // defect, one indirection deeper.
    expect(resolveLocalSdSize({ size: '1024x1024', width: 512, height: 512 }))
      .toEqual({ width: 1024, height: 1024 })
  })

  it('falls back to numeric width/height when `size` is absent or unusable', () => {
    expect(resolveLocalSdSize({ width: 832, height: 576 })).toEqual({ width: 832, height: 576 })
    expect(resolveLocalSdSize({ size: 'garbage', width: 768, height: 768 })).toEqual({ width: 768, height: 768 })
    // …and normalizes that path too, so a hand-edited param cannot reach sd-cli raw.
    expect(resolveLocalSdSize({ width: 700, height: 500 })).toEqual({ width: 704, height: 512 })
  })

  it('sends NOTHING when neither source is usable — the engine default stands', () => {
    expect(resolveLocalSdSize({})).toEqual({})
    expect(resolveLocalSdSize({ prompt: 'a fox' })).toEqual({})
    expect(resolveLocalSdSize({ size: 'x' })).toEqual({})
    expect(resolveLocalSdSize({ width: 512 })).toEqual({})          // half a pair is not a size
    expect(resolveLocalSdSize({ width: NaN, height: NaN })).toEqual({})
    expect(resolveLocalSdSize({ size: null, width: '512', height: '512' })).toEqual({})
  })

  it('spreads cleanly into the generate payload (no undefined keys over IPC)', () => {
    expect(Object.keys({ modelId: 'sd-turbo', ...resolveLocalSdSize({}) })).toEqual(['modelId'])
    expect(Object.keys({ modelId: 'sd-turbo', ...resolveLocalSdSize({ size: '768x768' }) }))
      .toEqual(['modelId', 'width', 'height'])
  })
})

// ─── The wiring, and the metadata contract on the far side ───────────────────

describe('the resolved size reaches sd-cli AND the tachi-gen tEXt chunk', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

  it('MediaPage sends the resolved size, not a raw numeric-only spread', () => {
    const src = read('src/pages/media/MediaPage.tsx')
    const call = src.slice(src.indexOf('window.tachi.sdCpp.generate({'), src.indexOf("'Local generation failed'"))
    expect(call).toContain('...resolveLocalSdSize(runParams)')
    // The dropped-on-the-floor idiom must not come back for the local image call.
    expect(call).not.toContain("typeof runParams.width === 'number'")
  })

  it('a restore-from-PNG seeds `size` too, so the provenance is not re-defaulted', () => {
    const src = read('src/pages/media/MediaPage.tsx')
    const restore = src.slice(src.indexOf('const restoreFromImage'), src.indexOf('// ── Esc closes'))
    expect(restore).toContain('size:            `${meta.width}x${meta.height}`')
  })

  it('sd-cpp-client threads input.width into BOTH the argv and the PNG metadata', () => {
    const src = read('electron/services/sd-cpp-client.ts')
    // argv: -W/-H come from the input first, the ROW's baseSize only as fallback.
    // (`baseSize` is now read off the merged curated ∪ user row — audit D4 —
    // so a user-installed SDXL checkpoint falls back to ITS 1024, not to 512.)
    expect(src).toContain("args.push('-W', String(input.width  ?? baseSize ?? 512))")
    expect(src).toContain("args.push('-H', String(input.height ?? baseSize ?? 512))")
    expect(src).toContain("const baseSize = model && model.kind === 'image' ? model.baseSize : undefined")
    // tachi-gen: the same precedence, so a restored image reports the size it
    // was actually generated at rather than the model default. (The chunk is
    // written per IMAGE now — a `--batch-count` run stamps N files — so this
    // lives in collectSdImages; the precedence is the same one it always was.)
    const metaAt = src.indexOf('const meta: TachiGenMeta')
    const meta = src.slice(metaAt, src.indexOf('embedTextChunk(', metaAt))
    expect(meta).toContain('input.width  ?? rowSize ?? 512')
    expect(meta).toContain('input.height ?? rowSize ?? 512')
  })
})

// ═══ VIDEO — the same defect, one modality over ══════════════════════════════
//
// THE RESOLUTION / ASPECT PICKERS ACTUALLY CHANGE THE VIDEO.
//
// Flagged when the image bug was fixed (73d461c) and left alone then: the local
// Wan call forwarded `typeof runParams.width === 'number'` / `.height`, but the
// video schema declares NO numerics — only `resolution` ('480p'|'720p'|'1080p')
// and `aspect_ratio` ('16:9'|'9:16'|'1:1'). Both pickers were dropped on the
// floor and sd-cli always fell back to the SD_VIDEO_MODELS row (832x480).
//
// THE SUPPORTED-SIZE TRUTH pinned below: Wan 2.1 T2V 1.3B — the only video
// checkpoint the app ships — has upstream SUPPORTED_SIZES ('832*480','480*832').
// 480p landscape, 480p portrait, nothing else. 720p is the 14B checkpoints'
// pair; Wan 2.1 has no 1080p variant at all; no variant lists a square size. So
// the fix is two-sided: STOP OFFERING what the model can't do (the schema
// narrowing in surplus-media-service), and MAP what is offered onto real pixels
// (the helpers here).

describe('parseVideoSizeParams — resolution × aspect → Wan pixel pairs', () => {
  it('maps the two sizes Wan 2.1 T2V 1.3B actually supports', () => {
    expect(parseVideoSizeParams('480p', '16:9')).toEqual({ width: 832, height: 480 })
    expect(parseVideoSizeParams('480p', '9:16')).toEqual({ width: 480, height: 832 })
  })

  it('carries the 14B 720p pair as DATA (portrait too) — the schema, not the mapper, gates it', () => {
    expect(parseVideoSizeParams('720p', '16:9')).toEqual({ width: 1280, height: 720 })
    expect(parseVideoSizeParams('720p', '9:16')).toEqual({ width: 720, height: 1280 })
  })

  it('uses the EXACT upstream pair, not a computed ratio (16:9 of 480 would be 853/848, Wan says 832)', () => {
    expect(parseVideoSizeParams('480p', '16:9')!.width).toBe(832)
    expect(parseVideoSizeParams('720p', '16:9')!.width).toBe(1280)
  })

  it('returns null for 1080p — no Wan 2.1 checkpoint renders it, so the native size must stand', () => {
    expect(parseVideoSizeParams('1080p', '16:9')).toBeNull()
    expect(parseVideoSizeParams('1080p', '9:16')).toBeNull()
    expect(parseVideoSizeParams('4k', '16:9')).toBeNull()
  })

  it('returns null for a SQUARE ratio — no Wan variant lists a square supported size', () => {
    expect(parseVideoSizeParams('480p', '1:1')).toBeNull()
    expect(parseVideoSizeParams('720p', '1:1')).toBeNull()
  })

  it('returns null — never NaN — for garbage on either axis', () => {
    for (const bad of ['', '480', 'p480', '480px', null, undefined, 480, {}, ['480p'], '  ']) {
      expect(parseVideoSizeParams(bad, '16:9')).toBeNull()
    }
    for (const bad of ['', ':', '16:', ':9', '0:0', 'a:b', '16-9', null, undefined, 1.78, {}, ['16:9']]) {
      expect(parseVideoSizeParams('480p', bad)).toBeNull()
    }
  })

  it('tolerates the label casing/whitespace a pasted or remixed param carries', () => {
    expect(parseVideoSizeParams(' 480P ', '16:9')).toEqual({ width: 832, height: 480 })
    expect(parseVideoSizeParams('480p', ' 16 x 9 ')).toEqual({ width: 832, height: 480 })
  })

  it('every pair lands on Wan\'s 16px grid — and 480 would DIE on the image path\'s 64', () => {
    for (const [res, ratio] of [['480p', '16:9'], ['480p', '9:16'], ['720p', '16:9'], ['720p', '9:16']] as const) {
      const d = parseVideoSizeParams(res, ratio)!
      expect(d.width  % 16).toBe(0)
      expect(d.height % 16).toBe(0)
    }
    // The reason video cannot reuse normalizeSdDim: 480 is not a multiple of 64,
    // so the image snapper would rewrite the model's own native height to 512.
    expect(480 % 64).not.toBe(0)
    expect(resolveLocalSdSize({ width: 832, height: 480 })).toEqual({ width: 832, height: 512 })
  })
})

describe('resolveLocalWanSize — what actually goes over the sd-cpp:generateVideo IPC', () => {
  it('THE BUG: a params bag holding only resolution + aspect now yields dimensions', () => {
    // Pre-fix this produced {} and every local render came out at 832x480.
    expect(resolveLocalWanSize({ resolution: '480p', aspect_ratio: '9:16', prompt: 'a fox' }))
      .toEqual({ width: 480, height: 832 })
  })

  it('the schema\'s offered tiers out-vote a stale param left over from a cloud run', () => {
    // params are persisted per MODALITY, not per provider: a 1080p/720p carried
    // over from Surplus must not make the 1.3B attempt a size it never trained on.
    expect(resolveLocalWanSize({ resolution: '1080p', aspect_ratio: '16:9' }, ['480p']))
      .toEqual({ width: 832, height: 480 })
    expect(resolveLocalWanSize({ resolution: '720p', aspect_ratio: '9:16' }, ['480p']))
      .toEqual({ width: 480, height: 832 })
    // …but an offered tier is honoured as picked.
    expect(resolveLocalWanSize({ resolution: '720p', aspect_ratio: '16:9' }, ['480p', '720p']))
      .toEqual({ width: 1280, height: 720 })
  })

  it('falls back to numeric width/height when the pickers are unusable, normalizing them', () => {
    expect(resolveLocalWanSize({ width: 832, height: 480 })).toEqual({ width: 832, height: 480 })
    expect(resolveLocalWanSize({ resolution: '1080p', width: 640, height: 368 }))
      .toEqual({ width: 640, height: 368 })
    // a hand-edited off-grid pair cannot reach sd-cli raw (16px snap, 128..1280 clamp)
    expect(resolveLocalWanSize({ width: 833, height: 481 })).toEqual({ width: 832, height: 480 })
    expect(resolveLocalWanSize({ width: 4096, height: 8 })).toEqual({ width: 1280, height: 128 })
  })

  it('sends NOTHING when neither source is usable — the model row\'s native size stands', () => {
    expect(resolveLocalWanSize({})).toEqual({})
    expect(resolveLocalWanSize({ prompt: 'a fox' })).toEqual({})
    expect(resolveLocalWanSize({ resolution: '480p' })).toEqual({})              // no ratio
    expect(resolveLocalWanSize({ aspect_ratio: '16:9' })).toEqual({})            // no resolution
    expect(resolveLocalWanSize({ resolution: '480p', aspect_ratio: '1:1' })).toEqual({})
    expect(resolveLocalWanSize({ width: 480 })).toEqual({})                      // half a pair
    expect(resolveLocalWanSize({ width: NaN, height: NaN })).toEqual({})
    expect(resolveLocalWanSize({ width: '832', height: '480' })).toEqual({})
    // an empty/absent offer list must not force a resolution out of thin air
    expect(resolveLocalWanSize({ aspect_ratio: '16:9' }, [])).toEqual({})
  })

  it('spreads cleanly into the generateVideo payload (no undefined keys over IPC)', () => {
    expect(Object.keys({ modelId: 'wan21-t2v-1.3b', ...resolveLocalWanSize({}) })).toEqual(['modelId'])
    expect(Object.keys({ modelId: 'wan21-t2v-1.3b', ...resolveLocalWanSize({ resolution: '480p', aspect_ratio: '16:9' }) }))
      .toEqual(['modelId', 'width', 'height'])
  })
})

describe('the video wiring: schema stops over-promising, and the size reaches vid_gen', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

  it('MediaPage sends the RESOLVED size for local video, not a raw numeric-only spread', () => {
    const src = read('src/pages/media/MediaPage.tsx')
    const call = src.slice(
      src.indexOf('window.tachi.sdCpp.generateVideo({'),
      src.indexOf("'Local video generation failed'"),
    )
    expect(call).toContain('...resolveLocalWanSize(runParams, offeredRes)')
    // The dropped-on-the-floor idiom must not come back for the local video call.
    expect(call).not.toContain("typeof runParams.width === 'number'")
    expect(call).not.toContain("typeof runParams.height === 'number'")
    // …and it must not borrow the IMAGE resolver, whose 64px grid mangles 480.
    expect(call).not.toContain('resolveLocalSdSize')
    // the offer list handed in is the LIVE schema's resolution enum
    expect(src).toContain("const offeredRes = shownSchema.find(s => s.name === 'resolution')?.enum")
  })

  it('the video schema is narrowed PER LOCAL CHECKPOINT — no 1080p, no square', () => {
    const src = read('electron/services/surplus-media-service.ts')
    // the narrowing is keyed off the local video registry, so cloud ids miss it
    // (the import also carries allSdModels now — the IMAGE half of the same
    // per-family narrowing; see mediaLocalModelTruth.test.ts)
    expect(src).toMatch(/import \{[^}]*\bSD_VIDEO_MODELS\b[^}]*\} from '\.\/sd-cpp-models'/)
    const fn = src.slice(
      src.indexOf('function localVideoOptionsFor'),
      src.indexOf('/** Resolve the aspect-ratio enum + default for an image model. */'),
    )
    expect(fn).toContain('SD_VIDEO_MODELS.find(x => x.id === modelId)')
    expect(fn).toContain('if (!m) return null')                     // cloud falls through
    // The rung is compared ON THE ROW'S OWN PIXEL GRID: '720p' means 704 on a
    // 32-grid checkpoint, and a nominal-720 comparison would hide the native
    // tier of the one row whose whole point is 720p.
    expect(fn).toContain('onGrid(r.shortSide) <= shortSide')
    expect(fn).toContain('const onGrid = (n: number) => Math.floor(n / grid) * grid')                // tiers from the row itself
    expect(fn).toContain("ratios: ['16:9', '9:16']")                // square dropped
    // and it is actually applied in modelParamSchema, for video only
    const schemaFn = src.slice(src.indexOf('export function modelParamSchema'), src.length)
    expect(schemaFn).toContain("const localVid  = modality === 'video' ? localVideoOptionsFor(modelId)  : null")
    expect(schemaFn).toContain("if (localVid && p.name === 'resolution')")
    expect(schemaFn).toContain("if (localVid && p.name === 'aspect_ratio')")
  })

  it('CLOUD video keeps the full curated superset — the narrowing is not global', () => {
    const src = read('electron/services/surplus-media-service.ts')
    const video = src.slice(src.indexOf('  video: ['), src.indexOf('  music: ['))
    expect(video).toContain("enum: ['480p', '720p', '1080p']")
    expect(video).toContain("enum: ['16:9', '9:16', '1:1']")
  })

  it('sd-cpp-client threads input.width/height into the vid_gen argv ahead of the model row', () => {
    const src = read('electron/services/sd-cpp-client.ts')
    // …and then SNAPS the result onto the row's own pixel grid. The picker
    // resolves '720p' through a Wan 2.1 table, so a 32-grid checkpoint is handed
    // 1280x720 and has to come out at 1280x704 (sdVideoRowTruth.test.ts calls
    // the builder and checks the number; this pins the precedence).
    expect(src).toContain("args.push('-W', String(snapVideoDim(input.width  ?? m?.width  ?? 832, grid)))")
    expect(src).toContain("args.push('-H', String(snapVideoDim(input.height ?? m?.height ?? 480, grid)))")
    expect(src).toContain('const grid = m?.pixelGrid ?? DEFAULT_VIDEO_PIXEL_GRID')
  })

  it('video provenance is the GALLERY ENTRY, not a tachi-gen chunk (webm carries no PNG tEXt)', () => {
    const client = read('electron/services/sd-cpp-client.ts')
    // generateVideo writes a .webm and never embeds a tEXt chunk — TachiGenMeta
    // is image-only, so there is no restore-from-video path to seed.
    const vid = client.slice(client.indexOf('export function generateVideo'), client.length)
    expect(vid).toContain("`sd-vid-${Date.now()}.webm`")
    expect(vid).not.toContain('embedTextChunk')
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page.slice(page.indexOf('const restoreFromImage'), page.indexOf('// ── Esc closes')))
      .toContain('parseTachiGenMetaFromFile')
    // …so the round-trip is Remix: the entry snapshots the params bag that now
    // carries the resolution/aspect the render actually used — and, since the
    // TIME fix, the frame count it was actually rendered at (stampLocalWanTime).
    const call = page.slice(
      page.indexOf('window.tachi.sdCpp.generateVideo({'),
      page.indexOf("} else if (mediaProvider === 'imgnai' && modality === 'video')"),
    )
    // (…now THREE stamps, nested innermost-first, one per axis of the same
    // provenance argument: the frame count that rendered, then the seed the
    // ENGINE chose over the -1 the composer asked with, then the RECIPE it was
    // actually given — a speed pack out-votes the composer in MAIN, so an entry
    // built from `runParams` alone claimed 20 steps at guidance 6 for a run
    // that went out at 4 and 1.)
    expect(call).toContain('stampLocalWanTime(runParams, localFrames.frames, durationSpec?.fps)')
    expect(call).toContain('stampLocalSeed(stampLocalWanTime(runParams, localFrames.frames, durationSpec?.fps), r.seed)')
    expect(call).toContain('stampLocalEngineParams(')
    expect(call).toContain('r.effective,')
    expect(call).toContain('params: videoParams')
  })
})

// ═══ VIDEO, THE TIME AXIS — the same defect one axis over ════════════════════
//
// THE DURATION SLIDER ACTUALLY CHANGES THE CLIP LENGTH.
//
// Flagged when the SPACE half was fixed (2bd48fc) and left alone then: the
// local Wan call forwarded `typeof runParams.frames === 'number'`, but the
// video schema declares NO `frames` — its only length control is `duration`,
// in SECONDS. The spread never fired, sd-cli fell back to the SD_VIDEO_MODELS
// row, and every local clip was 33 frames wherever the slider sat.
//
// THE TIME TRUTH pinned below:
//   • Wan 2.1 generates at 16 FPS — so frames = 16 x seconds and nothing else.
//     sd-cli's own `--fps` defaults to 24 (read off `--help` on the pinned
//     build, master-782-b290693), so the client must pass 16 or the file plays
//     1.5x fast and lasts frames/24 s — a duration promise that lies.
//   • Frame counts are 4n+1: Wan's VAE compresses time 4x keeping frame one, so
//     F frames become (F-1)/4 + 1 latents. Nothing else tiles onto that grid.
//   • The ceiling is 81 frames ~ 5 s: upstream Wan's own `--frame_num` default
//     and the length the model is trained on. sd-cli imposes no cap of its own
//     (`--video-frames <int>`, default 1), so this is the MODEL's limit.
// So the fix is two-sided again: STOP OFFERING 30 s on the local route (the
// schema narrowing in surplus-media-service), and MAP what is offered onto real
// frames (the helpers here).

describe('durationSecondsToWanFrames — seconds → Wan\'s 4n+1 law at 16 fps', () => {
  it('maps every second the narrowed local slider can offer', () => {
    expect(durationSecondsToWanFrames(1)).toBe(17)
    expect(durationSecondsToWanFrames(2)).toBe(33)   // the row's own default length
    expect(durationSecondsToWanFrames(3)).toBe(49)
    expect(durationSecondsToWanFrames(4)).toBe(65)
    expect(durationSecondsToWanFrames(5)).toBe(81)   // upstream's --frame_num default
  })

  it('is exactly 16s+1 for a whole second — the nearest 4n+1 to 16 x seconds', () => {
    for (const s of [1, 2, 3, 4, 5]) expect(durationSecondsToWanFrames(s)).toBe(16 * s + 1)
    // …and NOT the naive 16s, which is not on the 4n+1 grid at all.
    for (const s of [1, 2, 3, 4, 5]) expect(durationSecondsToWanFrames(s)).not.toBe(16 * s)
  })

  it('snaps a fractional second to the nearest legal count, never between grid points', () => {
    expect(durationSecondsToWanFrames(1.5)).toBe(25)
    expect(durationSecondsToWanFrames(2.5)).toBe(41)
    expect(durationSecondsToWanFrames(4.5)).toBe(73)
  })

  it('CLAMPS at the 81-frame ceiling — a 30 s ask does not become a 481-frame run', () => {
    expect(durationSecondsToWanFrames(5.0625)).toBe(81)   // exactly 81/16
    expect(durationSecondsToWanFrames(6)).toBe(81)
    expect(durationSecondsToWanFrames(15)).toBe(81)
    expect(durationSecondsToWanFrames(30)).toBe(81)       // the cloud slider's max
    expect(durationSecondsToWanFrames(1e6)).toBe(81)
  })

  it('CLAMPS at a 5-frame floor — a sub-second ask is a clip, not a still', () => {
    expect(durationSecondsToWanFrames(0.5)).toBe(9)
    expect(durationSecondsToWanFrames(0.3)).toBe(5)
    expect(durationSecondsToWanFrames(0.05)).toBe(5)      // 4n+1 with n=0 would be ONE frame
    expect(durationSecondsToWanFrames(1e-9)).toBe(5)
  })

  it('THE 4n+1 LAW holds as a property across the whole range, floor to past the ceiling', () => {
    for (let s = 0.05; s <= 40; s += 0.05) {
      const f = durationSecondsToWanFrames(s)!
      expect(Number.isInteger(f)).toBe(true)
      expect((f - 1) % 4).toBe(0)            // Wan's temporal patchify grid
      expect(f).toBeGreaterThanOrEqual(5)
      expect(f).toBeLessThanOrEqual(81)      // the model's trained ceiling
    }
  })

  it('returns null — never NaN — for garbage, so the engine default stands', () => {
    for (const bad of ['', '   ', 'abc', '5s', null, undefined, {}, [], [5], true, false,
                       NaN, Infinity, -Infinity, 0, -1, '0', '-4']) {
      expect(durationSecondsToWanFrames(bad)).toBeNull()
    }
  })

  it('tolerates the numeric STRING a remixed or hand-edited bag can carry', () => {
    // the imgnai/venice paths already parseInt a string duration — same shape here
    expect(durationSecondsToWanFrames('2')).toBe(33)
    expect(durationSecondsToWanFrames(' 5 ')).toBe(81)
  })
})

describe('wanFramesToSeconds — the length the gallery entry reports back', () => {
  it('inverts the mapping for every count the local route can produce', () => {
    expect(wanFramesToSeconds(17)).toBe(1)
    expect(wanFramesToSeconds(33)).toBe(2)
    expect(wanFramesToSeconds(49)).toBe(3)
    expect(wanFramesToSeconds(65)).toBe(4)
    expect(wanFramesToSeconds(81)).toBe(5)
  })

  it('round-trips: a Remix of a stamped entry re-renders the SAME frame count', () => {
    for (const f of [17, 33, 49, 65, 81]) {
      expect(durationSecondsToWanFrames(wanFramesToSeconds(f))).toBe(f)
    }
  })

  it('never reports a 0 s clip for the shortest counts', () => {
    expect(wanFramesToSeconds(5)).toBe(1)
    expect(wanFramesToSeconds(1)).toBe(1)
  })
})

describe('resolveLocalWanFrames — what actually goes over sd-cpp:generateVideo', () => {
  it('THE BUG: a params bag holding only `duration` now yields a frame count', () => {
    // Pre-fix this produced {} and every local clip came out at the row's 33.
    expect(resolveLocalWanFrames({ duration: 4, prompt: 'a fox' })).toEqual({ frames: 65 })
    expect(resolveLocalWanFrames({ duration: 1 })).toEqual({ frames: 17 })
  })

  it('the schema\'s offered bound out-votes a stale duration left over from a cloud run', () => {
    // params are persisted per MODALITY, not per provider: a 30 s carried over
    // from Surplus must not make the 1.3B attempt a length it never trained on.
    expect(resolveLocalWanFrames({ duration: 30 }, { min: 1, max: 5 })).toEqual({ frames: 81 })
    // a NARROWER offer (a future shorter row) governs too — not just the hard cap
    expect(resolveLocalWanFrames({ duration: 30 }, { min: 1, max: 3 })).toEqual({ frames: 49 })
    expect(resolveLocalWanFrames({ duration: 5  }, { min: 1, max: 2 })).toEqual({ frames: 33 })
    // …and the floor is honoured as well
    expect(resolveLocalWanFrames({ duration: 0.2 }, { min: 1, max: 5 })).toEqual({ frames: 17 })
    // an offered value is honoured exactly as picked
    expect(resolveLocalWanFrames({ duration: 3 }, { min: 1, max: 5 })).toEqual({ frames: 49 })
  })

  it('a partial or absent offer never invents a bound', () => {
    expect(resolveLocalWanFrames({ duration: 2 }, {})).toEqual({ frames: 33 })
    expect(resolveLocalWanFrames({ duration: 2 }, { max: 5 })).toEqual({ frames: 33 })
    expect(resolveLocalWanFrames({ duration: 2 }, { min: 1 })).toEqual({ frames: 33 })
    expect(resolveLocalWanFrames({ duration: 30 })).toEqual({ frames: 81 })  // the hard cap still bites
  })

  it('falls back to a numeric `frames` when the slider value is unusable, snapping it', () => {
    expect(resolveLocalWanFrames({ frames: 33 })).toEqual({ frames: 33 })
    expect(resolveLocalWanFrames({ duration: 'soon', frames: 65 })).toEqual({ frames: 65 })
    // an off-grid hand-edited count cannot reach sd-cli raw (4n+1 snap, 5..81 clamp)
    expect(resolveLocalWanFrames({ frames: 34 })).toEqual({ frames: 33 })
    expect(resolveLocalWanFrames({ frames: 36 })).toEqual({ frames: 37 })
    expect(resolveLocalWanFrames({ frames: 500 })).toEqual({ frames: 81 })
    expect(resolveLocalWanFrames({ frames: 2 })).toEqual({ frames: 5 })
  })

  it('the VISIBLE control wins over a stale stamped `frames`', () => {
    expect(resolveLocalWanFrames({ duration: 1, frames: 81 })).toEqual({ frames: 17 })
  })

  it('sends NOTHING when neither source is usable — the model row\'s own count stands', () => {
    expect(resolveLocalWanFrames({})).toEqual({})
    expect(resolveLocalWanFrames({ prompt: 'a fox' })).toEqual({})
    expect(resolveLocalWanFrames({ duration: 'abc' })).toEqual({})
    expect(resolveLocalWanFrames({ duration: null, frames: null })).toEqual({})
    expect(resolveLocalWanFrames({ duration: NaN, frames: NaN })).toEqual({})
    expect(resolveLocalWanFrames({ frames: '33' })).toEqual({})
    expect(resolveLocalWanFrames({ duration: 0 })).toEqual({})
    expect(resolveLocalWanFrames({ duration: -5 })).toEqual({})
  })

  it('spreads cleanly into the generateVideo payload (no undefined keys over IPC)', () => {
    expect(Object.keys({ modelId: 'wan21-t2v-1.3b', ...resolveLocalWanFrames({}) })).toEqual(['modelId'])
    expect(Object.keys({ modelId: 'wan21-t2v-1.3b', ...resolveLocalWanFrames({ duration: 2 }) }))
      .toEqual(['modelId', 'frames'])
  })

  it('a ParamSpec is accepted as the offer verbatim — that is what the call site hands it', () => {
    const spec = { name: 'duration', label: 'Duration (s)', kind: 'int', min: 1, max: 5, step: 1, default: 2 }
    expect(resolveLocalWanFrames({ duration: 30 }, spec)).toEqual({ frames: 81 })
  })
})

describe('stampLocalWanTime — the gallery entry IS the video provenance', () => {
  it('records the frame count that actually rendered, alongside the seconds it plays', () => {
    expect(stampLocalWanTime({ prompt: 'a fox', duration: 4 }, 65))
      .toEqual({ prompt: 'a fox', duration: 4, frames: 65 })
  })

  it('REWRITES a duration the engine could not honour — the entry must not claim 30 s', () => {
    expect(stampLocalWanTime({ duration: 30, resolution: '480p' }, 81))
      .toEqual({ duration: 5, resolution: '480p', frames: 81 })
  })

  it('passes the bag through untouched when no frame count was resolved', () => {
    const bag = { prompt: 'a fox', duration: 4 }
    expect(stampLocalWanTime(bag, undefined)).toBe(bag)   // same reference, no stamp invented
  })

  it('does not mutate the run\'s own snapshot', () => {
    const bag: Record<string, unknown> = { duration: 30 }
    stampLocalWanTime(bag, 81)
    expect(bag).toEqual({ duration: 30 })
  })

  it('a stamped entry Remixes back to the SAME render', () => {
    const stamped = stampLocalWanTime({ duration: 30 }, 81)
    expect(resolveLocalWanFrames(stamped, { min: 1, max: 5 })).toEqual({ frames: 81 })
  })
})

describe('the video TIME wiring: schema stops over-promising, frames + fps reach vid_gen', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

  it('MediaPage sends the RESOLVED frame count, not the dead numeric-only spread', () => {
    const src = read('src/pages/media/MediaPage.tsx')
    const call = src.slice(
      src.indexOf('window.tachi.sdCpp.generateVideo({'),
      src.indexOf("'Local video generation failed'"),
    )
    expect(call).toContain('...localFrames')
    // the idiom that never fired (there is no `frames` in the video schema)
    expect(call).not.toContain("typeof runParams.frames === 'number'")
    // the offer handed in is the LIVE schema's duration spec (min/max)
    expect(src).toContain('const localFrames = resolveLocalWanFrames(runParams, durationSpec)')
  })

  it('the video schema NARROWS duration per LOCAL checkpoint — no 30 s promise', () => {
    const src = read('electron/services/surplus-media-service.ts')
    const fn = src.slice(
      src.indexOf('function localVideoOptionsFor'),
      src.indexOf('/** Resolve the aspect-ratio enum + default for an image model. */'),
    )
    // the ceiling is DERIVED from the model's law, not typed in as a magic 5
    expect(src).toContain('const WAN_FRAMES_MAX = 81')
    // The ceiling is in FRAMES and the rate is the ROW's, so the seconds bound
    // is derived per checkpoint: ~5 s at 16 fps, ~3 s at 24.
    expect(fn).toContain('const fps  = m.fps ?? DEFAULT_VIDEO_FPS')
    expect(fn).toContain('Math.floor(WAN_FRAMES_MAX / fps)')
    // …and the DEFAULT comes from the row's own frame count (33 @ 16 -> 2 s)
    expect(fn).toContain('Math.round(m.frames / fps)')
    // …and that same rate travels ON the spec, which is how both local surfaces
    // convert seconds→frames without either one being told twice.
    expect(src).toContain('fps:     localVid.fps')
    // applied in modelParamSchema, for a local video model only
    const schemaFn = src.slice(src.indexOf('export function modelParamSchema'), src.length)
    expect(schemaFn).toContain("if (localVid && p.name === 'duration')")
    expect(schemaFn).toContain('min:     localVid.seconds.min')
    expect(schemaFn).toContain('max:     localVid.seconds.max')
    expect(schemaFn).toContain('default: localVid.seconds.default')
  })

  it('the derivation the schema pin rests on yields 1..5 s, default 2, for the shipped row', () => {
    // Recomputed from the SAME numbers the sources declare — pins the arithmetic
    // (81 frames / 16 fps = a 5 s ceiling; the row's 33 frames = the 2 s default)
    // without importing the electron-bound service module.
    const models = read('electron/services/sd-cpp-models.ts')
    const row = models.slice(models.indexOf("id: 'wan21-t2v-1.3b'"), models.indexOf("notes: 'Text→video"))
    const rowFrames = Number(/frames:\s*(\d+)/.exec(row)![1])
    expect(rowFrames).toBe(33)
    expect(Math.max(1, Math.floor(81 / 16))).toBe(5)
    expect(Math.min(5, Math.max(1, Math.round(rowFrames / 16)))).toBe(2)
    // the offered window and the mapper agree end to end
    expect(durationSecondsToWanFrames(5)).toBe(81)
    expect(durationSecondsToWanFrames(2)).toBe(rowFrames)
  })

  it('CLOUD video keeps the full curated duration superset — the narrowing is not global', () => {
    const src = read('electron/services/surplus-media-service.ts')
    const video = src.slice(src.indexOf('  video: ['), src.indexOf('  music: ['))
    expect(video).toContain("{ name: 'duration',        label: 'Duration (s)',    kind: 'int',  min: 1, max: 30, step: 1, default: 5 }")
    // (and the size superset the SPACE fix left intact is still there)
    expect(video).toContain("enum: ['480p', '720p', '1080p']")
  })

  it('sd-cpp-client threads input.frames into --video-frames ahead of the model row', () => {
    const src = read('electron/services/sd-cpp-client.ts')
    // The temporal grid moved onto the ROW the day the catalog stopped being
    // all-Wan (LTX-AV compresses time 8x where Wan compresses 4x), so the snap
    // now takes it as an argument. The PRECEDENCE this line exists to pin —
    // input over row over 33 — is unchanged.
    expect(src).toContain("args.push('--video-frames', String(snapVideoFrames(input.frames ?? m?.frames ?? 33, frameGrid)))")
    expect(src).toContain('const frameGrid = m?.frameGrid ?? DEFAULT_VIDEO_FRAME_GRID')
  })

  it('sd-cpp-client passes the ROW fps — sd-cli defaults to 24, which would make the duration a lie', () => {
    const src = read('electron/services/sd-cpp-client.ts')
    // It was a module constant of 16 while every shipped checkpoint was Wan 2.1.
    // Wan 2.2 TI2V-5B is genuinely 24, so the same constant became wrong in the
    // other direction and the number moved onto the row.
    expect(src).toContain("args.push('--fps', String(m?.fps ?? DEFAULT_VIDEO_FPS))")
    expect(src).not.toContain('const WAN_FPS = 16')
  })

  it('the renderer\'s fps and the client\'s fps are the SAME number (or seconds mean nothing)', () => {
    // ONE DEFAULT, ONE DECLARATION. Each of the three modules held its own
    // `const WAN_FPS = 16` and this test compared the three literals — which is
    // only a contract while the answer is the same for every checkpoint. It is
    // not: Wan 2.2 TI2V-5B is a 24 fps model. So the FALLBACK now lives in the
    // registry beside the rows that override it, and the other two IMPORT it,
    // which is a stronger guarantee than three numbers that happen to match.
    expect(Number(/export const DEFAULT_VIDEO_FPS = (\d+)/.exec(read('electron/services/sd-cpp-models.ts'))![1])).toBe(16)
    expect(read('src/pages/media/localGenParams.ts')).toContain('const WAN_FPS = 16')
    for (const rel of ['electron/services/sd-cpp-client.ts', 'electron/services/surplus-media-service.ts']) {
      expect(read(rel), rel).toContain('DEFAULT_VIDEO_FPS')
      expect(read(rel), rel).not.toContain('const WAN_FPS = 16')
    }
  })

  it('a 24 fps row converts seconds through ITS rate, on BOTH local surfaces', () => {
    // The end-to-end of the fps carrier. `resolveLocalWanFrames` takes the
    // `duration` SPEC as its bound, and that spec now carries the row's rate —
    // so 2 s is 33 frames on a 16 fps checkpoint and 49 on a 24 fps one, and
    // both surfaces get it because both already pass the spec.
    const spec = (fps?: number): ParamSpec =>
      ({ name: 'duration', label: 'Duration (s)', kind: 'int', min: 1, max: 5, ...(fps ? { fps } : {}) })
    expect(resolveLocalWanFrames({ duration: 2 }, spec(16))).toEqual({ frames: 33 })
    expect(resolveLocalWanFrames({ duration: 2 }, spec(24))).toEqual({ frames: 49 })
    // A spec with NO fps (every cloud schema, and every bag from before this
    // change) is byte-identical to the old behaviour.
    expect(resolveLocalWanFrames({ duration: 2 }, spec())).toEqual({ frames: 33 })
    expect(resolveLocalWanFrames({ duration: 2 })).toEqual({ frames: 33 })
    // …and the STAMP reads the same rate back, or the gallery entry claims a
    // length the clip does not have (49 frames at 24 fps is 2 s, not 3).
    expect(stampLocalWanTime({}, 49, 24)).toEqual({ frames: 49, duration: 2 })
    expect(stampLocalWanTime({}, 49, 16)).toEqual({ frames: 49, duration: 3 })
    expect(wanFramesToSeconds(49, 24)).toBe(2)
    expect(durationSecondsToWanFrames(3, 24)).toBe(73)   // still 4n+1, still <= 81
  })

  it('the 81-frame ceiling is a COUNT, so it survives the rate change', () => {
    // 81 frames is Wan's trained clip length and the ~80-frame consistency
    // ceiling — a frame fact, not a time one. At 24 fps that is ~3.4 s, which
    // is why the seconds bound is derived per row rather than typed in.
    expect(durationSecondsToWanFrames(5, 16)).toBe(81)
    expect(durationSecondsToWanFrames(5, 24)).toBe(81)   // clamped, not 121
    expect(durationSecondsToWanFrames(30, 24)).toBe(81)
    expect(Math.max(1, Math.floor(81 / 24))).toBe(3)
  })
})

// ═══ THE COMPOSER STOPS DISPLAYING WHAT THE MODEL CANNOT DO ══════════════════
//
// Driver finding, one layer above the two fixes above: composer params persist
// per MODALITY (tachi-media-v1), not per provider. So after a cloud video run
// the LOCAL Wan composer ARRIVES showing duration = 10 on a slider whose max is
// 5, and resolution = '1080p' selected in a dropdown that only offers '480p'
// (ParamFields injects an out-of-enum current value as an extra <option> on
// purpose, so the stale value looks like a real choice).
//
// The GENERATION side already out-votes both (2bd48fc / 9db0dbd) — which is
// exactly what makes this a UI lie rather than a bad render: the composer
// promised a 10 s 1080p clip and the engine quietly produced a 2 s 480p one.
//
// healParamsForSchema is the generic fix, keyed off the only authority there
// is: the spec the ACTIVE schema declares. It must heal what that spec EXCLUDES
// and nothing else — an in-range value is a user edit, and an out-of-enum value
// an explicit Remix/restore put there is PROVENANCE (that is what ParamFields'
// injected option is for).

/** The video specs as surplus-media-service narrows them for the shipped Wan row. */
const LOCAL_VIDEO_SCHEMA: ParamSpec[] = [
  { name: 'prompt',      label: 'Prompt',       kind: 'text', required: true },
  { name: 'aspect_ratio', label: 'Aspect ratio', kind: 'enum', enum: ['16:9', '9:16'], default: '16:9' },
  { name: 'duration',    label: 'Duration (s)', kind: 'int',  min: 1, max: 5, step: 1, default: 2 },
  { name: 'resolution',  label: 'Resolution',   kind: 'enum', enum: ['480p'], default: '480p' },
  { name: 'seed',        label: 'Seed',         kind: 'int',  min: -1, max: 2_147_483_647, step: 1, default: -1 },
]

/** …and the cloud superset the same modality shows on Surplus/Venice. */
const CLOUD_VIDEO_SCHEMA: ParamSpec[] = [
  { name: 'prompt',       label: 'Prompt',       kind: 'text', required: true },
  { name: 'aspect_ratio', label: 'Aspect ratio', kind: 'enum', enum: ['16:9', '9:16', '1:1'], default: '16:9' },
  { name: 'duration',     label: 'Duration (s)', kind: 'int',  min: 1, max: 30, step: 1, default: 5 },
  { name: 'resolution',   label: 'Resolution',   kind: 'enum', enum: ['480p', '720p', '1080p'], default: '720p' },
]

describe('healParamsForSchema — a stale bag stops DISPLAYING what the schema excludes', () => {
  it('THE BUG (time): a cloud 10 s heals when the local schema tops out at 5 s', () => {
    const { next, healed } = healParamsForSchema({ duration: 10 }, LOCAL_VIDEO_SCHEMA)
    expect(next.duration).toBe(2)
    expect(healed).toContain('duration')
  })

  it('THE BUG (size): a cloud 1080p heals to the tier the local checkpoint offers', () => {
    const { next, healed } = healParamsForSchema({ resolution: '1080p' }, LOCAL_VIDEO_SCHEMA)
    expect(next.resolution).toBe('480p')
    expect(healed).toContain('resolution')
  })

  it('heals to the spec DEFAULT, not the nearest bound — the ceiling is the run nobody asked for', () => {
    // Clamping 10 s to the 5 s max would hand over the longest, most VRAM-hungry
    // render available (the driver's 49-frame job died exactly there). 2 s is the
    // length every local render has actually been producing.
    expect(healParamsForSchema({ duration: 10 }, LOCAL_VIDEO_SCHEMA).next.duration).toBe(2)
    expect(healParamsForSchema({ duration: 30 }, LOCAL_VIDEO_SCHEMA).next.duration).toBe(2)
    expect(healParamsForSchema({ duration: 0 },  LOCAL_VIDEO_SCHEMA).next.duration).toBe(2)
    expect(healParamsForSchema({ duration: -7 }, LOCAL_VIDEO_SCHEMA).next.duration).toBe(2)
  })

  it('clamps to the nearest bound when the spec declares no usable default', () => {
    const noDefault: ParamSpec[] = [{ name: 'steps', label: 'Steps', kind: 'int', min: 1, max: 50 }]
    expect(healParamsForSchema({ steps: 900 }, noDefault).next.steps).toBe(50)
    expect(healParamsForSchema({ steps: 0 },   noDefault).next.steps).toBe(1)
    // …and when the declared default is ITSELF out of the declared range.
    const badDefault: ParamSpec[] = [{ name: 'steps', label: 'Steps', kind: 'int', min: 1, max: 50, default: 99 }]
    expect(healParamsForSchema({ steps: 900 }, badDefault).next.steps).toBe(50)
  })

  it('honours a one-sided bound without inventing the other', () => {
    const seedOnly: ParamSpec[] = [{ name: 'seed', label: 'Seed', kind: 'int', min: -1 }]
    expect(healParamsForSchema({ seed: -5 }, seedOnly).next.seed).toBe(-1)
    expect(healParamsForSchema({ seed: 2_000_000 }, seedOnly).changed).toBe(false)  // no max declared
  })

  it('NEVER touches an in-range value — the heal must not fight a user mid-edit', () => {
    for (const s of [1, 2, 3, 4, 5]) {
      const { next, changed, healed } = healParamsForSchema({ duration: s, resolution: '480p', aspect_ratio: '9:16' }, LOCAL_VIDEO_SCHEMA)
      expect(next.duration).toBe(s)
      expect(next.resolution).toBe('480p')
      expect(next.aspect_ratio).toBe('9:16')
      expect(healed).toEqual([])
      // the only write is the missing-default seeding of `seed`
      expect(changed).toBe(true)
      expect(next.seed).toBe(-1)
    }
  })

  it('leaves the CLOUD composer alone — 10 s and 1080p are in ITS schema', () => {
    const stale = { duration: 10, resolution: '1080p', aspect_ratio: '1:1' }
    const { next, healed } = healParamsForSchema(stale, CLOUD_VIDEO_SCHEMA)
    expect(healed).toEqual([])
    expect(next).toMatchObject(stale)
  })

  it('prefers the enum DEFAULT over the first option (they are not the same tier)', () => {
    // The cloud video schema defaults to '720p' while '480p' leads the enum:
    // healing a bad value must land on the schema's own choice, not on index 0.
    expect(healParamsForSchema({ resolution: '4k' }, CLOUD_VIDEO_SCHEMA).next.resolution).toBe('720p')
    expect(CLOUD_VIDEO_SCHEMA.find(s => s.name === 'resolution')!.enum![0]).toBe('480p')
  })

  it('falls back to the FIRST option when the enum default is itself excluded', () => {
    const spec: ParamSpec[] = [{ name: 'resolution', label: 'Resolution', kind: 'enum', enum: ['480p'], default: '720p' }]
    expect(healParamsForSchema({ resolution: '1080p' }, spec).next.resolution).toBe('480p')
  })

  it('an enum with no options declares no domain — nothing can be excluded', () => {
    const spec: ParamSpec[] = [
      { name: 'sampler', label: 'Sampler', kind: 'enum' },
      { name: 'other',   label: 'Other',   kind: 'enum', enum: [] },
    ]
    const { changed } = healParamsForSchema({ sampler: 'dpmpp_3m', other: 'x' }, spec)
    expect(changed).toBe(false)
  })

  it('heals a null / non-scalar sitting in an enum slot (the select would show a different option than the store holds)', () => {
    expect(healParamsForSchema({ resolution: null }, LOCAL_VIDEO_SCHEMA).next.resolution).toBe('480p')
    expect(healParamsForSchema({ resolution: {} },   LOCAL_VIDEO_SCHEMA).next.resolution).toBe('480p')
    expect(healParamsForSchema({ resolution: ['720p'] }, LOCAL_VIDEO_SCHEMA).next.resolution).toBe('480p')
    // a numeric/boolean that stringifies INTO the enum is a match, not a miss
    const numeric: ParamSpec[] = [{ name: 'n', label: 'N', kind: 'enum', enum: ['1', '2'], default: '1' }]
    expect(healParamsForSchema({ n: 2 }, numeric).changed).toBe(false)
  })

  it('leaves a NON-numeric value in a slider slot alone — ParamFields already shows the default for it', () => {
    const { next, healed } = healParamsForSchema({ duration: '10', seed: null }, LOCAL_VIDEO_SCHEMA)
    expect(healed).toEqual([])           // (the absent params are still seeded — that is job 1)
    expect(next.duration).toBe('10')
    expect(next.seed).toBeNull()
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(healParamsForSchema({ duration: bad }, LOCAL_VIDEO_SCHEMA).healed).toEqual([])
    }
  })

  it('never rewrites a kind with no declared domain (text / string / boolean / image / audio)', () => {
    const schema: ParamSpec[] = [
      { name: 'prompt',       label: 'Prompt',  kind: 'text',    default: '' },
      { name: 'genre',        label: 'Genre',   kind: 'string',  default: '' },
      { name: 'instrumental', label: 'Inst.',   kind: 'boolean', default: false },
      { name: 'image_url',    label: 'Init',    kind: 'image' },
      { name: 'file',         label: 'Audio',   kind: 'audio' },
    ]
    const bag = { prompt: 'a fox', genre: 'lofi', instrumental: 'yes', image_url: 'data:x', file: 'a.wav' }
    const { next, changed, healed } = healParamsForSchema(bag, schema)
    expect(changed).toBe(false)
    expect(healed).toEqual([])
    expect(next).toEqual(bag)
  })

  it('still SEEDS the params the bag is missing — the pre-existing schema-arrival behaviour', () => {
    const { next, changed } = healParamsForSchema({ prompt: 'a fox' }, LOCAL_VIDEO_SCHEMA)
    expect(changed).toBe(true)
    expect(next).toEqual({ prompt: 'a fox', aspect_ratio: '16:9', duration: 2, resolution: '480p', seed: -1 })
    // a spec with no default is not invented into the bag
    expect('steps' in healParamsForSchema({}, [{ name: 'steps', label: 'Steps', kind: 'int', min: 1, max: 50 }]).next).toBe(false)
  })

  it('treats an explicitly-undefined value as missing, so the store agrees with the control', () => {
    expect(healParamsForSchema({ duration: undefined }, LOCAL_VIDEO_SCHEMA).next.duration).toBe(2)
  })

  it('reports changed=false and an empty heal list when nothing needed either job', () => {
    const bag = { prompt: 'a fox', aspect_ratio: '16:9', duration: 2, resolution: '480p', seed: -1 }
    const { next, changed, healed } = healParamsForSchema(bag, LOCAL_VIDEO_SCHEMA)
    expect(changed).toBe(false)
    expect(healed).toEqual([])
    expect(next).toEqual(bag)
  })

  it('ignores params no spec claims — the bag keeps what other providers put there', () => {
    const { next } = healParamsForSchema({ lyrics: 'la la', frames: 999 }, LOCAL_VIDEO_SCHEMA)
    expect(next.lyrics).toBe('la la')
    expect(next.frames).toBe(999)      // no `frames` spec exists — not ours to heal
  })

  it('does not mutate the caller\'s bag', () => {
    const bag: Record<string, unknown> = { duration: 10, resolution: '1080p' }
    healParamsForSchema(bag, LOCAL_VIDEO_SCHEMA)
    expect(bag).toEqual({ duration: 10, resolution: '1080p' })
  })

  it('is idempotent — healing a healed bag changes nothing', () => {
    const once = healParamsForSchema({ duration: 10, resolution: '1080p' }, LOCAL_VIDEO_SCHEMA)
    const twice = healParamsForSchema(once.next, LOCAL_VIDEO_SCHEMA)
    expect(twice.changed).toBe(false)
    expect(twice.next).toEqual(once.next)
  })
})

describe('healParamsForSchema — the Remix / restore-from-PNG exemption', () => {
  /** The image specs as modelParamSchema narrows them for a local sd15 checkpoint. */
  const SD15_SCHEMA: ParamSpec[] = [
    { name: 'prompt', label: 'Prompt', kind: 'text', required: true },
    { name: 'size',   label: 'Size',   kind: 'enum', enum: ['512x512', '768x768', '1024x1024'], default: '512x512' },
    { name: 'seed',   label: 'Seed',   kind: 'int',  min: -1, max: 2_147_483_647, step: 1, default: -1 },
  ]

  it('a restored 512x512 survives on an sd15 schema — it is a real tier', () => {
    const restored = { prompt: 'a fox', size: '512x512', width: 512, height: 512, seed: 7 }
    // …with the heal ON (it is simply in the enum)
    expect(healParamsForSchema(restored, SD15_SCHEMA).next.size).toBe('512x512')
    // …and with it OFF
    expect(healParamsForSchema(restored, SD15_SCHEMA, { healExcluded: false }).next.size).toBe('512x512')
  })

  it('healExcluded:false keeps a NON-TIER restored size — ParamFields\' out-of-enum option exists for exactly this', () => {
    // 640x896 is a real sd-cli render but not a curated tier: it comes back from
    // the PNG's tachi-gen chunk, so it is provenance, not staleness.
    const restored = { prompt: 'a fox', size: '640x896', width: 640, height: 896 }
    const { next, changed, healed } = healParamsForSchema(restored, SD15_SCHEMA, { healExcluded: false })
    expect(next.size).toBe('640x896')
    expect(healed).toEqual([])
    expect(changed).toBe(true)               // the missing `seed` default still seeds
    expect(next.seed).toBe(-1)
    // …and the generation side then re-renders at exactly that size
    expect(resolveLocalSdSize(next)).toEqual({ width: 640, height: 896 })
  })

  it('the exemption is opt-IN: the same bag WOULD be healed on a normal schema arrival', () => {
    const stale = { size: '640x896' }
    expect(healParamsForSchema(stale, SD15_SCHEMA).next.size).toBe('512x512')
    expect(healParamsForSchema(stale, SD15_SCHEMA).healed).toEqual(['size'])
  })

  it('healExcluded:false NEVER skips the seeding half (a restore must still get the defaults it lacks)', () => {
    const { next } = healParamsForSchema({ prompt: 'a fox' }, LOCAL_VIDEO_SCHEMA, { healExcluded: false })
    expect(next).toEqual({ prompt: 'a fox', aspect_ratio: '16:9', duration: 2, resolution: '480p', seed: -1 })
  })
})

describe('the healed bag and the GENERATION side now tell the same story', () => {
  it('what the composer shows is what resolveLocalWanFrames / resolveLocalWanSize send', () => {
    // The stale cloud bag, before the heal: the UI said 10 s @ 1080p…
    const stale = { prompt: 'a fox', duration: 10, resolution: '1080p', aspect_ratio: '16:9' }
    const durationSpec = LOCAL_VIDEO_SCHEMA.find(s => s.name === 'duration')!
    const offeredRes   = LOCAL_VIDEO_SCHEMA.find(s => s.name === 'resolution')!.enum
    // …while the engine rendered 2 s @ 832x480 (the out-voting from 2bd48fc/9db0dbd).
    expect(resolveLocalWanFrames(stale, durationSpec)).toEqual({ frames: 81 })   // clamped to the OFFER, not the display
    expect(resolveLocalWanSize(stale, offeredRes)).toEqual({ width: 832, height: 480 })

    const { next } = healParamsForSchema(stale, LOCAL_VIDEO_SCHEMA)
    expect(next.duration).toBe(2)
    expect(next.resolution).toBe('480p')
    // After the heal the two agree: 2 s on the slider IS the 33 frames that render.
    expect(resolveLocalWanFrames(next, durationSpec)).toEqual({ frames: 33 })
    expect(resolveLocalWanFrames(next, durationSpec).frames)
      .toBe(durationSecondsToWanFrames(next.duration as number))
    expect(resolveLocalWanSize(next, offeredRes)).toEqual({ width: 832, height: 480 })
  })

  it('the resolvers keep out-voting even if the heal never ran (belt AND braces)', () => {
    // The heal is a UI truth fix, not a safety net — removing it must not make
    // the engine attempt 1080p or 481 frames again.
    const stale = { duration: 30, resolution: '1080p', aspect_ratio: '16:9' }
    expect(resolveLocalWanFrames(stale, { min: 1, max: 5 })).toEqual({ frames: 81 })
    expect(resolveLocalWanSize(stale, ['480p'])).toEqual({ width: 832, height: 480 })
  })
})

describe('the heal wiring: it fires on SCHEMA ARRIVAL, and an explicit restore is exempt', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
  const page = () => read('src/pages/media/MediaPage.tsx')

  it('the schema-arrival effect heals the persisted bag instead of only seeding it', () => {
    const src = page()
    const effect = src.slice(src.indexOf('window.tachi.surplusMedia.modelParams({'), src.indexOf('const shownSchema'))
    // The heal now runs on the output of the recipe RE-SEED (the model-switch
    // fix — see mediaModelSwitchRecipe.test.ts), which is `existing` verbatim on
    // every path that is not a checkpoint switch. Both flags still ride the same
    // `explicit` exemption.
    expect(effect).toContain('healParamsForSchema(reseed.next, res.params, { healExcluded: !explicit })')
    // The third argument is WHICH params the row owns, and it is chosen per
    // route: the recipe three on a cloud schema, plus `size` on a local one
    // (the second half of the model-switch finding — see
    // mediaModelSwitchRecipe.test.ts, which owns that contract).
    expect(effect).toMatch(/reseedRecipeParams\(existing, res\.params, \w+\)/)
    expect(effect).toContain('if (changed) setParams(modality, next)')
    // the hand-rolled seed-only loop it replaced must not come back
    expect(effect).not.toContain('const seeded')
    // …and it still runs off the LIVE store bag, not a stale render closure
    expect(effect).toContain('useMediaStore.getState().paramsByModality[modality]')
  })

  it('the effect re-runs on every schema change (modality / model / provider switch)', () => {
    const src = page()
    const effect = src.slice(src.indexOf('window.tachi.surplusMedia.modelParams({'), src.indexOf('const shownSchema'))
    expect(effect).toContain('}, [modality, model, setParams])')
    // a provider switch reloads the catalog, which re-selects the model id
    expect(src).toContain('useEffect(() => { loadModels(modality) }, [modality, loadModels])')
  })

  it('Remix and restore-from-PNG pin the exact bag they wrote, by IDENTITY', () => {
    const src = page()
    expect(src).toContain('const explicit = explicitParamsRef.current === existing')
    const remix = src.slice(src.indexOf('const remix = ('), src.indexOf('// ── Auto-save folder'))
    expect(remix).toContain('explicitParamsRef.current = next')
    const restore = src.slice(src.indexOf('const restoreFromImage'), src.indexOf('// ── Esc closes'))
    expect(restore).toContain('explicitParamsRef.current = restored')
    // seeding rewrites the bag, so the pin follows it into the store
    expect(src).toContain('if (explicit) explicitParamsRef.current = changed ? next : existing')
    // the restore still seeds `size` from the provenance (73d461c)
    expect(restore).toContain('size:            `${meta.width}x${meta.height}`')
  })

  it('ParamFields still SHOWS an out-of-enum current value — the heal did not delete that affordance', () => {
    const fields = read('src/pages/media/ParamFields.tsx')
    expect(fields).toContain("{!(spec.enum ?? []).includes(asString(value, spec.default))")
  })
})
