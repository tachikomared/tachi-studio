import { describe, it, expect } from 'vitest'
import type { ChatBackend, ChatChunk, ChatRequest, TokenUsage } from '../backend.js'
import {
  collectStream,
  rerunFusionMember,
  runFusion,
  buildAnalysisSystem,
  buildSynthSystem,
  buildJudgeSystem,
  buildSelectSystem,
  parseSelectionIndex,
  pickMajority,
  FUSION_ANALYSIS_SYSTEM,
  FUSION_SYNTH_SYSTEM,
  FUSION_JUDGE_SYSTEM,
  FUSION_SELECT_SYSTEM,
  FUSION_PLAN_ANALYSIS_SYSTEM,
  FUSION_PLAN_SYNTH_SYSTEM,
  FUSION_PLAN_JUDGE_SYSTEM,
  type FusionPanelMember,
} from '../fusion.js'

/** Scripted backend: per-model chunk lists, recording every request it receives. */
class FakeBackend implements ChatBackend {
  id = 'fake'
  displayName = 'Fake'
  calls: ChatRequest[] = []
  constructor(private scripts: Record<string, ChatChunk[]>) {}
  async *sendMessage(request: ChatRequest, _apiKey: string): AsyncIterable<ChatChunk> {
    this.calls.push(request)
    const chunks = this.scripts[request.model] ?? [
      { type: 'delta', messageId: 'm', text: `[${request.model}]` },
      { type: 'done', messageId: 'm' },
    ]
    for (const c of chunks) yield c
  }
}

/** A normal answer stream: one delta + optional usage + done. */
const answer = (text: string, usage?: Partial<TokenUsage>): ChatChunk[] => [
  { type: 'start', messageId: 'inner', model: 'inner' },
  { type: 'delta', messageId: 'inner', text },
  ...(usage
    ? [{ type: 'usage' as const, messageId: 'inner', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, ...usage } }]
    : []),
  { type: 'done', messageId: 'inner' },
]

const drain = async (iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> => {
  const out: ChatChunk[] = []
  for await (const c of iter) out.push(c)
  return out
}

const sysOf = (req: ChatRequest): string => String(req.messages.find(m => m.role === 'system')?.content ?? '')

const conv = [{ role: 'user' as const, content: 'what is 2+2?' }]

describe('collectStream', () => {
  it('concatenates deltas, captures usage, surfaces first error', async () => {
    async function* gen(): AsyncIterable<ChatChunk> {
      yield { type: 'start', messageId: 'x', model: 'm' }
      yield { type: 'delta', messageId: 'x', text: 'foo ' }
      yield { type: 'delta', messageId: 'x', text: 'bar' }
      yield { type: 'usage', messageId: 'x', usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 } }
      yield { type: 'done', messageId: 'x' }
    }
    const r = await collectStream(gen())
    expect(r.text).toBe('foo bar')
    expect(r.usage).toEqual({ promptTokens: 3, completionTokens: 5, totalTokens: 8 })
    expect(r.error).toBeUndefined()
  })

  it('returns the error and whatever text preceded it', async () => {
    async function* gen(): AsyncIterable<ChatChunk> {
      yield { type: 'delta', messageId: 'x', text: 'partial' }
      yield { type: 'error', messageId: 'x', error: { code: 'HTTP_429', message: 'rate limited' } }
    }
    const r = await collectStream(gen())
    expect(r.error?.code).toBe('HTTP_429')
    expect(r.text).toBe('partial')
  })
})

