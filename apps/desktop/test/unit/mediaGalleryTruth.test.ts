// apps/desktop/test/unit/mediaGalleryTruth.test.ts
//
// WAVE-2 LANE A — the media gallery/store bundle: seven promises the surface
// made and did not keep. Every describe below names the promise, then the
// evidence that it was broken.
//
//  1. PIN TO TOP NEVER SORTED. The button is literally labelled "Pin to top"
//     and toggles `favorite`; the MEDIA gallery then rendered `gallery.map(…)`
//     in store order, so the pinned entry stayed exactly where it was. The
//     ARTIFACTS page (ArtifactsPage.tsx:74-77) has always sorted — one store,
//     two answers, and the tab with the button is the one that lied.
//
//  2. THE CAP HAD TWO EDGES, NOT ONE. 24dbb71 taught `addEntry` that a gallery
//     full of pins must still record the render that just finished
//     (trimGallery). `partialize` kept its own `slice(0, GALLERY_CAP)` — a
//     favorites-BLIND trim — so what survived a restart was decided by a
//     different rule than what survived the click. A pinned entry could be
//     dropped on the way to localStorage.
//
//  3. NATIVE confirm() IS BANNED (it blocks Electron's renderer event loop —
//     see ConfirmProvider's header). Clear-all and the per-entry ✕ destroy
//     persisted rows with no confirmation at all.
//
//  4. REMIX COULD NOT RESTORE WHAT IT SHOWED. style / loras / vae were
//     component useState, so (a) a tab switch reset them while the prompt, the
//     size and the provider persisted, and (b) they were never recorded on the
//     entry — Remix rebuilt the params bag and silently re-ran with a DIFFERENT
//     style and no adapters. Same class as the provider bug (f19ffdd).
//
//  5. RESTORE-FROM-PNG WROTE THE LEGACY KEYS. `cfgScale` / `samplingMethod` are
//     read only as a FALLBACK by resolveLocalGenParams; the schema seeds `cfg` /
//     `sampler` from the row's own recipe, so seeding out-voted provenance and
//     the restored image re-rendered at the checkpoint's numbers.
//
//  6. INIT-IMAGE DATA URLs WERE PERSISTED IN FULL. A reference frame is a
//     multi-MB `data:` URL living in `params`; 60 of them in the gallery plus
//     one per modality in the composer form is a localStorage quota blowout —
//     and a QuotaExceeded write loses the WHOLE store, not just the picture.
//     Artifact b64 has been stripped since day one; params never were.
//
//  7. AN ADAPTER WITH NO RECORDED FAMILY VANISHED. The picker's gate was
//     `a.family === row.family`, so "we do not know this adapter's base model"
//     was rendered as the verdict "it does not fit" — the user's LoRA silently
//     disappeared. Absence is not a verdict.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// --- in-memory localStorage shim, installed BEFORE the store is imported -----
const ls = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string): string | null => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string): void => { ls.set(k, v) },
  removeItem: (k: string): void => { ls.delete(k) },
  clear: (): void => { ls.clear() },
  key: (i: number): string | null => Array.from(ls.keys())[i] ?? null,
  get length(): number { return ls.size },
}

type StoreMod   = typeof import('../../src/store/media.store')
type HelpersMod = typeof import('../../src/pages/media/mediaHelpers')
let store: StoreMod
let helpers: HelpersMod

beforeAll(async () => {
  store   = await import('../../src/store/media.store')
  helpers = await import('../../src/pages/media/mediaHelpers')
})

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

type Entry = import('../../src/store/media.store').MediaGalleryEntry

const entry = (id: string, over: Partial<Entry> = {}): Entry => ({
  id, model: 'sd-turbo', modality: 'image', prompt: 'p',
  artifacts: [{ kind: 'image', mimeType: 'image/png', path: `C:/out/${id}.png` } as never],
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  ...over,
})

const persisted = () => JSON.parse(ls.get('tachi-media-v1') ?? '{"state":{}}').state as Record<string, unknown>

beforeEach(() => {
  ls.clear()
  store.useMediaStore.setState({
    gallery: [], styleId: 'none', loraWeights: {}, vaeAdapterId: '',
    paramsByModality: {},
  })
})

// ── 1. PIN TO TOP ────────────────────────────────────────────────────────────

