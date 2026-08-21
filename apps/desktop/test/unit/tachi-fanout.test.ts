// apps/desktop/test/unit/tachi-fanout.test.ts
//
// MULTI-AGENT FAN-OUT (`spawn_agents`) — the safety properties, driven by a
// MOCKED child runner (no model, no electron, no fs). What must hold:
//
//   * never more than min(3, tasks) children in flight at once;
//   * a parent abort tears the whole subtree down (abort tree);
//   * the spend cap is re-checked BEFORE EACH child, not once per fan-out;
//   * a child can never spawn/delegate (depth cap, second lock);
//   * a read-only child's gate refuses every mutator;
//   * untrusted input is bounded (task count, missing prompts, concurrency);
//   * child trail events reach the parent prefixed with the child index, while
//     the child's TEXT stays private.

import { describe, it, expect } from 'vitest'
import type { AgentEvent } from '@tachi/core'
import {
  runFanout,
  normalizeFanoutInput,
  buildChildGate,
  formatFanoutResults,
  FANOUT_MAX_TASKS,
  FANOUT_MAX_CONCURRENT,
  type FanoutChildRun,
  type FanoutDeps,
} from '../../electron/services/tachi/fanout'

const alwaysAllow = async (): Promise<boolean> => true

function baseDeps(over: Partial<FanoutDeps> = {}): FanoutDeps {
  return {
    workspaceRoot: '/ws',
    signal: new AbortController().signal,
    onEvent: () => {},
    gate: alwaysAllow,
    runChild: async () => {},
    ...over,
  }
}

/** A child that reports `text` and then an accepted complete(). */
function replyingChild(reply: (index: number) => string) {
  return async (run: FanoutChildRun): Promise<void> => {
    run.onEvent({ type: 'tool-call', name: 'complete', input: JSON.stringify({ summary: reply(run.index) }) })
    run.onEvent({ type: 'tool-done', name: 'complete', output: 'Task marked complete.' })
  }
}

