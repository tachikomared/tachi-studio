// apps/desktop/test/unit/civitaiGate.test.ts
//
// THE GATE. civitai-gate.ts imports nothing at all — no electron, no fetch, no
// settings — which is what makes this file able to assert TOTALITY rather than
// spot-check: layer 0 is walked over the full cartesian product of every flag
// the API exposes, and there is no argument that could have changed the answer.
//
// The headline case is real, not invented: `Realistic Vision V6.0 B1` is the
// #1 most-downloaded checkpoint on Civitai and it comes back from a
// `nsfw=false` request with `nsfw: false` and `nsfwLevel: 15` (PG|PG13|R|X).
// The fixture in test/fixtures/civitai/models-page.json is that exact response,
// captured live on 2026-07-28.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  sfwOnly,
  normalizeTag,
  hasDeniedTag,
  layer0Excluded,
  layer1SfwPass,
  civitaiRowAllowed,
  isPgPreviewImage,
  NSFW_BIT,
} from '../../electron/services/civitai-gate'

const FIXTURES = fileURLToPath(new URL('../fixtures/civitai/', import.meta.url))
const page = JSON.parse(readFileSync(join(FIXTURES, 'models-page.json'), 'utf8')) as {
  items: Array<Record<string, unknown> & { modelVersions: Array<Record<string, unknown>> }>
}
const byId = (id: number) => page.items.find(m => m.id === id)!

describe('sfwOnly — bitmask, never an ordinal', () => {
  it('passes exactly PG, PG13 and PG|PG13', () => {
    expect(sfwOnly(1)).toBe(true)   // PG
    expect(sfwOnly(2)).toBe(true)   // PG13
    expect(sfwOnly(3)).toBe(true)   // PG|PG13
  })

  it('rejects every level carrying a bit above PG13', () => {
    for (const level of [4, 5, 7, 8, 11, 13, 15, 16, 22, 23, 24, 30, 31, 32, 60, 63]) {
      expect(sfwOnly(level), `level ${level}`).toBe(false)
    }
  })

  it('rejects level 0 and every non-integer — unknown is not safe', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, null, undefined, '1', '', {}, []]) {
      expect(sfwOnly(bad as unknown), JSON.stringify(bad)).toBe(false)
    }
  })

  it('is a `&` test, not a `>=` test (the whole point)', () => {
    // 24 = X|XXX carries neither PG nor PG13 and is not "greater than" R.
    // An ordinal implementation (`level <= 3`) would agree here by accident,
    // so pin the case that separates them: 16 (XXX alone) is below nothing.
    expect(sfwOnly(24)).toBe(false)
    expect(sfwOnly(16)).toBe(false)
    // and a level that is numerically small but carries R:
    expect(sfwOnly(NSFW_BIT.R)).toBe(false)
  })
})

describe('normalizeTag / hasDeniedTag — whole tokens, never substrings', () => {
  it('folds case, diacritics and every separator to single spaces', () => {
    expect(normalizeTag('Young_Girl')).toBe('young girl')
    expect(normalizeTag('  Anime-Style / Art  ')).toBe('anime style art')
    expect(normalizeTag('lóli')).toBe('loli')
    expect(normalizeTag('麦橘写实')).toBe('')
    expect(normalizeTag(null)).toBe('')
  })

  it('keeps digits so architecture tokens survive intact', () => {
    expect(normalizeTag('SD 1.5')).toBe('sd 1 5')
    expect(normalizeTag('sdxl1.0')).toBe('sdxl1 0')
    expect(hasDeniedTag(['sd15', 'sdxl', 'flux1d', '3d'])).toBe(false)
  })

  it('does NOT fire on a substring — that is the documented contract', () => {
    // 'analog' contains 'anal'; 'holiday' contains 'oli'; 'kidney' contains
    // 'kid'; 'protein' contains 'teen'. None may be excluded.
    expect(hasDeniedTag(['analog', 'holiday', 'kidney', 'protein', 'canteen', 'skidding'])).toBe(false)
  })

  it('DOES fire on the denied token however it is punctuated', () => {
    for (const tag of ['loli', 'LOLI', 'lolicon', 'Shota', 'under-age', 'under_age', 'jailbait', 'school girl', 'loli.con', 'jail bait']) {
      expect(hasDeniedTag([tag]), tag).toBe(true)
    }
  })

  it('the adjacent-pair join stays token-aligned (no arbitrary spans)', () => {
    // 'under age' → 'underage' (denied). But a three-token span is never
    // joined, and non-neighbours are never joined, so ordinary prose survives.
    expect(hasDeniedTag(['under age'])).toBe(true)
    expect(hasDeniedTag(['under the age of the sun'])).toBe(false)
    expect(hasDeniedTag(['photo realistic'])).toBe(false)   // → 'photorealistic'
    expect(hasDeniedTag(['semi realistic', 'base model', 'sd 1 5'])).toBe(false)
  })

  it('fires on multi-word phrases with token boundaries', () => {
    expect(hasDeniedTag(['photo of a young girl'])).toBe(true)
    expect(hasDeniedTag(['young'])).toBe(false)          // 'young' alone is not enough
    expect(hasDeniedTag(['younggirlish'])).toBe(false)   // still not a substring matcher
  })

  it('scans a whole list and short-circuits on the first hit', () => {
    expect(hasDeniedTag(['anime', 'style', 'toddler', 'art'])).toBe(true)
    expect(hasDeniedTag(['anime', 'style', 'art'])).toBe(false)
    expect(hasDeniedTag([])).toBe(false)
  })
})

