// apps/desktop/test/unit/tachiReasoningWire.test.ts
//
// THE EMPTY VENICE RUN (live, 2026-08-02).
//
// Reported: CODE tab, TACHI, Venice, `olafangensan-glm-4.7-flash-heretic` —
// no assistant text, no tool calls, then AUTO-CONTINUE and ENDED WITHOUT
// COMPLETING. The same model answered perfectly in the CHAT tab. That split is
// the whole diagnosis: a reasoning model streams its thinking in the SEPARATE
// OpenAI-compatible `reasoning_content` field. Chat reads that field
// (packages/core/src/chat/reasoning-stream.ts) and renders it as <think>. The
// harness read only `text-delta`, so the model's entire output fell on the
// stream switch's `default:` and the run was classified as a silent give-up.
//
// These tests run against a LOOPBACK SSE server through the REAL
// @ai-sdk/openai-compatible provider — the exact production path, no API key,
// no external call. That matters: the repo's MockLanguageModelV3/V4 fixtures
// silently drop `finishReason` and usage, so a mock CANNOT express the
// truncation half of this bug. Do not "simplify" these back onto a mock.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'

/** A gateway that answers every request with reasoning ONLY — no content, no
 *  tool calls — and the given finish_reason. This is the Venice shape. */
function reasoningOnlyServer(finishReason: 'stop' | 'length', thought: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm' }
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`)
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: thought } }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise(resolve => {
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port
      resolve({ server, url: `http://127.0.0.1:${port}/v1` })
    })
  })
}

describe('the wire: reasoning_content is not assistant text', () => {
  it('maps reasoning_content to reasoning-delta, leaves text empty, keeps finish_reason', async () => {
    const { server, url } = await reasoningOnlyServer('length', 'thinking hard')
    const model = createOpenAICompatible({ name: 't', baseURL: url, apiKey: 'x' })('m')
    let reasoning = '', text = '', finish = 'UNSET'
    for await (const part of streamText({ model, prompt: 'hi' }).fullStream) {
      if (part.type === 'reasoning-delta') reasoning += part.text
      if (part.type === 'text-delta') text += part.text
      if (part.type === 'finish-step' || part.type === 'finish') {
        finish = String((part as { finishReason?: string }).finishReason)
      }
    }
    server.close()

    // The model DID talk — just not in the channel the harness was reading.
    expect(reasoning).toBe('thinking hard')
    expect(text).toBe('')
    // And the provider's own verdict survives: we truncated it, it did not quit.
    expect(finish).toBe('length')
  })
})

describe('runTachiLoop against a reasoning-only gateway', () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-reasoning-')) })
  afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  async function runAgainst(finishReason: 'stop' | 'length', thought: string) {
    const { server, url } = await reasoningOnlyServer(finishReason, thought)
    const events: AgentEvent[] = []
    try {
      await runTachiLoop({
        model: createOpenAICompatible({ name: 'venice', baseURL: url, apiKey: 'x' })('m'),
        modelId: 'olafangensan-glm-4.7-flash-heretic',
        workspaceRoot: ws,
        task: 'fix the failing gate test',
        signal: new AbortController().signal,
        onEvent: e => events.push(e),
        gate: async () => true,
        maxSteps: 4,
      })
    } finally { server.close() }
    const done = events.find(e => e.type === 'done') as Extract<AgentEvent, { type: 'done' }>
    return { events, done }
  }

  it('reports REASONING, not a silent give-up', async () => {
    const { events, done } = await runAgainst('stop', 'z'.repeat(300))

    expect(done.incomplete).toBe(true)
    expect(done.incompleteCode).toBe('empty-text')   // the outcome is unchanged
    // …but the SENTENCE now names what actually happened.
    expect(done.incompleteDetail).toMatch(/reasoning/i)
    expect(done.incompleteDetail).toContain('300')

    // Reasoning must never be rendered as assistant text: that would make the
    // model look like it answered and would blind silent-finish detection.
    const spoken = events.filter(e => e.type === 'text' && !/AUTO-CONTINUE/.test((e as { text: string }).text))
    expect(spoken).toHaveLength(0)
  })

  it('blames the OUTPUT LIMIT when the provider says length', async () => {
    const { done } = await runAgainst('length', 'z'.repeat(300))
    expect(done.incompleteDetail).toMatch(/output budget/i)
    // The old sentence accused the model of quitting. It must not come back.
    expect(done.incompleteDetail).not.toMatch(/without any assistant text/i)
  })
})
