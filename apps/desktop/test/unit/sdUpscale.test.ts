// apps/desktop/test/unit/sdUpscale.test.ts
//
// THE UPSCALE VERTICAL — "make it bigger", which is the #1 follow-up to a
// finished render (the 41%-presence cluster) and had no answer in the app at all.
//
// ── WHAT THE GATE PROVED, BEFORE ANY OF THIS WAS WIRED ───────────────────────
//
// Run live against the INSTALLED binary at our pin (master-782-b290693) on
// 2026-07-31, on a real 1024x1024 PNG from the media folder:
//
//   sd-cli -M upscale --upscale-model <file> -i <src.png> -o <out.png>
//
//   • RealESRGAN_x4plus_anime_6B.pth  (17.9 MB) → 4096x4096, 10.8 s wall
//   • RealESRGAN_x4plus.pth           (64 MB)   → 4096x4096, 26.4 s wall
//   • RealESRGAN_x4plus.safetensors   (64 MB)   → 4096x4096, 26.3 s wall
//
// All three LOAD and RUN. `esrgan.hpp:83` prints
// `scale = 4, num_block = 6, …` for the 6-block file and runs the 23-block file
// too, so the block count is READ FROM THE WEIGHTS rather than compiled in —
// which is why the general-purpose x4plus is a legal choice here at all.
//
// NO DIFFUSION MODEL IS LOADED: the probe passed no `-m` and no prompt, and the
// engine loaded 192 tensors from the upscaler alone (`model_manager prepared
// params backend buffer (8.53 MB, 192 tensors)`). That is the whole reason this
// is a SEPARATE entry point instead of a flag threaded through generateImage.
//
// ── WHY THE SAFETENSORS FILE AND NOT THE CANONICAL .pth ──────────────────────
//
// `fileExtFor` (sd-cpp-installer) returns NULL for `.pth` — "this component must
// never be written to disk" — because a pickle can execute arbitrary code when
// PyTorch loads it. sd.cpp is C++ and only parses the pickle opcodes for tensor
// metadata, so the vector does not reach US; but that refusal is a documented
// defense-in-depth policy applied at two layers, and a lane does not get to
// quietly flip a security posture to save 3 MB.
//
// It did not have to be flipped. Comfy-Org/Real-ESRGAN_repackaged publishes the
// SAME WEIGHTS as safetensors under a DECLARED bsd-3-clause licence, and the
// gate proved the repackage is faithful: upscaling one image with the .pth and
// with the safetensors produced BYTE-IDENTICAL PNGs
// (sha256 dc77410a985d5b41e9bac2aa673c04c695a528372c1bf64e7acd379db779459d for
// both). Same pixels, allowed container, licence read off the HF model API — and
// Comfy-Org is a source this registry already pins (the Wan 2.1 VAE and
// clip_vision components come from Comfy-Org/Wan_2.1_ComfyUI_repackaged).
//
// ── AND WHAT THE GATE FOUND OUT ABOUT PROVENANCE ─────────────────────────────
//
// The upscaled PNG carries a `parameters` tEXt chunk that DESCRIBES A RUN THAT
// NEVER HAPPENED. Verbatim from the probe output:
//
//   Steps: 20, CFG scale: 7.000000, Seed: 42, Size: 1024x1024, Model: ,
//   Sampler: NONE, … "mode":"img_gen", "models":null,
//   "prompt":{"negative":"","positive":""}
//
// Every number there is sd-cli's DEFAULT, the mode is a lie (`img_gen` on a
// `-M upscale` run), and `Size: 1024x1024` is the INPUT while the file on disk
// is 4096x4096. The source image's own metadata (its iCCP / XMP / IPTC chunks)
// is DROPPED — nothing is inherited.
//
// That matters because this app already parses that exact chunk: parseSdSeed
// reads `Seed:` out of it, and collectSdImages calls parseSdSeed on every file a
// run writes. Threading upscale through that path would have recorded "seed 42,
// 20 steps, cfg 7" as the provenance of a file that was never sampled. So the
// upscale entry point does no seed parsing and writes no tachi-gen chunk, and
// the gallery entry it produces carries no `params` at all — the same refusal,
// for the same reason, that interpolatedGalleryEntry already makes for RIFE.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The registry / arg-builder / path helpers under test are pure, but their
// MODULES sit next to ones that read `app.getPath('userData')` at import time
// (settings-store -> storage-root). The canvasLocalNegative idiom.
// The temp root is created INSIDE the factory: `vi.mock` is hoisted above every
// module-level const, so a captured one is still uninitialised when the mocked
// module is first imported.
vi.mock('electron', () => {
  const os = require('node:os') as typeof import('node:os')
  const fs = require('node:fs') as typeof import('node:fs')
  const p  = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'tachi-upscale-'))
  return {
  app: { getPath: () => dir, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => String(b),
  },
  }
})