describe('1 — pin to top actually sorts to the top', () => {
  it('favorites lead, newest-first inside each group', () => {
    const list = [
      entry('e3', { createdAt: 3 }),
      entry('e2', { createdAt: 2, favorite: true }),
      entry('e1', { createdAt: 1, favorite: true }),
      entry('e4', { createdAt: 4 }),
    ]
    expect(helpers.sortGalleryForDisplay(list).map(e => e.id)).toEqual(['e2', 'e1', 'e4', 'e3'])
  })

  it('THE REPRO: an OLD entry that gets pinned jumps over every newer one', () => {
    const oldest = entry('e1', { createdAt: 1, favorite: true })
    const list = [entry('e9', { createdAt: 9 }), entry('e5', { createdAt: 5 }), oldest]
    expect(helpers.sortGalleryForDisplay(list)[0]?.id).toBe('e1')
  })

  it('does not mutate the store array it is handed', () => {
    const list = [entry('e1', { createdAt: 1 }), entry('e2', { createdAt: 2, favorite: true })]
    const before = list.map(e => e.id)
    helpers.sortGalleryForDisplay(list)
    expect(list.map(e => e.id)).toEqual(before)
  })

  it('answers exactly what the ARTIFACTS page answers (one store, one order)', () => {
    // ArtifactsPage.tsx:74-77 is the comparator this lane was told to apply.
    const list = [
      entry('a', { createdAt: 10 }),
      entry('b', { createdAt: 20, favorite: true }),
      entry('c', { createdAt: 30 }),
      entry('d', { createdAt: 40, favorite: true }),
    ]
    const artifactsOrder = list.slice().sort((x, y) => {
      const fx = x.favorite ? 1 : 0
      const fy = y.favorite ? 1 : 0
      if (fx !== fy) return fy - fx
      return y.createdAt - x.createdAt
    })
    expect(helpers.sortGalleryForDisplay(list)).toEqual(artifactsOrder)
  })

  it('MediaPage renders the SORTED list, not the raw store order', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('sortGalleryForDisplay')
    // the raw map is gone
    expect(page).not.toMatch(/\{gallery\.map\(entry =>/)
  })
})

// ── 2. THE CAP, AT BOTH EDGES ────────────────────────────────────────────────

describe('2 — one trim rule for the click AND for the restart', () => {
  const fill = (n: number, favorite = false) => {
    for (let i = 1; i <= n; i++) store.useMediaStore.getState().addEntry(entry(`e${i}`, { favorite, createdAt: i }))
  }

  it('addEntry still never evicts the entry it just added (24dbb71, re-verified)', () => {
    fill(store.GALLERY_CAP, true)                        // a gallery of nothing but pins
    store.useMediaStore.getState().addEntry(entry('fresh', { createdAt: 9_999 }))
    const g = store.useMediaStore.getState().gallery
    expect(g).toHaveLength(store.GALLERY_CAP)
    expect(g[0]?.id).toBe('fresh')
  })

  it('THE REPRO: partialize used a favorites-BLIND slice, so a pin could be dropped', () => {
    // Newest-first with the pins at the BOTTOM (they are the oldest): a plain
    // slice(0, CAP) keeps the newest CAP and throws every pin away.
    const pins   = Array.from({ length: 5 },  (_, i) => entry(`p${i}`, { createdAt: i + 1, favorite: true }))
    const others = Array.from({ length: store.GALLERY_CAP + 20 }, (_, i) => entry(`o${i}`, { createdAt: 1_000 + i }))
    const all = [...others].sort((a, b) => b.createdAt - a.createdAt).concat(pins)
    store.useMediaStore.setState({ gallery: all })
    // force a persist write
    store.useMediaStore.getState().setAutoSaveDir('C:/x')

    const saved = (persisted().gallery ?? []) as Entry[]
    expect(saved.length).toBeLessThanOrEqual(store.GALLERY_CAP)
    for (const p of pins) expect(saved.some(e => e.id === p.id), `pin ${p.id} survived`).toBe(true)
  })

  it('and it is the SAME function, not a second copy of the rule', () => {
    const src = read('src/store/media.store.ts')
    const partialize = src.slice(src.indexOf('partialize:'))
    expect(partialize).toContain('trimGallery')
    expect(partialize).not.toMatch(/slice\(0,\s*GALLERY_CAP\)/)
  })

  it('a gallery at or under the cap is persisted whole', () => {
    fill(10)
    store.useMediaStore.getState().setAutoSaveDir('C:/x')
    expect((persisted().gallery as Entry[]).length).toBe(10)
  })
})

// ── 3. NO NATIVE confirm() ───────────────────────────────────────────────────

describe('3 — destructive gallery actions go through the in-app dialog', () => {
  it('MediaPage uses useConfirm and never window.confirm', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain("import { useConfirm }")
    expect(page).toMatch(/const confirm\s*=\s*useConfirm\(\)/)
    // a CALL to the native modal (the prose above may name it; calling it is the ban)
    expect(page).not.toMatch(/window\.confirm\(/)
  })

  it('both the clear-all and the per-entry ✕ are gated', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/confirmClearGallery/)
    expect(page).toMatch(/confirmRemoveEntry/)
    // the un-gated handlers are gone
    expect(page).not.toMatch(/onClick=\{clearGallery\}/)
    expect(page).not.toMatch(/onClick=\{\(\) => removeEntry\(entry\.id\)\}/)
  })

  it('the two questions exist in every locale', () => {
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      expect(json.gallery.clearAllConfirm, l).toBeTruthy()
      expect(json.gallery.clearAllConfirm, l).toContain('{{count}}')
      expect(json.entry.removeConfirm, l).toBeTruthy()
    }
  })
})

