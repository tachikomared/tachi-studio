// apps/desktop/test/unit/civitaiDetailMapping.test.ts
//
// THE DETAIL PAYLOAD, asserted against BYTES THE LIVE API ACTUALLY RETURNED.
//
// Two fixtures, both captured 2026-07-31 from GET /api/v1/models/{id} and
// trimmed to the fields the detail mapper reads:
//
//   model-detail.json       260267 Animagine XL V3.1 — model nsfwLevel 1, so it
//                           PASSES the SFW gate. 3 versions, an 11 265-byte
//                           description, per-version descriptions null/2503/927,
//                           every image at level 1. The happy path — and the
//                           same model models-page.json already pins as an
//                           installable SDXL checkpoint, so the two fixtures
//                           agree about the row.
//   model-detail-nsfw.json  4201 Realistic Vision V6.0 B1 — model nsfwLevel 15,
//                           so the SFW gate REFUSES it outright. Per-version
//                           levels 15/1/7/1 and images at levels 1, 2, 4 and 8.
//
// ─── THE MEASUREMENT THAT SHAPED THIS FILE ───────────────────────────────────
// The by-id endpoint DOES NOT HONOUR `nsfw`. Measured the same day:
//   GET /models?limit=24&nsfw=false  → model 4201 v501240 carried 16 images,
//                                      EVERY ONE at level 1
//   GET /models/4201                 → the same version carried 20 images at
//                                      levels [2,1,1,1,4,1,1,1,1,2,1,1,1,1,1,
//                                      1,1,1,1,8]
//   GET /models/4201?nsfw=false      → 20 images. IDENTICAL. The param is
//                                      ignored on this endpoint.
// i.e. the LIST pre-clamps images to PG and the BY-ID endpoint serves the raw
// set — R (4) and X (8) included, in SFW mode, with no key. So the detail's
// gallery cannot lean on the request parameter the way the grid's thumbnail
// picker safely does; it has to run the bitmask gate itself. It does, through
// the SAME civitai-gate.ts predicates the grid uses — that is what these tests
// pin, and they pin it as a BITMASK rather than an ordinal.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Same stubs as civitaiMapping.test.ts: the keychain and the egress policy both
// reach electron at module scope and neither participates in the pure mapping.
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: () => null,
  hasKey: () => false,
}))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import {
  mapCivitaiModelDetail,
  mapCivitaiPageCounted,
  pickPreviewImages,
  civitaiModelPageUrl,
  CIVITAI_DETAIL_MAX_VERSIONS,
  CIVITAI_DETAIL_MAX_PREVIEWS,
  CIVITAI_REASONS,
} from '../../electron/services/civitai-search'
// The PANEL's reader for the two counters this file produces. Imported here on
// purpose: the counters are only worth anything if the line the panel prints is
// asserted against a REAL payload, and the renderer's own suite can only feed it
// hand-built objects.
import { civitaiVersionNotice } from '../../src/pages/catalog/civitaiDetail'
import type { CivitaiModelDetail } from '../../src/types/electron'

const FIXTURES = fileURLToPath(new URL('../fixtures/civitai/', import.meta.url))
const read = (f: string) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))
const SFW_MODEL = read('model-detail.json')
const NSFW_MODEL = read('model-detail-nsfw.json')
const PAGE = read('models-page.json')

/** The panel reads main's payload through the renderer's mirrored type. */
const asPanelDetail = (d: unknown): CivitaiModelDetail => d as CivitaiModelDetail

