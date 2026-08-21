// apps/desktop/test/unit/civitaiAdultGate.test.ts
//
// PHASE 3 — the 18+ unlock, the host switch, and the proof that neither can
// reach past layer 0.
//
// THE ONE THING THIS FILE EXISTS FOR: layer 0 must be provably unconditional.
// civitaiGate.test.ts already walks every trigger subset in the DEFAULT mode;
// this file walks the same product again with `adult: true` and asserts the
// answers did not move. If a future refactor gives layer 0 a mode parameter,
// this suite is what fails.
//
// It also pins the three things the unlock is made of, because each of them is
// a place where "it mostly works" would be indistinguishable from correct:
//   • the CEILING is 31, never 60 — 60 carries the Blocked bit;
//   • the HOST is the mode, and the thumbnail containment does NOT follow it
//     (image.civitai.red does not exist — verified by DNS, twice);
//   • the CREDENTIAL is ANDed in live, so removing the key locks instantly.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The keychain double is the whole point of resolveCivitaiAdult's test: the
// unlock is settings AND a live key read, and only a stub can walk both axes.
const h = vi.hoisted(() => ({ key: null as string | null, broken: false }))
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: () => h.key,
  hasKey: () => {
    if (h.broken) throw new Error('Encryption not available on this system')
    return h.key !== null
  },
}))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import {
  adultAllowed,
  civitaiAdultUnlocked,
  civitaiRowAllowed,
  isAdultPreviewImage,
  isPgPreviewImage,
  layer0Excluded,
  layer1SfwPass,
  layer2AdultPass,
  sfwOnly,
  NSFW_ADULT_CAP,
  NSFW_BIT,
} from '../../electron/services/civitai-gate'
import {
  buildCivitaiSearchUrl,
  civitaiApiBase,
  civitaiThumbnailCandidates,
  mapCivitaiPage,
  pickPreviewImage,
  resolveCivitaiAdult,
  civitaiKeyStored,
  isCivitaiModelType,
  isCivitaiPeriod,
  isCivitaiSort,
  CIVITAI_MODEL_TYPES,
  CIVITAI_PERIODS,
  CIVITAI_SORTS,
} from '../../electron/services/civitai-search'
import {
  canAffirmCivitaiAdult,
  civitaiAdultLockPatch,
  civitaiAdultStatus,
  civitaiAdultUnlockPatch,
  formatCivitaiAcceptedAt,
} from '../../src/components/civitaiAdultPolicy'
import { CIVITAI_TYPE_FILTERS } from '../../src/pages/catalog/civitaiRow'

const FIXTURES = fileURLToPath(new URL('../fixtures/civitai/', import.meta.url))
const rawPage = JSON.parse(readFileSync(join(FIXTURES, 'models-page.json'), 'utf8')) as {
  items: Array<Record<string, unknown> & { id: number; modelVersions: Array<Record<string, unknown>> }>
}
const SRC = fileURLToPath(new URL('../../electron/services/civitai-search.ts', import.meta.url))
const searchSrc = readFileSync(SRC, 'utf8')

// ─── the ceiling ─────────────────────────────────────────────────────────────