// ── 4. REMIX TRUTH ───────────────────────────────────────────────────────────

describe('4 — style / loras / vae live in the store and round-trip through Remix', () => {
  it('they are store state with defaults (the useState they replace)', () => {
    const s = store.useMediaStore.getState()
    expect(s.styleId).toBe('none')
    expect(s.loraWeights).toEqual({})
    expect(s.vaeAdapterId).toBe('')
  })

  it('SURVIVE A REMOUNT — the store outlives the component', () => {
    store.useMediaStore.getState().setStyleId('cinematic')
    store.useMediaStore.getState().setLoraWeights({ 'civitai-1': 0.8 })
    store.useMediaStore.getState().setVaeAdapterId('civitai-9')
    const after = store.useMediaStore.getState()
    expect(after.styleId).toBe('cinematic')
    expect(after.loraWeights).toEqual({ 'civitai-1': 0.8 })
    expect(after.vaeAdapterId).toBe('civitai-9')
  })

  it('…and a restart: they are in the persisted composer form', () => {
    store.useMediaStore.getState().setStyleId('anime')
    store.useMediaStore.getState().setVaeAdapterId('civitai-9')
    const p = persisted()
    expect(p.styleId).toBe('anime')
    expect(p.vaeAdapterId).toBe('civitai-9')
  })

  it('an OLD save with none of the three keys still parses, at the defaults', async () => {
    ls.set('tachi-media-v1', JSON.stringify({
      state: { provider: 'local', modality: 'image', modelByModality: {}, paramsByModality: {}, gallery: [], autoSaveDir: null },
      version: 0,
    }))
    vi.resetModules()
    const fresh = await import('../../src/store/media.store')
    expect(fresh.useMediaStore.getState().styleId).toBe('none')
    expect(fresh.useMediaStore.getState().loraWeights).toEqual({})
    expect(fresh.useMediaStore.getState().vaeAdapterId).toBe('')
    vi.resetModules()
  })

  it('THE ROUND TRIP: stamped into entry.params at generate, read back by Remix', () => {
    const sel = { style: 'neon-noir', loras: { 'civitai-1': 0.7, 'civitai-2': 1 }, vae: 'civitai-9' }
    const stamped = helpers.stampLocalSelections({ prompt: 'a cat', steps: 4 }, sel)
    // the run's own params are untouched…
    expect(stamped.prompt).toBe('a cat')
    expect(stamped.steps).toBe(4)
    // …and the selections come back byte-identical
    expect(helpers.readLocalSelections(stamped)).toEqual(sel)
  })

  it('the stamp is ONE reserved key, so it can be lifted back out of the bag', () => {
    const stamped = helpers.stampLocalSelections({ prompt: 'x' }, { style: 'anime', loras: {}, vae: '' })
    expect(Object.keys(stamped).sort()).toEqual(['localSelections', 'prompt'])
    expect(helpers.withoutLocalSelections(stamped)).toEqual({ prompt: 'x' })
  })

  it('a DEFAULT selection writes nothing — an entry only carries a real choice', () => {
    const stamped = helpers.stampLocalSelections({ prompt: 'x' }, { style: 'none', loras: {}, vae: '' })
    expect(stamped).toEqual({ prompt: 'x' })
    expect(helpers.readLocalSelections(stamped)).toBeNull()
  })

  it('a cloud / pre-change entry reads back as null, and Remix resets to the defaults', () => {
    expect(helpers.readLocalSelections(undefined)).toBeNull()
    expect(helpers.readLocalSelections({ prompt: 'x' })).toBeNull()
    // garbage in the bag is not a selection either
    expect(helpers.readLocalSelections({ localSelections: 'nope' })).toBeNull()
    expect(helpers.readLocalSelections({ localSelections: { style: 5 } })).toBeNull()
  })

  it('lora weights survive as numbers only — a poisoned bag cannot smuggle strings', () => {
    const back = helpers.readLocalSelections({
      localSelections: { style: 'anime', loras: { good: 0.5, bad: 'x' }, vae: '' },
    })
    expect(back).toEqual({ style: 'anime', loras: { good: 0.5 }, vae: '' })
  })

  it('MediaPage stamps at generate and restores at remix', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('stampLocalSelections')
    expect(page).toContain('readLocalSelections')
    expect(page).toContain('withoutLocalSelections')
    // the three useState declarations are gone
    expect(page).not.toMatch(/useState<string>\('none'\)/)
    expect(page).not.toMatch(/const \[selectedLoras, setSelectedLoras\] = useState/)
    expect(page).not.toMatch(/const \[selectedVae, setSelectedVae\] = useState/)
    expect(page).toMatch(/useMediaStore\(s => s\.styleId\)/)
    expect(page).toMatch(/useMediaStore\(s => s\.loraWeights\)/)
    expect(page).toMatch(/useMediaStore\(s => s\.vaeAdapterId\)/)
  })
})

