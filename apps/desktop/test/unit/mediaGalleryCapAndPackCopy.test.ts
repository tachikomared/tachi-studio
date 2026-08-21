// apps/desktop/test/unit/mediaGalleryCapAndPackCopy.test.ts
//
// FOUR SMALLER DRIVER FINDINGS FROM THE SAME SPEED A/B RUN (2026-07-31), all in
// the local-media panel's honesty about what it just did and what it costs.
//
//  3. THE FULL GALLERY HID THE COMPLETION. GALLERY_CAP is 60 and the gallery was
//     already at 60, so a finished 27-minute render left the toolbar reading
//     "Gallery (60)" exactly as before it started. The driver's own harness gave
//     up on the count and watched the newest entry's id instead —
//     driver-speedab/gen.mjs says so in its first comment ("the count is
//     useless, GALLERY_CAP=60 and the gallery is already full") — and
//     S1-gen.log is 28 identical `gallery=60` lines across a render.
//
//  4. THE PACK BUTTON SAID IT TWICE. "↓ WAN 2.1 I2V 14B — 4-STEP SPEED PACK ·
//     0.7 GB — 4-STEP SPEED PACK": the pack's NAME already ends with the
//     category and the template appended it again.
//
//  5. A COMMENT THAT WAS MEASURABLY FALSE. sd-cpp-models said Civitai has no
//     Z-Image checkpoints to map; it has 402 versions.
//
//  + THE A14B DISCOUNT WAS INVISIBLE. Both speed packs share one byte-identical
//    LoRA, so once either is installed the other costs ~0.6 GB rather than 1.3.
//    That subtraction is only rendered inside the pack block, which only renders
//    for the SELECTED INSTALLED model — so a user looking at the 12.1 GB A14B
//    download row could not learn it before paying for the checkpoint.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useMediaStore, GALLERY_CAP, type MediaGalleryEntry } from '../../src/store/media.store'
import { speedPackDiscountNote } from '../../src/pages/media/mediaHelpers'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const entry = (id: string, over: Partial<MediaGalleryEntry> = {}): MediaGalleryEntry => ({
  id, model: 'wan21-i2v-14b-480p', modality: 'video', prompt: 'p',
  artifacts: [{ kind: 'video', mimeType: 'video/webm', path: `C:/out/${id}.webm` } as never],
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  ...over,
})

describe('finding 3 — a full gallery still has to show that the run landed', () => {
  beforeEach(() => { useMediaStore.setState({ gallery: [] }) })

  const fill = (n: number, favorite = false) => {
    for (let i = 1; i <= n; i++) useMediaStore.getState().addEntry(entry(`e${i}`, { favorite }))
  }

  it('the newest entry ALWAYS lands, and the oldest non-favorite is what goes', () => {
    fill(GALLERY_CAP)
    useMediaStore.getState().addEntry(entry(`e${GALLERY_CAP + 1}`))
    const g = useMediaStore.getState().gallery
    expect(g).toHaveLength(GALLERY_CAP)
    expect(g[0]?.id).toBe(`e${GALLERY_CAP + 1}`)   // the new one is at the top
    expect(g.some(e => e.id === 'e1')).toBe(false) // the oldest was evicted
  })

  it('THE BUG UNDER THE FINDING: a gallery of nothing but favorites ate the result', () => {
    // `keepOthers` was `others.slice(0, CAP - favorites.length)` — with CAP
    // favorites that is slice(0, 0), and `others` is where the entry being
    // ADDED lives. The 27-minute render was dropped on the floor with no
    // message, which is the same defect as the cap hiding the count, one degree
    // worse.
    fill(GALLERY_CAP, true)
    useMediaStore.getState().addEntry(entry('fresh', { createdAt: 9_999 }))
    const g = useMediaStore.getState().gallery
    expect(g.some(e => e.id === 'fresh')).toBe(true)
    expect(g[0]?.id).toBe('fresh')
  })

  it('favorites are still protected — an ordinary entry is evicted before a pin', () => {
    for (let i = 1; i <= 10; i++) useMediaStore.getState().addEntry(entry(`f${i}`, { favorite: true }))
    for (let i = 11; i <= GALLERY_CAP; i++) useMediaStore.getState().addEntry(entry(`e${i}`))
    useMediaStore.getState().addEntry(entry('fresh', { createdAt: 9_999 }))
    const g = useMediaStore.getState().gallery
    expect(g).toHaveLength(GALLERY_CAP)
    expect(g.filter(e => e.favorite)).toHaveLength(10)
    expect(g.some(e => e.id === 'e11')).toBe(false)
  })

  it('the toolbar shows something that CHANGES when the count cannot', () => {
    // The count line is the gallery title + the newest entry's own timestamp, so
    // a landing is visible at the cap. Pinned on the source because the value is
    // locale/timezone-dependent and the point is that the field is rendered.
    // (Anchored on the toolbar comment, not on the title call: the title is now
    // a conditional and its exact call text is not a stable landmark.)
    const page = read('src/pages/media/MediaPage.tsx')
    const toolbar = page.slice(page.indexOf('{/* Gallery toolbar */}'), page.indexOf("{t('gallery.clearAll')}"))
    expect(toolbar).toContain("t('gallery.newest'")
    expect(toolbar).toContain('gallery[0]')
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      expect(json.gallery.newest, l).toContain('{{time}}')
    }
  })

  it('AND the line says it is FULL at the cap — 60-of-60 must not read like 60-and-growing', () => {
    // Driver re-flagged 2026-08-01: "GALLERY (60)" sat still while 3 entries
    // landed. The count is correct (the cap evicts), but nothing on screen said
    // the number had stopped being able to move.
    const page = read('src/pages/media/MediaPage.tsx')
    const toolbar = page.slice(page.indexOf('{/* Gallery toolbar */}'), page.indexOf("{t('gallery.clearAll')}"))
    expect(toolbar).toContain('gallery.length >= GALLERY_CAP')
    expect(toolbar).toContain("t('gallery.titleFull'")
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      expect(json.gallery.titleFull, `${l} gallery.titleFull`).toBeTruthy()
      expect(json.gallery.titleFull, l).toContain('{{count}}')
      // it must actually DIFFER from the normal title, or it says nothing new
      expect(json.gallery.titleFull, l).not.toBe(json.gallery.title)
    }
  })
})

