// Tests for the stream idle watchdog (electron/services/stream-idle.ts).
// Used by every chat-service streaming branch: each reader.read() is raced
// against an idle timer so a half-dead socket can't hang a conversation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readOrIdleAbort, STREAM_IDLE_TIMEOUT_MS } from '../../electron/services/stream-idle'

describe('readOrIdleAbort', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('passes through a read that resolves before the idle timeout', async () => {
    const abort = new AbortController()
    const p = readOrIdleAbort(() => Promise.resolve({ done: false, value: 'chunk' }), abort, 1_000)
    await expect(p).resolves.toEqual({ done: false, value: 'chunk' })
    expect(abort.signal.aborted).toBe(false)
    // Timer must be cleared — advancing past the deadline changes nothing.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(abort.signal.aborted).toBe(false)
  })

  it('rejects with a stall message and aborts when no data arrives', async () => {
    const abort = new AbortController()
    const never = new Promise<never>(() => { /* hangs like a dead socket */ })
    const p = readOrIdleAbort(() => never, abort, 1_000)
    const assertion = expect(p).rejects.toThrow(/Stream stalled/)
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
    expect(abort.signal.aborted).toBe(true)
  })

  it('propagates a read rejection unchanged (no idle interference)', async () => {
    const abort = new AbortController()
    const p = readOrIdleAbort(() => Promise.reject(new Error('ECONNRESET')), abort, 1_000)
    await expect(p).rejects.toThrow('ECONNRESET')
    expect(abort.signal.aborted).toBe(false)
  })

  it('does not produce an unhandled rejection when the read settles after the stall', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const abort = new AbortController()
      let rejectRead: (e: Error) => void = () => {}
      const lateRead = new Promise<never>((_, rej) => { rejectRead = rej })
      const p = readOrIdleAbort(() => lateRead, abort, 1_000)
      const assertion = expect(p).rejects.toThrow(/Stream stalled/)
      await vi.advanceTimersByTimeAsync(1_000)
      await assertion
      // The aborted fetch makes the original read reject AFTER the race lost.
      rejectRead(new Error('aborted'))
      // Let microtasks + any unhandledRejection notification drain.
      // process.nextTick is NOT faked by vi.useFakeTimers (setImmediate IS —
      // awaiting it here would hang the test).
      await vi.advanceTimersByTimeAsync(10)
      await new Promise<void>((r) => { process.nextTick(r) })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('accepts any aborter with an abort() method (reader.cancel wrapper)', async () => {
    // The streaming clients (freellmapi/freeclaudecode/llama-cpp) only hold an
    // AbortSignal, so they pass { abort: () => reader.cancel() } instead of a
    // controller — pin the widened structural contract.
    const abortFn = vi.fn()
    const p = readOrIdleAbort(() => new Promise<never>(() => {}), { abort: abortFn }, 500)
    const assertion = expect(p).rejects.toThrow(/Stream stalled/)
    await vi.advanceTimersByTimeAsync(500)
    await assertion
    expect(abortFn).toHaveBeenCalledTimes(1)
  })

  it('default timeout is 120s', () => {
    expect(STREAM_IDLE_TIMEOUT_MS).toBe(120_000)
  })
})
