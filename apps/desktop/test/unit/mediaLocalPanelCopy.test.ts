// apps/desktop/test/unit/mediaLocalPanelCopy.test.ts
//
// TWO DRIVER FINDINGS ABOUT THE LOCAL PANEL TELLING THE TRUTH.
//
// 1. THE HINT THAT WENT STALE THE DAY THE ROW SHIPPED.
//    With Wan T2V selected, the RESOLUTION hint read "…starting from an image
//    needs a Wan i2v checkpoint, which is not shipped either" — while the
//    DOWNLOAD MODEL panel two inches below offered "Wan 2.1 I2V 14B 480P".
//    Commit 0fab056 added the row; the sentence that said we had none was
//    written before it and nobody re-read it. The sentence is built in MAIN
//    (surplus-media-service's localVideoOptionsFor branch) and is English-only
//    there, like every other schema description; the composer is the surface
//    that can both localize it AND point at the row that now exists.
//
// 2. THE DOWNLOAD PANEL DOES NOT KNOW WHAT IS INSTALLED.
//    SD-Turbo, Wan and the user's civitai-142421 render as identical download
//    buttons whether or not they are already on disk — the page knows perfectly
//    well which ones are installed (it will not offer to generate with anything
//    else), it simply never told the panel. A download button for weights that
//    are already there is an invitation to re-fetch several GB for nothing.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  T2V_ONLY_SENTENCE,
  WAN_I2V_ROW_NAME,
  retargetT2vOnlyHint,
  sdDownloadRowState,
} from '../../src/pages/media/mediaHelpers'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

/** The whole hint main sends for a LOCAL t2v row, verbatim in shape. */
const T2V_HINT =
  'Local engine: this checkpoint renders 832x480. Higher tiers need a larger Wan model, which is not shipped.'
  + ' ' + T2V_ONLY_SENTENCE

describe('the i2v sentence is retargeted at the row that now exists', () => {
  it('main still emits the exact sentence this rewrites', () => {
    // The pin: if main rewords or removes it, this fails HERE rather than
    // silently leaving the stale copy on screen.
    const svc = read('electron/services/surplus-media-service.ts')
    expect(svc).toContain(T2V_ONLY_SENTENCE)
    // …and it is still appended only for a row that is NOT i2v.
    expect(svc).toMatch(/localVid\.i2v \? '' :/)
  })

  it('the shipped i2v row really is named what the new copy points at', () => {
    const rows = read('electron/services/sd-cpp-models.ts')
    expect(rows).toContain(WAN_I2V_ROW_NAME)
    expect(rows).toMatch(/id: 'wan21-i2v-14b-480p'/)
    expect(rows).toMatch(/i2v: true/)
  })

  it('THE REPRO: "not shipped either" is gone, replaced by the row name', () => {
    const replacement = `It is text→video only: starting from an image needs a Wan i2v checkpoint — ${WAN_I2V_ROW_NAME} is available in the download panel.`
    const out = retargetT2vOnlyHint(T2V_HINT, replacement)
    expect(out).not.toContain('not shipped either')
    expect(out).toContain(WAN_I2V_ROW_NAME)
    // The FIRST half of the hint — the resolution truth — is untouched.
    expect(out).toContain('this checkpoint renders 832x480')
    expect(out).toContain('Higher tiers need a larger Wan model, which is not shipped.')
  })

  it('leaves every other description byte-identical', () => {
    const steps = "Denoising steps. This checkpoint's own recipe is 20; past 40 it is out of what it was trained for."
    expect(retargetT2vOnlyHint(steps, 'x')).toBe(steps)
    // An i2v row's own hint never carried the sentence in the first place.
    const i2vHint = 'Local engine: this checkpoint renders 832x480. Higher tiers need a larger Wan model, which is not shipped.'
    expect(retargetT2vOnlyHint(i2vHint, 'x')).toBe(i2vHint)
    expect(retargetT2vOnlyHint(undefined, 'x')).toBeUndefined()
    expect(retargetT2vOnlyHint('', 'x')).toBe('')
  })

  it('is applied in ParamFields, so the canvas media node gets it too', () => {
    // ParamFields is the renderer shared by BOTH generation surfaces — fixing
    // this in MediaPage alone is the exact split that caused audit D3.
    const pf = read('src/pages/media/ParamFields.tsx')
    expect(pf).toMatch(/retargetT2vOnlyHint/)
    expect(pf).toMatch(/params\.videoI2vAvailable/)
  })

  it('ships a REAL translation in every locale, naming the row', () => {
    const en = (JSON.parse(read('src/i18n/locales/en/media.json')) as {
      params: Record<string, string>
    }).params.videoI2vAvailable
    expect(en).toBeTruthy()
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`)) as {
        params: Record<string, string>
      }
      const s = json.params.videoI2vAvailable
      expect(s, `${l}/media.json params.videoI2vAvailable`).toBeTruthy()
      expect(s, `${l} must interpolate the row name`).toContain('{{model}}')
      // A copied English value is a missing translation wearing a locale's name.
      if (l !== 'en') expect(s, `${l} is still the English string`).not.toBe(en)
    }
  })
})

describe('the download panel marks what is already on disk', () => {
  const installed = ['sd-turbo', 'civitai-142421']

  it('THE REPRO: an installed row is not offered as a download', () => {
    expect(sdDownloadRowState('sd-turbo', installed)).toBe('installed')
    expect(sdDownloadRowState('civitai-142421', installed)).toBe('installed')
  })

  it('an absent row keeps its download affordance', () => {
    expect(sdDownloadRowState('wan21-i2v-14b-480p', installed)).toBe('download')
    expect(sdDownloadRowState('z-image-turbo', [])).toBe('download')
  })

  it('accepts either shape of install-state source', () => {
    // The page holds it as a Record keyed by id (localRows, from sd-cpp:status).
    expect(sdDownloadRowState('sd-turbo', new Set(installed))).toBe('installed')
    expect(sdDownloadRowState('sd-turbo', Object.keys({ 'sd-turbo': {} }))).toBe('installed')
  })

  it('is wired to the install-state the page already has', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/sdDownloadRowState/)
    // localRows IS the installed set — sd-cpp:status keys it by installed id,
    // and it is what gates generation. No second source of truth.
    //
    // The third argument is the row's OWN on-disk bytes (rows5 driver): an
    // install that died mid-file used to render the same button as one that
    // was never started. See sdInterruptedDownload.test.ts.
    expect(page).toMatch(/sdDownloadRowState\(m\.id, \w+, [\w.]+\)/)
    expect(page).toMatch(/local\.modelInstalled/)
  })

  it('ships the badge label in every locale, naming the model', () => {
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`)) as {
        local: Record<string, string>
      }
      const s = json.local.modelInstalled
      expect(s, `${l}/media.json local.modelInstalled`).toBeTruthy()
      expect(s, `${l} must interpolate the model name`).toContain('{{name}}')
    }
  })
})