describe('mapCivitaiModelDetail — the happy path (260267, SFW)', () => {
  const { detail } = mapCivitaiModelDetail(SFW_MODEL, { adult: false })

  it('carries the identity fields the panel leads with', () => {
    expect(detail.modelId).toBe(260267)
    expect(detail.name).toBe('Animagine XL V3.1')
    expect(detail.type).toBe('Checkpoint')
    expect(detail.adult).toBe(false)
  })

  it('carries the FULL description verbatim — parsing is the renderer\'s job', () => {
    // 11 265 bytes, unmodified. Main must not "clean" it: the renderer parses it
    // into a block tree (civitaiHtml.ts), and a half-sanitised string handed
    // across IPC would be a second, weaker sanitizer nobody tests.
    expect(detail.description).toBe(SFW_MODEL.description)
    expect(detail.description!.length).toBe(11265)
  })

  it('carries the creator USERNAME and deliberately not their avatar url', () => {
    expect(detail.creator).toEqual({ username: 'CagliostroLab' })
    // The avatar is a remote image.civitai.com url. Rendering it would cost
    // another main-side fetch + base64 for a 96px decoration, so it is dropped
    // rather than shipped as a url the CSP forbids the renderer from loading.
    expect(JSON.stringify(detail)).not.toContain('CagliostroLab.jpeg')
  })

  it('carries the two stats the card already shows, from the model level', () => {
    expect(detail.downloads).toBe(SFW_MODEL.stats.downloadCount)
    expect(detail.likes).toBe(SFW_MODEL.stats.thumbsUpCount)
  })

  it('links to the model page on the host it was served from', () => {
    expect(detail.pageUrl).toBe('https://civitai.com/models/260267')
    expect(detail.versions[0]!.pageUrl).toBe('https://civitai.com/models/260267?modelVersionId=403131')
  })

  it('maps every version that passes the gate, newest first', () => {
    expect(detail.versions.map(v => v.versionId)).toEqual([403131, 293564, 297102])
    expect(detail.filteredVersionCount).toBe(0)
    expect(detail.versionsTotal).toBe(3)
  })

  it('gives each version its own description, base model, file and trigger words', () => {
    const [v31, v30, v30base] = detail.versions
    expect(v31!.name).toBe('v3.1')
    // v3.1 genuinely has no description on the live API — `null`, not ''.
    expect(v31!.description).toBeNull()
    expect(v30!.description).toBe(SFW_MODEL.modelVersions[1].description)
    expect(v30!.description!.length).toBe(2503)
    expect(v30base!.description!.length).toBe(927)
    for (const v of detail.versions) {
      expect(v.baseModel).toBe('SDXL 1.0')
      expect(v.family).toBe('sdxl')
      expect(v.format).toBe('SafeTensor')
      expect(v.sizeMb).toBeGreaterThan(0)
      expect(v.fileName).toMatch(/\.safetensors$/i)
      expect(Array.isArray(v.trainedWords)).toBe(true)
    }
  })

  it('reuses the grid\'s row id so an installed version is recognisable', () => {
    expect(detail.versions.map(v => v.id)).toEqual(['civitai-403131', 'civitai-293564', 'civitai-297102'])
  })

  it('carries publishedAt as the API\'s own ISO string, never a reformatted date', () => {
    expect(detail.versions[0]!.publishedAt).toBe(SFW_MODEL.modelVersions[0].publishedAt)
  })

  it('runs the SAME install verdict as the grid — an SDXL checkpoint installs', () => {
    for (const v of detail.versions) {
      expect(v.installable).toBe(true)
      expect(v.reason).toBeUndefined()
    }
  })

  it('carries the licence, parsed as a SET (the postgres array literal)', () => {
    // The fixture's raw value is the string "{Image,RentCivit,Rent}" — parsed as
    // a SET and returned SORTED, so equality here is order-independent by
    // construction (live data shipped the same three members in two orders).
    expect(SFW_MODEL.allowCommercialUse).toBe('{Image,RentCivit,Rent}')
    expect(detail.license.commercial).toEqual(['Image', 'Rent', 'RentCivit'])
    expect(typeof detail.license.noCredit).toBe('boolean')
    expect(typeof detail.license.derivatives).toBe('boolean')
  })
})

