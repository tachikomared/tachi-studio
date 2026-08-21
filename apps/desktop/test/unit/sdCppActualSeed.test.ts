// apps/desktop/test/unit/sdCppActualSeed.test.ts
//
// THE tachi-gen CHUNK RECORDED THE REQUEST, NOT THE ANSWER.
//
// Driver finding (Civitai phase-1 verify): every locally-generated PNG carried
// `"seed": -1` in its tachi-gen chunk. -1 is what we ASKED for ("pick one for
// me"); the number sd.cpp actually seeded the sampler with — 16124 in the
// driver's run — was sitting in the SAME FILE, in sd.cpp's own A1111-style
// `parameters` tEXt chunk, and nothing read it. A generation-metadata chunk
// that cannot reproduce its own image is the only thing such a chunk is for.
//
// The same hole swallowed the no-seed case: buildSdArgs omits `--seed`
// entirely when the caller passes none, and sd-cli's own default is a FIXED
// number rather than "random" — so those runs were perfectly reproducible and
// we still wrote -1 over the answer.
//
// THE PIN: a -1 request must never reach the chunk when the engine chose a
// concrete seed. Everything below is the pure half (the parse + the resolve)
// plus a wiring sweep over the two call sites and the renderer's entry params,
// which is as far as a node-env suite can reach without a GPU.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdseed-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { parseSdSeed, parseSdcppMetadata, resolveActualSeed } from '../../electron/services/sd-cpp-client'
import { stampLocalSeed } from '../../src/pages/media/MediaPage'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

/** sd.cpp's `parameters` chunk, in the shape it actually writes it. */
const PARAMETERS =
  'a photo of a cat Negative prompt: blurry' +
  'Steps: 28, CFG scale: 5.00, Guidance: 3.50, Seed: 16124, Size: 1024x1024, ' +
  'Model: model, RNG: cuda, Sampler: dpm++2m, Version: stable-diffusion.cpp'

// ── THE `, SDCPP: {json}` TAIL ───────────────────────────────────────────────
//
// Upstream appends a machine-readable copy of the whole recipe to the END of the
// SAME `parameters` string (examples/common/common.cpp:3007 at our pin b290693,
// built by build_sdcpp_image_metadata_json at :2737):
//
//   root["schema"] = "sdcpp.image.params/v1";
//   root["seed"]   = seed;
//   root["prompt"] = {{"positive", …}, {"negative", …}};
//
// It ECHOES THE PROMPT, and it lands AFTER the genuine `Seed:` field. Our "last
// match wins" rule was built on "the prompt only ever comes FIRST", so with the
// tail present a prompt containing the literal text `Seed: 999` became the LAST
// `Seed:` in the string and won. The number recorded in tachi-gen was then a seed
// nothing sampled — unrecoverable months later, when the chunk is all there is.
//
// Shaped here exactly as the engine writes it, so the fixture is the bug.

/** The engine's tail for a run seeded 16124, echoing `prompt`. */
const sdcppTail = (seed: number, prompt: string, negative = ''): string =>
  ', SDCPP: ' + JSON.stringify({
    schema: 'sdcpp.image.params/v1',
    mode: 'img_gen',
    generator: { name: 'stable-diffusion.cpp', version: 'master', commit: 'b290693' },
    seed, width: 512, height: 512,
    prompt: { positive: prompt, negative },
    sampling: { steps: 20, sample_method: 'euler' },
    models: { model: 'model.safetensors' },
    clip_skip: -1, strength: 0.75,
  })

/** A whole `parameters` chunk the way sd-cli writes one, tail included. */
const chunkFor = (seed: number, prompt: string): string =>
  `${prompt}\n` +
  `Steps: 20, CFG scale: 7.00, Guidance: 3.50, Eta: 0.00, Seed: ${seed}, Size: 512x512, ` +
  'Model: model, RNG: cuda, Sampler: euler, Version: stable-diffusion.cpp' +
  sdcppTail(seed, prompt)

/** THE ADVERSARIAL PROMPT. Nothing exotic — a user asking for a picture of a
 *  seed packet, or quoting someone else's settings, types this. */
const HOSTILE_PROMPT = 'Seed: 999'

/** The CLI's own progress stream around the same run. */
const LOG = [
  '[INFO ] stable-diffusion.cpp:1387 - sampling using DPM++ (2M) method',
  '[INFO ] stable-diffusion.cpp:1409 - generating image: 1/1 - seed 16124',
  '  |==================================================| 28/28 - 1.42s/it',
  '[INFO ] stable-diffusion.cpp:1553 - save result PNG image to \'out.png\'',
].join('\n')

// ─── 1. reading the engine's answer ──────────────────────────────────────────

