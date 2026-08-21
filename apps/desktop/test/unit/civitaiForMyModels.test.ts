// apps/desktop/test/unit/civitaiForMyModels.test.ts
//
// "Make Civitai actually useful FOR MY MODELS."
//
// Two halves, both keyed on MEASURED truth rather than on plausible spellings:
//
//  1. THE VOCABULARY. Civitai's `baseModels=` values are a closed, drifting
//     enum. Every string this app sends was echo-tested against the live API on
//     2026-07-31 (GET /api/v1/enums for the list, then
//     GET /api/v1/models?limit=100&nsfw=false&baseModels=<X> for the proof that
//     the value actually selects rows). The numbers in the table below are that
//     measurement, and the point of the table is the NEGATIVE result in it:
//
//       ZImageTurbo             → 100 models / 402 versions   ✔
//       ZImageBase              →  99 models / 194 versions   ✔
//       "Z-Image Turbo"         →   0 models /   0 versions   ✘ (the guessable
//                                   spelling — it is not the enum value, and a
//                                   chip carrying it would be a dead filter
//                                   that says nothing about being dead)
//       Wan Video 14B t2v       → 100 models / 174 versions   ✔
//       Wan Video 14B i2v 480p  → 100 models / 127 versions   ✔
//       Wan Video 14B i2v 720p  → 100 models / 132 versions   ✔
//       Wan Video 2.2 TI2V-5B   →  50 models /  69 versions   ✔
//       Wan Video 2.2 I2V-A14B  → 100 models / 252 versions   ✔
//       Wan Video 2.2 T2V-A14B  → 100 models / 240 versions   ✔
//       Wan Video 1.3B t2v      →  52 models /  65 versions   ✔
//       Wan Video                → 100 models / 195 versions  ✔ but RETIRED —
//                                   present in `BaseModel`, absent from
//                                   `ActiveBaseModel`, so it still labels old
//                                   rows and must be READ, never OFFERED.
//
//  2. THE VERDICT. Discovery is not permission. Z-Image and Wan are BOTH
//     multi-component bundles in this app (sd-cpp-models.ts: z-image-turbo is
//     diffusion + vae + Qwen3-4B-Instruct-2507; every wan row is diffusion +
//     vae + t5xxl), so a single Civitai checkpoint file of either CANNOT run —
//     the same fact that already makes `familyForBaseModel` return null for
//     Flux. Letting a chip exist is a browsing decision; letting Install exist
//     is a capability claim, and only the first one changes here.

