// apps/desktop/test/unit/sdEffectiveParams.test.ts
//
// THE GALLERY ENTRY DESCRIBED A RUN THAT DID NOT HAPPEN.
//
// Driver finding (speed A/B, 2026-07-31). The speed pack was ON, and
// D:\projects\tachidecktests\driver-speedab\SDCLI-WATCH.log records the argv
// the app actually spawned:
//
//   sd-cli.exe -M vid_gen … --cfg-scale 1 --sampling-method euler --steps 4
//              --scheduler simple --flow-shift 1 …
//
// while the gallery entry that run produced recorded `steps: 20, cfg: 6` — the
// COMPOSER's bag, untouched. Both numbers are in the app at the same instant;
// only one of them describes the render.
//
// It is the same class of hole 2bd48fc closed for the frame count and
// resolveActualSeed closed for the seed: the entry is the only provenance a
// .webm has, and "Remix" restores from it. Remixing that entry re-ran a
// 20-step, guidance-6 render and called it a reproduction.
//
// THE PRESET OUT-VOTES THE COMPOSER BY DESIGN — buildSdVideoArgs says so in its
// own comment, and the toggle that turns it on says so to the user ("runs at N
// steps and guidance 1 whatever the Steps and Guidance controls say"). Nothing
// about that is wrong. What was wrong is that the out-vote was invisible
// afterwards, because the resolution lived inline in the argv builder and was
// thrown away with the string array.
//
// So the resolution is now a named, pure function that BOTH the argv builder
// and the provenance stamp read. One source, so they cannot drift.

import { describe, it, expect, vi } from 'vitest'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), 'tachi-sdeff-'))
})
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  buildSdArgs, buildSdVideoArgs, effectiveImageParams, effectiveVideoParams,
  type SdArgEnv,
} from '../../electron/services/sd-cpp-client'
import { SD_SPEED_ADAPTERS, findSdRow } from '../../electron/services/sd-cpp-models'
import { stampLocalEngineParams } from '../../src/pages/media/localGenParams'

const I2V_14B = 'wan21-i2v-14b-480p'
const PACK = SD_SPEED_ADAPTERS.find(a => a.modelId === I2V_14B)!

/** The env sdArgEnvFor builds for a speed run: the row, a lora dir, the pack. */
const speedEnv = (): SdArgEnv => ({
  row: findSdRow(I2V_14B),
  adapterDirs: { lora: 'D:\\Tachi Studio\\Models\\sd\\loras' },
  speed: PACK,
})
/** The same run with the pack absent from disk. */
const vanillaEnv = (): SdArgEnv => ({ row: findSdRow(I2V_14B) })

/** The composer bag the driver's run carried — the row's vanilla recipe. */
const COMPOSER = { steps: 20, cfgScale: 6, samplingMethod: 'euler' }

const VIDEO_INPUT = { modelId: I2V_14B, prompt: 'young girl dance', ...COMPOSER }

describe('effectiveVideoParams — what the engine was actually told', () => {
  it('THE REPRO: with the pack on disk it is the PACK, not the composer', () => {
    const eff = effectiveVideoParams(VIDEO_INPUT, speedEnv())
    expect(eff).toMatchObject({
      steps: 4, cfgScale: 1, samplingMethod: 'euler',
      scheduler: PACK.preset.scheduler, flowShift: PACK.preset.flowShift,
    })
    // …and the composer's own numbers are exactly what the entry used to store.
    expect(eff.steps).not.toBe(COMPOSER.steps)
    expect(eff.cfgScale).not.toBe(COMPOSER.cfgScale)
  })

  it('without the pack it IS the composer — this is not a second opinion', () => {
    expect(effectiveVideoParams(VIDEO_INPUT, vanillaEnv())).toMatchObject({ steps: 20, cfgScale: 6 })
  })

  it('the pack is ignored when the lora dir is missing, and so is the stamp', () => {
    // buildSdVideoArgs falls back to the vanilla recipe ENTIRELY when there is
    // no `--lora-model-dir` to resolve the tags in ("all or nothing"). The
    // provenance has to make the same call or it describes a 4-step run that
    // went out at 20.
    const noDir: SdArgEnv = { row: findSdRow(I2V_14B), speed: PACK }
    expect(effectiveVideoParams(VIDEO_INPUT, noDir)).toMatchObject({ steps: 20, cfgScale: 6 })
  })

  it('a row-less run still answers, from sd-cli\'s own defaults', () => {
    expect(effectiveVideoParams({ modelId: 'nope', prompt: 'x' }, {})).toMatchObject({
      steps: 20, cfgScale: 6, samplingMethod: 'euler',
    })
  })
})

