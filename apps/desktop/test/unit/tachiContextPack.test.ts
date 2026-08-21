// apps/desktop/test/unit/tachiContextPack.test.ts
//
// BATCH33 STAGE 2 — the context packer inside the TACHI harness.
//
// Half 1 unit-tests the pure packer (packAgentHistory: budget cap, recency
// preservation, the return-by-reference no-op).
//
// Half 2 drives the REAL runTachiLoop with a mock model and captures the prompt
// the model is actually asked with — the only way to prove the two claims that
// matter: with the setting OFF the assembled first call is byte-identical to
// what it was before this feature existed, and with it ON the recap + the
// recalled excerpts are really there and really bounded.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { estimateTokens, type AgentHistoryTurn } from '@tachi/core'
import { packAgentHistory, packAgentHistoryWithStats, RECAP_HEADER, DEFAULT_KEEP_RECENT } from '../../electron/services/tachi/context-pack'
import { runTachiLoop } from '../../electron/services/tachi/loop'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-ctxpack-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }

/** A history long enough to blow any sane budget, with one planted needle. */
function longHistory(turns: number, needleAt: number): AgentHistoryTurn[] {
  return Array.from({ length: turns }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: i === needleAt
      ? 'the deployment certificate thumbprint is ABC123 and it lives in the vault'
      : `unrelated filler turn number ${i} about kittens and weather ${'padding '.repeat(30)}`,
  }))
}

// ── Half 1: the pure packer ──────────────────────────────────────────────────

describe('packAgentHistory (pure)', () => {
  it('is the identity — same array reference — when there is nothing to gain', () => {
    const empty: AgentHistoryTurn[] = []
    expect(packAgentHistory(undefined, 'q', { budgetTokens: 500 })).toBeUndefined()
    expect(packAgentHistory(empty, 'q', { budgetTokens: 500 })).toBe(empty)

    // Shorter than keepRecent → nothing older to digest.
    const short = longHistory(DEFAULT_KEEP_RECENT, 0)
    expect(packAgentHistory(short, 'q', { budgetTokens: 500 })).toBe(short)

    // Older prefix already under budget → packing could only lose information.
    const cheap: AgentHistoryTurn[] = [
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' }, { role: 'assistant', content: 'd' },
    ]
    expect(packAgentHistory(cheap, 'q', { budgetTokens: 5000 })).toBe(cheap)
  })

  it('is the identity when the budget is zero or negative (the OFF switch)', () => {
    const h = longHistory(40, 3)
    expect(packAgentHistory(h, 'q', { budgetTokens: 0 })).toBe(h)
    expect(packAgentHistory(h, 'q', { budgetTokens: -1 })).toBe(h)
    expect(packAgentHistory(h, 'q', { budgetTokens: Number.NaN })).toBe(h)
  })

  it('replaces the older prefix with ONE recap turn and keeps the tail verbatim', () => {
    const h = longHistory(40, 5)
    const out = packAgentHistory(h, 'certificate thumbprint', { budgetTokens: 200 })!
    expect(out).not.toBe(h)
    expect(out).toHaveLength(1 + DEFAULT_KEEP_RECENT)
    expect(out[0].role).toBe('user')
    expect(out[0].content).toContain(RECAP_HEADER)
    // The recent tail is the SAME objects, in the same order, unmodified.
    expect(out.slice(1)).toEqual(h.slice(h.length - DEFAULT_KEEP_RECENT))
    expect(out[1]).toBe(h[h.length - DEFAULT_KEEP_RECENT])
  })

  it('keeps the recap inside the TOKEN budget (ascii and CJK alike)', () => {
    for (const budget of [80, 200, 600]) {
      const out = packAgentHistory(longHistory(60, 7), 'certificate thumbprint', { budgetTokens: budget })!
      const recap = out[0].content
      const body = recap.slice(recap.indexOf('\n- ') + 1)
      expect(estimateTokens(body)).toBeLessThanOrEqual(budget)
    }

    // CJK costs ~6x an ascii char in the estimator — the naive chars = tokens*4
    // conversion overshoots badly here, which is exactly what the correction
    // pass exists for.
    const cjk: AgentHistoryTurn[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `部署证书指纹保存在保险库里第${i}条记录`.repeat(4),
    }))
    const out = packAgentHistory(cjk, '部署证书指纹', { budgetTokens: 150 })!
    const recap = out[0].content
    expect(estimateTokens(recap.slice(recap.indexOf('\n- ') + 1))).toBeLessThanOrEqual(150)
  })

  it('ranks the relevant older turn into the recap ahead of the filler', () => {
    const h = longHistory(40, 5)
    const out = packAgentHistory(h, 'deployment certificate thumbprint vault', { budgetTokens: 220 })!
    expect(out[0].content).toContain('thumbprint')
  })

  it('reports what it did', () => {
    const h = longHistory(40, 5)
    const { stats } = packAgentHistoryWithStats(h, 'certificate', { budgetTokens: 200 })
    expect(stats.packed).toBe(true)
    expect(stats.turnsDigested).toBe(40 - DEFAULT_KEEP_RECENT)
    expect(stats.tokensBefore).toBeGreaterThan(200)
    expect(stats.tokensAfter).toBeLessThan(stats.tokensBefore)

    const { stats: none } = packAgentHistoryWithStats(h, 'certificate', { budgetTokens: 0 })
    expect(none.packed).toBe(false)
    expect(none.turnsDigested).toBe(0)
  })
})

