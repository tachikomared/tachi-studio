// apps/desktop/test/unit/civitaiCatalogTab.test.ts
//
// PHASE1 LANE D — the Catalog `civitai` source tab + the Settings key card.
//
// Two halves, both runnable in the node environment (vitest.config.ts pins
// `environment: 'node'` — there is no DOM here and the renderer cannot be
// mounted):
//
//   1. PURE LOGIC — everything the tab decides lives in
//      src/pages/catalog/civitaiRow.ts and src/pages/catalog/search.ts, so the
//      row→card mapping, the licence reading, the paging merge and above all
//      the INSTALL AFFORDANCE are asserted as functions.
//   2. SOURCE SWEEP — the wiring that can only be seen in the JSX is pinned by
//      reading the files, the same idiom nodesA11y / codexCardWiring use. The
//      point is regression: someone re-introducing `source === 'hf'` on the
//      popularity line, or drawing a disabled Install on a refused row, fails
//      here instead of shipping it.
//
// Plus: every i18n key this feature introduces exists, non-empty, in all 8
// locales with matching interpolation placeholders — and a button-name sweep
// over src/pages/catalog so the new controls stay reachable.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  CIVITAI_PAGE_LIMIT,
  CIVITAI_SEARCH_DEBOUNCE_MS,
  CIVITAI_TYPE_FILTERS,
  civitaiAffordance,
  civitaiCatalogEntry,
  civitaiLicenseBadges,
  civitaiRowChips,
  civitaiTypesFor,
  mergeCivitaiRows,
  normalizeFilteredCount,
  shouldShowFilteredNotice,
} from '../../src/pages/catalog/civitaiRow'
import {
  createRequestCoordinator,
  hfSearchCoordinator,
  civitaiSearchCoordinator,
} from '../../src/pages/catalog/search'
import {
  showsSizeChip,
  showsFitVerdict,
  rowSizeBytes,
  formatModelSize,
} from '../../src/pages/catalog/rowMeta'
import type { CivitaiSearchRow } from '../../src/types/electron'

const APP = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), 'utf8')

const STORE      = 'src/pages/catalog/catalog.store.ts'
const PAGE       = 'src/pages/catalog/CatalogPage.tsx'
const CARD       = 'src/pages/catalog/ModelCard.tsx'
const SEARCH     = 'src/pages/catalog/search.ts'
const SETTINGS   = 'src/pages/settings/SettingsPage.tsx'
const SETTINGS_IPC = 'electron/ipc/settings.ipc.ts'
const PRELOAD    = 'electron/preload.ts'

const LOCALES = path.join(APP, 'src/i18n/locales')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

