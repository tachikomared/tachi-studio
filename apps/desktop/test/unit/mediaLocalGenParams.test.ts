// apps/desktop/test/unit/mediaLocalGenParams.test.ts
//
// THE THREE CONTROLS THAT DECIDE WHAT THE SAMPLER DOES WERE LYING.
//
// Audit lane U1, findings D1 / D2 / D3 / D5 / D17 — one contract, five ways of
// being wrong about it:
//
//  D1  The schema declares `cfg` and `sampler`. Both local call sites read
//      `cfgScale` and `samplingMethod`, names only the PRESET PICKER ever
//      wrote. So dragging "Guidance (CFG)" to 12 changed nothing, picking a
//      sampler changed nothing, and the slider kept showing the number that did
//      not run. Exactly the class of 73d461c / 2bd48fc, on two more params.
//  D2  Those specs carried NO default and no per-model narrowing, so
//      ParamFields fell back to `min` — the Steps slider read 1 and the CFG
//      slider read 1 on EVERY local model while sd-cli ran the row's 20/28/4.
//      And SD-Turbo, a one-step model, was offered 50 steps: unlike cfg, the
//      steps path was always live, so that is a real 50x waste one drag away.
//  D17 The sampler enum was spelled in A1111/diffusers names (`dpmpp_2m`,
//      `ddim`, `lms`) that sd-cli REJECTS. Harmless only while D1 kept the
//      control dead — fixing D1 alone would have started feeding the engine
//      names it does not accept, so D17 ships in the same change.
//  D3  Every resolver lived inside MediaPage.tsx, which is why the CANVAS media
//      node — whose local branch runs in MAIN — never got the size / duration /
//      frames / negative_prompt fixes and was three bugs behind.
//  D5  The preset table has sd15/sdxl/flux columns and every other row fell
//      through to sd15: Wan got a 28-step "Quality" and a 1-step "Lightning"
//      that is pure noise, and SD-Turbo got the full ladder up to 28 steps.

import { describe, it, expect, vi, afterAll } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-localgen-'))
})

// The hoisted dir outlives the suite unless somebody removes it — one temp tree
// per run, forever, on every machine that runs the suite.
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
  resolveLocalGenParams, resolveLocalNegative, schemaNegativeDefault, LOCAL_GEN_LEGACY_KEYS,
  toggleTriggerWord, hasTriggerWord, SD_BATCH_MAX,
} from '../../src/pages/media/localGenParams'
import {
  SD_IMAGE_MODELS, SD_VIDEO_MODELS, SD_SAMPLING_METHODS,
  presetsForRow, isDistilledRow, WAN_DEFAULT_NEGATIVE,
} from '../../electron/services/sd-cpp-models'
import {
  presetsForRow as presetsForRowUi,
  isDistilledRow as isDistilledRowUi,
} from '../../src/pages/media/mediaHelpers'
import { modelParamSchema } from '../../electron/services/surplus-media-service'

/**
 * Source WITHOUT comments (civitaiCatalogTab's helper).
 *
 * Every `not.toContain` here names a dead idiom — and this lane's comments
 * QUOTE those idioms to say what was replaced, so a naive read() would let the
 * post-mortem satisfy the assertion the post-mortem is about.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n')
}

const read = (rel: string): string => stripComments(readFileSync(resolve(__dirname, '..', '..', rel), 'utf8'))

/** Non-vacuous slice between two anchors (civitaiCatalogTab's `between`). */
function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1)
  const end = src.indexOf(to, start + from.length)
  expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start)
  const body = src.slice(start, end)
  expect(body.length, `slice ${from} → ${to} is too short to be the real block`).toBeGreaterThan(80)
  return body
}

const specOf = (modality: 'image' | 'video', modelId: string, name: string) =>
  modelParamSchema(modality, modelId).find(s => s.name === name)

// ═══ D1 — ONE NAME AT BOTH ENDS ══════════════════════════════════════════════

