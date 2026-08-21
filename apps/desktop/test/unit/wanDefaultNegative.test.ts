// apps/desktop/test/unit/wanDefaultNegative.test.ts
//
// WAN SHIPS A NEGATIVE PROMPT, AND WE WERE SENDING NONE.
//
// Research finding (LOWVRAM-META-RESEARCH-2026-07-28, DELTA ADDENDUM §B, post
// 2470813): Wan's official negative conditioning is a fixed, mostly
// Chinese-language string. It is not a community "quality tag" habit — it is
// the string Wan's OWN inference code passes on every sample, the model was
// tuned against it, and dropping it measurably degrades output.
//
// VERIFIED, verbatim, against upstream's own source (both generations agree,
// byte for byte):
//   github.com/Wan-Video/Wan2.1  wan/configs/shared_config.py  `sample_neg_prompt`
//   github.com/Wan-Video/Wan2.2  wan/configs/shared_config.py  `sample_neg_prompt`
//
// It is LIVE on our rows and not decoration: both curated Wan rows run at
// cfg 6, and sd.cpp only encodes the unconditional pass when guidance ≠ 1 — the
// same fact that makes the negative INERT on z-image-turbo (cfg 1) makes it
// fully effective here. See localGenOptionsFor's `negativeIsInert`.
//
// THE MECHANISM IS THE ONE THAT ALREADY EXISTS. steps / cfg / sampler / size are
// "row-owned": the row states the recipe, localGenOptionsFor lifts it into the
// ParamSpec's `default`, healParamsForSchema SEEDS it into the bag, and
// reseedRecipeParams re-seeds it on a model switch. `negative_prompt` joins that
// list rather than growing a second mechanism — which is also what makes the
// field EDITABLE: it is a real value in the bag, so typing over it wins for the
// same reason typing over Steps wins.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// surplus-media-service reaches the keychain, which reads electron's app paths
// at import time. Same stub mediaLocalGenParams.test.ts uses.
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'tachi-wanneg-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  WAN_DEFAULT_NEGATIVE,
  SD_VIDEO_MODELS,
  SD_IMAGE_MODELS,
} from '../../electron/services/sd-cpp-models'
import { modelParamSchema } from '../../electron/services/surplus-media-service'
import {
  LOCAL_ROW_OWNED_PARAMS,
  RECIPE_OWNED_PARAMS,
  healParamsForSchema,
  reseedRecipeParams,
  resolveLocalNegative,
} from '../../src/pages/media/localGenParams'

/** Upstream's `sample_neg_prompt`, pasted from wan/configs/shared_config.py. */
const UPSTREAM_SAMPLE_NEG_PROMPT =
  '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走'

const negSpec = (modelId: string) =>
  modelParamSchema('video', modelId).find(s => s.name === 'negative_prompt')

describe('the string is upstream\'s, not ours', () => {
  it('matches Wan2.1/Wan2.2 shared_config.py `sample_neg_prompt` character for character', () => {
    expect(WAN_DEFAULT_NEGATIVE).toBe(UPSTREAM_SAMPLE_NEG_PROMPT)
  })

  it('survived the trip through this repo\'s encoding intact', () => {
    // A mojibake'd copy is still a string and would still be forwarded — it
    // would just condition on garbage. Pin the shape, not only the identity.
    const terms = WAN_DEFAULT_NEGATIVE.split('，')
    expect(terms).toHaveLength(28)
    expect(terms[0]).toBe('色调艳丽')
    expect(terms[terms.length - 1]).toBe('倒着走')
    // No replacement chars, no ASCII commas (upstream uses U+FF0C throughout).
    expect(WAN_DEFAULT_NEGATIVE).not.toMatch(/�/)
    expect(WAN_DEFAULT_NEGATIVE).not.toContain(',')
    // The one Latin token upstream carries, kept as evidence of a clean copy.
    expect(WAN_DEFAULT_NEGATIVE).toContain('JPEG压缩残留')
  })
})