describe('rerunFusionMember', () => {
  it('returns ok + chars and meters usage when the leg answers', async () => {
    const backend = new FakeBackend({ 'glm-5.2': answer('the fused answer', { promptTokens: 7, completionTokens: 11, totalTokens: 18 }) })
    const usages: TokenUsage[] = []
    const res = await rerunFusionMember({
      backend, key: 'k', model: 'glm-5.2', brief: 'do the thing',
      meter: (u) => usages.push(u),
    })
    expect(res).toEqual({ ok: true, chars: 'the fused answer'.length })
    expect(usages).toEqual([{ promptTokens: 7, completionTokens: 11, totalTokens: 18 }])
    // The brief is sent as a single user message to the requested model.
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].model).toBe('glm-5.2')
    expect(backend.calls[0].messages).toEqual([{ role: 'user', content: 'do the thing' }])
  })

  it('returns ok:false when the backend throws (and never meters)', async () => {
    const throwing: ChatBackend = {
      id: 'boom', displayName: 'Boom',
      // eslint-disable-next-line require-yield
      async *sendMessage() { throw new Error('breaker tripped') },
    }
    let metered = false
    const res = await rerunFusionMember({ backend: throwing, key: 'k', model: 'm', brief: 'b', meter: () => { metered = true } })
    expect(res.ok).toBe(false)
    expect(res.chars).toBe(0)
    expect(res.error).toContain('breaker tripped')
    expect(metered).toBe(false)
  })

  it('returns ok:false on an empty / whitespace-only answer', async () => {
    const backend = new FakeBackend({ m: answer('   \n  ') })
    const res = await rerunFusionMember({ backend, key: 'k', model: 'm', brief: 'b' })
    expect(res).toEqual({ ok: false, chars: 0, error: 'Empty response' })
  })

  it('returns ok:false and surfaces a streamed error chunk', async () => {
    const backend = new FakeBackend({ m: [
      { type: 'delta', messageId: 'x', text: 'partial' },
      { type: 'error', messageId: 'x', error: { code: 'HTTP_429', message: 'rate limited' } },
    ] })
    const res = await rerunFusionMember({ backend, key: 'k', model: 'm', brief: 'b' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('rate limited')
  })
})

describe('prompt builders', () => {
  const members: FusionPanelMember[] = [
    { model: 'a', text: 'four', ok: true },
    { model: 'b', text: 'the answer is 4', ok: true },
  ]
  it('buildAnalysisSystem folds system + analysis instructions + candidates', () => {
    const s = buildAnalysisSystem('BE TERSE', members)
    expect(s).toContain('BE TERSE')
    expect(s).toContain(FUSION_ANALYSIS_SYSTEM)
    expect(s).toContain('four')
    expect(s).toContain('the answer is 4')
  })
  it('buildSynthSystem folds system + synth instructions + the analysis', () => {
    const s = buildSynthSystem('BE TERSE', 'ANALYSIS-BODY')
    expect(s).toContain('BE TERSE')
    expect(s).toContain(FUSION_SYNTH_SYSTEM)
    expect(s).toContain('ANALYSIS-BODY')
  })
  it('buildJudgeSystem (single-call fallback) folds system + judge instructions + candidates', () => {
    const s = buildJudgeSystem('BE TERSE', members)
    expect(s).toContain(FUSION_JUDGE_SYSTEM)
    expect(s).toContain('four')
  })
})