describe('D1 — the composer\'s cfg/sampler finally reach sd-cli', () => {
  it('reads the SCHEMA\'s names', () => {
    expect(resolveLocalGenParams({ steps: 12, cfg: 9.5, sampler: 'dpm++2m' }))
      .toEqual({ steps: 12, cfgScale: 9.5, samplingMethod: 'dpm++2m' })
  })

  it('still reads the LEGACY keys, because a persisted bag holds them', () => {
    // Params persist per MODALITY in localStorage and survive an app update;
    // silently dropping `cfgScale` would trade one silent lie for another.
    expect(LOCAL_GEN_LEGACY_KEYS).toEqual({ cfg: 'cfgScale', sampler: 'samplingMethod' })
    expect(resolveLocalGenParams({ cfgScale: 4, samplingMethod: 'heun' }))
      .toEqual({ cfgScale: 4, samplingMethod: 'heun' })
  })

  it('the SCHEMA name wins when a bag holds both', () => {
    expect(resolveLocalGenParams({ cfg: 8, cfgScale: 3, sampler: 'euler_a', samplingMethod: 'lcm' }))
      .toEqual({ cfgScale: 8, samplingMethod: 'euler_a' })
  })

  it('an absent / unusable value adds NO key, so the model row\'s own number runs', () => {
    expect(resolveLocalGenParams({})).toEqual({})
    expect(resolveLocalGenParams({ cfg: NaN, sampler: '   ', steps: 'nope' })).toEqual({})
    // …and never coerces a string into a number the engine would reject.
    expect(resolveLocalGenParams({ cfg: '7' })).toEqual({})
  })

  it('the negative prompt has the same split, and the canvas key is the legacy one', () => {
    expect(resolveLocalNegative({ negative_prompt: 'blurry' })).toBe('blurry')
    expect(resolveLocalNegative({ negative: 'blurry' })).toBe('blurry')
    expect(resolveLocalNegative({ negative_prompt: 'a', negative: 'b' })).toBe('a')
    expect(resolveLocalNegative({})).toBe('')
  })

  it('BOTH generation call sites go through the resolver', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    const img = between(page, 'window.tachi.sdCpp.generate({', "'Local generation failed'")
    expect(img).toContain('...resolveLocalGenParams(runParams)')
    expect(img).not.toContain('runParams.cfgScale')
    expect(img).not.toContain('runParams.samplingMethod')

    const vid = between(page, 'window.tachi.sdCpp.generateVideo({', "'Local video generation failed'")
    expect(vid).toContain('...resolveLocalGenParams(runParams)')
    expect(vid).not.toContain('runParams.cfgScale')
    // …and the negative prompt, which this call never sent AT ALL (D6b): the
    // schema renders the textarea and SdVideoInput has always had `-n`.
    expect(vid).toContain('...(localNeg ? { negative: localNeg } : {})')
  })
})

// ═══ D2 + D17 — THE SLIDERS SHOW WHAT WILL RUN ═══════════════════════════════