describe('mapCivitaiModelDetail — the verdict is main\'s, not the panel\'s', () => {
  it('refuses an adapter with no base on disk, naming what to install', () => {
    const lora = {
      ...SFW_MODEL, id: 25995, type: 'LORA',
      modelVersions: [SFW_MODEL.modelVersions[0]],
    }
    const { detail } = mapCivitaiModelDetail(lora, { adult: false })
    const v = detail.versions[0]!
    expect(v.installable).toBe(false)
    expect(v.reasonCode).toBe('needs-base')
    // The prominent sentence the panel renders — main's words, not the panel's.
    expect(v.reason).toContain('SDXL checkpoint')
  })

  it('allows the same adapter once its family is installed', () => {
    const lora = {
      ...SFW_MODEL, id: 25995, type: 'LORA',
      modelVersions: [SFW_MODEL.modelVersions[0]],
    }
    const { detail } = mapCivitaiModelDetail(lora, {
      adult: false,
      installedFamilies: new Set(['sdxl' as const]),
    })
    expect(detail.versions[0]!.installable).toBe(true)
  })

  it('refuses a PickleTensor version on safety before any capability reason', () => {
    const v0 = SFW_MODEL.modelVersions[0]
    const pickled = {
      ...SFW_MODEL,
      modelVersions: [{
        ...v0,
        files: v0.files.map((f: Record<string, unknown>) => ({
          ...f, metadata: { ...(f.metadata as object), format: 'PickleTensor' },
        })),
      }],
    }
    const { detail } = mapCivitaiModelDetail(pickled, { adult: false })
    expect(detail.versions[0]!.reasonCode).toBe('pickle')
    expect(detail.versions[0]!.reason).toBe(CIVITAI_REASONS.pickle)
  })

  it('bounds the version list and says how many there really were', () => {
    const many = {
      ...SFW_MODEL,
      modelVersions: Array.from({ length: 40 }, (_, i) => ({
        ...SFW_MODEL.modelVersions[0], id: 900000 + i, name: `v${i}`,
      })),
    }
    const { detail } = mapCivitaiModelDetail(many, { adult: false })
    expect(detail.versions).toHaveLength(CIVITAI_DETAIL_MAX_VERSIONS)
    // The honest total is the number the panel prints, not the number it shows.
    expect(detail.versionsTotal).toBe(40)
  })
})

describe('mapCivitaiModelDetail — the gate governs the detail too', () => {
  it('refuses every version of a model the SFW ceiling excludes (4201, level 15)', () => {
    const { detail } = mapCivitaiModelDetail(NSFW_MODEL, { adult: false })
    // model.nsfwLevel is 15 = PG|PG13|R|X. layer1SfwPass tests BOTH levels, so
    // no version of this model is showable in SFW mode however clean the
    // version itself is (v501286 and v130090 are both level 1).
    expect(detail.versions).toEqual([])
    expect(detail.filteredVersionCount).toBe(4)
    expect(detail.versionsTotal).toBe(4)
  })

  it('admits the level-1 and level-15 versions under the ADULT ceiling', () => {
    const { detail } = mapCivitaiModelDetail(NSFW_MODEL, { adult: true })
    // Ceiling 31 = PG|PG13|R|X|XXX. All four version levels (15/1/7/1) pass it.
    expect(detail.versions.map(v => v.nsfwLevel)).toEqual([15, 1, 7, 1])
    expect(detail.filteredVersionCount).toBe(0)
    expect(detail.adult).toBe(true)
  })

  it('points an adult detail at civitai.red, not at .com', () => {
    const { detail } = mapCivitaiModelDetail(NSFW_MODEL, { adult: true })
    expect(detail.pageUrl).toBe('https://civitai.red/models/4201')
  })

  it('excludes a poi / minor / taken-down model whatever the mode', () => {
    for (const flag of [{ poi: true }, { minor: true }, { mode: 'TakenDown' }]) {
      for (const adult of [false, true]) {
        const { detail } = mapCivitaiModelDetail({ ...SFW_MODEL, ...flag }, { adult })
        expect(detail.versions).toEqual([])
      }
    }
  })

  it('excludes a model whose name carries a denied token, in both modes', () => {
    for (const adult of [false, true]) {
      const { detail } = mapCivitaiModelDetail({ ...SFW_MODEL, name: 'cute loli mix' }, { adult })
      expect(detail.versions).toEqual([])
    }
  })
})