// ─── TOTALITY ────────────────────────────────────────────────────────────────

describe('layer0Excluded — no flag combination gets past it', () => {
  const TRIGGERS = [
    { name: 'poi',        apply: (m: Record<string, unknown>) => { m.poi = true } },
    { name: 'minor',      apply: (m: Record<string, unknown>) => { m.minor = true } },
    { name: 'takenDown',  apply: (m: Record<string, unknown>) => { m.mode = 'TakenDown' } },
    { name: 'blockedBit', apply: (m: Record<string, unknown>) => { m.nsfwLevel = (m.nsfwLevel as number) | NSFW_BIT.BLOCKED } },
    { name: 'deniedTag',  apply: (m: Record<string, unknown>) => { m.tags = [...(m.tags as string[]), 'lolicon'] } },
  ]

  const clean = () => ({
    model: { name: 'Clean Model', poi: false, minor: false, nsfwLevel: 1, tags: ['anime', 'style'] } as Record<string, unknown>,
    version: { name: 'v1', nsfwLevel: 1, trainedWords: ['a photo'] } as Record<string, unknown>,
  })

  it('the all-clear control is NOT excluded (otherwise every case below is vacuous)', () => {
    const { model, version } = clean()
    expect(layer0Excluded(model, version)).toBe(false)
  })

  it('every one of the 31 non-empty trigger subsets is excluded', () => {
    let checked = 0
    for (let mask = 1; mask < (1 << TRIGGERS.length); mask++) {
      const { model, version } = clean()
      const names: string[] = []
      for (let i = 0; i < TRIGGERS.length; i++) {
        if (mask & (1 << i)) { TRIGGERS[i]!.apply(model); names.push(TRIGGERS[i]!.name) }
      }
      expect(layer0Excluded(model, version), names.join('+')).toBe(true)
      checked++
    }
    expect(checked).toBe(31)
  })

  it('excludes on the VERSION side too — blocked bit and denied trained word', () => {
    const a = clean()
    a.version.nsfwLevel = 1 | NSFW_BIT.BLOCKED
    expect(layer0Excluded(a.model, a.version)).toBe(true)

    const b = clean()
    b.version.trainedWords = ['1girl', 'shotacon']
    expect(layer0Excluded(b.model, b.version)).toBe(true)

    const c = clean()
    c.version.name = 'AS-Toddler'
    expect(layer0Excluded(c.model, c.version)).toBe(true)
  })

  it('excludes a VERSION-level minor:true, and ONLY an explicit true', () => {
    // `minor` is documented at version level on GET /api/v1/model-versions/mini/:id
    // (developer.civitai.com/site/reference/model-versions.md) — the same name and
    // the same creator-declared meaning as the model-level flag layer 0 already
    // honours, so it gets the same kill switch. It can only ever BLOCK: no branch
    // reads it to widen anything.
    const flagged = clean()
    flagged.version.minor = true
    expect(layer0Excluded(flagged.model, flagged.version)).toBe(true)
    expect(civitaiRowAllowed(flagged.model, flagged.version)).toBe(false)
    expect(civitaiRowAllowed(flagged.model, flagged.version, { adult: true })).toBe(false)

    // Everything short of `true` leaves the verdict exactly as it was — which is
    // what makes this additive for the browse payload, whose embedded versions do
    // not carry the field at all (see CivitaiLayer0Version.minor).
    for (const not of [false, undefined, null, 0, 1, 'true', {}]) {
      const v = { ...clean().version, minor: not as unknown }
      expect(layer0Excluded(clean().model, v), JSON.stringify(not)).toBe(false)
    }
  })

  it('judges a VERSION-ONLY pair — the install path asks exactly this question', () => {
    // civitai:install (civitai.ipc.ts) re-asks layer 0 with the ONE fact the
    // browse payload could not carry, passing an EMPTY model because the model
    // half already went through this predicate inside fetchCivitaiModelRows. So
    // `{}` + no flag MUST stay a pass: if a future fail-closed-on-empty-model
    // branch landed here, every Civitai install would refuse instead. That is the
    // regression this pins — and the `true` half is what must keep working.
    expect(layer0Excluded({}, {})).toBe(false)
    expect(layer0Excluded({}, { minor: undefined })).toBe(false)
    expect(layer0Excluded({}, { minor: null as unknown })).toBe(false)
    expect(layer0Excluded({}, { minor: false })).toBe(false)
    expect(layer0Excluded({}, { minor: true })).toBe(true)
  })

  it('excludes archived models and fails closed on malformed payloads', () => {
    const { model, version } = clean()
    expect(layer0Excluded({ ...model, mode: 'Archived' }, version)).toBe(true)
    expect(layer0Excluded(null, version)).toBe(true)
    expect(layer0Excluded(model, null)).toBe(true)
    expect(layer0Excluded(undefined, undefined)).toBe(true)
  })

  it('takes NO parameters beyond the payload — nothing can be passed to relax it', () => {
    // A third argument would be the seam a future "adult unlock" leaks through.
    expect(layer0Excluded.length).toBe(2)
  })

  it('is deliberately NOT the SFW pass: an R-rated but unblocked model survives layer 0', () => {
    // Layer 0 is the floor that must still hold in phase 3, when adult content
    // is legitimately visible. The SFW filtering is layer 1's job.
    const { model, version } = clean()
    model.nsfwLevel = 15
    version.nsfwLevel = 15
    expect(layer0Excluded(model, version)).toBe(false)
    expect(layer1SfwPass(model, version)).toBe(false)
    expect(civitaiRowAllowed(model, version)).toBe(false)
  })
})

