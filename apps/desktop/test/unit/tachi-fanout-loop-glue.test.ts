// apps/desktop/test/unit/tachi-fanout-loop-glue.test.ts
//
// The GLUE, driven by a mock model through the REAL loop (no network, no
// electron): `spawn_agents` as the model actually sees it, and the per-iteration
// collector loop mode decides on.
//
// What a unit test of fanout.ts alone cannot prove:
//   * spawn_agents is registered at depth 0 and NOT at depth 1 (children can't
//     fan out — the depth cap, checked where it is enforced);
//   * ONE parent-level gate approval covers the whole fan-out, and a denial
//     hands the model a reason instead of silently running the children;
//   * a real child session runs through the real loop with a read-only gate,
//     and its result comes back in the tool output.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'
import { createIterationCollector } from '../../electron/services/tachi/loop-controller'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-fanout-glue-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }

/**
 * A model that emits `first` on step 1 and a final text answer afterwards.
 * A child session (which gets its own model instance? no — the SAME instance)
 * would re-enter step 2+, so children are given their own script by index.
 */
function scriptedModel(scripts: Array<{ tool: string; input: string } | { text: string }>): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = scripts[Math.min(call, scripts.length - 1)]
      call++
      if ('tool' in step) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: `t${call}`, toolName: step.tool, input: step.input },
              { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
            ],
          }),
        }
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: `a${call}` },
            { type: 'text-delta', id: `a${call}`, delta: step.text },
            { type: 'text-end', id: `a${call}` },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ],
        }),
      }
    },
  })
}

describe('spawn_agents — registration + depth cap', () => {
  it('is offered at depth 0 and refused at depth 1 (a child cannot fan out)', async () => {
    const events: AgentEvent[] = []
    await runTachiLoop({
      model: scriptedModel([
        { tool: 'spawn_agents', input: JSON.stringify({ tasks: [{ prompt: 'look at the README' }] }) },
        { text: 'child done' },
      ]),
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'child task',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async () => true,
      recursionDepth: 1, // this run IS a child
      maxSteps: 3,
    })
    // At depth 1 neither fan-out tool is registered: the model is told the tool
    // is unavailable (with the list it DOES have) and no grandchildren appear.
    const done = events.find(e => e.type === 'tool-done' && (e as { name: string }).name === 'spawn_agents') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(done?.output).toMatch(/unavailable tool 'spawn_agents'/i)
    expect(done?.output).not.toMatch(/\bdelegate\b/)      // nor delegate
    expect(done?.output).not.toMatch(/Available tools:.*spawn_agents/)
    expect(done?.exitCode).toBe(1)
  })

  it('IS registered at depth 0 (the same call succeeds for a top-level run)', async () => {
    const events: AgentEvent[] = []
    await runTachiLoop({
      model: scriptedModel([
        { tool: 'spawn_agents', input: JSON.stringify({ tasks: [{ prompt: 'say hi' }] }) },
        { text: 'child said hi' },
        { text: 'parent done' },
      ]),
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'top-level task',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async () => true,
      maxSteps: 5,
    })
    const done = events.find(e => e.type === 'tool-done' && (e as { name: string }).name === 'spawn_agents') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(done?.output).toMatch(/sub-agent\(s\) finished/)
    expect(done?.output).not.toMatch(/unavailable tool/i)
  })
})

describe('spawn_agents — parent-level approval', () => {
  it('asks the gate ONCE for the whole fan-out, listing the tasks', async () => {
    const gateCalls: Array<{ name: string; args: Record<string, unknown> }> = []
    const events: AgentEvent[] = []
    await runTachiLoop({
      model: scriptedModel([
        { tool: 'spawn_agents', input: JSON.stringify({ tasks: [{ prompt: 'summarise a.txt' }, { prompt: 'summarise b.txt' }] }) },
        { text: 'both summarised' },
      ]),
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'summarise both files',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async (name, args) => { gateCalls.push({ name, args }); return true },
      maxSteps: 4,
    })

    const fanoutGate = gateCalls.filter(c => c.name === 'spawn_agents')
    expect(fanoutGate).toHaveLength(1) // ONE approval for the fan-out
    expect(fanoutGate[0].args.taskCount).toBe(2)
    expect(fanoutGate[0].args.writes).toBe(false)
    expect(String(fanoutGate[0].args.tasks)).toMatch(/summarise a\.txt/)
  })

  it('a denied fan-out runs no children and tells the model why', async () => {
    const events: AgentEvent[] = []
    let childrenStarted = 0
    await runTachiLoop({
      model: scriptedModel([
        { tool: 'spawn_agents', input: JSON.stringify({ tasks: [{ prompt: 'do a thing' }] }) },
        { text: 'ok, doing it myself' },
      ]),
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'x',
      signal: new AbortController().signal,
      onEvent: (e) => { events.push(e); if (e.type === 'tool-call' && e.name === 'read') childrenStarted++ },
      gate: async (name) => (name === 'spawn_agents' ? 'The user declined the fan-out.' : true),
      maxSteps: 4,
    })

    expect(childrenStarted).toBe(0)
    const done = events.find(e => e.type === 'tool-done' && (e as { name: string }).name === 'spawn_agents') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(done?.output).toMatch(/declined the fan-out/i)
  })

  it('rejects malformed input before any approval is asked for', async () => {
    const gateNames: string[] = []
    const events: AgentEvent[] = []
    await runTachiLoop({
      model: scriptedModel([
        { tool: 'spawn_agents', input: JSON.stringify({ tasks: [] }) },
        { text: 'fine' },
      ]),
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'x',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async (name) => { gateNames.push(name); return true },
      maxSteps: 4,
    })
    expect(gateNames).not.toContain('spawn_agents')
    const done = events.find(e => e.type === 'tool-done' && (e as { name: string }).name === 'spawn_agents') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(done?.output).toMatch(/non-empty "tasks"/i)
  })
})

