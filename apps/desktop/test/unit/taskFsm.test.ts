// apps/desktop/test/unit/taskFsm.test.ts
import { describe, it, expect } from 'vitest'
import { TaskFSM, runWithFSM } from '../../electron/services/util/task-fsm'

describe('TaskFSM', () => {
  it('starts queued with attempt 0', () => {
    const f = new TaskFSM('t1')
    expect(f.status).toBe('queued')
    expect(f.attempt).toBe(0)
    expect(f.isTerminal).toBe(false)
  })

  it('walks the legal happy path and increments attempt on running', () => {
    const f = new TaskFSM('t2')
    f.transition('running')
    expect(f.attempt).toBe(1)
    f.transition('processing')
    f.transition('completed')
    expect(f.status).toBe('completed')
    expect(f.isTerminal).toBe(true)
  })

  it('records an error on failure', () => {
    const f = new TaskFSM('t3')
    f.transition('running')
    f.transition('failed', 'network down')
    const snap = f.snapshot()
    expect(snap.status).toBe('failed')
    expect(snap.prevStatus).toBe('running')
    expect(snap.error).toBe('network down')
    expect(typeof snap.enteredAt).toBe('number')
  })

  it('throws on illegal transitions', () => {
    expect(() => new TaskFSM('a').transition('completed')).toThrow(/Illegal/) // queued -> completed
    expect(() => new TaskFSM('b').transition('processing')).toThrow(/Illegal/) // queued -> processing
    const term = new TaskFSM('c')
    term.transition('running'); term.transition('completed')
    expect(() => term.transition('running')).toThrow(/Illegal/) // terminal -> running
  })

  it('cancels from a non-terminal state and is a no-op when terminal', () => {
    const f = new TaskFSM('d')
    f.cancel()
    expect(f.status).toBe('cancelled')
    expect(f.isTerminal).toBe(true)
    // already terminal -> safe no-op (no throw, status unchanged)
    expect(() => f.cancel()).not.toThrow()
    expect(f.status).toBe('cancelled')
  })
})

describe('runWithFSM', () => {
  it('drives running -> completed and returns the result', async () => {
    const seen: string[] = []
    const { result, fsm } = await runWithFSM('ok', async () => 42, s => seen.push(s.status))
    expect(result).toBe(42)
    expect(fsm.status).toBe('completed')
    expect(seen).toEqual(['running', 'completed'])
  })

  it('drives running -> failed and rethrows', async () => {
    const seen: string[] = []
    await expect(
      runWithFSM('bad', async () => { throw new Error('boom') }, s => seen.push(s.status)),
    ).rejects.toThrow('boom')
    expect(seen).toEqual(['running', 'failed'])
  })
})