describe('parseSdSeed — the engine says what it did, in two places', () => {
  it('reads the seed out of sd.cpp\'s own parameters chunk', () => {
    expect(parseSdSeed({ parameters: PARAMETERS })).toBe(16124)
  })

  it('reads it out of the run log — the ONLY source for a .webm', () => {
    expect(parseSdSeed({ log: LOG })).toBe(16124)
  })

  it('the chunk OUT-VOTES the log: it is the engine\'s record of THIS file', () => {
    expect(parseSdSeed({ parameters: PARAMETERS, log: LOG.replace('16124', '999') })).toBe(16124)
  })

  it('a prompt that literally contains "Seed: 7" cannot out-vote the metadata', () => {
    // The chunk STARTS with the user's prompt, so a first-match parse is wrong.
    const hostile = 'Seed: 7 growing in soil Negative prompt: Steps: 20, Seed: 16124, Size: 512x512'
    expect(parseSdSeed({ parameters: hostile })).toBe(16124)
  })

  it('THE BUG: a prompt of "Seed: 999" cannot out-vote it THROUGH THE SDCPP TAIL either', () => {
    // Last-match-wins used to read the prompt's own text out of the JSON echo
    // that upstream appends AFTER the real Seed: field, and record 999.
    const chunk = chunkFor(16124, HOSTILE_PROMPT)
    expect(chunk.lastIndexOf('Seed: 999'), 'the fixture must actually contain the trap')
      .toBeGreaterThan(chunk.indexOf('Seed: 16124'))
    expect(parseSdSeed({ parameters: chunk })).toBe(16124)
  })

  it('…and the log cannot rescue it either — the chunk must be right on its own', () => {
    // The chunk out-votes the log by design, so a wrong chunk is the final answer.
    expect(parseSdSeed({ parameters: chunkFor(16124, HOSTILE_PROMPT), log: LOG })).toBe(16124)
  })

  it('a BATCH: each file carries its own chunk, and its own hostile echo', () => {
    // collectSdImages reads one chunk per file; the trap fires per image, and
    // stamping image 0 with image 2's seed is the same class of lie one axis over.
    for (const seed of [18002, 18003, 18004]) {
      expect(parseSdSeed({ parameters: chunkFor(seed, HOSTILE_PROMPT) }), String(seed)).toBe(seed)
    }
  })

  it('a prompt that forges the MARKER itself still cannot win', () => {
    // `, SDCPP: {"seed": 999}` typed into the prompt box. The forged marker comes
    // FIRST, but its remainder is `{"seed": 999}\nSteps: 20, …` — trailing text,
    // so JSON.parse rejects it. Only the real tail runs to the end of the string.
    const forged = ', SDCPP: {"seed": 999}'
    expect(parseSdSeed({ parameters: chunkFor(16124, forged) })).toBe(16124)
    // …and the schema check is what makes "it parsed" mean "it is the engine's".
    expect(parseSdcppMetadata(chunkFor(16124, forged))?.schema).toBe('sdcpp.image.params/v1')
  })

  it('the JSON is the SOURCE, not a tiebreak: it wins even against a stale A1111 field', () => {
    // Same run, two layers, one truth. If they ever disagree the structured one
    // is the one a prompt cannot reach.
    const chunk = chunkFor(16124, 'a cat').replace('Seed: 16124', 'Seed: 7')
    expect(parseSdSeed({ parameters: chunk })).toBe(16124)
  })

  it('an image written BEFORE the tail existed still parses (the fallback lives)', () => {
    expect(parseSdSeed({ parameters: PARAMETERS })).toBe(16124)
    expect(parseSdcppMetadata(PARAMETERS)).toBeNull()
  })

  it('a truncated or foreign tail falls back rather than throwing', () => {
    const cut = chunkFor(16124, 'a cat').slice(0, -12)          // JSON chopped
    expect(parseSdSeed({ parameters: cut })).toBe(16124)         // …A1111 head answers
    const foreign = `a cat\nSteps: 20, Seed: 16124, Size: 512x512, SDCPP: {"schema":"someone.else/v1","seed":5}`
    expect(parseSdcppMetadata(foreign)).toBeNull()
    expect(parseSdSeed({ parameters: foreign })).toBe(16124)
  })

  it('a batch run reports the LAST image — the one we just read off disk', () => {
    const batch = [
      '[INFO ] - generating image: 1/2 - seed 100',
      '[INFO ] - generating image: 2/2 - seed 101',
    ].join('\n')
    expect(parseSdSeed({ log: batch })).toBe(101)
  })

  it('says nothing rather than guessing', () => {
    expect(parseSdSeed({})).toBeNull()
    expect(parseSdSeed({ parameters: '', log: '' })).toBeNull()
    expect(parseSdSeed({ parameters: null, log: null })).toBeNull()
    expect(parseSdSeed({ log: 'loading model from seed.gguf' })).toBeNull()
    expect(parseSdSeed({ log: 'random seed enabled' })).toBeNull()
  })

  it('tolerates the video wording of the same line', () => {
    expect(parseSdSeed({ log: '[INFO ] - generating video: 1/1 - seed 4242' })).toBe(4242)
  })

  it('never accepts a negative or non-integer as an answer', () => {
    expect(parseSdSeed({ parameters: 'Steps: 20, Seed: -1, Size: 512x512' })).toBeNull()
    expect(parseSdSeed({ log: '- generating image: 1/1 - seed -1' })).toBeNull()
    // …including out of the structured tail, where -1 would be a REQUEST again.
    expect(parseSdSeed({ parameters: `a cat\nSteps: 20${sdcppTail(-1, 'a cat')}` })).toBeNull()
  })
})