describe('the ROW declares it', () => {
  it('both curated Wan rows carry it', () => {
    const wan = SD_VIDEO_MODELS.filter(m => m.family === 'wan')
    expect(wan.length).toBeGreaterThanOrEqual(2)
    for (const row of wan) {
      expect(row.negativePrompt, `${row.id} has no default negative`).toBe(WAN_DEFAULT_NEGATIVE)
    }
  })

  it('is LIVE on them — both run at guidance > 1, where sd.cpp encodes the uncond pass', () => {
    // At cfg 1 the engine skips the unconditional pass and a negative prompt is
    // silently ignored; declaring one there would be a lie in the field.
    for (const row of SD_VIDEO_MODELS.filter(m => m.negativePrompt)) {
      expect(row.cfgScale, `${row.id} declares a negative but renders at guidance 1`).toBeGreaterThan(1)
    }
  })

  it('no IMAGE row claims one — this is a Wan fact, not a house style', () => {
    // The style presets (SD_STYLES) are the image-side negative mechanism and
    // they are the user's choice, not the checkpoint's recipe.
    for (const row of SD_IMAGE_MODELS) expect(row.negativePrompt).toBeUndefined()
  })
})

describe('the SCHEMA carries it into the field', () => {
  it('the Wan t2v spec pre-fills with the official negative', () => {
    expect(negSpec('wan21-t2v-1.3b')?.default).toBe(WAN_DEFAULT_NEGATIVE)
  })

  it('the Wan i2v spec does too', () => {
    expect(negSpec('wan21-i2v-14b-480p')?.default).toBe(WAN_DEFAULT_NEGATIVE)
  })

  it('the control is still an ordinary editable text field', () => {
    const spec = negSpec('wan21-t2v-1.3b')!
    expect(spec.kind).toBe('text')
    expect(spec.required).toBeFalsy()
  })

  it('says WHERE the string came from, so it does not read as our invention', () => {
    // A wall of Chinese appearing in a field by itself is indistinguishable
    // from a bug unless the description explains it — and it must also say the
    // field is editable, or a user assumes it is a locked engine setting.
    const description = negSpec('wan21-t2v-1.3b')?.description ?? ''
    expect(description).toMatch(/own official negative prompt/i)
    expect(description).toMatch(/edit or clear it/i)
  })

  it('the INERT row (z-image, cfg 1) is pre-filled with nothing and still says why', () => {
    // Same branch, opposite answer: at guidance 1 sd.cpp encodes no
    // unconditional pass, so pre-filling there would be a field that lies.
    const spec = modelParamSchema('image', 'z-image-turbo').find(s => s.name === 'negative_prompt')
    expect(spec?.default).toBe('')
    expect(spec?.description ?? '').toMatch(/no effect/i)
  })

  it('a CLOUD video model declares no default — nothing is pushed onto a route that never asked', () => {
    const spec = modelParamSchema('video', 'some-cloud-video-model')
      .find(s => s.name === 'negative_prompt')
    expect(spec).toBeDefined()
    expect(spec?.default).toBeUndefined()
  })
})

describe('the param assembly forwards it when the field is untouched', () => {
  it('SEEDS an empty bag from the spec, and resolveLocalNegative reads it back', () => {
    const schema = modelParamSchema('video', 'wan21-t2v-1.3b')
    const { next, changed } = healParamsForSchema({}, schema)
    expect(changed).toBe(true)
    expect(next.negative_prompt).toBe(WAN_DEFAULT_NEGATIVE)
    // …and that is the exact value MediaPage hands sd-cli as `-n`.
    expect(resolveLocalNegative(next)).toBe(WAN_DEFAULT_NEGATIVE)
  })

  it('a model SWITCH re-seeds it, which is how an existing user ever sees it', () => {
    // The bag persists per MODALITY, so a returning user arrives with
    // `negative_prompt: ''` already in it — SEED alone would never fire.
    const fromCloud = { negative_prompt: '' }
    const schema = modelParamSchema('video', 'wan21-t2v-1.3b')
    const { next, reseeded } = reseedRecipeParams(fromCloud, schema, LOCAL_ROW_OWNED_PARAMS)
    expect(reseeded).toContain('negative_prompt')
    expect(next.negative_prompt).toBe(WAN_DEFAULT_NEGATIVE)
  })

  it('negative_prompt is LOCAL-route-owned only — the cloud list must not learn it', () => {
    // reseedRecipeParams is called with RECIPE_OWNED_PARAMS on every cloud
    // model switch; adding the negative there would wipe a deliberate one.
    expect(LOCAL_ROW_OWNED_PARAMS).toContain('negative_prompt')
    expect(RECIPE_OWNED_PARAMS).not.toContain('negative_prompt')
  })

  it('leaving a Wan row CLEARS it again — the string never follows the user elsewhere', () => {
    // Switching to a local row with no recipe negative re-seeds to ''. Without
    // this, Wan's Chinese negative would ride onto an SDXL render at cfg 5 and
    // condition it for real.
    const carried = { negative_prompt: WAN_DEFAULT_NEGATIVE }
    const sdxl = modelParamSchema('image', 'sdxl-base-1.0')
    const { next } = reseedRecipeParams(carried, sdxl, LOCAL_ROW_OWNED_PARAMS)
    expect(next.negative_prompt).toBe('')
  })
})

