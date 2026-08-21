// apps/desktop/test/unit/civitaiCatalogFilters.test.ts
//
// PHASE 2/3 LANE P2C — the Catalog `civitai` tab's FILTER SURFACE and the
// per-card truths that came with it.
//
// civitaiCatalogTab.test.ts owns phase 1 (row → card, licence, affordance,
// paging, the settings key card). This file owns what phase 2/3 added on top:
//
//   1. THE TYPE TABLE — all 22 live Civitai types offered, grouped, each with
//      an outlook that AGREES WITH MAIN'S OWN VERDICT TABLE. The agreement is
//      asserted by reading electron/services/civitai-search.ts, so the two
//      halves cannot drift apart silently.
//   2. sort / period / base-model selection + the Clear predicate.
//   3. THE 18+ PREVIEW BLUR — mode-outer, bitmask-inner, fail-toward-blur.
//   4. The mode notice (including the 'switch lit, grid safe' contradiction).
//   5. SOURCE SWEEP over CatalogPage/ModelCard: the chips are built FROM the
//      tables (not a hand-copied list), the blocked row still draws no button
//      for any of the 19 new types, and the blur is gated on the mode the page
//      was SERVED in rather than the local setting.
//   6. i18n — every label these chips render, DERIVED FROM THE TABLES, present
//      and non-empty in all 8 locales. A hand-written key list is what let 19
//      raw key strings ship on screen in the first place.
//
// Node environment, like the rest of the suite: no DOM, so the JSX half is
// pinned by reading the files.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  CIVITAI_BASE_MODEL_FILTERS,
  CIVITAI_DEFAULT_PERIOD,
  CIVITAI_DEFAULT_SORT,
  CIVITAI_PERIOD_OPTIONS,
  CIVITAI_SORT_OPTIONS,
  CIVITAI_TYPE_FILTERS,
  CIVITAI_TYPE_GROUPS,
  NSFW_ABOVE_PG13,
  civitaiAffordance,
  civitaiFiltersActive,
  civitaiModeNotice,
  civitaiNameParts,
  civitaiPeriodValue,
  civitaiPreviewBlurred,
  civitaiShowsFitVerdict,
  civitaiSortValue,
  civitaiTypeFilterIdForType,
  civitaiTypeFiltersIn,
  civitaiTypeOutlook,
  civitaiTypesFor,
  isCivitaiTypeFilterId,
  toggleCivitaiBaseModel,
  type CivitaiTypeFilterId,
} from '../../src/pages/catalog/civitaiRow'
import type { CivitaiSearchRow } from '../../src/types/electron'

const APP = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')

const PAGE = 'src/pages/catalog/CatalogPage.tsx'
const CARD = 'src/pages/catalog/ModelCard.tsx'
const STORE = 'src/pages/catalog/catalog.store.ts'
const MAIN = 'electron/services/civitai-search.ts'

const LOCALES = path.join(APP, 'src/i18n/locales')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

/**
 * The text between two anchors, asserted NON-VACUOUS.
 *
 * Same helper (and same reason) as civitaiCatalogTab.test.ts: the store
 * DECLARES every action in `interface CatalogStore` before implementing it, so
 * a naive indexOf pair runs end-before-start and returns `''` — an empty
 * haystack that passes every `not.toContain` there is. `to` is searched from
 * `from`, and a suspiciously short slice fails loudly.
 */
function between(src: string, from: string, to: string): string {
  const start = src.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1)
  const end = src.indexOf(to, start + from.length)
  expect(end, `anchor not found after ${from}: ${to}`).toBeGreaterThan(start)
  const body = src.slice(start, end)
  expect(body.length, `slice ${from} → ${to} is too short to be the real block`).toBeGreaterThan(100)
  return body
}

/** Whole-line `//` comments removed so prose cannot satisfy an assertion. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n')
}

/** The string members of a `export const NAME = [...] as const` in main. */
function constArray(src: string, name: string): string[] {
  const m = src.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))
  expect(m, `main has no ${name}`).not.toBeNull()
  const body = m![1]
  const out = [...body.matchAll(/'([^']+)'/g)].map(x => x[1])
  expect(out.length, `${name} parsed empty`).toBeGreaterThan(0)
  return out
}

const MAIN_SRC = read(MAIN)
const MAIN_TYPES = constArray(MAIN_SRC, 'CIVITAI_MODEL_TYPES')
const MAIN_ADAPTERS = constArray(MAIN_SRC, 'CIVITAI_ADAPTER_TYPES')
const MAIN_SORTS = constArray(MAIN_SRC, 'CIVITAI_SORTS')
const MAIN_PERIODS = constArray(MAIN_SRC, 'CIVITAI_PERIODS')