describe('the adult ceiling is 31, and 60 is the trap', () => {
  it('is exactly PG|PG13|R|X|XXX', () => {
    expect(NSFW_ADULT_CAP).toBe(31)
    expect(NSFW_ADULT_CAP).toBe(
      NSFW_BIT.PG | NSFW_BIT.PG13 | NSFW_BIT.R | NSFW_BIT.X | NSFW_BIT.XXX,
    )
  })

  it('REFUSES 60 — the `nsfw: true` sentinel carries Blocked', () => {
    // 60 = R|X|XXX|Blocked. Every implementation that "caps at 60" admits
    // Blocked content through the front door of the careful mode.
    expect(60 & NSFW_BIT.BLOCKED).toBe(32)
    expect(adultAllowed(60)).toBe(false)
  })

  it('accepts every level made only of bits at or below XXX', () => {
    for (const lvl of [1, 2, 3, 4, 7, 8, 15, 16, 23, 24, 31]) {
      expect(adultAllowed(lvl), `level ${lvl}`).toBe(true)
    }
  })

  it('is a bitmask test, not `level <= 31`', () => {
    // 32 alone (Blocked with nothing else) is the case an ordinal check misses:
    // it is not "greater than 60", so `level <= 60` would wave it through.
    expect(32).toBeLessThan(60)
    expect(adultAllowed(32)).toBe(false)
    expect(adultAllowed(33)).toBe(false)     // PG|Blocked
    expect(adultAllowed(63)).toBe(false)     // everything
  })

  it('treats unknown as unsafe, exactly like sfwOnly', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity, '31', null, undefined, {}]) {
      expect(adultAllowed(bad as unknown), String(bad)).toBe(false)
    }
  })

  it('is strictly wider than the SFW pass and strictly narrower than "anything"', () => {
    for (let lvl = 1; lvl <= 64; lvl++) {
      if (sfwOnly(lvl)) expect(adultAllowed(lvl), `level ${lvl}`).toBe(true)
    }
    expect(sfwOnly(4)).toBe(false)
    expect(adultAllowed(4)).toBe(true)
  })
})

// ─── LAYER 0 IS ABSOLUTE ─────────────────────────────────────────────────────