// ── 4b. THE DEAD aspect_ratio A LOCAL IMAGE ENTRY CARRIED (checkpoint-B) ─────
//
// `aspect_ratio` is a VIDEO-only control on the local route — modelParamSchema
// drops it from every local IMAGE schema, orientation lives in `size` itself
// now — but the params bag is persisted per MODALITY, so a value a CLOUD image
// run (or an older session) left behind rides along unnoticed into a LOCAL
// entry. A driver caught a 512x768 run recording `aspect_ratio: '1:1'` beside
// `size: '512x768'` — the dead field reading as a lie next to the real one.

describe('4b — a local IMAGE entry does not carry the dead aspect_ratio field', () => {
  it('drops aspect_ratio when present, leaves everything else byte-identical', () => {
    const bag = { prompt: 'a cat', size: '512x768', aspect_ratio: '1:1', steps: 20 }
    expect(helpers.withoutLocalImageAspectRatio(bag)).toEqual({ prompt: 'a cat', size: '512x768', steps: 20 })
  })

  it('is a true no-op (same reference-worthy shape) when there is nothing to drop', () => {
    const bag = { prompt: 'a cat', size: '512x768' }
    expect(helpers.withoutLocalImageAspectRatio(bag)).toEqual(bag)
  })

  it('MediaPage strips it on the LOCAL image path only, after every other stamp', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/entryParams = withoutLocalImageAspectRatio\(entryParams\)/)
    // it must run inside the generate() function's LOCAL IMAGE branch, not the
    // cloud ones — imgnAI's own call reads runParams.aspect_ratio directly, and
    // that call site (and Venice's) must not be touched by this fix. Anchored
    // on the entryParams snapshot (unique to this branch), ending at the first
    // `else if (mediaProvider === 'imgnai')` that follows it.
    const start = page.indexOf('let entryParams = runParams')
    expect(start).toBeGreaterThan(-1)
    const localBlock = page.slice(start, page.indexOf("} else if (mediaProvider === 'imgnai')", start))
    expect(localBlock).toMatch(/withoutLocalImageAspectRatio/)
  })

  it('the cloud imgnAI path still reads aspect_ratio straight off runParams — untouched', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/aspectRatio: typeof runParams\.aspect_ratio === 'string' \? runParams\.aspect_ratio : undefined/)
  })
})

// ── 5. RESTORE-FROM-PNG WRITES THE SCHEMA'S NAMES ────────────────────────────

describe('5 — provenance is written under the keys the composer reads FIRST', () => {
  it('THE REPRO: the legacy names are only a fallback in resolveLocalGenParams', async () => {
    const { resolveLocalGenParams } = await import('../../src/pages/media/localGenParams')
    // schema key wins over the legacy key — which is why writing the legacy one
    // let the schema-seeded row recipe out-vote the PNG.
    expect(resolveLocalGenParams({ cfg: 1, cfgScale: 7, sampler: 'euler', samplingMethod: 'dpm++2m' }))
      .toEqual({ cfgScale: 1, samplingMethod: 'euler' })
  })

  it('restoreFromImage writes cfg / sampler, not cfgScale / samplingMethod', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    const fn = page.slice(page.indexOf('const restoreFromImage'), page.indexOf('// ── Esc closes'))
    expect(fn).toMatch(/cfg:\s*meta\.cfgScale/)
    expect(fn).toMatch(/sampler:\s*meta\.samplingMethod/)
    expect(fn).not.toMatch(/cfgScale:\s*meta\.cfgScale/)
    expect(fn).not.toMatch(/samplingMethod:\s*meta\.samplingMethod/)
  })
})

