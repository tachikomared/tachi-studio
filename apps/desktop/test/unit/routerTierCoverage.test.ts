// apps/desktop/test/unit/routerTierCoverage.test.ts
//
// A DEAD ROUTER PATTERN IS SILENT, WHICH IS WHY IT ROTS.
//
// `resolveChain` skips a pattern that matches nothing (surplus-router.ts) — no
// warning, no error, the chain is just shorter than it reads. Audited against
// the live catalogs on 2026-08-03:
//
//   BANKR   `gemini-3-pro` (in FOUR sets), `deepseek-r1`, `o3`, `o4`,
//           `llama-3.2`, `llama-3.3-70b`, `gpt-5-mid` → matched nothing.
//           REASONING was down to two live entries out of six.
//   VENICE  fourteen dead patterns, FOUR of them in VISION — so an image was
//           routed by a two-entry chain that reads as six.
//
// Meanwhile both catalogs had grown a whole generation the router could not
// reach. These tests fail the moment that starts again, using each provider's
// own SHIPPED FALLBACK CATALOG as the fixture: it is checked in, it is what a
// user with no network sees, and it is the closest thing to the live list that
// a unit test may depend on.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// venice-service reaches the keychain, which reads app.getPath at module scope.
// Nothing here touches a key; the mock exists only so the fallback LIST can be
// imported rather than grepped out of the source.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

import { BANKR_TIERS, VENICE_TIERS, IMGNAI_TIERS, SURPLUS_TIERS } from '../../electron/services/surplus-router'
import { VENICE_FALLBACK_IDS } from '../../electron/services/venice-service'

// THE FIXTURE IS A DATED SNAPSHOT OF THE LIVE CATALOGS, not the shipped
// fallback arrays, and the difference matters: a fallback is a 9-model
// emergency list for when the gateway is unreachable, while the tier maps are
// written against the 57 / 106 / 56 models the gateways actually serve. Testing
// the maps against the fallback would demand that a curated handful cover eight
// tiers, which is not what either list is for.
//
// A frozen snapshot goes stale — that is its nature and it is why it carries
// its date in the filename and in `readOn`. Stale-and-dated beats a network
// call in a unit test, and beats no check at all, which is what let the maps
// rot for months.
const SNAPSHOT = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/live-catalogs-2026-08-03.json'), 'utf8'),
) as { readOn: string; bankr: string[]; venice: string[]; imgnai: string[] }

const CATALOGS: Record<string, { tiers: Record<string, string[]>; ids: string[] }> = {
  bankr:  { tiers: BANKR_TIERS,  ids: SNAPSHOT.bankr.map(s => s.toLowerCase()) },
  venice: { tiers: VENICE_TIERS, ids: SNAPSHOT.venice.map(s => s.toLowerCase()) },
  imgnai: { tiers: IMGNAI_TIERS, ids: SNAPSHOT.imgnai.map(s => s.toLowerCase()) },
}

describe('every tier pattern resolves to a model the gateway serves', () => {
  for (const [name, { tiers, ids }] of Object.entries(CATALOGS)) {
    it(`${name}: the fallback catalog is readable at all`, () => {
      // If this fails the parser above broke, not the router.
      expect(ids.length).toBeGreaterThan(5)
    })

    it(`${name}: no set is left with fewer than two live entries`, () => {
      // The number that matters is not "how many patterns" but "how many can
      // actually be picked". A one-entry chain has no fallback at all.
      const thin: string[] = []
      for (const [set, pats] of Object.entries(tiers)) {
        const live = pats.filter(p => ids.some(id => id.includes(p.toLowerCase())))
        if (live.length < 2) thin.push(`${set} (${live.length} live of ${pats.length})`)
      }
      expect(thin, `thin chains in ${name}: ${thin.join(', ')}`).toEqual([])
    })
  }
})

describe('the tier maps stay distinct, because the catalogs are', () => {
  it('imgnAI has its own map — it spells versions a third way', () => {
    // Bankr writes `gpt-5.6-sol`, Venice writes `openai-gpt-56-sol`, imgnAI
    // writes `gpt-5-6-sol`. One shared map cannot match all three.
    expect(IMGNAI_TIERS).not.toEqual(BANKR_TIERS)
    expect(IMGNAI_TIERS.TOP.some(p => p.includes('-'))).toBe(true)
    // …and it must not carry a dotted spelling, which is Bankr's convention.
    for (const pats of Object.values(IMGNAI_TIERS)) {
      for (const p of pats) expect(p, `imgnai pattern "${p}" uses a dot`).not.toMatch(/\d\.\d/)
    }
  })

  it('every map covers all eight model sets', () => {
    const sets = Object.keys(SURPLUS_TIERS).sort()
    for (const [name, m] of Object.entries({ BANKR_TIERS, VENICE_TIERS, IMGNAI_TIERS })) {
      expect(Object.keys(m).sort(), name).toEqual(sets)
      for (const [set, pats] of Object.entries(m)) {
        expect(pats.length, `${name}.${set} is empty`).toBeGreaterThan(0)
      }
    }
  })
})

// ── THE FALLBACK LIST ROTS THE SAME WAY, AND IS SEEN BY MORE PEOPLE ─────────
//
// The router's patterns are matched against a live catalog and fail quietly.
// Venice's shipped fallback is worse: it is what a user with NO key and no
// network is shown, so a dead id there is offered to be clicked. Two of its ten
// named models Venice no longer serves — `qwen-2.5-vl` and `mistral-31-24b` —
// and those two were the list's only vision entries.
describe('the Venice fallback names models Venice actually serves', () => {
  it('every fallback id is in the dated catalog', () => {
    const live = new Set(SNAPSHOT.venice.map(s => s.toLowerCase()))
    const dead = VENICE_FALLBACK_IDS.filter(id => !live.has(id.toLowerCase()))
    // Exact ids, not substrings: this list is offered to a user as a choice, so
    // "something like it exists" is not good enough.
    expect(dead, `fallback ids absent from the ${SNAPSHOT.readOn} catalog: ${dead.join(', ')}`).toEqual([])
  })

  it('the two that were dead are named here so they cannot come back', () => {
    for (const gone of ['qwen-2.5-vl', 'mistral-31-24b']) {
      expect(VENICE_FALLBACK_IDS).not.toContain(gone)
    }
  })
})

describe('the retired ids that started this are gone', () => {
  it('no map still names a model its vendor no longer serves', () => {
    // grok-4 was retired 2026-05-15 and silently redirects; gemini-3-pro and
    // deepseek-r1 are absent from every catalog we read. A router pattern is
    // not a price row, but pointing one at a dead id is how a chain quietly
    // loses a rung.
    const dead = ['gemini-3-pro', 'deepseek-r1', 'o3', 'o4', 'gpt-5-mid']
    for (const [name, m] of Object.entries({ BANKR_TIERS, VENICE_TIERS, IMGNAI_TIERS })) {
      for (const [set, pats] of Object.entries(m)) {
        for (const d of dead) {
          expect(pats, `${name}.${set} still names ${d}`).not.toContain(d)
        }
      }
    }
  })
})
