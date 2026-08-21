// apps/desktop/test/unit/tachi-gaveup.test.ts
//
// GAVE-UP DETECTION — "the run stopped" is not "the run finished".
//
// The bug this locks down was observed live: two 8-minute TACHIAPP runs read
// files, then the provider finished with reason `stop` — no completion tool
// call, no assistant text, zero edits — and the UI rendered "Done (stop)" as a
// success. Three layers are tested:
//
//   1. the PURE decision table (outcome.ts) — every row, including the ones
//      that must stay unchanged (abort / error / an accepted completion);
//   2. the LOOP end-to-end against a MOCK model — a give-up is nudged exactly
//      ONCE, a nudge that lands flips the run to done, a nudge that doesn't
//      surfaces ENDED-INCOMPLETE, and an ordinary answer is untouched;
//   3. the COMPOSITION with the loop controller — an incomplete iteration is
//      verify-RED, which is the controller's existing "continue" arm.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'
import { classifyRunEnd, hasMutatingIntent, CONTINUE_NUDGE } from '../../electron/services/tachi/outcome'
import { createIterationCollector, decideLoop } from '../../electron/services/tachi/loop-controller'

// This suite spawns a REAL shell. On windows-latest that is powershell.exe with
// a cold module cache and a virus scanner in front of it, and 30s was measured
// to be too little — the test timed out while its child was still alive, which
// then turned the next test's temp-directory cleanup into EBUSY. Two failures,
// one cause. The allowance is per file on purpose: raising it globally was
// measured to break four sd/media suites that share real temp directories.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-gaveup-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
const MODEL_ID = 'claude-opus-4.8'

/** The exact shape of the observed give-up: a `stop` with nothing in it. */
const SILENT_STOP = [
  { type: 'stream-start' as const, warnings: [] },
  { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE },
]

function textStop(text: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 'a' },
    { type: 'text-delta' as const, id: 'a', delta: text },
    { type: 'text-end' as const, id: 'a' },
    { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE },
  ]
}

// The Venice shape (live 2026-08-02, `olafangensan-glm-4.7-flash-heretic`): a
// reasoning model streams its thinking in the SEPARATE reasoning channel and
// emits no assistant text and no tool call. Chat renders that channel, so the
// same model looked healthy there; the harness dropped it and reported silence.
function reasoningOnly(thought: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'reasoning-start' as const, id: 'r' },
    { type: 'reasoning-delta' as const, id: 'r', delta: thought },
    { type: 'reasoning-end' as const, id: 'r' },
    { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE },
  ]
}

function completeRound(summary: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'complete', input: JSON.stringify({ summary }) },
    { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE },
  ]
}

interface Run { events: AgentEvent[]; calls: number; done: Extract<AgentEvent, { type: 'done' }> }

async function run(
  chunksPerCall: (call: number) => ReturnType<typeof textStop>,
  extra: Partial<Parameters<typeof runTachiLoop>[0]> = {},
): Promise<Run> {
  const events: AgentEvent[] = []
  let calls = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      calls++
      return { stream: simulateReadableStream({ chunks: chunksPerCall(calls) }) }
    },
  })
  await runTachiLoop({
    model,
    modelId: MODEL_ID,
    workspaceRoot: ws,
    task: 'fix the failing gate test',   // classifies as `debugging` ⇒ mutating intent
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    gate: async () => true,
    maxSteps: 8,
    ...extra,
  })
  const done = events.filter(e => e.type === 'done').at(-1) as Extract<AgentEvent, { type: 'done' }>
  return { events, calls, done }
}

/**
 * The DOGFOOD-4 shape, round 1: the model opens with prose, then fires a tool
 * group. The pass does NOT end here — the SDK takes another step — which is
 * precisely why the early prose used to launder the run into "done".
 */
function proseThenWriteRound(text: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 'a' },
    { type: 'text-delta' as const, id: 'a', delta: text },
    { type: 'text-end' as const, id: 'a' },
    { type: 'tool-call' as const, toolCallId: 'w9', toolName: 'write', input: JSON.stringify({ path: 'theme.css', content: ':root{--x:1}' }) },
    { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE },
  ]
}