describe('normalizeFanoutInput', () => {
  it('rejects an empty or missing task list', () => {
    expect(normalizeFanoutInput({}).ok).toBe(false)
    expect(normalizeFanoutInput({ tasks: [] }).ok).toBe(false)
  })

  it('rejects more than the breadth cap', () => {
    const tasks = Array.from({ length: FANOUT_MAX_TASKS + 1 }, (_, i) => ({ prompt: `t${i}` }))
    const r = normalizeFanoutInput({ tasks })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/at most 8 tasks/i)
  })

  it('rejects a task with no prompt', () => {
    const r = normalizeFanoutInput({ tasks: [{ prompt: 'ok' }, { prompt: '   ' }] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/task 2/i)
  })

  it('defaults tools to readOnly and clamps concurrency to min(3, tasks)', () => {
    const r = normalizeFanoutInput({ tasks: [{ prompt: 'a' }, { prompt: 'b', tools: 'full' }], maxConcurrent: 99 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.tasks[0].tools).toBe('readOnly')
    expect(r.value.tasks[1].tools).toBe('full')
    expect(r.value.maxConcurrent).toBe(2) // min(3, 2 tasks)
  })

  it('never exceeds FANOUT_MAX_CONCURRENT even with many tasks', () => {
    const r = normalizeFanoutInput({ tasks: Array.from({ length: 8 }, (_, i) => ({ prompt: `t${i}` })), maxConcurrent: 8 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.maxConcurrent).toBe(FANOUT_MAX_CONCURRENT)
  })
})

describe('runFanout — concurrency cap', () => {
  it('runs at most min(3, tasks) children at once and returns results in input order', async () => {
    const input = normalizeFanoutInput({ tasks: Array.from({ length: 6 }, (_, i) => ({ prompt: `task ${i + 1}` })) })
    expect(input.ok).toBe(true)
    if (!input.ok) return

    let inFlight = 0
    let peak = 0
    const results = await runFanout(input.value, baseDeps({
      runChild: async (run) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(r => setTimeout(r, 5))
        run.onEvent({ type: 'tool-call', name: 'complete', input: JSON.stringify({ summary: `done ${run.index}` }) })
        run.onEvent({ type: 'tool-done', name: 'complete', output: 'Task marked complete.' })
        inFlight--
      },
    }))

    expect(peak).toBeLessThanOrEqual(FANOUT_MAX_CONCURRENT)
    expect(results).toHaveLength(6)
    expect(results.map(r => r.task)).toEqual(['task 1', 'task 2', 'task 3', 'task 4', 'task 5', 'task 6'])
    expect(results.map(r => r.summary)).toEqual(['done 1', 'done 2', 'done 3', 'done 4', 'done 5', 'done 6'])
    expect(results.every(r => r.status === 'ok')).toBe(true)
  })
})

describe('runFanout — abort tree', () => {
  it('aborting the parent aborts every in-flight child and marks the rest aborted', async () => {
    const input = normalizeFanoutInput({ tasks: Array.from({ length: 5 }, (_, i) => ({ prompt: `t${i + 1}` })) })
    if (!input.ok) throw new Error('setup')

    const parent = new AbortController()
    const seenSignals: AbortSignal[] = []
    const started: number[] = []

    const results = await runFanout(input.value, baseDeps({
      signal: parent.signal,
      runChild: async (run) => {
        seenSignals.push(run.signal)
        started.push(run.index)
        if (started.length === 2) parent.abort() // abort mid-flight
        await new Promise<void>(resolve => {
          if (run.signal.aborted) { resolve(); return }
          run.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      },
    }))

    expect(seenSignals.every(s => s.aborted)).toBe(true)
    expect(results).toHaveLength(5)
    expect(results.every(r => r.status === 'aborted')).toBe(true)
    // Children queued behind the abort never started.
    expect(started.length).toBeLessThanOrEqual(FANOUT_MAX_CONCURRENT)
  })

  it('a parent already aborted starts no children at all', async () => {
    const input = normalizeFanoutInput({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] })
    if (!input.ok) throw new Error('setup')
    const parent = new AbortController()
    parent.abort()
    let started = 0
    const results = await runFanout(input.value, baseDeps({
      signal: parent.signal,
      runChild: async () => { started++ },
    }))
    expect(started).toBe(0)
    expect(results.map(r => r.status)).toEqual(['aborted', 'aborted'])
  })
})

describe('runFanout — spend cap', () => {
  it('checks the cap before EACH child and refuses the ones past it', async () => {
    const input = normalizeFanoutInput({ tasks: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }], maxConcurrent: 1 })
    if (!input.ok) throw new Error('setup')

    let calls = 0
    let ran = 0
    const results = await runFanout(input.value, baseDeps({
      checkSpend: async () => {
        calls++
        return calls <= 1 ? { allowed: true } : { allowed: false, reason: 'Refused: budget cap reached.' }
      },
      runChild: async (run) => { ran++; replyingChild(() => `ok ${run.index}`)(run) },
    }))

    expect(calls).toBe(3)         // once per child, not once per fan-out
    expect(ran).toBe(1)
    expect(results.map(r => r.status)).toEqual(['ok', 'refused', 'refused'])
    expect(results[1].summary).toMatch(/budget cap/i)
  })
})

describe('buildChildGate — depth cap + tool modes', () => {
  it('refuses spawn_agents and delegate in BOTH modes (children cannot recurse)', async () => {
    for (const mode of ['readOnly', 'full'] as const) {
      const gate = buildChildGate({ prompt: 'x', tools: mode }, alwaysAllow)
      expect(await gate('spawn_agents', {})).toMatch(/cannot spawn/i)
      expect(await gate('delegate', {})).toMatch(/cannot spawn/i)
    }
  })

  it('read-only children may read/grep but never write, edit or bash', async () => {
    const gate = buildChildGate({ prompt: 'x', tools: 'readOnly' }, alwaysAllow)
    expect(await gate('read', { path: 'a' })).toBe(true)
    expect(await gate('grep', { pattern: 'a' })).toBe(true)
    expect(await gate('write', { path: 'a', content: 'b' })).toMatch(/READ-ONLY/i)
    expect(await gate('edit', { path: 'a' })).toMatch(/READ-ONLY/i)
    expect(await gate('bash', { command: 'ls' })).toMatch(/READ-ONLY/i)
  })

  it('full children run under the PARENT gate — dangerous tools still prompt/deny', async () => {
    const seen: string[] = []
    const parentGate = async (name: string): Promise<boolean | string> => {
      seen.push(name)
      return name === 'bash' ? 'The user declined that command.' : true
    }
    const gate = buildChildGate({ prompt: 'x', tools: 'full' }, parentGate)
    expect(await gate('write', { path: 'a', content: 'b' })).toBe(true)
    expect(await gate('bash', { command: 'rm -rf /' })).toMatch(/declined/i)
    expect(seen).toEqual(['write', 'bash'])
  })
})

