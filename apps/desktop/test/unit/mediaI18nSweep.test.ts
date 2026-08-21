// apps/desktop/test/unit/mediaI18nSweep.test.ts
//
// W4-C — THE HARDCODED-ENGLISH SWEEP.
//
// Four surfaces rendered raw English in an 8-locale app: (1) ImportFromUrl —
// zero useTranslation; (2) the Preset dropdown (PROMPT_PRESETS labels);
// (3) the Nodes starter-template menu (starterTemplates.ts rendered hardcoded
// at NodesPage.tsx); (4) every ParamSpec label/description, resolved
// renderer-side in ParamFields via the retargetT2vOnlyHint precedent. This
// file pins the renderer-side machinery (the two mediaHelpers hooks + the
// resolver functions) and spot-checks that every locale actually ships a REAL
// translation (not an English value wearing a locale's name) for a
// representative key on each of the four surfaces — the full parity sweep
// itself lives in i18nConsistency.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  PROMPT_PRESETS, promptPresetLabelKey,
  PROMPT_PLUG_JARGON_SENTENCE, retargetPromptPlugHint,
  resolveParamLabel, resolveParamDescription,
  galleryTimestamp,
} from '../../src/pages/media/mediaHelpers'
import { STARTER_TEMPLATES } from '../../src/pages/nodes/starterTemplates'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const loadJson = (loc: string, ns: string): Record<string, unknown> =>
  JSON.parse(read(`src/i18n/locales/${loc}/${ns}.json`)) as Record<string, unknown>

const deepGet = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)

// A trivial `t`-shaped stub: returns the resource value if the (fake) bundle
// has one, else the defaultValue — exactly i18next's own missing-key
// behaviour, so these unit tests don't need react-i18next running.
function fakeT(bundle: Record<string, string>) {
  return (key: string, opts: { defaultValue: string }) => bundle[key] ?? opts.defaultValue
}

describe('ImportFromUrl — zero hardcoded English left', () => {
  const src = read('src/pages/media/ImportFromUrl.tsx')

  it('renders through useTranslation, not literal strings', () => {
    expect(src).toMatch(/useTranslation\('media'\)/)
  })

  it('THE REPRO: none of the old hardcoded UI strings remain', () => {
    // The exact literals the component used to render before the sweep (kept
    // distinct enough from the file's own header comment, which legitimately
    // says "Import from URL" / "Personal-use only" in prose).
    for (const stale of [
      '⬇ Import from URL',
      'Paste a media URL…',
      'Download into your media library',
      'Could not read that URL.',
      'Download failed.',
      'Saved to your media library — remix or edit it below.',
      'Personal use only — import content',
    ]) {
      expect(src, `ImportFromUrl.tsx still contains "${stale}"`).not.toContain(stale)
    }
  })

  it('every locale ships a real (non-English-copy) translation for the surface', () => {
    const en = loadJson('en', 'media')
    const enTitle = deepGet(en, 'import.title')
    const enDisclaimer = deepGet(en, 'import.disclaimer')
    expect(enTitle).toBeTruthy()
    expect(enDisclaimer).toBeTruthy()
    for (const loc of LOCALES) {
      const json = loadJson(loc, 'media')
      const title = deepGet(json, 'import.title')
      const disclaimer = deepGet(json, 'import.disclaimer')
      expect(title, `${loc}/media.json import.title`).toBeTruthy()
      expect(disclaimer, `${loc}/media.json import.disclaimer`).toBeTruthy()
      if (loc !== 'en') {
        expect(title, `${loc} import.title is still the English string`).not.toBe(enTitle)
        expect(disclaimer, `${loc} import.disclaimer is still the English string`).not.toBe(enDisclaimer)
      }
    }
  })
})