/** Round 1 of a read-only run: prose, then a provably read-only bash call. */
function proseThenBashRound(text: string, command: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 'a' },
    { type: 'text-delta' as const, id: 'a', delta: text },
    { type: 'text-end' as const, id: 'a' },
    { type: 'tool-call' as const, toolCallId: 'b9', toolName: 'bash', input: JSON.stringify({ command }) },
    { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE },
  ]
}

function bashRound(call: number, command: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'tool-call' as const, toolCallId: `b${call}`, toolName: 'bash', input: JSON.stringify({ command }) },
    { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE },
  ]
}

// ── 1. the decision table ────────────────────────────────────────────────────

describe('classifyRunEnd — the end-state decision table', () => {
  const base = { terminal: 'stop' as const, completionAccepted: false, mutatingIntent: true, mutations: 0, finalText: 'looked around' }

  it('stop + an accepted completion is DONE', () => {
    expect(classifyRunEnd({ ...base, completionAccepted: true }).outcome).toBe('done')
  })

  it('stop + no completion + no mutation on a mutating-intent task is INCOMPLETE', () => {
    const v = classifyRunEnd(base)
    expect(v.outcome).toBe('incomplete')
    expect(v.code).toBe('no-completion')
    expect(v.detail).toBeTruthy()
  })

  it('stop + no completion but the run DID mutate is DONE', () => {
    expect(classifyRunEnd({ ...base, mutations: 2 }).outcome).toBe('done')
  })

  it('a read-only/answer task that answered is DONE even with no completion call', () => {
    expect(classifyRunEnd({ ...base, mutatingIntent: false }).outcome).toBe('done')
  })

  it('empty/whitespace final text is INCOMPLETE regardless of mode or mutations', () => {
    expect(classifyRunEnd({ ...base, mutatingIntent: false, mutations: 3, finalText: '' }).code).toBe('empty-text')
    expect(classifyRunEnd({ ...base, mutatingIntent: false, mutations: 3, finalText: '   \n\t ' }).code).toBe('empty-text')
  })

  // ── WHY the pass was empty (live 2026-08-02, Venice glm-4.7-flash-heretic) ──
  // The outcome is 'empty-text' in every case below — the operator got nothing.
  // What changes is the SENTENCE, because "the model gave up" and "we truncated
  // the model mid-thought" are opposite diagnoses and used to read identically.
  describe('empty-text detail names the real cause', () => {
    const silent = { ...base, mutatingIntent: false, mutations: 3, finalText: '' }

    it('reasoning-only: says the model thought and names the volume', () => {
      const r = classifyRunEnd({ ...silent, reasoningChars: 4200 })
      expect(r.code).toBe('empty-text')
      expect(r.detail).toContain('4200')
      expect(r.detail).toMatch(/reasoning/i)
    })

    it('reasoning + length: blames the OUTPUT LIMIT, not the model', () => {
      const r = classifyRunEnd({ ...silent, reasoningChars: 9000, finishReason: 'length' })
      expect(r.detail).toMatch(/output budget/i)
      expect(r.detail).toContain('9000')
    })

    it('length with no reasoning: says it was cut off, not finished', () => {
      const r = classifyRunEnd({ ...silent, finishReason: 'length' })
      expect(r.detail).toMatch(/cut off/i)
    })

    it('genuine silence keeps the original sentence', () => {
      // Unmeasured (fields absent) must read exactly like measured-zero, so an
      // old caller that never sets them is not accused of anything new.
      const unmeasured = classifyRunEnd(silent).detail
      const measuredZero = classifyRunEnd({ ...silent, reasoningChars: 0, finishReason: 'stop' }).detail
      expect(unmeasured).toBe('the run ended without any assistant text and without calling the completion tool')
      expect(measuredZero).toBe(unmeasured)
    })

    it('reasoning does NOT rescue a pass — silence is still incomplete', () => {
      // The model talking to itself is not the model answering the user.
      expect(classifyRunEnd({ ...silent, reasoningChars: 50000 }).outcome).toBe('incomplete')
    })
  })

  it('an accepted completion outranks silence — the tool IS the summary', () => {
    expect(classifyRunEnd({ ...base, completionAccepted: true, finalText: '' }).outcome).toBe('done')
  })

  it('abort and error are unchanged, whatever else is true', () => {
    expect(classifyRunEnd({ ...base, terminal: 'abort' }).outcome).toBe('abort')
    expect(classifyRunEnd({ ...base, terminal: 'error' }).outcome).toBe('error')
    expect(classifyRunEnd({ ...base, terminal: 'abort', completionAccepted: true }).outcome).toBe('abort')
  })
})

