// apps/desktop/test/unit/sdLowVramClipSkip.test.ts
//
// TWO THINGS: the img2img strength that was rendered at 0 and emitted at 0.6,
// and the five memory flags + clip-skip the engine has and the app could not
// express.
//
// ── 1. THE P1: TWO COMPONENTS OWNED ONE KNOB, WITH DIFFERENT DEFAULTS ────────
//
// Driver proof (checkpoint A): two local image runs went out
//
//   sd-cli … -i C:\…\Temp\sd-init-1753…-a1b2c3d4.png --strength 0.6
//
// while the visible IMG2IMG STRENGTH control read 0, with the help text under it
// saying "0 = keep init". The user was told the init frame would be preserved
// and the engine was told to move 60% of the way off it.
//
// Neither number was a bug on its own. `strength` was the ONE param in the image
// schema with no `default`, and ParamFields renders `spec.min` for a default-less
// slider — so the 0 on screen was the CONTROL's idea of "unset". buildSdArgs
// then read `input.strength ?? 0.6`, so the ARG BUILDER's idea of "unset" was
// 0.6. Two owners, two answers, and the params bag was empty in between, which is
// why nothing on screen could show the disagreement.
//
// THE FIX IS THE SCHEMA IDIOM ALREADY USED BY steps / cfg / sampler / size /
// negative_prompt: the spec `default` is the owner. healParamsForSchema seeds it
// into the bag, ParamFields renders the bag, resolveLocalStrength reads the bag,
// and buildSdArgs emits what effectiveImageParams resolved. One number, one
// owner, and the DISPLAYED number is the EMITTED number — pinned both ways below
// (unset, and an explicit 0 that must stay 0).
//
// ── 2. THE FLAGS, SOURCE-ASSERTED AGAINST THE PINNED BINARY ──────────────────
//
// `sd-cli --help` on the installed build (stable-diffusion.cpp commit b290693),
// verbatim, because every gate below is one of these sentences:
//
//   --max-vram <string>     maximum VRAM budget in GiB for graph-cut segmented
//                           execution. Accepts a single value or assignments by
//                           backend/device, e.g. 6 or cuda0=6,vulkan0=4. 0
//                           disables graph splitting; a negative value
//                           auto-detects free VRAM, sparing the specified value
//   --stream-layers         enable residency+prefetch streaming on top of
//                           --max-vram (no effect without --max-vram; defaults
//                           to false)
//   --auto-fit              pick the diffusion/te/vae device placements
//                           automatically from the model size and the per-device
//                           memory budgets (--max-vram; defaults to free memory
//                           minus a small margin). Overrides --backend and
//                           --params-backend; may split modules across GPUs
//   --vae-tiling            process vae in tiles to reduce memory usage
//   --vae-conv-direct       use ggml_conv2d_direct in the vae model
//   --clip-skip <int>       ignore last layers of CLIP network; 1 ignores none,
//                           2 ignores one layer (default: -1). <= 0 represents
//                           unspecified, will be 1 for SD1.x, 2 for SD2.x
//   --strength <float>      strength for noising/unnoising (default: 0.75)
//
// ONE OF THOSE SENTENCES IS TRUE AND INCOMPLETE, and believing it cost us a
// silently-inert control plus a false provenance stamp. `--stream-layers` needs
// BOTH a VRAM budget (which the help names) AND the diffusion params backend on
// CPU (which only `docs/performance.md` names, and which `--offload-to-cpu`
// supplies). Read from the engine source at the same commit rather than from
// either sentence:
//
//   src/core/ggml_extend.hpp:3127  compute_graph_cut_segments(gf, plan, n_threads,
//                                    stream_layers_enabled, no_return)
//     …the ONLY place the flag reaches the executor, behind
//   :3120                          if (can_attempt_graph_cut_segmented_compute())
//   :2377                            = max_graph_vram_bytes > 0 && !cpu && !multi
//
//   src/stable-diffusion.cpp:874   if (stream_layers &&
//                                      !params_backend_is_cpu(DIFFUSION)) {
//   :875                             LOG_WARN("--stream-layers has no effect unless
//                                      diffusion params backend is cpu; ignoring");
//
//   examples/common/common.cpp:770 if (offload_params_to_cpu)
//   :771                             prepend_backend_assignment(params, "*=cpu");
//
// …and `--auto-fit` REMOVES the second condition again (backend_fit.cpp:326
// "ignoring --backend / --params-backend", then it overwrites the params spec),
// which is why streaming and auto-fit are mutually exclusive below.
//
// Three of those sentences are load-bearing and are pinned as behaviour here:
//   • --stream-layers WITHOUT --max-vram does nothing, so it must not be emitted
//     alone — a flag the engine ignores is a control that lies — and neither does
//     it do anything without --offload-to-cpu, which it now brings with it;
//   • --max-vram takes a NEGATIVE value meaning "auto-detect free VRAM, sparing
//     this much", which is exactly the committed 8 GB recipe (`--max-vram -1
//     --stream-layers --clip-on-cpu --vae-tiling`, VIDEO-MODELS-RESEARCH §4), so
//     the control has to be able to say it;
//   • --auto-fit OVERRIDES --backend/--params-backend, and `--clip-on-cpu` is
//     that build's deprecated alias for `--backend te=cpu`. So turning auto-fit
//     on hands the app's own text-encoder placement to the engine. Both flags
//     still travel (the engine resolves its own precedence; dropping one would be
//     the app second-guessing it) and the schema says so out loud.