describe('D2 — steps / cfg / sampler are narrowed PER ROW', () => {
  it('every local image row defaults its sliders to its OWN recipe', () => {
    for (const m of SD_IMAGE_MODELS) {
      expect(specOf('image', m.id, 'steps')?.default, `${m.id} steps`).toBe(m.steps)
      expect(specOf('image', m.id, 'sampler')?.default, `${m.id} sampler`).toBe(m.samplingMethod)
    }
  })

  it('SD-TURBO STOPS OFFERING 50 STEPS — the live 50x waste', () => {
    const steps = specOf('image', 'sd-turbo', 'steps')!
    expect(steps.default).toBe(1)
    expect(steps.max).toBeLessThanOrEqual(4)
    // …while a non-distilled row keeps a generous band around its own recipe.
    const sd15 = specOf('image', 'sd15', 'steps')!
    expect(sd15.default).toBe(20)
    expect(sd15.max).toBeGreaterThanOrEqual(40)
  })

  it('a CLOUD model id is untouched — the curated superset survives', () => {
    const steps = specOf('image', 'flux-1.1-pro', 'steps')!
    expect(steps.min).toBe(1)
    expect(steps.max).toBe(50)
    expect(steps.default).toBeUndefined()
    expect(specOf('image', 'flux-1.1-pro', 'cfg')).toBeDefined()
    expect(specOf('image', 'flux-1.1-pro', 'n')).toBeDefined()
    expect(specOf('image', 'flux-1.1-pro', 'aspect_ratio')).toBeDefined()
  })

  it('a GUIDANCE-1 row DROPS the cfg control and says the negative prompt is inert', () => {
    // sd.cpp's resolve_guidance enables the unconditional pass only when
    // cfg ≠ 1, so at guidance 1 a negative prompt cannot affect the image —
    // and a slider that moves a number nothing reads is the D1 bug again.
    for (const id of ['sd-turbo', 'flux-schnell-q4']) {
      expect(specOf('image', id, 'cfg'), id).toBeUndefined()
      expect(specOf('image', id, 'negative_prompt')?.description, id).toMatch(/guidance 1/i)
    }
    // A row that DOES use guidance keeps the control and defaults to its own.
    expect(specOf('image', 'sd15', 'cfg')?.default).toBe(7)
    expect(specOf('image', 'sdxl-base-1.0', 'cfg')?.default).toBe(5)
    expect(specOf('image', 'sd15', 'negative_prompt')?.description).not.toMatch(/guidance 1/i)
  })

  it('D17 — the sampler enum is sd-cli\'s OWN vocabulary, not A1111\'s', () => {
    const sampler = specOf('image', 'sd15', 'sampler')!
    expect(sampler.enum).toEqual([...SD_SAMPLING_METHODS])
    // The names the dropdown used to offer, which the engine rejects.
    //
    // `lms` LEFT THIS LIST ON 2026-08-03 and that is not a loosening. It was
    // here as an A1111 spelling sd-cli had no sampler for; master-810 added a
    // real `lms` to `--sampling-method`, so the same five characters went from
    // "a name the engine rejects" to "a name the engine implements". A guard
    // word that becomes a real value has to be released, or the guard starts
    // banning the thing it was protecting. The other four are still A1111-only.
    for (const dead of ['dpmpp_2m', 'dpmpp_2m_karras', 'dpmpp_sde', 'ddim']) {
      expect(sampler.enum, dead).not.toContain(dead)
    }
    // …and the whole list is the ENGINE's, not a subset somebody transcribed:
    // this array held 11 of the 19 sd-cli printed at the previous pin, so eight
    // working samplers were unreachable from the UI. Pinned by count so a future
    // hand-edit that drops one fails here rather than in a user's dropdown.
    expect(sampler.enum!.length, 'sd-cli master-810 offers 20 samplers').toBe(20)
    for (const added of ['dpm++2s_a', 'dpm++2m_sde', 'dpm++2m_sde_bt', 'res_multistep',
                         'res_2s', 'er_sde', 'euler_cfg_pp', 'euler_a_cfg_pp', 'lms']) {
      expect(sampler.enum, added).toContain(added)
    }
    // …and every curated row's own sampler IS selectable (or the dropdown
    // silently shows something else as the current value).
    for (const m of [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS]) {
      expect(SD_SAMPLING_METHODS, m.id).toContain(m.samplingMethod)
    }
  })

  it('the local IMAGE route stops offering what it ignores (D9, D10)', () => {
    // resolveLocalSdSize reads `size`, never the ratio — and the local `size`
    // enum names the orientation IN PIXELS now ('1216x832'), so a ratio control
    // would be a second, approximate name for the same choice.
    expect(specOf('image', 'sd15', 'aspect_ratio')).toBeUndefined()
    // `n` was the other half of D10 and it is LIVE now (buildSdArgs emits `-b`),
    // so what has to hold is no longer "absent" but "honest about the engine".
    const n = specOf('image', 'sd15', 'n')!
    expect(n.max).toBe(SD_BATCH_MAX)
    expect(n.default).toBe(1)                       // one image is still the default
    expect(n.description).toMatch(/own seed/i)      // the seeds count up — say so
    expect(n.description).toMatch(/4x as long/)     // …and it costs N samplings
    // …and the size control now names the row's native grid (D15).
    expect(specOf('image', 'sdxl-base-1.0', 'size')?.description).toMatch(/1024x1024/)
    expect(specOf('image', 'sd15', 'size')?.description).toMatch(/512x512/)
  })

  it('the VIDEO row is narrowed on the same three params', () => {
    expect(specOf('video', 'wan21-t2v-1.3b', 'steps')?.default).toBe(20)
    expect(specOf('video', 'wan21-t2v-1.3b', 'cfg')?.default).toBe(6)
    expect(specOf('video', 'wan21-t2v-1.3b', 'sampler')?.default).toBe('euler')
  })
})