// ── 1b. the SILENT-FINISH row (dogfood-4) ────────────────────────────────────

describe('classifyRunEnd — silent-finish (the tool-only final pass)', () => {
  /** The live shape: opening prose, then a tool group, then stop. */
  const dogfood4 = {
    terminal: 'stop' as const,
    completionAccepted: false,
    mutatingIntent: true,
    mutations: 3,                    // it really did change things…
    finalText: 'I will start by reading the theme recipe.',   // …and really did talk — first
    toolsRan: true,
    trailingText: false,             // but never after the last tool
  }

  it('the dogfood-4 shape is INCOMPLETE with code silent-finish', () => {
    const v = classifyRunEnd(dogfood4)
    expect(v.outcome).toBe('incomplete')
    expect(v.code).toBe('silent-finish')
    expect(v.detail).toMatch(/tool output/)
  })

  it('the SAME run with a closing message is DONE — trailing prose is the whole difference', () => {
    expect(classifyRunEnd({ ...dogfood4, trailingText: true }).outcome).toBe('done')
  })

  it('an accepted completion outranks it — complete() after tools is always DONE', () => {
    expect(classifyRunEnd({ ...dogfood4, completionAccepted: true }).outcome).toBe('done')
  })

  it('abort/error outrank it — a user stop is never a give-up', () => {
    expect(classifyRunEnd({ ...dogfood4, terminal: 'abort' }).outcome).toBe('abort')
    expect(classifyRunEnd({ ...dogfood4, terminal: 'error' }).outcome).toBe('error')
  })

  it('PRECEDENCE: total silence still reports as empty-text, not silent-finish', () => {
    // Both rows are true here. empty-text is the more informative diagnosis
    // (the model never said one word), so it must keep winning.
    expect(classifyRunEnd({ ...dogfood4, finalText: '' }).code).toBe('empty-text')
    expect(classifyRunEnd({ ...dogfood4, finalText: '  \n ' }).code).toBe('empty-text')
  })

  it('PRECEDENCE: a mutating task that changed nothing still reports as no-completion', () => {
    // Read-only tools ran and nothing was said after them, but "you were asked
    // to change something and did not" is the fact worth surfacing.
    expect(classifyRunEnd({ ...dogfood4, mutations: 0 }).code).toBe('no-completion')
  })

  it('answer-shaped runs are covered too — read-only tools then silence is still a silent finish', () => {
    expect(classifyRunEnd({ ...dogfood4, mutatingIntent: false, mutations: 0 }).code).toBe('silent-finish')
  })

  it('a pass with NO tools at all can never trip it', () => {
    expect(classifyRunEnd({ ...dogfood4, mutatingIntent: false, toolsRan: false, trailingText: false }).outcome).toBe('done')
  })

  it('unmeasured facts are not evidence — a caller that omits them gets the old table', () => {
    const { toolsRan: _t, trailingText: _tt, ...unmeasured } = dogfood4
    expect(classifyRunEnd(unmeasured).outcome).toBe('done')
  })
})

describe('hasMutatingIntent', () => {
  it('is false in PLAN mode — a plan that changes nothing is doing its job', () => {
    expect(hasMutatingIntent('fix the crash', 'plan')).toBe(false)
  })

  it('is true for change-shaped tasks in BUILD mode', () => {
    expect(hasMutatingIntent('fix the crash', 'build')).toBe(true)
    expect(hasMutatingIntent('add a retry button')).toBe(true)
    expect(hasMutatingIntent('refactor the gate')).toBe(true)
  })

  it('is false for answer-shaped tasks', () => {
    expect(hasMutatingIntent('explain how the gate works', 'build')).toBe(false)
    expect(hasMutatingIntent('what is in this folder?')).toBe(false)
  })
})