describe('LAYER 0 — no mode, no flag combination, no unlock gets past it', () => {
  const clean = () => ({
    model: {
      name: 'Clean Model', poi: false, minor: false, mode: undefined,
      nsfwLevel: 1, tags: ['anime', 'style'],
    },
    version: { name: 'v1', nsfwLevel: 1, trainedWords: ['a token'] },
  })

  /** Every way a row can be layer-0 poison. */
  const TRIGGERS: Array<[string, (r: ReturnType<typeof clean>) => void]> = [
    ['poi',            r => { r.model.poi = true }],
    ['minor',          r => { r.model.minor = true }],
    ['takenDown',      r => { (r.model as { mode?: string }).mode = 'TakenDown' }],
    ['archived',       r => { (r.model as { mode?: string }).mode = 'Archived' }],
    ['modelBlocked',   r => { r.model.nsfwLevel = 32 }],
    ['versionBlocked', r => { r.version.nsfwLevel = 33 }],
    ['deniedTag',      r => { r.model.tags = ['anime', 'loli'] }],
    ['deniedWord',     r => { r.version.trainedWords = ['schoolgirl'] }],
    ['deniedName',     r => { r.model.name = 'Toddler Mix v2' }],
  ]

  it('the all-clear control passes in BOTH modes (else every case below is vacuous)', () => {
    const r = clean()
    expect(layer0Excluded(r.model, r.version)).toBe(false)
    expect(civitaiRowAllowed(r.model, r.version)).toBe(true)
    expect(civitaiRowAllowed(r.model, r.version, { adult: true })).toBe(true)
  })

  it('every non-empty subset of the 9 triggers is excluded — in both modes', () => {
    let checked = 0
    for (let mask = 1; mask < (1 << TRIGGERS.length); mask++) {
      const r = clean()
      const names: string[] = []
      TRIGGERS.forEach(([name, apply], i) => {
        if (mask & (1 << i)) { apply(r); names.push(name) }
      })
      const label = names.join('+')
      expect(layer0Excluded(r.model, r.version), label).toBe(true)
      // …and no mode value reaches past it.
      expect(civitaiRowAllowed(r.model, r.version), label).toBe(false)
      expect(civitaiRowAllowed(r.model, r.version, {}), label).toBe(false)
      expect(civitaiRowAllowed(r.model, r.version, { adult: false }), label).toBe(false)
      expect(civitaiRowAllowed(r.model, r.version, { adult: true }), label).toBe(false)
      checked++
    }
    expect(checked).toBe(511)      // 2^9 - 1, so the loop really ran
  })

  it('a truthy-but-not-true mode value cannot widen anything either', () => {
    const r = clean()
    r.model.poi = true
    for (const bogus of [1, 'yes', {}, [], 'true']) {
      expect(civitaiRowAllowed(r.model, r.version, { adult: bogus as unknown as boolean })).toBe(false)
    }
  })

  it('an adult-level row is refused by layer 1 and ALLOWED by layer 2 — the ONLY difference', () => {
    const r = clean()
    r.model.nsfwLevel = 15         // PG|PG13|R|X
    r.version.nsfwLevel = 31
    expect(layer0Excluded(r.model, r.version)).toBe(false)
    expect(layer1SfwPass(r.model, r.version)).toBe(false)
    expect(layer2AdultPass(r.model, r.version)).toBe(true)
    expect(civitaiRowAllowed(r.model, r.version)).toBe(false)
    expect(civitaiRowAllowed(r.model, r.version, { adult: true })).toBe(true)
  })

  it('a level-60 model is refused in adult mode TWICE — by layer 0 and by layer 2', () => {
    const r = clean()
    r.model.nsfwLevel = 60
    expect(layer0Excluded(r.model, r.version)).toBe(true)
    expect(layer2AdultPass(r.model, r.version)).toBe(false)
    expect(civitaiRowAllowed(r.model, r.version, { adult: true })).toBe(false)
  })

  it('BOTH levels must pass in adult mode — a clean version under a dirty model is not shown', () => {
    const r = clean()
    r.model.nsfwLevel = 60         // Blocked-bearing sentinel
    r.version.nsfwLevel = 1        // spotless
    expect(civitaiRowAllowed(r.model, r.version, { adult: true })).toBe(false)
  })

  it('layer0Excluded takes exactly two parameters — there is nowhere to pass a mode', () => {
    expect(layer0Excluded.length).toBe(2)
  })

  it('the live fixture behaves the same way: unlocking only ever ADDS rows', () => {
    const sfw = mapCivitaiPage(rawPage)
    const adult = mapCivitaiPage(rawPage, { adult: true })
    const ids = (rs: Array<{ id: string }>) => new Set(rs.map(r => r.id))
    // Every SFW row survives the unlock…
    for (const id of ids(sfw)) expect(ids(adult), id).toContain(id)
    // …and the unlock reveals rows the SFW pass hid (the measured 80% leak).
    expect(adult.length).toBeGreaterThan(sfw.length)
  })
})

// ─── the unlock predicate ────────────────────────────────────────────────────

describe('civitaiAdultUnlocked — three facts, all required', () => {
  const T = true, F = false
  const cases: Array<[boolean, number, boolean, boolean]> = [
    //  adultMode, acceptedAt, hasKey, expected
    [F, 0, F, F], [F, 0, T, F], [F, 1, F, F], [F, 1, T, F],
    [T, 0, F, F], [T, 0, T, F], [T, 1, F, F], [T, 1, T, T],
  ]
  it('is the AND of all three — the full truth table', () => {
    for (const [adultMode, acceptedAt, hasKey, want] of cases) {
      expect(
        civitaiAdultUnlocked({ adultMode, acceptedAt, hasKey }),
        `${adultMode}/${acceptedAt}/${hasKey}`,
      ).toBe(want)
    }
  })

  it('rejects a timestamp that is not a moment in time', () => {
    for (const at of [0, -1, NaN, Infinity, '1700000000000', null, undefined]) {
      expect(
        civitaiAdultUnlocked({ adultMode: true, acceptedAt: at as unknown as number, hasKey: true }),
        String(at),
      ).toBe(false)
    }
  })

  it('rejects a truthy-but-not-true switch (a hand-edited settings file)', () => {
    for (const v of [1, 'true', 'yes', {}]) {
      expect(civitaiAdultUnlocked({ adultMode: v as unknown as boolean, acceptedAt: 1, hasKey: true })).toBe(false)
    }
  })

  it('is null-safe', () => {
    expect(civitaiAdultUnlocked(null)).toBe(false)
    expect(civitaiAdultUnlocked(undefined)).toBe(false)
    expect(civitaiAdultUnlocked({})).toBe(false)
  })
})