// ─── 2. THE PIN ──────────────────────────────────────────────────────────────

describe('resolveActualSeed — a -1 request never reaches the chunk', () => {
  it('THE DRIVER BUG: seed -1 requested, 16124 chosen ⇒ 16124 is recorded', () => {
    expect(resolveActualSeed(16124, -1)).toBe(16124)
  })

  it('…and the engine still wins over a concrete request', () => {
    // They should agree (we passed --seed 5), but if they ever disagree the
    // file is what happened and the request is what we hoped.
    expect(resolveActualSeed(16124, 5)).toBe(16124)
  })

  it('no answer + a concrete request ⇒ the request, which DID run', () => {
    expect(resolveActualSeed(null, 5)).toBe(5)
    expect(resolveActualSeed(null, 0)).toBe(0)
  })

  it('no answer + no request ⇒ -1, honestly "we do not know"', () => {
    expect(resolveActualSeed(null, undefined)).toBe(-1)
    expect(resolveActualSeed(null, -1)).toBe(-1)
  })
})

// ─── 3. the renderer's copy (the gallery entry / Remix) ──────────────────────

describe('stampLocalSeed — the entry carries the seed that ran', () => {
  it('overwrites the -1 the composer sent with the engine\'s number', () => {
    expect(stampLocalSeed({ seed: -1, steps: 28 }, 16124)).toEqual({ seed: 16124, steps: 28 })
  })

  it('never invents one when the engine did not say', () => {
    expect(stampLocalSeed({ seed: -1 }, -1)).toEqual({ seed: -1 })
    expect(stampLocalSeed({ seed: -1 }, undefined)).toEqual({ seed: -1 })
    expect(stampLocalSeed({ seed: -1 }, NaN)).toEqual({ seed: -1 })
  })

  it('does not mutate the params it was handed', () => {
    const p = { seed: -1 }
    stampLocalSeed(p, 16124)
    expect(p).toEqual({ seed: -1 })
  })
})

// ─── 4. wiring — both engines read it back, both entries record it ───────────

describe('the wiring: nothing writes a request where an answer exists', () => {
  const CLIENT = read('electron/services/sd-cpp-client.ts')
  const PAGE   = read('src/pages/media/MediaPage.tsx')

  it('the image path resolves the seed BEFORE it builds the tachi-gen chunk', () => {
    expect(CLIENT).toMatch(/parseSdSeed\(\{\s*parameters: readTextChunks\(bytes\)\.get\('parameters'\)/)
    expect(CLIENT).toMatch(/seed:\s+actualSeed,/)
    // the old lie, gone
    expect(CLIENT).not.toMatch(/seed:\s+input\.seed\s+\?\?\s+-1/)
  })

  it('the video path parses the log — a .webm has no chunk to read', () => {
    expect(CLIENT).toMatch(/seed: resolveActualSeed\(parseSdSeed\(\{ log: engineLog \}\), input\.seed\)/)
  })

  it('BOTH streams are kept, not just the one this build happens to log to', () => {
    expect((CLIENT.match(/engineLog \+= String\(d\)/g) ?? []).length).toBe(4)
  })

  it('a metadata read can never fail the generation', () => {
    // The seed read-back sits in its own try/catch: a corrupt PNG must cost the
    // seed, not the image the user just waited for. (The fallback request is
    // per-image now — `seed + i`, the engine's own increment — because a batch
    // whose chunks are all unreadable must not stamp four files with one seed.)
    expect(CLIENT).toMatch(/\} catch \{ actualSeed = resolveActualSeed\(null, sdBatchSeedRequest\(input\.seed, i\)\) \}/)
  })

  it('the gallery entry records it on both modalities', () => {
    // Image side: since the W3-A batch wire, the entry's headline seed is the
    // FIRST image's own engine seed (each batch image carries its own in its
    // own tEXt chunk) — still the engine's answer, never the request.
    expect(PAGE).toMatch(/entryParams = stampLocalSeed\(entryParams, localImages\[0\]\.seed\)/)
    // The anchor is `params: entryParams` and NOT the end of the call: pushEntry
    // gained a sibling argument (completedAfterPrivate) and this assertion broke
    // on the closing brace, not on anything it exists to protect. What it must
    // pin is that the STAMPED params reach the entry — nothing about arity.
    expect(PAGE).toMatch(/params: entryParams\b/)
    expect(PAGE).toMatch(/stampLocalSeed\(stampLocalWanTime\(runParams, localFrames\.frames, durationSpec\?\.fps\), r\.seed\)/)
  })
})