// ── 2. the loop, end to end ──────────────────────────────────────────────────

describe('runTachiLoop — AUTO-CONTINUE on a give-up', () => {
  it('nudges ONCE and surfaces ENDED-INCOMPLETE when the nudge also gives up', async () => {
    const r = await run(() => SILENT_STOP)

    // Exactly two model passes: the run, then the single continuation.
    expect(r.calls).toBe(2)
    expect(r.done.incomplete).toBe(true)
    expect(r.done.reason).toBe('stop')           // `reason` is unchanged — the fields are additive
    expect(r.done.incompleteCode).toBe('empty-text')
    expect(r.done.nudged).toBe(true)

    // The nudge is announced in the transcript exactly once.
    const nudges = r.events.filter(e => e.type === 'text' && /AUTO-CONTINUE/.test((e as { text: string }).text))
    expect(nudges).toHaveLength(1)
  })

  it('a REASONING-ONLY pass is reported as reasoning, not as a silent give-up', async () => {
    // The exact live failure: Venice glm-4.7-flash-heretic thought at length,
    // said nothing, called nothing. Before this, both the nudge line and the
    // terminal verdict read "ended without any assistant text" — which blamed
    // the model for going quiet when it had in fact been talking the whole time.
    const r = await run(() => reasoningOnly('x'.repeat(1234)))

    expect(r.done.incomplete).toBe(true)
    expect(r.done.incompleteCode).toBe('empty-text')   // outcome unchanged
    expect(r.done.incompleteDetail).toMatch(/reasoning/i)
    expect(r.done.incompleteDetail).toContain('1234')

    // Reasoning must NOT be rendered as assistant text — that would make the
    // model look like it answered, and would blind silent-finish detection.
    const spoken = r.events.filter(e => e.type === 'text' && !/AUTO-CONTINUE/.test((e as { text: string }).text))
    expect(spoken).toHaveLength(0)
  })

  // NOTE: the TRUNCATION half of this bug (finish_reason 'length') cannot be
  // tested here — MockLanguageModelV3/V4 drop `finishReason` on the way to
  // fullStream. It is covered end-to-end against the real openai-compatible
  // provider in tachiReasoningWire.test.ts.

  it('caps the nudge at one — a DIFFERENT give-up on the nudge pass is not re-nudged', async () => {
    // Pass 1 goes silent (empty-text); the nudge pass talks but still changes
    // nothing on a mutating-intent task (no-completion). Two distinct incomplete
    // codes, one nudge budget — the second verdict is surfaced, not retried.
    const r = await run(call => (call === 1 ? SILENT_STOP : textStop('I looked at the gate but did not change it.')), { maxSteps: 30 })
    expect(r.calls).toBe(2)
    expect(r.done.incomplete).toBe(true)
    expect(r.done.incompleteCode).toBe('no-completion')
    expect(r.done.nudged).toBe(true)
  })

  it('logs the nudge exactly once through the injected run-log hook', async () => {
    const logged: Array<{ code: string }> = []
    const r = await run(() => SILENT_STOP, { logNudge: (e) => { logged.push({ code: e.code }) } })
    expect(r.done.incomplete).toBe(true)
    expect(logged).toHaveLength(1)
    expect(logged[0].code).toBe('empty-text')
  })

  it('read-only bash buys NO productive-run credit — still a give-up', async () => {
    // Live-found (batch16b verify): a run whose only tool calls were `ls` +
    // a hex dump could never classify as no-completion, because bash counted
    // as a mutation unconditionally. Provably read-only commands now don't.
    const r = await run(
      call => (call === 1 ? bashRound(call, 'ls') : textStop('Looked around; nothing I can do.')),
      { maxSteps: 30 },
    )
    expect(r.done.incomplete).toBe(true)
    expect(r.done.incompleteCode).toBe('no-completion')
    expect(r.done.nudged).toBe(true)
  })

  it('bash with a redirect still counts as a mutation (conservative default)', async () => {
    const r = await run(
      call => (call === 1 ? bashRound(call, 'echo hi > out.txt') : textStop('Wrote the file.')),
      { maxSteps: 30 },
    )
    expect(r.done.incomplete).toBeUndefined()
  })

  it('a nudge that lands flips the run to DONE (no incomplete flag)', async () => {
    const r = await run(call => (call === 1 ? SILENT_STOP : completeRound('Fixed the gate test by widening the allowlist; verified with the unit suite.')))
    expect(r.calls).toBe(2)
    expect(r.done.incomplete).toBeUndefined()
    expect(r.done.reason).toBe('stop')
    expect(r.done.nudged).toBe(true)  // it took a nudge, and we say so
  })

  it('feeds the nudge text to the model as a real follow-up turn', async () => {
    const prompts: string[] = []
    let calls = 0
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        calls++
        prompts.push(JSON.stringify((options as { prompt?: unknown }).prompt ?? ''))
        return { stream: simulateReadableStream({ chunks: SILENT_STOP }) }
      },
    })
    await runTachiLoop({
      model, modelId: MODEL_ID, workspaceRoot: ws,
      task: 'fix the failing gate test',
      signal: new AbortController().signal,
      onEvent: () => {}, gate: async () => true, maxSteps: 8,
    })
    expect(calls).toBe(2)
    expect(prompts[0]).not.toContain('stopped without completing')
    expect(prompts[1]).toContain(CONTINUE_NUDGE.slice(0, 40))
  })

  it('leaves an ordinary answered run completely alone (no nudge, no flag)', async () => {
    const r = await run(() => textStop('The gate lives in verify-policy.ts and allows write/edit/bash.'), {
      task: 'explain how the verify gate works',
    })
    expect(r.calls).toBe(1)
    expect(r.done).toEqual({ type: 'done', reason: 'stop' })
  })

  it('does not nudge a mutating run that actually changed something', async () => {
    const r = await run(call => (call === 1
      ? [
          { type: 'stream-start' as const, warnings: [] },
          { type: 'tool-call' as const, toolCallId: 'w1', toolName: 'write', input: JSON.stringify({ path: 'fix.txt', content: 'patched' }) },
          { type: 'finish' as const, finishReason: 'tool-calls' as const, usage: USAGE },
        ]
      : textStop('Patched fix.txt.')))
    expect(r.calls).toBe(2)   // tool round + answer round, NOT a nudge
    expect(r.done.incomplete).toBeUndefined()
    expect(r.done.nudged).toBeUndefined()
  })

  // ── the dogfood-4 gap: a pass that ENDS on tool output ────────────────────
  //
  // Live shape (2026-07-26): prose → a 21-tool group → stop. No complete(), no
  // closing word. passText was non-empty (that opening prose) and mutations > 0,
  // so every earlier row scored it `done` and the operator got no summary at
  // all — even though the task said "complete with a summary".

  it('prose → tools → stop is INCOMPLETE (silent-finish) and is nudged once', async () => {
    const logged: Array<{ code: string; detail: string }> = []
    const r = await run(
      call => (call === 1
        ? proseThenWriteRound('I will start by reading the theme recipe.')
        : SILENT_STOP),                                  // pass 1 ends ON the tool output
      { maxSteps: 30, logNudge: (e) => { logged.push({ code: e.code, detail: e.detail }) } },
    )
    // Two rounds of pass 1, then the single nudge pass (which also says nothing).
    expect(r.calls).toBe(3)
    expect(r.done.incomplete).toBe(true)
    expect(r.done.nudged).toBe(true)
    // The nudge was spent on the SILENT-FINISH diagnosis…
    expect(logged).toHaveLength(1)
    expect(logged[0].code).toBe('silent-finish')
    expect(logged[0].detail).toMatch(/tool output/)
    // …and the transcript said so, exactly once.
    const nudges = r.events.filter(e => e.type === 'text' && /AUTO-CONTINUE/.test((e as { text: string }).text))
    expect(nudges).toHaveLength(1)
  })

  it('the nudge is what produces the missing summary — a landing nudge flips it to DONE', async () => {
    const r = await run(call => (
      call === 1 ? proseThenWriteRound('Patching the theme now.')
      : call === 2 ? SILENT_STOP
      : completeRound('Added the OPUS-5 theme: swatches derived from the base hue; verified with the theme unit suite.')
    ), { maxSteps: 30 })
    expect(r.calls).toBe(3)
    expect(r.done.incomplete).toBeUndefined()
    expect(r.done.nudged).toBe(true)
  })

  it('the same run that DOES speak after its tools is left alone', async () => {
    const r = await run(call => (
      call === 1 ? proseThenWriteRound('Patching the theme now.')
      : textStop('Added the OPUS-5 theme and re-derived the swatches.')
    ), { maxSteps: 30 })
    expect(r.calls).toBe(2)
    expect(r.done.incomplete).toBeUndefined()
    expect(r.done.nudged).toBeUndefined()
  })

  it('read-only Q&A: tools then a written answer is DONE, no nudge', async () => {
    const r = await run(call => (
      call === 1 ? proseThenBashRound('Let me look at the gate.', 'ls')
      : textStop('The gate lives in verify-policy.ts and allows write/edit/bash.')
    ), { task: 'explain how the verify gate works', maxSteps: 30 })
    expect(r.calls).toBe(2)
    expect(r.done).toEqual({ type: 'done', reason: 'stop' })
  })

  it('read-only Q&A that stops on tool output is a silent finish too', async () => {
    const logged: Array<{ code: string }> = []
    const r = await run(
      call => (call === 1 ? proseThenBashRound('Let me look at the gate.', 'ls') : SILENT_STOP),
      { task: 'explain how the verify gate works', maxSteps: 30, logNudge: (e) => { logged.push({ code: e.code }) } },
    )
    expect(r.done.incomplete).toBe(true)
    expect(logged[0].code).toBe('silent-finish')
    expect(r.done.nudged).toBe(true)
  })

  it('does not nudge in PLAN mode — a plan legitimately changes nothing', async () => {
    const r = await run(() => textStop('Plan: 1) widen the allowlist 2) add a test.'), { mode: 'plan' })
    expect(r.calls).toBe(1)
    expect(r.done.incomplete).toBeUndefined()
  })
})