describe('the USER wins', () => {
  it('a typed negative REPLACES the default — it is never appended to', () => {
    const schema = modelParamSchema('video', 'wan21-t2v-1.3b')
    const typed = { negative_prompt: 'blurry, watermark' }
    const { next } = healParamsForSchema(typed, schema)
    expect(next.negative_prompt).toBe('blurry, watermark')
    expect(resolveLocalNegative(next)).toBe('blurry, watermark')
    expect(resolveLocalNegative(next)).not.toContain('色调艳丽')
  })

  it('a REMIX of an entry that recorded an empty negative keeps it empty', () => {
    // Remix is the `explicit` path: reseedRecipeParams is skipped entirely and
    // healParamsForSchema runs SEED-only, so a recorded value is provenance and
    // survives. Every entry generated from here on records the key.
    const schema = modelParamSchema('video', 'wan21-t2v-1.3b')
    const { next } = healParamsForSchema({ negative_prompt: '' }, schema, { healExcluded: false })
    expect(next.negative_prompt).toBe('')
  })

  it('a remix of a PRE-CHANGE entry gains the default — the key was simply absent', () => {
    // Documented, not accidental: an entry written before this row declared a
    // negative has no `negative_prompt` key at all, and SEED cannot tell "the
    // user cleared it" from "this bag predates the field". The row's recipe is
    // the better guess of the two, and it lands in a VISIBLE field the user can
    // clear before re-running.
    const schema = modelParamSchema('video', 'wan21-t2v-1.3b')
    const { next } = healParamsForSchema({ steps: 20 }, schema, { healExcluded: false })
    expect(next.negative_prompt).toBe(WAN_DEFAULT_NEGATIVE)
  })

  it('an emptied field stays empty for the run the user emptied it on', () => {
    // healParamsForSchema only SEEDS what is absent; '' is a value, not a hole.
    // (A model switch re-seeds — that is the row's recipe arriving, not this.)
    const schema = modelParamSchema('video', 'wan21-t2v-1.3b')
    const { next } = healParamsForSchema({ negative_prompt: '' }, schema)
    expect(next.negative_prompt).toBe('')
    expect(resolveLocalNegative(next)).toBe('')
  })

  it('MediaPage sends it only when non-empty, so an emptied field sends no -n at all', () => {
    // Pinned at the call site: the video branch spreads `negative` conditionally.
    // The resolver call carries the visible schema's own default now — the same
    // one rule as the image branch and the canvas assembly (review follow-up);
    // an emptied field still resolves to '' (the key is IN the bag) and the
    // conditional spread still drops the empty string.
    const page = readFileSync(
      resolve(__dirname, '..', '..', 'src/pages/media/MediaPage.tsx'), 'utf8')
    expect(page).toContain('const localNeg = resolveLocalNegative(runParams, schemaNegativeDefault(shownSchema))')
    expect(page).toContain('...(localNeg ? { negative: localNeg } : {}),')
  })
})

describe('main still emits -n for it', () => {
  it('sd-cpp-client passes the video negative through to sd-cli', () => {
    const client = readFileSync(
      resolve(__dirname, '..', '..', 'electron/services/sd-cpp-client.ts'), 'utf8')
    expect((client.match(/args\.push\('-n', input\.negative\)/g) ?? []).length).toBe(2)
  })
})
