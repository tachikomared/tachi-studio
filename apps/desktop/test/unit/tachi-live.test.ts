// apps/desktop/test/unit/tachi-live.test.ts
//
// LIVE end-to-end smoke test: runs the real TACHI loop against a REAL provider
// (a running freellmapi router on localhost) doing a real multi-step task in a
// real temp workspace — no mocks. This is the operational proof that the harness
// works as a running system, not just at the unit level.
//
// Skipped unless TACHI_LIVE_KEY is set, so it never runs in normal CI (it needs
// a live endpoint). Run manually:
//   $env:TACHI_LIVE_BASEURL='http://127.0.0.1:31415/v1'
//   $env:TACHI_LIVE_MODEL='deepseek-ai/deepseek-v4-pro'
//   $env:TACHI_LIVE_KEY='<freellmapi key>'
//   npx vitest run test/unit/tachi-live.test.ts

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'
import { singleToolCallFetch } from '../../electron/services/tachi/wire'

const KEY = process.env.TACHI_LIVE_KEY
const BASE = process.env.TACHI_LIVE_BASEURL ?? 'http://127.0.0.1:31415/v1'
const MODEL = process.env.TACHI_LIVE_MODEL ?? 'deepseek-ai/deepseek-v4-pro'

describe.skipIf(!KEY)('TACHI live loop (real provider, real workspace)', () => {
  it('drives a real model through a real multi-step file task', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'tachi-live-'))
    try {
      const provider = createOpenAICompatible({ name: 'freellmapi', baseURL: BASE, apiKey: KEY!, fetch: singleToolCallFetch() })
      const events: AgentEvent[] = []
      const toolCalls: string[] = []

      await runTachiLoop({
        model: provider(MODEL),
        modelId: MODEL,
        workspaceRoot: ws,
        task: 'Create a file named result.txt whose entire contents are exactly the line: TACHI_LIVE_OK . Then read it back to confirm. When done, reply with a one-line summary.',
        signal: AbortSignal.timeout(120_000),
        onEvent: (e) => {
          events.push(e)
          if (e.type === 'tool-call') toolCalls.push(e.name)
          // Live trace to the test console so the run is observable.
          if (e.type === 'tool-call') console.log(`[live] tool-call: ${e.name} ${e.input.slice(0, 120)}`)
          if (e.type === 'tool-done') console.log(`[live] tool-done: ${e.name} -> ${e.output.slice(0, 80).replace(/\n/g, ' ')}`)
          if (e.type === 'error') console.log(`[live] ERROR: ${e.message}`)
        },
        gate: async () => true, // auto-approve for the smoke test
        maxSteps: 12,
      })

      const types = events.map(e => e.type)
      console.log(`[live] event types: ${types.join(',')}`)
      console.log(`[live] tools used: ${toolCalls.join(',')}`)

      // Operational assertions: the model actually drove a tool, and the file
      // was actually created in the workspace by the real loop.
      expect(toolCalls).toContain('write')
      expect(existsSync(join(ws, 'result.txt'))).toBe(true)
      expect(readFileSync(join(ws, 'result.txt'), 'utf8')).toContain('TACHI_LIVE_OK')
      expect(types[types.length - 1]).toBe('done')
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, 130_000)
})
