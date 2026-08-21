// apps/desktop/test/unit/permissionLifetime.test.ts
//
// PERMISSION LIFETIME — main-process half. Live /loop bug, 2026-07-25:
//
// A card for the DERIVED verify check (`pnpm run typecheck`) was on screen when
// the operator navigated CODE → NODES → CODE. AgentPage unmounted, the queue was
// component state, so the card was gone forever while main kept awaiting its
// resolver. The run sat WORKING with no visible events; STOP LOOP could not end
// it because the cycle it was waiting on could never finish.
//
// Three guarantees are pinned here:
//
//  1. the verify-gate path (createVerifyCheck → gate → registry) is registry-
//     BACKED: an unanswered prompt denies at PERMISSION_PROMPT_TIMEOUT_MS with
//     the model-facing "re-issue it" wording, and the command never runs;
//  2. the registry can hand the outstanding card back (listPending) so a
//     re-mounted renderer repopulates its queue instead of losing the prompt;
//  3. STOP LOOP releases the loop's open prompts (requestLoopStop →
//     cancelPrompts → cancelScope), so a graceful stop cannot be blocked by an
//     unanswerable card — proven WITHOUT any timer, i.e. it is the stop that
//     releases it, not the 10-minute deadline.
//
// Pure: no electron, no network, no DOM.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  PendingPermissionRegistry,
  toolMessageForOutcome,
  PERMISSION_PROMPT_TIMEOUT_MS,
  PERMISSION_TIMEOUT_TOOL_MESSAGE,
  PERMISSION_CANCELLED_TOOL_MESSAGE,
} from '../../electron/services/pending-permissions'
import type { PermissionRequest } from '../../electron/services/permission-service'
import { createVerifyCheck } from '../../electron/services/tachi/verify-policy'
import {
  runLoopController,
  requestLoopStop,
  _resetLoopRegistry,
  type LoopIterationOutcome,
} from '../../electron/services/tachi/loop-controller'

afterEach(() => { vi.useRealTimers() })
beforeEach(() => { _resetLoopRegistry() })

const DERIVED = 'pnpm run typecheck'

function cardFor(id: string, command: string): PermissionRequest {
  return {
    id,
    toolName: 'bash',
    toolInput: { command },
    reason: `Bash execution: \`${command}\``,
    recommendedDecision: 'allow',
  }
}

/**
 * The gate agent.ipc installs, reduced to the branch that matters: push a card,
 * block on the registry, and translate a NON-user denial into its own reason
 * string (which the loop hands to the model verbatim).
 */
function registryGate(reg: PendingPermissionRegistry, scope: string, raised: string[]) {
  let n = 0
  return async (name: string, args: Record<string, unknown>): Promise<boolean | string> => {
    const id = `req-${++n}`
    raised.push(id)
    const outcome = await reg.awaitDecision({
      id,
      scope,
      request: cardFor(id, String(args.command ?? '')),
    })
    if (outcome.decision === 'deny') {
      return outcome.reason === 'user' ? false : toolMessageForOutcome(outcome, name)
    }
    return true
  }
}

describe('verify-gate prompt — timeout deny', () => {
  it('denies the derived check at the timeout and never runs the command', async () => {
    vi.useFakeTimers()
    const reg = new PendingPermissionRegistry()
    const ran: string[] = []
    const verify = createVerifyCheck({
      gate: registryGate(reg, 'default', []),
      exec: async (command) => { ran.push(command); return { isError: false, output: 'ok' } },
    })

    const pending = verify(DERIVED)
    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS - 1)
    expect(reg.size).toBe(1)                       // still waiting just before the deadline

    await vi.advanceTimersByTimeAsync(2)
    const result = await pending

    expect(result.ran).toBe(false)                 // the check could not execute
    expect(result.ok).toBe(false)
    expect(result.output).toBe(PERMISSION_TIMEOUT_TOOL_MESSAGE)
    expect(result.output).not.toMatch(/declined/i) // a timeout is not a user "no"
    expect(ran).toEqual([])                        // the command never ran
    expect(reg.size).toBe(0)                       // and nothing leaked
  })

  it('exposes the pending card for a re-mounted renderer, then drops it on timeout', async () => {
    vi.useFakeTimers()
    const reg = new PendingPermissionRegistry()
    const verify = createVerifyCheck({
      gate: registryGate(reg, 'task-1', []),
      exec: async () => ({ isError: false, output: 'ok' }),
    })

    const pending = verify(DERIVED)
    await vi.advanceTimersByTimeAsync(1)
    // This is what agent:permission-pending returns — the card the unmounted
    // page lost. Without it a remount had no way to learn the prompt exists.
    const resync = reg.listPending()
    expect(resync).toHaveLength(1)
    expect(resync[0].toolName).toBe('bash')
    expect((resync[0].toolInput as { command: string }).command).toBe(DERIVED)
    expect(reg.listPending('task-1')).toHaveLength(1)
    expect(reg.listPending('other-task')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS + 1)
    await pending
    expect(reg.listPending()).toEqual([])          // settled → nothing to re-sync
  })

  it('runs the command when the prompt is answered in time', async () => {
    vi.useFakeTimers()
    const reg = new PendingPermissionRegistry()
    const ran: string[] = []
    const raised: string[] = []
    const verify = createVerifyCheck({
      gate: registryGate(reg, 'default', raised),
      exec: async (command) => { ran.push(command); return { isError: false, output: 'typecheck clean' } },
    })

    const pending = verify(DERIVED)
    await vi.advanceTimersByTimeAsync(1)
    expect(reg.deliver(raised[0], 'allow')).toBe(true)

    await expect(pending).resolves.toEqual({ ok: true, ran: true, output: 'typecheck clean' })
    expect(ran).toEqual([DERIVED])
  })

  it('a stopped run releases the check immediately with its own reason', async () => {
    const reg = new PendingPermissionRegistry()
    const ran: string[] = []
    const verify = createVerifyCheck({
      gate: registryGate(reg, 'task-1', []),
      exec: async (command) => { ran.push(command); return { isError: false, output: 'ok' } },
    })

    const pending = verify(DERIVED)
    await vi.waitFor(() => expect(reg.size).toBe(1))
    expect(reg.cancelScope('task-1')).toHaveLength(1)

    const result = await pending
    expect(result).toEqual({ ok: false, ran: false, output: PERMISSION_CANCELLED_TOOL_MESSAGE })
    expect(ran).toEqual([])
  })

  it('a real user "no" still reads as a user denial, not a timeout', async () => {
    const reg = new PendingPermissionRegistry()
    const raised: string[] = []
    const verify = createVerifyCheck({
      gate: registryGate(reg, 'default', raised),
      exec: async () => ({ isError: false, output: 'ok' }),
    })

    const pending = verify(DERIVED)
    await vi.waitFor(() => expect(reg.size).toBe(1))
    reg.deliver(raised[0], 'deny')

    const result = await pending
    expect(result.ran).toBe(false)
    expect(result.output).toMatch(/not permitted/i)   // gate returned bare `false`
    expect(result.output).not.toBe(PERMISSION_TIMEOUT_TOOL_MESSAGE)
  })
})

