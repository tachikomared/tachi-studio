// apps/desktop/test/unit/mediaModelSwitchRecipe.test.ts
//
// SWITCHING CHECKPOINT MUST MOVE THE NUMBERS THE HINT SAYS IT MOVED.
//
// Driver finding (owner, live, the "mush" incident): SD-Turbo was selected
// (its recipe: 1 step, guidance inert), then a user-installed SD 1.5 checkpoint
// (civitai-142421, recipe {steps:20, cfgScale:7, samplingMethod:'euler_a'}) was
// picked from the same dropdown. The STEPS control re-derived correctly — its
// max became 40 and its description read "This checkpoint's own recipe is 20" —
// but the VALUE stayed 1 and the sampler stayed 'euler'. The run went out at
// steps:1 / euler on a 20-step checkpoint and produced mush, and the tEXt
// provenance of the resulting PNG says so:
//     "Steps: 1 ... Sampler: euler discrete"
//     tachi-gen {"modelId":"civitai-142421","steps":1}
//
// WHY NOTHING CAUGHT IT: healParamsForSchema has exactly two jobs — SEED a
// param the bag is MISSING, and HEAL a param the active spec EXCLUDES. steps:1
// is neither: the new spec is min 1 / max 40, so 1 is perfectly in range and
// was left alone. Same for 'euler', which is a member of the sampler enum on
// every row. And STEPS lives in a collapsed "Advanced" disclosure that
// re-collapses on model change, so the stale value was not even on screen.
//
// The recipe-owned params are OWNED BY THE ROW, not by the bag: their spec
// `default` IS the row's own recipe (surplus-media-service localGenOptionsFor
// returns `{ steps: {default: row.steps}, cfg: {default: row.cfgScale},
// sampler: {default: row.samplingMethod} }`). So on a model SWITCH they are
// re-seeded from the new spec, which is exactly what the hint text claims is
// happening.
//
// Pinned here: the exact sd-turbo → sd15 repro, the reverse direction (where a
// stale cfg would otherwise be forwarded to a distilled checkpoint whose spec
// drops the control entirely), the fact that a CLOUD spec — which declares no
// defaults for these — is untouched, and the MediaPage wiring that gates the
// re-seed on a real model change (so a remount, and an explicit Remix/restore,
// keep the values they were given).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ParamSpec } from '../../src/types/electron'
import {
  RECIPE_OWNED_PARAMS,
  LOCAL_ROW_OWNED_PARAMS,
  reseedRecipeParams,
  healParamsForSchema,
  resolveLocalGenParams,
  resolveLocalSdSize,
} from '../../src/pages/media/localGenParams'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

// ── The two schemas the driver actually had, built the way main builds them ──
//
// MIRROR of surplus-media-service.localGenOptionsFor: steps.max is
// stepsCeilingFor(row) (4x for a distilled row, 2x floored at 30 otherwise),
// every default is the row's own number, and `cfg` is DROPPED for a row whose
// guidance is inert (cfgScale <= 1) because sd.cpp's resolve_guidance only
// enables the unconditional pass when cfg != 1.
const SAMPLERS = [
  'euler', 'euler_a', 'heun', 'dpm2', 'dpm++2m', 'dpm++2mv2',
  'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing', 'tcd',
]

/** sd-turbo: {family:'sd15', steps:1, cfgScale:1, samplingMethod:'euler'} */
const TURBO_SCHEMA: ParamSpec[] = [
  { name: 'prompt', label: 'Prompt', kind: 'text', required: true },
  { name: 'steps', label: 'Steps', kind: 'int', min: 1, max: 4, default: 1, advanced: true,
    description: "Denoising steps. This checkpoint's own recipe is 1; past 4 it is out of what it was trained for." },
  // no `cfg` at all — guidance is inert on a distilled row
  { name: 'sampler', label: 'Sampler', kind: 'enum', enum: [...SAMPLERS], default: 'euler', advanced: true },
]

