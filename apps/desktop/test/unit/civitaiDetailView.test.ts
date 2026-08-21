// apps/desktop/test/unit/civitaiDetailView.test.ts
//
// The detail PANEL's decisions. Node env, no DOM — so every branch the panel can
// take is reached through a pure function rather than through a render this
// suite cannot run (the same reason civitaiRow.ts exists).
//
// The two properties worth naming, because they are what keeps a detail view
// from becoming a second, disagreeing source of truth:
//   1. the affordance is THE SAME function the card uses — a panel that offered
//      Install where its own card showed a refusal is a contradiction the user
//      can see and nobody can explain;
//   2. the preview blur DELEGATES to civitaiRow's committed bitmask predicate,
//      so `& ~3` (never `>=`) lives in exactly one place.

import { describe, it, expect } from 'vitest'
import {
  civitaiDetailOpening,
  civitaiDetailResolved,
  civitaiLeadVersion,
  civitaiOtherVersions,
  civitaiVersionNotice,
  civitaiVersionAffordance,
  civitaiShowsVerdictBanner,
  civitaiDetailPreviewBlurred,
  civitaiGalleryImages,
  civitaiCompactCount,
  civitaiPublishedDate,
  civitaiVersionFileLine,
  civitaiFormatMb,
} from '../../src/pages/catalog/civitaiDetail'
import type { CivitaiModelDetail, CivitaiDetailVersion } from '../../src/types/electron'

const version = (over: Partial<CivitaiDetailVersion> = {}): CivitaiDetailVersion => ({
  id: `civitai-${over.versionId ?? 1}`,
  versionId: over.versionId ?? 1,
  name: 'v1',
  baseModel: 'SDXL 1.0',
  family: 'sdxl',
  description: null,
  publishedAt: null,
  trainedWords: [],
  sizeMb: 6600,
  format: 'SafeTensor',
  fileName: 'model.safetensors',
  nsfwLevel: 1,
  pageUrl: 'https://civitai.com/models/1?modelVersionId=1',
  previews: [],
  installable: true,
  ...over,
})

const detail = (over: Partial<CivitaiModelDetail> = {}): CivitaiModelDetail => ({
  modelId: 1,
  name: 'A Model',
  type: 'Checkpoint',
  description: null,
  creator: { username: 'someone' },
  downloads: 0,
  likes: 0,
  license: { commercial: [], noCredit: false, derivatives: false },
  pageUrl: 'https://civitai.com/models/1',
  versions: [version()],
  filteredVersionCount: 0,
  versionsTotal: 1,
  adult: false,
  ...over,
})

describe('the panel opens on the ROW, not on the fetch', () => {
  it('starts loading with the ids it was opened for', () => {
    const s = civitaiDetailOpening(260267, 403131)
    expect(s).toEqual({
      modelId: 260267, versionId: 403131, phase: 'loading', detail: null, error: null,
    })
  })

  it('becomes ready when a detail arrives', () => {
    const s = civitaiDetailResolved(civitaiDetailOpening(1, 1), 1, { detail: detail() })
    expect(s!.phase).toBe('ready')
    expect(s!.detail!.modelId).toBe(1)
  })

  it('becomes an error — WITHOUT losing the ids the panel still renders from', () => {
    const s = civitaiDetailResolved(civitaiDetailOpening(1, 7), 1, { detail: null, error: 'offline' })
    expect(s).toEqual({ modelId: 1, versionId: 7, phase: 'error', detail: null, error: 'offline' })
  })

  it('treats a gate-emptied detail as READY, not as a failure', () => {
    // Zero versions with a refusal count is a working filter. Calling it an
    // error would tell the user the app broke when it did its job.
    const s = civitaiDetailResolved(
      civitaiDetailOpening(4201, 501240), 4201,
      { detail: detail({ versions: [], filteredVersionCount: 4, versionsTotal: 4 }) },
    )
    expect(s!.phase).toBe('ready')
    expect(civitaiVersionNotice(s!.detail)).toEqual({ kind: 'hidden', count: 4 })
  })

  it('IGNORES a late reply for a card the reader already left', () => {
    const open = civitaiDetailOpening(999, 1)
    const s = civitaiDetailResolved(open, 111, { detail: detail() })
    expect(s).toBe(open)              // untouched, same reference
    expect(s!.phase).toBe('loading')
  })

  it('is a no-op when the panel is already closed', () => {
    expect(civitaiDetailResolved(null, 1, { detail: detail() })).toBeNull()
  })
})