describe('the stamp and the argv cannot disagree', () => {
  const args = (env: SdArgEnv) => buildSdVideoArgs(
    { diffusion: 'd.gguf', vae: 'v.safetensors', t5xxl: 't5.gguf' }, VIDEO_INPUT, 'out.webm', env,
  )
  const flag = (a: string[], name: string) => { const i = a.indexOf(name); return i < 0 ? undefined : a[i + 1] }

  it('every number the stamp reports is the number on the command line (speed ON)', () => {
    const env = speedEnv()
    const a = args(env)
    const eff = effectiveVideoParams(VIDEO_INPUT, env)
    expect(flag(a, '--steps')).toBe(String(eff.steps))
    expect(flag(a, '--cfg-scale')).toBe(String(eff.cfgScale))
    expect(flag(a, '--sampling-method')).toBe(eff.samplingMethod)
    expect(flag(a, '--scheduler')).toBe(eff.scheduler)
    expect(flag(a, '--flow-shift')).toBe(String(eff.flowShift))
    // The argv the driver captured, verbatim.
    expect(flag(a, '--steps')).toBe('4')
    expect(flag(a, '--cfg-scale')).toBe('1')
  })

  it('…and with speed OFF', () => {
    const env = vanillaEnv()
    const a = args(env)
    const eff = effectiveVideoParams(VIDEO_INPUT, env)
    expect(flag(a, '--steps')).toBe(String(eff.steps))
    expect(flag(a, '--cfg-scale')).toBe(String(eff.cfgScale))
    expect(flag(a, '--sampling-method')).toBe(eff.samplingMethod)
  })
})

describe('effectiveImageParams — the same law on the image path', () => {
  const IMG = { modelId: 'sd-turbo', prompt: 'a lighthouse' }
  const imgArgs = (input: typeof IMG & { steps?: number }) =>
    buildSdArgs({ model: 'm.safetensors' }, input, 'out.png', { row: findSdRow('sd-turbo') })

  it('falls through to the ROW when the composer says nothing', () => {
    const eff = effectiveImageParams(IMG, { row: findSdRow('sd-turbo') })
    const a = imgArgs(IMG)
    expect(a[a.indexOf('--steps') + 1]).toBe(String(eff.steps))
    expect(a[a.indexOf('--cfg-scale') + 1]).toBe(String(eff.cfgScale))
    // sd-turbo's own recipe, not the 20/7 generic fallback.
    expect(eff).toMatchObject({ steps: 1, cfgScale: 1 })
  })

  it('the composer wins when it says something', () => {
    expect(effectiveImageParams({ ...IMG, steps: 12 }, { row: findSdRow('sd-turbo') }).steps).toBe(12)
  })
})

// ── the renderer half: the entry the gallery keeps ───────────────────────────

describe('stampLocalEngineParams — the entry records the run, not the request', () => {
  it('THE REPRO: a speed run stops claiming 20 steps at guidance 6', () => {
    const bag = { prompt: 'young girl dance', steps: 20, cfg: 6, sampler: 'euler', speed_mode: true }
    const out = stampLocalEngineParams(bag, {
      steps: 4, cfgScale: 1, samplingMethod: 'euler', scheduler: 'simple', flowShift: 1,
    })
    expect(out).toMatchObject({ steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple', flow_shift: 1 })
    // Untouched keys survive — Remix restores the whole composer, not just these.
    expect(out.prompt).toBe('young girl dance')
    expect(out.speed_mode).toBe(true)
  })

  it('nothing to stamp is a no-op, exactly like stampLocalSeed', () => {
    const bag = { steps: 20, cfg: 6 }
    expect(stampLocalEngineParams(bag, undefined)).toBe(bag)
  })

  it('optional halves are omitted rather than written as undefined', () => {
    const out = stampLocalEngineParams({ steps: 20 }, { steps: 8, cfgScale: 3.5, samplingMethod: 'euler' })
    expect(out).toMatchObject({ steps: 8, cfg: 3.5, sampler: 'euler' })
    expect('scheduler' in out).toBe(false)
    expect('flow_shift' in out).toBe(false)
  })

  it('the keys are the COMPOSER\'s names, so Remix can read them back', () => {
    // The bag is keyed by ParamSpec.name — `cfg`, not `cfgScale`; `sampler`,
    // not `samplingMethod`. Writing the engine's spelling would silently add
    // dead keys and leave the composer showing the old numbers.
    const out = stampLocalEngineParams({}, { steps: 4, cfgScale: 1, samplingMethod: 'euler' })
    expect(Object.keys(out).sort()).toEqual(['cfg', 'sampler', 'steps'])
  })
})
