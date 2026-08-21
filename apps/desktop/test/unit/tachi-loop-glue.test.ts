// apps/desktop/test/unit/tachi-loop-glue.test.ts
//
// Integration coverage for the TACHI loop GLUE that the happy-path test
// (tachi-loop.test.ts) doesn't exercise — the defensive wiring that a green
// build can't prove:
//
//   * a failed tool surfaces with exitCode 1 (errByCallId → tool-done)
//   * experimental_repairToolCall maps a wrong tool name (read_file → read)
//     onto a REAL tool and executes it — but is restricted to the file/shell
//     tools, so a typo near a meta tool (complet) can NOT silently complete()
//   * the per-run read-only dedup short-circuits an exact repeat read and skips
//     the permission gate entirely
//   * the stall guard refuses the 3rd identical call (here via consult_panel)
//     and never reaches the (expensive) advisor a 3rd time
//   * the blank-argument guards short-circuit before the advisor
//   * an aborted signal produces no side effect
//
// Driven by ai/test MockLanguageModelV3 (no network, no electron, no real LLM),
// against a real temp workspace — same approach as tachi-loop.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-glue-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }

type Step =
  | { tool: string; input: string }
  | { text: string }

/**
 * A mock model that replays `steps` one per loop iteration. A tool step emits a
 * single tool-call then finishes with reason 'tool-calls'; a text step emits a
 * final answer and finishes with 'stop'. Once the script is exhausted it repeats
 * the LAST step — so always end with a `{ text }` step to let the loop terminate.
 * Each tool-call gets a unique id (the args define identity, not the call id).
 */
function scriptedModel(steps: Step[]): MockLanguageModelV3 {
  let i = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = steps[Math.min(i, steps.length - 1)]!
      i++
      const chunks: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: [] }]
      if ('tool' in step) {
        chunks.push({ type: 'tool-call', toolCallId: `call-${i}`, toolName: step.tool, input: step.input })
        chunks.push({ type: 'finish', finishReason: 'tool-calls', usage: USAGE })
      } else {
        chunks.push({ type: 'text-start', id: 'a' })
        chunks.push({ type: 'text-delta', id: 'a', delta: step.text })
        chunks.push({ type: 'text-end', id: 'a' })
        chunks.push({ type: 'finish', finishReason: 'stop', usage: USAGE })
      }
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
}

interface RunResult {
  events: AgentEvent[]
  gateCalls: Array<{ name: string; args: Record<string, unknown> }>
}

/** Drive runTachiLoop with a recording gate (default allow) + optional extras. */
async function run(
  model: MockLanguageModelV3,
  opts: {
    gate?: (name: string, args: Record<string, unknown>) => Promise<boolean>
    signal?: AbortSignal
    consultPanel?: (q: string) => Promise<string>
    fusePlan?: (b: string) => Promise<string>
    searchPage?: (url: string, query: string) => Promise<string>
    verifyCheck?: (command: string) => Promise<{ ok: boolean; output: string; ran?: boolean }>
    verifyCompletion?: (task: string, summary: string) => Promise<{ pass: boolean; critique: string }>
    task?: string
  } = {},
): Promise<RunResult> {
  const events: AgentEvent[] = []
  const gateCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  await runTachiLoop({
    model,
    modelId: 'claude-sonnet-4.6', // agentCapable
    workspaceRoot: ws,
    task: opts.task ?? 'do the thing',
    signal: opts.signal ?? new AbortController().signal,
    onEvent: (e) => events.push(e),
    gate: async (name, args) => {
      gateCalls.push({ name, args })
      return opts.gate ? opts.gate(name, args) : true
    },
    consultPanel: opts.consultPanel,
    fusePlan: opts.fusePlan,
    searchPage: opts.searchPage,
    verifyCheck: opts.verifyCheck,
    verifyCompletion: opts.verifyCompletion,
  })
  return { events, gateCalls }
}

