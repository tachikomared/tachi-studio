// apps/desktop/test/unit/sdBlockedCatalogRow.test.ts
//
// THE HONEST REFUSAL HAS TO BE SOMEWHERE THE USER CAN SEE IT.
//
// 0fab056 added flux2-klein-4b to SD_BLOCKED_MODELS with a carefully written
// reason: the DiT is pinned and HEAD-verified, but the VAE only exists in a
// gated non-commercial repo or in a container our installer refuses, and the
// LLM encoder has no re-host with a published sha. That is exactly the kind of
// thing this app is supposed to say out loud instead of shipping a Download
// button that 404s.
//
// Driver finding (owner, live): enumerating all 55 catalog rows turned up NO
// Klein entry anywhere. The reason is one line of plumbing — the `sd-cpp:catalog`
// IPC maps SD_IMAGE_MODELS and SD_VIDEO_MODELS and nothing else, so the blocked
// row never crosses into the renderer at all. `SD_BLOCKED_MODELS` is referenced
// by its own unit test and by nothing else in the app.
//
// (A DIFFERENT "flux.2-klein-4b | FLUX.2 Klein 4B" does appear in the Surplus
// CLOUD dropdown. That is the provider's own hosted model, not ours, and none
// of this touches the cloud lists.)
//
// THE MIRROR, and why: main's registry pulls in user-sd-models, which reads the
// filesystem through electron's app paths — the renderer cannot import it. The
// house pattern for that is a renderer-side copy pinned by a test against the
// authoritative main-process one (mediaHelpers' SD_PRESETS / presetsForRow do
// exactly this, pinned by mediaLocalGenParams.test.ts). This file is that pin:
// it imports BOTH sides and compares them field by field, so a change to the
// blocked list that skips the renderer fails here rather than on someone's
// screen.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SD_BLOCKED_MODELS, SD_VIDEO_MODELS, isShaPlaceholder } from '../../electron/services/sd-cpp-models'
import {
  BLOCKED_LOCAL_ROWS,
  BLOCKED_LOCAL_ID_PREFIX,
  blockedLocalCatalogEntry,
  blockedLocalCatalogEntries,
  blockedLocalReasonFor,
} from '../../src/pages/catalog/blockedLocalRows'
import { showsFavoriteControl } from '../../src/pages/catalog/rowMeta'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

describe('the renderer mirror is the main registry, verbatim', () => {
  it('carries every blocked row main declares — no more, no fewer', () => {
    expect(BLOCKED_LOCAL_ROWS.map(r => r.id).sort())
      .toEqual(SD_BLOCKED_MODELS.map(m => m.id).sort())
  })

  it('the Klein row is present at all (the driver enumerated 55 rows and no Klein)', () => {
    expect(SD_BLOCKED_MODELS.some(m => m.id === 'flux2-klein-4b')).toBe(true)
    expect(BLOCKED_LOCAL_ROWS.some(r => r.id === 'flux2-klein-4b')).toBe(true)
  })

  it('name, family, KIND and REASON match byte for byte', () => {
    for (const m of SD_BLOCKED_MODELS) {
      const mirrored = BLOCKED_LOCAL_ROWS.find(r => r.id === m.id)
      expect(mirrored, `no mirror for ${m.id}`).toBeDefined()
      expect(mirrored!.name).toBe(m.name)
      expect(mirrored!.family).toBe(m.family)
      // `kind` used to be implicit — every blocked row was an image row, so the
      // mirror could hardcode it. A blocked VIDEO row makes that a guess, and a
      // guess here mis-tags the card's capability filter.
      expect(mirrored!.kind).toBe(m.kind)
      // The reason is the whole point of the row. A paraphrase is a drift.
      expect(mirrored!.reason).toBe(m.blocked)
    }
  })

  it('the reason actually says what is missing', () => {
    const klein = BLOCKED_LOCAL_ROWS.find(r => r.id === 'flux2-klein-4b')!
    expect(klein.reason).toMatch(/VAE/)
    expect(klein.reason).toMatch(/LLM encoder|encoder/)
    expect(klein.reason.length).toBeGreaterThan(80)
  })
})