// ── Half 2: the packer inside runTachiLoop ───────────────────────────────────

/** A one-step mock that records the prompt it was called with. */
function capturingModel(): { model: MockLanguageModelV3; prompts: unknown[] } {
  const prompts: unknown[] = []
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push((options as { prompt?: unknown }).prompt)
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: 'ok' },
            { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ],
        }),
      }
    },
  })
  return { model, prompts }
}

const TASK = 'what is the deployment certificate thumbprint?'

async function runWith(
  workspace: string,
  extra: Partial<Parameters<typeof runTachiLoop>[0]>,
): Promise<unknown> {
  const { model, prompts } = capturingModel()
  await runTachiLoop({
    model,
    modelId: 'claude-sonnet-4.6',
    workspaceRoot: workspace,
    task: TASK,
    history: longHistory(40, 5),
    signal: new AbortController().signal,
    onEvent: () => {},
    gate: async () => true,
    ...extra,
  })
  return prompts[0]
}

describe('runTachiLoop context assembly', () => {
  it('OFF is a passthrough: the assembled prompt is byte-identical to the un-wired path', async () => {
    // Baseline = no contextPack option at all (what every caller passed before
    // batch33 and what delegated sub-agents still pass).
    const baseline = await runWith(ws, {})

    // Explicitly disabled, WITH a recaller injected and a budget set — neither
    // may have any effect.
    let recallerCalled = false
    const disabled = await runWith(ws, {
      contextPack: { enabled: false, budgetTokens: 4000 },
      recallContext: async () => { recallerCalled = true; return 'SHOULD NEVER APPEAR' },
    })

    expect(recallerCalled).toBe(false)
    expect(JSON.stringify(disabled)).toBe(JSON.stringify(baseline))

    // A zero budget is the same switch (guards a UI that writes 0 instead of false).
    const zeroBudget = await runWith(ws, {
      contextPack: { enabled: true, budgetTokens: 0 },
      recallContext: async () => 'SHOULD NEVER APPEAR',
    })
    expect(JSON.stringify(zeroBudget)).toBe(JSON.stringify(baseline))

    // And the baseline really is the full verbatim replay (so the equality
    // above is not two identically-broken prompts).
    const s = JSON.stringify(baseline)
    expect(s).toContain('unrelated filler turn number 0')
    expect(s).toContain('unrelated filler turn number 30')
    expect(s).not.toContain(RECAP_HEADER)
  })

  it('ON: the older turns arrive as one bounded recap and the tail survives verbatim', async () => {
    const baseline = JSON.stringify(await runWith(ws, {}))
    const packed = await runWith(ws, { contextPack: { enabled: true, budgetTokens: 300 } })
    const s = JSON.stringify(packed)

    expect(s).toContain(RECAP_HEADER)
    // The needle from turn 5 survived the ranking…
    expect(s).toContain('thumbprint')
    // …while the filler beyond the packer's item cap did not. (The packer keeps
    // the best `targetItems` — clipped — so the SURVIVORS are a prefix of the
    // ranking, not "everything relevant"; mid-history filler is what goes.)
    expect(s).not.toContain('turn number 20 about')
    expect(s).not.toContain('turn number 30 about')
    // The last turns are still there, whole.
    expect(s).toContain('unrelated filler turn number 39')
    // The current task is still the last user message.
    expect(s).toContain(TASK)
    // And the whole point: materially less context than the verbatim replay.
    expect(s.length).toBeLessThan(baseline.length * 0.6)

    // Far fewer messages than the 40-turn replay: the SDK's prompt is
    // [system, recap, …tail, task].
    const msgs = packed as Array<unknown>
    expect(Array.isArray(msgs)).toBe(true)
    expect(msgs.length).toBe(1 /* system */ + 1 /* recap */ + DEFAULT_KEEP_RECENT + 1 /* task */)
    expect((await runWith(ws, {}) as Array<unknown>).length).toBe(1 + 40 + 1)
  })

  it('ON: the recalled-chat block is injected ahead of the task, and the raw task is preserved', async () => {
    const seen: string[] = []
    const packed = await runWith(ws, {
      contextPack: { enabled: true, budgetTokens: 300 },
      recallContext: async (q) => { seen.push(q); return '<recalled-conversations>\n- [old chat] thumbprint lives in the vault\n</recalled-conversations>' },
    })
    // The recaller is queried with the RAW task, not the recap-mangled one.
    expect(seen).toEqual([TASK])
    const s = JSON.stringify(packed)
    expect(s).toContain('recalled-conversations')
    expect(s).toContain('thumbprint lives in the vault')
    expect(s).toContain(TASK)
  })

  it('ON: a throwing recaller degrades to the no-recall assembly instead of failing the run', async () => {
    const withoutRecall = await runWith(ws, { contextPack: { enabled: true, budgetTokens: 300 } })
    const withBrokenRecall = await runWith(ws, {
      contextPack: { enabled: true, budgetTokens: 300 },
      recallContext: async () => { throw new Error('index on fire') },
    })
    expect(JSON.stringify(withBrokenRecall)).toBe(JSON.stringify(withoutRecall))

    // A recaller that finds nothing (null) is the same story.
    const withEmptyRecall = await runWith(ws, {
      contextPack: { enabled: true, budgetTokens: 300 },
      recallContext: async () => null,
    })
    expect(JSON.stringify(withEmptyRecall)).toBe(JSON.stringify(withoutRecall))
  })

  it('ON with no history: only the recall block changes, the turn shape does not', async () => {
    const { model, prompts } = capturingModel()
    await runTachiLoop({
      model,
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: TASK,
      signal: new AbortController().signal,
      onEvent: () => {},
      gate: async () => true,
      contextPack: { enabled: true, budgetTokens: 300 },
      recallContext: async () => '<recalled-conversations>\n- [old chat] vault\n</recalled-conversations>',
    })
    const s = JSON.stringify(prompts[0])
    expect(s).toContain('recalled-conversations')
    expect(s).toContain(TASK)
    expect(s).not.toContain(RECAP_HEADER) // nothing to recap
  })
})

describe('the settings surface exists end to end', () => {
  it('both keys are in AppSettings, the defaults, and the save schema', async () => {
    const { DEFAULT_SETTINGS } = await import('@tachi/core')
    expect(DEFAULT_SETTINGS.tachiRecallEnabled).toBe(true)
    expect(DEFAULT_SETTINGS.tachiRecallBudgetTokens).toBe(1200)

    const { appSettingsSaveSchema } = await import('../../electron/services/settings-schema')
    expect(appSettingsSaveSchema.parse({ tachiRecallEnabled: false }))
      .toEqual({ tachiRecallEnabled: false })
    expect(appSettingsSaveSchema.parse({ tachiRecallBudgetTokens: 2400 }))
      .toEqual({ tachiRecallBudgetTokens: 2400 })
    // Out-of-range budgets are rejected rather than silently stored.
    expect(() => appSettingsSaveSchema.parse({ tachiRecallBudgetTokens: -1 })).toThrow()
    expect(() => appSettingsSaveSchema.parse({ tachiRecallBudgetTokens: 1_200_000 })).toThrow()
  })
})