describe('spawn_agents — a real child session', () => {
  it('runs a read-only child through the real loop and returns its summary; the child cannot write', async () => {
    writeFileSync(join(ws, 'a.txt'), 'the answer is 42', 'utf8')
    const events: AgentEvent[] = []

    // Step 1 (parent): fan out. Steps 2-4 are consumed by the CHILD loop (same
    // mock instance, shared call counter): read → complete. Step 5+: the parent
    // finishes. This shares one script across both loops on purpose — it proves
    // the child really drove the same model plumbing.
    await runTachiLoop({
      model: scriptedModel([
        { tool: 'spawn_agents', input: JSON.stringify({ tasks: [{ prompt: 'read a.txt and report the answer' }] }) },
        { tool: 'read', input: JSON.stringify({ path: 'a.txt' }) },
        { tool: 'write', input: JSON.stringify({ path: 'child-wrote.txt', content: 'nope' }) },
        { tool: 'complete', input: JSON.stringify({ summary: 'a.txt says the answer is 42; verified by reading the file directly.' }) },
        { text: 'the answer is 42' },
      ]),
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'what does a.txt say?',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async () => true,
      maxSteps: 8,
    })

    // The child's trail surfaced with its index prefix.
    const childCalls = events.filter(e => e.type === 'tool-call' && /^\[1\] /.test((e as { name: string }).name))
    expect(childCalls.length).toBeGreaterThan(0)

    // The read-only child was refused the write EVEN THOUGH the parent gate said
    // yes to everything: the child gate is its own, narrower lock.
    expect(existsSync(join(ws, 'child-wrote.txt'))).toBe(false)

    const fanoutDone = events.find(e => e.type === 'tool-done' && (e as { name: string }).name === 'spawn_agents') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(fanoutDone?.output).toMatch(/1 sub-agent\(s\) finished/)
    expect(fanoutDone?.output).toMatch(/the answer is 42/)
  })
})

describe('createIterationCollector — what loop mode decides on', () => {
  it('reads a green completion, the goal sentinel and the transcript', () => {
    const c = createIterationCollector()
    c.observe({ type: 'text', text: 'working…' })
    c.observe({ type: 'tool-call', name: 'complete', input: JSON.stringify({ summary: 'tests pass — LOOP GOAL REACHED' }) })
    c.observe({ type: 'tool-done', name: 'complete', output: 'Task marked complete.' })
    c.observe({ type: 'done', reason: 'stop' })
    const r = c.result()
    expect(r.verify).toBe('green')
    expect(r.goalReached).toBe(true)
    expect(r.doneReason).toBe('stop')
    expect(r.errored).toBe(false)
    expect(r.transcript.length).toBeGreaterThanOrEqual(3)
  })

  it('reads an UNVERIFIED completion as a RED check (the loop keeps going)', () => {
    const c = createIterationCollector()
    c.observe({ type: 'tool-call', name: 'complete', input: JSON.stringify({ summary: 'changed the thing' }) })
    c.observe({ type: 'tool-done', name: 'complete', output: 'Task marked complete — but UNVERIFIED: the derived typecheck check never passed after 2 attempt(s).' })
    expect(c.result().verify).toBe('red')
  })

  it('ignores the sentinel when complete() was REJECTED (no self-declared exit)', () => {
    const c = createIterationCollector()
    c.observe({ type: 'tool-call', name: 'complete', input: JSON.stringify({ summary: 'LOOP GOAL REACHED' }) })
    c.observe({ type: 'tool-done', name: 'complete', output: 'complete rejected: the summary is a placeholder.' })
    const r = c.result()
    expect(r.goalReached).toBe(false)
    expect(r.verify).toBe('unknown')
  })

  it('records an errored iteration', () => {
    const c = createIterationCollector()
    c.observe({ type: 'error', message: 'gateway 503' })
    c.observe({ type: 'done', reason: 'error' })
    expect(c.result()).toMatchObject({ errored: true, doneReason: 'error' })
  })
})