/** civitai-142421: {family:'sd15', steps:20, cfgScale:7, samplingMethod:'euler_a'} */
const SD15_SCHEMA: ParamSpec[] = [
  { name: 'prompt', label: 'Prompt', kind: 'text', required: true },
  { name: 'steps', label: 'Steps', kind: 'int', min: 1, max: 40, default: 20, advanced: true,
    description: "Denoising steps. This checkpoint's own recipe is 20; past 40 it is out of what it was trained for." },
  { name: 'cfg', label: 'Guidance (CFG)', kind: 'number', min: 1, max: 20, default: 7, advanced: true },
  { name: 'sampler', label: 'Sampler', kind: 'enum', enum: [...SAMPLERS], default: 'euler_a', advanced: true },
]

/** The curated CLOUD superset: same three names, and NO defaults on any of them. */
const CLOUD_SCHEMA: ParamSpec[] = [
  { name: 'prompt', label: 'Prompt', kind: 'text', required: true },
  { name: 'steps', label: 'Steps', kind: 'int', min: 1, max: 50, step: 1, advanced: true },
  { name: 'cfg', label: 'Guidance (CFG)', kind: 'number', min: 1, max: 20, step: 0.5, advanced: true },
  { name: 'sampler', label: 'Sampler', kind: 'enum', enum: ['euler', 'euler_a', 'ddim'], advanced: true },
]

// ── The SIZE half of the same bug (driver, second pass) ──────────────────────
//
// civitai-142421 (sd15, native 512) selected, then z-image-turbo (native 1024)
// picked from the same dropdown. The size spec re-derived — the enum grew to
// 1536 and the hint under it read "this checkpoint renders natively at
// 1024x1024" — but the VALUE stayed 512x512, because 512x512 is a legal
// z-image tier and healParamsForSchema only touches what a spec EXCLUDES. The
// render came out at a QUARTER of the native area: soft, and 6.4 s of GPU for
// an image the checkpoint was not trained to make.
//
// `size` is row-owned for exactly the reason steps/cfg/sampler are: the spec's
// default IS the row's native grid (surplus-media-service's localImageOptionsFor
// / imageSizeOptionsFor decide it per row). The difference — and the reason it
// is a SECOND list rather than a fourth entry in the first — is that a CLOUD
// image schema DOES declare a `size` default, so re-seeding it unconditionally
// would reset a deliberate 1536x1536 on every cloud model switch. Only the
// LOCAL route passes LOCAL_ROW_OWNED_PARAMS.
//
// THE TIERS ARE ORIENTATION-AWARE NOW (the local `size` enum carries each
// family's trained landscape/portrait pair beside its square), so these fixtures
// carry them too — a fixture that stayed square-only would keep this suite green
// through exactly the regression it exists to catch: a portrait size surviving a
// switch to a checkpoint that does not offer it.
const SIZE_SD15: ParamSpec = {
  name: 'size', label: 'Size', kind: 'enum',
  enum: ['512x512', '768x512', '512x768', '768x768'], default: '512x512',
  description: 'Local engine: this checkpoint renders natively at 512x512. Other tiers work but drift from what it was trained on.',
}
const SIZE_ZIMAGE: ParamSpec = {
  name: 'size', label: 'Size', kind: 'enum',
  enum: ['512x512', '768x768', '896x640', '640x896', '1024x1024', '1216x832', '832x1216',
         '1536x1536', '1792x1280', '1280x1792'],
  default: '1024x1024',
  description: 'Local engine: this checkpoint renders natively at 1024x1024. Other tiers work but drift from what it was trained on.',
}

/** civitai-142421 as the IMAGE composer really sees it: recipe + size tiers. */
const SD15_IMAGE_SCHEMA: ParamSpec[] = [...SD15_SCHEMA, SIZE_SD15]

/** z-image-turbo: {family:'zimage', baseSize:1024, steps:8, cfgScale:1.0,
 *  samplingMethod:'euler'} — guidance is inert, so `cfg` is dropped. */