import { describe, it, expect, vi, afterAll } from 'vitest'
import { rmSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'tachi-sdlowvram-'))
})
afterAll(() => { try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ } })
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  buildSdArgs, buildSdVideoArgs, effectiveImageParams, effectiveVideoParams,
  sdMemoryArgs, type SdArgEnv, type SdGenerateInput,
} from '../../electron/services/sd-cpp-client'
import { findSdRow, SD_IMAGE_MODELS, SD_VIDEO_MODELS } from '../../electron/services/sd-cpp-models'
import { modelParamSchema } from '../../electron/services/surplus-media-service'
import {
  resolveLocalStrength, resolveLocalMemoryFlags, resolveLocalClipSkip, resolveLocalVramBudget,
  schemaOffersClipSkip,
  healParamsForSchema, stampLocalEngineParams,
  SD_IMG2IMG_STRENGTH_DEFAULT, SD_CLI_STRENGTH_DEFAULT,
  SD_CLIP_SKIP_MAX, SD_MAX_VRAM_AUTO, SD_MAX_VRAM_OPTIONS,
} from '../../src/pages/media/localGenParams'

/** The value of a `--flag <value>` pair, or undefined when the flag is absent. */
const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}

const IMG_ROW  = 'sd15'
const imgEnv = (): SdArgEnv => ({ row: findSdRow(IMG_ROW) })
const imgArgs = (input: Partial<SdGenerateInput> = {}): string[] => buildSdArgs(
  { model: 'm.safetensors' },
  { modelId: IMG_ROW, prompt: 'a lighthouse', ...input },
  'out.png',
  imgEnv(),
)

/** What ParamFields puts on screen for `values[name]` — its own rule, verbatim:
 *  `const fallback = typeof spec.default === 'number' ? spec.default : min`,
 *  `const num = typeof value === 'number' && isFinite(value) ? value : fallback`.
 *  Re-stated here because it is the HALF OF THE BUG that lives in the renderer,
 *  and the pin below is that this number equals the one on the command line. */