import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// civitai-search.ts reaches the keychain + egress policy at module scope;
// neither participates in the pure mapping under test (their real behaviour is
// pinned in civitaiEgress.test.ts).
vi.mock('../../electron/services/keychain', () => ({ retrieveKey: () => null, hasKey: () => false }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import {
  familyForBaseModel,
  civitaiInstallVerdict,
  isCivitaiWanBaseModel,
  CIVITAI_WAN_BASE_MODELS,
  isCivitaiLtxBaseModel,
  CIVITAI_LTX_BASE_MODELS,
  CIVITAI_REASONS,
  type CivitaiFamily,
} from '../../electron/services/civitai-search'

import {
  CIVITAI_BASE_MODEL_CHIPS,
  CIVITAI_BASE_MODEL_FILTERS,
  CIVITAI_CHIP_FAMILIES,
  CIVITAI_FOR_MY_MODELS_TYPE,
  civitaiBaseModelsForFamilies,
  civitaiChipsForFamily,
  civitaiInstalledChipFamilies,
  civitaiForMyModelsUsable,
  toggleCivitaiBaseModel,
  type CivitaiChipFamily,
} from '../../src/pages/catalog/civitaiRow'

const root = path.resolve(__dirname, '../..')
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8')
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const STORE = 'src/pages/catalog/catalog.store.ts'
const PAGE = 'src/pages/catalog/CatalogPage.tsx'
const IPC = 'electron/ipc/civitai.ipc.ts'

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE MEASURED VOCABULARY
// ═══════════════════════════════════════════════════════════════════════════

describe('familyForBaseModel — Z-Image joins the families we run', () => {
  it('maps BOTH live Z-Image enum values', () => {
    // Echo-tested: 402 and 194 versions respectively.
    expect(familyForBaseModel('ZImageTurbo')).toBe('zimage')
    expect(familyForBaseModel('ZImageBase')).toBe('zimage')
  })

  it('does NOT map the guessable hyphenated spelling', () => {
    // `baseModels=Z-Image Turbo` returned 0 models on the live API. Mapping it
    // would be inventing a value the server has never heard of.
    expect(familyForBaseModel('Z-Image Turbo')).toBeNull()
    expect(familyForBaseModel('Z Image Turbo')).toBeNull()
  })

  it('leaves the families it already knew alone', () => {
    expect(familyForBaseModel('SD 1.5')).toBe('sd15')
    expect(familyForBaseModel('Pony')).toBe('sdxl')
    expect(familyForBaseModel('Illustrious')).toBe('sdxl')
    // Flux is still null on purpose: a component bundle, not a checkpoint.
    expect(familyForBaseModel('Flux.1 D')).toBeNull()
  })

  it('does NOT invent a family for Wan — `wan` is not an SdModelFamily', () => {
    // sd-cpp-models.ts is explicit that the adapter-compat union must not gain
    // a `wan` member (it keys an image-only defaults table). So a Wan row is
    // browsable but unmapped, and the verdict has to say something TRUE about
    // it rather than borrowing the "unsupported base" line.
    for (const b of CIVITAI_WAN_BASE_MODELS) expect(familyForBaseModel(b)).toBeNull()
  })
})

describe('isCivitaiWanBaseModel — the measured Wan vocabulary', () => {
  it('recognises every ACTIVE Wan enum value', () => {
    for (const b of [
      'Wan Video 1.3B t2v', 'Wan Video 14B t2v',
      'Wan Video 14B i2v 480p', 'Wan Video 14B i2v 720p',
      'Wan Video 2.2 TI2V-5B', 'Wan Video 2.2 I2V-A14B', 'Wan Video 2.2 T2V-A14B',
    ]) {
      expect(isCivitaiWanBaseModel(b), b).toBe(true)
    }
  })

  it('also recognises the RETIRED bare "Wan Video" string', () => {
    // 195 live versions still carry it. It is read (so their cards get the
    // honest reason) but never offered as a chip — see the chip test below.
    expect(isCivitaiWanBaseModel('Wan Video')).toBe(true)
  })

  it('is not a substring match', () => {
    expect(isCivitaiWanBaseModel('Wandering Diffusion')).toBe(false)
    expect(isCivitaiWanBaseModel('SDXL 1.0')).toBe(false)
    expect(isCivitaiWanBaseModel(null)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 1b. LTX — added 2026-07-31, SAME DISCIPLINE AS WAN
//
//   LTXV       →  76 models / 144 versions   ✔ (Workflows 37 · LORA 36 · Checkpoint 3)
//   LTXV 2.3   → 100 models / 209 versions   ✔ (Workflows 37 · LORA 56 · Checkpoint 7)
//
// Both are in /api/v1/enums's `ActiveBaseModel`, read verbatim rather than
// guessed — the same table also lists `LTXV2` (96/133, echo-tested the same
// way), which this lane deliberately does NOT wire: it was not named in the
// brief and no curated row was checked against it, so adding it would be
// exactly the guess this discipline exists to catch.
// ═══════════════════════════════════════════════════════════════════════════

describe('familyForBaseModel — LTX stays null (ltx2 is not an SdModelFamily)', () => {
  it('does NOT invent a family for LTX, for the SAME reason as Wan', () => {
    // Widening CivitaiFamily/SdModelFamily to add `ltx2` would either fail to
    // compile at user-sd-models.ts's exhaustive FAMILY_DEFAULTS Record (a
    // missing key) or force a filler entry there that lets an LTX VIDEO row
    // flow through code that computes an IMAGE baseSize/steps/cfg default for
    // it — the exact "recognized-but-not-backed" bug class user-sd-models.ts's
    // own comment warns about for Z-Image. So, like Wan, LTX is browsable but
    // unmapped.
    for (const b of CIVITAI_LTX_BASE_MODELS) expect(familyForBaseModel(b)).toBeNull()
  })
})

describe('isCivitaiLtxBaseModel — the measured LTX vocabulary', () => {
  it('recognises both wired ActiveBaseModel values', () => {
    for (const b of CIVITAI_LTX_BASE_MODELS) expect(isCivitaiLtxBaseModel(b), b).toBe(true)
  })

  it('is not a substring or prefix match', () => {
    expect(isCivitaiLtxBaseModel('LTXV2')).toBe(false)     // live, but deliberately unwired
    expect(isCivitaiLtxBaseModel('LTXVideo')).toBe(false)
    expect(isCivitaiLtxBaseModel('SDXL 1.0')).toBe(false)
    expect(isCivitaiLtxBaseModel(null)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE VERDICT — discovery is not permission
// ═══════════════════════════════════════════════════════════════════════════

const row = (over: Partial<Parameters<typeof civitaiInstallVerdict>[0]>) => ({
  type: 'Checkpoint', family: null as CivitaiFamily | null, baseModel: 'SD 1.5',
  format: 'SafeTensor', sha256: 'abc', downloadUrl: 'https://civitai.com/x',
  ...over,
})

describe('civitaiInstallVerdict — Z-Image', () => {
  it('REFUSES a Z-Image checkpoint: it is a 3-file bundle, not one file', () => {
    // z-image-turbo ships diffusion + vae + Qwen3-4B-Instruct-2507. Civitai
    // publishes the diffusion file alone, exactly as it does for Flux, and
    // installing it would produce a model that cannot generate.
    const v = civitaiInstallVerdict(row({ type: 'Checkpoint', family: 'zimage', baseModel: 'ZImageTurbo' }))
    expect(v.installable).toBe(false)
    expect(v.reasonCode).toBe('zimage-bundle')
    expect(v.reason).toBe(CIVITAI_REASONS.zimageBundle)
  })

  it('ALLOWS a Z-Image LoRA once a Z-Image checkpoint is on disk', () => {
    // This is the whole point of the lane: the curated z-image-turbo row IS
    // installable, and a LoRA on top of it genuinely runs (`--lora-model-dir`
    // + a prompt tag). 235 such LoRA versions exist upstream.
    const v = civitaiInstallVerdict(
      row({ type: 'LORA', family: 'zimage', baseModel: 'ZImageTurbo' }),
      { installedFamilies: new Set<CivitaiFamily>(['zimage']) },
    )
    expect(v.installable).toBe(true)
  })

  it('refuses that same LoRA — naming Z-Image — when no base is installed', () => {
    const v = civitaiInstallVerdict(row({ type: 'LORA', family: 'zimage', baseModel: 'ZImageTurbo' }))
    expect(v.installable).toBe(false)
    expect(v.reasonCode).toBe('needs-base')
    expect(v.reason).toContain('Z-Image')
  })

  it('still puts safety first — a pickle Z-Image row is refused as a pickle', () => {
    const v = civitaiInstallVerdict(
      row({ type: 'LORA', family: 'zimage', baseModel: 'ZImageTurbo', format: 'PickleTensor' }),
      { installedFamilies: new Set<CivitaiFamily>(['zimage']) },
    )
    expect(v.reasonCode).toBe('pickle')
  })
})

describe('civitaiInstallVerdict — Wan says something TRUE', () => {
  it('does not tell a Wan row that we cannot run its base model', () => {
    // We DO run Wan — four curated rows of it. The old generic line
    // ("Our engine does not run this base model yet") was simply false here,
    // and a false refusal is still a lie even though it refuses.
    const v = civitaiInstallVerdict(row({ type: 'Checkpoint', baseModel: 'Wan Video 2.2 I2V-A14B' }))
    expect(v.installable).toBe(false)
    expect(v.reasonCode).toBe('wan')
    expect(v.reason).toBe(CIVITAI_REASONS.wan)
    expect(v.reason).not.toBe(CIVITAI_REASONS.unsupportedBase)
  })

  it('gives a Wan LoRA the same honest reason, not the adapter one', () => {
    // It must NOT say "needs a Wan checkpoint — install one and this runs on
    // top of it": the adapter registry has no `wan` family, so that sentence
    // would promise something no amount of installing can deliver.
    const v = civitaiInstallVerdict(
      row({ type: 'LORA', baseModel: 'Wan Video 14B t2v' }),
      { installedFamilies: new Set<CivitaiFamily>(['sdxl']) },
    )
    expect(v.installable).toBe(false)
    expect(v.reasonCode).toBe('wan')
  })

  it('covers the retired bare string too', () => {
    expect(civitaiInstallVerdict(row({ baseModel: 'Wan Video' })).reasonCode).toBe('wan')
  })

  it('leaves genuinely unknown bases on the generic reason', () => {
    expect(civitaiInstallVerdict(row({ baseModel: 'Kolors' })).reasonCode).toBe('unsupported-base')
  })
})

describe('civitaiInstallVerdict — LTX says something TRUE', () => {
  it('does not tell an LTX row that we cannot run its base model', () => {
    // We DO run LTX — the curated ltx-2-3-22b-distilled row. The generic
    // "our engine does not run this base model yet" would be false here too.
    const v = civitaiInstallVerdict(row({ type: 'Checkpoint', baseModel: 'LTXV 2.3' }))
    expect(v.installable).toBe(false)
    expect(v.reasonCode).toBe('ltx')
    expect(v.reason).toBe(CIVITAI_REASONS.ltx)
    expect(v.reason).not.toBe(CIVITAI_REASONS.unsupportedBase)
  })

  it('gives an LTX LoRA the same honest reason, not the adapter one', () => {
    // Must NOT say "needs an LTX checkpoint — install one and this runs on top
    // of it": the adapter registry (SdAdapter) has no `ltx2` family, so that
    // sentence would promise something no amount of installing can deliver.
    const v = civitaiInstallVerdict(
      row({ type: 'LORA', baseModel: 'LTXV' }),
      { installedFamilies: new Set<CivitaiFamily>(['sdxl']) },
    )
    expect(v.installable).toBe(false)
    expect(v.reasonCode).toBe('ltx')
  })

  it('checked BEFORE the type branches, exactly like Wan', () => {
    // A Checkpoint AND an adapter both resolve to the ltx reason — neither
    // reaches the `family === null` arms below it.
    for (const type of ['Checkpoint', 'LORA', 'TextualInversion']) {
      expect(civitaiInstallVerdict(row({ type, baseModel: 'LTXV 2.3' })).reasonCode).toBe('ltx')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE CHIPS — one per family we actually have a row for
// ═══════════════════════════════════════════════════════════════════════════

describe('base-model chips', () => {
  it('covers every family with an installable local row', () => {
    expect([...CIVITAI_CHIP_FAMILIES].sort()).toEqual(['sd15', 'sdxl', 'wan', 'zimage'])
  })

  it('uses Civitai’s own spelling as the value — the label IS the query', () => {
    for (const c of CIVITAI_BASE_MODEL_CHIPS) {
      expect(c.value.trim()).toBe(c.value)
      expect(c.value.length).toBeGreaterThan(0)
    }
    // The derived flat list stays the wire vocabulary the store sends.
    expect(CIVITAI_BASE_MODEL_FILTERS).toEqual(CIVITAI_BASE_MODEL_CHIPS.map(c => c.value))
  })

  it('offers ONLY strings measured to return rows on the live API', () => {
    for (const c of CIVITAI_BASE_MODEL_CHIPS) expect(c.measuredVersions).toBeGreaterThan(0)
    // The dead spelling never becomes a chip.
    expect(CIVITAI_BASE_MODEL_FILTERS).not.toContain('Z-Image Turbo')
  })

  it('offers the Z-Image values that exist upstream', () => {
    expect(CIVITAI_BASE_MODEL_FILTERS).toContain('ZImageTurbo')
    expect(CIVITAI_BASE_MODEL_FILTERS).toContain('ZImageBase')
  })

  it('does NOT offer the retired bare "Wan Video" chip', () => {
    // It is absent from ActiveBaseModel; offering a retired value as a filter
    // is how a chip quietly stops working. The VERDICT still reads it.
    expect(CIVITAI_BASE_MODEL_FILTERS).not.toContain('Wan Video')
    expect(isCivitaiWanBaseModel('Wan Video')).toBe(true)
  })

  it('never offers a family the engine has no row for', () => {
    expect(CIVITAI_BASE_MODEL_FILTERS).not.toContain('Flux.1 D')
    expect(CIVITAI_BASE_MODEL_FILTERS).not.toContain('LTXV')
  })

  it('groups chips by family for the two-row layout', () => {
    expect(civitaiChipsForFamily('zimage').map(c => c.value))
      .toEqual(['ZImageTurbo', 'ZImageBase'])
    expect(civitaiChipsForFamily('sd15').map(c => c.value)).toEqual(['SD 1.5'])
    expect(civitaiChipsForFamily('sdxl').length).toBeGreaterThan(1)
  })

  it('still toggles in declared order (multi-select is a set, not a stack)', () => {
    const one = toggleCivitaiBaseModel([], 'ZImageTurbo')
    expect(one).toEqual(['ZImageTurbo'])
    const two = toggleCivitaiBaseModel(one, 'SD 1.5')
    // Declaration order, not click order.
    expect(two).toEqual(['SD 1.5', 'ZImageTurbo'])
    expect(toggleCivitaiBaseModel(two, 'SD 1.5')).toEqual(['ZImageTurbo'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. "FOR MY MODELS" — the toggle that answers the ask
// ═══════════════════════════════════════════════════════════════════════════

describe('civitaiInstalledChipFamilies — what the user actually has', () => {
  const st = (models: Array<{ family: string; kind?: string }>) =>
    ({ models: models.map((m, i) => ({ id: `m${i}`, kind: m.kind ?? 'image', family: m.family })) })

  it('reads families straight off the sd-cpp status snapshot', () => {
    expect(civitaiInstalledChipFamilies(st([{ family: 'sdxl' }, { family: 'zimage' }])).sort())
      .toEqual(['sdxl', 'zimage'])
  })

  it('counts a VIDEO row — wan is a family you own even though it is not an image base', () => {
    // The verdict deliberately ignores video rows (an image LoRA cannot sit on
    // a video checkpoint). DISCOVERY is the opposite question: "show me things
    // for the models I have", and a Wan install is a model you have.
    expect(civitaiInstalledChipFamilies(st([{ family: 'wan', kind: 'video' }])))
      .toEqual(['wan'])
  })

  it('drops families no chip can express, rather than inventing one', () => {
    expect(civitaiInstalledChipFamilies(st([{ family: 'ltx2', kind: 'video' }, { family: 'sd15' }])))
      .toEqual(['sd15'])
  })

  it('de-duplicates and survives a missing/garbage snapshot', () => {
    expect(civitaiInstalledChipFamilies(st([{ family: 'sdxl' }, { family: 'sdxl' }]))).toEqual(['sdxl'])
    expect(civitaiInstalledChipFamilies(null)).toEqual([])
    expect(civitaiInstalledChipFamilies({ models: undefined })).toEqual([])
  })
})

describe('civitaiBaseModelsForFamilies — the constraint the toggle applies', () => {
  it('expands a family to every measured value for it', () => {
    expect(civitaiBaseModelsForFamilies(['zimage'])).toEqual(['ZImageTurbo', 'ZImageBase'])
  })

  it('unions several families in declaration order', () => {
    const out = civitaiBaseModelsForFamilies(['zimage', 'sd15'])
    expect(out[0]).toBe('SD 1.5')
    expect(out).toContain('ZImageTurbo')
  })

  it('is empty for nothing installed — and the toggle must then stay OFF', () => {
    expect(civitaiBaseModelsForFamilies([])).toEqual([])
    expect(civitaiForMyModelsUsable([])).toBe(false)
    expect(civitaiForMyModelsUsable(['sdxl'])).toBe(true)
  })

  it('ignores a family with no chips instead of sending an empty filter', () => {
    expect(civitaiBaseModelsForFamilies(['ltx2' as CivitaiChipFamily])).toEqual([])
  })
})

describe('the type bias — adapters first', () => {
  it('points at LoRA, the one type that is USEFUL FOR a model you own', () => {
    // A checkpoint is a replacement for what you have; an adapter is an
    // addition to it. "For my models" means the second one.
    expect(CIVITAI_FOR_MY_MODELS_TYPE).toBe('lora')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. WIRING (node-env: the JSX/store halves are pinned by reading the files)
// ═══════════════════════════════════════════════════════════════════════════

describe('catalog.store — the for-my-models slice', () => {
  const src = stripComments(read(STORE))

  it('holds the toggle and the installed families it depends on', () => {
    expect(src).toContain('civitaiForMyModels: boolean')
    expect(src).toContain('civitaiInstalledFamilies: CivitaiChipFamily[]')
  })

  it('derives the families from the sd-cpp status snapshot it ALREADY fetches', () => {
    // No new IPC channel: status() has carried `family` since the media lane
    // needed it for the preset picker.
    expect(src).toContain('civitaiInstalledChipFamilies(')
  })

  it('constrains baseModels to the installed families when the toggle is on', () => {
    const body = src.slice(src.indexOf('runCivitaiSearch: async'), src.indexOf('loadMoreCivitai: async'))
    expect(body).toContain('civitaiBaseModelsForFamilies(')
    expect(body).toContain('civitaiForMyModels')
  })

  it('applies the SAME constraint on a cursor page (a filter that forgets is a bug)', () => {
    const body = src.slice(src.indexOf('loadMoreCivitai: async'), src.indexOf('setCivitaiInstalling: (id)'))
    expect(body).toContain('civitaiForMyModels')
  })

  it('re-searches when the toggle flips', () => {
    // Anchored on the IMPLEMENTATION arrow, not on `setCivitaiForMyModels:` —
    // the latter finds the interface declaration ~200 lines earlier and
    // asserts nothing. (The same trap civitaiCatalogFilters.test.ts records.)
    const body = src.slice(src.indexOf('setCivitaiForMyModels: (on) => {'))
    expect(body.slice(0, 900)).toContain('runCivitaiSearch()')
  })
})

describe('CatalogPage — the chip row', () => {
  const src = stripComments(read(PAGE))

  it('renders chips grouped by family', () => {
    expect(src).toContain('civitaiChipsForFamily(')
    expect(src).toContain('CIVITAI_CHIP_FAMILIES')
  })

  it('renders the chip VALUE, never a translated label', () => {
    expect(src).not.toMatch(/t\(`civitai\.baseModels\./)
  })

  it('offers the for-my-models toggle and disables it with nothing installed', () => {
    expect(src).toContain('setCivitaiForMyModels')
    expect(src).toContain('civitaiForMyModelsUsable(')
  })
})

describe('civitai.ipc — the verdict knows about the new family', () => {
  const src = stripComments(read(IPC))

  it('reports an installed zimage checkpoint, or every Z-Image LoRA lies', () => {
    // VERDICT_FAMILIES is the allowlist that turns "on disk" into "a base an
    // adapter may sit on". Without zimage here, installing the curated
    // z-image-turbo row would change nothing about the LoRA cards.
    expect(src).toMatch(/VERDICT_FAMILIES[^\n]*zimage/)
  })

  it('still refuses to take an installedFamilies claim from the renderer', () => {
    expect(src).toContain('.strip()')
  })
})