// ── 3. composition with the loop controller ──────────────────────────────────

describe('loop controller composition', () => {
  it('reads an ENDED-INCOMPLETE iteration as verify-RED', () => {
    const c = createIterationCollector()
    c.observe({ type: 'text', text: 'looked around' })
    c.observe({ type: 'done', reason: 'stop', incomplete: true, incompleteCode: 'no-completion' })
    const r = c.result()
    expect(r.verify).toBe('red')
    expect(r.goalReached).toBe(false)
    // …which is exactly the controller's existing "there is work left" arm.
    expect(decideLoop({ iteration: 1, cap: 3, lastOutcome: 'done', verify: r.verify })).toEqual({
      action: 'continue', code: 'verify-red', reason: 'the success check is still failing',
    })
  })

  it('never downgrades a GREEN completion receipt to red', () => {
    const c = createIterationCollector()
    c.observe({ type: 'tool-call', name: 'complete', input: JSON.stringify({ summary: 'did the thing, LOOP GOAL REACHED' }) })
    c.observe({ type: 'tool-done', name: 'complete', output: 'Task marked complete.' })
    c.observe({ type: 'done', reason: 'stop', incomplete: true })
    const r = c.result()
    expect(r.verify).toBe('green')
    expect(r.goalReached).toBe(true)
  })

  it('leaves an ordinary done iteration exactly as before', () => {
    const c = createIterationCollector()
    c.observe({ type: 'text', text: 'answered' })
    c.observe({ type: 'done', reason: 'stop' })
    expect(c.result().verify).toBe('unknown')
  })
})