const ZIMAGE_SCHEMA: ParamSpec[] = [
  { name: 'prompt', label: 'Prompt', kind: 'text', required: true },
  { name: 'steps', label: 'Steps', kind: 'int', min: 1, max: 30, default: 8, advanced: true,
    description: "Denoising steps. This checkpoint's own recipe is 8; past 30 it is out of what it was trained for." },
  { name: 'sampler', label: 'Sampler', kind: 'enum', enum: [...SAMPLERS], default: 'euler', advanced: true },
  SIZE_ZIMAGE,
]

/** The CLOUD image schema: `size` here DOES carry a default, unlike the three
 *  recipe params — which is the whole reason the local list is separate. */
const CLOUD_IMAGE_SCHEMA: ParamSpec[] = [
  ...CLOUD_SCHEMA,
  { name: 'size', label: 'Size', kind: 'enum',
    enum: ['512x512', '768x768', '1024x1024', '1536x1536', '2048x2048'], default: '1024x1024' },
]

describe('recipe-owned params: the contract', () => {
  it('names exactly the three params whose value is the ROW\'s, not the bag\'s', () => {
    expect([...RECIPE_OWNED_PARAMS].sort()).toEqual(['cfg', 'sampler', 'steps'])
  })

  it('the LOCAL list is the recipe PLUS size and negative_prompt — both row-owned', () => {
    // `size` — the row's native grid. `negative_prompt` — Wan ships an official
    // negative its checkpoint was tuned against (WAN_DEFAULT_NEGATIVE), and the
    // bag persists per modality, so a returning user arrives with '' already in
    // it and SEED alone would never pre-fill the field. Neither may move up
    // into RECIPE_OWNED_PARAMS: cloud schemas declare a `size` default (a
    // switch would discard a deliberate 1536x1536) and declare no negative at
    // all (a switch would leave a deliberate one to be overwritten by nothing).
    // See wanDefaultNegative.test.ts.
    expect([...LOCAL_ROW_OWNED_PARAMS].sort()).toEqual(['cfg', 'negative_prompt', 'sampler', 'size', 'steps'])
    // Superset, never a replacement: whatever the recipe list gains, the local
    // list gains with it.
    for (const name of RECIPE_OWNED_PARAMS) expect(LOCAL_ROW_OWNED_PARAMS).toContain(name)
  })

  it('flow_shift / scheduler are NOT among them — they never enter the params bag', () => {
    // They live on the model row and are applied in MAIN (sd-cpp-client) from
    // the row directly; no composer control declares them, so there is nothing
    // to re-seed. If a spec for either ever appears, this test says: add it.
    const svc = read('electron/services/surplus-media-service.ts')
    expect(svc).not.toMatch(/name:\s*'(flow_shift|scheduler)'/)
    expect(RECIPE_OWNED_PARAMS).not.toContain('flow_shift')
    expect(RECIPE_OWNED_PARAMS).not.toContain('scheduler')
  })
})

describe('sd-turbo → sd15: the mush repro', () => {
  // What the bag holds after an SD-Turbo run: 1 step, euler, and no cfg (the
  // turbo schema does not offer the control).
  const afterTurbo = { prompt: 'a cat', steps: 1, sampler: 'euler', size: '512x512' }

  it('healParamsForSchema alone leaves steps:1 / euler standing (the bug)', () => {
    const { next } = healParamsForSchema(afterTurbo, SD15_SCHEMA)
    // 1 is inside 1..40 and 'euler' is in the enum, so neither is "excluded".
    expect(next.steps).toBe(1)
    expect(next.sampler).toBe('euler')
    // Only cfg moves, because it is MISSING and therefore seeded.
    expect(next.cfg).toBe(7)
  })

  it('re-seeds steps / cfg / sampler from the NEW checkpoint\'s own recipe', () => {
    const { next, changed, reseeded } = reseedRecipeParams(afterTurbo, SD15_SCHEMA)
    expect(changed).toBe(true)
    expect(reseeded.sort()).toEqual(['sampler', 'steps'])   // cfg was absent → seeded, not re-seeded
    expect(next.steps).toBe(20)
    expect(next.sampler).toBe('euler_a')
  })

  it('the value that reaches sd.cpp is the new row\'s, end to end', () => {
    const reseeded = reseedRecipeParams(afterTurbo, SD15_SCHEMA).next
    const { next } = healParamsForSchema(reseeded, SD15_SCHEMA)
    expect(resolveLocalGenParams(next)).toEqual({
      steps: 20, cfgScale: 7, samplingMethod: 'euler_a',
    })
  })

  it('leaves params the recipe does not own alone', () => {
    const { next } = reseedRecipeParams(afterTurbo, SD15_SCHEMA)
    expect(next.prompt).toBe('a cat')
    expect(next.size).toBe('512x512')
  })

  it('does not mutate the input bag', () => {
    const bag = { ...afterTurbo }
    reseedRecipeParams(bag, SD15_SCHEMA)
    expect(bag).toEqual(afterTurbo)
  })
})

