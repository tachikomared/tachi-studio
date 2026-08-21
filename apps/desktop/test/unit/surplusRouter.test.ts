// apps/desktop/test/unit/surplusRouter.test.ts
//
// Locks in the smart-routing classifier + per-provider tier maps. The module is
// pure (no IO), so these are deterministic.
import { describe, it, expect } from 'vitest'
import {
  classifySurplus, routeSurplus, routeModel,
  SURPLUS_TIERS, BANKR_TIERS, VENICE_TIERS, DEFAULT_SURPLUS_MODEL,
  STABILITY_SPIKY_THRESHOLD,
} from '../../electron/services/surplus-router'

const MODEL_SETS = ['SIMPLE', 'MID', 'TOP', 'REASONING', 'AGENTIC', 'AGENTIC_LIGHT', 'AGENTIC_TOP', 'VISION'] as const

describe('classifySurplus', () => {
  it('routes a trivial greeting to SIMPLE/general', () => {
    const c = classifySurplus({ message: 'hi' })
    expect(c.tier).toBe('SIMPLE')
    expect(c.category).toBe('general')
  })

  it('routes a math proof to TOP/reasoning', () => {
    const c = classifySurplus({ message: 'Prove that the square root of 2 is irrational.' })
    expect(c.tier).toBe('TOP')
    expect(c.category).toBe('reasoning')
  })

  it('classifies a coding request as the code category', () => {
    const c = classifySurplus({ message: 'Write a function in Python to reverse a linked list.' })
    expect(c.category).toBe('code')
  })

  it('honours an explicit "use opus / best model" force-to-top', () => {
    expect(classifySurplus({ message: 'use opus, give me the best model' }).tier).toBe('TOP')
  })

  it('forces a high-stakes medical question to TOP', () => {
    expect(classifySurplus({ message: 'What is the correct dosage of ibuprofen for a child?' }).tier).toBe('TOP')
  })

  it('detects a non-English reasoning prompt (Russian) above SIMPLE', () => {
    // "Explain in detail why..." in Russian — must not be mis-scored as trivial.
    const c = classifySurplus({ message: 'Подробно объясни, почему небо голубое, шаг за шагом' })
    expect(c.tier).not.toBe('SIMPLE')
  })
})

describe('routeSurplus (default Surplus catalog)', () => {
  const catalog = ['claude-haiku-4', 'claude-sonnet-4.5', 'claude-opus-4.8']

  it('maps SIMPLE to the cheapest matching model', () => {
    expect(routeSurplus({ message: 'hi' }, catalog).primary).toBe('claude-haiku-4')
  })

  it('maps a force-top request to the opus tier', () => {
    expect(routeSurplus({ message: 'use opus, best model please' }, catalog).primary).toBe('claude-opus-4.8')
  })

  it('picks the NEWEST version among pattern matches', () => {
    const d = routeSurplus({ message: 'use opus, best model' }, ['claude-opus-4.1', 'claude-opus-4.8'])
    expect(d.primary).toBe('claude-opus-4.8')
  })

  it('routes an image request to the VISION set / vision category', () => {
    const d = routeSurplus({ message: 'describe this picture', hasImage: true }, catalog)
    expect(d.modelSet).toBe('VISION')
    expect(d.category).toBe('vision')
  })

  it('falls back to the default model on an empty catalog', () => {
    expect(routeSurplus({ message: 'hi' }, []).primary).toBe(DEFAULT_SURPLUS_MODEL)
  })
})

describe('routeSurplus runtime re-ordering (injected, pure)', () => {
  const topCatalog = ['claude-opus-4.8', 'gpt-5.5', 'grok-4.3']

  it('pushes cooled-down ids to the END without dropping them', () => {
    const d = routeSurplus({ message: 'use opus, best model' }, topCatalog, {
      cooledDown: new Set(['claude-opus-4.8']),
    })
    expect(d.primary).toBe('gpt-5.5')
    expect(d.chain[d.chain.length - 1]).toBe('claude-opus-4.8')
  })

  it('sinks low-reliability ids', () => {
    const d = routeSurplus({ message: 'use opus, best model' }, ['claude-opus-4.8', 'gpt-5.5'], {
      reliability: (id) => (id === 'claude-opus-4.8' ? 0.2 : 1.0),
    })
    expect(d.primary).toBe('gpt-5.5')
  })
})