const toolDones = (events: AgentEvent[], name?: string) =>
  events.filter(e => e.type === 'tool-done' && (name ? (e as { name: string }).name === name : true)) as Array<Extract<AgentEvent, { type: 'tool-done' }>>

describe('runTachiLoop glue (mock model, real workspace)', () => {
  it('a failing tool surfaces as tool-done with exitCode 1 (not a silent success)', async () => {
    // read a file that does not exist → executeTool returns { isError: true }.
    const model = scriptedModel([
      { tool: 'read', input: JSON.stringify({ path: 'nope.txt' }) },
      { text: 'I could not read it.' },
    ])
    const { events } = await run(model)

    const done = toolDones(events, 'read')
    expect(done.length).toBe(1)
    expect(done[0]!.exitCode).toBe(1)              // ← the errByCallId mapping
    expect(done[0]!.output).toContain('File not found')
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('repairs a wrong tool name (read_file → read) onto a real tool and executes it', async () => {
    writeFileSync(join(ws, 'data.txt'), 'alpha\nbeta\ngamma')
    const model = scriptedModel([
      { tool: 'read_file', input: JSON.stringify({ path: 'data.txt' }) }, // not a real tool name
      { text: 'Read it via the repaired call.' },
    ])
    const { events, gateCalls } = await run(model)

    // The repair routes execution to the REAL `read` tool: the gate is invoked
    // with 'read' (the registered key), and the file content comes back ok.
    expect(gateCalls.some(g => g.name === 'read')).toBe(true)
    const done = toolDones(events, 'read')
    expect(done.length).toBe(1)
    expect(done[0]!.exitCode).toBe(0)
    expect(done[0]!.output).toContain('beta')
    expect(events.some(e => e.type === 'error')).toBe(false)
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('exposes search_page when injected and returns its result (past browse() truncation)', async () => {
    // STEAL 2026-07-08 (browser-use): zero-LLM full-page grep. Inject a stub and
    // script the model to call it; assert the tool is dispatched with the args
    // and its output reaches the model as a tool-done.
    const calls: Array<{ url: string; query: string }> = []
    const searchPage = async (url: string, query: string) => {
      calls.push({ url, query })
      return `# Example\n\n1 match(es) for "${query}":\n\nthe answer is 4271`
    }
    const model = scriptedModel([
      { tool: 'search_page', input: JSON.stringify({ url: 'https://example.com/long', query: 'answer' }) },
      { text: 'Found it past the truncation.' },
    ])
    const { events } = await run(model, { searchPage })

    expect(calls).toEqual([{ url: 'https://example.com/long', query: 'answer' }])
    const done = toolDones(events, 'search_page')
    expect(done.length).toBe(1)
    expect(done[0]!.output).toContain('4271')
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('does NOT execute search_page when not injected (unknown tool, no crash)', async () => {
    // No searchPage dep → the tool is not registered. A call to it must NEVER
    // reach the gate/execution (the security-relevant assertion); the SDK
    // surfaces it as a NoSuchTool the loop tolerates and still terminates.
    const model = scriptedModel([
      { tool: 'search_page', input: JSON.stringify({ url: 'https://x.test', query: 'q' }) },
      { text: 'search_page was not available.' },
    ])
    const { events, gateCalls } = await run(model)
    expect(gateCalls.some(g => g.name === 'search_page')).toBe(false) // never executed
    expect(events.some(e => e.type === 'error')).toBe(false)          // tolerated, not fatal
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  it('does NOT coerce a typo near a meta tool onto complete() (repair is file/shell only)', async () => {
    // 'complet' is one edit from 'complete', but complete is excluded from the
    // repair target set — so it must NOT be silently completed. The completion
    // validator stays the only path to "Task marked complete."
    const model = scriptedModel([
      { tool: 'complet', input: JSON.stringify({ summary: 'A real, substantive summary of what changed and how it was verified.' }) },
      { text: 'Falling through after the bad tool name.' },
    ])
    const { events, gateCalls } = await run(model)

    // No real tool ran for the bogus name, and nothing got marked complete.
    expect(gateCalls.length).toBe(0)
    expect(toolDones(events).some(d => /marked complete/i.test(d.output))).toBe(false)
    // The loop still terminates (NoSuchTool surfaces, loop self-finishes).
    expect(events.some(e => e.type === 'done')).toBe(true)
  })

  it('dedupes an exact repeat read: 2nd call short-circuits and skips the gate', async () => {
    writeFileSync(join(ws, 'a.txt'), 'reusable content')
    const model = scriptedModel([
      { tool: 'read', input: JSON.stringify({ path: 'a.txt' }) },
      { tool: 'read', input: JSON.stringify({ path: 'a.txt' }) }, // identical → deduped
      { text: 'Used the cached read.' },
    ])
    const { events, gateCalls } = await run(model)

    // The gate fired once (1st read); the 2nd identical read never reached it.
    expect(gateCalls.filter(g => g.name === 'read').length).toBe(1)
    const done = toolDones(events, 'read')
    expect(done.length).toBe(2)
    expect(done[0]!.output).toContain('reusable content')          // real read
    expect(done[1]!.output).toContain('already executed this run') // dedup pointer
  })

  it('stall guard refuses the 3rd identical consult_panel and never calls the advisor a 3rd time', async () => {
    let advisorCalls = 0
    const q = 'Which cache eviction policy?'
    const model = scriptedModel([
      { tool: 'consult_panel', input: JSON.stringify({ question: q }) },
      { tool: 'consult_panel', input: JSON.stringify({ question: q }) },
      { tool: 'consult_panel', input: JSON.stringify({ question: q }) }, // 3rd in a row → stalled
      { text: 'Acting on the advice already given.' },
    ])
    const { events } = await run(model, {
      consultPanel: async () => { advisorCalls++; return 'PANEL: use LRU.' },
    })

    // detectStall threshold 3: calls 1 and 2 reach the advisor; call 3 is steered.
    expect(advisorCalls).toBe(2)
    const done = toolDones(events, 'consult_panel')
    expect(done.length).toBe(3)
    expect(done[2]!.output.toLowerCase()).toContain('repeatedly')
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('consult_panel with a blank question short-circuits before the advisor', async () => {
    let advisorCalls = 0
    const model = scriptedModel([
      { tool: 'consult_panel', input: JSON.stringify({ question: '   ' }) },
      { text: 'No panel needed after all.' },
    ])
    const { events } = await run(model, {
      consultPanel: async () => { advisorCalls++; return 'SHOULD NOT RUN' },
    })

    expect(advisorCalls).toBe(0)
    const done = toolDones(events, 'consult_panel')
    expect(done[0]!.output).toContain('non-empty question')
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('bounds the agent history on a long run — prepareStep compaction trims the tail once the budget is crossed', async () => {
    // Record how many messages the model is actually sent each step. Without
    // compaction this grows ~linearly (2 per tool step); with it the tail stays
    // bounded near keepRecent once the run crosses the model's context budget.
    const promptCounts: number[] = []
    const STEPS = 22
    const body = 'D'.repeat(3_000) // big enough that ~19 steps overflow a 56k-char budget
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async (options: { prompt?: unknown }) => {
        promptCounts.push(Array.isArray(options.prompt) ? options.prompt.length : 0)
        call++
        const chunks: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: [] }]
        if (call <= STEPS) {
          chunks.push({ type: 'tool-call', toolCallId: `w${call}`, toolName: 'write', input: JSON.stringify({ path: `f${call}.txt`, content: body }) })
          chunks.push({ type: 'finish', finishReason: 'tool-calls', usage: USAGE })
        } else {
          chunks.push({ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'All files written.' }, { type: 'text-end', id: 'a' })
          chunks.push({ type: 'finish', finishReason: 'stop', usage: USAGE })
        }
        return { stream: simulateReadableStream({ chunks }) }
      },
    })
    const events: AgentEvent[] = []
    await runTachiLoop({
      model,
      modelId: 'qwen-2.5-coder', // 32k context → ~56k-char history budget
      workspaceRoot: ws,
      task: 'write many files',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async () => true,
      maxSteps: STEPS + 4,
    })

    // The run completed despite a history that would otherwise blow the window.
    expect(events[events.length - 1]!.type).toBe('done')
    const lastCount = promptCounts[promptCounts.length - 1]!
    // Final step is bounded by the compactor's block rule — head + notice + a
    // tail between keepRecent (12) and 2×keepRecent, because the cut is snapped
    // to a grid so it does not advance on every step and destroy the provider's
    // prefix cache. This bound was 16, calibrated to a tail of exactly
    // keepRecent; the tail is now allowed to run longer BETWEEN cuts, which is
    // more context retained, not less, and the char budget (the thing that
    // actually protects the run) is still enforced — the compactor falls back to
    // the tight cut whenever the longer tail would not fit.
    expect(lastCount).toBeLessThanOrEqual(2 * 12 + 2)
    // …and still far below what an uncompacted run would have sent by now: one
    // task message plus two per tool step.
    expect(lastCount).toBeLessThan((1 + 2 * STEPS) * 0.6)
    // The peak (right before a compaction) exceeded the bounded tail — proving the
    // history actually grew and was then trimmed, i.e. prepareStep is wired in.
    expect(Math.max(...promptCounts)).toBeGreaterThan(lastCount)
  })

  it('an ACCEPTED complete() terminates the loop — no further steps run', async () => {
    // Step 1 calls complete with a valid summary; step 2 would write a file.
    // Because complete is accepted, the loop must stop before step 2 executes.
    const model = scriptedModel([
      { tool: 'complete', input: JSON.stringify({ summary: 'Wired the completion stop condition and ran the desktop suite; every test passed green.' }) },
      { tool: 'write', input: JSON.stringify({ path: 'after-complete.txt', content: 'must never be written' }) },
      { text: 'unreachable' },
    ])
    const { events } = await run(model)

    // The post-complete write never happened.
    expect(existsSync(join(ws, 'after-complete.txt'))).toBe(false)
    expect(events.some(e => e.type === 'tool-call' && (e as { name: string }).name === 'write')).toBe(false)
    // complete was accepted, and the run ended cleanly.
    const done = toolDones(events, 'complete')
    expect(done.length).toBe(1)
    expect(done[0]!.output).toMatch(/marked complete/i)
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('a REJECTED complete() does NOT terminate — the loop continues', async () => {
    // Step 1 calls complete with a placeholder (rejected) → loop continues to
    // step 2's write, which DOES execute.
    const model = scriptedModel([
      { tool: 'complete', input: JSON.stringify({ summary: 'done' }) },
      { tool: 'write', input: JSON.stringify({ path: 'after-reject.txt', content: 'written because complete was rejected' }) },
      { text: 'finished for real' },
    ])
    const { events } = await run(model)

    expect(existsSync(join(ws, 'after-reject.txt'))).toBe(true) // loop kept going
    const done = toolDones(events, 'complete')
    expect(done[0]!.output).toMatch(/rejected/i)
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('salvages a text-encoded tool call on a native-then-salvage model and executes it', async () => {
    writeFileSync(join(ws, 'salv.txt'), 'salvaged file content')
    // Step 1: emit the tool call as TEXT (no native tool-call) like DeepSeek/Qwen
    // on vLLM. Step 2: a final answer. modelId 'deepseek-*' → native-then-salvage,
    // so runTachiLoop wraps the model with the salvage middleware.
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        const chunks: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: [] }]
        if (call === 1) {
          chunks.push(
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: '<tool_call>{"name":"read","arguments":{"path":"salv.txt"}}</tool_call>' },
            { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          )
        } else {
          chunks.push(
            { type: 'text-start', id: 'b' },
            { type: 'text-delta', id: 'b', delta: 'Read the file via salvage.' },
            { type: 'text-end', id: 'b' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          )
        }
        return { stream: simulateReadableStream({ chunks }) }
      },
    })
    const events: AgentEvent[] = []
    const gateCalls: string[] = []
    await runTachiLoop({
      model,
      modelId: 'deepseek-chat', // native-then-salvage → salvage middleware active
      workspaceRoot: ws,
      task: 'read salv.txt',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async (name) => { gateCalls.push(name); return true },
    })

    // The salvaged read ran through the SAME gated tool path as a native call.
    expect(gateCalls).toContain('read')
    const done = toolDones(events, 'read')
    expect(done.length).toBe(1)
    expect(done[0]!.output).toContain('salvaged file content')
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('a passing success check lets complete() finish the task', async () => {
    const checks: string[] = []
    const model = scriptedModel([
      { tool: 'set_success_check', input: JSON.stringify({ command: 'npm test' }) },
      { tool: 'complete', input: JSON.stringify({ summary: 'Added the parser and wired it in; the test suite passes green.' }) },
      { tool: 'write', input: JSON.stringify({ path: 'after.txt', content: 'must not run' }) },
      { text: 'unreachable' },
    ])
    const { events } = await run(model, {
      verifyCheck: async (cmd) => { checks.push(cmd); return { ok: true, output: 'all green' } },
    })

    expect(checks).toEqual(['npm test'])                       // the registered check ran
    expect(existsSync(join(ws, 'after.txt'))).toBe(false)      // complete terminated the loop
    const done = toolDones(events, 'complete')
    expect(done[done.length - 1]!.output).toMatch(/marked complete/i)
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('a FAILING success check blocks complete() and the loop keeps going until it passes', async () => {
    let n = 0
    const model = scriptedModel([
      { tool: 'set_success_check', input: JSON.stringify({ command: 'tsc --noEmit' }) },
      { tool: 'complete', input: JSON.stringify({ summary: 'Refactored the module and believe it type-checks cleanly now.' }) },
      { tool: 'complete', input: JSON.stringify({ summary: 'Fixed the remaining type error; tsc is clean now and the build passes.' }) },
      { text: 'done' },
    ])
    const { events } = await run(model, {
      // First check fails, second passes (the model "fixed it" between calls).
      verifyCheck: async () => { n++; return n === 1 ? { ok: false, output: 'src/x.ts(3,1): error TS2322' } : { ok: true, output: '' } },
    })

    const done = toolDones(events, 'complete')
    expect(done.length).toBe(2)
    expect(done[0]!.output).toMatch(/did not pass/i)
    expect(done[0]!.output).toContain('TS2322')          // the failing output is fed back
    expect(done[1]!.output).toMatch(/marked complete/i)  // accepted once the check is green
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('the success check is opt-in: complete() finishes on the summary alone when none is registered', async () => {
    let called = false
    const model = scriptedModel([
      { tool: 'complete', input: JSON.stringify({ summary: 'Updated the README and confirmed the links resolve; nothing else touched.' }) },
      { text: 'done' },
    ])
    const { events } = await run(model, {
      verifyCheck: async () => { called = true; return { ok: true, output: '' } },
    })

    expect(called).toBe(false) // no check registered → verifier never invoked
    expect(toolDones(events, 'complete')[0]!.output).toMatch(/marked complete/i)
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('todo_write records the plan, and complete() is blocked while items stay open', async () => {
    const model = scriptedModel([
      { tool: 'todo_write', input: JSON.stringify({ items: [{ content: 'wire the parser', status: 'in_progress' }, { content: 'add tests', status: 'pending' }] }) },
      { tool: 'complete', input: JSON.stringify({ summary: 'Wired the parser and added tests; the suite passes green now.' }) },
      { tool: 'todo_write', input: JSON.stringify({ items: [{ content: 'wire the parser', status: 'completed' }, { content: 'add tests', status: 'completed' }] }) },
      { tool: 'complete', input: JSON.stringify({ summary: 'Wired the parser and added tests; the suite passes green now.' }) },
      { text: 'done' },
    ])
    const { events } = await run(model)

    const writes = toolDones(events, 'todo_write')
    expect(writes[0]!.output).toContain('1 in progress, 1 pending')
    const completes = toolDones(events, 'complete')
    expect(completes.length).toBe(2)
    expect(completes[0]!.output).toMatch(/blocked/i)          // open todos → refused
    expect(completes[0]!.output).toContain('2 open')
    expect(completes[1]!.output).toMatch(/marked complete/i)  // all closed → accepted
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('pins the working plan into context on every subsequent step (survives compaction)', async () => {
    const prompts: unknown[][] = []
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async (options: { prompt?: unknown }) => {
        if (Array.isArray(options.prompt)) prompts.push(options.prompt)
        call++
        const chunks: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: [] }]
        if (call === 1) {
          chunks.push(
            { type: 'tool-call', toolCallId: 'td1', toolName: 'todo_write', input: JSON.stringify({ items: [{ content: 'PIN_ME_TASK', status: 'in_progress' }] }) },
            { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
          )
        } else {
          chunks.push(
            { type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'Working the plan.' }, { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          )
        }
        return { stream: simulateReadableStream({ chunks }) }
      },
    })
    const events: AgentEvent[] = []
    await runTachiLoop({
      model, modelId: 'claude-sonnet-4.6', workspaceRoot: ws, task: 'multi-step task',
      signal: new AbortController().signal, onEvent: (e) => events.push(e), gate: async () => true,
    })

    // After todo_write (step 1), the ledger is re-injected, so a later step's
    // prompt carries the pinned plan as its final message.
    const laterPrompts = prompts.slice(1)
    expect(laterPrompts.length).toBeGreaterThan(0)
    expect(laterPrompts.some(p => JSON.stringify(p).includes('PIN_ME_TASK') && JSON.stringify(p).includes('TODO LIST'))).toBe(true)
    // The plan is NOT injected on the very first step (nothing written yet).
    expect(JSON.stringify(prompts[0]).includes('PIN_ME_TASK')).toBe(false)
  })

  it('delegate runs a sub-agent and returns ONLY its summary (trajectory stays isolated)', async () => {
    // The mock serves both parent and child steps, branching on the first user
    // message (the task). The child immediately completes with a summary.
    const userTextOf = (prompt: unknown): string => {
      const u = (prompt as Array<{ role?: string; content?: unknown }> | undefined)?.find(m => m.role === 'user')
      return typeof u?.content === 'string' ? u.content : JSON.stringify(u?.content ?? '')
    }
    const model = new MockLanguageModelV3({
      doStream: async (options: { prompt?: unknown }) => {
        const userText = userTextOf(options.prompt)
        const promptStr = JSON.stringify(options.prompt ?? '')
        const chunks: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: [] }]
        if (userText.includes('recon the auth module')) {
          chunks.push(
            { type: 'tool-call', toolCallId: 'cc', toolName: 'complete', input: JSON.stringify({ summary: 'The auth module lives in auth.ts and validates JWTs in three call sites.' }) },
            { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
          )
        } else if (promptStr.includes('Sub-agent result')) {
          chunks.push({ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'The sub-agent summarized the auth module.' }, { type: 'text-end', id: 'a' }, { type: 'finish', finishReason: 'stop', usage: USAGE })
        } else {
          chunks.push({ type: 'tool-call', toolCallId: 'd1', toolName: 'delegate', input: JSON.stringify({ task: 'recon the auth module' }) }, { type: 'finish', finishReason: 'tool-calls', usage: USAGE })
        }
        return { stream: simulateReadableStream({ chunks }) }
      },
    })
    const events: AgentEvent[] = []
    await runTachiLoop({
      model, modelId: 'claude-sonnet-4.6', workspaceRoot: ws, task: 'explore the project',
      signal: new AbortController().signal, onEvent: (e) => events.push(e), gate: async () => true,
    })

    const delDone = toolDones(events, 'delegate')
    expect(delDone.length).toBe(1)
    expect(delDone[0]!.output).toContain('auth.ts and validates JWTs') // child summary surfaced
    // Context isolation: the child's own complete() did NOT leak into the parent stream.
    expect(events.some(e => e.type === 'tool-done' && (e as { name: string }).name === 'complete')).toBe(false)
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('the delegated sub-agent is read-only — a write it attempts is denied', async () => {
    const userTextOf = (prompt: unknown): string => {
      const u = (prompt as Array<{ role?: string; content?: unknown }> | undefined)?.find(m => m.role === 'user')
      return typeof u?.content === 'string' ? u.content : JSON.stringify(u?.content ?? '')
    }
    const model = new MockLanguageModelV3({
      doStream: async (options: { prompt?: unknown }) => {
        const userText = userTextOf(options.prompt)
        const promptStr = JSON.stringify(options.prompt ?? '')
        const chunks: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: [] }]
        if (userText.includes('try to modify the config')) {
          if (promptStr.includes('Permission denied')) {
            chunks.push({ type: 'tool-call', toolCallId: 'cc', toolName: 'complete', input: JSON.stringify({ summary: 'I could not modify the config — writes are not permitted in this read-only sub-agent.' }) }, { type: 'finish', finishReason: 'tool-calls', usage: USAGE })
          } else {
            chunks.push({ type: 'tool-call', toolCallId: 'cw', toolName: 'write', input: JSON.stringify({ path: 'child-write.txt', content: 'nope' }) }, { type: 'finish', finishReason: 'tool-calls', usage: USAGE })
          }
        } else if (promptStr.includes('Sub-agent result')) {
          chunks.push({ type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'understood.' }, { type: 'text-end', id: 'a' }, { type: 'finish', finishReason: 'stop', usage: USAGE })
        } else {
          chunks.push({ type: 'tool-call', toolCallId: 'd1', toolName: 'delegate', input: JSON.stringify({ task: 'try to modify the config' }) }, { type: 'finish', finishReason: 'tool-calls', usage: USAGE })
        }
        return { stream: simulateReadableStream({ chunks }) }
      },
    })
    await runTachiLoop({
      model, modelId: 'claude-sonnet-4.6', workspaceRoot: ws, task: 'have a sub-agent touch the config',
      signal: new AbortController().signal, onEvent: () => {}, gate: async () => true,
    })

    // The sub-agent's write was gated off (read-only) — no file created.
    expect(existsSync(join(ws, 'child-write.txt'))).toBe(false)
  })

  it('a success check that could NOT run (gate-denied, e.g. plan mode) does not deadlock complete()', async () => {
    const model = scriptedModel([
      { tool: 'set_success_check', input: JSON.stringify({ command: 'npm test' }) },
      { tool: 'complete', input: JSON.stringify({ summary: 'Made the change; the check could not run in this mode but the edit is small and reviewed.' }) },
      { text: 'done' },
    ])
    const { events } = await run(model, {
      verifyCheck: async () => ({ ok: false, ran: false, output: 'not permitted (plan mode)' }),
    })
    // ran:false → completion proceeds rather than blocking forever.
    expect(toolDones(events, 'complete').slice(-1)[0]!.output).toMatch(/marked complete/i)
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('delegate falls back to the child final text when the child completion is REJECTED (no rejected-summary leak)', async () => {
    const userTextOf = (prompt: unknown): string => {
      const u = (prompt as Array<{ role?: string; content?: unknown }> | undefined)?.find(m => m.role === 'user')
      return typeof u?.content === 'string' ? u.content : JSON.stringify(u?.content ?? '')
    }
    const model = new MockLanguageModelV3({
      doStream: async (options: { prompt?: unknown }) => {
        const userText = userTextOf(options.prompt)
        const promptStr = JSON.stringify(options.prompt ?? '')
        const chunks: Array<Record<string, unknown>> = [{ type: 'stream-start', warnings: [] }]
        if (userText.includes('summarize the build')) {
          if (promptStr.includes('complete rejected')) {
            chunks.push({ type: 'text-start', id: 'z' }, { type: 'text-delta', id: 'z', delta: '' }, { type: 'text-end', id: 'z' }, { type: 'finish', finishReason: 'stop', usage: USAGE })
          } else {
            // Useful text THEN a placeholder complete (which will be rejected).
            chunks.push(
              { type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'The build uses vite and runs in 9s.' }, { type: 'text-end', id: 'a' },
              { type: 'tool-call', toolCallId: 'cc', toolName: 'complete', input: JSON.stringify({ summary: 'done' }) },
              { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
            )
          }
        } else if (promptStr.includes('Sub-agent result')) {
          chunks.push({ type: 'text-start', id: 'b' }, { type: 'text-delta', id: 'b', delta: 'ok' }, { type: 'text-end', id: 'b' }, { type: 'finish', finishReason: 'stop', usage: USAGE })
        } else {
          chunks.push({ type: 'tool-call', toolCallId: 'd1', toolName: 'delegate', input: JSON.stringify({ task: 'summarize the build' }) }, { type: 'finish', finishReason: 'tool-calls', usage: USAGE })
        }
        return { stream: simulateReadableStream({ chunks }) }
      },
    })
    const events: AgentEvent[] = []
    await runTachiLoop({
      model, modelId: 'claude-sonnet-4.6', workspaceRoot: ws, task: 'explore',
      signal: new AbortController().signal, onEvent: (e) => events.push(e), gate: async () => true,
    })
    const delDone = toolDones(events, 'delegate')
    expect(delDone[0]!.output).toContain('vite and runs in 9s') // the child's TEXT, not the rejected 'done'
    expect(delDone[0]!.output).not.toMatch(/result:\s*done\s*$/i)
  })

  it('the completion critic blocks a mutating, check-less task then accepts once it passes', async () => {
    let n = 0
    const model = scriptedModel([
      { tool: 'write', input: JSON.stringify({ path: 'out.txt', content: 'work' }) },
      { tool: 'complete', input: JSON.stringify({ summary: 'Wrote out.txt with the feature; I believe it is complete and correct.' }) },
      { tool: 'complete', input: JSON.stringify({ summary: 'Wrote out.txt and verified the output against the spec; it is complete.' }) },
      { text: 'done' },
    ])
    const { events } = await run(model, {
      verifyCompletion: async () => { n++; return n === 1 ? { pass: false, critique: 'the summary does not show verification' } : { pass: true, critique: 'looks complete' } },
    })
    const done = toolDones(events, 'complete')
    expect(done.length).toBe(2)
    expect(done[0]!.output).toMatch(/blocked by review/i)
    expect(done[0]!.output).toContain('does not show verification')
    expect(done[1]!.output).toMatch(/marked complete/i)
    expect(events[events.length - 1]!.type).toBe('done')
  })

  it('the completion critic is skipped for a read-only run (no mutation)', async () => {
    writeFileSync(join(ws, 'a.txt'), 'x')
    let called = false
    const model = scriptedModel([
      { tool: 'read', input: JSON.stringify({ path: 'a.txt' }) },
      { tool: 'complete', input: JSON.stringify({ summary: 'Read a.txt and answered the question; nothing was changed.' }) },
      { text: 'done' },
    ])
    const { events } = await run(model, { verifyCompletion: async () => { called = true; return { pass: false, critique: 'no' } } })
    expect(called).toBe(false) // read-only run → no review tax
    expect(toolDones(events, 'complete')[0]!.output).toMatch(/marked complete/i)
  })

  it('an already-aborted signal produces no side effect', async () => {
    const ac = new AbortController()
    ac.abort()
    const model = scriptedModel([
      { tool: 'write', input: JSON.stringify({ path: 'should-not-exist.txt', content: 'nope' }) },
      { text: 'unreachable' },
    ])
    const { events } = await run(model, { signal: ac.signal })

    // The write must not have happened, and the loop must reach a terminal done.
    expect(existsSync(join(ws, 'should-not-exist.txt'))).toBe(false)
    expect(events.some(e => e.type === 'done')).toBe(true)
  })
})