describe('resolveCivitaiAdult — the settings are ANDed with a LIVE keychain read', () => {
  it('the settings alone unlock nothing', () => {
    h.key = null
    expect(resolveCivitaiAdult({ adultMode: true, adultAcceptedAt: Date.now() })).toBe(false)
  })

  it('with the key stored, an affirmed switch unlocks', () => {
    h.key = 'civ-secret'
    expect(resolveCivitaiAdult({ adultMode: true, adultAcceptedAt: 1 })).toBe(true)
  })

  it('deleting the key locks on the very next call — no cached verdict', () => {
    h.key = 'civ-secret'
    const q = { adultMode: true, adultAcceptedAt: 1 }
    expect(resolveCivitaiAdult(q)).toBe(true)
    h.key = null
    expect(resolveCivitaiAdult(q)).toBe(false)
  })

  it('an unreadable keychain means SFW, not a crash', () => {
    h.key = 'civ-secret'
    h.broken = true
    expect(civitaiKeyStored()).toBe(false)
    expect(resolveCivitaiAdult({ adultMode: true, adultAcceptedAt: 1 })).toBe(false)
    h.broken = false
  })

  it('no arguments at all is SFW', () => {
    h.key = 'civ-secret'
    expect(resolveCivitaiAdult()).toBe(false)
    expect(resolveCivitaiAdult({})).toBe(false)
    h.key = null
  })
})

// ─── the host IS the mode ────────────────────────────────────────────────────

describe('the host switch', () => {
  it('civitai.com for SFW, civitai.red for unlocked', () => {
    expect(civitaiApiBase(false)).toBe('https://civitai.com/api/v1')
    expect(civitaiApiBase(true)).toBe('https://civitai.red/api/v1')
  })

  it('the SFW url is .com with nsfw=false — and the flag is set EXPLICITLY', () => {
    const u = new URL(buildCivitaiSearchUrl({ query: 'anime' }))
    expect(u.origin).toBe('https://civitai.com')
    // Omitting the param is NOT neutral: measured, it is identical to
    // nsfw=false. Setting it is what keeps the response's previews PG-clamped.
    expect(u.searchParams.get('nsfw')).toBe('false')
  })

  it('the unlocked url is .red with nsfw=true (an INCLUDE flag, measured)', () => {
    const u = new URL(buildCivitaiSearchUrl({ query: 'anime' }, true))
    expect(u.origin).toBe('https://civitai.red')
    expect(u.searchParams.get('nsfw')).toBe('true')
  })

  it('DEFAULTS to SFW — a caller that forgets the argument cannot reach .red', () => {
    expect(new URL(buildCivitaiSearchUrl({})).origin).toBe('https://civitai.com')
  })

  it('the adult flag is a SEPARATE argument, never a field on the query', () => {
    // A renderer-shaped object carrying every plausible spelling still builds
    // a .com url, because the builder does not read any of them.
    const u = new URL(buildCivitaiSearchUrl({
      query: 'x',
      adult: true, adultMode: true, adultAcceptedAt: Date.now(), unlocked: true,
    } as never))
    expect(u.origin).toBe('https://civitai.com')
    expect(u.searchParams.get('nsfw')).toBe('false')
  })
})