// ═══ D5 — PRESETS THAT DESCRIBE THE ROW THEY ARE OFFERED ON ══════════════════

describe('D5 — a row is only offered tiers it can honestly run', () => {
  const row = (id: string) => {
    const m = [...SD_IMAGE_MODELS, ...SD_VIDEO_MODELS].find(x => x.id === id)!
    return { family: m.family as string, steps: m.steps, cfgScale: m.cfgScale, samplingMethod: m.samplingMethod }
  }

  it('SD-TURBO and FLUX-SCHNELL are offered NONE (the picker hides)', () => {
    expect(isDistilledRow(row('sd-turbo'))).toBe(true)
    expect(presetsForRow(row('sd-turbo'))).toEqual([])
    expect(isDistilledRow(row('flux-schnell-q4'))).toBe(true)
    expect(presetsForRow(row('flux-schnell-q4'))).toEqual([])
  })

  it('WAN gets tiers DERIVED FROM ITS OWN ROW — and never a 1-step one', () => {
    const offers = presetsForRow(row('wan21-t2v-1.3b'))
    expect(offers.map(o => o.id)).toEqual(['speed', 'quality'])
    expect(offers.find(o => o.id === 'quality')!.params).toEqual({ steps: 20, cfgScale: 6, samplingMethod: 'euler' })
    expect(offers.find(o => o.id === 'speed')!.params).toEqual({ steps: 10, cfgScale: 6, samplingMethod: 'euler' })
    // The old fall-through handed it the sd15 column: 28 steps at cfg 7 for
    // "Quality", and 1 step at cfg 1 for "Lightning" — which is noise, not speed.
    expect(offers.some(o => o.id === 'lightning')).toBe(false)
    expect(offers.every(o => o.params.cfgScale === 6)).toBe(true)
  })

  it('sd15 / sdxl keep their full curated ladder', () => {
    expect(presetsForRow(row('sd15')).map(o => o.id)).toEqual(['lightning', 'speed', 'quality'])
    expect(presetsForRow(row('sdxl-base-1.0')).find(o => o.id === 'quality')!.params)
      .toEqual({ steps: 28, cfgScale: 5, samplingMethod: 'dpm++2m' })
  })

  it('the RENDERER MIRROR agrees with main, row for row', () => {
    // mediaHelpers is a hand-kept copy (the renderer cannot import a main
    // service). Two copies of a rule is two chances to fix only one.
    for (const id of ['sd-turbo', 'sd15', 'sdxl-base-1.0', 'flux-schnell-q4', 'wan21-t2v-1.3b']) {
      expect(presetsForRowUi(row(id)), id).toEqual(presetsForRow(row(id)))
      expect(isDistilledRowUi(row(id)), id).toBe(isDistilledRow(row(id)))
    }
    // …including a user-installed row shape neither copy has a column for.
    const civitai = { family: 'sdxl', steps: 28, cfgScale: 5, samplingMethod: 'dpm++2m' }
    expect(presetsForRowUi(civitai)).toEqual(presetsForRow(civitai))
  })

  it('the picker WRITES the schema names and is hidden when there is no tier', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    const apply = between(page, 'const applyPerfPreset = useCallback', 'const loadModels = useCallback')
    expect(apply).toContain('sampler: tier.samplingMethod')
    expect(apply).toContain('cfg:     tier.cfgScale')
    expect(page).toContain('{offeredPresets.length > 0 && (')
  })
})