describe('PROMPT_PRESETS — stable ids, translated labels', () => {
  it('every preset in every modality carries a unique, non-empty id', () => {
    for (const [modality, presets] of Object.entries(PROMPT_PRESETS)) {
      const ids = (presets ?? []).map(p => p.id)
      expect(ids.every(id => id.length > 0), `${modality} has a blank preset id`).toBe(true)
      expect(new Set(ids).size, `${modality} has duplicate preset ids`).toBe(ids.length)
    }
  })

  it('promptPresetLabelKey builds the params.* namespace this sweep owns', () => {
    expect(promptPresetLabelKey('image', 'cinematicPortrait')).toBe('presets.prompt.image.cinematicPortrait')
  })

  it('MediaPage matches presets by id, not by (now-translatable) label', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/presets\.find\(x => x\.id === e\.target\.value\)/)
    expect(page).toMatch(/promptPresetLabelKey\(modality, p\.id\)/)
  })

  it('every locale ships a real translation for a sample preset in every modality', () => {
    const en = loadJson('en', 'media')
    const sample: Record<string, string> = {
      image: 'cinematicPortrait', video: 'slowDollyPush', music: 'lofiBeat', tts: 'friendlyIntro',
    }
    for (const loc of LOCALES) {
      const json = loadJson(loc, 'media')
      for (const [modality, id] of Object.entries(sample)) {
        const key = `presets.prompt.${modality}.${id}`
        const enVal = deepGet(en, key)
        const val = deepGet(json, key)
        expect(val, `${loc}/media.json ${key}`).toBeTruthy()
        if (loc !== 'en') expect(val, `${loc} ${key} is still the English string`).not.toBe(enVal)
      }
    }
  })
})