// ── …and what it is that we are refusing ─────────────────────────────────────
//
// A refusal that only lists blockers reads as "some model we could not be
// bothered to finish". Research (LOWVRAM-META-RESEARCH-2026-07-28, DELTA
// ADDENDUM §B, "KLEIN-4B ROW UPGRADE — biggest item") establishes that this row
// is not another txt2img checkpoint: Klein's marquee tricks — single-reference
// KV edit, two-image face+pose swap, merge — are NATIVE multi-reference
// conditioning, and OUR PIN already supports them. docs/flux2.md at
// master-782-b290693 ships klein EDIT examples driven by `-r ref.png`, and
// main.cpp parses `ref_image_paths` as a VECTOR, so `-r a.png -r b.png` is a
// real two-reference call, not a hypothetical.
//
// That is a capability class NO shipped local row has: every curated image row
// is txt2img (plus img2img `--strength`), which is a different operation from
// editing a photo against one or two references. So the card should sell the
// future honestly — the person reading the refusal deserves to know what the
// two missing files would actually buy them.
//
// DATA ONLY, deliberately. No reference-image slot is built here, no row moves
// out of SD_BLOCKED_MODELS, and the claim stays subjunctive ("would") because
// the row still cannot load. Building the UI for a model nobody can install is
// the exact mistake the blocked list exists to prevent.
describe('the refusal says what unlocking it would BUY', () => {
  const klein = () => SD_BLOCKED_MODELS.find(m => m.id === 'flux2-klein-4b')!

  it('names the capability class — edit / face-swap via reference images', () => {
    const reason = klein().blocked
    expect(reason).toMatch(/edit/i)
    expect(reason).toMatch(/face.?swap/i)
    expect(reason).toMatch(/reference image/i)
  })

  it('cites the evidence at our own pin, not a marketing claim', () => {
    const reason = klein().blocked
    // The two source facts the research verified.
    expect(reason).toMatch(/docs\/flux2\.md/)
    expect(reason).toMatch(/-r\b/)
    // Multi-reference is the part that makes face+pose swap possible at all.
    expect(reason).toMatch(/two|multi|vector/i)
  })

  it('stays honest that it is still BLOCKED — the note is subjunctive', () => {
    const reason = klein().blocked
    // The blockers must still be the headline; the capability is the coda.
    expect(reason).toMatch(/cannot pin yet|not offered|blocked/i)
    expect(reason).toMatch(/would/i)
    // It must not read as an available feature.
    expect(reason).not.toMatch(/\bavailable now\b/i)
  })

  it('the mirror carries the enriched reason too (the whole point of the pin)', () => {
    // Redundant with the byte-for-byte test above ON PURPOSE: this is the
    // change most likely to be made on one side only.
    const mirrored = BLOCKED_LOCAL_ROWS.find(r => r.id === 'flux2-klein-4b')!
    expect(mirrored.reason).toBe(klein().blocked)
    expect(mirrored.reason).toMatch(/face.?swap/i)
  })

  it('is METADATA ONLY — the capability lives in the sentence, not in a new field', () => {
    // The research item asks for metadata and nothing else. A blocked row that
    // grows an `edit: true` flag invites a consumer to branch on it, and a
    // blocked row that grows an input control is a download button by another
    // name. Both sides keep the shape they had.
    expect(Object.keys(BLOCKED_LOCAL_ROWS[0]).sort())
      .toEqual(['family', 'id', 'kind', 'name', 'reason'])
    expect(klein().files).toHaveLength(1)
    expect(klein().files[0].role).toBe('diffusion')
    // …and still nothing to download, size or fit.
    expect(blockedLocalCatalogEntry(BLOCKED_LOCAL_ROWS[0]).quants).toEqual([])
  })
})