describe('runFanout — child workspaces + trail', () => {
  it('refuses a workingDir the resolver rejects (sandbox escape)', async () => {
    const input = normalizeFanoutInput({ tasks: [{ prompt: 'a', workingDir: '../../etc' }] })
    if (!input.ok) throw new Error('setup')
    let ran = 0
    const results = await runFanout(input.value, baseDeps({
      resolveWorkingDir: () => null,
      runChild: async () => { ran++ },
    }))
    expect(ran).toBe(0)
    expect(results[0].status).toBe('refused')
    expect(results[0].summary).toMatch(/outside this workspace/i)
  })

  it('surfaces child tool events with an index prefix, keeps child text private, and records filesTouched', async () => {
    const input = normalizeFanoutInput({ tasks: [{ prompt: 'a', tools: 'full' }] })
    if (!input.ok) throw new Error('setup')

    const events: AgentEvent[] = []
    const results = await runFanout(input.value, baseDeps({
      onEvent: (e) => events.push(e),
      runChild: async (run) => {
        run.onEvent({ type: 'text', text: 'internal thinking that must not leak' })
        run.onEvent({ type: 'tool-call', name: 'edit', input: JSON.stringify({ path: 'src/a.ts' }) })
        run.onEvent({ type: 'tool-done', name: 'edit', output: 'Edited src/a.ts' })
        run.onEvent({ type: 'reconnect', attempt: 1, maxAttempts: 10, delayMs: 500, reason: 'econnreset' })
        run.onEvent({ type: 'tool-call', name: 'complete', input: JSON.stringify({ summary: 'edited the file' }) })
        run.onEvent({ type: 'tool-done', name: 'complete', output: 'Task marked complete.' })
        run.onEvent({ type: 'done', reason: 'stop' })
      },
    }))

    expect(events.filter(e => e.type === 'text')).toHaveLength(0)  // trajectory stays private
    expect(events.some(e => e.type === 'done')).toBe(false)        // a child's done is not the run's done
    expect(events.some(e => e.type === 'reconnect')).toBe(true)    // but "why is it quiet" IS surfaced
    const names = events.filter(e => e.type === 'tool-call').map(e => (e as { name: string }).name)
    expect(names).toEqual(['[1] edit', '[1] complete'])
    expect(results[0].summary).toBe('edited the file')
    expect(results[0].filesTouched).toEqual(['src/a.ts'])
  })

  it('a child that throws becomes an error result, not a thrown fan-out', async () => {
    const input = normalizeFanoutInput({ tasks: [{ prompt: 'a' }, { prompt: 'b' }] })
    if (!input.ok) throw new Error('setup')
    const results = await runFanout(input.value, baseDeps({
      runChild: async (run) => {
        if (run.index === 1) throw new Error('provider exploded')
        replyingChild(() => 'fine')(run)
      },
    }))
    expect(results[0].status).toBe('error')
    expect(results[0].summary).toMatch(/provider exploded/)
    expect(results[1].status).toBe('ok')
  })
})

describe('formatFanoutResults', () => {
  it('renders a scannable per-agent digest with the status and files', () => {
    const out = formatFanoutResults([
      { task: 'explore auth', status: 'ok', summary: 'auth lives in src/auth' },
      { task: 'patch imports', status: 'error', summary: 'blew up', filesTouched: ['src/x.ts'] },
    ])
    expect(out).toMatch(/2 sub-agent\(s\) finished: 1 ok, 1 not ok/)
    expect(out).toMatch(/── agent 1 \[OK\] ──/)
    expect(out).toMatch(/── agent 2 \[ERROR\] ──/)
    expect(out).toMatch(/files: src\/x\.ts/)
  })
})