describe('pickPreviewImages — the bitmask, never an ordinal', () => {
  const v501240 = NSFW_MODEL.modelVersions[0]   // images at levels 1,2,4,8

  it('takes ONLY level-1 images in SFW mode, even though by-id served R and X', () => {
    const picks = pickPreviewImages(v501240, false, 8)
    expect(picks.length).toBeGreaterThan(0)
    expect(picks.map(p => p.level)).toEqual(picks.map(() => 1))
    // Proof this matters: the raw version really does carry higher levels.
    expect(v501240.images.map((i: { nsfwLevel: number }) => i.nsfwLevel)).toContain(8)
  })

  it('caps the count', () => {
    expect(pickPreviewImages(v501240, false, 3)).toHaveLength(3)
    expect(pickPreviewImages(v501240, true, 2)).toHaveLength(2)
  })

  it('orders adult picks LEAST EXPLICIT FIRST, so a gallery opens on the mildest', () => {
    const picks = pickPreviewImages(v501240, true, 20)
    const levels = picks.map(p => p.level)
    expect(levels).toEqual([...levels].sort((a, b) => a - b))
    expect(levels[0]).toBe(1)
    expect(levels).toContain(8)
  })

  it('refuses the Blocked bit in ADULT mode — a bitmask test, not level <= 31', () => {
    // 32 is Blocked alone: numerically it is NOT greater than 31 in a way an
    // ordinal `level <= 60` check would catch, and 33 (PG|Blocked) is greater
    // than 31 only by luck. `& ~31` refuses both.
    const version = {
      images: [
        { url: 'https://image.civitai.com/a/original=true/a.jpeg', nsfwLevel: 32, type: 'image' },
        { url: 'https://image.civitai.com/b/original=true/b.jpeg', nsfwLevel: 33, type: 'image' },
        { url: 'https://image.civitai.com/c/original=true/c.jpeg', nsfwLevel: 16, type: 'image' },
      ],
    }
    const picks = pickPreviewImages(version, true, 8)
    expect(picks.map(p => p.level)).toEqual([16])
  })

  it('refuses level 0 / missing / fractional levels as UNKNOWN, in both modes', () => {
    const version = {
      images: [
        { url: 'https://image.civitai.com/a/original=true/a.jpeg', nsfwLevel: 0, type: 'image' },
        { url: 'https://image.civitai.com/b/original=true/b.jpeg', type: 'image' },
        { url: 'https://image.civitai.com/c/original=true/c.jpeg', nsfwLevel: 1.5, type: 'image' },
        { url: 'https://image.civitai.com/d/original=true/d.jpeg', nsfwLevel: -1, type: 'image' },
      ],
    }
    expect(pickPreviewImages(version, false, 8)).toEqual([])
    expect(pickPreviewImages(version, true, 8)).toEqual([])
  })

  it('refuses videos and non-https urls', () => {
    const version = {
      images: [
        { url: 'https://image.civitai.com/a/original=true/a.mp4', nsfwLevel: 1, type: 'video' },
        { url: 'http://image.civitai.com/b/original=true/b.jpeg', nsfwLevel: 1, type: 'image' },
        { url: 'https://image.civitai.com/c/original=true/c.jpeg', nsfwLevel: 1, type: 'image' },
      ],
    }
    expect(pickPreviewImages(version, false, 8).map(p => p.url)).toEqual([
      'https://image.civitai.com/c/original=true/c.jpeg',
    ])
  })

  it('de-duplicates identical urls', () => {
    const url = 'https://image.civitai.com/a/original=true/a.jpeg'
    const version = { images: [{ url, nsfwLevel: 1, type: 'image' }, { url, nsfwLevel: 1, type: 'image' }] }
    expect(pickPreviewImages(version, false, 8)).toHaveLength(1)
  })

  it('is empty for a version with no images at all', () => {
    expect(pickPreviewImages({ images: [] }, false, 4)).toEqual([])
    expect(pickPreviewImages(null, false, 4)).toEqual([])
    expect(pickPreviewImages(undefined, true, 4)).toEqual([])
  })
})

