// apps/desktop/test/unit/sdLivePreview.test.ts
//
// AN ELEVEN-MINUTE RENDER SHOWED A BAR AND NOTHING ELSE.
//
// sd.cpp has been able to decode its own latents mid-run the whole time — the
// flags are in the help text of the exact binary we ship (stable-diffusion.cpp,
// verified against the installed sd-cli on 2026-08-03):
//
//   --preview            preview method. must be one of the following
//                        [none, proj, tae, vae] (default is none)
//   --preview-path       path to write preview image to (default ./preview.png)
//   --preview-interval   interval in denoising steps between consecutive
//                        updates of the image preview file (default is 1)
//
// We never passed any of them. This pins the three decisions that make passing
// them safe: WHICH decoder, HOW OFTEN, and how a file the engine is still
// writing is read without ever handing a torn PNG to the UI.

import { describe, it, expect, vi, afterAll } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = mkdtempSync(join(tmpdir(), 'tachi-sdpreview-'))
afterAll(() => { try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ } })
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  buildSdArgs, previewIntervalFor, completePngOrNull, PREVIEW_TARGET_FRAMES,
  type SdArgEnv, type SdGenerateInput,
} from '../../electron/services/sd-cpp-client'
import { findSdRow } from '../../electron/services/sd-cpp-models'

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}

const INPUT: SdGenerateInput = { modelId: 'sd15', prompt: 'a lighthouse' }
const argsWith = (env: Partial<SdArgEnv>): string[] =>
  buildSdArgs({ model: 'm.safetensors' }, INPUT, 'out.png', { row: findSdRow('sd15'), ...env })

describe('the preview flags reach the argv, and only when asked for', () => {
  it('a run with no preview request is byte-identical to before', () => {
    const args = argsWith({})
    expect(args).not.toContain('--preview')
    expect(args).not.toContain('--preview-path')
    expect(args).not.toContain('--preview-interval')
  })

  it('proj when there is no TAE — a decoder that needs no weights at all', () => {
    const args = argsWith({ preview: { path: 'C:/tmp/p.png', intervalSteps: 3 } })
    expect(flag(args, '--preview')).toBe('proj')
    expect(flag(args, '--preview-path')).toBe('C:/tmp/p.png')
    expect(flag(args, '--preview-interval')).toBe('3')
  })

  it('tae when one is on disk — the cheap decoder we already ship', () => {
    const args = argsWith({ taePath: 'C:/tae.safetensors', preview: { path: 'C:/tmp/p.png', intervalSteps: 3 } })
    expect(flag(args, '--preview')).toBe('tae')
    // …and it is the same file already passed as --tae, not a second download.
    expect(flag(args, '--tae')).toBe('C:/tae.safetensors')
  })

  it('NEVER vae — that is the full decoder, the most expensive thing in the run', () => {
    // Paying for it eight times to watch a picture appear would make the render
    // slower in order to show you that it is slow.
    for (const env of [{}, { taePath: 'C:/tae.safetensors' }]) {
      const args = argsWith({ ...env, preview: { path: 'C:/tmp/p.png', intervalSteps: 1 } })
      expect(flag(args, '--preview')).not.toBe('vae')
    }
  })

  it('the interval is never below 1 — the engine would reject a 0', () => {
    const args = argsWith({ preview: { path: 'C:/tmp/p.png', intervalSteps: 0 } })
    expect(flag(args, '--preview-interval')).toBe('1')
  })
})

describe('previewIntervalFor aims at a count, not at a cadence', () => {
  it('a long run is thinned to about the target number of frames', () => {
    for (const steps of [16, 20, 30, 40, 60]) {
      const frames = Math.floor(steps / previewIntervalFor(steps))
      expect(frames, `steps=${steps}`).toBeGreaterThanOrEqual(PREVIEW_TARGET_FRAMES)
      expect(frames, `steps=${steps}`).toBeLessThanOrEqual(PREVIEW_TARGET_FRAMES * 2)
    }
  })

  it('a short run gets every step — there is nothing to thin out', () => {
    // A 4-step speed-pack render is the case the engine's own default (1) was
    // already right for.
    for (const steps of [1, 2, 4, 7]) expect(previewIntervalFor(steps)).toBe(1)
  })

  it('a nonsense step count does not produce a nonsense interval', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(previewIntervalFor(bad)).toBe(1)
    }
  })
})

// ── READING A FILE THE ENGINE IS STILL WRITING ───────────────────────────────
//
// sd-cli rewrites one PNG in place, so there is no atomic rename to wait for
// and no event to subscribe to. A poll WILL sometimes land mid-write, and a
// torn PNG rendered into an <img> is a broken-image icon in the middle of a
// feature whose whole job is reassurance.
//
// The check is structural rather than a timing guess: IEND is the last chunk a
// PNG writer emits, so a file that has both the signature and IEND is complete.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IEND  = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
const whole = (body = 'pixels') => Buffer.concat([PNG_MAGIC, Buffer.from(body), PNG_IEND])

describe('completePngOrNull', () => {
  it('accepts a file that has both ends', () => {
    const buf = whole()
    expect(completePngOrNull(buf)).toBe(buf)
  })

  it('rejects a write caught in the middle', () => {
    const buf = whole()
    for (const cut of [buf.length - 1, buf.length - 4, Math.floor(buf.length / 2)]) {
      expect(completePngOrNull(buf.subarray(0, cut)), `cut at ${cut}`).toBeNull()
    }
  })

  it('rejects a file that is not a PNG at all, and an empty one', () => {
    expect(completePngOrNull(Buffer.from('not a png at all, but long enough'))).toBeNull()
    expect(completePngOrNull(Buffer.alloc(0))).toBeNull()
    // Long enough to pass the length gate, IEND at the end, no signature: the
    // signature check has to be its own test or a truncated-then-appended file
    // would sneak through.
    expect(completePngOrNull(Buffer.concat([Buffer.from('xxxxxxxxxxxx'), PNG_IEND]))).toBeNull()
  })
})
