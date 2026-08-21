// apps/desktop/test/unit/mediaInitFrame.test.ts
//
// THE INIT FRAME REACHES THE ENGINE — OR IS NOT OFFERED AT ALL.
//
// Driver finding (owner, live): an init/ref image was attached on the MEDIA
// composer's INIT FRAME (IMAGE→VIDEO) control — thumbnail rendered, CHANGE
// IMAGE / CLEAR right there — and the spawn that was captured off the running
// app read:
//
//     -M vid_gen … -p "animate image" -W 832 -H 480 --video-frames 49 …
//
// No `-i`. The image never left the renderer. An hour of GPU went into a pure
// text→video of a prompt that only made sense WITH the picture.
//
// Two independent defects, both pinned here:
//
//  1. THE THREAD WAS NEVER CONNECTED. ParamFields stores the picked file as a
//     `data:` URL under `image_url`; the local generate calls forwarded size,
//     frames, seed, steps and cfg — and nothing else. (The canvas node path DID
//     work, because graph-to-agentkit writes the data URL to a temp file and
//     passes `initImagePath`; that asymmetry is what made this look impossible.)
//     The renderer cannot produce a path, so main materialises the reference.
//
//  2. THE CONTROL PROMISED SOMETHING THE CHECKPOINT CANNOT DO. Image→video in
//     Wan is a DIFFERENT checkpoint — extra conditioning channels plus a
//     clip_vision encoder — and the one video row we ship (wan21-t2v-1.3b)
//     declares `i2v: false` and has no clip_vision file. Wiring `-i` into it
//     would have replaced a silent drop with a silent lie, so the composer stops
//     OFFERING the control on a row that cannot use it (the same narrowing
//     localVideoOptionsFor already does for 720p and 30 s).
//
// And the reverse, which is the regression that would hurt most: NO init frame
// set ⇒ no `-i`. Composer params are persisted per MODALITY, so an `image_url`
// left behind by an imgnAI/Venice run outlives the control that set it.

import { describe, it, expect, vi, afterAll } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'

// hoisted: sd-cpp-client → storage-root reads app.getPath() at IMPORT time.
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-initframe-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => String(b) },
}))

import { materializeInitImage } from '../../electron/services/util/init-image'
import { buildSdArgs } from '../../electron/services/sd-cpp-client'
import { modelParamSchema } from '../../electron/services/surplus-media-service'
import { SD_VIDEO_MODELS } from '../../electron/services/sd-cpp-models'
import { schemaOffersInitImage, resolveLocalInitImage, resolveLocalStrength } from '../../src/pages/media/MediaPage'
import type { ParamSpec } from '../../src/types/electron'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