describe('THUMBNAIL CONTAINMENT does not follow the host', () => {
  // Re-verified 2026-07-28 on the phase-3 pass: civitai.red serves every
  // images[].url on image.civitai.com, and image.civitai.red is NXDOMAIN.
  const shot = (host: string) => `https://${host}/xG1nkq/original=true/00001.jpeg`

  it('allows image.civitai.com and NOTHING else, in either mode', () => {
    expect(civitaiThumbnailCandidates(shot('image.civitai.com'))).toHaveLength(2)
    for (const host of [
      'image.civitai.red',           // does not resolve — allowlisting it would be a fabrication
      'civitai.red', 'civitai.com',
      'image.civitai.com.evil.test',
      'evil.test',
    ]) {
      expect(civitaiThumbnailCandidates(shot(host)), host).toEqual([])
    }
  })

  it('the file names image.civitai.com exactly once as the containment host', () => {
    expect(searchSrc).toContain("const THUMB_HOST = 'image.civitai.com'")
    expect(searchSrc).not.toContain('image.civitai.red\'')
  })

  it('NOTHING in the thumbnail path writes to disk — memory only, both modes', () => {
    // An on-disk cache would outlive the mode that produced it. There is no
    // fs import in this module at all, which is the strongest form of that.
    expect(searchSrc).not.toMatch(/from 'node:fs'|require\('fs'\)|writeFileSync|createWriteStream/)
  })
})

// ─── previews ────────────────────────────────────────────────────────────────

describe('pickPreviewImage — the LEAST explicit image, never merely the first', () => {
  const img = (nsfwLevel: number, name = 'a') => ({
    url: `https://image.civitai.com/${name}/original=true/x.jpeg`,
    nsfwLevel, type: 'image',
  })

  it('SFW takes the first level-1 image and nothing else', () => {
    const v = { images: [img(4, 'r'), img(1, 'pg'), img(1, 'pg2')] }
    expect(pickPreviewImage(v, false)).toEqual({ url: img(1, 'pg').url, level: 1 })
    expect(pickPreviewImage({ images: [img(2), img(4)] }, false)).toBe(null)
  })

  it('ADULT takes the minimum level available, not the API ordering', () => {
    const v = { images: [img(16, 'xxx'), img(8, 'x'), img(2, 'pg13'), img(4, 'r')] }
    expect(pickPreviewImage(v, true)).toEqual({ url: img(2, 'pg13').url, level: 2 })
  })

  it('ADULT still refuses the Blocked bit — measured 3 of 4095 on a live page', () => {
    expect(pickPreviewImage({ images: [img(32, 'blocked')] }, true)).toBe(null)
    // …and with a clean sibling present, the clean one wins rather than nothing.
    const v = { images: [img(32, 'blocked'), img(8, 'x')] }
    expect(pickPreviewImage(v, true)).toEqual({ url: img(8, 'x').url, level: 8 })
  })

  it('both modes refuse http: and videos', () => {
    const httpImg = { url: 'http://image.civitai.com/a/original=true/x.jpeg', nsfwLevel: 1, type: 'image' }
    const video = { url: 'https://image.civitai.com/a/original=true/x.mp4', nsfwLevel: 1, type: 'video' }
    for (const adult of [false, true]) {
      expect(pickPreviewImage({ images: [httpImg] }, adult), `http adult=${adult}`).toBe(null)
      expect(pickPreviewImage({ images: [video] }, adult), `video adult=${adult}`).toBe(null)
    }
  })

  it('the underlying predicates agree with the picker', () => {
    expect(isPgPreviewImage({ nsfwLevel: 1, type: 'image' })).toBe(true)
    expect(isPgPreviewImage({ nsfwLevel: 2, type: 'image' })).toBe(false)
    expect(isAdultPreviewImage({ nsfwLevel: 31, type: 'image' })).toBe(true)
    expect(isAdultPreviewImage({ nsfwLevel: 32, type: 'image' })).toBe(false)
  })

  it('is empty-safe', () => {
    for (const adult of [false, true]) {
      expect(pickPreviewImage(null, adult)).toBe(null)
      expect(pickPreviewImage({}, adult)).toBe(null)
      expect(pickPreviewImage({ images: [] }, adult)).toBe(null)
    }
  })
})