// ── 6. NO data: URL EVER REACHES localStorage ────────────────────────────────

describe('6 — the init frame is not persisted (quota)', () => {
  const DATA_URL = `data:image/png;base64,${'A'.repeat(4096)}`

  it('stripped out of a gallery entry\'s params', () => {
    store.useMediaStore.getState().addEntry(entry('e1', {
      params: { prompt: 'p', image_url: DATA_URL, steps: 4 },
    }))
    const saved = (persisted().gallery as Entry[])[0]
    expect(saved.params?.prompt).toBe('p')
    expect(saved.params?.steps).toBe(4)
    expect(saved.params?.image_url).toBeUndefined()
  })

  it('stripped out of the COMPOSER form too — that copy is per-modality and long-lived', () => {
    store.useMediaStore.getState().setParam('image', 'image_url', DATA_URL)
    store.useMediaStore.getState().setParam('image', 'prompt', 'p')
    const p = persisted().paramsByModality as Record<string, Record<string, unknown>>
    expect(p.image.prompt).toBe('p')
    expect(p.image.image_url).toBeUndefined()
  })

  it('the in-memory value is untouched — only what LEAVES for localStorage is stripped', () => {
    store.useMediaStore.getState().setParam('image', 'image_url', DATA_URL)
    expect(store.useMediaStore.getState().paramsByModality.image?.image_url).toBe(DATA_URL)
  })

  it('an on-disk PATH is NOT a data URL and must survive (Remix of a recorded frame)', () => {
    store.useMediaStore.getState().setParam('video', 'image_url', 'C:/frames/first.png')
    const p = persisted().paramsByModality as Record<string, Record<string, unknown>>
    expect(p.video.image_url).toBe('C:/frames/first.png')
  })

  it('artifact b64 is still stripped (no regression from touching partialize)', () => {
    store.useMediaStore.getState().addEntry(entry('e2', {
      artifacts: [{ kind: 'image', mimeType: 'image/png', path: 'C:/o.png', b64: 'AAAA' } as never],
    }))
    const saved = (persisted().gallery as Entry[])[0]
    expect(saved.artifacts[0].path).toBe('C:/o.png')
    expect((saved.artifacts[0] as { b64?: string }).b64).toBeUndefined()
  })

  it('the recorded selections are an OBJECT and survive the string-only strip', () => {
    store.useMediaStore.getState().addEntry(entry('e3', {
      params: helpers.stampLocalSelections({ prompt: 'p', image_url: DATA_URL }, { style: 'anime', loras: { a: 1 }, vae: '' }),
    }))
    const saved = (persisted().gallery as Entry[])[0]
    expect(helpers.readLocalSelections(saved.params)).toEqual({ style: 'anime', loras: { a: 1 }, vae: '' })
    expect(saved.params?.image_url).toBeUndefined()
  })
})

// ── 7. THE ADAPTER-FAMILY AXIS ───────────────────────────────────────────────