/** The types main refuses with a STATIC "…comes in phase 4" style reason. */
function mainTypeReasonKeys(): string[] {
  const start = MAIN_SRC.indexOf('const TYPE_REASON')
  expect(start, 'main has no TYPE_REASON table').toBeGreaterThan(-1)
  const end = MAIN_SRC.indexOf('\n}', start)
  const body = MAIN_SRC.slice(start, end)
  return [...body.matchAll(/^\s{2}(\w+):\s*\{/gm)].map(m => m[1])
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. the type table — every live type, grouped, with an outlook
// ═══════════════════════════════════════════════════════════════════════════

describe('CIVITAI_TYPE_FILTERS — the whole vocabulary, not just the four we run', () => {
  const named = CIVITAI_TYPE_FILTERS.filter(f => f.id !== 'all')

  it('offers EVERY type main will forward — hiding the rest is the flattering lie', () => {
    // A user who cannot see DoRA concludes we cannot see it either, then goes
    // and installs it by hand somewhere that says nothing about magnitude
    // vectors. Offer it; refuse it per row, with a reason.
    const offered = new Set(named.flatMap(f => [...(f.types ?? [])]))
    expect([...offered].sort()).toEqual([...MAIN_TYPES].sort())
  })

  it('never offers LyCORIS as a chip — `types=LyCORIS` 400s upstream', () => {
    const ids = CIVITAI_TYPE_FILTERS.map(f => f.id)
    expect(ids).not.toContain('lycoris')
    expect(named.flatMap(f => [...(f.types ?? [])])).not.toContain('LyCORIS')
  })

  it('has unique ids and exactly one unfiltered chip', () => {
    const ids = CIVITAI_TYPE_FILTERS.map(f => f.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(CIVITAI_TYPE_FILTERS.filter(f => f.types === undefined).map(f => f.id)).toEqual(['all'])
  })

  it('gives every named filter BOTH a group and an outlook, and `all` neither', () => {
    for (const f of named) {
      expect(f.group, `${f.id} has no group`).toBeTruthy()
      expect(f.outlook, `${f.id} has no outlook`).toBeTruthy()
    }
    const all = CIVITAI_TYPE_FILTERS.find(f => f.id === 'all')!
    // `all` is every outlook at once, which describes nothing — so it claims none.
    expect(all.group).toBeUndefined()
    expect(all.outlook).toBeUndefined()
  })

  it('partitions the named filters across the three groups — none lost, none twice', () => {
    const grouped = CIVITAI_TYPE_GROUPS.flatMap(g => civitaiTypeFiltersIn(g).map(f => f.id))
    expect(grouped.sort()).toEqual(named.map(f => f.id).sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })

  it('keeps the declaration order inside a group (the chip row is not shuffled)', () => {
    const models = civitaiTypeFiltersIn('models').map(f => f.id)
    expect(models[0]).toBe('checkpoint') // the one people come here for, first
    expect(models).toEqual(
      CIVITAI_TYPE_FILTERS.filter(f => f.group === 'models').map(f => f.id),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE DRIFT TEST — the chip outlook must agree with main's verdict table
// ═══════════════════════════════════════════════════════════════════════════

describe('outlook ⇄ main’s run-truth verdicts', () => {
  const outlookOf = (type: string) => {
    const f = CIVITAI_TYPE_FILTERS.find(x => (x.types ?? []).includes(type))
    return f?.outlook ?? null
  }

  it('`runs` is exactly Checkpoint — the only type that installs and generates alone', () => {
    const runs = CIVITAI_TYPE_FILTERS.filter(f => f.outlook === 'runs').flatMap(f => [...(f.types ?? [])])
    expect(runs).toEqual(['Checkpoint'])
  })

  it('`needs-base` is exactly main’s adapter set (minus the retired LyCORIS)', () => {
    const needsBase = CIVITAI_TYPE_FILTERS.filter(f => f.outlook === 'needs-base')
      .flatMap(f => [...(f.types ?? [])]).sort()
    const expected = MAIN_ADAPTERS.filter(t => t !== 'LyCORIS').sort()
    expect(needsBase).toEqual(expected)
    // …and every one of them really is an adapter upstream.
    for (const t of needsBase) expect(MAIN_ADAPTERS).toContain(t)
  })

  it('`later` is exactly the phase-4 refusals — never DoRA, which is a NEVER', () => {
    const later = CIVITAI_TYPE_FILTERS.filter(f => f.outlook === 'later')
      .flatMap(f => [...(f.types ?? [])]).sort()
    // main's static-reason table is {DoRA, Controlnet, Upscaler, MotionModule};
    // DoRA is the one that is not a "yet".
    const phase4 = mainTypeReasonKeys().filter(k => k !== 'DoRA').sort()
    expect(later).toEqual(phase4)
    expect(later).not.toContain('DoRA')
    expect(outlookOf('DoRA')).toBe('no')
  })

  it('everything main has no path for at all reads `no`', () => {
    const accountedFor = new Set([
      'Checkpoint',
      ...MAIN_ADAPTERS.filter(t => t !== 'LyCORIS'),
      ...mainTypeReasonKeys().filter(k => k !== 'DoRA'),
    ])
    for (const type of MAIN_TYPES) {
      if (accountedFor.has(type)) continue
      expect(outlookOf(type), `${type} should read as never-installable`).toBe('no')
    }
  })

  it('MUTATION: promoting DoRA to `later` would promise a phase that will never come', () => {
    // The binary has no dora_scale; the magnitude vector is dropped and output
    // is silently wrong. 'later' would be a dated promise about that.
    expect(civitaiTypeOutlook('dora')).toBe('no')
    expect(civitaiTypeOutlook('dora')).not.toBe('later')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. selection helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('civitaiTypesFor / civitaiTypeOutlook / id narrowing', () => {
  it('sends Civitai’s own spelling for the newly offered types', () => {
    expect(civitaiTypesFor('unet')).toEqual(['UNet'])
    expect(civitaiTypesFor('clip-vision')).toEqual(['CLIPVision'])
    expect(civitaiTypesFor('vision-language')).toEqual(['VisionLanguage'])
    expect(civitaiTypesFor('text-encoder')).toEqual(['TextEncoder'])
    expect(civitaiTypesFor('motion')).toEqual(['MotionModule'])
    expect(civitaiTypesFor('aesthetic')).toEqual(['AestheticGradient'])
    expect(civitaiTypesFor('locon')).toEqual(['LoCon'])
  })

  it('returns undefined (not an empty array) for an unknown id — no filter, not a broken one', () => {
    expect(civitaiTypesFor('nope' as CivitaiTypeFilterId)).toBeUndefined()
    expect(civitaiTypesFor('all')).toBeUndefined()
  })

  it('describes nothing for All, and nothing for an id it does not know', () => {
    expect(civitaiTypeOutlook('all')).toBeNull()
    expect(civitaiTypeOutlook('nope' as CivitaiTypeFilterId)).toBeNull()
  })

  it('narrows a persisted / stale chip id', () => {
    expect(isCivitaiTypeFilterId('dora')).toBe(true)
    expect(isCivitaiTypeFilterId('lycoris')).toBe(false)
    expect(isCivitaiTypeFilterId(undefined)).toBe(false)
    expect(isCivitaiTypeFilterId(7)).toBe(false)
  })
})

describe('civitaiTypeFilterIdForType — the badge on the card', () => {
  it('maps every type main can send to a label id', () => {
    for (const type of MAIN_TYPES) {
      expect(civitaiTypeFilterIdForType(type), `no label for ${type}`).not.toBeNull()
    }
  })

  it('folds the retired LyCORIS onto the LoCon label — they are one thing upstream', () => {
    expect(civitaiTypeFilterIdForType('LyCORIS')).toBe('locon')
  })

  it('returns null for a type we have no word for — the card then prints it verbatim', () => {
    expect(civitaiTypeFilterIdForType('Hologram')).toBeNull()
    expect(civitaiTypeFilterIdForType('')).toBeNull()
    expect(civitaiTypeFilterIdForType('   ')).toBeNull()
    expect(civitaiTypeFilterIdForType(null)).toBeNull()
    expect(civitaiTypeFilterIdForType(42)).toBeNull()
  })

  it('is case- and space-exact apart from trimming (no fuzzy guessing)', () => {
    expect(civitaiTypeFilterIdForType('  LORA  ')).toBe('lora')
    expect(civitaiTypeFilterIdForType('lora')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. sort / period / base model / clear
// ═══════════════════════════════════════════════════════════════════════════

describe('sort + period', () => {
  it('sends exactly the values main will forward (anything else is DROPPED, not errored)', () => {
    expect(CIVITAI_SORT_OPTIONS.map(o => o.value).sort()).toEqual([...MAIN_SORTS].sort())
    expect(CIVITAI_PERIOD_OPTIONS.map(o => o.value).sort()).toEqual([...MAIN_PERIODS].sort())
  })

  it('never offers Hour — it 400s upstream', () => {
    expect(CIVITAI_PERIOD_OPTIONS.map(o => o.value)).not.toContain('Hour')
  })

  it('defaults match main’s own default, so the initial chip matches the initial grid', () => {
    expect(civitaiSortValue(CIVITAI_DEFAULT_SORT)).toBe('Most Downloaded')
    expect(civitaiPeriodValue(CIVITAI_DEFAULT_PERIOD)).toBe('AllTime')
  })

  it('sends AllTime explicitly rather than omitting the param', () => {
    expect(civitaiPeriodValue('allTime')).toBe('AllTime')
  })

  it('falls back to the default for an unknown id instead of sending garbage', () => {
    expect(civitaiSortValue('nope' as never)).toBe('Most Downloaded')
    expect(civitaiPeriodValue('nope' as never)).toBe('AllTime')
  })
})

describe('toggleCivitaiBaseModel', () => {
  it('adds and removes', () => {
    expect(toggleCivitaiBaseModel([], 'Pony')).toEqual(['Pony'])
    expect(toggleCivitaiBaseModel(['Pony'], 'Pony')).toEqual([])
  })

  it('keeps the declared chip order however they were clicked', () => {
    const a = toggleCivitaiBaseModel([], 'NoobAI')
    const b = toggleCivitaiBaseModel(a, 'SD 1.5')
    expect(b).toEqual(['SD 1.5', 'NoobAI'])
  })

  it('DROPS a value that is not an offered chip — the wire only carries what the UI shows', () => {
    expect(toggleCivitaiBaseModel([], 'Flux.1 D')).toEqual([])
    expect(toggleCivitaiBaseModel(['SD 1.5'], 'Flux.1 D')).toEqual(['SD 1.5'])
  })

  it('never mutates the input', () => {
    const cur = ['SD 1.5']
    toggleCivitaiBaseModel(cur, 'Pony')
    expect(cur).toEqual(['SD 1.5'])
  })

  it('offers only base models this app has a local row for', () => {
    // GREW from five to fourteen on 2026-07-31. The original five were the
    // families we could install a CHECKPOINT for; the app also runs Z-Image and
    // four Wan rows, and the filter row was pretending they did not exist.
    // Every value is echo-tested — the per-chip evidence, the two-row grouping
    // and the "for my models" toggle live in civitaiForMyModels.test.ts.
    expect(CIVITAI_BASE_MODEL_FILTERS.slice(0, 5))
      .toEqual(['SD 1.5', 'SDXL 1.0', 'Pony', 'Illustrious', 'NoobAI'])
    expect(CIVITAI_BASE_MODEL_FILTERS).toContain('ZImageTurbo')
    expect(CIVITAI_BASE_MODEL_FILTERS).toContain('Wan Video 2.2 I2V-A14B')
    // Still nothing whose entire grid would be refusals, and still no retired
    // enum value (`Wan Video` matches rows but is no longer offered upstream).
    expect(CIVITAI_BASE_MODEL_FILTERS).not.toContain('Flux.1 D')
    expect(CIVITAI_BASE_MODEL_FILTERS).not.toContain('Wan Video')
  })
})

describe('civitaiFiltersActive — the Clear control', () => {
  const clean = {
    type: 'all' as const, sort: CIVITAI_DEFAULT_SORT,
    period: CIVITAI_DEFAULT_PERIOD, baseModels: [] as string[],
  }

  it('is quiet on a clean filter set (no permanent Clear button)', () => {
    expect(civitaiFiltersActive(clean)).toBe(false)
  })

  it('lights up for any one of the four', () => {
    expect(civitaiFiltersActive({ ...clean, type: 'lora' })).toBe(true)
    expect(civitaiFiltersActive({ ...clean, sort: 'newest' })).toBe(true)
    expect(civitaiFiltersActive({ ...clean, period: 'week' })).toBe(true)
    expect(civitaiFiltersActive({ ...clean, baseModels: ['Pony'] })).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. THE 18+ PREVIEW BLUR
// ═══════════════════════════════════════════════════════════════════════════

const thumb = (level?: unknown): Pick<CivitaiSearchRow, 'thumbnail' | 'thumbnailNsfwLevel'> =>
  ({ thumbnail: 'data:image/jpeg;base64,AAAA', thumbnailNsfwLevel: level as number })

describe('civitaiPreviewBlurred', () => {
  it('NEVER blurs in SFW mode, whatever the level says', () => {
    // Main requested nsfw=false, which clamps previews to PG. A blur here would
    // be theatre — and an older main build sends no level at all, which would
    // fog every card in the safest mode there is.
    expect(civitaiPreviewBlurred(thumb(16), {})).toBe(false)
    expect(civitaiPreviewBlurred(thumb(16), { adult: false })).toBe(false)
    expect(civitaiPreviewBlurred(thumb(undefined), {})).toBe(false)
  })

  it('lets PG and PG13 through in adult mode', () => {
    expect(civitaiPreviewBlurred(thumb(1), { adult: true })).toBe(false)
    expect(civitaiPreviewBlurred(thumb(2), { adult: true })).toBe(false)
    expect(civitaiPreviewBlurred(thumb(3), { adult: true })).toBe(false)
  })

  it('blurs R / X / XXX / Blocked in adult mode', () => {
    for (const level of [4, 8, 16, 32]) {
      expect(civitaiPreviewBlurred(thumb(level), { adult: true }), `level ${level}`).toBe(true)
    }
  })

  it('MUTATION: an ordinal `level >= 4` test gets Blocked(32) right but a mixed mask wrong', () => {
    // The levels are a SET, not a scale. 33 = PG|Blocked: an ordinal test on the
    // low bit would pass it. The mask does not.
    expect(civitaiPreviewBlurred(thumb(33), { adult: true })).toBe(true)
    expect((33 & NSFW_ABOVE_PG13) !== 0).toBe(true)
  })

  it('blurs an UNKNOWN level in adult mode — unknown is not evidence of PG', () => {
    expect(civitaiPreviewBlurred(thumb(undefined), { adult: true })).toBe(true)
    expect(civitaiPreviewBlurred(thumb(null), { adult: true })).toBe(true)
    expect(civitaiPreviewBlurred(thumb('4'), { adult: true })).toBe(true)
    expect(civitaiPreviewBlurred(thumb(NaN), { adult: true })).toBe(true)
  })

  it('has nothing to blur on a row with no thumbnail', () => {
    expect(civitaiPreviewBlurred({ thumbnail: null, thumbnailNsfwLevel: 16 }, { adult: true })).toBe(false)
    expect(civitaiPreviewBlurred({ thumbnail: '', thumbnailNsfwLevel: 16 }, { adult: true })).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. the mode notice
// ═══════════════════════════════════════════════════════════════════════════

describe('civitaiModeNotice', () => {
  it('reports what was SERVED, outranking the settings', () => {
    expect(civitaiModeNotice({ served: true, adultMode: false })).toBe('adult')
    expect(civitaiModeNotice({ served: false, adultMode: false })).toBe('sfw')
  })

  it('names the contradiction: switch lit, page served safe', () => {
    // Almost always a removed API key, and the single most confusing state this
    // feature can be in. Reporting plain 'sfw' here would be true about the rows
    // and silent about the lie on screen.
    expect(civitaiModeNotice({ served: false, adultMode: true })).toBe('adult-inert')
  })

  it('falls back to main’s resolved predicate before the first page lands', () => {
    expect(civitaiModeNotice({ unlocked: true })).toBe('adult')
    expect(civitaiModeNotice({ unlocked: false, adultMode: true })).toBe('adult-inert')
    expect(civitaiModeNotice({ unlocked: false, adultMode: false })).toBe('sfw')
    expect(civitaiModeNotice({})).toBe('sfw')
  })

  it('is SFW for a null-ish input — the safe default is the shipped default', () => {
    expect(civitaiModeNotice(undefined as never)).toBe('sfw')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. name split + the narrowed fit verdict
// ═══════════════════════════════════════════════════════════════════════════

describe('civitaiNameParts', () => {
  it('splits main’s join on the LAST separator', () => {
    expect(civitaiNameParts({ name: 'Juggernaut XL - v9' })).toEqual({ title: 'Juggernaut XL', version: 'v9' })
  })

  it('keeps a dashed MODEL name whole when the tail is too long to be a version', () => {
    const name = 'Realistic Vision - Photorealism Pack for portraits and studio work'
    expect(civitaiNameParts({ name })).toEqual({ title: name, version: '' })
  })

  it('degrades to the whole string when there is nothing to split', () => {
    expect(civitaiNameParts({ name: 'DreamShaper' })).toEqual({ title: 'DreamShaper', version: '' })
    expect(civitaiNameParts({ name: 'DreamShaper - ' })).toEqual({ title: 'DreamShaper -', version: '' })
    expect(civitaiNameParts({ name: '' })).toEqual({ title: '', version: '' })
    expect(civitaiNameParts({ name: undefined as never })).toEqual({ title: '', version: '' })
  })

  it('loses nothing: both halves are always rendered together', () => {
    const parts = civitaiNameParts({ name: 'A - B - v2' })
    expect(`${parts.title} - ${parts.version}`).toBe('A - B - v2')
  })
})

describe('civitaiShowsFitVerdict', () => {
  it('keeps the VRAM verdict for a checkpoint — VRAM really does decide there', () => {
    expect(civitaiShowsFitVerdict({ type: 'Checkpoint' })).toBe(true)
  })

  it('suppresses it for everything else — a 150 MB LoRA never occupies VRAM alone', () => {
    for (const type of MAIN_TYPES.filter(t => t !== 'Checkpoint')) {
      expect(civitaiShowsFitVerdict({ type }), type).toBe(false)
    }
    expect(civitaiShowsFitVerdict({ type: undefined as never })).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. THE HONESTY LAW, across the 19 newly offered types
// ═══════════════════════════════════════════════════════════════════════════

describe('a refused row of ANY newly offered type still gets no button', () => {
  const NEVER_INSTALLABLE = [
    'UNet', 'TextEncoder', 'CLIP', 'CLIPVision', 'VisionLanguage', 'LLM',
    'DoRA', 'Hypernetwork', 'AestheticGradient',
    'Poses', 'Wildcards', 'Workflows', 'Detection', 'Other',
  ]

  it('every never-installable type is BLOCKED, with main’s own reason', () => {
    for (const type of NEVER_INSTALLABLE) {
      const v = civitaiAffordance(
        { type, installable: false, reason: 'This model type does not run in our image engine.' } as never,
        {},
      )
      expect(v.kind, type).toBe('blocked')
      expect(v.kind, type).not.toBe('install')
    }
  })

  it('a phase-4 type is blocked too — "later" on the chip is not a button on the card', () => {
    for (const type of ['Controlnet', 'Upscaler', 'MotionModule']) {
      const v = civitaiAffordance({ type, installable: false, reason: 'ControlNet support comes in phase 4.' } as never, {})
      expect(v.kind, type).toBe('blocked')
    }
  })

  it('an adapter with no base under it is blocked, not disabled', () => {
    const v = civitaiAffordance(
      { type: 'LORA', installable: false, reason: 'Needs an SDXL checkpoint — install one first and this LoRA runs on top of it.' } as never,
      {},
    )
    expect(v).toEqual({
      kind: 'blocked',
      reason: 'Needs an SDXL checkpoint — install one first and this LoRA runs on top of it.',
    })
  })

  it('the same adapter INSTALLS once main flips the verdict — the chip outlook is not the gate', () => {
    expect(civitaiAffordance({ type: 'LORA', installable: true } as never, {}).kind).toBe('install')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. SOURCE SWEEP — the JSX wiring
// ═══════════════════════════════════════════════════════════════════════════

describe('CatalogPage — the filter surface is built FROM the tables', () => {
  const src = stripComments(read(PAGE))

  it('renders the type chips per GROUP, never as one 23-chip wall', () => {
    expect(src).toContain('CIVITAI_TYPE_GROUPS.map(g =>')
    expect(src).toMatch(/civitaiTypeFiltersIn\(openGroup\)\.map\(f => \(/)
    // The flat map over the whole table is exactly what this replaced.
    expect(src).not.toMatch(/CIVITAI_TYPE_FILTERS\.map\(/)
  })

  it('keeps every type reachable: All is its own chip and all three groups render', () => {
    expect(src).toMatch(/setCivitaiType\('all'\)/)
    expect(src).toContain("t('civitai.types.all')")
    expect(src).toMatch(/t\(`civitai\.groups\.\$\{g\}`\)/)
    // The group chip is a DISCLOSURE control — it must not set the filter.
    const groupBtn = between(src, 'CIVITAI_TYPE_GROUPS.map(g =>', 'civitaiTypeFiltersIn(openGroup)')
    expect(groupBtn).toContain('setOpenGroup(')
    expect(groupBtn).not.toContain('setCivitaiType(')
  })

  it('reuses the ONE chip style for the type chips (unchanged from phase 1)', () => {
    expect(src).toMatch(/style=\{chip\(s\.civitaiType === f\.id\)\}/)
  })

  it('prints the outlook for the ACTIVE type, and nothing for All', () => {
    expect(src).toMatch(/civitaiTypeOutlook\(s\.civitaiType\) && \(/)
    expect(src).toMatch(/t\(`civitai\.outlook\.\$\{civitaiTypeOutlook\(s\.civitaiType\)\}`\)/)
  })

  it('wires sort and period to the store actions, single-select each', () => {
    expect(src).toMatch(/CIVITAI_SORT_OPTIONS\.map\(o => \(/)
    expect(src).toMatch(/s\.setCivitaiSort\(o\.id\)/)
    expect(src).toMatch(/style=\{chip\(s\.civitaiSort === o\.id\)\}/)
    expect(src).toMatch(/CIVITAI_PERIOD_OPTIONS\.map\(o => \(/)
    expect(src).toMatch(/s\.setCivitaiPeriod\(o\.id\)/)
    expect(src).toMatch(/style=\{chip\(s\.civitaiPeriod === o\.id\)\}/)
  })

  it('wires base models as MULTI-select and shows them in Civitai’s own spelling', () => {
    // Rendered as one labelled sub-row per engine family since the set grew to
    // fourteen — the chips are still individually toggled and still carry the
    // raw wire value as their label.
    expect(src).toMatch(/CIVITAI_CHIP_FAMILIES\.map\(fam => \(/)
    expect(src).toMatch(/civitaiChipsForFamily\(fam\)\.map\(c => \(/)
    expect(src).toMatch(/s\.toggleCivitaiBase\(c\.value\)/)
    expect(src).toMatch(/style=\{chip\(s\.civitaiBaseModels\.includes\(c\.value\)\)\}/)
    // Never translated: the chip label IS the query value. (The FAMILY heading
    // above each row is translated — it is prose, not a filter value.)
    expect(src).not.toMatch(/t\(`civitai\.baseModels\./)
  })

  it('offers Clear only when something is actually filtered', () => {
    expect(src).toContain('civitaiFiltersActive({')
    expect(src).toMatch(/s\.clearCivitaiFilters\(\)/)
    expect(src).toContain("t('civitai.clearFilters')")
  })

  it('says which MODE the rows on screen came back in, served-first', () => {
    expect(src).toContain('civitaiModeNotice({')
    expect(src).toMatch(/served: s\.civitaiAdultServed/)
    expect(src).toMatch(/adultMode: s\.civitaiAdultState\?\.adultMode/)
    expect(src).toMatch(/unlocked: s\.civitaiAdultState\?\.unlocked/)
    expect(src).toMatch(/MODE_KEY\[notice\]/)
  })

  it('hands the card the SERVED mode, never the local setting', () => {
    expect(src).toMatch(/adultServed=\{s\.civitaiAdultServed === true\}/)
    expect(src).not.toMatch(/adultServed=\{s\.civitaiAdultState/)
  })
})

describe('ModelCard — the per-row phase 2/3 truths', () => {
  const src = stripComments(read(CARD))

  it('blurs through the shared predicate, with the SERVED mode as the outer gate', () => {
    expect(src).toMatch(/civitaiPreviewBlurred\(civitai, \{ adult: adultServed \}\)/)
    expect(src).toMatch(/filter: blurNow \? 'blur\(\d+px\)' : undefined/)
    // The renderer must not re-derive the bitmask.
    expect(src).not.toContain('thumbnailNsfwLevel')
  })

  it('draws the reveal control ONLY while something is blurred', () => {
    expect(src).toMatch(/\{blurEligible && !revealed && \(/)
    expect(src).toMatch(/aria-label=\{t\('civitai\.reveal'\)\}/)
    expect(src).toMatch(/setRevealed\(true\)/)
    // Hover peeks, and only when there is something to peek at.
    expect(src).toMatch(/if \(blurEligible\) setPeeking\(true\)/)
  })

  it('still uses the data: thumbnail — the blur is a filter, not a different source', () => {
    expect(src).toContain('src={civitai.thumbnail}')
    expect(src).not.toMatch(/src=\{`https:/)
  })

  it('suppresses the VRAM verdict for a Civitai row that is not a checkpoint', () => {
    expect(src).toMatch(/showsFitVerdict\(entry\) && \(!civitai \|\| civitaiShowsFitVerdict\(civitai\)\)/)
  })

  it('shows the model name and the version separately', () => {
    expect(src).toMatch(/civitaiNameParts\(civitai\)/)
    expect(src).toMatch(/cvName \? cvName\.title : entry\.name/)
  })

  it('labels the row type through the chip vocabulary, and prints an unknown one verbatim', () => {
    expect(src).toMatch(/civitaiTypeFilterIdForType\(civitai\.type\)/)
    expect(src).toMatch(/t\(`civitai\.types\.\$\{cvTypeId\}`\)/)
    expect(src).toMatch(/\(civitai\.type \?\? ''\)\.trim\(\)/)
  })

  it('keeps the honesty law intact: exactly one Install button, in the install arm', () => {
    expect((src.match(/onClick=\{onInstall\}/g) ?? []).length).toBe(1)
    const start = src.indexOf("affordance.kind === 'blocked' ?")
    const end = src.indexOf("affordance.kind === 'installed' ?")
    const blockedArm = src.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(blockedArm).not.toContain('<button')
  })
})

describe('catalog.store — the filter slice re-searches from page one', () => {
  const src = stripComments(read(STORE))

  it('sends type, baseModels, sort and period on a FRESH search', () => {
    const body = between(src, 'runCivitaiSearch: async', 'loadMoreCivitai: async')
    expect(body).toContain('types: civitaiTypesFor(civitaiType)')
    expect(body).toContain('sort: civitaiSortValue(civitaiSort)')
    expect(body).toContain('period: civitaiPeriodValue(civitaiPeriod)')
    // `baseModels` is the RESOLVED constraint: the manual chips, or the
    // installed-family expansion when "for my models" owns the filter.
    expect(body).toMatch(/baseModels: baseModels\.length > 0/)
    expect(body).toContain('civitaiBaseModelsForFamilies(')
  })

  it('does NOT send sort/period on a cursor page — main drops them there by design', () => {
    const body = between(src, 'loadMoreCivitai: async', 'setCivitaiInstalling: (id)')
    expect(body).toContain('types: civitaiTypesFor(civitaiType)')
    expect(body).toContain('cursor: civitaiCursor')
    expect(body).not.toContain('sort:')
    expect(body).not.toContain('period:')
  })

  it('re-runs from page one on every filter change (a cursor encodes the old order)', () => {
    // Anchored on the IMPLEMENTATION arrow, not on `fn: (` — the latter finds
    // the interface declaration 200 lines earlier and asserts nothing.
    const impls: Array<[string, string]> = [
      ['setCivitaiType: (t) => {', 'setCivitaiSort: (s) => {'],
      ['setCivitaiSort: (s) => {', 'setCivitaiPeriod: (p) => {'],
      ['setCivitaiPeriod: (p) => {', 'toggleCivitaiBase: (baseModel) => {'],
      ['toggleCivitaiBase: (baseModel) => {', 'clearCivitaiFilters: () => {'],
      ['clearCivitaiFilters: () => {', 'refreshCivitaiAdultState: async'],
    ]
    for (const [from, to] of impls) {
      expect(between(src, from, to), `${from} does not re-search`).toContain('runCivitaiSearch()')
    }
  })

  it('Clear is a no-op when nothing is filtered (no pointless request)', () => {
    const body = between(src, 'clearCivitaiFilters: () => {', 'refreshCivitaiAdultState: async')
    expect(body).toMatch(/if \(clean\) return/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. i18n — DERIVED from the tables, all 8 locales
// ═══════════════════════════════════════════════════════════════════════════

function loadNs(lang: string, ns: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES, lang, `${ns}.json`), 'utf8'))
}

function at(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined),
    obj,
  )
}

/**
 * Every catalog key the filter surface renders, DERIVED from the code tables.
 *
 * Derived, not hand-listed, because a hand-list is exactly how 19 of these went
 * missing: the table grew from 4 ids to 23 and the list did not follow, so the
 * chip row rendered raw key strings in all eight languages.
 */
const DERIVED_KEYS = [
  ...CIVITAI_TYPE_FILTERS.map(f => `civitai.types.${f.id}`),
  ...CIVITAI_TYPE_GROUPS.map(g => `civitai.groups.${g}`),
  ...[...new Set(CIVITAI_TYPE_FILTERS.map(f => f.outlook).filter(Boolean))].map(o => `civitai.outlook.${o}`),
  ...CIVITAI_SORT_OPTIONS.map(o => `civitai.sort.${o.id}`),
  ...CIVITAI_PERIOD_OPTIONS.map(o => `civitai.period.${o.id}`),
  'civitai.sortLabel', 'civitai.periodLabel', 'civitai.baseLabel', 'civitai.clearFilters',
  'civitai.reveal', 'civitai.mode.adult', 'civitai.mode.adultInert',
]

describe('i18n — every filter label, every locale', () => {
  it('derives a key for all 23 types, 3 groups, 4 outlooks, 3 sorts and 5 periods', () => {
    expect(CIVITAI_TYPE_FILTERS).toHaveLength(23)
    expect(DERIVED_KEYS).toHaveLength(23 + 3 + 4 + 3 + 5 + 7)
  })

  for (const lang of LANGS) {
    it(`${lang}/catalog has every derived key, non-empty`, () => {
      const ns = loadNs(lang, 'catalog')
      for (const key of DERIVED_KEYS) {
        const v = at(ns, key)
        expect(typeof v, `${lang}/catalog:${key}`).toBe('string')
        expect((v as string).trim(), `${lang}/catalog:${key}`).not.toBe('')
      }
    })
  }

  it('no locale left a type label as its own key id (the raw-key-on-screen bug)', () => {
    for (const lang of LANGS) {
      const ns = loadNs(lang, 'catalog')
      for (const f of CIVITAI_TYPE_FILTERS) {
        expect(at(ns, `civitai.types.${f.id}`), `${lang}:${f.id}`).not.toBe(`civitai.types.${f.id}`)
      }
    }
  })

  it('the non-English locales really translated the translatable labels', () => {
    // The model-type jargon the ecosystem itself writes in Latin (LoRA, VAE,
    // ControlNet…) stays Latin everywhere on purpose — a localised "LoRA" is a
    // word nobody searches for. The SENTENCES have no such excuse.
    const en = loadNs('en', 'catalog')
    const prose = [
      'civitai.outlook.runs', 'civitai.outlook.needs-base', 'civitai.outlook.later',
      'civitai.outlook.no', 'civitai.mode.adultInert', 'civitai.clearFilters',
      'civitai.reveal', 'civitai.sortLabel', 'civitai.periodLabel', 'civitai.baseLabel',
    ]
    for (const lang of LANGS.filter(l => l !== 'en')) {
      const ns = loadNs(lang, 'catalog')
      for (const key of prose) {
        expect(at(ns, key), `${lang}:${key} is still the English string`).not.toBe(at(en, key))
      }
    }
  })

  it('the group labels are distinct from each other in every locale', () => {
    for (const lang of LANGS) {
      const ns = loadNs(lang, 'catalog')
      const labels = CIVITAI_TYPE_GROUPS.map(g => at(ns, `civitai.groups.${g}`))
      expect(new Set(labels).size, `${lang} group labels collide`).toBe(labels.length)
    }
  })

  it('the type labels are distinct within a locale — two chips must not read alike', () => {
    for (const lang of LANGS) {
      const ns = loadNs(lang, 'catalog')
      const labels = CIVITAI_TYPE_FILTERS.map(f => at(ns, `civitai.types.${f.id}`))
      expect(new Set(labels).size, `${lang} type labels collide`).toBe(labels.length)
    }
  })
})