describe('per-provider tier maps', () => {
  it('all three maps cover every model-set with a non-empty pattern list', () => {
    for (const map of [SURPLUS_TIERS, BANKR_TIERS, VENICE_TIERS]) {
      for (const set of MODEL_SETS) {
        expect(Array.isArray(map[set])).toBe(true)
        expect(map[set].length).toBeGreaterThan(0)
      }
    }
  })

  it('VENICE_TIERS override resolves SIMPLE against an OSS-only catalog', () => {
    // No claude/gpt here — the default Surplus map would never hit SIMPLE.
    //
    // The ids are REAL ones from Venice's live catalog (read 2026-08-03). The
    // previous fixture used `qwen3-4b`, `deepseek-v4` and
    // `qwen3-235b-a22b-thinking`, none of which Venice serves under those exact
    // names any more — so this test was green against a catalog that does not
    // exist, which is precisely how the tier maps themselves rotted.
    const veniceCatalog = ['llama-3.2-3b', 'llama-3.3-70b', 'deepseek-v4-pro', 'qwen3-235b-a22b-thinking-2507']
    const d = routeSurplus({ message: 'hi' }, veniceCatalog, { tierMap: VENICE_TIERS })
    expect(d.tier).toBe('SIMPLE')
    expect(d.primary).toBe('llama-3.2-3b')
  })

  it('BANKR_TIERS override maps SIMPLE to a Bankr cheap model', () => {
    const bankrCatalog = ['claude-haiku-4', 'gemini-3-flash', 'claude-sonnet-4.5', 'claude-opus-4.8']
    const d = routeSurplus({ message: 'hi' }, bankrCatalog, { tierMap: BANKR_TIERS })
    expect(d.tier).toBe('SIMPLE')
    expect(['claude-haiku-4', 'gemini-3-flash']).toContain(d.primary)
  })

  it('BANKR_TIERS prefers Claude 5 over 4.x without a map edit (family patterns + newest-version pick)', () => {
    // The tier map keys on the FAMILY ('claude-opus'), so a new Bankr version
    // needs no change here — versionScore just has to rank 5 above 4.8.
    const bankrCatalog = ['claude-haiku-4.5', 'claude-sonnet-5', 'claude-sonnet-4.6', 'claude-opus-5', 'claude-opus-4.8']
    const d = routeSurplus({ message: 'use opus, best model' }, bankrCatalog, { tierMap: BANKR_TIERS })
    expect(d.primary).toBe('claude-opus-5')
    // One pick per pattern → the superseded 4.8 never enters the chain.
    expect(d.chain).not.toContain('claude-opus-4.8')
    expect(d.chain).not.toContain('claude-sonnet-4.6')
  })
})

describe('routeModel alias', () => {
  it('is the same function as routeSurplus', () => {
    expect(routeModel).toBe(routeSurplus)
  })
})

describe('momentum vs strong fresh signals (live-QA regression)', () => {
  it('a short code request after a SIMPLE turn is NOT dragged down by momentum', () => {
    // Live bug: "write me snake game in html" (27 chars) after "2+2?" scored
    // code+0.18 (MID) but momentum w=0.6 sank it to SIMPLE -> haiku.
    const c = classifySurplus({ message: 'write me snake game in html', recentTiers: ['SIMPLE'] })
    expect(c.category).toBe('code')
    expect(c.tier).not.toBe('SIMPLE')
    expect(c.reasoning).toContain('momentum skipped')
  })

  it('routes that request to the AGENTIC set on Bankr (sonnet-class, not haiku)', () => {
    const bankrCatalog = ['claude-haiku-4.5', 'claude-sonnet-4.6', 'claude-opus-4.7', 'gemini-3-flash', 'gemini-3-pro', 'gpt-5.2', 'llama-3.3-70b']
    const d = routeSurplus(
      { message: 'write me snake game in html', recentTiers: ['SIMPLE'] },
      bankrCatalog,
      { tierMap: BANKR_TIERS },
    )
    expect(d.modelSet).toBe('AGENTIC')
    expect(d.primary).toBe('claude-sonnet-4.6')
  })

  it('momentum still lifts a genuinely ambiguous short follow-up', () => {
    // "ok continue" fires NO categorical signal -> momentum applies.
    const cold = classifySurplus({ message: 'ok continue' })
    const hot  = classifySurplus({ message: 'ok continue', recentTiers: ['TOP', 'TOP', 'TOP'] })
    expect(hot.score).toBeGreaterThan(cold.score)
    expect(hot.reasoning).toContain('momentum')
  })
})

