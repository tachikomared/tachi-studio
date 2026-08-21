// apps/desktop/test/unit/tachi-loop.test.ts
//
// End-to-end test of the TACHI loop core (runTachiLoop) driven by a MOCK model
// (ai/test MockLanguageModelV3) — no network, no electron, no real LLM. Proves
// the loop glue that a green build can't: streamText fullStream parts map to
// the right AgentEvents, the permission gate runs BEFORE the tool's side
// effect, a real tool actually executes against the workspace, and a denied
// gate prevents the side effect. The model emits a tool call on step 1, the
// loop executes it, then the model emits a final text answer on step 2.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-loop-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }

/** A mock model: step 1 emits a `write` tool call; step 2 emits a final text answer. */
function twoStepWriteModel(toolInput: string): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call++
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 't1', toolName: 'write', input: toolInput },
              { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
            ],
          }),
        }
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: 'Done — created the file.' },
            { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ],
        }),
      }
    },
  })
}

/** A mock model: step 1 calls `consult_panel`; step 2 emits a final text answer. */
function consultThenFinishModel(question: string): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call++
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'c1', toolName: 'consult_panel', input: JSON.stringify({ question }) },
              { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
            ],
          }),
        }
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: 'Decided based on the panel.' },
            { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ],
        }),
      }
    },
  })
}

/** A mock model: step 1 calls `fuse_plan`; step 2 emits a final text answer (the plan). */
function planThenFinishModel(brief: string): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call++
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: 'p1', toolName: 'fuse_plan', input: JSON.stringify({ brief }) },
              { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
            ],
          }),
        }
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'a' },
            { type: 'text-delta', id: 'a', delta: 'Here is the plan.' },
            { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ],
        }),
      }
    },
  })
}

async function collect(model: MockLanguageModelV3, ws: string, gate: () => Promise<boolean>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  await runTachiLoop({
    model,
    modelId: 'claude-sonnet-4.6', // resolves to the 'claude' capability (agentCapable)
    workspaceRoot: ws,
    task: 'create out.txt',
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    gate,
  })
  return events
}