describe('7 — family filter: a match hides nothing, an ABSENCE hides nothing either', () => {
  const V = (a: string | undefined, r: string | undefined) => helpers.adapterFamilyVerdict(a, r)

  it('the matrix', () => {
    expect(V('sdxl', 'sdxl')).toBe('match')
    expect(V('SDXL', 'sdxl')).toBe('match')       // case/whitespace are not a verdict
    expect(V(' sdxl ', 'sdxl')).toBe('match')
    expect(V('sd15', 'sdxl')).toBe('mismatch')
    expect(V('flux', 'wan')).toBe('mismatch')
    // THE FINDING: absence on EITHER side is "we do not know", never "it does not fit"
    expect(V('', 'sdxl')).toBe('unknown')
    expect(V(undefined, 'sdxl')).toBe('unknown')
    expect(V('sdxl', '')).toBe('unknown')
    expect(V('sdxl', undefined)).toBe('unknown')
    expect(V(undefined, undefined)).toBe('unknown')
  })

  it('THE REPRO: the old gate `a.family === row.family` deleted the unknown one', () => {
    const adapters = [
      { id: 'ok',      family: 'sdxl' },
      { id: 'other',   family: 'sd15' },
      { id: 'unknown', family: '' },
    ]
    const old = adapters.filter(a => a.family === 'sdxl').map(a => a.id)
    expect(old).toEqual(['ok'])                                   // 'unknown' vanished

    const now = helpers.partitionAdaptersByFamily(adapters, 'sdxl')
    expect(now.offered.map(a => a.id)).toEqual(['ok', 'unknown'])
    expect(now.mismatchCount).toBe(1)
  })

  it('a row whose OWN family is unrecorded cannot rule anything out', () => {
    const adapters = [{ id: 'a', family: 'sd15' }, { id: 'b', family: 'sdxl' }]
    const p = helpers.partitionAdaptersByFamily(adapters, '')
    expect(p.offered.map(a => a.id)).toEqual(['a', 'b'])
    expect(p.mismatchCount).toBe(0)
  })

  it('a WAN video row still offers no image adapters (the verdict that was right)', () => {
    const adapters = [{ id: 'a', family: 'sd15' }, { id: 'b', family: 'sdxl' }]
    const p = helpers.partitionAdaptersByFamily(adapters, 'wan')
    expect(p.offered).toEqual([])
    expect(p.mismatchCount).toBe(2)
  })

  it('the picker renders the hint instead of hiding, and every locale has it', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('partitionAdaptersByFamily')
    expect(page).toContain('adapterFamilyVerdict')
    expect(page).toContain("t('composer.loraUnknownFamily')")
    // The old strict FILTER is gone. Narrowed from a bare
    // `a.family === activeLocalRow.family` to the filter idiom it was: a strict
    // equality is the defect only when it HIDES adapters whose family is the
    // creator's metadata and may be unrecorded. Selecting the one curated
    // reference-image row for this family is a `find` over OUR OWN data, where
    // "no row" is a fact (upstream supports sd15/sdxl) rather than ignorance.
    expect(page).not.toMatch(/\.filter\(a => a\.family === activeLocalRow\.family\)/)
    expect(page).not.toMatch(/localAdapters[\s\S]{0,40}a\.family === activeLocalRow\.family/)
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      expect(json.composer.loraUnknownFamily, l).toBeTruthy()
      expect(json.composer.lorasUnknownFamilyNote, l).toContain('{{count}}')
    }
  })

  it('and the compat PRUNE never fires on ignorance (a Remix landing before status)', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    const effect = page.slice(page.indexOf('// Switching checkpoint drops any selection'))
    // the guard is the FIRST statement of the effect body, ahead of the set()s
    const body = effect.slice(0, effect.indexOf('setSelectedLoras'))
    expect(body).toMatch(/if \(!activeLocalRow\) return/)
  })
})

// ── the family the picker filters ON is recorded at install ──────────────────

describe('7b — user-sd-models persists the family the picker reads', () => {
  it('an adapter row keeps its family through normalize (no pass-through needed)', async () => {
    const m = await import('../../electron/services/user-sd-models')
    const row = m.normalizeUserSdAdapter({
      id: 'civitai-1', kind: 'lora', name: 'Add detail', slug: 'add-detail-9f3c1a2b', family: 'sdxl',
      file: { role: 'model', url: 'https://x/y.safetensors', sha256: 'a'.repeat(64), sizeMb: 12 },
    })
    expect(row?.family).toBe('sdxl')
  })

  it('civitai-search computes the family the mapper then stores', async () => {
    // civitai-search itself pulls in the keychain (electron) at import time, so
    // it is pinned by source here rather than executed: what this lane needs is
    // that the family is COMPUTED there and CARRIED through the mapper below —
    // which is why user-sd-models needed no pass-through of its own.
    const cs = read('electron/services/civitai-search.ts')
    expect(cs).toMatch(/export function familyForBaseModel/)
    const m = await import('../../electron/services/user-sd-models')
    const adapter = m.userSdAdapterFromCivitaiRow({
      id: 'civitai-1', modelId: 1, versionId: 1, name: 'L', type: 'LORA',
      family: 'sdxl', baseModel: 'SDXL 1.0', sizeMb: 12, sha256: 'b'.repeat(64),
      downloadUrl: 'https://x/y.safetensors', fileName: 'y.safetensors', format: 'SafeTensor',
    })
    expect(adapter.family).toBe('sdxl')
  })
})