describe('Nodes starter-template menu — translated by stable template id', () => {
  const nodesPage = read('src/pages/nodes/NodesPage.tsx')

  it('the render spot resolves label/description through the outer i18n `t`, not the shadowed map param', () => {
    // The bug this guards: `STARTER_TEMPLATES.map((t, i) => ...)` shadowed the
    // component's own `t` (react-i18next), making it unreachable for every row.
    expect(nodesPage).toMatch(/STARTER_TEMPLATES\.map\(\(tpl, i\) => /)
    expect(nodesPage).toMatch(/t\(`templates\.\$\{tpl\.id\}\.label`, \{ defaultValue: tpl\.label \}\)/)
    expect(nodesPage).toMatch(/t\(`templates\.\$\{tpl\.id\}\.description`, \{ defaultValue: tpl\.description \}\)/)
  })

  it('the confirm/toast copy quotes the TRANSLATED label too, not the raw English one', () => {
    expect(nodesPage).toMatch(/const label = templateLabel\(tpl\)/)
    expect(nodesPage).toMatch(/confirm\.replaceTemplate', \{ label \}/)
    expect(nodesPage).toMatch(/toast\.templateLoaded', \{ label \}/)
  })

  it('every starter template id used by the menu has a resource entry, in every locale, translated', () => {
    expect(STARTER_TEMPLATES.length).toBeGreaterThan(0)
    const en = loadJson('en', 'nodes')
    for (const tpl of STARTER_TEMPLATES) {
      const enLabel = deepGet(en, `templates.${tpl.id}.label`)
      const enDesc = deepGet(en, `templates.${tpl.id}.description`)
      expect(enLabel, `en/nodes.json templates.${tpl.id}.label`).toBeTruthy()
      expect(enDesc, `en/nodes.json templates.${tpl.id}.description`).toBeTruthy()
      for (const loc of LOCALES) {
        if (loc === 'en') continue
        const json = loadJson(loc, 'nodes')
        const label = deepGet(json, `templates.${tpl.id}.label`)
        const description = deepGet(json, `templates.${tpl.id}.description`)
        expect(label, `${loc}/nodes.json templates.${tpl.id}.label`).toBeTruthy()
        expect(description, `${loc}/nodes.json templates.${tpl.id}.description`).toBeTruthy()
        // The DESCRIPTION is always a full sentence — guaranteed to differ
        // across languages, so it's the reliable "not a lazy English copy"
        // signal. The LABEL is sometimes legitimately identical (e.g.
        // "Prompt → Image" in French — both words are loanwords there), so it
        // isn't asserted for inequality here.
        expect(description, `${loc} templates.${tpl.id}.description is still the English string`).not.toBe(enDesc)
      }
    }
  })
})

describe('ParamFields — the jargon hook + the general label/description resolver', () => {
  it('main still emits the exact jargon sentence this rewrites', () => {
    // The pin: if main rewords or removes it, this fails HERE, mirroring the
    // T2V sentence's own pin in mediaLocalPanelCopy.test.ts.
    const svc = read('electron/services/surplus-media-service.ts')
    expect(svc).toContain(PROMPT_PLUG_JARGON_SENTENCE)
  })

  it('retargetPromptPlugHint swaps the jargon and nothing else', () => {
    const desc = `What to generate. ${PROMPT_PLUG_JARGON_SENTENCE}`
    const out = retargetPromptPlugHint(desc, 'It can be filled in automatically.')
    expect(out).toBe('What to generate. It can be filled in automatically.')
    expect(retargetPromptPlugHint(undefined, 'x')).toBeUndefined()
    expect(retargetPromptPlugHint('unrelated text', 'x')).toBe('unrelated text')
  })

  it('is wired into ParamFields, ahead of the generic per-name resolver', () => {
    const pf = read('src/pages/media/ParamFields.tsx')
    expect(pf).toMatch(/retargetPromptPlugHint/)
    expect(pf).toMatch(/resolveParamLabel/)
    expect(pf).toMatch(/resolveParamDescription/)
    expect(pf).toMatch(/params\.promptAutoFill/)
  })

  it('resolveParamLabel translates by name, with the current text as fallback', () => {
    const t = fakeT({ 'params.cfg.label': 'ГАЙДАНС' })
    expect(resolveParamLabel('cfg', 'Guidance (CFG)', t)).toBe('ГАЙДАНС')
    // No resource entry for this name → falls back to whatever main sent.
    expect(resolveParamLabel('some_future_param', 'Some Label', t)).toBe('Some Label')
  })

  it('resolveParamLabel matches image_url by CONTENT, since main sets one of two literal strings', () => {
    const t = fakeT({
      'params.image_url.labelImg2img': 'РЕФЕРЕНС',
      'params.image_url.labelI2v': 'СТАРТ-КАДР',
    })
    expect(resolveParamLabel('image_url', 'Reference image (img2img)', t)).toBe('РЕФЕРЕНС')
    expect(resolveParamLabel('image_url', 'Init frame (image→video)', t)).toBe('СТАРТ-КАДР')
    // An unrecognized image_url label (schema changed upstream) falls back to
    // the base key rather than silently mis-translating.
    expect(resolveParamLabel('image_url', 'Some new label', fakeT({}))).toBe('Some new label')
  })

  it('resolveParamDescription falls through untouched when no resource key exists (the normal case for row-specific names)', () => {
    const dynamic = "Denoising steps. This checkpoint's own recipe is 20; past 40 it is out of what it was trained for."
    expect(resolveParamDescription('steps', dynamic, fakeT({}))).toBe(dynamic)
  })

  it('THE DISCIPLINE THIS RELIES ON: no locale defines params.<name>.description for a row-specific name', () => {
    // resolveParamDescription itself cannot tell "steps" apart from "cfg" — the
    // only thing standing between a local row's real, numbered step recipe and
    // a static mistranslation is that NO locale JSON defines a `description`
    // resource under these names. This is what actually enforces that,
    // independent of the mock-`t` tests above (which prove the mechanism, not
    // the authoring discipline).
    //
    // `negative_prompt` and `n` are NOT in this list (checkpoint-B): each now
    // has its own content-matched generic key (see the tests below), and the
    // exact-string gate in resolveParamDescription — not an absent resource —
    // is what keeps every row-dependent composition (Wan's own negative, the
    // cfg-1 inertness note, the speed-off addendum) falling through untouched.
    const ROW_SPECIFIC_NAMES = ['steps', 'resolution', 'duration', 'size', 'hires', 'hires_scale', 'speed_mode']
    for (const loc of LOCALES) {
      const json = loadJson(loc, 'media')
      for (const name of ROW_SPECIFIC_NAMES) {
        expect(deepGet(json, `params.${name}.description`), `${loc}/media.json params.${name}.description must stay unset`).toBeUndefined()
      }
    }
  })

  it('negative_prompt/n: the row-dependent compositions still fall through untouched even though the name now HAS a resource key', () => {
    // The mechanism the discipline test above relies on for these two names:
    // content match, not name match. Defining params.negative_prompt.description
    // in every locale (below) must not leak into a local row's own composed
    // sentence, which never equals the generic string byte-for-byte.
    const t = fakeT({
      'params.negative_prompt.description': 'ЧТО ИЗБЕГАТЬ',
      'params.n.description': 'СКОЛЬКО ИЗОБРАЖЕНИЙ',
    })
    const wanComposed = 'What to avoid (artifacts, watermarks, extra limbs, …). This checkpoint ships its OWN official negative prompt and was tuned against it, so the field starts pre-filled — edit or clear it freely; whatever is in this box is what runs.'
    expect(resolveParamDescription('negative_prompt', wanComposed, t)).toBe(wanComposed)
    const cloudVariations = 'How many variations to generate.'
    expect(resolveParamDescription('n', cloudVariations, t)).toBe(cloudVariations)
  })

  it('negative_prompt/n: the one row-independent variant DOES translate, by exact content match', () => {
    const t = fakeT({
      'params.negative_prompt.description': 'ЧТО ИЗБЕГАТЬ',
      'params.n.description': 'СКОЛЬКО ИЗОБРАЖЕНИЙ',
    })
    expect(resolveParamDescription('negative_prompt', 'What to avoid (artifacts, watermarks, extra limbs, …).', t))
      .toBe('ЧТО ИЗБЕГАТЬ')
    const batchNote = 'How many images to generate in one run. The checkpoint loads once, but each image is sampled in full — 4 images take about 4x as long as 1. Each gets its own seed, counting up from the first.'
    expect(resolveParamDescription('n', batchNote, t)).toBe('СКОЛЬКО ИЗОБРАЖЕНИЙ')
  })

  it('resolveParamDescription DOES translate the names confirmed safe (never row-specific)', () => {
    const t = fakeT({ 'params.cfg.description': 'НАСКОЛЬКО СТРОГО' })
    expect(resolveParamDescription('cfg', 'How strictly to follow the prompt.', t)).toBe('НАСКОЛЬКО СТРОГО')
  })

  it('resolveParamDescription matches image_url by content, same as the label', () => {
    const t = fakeT({
      'params.image_url.description': 'REF-RU',
      'params.image_url.descriptionI2v': 'I2V-RU',
    })
    expect(resolveParamDescription('image_url', 'Optional starting image for img2img.', t)).toBe('REF-RU')
    expect(resolveParamDescription('image_url', 'Optional first frame (image→video).', t)).toBe('I2V-RU')
  })

  it('passes undefined straight through (no description to translate)', () => {
    expect(resolveParamDescription('sampler', undefined, fakeT({}))).toBeUndefined()
  })
})

describe('every safe param label/description ships a real translation in every locale', () => {
  const SAFE_LABELS = [
    'prompt', 'negative_prompt', 'aspect_ratio', 'size', 'n', 'seed', 'steps', 'cfg', 'sampler',
    'strength', 'duration', 'resolution', 'lyrics', 'instrumental', 'genre', 'input', 'response_format',
    'file', 'language', 'translate', 'hires', 'hires_scale', 'speed_mode',
    // checkpoint-B: the low-VRAM ladder + clip-skip controls (W4-A) had no i18n keys at all.
    'clip_skip', 'vae_tiling', 'vae_conv_direct', 'max_vram', 'stream_layers', 'auto_fit',
  ]
  const SAFE_DESCRIPTIONS = [
    'cfg', 'strength', 'seed', 'lyrics', 'input', 'file', 'language',
    'clip_skip', 'vae_tiling', 'vae_conv_direct', 'max_vram', 'stream_layers', 'auto_fit',
    // negative_prompt/n: only their one row-independent variant is safe — see the
    // content-match tests above and resolveParamDescription's own guard.
    'negative_prompt', 'n',
  ]

  it('en ships every key this sweep claims to translate', () => {
    const en = loadJson('en', 'media')
    for (const name of SAFE_LABELS) expect(deepGet(en, `params.${name}.label`), `params.${name}.label`).toBeTruthy()
    for (const name of SAFE_DESCRIPTIONS) expect(deepGet(en, `params.${name}.description`), `params.${name}.description`).toBeTruthy()
    expect(deepGet(en, 'params.image_url.labelImg2img')).toBeTruthy()
    expect(deepGet(en, 'params.image_url.labelI2v')).toBeTruthy()
    expect(deepGet(en, 'params.promptAutoFill')).toBeTruthy()
  })

  it('every other locale translates every safe label (not a copy of English)', () => {
    const en = loadJson('en', 'media')
    for (const loc of LOCALES) {
      if (loc === 'en') continue
      const json = loadJson(loc, 'media')
      for (const name of SAFE_LABELS) {
        const key = `params.${name}.label`
        const enVal = deepGet(en, key)
        const val = deepGet(json, key)
        expect(val, `${loc}/media.json ${key}`).toBeTruthy()
        // "Latin ecosystem jargon stays Latin" — a handful of labels (Prompt,
        // Sampler, Genre, Instrumental…) are legitimately identical across
        // locales, so this suite doesn't assert inequality here; the parity
        // suite (i18nConsistency.test.ts) already guarantees every locale has
        // its OWN authored value for the key, not a missing one.
      }
    }
  })

  it('every other locale translates every safe description (not a copy of English)', () => {
    const en = loadJson('en', 'media')
    for (const loc of LOCALES) {
      if (loc === 'en') continue
      const json = loadJson(loc, 'media')
      for (const name of SAFE_DESCRIPTIONS) {
        const key = `params.${name}.description`
        const enVal = deepGet(en, key)
        const val = deepGet(json, key)
        expect(val, `${loc}/media.json ${key}`).toBeTruthy()
        expect(val, `${loc} ${key} is still the English string`).not.toBe(enVal)
      }
    }
  })
})

describe('galleryTimestamp — the newest-entry pill follows the UI locale, not the OS one', () => {
  // Checkpoint-B driver finding: the gallery's "newest" time and its hover
  // title called `toLocaleTimeString()` / `toLocaleString()` with NO locale
  // argument, so Intl fell back to the RUNTIME default (the OS locale) —
  // switching the app to RU left the pill reading en-US 12-hour time. The
  // fix threads `i18n.language` through, the same precedent as
  // civitaiAdultPolicy's `formatCivitaiAcceptedAt(value, i18n.language)`.
  const SAMPLE = Date.UTC(2026, 0, 15, 13, 30, 0) // 2026-01-15T13:30:00Z

  it('is honest about garbage input: no key, no crash', () => {
    expect(galleryTimestamp(NaN)).toEqual({ time: '', full: '' })
    expect(galleryTimestamp(Number.POSITIVE_INFINITY)).toEqual({ time: '', full: '' })
  })

  it('threads the locale into BOTH the pill and the hover title', () => {
    const enUS = galleryTimestamp(SAMPLE, 'en-US')
    const ruRU = galleryTimestamp(SAMPLE, 'ru-RU')
    // Different calendars/scripts read differently — this is the whole bug:
    // before the fix, ruRU here would have been byte-identical to enUS because
    // neither call site passed a locale at all.
    expect(ruRU.time).not.toBe(enUS.time)
    expect(ruRU.full).not.toBe(enUS.full)
  })

  it('falls back to the platform default rather than throwing on a bad tag', () => {
    // Not every environment throws on an unrecognized BCP-47 tag, but none may
    // ever throw OUT of this function — a bad/legacy `i18n.language` value must
    // not crash the gallery toolbar.
    expect(() => galleryTimestamp(SAMPLE, 'not-a-real-locale-tag-at-all')).not.toThrow()
  })

  it('is wired into MediaPage with i18n.language, not a bare Date call', () => {
    const src = readFileSync(
      resolve(__dirname, '..', '..', 'src/pages/media/MediaPage.tsx'), 'utf8',
    )
    expect(src).toMatch(/galleryTimestamp\(gallery\[0\]\.createdAt, i18n\.language\)/)
    // The repro: the old call sites, gone.
    expect(src).not.toMatch(/gallery\[0\]\.createdAt\)\.toLocaleTimeString\(\)/)
    expect(src).not.toMatch(/gallery\[0\]\.createdAt\)\.toLocaleString\(\)/)
  })
})