describe('boundary overrides (opts.boundaries)', () => {
  it('default boundaries: a greeting is SIMPLE', () => {
    expect(classifySurplus({ message: 'hello' }).tier).toBe('SIMPLE')
  })

  it('lowering simpleMax far below pushes the same greeting to MID', () => {
    // With simpleMax at -10 nothing can score below it; the greeting's score
    // sits far from both boundaries so confidence is high (no MID floor kick-in
    // needed — it IS MID by the boundaries).
    const c = classifySurplus({ message: 'hello' }, { simpleMax: -10, midMax: 5 })
    expect(c.tier).toBe('MID')
  })

  it('lowering midMax too pushes the greeting all the way to TOP', () => {
    const c = classifySurplus({ message: 'hello' }, { simpleMax: -10, midMax: -5 })
    expect(c.tier).toBe('TOP')
  })

  it('boundaries flow through routeSurplus', () => {
    const catalog = ['claude-haiku-4', 'claude-sonnet-4.5', 'claude-opus-4.8']
    const def = routeSurplus({ message: 'hello' }, catalog)
    const top = routeSurplus({ message: 'hello' }, catalog, { boundaries: { simpleMax: -10, midMax: -5 } })
    expect(def.tier).toBe('SIMPLE')
    expect(top.tier).toBe('TOP')
    expect(top.primary).toBe('claude-opus-4.8')
  })
})

describe('bandit re-rank (opts.banditArm, C1)', () => {
  // tierMap where every set resolves to the same 2-model chain, so the
  // pattern order (model-x first) is the cold-start baseline.
  const TIERS = Object.fromEntries(
    MODEL_SETS.map(s => [s, ['model-x', 'model-y']]),
  ) as Record<(typeof MODEL_SETS)[number], string[]>
  const catalog = ['model-x', 'model-y']

  it('cold start (no arms) preserves the pattern order exactly', () => {
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      banditArm: () => undefined,
    })
    expect(d.chain).toEqual(['model-x', 'model-y'])
    expect(d.primary).toBe('model-x')
    expect(d.reasoning).not.toContain('bandit')
  })

  it('strong evidence promotes a lower-position model', () => {
    // model-x keeps failing in this bucket; model-y keeps succeeding.
    const arms: Record<string, { a: number; b: number }> = {
      'model-x': { a: 1, b: 10 },   // 0 successes, 9 failures
      'model-y': { a: 12, b: 1 },   // 11 successes, 0 failures
    }
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      banditArm: (_bucket, id) => arms[id],
    })
    expect(d.primary).toBe('model-y')
    expect(d.reasoning).toContain('bandit→model-y')
  })

  it('weak evidence does NOT override the position prior', () => {
    // One success for model-y is not enough to beat model-x's position prior.
    const arms: Record<string, { a: number; b: number }> = {
      'model-y': { a: 2, b: 1 },    // 1 success
    }
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      banditArm: (_bucket, id) => arms[id],
    })
    expect(d.primary).toBe('model-x')
  })

  it('passes the decision bucket to the arm lookup', () => {
    const seen: string[] = []
    routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      banditArm: (bucket) => { seen.push(bucket); return undefined },
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(b => b === 'general:SIMPLE')).toBe(true)
  })

  it('cooldown still beats bandit (acute > preference)', () => {
    const arms: Record<string, { a: number; b: number }> = {
      'model-y': { a: 30, b: 1 },
    }
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      banditArm: (_b, id) => arms[id],
      cooledDown: new Set(['model-y']),
    })
    // bandit promotes y, but the cooldown pushes it back to the end.
    expect(d.primary).toBe('model-x')
    expect(d.chain[d.chain.length - 1]).toBe('model-y')
  })
})