const displayedNumber = (
  spec: { default?: unknown; min?: number } | undefined,
  value: unknown,
): number => {
  const min = spec?.min ?? 0
  const fallback = typeof spec?.default === 'number' ? spec.default : min
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

// ═══ 1. THE P1, BOTH WAYS ════════════════════════════════════════════════════

describe('img2img strength — ONE default owner (the checkpoint-A P1)', () => {
  const schema = () => modelParamSchema('image', IMG_ROW)
  const strengthSpec = () => schema().find(s => s.name === 'strength')

  it('THE REPRO, in the two numbers that disagreed', () => {
    // The bug in one line: an untouched bag displayed one number and ran another.
    const spec = strengthSpec()!
    const shown = displayedNumber(spec, undefined)
    // Before the fix this was 0 (spec.min, because there was no default) while
    // the argv carried 0.6. Now the spec owns it and there is only one number.
    expect(shown).toBe(SD_IMG2IMG_STRENGTH_DEFAULT)
    const args = imgArgs({ initImagePath: 'C:\\pics\\ref.png' })
    expect(flag(args, '--strength')).toBe(String(shown))
  })

  it('the LOCAL image spec owns a default, and it is a real number', () => {
    expect(strengthSpec()?.default).toBe(SD_IMG2IMG_STRENGTH_DEFAULT)
    expect(typeof strengthSpec()?.default).toBe('number')
  })

  it('the whole chain agrees for an UNTOUCHED bag: seed → display → emit', () => {
    // 1. the schema arrives and SEEDS the bag (MediaPage's schema effect).
    const { next } = healParamsForSchema({}, schema())
    expect(next.strength).toBe(SD_IMG2IMG_STRENGTH_DEFAULT)
    // 2. ParamFields renders the bag value — the same number.
    expect(displayedNumber(strengthSpec(), next.strength)).toBe(SD_IMG2IMG_STRENGTH_DEFAULT)
    // 3. the composer forwards it, gated on a frame being attached.
    expect(resolveLocalStrength(next, true)).toEqual({ strength: SD_IMG2IMG_STRENGTH_DEFAULT })
    expect(resolveLocalStrength(next, false)).toEqual({})
    // 4. …and the argv carries exactly that.
    const args = imgArgs({ initImagePath: 'ref.png', ...resolveLocalStrength(next, true) })
    expect(flag(args, '--strength')).toBe(String(SD_IMG2IMG_STRENGTH_DEFAULT))
  })

  it('AND THE OTHER WAY: an explicit 0 stays 0 — "keep init" means keep init', () => {
    const bag = { strength: 0 }
    // healing must not overwrite a deliberate 0 with the default (0 is in range).
    const { next } = healParamsForSchema(bag, schema())
    expect(next.strength).toBe(0)
    expect(displayedNumber(strengthSpec(), next.strength)).toBe(0)
    expect(resolveLocalStrength(next, true)).toEqual({ strength: 0 })
    const args = imgArgs({ initImagePath: 'ref.png', strength: 0 })
    expect(flag(args, '--strength')).toBe('0')
  })

  it('every value the control can produce round-trips display → argv', () => {
    for (const v of [0, 0.05, 0.35, 0.6, 0.95, 1]) {
      const shown = displayedNumber(strengthSpec(), v)
      const args = imgArgs({ initImagePath: 'ref.png', strength: v })
      expect(flag(args, '--strength')).toBe(String(shown))
    }
  })

  it('no init frame ⇒ no -i and no --strength at all (byte-identical t2i)', () => {
    const args = imgArgs({ strength: 0.4 })
    expect(args).not.toContain('-i')
    expect(args).not.toContain('--strength')
  })

  it('the RENDERER half of the rule is still the rule (the cross-file pin)', () => {
    // `displayedNumber` above re-states ParamFields' own fallback, and this whole
    // fix rests on it: a default-less number spec renders `spec.min`, which is
    // where the 0 came from. If that line is ever reworked, the re-statement here
    // silently stops describing the app — so the source is asserted rather than
    // trusted, the way mediaModelSwitchRecipe pins MediaPage's own wiring.
    const src = readFileSync(resolve(__dirname, '../../src/pages/media/ParamFields.tsx'), 'utf8')
    expect(src).toContain("const fallback = typeof spec.default === 'number' ? spec.default : min")
    expect(src).toContain('const num = typeof value === \'number\' && Number.isFinite(value) ? value : fallback')
  })

  it('the app default is NOT sd-cli\'s own, and both numbers are named once', () => {
    // The engine would use 0.75 if we passed nothing (`--help`: "default: 0.75").
    // We pass 0.6 deliberately — closer to the init frame — and the divergence is
    // recorded rather than buried in a `??` in the arg builder.
    expect(SD_CLI_STRENGTH_DEFAULT).toBe(0.75)
    expect(SD_IMG2IMG_STRENGTH_DEFAULT).toBe(0.6)
    expect(SD_IMG2IMG_STRENGTH_DEFAULT).not.toBe(SD_CLI_STRENGTH_DEFAULT)
  })

  it('an out-of-band strength cannot reach the engine', () => {
    // The bag comes back out of localStorage, where a hand edit leaves anything.
    expect(resolveLocalStrength({ strength: 4 }, true)).toEqual({})
    expect(resolveLocalStrength({ strength: -1 }, true)).toEqual({})
    expect(resolveLocalStrength({ strength: 'a lot' }, true)).toEqual({})
    // …and a run with a frame still gets the ONE default rather than nothing.
    expect(flag(imgArgs({ initImagePath: 'ref.png' }), '--strength'))
      .toBe(String(SD_IMG2IMG_STRENGTH_DEFAULT))
  })

  it('a LOCAL VIDEO row is not offered a strength it cannot use', () => {
    // `-M vid_gen` takes `-i` and NO `--strength` (buildSdVideoArgs, and the
    // engine's own i2v commands) — so the control was decorative on the i2v row.
    const i2v = SD_VIDEO_MODELS.find(m => m.i2v)!
    const vschema = modelParamSchema('video', i2v.id)
    expect(vschema.find(s => s.name === 'image_url')).toBeDefined()   // the frame IS offered
    expect(vschema.find(s => s.name === 'strength')).toBeUndefined()  // its strength is not
  })

  it('a CLOUD image model keeps no local default (the body must not change)', () => {
    // The bag is forwarded verbatim to the gateway (mergeExtraParams), so seeding
    // a strength into every cloud t2i request would be a param nobody asked for.
    const cloud = modelParamSchema('image', 'gpt-image-2').find(s => s.name === 'strength')
    expect(cloud).toBeDefined()
    expect(cloud?.default).toBeUndefined()
  })
})

// ═══ 2. THE PROVENANCE GAP: Remix could not tell an img2img run apart ════════

describe('an img2img run says so in its own provenance', () => {
  it('effectiveImageParams records the frame AND the strength that ran', () => {
    const eff = effectiveImageParams(
      { modelId: IMG_ROW, prompt: 'p', initImagePath: 'C:\\pics\\ref.png' }, imgEnv(),
    )
    expect(eff.initImage).toBe(true)
    expect(eff.strength).toBe(SD_IMG2IMG_STRENGTH_DEFAULT)
  })

  it('…and a text→image run claims neither (absent, not false)', () => {
    const eff = effectiveImageParams({ modelId: IMG_ROW, prompt: 'p' }, imgEnv())
    expect('initImage' in eff).toBe(false)
    expect('strength' in eff).toBe(false)
  })

  it('the stamp and the argv cannot disagree about --strength', () => {
    const input = { modelId: IMG_ROW, prompt: 'p', initImagePath: 'ref.png', strength: 0.25 }
    const eff = effectiveImageParams(input, imgEnv())
    expect(flag(buildSdArgs({ model: 'm.safetensors' }, input, 'o.png', imgEnv()), '--strength'))
      .toBe(String(eff.strength))
  })

  it('the gallery entry records the mode and the number (Remix reads this)', () => {
    // THE REPRO: the entry recorded `steps: 20` with no image_url and no
    // strength, because the data: URL is stripped before localStorage and the
    // strength was never in the bag. `img2img` is the durable marker — it is not
    // a data URL, so it survives the strip.
    const out = stampLocalEngineParams({ prompt: 'p', steps: 20 }, {
      steps: 20, cfgScale: 7, samplingMethod: 'euler', initImage: true, strength: 0.6,
    })
    expect(out).toMatchObject({ img2img: true, strength: 0.6 })
  })

  it('a t2i entry gains no new keys at all', () => {
    const out = stampLocalEngineParams({}, { steps: 4, cfgScale: 1, samplingMethod: 'euler' })
    expect(Object.keys(out).sort()).toEqual(['cfg', 'sampler', 'steps'])
  })
})

// ═══ 3. CLIP SKIP ════════════════════════════════════════════════════════════

describe('--clip-skip: the #1 "why does it look wrong" on Civitai SD 1.5 merges', () => {
  it('the control exists on the families that HAVE a CLIP to skip', () => {
    for (const id of ['sd15', 'sdxl-base-1.0']) {
      const spec = modelParamSchema('image', id).find(s => s.name === 'clip_skip')
      expect(spec, id).toBeDefined()
      expect(spec?.advanced).toBe(true)
      expect(spec?.default).toBe(0)      // 0 = the engine decides; nothing changes
      expect(spec?.max).toBe(SD_CLIP_SKIP_MAX)
      expect(spec?.description).toMatch(/2/)  // …and it names the community norm
    }
  })

  it('…and NOT on the rows whose conditioning has no CLIP layers to skip', () => {
    // Z-Image conditions on an LLM (`--llm`) and Wan on umt5. A clip-skip control
    // there would be a knob wired to nothing — the D1 class, freshly minted.
    expect(modelParamSchema('image', 'z-image-turbo').find(s => s.name === 'clip_skip')).toBeUndefined()
    expect(modelParamSchema('video', SD_VIDEO_MODELS[0].id).find(s => s.name === 'clip_skip')).toBeUndefined()
    expect(modelParamSchema('image', 'gpt-image-2').find(s => s.name === 'clip_skip')).toBeUndefined()
  })

  it('NO SHIPPED ROW sets one — the control is exposed, the value is not assumed', () => {
    // 2 is the norm for anime-class SD 1.5 merges and we have no evidence for any
    // particular curated checkpoint, so nothing is pre-set behind the user.
    for (const row of SD_IMAGE_MODELS) expect(row.clipSkip, row.id).toBeUndefined()
  })

  it('emits --clip-skip only from 1 up (0 stays byte-identical to before)', () => {
    expect(imgArgs()).not.toContain('--clip-skip')
    expect(imgArgs({ clipSkip: 0 })).not.toContain('--clip-skip')
    expect(imgArgs({ clipSkip: -3 })).not.toContain('--clip-skip')
    expect(flag(imgArgs({ clipSkip: 2 }), '--clip-skip')).toBe('2')
    expect(flag(imgArgs({ clipSkip: 12 }), '--clip-skip')).toBe('12')
  })

  it('clamps to the band the control offers', () => {
    expect(flag(imgArgs({ clipSkip: 99 }), '--clip-skip')).toBe(String(SD_CLIP_SKIP_MAX))
    expect(flag(imgArgs({ clipSkip: 2.7 }), '--clip-skip')).toBe('2')
  })

  it('the composer resolver reads the SCHEMA\'s name and drops the no-ops', () => {
    expect(resolveLocalClipSkip({})).toEqual({})
    expect(resolveLocalClipSkip({ clip_skip: 0 })).toEqual({})
    expect(resolveLocalClipSkip({ clip_skip: 2 })).toEqual({ clipSkip: 2 })
    expect(resolveLocalClipSkip({ clip_skip: '2' })).toEqual({ clipSkip: 2 })
    expect(resolveLocalClipSkip({ clip_skip: 'x' })).toEqual({})
  })

  it('THE OUT-VOTE: a 2 left in the bag cannot ride onto a row with no control', () => {
    // The bag is persisted per MODALITY, so a clip skip set for an SD 1.5 merge
    // is still there after switching to Z-Image — whose schema drops the control
    // entirely. Sending it then would be an invisible flag from a control that is
    // no longer on screen, which is the same class as the `image_url` out-vote.
    const sd15 = modelParamSchema('image', 'sd15')
    const zimg = modelParamSchema('image', 'z-image-turbo')
    expect(schemaOffersClipSkip(sd15)).toBe(true)
    expect(schemaOffersClipSkip(zimg)).toBe(false)
    const bag = { clip_skip: 2 }
    expect(resolveLocalClipSkip(bag, schemaOffersClipSkip(sd15))).toEqual({ clipSkip: 2 })
    expect(resolveLocalClipSkip(bag, schemaOffersClipSkip(zimg))).toEqual({})
  })

  it('a ROW may declare one, and the composer out-votes it', () => {
    const row = { ...findSdRow('sd15')!, clipSkip: 2 } as ReturnType<typeof findSdRow>
    const rowEnv: SdArgEnv = { row }
    const a = buildSdArgs({ model: 'm.safetensors' }, { modelId: 'sd15', prompt: 'p' }, 'o.png', rowEnv)
    expect(flag(a, '--clip-skip')).toBe('2')
    const b = buildSdArgs({ model: 'm.safetensors' }, { modelId: 'sd15', prompt: 'p', clipSkip: 1 }, 'o.png', rowEnv)
    expect(flag(b, '--clip-skip')).toBe('1')
  })

  it('it is a RECIPE fact, so it reaches provenance', () => {
    const eff = effectiveImageParams({ modelId: IMG_ROW, prompt: 'p', clipSkip: 2 }, imgEnv())
    expect(eff.clipSkip).toBe(2)
    expect(stampLocalEngineParams({}, { steps: 20, cfgScale: 7, samplingMethod: 'euler', clipSkip: 2 }))
      .toMatchObject({ clip_skip: 2 })
    // …and an unset one writes no key rather than a 0 nobody chose.
    expect('clip_skip' in stampLocalEngineParams({}, { steps: 20, cfgScale: 7, samplingMethod: 'euler' }))
      .toBe(false)
  })
})

// ═══ 4. THE MEMORY LADDER ════════════════════════════════════════════════════

describe('sdMemoryArgs — the five flags, with the engine\'s own gates', () => {
  it('nothing asked for ⇒ no flags (every existing run is byte-identical)', () => {
    expect(sdMemoryArgs({})).toEqual([])
  })

  it('--vae-tiling / --vae-conv-direct are plain switches', () => {
    expect(sdMemoryArgs({ vaeTiling: true })).toEqual(['--vae-tiling'])
    expect(sdMemoryArgs({ vaeConvDirect: true })).toEqual(['--vae-conv-direct'])
    expect(sdMemoryArgs({ vaeTiling: false, vaeConvDirect: false })).toEqual([])
  })

  it('--max-vram carries GiB, and a NEGATIVE value is the auto form', () => {
    expect(sdMemoryArgs({ maxVramGb: 6 })).toEqual(['--max-vram', '6'])
    // "a negative value auto-detects free VRAM, sparing the specified value"
    expect(sdMemoryArgs({ maxVramGb: SD_MAX_VRAM_AUTO })).toEqual(['--max-vram', '-1'])
    // 0 is the engine's own "disables graph splitting" — i.e. off, so no flag.
    expect(sdMemoryArgs({ maxVramGb: 0 })).toEqual([])
    expect(sdMemoryArgs({ maxVramGb: Number.NaN })).toEqual([])
  })

  it('THE GATE, HALF ONE: --stream-layers is never emitted without --max-vram', () => {
    // Not from the help string this time, from the engine: stream_layers_enabled
    // reaches the executor through exactly one call — compute_graph_cut_segments
    // at ggml_extend.hpp:3127 — behind can_attempt_graph_cut_segmented_compute(),
    // which is `max_graph_vram_bytes > 0 && …`. No budget, no segmenter, no
    // streaming. Emitting it alone is a control that lies.
    expect(sdMemoryArgs({ streamLayers: true })).toEqual([])
    expect(sdMemoryArgs({ streamLayers: true, maxVramGb: 0 })).toEqual([])
  })

  it('THE GATE, HALF TWO: --stream-layers DRAGS --offload-to-cpu ONTO THE LINE', () => {
    // THE BUG. Half one was implemented and half two was not, so every image-path
    // `--stream-layers` was dropped by the engine with
    //   "--stream-layers has no effect unless diffusion params backend is cpu;
    //    ignoring"                                 (stable-diffusion.cpp:874)
    // …while the PNG's provenance recorded `streamLayers: true`. `--offload-to-cpu`
    // is the ONLY thing our command line can say to satisfy it: common.cpp:770
    // prepends `*=cpu` to --params-backend. So it is emitted WITH the flag, not
    // left to a path that happens to pass it.
    expect(sdMemoryArgs({ streamLayers: true, maxVramGb: 8 }))
      .toEqual(['--offload-to-cpu', '--max-vram', '8', '--stream-layers'])
    expect(sdMemoryArgs({ streamLayers: true, maxVramGb: SD_MAX_VRAM_AUTO }))
      .toEqual(['--offload-to-cpu', '--max-vram', '-1', '--stream-layers'])
  })

  it('…and the offload is NOT emitted by anything else — no silent slow-down', () => {
    // `--offload-to-cpu` puts every weight in RAM. It is a real cost, so it rides
    // in only as the precondition of a flag the user asked for (or when the path
    // itself declares it — the video ctx below).
    expect(sdMemoryArgs({ maxVramGb: 8 })).toEqual(['--max-vram', '8'])
    expect(sdMemoryArgs({ vaeTiling: true, vaeConvDirect: true, autoFit: true }))
      .toEqual(['--auto-fit', '--vae-tiling', '--vae-conv-direct'])
  })

  it('THE THIRD CONDITION: --auto-fit takes the placement back, so streaming is dropped', () => {
    // backend_fit.cpp:326 logs "--auto-fit is enabled; ignoring --backend /
    // --params-backend" and then OVERWRITES the params spec from its own plan —
    // before the :874 check runs. So under auto-fit `--offload-to-cpu` is
    // discarded and NOTHING on our command line can promise the precondition.
    // The flag is not emitted, and (below) not stamped: declining to record a
    // fact the argv cannot support is not the same as second-guessing the engine.
    expect(sdMemoryArgs({ streamLayers: true, maxVramGb: 8, autoFit: true }))
      .toEqual(['--auto-fit', '--max-vram', '8'])
    // …and the video path's own unconditional offload does NOT rescue it either.
    expect(sdMemoryArgs({ streamLayers: true, maxVramGb: 8, autoFit: true }, { offloadToCpu: true }))
      .toEqual(['--offload-to-cpu', '--auto-fit', '--max-vram', '8'])
  })

  it('--auto-fit stands alone (its budget defaults to free memory)', () => {
    expect(sdMemoryArgs({ autoFit: true })).toEqual(['--auto-fit'])
  })

  it('the video path DECLARES its offload rather than pushing it, so it lands once', () => {
    // buildSdVideoArgs used to `args.push('--offload-to-cpu')` immediately before
    // calling this. With the flag now also being --stream-layers' precondition,
    // two emitters would put it on the argv twice the moment a user asked for
    // streaming. One emitter, one flag, and the position is unchanged.
    expect(sdMemoryArgs(undefined, { offloadToCpu: true })).toEqual(['--offload-to-cpu'])
    expect(sdMemoryArgs({ streamLayers: true, maxVramGb: 8 }, { offloadToCpu: true }))
      .toEqual(['--offload-to-cpu', '--max-vram', '8', '--stream-layers'])
  })

  it('THE COMMITTED 8 GB RECIPE is expressible, in one order', () => {
    // VIDEO-MODELS-RESEARCH §4: `--max-vram -1 --stream-layers --clip-on-cpu
    // --vae-tiling`. The first three are this function's; --clip-on-cpu is
    // already unconditional on the multi-component branch. The offload the
    // recipe never wrote down is what made it work on the video path.
    expect(sdMemoryArgs({ maxVramGb: SD_MAX_VRAM_AUTO, streamLayers: true, vaeTiling: true }))
      .toEqual(['--offload-to-cpu', '--max-vram', '-1', '--stream-layers', '--vae-tiling'])
  })
})

describe('the memory ladder reaches BOTH sd-cli invocations', () => {
  /** Everything at once — MINUS auto-fit, which is mutually exclusive with
   *  streaming (it discards the params placement streaming depends on). */
  const MEM = { maxVramGb: 6, streamLayers: true, vaeTiling: true, vaeConvDirect: true }
  /** …and the placement flag on its own, for the runs that want the engine to fit. */
  const FIT = { maxVramGb: 6, vaeTiling: true, vaeConvDirect: true, autoFit: true }

  it('IMAGE: every flag lands on the img_gen command line', () => {
    const a = imgArgs(MEM)
    expect(flag(a, '--max-vram')).toBe('6')
    for (const f of ['--stream-layers', '--vae-tiling', '--vae-conv-direct', '--offload-to-cpu']) {
      expect(a, f).toContain(f)
    }
    // THE BUG: the image builder emitted --stream-layers and never the offload it
    // needs, so the engine dropped it on every single image render.
    expect(a.indexOf('--offload-to-cpu'), 'the precondition must precede nothing in particular, but must BE there')
      .toBeGreaterThanOrEqual(0)
    expect(imgArgs(FIT)).toContain('--auto-fit')
    expect(imgArgs(FIT)).not.toContain('--stream-layers')
  })

  it('IMAGE: a run that did not ask for streaming is byte-identical to before', () => {
    // --offload-to-cpu is a real cost (weights in RAM). Nothing else may drag it in.
    expect(imgArgs({ maxVramGb: 6, vaeTiling: true })).not.toContain('--offload-to-cpu')
    expect(imgArgs({})).not.toContain('--offload-to-cpu')
  })

  it('VIDEO: the same, on the row whose VAE decode is what OOMs', () => {
    const row = SD_VIDEO_MODELS[0]
    const vidArgs = (mem: Record<string, unknown>): string[] => buildSdVideoArgs(
      { diffusion: 'd.gguf', vae: 'v.safetensors', t5xxl: 't5.gguf' },
      { modelId: row.id, prompt: 'a cat', ...mem },
      'out.webm',
      { row: findSdRow(row.id) },
    )
    const a = vidArgs(MEM)
    expect(flag(a, '--max-vram')).toBe('6')
    for (const f of ['--stream-layers', '--vae-tiling', '--vae-conv-direct']) {
      expect(a, f).toContain(f)
    }
    // THE FLAG THAT MADE THE VIDEO PATH RIGHT BY ACCIDENT — still unconditional,
    // and now still exactly once even though streaming also asks for it.
    expect(a.filter(x => x === '--offload-to-cpu')).toEqual(['--offload-to-cpu'])
    expect(vidArgs({}).filter(x => x === '--offload-to-cpu')).toEqual(['--offload-to-cpu'])
    expect(vidArgs(FIT)).toContain('--auto-fit')
    expect(vidArgs(FIT)).not.toContain('--stream-layers')
  })

  it('AUTO-FIT MEETS --clip-on-cpu: both travel, and the help says who wins', () => {
    // `--auto-fit` "Overrides --backend and --params-backend"; `--clip-on-cpu` is
    // that build's deprecated alias for `--backend te=cpu`. So the engine's own
    // placement wins over ours — recorded here so the next reader does not have
    // to re-derive it from the help, and so a future "just drop one" is a
    // deliberate change to a pinned fact.
    const a = buildSdArgs(
      { diffusion: 'd.gguf', vae: 'v.sft', clip_l: 'c.sft', t5xxl: 't.gguf' },
      { modelId: 'flux1-dev-q4', prompt: 'p', autoFit: true },
      'o.png', { row: findSdRow('flux1-dev-q4') },
    )
    expect(a).toContain('--clip-on-cpu')
    expect(a).toContain('--auto-fit')
  })

  it('the flags a run went out with reach provenance, on both paths', () => {
    // The offload rides along, because a chunk that says `streamLayers: true`
    // without saying what made streaming possible cannot re-run its own image.
    const streamed = { maxVramGb: 6, streamLayers: true, offloadToCpu: true, vaeTiling: true, vaeConvDirect: true }
    expect(effectiveImageParams({ modelId: IMG_ROW, prompt: 'p', ...MEM }, imgEnv()).memory).toEqual(streamed)
    const vrow = SD_VIDEO_MODELS[0]
    expect(effectiveVideoParams({ modelId: vrow.id, prompt: 'p', ...MEM }, { row: findSdRow(vrow.id) }).memory)
      .toEqual(streamed)
  })

  it('THE STAMP: a --stream-layers the ENGINE would ignore is never recorded', () => {
    // The whole bug in one assertion. Before the fix, an image run with a budget
    // and the toggle on wrote `streamLayers: true` into the PNG while the engine
    // logged "…has no effect unless diffusion params backend is cpu; ignoring".
    // Now the stamp can only say it when the argv can back it.
    const stamp = (f: Record<string, unknown>): unknown =>
      effectiveImageParams({ modelId: IMG_ROW, prompt: 'p', ...f }, imgEnv()).memory
    // …no budget: not emitted, not stamped.
    expect(stamp({ streamLayers: true })).toBeUndefined()
    // …budget but auto-fit: the placement is the engine's, so we claim nothing.
    expect(stamp({ streamLayers: true, maxVramGb: 6, autoFit: true }))
      .toEqual({ maxVramGb: 6, autoFit: true })
    // …and the case that works says BOTH halves.
    expect(stamp({ streamLayers: true, maxVramGb: 6 }))
      .toEqual({ maxVramGb: 6, streamLayers: true, offloadToCpu: true })
  })

  it('…and a run with none records NO memory object rather than an empty one', () => {
    expect('memory' in effectiveImageParams({ modelId: IMG_ROW, prompt: 'p' }, imgEnv())).toBe(false)
    // The gate applies to provenance too: an ignored flag is not a fact.
    expect('memory' in effectiveImageParams({ modelId: IMG_ROW, prompt: 'p', streamLayers: true }, imgEnv()))
      .toBe(false)
    // VIDEO: its path-level `--offload-to-cpu` is a property of the PATH, not of
    // the run, so it must not turn every video entry into one that "asked for"
    // something. The stamp answers "what did THIS RUN ask for".
    const vrow = SD_VIDEO_MODELS[0]
    expect('memory' in effectiveVideoParams({ modelId: vrow.id, prompt: 'p' }, { row: findSdRow(vrow.id) }))
      .toBe(false)
  })
})

// ═══ 5. THE ADVANCED CONTROLS ════════════════════════════════════════════════

describe('the advanced-controls group the recipes needed', () => {
  const local = (id: string, modality: 'image' | 'video' = 'image') => modelParamSchema(modality, id)
  const MEMORY_PARAMS = ['vae_tiling', 'vae_conv_direct', 'max_vram', 'stream_layers', 'auto_fit']

  it('LOCAL image rows offer all five, collapsed', () => {
    const schema = local(IMG_ROW)
    for (const name of MEMORY_PARAMS) {
      const spec = schema.find(s => s.name === name)
      expect(spec, name).toBeDefined()
      expect(spec?.advanced, name).toBe(true)
      expect(spec?.description, name).toBeTruthy()
    }
  })

  it('LOCAL video rows offer them too — this is where the OOM happens', () => {
    const schema = local(SD_VIDEO_MODELS[0].id, 'video')
    for (const name of MEMORY_PARAMS) expect(schema.find(s => s.name === name), name).toBeDefined()
  })

  it('CLOUD models offer none of them (they are sd.cpp flags)', () => {
    const schema = local('gpt-image-2')
    for (const name of MEMORY_PARAMS) expect(schema.find(s => s.name === name), name).toBeUndefined()
  })

  it('the VRAM budget is an enum, so the auto form is sayable without a minus', () => {
    const spec = local(IMG_ROW).find(s => s.name === 'max_vram')!
    expect(spec.kind).toBe('enum')
    expect(spec.default).toBe('off')
    expect(spec.enum).toEqual([...SD_MAX_VRAM_OPTIONS])
    expect(spec.enum).toContain('auto')
  })

  it('…and the resolver maps every option to what the engine takes', () => {
    expect(resolveLocalVramBudget({})).toEqual({})
    expect(resolveLocalVramBudget({ max_vram: 'off' })).toEqual({})
    expect(resolveLocalVramBudget({ max_vram: 'auto' })).toEqual({ maxVramGb: SD_MAX_VRAM_AUTO })
    expect(resolveLocalVramBudget({ max_vram: '8' })).toEqual({ maxVramGb: 8 })
    expect(resolveLocalVramBudget({ max_vram: 'nonsense' })).toEqual({})
    for (const opt of SD_MAX_VRAM_OPTIONS) {
      expect(() => resolveLocalVramBudget({ max_vram: opt })).not.toThrow()
    }
  })

  it('the stream-layers HINT names BOTH conditions — the gate is not silent', () => {
    const spec = local(IMG_ROW).find(s => s.name === 'stream_layers')!
    expect(spec.description).toMatch(/budget/i)
    // …and the half the old text left out, which is why the toggle was inert.
    expect(spec.description).toMatch(/RAM/i)
    expect(spec.description).toMatch(/auto-fit/i)
  })

  it('the auto-fit HINT admits it overrides the app\'s own placement', () => {
    const spec = local(IMG_ROW).find(s => s.name === 'auto_fit')!
    expect(spec.description).toMatch(/place|placement/i)
  })

  it('EVERY new control is actually forwarded by the surfaces that render it', () => {
    // The controls this lane adds would otherwise be the audit-D1 class in its
    // purest form — a schema that renders five toggles no payload carries. Both
    // local surfaces assemble their own call, so both are pinned: the media tab
    // (image AND video) and the canvas media node.
    const page   = readFileSync(resolve(__dirname, '../../src/pages/media/MediaPage.tsx'), 'utf8')
    const canvas = readFileSync(resolve(__dirname, '../../electron/services/graph-to-agentkit.ts'), 'utf8')
    expect((page.match(/\.\.\.resolveLocalMemoryFlags\(runParams\)/g) ?? []).length).toBe(2)
    expect(page).toContain('...resolveLocalClipSkip(runParams, schemaOffersClipSkip(shownSchema))')
    expect(canvas).toContain('...resolveLocalMemoryFlags(params)')
    expect(canvas).toContain('...resolveLocalClipSkip(params, schemaOffersClipSkip(lschema))')
    // …and the canvas's own THIRD copy of the img2img default is gone with them.
    expect(canvas).not.toMatch(/strength:\s*typeof params\.strength/)
    expect(canvas).toContain('...resolveLocalStrength(params, true)')
  })

  it('one composer resolver collects the whole group under the IPC names', () => {
    expect(resolveLocalMemoryFlags({})).toEqual({})
    expect(resolveLocalMemoryFlags({
      vae_tiling: true, vae_conv_direct: true, auto_fit: true, stream_layers: true, max_vram: 'auto',
    })).toEqual({
      vaeTiling: true, vaeConvDirect: true, autoFit: true, streamLayers: true, maxVramGb: SD_MAX_VRAM_AUTO,
    })
    // An explicit OFF travels as nothing rather than as `false`: the arg builder
    // emits on truthiness, and a bag full of `false` is the same command line.
    expect(resolveLocalMemoryFlags({ vae_tiling: false, max_vram: 'off' })).toEqual({})
  })
})

// ═══ 6. STRUCTURED FIT NUMBERS (4B renders these) ════════════════════════════

describe('minVramGb / minRamGb — the numbers that were prose', () => {
  const rows = [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS]

  it('every declared number is a plausible GiB figure, not a byte count', () => {
    for (const r of rows) {
      if (r.minVramGb !== undefined) {
        expect(Number.isFinite(r.minVramGb), r.id).toBe(true)
        expect(r.minVramGb, r.id).toBeGreaterThan(0)
        expect(r.minVramGb, r.id).toBeLessThanOrEqual(48)
      }
      if (r.minRamGb !== undefined) {
        expect(r.minRamGb, r.id).toBeGreaterThan(0)
        expect(r.minRamGb, r.id).toBeLessThanOrEqual(256)
      }
    }
  })

  it('the 14B video rows carry the 12 GB their own notes measured', () => {
    // "33 frames at the row default of 20 steps took ~44 min on a 12 GB card …
    // ~11.5 GB of VRAM in use" — the row's own sentence, as a number.
    for (const id of ['wan21-i2v-14b-480p', 'wan22-i2v-a14b', 'wan22-t2v-a14b']) {
      const row = SD_VIDEO_MODELS.find(m => m.id === id)
      expect(row, id).toBeDefined()
      expect(row?.minVramGb, id).toBe(12)
    }
  })

  it('the LTX-AV row says RAM, because RAM is its binding constraint', () => {
    // "the weights are held in system RAM, so plan on 32 GB of RAM or more …
    // 8 GB of VRAM is not the binding constraint here, memory is."
    const row = SD_VIDEO_MODELS.find(m => m.id.startsWith('ltx'))
    expect(row?.minRamGb).toBe(32)
  })

  it('NO number is invented for a row whose notes state none', () => {
    // The image rows' notes say "GPU recommended", never a figure. A fabricated
    // 'needs ~N GB' is the same class of lie as the estimateFit verdict 4B is
    // removing, so absence has to stay absence and the card falls back to prose.
    for (const r of SD_IMAGE_MODELS) {
      if (r.minVramGb !== undefined) {
        expect(r.notes ?? '', r.id).toMatch(new RegExp(`${r.minVramGb}\\s*GB`, 'i'))
      }
    }
  })
})