describe('sd15 → sd-turbo: the same lie, other direction', () => {
  const afterSd15 = { prompt: 'a cat', steps: 20, cfg: 7, sampler: 'euler_a' }

  it('re-seeds to the distilled row\'s single working setting', () => {
    const { next } = reseedRecipeParams(afterSd15, TURBO_SCHEMA)
    expect(next.steps).toBe(1)
    expect(next.sampler).toBe('euler')
  })

  it('DROPS a cfg the new schema does not offer, instead of forwarding it', () => {
    // The turbo spec omits `cfg` entirely. Left in the bag, resolveLocalGenParams
    // would happily hand cfgScale:7 to a checkpoint distilled without guidance.
    const { next, reseeded } = reseedRecipeParams(afterSd15, TURBO_SCHEMA)
    expect('cfg' in next).toBe(false)
    expect(reseeded).toContain('cfg')
    expect(resolveLocalGenParams(next)).toEqual({ steps: 1, samplingMethod: 'euler' })
  })

  it('drops the LEGACY alias too, so it cannot win the fallback', () => {
    // resolveLocalGenParams reads `cfg` first and `cfgScale` second; a bag
    // persisted by an older build holds the legacy key, so dropping only the
    // schema name would trade one silent lie for the other.
    const legacy = { steps: 20, cfgScale: 7, samplingMethod: 'euler_a' }
    const { next } = reseedRecipeParams(legacy, TURBO_SCHEMA)
    expect('cfgScale' in next).toBe(false)
    expect(resolveLocalGenParams(next)).toEqual({ steps: 1, samplingMethod: 'euler' })
  })
})