describe('runFusion (two-stage: panel → analysis → grounded synthesis)', () => {
  const PANEL = ['m-a', 'm-b', 'm-c']
  const JUDGE = 'judge-x'

  it('fans out to every panel model and runs the judge twice (analysis + synthesis)', async () => {
    const be = new FakeBackend({
      'm-a': answer('A says four'),
      'm-b': answer('B says 4'),
      'm-c': answer('C says the result is four'),
      'judge-x': answer('Final: 4.'),
    })
    await drain(runFusion(be, 'k', { messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE }))
    const models = be.calls.map(c => c.model)
    expect(models).toEqual(expect.arrayContaining(PANEL))
    // analysis call + synthesis call = judge invoked twice
    expect(models.filter(m => m === JUDGE)).toHaveLength(2)
    // both judge calls come after all three panel calls
    expect(models.indexOf(JUDGE)).toBeGreaterThan(2)
  })

  it('analysis sees the candidates; synthesis is grounded in the analysis', async () => {
    const be = new FakeBackend({
      'm-a': answer('ALPHA-ANSWER'),
      'm-b': answer('BETA-ANSWER'),
      'm-c': answer('GAMMA-ANSWER'),
      'judge-x': answer('ANALYSIS-TEXT'),
    })
    await drain(runFusion(be, 'k', { messageId: 'f1', messages: conv, system: 'ROOT-SYS', panel: PANEL, judgeModel: JUDGE }))
    const judgeCalls = be.calls.filter(c => c.model === JUDGE)
    expect(judgeCalls).toHaveLength(2)
    const analysisSys = sysOf(judgeCalls[0])
    const synthSys = sysOf(judgeCalls[1])
    // analysis stage gets the raw candidates
    expect(analysisSys).toContain('ALPHA-ANSWER')
    expect(analysisSys).toContain('BETA-ANSWER')
    expect(analysisSys).toContain('GAMMA-ANSWER')
    expect(analysisSys).toContain('ROOT-SYS')
    // synthesis stage gets the analysis text (judge's first output), grounded
    expect(synthSys).toContain('ANALYSIS-TEXT')
    expect(synthSys).toContain('ROOT-SYS')
    // the conversation turn passes through to both
    expect(judgeCalls[0].messages.some(m => m.role === 'user')).toBe(true)
    expect(judgeCalls[1].messages.some(m => m.role === 'user')).toBe(true)
  })

  it('streams only the synthesized answer, under one start/done with the fusion messageId', async () => {
    const be = new FakeBackend({
      'm-a': answer('A'), 'm-b': answer('B'), 'm-c': answer('C'),
      'judge-x': answer('synthesized answer'),
    })
    const out = await drain(runFusion(be, 'k', { messageId: 'fX', messages: conv, panel: PANEL, judgeModel: JUDGE }))
    expect(out.every(c => c.messageId === 'fX')).toBe(true)
    expect(out.filter(c => c.type === 'start')).toHaveLength(1)
    expect(out.filter(c => c.type === 'done')).toHaveLength(1)
    const text = out.filter((c): c is Extract<ChatChunk, { type: 'delta' }> => c.type === 'delta').map(c => c.text).join('')
    expect(text).toBe('synthesized answer') // synthesis stage only; analysis is drained, not streamed
    const start = out.find((c): c is Extract<ChatChunk, { type: 'start' }> => c.type === 'start')!
    expect(start.model).toContain('fusion')
    expect(start.model).toContain(JUDGE)
  })

  it('fires onAnalysis with the structured analysis text', async () => {
    const be = new FakeBackend({
      'm-a': answer('A'), 'm-b': answer('B'), 'm-c': answer('C'),
      'judge-x': answer('STRUCTURED-XYZ'),
    })
    let analysis: string | null = null
    await drain(runFusion(be, 'k', { messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE, onAnalysis: (a) => { analysis = a } }))
    expect(analysis).toContain('STRUCTURED-XYZ')
  })

  it('drops a failed panel member but still analyses + synthesizes from the rest', async () => {
    const be = new FakeBackend({
      'm-a': answer('GOOD-A'),
      'm-b': [{ type: 'error', messageId: 'i', error: { code: 'HTTP_500', message: 'boom' } }],
      'm-c': answer('GOOD-C'),
      'judge-x': answer('ok'),
    })
    await drain(runFusion(be, 'k', { messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE }))
    const analysisSys = sysOf(be.calls.filter(c => c.model === JUDGE)[0])
    expect(analysisSys).toContain('GOOD-A')
    expect(analysisSys).toContain('GOOD-C')
    expect(analysisSys).not.toContain('boom')
  })

  it('emits an error (and no judge call) when the whole panel fails', async () => {
    const be = new FakeBackend({
      'm-a': [{ type: 'error', messageId: 'i', error: { code: 'X', message: 'a' } }],
      'm-b': [{ type: 'error', messageId: 'i', error: { code: 'X', message: 'b' } }],
      'm-c': [{ type: 'error', messageId: 'i', error: { code: 'X', message: 'c' } }],
      'judge-x': answer('should never run'),
    })
    const out = await drain(runFusion(be, 'k', { messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE }))
    expect(be.calls.map(c => c.model)).not.toContain(JUDGE)
    expect(out.some(c => c.type === 'error')).toBe(true)
    expect(out.filter(c => c.type === 'done')).toHaveLength(1)
  })

  it('sums panel + analysis + synthesis usage into the final usage chunk', async () => {
    const be = new FakeBackend({
      'm-a': answer('A', { promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
      'm-b': answer('B', { promptTokens: 10, completionTokens: 3, totalTokens: 13 }),
      'm-c': answer('C', { promptTokens: 10, completionTokens: 4, totalTokens: 14 }),
      'judge-x': answer('final', { promptTokens: 40, completionTokens: 6, totalTokens: 46 }),
    })
    const out = await drain(runFusion(be, 'k', { messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE }))
    const usage = out.find((c): c is Extract<ChatChunk, { type: 'usage' }> => c.type === 'usage')!.usage
    // panel 3x + judge analysis + judge synthesis (judge usage counted twice)
    expect(usage.promptTokens).toBe(110)     // 30 panel + 40 analysis + 40 synth
    expect(usage.completionTokens).toBe(21)  // 9 panel + 6 analysis + 6 synth
    expect(usage.totalTokens).toBe(131)      // 39 panel + 46 analysis + 46 synth
  })

  it('reports panel members via onPanel before judging', async () => {
    const be = new FakeBackend({
      'm-a': answer('GOOD-A'),
      'm-b': [{ type: 'error', messageId: 'i', error: { code: 'X', message: 'boom' } }],
      'm-c': answer('GOOD-C'),
      'judge-x': answer('ok'),
    })
    const seen: FusionPanelMember[] = []
    await drain(runFusion(be, 'k', {
      messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE,
      onPanel: (m) => seen.push(...m),
    }))
    expect(seen).toHaveLength(3)
    expect(seen.filter(m => m.ok).map(m => m.model)).toEqual(['m-a', 'm-c'])
    expect(seen.find(m => m.model === 'm-b')!.ok).toBe(false)
  })

  it('analysisStage:false uses a single judge call that sees the candidates directly', async () => {
    const be = new FakeBackend({
      'm-a': answer('CAND-A'), 'm-b': answer('CAND-B'), 'm-c': answer('CAND-C'),
      'judge-x': answer('one-shot answer'),
    })
    const out = await drain(runFusion(be, 'k', { messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE, analysisStage: false }))
    const judgeCalls = be.calls.filter(c => c.model === JUDGE)
    expect(judgeCalls).toHaveLength(1) // no separate analysis stage
    expect(sysOf(judgeCalls[0])).toContain('CAND-A') // single judge sees candidates directly
    const text = out.filter((c): c is Extract<ChatChunk, { type: 'delta' }> => c.type === 'delta').map(c => c.text).join('')
    expect(text).toBe('one-shot answer')
  })
})

describe('runFusion member filtering (skipMember / onMemberResult)', () => {
  const PANEL = ['m-a', 'm-b', 'm-c']
  const JUDGE = 'judge-x'

  it('without skipMember, runs the full panel (existing behavior preserved)', async () => {
    const be = new FakeBackend({
      'm-a': answer('A'), 'm-b': answer('B'), 'm-c': answer('C'),
      'judge-x': answer('final'),
    })
    await drain(runFusion(be, 'k', { messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE }))
    const panelModels = be.calls.map(c => c.model).filter(m => m !== JUDGE)
    expect(panelModels).toEqual(expect.arrayContaining(PANEL))
    expect(panelModels).toHaveLength(3)
  })

  it('skipMember drops the matching member BEFORE fanning out (not fetched, not in analysis)', async () => {
    const be = new FakeBackend({
      'm-a': answer('GOOD-A'), 'm-b': answer('SKIP-B'), 'm-c': answer('GOOD-C'),
      'judge-x': answer('final'),
    })
    await drain(runFusion(be, 'k', {
      messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE,
      skipMember: (id) => id === 'm-b',
    }))
    const panelModels = be.calls.map(c => c.model).filter(m => m !== JUDGE)
    expect(panelModels).toEqual(['m-a', 'm-c'])
    expect(panelModels).not.toContain('m-b')
    // skipped member's text never reaches the judge analysis
    const analysisSys = sysOf(be.calls.filter(c => c.model === JUDGE)[0])
    expect(analysisSys).toContain('GOOD-A')
    expect(analysisSys).toContain('GOOD-C')
    expect(analysisSys).not.toContain('SKIP-B')
    // start chunk reflects the reduced panel size
    const out = be.calls // sanity: only 2 panel fetches happened
    expect(out.filter(c => c.model !== JUDGE)).toHaveLength(2)
  })

  it('falls back to the FULL panel when every member would be skipped (never dead-ends)', async () => {
    const be = new FakeBackend({
      'm-a': answer('A'), 'm-b': answer('B'), 'm-c': answer('C'),
      'judge-x': answer('final'),
    })
    const out = await drain(runFusion(be, 'k', {
      messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE,
      skipMember: () => true, // would skip everything
    }))
    const panelModels = be.calls.map(c => c.model).filter(m => m !== JUDGE)
    expect(panelModels).toEqual(expect.arrayContaining(PANEL))
    expect(panelModels).toHaveLength(3)
    // and it still produces a real answer (no error chunk)
    expect(out.some(c => c.type === 'error')).toBe(false)
    expect(be.calls.some(c => c.model === JUDGE)).toBe(true)
  })

  it('onMemberResult fires once per fanned-out member with its ok/error outcome', async () => {
    const be = new FakeBackend({
      'm-a': answer('GOOD-A'),
      'm-b': [{ type: 'error', messageId: 'i', error: { code: 'X', message: 'boom' } }],
      'm-c': answer('GOOD-C'),
      'judge-x': answer('final'),
    })
    const seen: Array<{ id: string; ok: boolean }> = []
    await drain(runFusion(be, 'k', {
      messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE,
      onMemberResult: (id, ok) => seen.push({ id, ok }),
    }))
    expect(seen).toEqual([
      { id: 'm-a', ok: true },
      { id: 'm-b', ok: false },
      { id: 'm-c', ok: true },
    ])
  })

  it('onMemberResult is NOT called for skipped members (only for fanned-out ones)', async () => {
    const be = new FakeBackend({
      'm-a': answer('A'), 'm-b': answer('B'), 'm-c': answer('C'),
      'judge-x': answer('final'),
    })
    const seen: string[] = []
    await drain(runFusion(be, 'k', {
      messageId: 'f1', messages: conv, panel: PANEL, judgeModel: JUDGE,
      skipMember: (id) => id === 'm-b',
      onMemberResult: (id) => seen.push(id),
    }))
    expect(seen).toEqual(['m-a', 'm-c'])
  })
})

describe('arbiter helpers', () => {
  it('parseSelectionIndex parses a 1-based number to a clamped 0-based index', () => {
    expect(parseSelectionIndex('2', 3)).toBe(1)
    expect(parseSelectionIndex('the strongest is 3', 3)).toBe(2)
    expect(parseSelectionIndex('1', 3)).toBe(0)
    expect(parseSelectionIndex('garbage', 3)).toBe(0)   // unparseable → first
    expect(parseSelectionIndex('9', 3)).toBe(0)         // out of range → first
    expect(parseSelectionIndex('0', 3)).toBe(0)         // below range → first
  })
  it('pickMajority returns the most-agreed leg (normalized), ties → earliest', () => {
    const ms = (texts: string[]): FusionPanelMember[] => texts.map((t, i) => ({ model: `m${i}`, text: t, ok: true }))
    // m0 "BLUE" and m1 "blue." normalize equal → majority of 2; m2 differs
    expect(pickMajority(ms(['BLUE', 'blue.', 'red'])).model).toBe('m0')
    // all unique → earliest (strongest model first)
    expect(pickMajority(ms(['a', 'b', 'c'])).model).toBe('m0')
    // later cluster wins on size
    expect(pickMajority(ms(['x', 'yes', 'YES!'])).model).toBe('m1')
  })
  it('buildSelectSystem folds the select instruction + candidates', () => {
    const s = buildSelectSystem('ROOT', [{ model: 'a', text: 'AA', ok: true }, { model: 'b', text: 'BB', ok: true }])
    expect(s).toContain('ROOT')
    expect(s).toContain(FUSION_SELECT_SYSTEM)
    expect(s).toContain('AA')
    expect(s).toContain('BB')
  })
})

describe('runFusion arbiters (best_of_n / majority)', () => {
  const PANEL = ['m-a', 'm-b', 'm-c']
  const JUDGE = 'judge-x'

  it('best_of_n: one judge call picks the strongest leg, served VERBATIM', async () => {
    const be = new FakeBackend({
      'm-a': answer('ANSWER-A'), 'm-b': answer('ANSWER-B'), 'm-c': answer('ANSWER-C'),
      'judge-x': answer('2'), // judge picks candidate #2 → m-b
    })
    let winner: FusionPanelMember | null = null
    const out = await drain(runFusion(be, 'k', {
      messageId: 'fb', messages: conv, panel: PANEL, judgeModel: JUDGE,
      arbiter: 'best_of_n', onWinner: (w) => { winner = w },
    }))
    // exactly one judge call (the select), no synthesis call
    expect(be.calls.filter(c => c.model === JUDGE)).toHaveLength(1)
    const text = out.filter((c): c is Extract<ChatChunk, { type: 'delta' }> => c.type === 'delta').map(c => c.text).join('')
    expect(text).toBe('ANSWER-B') // leg 2, verbatim — not a re-write
    expect(winner!.model).toBe('m-b')
    const start = out.find((c): c is Extract<ChatChunk, { type: 'start' }> => c.type === 'start')!
    expect(start.model).toContain('best_of_n')
  })

  it('majority: serves the agreed leg verbatim with NO judge call', async () => {
    const be = new FakeBackend({
      'm-a': answer('FOUR'), 'm-b': answer('four.'), 'm-c': answer('five'),
      'judge-x': answer('should never run'),
    })
    let winner: FusionPanelMember | null = null
    const out = await drain(runFusion(be, 'k', {
      messageId: 'fm', messages: conv, panel: PANEL, judgeModel: JUDGE,
      arbiter: 'majority', onWinner: (w) => { winner = w },
    }))
    expect(be.calls.map(c => c.model)).not.toContain(JUDGE) // no extra LLM
    const text = out.filter((c): c is Extract<ChatChunk, { type: 'delta' }> => c.type === 'delta').map(c => c.text).join('')
    expect(text).toBe('FOUR') // m-a/m-b agree (normalized) → m-a served verbatim
    expect(winner!.model).toBe('m-a')
    const start = out.find((c): c is Extract<ChatChunk, { type: 'start' }> => c.type === 'start')!
    expect(start.model).toContain('majority')
  })
})

describe('runFusion plan mode (mode: "plan")', () => {
  const PANEL = ['m-a', 'm-b', 'm-c']
  const JUDGE = 'judge-x'

  it('two-stage plan: analysis compares the plans, synthesis emits ONE plan — using the PLAN prompts, not the prose prompts', async () => {
    const be = new FakeBackend({
      'm-a': answer('PLAN-A: 1. do X'),
      'm-b': answer('PLAN-B: 1. do Y'),
      'm-c': answer('PLAN-C: 1. do Z'),
      'judge-x': answer('MERGED-PLAN'),
    })
    await drain(runFusion(be, 'k', { messageId: 'p1', messages: conv, system: 'ROOT-SYS', panel: PANEL, judgeModel: JUDGE, mode: 'plan' }))
    const judgeCalls = be.calls.filter(c => c.model === JUDGE)
    expect(judgeCalls).toHaveLength(2)
    const analysisSys = sysOf(judgeCalls[0])
    const synthSys = sysOf(judgeCalls[1])
    // PLAN-flavoured prompts, NOT the prose-answer ones
    expect(analysisSys).toContain(FUSION_PLAN_ANALYSIS_SYSTEM)
    expect(analysisSys).not.toContain(FUSION_ANALYSIS_SYSTEM)
    expect(synthSys).toContain(FUSION_PLAN_SYNTH_SYSTEM)
    expect(synthSys).not.toContain(FUSION_SYNTH_SYSTEM)
    // analysis still sees the candidate plans + root system
    expect(analysisSys).toContain('PLAN-A: 1. do X')
    expect(analysisSys).toContain('ROOT-SYS')
  })

  it('the plan synthesizer is instructed to emit ONLY the plan and never name the candidates (no-meta contract)', () => {
    expect(FUSION_PLAN_SYNTH_SYSTEM).toContain('Output ONLY the final plan')
    expect(FUSION_PLAN_SYNTH_SYSTEM).toContain('Do NOT mention the candidate plans')
    // the single-call fallback (analysisStage:false) must enforce the same no-meta contract
    expect(FUSION_PLAN_JUDGE_SYSTEM).toContain('Do NOT mention the candidate plans')
  })

  it('plan mode with analysisStage:false uses the single-call PLAN judge prompt (one judge call)', async () => {
    const be = new FakeBackend({
      'm-a': answer('PA'), 'm-b': answer('PB'), 'm-c': answer('PC'),
      'judge-x': answer('one-shot plan'),
    })
    await drain(runFusion(be, 'k', { messageId: 'p2', messages: conv, panel: PANEL, judgeModel: JUDGE, mode: 'plan', analysisStage: false }))
    const judgeCalls = be.calls.filter(c => c.model === JUDGE)
    expect(judgeCalls).toHaveLength(1)
    expect(sysOf(judgeCalls[0])).toContain(FUSION_PLAN_JUDGE_SYSTEM)
    expect(sysOf(judgeCalls[0])).toContain('PA')
  })

  it('drops empty / failed plan legs before synthesis — only usable plans reach the judge', async () => {
    const be = new FakeBackend({
      'm-a': answer('GOOD-PLAN-A'),
      'm-b': [{ type: 'error', messageId: 'i', error: { code: 'HTTP_500', message: 'boom' } }],
      'm-c': answer(''), // empty leg
      'judge-x': answer('merged'),
    })
    await drain(runFusion(be, 'k', { messageId: 'p3', messages: conv, panel: PANEL, judgeModel: JUDGE, mode: 'plan' }))
    const analysisSys = sysOf(be.calls.filter(c => c.model === JUDGE)[0])
    expect(analysisSys).toContain('GOOD-PLAN-A')
    expect(analysisSys).not.toContain('boom')
    // only one candidate survived → exactly one "Candidate" block
    expect(analysisSys).toContain('Candidate 1')
    expect(analysisSys).not.toContain('Candidate 2')
  })

  it('default mode is unchanged — prose synth prompt, not the plan one (regression guard)', async () => {
    const be = new FakeBackend({
      'm-a': answer('A'), 'm-b': answer('B'), 'm-c': answer('C'),
      'judge-x': answer('answer'),
    })
    await drain(runFusion(be, 'k', { messageId: 'd1', messages: conv, panel: PANEL, judgeModel: JUDGE }))
    const synthSys = sysOf(be.calls.filter(c => c.model === JUDGE)[1])
    expect(synthSys).toContain(FUSION_SYNTH_SYSTEM)
    expect(synthSys).not.toContain(FUSION_PLAN_SYNTH_SYSTEM)
  })
})

describe('plan-mode prompt builders', () => {
  const members: FusionPanelMember[] = [
    { model: 'a', text: 'PLAN-A', ok: true },
    { model: 'b', text: 'PLAN-B', ok: true },
  ]
  it('buildAnalysisSystem("plan") uses the plan analysis instruction + the candidate plans', () => {
    const s = buildAnalysisSystem('SYS', members, 'plan')
    expect(s).toContain(FUSION_PLAN_ANALYSIS_SYSTEM)
    expect(s).not.toContain(FUSION_ANALYSIS_SYSTEM)
    expect(s).toContain('PLAN-A')
  })
  it('buildSynthSystem("plan") uses the plan synth instruction', () => {
    const s = buildSynthSystem('SYS', 'AN', 'plan')
    expect(s).toContain(FUSION_PLAN_SYNTH_SYSTEM)
    expect(s).not.toContain(FUSION_SYNTH_SYSTEM)
  })
  it('buildJudgeSystem("plan") uses the plan single-call instruction', () => {
    const s = buildJudgeSystem('SYS', members, 'plan')
    expect(s).toContain(FUSION_PLAN_JUDGE_SYSTEM)
  })
  it('builders default to synthesis mode when no mode is passed (back-compat)', () => {
    expect(buildAnalysisSystem('SYS', members)).toContain(FUSION_ANALYSIS_SYSTEM)
    expect(buildSynthSystem('SYS', 'AN')).toContain(FUSION_SYNTH_SYSTEM)
  })
})

describe('runFusion compare arbiter (no judge — the USER picks a column)', () => {
  const PANEL2 = ['model-a', 'model-b']

  it('emits a panel chunk with every usable answer (+ms/tokens) and never calls a judge', async () => {
    const be = new FakeBackend({
      'model-a': answer('Answer A', { completionTokens: 11, totalTokens: 11 }),
      'model-b': answer('Answer B', { completionTokens: 22, totalTokens: 22 }),
    })
    const out = await drain(runFusion(be, 'k', { messageId: 'c1', messages: conv, panel: PANEL2, judgeModel: 'judge-x', arbiter: 'compare' }))

    // Only the two panel calls — judge-x must never be invoked.
    expect(be.calls.map(c => c.model).sort()).toEqual(['model-a', 'model-b'])

    const panel = out.find(c => c.type === 'panel')
    expect(panel?.type).toBe('panel')
    if (panel?.type === 'panel') {
      expect(panel.members.map(m => m.model)).toEqual(['model-a', 'model-b'])
      expect(panel.members[0].text).toBe('Answer A')
      expect(panel.members[0].tokens).toBe(11)
      expect(typeof panel.members[0].ms).toBe('number')
    }

    const start = out.find(c => c.type === 'start')
    expect(start?.type === 'start' ? start.model : '').toBe('compare (2)')
    // Fallback body for surfaces without panel rendering; stream ends cleanly.
    expect(out.some(c => c.type === 'delta' && /pick an answer/i.test(c.text))).toBe(true)
    expect(out[out.length - 1].type).toBe('done')
  })

  it('drops failed members from the panel chunk and sums usage of usable legs', async () => {
    const be = new FakeBackend({
      'model-a': answer('Good', { completionTokens: 5, totalTokens: 9, promptTokens: 4 }),
      'model-b': [{ type: 'error', messageId: 'inner', error: { code: 'HTTP_500', message: 'boom' } }],
    })
    const out = await drain(runFusion(be, 'k', { messageId: 'c2', messages: conv, panel: PANEL2, judgeModel: 'j', arbiter: 'compare' }))
    const panel = out.find(c => c.type === 'panel')
    expect(panel?.type === 'panel' ? panel.members.map(m => m.model) : []).toEqual(['model-a'])
    const usage = out.find(c => c.type === 'usage')
    expect(usage?.type === 'usage' ? usage.usage.totalTokens : 0).toBe(9)
  })
})
