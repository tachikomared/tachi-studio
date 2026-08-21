// apps/desktop/test/unit/turnResetExecution.test.ts
//
// The RESET EXECUTION path with a MOCKED restore IPC. AgentPage cannot be
// driven in this repo's test setup (node env, no DOM harness), which is exactly
// why `runTurnReset` exists as an injectable function: the two behaviours that
// actually protect the operator are asserted here rather than assumed.
//
//   1. HONEST FAILURE — a `{ ok:false, error }` result AND a thrown/rejected
//      IPC both reach `onFailure` with a real message. Neither is swallowed and
//      neither is reported as success.
//   2. NO SILENT HALF-RESET — on RESET BOTH a failed code restore leaves the
//      transcript untouched, so the operator still has the record of what
//      produced the files sitting on disk.

import { describe, it, expect, vi } from 'vitest'
import { runTurnReset, NO_CHECKPOINT } from '../../src/pages/agent/turnReset'

/** Deps with spies; `restore` is the mocked `checkpoints.restoreWorkspace`. */
function deps(restore: (root: string, id: string) => Promise<{ ok: boolean; error?: string; safetyId?: string }>) {
  return {
    restore:   vi.fn(restore),
    sliceChat: vi.fn(),
    onSuccess: vi.fn(),
    onFailure: vi.fn(),
  }
}

const TARGET = { cpId: 'cp-1', root: 'D:/ws' }

describe('runTurnReset — chat only', () => {
  it('slices the transcript and never touches the workspace', async () => {
    const d = deps(async () => ({ ok: true }))
    const r = await runTurnReset('chat', TARGET, d)
    expect(d.restore).not.toHaveBeenCalled()
    expect(d.sliceChat).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ codeRestored: null, chatSliced: true })
  })
})

describe('runTurnReset — code only', () => {
  it('restores and keeps the transcript', async () => {
    const d = deps(async () => ({ ok: true, safetyId: 'safety-1' }))
    const r = await runTurnReset('code', TARGET, d)
    expect(d.restore).toHaveBeenCalledWith('D:/ws', 'cp-1')
    expect(d.sliceChat).not.toHaveBeenCalled()
    expect(d.onSuccess).toHaveBeenCalledWith({ choice: 'code', safetyId: 'safety-1' })
    expect(r.codeRestored).toBe(true)
    // The safety net is handed back so the caller can offer UNDO THIS RESET.
    expect(r.safetyId).toBe('safety-1')
  })

  it('surfaces an { ok:false } failure with the real error string', async () => {
    const d = deps(async () => ({ ok: false, error: 'restore failed: not a git repository' }))
    const r = await runTurnReset('code', TARGET, d)
    expect(d.onSuccess).not.toHaveBeenCalled()
    expect(d.onFailure).toHaveBeenCalledWith('restore failed: not a git repository')
    expect(r.codeRestored).toBe(false)
    expect(r.error).toBe('restore failed: not a git repository')
  })

  it('surfaces a REJECTED ipc call instead of hanging or claiming success', async () => {
    const d = deps(async () => { throw new Error('EPIPE: main process gone') })
    const r = await runTurnReset('code', TARGET, d)
    expect(d.onFailure).toHaveBeenCalledWith('EPIPE: main process gone')
    expect(d.onSuccess).not.toHaveBeenCalled()
    expect(r.codeRestored).toBe(false)
  })

  it('never claims success when the result has no error string either', async () => {
    const d = deps(async () => ({ ok: false }))
    const r = await runTurnReset('code', TARGET, d)
    expect(d.onFailure).toHaveBeenCalledWith('restore failed')
    expect(r.error).toBe('restore failed')
  })
})

describe('runTurnReset — both (the ordering rule)', () => {
  it('restores FIRST, then slices, when the restore succeeds', async () => {
    const order: string[] = []
    const d = {
      restore:   vi.fn(async () => { order.push('restore'); return { ok: true, safetyId: 's' } }),
      sliceChat: vi.fn(() => { order.push('slice') }),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
    }
    const r = await runTurnReset('both', TARGET, d)
    expect(order).toEqual(['restore', 'slice'])
    expect(r).toMatchObject({ codeRestored: true, chatSliced: true })
  })

  it('does NOT truncate the transcript when the restore fails', async () => {
    const d = deps(async () => ({ ok: false, error: 'backup manifest missing or unreadable' }))
    const r = await runTurnReset('both', TARGET, d)
    expect(d.sliceChat).not.toHaveBeenCalled()
    expect(d.onFailure).toHaveBeenCalledWith('backup manifest missing or unreadable')
    expect(r).toMatchObject({ codeRestored: false, chatSliced: false })
  })

  it('does NOT truncate the transcript when the ipc throws', async () => {
    const d = deps(async () => { throw new Error('boom') })
    await runTurnReset('both', TARGET, d)
    expect(d.sliceChat).not.toHaveBeenCalled()
  })
})

describe('runTurnReset — missing checkpoint', () => {
  it('refuses, reports, and changes nothing', async () => {
    for (const target of [{ cpId: null, root: 'D:/ws' }, { cpId: 'cp-1', root: null }]) {
      const d = deps(async () => ({ ok: true }))
      const r = await runTurnReset('both', target, d)
      expect(d.restore).not.toHaveBeenCalled()
      expect(d.sliceChat).not.toHaveBeenCalled()
      expect(d.onFailure).toHaveBeenCalledWith(NO_CHECKPOINT)
      expect(r).toEqual({ codeRestored: false, chatSliced: false, error: NO_CHECKPOINT })
    }
  })
})