// ── THE OTHER SHAPE OF REFUSAL, AND WHY IT IS NO LONGER HERE ───────────────
//
// LTX-2.3 lived in this list for exactly one lane, as the opposite case from
// Klein's: nothing was missing. All five components resolved anonymously,
// every source repo declared a licence, and those licences permitted
// redistribution. It was refused on five grounds, and the FIRST of them was a
// claim about this app — that the LTX-2 agreement's pass-through duties
// ("provide a copy of this Agreement") and the Gemma Notice requirement were
// ours to discharge, and that the registry had no way to.
//
// The owner ruled the premise wrong: those duties bind a DISTRIBUTOR, and this
// is an MIT download CLIENT that re-hosts nothing — the bytes go from
// Lightricks'/unsloth's own repos to the user's disk. What WAS ours is
// informed consent, which is now a row field (licenseName / licenseUrl) and a
// line in the download panel. The other four grounds were work, and the work
// is done: the video path learned a per-row size AND length law, the recipe
// came off Lightricks' own model card, and the machine bar is stated in the
// notes with no borrowed wall-clock.
//
// What this suite keeps is the ONE-WAY pin. A blocked row that ships must
// leave BOTH registries, and the shape of the list must not quietly grow back.
describe('LTX-2.3 shipped, and left this list on both sides', () => {
  const ID = 'ltx-2-3-22b-distilled'

  it('is in neither the blocked registry nor its renderer mirror', () => {
    expect(SD_BLOCKED_MODELS.some(m => m.id === ID)).toBe(false)
    expect(BLOCKED_LOCAL_ROWS.some(r => r.id === ID)).toBe(false)
    // …and no card can be built for it, so nothing in the grid can print a
    // refusal for a model that is now one click from downloading.
    expect(blockedLocalReasonFor(BLOCKED_LOCAL_ID_PREFIX + ID)).toBeNull()
  })

  it('is a real curated video row instead', () => {
    const row = SD_VIDEO_MODELS.find(m => m.id === ID)
    expect(row).toBeDefined()
    expect(row!.family).toBe('ltx2')
    expect(row!.files).toHaveLength(5)
    // The thing that unblocked it, on the row itself.
    expect(row!.licenseName).toBeTruthy()
    expect(row!.licenseUrl).toMatch(/^https:\/\//)
  })

  it('KLEIN is the only refusal left, and it is a different case entirely', () => {
    // Klein is blocked on FILES, not on a licence reading: its VAE exists only
    // in a gated non-commercial repo or in a container the installer refuses,
    // and its LLM encoder has no re-host with a published sha. No amount of
    // licence surfacing resolves a URL that does not exist.
    expect(SD_BLOCKED_MODELS.map(m => m.id)).toEqual(['flux2-klein-4b'])
    expect(BLOCKED_LOCAL_ROWS.map(r => r.id)).toEqual(['flux2-klein-4b'])
  })
})

describe('the card it becomes', () => {
  const entry = blockedLocalCatalogEntry(BLOCKED_LOCAL_ROWS[0])

  it('is namespaced so it can never collide with an installable sdcpp row', () => {
    expect(entry.id.startsWith(BLOCKED_LOCAL_ID_PREFIX)).toBe(true)
    expect(entry.id).not.toMatch(/^sdcpp:/)
  })

  it('is tagged with its modality so the capability filter finds it', () => {
    expect(entry.capabilities).toContain('image-gen')
  })

  it('declares NO quant — nothing to download, nothing to size, nothing to fit', () => {
    // A quant is a downloadable artifact. This row has none that resolve, so
    // inventing one would give the card a size chip and a VRAM verdict about a
    // file nobody can obtain — a fabricated number under a refusal.
    expect(entry.quants).toEqual([])
  })

  it('is never mistaken for installed (install state is keyed off quants)', () => {
    expect(entry.quants.some(() => true)).toBe(false)
  })

  it('resolves its reason back from the entry id, and only from a blocked id', () => {
    expect(blockedLocalReasonFor(entry.id)).toBe(BLOCKED_LOCAL_ROWS[0].reason)
    expect(blockedLocalReasonFor('sdcpp:sd-turbo')).toBeNull()
    expect(blockedLocalReasonFor('llamacpp:whatever')).toBeNull()
    expect(blockedLocalReasonFor(`${BLOCKED_LOCAL_ID_PREFIX}not-a-row`)).toBeNull()
  })

  it('builds one entry per blocked row', () => {
    expect(blockedLocalCatalogEntries()).toHaveLength(BLOCKED_LOCAL_ROWS.length)
  })
})

describe('the grid renders it with the reason and NO buttons', () => {
  it('the store folds blocked rows into the same curated list', () => {
    const store = read('src/pages/catalog/catalog.store.ts')
    expect(store).toMatch(/blockedLocalCatalogEntries/)
    // Alongside the installable sd.cpp rows, in the same slot.
    expect(store).toMatch(/parts\.sd = \[[\s\S]{0,160}blockedLocalCatalogEntries\(\)\]/)
  })

  it('ModelCard reuses the civitai honesty idiom: reason in place of the button', () => {
    const card = read('src/pages/catalog/ModelCard.tsx')
    expect(card).toMatch(/blockedReason/)
    // The refusal is checked BEFORE any button branch, so no download/run
    // control can be drawn for a row that cannot install.
    const refusal  = card.search(/blockedReason \?/)
    const download = card.search(/data-tour="catalog-download"/)
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(download)
  })

  it('CatalogPage feeds the reason to every grid it draws', () => {
    const page = read('src/pages/catalog/CatalogPage.tsx')
    expect(page).toMatch(/blockedLocalReasonFor/)
    // Main grid + the Favorites and Recents rails, which draw the same rows.
    expect((page.match(/blockedReason=\{blockedLocalReasonFor\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('ships the badge label in every locale', () => {
    const en = (JSON.parse(read('src/i18n/locales/en/catalog.json')) as Record<string, string>).notAvailable
    expect(en).toBeTruthy()
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/catalog.json`)) as Record<string, string>
      expect(json.notAvailable, `${l}/catalog.json notAvailable`).toBeTruthy()
      if (l !== 'en') expect(json.notAvailable, `${l} is still the English string`).not.toBe(en)
    }
  })
})

// ── …and the star, which the refusal branch never reached ────────────────────
//
// Driver finding (owner, live): the Klein card correctly shows NOT AVAILABLE and
// the reason where its buttons would be — and still offers the ☆ in the corner.
// You can favourite a model you can never install: it is then pinned to the top
// of the Favorites rail, permanently, as a card that only says no.
//
// The star sits ABOVE the footer, in its own absolutely-positioned corner, so
// the "checked FIRST, before any button branch" guard the refusal added never
// applied to it — its only condition was `!civitai`. Same law, one control
// further up the card.
//
// THE ONE THING IT MUST NOT DO IS STRAND AN EXISTING PIN. Someone who starred
// Klein before this change would otherwise have a favourite with no control to
// remove it. So a blocked row keeps the star exactly while it IS favourited —
// undo stays available, a new pin cannot be made — and once removed it is gone.
describe('a row that cannot be installed cannot be favourited', () => {
  it('draws no star on a blocked row', () => {
    expect(showsFavoriteControl({ blockedReason: BLOCKED_LOCAL_ROWS[0].reason, favorite: false })).toBe(false)
  })

  it('but still lets an ALREADY-pinned blocked row be un-pinned', () => {
    expect(showsFavoriteControl({ blockedReason: BLOCKED_LOCAL_ROWS[0].reason, favorite: true })).toBe(true)
  })

  it('keeps the existing Civitai rule: never, pinned or not', () => {
    // Favorites are resolved against the CURATED list, so a starred search
    // result would never appear in the rail — a control that does nothing.
    expect(showsFavoriteControl({ isCivitaiRow: true, favorite: false })).toBe(false)
    expect(showsFavoriteControl({ isCivitaiRow: true, favorite: true })).toBe(false)
  })

  it('leaves every ordinary curated row exactly as it was', () => {
    expect(showsFavoriteControl({})).toBe(true)
    expect(showsFavoriteControl({ favorite: true })).toBe(true)
    // An empty reason is not a refusal (blockedLocalReasonFor returns null, not '').
    expect(showsFavoriteControl({ blockedReason: null })).toBe(true)
    expect(showsFavoriteControl({ blockedReason: '' })).toBe(true)
  })

  it('ModelCard asks the predicate instead of re-deriving the rule', () => {
    const card = read('src/pages/catalog/ModelCard.tsx')
    expect(card).toContain('showsFavoriteControl')
    // The guard is on the star itself, not somewhere further down the card.
    const guard = card.indexOf('showsFavoriteControl')
    const star  = card.indexOf("{favorite ? '★' : '☆'}")
    expect(guard).toBeGreaterThan(-1)
    expect(star).toBeGreaterThan(guard)
    // …and it is still ABOVE the footer branch that renders the reason.
    expect(star).toBeLessThan(card.search(/blockedReason \?/))
    // The old unconditional-`!civitai` guard is gone (it is inside the predicate).
    expect(card).not.toMatch(/\{!civitai && \(\s*\n\s*<button/)
  })
})

describe('the CLOUD lists are untouched', () => {
  const mirror = read('src/pages/catalog/blockedLocalRows.ts')

  it('never names the provider-hosted model of the same family', () => {
    // Surplus offers "flux.2-klein-4b | FLUX.2 Klein 4B" — THEIR hosted model,
    // served over their API. Ours is `flux2-klein-4b` (no dot), local weights.
    // One character apart, and confusing them would put a refusal on a model
    // that works fine.
    expect(BLOCKED_LOCAL_ROWS.some(r => r.id === 'flux.2-klein-4b')).toBe(false)
    expect(mirror).not.toContain("'flux.2-klein-4b'")
  })

  it('is pure data — it reaches no provider IPC at all', () => {
    // The only import it may carry is the CatalogEntry type.
    const imports = mirror.match(/^import .+$/gm) ?? []
    expect(imports).toEqual(["import type { CatalogEntry, Capability } from '@tachi/core'"])
    expect(mirror).not.toMatch(/window\.tachi/)
  })
})
