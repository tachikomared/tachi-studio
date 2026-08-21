// apps/desktop/test/unit/pendingPermissions.test.ts
//
// Main-side half of the parallel-permission deadlock fix (live dogfood, 2026-07-25).
//
// The harness emitted two bash tool calls 10 ms apart; each blocked on its own
// `await new Promise(resolve => pendingPermissions.set(id, resolve))`. The
// renderer held ONE card, so request #1's resolver was never called and — with
// no timeout on the await — the run hung in WORKING forever.
//
// These tests pin the guarantees the registry now makes: two concurrent
// requests keep independent resolvers, an unanswered prompt is DENIED after the
// timeout, and aborting a run denies every prompt in that run's scope.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  PendingPermissionRegistry,
  toolMessageForOutcome,
  PERMISSION_PROMPT_TIMEOUT_MS,
  PERMISSION_TIMEOUT_TOOL_MESSAGE,
  PERMISSION_CANCELLED_TOOL_MESSAGE,
} from '../../electron/services/pending-permissions'

afterEach(() => {
  vi.useRealTimers()
})

describe('PendingPermissionRegistry — parallel prompts', () => {
  it('keeps independent resolvers for two requests raised in the same step', async () => {
    const reg = new PendingPermissionRegistry()
    const first = reg.awaitDecision({ id: 'req-1', scope: 'default' })
    const second = reg.awaitDecision({ id: 'req-2', scope: 'default' })
    expect(reg.size).toBe(2)

    // Answering the second must not strand the first (that was the bug).
    expect(reg.deliver('req-2', 'allow')).toBe(true)
    await expect(second).resolves.toEqual({ decision: 'allow', reason: 'user' })
    expect(reg.size).toBe(1)

    expect(reg.deliver('req-1', 'deny')).toBe(true)
    await expect(first).resolves.toEqual({ decision: 'deny', reason: 'user' })
    expect(reg.size).toBe(0)
  })

  it('reports an unknown / already-settled id instead of pretending it landed', async () => {
    const reg = new PendingPermissionRegistry()
    const p = reg.awaitDecision({ id: 'req-1' })
    expect(reg.deliver('req-1', 'allow')).toBe(true)
    expect(reg.deliver('req-1', 'allow')).toBe(false)   // second press: expired
    expect(reg.deliver('nope', 'allow')).toBe(false)
    await p
  })

  it('a duplicate id supersedes the older entry rather than orphaning its resolver', async () => {
    const reg = new PendingPermissionRegistry()
    const first = reg.awaitDecision({ id: 'dup' })
    const second = reg.awaitDecision({ id: 'dup' })
    await expect(first).resolves.toEqual({ decision: 'deny', reason: 'superseded' })
    expect(reg.size).toBe(1)
    reg.deliver('dup', 'allow')
    await expect(second).resolves.toEqual({ decision: 'allow', reason: 'user' })
  })
})

describe('PendingPermissionRegistry — timeout deny', () => {
  it('denies an unanswered prompt after the timeout and fires onTimeout', async () => {
    vi.useFakeTimers()
    const reg = new PendingPermissionRegistry()
    const seen: string[] = []
    const p = reg.awaitDecision({ id: 'req-1', scope: 'task-7', onTimeout: (id) => seen.push(id) })

    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS - 1)
    expect(reg.size).toBe(1)                       // still waiting just before the deadline

    await vi.advanceTimersByTimeAsync(2)
    await expect(p).resolves.toEqual({ decision: 'deny', reason: 'timeout' })
    expect(seen).toEqual(['req-1'])
    expect(reg.size).toBe(0)                       // no leak
  })

  it('does not fire the timeout for a request answered in time', async () => {
    vi.useFakeTimers()
    const reg = new PendingPermissionRegistry()
    const seen: string[] = []
    const p = reg.awaitDecision({ id: 'req-1', onTimeout: (id) => seen.push(id) })
    reg.deliver('req-1', 'allow')
    await expect(p).resolves.toEqual({ decision: 'allow', reason: 'user' })
    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS * 2)
    expect(seen).toEqual([])
  })

  it('an onTimeout observer that throws cannot break the gate', async () => {
    vi.useFakeTimers()
    const reg = new PendingPermissionRegistry()
    const p = reg.awaitDecision({ id: 'req-1', onTimeout: () => { throw new Error('renderer gone') } })
    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS + 1)
    await expect(p).resolves.toEqual({ decision: 'deny', reason: 'timeout' })
  })
})