// ═══ D3 — THE CANVAS IS THE SAME SURFACE ═════════════════════════════════════

describe('D3 — the canvas media node runs the SAME resolvers', () => {
  const local = () => {
    const src = read('electron/services/graph-to-agentkit.ts')
    return between(src, "if (media.data.provider === 'local') {", "if (media.data.provider === 'venice') {")
  }

  it('imports the shared pure module rather than re-implementing it', () => {
    const src = read('electron/services/graph-to-agentkit.ts')
    expect(src).toContain("} from '../../src/pages/media/localGenParams'")
    expect(src).toContain('resolveLocalSdSize, resolveLocalWanSize, resolveLocalWanFrames,')
  })

  it('image: `size` reaches -W/-H (it used to read a numeric width nothing writes)', () => {
    const b = local()
    expect(b).toContain('...resolveLocalSdSize(params)')
    expect(b).not.toContain("typeof params.width === 'number'")
    expect(b).not.toContain("typeof params.height === 'number'")
  })

  it('video: resolution/aspect/duration reach the argv, bounded by the LIVE schema', () => {
    const b = local()
    expect(b).toContain("...resolveLocalWanSize(params, vschema.find(s => s.name === 'resolution')?.enum)")
    expect(b).toContain("...resolveLocalWanFrames(params, vschema.find(s => s.name === 'duration'))")
    expect(b).not.toContain("typeof params.frames === 'number'")
  })

  it('the negative prompt is read under the schema\'s name, and cfg/sampler too', () => {
    const b = local()
    // …with the ROW's own negative as the fallback for a bag that never held
    // the key — the field displayed it, so the field must be what runs (FLF
    // driver finding 1; canvasLocalNegative.test.ts owns the behaviour).
    expect(b).toContain('const existingNeg = resolveLocalNegative(params, schemaNegativeDefault(lschema))')
    expect(b).not.toContain("typeof params.negative === 'string'")
    expect(b).toContain('...resolveLocalGenParams(params)')
    expect(b).not.toContain("typeof params.cfgScale === 'number'")
    expect(b).not.toContain("typeof params.samplingMethod === 'string'")
  })
})

// ═══ …AND THE CANVAS CARD OFFERS ONLY WHAT THE ROUTE CAN DO ══════════════════
//
// Same principle as D9/D10 one file over — a control the route ignores is a lie
// — applied to the node's STOP button (review of the FLF fix lane).
//
// runActivityCancel({ kind: 'sd-generate' }) reaches sdCpp.cancelGeneration and
// NOTHING else. It was offered for every provider==='local' run, which on the
// local TTS route (piper) means: the piper child keeps speaking, media.store's
// stopping flag latches, and — worst of it — an UNRELATED sd render happening in
// another node or the media tab is the process that actually dies. The card's own
// comment calls that "the lie the activity rail refuses to print", so the gate has
// to match the kill: local image/video only.