describe('runTachiLoop (mock model, real workspace)', () => {
  it('seeds the conversation with prior history so the agent remembers context across turns', async () => {
    let capturedPrompt: unknown = null
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        capturedPrompt = (options as { prompt?: unknown }).prompt
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 'a' },
              { type: 'text-delta', id: 'a', delta: 'You said 42.' },
              { type: 'text-end', id: 'a' },
              { type: 'finish', finishReason: 'stop', usage: USAGE },
            ],
          }),
        }
      },
    })
    await runTachiLoop({
      model,
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'what number did I mention?',
      history: [
        { role: 'user', content: 'remember the number 42' },
        { role: 'assistant', content: 'Got it, 42.' },
      ],
      signal: new AbortController().signal,
      onEvent: () => {},
      gate: async () => true,
    })
    const serialized = JSON.stringify(capturedPrompt)
    expect(serialized).toContain('remember the number 42') // prior user turn replayed
    expect(serialized).toContain('Got it, 42.')            // prior assistant turn replayed
    expect(serialized).toContain('what number did I mention?') // current task present
  })

  it('executes an approved tool call and streams the right AgentEvents', async () => {
    const model = twoStepWriteModel(JSON.stringify({ path: 'out.txt', content: 'hello tachi' }))
    let gateCalledWith: { name: string; args: Record<string, unknown> } | null = null
    let fileExistedAtGate = false

    const events = await collect(model, ws, async () => {
      // Gate runs BEFORE the side effect: prove the file does NOT exist yet.
      fileExistedAtGate = existsSync(join(ws, 'out.txt'))
      return true
    })

    // The file was actually written by the real tool through the loop.
    expect(existsSync(join(ws, 'out.txt'))).toBe(true)
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('hello tachi')

    // Gate was pre-emptive (file absent at gate time).
    expect(fileExistedAtGate).toBe(false)

    // Event sequence: tool-call → tool-done → text → done.
    const types = events.map(e => e.type)
    expect(types).toContain('tool-call')
    expect(types).toContain('tool-done')
    expect(types).toContain('text')
    expect(types[types.length - 1]).toBe('done')

    const toolCall = events.find(e => e.type === 'tool-call') as Extract<AgentEvent, { type: 'tool-call' }>
    expect(toolCall.name).toBe('write')
    const text = events.filter(e => e.type === 'text').map(e => (e as { text: string }).text).join('')
    expect(text).toContain('Done')
  })

  it('a denied gate prevents the side effect (no file written)', async () => {
    const model = twoStepWriteModel(JSON.stringify({ path: 'blocked.txt', content: 'nope' }))
    let gateCalled = false
    const events = await collect(model, ws, async () => { gateCalled = true; return false })

    expect(gateCalled).toBe(true)
    expect(existsSync(join(ws, 'blocked.txt'))).toBe(false) // denied → never written
    // The model still gets a tool-done (the denial message) and the loop finishes.
    const types = events.map(e => e.type)
    expect(types).toContain('tool-done')
    expect(types[types.length - 1]).toBe('done')
    const toolDone = events.find(e => e.type === 'tool-done') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(toolDone.output.toLowerCase()).toContain('denied')
  })

  it('refuses a model below the agent-capability bar', async () => {
    const model = twoStepWriteModel('{}')
    const events: AgentEvent[] = []
    await runTachiLoop({
      model, modelId: 'gemma-2b', // 8k catalog entry → agentCapable:false
      workspaceRoot: ws, task: 'x', signal: new AbortController().signal,
      onEvent: (e) => events.push(e), gate: async () => true,
    })
    expect(events.some(e => e.type === 'error' && /can't drive/i.test((e as { message: string }).message))).toBe(true)
    expect(events[events.length - 1].type).toBe('done')
  })

  it('exposes consult_panel when a Fusion advisor is injected — brain calls it, gets the synthesis, no permission gate', async () => {
    const model = consultThenFinishModel('Which data structure for the cache?')
    let consultedWith: string | null = null
    let gateCalls = 0
    const events: AgentEvent[] = []
    await runTachiLoop({
      model,
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'pick a cache structure',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async () => { gateCalls++; return true },
      consultPanel: async (q) => { consultedWith = q; return 'PANEL SYNTHESIS: use an LRU map.' },
    })

    // The brain's consult reached the injected advisor with its question.
    expect(consultedWith).toBe('Which data structure for the cache?')
    // Read-only advisor → it must NOT go through the permission gate.
    expect(gateCalls).toBe(0)
    // The synthesized advice came back to the model as the tool result.
    const toolDone = events.find(e => e.type === 'tool-done' && (e as { name: string }).name === 'consult_panel') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(toolDone?.output).toContain('LRU map')
    expect(toolDone?.exitCode).toBe(0)
    expect(events[events.length - 1].type).toBe('done')
  })

  it('does not expose consult_panel without an injected advisor (normal loop unaffected)', async () => {
    // No consultPanel → the tool is simply not registered; a normal write task
    // still runs end to end.
    const model = twoStepWriteModel(JSON.stringify({ path: 'ok.txt', content: 'hi' }))
    const events = await collect(model, ws, async () => true)
    expect(existsSync(join(ws, 'ok.txt'))).toBe(true)
    expect(events[events.length - 1].type).toBe('done')
  })

  it('exposes fuse_plan when a plan advisor is injected — brain hands over a brief, gets the fused plan, no permission gate', async () => {
    const model = planThenFinishModel('Task: split chat-service.ts. Findings: SSE dup 5x, router 3x.')
    let fusedWith: string | null = null
    let gateCalls = 0
    const events: AgentEvent[] = []
    await runTachiLoop({
      model,
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'plan the refactor',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async () => { gateCalls++; return true },
      fusePlan: async (b) => { fusedWith = b; return 'FUSED PLAN:\n1. Extract the SSE helper.\n2. Split the router.' },
    })

    // The brain's brief reached the injected plan advisor.
    expect(fusedWith).toContain('split chat-service.ts')
    // Read-only advisor → it must NOT go through the permission gate.
    expect(gateCalls).toBe(0)
    // The fused plan came back to the model as the tool result.
    const toolDone = events.find(e => e.type === 'tool-done' && (e as { name: string }).name === 'fuse_plan') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(toolDone?.output).toContain('FUSED PLAN')
    expect(toolDone?.exitCode).toBe(0)
    expect(events[events.length - 1].type).toBe('done')
  })

  it('does not expose fuse_plan without an injected plan advisor (normal loop unaffected)', async () => {
    const model = twoStepWriteModel(JSON.stringify({ path: 'np.txt', content: 'x' }))
    const events = await collect(model, ws, async () => true)
    expect(existsSync(join(ws, 'np.txt'))).toBe(true)
    expect(events[events.length - 1].type).toBe('done')
  })

  it('refuses a fuse_plan call with a blank brief and never reaches the advisor', async () => {
    const model = planThenFinishModel('   ') // whitespace-only brief
    let fuseCalls = 0
    const events: AgentEvent[] = []
    await runTachiLoop({
      model,
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'plan the refactor',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async () => true,
      fusePlan: async () => { fuseCalls++; return 'SHOULD NOT RUN' },
    })
    // The empty-brief guard short-circuits before the (expensive) advisor.
    expect(fuseCalls).toBe(0)
    const toolDone = events.find(e => e.type === 'tool-done' && (e as { name: string }).name === 'fuse_plan') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(toolDone?.output).toContain('non-empty brief')
    expect(events[events.length - 1].type).toBe('done')
  })

  it('surfaces a fuse_plan advisor failure as a tool-result string, not a thrown error (loop self-corrects)', async () => {
    const model = planThenFinishModel('Real task: refactor the streaming path.')
    const events: AgentEvent[] = []
    await runTachiLoop({
      model,
      modelId: 'claude-sonnet-4.6',
      workspaceRoot: ws,
      task: 'plan the refactor',
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      gate: async () => true,
      fusePlan: async () => { throw new Error('panel down') },
    })
    // The catch branch turns the failure into a model-visible string; loop finishes.
    const toolDone = events.find(e => e.type === 'tool-done' && (e as { name: string }).name === 'fuse_plan') as Extract<AgentEvent, { type: 'tool-done' }>
    expect(toolDone?.output).toContain('fuse_plan failed')
    expect(toolDone?.output).toContain('panel down')
    expect(events[events.length - 1].type).toBe('done')
  })

  it('applies the ULTRA thinking directive to the system prompt SERVER-SIDE (and NORMAL does not)', async () => {
    // The depth toggle is now applied in runTachiLoop, not the renderer — so the
    // directive must reach the model's SYSTEM prompt from any entry point. The
    // AI SDK threads `system` into the request's prompt as a role:'system'
    // message; we capture the whole request and read its system text.
    const systemTextOf = (opts: { system?: unknown; prompt?: unknown }): string => {
      if (typeof opts.system === 'string') return opts.system
      const sys = (opts.prompt as Array<{ role?: string; content?: unknown }> | undefined)
        ?.find(m => m.role === 'system')
      return typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content ?? '')
    }
    const oneShotTextModel = (): MockLanguageModelV3 => {
      let captured = ''
      const m = new MockLanguageModelV3({
        doStream: async (options: { system?: unknown; prompt?: unknown }) => {
          captured = systemTextOf(options)
          return { stream: simulateReadableStream({ chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'ok' }, { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ] }) }
        },
      })
      ;(m as unknown as { getCaptured: () => string }).getCaptured = () => captured
      return m
    }

    const ultraModel = oneShotTextModel()
    await runTachiLoop({
      model: ultraModel, modelId: 'claude-sonnet-4.6', workspaceRoot: ws, task: 'do a thing',
      signal: new AbortController().signal, onEvent: () => {}, gate: async () => true, depth: 'ultra',
    })
    expect((ultraModel as unknown as { getCaptured: () => string }).getCaptured())
      .toContain('ultrathink — reason as deeply as you can before acting.')

    const normalModel = oneShotTextModel()
    await runTachiLoop({
      model: normalModel, modelId: 'claude-sonnet-4.6', workspaceRoot: ws, task: 'do a thing',
      signal: new AbortController().signal, onEvent: () => {}, gate: async () => true, depth: 'normal',
    })
    expect((normalModel as unknown as { getCaptured: () => string }).getCaptured())
      .not.toContain('ultrathink')
  })

  it('the complete tool rejects a placeholder summary and accepts a substantive one', async () => {
    let call = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++
        if (call === 1) return { stream: simulateReadableStream({ chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'complete', input: JSON.stringify({ summary: 'done' }) },
          { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
        ] }) }
        if (call === 2) return { stream: simulateReadableStream({ chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'complete', input: JSON.stringify({ summary: 'Extracted the SSE loop into chat-stream.ts and ran the desktop suite, all green.' }) },
          { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
        ] }) }
        return { stream: simulateReadableStream({ chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'All set.' }, { type: 'text-end', id: 'a' },
          { type: 'finish', finishReason: 'stop', usage: USAGE },
        ] }) }
      },
    })
    const events = await collect(model, ws, async () => true)
    const completes = events.filter(e => e.type === 'tool-done' && (e as { name: string }).name === 'complete') as Array<Extract<AgentEvent, { type: 'tool-done' }>>
    expect(completes.length).toBe(2)
    expect(completes[0].output).toMatch(/rejected/i)       // placeholder "done" refused
    expect(completes[1].output).toMatch(/marked complete/i) // substantive summary accepted
    expect(events[events.length - 1].type).toBe('done')
  })
})