import {
  SD_UPSCALERS, findUpscaler, DEFAULT_UPSCALER_ID, upscalerCatalogFiles,
  type SdUpscaler,
} from '../../electron/services/sd-cpp-models'
import { buildSdUpscaleArgs, upscaleOutputPath } from '../../electron/services/sd-cpp-client'
import { fileExtFor } from '../../electron/services/sd-cpp-installer'
import { upscaledGalleryEntry, UPSCALE_DERIVED_MODEL_ID, mediaFitLine } from '../../src/pages/media/mediaHelpers'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

// ── THE PINNED ASSET ─────────────────────────────────────────────────────────

describe('the curated upscaler row', () => {
  it('ships exactly one row, and it is the default', () => {
    expect(SD_UPSCALERS).toHaveLength(1)
    expect(findUpscaler(DEFAULT_UPSCALER_ID)).toBeDefined()
  })

  it('pins the sha256 published as the LFS oid of the Comfy-Org repackage', () => {
    const u = findUpscaler(DEFAULT_UPSCALER_ID)!
    expect(u.files).toHaveLength(1)
    const f = u.files[0]
    // Measured 2026-07-31: HTTP 200, Content-Length 66_857_836, and the file's
    // own sha256 equalled the tree API's LFS oid byte for byte.
    expect(f.sha256).toBe('37f9a931c215f040aa6d50f711f2cb115f713c46df1d0d6469a8bd7bfe9a60bb')
    expect(f.sizeMb).toBe(Math.ceil(66_857_836 / 1_048_576))
    expect(f.url).toBe('https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged/resolve/main/RealESRGAN_x4plus.safetensors')
  })

  it('declares the licence it lands under, and links its canonical text', () => {
    for (const u of SD_UPSCALERS) {
      expect(u.licenseName).toBeTruthy()
      expect(u.licenseUrl).toMatch(/^https:\/\//)
      // The SOURCE repo's own declaration, so it can be re-checked in one click.
      expect(u.source).toMatch(/^https:\/\/huggingface\.co\//)
      expect(u.license).toBe('bsd-3-clause')
    }
  })

  it('fetches every byte over https, from a repo whose licence was read', () => {
    for (const u of SD_UPSCALERS) {
      for (const f of u.files) {
        expect(f.url).toMatch(/^https:\/\//)
        expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(f.sizeMb).toBeGreaterThan(0)
      }
    }
  })

  it('uses ids and slugs a human can read, the same law every other row obeys', () => {
    for (const u of SD_UPSCALERS) {
      expect(u.id).toMatch(/^[a-z0-9-]+$/)
      for (const f of u.files) expect(f.slug).toMatch(/^[a-z0-9-]+$/)
    }
  })

  // THE POLICY GATE. A `.pth` row would be refused a path by the installer and
  // fail at download time with "not a weights container this engine loads" —
  // this asserts the row we ship is one the installer will actually write.
  it('declares a container the installer is allowed to write', () => {
    for (const u of SD_UPSCALERS) {
      for (const f of u.files) {
        expect(fileExtFor(f, 'model')).toBe('.safetensors')
      }
    }
  })

  // The refusal itself, so a later "just allow .pth" cannot pass silently.
  it('and the pickle refusal it relies on is still in force', () => {
    expect(fileExtFor({ url: 'https://x/RealESRGAN_x4plus.pth' }, 'model')).toBeNull()
    expect(fileExtFor({ url: 'https://x/m.bin', format: 'PickleTensor' }, 'model')).toBeNull()
  })

  it('quotes the scale factor it actually runs at (the gate measured x4)', () => {
    expect(findUpscaler(DEFAULT_UPSCALER_ID)!.scale).toBe(4)
  })

  it('hands the catalog a per-file size, like every other download surface', () => {
    const files = upscalerCatalogFiles(findUpscaler(DEFAULT_UPSCALER_ID)!)
    expect(files).toEqual([{ slug: 'realesrgan-x4plus', sizeMb: 64, sharedWith: [] }])
  })
})

// ── THE ARGV ─────────────────────────────────────────────────────────────────

describe('buildSdUpscaleArgs', () => {
  const args = (over: Partial<Parameters<typeof buildSdUpscaleArgs>[0]> = {}) =>
    buildSdUpscaleArgs({
      modelPath: '/m/realesrgan-x4plus.safetensors',
      inputPath: '/in/a.png',
      outputPath: '/out/b.png',
      ...over,
    })

  it('emits the upscale MODE, the model, the input and the output', () => {
    expect(args()).toEqual([
      '-M', 'upscale',
      '--upscale-model', '/m/realesrgan-x4plus.safetensors',
      '-i', '/in/a.png',
      '-o', '/out/b.png',
      '--disable-image-metadata',
    ])
  })

  // UPSCALE mode shares `write_image` with a generation, so without this flag the
  // engine stamps an upscaled PNG with a `parameters` chunk of DEFAULTS — "Steps:
  // 20, CFG scale: 7, Seed: 42, Sampler: NONE", and `Size: 1024x1024` on a
  // 4096x4096 file. Not reading it back was never enough: the lie stayed on disk
  // for every other tool that reads PNG text chunks.
  //
  // The flag is verified present in the INSTALLED sd-cli's own --help at our pin,
  // and it is valueless — a following token would be swallowed as the next arg.
  it('suppresses the fabricated provenance chunk at the source', () => {
    const a = args()
    expect(a).toContain('--disable-image-metadata')
    const next = a[a.indexOf('--disable-image-metadata') + 1]
    expect(next === undefined || next.startsWith('-'), '--disable-image-metadata takes no value').toBe(true)
  })

  it('keeps suppressing it when the optional flags are present', () => {
    expect(args({ repeats: 2, tileSize: 64 })).toContain('--disable-image-metadata')
  })

  // THE WHOLE POINT OF A SEPARATE ENTRY POINT. `-M upscale` loads no diffusion
  // model, takes no prompt and runs no sampler; an argv that carried any of
  // them would either be ignored or would load gigabytes for nothing.
  it('never emits a diffusion model, a prompt or any sampling flag', () => {
    const a = args()
    for (const flag of [
      '-m', '--model', '--diffusion-model', '--vae', '--clip_l', '--t5xxl', '--llm',
      '-p', '--prompt', '-n', '--negative-prompt',
      '--steps', '--cfg-scale', '--sampling-method', '--scheduler', '-s', '--seed',
      '-W', '-H', '--hires', '-b', '--batch-count', '--clip-skip',
    ]) {
      expect(a, `argv must not carry ${flag}`).not.toContain(flag)
    }
  })

  it('passes --upscale-repeats only when more than one pass was asked for', () => {
    expect(args()).not.toContain('--upscale-repeats')
    expect(args({ repeats: 1 })).not.toContain('--upscale-repeats')
    const two = args({ repeats: 2 })
    expect(two.slice(two.indexOf('--upscale-repeats'), two.indexOf('--upscale-repeats') + 2))
      .toEqual(['--upscale-repeats', '2'])
  })

  // The engine defaults this to 128 and the flag exists for cards that cannot
  // hold a 128-tile compute buffer (the gate measured 416 MB at the default).
  it('passes --upscale-tile-size only when one was chosen', () => {
    expect(args()).not.toContain('--upscale-tile-size')
    const t = args({ tileSize: 64 })
    expect(t.slice(t.indexOf('--upscale-tile-size'), t.indexOf('--upscale-tile-size') + 2))
      .toEqual(['--upscale-tile-size', '64'])
  })

  it('ignores a nonsense repeat / tile count rather than passing it on', () => {
    expect(args({ repeats: 0 })).not.toContain('--upscale-repeats')
    expect(args({ repeats: -3 })).not.toContain('--upscale-repeats')
    expect(args({ repeats: 2.7 })).not.toContain('--upscale-repeats')
    expect(args({ tileSize: 0 })).not.toContain('--upscale-tile-size')
    expect(args({ tileSize: -1 })).not.toContain('--upscale-tile-size')
  })
})

describe('upscaleOutputPath', () => {
  it('lands beside the source, naming the scale that produced it', () => {
    expect(upscaleOutputPath('/media/img/0.png', 4)).toBe('/media/img/0-upscaled-x4.png')
    expect(upscaleOutputPath('C:\\media\\img\\0.png', 4)).toBe('C:\\media\\img\\0-upscaled-x4.png')
  })

  // Upscaling an upscale is legal (x16 in two passes) and must not collide.
  it('does not collide when run on its own output', () => {
    const once = upscaleOutputPath('/m/a.png', 4)
    expect(upscaleOutputPath(once, 4)).toBe('/m/a-upscaled-x4-upscaled-x4.png')
  })

  // The engine writes PNG whatever the input container was, so the extension is
  // a fact rather than a guess — a .jpg source still yields a .png output.
  it('always writes .png, because that is what the engine writes', () => {
    expect(upscaleOutputPath('/m/a.jpg', 4)).toBe('/m/a-upscaled-x4.png')
    expect(upscaleOutputPath('/m/a.webp', 2)).toBe('/m/a-upscaled-x2.png')
  })
})

// ── THE DERIVED GALLERY ENTRY ────────────────────────────────────────────────

describe('upscaledGalleryEntry', () => {
  const base = {
    source:     { prompt: 'a lovely cat', model: 'sd-turbo' },
    sourcePath: '/media/img-1/0.png',
    outputPath: '/media/img-1/0-upscaled-x4.png',
    now:        1_780_000_000_000,
    scale:      4,
    label:      (s: string) => `ESRGAN x4 · from: ${s}`,
  }

  it('files the file as its own entry, attributed to the engine that made it', () => {
    const e = upscaledGalleryEntry(base)!
    expect(e.model).toBe(UPSCALE_DERIVED_MODEL_ID)
    expect(e.modality).toBe('image')
    expect(e.source).toBe('derived')
    expect(e.prompt).toBe('ESRGAN x4 · from: a lovely cat')
    expect(e.artifacts).toEqual([
      { kind: 'image', mimeType: 'image/png', path: '/media/img-1/0-upscaled-x4.png' },
    ])
  })

  // NO params ⇒ NO Remix. Remix would offer to re-run the SOURCE's recipe under
  // a file whose pixels no sampler produced — and the engine's own tEXt chunk on
  // this very file claims "Steps: 20, Seed: 42" about a run that never happened.
  it('carries no params and no provider', () => {
    const e = upscaledGalleryEntry(base)!
    expect(e.params).toBeUndefined()
    expect(e.provider).toBeUndefined()
  })

  it('has nothing to add when the run wrote no path', () => {
    expect(upscaledGalleryEntry({ ...base, outputPath: '' })).toBeNull()
    expect(upscaledGalleryEntry({ ...base, outputPath: '   ' })).toBeNull()
  })

  // One file on disk is one row, however many times a run reports it.
  it('refuses to add a file the gallery already holds', () => {
    const existing = [{
      id: 'x', model: 'm', modality: 'image' as const, prompt: 'p', createdAt: 1,
      artifacts: [{ kind: 'image' as const, mimeType: 'image/png', path: base.outputPath }],
    }]
    expect(upscaledGalleryEntry({ ...base, existing: existing as never })).toBeNull()
  })

  it('falls back to the file name when the source has no prompt', () => {
    const e = upscaledGalleryEntry({
      ...base,
      source: { prompt: '', model: '' },
      label:  s => `from: ${s}`,
    })!
    expect(e.prompt).toBe('from: 0.png')
  })

  it('names the scale that ran, not a hardcoded x4', () => {
    const e = upscaledGalleryEntry({ ...base, scale: 2, label: s => `ESRGAN x2 · from: ${s}` })!
    expect(e.prompt).toBe('ESRGAN x2 · from: a lovely cat')
  })
})

// ── THE WIRES (asserted on source, the rifeWiring idiom) ─────────────────────

describe('the upscale vertical is wired end to end', () => {
  it('exposes an IPC verb, a preload binding and a type for it', () => {
    expect(read('electron/ipc/sd-cpp.ipc.ts')).toContain("'sd-cpp:upscale'")
    expect(read('electron/ipc/sd-cpp.ipc.ts')).toContain("'sd-cpp:download-upscaler'")
    const preload = read('electron/preload.ts')
    expect(preload).toContain("ipcRenderer.invoke('sd-cpp:upscale'")
    expect(preload).toContain("ipcRenderer.invoke('sd-cpp:download-upscaler'")
    expect(read('src/types/electron.d.ts')).toContain('upscale(')
  })

  // The catalog is how the button learns whether the 64 MB is already on disk —
  // an upscaler is in NEITHER status() list (not a checkpoint, not an adapter),
  // exactly like a speed pack.
  it('ships the upscaler list, with its install state, on the catalog payload', () => {
    expect(read('electron/ipc/sd-cpp.ipc.ts')).toContain('upscalers:')
  })

  it('renders the button from the gallery tile, and files what it produces', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('UpscaleAction')
    expect(page).toContain('upscaledGalleryEntry')
  })

  // Lane 5B's tour steps point at these anchors. The import one existed and was
  // orphaned; the local-engine one is added here.
  it('anchors both tour steps lane 5B wrote copy for', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('data-tour="media-local"')
    expect(page).toContain("selector: '[data-tour=\"media-local\"]'")
    expect(page).toContain("selector: '[data-tour=\"media-import\"]'")
    expect(page).toContain('tour.localEngine.title')
    expect(page).toContain('tour.importUrl.title')
  })
})

// ── THE FITS LINE UNDER THE DOWNLOAD ROWS ────────────────────────────────────
//
// W4-A put minVramGb / minRamGb on the sd-cpp catalog payload and W4-B renders
// them on the CATALOG card. The Media tab's own DOWNLOAD panel — the surface
// where the multi-GB button actually is — dropped both fields in its mapping
// (MediaPage's setSdModels kept id/name/size/notes/licence/files and nothing
// else), so the number reached one of the two places it was collected for.

describe('the download panel projects the fit numbers', () => {
  it('keeps minVramGb / minRamGb in the media catalog mapping', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('minVramGb: mm.minVramGb')
    expect(page).toContain('minRamGb: mm.minRamGb')
  })

  it('renders the line, in both the installed and the download branch', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('mediaFitLine(')
    // Two render sites: the question outlives the download.
    expect(page.match(/\{fitLine\}/g) ?? []).toHaveLength(2)
  })
})