// ─── the row fields wave B renders from ──────────────────────────────────────

describe('the blur contract is carried per ROW', () => {
  const rows = mapCivitaiPage(rawPage)

  it('every row carries the CHOSEN VERSION level, not just the model level', () => {
    for (const r of rows) {
      expect(typeof r.nsfwLevelVersion, r.name).toBe('number')
      expect(r.nsfwLevelVersion, r.name).toBeGreaterThan(0)
    }
    // A real row where the two genuinely differ, so this is not tautological.
    expect(rows.some(r => r.nsfwLevelVersion !== r.nsfwLevelModel)).toBe(true)
  })

  it('thumbnailNsfwLevel starts at 0 — the pure mapper has fetched no picture', () => {
    for (const r of rows) {
      expect(r.thumbnail, r.name).toBe(null)
      expect(r.thumbnailNsfwLevel, r.name).toBe(0)
    }
  })

  it('in SFW mode no surviving row can be above PG13 — so a locked catalog never blurs', () => {
    const blurs = (level: number) => (level & ~3) !== 0
    for (const r of rows) {
      expect(blurs(r.nsfwLevelModel), r.name).toBe(false)
      expect(blurs(r.nsfwLevelVersion), r.name).toBe(false)
      expect(blurs(r.thumbnailNsfwLevel), r.name).toBe(false)
    }
  })

  it('in adult mode rows above PG13 appear, and they announce it', () => {
    const adultRows = mapCivitaiPage(rawPage, { adult: true })
    const above = adultRows.filter(r => (r.nsfwLevelVersion & ~3) !== 0)
    expect(above.length).toBeGreaterThan(0)
    // …and none of them carries the Blocked bit, in either field.
    for (const r of above) {
      expect(r.nsfwLevelVersion & 32, r.name).toBe(0)
      expect(r.nsfwLevelModel & 32, r.name).toBe(0)
    }
  })
})

// ─── the dialog's rules ──────────────────────────────────────────────────────

describe('the 18+ dialog policy', () => {
  it('needs BOTH the affirmation and the stored key', () => {
    expect(canAffirmCivitaiAdult({ affirmed: false, hasKey: false })).toBe(false)
    expect(canAffirmCivitaiAdult({ affirmed: true, hasKey: false })).toBe(false)
    expect(canAffirmCivitaiAdult({ affirmed: false, hasKey: true })).toBe(false)
    expect(canAffirmCivitaiAdult({ affirmed: true, hasKey: true })).toBe(true)
  })

  it('the unlock patch writes BOTH keys, with a real timestamp', () => {
    expect(civitaiAdultUnlockPatch(1_700_000_000_000)).toEqual({
      civitaiAdultMode: true, civitaiAdultAcceptedAt: 1_700_000_000_000,
    })
    // …and the pair it writes actually unlocks, which a boolean-only write
    // would not (this is the assertion that ties the dialog to the gate).
    const patch = civitaiAdultUnlockPatch(1_700_000_000_000)
    expect(civitaiAdultUnlocked({
      adultMode: patch.civitaiAdultMode,
      acceptedAt: patch.civitaiAdultAcceptedAt,
      hasKey: true,
    })).toBe(true)
  })

  it('a broken clock still produces a moment, never "never affirmed"', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const p = civitaiAdultUnlockPatch(bad)
      expect(p.civitaiAdultAcceptedAt, String(bad)).toBeGreaterThan(0)
    }
    expect(civitaiAdultUnlockPatch(1.9).civitaiAdultAcceptedAt).toBe(1)
  })

  it('the lock patch RESETS the timestamp, so re-enabling re-asks', () => {
    const p = civitaiAdultLockPatch()
    expect(p).toEqual({ civitaiAdultMode: false, civitaiAdultAcceptedAt: 0 })
    expect(civitaiAdultUnlocked({ adultMode: true, acceptedAt: p.civitaiAdultAcceptedAt, hasKey: true })).toBe(false)
  })

  it('the status explains a switch that is on but doing nothing', () => {
    expect(civitaiAdultStatus({ unlocked: true, adultMode: true, acceptedAt: 1, hasKey: true })).toBe('unlocked')
    expect(civitaiAdultStatus({ unlocked: false, adultMode: false, acceptedAt: 0, hasKey: true })).toBe('off')
    expect(civitaiAdultStatus({ unlocked: false, adultMode: true, acceptedAt: 1, hasKey: false })).toBe('no-key')
    expect(civitaiAdultStatus({ unlocked: false, adultMode: true, acceptedAt: 0, hasKey: true })).toBe('not-affirmed')
    expect(civitaiAdultStatus(null)).toBe('off')
  })

  it('never contradicts main: `unlocked` wins over any local reasoning', () => {
    // A state main calls unlocked is reported unlocked even if the renderer's
    // own view of the parts looks inconsistent (a stale hasKey, say).
    expect(civitaiAdultStatus({ unlocked: true, adultMode: false, acceptedAt: 0, hasKey: false })).toBe('unlocked')
  })

  it('formats the affirmation date, and says nothing when there is none', () => {
    expect(formatCivitaiAcceptedAt(0)).toBe('')
    expect(formatCivitaiAcceptedAt(-1)).toBe('')
    expect(formatCivitaiAcceptedAt(null)).toBe('')
    expect(formatCivitaiAcceptedAt(NaN)).toBe('')
    expect(formatCivitaiAcceptedAt(1_700_000_000_000, 'en-US')).toMatch(/\d/)
  })
})