describe('civitai-142421 → z-image-turbo: the SIZE repro', () => {
  // What the bag holds after an sd15 run at that row's own native grid.
  const afterSd15 = { prompt: 'a cat', steps: 20, cfg: 7, sampler: 'euler_a', size: '512x512' }

  it('healParamsForSchema alone leaves size 512x512 standing (the bug)', () => {
    const { next } = healParamsForSchema(afterSd15, ZIMAGE_SCHEMA)
    // 512x512 IS a z-image tier, so the spec does not exclude it and nothing moves.
    expect(next.size).toBe('512x512')
  })

  it('the recipe-only list does not move it either — that is why `size` was added', () => {
    const { next } = reseedRecipeParams(afterSd15, ZIMAGE_SCHEMA, RECIPE_OWNED_PARAMS)
    expect(next.size).toBe('512x512')
  })

  it('re-seeds size to the NEW checkpoint\'s native grid', () => {
    const { next, changed, reseeded } = reseedRecipeParams(afterSd15, ZIMAGE_SCHEMA, LOCAL_ROW_OWNED_PARAMS)
    expect(changed).toBe(true)
    expect(reseeded).toContain('size')
    expect(next.size).toBe('1024x1024')
    // …and the hint the composer prints next to it is now the truth.
    expect(SIZE_ZIMAGE.description).toContain('natively at 1024x1024')
  })

  it('the dimensions that reach sd.cpp are the new row\'s, end to end', () => {
    const reseeded = reseedRecipeParams(afterSd15, ZIMAGE_SCHEMA, LOCAL_ROW_OWNED_PARAMS).next
    const { next } = healParamsForSchema(reseeded, ZIMAGE_SCHEMA)
    expect(resolveLocalSdSize(next)).toEqual({ width: 1024, height: 1024 })
    // The quarter-area render the driver got, for contrast.
    expect(resolveLocalSdSize(afterSd15)).toEqual({ width: 512, height: 512 })
  })

  it('re-seeds the recipe in the SAME pass (one switch, one reconciliation)', () => {
    const { next } = reseedRecipeParams(afterSd15, ZIMAGE_SCHEMA, LOCAL_ROW_OWNED_PARAMS)
    expect(next.steps).toBe(8)
    expect(next.sampler).toBe('euler')
    // z-image runs at guidance 1, so its schema drops `cfg` — the stale 7 goes
    // with it rather than being forwarded to a row distilled without guidance.
    expect('cfg' in next).toBe(false)
  })

  it('walks back down too: z-image → civitai-142421 re-seeds 1024 → 512', () => {
    const afterZimage = { prompt: 'a cat', steps: 8, sampler: 'euler', size: '1024x1024' }
    const { next } = reseedRecipeParams(afterZimage, SD15_IMAGE_SCHEMA, LOCAL_ROW_OWNED_PARAMS)
    expect(next.size).toBe('512x512')
    expect(resolveLocalSdSize(next)).toEqual({ width: 512, height: 512 })
  })

  it('leaves the prompt alone', () => {
    const { next } = reseedRecipeParams(afterSd15, ZIMAGE_SCHEMA, LOCAL_ROW_OWNED_PARAMS)
    expect(next.prompt).toBe('a cat')
  })

  // ── …and the same switch with an ORIENTED size in the bag ──────────────────
  //
  // The tiers carry landscape/portrait pairs now, which opens a second version of
  // the same hole: a portrait picked on one checkpoint is a size the NEXT one may
  // not offer at all, and `size` is row-owned precisely so that a switch does not
  // leave a shape standing that the new row was never trained on.

  it('a PORTRAIT from the old row is re-seeded to the new row\'s native square', () => {
    const afterZimagePortrait = { prompt: 'a cat', steps: 8, sampler: 'euler', size: '832x1216' }
    const { next, reseeded } = reseedRecipeParams(afterZimagePortrait, SD15_IMAGE_SCHEMA, LOCAL_ROW_OWNED_PARAMS)
    expect(reseeded).toContain('size')
    expect(next.size).toBe('512x512')
    // …and the dimensions that reach sd.cpp move with it. Left alone, 832x1216
    // is 2.4x the pixels SD 1.5 renders and would have produced the mush the
    // whole re-seed exists to prevent.
    expect(resolveLocalSdSize(next)).toEqual({ width: 512, height: 512 })
    expect(resolveLocalSdSize(afterZimagePortrait)).toEqual({ width: 832, height: 1216 })
  })

  it('healParamsForSchema alone could NOT have caught it either', () => {
    // Not because the value is legal this time — 832x1216 is NOT in the sd15
    // enum — but because heal picks the SPEC DEFAULT for an excluded enum value,
    // which lands on the same 512x512 by luck. The load-bearing difference is the
    // case where the shape IS legal on both rows…
    const legalOnBoth = { prompt: 'a cat', size: '768x512' }
    expect(healParamsForSchema(legalOnBoth, SD15_IMAGE_SCHEMA).next.size).toBe('768x512')
    // …where only the row-owned re-seed moves it back to the row's own grid.
    expect(reseedRecipeParams(legalOnBoth, SD15_IMAGE_SCHEMA, LOCAL_ROW_OWNED_PARAMS).next.size)
      .toBe('512x512')
  })

  it('an oriented size the NEW row does offer is still re-seeded — the row owns it', () => {
    // sd15's landscape and zimage's landscape are different pixel pairs, so
    // "keep it if it is legal" would be a shape the user did not pick on a
    // checkpoint they did not pick it for.
    const afterSd15Landscape = { prompt: 'a cat', steps: 20, cfg: 7, sampler: 'euler_a', size: '768x512' }
    const { next } = reseedRecipeParams(afterSd15Landscape, ZIMAGE_SCHEMA, LOCAL_ROW_OWNED_PARAMS)
    expect(next.size).toBe('1024x1024')
  })

  it('does not mutate the input bag', () => {
    const bag = { ...afterSd15 }
    reseedRecipeParams(bag, ZIMAGE_SCHEMA, LOCAL_ROW_OWNED_PARAMS)
    expect(bag).toEqual(afterSd15)
  })
})

