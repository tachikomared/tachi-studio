// apps/desktop/test/unit/mediaLocalModelTruth.test.ts
//
// THE COMPOSER STOPS GUESSING WHAT THE MODEL IS.
//
// Two lies on the LOCAL provider, both of the family the Wan fixes came from
// (2bd48fc / 9db0dbd — the schema promised what the engine could not do):
//
//   1. THE DROPDOWN SHOWED RAW IDS. loadModels mapped sd-cpp:status to
//      `{ id: x.id, label: x.id }`, so the picker read 'sd-turbo' and
//      'wan21-t2v-1.3b'. Tolerable while the only models were three curated
//      ones whose ids read like names — and unusable the moment a user installs
//      'civitai-812345'.
//
//   2. THE FAMILY WAS GUESSED FROM THE ID STRING:
//         if (id.startsWith('flux')) 'flux'
//         if (id.includes('xl'))     'sdxl'
//         else                       'sd15'
//      which survives only because the curated ids spell their family out. A
//      Civitai row is 'civitai-812345' — no substring at all — so an SDXL
//      checkpoint would have been handed the SD 1.5 preset tier AND the SD 1.5
//      pixel grid, and any id containing "xl" would have claimed SDXL.
//
// The authority in both cases is the ROW, which now travels with the status
// payload (name + declared family) and through allSdModels() for the schema.
//
// Source-assertion style, like the rest of the mediaLocalSdSize family: these
// are wiring facts in a React page and an electron-coupled service, and the
// point is that the WIRE is right, not that a mock returns what it was told.

import { describe, it, expect, vi, afterAll } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

// The size-grid assertions read the SCHEMA the composer renders (behaviour, not
// source text — the table gained an orientation axis and a verbatim pin on its
// spelling would fail on every future tier), and modelParamSchema lives in an
// electron-coupled service. Same hoisted-temp mock the rest of this family uses.
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-localtruth-'))
})
afterAll(() => {
  try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
})
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { SD_IMAGE_MODELS } from '../../electron/services/sd-cpp-models'
import { modelParamSchema } from '../../electron/services/surplus-media-service'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')