// ─── the dialog's markup (node-only runner ⇒ pinned at the source) ───────────

describe('CivitaiAdultDialog — the four things it owes the user', () => {
  const dialogSrc = readFileSync(
    fileURLToPath(new URL('../../src/components/CivitaiAdultDialog.tsx', import.meta.url)),
    'utf8',
  )
  const stripped = dialogSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('is a real modal with the house a11y hook', () => {
    expect(stripped).toContain('useDialog')
    expect(stripped).toContain('role="dialog"')
    expect(stripped).toContain('aria-modal="true"')
    expect(stripped).toContain('aria-labelledby')
  })

  it('the affirmation is a REAL checkbox with a label, and is NEVER pre-checked', () => {
    expect(stripped).toContain('type="checkbox"')
    expect(stripped).toContain('htmlFor={affirmId}')
    expect(stripped).toMatch(/useState\(false\)/)
    expect(stripped).not.toMatch(/useState\(true\)/)
  })

  it('confirm is gated by the shared policy, not by a re-implementation', () => {
    expect(stripped).toContain('canAffirmCivitaiAdult')
    expect(stripped).toContain('disabled={!canConfirm}')
  })

  it('writes exactly one settings save, using the shared patch', () => {
    expect(stripped).toContain('civitaiAdultUnlockPatch')
    expect((stripped.match(/settings\.save\(/g) ?? []).length).toBe(1)
  })

  it('states what changes, what never changes, the key policy and the undo', () => {
    for (const key of ['whatChanges', 'neverLabel', 'never', 'keyPolicy', 'affirm', 'needKey']) {
      expect(stripped, key).toContain(`civitai.adult.${key}`)
    }
  })

  it('every string is translated — no hard-coded English in the markup', () => {
    // The only literal text nodes allowed are through t(); catch a stray
    // sentence by looking for a capitalised word between JSX tags.
    expect(stripped).not.toMatch(/>\s*[A-Z][a-z]+ [a-z]+[^<{]*</)
  })
})

describe('the 18+ strings exist in all 8 locales', () => {
  const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const
  const KEYS = [
    'title', 'on', 'off', 'whatChanges', 'neverLabel', 'never', 'keyPolicy',
    'affirm', 'needKey', 'enable', 'cancel', 'saveFailed', 'confirmedOn',
    'status.unlocked', 'status.off', 'status.no-key', 'status.not-affirmed',
  ]
  const load = (lang: string) => JSON.parse(readFileSync(
    fileURLToPath(new URL(`../../src/i18n/locales/${lang}/settings.json`, import.meta.url)),
    'utf8',
  )) as Record<string, unknown>

  for (const lang of LANGS) {
    it(`${lang} has every civitai.adult key, non-empty`, () => {
      const adult = (load(lang).civitai as Record<string, unknown>).adult as Record<string, unknown>
      expect(adult, `${lang} civitai.adult`).toBeTruthy()
      for (const k of KEYS) {
        const v = k.split('.').reduce<unknown>(
          (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
          adult,
        )
        expect(typeof v, `${lang} ${k}`).toBe('string')
        expect((v as string).trim().length, `${lang} ${k}`).toBeGreaterThan(0)
      }
    })
  }

  it('the interpolation placeholder survives translation', () => {
    for (const lang of LANGS) {
      const adult = (load(lang).civitai as Record<string, unknown>).adult as Record<string, string>
      expect(adult.confirmedOn, lang).toContain('{{date}}')
    }
  })
})

// ─── the vocabulary main and the renderer must agree on ──────────────────────

describe('the filter vocabulary is exported, complete, and drift-guarded', () => {
  it('is the 22 live ModelType values, and LyCORIS is NOT one of them', () => {
    expect(CIVITAI_MODEL_TYPES).toHaveLength(22)
    expect(CIVITAI_MODEL_TYPES).not.toContain('LyCORIS')
    // The six a hand-written list forgot; a menu missing them is a subset
    // presented as the whole.
    for (const t of ['TextEncoder', 'UNet', 'CLIPVision', 'VisionLanguage', 'CLIP', 'LLM']) {
      expect(CIVITAI_MODEL_TYPES, t).toContain(t)
    }
  })

  it('the type guards accept exactly the enum and nothing else', () => {
    for (const t of CIVITAI_MODEL_TYPES) expect(isCivitaiModelType(t), t).toBe(true)
    for (const bad of ['LyCORIS', 'checkpoint', 'CHECKPOINT', '', null, 7]) {
      expect(isCivitaiModelType(bad), String(bad)).toBe(false)
    }
    for (const s of CIVITAI_SORTS) expect(isCivitaiSort(s)).toBe(true)
    expect(isCivitaiSort('Oldest')).toBe(false)          // 200s upstream, not offered
    for (const p of CIVITAI_PERIODS) expect(isCivitaiPeriod(p)).toBe(true)
    expect(isCivitaiPeriod('Hour')).toBe(false)          // 400s upstream
  })

  it('every type the CATALOG TAB can send is one main will forward', () => {
    // The drift this catches: a filter chip whose string is not in the enum
    // does not narrow the search, it 400s the whole request. Wave B owns which
    // subset to offer; it does not get to invent the strings.
    for (const f of CIVITAI_TYPE_FILTERS) {
      for (const t of f.types ?? []) {
        expect(isCivitaiModelType(t), `${f.id} → ${t}`).toBe(true)
        expect(new URL(buildCivitaiSearchUrl({ types: [t] })).searchParams.getAll('types'), t).toEqual([t])
      }
    }
  })

  it('the renderer type surface declares the same 22 values', () => {
    const dts = readFileSync(
      fileURLToPath(new URL('../../src/types/electron.d.ts', import.meta.url)),
      'utf8',
    )
    const block = dts.slice(dts.indexOf('export type CivitaiModelType'), dts.indexOf('export type CivitaiSort'))
    for (const t of CIVITAI_MODEL_TYPES) expect(block, t).toContain(`'${t}'`)
    expect(block).not.toContain("'LyCORIS'")
  })
})