describe('the canvas media node\'s STOP is gated to the kill it can actually make', () => {
  it('is offered for LOCAL image/video only — never for local piper TTS', () => {
    const node = read('src/pages/nodes/canvas/nodeTypes/MediaNode.tsx')
    expect(node).toMatch(
      /provider === 'local' && \(modality === 'image' \|\| modality === 'video'\)\s*\?\s*\{ onStopRun: stopLocalRun \}/,
    )
    // The any-local spread that put a dead button on a TTS node.
    expect(node).not.toContain("{...(provider === 'local' ? { onStopRun: stopLocalRun } : {})}")
  })

  it('and it still goes through the ONE stop dispatcher, not sdCpp directly', () => {
    const node = read('src/pages/nodes/canvas/nodeTypes/MediaNode.tsx')
    expect(node).toContain("runActivityCancel({ kind: 'sd-generate' })")
    expect(node).not.toContain('sdCpp.cancelGeneration')
  })
})

// ═══ TRIGGER WORDS — the chips ═══════════════════════════════════════════════

describe('trigger words toggle on WHOLE tokens', () => {
  it('adds, removes, and round-trips', () => {
    expect(toggleTriggerWord('a cat', '1girl')).toBe('a cat, 1girl')
    expect(toggleTriggerWord('a cat, 1girl', '1girl')).toBe('a cat')
    expect(toggleTriggerWord('', 'solo')).toBe('solo')
    expect(toggleTriggerWord('a cat', '  ')).toBe('a cat')
  })

  it('"girl" does not match "1girl" — a substring test would kill the chip', () => {
    expect(hasTriggerWord('1girl, solo', 'girl')).toBe(false)
    expect(hasTriggerWord('1girl, solo', '1girl')).toBe(true)
    expect(hasTriggerWord('1GIRL, solo', '1girl')).toBe(true)
    expect(toggleTriggerWord('1girl, solo', 'girl')).toBe('1girl, solo, girl')
  })
})

// ═══ ONE NEGATIVE RULE ON EVERY LOCAL ASSEMBLY ═══════════════════════════════
//
// The FLF fix taught the CANVAS assembly the full rule — resolveLocalNegative
// with the row's own default as fallback — but the media tab kept two older
// forms (review follow-up, P3): the video call passed no rowDefault, and the
// image call read `runParams.negative_prompt` RAW, skipping the resolver
// entirely (no legacy key, no absent-vs-cleared distinction). Invisible while
// the schema effect seeds the bag; visibly wrong when the schema fetch fails or
// GENERATE lands before it resolves — the media tab then sent no -n while the
// same Wan model on a canvas node sent the official negative. One rule now,
// three assemblies, and the helper lives in localGenParams where a renderer can
// import it.

describe('one negative rule on every local assembly (review follow-up)', () => {
  it('schemaNegativeDefault reads the row default off the LIVE schema', () => {
    expect(schemaNegativeDefault(modelParamSchema('video', 'wan21-t2v-1.3b'))).toBe(WAN_DEFAULT_NEGATIVE)
  })

  it('…and answers "" for an empty schema and for a row that declares none', () => {
    expect(schemaNegativeDefault([])).toBe('')
    expect(schemaNegativeDefault(modelParamSchema('image', 'sd-turbo'))).toBe('')
  })

  it('MediaPage image AND video both call the resolver with the visible schema default', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    const calls = page.match(/resolveLocalNegative\(runParams, schemaNegativeDefault\(shownSchema\)\)/g) ?? []
    expect(calls).toHaveLength(2)
    // The raw read the image branch used INSTEAD of the resolver is gone…
    expect(page).not.toContain("typeof runParams.negative_prompt === 'string' ? runParams.negative_prompt : ''")
    // …and no one-argument resolver call is left on a local assembly.
    expect(page).not.toContain('resolveLocalNegative(runParams)')
  })

  it('graph-to-agentkit calls the SAME exported rule — its private copy is gone', () => {
    const gta = read('electron/services/graph-to-agentkit.ts')
    expect(gta).toContain('const existingNeg = resolveLocalNegative(params, schemaNegativeDefault(lschema))')
    expect(gta).not.toContain('function schemaNegativeDefault')
  })
})