describe('stability re-rank (opts.stability, router-intel)', () => {
  const TIERS = Object.fromEntries(
    MODEL_SETS.map(s => [s, ['model-x', 'model-y']]),
  ) as Record<(typeof MODEL_SETS)[number], string[]>
  const catalog = ['model-x', 'model-y']

  it('no stability fn → chain order untouched (back-compat)', () => {
    const d = routeSurplus({ message: 'hi' }, catalog, { tierMap: TIERS })
    expect(d.chain).toEqual(['model-x', 'model-y'])
  })

  it('cold start (-1) and high scores are a no-op', () => {
    const cold = routeSurplus({ message: 'hi' }, catalog, { tierMap: TIERS, stability: () => -1 })
    expect(cold.chain).toEqual(['model-x', 'model-y'])
    const good = routeSurplus({ message: 'hi' }, catalog, { tierMap: TIERS, stability: () => 90 })
    expect(good.chain).toEqual(['model-x', 'model-y'])
  })

  it('sinks a spiky leader behind its healthy peer (within-tier demotion)', () => {
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      stability: (id) => (id === 'model-x' ? STABILITY_SPIKY_THRESHOLD - 1 : 90),
    })
    expect(d.primary).toBe('model-y')
    expect(d.chain).toEqual(['model-y', 'model-x'])
    expect(d.reasoning).toContain('spiky→back')
  })

  it('does NOT reorder when every id is spiky (no healthy peer to promote)', () => {
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      stability: () => 10,
    })
    expect(d.chain).toEqual(['model-x', 'model-y'])
    expect(d.reasoning).not.toContain('spiky→back')
  })

  it('cooldown still beats stability (acute > consistency)', () => {
    // model-x is spiky (would sink) but model-y is cooled down — cooldown wins,
    // so model-y still lands LAST and model-x leads.
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      stability: (id) => (id === 'model-x' ? 10 : 90),
      cooledDown: new Set(['model-y']),
    })
    expect(d.primary).toBe('model-x')
    expect(d.chain[d.chain.length - 1]).toBe('model-y')
  })

  it('reliability promotion is respected before stability demotion', () => {
    // reliability sinks model-x; stability would too, but the net result keeps
    // the healthy model-y in front either way (stages compose, cooldown last).
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      reliability: (id) => (id === 'model-x' ? 0.2 : 1.0),
      stability: (id) => (id === 'model-x' ? 10 : 90),
    })
    expect(d.primary).toBe('model-y')
  })
})

describe('elo re-rank (opts.eloRank, cold-start-safe late prior)', () => {
  const TIERS = Object.fromEntries(
    MODEL_SETS.map(s => [s, ['model-x', 'model-y']]),
  ) as Record<(typeof MODEL_SETS)[number], string[]>
  const catalog = ['model-x', 'model-y']

  it('no eloRank fn → chain order untouched (back-compat)', () => {
    const d = routeSurplus({ message: 'hi' }, catalog, { tierMap: TIERS })
    expect(d.chain).toEqual(['model-x', 'model-y'])
  })

  it('equal Elo is a no-op (stable, preserves the prior-stage order)', () => {
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      eloRank: (_bucket, ids) => [...ids], // store returns input order when ratings tie
    })
    expect(d.chain).toEqual(['model-x', 'model-y'])
    expect(d.reasoning).not.toContain('elo')
  })

  it('breaks a tie by Elo (promotes the higher-rated id)', () => {
    // model-y outranks model-x in this bucket — Elo lifts it to the front.
    const order: Record<string, number> = { 'model-y': 0, 'model-x': 1 }
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      eloRank: (_bucket, ids) => [...ids].sort((a, b) => order[a]! - order[b]!),
    })
    expect(d.primary).toBe('model-y')
    expect(d.chain).toEqual(['model-y', 'model-x'])
    expect(d.reasoning).toContain('elo→model-y')
  })

  it('passes the decision bucket to the elo lookup', () => {
    const seen: string[] = []
    routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      eloRank: (bucket, ids) => { seen.push(bucket); return [...ids] },
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(b => b === 'general:SIMPLE')).toBe(true)
  })

  it('cooldown still beats Elo (acute failure > global prior)', () => {
    // Elo would promote model-y, but it is cooled down → must land LAST.
    const order: Record<string, number> = { 'model-y': 0, 'model-x': 1 }
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      eloRank: (_bucket, ids) => [...ids].sort((a, b) => order[a]! - order[b]!),
      cooledDown: new Set(['model-y']),
    })
    expect(d.primary).toBe('model-x')
    expect(d.chain[d.chain.length - 1]).toBe('model-y')
  })

  it('reliability outranks Elo (stronger signal earlier, Elo only breaks its leftovers)', () => {
    // reliability sinks model-y to the back; Elo would prefer model-y, but it
    // must NOT override a stronger signal — model-x (healthy) stays in front.
    const order: Record<string, number> = { 'model-y': 0, 'model-x': 1 }
    const d = routeSurplus({ message: 'hi' }, catalog, {
      tierMap: TIERS,
      reliability: (id) => (id === 'model-y' ? 0.2 : 1.0),
      eloRank: (_bucket, ids) => [...ids].sort((a, b) => order[a]! - order[b]!),
    })
    expect(d.primary).toBe('model-x')
  })
})