describe('the preview picks the mapper hands the network half', () => {
  it('picks images for the REQUESTED version, capped', () => {
    const { previewPicks } = mapCivitaiModelDetail(NSFW_MODEL, { adult: true, versionId: 130072 })
    const picks = previewPicks.get(130072)
    expect(picks).toBeDefined()
    expect(picks!.length).toBeLessThanOrEqual(CIVITAI_DETAIL_MAX_PREVIEWS)
    expect(picks!.length).toBeGreaterThan(0)
  })

  it('puts the requested version FIRST, so the gallery matches the card clicked', () => {
    const { detail } = mapCivitaiModelDetail(NSFW_MODEL, { adult: true, versionId: 130072 })
    expect(detail.versions[0]!.versionId).toBe(130072)
    // and the rest keep their API order behind it
    expect(detail.versions.map(v => v.versionId)).toEqual([130072, 501240, 501286, 130090])
  })

  it('falls back to the newest gated version when no versionId is asked for', () => {
    const { detail, previewPicks } = mapCivitaiModelDetail(SFW_MODEL, { adult: false })
    expect(detail.versions[0]!.versionId).toBe(403131)
    expect(previewPicks.get(403131)!.length).toBeGreaterThan(0)
  })

  it('picks nothing when the gate emptied the model', () => {
    const { detail, previewPicks } = mapCivitaiModelDetail(NSFW_MODEL, { adult: false })
    expect(detail.versions).toEqual([])
    expect(previewPicks.size).toBe(0)
  })

  it('never leaks a remote url onto the detail itself', () => {
    const { detail } = mapCivitaiModelDetail(SFW_MODEL, { adult: false })
    // `previews` are data: URIs filled in by main. The remote urls stay in the
    // side channel, because the prod CSP has no https: in img-src and a remote
    // <img> in the panel would be one request per sample to a CDN we do not
    // control.
    for (const v of detail.versions) expect(v.previews).toEqual([])
    expect(JSON.stringify(detail)).not.toContain('image.civitai.com')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE ROW CARRIES THE MODEL PAGE URL, SO FRAME 1 HAS THE ONE LIVE CONTROL
// ═══════════════════════════════════════════════════════════════════════════
//
// Driver-found: "Open on Civitai" was missing until the by-id fetch landed,
// because only the DETAIL payload carried `pageUrl`. The panel opens on the row,
// so the row has to carry it — built in MAIN from the resolved mode, exactly like
// the detail's, which is also what makes the button not change when the fetch
// arrives.

describe('the search row carries the version page url', () => {
  it('builds it for every row, on the host the page was served from', () => {
    const { rows } = mapCivitaiPageCounted(PAGE, { adult: false })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.pageUrl).toBe(`https://civitai.com/models/${row.modelId}?modelVersionId=${row.versionId}`)
    }
  })

  it('follows the RESOLVED mode to .red, never a renderer choice', () => {
    const { rows } = mapCivitaiPageCounted(PAGE, { adult: true })
    const row = rows.find(r => r.modelId === 4201)!
    expect(row.pageUrl).toBe('https://civitai.red/models/4201?modelVersionId=501240')
  })

  it('is the SAME string the detail hands back, so the button does not change', () => {
    // 260267's grid row and its detail resolve to the same version (403131), and
    // both urls come out of civitaiModelPageUrl — this is the property the panel
    // relies on when it prefers the fetched value but renders the row's first.
    const row = mapCivitaiPageCounted(PAGE, { adult: false }).rows.find(r => r.modelId === 260267)!
    const { detail } = mapCivitaiModelDetail(SFW_MODEL, { adult: false, versionId: row.versionId })
    expect(row.versionId).toBe(403131)
    expect(row.pageUrl).toBe(detail.versions[0]!.pageUrl)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE TWO HONEST COUNTERS, AGAINST REAL PAYLOADS
// ═══════════════════════════════════════════════════════════════════════════
//
// A driver reported `filteredVersionCount: 0` on every model it opened and read
// this as "the counter never fires". It is the TRUE answer for those models: it
// counts versions the GATE refused, and the driver was browsing with 18+
// unlocked, where the ceiling is 31 and almost nothing is refused. (`hidden` is
// common in the OTHER direction — see the SFW case below.) The counters are wired
// mapper → payload → panel; these tests pin both branches and their precedence on
// bytes the API really returned, so "never fires" cannot be claimed again without
// contradicting a test.

describe('the version notice the panel prints, computed from a real payload', () => {
  it('HIDDEN: the SFW ceiling refuses all 4 versions of 4201 and says so', () => {
    // The reachable path is documented in fetchCivitaiModelDetail: the unlock
    // lapsed between the browse and the click (the key was removed), so a model
    // that was visible on .red is re-read on .com and the gate empties it. Zero
    // versions with no explanation reads as a broken panel; this is the line.
    const { detail } = mapCivitaiModelDetail(NSFW_MODEL, { adult: false })
    expect(detail.filteredVersionCount).toBe(4)
    expect(civitaiVersionNotice(asPanelDetail(detail))).toEqual({ kind: 'hidden', count: 4 })
  })

  it('CAPPED: 12 versions of the same fixture model shows 8 and prints the total', () => {
    const many = {
      ...SFW_MODEL,
      modelVersions: Array.from({ length: 12 }, (_, i) => ({
        ...SFW_MODEL.modelVersions[0], id: 900000 + i, name: `v${i}`,
      })),
    }
    const { detail } = mapCivitaiModelDetail(many, { adult: false })
    expect(detail.versions).toHaveLength(CIVITAI_DETAIL_MAX_VERSIONS)
    expect(detail.filteredVersionCount).toBe(0)
    expect(detail.versionsTotal).toBe(12)
    expect(civitaiVersionNotice(asPanelDetail(detail))).toEqual({ kind: 'capped', shown: 8, total: 12 })
  })

  it('PRECEDENCE: a refusal outranks a cap when both are true', () => {
    // Three of the twelve carry the Blocked bit (32) — a level the live API
    // really serves (measured: 3 of 4 095 images in a 20-model adult sample), and
    // one layer 0 refuses in BOTH modes. So 9 survive, 8 are shown, 3 were
    // refused: the reader needs the missing version explained, not the truncation.
    const mixed = {
      ...SFW_MODEL,
      modelVersions: Array.from({ length: 12 }, (_, i) => ({
        ...SFW_MODEL.modelVersions[0],
        id: 900000 + i,
        name: `v${i}`,
        nsfwLevel: i < 3 ? 32 : 1,
      })),
    }
    const { detail } = mapCivitaiModelDetail(mixed, { adult: false })
    expect(detail.versions).toHaveLength(CIVITAI_DETAIL_MAX_VERSIONS)
    expect(detail.filteredVersionCount).toBe(3)
    expect(detail.versionsTotal).toBe(12)
    expect(civitaiVersionNotice(asPanelDetail(detail))).toEqual({ kind: 'hidden', count: 3 })
  })

  it('SAYS NOTHING when the payload really has nothing to report', () => {
    // 260267 in SFW mode: 3 versions, all shown, none refused. `0` here is the
    // honest answer the driver saw — not a broken counter — and the panel prints
    // no line at all rather than a permanent "0 hidden".
    const { detail } = mapCivitaiModelDetail(SFW_MODEL, { adult: false })
    expect(detail.filteredVersionCount).toBe(0)
    expect(detail.versionsTotal).toBe(3)
    expect(civitaiVersionNotice(asPanelDetail(detail))).toBeNull()
  })

  it('there is no `totalVersionCount` — the field is `versionsTotal`', () => {
    // The driver also reported `totalVersionCount: undefined`. That name has never
    // existed in this app; reading it can only ever be undefined. Pinned so the
    // next reader of that report does not go looking for a wiring bug.
    const { detail } = mapCivitaiModelDetail(SFW_MODEL, { adult: false })
    expect(Object.keys(detail)).toContain('versionsTotal')
    expect(Object.keys(detail)).not.toContain('totalVersionCount')
  })
})

describe('civitaiModelPageUrl', () => {
  it('builds the mode-correct model url, version optional', () => {
    expect(civitaiModelPageUrl(123, false)).toBe('https://civitai.com/models/123')
    expect(civitaiModelPageUrl(123, true)).toBe('https://civitai.red/models/123')
    expect(civitaiModelPageUrl(123, false, 456)).toBe('https://civitai.com/models/123?modelVersionId=456')
  })

  it('refuses to build a url for a nonsense id', () => {
    expect(civitaiModelPageUrl(-1, false)).toBeNull()
    expect(civitaiModelPageUrl(Number.NaN, false)).toBeNull()
    expect(civitaiModelPageUrl(1.5, false)).toBeNull()
  })
})