describe('which version leads', () => {
  const d = detail({
    versions: [version({ versionId: 10 }), version({ versionId: 20 }), version({ versionId: 30 })],
    versionsTotal: 3,
  })

  it('is the version the card resolved to', () => {
    expect(civitaiLeadVersion(d, 20)!.versionId).toBe(20)
  })

  it('falls back to the first when the asked-for version was gated away', () => {
    // A real case: the unlock lapsed between the browse and the click, so the
    // version the card showed is no longer showable. Leading with the newest
    // survivor beats an empty panel.
    expect(civitaiLeadVersion(d, 4242)!.versionId).toBe(10)
  })

  it('is null when the gate emptied the model', () => {
    expect(civitaiLeadVersion(detail({ versions: [] }), 1)).toBeNull()
    expect(civitaiLeadVersion(null, 1)).toBeNull()
  })

  it('lists the others in main\'s order, without the lead', () => {
    const lead = civitaiLeadVersion(d, 20)
    expect(civitaiOtherVersions(d, lead).map(v => v.versionId)).toEqual([10, 30])
  })
})

describe('the honest version notice', () => {
  it('says how many the gate refused', () => {
    expect(civitaiVersionNotice(detail({ filteredVersionCount: 3 })))
      .toEqual({ kind: 'hidden', count: 3 })
  })

  it('says a list was capped', () => {
    const d = detail({
      versions: Array.from({ length: 8 }, (_, i) => version({ versionId: i })),
      versionsTotal: 31,
    })
    expect(civitaiVersionNotice(d)).toEqual({ kind: 'capped', shown: 8, total: 31 })
  })

  it('prefers the refusal when both are true — a missing version outranks a truncated list', () => {
    const d = detail({
      versions: Array.from({ length: 8 }, (_, i) => version({ versionId: i })),
      versionsTotal: 31,
      filteredVersionCount: 5,
    })
    expect(civitaiVersionNotice(d)).toEqual({ kind: 'hidden', count: 5 })
  })

  it('prints NOTHING when nothing was dropped — a permanent "0 hidden" trains people to ignore it', () => {
    expect(civitaiVersionNotice(detail())).toBeNull()
    expect(civitaiVersionNotice(null)).toBeNull()
  })

  it('ignores a nonsense count from an older main build', () => {
    for (const bad of [undefined, null, -3, Number.NaN, 'four']) {
      const d = detail({ filteredVersionCount: bad as unknown as number })
      expect(civitaiVersionNotice(d)).toBeNull()
    }
  })
})

describe('the affordance is the card\'s, verbatim', () => {
  it('offers install for a runnable version', () => {
    expect(civitaiVersionAffordance(version(), {})).toEqual({ kind: 'install' })
  })

  it('offers RUN when this exact version is already on disk', () => {
    expect(civitaiVersionAffordance(version(), { installed: true })).toEqual({ kind: 'installed' })
  })

  it('keeps RUN for installed weights even when the listing now refuses them', () => {
    const stale = version({ installable: false, reason: 'no longer offered' })
    expect(civitaiVersionAffordance(stale, { installed: true })).toEqual({ kind: 'installed' })
  })

  it('draws NO button for a refusal, and carries the reason instead', () => {
    const blocked = version({ installable: false, reason: 'Needs an SDXL checkpoint — install one first.' })
    const a = civitaiVersionAffordance(blocked, {})
    expect(a.kind).toBe('blocked')
    expect(civitaiShowsVerdictBanner(a)).toBe(true)
  })

  it('does not raise a banner with nothing in it', () => {
    const a = civitaiVersionAffordance(version({ installable: false, reason: '  ' }), {})
    expect(a.kind).toBe('blocked')
    expect(civitaiShowsVerdictBanner(a)).toBe(false)
  })

  it('never banners an offer', () => {
    for (const s of [{}, { installed: true }, { installing: true }]) {
      expect(civitaiShowsVerdictBanner(civitaiVersionAffordance(version(), s))).toBe(false)
    }
  })
})