describe('mediaFitLine', () => {
  const GIB = 1024 ** 3

  it('goes green when the card clears the row\'s own stated figure', () => {
    expect(mediaFitLine({ row: { minVramGb: 8 }, vramFreeBytes: 12 * GIB }))
      .toEqual({ kind: 'vram', fits: true, needGb: 8, haveGb: 12 })
  })

  it('goes amber when it does not', () => {
    expect(mediaFitLine({ row: { minVramGb: 16 }, vramFreeBytes: 12 * GIB }))
      .toEqual({ kind: 'vram', fits: false, needGb: 16, haveGb: 12 })
  })

  it('treats exactly-enough as fitting', () => {
    expect(mediaFitLine({ row: { minVramGb: 12 }, vramFreeBytes: 12 * GIB })?.fits).toBe(true)
  })

  // THE HONEST SILENCES. Each of these would otherwise become a fabricated
  // verdict — the exact failure W4-B removed from the catalog card.
  it('says nothing when the row states no figure', () => {
    expect(mediaFitLine({ row: {}, vramFreeBytes: 12 * GIB })).toBeNull()
  })

  it('says nothing when the machine is unknown — amber would be a claim too', () => {
    expect(mediaFitLine({ row: { minVramGb: 8 }, vramFreeBytes: null })).toBeNull()
    expect(mediaFitLine({ row: { minVramGb: 8 } })).toBeNull()
    expect(mediaFitLine({ row: { minVramGb: 8 }, vramFreeBytes: 0 })).toBeNull()
  })

  it('ignores a non-finite or negative figure on either side', () => {
    expect(mediaFitLine({ row: { minVramGb: NaN }, vramFreeBytes: 12 * GIB })).toBeNull()
    expect(mediaFitLine({ row: { minVramGb: -8 }, vramFreeBytes: 12 * GIB })).toBeNull()
    expect(mediaFitLine({ row: { minVramGb: Infinity }, vramFreeBytes: 12 * GIB })).toBeNull()
  })

  // minRamGb exists for the rows where SYSTEM memory is the binding constraint
  // (the LTX-AV row holds its weights in RAM, so a 24 GB card does not help it).
  it('falls to RAM only when the row names no VRAM figure', () => {
    expect(mediaFitLine({ row: { minRamGb: 32 }, ramTotalBytes: 64 * GIB }))
      .toEqual({ kind: 'ram', fits: true, needGb: 32, haveGb: 64 })
    // VRAM wins when both are declared: it is the binding one where it applies.
    expect(mediaFitLine({
      row: { minVramGb: 8, minRamGb: 32 }, vramFreeBytes: 12 * GIB, ramTotalBytes: 4 * GIB,
    })?.kind).toBe('vram')
  })

  it('rounds both sides to one decimal, so the line reads like a number', () => {
    const r = mediaFitLine({ row: { minVramGb: 11.53 }, vramFreeBytes: 12.34567 * GIB })!
    expect(r.needGb).toBe(11.5)
    expect(r.haveGb).toBe(12.3)
  })
})