describe('STOP LOOP releases the loop’s open permission prompts', () => {
  /** An iteration that blocks on a permission prompt with NO timeout armed. */
  function blockingIteration(reg: PendingPermissionRegistry, scope: string, seen: string[]) {
    return async ({ iteration }: { iteration: number; task: string }): Promise<LoopIterationOutcome> => {
      const outcome = await reg.awaitDecision({
        id: `p-${iteration}`,
        scope,
        timeoutMs: 0,                                // no timer: only a stop can free it
        request: cardFor(`p-${iteration}`, DERIVED),
      })
      seen.push(outcome.reason)
      return { outcome: 'done', transcript: [], goalReached: false, verify: 'unknown', durationMs: 1 }
    }
  }

  it('unblocks the cycle so the graceful stop can actually land', async () => {
    const reg = new PendingPermissionRegistry()
    const key = 'session-1'
    const seen: string[] = []

    const run = runLoopController({
      config: { goal: 'make typecheck pass', cap: 5 },
      key,
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      runIteration: blockingIteration(reg, key, seen),
      cancelPrompts: () => { reg.cancelScope(key) },
    })

    await vi.waitFor(() => expect(reg.size).toBe(1))   // cycle 1 parked on the card
    expect(requestLoopStop(key)).toBe(true)

    const summary = await run
    expect(seen).toEqual(['cancelled'])                // the card was released, not answered
    expect(reg.size).toBe(0)
    expect(summary.code).toBe('user-stop')
    expect(summary.iterations).toBe(1)                 // it stopped after the cycle it freed
  })

  it('without the hook the stop is inert — the cycle stays parked (the shipped bug)', async () => {
    const reg = new PendingPermissionRegistry()
    const key = 'session-2'
    const seen: string[] = []

    const run = runLoopController({
      config: { goal: 'g', cap: 5 },
      key,
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      runIteration: blockingIteration(reg, key, seen),
      // no cancelPrompts — the pre-fix wiring
    })

    await vi.waitFor(() => expect(reg.size).toBe(1))
    expect(requestLoopStop(key)).toBe(true)
    await new Promise(r => setTimeout(r, 5))
    expect(reg.size).toBe(1)                           // still blocked: STOP LOOP did nothing
    expect(seen).toEqual([])

    reg.deliver('p-1', 'allow')                        // let the test finish
    await run
  })

  it('a throwing cancelPrompts hook cannot swallow the stop request', async () => {
    const reg = new PendingPermissionRegistry()
    const key = 'session-3'
    const seen: string[] = []

    const run = runLoopController({
      config: { goal: 'g', cap: 3 },
      key,
      workspaceRoot: '/ws',
      signal: new AbortController().signal,
      onEvent: () => {},
      runIteration: blockingIteration(reg, key, seen),
      cancelPrompts: () => { throw new Error('window gone') },
    })

    await vi.waitFor(() => expect(reg.size).toBe(1))
    expect(requestLoopStop(key)).toBe(true)            // still reports "stop requested"
    reg.deliver('p-1', 'allow')
    const summary = await run
    expect(summary.code).toBe('user-stop')
  })
})