describe('the detail gallery blur delegates to the row predicate', () => {
  const img = (level: number) => ({ dataUri: 'data:image/jpeg;base64,AA', level })

  it('never blurs in SFW mode — main clamped the request and the picker gated it', () => {
    for (const level of [1, 2, 4, 8, 16, 32, 0]) {
      expect(civitaiDetailPreviewBlurred(img(level), { adult: false })).toBe(false)
    }
  })

  it('blurs above PG13 in adult mode, by BITMASK', () => {
    expect(civitaiDetailPreviewBlurred(img(1), { adult: true })).toBe(false)
    expect(civitaiDetailPreviewBlurred(img(3), { adult: true })).toBe(false)
    expect(civitaiDetailPreviewBlurred(img(4), { adult: true })).toBe(true)
    expect(civitaiDetailPreviewBlurred(img(8), { adult: true })).toBe(true)
    expect(civitaiDetailPreviewBlurred(img(16), { adult: true })).toBe(true)
    // 32 is Blocked ALONE — numerically it would slip past `level <= 60`-shaped
    // code. `& ~3` cannot miss it.
    expect(civitaiDetailPreviewBlurred(img(32), { adult: true })).toBe(true)
  })

  it('blurs an UNKNOWN level in adult mode — unknown is not evidence of PG', () => {
    for (const bad of [0, Number.NaN, undefined, null, 'x']) {
      expect(civitaiDetailPreviewBlurred(
        { dataUri: 'data:image/jpeg;base64,AA', level: bad as unknown as number },
        { adult: true },
      )).toBe(true)
    }
  })

  it('has nothing to blur without an image', () => {
    expect(civitaiDetailPreviewBlurred(null, { adult: true })).toBe(false)
    expect(civitaiDetailPreviewBlurred({ dataUri: '', level: 16 }, { adult: true })).toBe(false)
  })
})

describe('civitaiGalleryImages', () => {
  const row = { thumbnail: 'data:image/jpeg;base64,ROW', thumbnailNsfwLevel: 1 }

  it('uses the fetched previews when there are any', () => {
    const v = version({ previews: [{ dataUri: 'data:image/jpeg;base64,A', level: 1 }] })
    expect(civitaiGalleryImages(v, row).map(p => p.dataUri)).toEqual(['data:image/jpeg;base64,A'])
  })

  it('falls back to the row thumbnail rather than showing an empty gallery', () => {
    expect(civitaiGalleryImages(version(), row)).toEqual([
      { dataUri: 'data:image/jpeg;base64,ROW', level: 1 },
    ])
  })

  it('never MERGES the fallback in — the row thumbnail is one of these images', () => {
    const v = version({ previews: [{ dataUri: 'data:image/jpeg;base64,ROW', level: 1 }] })
    expect(civitaiGalleryImages(v, row)).toHaveLength(1)
  })

  it('drops malformed preview entries', () => {
    const v = version({
      previews: [
        { dataUri: '', level: 1 },
        { dataUri: 'data:image/jpeg;base64,B', level: 1 },
      ],
    })
    expect(civitaiGalleryImages(v, null).map(p => p.dataUri)).toEqual(['data:image/jpeg;base64,B'])
  })

  it('is empty with neither previews nor a row thumbnail', () => {
    expect(civitaiGalleryImages(version(), { thumbnail: null, thumbnailNsfwLevel: 0 })).toEqual([])
    expect(civitaiGalleryImages(null, null)).toEqual([])
  })
})

describe('formatters', () => {
  it('abbreviates counts the way the card already does', () => {
    expect(civitaiCompactCount(2_285_908)).toBe('2.3M')
    expect(civitaiCompactCount(52_737)).toBe('52.7k')
    expect(civitaiCompactCount(931)).toBe('931')
    expect(civitaiCompactCount(0)).toBe('0')
  })

  it('says nothing about a count it was not given', () => {
    for (const bad of [undefined, null, Number.NaN, 'lots']) {
      expect(civitaiCompactCount(bad)).toBe('')
    }
  })

  it('parses publishedAt, and refuses to invent a date', () => {
    expect(civitaiPublishedDate('2024-05-12T06:24:13.109Z')!.getUTCFullYear()).toBe(2024)
    for (const bad of [undefined, null, '', '   ', 'not a date', 42]) {
      expect(civitaiPublishedDate(bad)).toBeNull()
    }
  })

  it('formats sizes, and returns nothing for an absent one', () => {
    expect(civitaiFormatMb(6600)).toBe('6.4 GB')
    expect(civitaiFormatMb(150)).toBe('150 MB')
    expect(civitaiFormatMb(1024)).toBe('1.0 GB')
    for (const bad of [0, -1, undefined, null, Number.NaN]) expect(civitaiFormatMb(bad)).toBe('')
  })

  it('drops empty and Unknown segments from the file line instead of leaving a gap', () => {
    expect(civitaiVersionFileLine({ sizeMb: 6600, format: 'SafeTensor', fp: 'fp16' }))
      .toBe('6.4 GB · SafeTensor · fp16')
    expect(civitaiVersionFileLine({ sizeMb: 150, format: 'SafeTensor', fp: null }))
      .toBe('150 MB · SafeTensor')
    // `Unknown` is main's placeholder for "the API sent no format" — printing it
    // as a chip would dress absent data up as a fact.
    expect(civitaiVersionFileLine({ sizeMb: 0, format: 'Unknown', fp: null })).toBe('')
  })
})
