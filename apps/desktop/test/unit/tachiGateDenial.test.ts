// apps/desktop/test/unit/tachiGateDenial.test.ts
//
// Loop-level proof for the two bugs a live dogfood run exposed (2026-07-25):
//
//  1. A permission gate may now deny with its OWN reason string (the request
//     timed out / the run was stopped) instead of the flat "the user declined".
//     Anything that isn't exactly `true` must still deny — fail-closed.
//  2. A terminal stream error carrying an OBJECT (AI_InvalidToolInputError,
//     emitted when a gateway truncates streamed tool-call arguments mid-JSON)
//     must render as name + message, never as the literal "[object Object]".
//
// Mock model (ai/test), real temp workspace — no network, no electron.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'tachi-gate-')) })
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

const USAGE = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }

/** Step 1 emits a `write` tool call; step 2 finishes. Records every prompt it saw. */
function writeThenFinishModel(prompts: unknown[][]): MockLanguageModelV3 {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async (options: { prompt: unknown }) => {
      call++
      prompts.push(options.prompt as unknown[])
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call', toolCallId: 't1', toolName: 'write',
                input: JSON.stringify({ path: 'out.txt', content: 'hello' }),
              },
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
            { type: 'text-delta', id: 'a', delta: 'ok' },
            { type: 'text-end', id: 'a' },
            { type: 'finish', finishReason: 'stop', usage: USAGE },
          ],
        }),
      }
    },
  })
}

async function run(
  model: MockLanguageModelV3,
  gate: (name: string, args: Record<string, unknown>) => Promise<boolean | string>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  await runTachiLoop({
    model,
    modelId: 'claude-sonnet-4.6',
    workspaceRoot: ws,
    task: 'create out.txt',
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    gate,
  })
  return events
}

/** Flatten every tool-result text the model was fed on its next turn. */
function toolResultTexts(prompts: unknown[][]): string {
  return JSON.stringify(prompts)
}

describe('gate denial with a reason string', () => {
  it('blocks the side effect AND hands the model the gate\'s own reason', async () => {
    const prompts: unknown[][] = []
    const reason = 'Permission request timed out — nobody answered the prompt within 10 minutes, so the call was NOT executed. Re-issue the call if it is still needed.'
    await run(writeThenFinishModel(prompts), async () => reason)

    expect(existsSync(join(ws, 'out.txt'))).toBe(false)     // pre-emptive: no write happened
    const fed = toolResultTexts(prompts)
    expect(fed).toContain('timed out')
    expect(fed).not.toContain('the user declined')          // don't blame the user for a timeout
  })

  it('still denies on plain `false`, with the legacy user-declined wording', async () => {
    const prompts: unknown[][] = []
    await run(writeThenFinishModel(prompts), async () => false)

    expect(existsSync(join(ws, 'out.txt'))).toBe(false)
    expect(toolResultTexts(prompts)).toContain('the user declined')
  })

  it('allows only on an exact `true` (an empty string is a denial, not an allow)', async () => {
    const prompts: unknown[][] = []
    await run(writeThenFinishModel(prompts), async () => '')

    expect(existsSync(join(ws, 'out.txt'))).toBe(false)     // fail-closed
    expect(toolResultTexts(prompts)).toContain('the user declined')
  })

  it('a `true` gate still executes the tool', async () => {
    const prompts: unknown[][] = []
    await run(writeThenFinishModel(prompts), async () => true)
    expect(existsSync(join(ws, 'out.txt'))).toBe(true)
  })
})

describe('terminal stream errors are readable', () => {
  // NOTE: the wording deliberately avoids the transport-blip fragments that the
  // reconnect policy retries on ("unexpected end of …"), so this test isolates
  // the FORMATTING of the terminal error and never touches retry behaviour
  // (which belongs to the reconnect work, not here).
  it('renders an AI_InvalidToolInputError object as name + message, not [object Object]', async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'error',
              error: {
                name: 'AI_InvalidToolInputError',
                message: 'Invalid input for tool bash: invalid_request_error while parsing the streamed arguments',
                toolName: 'bash',
              },
            },
          ],
        }),
      }),
    })
    const events = await run(model, async () => true)
    const err = events.find(e => e.type === 'error') as { type: 'error'; message: string } | undefined
    expect(err).toBeDefined()
    expect(err?.message).not.toContain('[object Object]')
    expect(err?.message).toContain('AI_InvalidToolInputError')
    expect(err?.message).toContain('while parsing the streamed arguments')
    expect(err?.message).toContain('tool bash')
    expect(events.some(e => e.type === 'done')).toBe(true)   // the run still terminates
  })
})