// A 1x1 PNG — real bytes, so "was the file written correctly" is a real answer.
const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_1PX_B64}`

describe('materializeInitImage — a data: URL becomes a file sd-cli can open', () => {
  // Deleted when the suite ends: a test about not leaking init temps has no
  // business leaving a dir of them in %TEMP% on every run.
  const dir = mkdtempSync(join(tmpdir(), 'tachi-init-mat-'))
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ } })

  it('writes the decoded bytes and hands back the path (the composer case)', () => {
    // `<clock>-<entropy>`: the clock alone collided when two Generate clicks
    // landed in the same millisecond, and since the temp is now DELETED at the
    // end of a run (sdInitTempCleanup) the loser of that race also had its frame
    // pulled out from under it mid-render. Both parts are injectable so the name
    // is pinnable; the shape has to stay inside the boot sweep's pattern.
    const p = materializeInitImage(PNG_DATA_URL, { dir, now: () => 1234, entropy: () => 'deadbeef' })!
    expect(p).toBe(join(dir, 'sd-init-1234-deadbeef.png'))
    expect(existsSync(p)).toBe(true)
    // the FILE is the point — byte-identical to what the picker read
    expect(readFileSync(p).toString('base64')).toBe(PNG_1PX_B64)
  })

  it('two calls in the SAME millisecond do not write the same file', () => {
    const a = materializeInitImage(PNG_DATA_URL, { dir, now: () => 777 })!
    const b = materializeInitImage(PNG_DATA_URL, { dir, now: () => 777 })!
    expect(a).not.toBe(b)
    expect(existsSync(a) && existsSync(b)).toBe(true)
  })

  it('names the file by the declared mime, so the loader is not guessing', () => {
    expect(materializeInitImage(`data:image/jpeg;base64,${PNG_1PX_B64}`, { dir, now: () => 1 })).toMatch(/\.jpg$/)
    expect(materializeInitImage(`data:image/webp;base64,${PNG_1PX_B64}`, { dir, now: () => 2 })).toMatch(/\.webp$/)
    // unknown/absent mime falls back to .png rather than inventing an extension
    expect(materializeInitImage(`data:;base64,${PNG_1PX_B64}`, { dir, now: () => 3 })).toMatch(/\.png$/)
  })

  it('passes through a path that already exists (a remixed / hand-edited bag)', () => {
    const onDisk = join(dir, 'already-here.png')
    writeFileSync(onDisk, Buffer.from(PNG_1PX_B64, 'base64'))
    expect(materializeInitImage(onDisk, { dir })).toBe(onDisk)
    // …and refuses one that does not, instead of handing sd-cli a dead path
    expect(materializeInitImage(join(dir, 'nope.png'), { dir })).toBeUndefined()
  })

  it('does NOT fetch a remote reference — the one-shot sd-cli cannot', () => {
    expect(materializeInitImage('https://example.com/cat.png', { dir })).toBeUndefined()
    expect(materializeInitImage('http://example.com/cat.png', { dir })).toBeUndefined()
  })

  it('returns undefined — never a throw — for everything unusable', () => {
    for (const bad of ['', '   ', 'data:image/png;base64,', 'data:image/png,notbase64',
                       null, undefined, 42, {}, [PNG_DATA_URL], true]) {
      expect(materializeInitImage(bad, { dir })).toBeUndefined()
    }
  })

  it('survives an unwritable destination: no init frame beats no render', () => {
    const p = materializeInitImage(PNG_DATA_URL, {
      dir, now: () => 9, write: () => { throw new Error('EACCES') },
    })
    expect(p).toBeUndefined()
  })
})

describe('buildSdArgs — `-i` is emitted if and only if there is an init frame', () => {
  const components = { model: 'C:/models/sd15.safetensors' }
  const base = { modelId: 'sd15', prompt: 'a cat' }

  it('emits -i AND --strength when an init frame is present (img2img)', () => {
    const args = buildSdArgs(components, { ...base, initImagePath: 'C:/tmp/sd-init-1.png', strength: 0.35 }, 'out.png')
    expect(args).toContain('-i')
    expect(args[args.indexOf('-i') + 1]).toBe('C:/tmp/sd-init-1.png')
    expect(args[args.indexOf('--strength') + 1]).toBe('0.35')
  })

  it('defaults the strength rather than letting sd-cli pick one silently', () => {
    const args = buildSdArgs(components, { ...base, initImagePath: 'C:/tmp/x.png' }, 'out.png')
    expect(args[args.indexOf('--strength') + 1]).toBe('0.6')
  })

  it('THE REVERSE: no init frame ⇒ no -i and no --strength at all', () => {
    const args = buildSdArgs(components, base, 'out.png')
    expect(args).not.toContain('-i')
    expect(args).not.toContain('--strength')
  })

  it('an empty/whitespace path is not an init frame either', () => {
    expect(buildSdArgs(components, { ...base, initImagePath: '' }, 'out.png')).not.toContain('-i')
  })
})

describe('the VIDEO path emits -i the same way (its args are built inline)', () => {
  const client = () => read('electron/services/sd-cpp-client.ts')

  it('generateVideo pushes -i from initImagePath, and only then', () => {
    // The vid_gen argv now lives in the PURE buildSdVideoArgs, which is where
    // this flag moved with it (the two Wan 2.2 rows gave that builder
    // row-derived arithmetic that reading source cannot check —
    // sdVideoRowTruth.test.ts calls it).
    const src = client()
    const vid = src.slice(src.indexOf('export function buildSdVideoArgs'), src.indexOf('export function generateVideo'))
    expect(vid).toContain("if (input.initImagePath) args.push('-i', input.initImagePath)")
  })
})

describe('the IPC boundary is where the data: URL becomes a path', () => {
  const ipc = () => read('electron/ipc/sd-cpp.ipc.ts')

  it('both generate handlers run the payload through withInitImagePath', () => {
    const src = ipc()
    expect(src).toContain('import { materializeInitImageOwned }')
    expect(src).toContain('const prepared = withInitImagePath(input)')
    expect(src).toContain('generateImage(prepared.input, win)')
    expect(src).toContain('generateVideo(prepared.input, win)')
    // …and hand the temp it created to a `finally`, on both channels. The
    // BEHAVIOUR (gone on success, gone on a throw, a user's own path untouched)
    // is pinned in sdInitTempCleanup.test.ts through the registered handlers.
    // BOTH temps now: a run may also carry a REFERENCE IMAGE
    // (`--ip-adapter-image`), materialised by the same function and owned the
    // same way, so a `finally` that dropped only the init frame would leak one
    // temp per Generate — the exact leak this test exists for, one field over.
    expect(src.match(/finally \{ dropOwnTempInit\(prepared\.ownTempInit, prepared\.ownTempRef\) \}/g)).toHaveLength(2)
  })

  it('withInitImagePath drops the renderer keys and adds ONLY materialised paths', () => {
    const src = ipc()
    const fn = src.slice(src.indexOf('function withInitImagePath'), src.indexOf('export function registerSdCppIpc'))
    // Neither raw reference reaches the service — both are destructured away.
    expect(fn).toContain('const { initImage, ipAdapterImage, ...rest } = input')
    expect(fn).toContain('materializeInitImageOwned(initImage)')
    expect(fn).toContain('materializeInitImageOwned(ipAdapterImage)')
    // Nothing usable ⇒ nothing added (no `initImagePath: undefined` key): each
    // path is written only inside its own `if`.
    expect(fn).toMatch(/if \(init\.path\) \{\s*\n\s*out\.initImagePath = init\.path/)
    expect(fn).toMatch(/if \(ref\.path\) \{\s*\n\s*out\.ipAdapterImagePath = ref\.path/)
    // …and only OUR temps are ever removed — a user-supplied path carries no
    // ownTemp, and that is true of both pictures.
    expect(fn).toContain('prepared.ownTempInit = init.ownTemp')
    expect(fn).toContain('prepared.ownTempRef = ref.ownTemp')
  })
})

describe('the composer forwards it — the thread that was cut', () => {
  const page = () => read('src/pages/media/MediaPage.tsx')
  const body = () => {
    const src = page()
    return src.slice(src.indexOf('  const generate = async () => {'), src.indexOf('const pushEntry ='))
  }

  it('the LOCAL VIDEO call spreads the resolved init frame', () => {
    const src = body()
    const vid = src.slice(src.indexOf("mediaProvider === 'local' && modality === 'video'"))
    expect(vid).toContain('const initImg = resolveLocalInitImage(runParams, schemaOffersInitImage(shownSchema))')
    expect(vid).toContain('...initImg,')
  })

  it('the LOCAL IMAGE call does too, with its strength (same drop, one modality over)', () => {
    const src = body()
    const img = src.slice(src.indexOf("if (modality === 'image')"), src.indexOf("} else if (modality === 'tts')"))
    expect(img).toContain('const initImg = resolveLocalInitImage(runParams, schemaOffersInitImage(shownSchema))')
    expect(img).toContain('...initImg,')
    expect(img).toContain('...resolveLocalStrength(runParams, initImg.initImage !== undefined),')
  })
})

describe('resolveLocalInitImage — the LIVE schema decides, not the stale bag', () => {
  const OFFERED = true

  it('forwards the data: URL the picker stored', () => {
    expect(resolveLocalInitImage({ image_url: PNG_DATA_URL }, OFFERED)).toEqual({ initImage: PNG_DATA_URL })
  })

  it('forwards a plain path too (a Remix of an entry that recorded one)', () => {
    expect(resolveLocalInitImage({ image_url: 'C:/pics/frame.png' }, OFFERED)).toEqual({ initImage: 'C:/pics/frame.png' })
  })

  it('THE REVERSE: no frame ⇒ NO KEY AT ALL (not `initImage: undefined`)', () => {
    for (const params of [{}, { image_url: '' }, { image_url: '   ' }, { image_url: null },
                          { image_url: 42 }, { image_url: {} }, { seed: 7 }]) {
      const out = resolveLocalInitImage(params as Record<string, unknown>, OFFERED)
      expect(out).toEqual({})
      expect('initImage' in out).toBe(false)
    }
  })

  it('a STALE image_url cannot smuggle an -i onto a model that dropped the control', () => {
    // Params are persisted per MODALITY: an imgnAI video run's init frame is
    // still in the bag when the LOCAL t2v row is selected. The schema no longer
    // offers `image_url`, so nothing is sent.
    expect(resolveLocalInitImage({ image_url: PNG_DATA_URL }, false)).toEqual({})
  })

  it('schemaOffersInitImage reads the ACTIVE schema, and only an image control', () => {
    const img: ParamSpec = { name: 'image_url', label: 'Init frame', kind: 'image' }
    const txt: ParamSpec = { name: 'image_url', label: 'Init frame URL', kind: 'string' }
    expect(schemaOffersInitImage([{ name: 'prompt', label: 'Prompt', kind: 'text' }, img])).toBe(true)
    expect(schemaOffersInitImage([{ name: 'prompt', label: 'Prompt', kind: 'text' }])).toBe(false)
    expect(schemaOffersInitImage([])).toBe(false)
    // a same-named control of another kind is not a file picker
    expect(schemaOffersInitImage([txt])).toBe(false)
  })
})

describe('resolveLocalStrength — meaningful only WITH a frame', () => {
  it('forwards the slider when there is an init frame', () => {
    expect(resolveLocalStrength({ strength: 0.35 }, true)).toEqual({ strength: 0.35 })
    expect(resolveLocalStrength({ strength: 0 }, true)).toEqual({ strength: 0 })
    expect(resolveLocalStrength({ strength: 1 }, true)).toEqual({ strength: 1 })
  })

  it('sends nothing without one — strength alone is noise', () => {
    expect(resolveLocalStrength({ strength: 0.35 }, false)).toEqual({})
  })

  it('refuses a value outside 0..1 (and anything non-numeric) rather than passing it on', () => {
    for (const bad of [-0.1, 1.5, NaN, Infinity, '0.5', null, undefined, {}]) {
      expect(resolveLocalStrength({ strength: bad }, true)).toEqual({})
    }
  })
})

describe('THE TRUTH PASS: the shipped video row cannot start from an image', () => {
  it('clip_vision is a WAN 2.1 i2v requirement — not an image-to-video one', () => {
    // The invariant used to read "i2v <=> clip_vision", which was true while the
    // only i2v row was Wan 2.1's. It is NOT the general law: upstream's own Wan
    // 2.2 commands (docs/wan.md at the pinned build) pass no --clip_vision for
    // either TI2V-5B or I2V-A14B. What holds in both directions is the weaker,
    // true statement: a row that cannot do i2v never ships one.
    for (const row of SD_VIDEO_MODELS) {
      const roles = row.files.map(f => f.role)
      if (!row.i2v) expect(roles, row.id).not.toContain('clip_vision')
    }
    expect(SD_VIDEO_MODELS.filter(r => r.files.some(f => f.role === 'clip_vision')).map(r => r.id))
      .toEqual(['wan21-i2v-14b-480p'])
  })

  it('the one row we ship today IS text→video only', () => {
    const wan = SD_VIDEO_MODELS.find(m => m.id === 'wan21-t2v-1.3b')!
    expect(wan.i2v).toBe(false)
  })

  it('so its schema does NOT offer an init frame (nor an img2img strength)', () => {
    const names = modelParamSchema('video', 'wan21-t2v-1.3b').map(s => s.name)
    expect(names).not.toContain('image_url')
    expect(names).not.toContain('strength')
    // …while the controls that ARE real for it are untouched
    expect(names).toEqual(expect.arrayContaining(['prompt', 'resolution', 'duration', 'aspect_ratio']))
  })

  it('…and the i2v row we now ship BRINGS THE CONTROL BACK, with no code change', () => {
    // The narrowing was keyed off `row.i2v` from the day it was written, so the
    // whole cost of turning the control back on was one DATA row (Wan 2.1
    // I2V-14B-480P). This is the assertion that proves the key works in the
    // direction it was never exercised in.
    const row = SD_VIDEO_MODELS.find(m => m.id === 'wan21-i2v-14b-480p')!
    expect(row.i2v).toBe(true)
    expect(row.files.map(f => f.role)).toContain('clip_vision')

    const specs = modelParamSchema('video', 'wan21-i2v-14b-480p')
    expect(specs.map(s => s.name)).toContain('image_url')
    expect(schemaOffersInitImage(specs)).toBe(true)
    // …so resolveLocalInitImage forwards a frame for THIS model and drops it for
    // the t2v one, off the same params bag.
    const params = { image_url: 'data:image/png;base64,AAAA' }
    expect(resolveLocalInitImage(params, schemaOffersInitImage(specs)))
      .toEqual({ initImage: 'data:image/png;base64,AAAA' })
    expect(resolveLocalInitImage(params, schemaOffersInitImage(modelParamSchema('video', 'wan21-t2v-1.3b'))))
      .toEqual({})

    // and the apology the t2v row carries is ABSENT here — nothing is missing
    const res = specs.find(s => s.name === 'resolution')!
    expect(res.description ?? '').not.toContain('text→video only')
    // it is a 480p checkpoint, so that is the only tier it may offer
    expect(res.enum).toEqual(['480p'])
  })

  it('a CLOUD video model keeps the full superset — the narrowing is local-only', () => {
    const names = modelParamSchema('video', 'some-cloud-i2v-model').map(s => s.name)
    expect(names).toContain('image_url')
  })

  it('LOCAL IMAGE models keep it: img2img works on any sd.cpp checkpoint', () => {
    const names = modelParamSchema('image', 'sd15').map(s => s.name)
    expect(names).toContain('image_url')
    expect(names).toContain('strength')
  })

  it('the narrowing is keyed off the ROW, so an i2v row brings the control back', () => {
    const src = read('electron/services/surplus-media-service.ts')
    expect(src).toContain('i2v: m.i2v,')
    expect(src).toContain('if (localVid && !localVid.i2v) continue')
  })

  it('and the composer SAYS why the control is gone (a vanishing control is a bug)', () => {
    const res = modelParamSchema('video', 'wan21-t2v-1.3b').find(s => s.name === 'resolution')!
    expect(res.description).toContain('text→video only')
    expect(res.description).toContain('i2v checkpoint')
    // a cloud model, which keeps the control, gets no such sentence
    const cloud = modelParamSchema('video', 'some-cloud-i2v-model').find(s => s.name === 'resolution')!
    expect(cloud.description ?? '').not.toContain('text→video only')
  })
})
