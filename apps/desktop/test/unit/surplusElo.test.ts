// apps/desktop/test/unit/surplusElo.test.ts
//
// Online incremental Elo / Bradley-Terry global model ranking, layered over the
// bandit as a COLD-START-SAFE late prior (STEAL .research-tmp/repos/LLMRouter
// elorouter/trainer.py compute_elo_mle — pairwise win/loss → Elo). The trainer
// is BATCH logistic-regression MLE; we record outcomes one at a time, so this is
// the standard online Elo update R += K*(score - expected) against a fixed
// category baseline (1500). Class is electron-free (path + clock injected) for
// vitest, mirroring CostLedger.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurplusEloStore, ELO_DEFAULT, eloExpected } from '../../electron/services/surplus-elo'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'surplus-elo-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

function makeStore() {
  return new SurplusEloStore(join(dir, 'surplus-elo.json'))
}

describe('eloExpected (Bradley-Terry logistic)', () => {
  it('equal ratings give a 0.5 expectation (symmetry)', () => {
    expect(eloExpected(1500, 1500)).toBeCloseTo(0.5)
  })

  it('expected scores of the two sides sum to 1', () => {
    const e = eloExpected(1600, 1480)
    const eOpp = eloExpected(1480, 1600)
    expect(e + eOpp).toBeCloseTo(1)
  })

  it('a higher rating yields a higher-than-0.5 expectation', () => {
    expect(eloExpected(1700, 1500)).toBeGreaterThan(0.5)
    expect(eloExpected(1300, 1500)).toBeLessThan(0.5)
  })
})

describe('SurplusEloStore.getElo default', () => {
  it('an unseen (bucket, model) defaults to 1500', () => {
    const s = makeStore()
    expect(s.getElo('general:MID', 'never-seen')).toBe(ELO_DEFAULT)
    expect(ELO_DEFAULT).toBe(1500)
  })
})

describe('SurplusEloStore.recordOutcome', () => {
  it('a win moves the rating UP from the default', () => {
    const s = makeStore()
    s.recordOutcome('general:MID', 'm', true)
    expect(s.getElo('general:MID', 'm')).toBeGreaterThan(ELO_DEFAULT)
  })

  it('a loss moves the rating DOWN from the default', () => {
    const s = makeStore()
    s.recordOutcome('general:MID', 'm', false)
    expect(s.getElo('general:MID', 'm')).toBeLessThan(ELO_DEFAULT)
  })

  it('a win then a loss against the baseline nets near-zero (symmetry at 1500)', () => {
    // At R == baseline, expected == 0.5, so +K*0.5 then -K*0.5 ≈ original (the
    // tiny asymmetry is the rating moving off-baseline between the two updates).
    const s = makeStore()
    s.recordOutcome('general:MID', 'm', true)
    s.recordOutcome('general:MID', 'm', false)
    expect(s.getElo('general:MID', 'm')).toBeCloseTo(ELO_DEFAULT, 0)
  })

  it('keeps ratings per (bucket, model) — different buckets are independent', () => {
    const s = makeStore()
    s.recordOutcome('code:TOP', 'm', true)
    expect(s.getElo('code:TOP', 'm')).toBeGreaterThan(ELO_DEFAULT)
    expect(s.getElo('general:MID', 'm')).toBe(ELO_DEFAULT) // untouched bucket
  })

  it('repeated wins keep climbing but with diminishing steps (expected→1)', () => {
    const s = makeStore()
    s.recordOutcome('general:MID', 'm', true)
    const afterOne = s.getElo('general:MID', 'm')
    s.recordOutcome('general:MID', 'm', true)
    const afterTwo = s.getElo('general:MID', 'm')
    expect(afterTwo).toBeGreaterThan(afterOne)
    expect(afterTwo - afterOne).toBeLessThan(afterOne - ELO_DEFAULT)
  })
})

describe('SurplusEloStore.eloRank', () => {
  it('orders model ids by Elo descending', () => {
    const s = makeStore()
    s.recordOutcome('general:MID', 'win', true)
    s.recordOutcome('general:MID', 'win', true)
    s.recordOutcome('general:MID', 'loss', false)
    // 'mid' stays at the default 1500.
    const ranked = s.eloRank('general:MID', ['loss', 'mid', 'win'])
    expect(ranked).toEqual(['win', 'mid', 'loss'])
  })

  it('is a stable sort (equal Elo keeps input order)', () => {
    const s = makeStore()
    expect(s.eloRank('general:MID', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input array', () => {
    const s = makeStore()
    const ids = ['a', 'b']
    s.eloRank('general:MID', ids)
    expect(ids).toEqual(['a', 'b'])
  })
})

describe('SurplusEloStore persistence', () => {
  it('a new instance over the same file sees prior ratings', () => {
    const path = join(dir, 'surplus-elo.json')
    const a = new SurplusEloStore(path)
    a.recordOutcome('general:MID', 'm', true)
    const elo = a.getElo('general:MID', 'm')
    const b = new SurplusEloStore(path)
    expect(b.getElo('general:MID', 'm')).toBe(elo)
  })

  it('writes valid JSON keyed by bucket|model', () => {
    const path = join(dir, 'surplus-elo.json')
    const s = new SurplusEloStore(path)
    s.recordOutcome('general:MID', 'm', true)
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, number>
    expect(typeof j['general:MID|m']).toBe('number')
    expect(j['general:MID|m']).toBeGreaterThan(ELO_DEFAULT)
  })

  it('stamps + round-trips the injected write clock (lastUpdatedAt)', () => {
    const path = join(dir, 'clock.json')
    const a = new SurplusEloStore(path, () => 123_456)
    expect(a.lastUpdatedAt()).toBe(0) // never written yet
    a.recordOutcome('general:MID', 'm', true)
    expect(a.lastUpdatedAt()).toBe(123_456)
    // A fresh instance reloads the timestamp from disk.
    const b = new SurplusEloStore(path, () => 999)
    expect(b.lastUpdatedAt()).toBe(123_456)
  })

  it('the reserved timestamp key never leaks into a rating lookup', () => {
    const path = join(dir, 'meta.json')
    const s = new SurplusEloStore(path, () => 42)
    s.recordOutcome('general:MID', 'm', true)
    const reloaded = new SurplusEloStore(path)
    // The meta key must not be readable as a (bucket, model) pair.
    expect(reloaded.getElo('', 'updatedAt')).toBe(ELO_DEFAULT)
    expect(reloaded.eloRank('general:MID', ['m'])).toEqual(['m'])
  })

  it('tolerates a missing file (default ratings, no throw)', () => {
    const s = new SurplusEloStore(join(dir, 'does-not-exist.json'))
    expect(s.getElo('x:y', 'm')).toBe(ELO_DEFAULT)
  })

  it('tolerates a corrupt file (falls back to defaults, no throw)', () => {
    const path = join(dir, 'corrupt.json')
    // Write garbage, then load.
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(path, '{ this is not json', 'utf8')
    const s = new SurplusEloStore(path)
    expect(s.getElo('x:y', 'm')).toBe(ELO_DEFAULT)
    // It can still record after a corrupt load.
    s.recordOutcome('x:y', 'm', true)
    expect(s.getElo('x:y', 'm')).toBeGreaterThan(ELO_DEFAULT)
  })
})