describe('what re-seeding must NOT touch', () => {
  it('a CLOUD image schema keeps the size the user picked (why the list is split)', () => {
    // The cloud `size` spec DOES declare a default, so the LOCAL list would
    // reset it — which is exactly why MediaPage passes that list only on the
    // local route (asserted in the wiring block below).
    const bag = { prompt: 'x', steps: 40, cfg: 12, sampler: 'ddim', size: '1536x1536' }
    const { next, changed } = reseedRecipeParams(bag, CLOUD_IMAGE_SCHEMA, RECIPE_OWNED_PARAMS)
    expect(changed).toBe(false)
    expect(next.size).toBe('1536x1536')
  })

  it('is a no-op for a CLOUD schema, which declares no defaults for these', () => {
    const bag = { prompt: 'x', steps: 40, cfg: 12, sampler: 'ddim' }
    const { next, changed, reseeded } = reseedRecipeParams(bag, CLOUD_SCHEMA)
    expect(changed).toBe(false)
    expect(reseeded).toEqual([])
    expect(next).toEqual(bag)
  })

  it('is a no-op when the value already IS the row\'s recipe', () => {
    const bag = { steps: 20, cfg: 7, sampler: 'euler_a' }
    const { changed } = reseedRecipeParams(bag, SD15_SCHEMA)
    expect(changed).toBe(false)
  })

  it('is a no-op for an EMPTY schema (a failed/pending fetch must not clear the bag)', () => {
    const bag = { steps: 20, cfg: 7, sampler: 'euler_a' }
    const { next, changed } = reseedRecipeParams(bag, [])
    expect(changed).toBe(false)
    expect(next).toEqual(bag)
  })
})

// ── The wiring: WHEN the re-seed runs ────────────────────────────────────────
//
// Source-level, the idiom mediaLocalGenParams / mediaLocalModelTruth use for
// call-site facts a pure unit cannot see. The rule is narrow on purpose:
//   • only on a real MODEL CHANGE (a remount re-reads the SAME model and must
//     keep whatever the user set — the run-state lane already proved a remount
//     must not invent state);
//   • never over an explicit Remix / restore-from-PNG, which is provenance.
describe('MediaPage wiring', () => {
  const page = read('src/pages/media/MediaPage.tsx')

  it('re-seeds inside the schema effect, gated on the model having CHANGED', () => {
    expect(page).toMatch(/reseedRecipeParams/)
    expect(page).toMatch(/seededForModelRef/)
  })

  it('exempts an explicit Remix / restore, exactly as healing is exempted', () => {
    // `explicit` already guards healExcluded; the re-seed must ride the same flag.
    expect(page).toMatch(/modelChanged && !explicit/)
  })

  it('imports the helper from the pure module (canvas parity, audit D3)', () => {
    expect(page).toMatch(/reseedRecipeParams,?\n?[\s\S]{0,400}?from '\.\/localGenParams'/)
  })

  it('passes the LOCAL list only on the local route, so cloud size is untouched', () => {
    // The provider is read from the STORE at apply time rather than added to the
    // effect's deps: it already lives there (mediaProviderPersistence), and a new
    // dep would re-fetch the schema on every chip toggle.
    expect(page).toMatch(/LOCAL_ROW_OWNED_PARAMS/)
    expect(page).toMatch(/provider === 'local'[\s\S]{0,120}?LOCAL_ROW_OWNED_PARAMS[\s\S]{0,120}?RECIPE_OWNED_PARAMS/)
    expect(page).toMatch(/reseedRecipeParams\(existing, res\.params, \w+\)/)
  })
})