describe('PendingPermissionRegistry — abort deny', () => {
  it('denies every outstanding prompt in the aborted task scope, leaving other tasks alone', async () => {
    const reg = new PendingPermissionRegistry()
    const a1 = reg.awaitDecision({ id: 'a1', scope: 'task-a' })
    const a2 = reg.awaitDecision({ id: 'a2', scope: 'task-a' })
    const b1 = reg.awaitDecision({ id: 'b1', scope: 'task-b' })

    const cancelled = reg.cancelScope('task-a')
    expect(cancelled.sort()).toEqual(['a1', 'a2'])
    await expect(a1).resolves.toEqual({ decision: 'deny', reason: 'cancelled' })
    await expect(a2).resolves.toEqual({ decision: 'deny', reason: 'cancelled' })

    expect(reg.size).toBe(1)
    expect(reg.has('b1')).toBe(true)
    reg.deliver('b1', 'allow')
    await expect(b1).resolves.toEqual({ decision: 'allow', reason: 'user' })
  })

  it('cancelAll releases everything (app shutdown)', async () => {
    const reg = new PendingPermissionRegistry()
    const p1 = reg.awaitDecision({ id: 'x', scope: 'task-a' })
    const p2 = reg.awaitDecision({ id: 'y', scope: 'task-b' })
    expect(reg.cancelAll().sort()).toEqual(['x', 'y'])
    await expect(p1).resolves.toEqual({ decision: 'deny', reason: 'cancelled' })
    await expect(p2).resolves.toEqual({ decision: 'deny', reason: 'cancelled' })
    expect(reg.size).toBe(0)
  })

  it('cancelling a scope with nothing pending is a no-op', () => {
    const reg = new PendingPermissionRegistry()
    expect(reg.cancelScope('task-a')).toEqual([])
  })

  it('clears the timeout timer when a prompt is cancelled (no late resolve)', async () => {
    vi.useFakeTimers()
    const reg = new PendingPermissionRegistry()
    const seen: string[] = []
    const p = reg.awaitDecision({ id: 'x', scope: 'task-a', onTimeout: (id) => seen.push(id) })
    reg.cancelScope('task-a')
    await expect(p).resolves.toEqual({ decision: 'deny', reason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_TIMEOUT_MS * 2)
    expect(seen).toEqual([])
  })
})

describe('toolMessageForOutcome', () => {
  it('tells the model to re-issue after a timeout (not "the user declined")', () => {
    const msg = toolMessageForOutcome({ decision: 'deny', reason: 'timeout' }, 'bash')
    expect(msg).toBe(PERMISSION_TIMEOUT_TOOL_MESSAGE)
    expect(msg).toMatch(/timed out/i)
    expect(msg).toMatch(/re-issue/i)
    expect(msg).not.toMatch(/declined/i)
  })

  it('says the run was stopped when a prompt is cancelled', () => {
    expect(toolMessageForOutcome({ decision: 'deny', reason: 'cancelled' }, 'bash'))
      .toBe(PERMISSION_CANCELLED_TOOL_MESSAGE)
  })

  it('blames the user only for a real user decision', () => {
    const msg = toolMessageForOutcome({ decision: 'deny', reason: 'user' }, 'write')
    expect(msg).toContain('the user declined "write"')
  })
})