/** A realistic installable SDXL checkpoint row (fields as main emits them). */
function mkRow(over: Partial<CivitaiSearchRow> = {}): CivitaiSearchRow {
  return {
    id: 'civitai-812345',
    modelId: 4384,
    versionId: 812345,
    name: 'Juggernaut XL - v9',
    type: 'Checkpoint',
    family: 'sdxl',
    baseModel: 'SDXL 1.0',
    sizeMb: 6763,
    sha256: '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b',
    downloadUrl: 'https://civitai.com/api/download/models/812345',
    fileName: 'juggernautXL_v9.safetensors',
    format: 'SafeTensor',
    fp: 'fp16',
    nsfwLevelModel: 1,
    downloads: 1_234_567,
    likes: 34_512,
    thumbnail: 'data:image/jpeg;base64,AAAA',
    // Built in main from the resolved mode — the panel's first-frame "Open on
    // Civitai" (see civitaiDetailMapping.test.ts for the mapper's own guard).
    pageUrl: 'https://civitai.com/models/4384?modelVersionId=812345',
    trainedWords: [],
    license: { commercial: ['Image', 'Rent'], noCredit: true, derivatives: true },
    installable: true,
    ...over,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. row → catalog card
// ═══════════════════════════════════════════════════════════════════════════

describe('civitaiCatalogEntry', () => {
  it('carries the row id verbatim — it is also the user-registry model id', () => {
    // civitai-<versionId> is what lane C's civitaiModelId() mints and what
    // sdCpp.cancelDownload() is keyed on. If the card ever re-derived it, Stop
    // would pause nothing.
    expect(civitaiCatalogEntry(mkRow()).id).toBe('civitai-812345')
  })

  it('has NO colon in the id (a colon breaks the sd Stop prefix sweep)', () => {
    expect(civitaiCatalogEntry(mkRow()).id).not.toContain(':')
    expect(civitaiCatalogEntry(mkRow()).id).toMatch(/^[a-z0-9-]+$/)
  })

  it('declares source civitai — not hf, not curated', () => {
    expect(civitaiCatalogEntry(mkRow()).source).toBe('civitai')
  })

  it('uses the DECLARED family, never a guess from the id', () => {
    expect(civitaiCatalogEntry(mkRow({ family: 'sd15' })).family).toBe('sd15')
    // An id containing "xl" must not upgrade an sd15 row — the 2bd48fc class.
    expect(civitaiCatalogEntry(mkRow({ id: 'civitai-xl-99', family: 'sd15' })).family).toBe('sd15')
  })

  it('renders an unmapped family as an empty segment, never a fabricated one', () => {
    expect(civitaiCatalogEntry(mkRow({ family: null })).family).toBe('')
  })

  it('routes through the sdcpp runtime so the honest size chip turns on', () => {
    const e = civitaiCatalogEntry(mkRow())
    expect(e.quants).toHaveLength(1)
    expect(e.quants[0].runtime).toBe('sdcpp')
    expect(e.quants[0].ref).toBe(e.id)
    // showsSizeChip is runtime-keyed (rowMeta.isMediaRow) — this is the wire.
    expect(showsSizeChip(e)).toBe(true)
  })

  it('renders the size in binary units matching the declared MiB', () => {
    const e = civitaiCatalogEntry(mkRow({ sizeMb: 6763 }))
    expect(rowSizeBytes(e)).toBe(6763 * 1024 * 1024)
    expect(formatModelSize(rowSizeBytes(e))).toBe('6.6 GB')
  })

  // W4-B FIX: this used to assert `true` — the premise in its own old name
  // ("an image checkpoint really is GPU-decided") was the bug. A Civitai
  // checkpoint is mapped to quants[0].runtime === 'sdcpp' same as every
  // curated local media row, and estimateFit()'s sizeBytes*1.2 overhead is
  // just as fabricated for a downloaded Juggernaut XL as it is for Flux or
  // Wan: resolution/offload flags decide the real peak, not the file size.
  // rowMeta.isMediaRow() is runtime-keyed, so this suppression covers Civitai
  // rows for free — see mediaFitNote() for the honest replacement ModelCard
  // renders instead (gated by civitaiShowsFitVerdict same as before, since a
  // LoRA/VAE row never had a verdict-shaped question to answer).
  it('suppresses the VRAM fit verdict too — same fabricated-verdict class as sd.cpp media rows', () => {
    expect(showsFitVerdict(civitaiCatalogEntry(mkRow()))).toBe(false)
  })

  it('degrades a missing/absurd size to 0 rather than inventing one', () => {
    expect(rowSizeBytes(civitaiCatalogEntry(mkRow({ sizeMb: 0 })))).toBe(0)
    expect(rowSizeBytes(civitaiCatalogEntry(mkRow({ sizeMb: NaN })))).toBe(0)
    expect(rowSizeBytes(civitaiCatalogEntry(mkRow({ sizeMb: -5 })))).toBe(0)
    // …and a 0 renders as nothing at all, not "0 MB".
    expect(formatModelSize(0)).toBeNull()
  })

  it('copies downloads + likes so the popularity line has data to gate on', () => {
    const e = civitaiCatalogEntry(mkRow())
    expect(e.downloads).toBe(1_234_567)
    expect(e.likes).toBe(34_512)
  })

  it('tags the modality so the row reads as an image model', () => {
    expect(civitaiCatalogEntry(mkRow()).capabilities).toEqual(['image-gen'])
  })

  it('falls back to a container label when the row declares no format', () => {
    expect(civitaiCatalogEntry(mkRow({ format: '' })).quants[0].label).toBe('SafeTensor')
  })
})

describe('civitaiRowChips', () => {
  it('orders base model, format, precision', () => {
    expect(civitaiRowChips(mkRow())).toEqual(['SDXL 1.0', 'SafeTensor', 'fp16'])
  })

  it('drops a missing precision instead of rendering an empty chip', () => {
    expect(civitaiRowChips(mkRow({ fp: null }))).toEqual(['SDXL 1.0', 'SafeTensor'])
  })

  it('drops whitespace-only values', () => {
    expect(civitaiRowChips(mkRow({ format: '   ', fp: '' }))).toEqual(['SDXL 1.0'])
  })

  it('still shows the base model of a row we cannot run — it IS the explanation', () => {
    const row = mkRow({ family: null, baseModel: 'Flux.1 D', installable: false })
    expect(civitaiRowChips(row)[0]).toBe('Flux.1 D')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. licence badges
// ═══════════════════════════════════════════════════════════════════════════

describe('civitaiLicenseBadges', () => {
  const lic = (o: Partial<CivitaiSearchRow['license']>) =>
    ({ commercial: ['Image'], noCredit: true, derivatives: true, ...o }) as CivitaiSearchRow['license']

  it('gives no badges for a fully permissive licence', () => {
    expect(civitaiLicenseBadges(lic({}))).toEqual([])
  })

  it('badges no-commercial when the commercial SET is empty ("{}" upstream)', () => {
    expect(civitaiLicenseBadges(lic({ commercial: [] }))).toContain('noCommercial')
  })

  it('does NOT badge no-commercial when any permission is present', () => {
    expect(civitaiLicenseBadges(lic({ commercial: ['Rent'] }))).not.toContain('noCommercial')
    expect(civitaiLicenseBadges(lic({ commercial: ['Image', 'RentCivit', 'Rent'] }))).not.toContain('noCommercial')
  })

  it('badges attribution when noCredit is FALSE (the field is the permission)', () => {
    // The inversion is the whole reason this is a named function: allowNoCredit
    // false means credit IS required.
    expect(civitaiLicenseBadges(lic({ noCredit: false }))).toContain('attribution')
    expect(civitaiLicenseBadges(lic({ noCredit: true }))).not.toContain('attribution')
  })

  it('badges no-derivatives when derivatives is false', () => {
    expect(civitaiLicenseBadges(lic({ derivatives: false }))).toContain('noDerivatives')
    expect(civitaiLicenseBadges(lic({ derivatives: true }))).not.toContain('noDerivatives')
  })

  it('emits every applicable badge at once', () => {
    expect(civitaiLicenseBadges({ commercial: [], noCredit: false, derivatives: false }))
      .toEqual(['noCommercial', 'attribution', 'noDerivatives'])
  })

  it('gives NO badges when there is no licence object — absence is not restriction', () => {
    expect(civitaiLicenseBadges(null)).toEqual([])
    expect(civitaiLicenseBadges(undefined)).toEqual([])
    expect(civitaiLicenseBadges('nope' as never)).toEqual([])
  })

  it('reads a MALFORMED field restrictively (present object, broken contract)', () => {
    expect(civitaiLicenseBadges({ commercial: 'Image' as never, noCredit: true, derivatives: true }))
      .toEqual(['noCommercial'])
    expect(civitaiLicenseBadges({ commercial: ['Image'] } as never))
      .toEqual(['attribution', 'noDerivatives'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE AFFORDANCE — the honesty law, as a function
// ═══════════════════════════════════════════════════════════════════════════

describe('civitaiAffordance', () => {
  it('offers Install for a runnable, not-yet-downloaded row', () => {
    expect(civitaiAffordance(mkRow(), {})).toEqual({ kind: 'install' })
  })

  it('BLOCKS a row main refused, and hands back main’s own reason', () => {
    const row = mkRow({ installable: false, reason: 'LoRA support comes in phase 2.' })
    expect(civitaiAffordance(row, {})).toEqual({ kind: 'blocked', reason: 'LoRA support comes in phase 2.' })
  })

  it('blocks anything that is not literally installable:true', () => {
    // A row from an older/foreign main build with a truthy-but-not-true value
    // must not be talked into a button.
    expect(civitaiAffordance({ installable: undefined as never }, {}).kind).toBe('blocked')
    expect(civitaiAffordance({ installable: 1 as never }, {}).kind).toBe('blocked')
    expect(civitaiAffordance({ installable: 'yes' as never }, {}).kind).toBe('blocked')
  })

  it('returns an EMPTY reason (never a made-up one) when main sent none', () => {
    expect(civitaiAffordance({ installable: false }, {})).toEqual({ kind: 'blocked', reason: '' })
    expect(civitaiAffordance({ installable: false, reason: '   ' }, {})).toEqual({ kind: 'blocked', reason: '' })
  })

  it('shows the in-flight state for the row being installed', () => {
    expect(civitaiAffordance(mkRow(), { installing: true })).toEqual({ kind: 'installing' })
  })

  it('shows Installed once the weights are on disk', () => {
    expect(civitaiAffordance(mkRow(), { installed: true })).toEqual({ kind: 'installed' })
  })

  it('KEEPS Run for on-disk weights even if the listing later refuses them', () => {
    // Order is load-bearing: installed is checked before the verdict. Bytes on
    // disk run; a remote listing changing its mind cannot un-run them.
    const row = mkRow({ installable: false, reason: 'Our engine does not run this base model yet.' })
    expect(civitaiAffordance(row, { installed: true })).toEqual({ kind: 'installed' })
  })

  it('MUTATION: a blocked-first ordering would strip Run from a working model', () => {
    const row = mkRow({ installable: false, reason: 'gone' })
    const blockedFirst = (r: typeof row, s: { installed?: boolean }) =>
      r.installable !== true ? { kind: 'blocked' as const } : s.installed ? { kind: 'installed' as const } : { kind: 'install' as const }
    expect(blockedFirst(row, { installed: true }).kind).toBe('blocked')
    expect(civitaiAffordance(row, { installed: true }).kind).toBe('installed')
  })

  it('MUTATION: a disabled-button design would still return an install kind', () => {
    // Guards the intent, not just the code: `blocked` must be its own kind, not
    // `{ kind: 'install', disabled: true }` — the card branches on the kind and
    // an install kind is what draws a button.
    const v = civitaiAffordance(mkRow({ installable: false }), {})
    expect(v.kind).toBe('blocked')
    expect(v.kind).not.toBe('install')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. cursor paging
// ═══════════════════════════════════════════════════════════════════════════

describe('mergeCivitaiRows', () => {
  const r = (id: string) => ({ id } as CivitaiSearchRow)

  it('appends the next page after the current one', () => {
    expect(mergeCivitaiRows([r('a'), r('b')], [r('c')]).map(x => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('drops a row the previous page already showed, keeping the FIRST copy', () => {
    const prev = [r('a'), r('b')]
    const merged = mergeCivitaiRows(prev, [r('b'), r('c')])
    expect(merged.map(x => x.id)).toEqual(['a', 'b', 'c'])
    expect(merged[1]).toBe(prev[1])
  })

  it('de-duplicates WITHIN the incoming page too', () => {
    expect(mergeCivitaiRows([], [r('a'), r('a'), r('b')]).map(x => x.id)).toEqual(['a', 'b'])
  })

  it('is a no-op for an empty page and never mutates the input', () => {
    const prev = [r('a')]
    expect(mergeCivitaiRows(prev, []).map(x => x.id)).toEqual(['a'])
    expect(prev).toHaveLength(1)
  })
})

describe('CIVITAI_TYPE_FILTERS', () => {
  it('offers All and Checkpoint at minimum', () => {
    const ids = CIVITAI_TYPE_FILTERS.map(f => f.id)
    expect(ids).toContain('all')
    expect(ids).toContain('checkpoint')
  })

  it('sends NO types filter for All', () => {
    expect(civitaiTypesFor('all')).toBeUndefined()
  })

  it('uses Civitai’s OWN enum spelling — the strings main’s verdict table is keyed on', () => {
    expect(civitaiTypesFor('checkpoint')).toEqual(['Checkpoint'])
    expect(civitaiTypesFor('lora')).toEqual(['LORA'])
    expect(civitaiTypesFor('embedding')).toEqual(['TextualInversion'])
  })

  it('hands back a fresh array so a caller cannot mutate the shared table', () => {
    const a = civitaiTypesFor('checkpoint')!
    a.push('Hacked')
    expect(civitaiTypesFor('checkpoint')).toEqual(['Checkpoint'])
  })

  it('keeps the page size well under the API max (thumbnail fan-out)', () => {
    expect(CIVITAI_PAGE_LIMIT).toBeGreaterThan(0)
    expect(CIVITAI_PAGE_LIMIT).toBeLessThanOrEqual(100)
  })

  it('debounces by a human typing-pause, not by a frame', () => {
    expect(CIVITAI_SEARCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(150)
    expect(CIVITAI_SEARCH_DEBOUNCE_MS).toBeLessThanOrEqual(1000)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. the stale-response coordinator — reused, not re-invented
// ═══════════════════════════════════════════════════════════════════════════

describe('request coordinators', () => {
  it('keeps the HF rule byte-for-byte: only the newest id is current', () => {
    const id1 = hfSearchCoordinator.next()
    const id2 = hfSearchCoordinator.next()
    expect(hfSearchCoordinator.isCurrent(id1)).toBe(false)
    expect(hfSearchCoordinator.isCurrent(id2)).toBe(true)
  })

  it('gives Civitai the SAME rule from the SAME factory', () => {
    const c = createRequestCoordinator()
    const a = c.next()
    const b = c.next()
    expect(c.isCurrent(a)).toBe(false)
    expect(c.isCurrent(b)).toBe(true)
  })

  it('keeps the two tabs INDEPENDENT — one tab cannot discard the other’s answer', () => {
    const hfId = hfSearchCoordinator.next()
    civitaiSearchCoordinator.next()
    civitaiSearchCoordinator.next()
    expect(hfSearchCoordinator.isCurrent(hfId)).toBe(true)
  })

  it('lets a fresh Civitai search invalidate an in-flight Load-more (shared counter)', () => {
    const pageAppend = civitaiSearchCoordinator.next()
    const reSearch = civitaiSearchCoordinator.next()
    expect(civitaiSearchCoordinator.isCurrent(pageAppend)).toBe(false)
    expect(civitaiSearchCoordinator.isCurrent(reSearch)).toBe(true)
  })

  it('exports both coordinators from the same factory call', () => {
    const src = read(SEARCH)
    expect(src).toMatch(/export function createRequestCoordinator\(\)/)
    expect(src).toMatch(/export const hfSearchCoordinator[^\n]*= createRequestCoordinator\(\)/)
    expect(src).toMatch(/export const civitaiSearchCoordinator[^\n]*= createRequestCoordinator\(\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. SOURCE SWEEP — the wiring
// ═══════════════════════════════════════════════════════════════════════════

/** Whole-line `//` comments removed so prose cannot satisfy an assertion. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(l => (l.trimStart().startsWith('//') ? '' : l))
    .join('\n')
}

/**
 * The text between two anchors, asserted NON-VACUOUS.
 *
 * Written because the naive version silently wasn't: the store declares every
 * action in its `interface CatalogStore` BEFORE implementing it, so
 * `slice(indexOf('runCivitaiSearch: async'), indexOf('setCivitaiInstalling:'))`
 * ran end-before-start and returned `''` — an empty haystack that passes every
 * `not.toContain` there is. A mutant that wrapped the fetcher in cachedFetch
 * SURVIVED against that assertion. `end` is now searched from `start`, and a
 * suspiciously short slice fails loudly.
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

describe('catalog.store — the civitai slice', () => {
  const src = stripComments(read(STORE))

  it('adds civitai to the SourceTab union (and exports it)', () => {
    expect(src).toMatch(/export type SourceTab =[^\n]*'civitai'/)
    for (const tab of ['curated', 'hf', 'installed', 'civitai']) {
      expect(src).toMatch(new RegExp(`export type SourceTab =[^\\n]*'${tab}'`))
    }
  })

  it('guards BOTH civitai fetchers with the coordinator, on success AND on failure', () => {
    const guards = src.match(/if \(!civitaiSearchCoordinator\.isCurrent\(reqId\)\) return/g) ?? []
    // runCivitaiSearch and loadMoreCivitai, each with a try and a catch arm.
    expect(guards.length).toBeGreaterThanOrEqual(4)
    expect((src.match(/civitaiSearchCoordinator\.next\(\)/g) ?? []).length).toBe(2)
  })

  it('acquires the request id BEFORE the await in both fetchers', () => {
    for (const fn of ['runCivitaiSearch', 'loadMoreCivitai']) {
      const body = src.slice(src.indexOf(`${fn}: async`))
      const idAt = body.indexOf('civitaiSearchCoordinator.next()')
      const awaitAt = body.indexOf('await window.tachi.civitai.search')
      expect(idAt).toBeGreaterThan(-1)
      expect(awaitAt).toBeGreaterThan(idAt)
    }
  })

  it('pages by CURSOR only — no page number anywhere in the slice', () => {
    expect(src).toMatch(/cursor: civitaiCursor/)
    expect(src).not.toMatch(/\bpage:\s*\d/)
    expect(src).not.toMatch(/civitaiPage\b/)
  })

  it('refuses to load more without a server-issued cursor', () => {
    expect(src).toMatch(/if \(!civitaiCursor \|\| civitaiLoading \|\| civitaiLoadingMore\) return/)
  })

  it('never caches civitai rows through cachedFetch (verdicts go stale)', () => {
    expect(between(src, 'runCivitaiSearch: async', 'loadMoreCivitai: async')).not.toContain('cachedFetch')
    expect(between(src, 'loadMoreCivitai: async', 'setCivitaiInstalling: (id)')).not.toContain('cachedFetch')
  })

  it('keeps the civitai failure out of the HF error slot and vice versa', () => {
    expect(src).toMatch(/civitaiError: string \| null/)
    expect(between(src, 'runCivitaiSearch: async', 'loadMoreCivitai: async')).not.toContain('hfError')
    expect(between(src, 'runHfSearch: async', 'setCivitaiType:')).not.toContain('civitaiError')
  })
})

describe('CatalogPage — the civitai tab', () => {
  const src = stripComments(read(PAGE))

  it('draws a fourth source tab wired to the civitai SourceTab value', () => {
    expect(src).toMatch(/setSourceTab\('civitai'\)/)
    expect(src).toMatch(/t\('tabCivitai'\)/)
  })

  it('debounces the query with the shared constant, not a magic number', () => {
    expect(src).toContain('CIVITAI_SEARCH_DEBOUNCE_MS')
    expect(src).toMatch(/setTimeout\([^\n]*CIVITAI_SEARCH_DEBOUNCE_MS\)/)
    expect(src).toMatch(/clearTimeout\(h\)/)
  })

  it('renders every row through the shared ModelCard, not a bespoke card', () => {
    expect(src).toMatch(/s\.civitaiRows\.map\(row => \(/)
    expect(src).toContain('entry={civitaiCatalogEntry(row)}')
    expect(src).toContain('civitai={row}')
  })

  it('reads the installed state from the sd.cpp merged registry', () => {
    // lane C merges the user registry into allSdModels() → sd-cpp:status →
    // catalog.store.sdInstalledIds, which isInstalled('sdcpp', …) reads.
    expect(src).toContain("installed={s.isInstalled('sdcpp', row.id)}")
  })

  it('offers Load more ONLY while the server handed back a cursor', () => {
    expect(src).toMatch(/\{s\.civitaiCursor && !s\.civitaiLoading && \(/)
    expect(src).toMatch(/loadMoreCivitai\(\)/)
  })

  it('routes install through the civitai IPC', () => {
    expect(src).toContain('window.tachi.civitai.install(row)')
  })

  it('drives the shared progress strip with the row id as the sdcpp ref', () => {
    // This is what makes the existing Stop button pause the right task.
    expect(src).toMatch(/setDownload\(\{ ref: row\.id[^\n]*runtime: 'sdcpp' \}\)/)
  })

  it('reuses the ONE chip style for both filter rows', () => {
    expect(src).toMatch(/function chip\(active: boolean\)/)
    expect(src).toMatch(/style=\{chip\(s\.activeTags\.includes\(tag\)\)\}/)
    expect(src).toMatch(/style=\{chip\(s\.civitaiType === f\.id\)\}/)
  })

  it('shows the type filter on the civitai tab and the capability tags elsewhere', () => {
    expect(src).toMatch(/\{s\.sourceTab === 'civitai' && \(/)
    expect(src).toMatch(/\{\(s\.sourceTab === 'curated' \|\| s\.sourceTab === 'hf'\) && \(/)
  })

  it('surfaces a civitai search failure on the civitai tab only', () => {
    expect(src).toMatch(/s\.civitaiError && s\.sourceTab === 'civitai'/)
  })
})

describe('ModelCard — honesty on a civitai row', () => {
  const raw = read(CARD)
  const src = stripComments(raw)

  it('gates the ↓/♥ line on the DATA, not on source === "hf"', () => {
    expect(src).toMatch(/\{\(entry\.downloads != null \|\| entry\.likes != null\) && \(/)
    expect(src).not.toContain("entry.source === 'hf'")
  })

  it('renders the reason INSTEAD of a button for a blocked row', () => {
    const start = src.indexOf("affordance.kind === 'blocked' ?")
    const end = src.indexOf("affordance.kind === 'installed' ?")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const blockedArm = src.slice(start, end)
    expect(blockedArm).toContain('affordance.reason')
    // THE HONESTY LAW: not even a disabled Install lives in this arm.
    expect(blockedArm).not.toContain('<button')
    expect(blockedArm).not.toContain('onInstall')
  })

  it('draws Install only in the install arm', () => {
    expect(src).toMatch(/<button onClick=\{onInstall\}[^\n]*>\{t\('civitai\.install'\)\}<\/button>/)
    expect((src.match(/t\('civitai\.install'\)/g) ?? []).length).toBe(1)
  })

  it('delegates the decision to the pure predicate — no verdict re-derived here', () => {
    expect(src).toMatch(/const affordance = civitai \? civitaiAffordance\(civitai, \{ installed, installing \}\) : null/)
    expect(src).not.toMatch(/civitai\.installable\s*[=!]==/)
  })

  it('hides the favorite star on a civitai row (favorites are curated-only)', () => {
    // The rule now lives in rowMeta's showsFavoriteControl, which also refuses
    // the star on a BLOCKED row (sdBlockedCatalogRow.test.ts owns that half).
    // What this suite pins is that the civitai flag still reaches it.
    expect(src).toMatch(/showsFavoriteControl\(\{ isCivitaiRow: !!civitai[^)]*\}\) && \(\s*<button/)
  })

  it('shows a data: thumbnail, and an explicit neutral box when there is none', () => {
    expect(src).toContain('src={civitai.thumbnail}')
    expect(src).toContain("t('civitai.noPreview')")
    expect(src).toMatch(/alt=""/)
    // Never a remote URL: the prod CSP img-src has no https:.
    expect(src).not.toMatch(/src=\{`https:/)
  })

  it('renders trigger words as copyable, individually labelled chips', () => {
    expect(src).toContain("t('civitai.triggerWords')")
    expect(src).toMatch(/aria-label=\{t\('civitai\.copyTrigger', \{ word \}\)\}/)
    expect(src).toMatch(/copyText\(word\)/)
  })

  it('titles each licence badge with the explanation of what it restricts', () => {
    expect(src).toMatch(/t\(`civitai\.license\.\$\{badge\}Hint`\)/)
    expect(src).toMatch(/t\(`civitai\.license\.\$\{badge\}`\)/)
  })
})

describe('preload / renderer channel agreement', () => {
  const preload = read(PRELOAD)

  it('the two channels the tab calls are the two the bridge exposes', () => {
    expect(preload).toContain("ipcRenderer.invoke('civitai:search'")
    expect(preload).toContain("ipcRenderer.invoke('civitai:install'")
  })

  it('the store calls search with a cursor, and the page calls install', () => {
    expect(read(STORE)).toContain('window.tachi.civitai.search(')
    expect(read(PAGE)).toContain('window.tachi.civitai.install(')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7. Settings key card
// ═══════════════════════════════════════════════════════════════════════════

describe('Settings — the Civitai key card', () => {
  const src = stripComments(read(SETTINGS))

  it('stores under the keychain id main reads', () => {
    expect(src).toMatch(/const CIVITAI_KEY_ID = 'civitai'/)
    expect(src).toContain('window.tachi.settings.saveKey(CIVITAI_KEY_ID')
    expect(src).toContain('window.tachi.settings.deleteKey(CIVITAI_KEY_ID)')
  })

  it('is listed by main as a NON-provider key, or the ✓ state can never appear', () => {
    // The imgnai bug, recorded in settings.ipc.ts's own comment: list-keys
    // derives provider ids from the registry, so a non-provider id must be
    // named literally.
    const ipc = read(SETTINGS_IPC)
    expect(ipc).toMatch(/const NON_PROVIDER_KEY_IDS = \[[^\]]*'civitai'/)
  })

  it('masks the input', () => {
    const card = between(src, 'function CivitaiCard', 'function HuggingFaceCard')
    expect(card).toContain('type="password"')
    expect(card).toContain('data-testid="civitai-key"')
  })

  it('shows a stored-key state with a remove control instead of the input', () => {
    const card = between(src, 'function CivitaiCard', 'function HuggingFaceCard')
    expect(card).toMatch(/hasStored \?/)
    expect(card).toContain("t('civitai.keySet')")
    expect(card).toContain("t('civitai.removeKey')")
  })

  it('re-reads list-keys after a save AND after a remove', () => {
    const card = between(src, 'function CivitaiCard', 'function HuggingFaceCard')
    expect(card).toContain('window.tachi.settings.listKeys()')
    // Four write paths now bump the refresh: save key, remove key, and the two
    // 18+ writes (lock, and the dialog's confirm). The ORIGINAL two are what
    // this test was written for — a shipped bug where removing a key left the
    // card claiming one was stored — and they are still asserted individually
    // below, so this count is a floor, not a shape.
    expect((card.match(/setRefresh\(r => r \+ 1\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(between(card, 'const save = async', 'const remove = async')).toContain('setRefresh(r => r + 1)')
    expect(between(card, 'const remove = async', 'const toggleAdult')).toContain('setRefresh(r => r + 1)')
  })

  // ── 18+ (phase 3) ───────────────────────────────────────────────────────────
  //
  // The switch in this card must NOT be the thing that turns adult browsing on.
  // A settings-list toggle is one accidental click, says nothing about what
  // changes, and leaves no timestamped record — which is exactly what the spec
  // forbids. So: ON opens the dialog, OFF writes immediately.

  it('the 18+ switch OPENS the dialog and never writes the unlock itself', () => {
    const card = between(src, 'function CivitaiCard', 'function HuggingFaceCard')
    expect(card).toContain('CivitaiAdultDialog')
    // The `next === true` branch opens the dialog and returns before any save.
    expect(card).toMatch(/if \(next\) \{ setDialogOpen\(true\); return \}/)
    // The ONLY save in the card's toggle is the LOCK patch.
    expect(card).toContain('civitaiAdultLockPatch()')
    expect(card).not.toContain('civitaiAdultUnlockPatch')
  })

  it('the switch reports MAIN’s resolved state, not the raw setting', () => {
    const card = between(src, 'function CivitaiCard', 'function HuggingFaceCard')
    expect(card).toContain('window.tachi.civitai.adultState()')
    // checked follows the derived status (which is main's `unlocked` verbatim),
    // never `adult.adultMode` — a lit switch that does nothing is the failure
    // this card exists to prevent.
    expect(card).toMatch(/checked=\{status === 'unlocked'\}/)
    expect(card).not.toMatch(/checked=\{adult[?.]*\.?adultMode\}/)
  })

  it('removing the key re-reads the 18+ state in the same pass', () => {
    const card = between(src, 'function CivitaiCard', 'function HuggingFaceCard')
    // One effect, keyed on `refresh`, reads BOTH — so deleting the credential
    // cannot leave the 18+ line stale while the key line updates.
    const effect = between(card, 'React.useEffect', '}, [refresh])')
    expect(effect).toContain('listKeys()')
    expect(effect).toContain('adultState()')
  })

  it('sits in the API KEYS section, NOT in the Providers rail and no longer under Search', () => {
    // MOVED 2026-07-31. It was filed under `search` next to Brave/Tavily —
    // internally "the non-provider keys", but the owner's actual report was
    // "I don't see where I can add my civitai and huggingface API keys". A
    // model-host credential is not something anyone hunts for under Search.
    const providers = between(src, "id: 'providers'", "id: 'agents'")
    expect(providers).not.toContain('<CivitaiCard />')

    const apiKeys = between(src, "id: 'api-keys'", "id: 'search'")
    expect(apiKeys).toContain('<CivitaiCard />')
    expect(apiKeys).toContain('<HuggingFaceCard />')

    // Search keeps the web-search keys and nothing else.
    const search = between(src, "id: 'search'", "id: 'other'")
    expect(search).toContain('<WebSearchCard />')
    expect(search).not.toContain('<CivitaiCard />')
  })

  it('opens the account page externally, never in-app', () => {
    const card = between(src, 'function CivitaiCard', 'function HuggingFaceCard')
    expect(card).toContain('window.tachi.shell.openExternal(')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8. i18n — 8 locales, matching placeholders, honest hint
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

const CATALOG_KEYS = [
  'tabCivitai',
  'civitai.searchPlaceholder', 'civitai.sfwNote', 'civitai.install',
  'civitai.loadMore', 'civitai.loadingMore', 'civitai.empty', 'civitai.emptyAfterError',
  'civitai.tryAgain', 'civitai.filteredNotice',
  'civitai.noPreview', 'civitai.triggerWords', 'civitai.copyTrigger', 'civitai.blockedFallback',
  'civitai.types.all', 'civitai.types.checkpoint', 'civitai.types.lora', 'civitai.types.embedding',
  'civitai.license.noCommercial', 'civitai.license.noCommercialHint',
  'civitai.license.attribution', 'civitai.license.attributionHint',
  'civitai.license.noDerivatives', 'civitai.license.noDerivativesHint',
]

const SETTINGS_KEYS = [
  'civitai.title', 'civitai.hint', 'civitai.placeholder',
  'civitai.keySet', 'civitai.removeKey', 'civitai.save',
]

describe('i18n — every new key, every locale', () => {
  for (const lang of LANGS) {
    it(`${lang}/catalog has all ${CATALOG_KEYS.length} civitai keys, non-empty`, () => {
      const ns = loadNs(lang, 'catalog')
      for (const key of CATALOG_KEYS) {
        const v = at(ns, key)
        expect(typeof v, `${lang}/catalog:${key}`).toBe('string')
        expect((v as string).trim(), `${lang}/catalog:${key}`).not.toBe('')
      }
    })

    it(`${lang}/settings has all ${SETTINGS_KEYS.length} civitai keys, non-empty`, () => {
      const ns = loadNs(lang, 'settings')
      for (const key of SETTINGS_KEYS) {
        const v = at(ns, key)
        expect(typeof v, `${lang}/settings:${key}`).toBe('string')
        expect((v as string).trim(), `${lang}/settings:${key}`).not.toBe('')
      }
    })

    it(`${lang} keeps the {{word}} placeholder on the copy label`, () => {
      expect(at(loadNs(lang, 'catalog'), 'civitai.copyTrigger')).toContain('{{word}}')
    })

    it(`${lang} keeps the {{count}} placeholder on the hidden-results line`, () => {
      // A translation that drops it prints the sentence with no number, which
      // is exactly the silence this feature exists to end.
      expect(at(loadNs(lang, 'catalog'), 'civitai.filteredNotice')).toContain('{{count}}')
    })

    it(`${lang} shows a ✓ on the stored-key state`, () => {
      expect(at(loadNs(lang, 'settings'), 'civitai.keySet')).toContain('✓')
    })
  }

  it('the English hint says the key is OPTIONAL — browsing needs none', () => {
    const hint = at(loadNs('en', 'settings'), 'civitai.hint') as string
    expect(hint).toMatch(/optional/i)
    expect(hint).toMatch(/no key/i)
    // Never claim it is needed to browse — it is not (live probes: anonymous 307s).
    expect(hint).not.toMatch(/\brequired\b/i)
  })

  it('the type chips are keyed by the filter ids the code actually uses', () => {
    // ALL EIGHT locales, not just English: the chip row renders `t()` of every
    // id, so one missing key is 19 raw key strings on screen in that language —
    // the exact breakage this loop was widened to catch.
    for (const lang of LANGS) {
      const ns = loadNs(lang, 'catalog')
      for (const f of CIVITAI_TYPE_FILTERS) {
        const v = at(ns, `civitai.types.${f.id}`)
        expect(typeof v, `${lang}/catalog:civitai.types.${f.id}`).toBe('string')
        expect((v as string).trim(), `${lang}/catalog:civitai.types.${f.id}`).not.toBe('')
      }
    }
  })

  it('the licence badge keys cover every badge the predicate can return', () => {
    const ns = loadNs('en', 'catalog')
    const all = civitaiLicenseBadges({ commercial: [], noCredit: false, derivatives: false })
    expect(all).toHaveLength(3)
    for (const badge of all) {
      expect(typeof at(ns, `civitai.license.${badge}`)).toBe('string')
      expect(typeof at(ns, `civitai.license.${badge}Hint`)).toBe('string')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9. button-name sweep over src/pages/catalog (nodesA11y's rule, this surface)
// ═══════════════════════════════════════════════════════════════════════════

function catalogTsx(): string[] {
  const dir = path.join(APP, 'src/pages/catalog')
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.tsx'))
    .map(f => `src/pages/catalog/${f}`)
    .sort()
}

function endOfOpenTag(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return i
  }
  return src.length - 1
}

interface Btn { file: string; line: number; open: string; inner: string }

function scanButtons(file: string): Btn[] {
  const src = stripComments(read(file))
  const out: Btn[] = []
  let pos = 0
  for (;;) {
    const start = src.indexOf('<button', pos)
    if (start === -1) break
    const openEnd = endOfOpenTag(src, start)
    const open = src.slice(start, openEnd + 1)
    let inner = ''
    let next = openEnd + 1
    if (!open.trimEnd().endsWith('/>')) {
      const close = src.indexOf('</button>', openEnd + 1)
      if (close === -1) { inner = src.slice(openEnd + 1); next = src.length }
      else { inner = src.slice(openEnd + 1, close); next = close + 9 }
    }
    out.push({ file, line: src.slice(0, start).split('\n').length, open, inner })
    pos = next
  }
  return out
}

describe('catalog a11y — every button has an accessible name', () => {
  it('scans the whole catalog surface, and finds buttons to scan', () => {
    const all = catalogTsx().flatMap(scanButtons)
    expect(all.length).toBeGreaterThan(10)
  })

  it('names every button (aria-label, a t() child, a bound label, or literal text)', () => {
    const nameless = catalogTsx().flatMap(scanButtons).filter(b => {
      if (/aria-label=/.test(b.open)) return false
      const text = b.inner.trim()
      if (text === '') return true
      if (/\bt\(/.test(text)) return false            // {t('run')}
      if (/^\{[A-Za-z_$][\w$.]*\}$/.test(text)) return false // {label}
      if (/[A-Za-z]{2,}/.test(text.replace(/\{[^}]*\}/g, ' '))) return false // literal words
      // A bare glyph ('×', '★') with no aria-label is the failure case.
      return true
    })
    expect(nameless.map(b => `${b.file}:${b.line} ${b.inner.trim().slice(0, 24)}`)).toEqual([])
  })

  it('names the two new civitai controls explicitly', () => {
    const card = scanButtons(CARD)
    expect(card.some(b => /civitai\.copyTrigger/.test(b.open))).toBe(true)
    const page = scanButtons(PAGE)
    expect(page.some(b => /civitai\.loadMore/.test(b.inner))).toBe(true)
  })

  // ─── READING ORDER: THE MODEL'S NAME COMES FIRST ───────────────────────────
  //
  // Driver-found on a gated card: the first text in the DOM was "Show 18+
  // preview", so both the scan order and a screen reader's began with the reveal
  // control rather than with the model. The fix is DOM order + `order: -1`, which
  // keeps the picture on top visually — so these assert the source order, which is
  // the thing that was wrong and the thing a future edit could silently undo.

  it('ModelCard puts the NAME before the preview and its reveal button', () => {
    const src = stripComments(read(CARD))
    const name = src.indexOf('civitai.detail.openNamed')
    const preview = src.indexOf('civitai.thumbnail ?')
    const reveal = src.indexOf("t('civitai.reveal')")
    const noPreview = src.indexOf('civitai.noPreview')
    for (const [label, at] of [['preview', preview], ['reveal', reveal], ['noPreview', noPreview]] as const) {
      expect(at, `ModelCard: ${label} must come AFTER the name in the DOM`).toBeGreaterThan(name)
    }
    expect(name).toBeGreaterThan(-1)
  })

  it('and pulls the preview back to the top with CSS order, not DOM order', () => {
    // Both branches: the thumbnail wrapper and the "no preview" box.
    const src = stripComments(read(CARD))
    expect(src.match(/order: -1/g) ?? []).toHaveLength(2)
  })

  it('the detail panel leads with the model name too, before the gallery', () => {
    const src = stripComments(read('src/pages/catalog/CivitaiDetailPanel.tsx'))
    const title = src.indexOf('{title}')
    const gallery = src.indexOf('<GalleryImage')
    expect(title).toBeGreaterThan(-1)
    expect(gallery).toBeGreaterThan(title)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9b. the detail panel's two link rules (driver-found)
// ═══════════════════════════════════════════════════════════════════════════

describe('the detail panel prints a url once, and breaks it sanely', () => {
  const PANEL = 'src/pages/catalog/CivitaiDetailPanel.tsx'

  it('asks the shared predicate instead of always printing text + href', () => {
    const src = stripComments(read(PANEL))
    expect(src).toContain('civitaiLinkPrintsHref(node)')
  })

  it('has NO word-break: break-all left on a url — that is the mid-token break', () => {
    const src = stripComments(read(PANEL))
    // `break-all` survives elsewhere in the panel for a FILE NAME, which is a
    // single token with no sane break points; a url has plenty and gets <wbr>.
    const urlish = src.slice(src.indexOf('function Inlines'))
    expect(urlish).not.toContain('break-all')
    expect(urlish).toContain('<wbr />')
  })

  it('still refuses to draw a clickable control for a description link', () => {
    // The honesty law: those hosts are not in the openExternal allowlist, so a
    // button would reject and silently no-op. Only "Open on Civitai" is a control.
    const src = stripComments(read(PANEL))
    const inlines = src.slice(src.indexOf('function Inlines'), src.indexOf('function VersionNotes'))
    expect(inlines).not.toContain('<button')
    expect(inlines).not.toContain('openExternal')
  })

  it('the panel can offer "Open on Civitai" from the ROW, before any fetch', () => {
    const src = stripComments(read(PANEL))
    expect(src).toContain('row.pageUrl')
    // and it never builds a host itself — main resolved the mode.
    expect(src).not.toContain('civitai.red')
    expect(src).not.toMatch(/['"`]https:\/\/civitai\.com/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 10. THE SILENT SFW DROP — the tab has to say the number out loud
// ═══════════════════════════════════════════════════════════════════════════
//
// Driver: `realistic` fetched a 24-row page and rendered 2 cards, with no
// explanation anywhere — a working gate reading as a broken search. Main now
// sends `filteredCount`; these are the two decisions the renderer makes with
// it. The gate itself is untouched (civitaiGate.test.ts still owns that).

describe('normalizeFilteredCount', () => {
  it('passes a real count through', () => {
    expect(normalizeFilteredCount(22)).toBe(22)
    expect(normalizeFilteredCount(1)).toBe(1)
  })

  it('an older main (no such field) prints NOTHING, never "NaN hidden"', () => {
    expect(normalizeFilteredCount(undefined)).toBe(0)
    expect(normalizeFilteredCount(null)).toBe(0)
    expect(normalizeFilteredCount('22')).toBe(0)
    expect(normalizeFilteredCount(NaN)).toBe(0)
    expect(normalizeFilteredCount(Infinity)).toBe(0)
  })

  it('a negative or fractional value is not a count', () => {
    expect(normalizeFilteredCount(-3)).toBe(0)
    expect(normalizeFilteredCount(0)).toBe(0)
    expect(normalizeFilteredCount(2.7)).toBe(2)
  })
})

describe('shouldShowFilteredNotice', () => {
  it('shows the line when the gate actually removed something', () => {
    expect(shouldShowFilteredNotice(22, {})).toBe(true)
    expect(shouldShowFilteredNotice(1, { loading: false })).toBe(true)
  })

  it('stays quiet when nothing was hidden — no permanent "0 hidden" noise', () => {
    expect(shouldShowFilteredNotice(0, {})).toBe(false)
    expect(shouldShowFilteredNotice(undefined as unknown as number, {})).toBe(false)
  })

  it('stays quiet while the first page is still skeletons', () => {
    expect(shouldShowFilteredNotice(22, { loading: true })).toBe(false)
  })
})

describe('the tab renders the count and offers a way out of a failure', () => {
  it('CatalogPage prints the honest line, gated on the shared predicate', () => {
    const page = read(PAGE)
    expect(page).toMatch(/shouldShowFilteredNotice\(s\.civitaiFilteredCount/)
    expect(page).toMatch(/civitai\.filteredNotice/)
    expect(page).toMatch(/count: s\.civitaiFilteredCount/)
  })

  it('the failure row carries a Try-again button wired to a re-search', () => {
    // Without it the only recovery from an intermittent 503 was retyping the
    // query — which reads as "this feature is broken".
    const btn = /<button[\s\S]{0,200}?onClick=\{\(\) => void s\.runCivitaiSearch\(\)\}[\s\S]{0,400}?civitai\.tryAgain/
    expect(btn.test(read(PAGE))).toBe(true)
  })

  it('the store accumulates the count across cursor pages and resets on a new search', () => {
    const store = read('src/pages/catalog/catalog.store.ts')
    // fresh search: reset, then take the server's number
    expect(store).toMatch(/civitaiLoading: true, civitaiError: null, civitaiFilteredCount: 0/)
    expect(store).toMatch(/civitaiFilteredCount: normalizeFilteredCount\(res\.filteredCount\)/)
    // load-more: ADD, because the line describes the whole grid on screen
    expect(store).toMatch(/civitaiFilteredCount: s\.civitaiFilteredCount \+ normalizeFilteredCount\(res\.filteredCount\)/)
  })
})