// ─── THE LEAK, on real captured bytes ────────────────────────────────────────

describe('the nsfw=false leak (live fixture, 2026-07-28)', () => {
  it('drops Realistic Vision V6.0 B1 — nsfw:false, nsfwLevel:15', () => {
    const m = byId(4201)
    // The API really did say this in a nsfw=false response:
    expect(m.nsfw).toBe(false)
    expect(m.nsfwLevel).toBe(15)
    const v = m.modelVersions[0]!
    expect(civitaiRowAllowed(m, v)).toBe(false)
  })

  it('drops Pony Diffusion V6 XL (model 7) even though its version reads 3', () => {
    const m = byId(257749)
    const v = m.modelVersions[0]!
    expect(m.nsfwLevel).toBe(7)
    expect(v.nsfwLevel).toBe(3)
    // BOTH levels must pass — a clean version under a dirty model is not clean.
    expect(sfwOnly(v.nsfwLevel)).toBe(true)
    expect(civitaiRowAllowed(m, v)).toBe(false)
  })

  it('drops Detail Tweaker XL (model 5 = PG|R)', () => {
    const m = byId(122359)
    expect(civitaiRowAllowed(m, m.modelVersions[0]!)).toBe(false)
  })

  it('keeps the genuinely-SFW rows', () => {
    for (const id of [260267, 795765, 618692, 3627, 1274, 65214, 25995, 276082, 147759, 80324]) {
      const m = byId(id)
      expect(civitaiRowAllowed(m, m.modelVersions[0]!), `model ${id} ${String(m.name)}`).toBe(true)
    }
  })

  it('every model in the fixture came from a nsfw=false request', () => {
    // Guards the fixture itself: if someone re-captures it against a different
    // query, the leak assertions above stop meaning what they say.
    expect(page.items.every(m => m.nsfw === false)).toBe(true)
    // …and the leak is not one unlucky row.
    const leaked = page.items.filter(m => !sfwOnly(m.nsfwLevel))
    expect(leaked.length).toBeGreaterThanOrEqual(3)
  })

  it('no live row carried poi/minor/mode — the flags are a belt, not the gate', () => {
    // Exactly the spec's warning: removed content is not served, so `false` is
    // not evidence of safety. If this ever fails, the flags started carrying
    // signal and the comment in civitai-gate.ts needs revisiting.
    expect(page.items.every(m => m.poi === false)).toBe(true)
    expect(page.items.every(m => m.minor === false)).toBe(true)
    expect(page.items.every(m => m.mode === undefined)).toBe(true)
  })
})

describe('isPgPreviewImage — equality on level 1, not a bitmask pass', () => {
  it('accepts only nsfwLevel === 1', () => {
    expect(isPgPreviewImage({ nsfwLevel: 1, type: 'image' })).toBe(true)
    expect(isPgPreviewImage({ nsfwLevel: 2, type: 'image' })).toBe(false)   // PG13: still no
    expect(isPgPreviewImage({ nsfwLevel: 3, type: 'image' })).toBe(false)
    expect(isPgPreviewImage({ nsfwLevel: 0 })).toBe(false)
    expect(isPgPreviewImage(null)).toBe(false)
  })

  it('rejects video previews', () => {
    expect(isPgPreviewImage({ nsfwLevel: 1, type: 'video' })).toBe(false)
  })

  it('every preview image in the live fixture is already clamped to PG', () => {
    const images = page.items.flatMap(m => m.modelVersions.flatMap(v => (v.images as Array<{ nsfwLevel: number }>) ?? []))
    expect(images.length).toBeGreaterThan(10)
    expect(images.every(i => i.nsfwLevel === 1)).toBe(true)
  })
})
