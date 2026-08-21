// packages/core/src/tools/__tests__/deep-research.test.ts
//
// Deep-research loop (STEAL 2026-06-21 #9, odysseus): Think→Search→Extract→
// Decide(LLM stopping-oracle)→Synthesize. The orchestrator is PURE — search /
// fetch / ask are injected — so the loop + stopping logic unit-test with fakes,
// no network or model.

import { describe, it, expect, vi } from 'vitest'
import { parseResearchVerdict, runDeepResearch, type DeepResearchDeps } from '../deep-research.js'

describe('parseResearchVerdict', () => {
  it('reads SUFFICIENT as done', () => {
    expect(parseResearchVerdict('The sources cover it. SUFFICIENT.')).toEqual({ done: true, gap: null })
  })
  it('reads NEED_MORE with the gap', () => {
    expect(parseResearchVerdict('NEED_MORE: 2025 pricing')).toEqual({ done: false, gap: '2025 pricing' })
  })
  it('lets NEED_MORE win over a stray SUFFICIENT (incomplete beats done)', () => {
    expect(parseResearchVerdict('mostly SUFFICIENT but NEED_MORE: benchmarks')).toEqual({ done: false, gap: 'benchmarks' })
  })
  it('defaults to not-done with no gap when ambiguous', () => {
    expect(parseResearchVerdict('hmm, unclear')).toEqual({ done: false, gap: null })
  })
})

const deps = (askReplies: string[]): DeepResearchDeps => {
  const ask = vi.fn(async () => askReplies.shift() ?? 'SUFFICIENT')
  return {
    search: vi.fn(async (q: string) => [{ title: `T:${q}`, url: `https://x/${encodeURIComponent(q)}`, description: 'd' }]),
    fetch: vi.fn(async (url: string) => `body of ${url}`),
    ask,
  }
}

describe('runDeepResearch', () => {
  it('loops until the oracle says SUFFICIENT, then synthesizes', async () => {
    const d = deps(['NEED_MORE: deeper', 'SUFFICIENT', 'FINAL SYNTHESIS'])
    const r = await runDeepResearch('What is X?', d, { maxIterations: 5 })
    expect(r.stoppedBecause).toBe('sufficient')
    expect(r.iterations).toBe(2)            // need_more once, then sufficient
    expect(r.synthesis).toBe('FINAL SYNTHESIS')
    expect(r.findings.length).toBeGreaterThan(0)
    expect((d.search as any).mock.calls[1][0]).toBe('deeper') // 2nd search used the gap
  })

  it('stops at maxIterations when the oracle never says SUFFICIENT', async () => {
    // 3 iterations = 3 verdict asks (a/b/c), then 1 synthesis ask = 'SYNTH'.
    const d = deps(['NEED_MORE: a', 'NEED_MORE: b', 'NEED_MORE: c', 'SYNTH'])
    const r = await runDeepResearch('Q', d, { maxIterations: 3 })
    expect(r.stoppedBecause).toBe('maxIterations')
    expect(r.iterations).toBe(3)
    expect(r.synthesis).toBe('SYNTH') // still synthesizes from what it gathered
  })

  it('collects findings from fetched pages', async () => {
    const d = deps(['SUFFICIENT', 'S'])
    const r = await runDeepResearch('Q', d, { maxIterations: 2 })
    expect(r.findings[0].excerpt).toContain('body of')
  })
})