describe('finding 4 — the pack label says "4-step speed pack" exactly once', () => {
  it('THE REPRO: the pack NAME already ends with the category', () => {
    const rows = read('electron/services/sd-cpp-models.ts')
    expect(rows).toContain("name: 'Wan 2.1 I2V 14B — 4-step speed pack'")
    expect(rows).toContain("name: 'Wan 2.2 A14B — 4-step speed pack'")
  })

  it('so the templates must not append it a second time, in any locale', () => {
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      for (const key of ['speedPack', 'speedPackShared'] as const) {
        const s: string = json.local[key]
        expect(s, `${l}.${key}`).toContain('{{name}}')
        // The observed doubling, in every language it was written in.
        expect(s, `${l}.${key}`).not.toMatch(/4-step speed pack|4 Schritte|4 pasos|4 étapes|4ステップ|4[- ]?步|4단계/i)
      }
    }
  })

  it('the SHARED variant keeps the thing it is actually for — the saving', () => {
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      expect(json.local.speedPackShared, l).toContain('{{saved}}')
      expect(json.local.speedPackShared, l).toContain('{{size}}')
    }
  })
})

describe('finding 5 — the Z-Image / Civitai comment is now the measured truth', () => {
  it('the false claim is gone', () => {
    const rows = read('electron/services/sd-cpp-models.ts')
    expect(rows).not.toContain('Civitai has no Z-Image checkpoints to map')
    // …and what replaced it names the measurement rather than asserting a new absolute.
    expect(rows).toMatch(/402 version/)
  })
})

describe('the A14B pack discount is legible BEFORE the 12.1 GB checkpoint lands', () => {
  it('no note when nothing is shared — a row that saves nothing says nothing', () => {
    expect(speedPackDiscountNote({ modelId: 'wan22-i2v-a14b', packs: [] })).toBeNull()
    expect(speedPackDiscountNote({
      modelId: 'wan22-i2v-a14b',
      packs: [{ modelId: 'wan22-i2v-a14b', sizeMbTotal: 1300, installed: false, incrementalMb: 1300 }],
    })).toBeNull()
  })

  it('THE FINDING: with the shared LoRA already on disk the row quotes the discount', () => {
    const note = speedPackDiscountNote({
      modelId: 'wan22-i2v-a14b',
      packs: [
        { modelId: 'wan21-i2v-14b-480p', sizeMbTotal: 706, installed: true,  incrementalMb: 0 },
        { modelId: 'wan22-i2v-a14b',     sizeMbTotal: 1300, installed: false, incrementalMb: 606 },
      ],
    })
    // 606 MB rather than the 1.3 GB the pack block would quote from scratch.
    expect(note).toEqual({ incrementalMb: 606, fullMb: 1300 })
  })

  it('an INSTALLED pack has nothing left to advertise', () => {
    expect(speedPackDiscountNote({
      modelId: 'wan22-i2v-a14b',
      packs: [{ modelId: 'wan22-i2v-a14b', sizeMbTotal: 1300, installed: true, incrementalMb: 0 }],
    })).toBeNull()
  })

  it('a row with no pack at all is untouched', () => {
    expect(speedPackDiscountNote({
      modelId: 'wan21-t2v-1.3b',
      packs: [{ modelId: 'wan22-i2v-a14b', sizeMbTotal: 1300, installed: false, incrementalMb: 606 }],
    })).toBeNull()
  })

  it('the model download row renders it, and every locale has the string', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('speedPackDiscountNote')
    expect(page).toContain("t('local.modelSpeedPackDiscount'")
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      expect(json.local.modelSpeedPackDiscount, l).toContain('{{size}}')
    }
  })
})