// Every key the two new surfaces resolve must exist in all 8 locales, or the UI
// renders a raw dotted path.
describe('the copy exists in every locale', () => {
  const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']
  const UPSCALE_KEYS = ['action', 'title', 'install', 'installTitle', 'installing', 'running', 'saved', 'derived', 'failed']
  const FIT_KEYS = ['fitVramOk', 'fitVramTight', 'fitRamOk', 'fitRamTight']

  for (const l of LOCALES) {
    it(`${l}/media.json carries the upscale + fit keys`, () => {
      const j = JSON.parse(read(`src/i18n/locales/${l}/media.json`)) as {
        upscale?: Record<string, string>
        local?:   Record<string, string>
        tour?:    Record<string, unknown>
      }
      for (const k of UPSCALE_KEYS) expect(j.upscale?.[k], `upscale.${k}`).toBeTruthy()
      for (const k of FIT_KEYS)     expect(j.local?.[k],   `local.${k}`).toBeTruthy()
      // Lane 5B's two steps, which THIS lane's MEDIA_TOUR_KEYS now reference.
      expect(j.tour?.importUrl,   'tour.importUrl').toBeTruthy()
      expect(j.tour?.localEngine, 'tour.localEngine').toBeTruthy()
    })
  }

  // The interpolated values the code passes must be the ones the copy names.
  it('interpolates the placeholders the callers actually pass', () => {
    const en = JSON.parse(read('src/i18n/locales/en/media.json')) as {
      upscale: Record<string, string>; local: Record<string, string>
    }
    expect(en.upscale.action).toContain('{{scale}}')
    expect(en.upscale.derived).toContain('{{scale}}')
    expect(en.upscale.derived).toContain('{{source}}')
    expect(en.upscale.install).toContain('{{size}}')
    expect(en.upscale.saved).toContain('{{name}}')
    for (const k of ['fitVramOk', 'fitVramTight', 'fitRamOk', 'fitRamTight']) {
      expect(en.local[k], k).toContain('{{need}}')
      expect(en.local[k], k).toContain('{{have}}')
    }
  })
})
