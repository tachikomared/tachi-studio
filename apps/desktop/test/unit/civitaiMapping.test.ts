// apps/desktop/test/unit/civitaiMapping.test.ts
//
// The row contract, asserted against BYTES THE LIVE API ACTUALLY RETURNED.
// test/fixtures/civitai/models-page.json is 13 models captured on 2026-07-28
// from GET /api/v1/models?limit=100&nsfw=false (two sorts), trimmed to the
// fields we read. It was chosen to cover every branch of the verdict:
//
//   3627  Protogen v2.2      Checkpoint  SD 1.5       SafeTensor    → INSTALLABLE (sd15)
//   260267 Animagine XL V3.1 Checkpoint  SDXL 1.0     SafeTensor    → INSTALLABLE (sdxl)
//   795765 Illustrious-XL    Checkpoint  Illustrious  SafeTensor    → INSTALLABLE (sdxl)
//   618692 FLUX              Checkpoint  Flux.1 D     SafeTensor    → flux component bundle
//   1274  Dreamlike Diff.    Checkpoint  SD 1.5       PickleTensor  → pickle refusal
//   80324 Roop               Checkpoint  Other        Other         → unsupported base
//   25995 blindbox           LORA        SD 1.5       SafeTensor    → phase 2
//   65214 Age Slider         TextualInv  SD 1.5       PickleTensor  → pickle wins over phase-2
//   276082 vae-ft-mse        VAE         SD 1.5       SafeTensor    → phase 2
//   147759 Remacri           Upscaler    Upscaler     SafeTensor    → phase 4
//   4201 / 257749 / 122359                                          → dropped by the gate
//
// mapCivitaiPage is PURE (no fetch, no thumbnails), so this file needs no mocks
// at all — the network-touching half is pinned in civitaiEgress.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// civitai-search.ts imports the keychain (Bearer, when stored) and the egress
// policy. Both reach electron at module scope; neither participates in the pure
// mapping under test, so they are stubbed away rather than exercised here —
// their real behaviour is pinned in civitaiEgress.test.ts.
vi.mock('../../electron/services/keychain', () => ({ retrieveKey: () => null }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import {
  mapCivitaiPage,
  parseCommercialUse,
  familyForBaseModel,
  civitaiRowId,
  pickPrimaryFile,
  normalizeTrainedWords,
  pgPreviewUrl,
  civitaiInstallVerdict,
  buildCivitaiSearchUrl,
  civitaiNeedsBaseReason,
  CIVITAI_REASONS,
  CIVITAI_REASON_CODES,
  type CivitaiSearchRow,
} from '../../electron/services/civitai-search'

const FIXTURES = fileURLToPath(new URL('../fixtures/civitai/', import.meta.url))
const rawPage = JSON.parse(readFileSync(join(FIXTURES, 'models-page.json'), 'utf8'))
const rows = mapCivitaiPage(rawPage)
/** Protogen v2.2 — the multi-file version used for the primary-file assertions. */
const protogenV4007 = rawPage.items
  .find((m: { id: number }) => m.id === 3627)!.modelVersions[0] as {
    files: Array<Record<string, unknown>>
  }
const row = (versionId: number): CivitaiSearchRow => {
  const r = rows.find(x => x.versionId === versionId)
  if (!r) throw new Error(`no row for version ${versionId} (gate dropped it?)`)
  return r
}

describe('parseCommercialUse — a POSTGRES ARRAY LITERAL, parsed as a SET', () => {
  it('parses the real literal shapes', () => {
    expect(parseCommercialUse('{Image,RentCivit,Rent,Sell}')).toEqual(['Image', 'Rent', 'RentCivit', 'Sell'])
    expect(parseCommercialUse('{Image}')).toEqual(['Image'])
    expect(parseCommercialUse('{}')).toEqual([])
  })

  it('is ORDER-INDEPENDENT — the live API really does vary the order', () => {
    // Counted over 100 live models: "{Image,RentCivit,Rent}" appeared 28×,
    // "{RentCivit,Rent,Image}" 2×, "{RentCivit,Image,Rent}" 1×. Same set.
    const a = parseCommercialUse('{Image,RentCivit,Rent}')
    const b = parseCommercialUse('{RentCivit,Rent,Image}')
    const c = parseCommercialUse('{RentCivit,Image,Rent}')
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  it('de-duplicates, trims, and tolerates quoted members and whitespace', () => {
    expect(parseCommercialUse('{ Image , Image ,"Rent" }')).toEqual(['Image', 'Rent'])
  })

  it('returns [] for every non-literal input', () => {
    for (const bad of [null, undefined, 42, {}, '', '   ']) {
      expect(parseCommercialUse(bad as unknown), JSON.stringify(bad)).toEqual([])
    }
  })

  it('also accepts a real JSON array (some endpoints return one)', () => {
    expect(parseCommercialUse(['Sell', 'Image', 'Image'])).toEqual(['Image', 'Sell'])
  })

  it('every allowCommercialUse in the fixture parses to a non-empty-or-empty SET', () => {
    for (const m of rawPage.items) {
      expect(typeof m.allowCommercialUse).toBe('string')
      const parsed = parseCommercialUse(m.allowCommercialUse)
      // sorted + unique by construction
      expect([...new Set(parsed)].sort()).toEqual(parsed)
    }
  })
})

describe('familyForBaseModel — the live enum, not a guess', () => {
  it('maps the SD 1.5 family (incl. the distillation schedules)', () => {
    for (const b of ['SD 1.5', 'SD 1.5 LCM', 'SD 1.5 Hyper']) {
      expect(familyForBaseModel(b), b).toBe('sd15')
    }
  })

  it('maps every SDXL-architecture string', () => {
    for (const b of ['SDXL 1.0', 'SDXL 0.9', 'SDXL 1.0 LCM', 'SDXL Lightning', 'SDXL Hyper', 'Pony', 'Illustrious', 'NoobAI']) {
      expect(familyForBaseModel(b), b).toBe('sdxl')
    }
  })

  it('returns null for Flux in phase 1 — Civitai ships the UNET alone', () => {
    for (const b of ['Flux.1 D', 'Flux.1 S', 'Flux.1 Krea', 'Flux.1 Kontext']) {
      expect(familyForBaseModel(b), b).toBe(null)
    }
  })

  it('maps the two Z-Image strings (echo-tested; see civitaiForMyModels.test.ts)', () => {
    // Moved OUT of the null list on 2026-07-31. Mapping them does not make a
    // Z-Image checkpoint installable — the verdict refuses it as a component
    // bundle, exactly like Flux — it makes Z-Image LoRAs installable on top of
    // the curated z-image-turbo row.
    for (const b of ['ZImageTurbo', 'ZImageBase']) {
      expect(familyForBaseModel(b), b).toBe('zimage')
    }
  })

  it('returns null for everything else the live enum contains', () => {
    for (const b of ['Krea 2', 'Anima', 'HiDream', 'Ernie', 'Upscaler', 'Other', 'SD 3.5', '', null, 42]) {
      expect(familyForBaseModel(b as unknown), String(b)).toBe(null)
    }
  })

  it('still returns null for Wan — browsable, but not an SdModelFamily', () => {
    for (const b of ['Wan Video 14B t2v', 'Wan Video 2.2 I2V-A14B', 'Wan Video']) {
      expect(familyForBaseModel(b), b).toBe(null)
    }
  })

  it('does not match on a prefix (SDXL 2.0 is not SDXL 1.0)', () => {
    expect(familyForBaseModel('SDXL 2.0')).toBe(null)
    expect(familyForBaseModel('SD 1.5.1')).toBe(null)
  })
})

describe('civitaiRowId — [a-z0-9-] only (risk R10)', () => {
  it('is civitai-<versionId> and contains no colon', () => {
    expect(civitaiRowId(403131)).toBe('civitai-403131')
    expect(civitaiRowId(403131)).not.toContain(':')
  })

  it('every mapped row id matches the safe charset', () => {
    for (const r of rows) {
      expect(r.id, r.id).toMatch(/^[a-z0-9-]+$/)
      expect(r.id).toBe(`civitai-${r.versionId}`)
    }
  })
})

describe('pickPrimaryFile — `primary` is true-or-ABSENT, never false', () => {
  it('finds the flagged primary among siblings', () => {
    const files = [{ name: 'a', type: 'VAE' }, { name: 'b', primary: true, type: 'Model' }]
    expect(pickPrimaryFile(files)!.name).toBe('b')
  })

  it('falls back to the first type:Model, then to files[0]', () => {
    expect(pickPrimaryFile([{ name: 'a', type: 'Config' }, { name: 'b', type: 'Model' }])!.name).toBe('b')
    expect(pickPrimaryFile([{ name: 'a', type: 'Config' }])!.name).toBe('a')
    expect(pickPrimaryFile([])).toBe(null)
    expect(pickPrimaryFile(null)).toBe(null)
  })

  it('picks the .safetensors primary out of Realistic Vision V6.0 B1 (2 real files)', () => {
    const v = rawPage.items.find((m: { id: number }) => m.id === 4201)!.modelVersions[0]
    expect(v.files.length).toBe(2)
    expect(pickPrimaryFile(v.files)!.name).toMatch(/\.safetensors$/)
  })
})

describe('normalizeTrainedWords', () => {
  it('keeps a proper array', () => {
    expect(normalizeTrainedWords(['analog style', 'modelshoot style'])).toEqual(['analog style', 'modelshoot style'])
  })

  it('splits the comma-joined single string real data ships', () => {
    expect(normalizeTrainedWords(['masterpiece, best quality,  , extra'])).toEqual(['masterpiece', 'best quality', 'extra'])
  })

  it('de-duplicates, drops junk, caps the list, and never throws', () => {
    expect(normalizeTrainedWords(['a', 'a', ' a '])).toEqual(['a'])
    expect(normalizeTrainedWords(null)).toEqual([])
    expect(normalizeTrainedWords(42)).toEqual([])
    expect(normalizeTrainedWords([Array.from({ length: 40 }, (_, i) => `w${i}`).join(',')]).length).toBe(24)
  })
})

describe('mapCivitaiPage — the row contract on live bytes', () => {
  it('drops exactly the gate-excluded models and keeps the rest', () => {
    const versionIds = rows.map(r => r.versionId).sort((a, b) => a - b)
    // 13 fixture models → 3 dropped by the SFW bitmask pass (4201, 257749, 122359)
    expect(rows.length).toBe(10)
    expect(versionIds).not.toContain(501240)   // Realistic Vision — the leak case
    expect(versionIds).not.toContain(290640)   // Pony V6 XL
    expect(versionIds).not.toContain(135867)   // Detail Tweaker XL
  })

  it('joins the name as "<model> - <version>"', () => {
    expect(row(403131).name).toBe('Animagine XL V3.1 - v3.1')
  })

  it('lowercases the SHA256 the API returns in uppercase', () => {
    const r = row(4007)
    const primary = pickPrimaryFile(protogenV4007.files)!
    const raw = (primary.hashes as { SHA256: string }).SHA256
    expect(raw).toBe(raw.toUpperCase())            // the API really is uppercase
    expect(r.sha256).toBe(raw.toLowerCase())
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the flagged primary is NOT files[0] on a real multi-file version', () => {
    // Protogen v2.2 ships FOUR files: a full SafeTensor, a pruned SafeTensor
    // (`primary: true`), and two PickleTensor variants. Taking files[0] would
    // pick the wrong artifact; taking the first `.ckpt` would install a pickle.
    expect(protogenV4007.files.length).toBe(4)
    expect(protogenV4007.files[0].primary).toBeUndefined()
    const primary = pickPrimaryFile(protogenV4007.files)!
    expect(primary.primary).toBe(true)
    expect((primary.metadata as { format: string }).format).toBe('SafeTensor')
    expect(row(4007).format).toBe('SafeTensor')
    expect(row(4007).installable).toBe(true)
  })

  it('computes sizeMb as ceil(sizeKB/1024) and NEVER under-declares', () => {
    for (const r of rows) {
      const version = rawPage.items
        .flatMap((m: { modelVersions: unknown[] }) => m.modelVersions)
        .find((v: { id: number }) => v.id === r.versionId)!
      const f = pickPrimaryFile(version.files)!
      const sizeKB = f.sizeKB as number
      expect(r.sizeMb).toBe(Math.ceil(sizeKB / 1024))
      // the load-bearing property: the declared MiB always covers the real bytes
      expect(r.sizeMb * 1024 * 1024).toBeGreaterThanOrEqual(sizeKB * 1000)
    }
  })

  it('takes downloadUrl VERBATIM from the primary file (never reconstructed)', () => {
    const r = row(4007)
    const raw = pickPrimaryFile(protogenV4007.files)!.downloadUrl as string
    expect(r.downloadUrl).toBe(raw)
    // …and it is NOT the sibling's url, which carries ?type=&format=&fp=
    expect(r.downloadUrl).not.toBe(protogenV4007.files[0].downloadUrl)
    expect(r.downloadUrl.startsWith('https://civitai.com/api/download/models/')).toBe(true)
    // …and it must never carry a token query param (leaky; downloads.json is plaintext)
    for (const x of rows) expect(x.downloadUrl).not.toMatch(/[?&]token=/)
  })

  it('carries fileName, format and fp off the primary file', () => {
    const r = row(4007)
    expect(r.fileName).toMatch(/\.safetensors$/)
    expect(r.format).toBe('SafeTensor')
    expect(['fp16', 'fp32', 'bf16', 'nf4', null]).toContain(r.fp)
  })

  it('carries the licence set, the counts and the raw type', () => {
    const r = row(403131)
    expect(r.type).toBe('Checkpoint')
    expect(r.license.commercial.length).toBeGreaterThan(0)
    expect(typeof r.license.noCredit).toBe('boolean')
    expect(typeof r.license.derivatives).toBe('boolean')
    expect(r.downloads).toBeGreaterThan(0)
    expect(r.likes).toBeGreaterThan(0)
    expect(r.nsfwLevelModel).toBe(1)
  })

  it('leaves thumbnail null — filling it is the network half\'s job', () => {
    expect(rows.every(r => r.thumbnail === null)).toBe(true)
  })

  it('survives a malformed / empty page instead of throwing', () => {
    expect(mapCivitaiPage(null)).toEqual([])
    expect(mapCivitaiPage({})).toEqual([])
    expect(mapCivitaiPage({ items: [] })).toEqual([])
    expect(mapCivitaiPage({ items: [{ id: 1, nsfwLevel: 1, modelVersions: null }] } as never)).toEqual([])
    expect(mapCivitaiPage({ items: [{ nsfwLevel: 1, modelVersions: [{ id: 2, nsfwLevel: 1 }] }] } as never)).toEqual([])
  })
})

// ─── the version fan-out ─────────────────────────────────────────────────────

describe('one row per MODEL, not per version', () => {
  // MEASURED live 2026-07-28: `/models` embeds every version inline —
  // 5 models carried 55 versions, 100 models carried 1477. A row per version
  // would make a limit=50 browse ~700 cards and ~700 thumbnail fetches.
  const file = (name: string, format: string) => ({
    name, primary: true, sizeKB: 2_000_000,
    metadata: { format, fp: 'fp16' },
    hashes: { SHA256: 'A'.repeat(64) },
    downloadUrl: `https://civitai.com/api/download/models/${name}`,
  })
  const multi = {
    items: [{
      id: 900, name: 'Many Versions', type: 'Checkpoint',
      poi: false, minor: false, nsfw: false, nsfwLevel: 1,
      tags: ['anime'], allowCommercialUse: '{Image}', allowNoCredit: false, allowDerivatives: true,
      stats: { downloadCount: 5, thumbsUpCount: 1 },
      modelVersions: [
        { id: 9001, name: 'v3', baseModel: 'SD 1.5', nsfwLevel: 1, trainedWords: [], files: [file('9001', 'PickleTensor')], images: [] },
        { id: 9002, name: 'v2', baseModel: 'SD 1.5', nsfwLevel: 1, trainedWords: [], files: [file('9002', 'SafeTensor')], images: [] },
        { id: 9003, name: 'v1', baseModel: 'SD 1.5', nsfwLevel: 1, trainedWords: [], files: [file('9003', 'SafeTensor')], images: [] },
      ],
    }],
  }

  it('collapses a 3-version model to ONE row by default', () => {
    expect(mapCivitaiPage(multi as never)).toHaveLength(1)
  })

  it('prefers the newest INSTALLABLE version over the newest one outright', () => {
    // v3 is newest but is a pickle. Showing a card that can only say "refused"
    // when a runnable v2 exists would be accurate and useless.
    const [only] = mapCivitaiPage(multi as never)
    expect(only!.versionId).toBe(9002)
    expect(only!.installable).toBe(true)
  })

  it('still shows a card (with the honest reason) when NO version is installable', () => {
    const allPickle = JSON.parse(JSON.stringify(multi)) as typeof multi
    for (const v of allPickle.items[0]!.modelVersions) v.files[0]!.metadata.format = 'PickleTensor'
    const out = mapCivitaiPage(allPickle as never)
    expect(out).toHaveLength(1)
    expect(out[0]!.versionId).toBe(9001)          // newest, as the fallback
    expect(out[0]!.installable).toBe(false)
    expect(out[0]!.reason).toBe(CIVITAI_REASONS.pickle)
  })

  it('allVersions:true returns every gate-passing version — the install lookup path', () => {
    const all = mapCivitaiPage(multi as never, { allVersions: true })
    expect(all.map(r => r.versionId)).toEqual([9001, 9002, 9003])
  })

  it('a model whose every version fails the gate contributes NO row', () => {
    const blocked = JSON.parse(JSON.stringify(multi)) as typeof multi
    blocked.items[0]!.nsfwLevel = 15
    expect(mapCivitaiPage(blocked as never)).toEqual([])
    expect(mapCivitaiPage(blocked as never, { allVersions: true })).toEqual([])
  })

  it('survives a malformed / empty page under either mode', () => {
    expect(mapCivitaiPage(null)).toEqual([])
    expect(mapCivitaiPage({})).toEqual([])
    expect(mapCivitaiPage({ items: [] })).toEqual([])
    expect(mapCivitaiPage({ items: [{ id: 1, nsfwLevel: 1, modelVersions: null }] } as never)).toEqual([])
    expect(mapCivitaiPage({ items: [{ nsfwLevel: 1, modelVersions: [{ id: 2, nsfwLevel: 1 }] }] } as never)).toEqual([])
  })
})

describe('run-truth verdicts on the real rows', () => {
  it('INSTALLABLE: the three single-file checkpoints our engine runs', () => {
    for (const [vid, family] of [[4007, 'sd15'], [403131, 'sdxl'], [889818, 'sdxl']] as const) {
      const r = row(vid)
      expect(r.installable, r.name).toBe(true)
      expect(r.reason).toBeUndefined()
      expect(r.family).toBe(family)
      expect(r.sha256).not.toBe(null)
    }
  })

  it('Illustrious is mapped to sdxl — the whole leverage of the SDXL row', () => {
    expect(row(889818).baseModel).toBe('Illustrious')
    expect(row(889818).family).toBe('sdxl')
  })

  it('REFUSED: PickleTensor, and the pickle reason OUTRANKS the phase-2 reason', () => {
    // 1274 Dreamlike Diffusion — a Checkpoint that would otherwise install.
    const ckpt = row(1356)
    expect(ckpt.type).toBe('Checkpoint')
    expect(ckpt.family).toBe('sd15')
    expect(ckpt.format).toBe('PickleTensor')
    expect(ckpt.installable).toBe(false)
    expect(ckpt.reason).toBe(CIVITAI_REASONS.pickle)

    // 65214 Age Slider — a TextualInversion in PickleTensor. Two blockers; the
    // one the user is told about is the safety one.
    const embed = row(94703)
    expect(embed.type).toBe('TextualInversion')
    expect(embed.format).toBe('PickleTensor')
    expect(embed.reason).toBe(CIVITAI_REASONS.pickle)
  })

  it('REFUSED: Flux says it needs a component bundle, not "unsupported"', () => {
    const r = row(691639)
    expect(r.baseModel).toBe('Flux.1 D')
    expect(r.family).toBe(null)
    expect(r.installable).toBe(false)
    expect(r.reason).toBe(CIVITAI_REASONS.flux)
  })

  // PHASE 3 flipped the adapter verdict: a LoRA / LoCon / embedding / VAE is
  // installable ON TOP OF an installed checkpoint of the same family. With NO
  // checkpoint installed — which is what `rows` is mapped with — the refusal
  // must name the base to install, not a phase number.
  it('REFUSED: adapters name the BASE they need, not a phase', () => {
    const lora = row(32988)                                       // LORA, SD 1.5
    expect(lora.reasonCode).toBe('needs-base')
    expect(lora.reason).toContain('SD 1.5 checkpoint')
    expect(lora.reason).toContain('LoRA')

    const vae = row(311162)                                       // VAE, SD 1.5
    expect(vae.reasonCode).toBe('needs-base')
    expect(vae.reason).toContain('SD 1.5 checkpoint')
    expect(vae.reason).toContain('VAE')
    // "a SD 1.5" is wrong — the article follows the sound, and both SD and SDXL
    // open on "ess". A vowel-letter test would get both backwards.
    expect(vae.reason).toMatch(/^Needs an SD 1\.5 /)
    expect(civitaiNeedsBaseReason('sdxl', 'LORA')).toMatch(/^Needs an SDXL /)
    expect(civitaiNeedsBaseReason('flux', 'LORA')).toMatch(/^Needs a Flux /)

    // Upscaler is NOT an adapter in this engine — it keeps its phase reason.
    expect(row(164821).reason).toBe(CIVITAI_REASONS.upscaler)
    expect(row(164821).reasonCode).toBe('upscaler')
  })

  it('REFUSED: an unmapped base model on a Checkpoint', () => {
    const r = row(85159)   // Roop, baseModel 'Other'
    expect(r.type).toBe('Checkpoint')
    expect(r.family).toBe(null)
    expect(r.reason).toBe(CIVITAI_REASONS.unsupportedBase)
  })

  it('every non-installable row carries a reason AND a code; installable ones carry neither', () => {
    for (const r of rows) {
      if (r.installable) {
        expect(r.reason, r.name).toBeUndefined()
        expect(r.reasonCode, r.name).toBeUndefined()
      } else {
        expect(r.reason, r.name).toBeTruthy()
        // The CODE is the closed set a UI can key i18n off; the PROSE is not,
        // because `needs-base` varies with the family it names.
        expect(CIVITAI_REASON_CODES, r.name).toContain(r.reasonCode)
      }
    }
  })

  it('is an ALLOWLIST: an unknown future type is refused, not waved through', () => {
    const v = civitaiInstallVerdict({
      type: 'SomeBrandNewTypeCivitaiAddsIn2027',
      family: 'sdxl', baseModel: 'SDXL 1.0', format: 'SafeTensor',
      sha256: 'a'.repeat(64), downloadUrl: 'https://civitai.com/api/download/models/1',
    })
    expect(v.installable).toBe(false)
    expect(v.reason).toBe(CIVITAI_REASONS.unsupportedType)
  })

  it('refuses a hash-less file even when everything else is perfect', () => {
    const v = civitaiInstallVerdict({
      type: 'Checkpoint', family: 'sd15', baseModel: 'SD 1.5', format: 'SafeTensor',
      sha256: null, downloadUrl: 'https://civitai.com/api/download/models/1',
    })
    expect(v).toEqual({ installable: false, reason: CIVITAI_REASONS.noHash, reasonCode: 'no-hash' })
  })

  it('refuses a version with no downloadable file', () => {
    const v = civitaiInstallVerdict({
      type: 'Checkpoint', family: 'sd15', baseModel: 'SD 1.5', format: 'SafeTensor',
      sha256: 'a'.repeat(64), downloadUrl: '',
    })
    expect(v).toEqual({ installable: false, reason: CIVITAI_REASONS.noFile, reasonCode: 'no-file' })
  })
})

describe('pgPreviewUrl', () => {
  it('returns the first level-1 https image', () => {
    const v = rawPage.items.find((m: { id: number }) => m.id === 260267)!.modelVersions[0]
    expect(pgPreviewUrl(v)).toMatch(/^https:\/\/image\.civitai\.com\//)
  })

  it('returns null when nothing is PG, and never accepts http:', () => {
    expect(pgPreviewUrl({ images: [{ url: 'https://x/a.jpg', nsfwLevel: 4, type: 'image' }] })).toBe(null)
    expect(pgPreviewUrl({ images: [{ url: 'http://x/a.jpg', nsfwLevel: 1, type: 'image' }] })).toBe(null)
    expect(pgPreviewUrl({ images: [] })).toBe(null)
    expect(pgPreviewUrl(null)).toBe(null)
  })
})

describe('buildCivitaiSearchUrl — cursor pagination, nsfw=false always', () => {
  const parse = (u: string) => new URL(u)

  it('always sends nsfw=false and NEVER a page param', () => {
    const u = parse(buildCivitaiSearchUrl({ query: 'anime' }))
    expect(u.searchParams.get('nsfw')).toBe('false')
    expect(u.searchParams.has('page')).toBe(false)
    expect(u.origin + u.pathname).toBe('https://civitai.com/api/v1/models')
  })

  it('clamps limit to 1..100', () => {
    expect(parse(buildCivitaiSearchUrl({ limit: 500 })).searchParams.get('limit')).toBe('100')
    expect(parse(buildCivitaiSearchUrl({ limit: 0 })).searchParams.get('limit')).toBe('1')
    expect(parse(buildCivitaiSearchUrl({ limit: 7.9 })).searchParams.get('limit')).toBe('7')
    expect(parse(buildCivitaiSearchUrl({})).searchParams.get('limit')).toBe('50')
  })

  it('repeats types and baseModels (the repeatable-param run-truth filter)', () => {
    const u = parse(buildCivitaiSearchUrl({ types: ['Checkpoint', 'LORA'], baseModels: ['SD 1.5', 'SDXL 1.0'] }))
    expect(u.searchParams.getAll('types')).toEqual(['Checkpoint', 'LORA'])
    expect(u.searchParams.getAll('baseModels')).toEqual(['SD 1.5', 'SDXL 1.0'])
    expect(u.search).toContain('baseModels=SD+1.5&baseModels=SDXL+1.0')
  })

  it('round-trips the pipe-bearing opaque cursor', () => {
    const cursor = '155969|8154|2458426'
    const u = parse(buildCivitaiSearchUrl({ cursor }))
    expect(u.searchParams.get('cursor')).toBe(cursor)
    expect(u.search).toContain('cursor=155969%7C8154%7C2458426')
    // sort is dropped once paging — mixing it with a cursor re-anchors the page
    expect(u.searchParams.has('sort')).toBe(false)
  })

  it('omits an empty query rather than sending query=', () => {
    expect(parse(buildCivitaiSearchUrl({ query: '   ' })).searchParams.has('query')).toBe(false)
    expect(parse(buildCivitaiSearchUrl({ query: 'a b' })).searchParams.get('query')).toBe('a b')
  })
})
