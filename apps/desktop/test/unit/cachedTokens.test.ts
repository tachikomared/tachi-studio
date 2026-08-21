// apps/desktop/test/unit/cachedTokens.test.ts
//
// Provider prompt-cache surfacing (CACHE-ALIGN-AUDIT-2026-07-21 recommendation #2).
// Covers (a) the pure extraction across every usage shape our stack can hand us,
// (b) the pure aggregation helper + process aggregate, incl. the honesty rule
// (report nothing → "--", never 0-as-fact), and (c) the additive cost-ledger
// entry shape carrying cachedTokens.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractCachedInputTokens,
  cacheHitRatio,
  recordCacheUsage,
  getCacheSavings,
  resetCacheStats,
} from '../../electron/services/cache-stats'
import { CostLedger } from '../../electron/services/cost-ledger'

describe('extractCachedInputTokens', () => {
  it('reads ai@7 LanguageModelUsage → inputTokenDetails.cacheReadTokens', () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 200,
      inputTokenDetails: { noCacheTokens: 700, cacheReadTokens: 300, cacheWriteTokens: 0 },
    }
    expect(extractCachedInputTokens(usage)).toBe(300)
  })

  it('reads provider LanguageModelV2Usage → cachedInputTokens', () => {
    expect(extractCachedInputTokens({ inputTokens: 500, outputTokens: 10, cachedInputTokens: 128 })).toBe(128)
  })

  it('reads raw OpenAI-compatible usage → raw.prompt_tokens_details.cached_tokens', () => {
    const usage = { inputTokens: 900, raw: { prompt_tokens_details: { cached_tokens: 640 } } }
    expect(extractCachedInputTokens(usage)).toBe(640)
  })

  it('reads a raw usage object passed directly → prompt_tokens_details.cached_tokens', () => {
    expect(extractCachedInputTokens({ prompt_tokens_details: { cached_tokens: 42 } })).toBe(42)
  })

  it('returns undefined (NOT 0) when the provider reported no cache field', () => {
    expect(extractCachedInputTokens({ inputTokens: 1000, outputTokens: 200 })).toBeUndefined()
    expect(extractCachedInputTokens({})).toBeUndefined()
    expect(extractCachedInputTokens(null)).toBeUndefined()
    expect(extractCachedInputTokens(undefined)).toBeUndefined()
  })

  it('preserves a provider-reported genuine 0 (real cache miss)', () => {
    expect(extractCachedInputTokens({ inputTokens: 1000, cachedInputTokens: 0 })).toBe(0)
    expect(extractCachedInputTokens({ inputTokenDetails: { cacheReadTokens: 0 } })).toBe(0)
  })

  it('ignores non-finite / negative junk', () => {
    expect(extractCachedInputTokens({ cachedInputTokens: NaN })).toBeUndefined()
    expect(extractCachedInputTokens({ cachedInputTokens: -5 })).toBeUndefined()
    expect(extractCachedInputTokens({ cachedInputTokens: 'lots' as unknown as number })).toBeUndefined()
  })
})

describe('cacheHitRatio', () => {
  it('computes cached / total input', () => {
    expect(cacheHitRatio(300, 1000)).toBeCloseTo(0.3)
  })
  it('returns null when the base is unknown / zero (no divide-by-zero, no fabrication)', () => {
    expect(cacheHitRatio(0, 0)).toBeNull()
    expect(cacheHitRatio(100, 0)).toBeNull()
  })
})

describe('cache-stats process aggregate', () => {
  beforeEach(() => resetCacheStats())

  it('starts unreported → UI shows "--" (reported:false, hitRatio:null)', () => {
    const s = getCacheSavings()
    expect(s.reported).toBe(false)
    expect(s.samples).toBe(0)
    expect(s.cachedInputTokens).toBe(0)
    expect(s.hitRatio).toBeNull()
  })

  it('ignores samples where the provider reported nothing (stays "--")', () => {
    recordCacheUsage(1000, undefined)
    recordCacheUsage(2000, undefined)
    const s = getCacheSavings()
    expect(s.reported).toBe(false)
    expect(s.samples).toBe(0)
  })

  it('aggregates reported cached tokens and computes a hit ratio over reported input', () => {
    recordCacheUsage(1000, 300) // reported
    recordCacheUsage(1000, 500) // reported
    recordCacheUsage(4000, undefined) // ignored — not reported
    const s = getCacheSavings()
    expect(s.reported).toBe(true)
    expect(s.samples).toBe(2)
    expect(s.cachedInputTokens).toBe(800)
    expect(s.totalInputTokens).toBe(2000) // only the reported events' input
    expect(s.hitRatio).toBeCloseTo(0.4)
  })

  it('a reported 0 counts as reported (genuine miss) even though nothing was cached', () => {
    recordCacheUsage(1000, 0)
    const s = getCacheSavings()
    expect(s.reported).toBe(true)
    expect(s.cachedInputTokens).toBe(0)
    expect(s.hitRatio).toBeCloseTo(0)
  })
})

describe('CostLedger cachedTokens entry shape', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cache-ledger-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('records an additive cachedTokens field when provided', () => {
    const ledger = new CostLedger(join(dir, 'l.jsonl'), () => 1)
    const ev = ledger.record('tachi', 'claude-sonnet-4.6', 1000, 200, 'feature', 640)
    expect(ev.cachedTokens).toBe(640)
    expect(ev).toMatchObject({ provider: 'tachi', promptTokens: 1000, completionTokens: 200, taskType: 'feature' })
  })

  it('omits cachedTokens entirely when the provider reported nothing', () => {
    const ledger = new CostLedger(join(dir, 'l.jsonl'), () => 1)
    const ev = ledger.record('tachi', 'claude-sonnet-4.6', 1000, 200)
    expect('cachedTokens' in ev).toBe(false)
  })

  it('keeps a provider-reported 0 as 0 (not omitted)', () => {
    const ledger = new CostLedger(join(dir, 'l.jsonl'), () => 1)
    const ev = ledger.record('tachi', 'claude-sonnet-4.6', 1000, 200, undefined, 0)
    expect(ev.cachedTokens).toBe(0)
  })

  it('sums cachedTokens per provider in the summary', () => {
    const ledger = new CostLedger(join(dir, 'l.jsonl'), () => 10 * 86_400_000)
    ledger.record('tachi', 'claude-sonnet-4.6', 1000, 0, 'feature', 300)
    ledger.record('tachi', 'claude-sonnet-4.6', 1000, 0, 'feature', 500)
    ledger.record('tachi', 'claude-sonnet-4.6', 1000, 0, 'feature') // no cache field
    const s = ledger.summary(30)
    expect(s.byProvider['tachi']!.cachedTokens).toBe(800)
  })
})
