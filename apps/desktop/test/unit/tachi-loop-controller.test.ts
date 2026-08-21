// apps/desktop/test/unit/tachi-loop-controller.test.ts
//
// LOOP MODE — the controller that decides whether the harness goes again.
//
// The whole point of loop mode is that the CONTROLLER decides, not the model,
// so the decision table is tested exhaustively (iterations, spend, verify,
// abort, user stop, goal reached) and then driven end-to-end with a mocked
// iteration runner: iterations are counted, the continue-prompt carries the
// compacted transcript, the loop persists a resume point between iterations and
// clears it on a clean end, and STOP LOOP takes effect after the current cycle.

import { describe, it, expect, beforeEach } from 'vitest'
import type { AgentEvent } from '@tachi/core'
import {
  decideLoop,
  parseLoopDirective,
  stripTaskPreamble,
  clampLoopCap,
  declaresGoalReached,
  summarizeIteration,
  buildContinuePrompt,
  runLoopController,
  requestLoopStop,
  isLoopLive,
  _resetLoopRegistry,
  LOOP_DEFAULT_CAP,
  LOOP_MAX_CAP,
  type LoopIterationOutcome,
  type LoopPersistState,
} from '../../electron/services/tachi/loop-controller'

beforeEach(() => { _resetLoopRegistry() })

describe('parseLoopDirective', () => {
  it('recognises /loop with the default cap', () => {
    expect(parseLoopDirective('/loop fix every failing test')).toEqual({ goal: 'fix every failing test', cap: LOOP_DEFAULT_CAP })
  })

  it('reads an explicit cap, attached or spaced', () => {
    expect(parseLoopDirective('/loop 8 keep going')).toEqual({ goal: 'keep going', cap: 8 })
    expect(parseLoopDirective('/loop3 tidy imports')).toEqual({ goal: 'tidy imports', cap: 3 })
  })

  it('clamps an absurd cap and never returns 0', () => {
    expect(parseLoopDirective('/loop 999 forever')?.cap).toBe(LOOP_MAX_CAP)
    expect(parseLoopDirective('/loop 0 forever')?.cap).toBe(1)
  })

  it('is opt-in: a normal task is not a loop', () => {
    expect(parseLoopDirective('fix the failing test')).toBeNull()
    expect(parseLoopDirective('mention /loop in a sentence')).toBeNull()
    expect(parseLoopDirective('/loop')).toBeNull() // no goal
  })

  it('sees past the IPC preamble blocks prepended on the first turn', () => {
    const task = '<workspace-memory>\nnotes\n</workspace-memory>\n\n<role>\npersona\n</role>\n\n/loop 2 harden the gate'
    expect(stripTaskPreamble(task).startsWith('/loop')).toBe(true)
    expect(parseLoopDirective(task)).toEqual({ goal: 'harden the gate', cap: 2 })
  })
})

describe('clampLoopCap', () => {
  it('defaults for non-numbers and bounds the rest', () => {
    expect(clampLoopCap(undefined)).toBe(LOOP_DEFAULT_CAP)
    expect(clampLoopCap('7')).toBe(LOOP_DEFAULT_CAP)
    expect(clampLoopCap(-4)).toBe(1)
    expect(clampLoopCap(500)).toBe(LOOP_MAX_CAP)
    expect(clampLoopCap(4)).toBe(4)
  })
})

describe('decideLoop — the decision table', () => {
  const base = { iteration: 1, cap: 5, lastOutcome: 'done' as const }

  it('stops on abort, and abort beats everything else', () => {
    expect(decideLoop({ ...base, aborted: true }).code).toBe('aborted')
    expect(decideLoop({ ...base, lastOutcome: 'abort' }).action).toBe('stop')
  })

  it('stops when the user pressed STOP LOOP', () => {
    const d = decideLoop({ ...base, stopRequested: true })
    expect(d).toMatchObject({ action: 'stop', code: 'user-stop' })
  })

  it('stops when the iteration errored (looping on a broken run only burns budget)', () => {
    expect(decideLoop({ ...base, lastOutcome: 'error' }).code).toBe('iteration-error')
  })

  it('stops when the model declared the goal reached', () => {
    expect(decideLoop({ ...base, goalReached: true }).code).toBe('goal-reached')
  })

  it('stops at the iteration cap', () => {
    expect(decideLoop({ ...base, iteration: 5, cap: 5 }).code).toBe('iteration-cap')
    expect(decideLoop({ ...base, iteration: 4, cap: 5 }).action).toBe('continue')
  })

  it('stops at the 30-day spend cap, and ignores an uncapped (0) budget', () => {
    expect(decideLoop({ ...base, spentUsd: 12, budgetUsd: 10 }).code).toBe('spend-cap')
    expect(decideLoop({ ...base, spentUsd: 9.99, budgetUsd: 10 }).action).toBe('continue')
    expect(decideLoop({ ...base, spentUsd: 500, budgetUsd: 0 }).action).toBe('continue')
  })

  it('continues while the success check is red', () => {
    expect(decideLoop({ ...base, verify: 'red' })).toMatchObject({ action: 'continue', code: 'verify-red' })
  })

  it('continues when nothing has stopped it yet', () => {
    expect(decideLoop({ ...base, verify: 'green' })).toMatchObject({ action: 'continue', code: 'goal-open' })
  })

  it('the cap wins over a red check (a stuck loop still terminates)', () => {
    expect(decideLoop({ ...base, iteration: 5, cap: 5, verify: 'red' }).code).toBe('iteration-cap')
  })
})

