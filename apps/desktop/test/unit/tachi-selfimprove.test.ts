// apps/desktop/test/unit/tachi-selfimprove.test.ts
//
// LIVE SELF-IMPROVEMENT DRIVER — runs the REAL TACHI loop against a REAL provider
// (Bankr gateway → Opus 4.8 by default) on the REAL repo to make a real,
// verifiable improvement. This is the dogfood + the operational proof the harness
// works on real tasks (not just mock-model unit tests).
//
// It is a DRIVER, not a CI test: skipped unless TACHI_LIVE_KEY is set, runs on a
// real workspace, and makes real LLM calls + real file edits. git is the safety
// net — review `git diff` after, keep or `git restore` .
//
// Run (PowerShell):
//   $env:TACHI_LIVE_KEY   = '<your Bankr gateway key>'   # required (keychain key, paste once)
//   $env:TACHI_LIVE_MODEL = 'claude-opus-4.8'            # optional (default)
//   $env:TACHI_WORKSPACE  = 'D:\projects\TachiDesk'      # optional (default = repo root)
//   $env:TACHI_TASK       = '<the improvement to make>'  # optional (sensible default below)
//   $env:TACHI_MAXSTEPS   = '40'                         # optional
//   npx vitest run test/unit/tachi-selfimprove.test.ts
//
// SAFETY: auto-approves tools (gate → true) for an unattended run, but the bash
// tool keeps its destructive-command deny-list + env-scrub + process-tree-kill,
// and the agent is sandboxed to the workspace. Run on a clean git tree.

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { AgentEvent } from '@tachi/core'
import { runTachiLoop } from '../../electron/services/tachi/loop'
import { singleToolCallFetch } from '../../electron/services/tachi/wire'

const KEY = process.env.TACHI_LIVE_KEY
const BASE = process.env.TACHI_LIVE_BASEURL ?? 'https://llm.bankr.bot/v1'
const MODEL = process.env.TACHI_LIVE_MODEL ?? 'claude-opus-4.8'
// Default workspace = the repo root (two levels up from apps/desktop).
const WORKSPACE = process.env.TACHI_WORKSPACE ?? resolve(process.cwd(), '..', '..')
const MAXSTEPS = Number(process.env.TACHI_MAXSTEPS ?? '40')

const DEFAULT_TASK =
  'Make ONE small, well-scoped, genuinely useful improvement to this repository ' +
  '(a real bug fix, a missing unit test, or a tight refactor — your choice, but keep it small and safe). ' +
  'First register a success check with set_success_check (e.g. the package typecheck or the relevant vitest file) ' +
  'so completion is verified, not just claimed. Read before you edit; make the smallest change that works; ' +
  'do not touch unrelated files. When the success check passes, call complete with exactly what you changed and how you verified it.'
const TASK = process.env.TACHI_TASK ?? DEFAULT_TASK

describe.skipIf(!KEY)('TACHI self-improvement (live, real repo)', () => {
  it('drives Opus 4.8 (Bankr) through a real improvement on this repo', async () => {
    // includeUsage + singleToolCallFetch mirror services/tachi/provider.ts:compat() exactly.
    const provider = createOpenAICompatible(
      { name: 'bankr', baseURL: BASE, apiKey: KEY!, includeUsage: true, fetch: singleToolCallFetch() } as Parameters<typeof createOpenAICompatible>[0],
    )

    const events: AgentEvent[] = []
    let usageIn = 0, usageOut = 0
    console.log(`[selfimprove] model=${MODEL} base=${BASE} workspace=${WORKSPACE} maxSteps=${MAXSTEPS}`)
    console.log(`[selfimprove] task: ${TASK.slice(0, 160)}…`)

    await runTachiLoop({
      model: provider(MODEL),
      modelId: MODEL,
      workspaceRoot: WORKSPACE,
      task: TASK,
      signal: AbortSignal.timeout(20 * 60_000), // 20 min ceiling
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'text' && e.text.trim()) console.log(`[selfimprove] ${e.text.replace(/\n/g, ' ').slice(0, 200)}`)
        if (e.type === 'tool-call') console.log(`[selfimprove] → ${e.name} ${e.input.replace(/\n/g, ' ').slice(0, 160)}`)
        if (e.type === 'tool-done') console.log(`[selfimprove]   ${e.name} ⇒ ${(e.output ?? '').replace(/\n/g, ' ').slice(0, 160)}`)
        if (e.type === 'error') console.log(`[selfimprove] ERROR: ${e.message}`)
      },
      onUsage: (u) => { usageIn += u.inputTokens ?? 0; usageOut += u.outputTokens ?? 0 },
      gate: async () => true, // unattended; bash deny-list + sandbox still apply
      maxSteps: MAXSTEPS,
    })

    const last = events[events.length - 1]
    console.log(`[selfimprove] DONE reason=${last && last.type === 'done' ? last.reason : last?.type} | tokens in=${usageIn} out=${usageOut}`)
    console.log('[selfimprove] review the change with: git -C "' + WORKSPACE + '" status && git -C "' + WORKSPACE + '" diff')
    // The loop never throws; it must reach a terminal 'done'.
    expect(events.some(e => e.type === 'done')).toBe(true)
  }, 21 * 60_000)
})