/** Source WITHOUT comments — this file's `not.toContain`s name DEAD IDIOMS, and
 *  the comments that record their removal quote them verbatim. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n')
}
const page = () => read('src/pages/media/MediaPage.tsx')

describe('the local model dropdown shows NAMES', () => {
  it('loadModels labels each local model with the row name, not its id', () => {
    const src = page()
    const branch = src.slice(src.indexOf("} else if (mediaProvider === 'local') {"), src.indexOf("} else if (mediaProvider === 'venice') {"))
    expect(branch).toContain('label: x.name || x.id')
    // the idiom that rendered 'civitai-812345' in the picker
    expect(branch).not.toContain('label: x.id }')
  })

  it('the media NODE on the canvas gets the same names (one surface fixed is not the fix)', () => {
    const src = read('src/pages/nodes/useMediaModels.ts')
    const local = src.slice(src.indexOf('window.tachi.sdCpp.status().then'), src.indexOf("provider === 'venice'"))
    expect(local).toContain('ms.map(m => ({ id: m.id, label: m.name }))')
    expect(local).not.toContain('ms.map(m => ({ id: m.id }))')
  })

  it('the name comes from MAIN, so a user model is named by the same wire as a curated one', () => {
    const installer = read('electron/services/sd-cpp-installer.ts')
    const fn = installer.slice(installer.indexOf('export function listInstalledSdModels'), installer.indexOf('export function removeSdModel'))
    expect(fn).toContain('name: m.name')
    expect(fn).toContain('family: m.family')
    // …and allSdModels is the merged (curated ∪ user) source it maps over
    expect(fn).toContain('allSdModels()')

    // The row's OWN recipe travels with it too (audit D2/D5): the composer
    // needs steps/cfg/sampler to narrow its sliders and to decide whether this
    // checkpoint can honestly offer preset tiers at all.
    expect(fn).toContain('steps:          row?.steps')
    expect(fn).toContain('cfgScale:       row?.cfgScale')
    expect(fn).toContain('samplingMethod: row?.samplingMethod')

    const client = read('electron/services/sd-cpp-client.ts')
    expect(client).toContain('models:    listInstalledSdModels()')

    const dts = read('src/types/electron.d.ts')
    expect(dts).toContain("models: { id: string; name: string; kind: 'image' | 'video'; family: string; steps: number; cfgScale: number; samplingMethod: string }[]")
  })
})

describe('the family is READ off the row — there is no guess left to make', () => {
  it('NEITHER surface derives a family from the model id any more', () => {
    // The `modelFamily` memo (id substring → sd15/sdxl/flux) is GONE from both
    // surfaces rather than fixed: the question it answered was the wrong one.
    // What the picker needs is "what can THIS ROW run", and presetsForRow reads
    // `family` off the row itself — so a guess has nowhere left to live.
    for (const rel of ['src/pages/media/MediaPage.tsx', 'src/pages/nodes/canvas/nodeTypes/MediaNode.tsx']) {
      const src = stripComments(read(rel))
      expect(src, rel).not.toContain('const modelFamily = useMemo')
      expect(src, rel).not.toContain("startsWith('flux')")
      expect(src, rel).not.toContain("includes('sdxl')")
    }
  })

  it('both surfaces resolve the ROW from sd-cpp:status and hand IT to presetsForRow', () => {
    const p = page()
    expect(p).toContain('const activeLocalRow = localRows[model]')
    expect(p).toContain('activeLocalRow ? presetsForRow(activeLocalRow) : []')
    const node = read('src/pages/nodes/canvas/nodeTypes/MediaNode.tsx')
    expect(node).toContain("const activeLocalRow = localRows[data.model ?? '']")
    expect(node).toContain('activeLocalRow ? presetsForRow(activeLocalRow) : []')
    // …and the canvas gets the row through the SAME hook the panel uses.
    expect(node).toContain('const { models, error: catalogErr, localRows } = useMediaModels(provider, modality)')
  })

  it('the map is filled from sd-cpp:status in BOTH places that call it', () => {
    const src = page()
    const fills = src.split('setLocalRows(Object.fromEntries(s.models.map(x => [x.id, {').length - 1
    expect(fills).toBe(2)   // loadModels + the local-engine refresh effect
    // …and so is the adapter list, or the LoRA picker would be empty on one of
    // the two paths into the composer.
    expect(src.split('setLocalAdapters(s.adapters ?? [])').length - 1).toBe(2)
  })

  it('the shared hook carries the row, and clears it when the provider is not local', () => {
    const hook = read('src/pages/nodes/useMediaModels.ts')
    expect(hook).toContain('localRows: Record<string, LocalSdRowInfo>')
    expect(hook).toContain("if (provider !== 'local') setLocalRows({})")
    expect(hook).toContain('return { models, error, localRows }')
  })

  it('THE TRAP the guess would have sprung, spelled out', () => {
    // A pure re-implementation of the OLD rule, run over the ids this lane
    // creates: it is wrong for every one of them.
    const guess = (id: string) => {
      const s = id.toLowerCase()
      if (s.startsWith('flux')) return 'flux'
      if (s.includes('xl') || s.includes('sdxl')) return 'sdxl'
      return 'sd15'
    }
    expect(guess('civitai-812345')).toBe('sd15')          // an SDXL checkpoint → sd15 presets
    expect(guess('civitai-1234-xl-merge')).toBe('sdxl')   // …and an SD 1.5 one → SDXL presets
    // The curated ids of the day are why nobody noticed: the guess agreed on
    // all of them, because each one spells its family out.
    for (const id of ['sd-turbo', 'sd15', 'sdxl-base-1.0', 'flux-schnell-q4']) {
      expect(guess(id), id).toBe(SD_IMAGE_MODELS.find(m => m.id === id)!.family)
    }
    // …and it stops agreeing the moment a row arrives whose family is not in its
    // own id: Z-Image is an S3-DiT, and the guess would hand it the SD 1.5
    // ladder AND the 512 grid AND every Flux/SD LoRA as "compatible".
    const z = SD_IMAGE_MODELS.find(m => m.id === 'z-image-turbo')!
    expect(z.family).toBe('zimage')
    expect(guess(z.id)).not.toBe(z.family)
  })
})

describe('the local IMAGE size grid comes from the declared family too', () => {
  const svc = () => read('electron/services/surplus-media-service.ts')

  it('localImageOptionsFor keys off the MERGED registry, not an id substring', () => {
    const src = svc()
    // The LOAD-BEARING half of this line, not its exact spelling: what matters
    // is that the service reads the MERGED registry helpers from
    // sd-cpp-models. Pinning the full import verbatim made every unrelated
    // addition to that list a failure in a suite about the size grid.
    const imp = src.split('\n').find(l => l.startsWith('import {') && l.includes("from './sd-cpp-models'")) ?? ''
    for (const name of ['SD_VIDEO_MODELS', 'allSdModels', 'findSdRow', 'isDistilledRow', 'SD_SAMPLING_METHODS', 'DEFAULT_VIDEO_FPS', 'DEFAULT_VIDEO_PIXEL_GRID']) {
      expect(imp).toContain(name)
    }
    const fn = src.slice(src.indexOf('function localImageOptionsFor'), src.indexOf('/** Per-family aspect-ratio sets'))
    expect(fn).toContain("allSdModels().find(m => m.id === modelId && m.kind === 'image')")
    expect(fn).toContain('if (!row) return null')            // cloud ids fall through
    expect(fn).toContain('LOCAL_IMAGE_TIERS[row.family')
  })

  it('SDXL gets its 1024 grid and SD 1.5 does not (the whole point of the row)', () => {
    // Behaviour, not source text: the table grew an orientation axis (landscape /
    // portrait per tier), and a verbatim pin on its spelling would have made
    // every future tier a failure in a suite about which grid a family gets.
    const sizeOf = (id: string) => modelParamSchema('image', id).find(s => s.name === 'size')!
    expect(sizeOf('sdxl-base-1.0').default).toBe('1024x1024')
    expect(sizeOf('sdxl-base-1.0').enum).toContain('1536x1536')
    expect(sizeOf('sd15').default).toBe('512x512')
    // sd15 must NOT be offered 1024: that is where SD 1.5 duplicates subjects,
    // and it is exactly what the curated-fallback list defaulted a local model to.
    // No option of ITS ladder may exceed 768 on either axis, whatever the shape.
    for (const s of sizeOf('sd15').enum!) {
      const [w, h] = s.split('x').map(Number)
      expect(Math.max(w, h), s).toBeLessThanOrEqual(768)
    }
    // …and flux is the one family that goes to 2K.
    expect(sizeOf('flux-schnell-q4').enum).toContain('2048x2048')
    expect(sizeOf('sdxl-base-1.0').enum).not.toContain('2048x2048')
  })

  it('it is APPLIED ahead of the substring table, for image only', () => {
    const src = svc()
    expect(src).toContain('const localImg  = modality === \'image\' ? localImageOptionsFor(modelId) : null')
    expect(src).toContain('const sizeOpts  = modality === \'image\' ? (localImg ?? imageSizeOptionsFor(modelId)) : null')
    // and the existing per-family cloud table is untouched
    expect(src).toContain("{ test: /sdxl|hunyuan|\\bpony\\b|qwen|chroma|z-image|zimage|sd-?3\\.?5|sd35/, sizes: ['512x512', '768x768', '1024x1024', '1536x1536'] },")
  })

  it('every local image row DEFAULTS to its own baseSize (or one of them lies)', () => {
    // Widened from SDXL-only when the table gained an orientation axis: the
    // default is the row's NATIVE square, and the spec's own description quotes
    // that same number, so a row whose column disagreed would say one size and
    // render another.
    for (const row of SD_IMAGE_MODELS) {
      const size = modelParamSchema('image', row.id).find(s => s.name === 'size')
      if (!size) continue                                  // a family with no pixel control
      expect(size.default, row.id).toBe(`${row.baseSize}x${row.baseSize}`)
      expect(size.enum, row.id).toContain(`${row.baseSize}x${row.baseSize}`)
    }
  })
})

describe('the generation path is unchanged by any of this', () => {
  it('the local image call still sends the RESOLVED size (the 73d461c contract)', () => {
    const src = page()
    const call = src.slice(src.indexOf('window.tachi.sdCpp.generate({'), src.indexOf("'Local generation failed'"))
    expect(call).toContain('...resolveLocalSdSize(runParams)')
    expect(call).toContain('modelId: model')
  })

  it('the preset picker applies the tier the ROW offered, under the SCHEMA\'s names', () => {
    const src = page()
    const apply = src.slice(src.indexOf('const applyPerfPreset'), src.indexOf('// ── Load the catalog'))
    // The tier now comes from presetsForRow (which is EMPTY for a distilled
    // checkpoint), not from a family column the row may not describe.
    expect(apply).toContain('offeredPresets.find(p => p.id === presetId)?.params')
    // …and it writes `cfg`/`sampler` — the names the schema declares and the
    // resolvers read. `cfgScale`/`samplingMethod` were write-only keys.
    expect(apply).toContain('sampler: tier.samplingMethod')
    expect(apply).toContain('cfg:     tier.cfgScale')
    expect(apply).not.toContain('samplingMethod: tier.samplingMethod')
  })
})