describe('declaresGoalReached', () => {
  it('only fires on the explicit sentinel', () => {
    expect(declaresGoalReached('everything is fine now')).toBe(false)
    expect(declaresGoalReached('tests pass — LOOP GOAL REACHED')).toBe(true)
    expect(declaresGoalReached('loop goal reached')).toBe(true)
    expect(declaresGoalReached('')).toBe(false)
  })
})

describe('summarizeIteration', () => {
  it('renders a role-tagged digest of the transcript', () => {
    const out = summarizeIteration([
      { role: 'assistant', content: 'read the file' },
      { role: 'tool', content: 'read: 40 lines' },
    ])
    expect(out).toMatch(/ASSISTANT: read the file/)
    expect(out).toMatch(/TOOL: read: 40 lines/)
  })

  it('reuses the loop compactor: a huge transcript is bounded', () => {
    const big = Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', content: 'x'.repeat(400) + ` #${i}` }))
    const out = summarizeIteration(big, 2000)
    expect(out.length).toBeLessThanOrEqual(2001)
    expect(out).toMatch(/elided|#59/)
  })

  it('never returns empty', () => {
    expect(summarizeIteration([])).toMatch(/no transcript/i)
  })
})

describe('buildContinuePrompt', () => {
  it('carries the goal, the cycle number and the sentinel instruction', () => {
    const p = buildContinuePrompt({ goal: 'make tests pass', cap: 5 }, 2, 'ASSISTANT: fixed one test')
    expect(p).toMatch(/iteration 2 of at most 5/)
    expect(p).toMatch(/make tests pass/)
    expect(p).toMatch(/ASSISTANT: fixed one test/)
    expect(p).toMatch(/LOOP GOAL REACHED/)
  })
})

// ── The controller, end to end ───────────────────────────────────────────────

function outcome(over: Partial<LoopIterationOutcome> = {}): LoopIterationOutcome {
  return { outcome: 'done', transcript: [{ role: 'assistant', content: 'did a thing' }], goalReached: false, verify: 'unknown', durationMs: 1, ...over }
}

describe('runLoopController', () => {
  it('runs up to the cap, emits a loop event per cycle, and ends once', async () => {
    const events: AgentEvent[] = []
    const prompts: string[] = []
    const summary = await runLoopController({
      config: { goal: 'keep improving', cap: 3 },
      key: 'sess-1',
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      runIteration: async ({ task }) => { prompts.push(task); return outcome() },
    })

    expect(summary).toMatchObject({ iterations: 3, code: 'iteration-cap' })
    const loopEvents = events.filter(e => e.type === 'loop') as Extract<AgentEvent, { type: 'loop' }>[]
    expect(loopEvents.map(e => e.iteration)).toEqual([1, 2, 3])
    expect(loopEvents.every(e => e.cap === 3 && e.goal === 'keep improving')).toBe(true)
    expect(events.filter(e => e.type === 'loop-ended')).toHaveLength(1)
    // Cycle 1 runs the raw goal; later cycles get the continue prompt.
    expect(prompts[0]).toBe('keep improving')
    expect(prompts[1]).toMatch(/LOOP GOAL \(iteration 2 of at most 3\)/)
    expect(prompts[1]).toMatch(/ASSISTANT: did a thing/)
  })

  it('runs firstTask verbatim on cycle 1 (the IPC preamble survives) but the clean goal drives later cycles', async () => {
    const prompts: string[] = []
    await runLoopController({
      config: { goal: 'harden the gate', cap: 2 },
      key: 'sess-first',
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      firstTask: '<workspace-memory>\nprior notes\n</workspace-memory>\n\nharden the gate',
      runIteration: async ({ task }) => { prompts.push(task); return outcome() },
    })
    expect(prompts[0]).toMatch(/<workspace-memory>/)
    expect(prompts[1]).not.toMatch(/<workspace-memory>/)
    expect(prompts[1]).toMatch(/LOOP GOAL \(iteration 2 of at most 2\)/)
  })

  it('stops early when the model declares the goal reached', async () => {
    let n = 0
    const summary = await runLoopController({
      config: { goal: 'g', cap: 5 },
      key: 'sess-2',
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      runIteration: async () => { n++; return outcome({ goalReached: n === 2 }) },
    })
    expect(summary).toMatchObject({ iterations: 2, code: 'goal-reached' })
  })

  it('stops when the spend snapshot crosses the budget', async () => {
    let spent = 4
    const summary = await runLoopController({
      config: { goal: 'g', cap: 9 },
      key: 'sess-3',
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      spend: async () => { spent += 4; return { spentUsd: spent, budgetUsd: 10 } },
      runIteration: async () => outcome(),
    })
    expect(summary).toMatchObject({ iterations: 2, code: 'spend-cap' })
  })

  it('persists the resume point between iterations and clears it on a clean end', async () => {
    const persisted: LoopPersistState[] = []
    let cleared = 0
    await runLoopController({
      config: { goal: 'g', cap: 3 },
      key: 'sess-4',
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      persist: (s) => persisted.push(s),
      clearPersist: () => { cleared++ },
      runIteration: async () => outcome(),
    })
    // Persisted after cycles 1 and 2 (not after the last — the loop is over).
    expect(persisted.map(p => p.iteration)).toEqual([1, 2])
    expect(persisted[0]).toMatchObject({ key: 'sess-4', goal: 'g', cap: 3, workspaceRoot: '/ws' })
    expect(cleared).toBe(1)
  })

  it('resumes from a persisted iteration count', async () => {
    const seen: number[] = []
    const summary = await runLoopController({
      config: { goal: 'g', cap: 4 },
      key: 'sess-5',
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      startIteration: 2,
      runIteration: async ({ iteration }) => { seen.push(iteration); return outcome() },
    })
    expect(seen).toEqual([3, 4])
    expect(summary.iterations).toBe(4)
  })

  it('STOP LOOP takes effect after the current iteration', async () => {
    const summary = await runLoopController({
      config: { goal: 'g', cap: 6 },
      key: 'sess-6',
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      runIteration: async ({ iteration }) => {
        expect(isLoopLive('sess-6')).toBe(true)
        if (iteration === 1) expect(requestLoopStop('sess-6')).toBe(true)
        return outcome()
      },
    })
    expect(summary).toMatchObject({ iterations: 1, code: 'user-stop' })
    expect(isLoopLive('sess-6')).toBe(false) // the registry is released
  })

  it('reports no live loop for an unknown key', () => {
    expect(requestLoopStop('nope')).toBe(false)
    expect(isLoopLive('nope')).toBe(false)
  })

  it('an aborted parent stops the loop', async () => {
    const ctrl = new AbortController()
    const summary = await runLoopController({
      config: { goal: 'g', cap: 5 },
      key: 'sess-7',
      workspaceRoot: '/ws',
      signal: ctrl.signal,
      onEvent: () => {},
      runIteration: async () => { ctrl.abort(); return outcome({ outcome: 'abort' }) },
    })
    expect(summary).toMatchObject({ iterations: 1, code: 'aborted' })
  })

  it('a throwing iteration stops the loop instead of escaping', async () => {
    const events: AgentEvent[] = []
    const summary = await runLoopController({
      config: { goal: 'g', cap: 5 },
      key: 'sess-8',
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      runIteration: async () => { throw new Error('model died') },
    })
    expect(summary).toMatchObject({ iterations: 1, code: 'iteration-error' })
    expect(events.some(e => e.type === 'error' && /model died/.test(e.message))).toBe(true)
    expect(isLoopLive('sess-8')).toBe(false)
  })

  it('logs EVERY iteration to the run log', async () => {
    const logged: { iteration: number; outcome: string }[] = []
    await runLoopController({
      config: { goal: 'g', cap: 3 },
      key: 'sess-9',
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      logIteration: (e) => logged.push({ iteration: e.iteration, outcome: e.outcome }),
      runIteration: async () => outcome({ verify: 'red' }),
    })
    expect(logged).toEqual([
      { iteration: 1, outcome: 'done' },
      { iteration: 2, outcome: 'done' },
      { iteration: 3, outcome: 'done' },
    ])
  })
})
