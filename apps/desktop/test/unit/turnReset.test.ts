// apps/desktop/test/unit/turnReset.test.ts
//
// PER-TURN FILE CHECKPOINTS — the pure decision layer (plan A2).
//
// `src/pages/agent/turnReset.ts` is deliberately framework-free so the rules
// that matter can be asserted without a DOM: which of the three RESET rows are
// live (and the HONEST reason when one is not), the binding of a snapshot to
// the user turn that caused it, and the ordering rule that keeps RESET BOTH
// safe — a failed code restore must NOT truncate the transcript.

import { describe, it, expect } from 'vitest'
import {
  resetAvailability,
  shouldSliceChat,
  shouldRestoreCode,
  stampTurnCheckpoint,
  pruneTurnCheckpoints,
  CHECKPOINTING_HARNESSES,
  type TurnCheckpoint,
} from '../../src/pages/agent/turnReset'

const cp = (over: Partial<TurnCheckpoint> = {}): TurnCheckpoint => ({
  messageId: 'm1', cpId: 'cp-1', root: 'D:/ws', createdAt: 1, ...over,
})

const ctx = (over: Partial<Parameters<typeof resetAvailability>[0]> = {}) => ({
  status: 'done',
  viewingArchiveId: null,
  harness: 'tachi',
  messageId: 'm1',
  turnCheckpoints: [cp()],
  liveCheckpointIds: null,
  ...over,
})

describe('resetAvailability', () => {
  it('offers all three rows for a finished tachi turn with a snapshot', () => {
    const a = resetAvailability(ctx())
    expect(a.canResetChat).toBe(true)
    expect(a.canResetCode).toBe(true)
    expect(a.cpId).toBe('cp-1')
    expect(a.root).toBe('D:/ws')
    expect(a.codeBlocker).toBeNull()
  })

  it('blocks both while a run is in flight', () => {
    for (const status of ['running', 'starting']) {
      const a = resetAvailability(ctx({ status }))
      expect(a.canResetChat).toBe(false)
      expect(a.canResetCode).toBe(false)
      expect(a.chatBlocker).toBe('running')
      expect(a.codeBlocker).toBe('running')
      // Never hand out a checkpoint id the UI must not act on.
      expect(a.cpId).toBeNull()
    }
  })

  it('blocks both while viewing an archived session', () => {
    const a = resetAvailability(ctx({ viewingArchiveId: 'arch-1' }))
    expect(a.chatBlocker).toBe('archive')
    expect(a.codeBlocker).toBe('archive')
  })

  it('says WHY a non-checkpointing harness has no code row', () => {
    const a = resetAvailability(ctx({ harness: 'codex', turnCheckpoints: [] }))
    expect(a.canResetChat).toBe(true)      // chat rewind still works
    expect(a.canResetCode).toBe(false)
    expect(a.codeBlocker).toBe('harness')
    expect(CHECKPOINTING_HARNESSES).toEqual(['tachi'])
  })

  it('reports not-taken (with main\'s reason) when the snapshot could not be made', () => {
    const a = resetAvailability(ctx({
      turnCheckpoints: [cp({ cpId: null, unavailable: 'no-git-backup' })],
    }))
    expect(a.canResetCode).toBe(false)
    expect(a.codeBlocker).toBe('not-taken')
    expect(a.codeDetail).toBe('no-git-backup')
    expect(a.cpId).toBeNull()
  })

  it('reports not-taken when this turn has no binding at all', () => {
    const a = resetAvailability(ctx({ turnCheckpoints: [cp({ messageId: 'other' })] }))
    expect(a.codeBlocker).toBe('not-taken')
  })

  it('reports aged-out only once the live index PROVES the snapshot is gone', () => {
    // Not loaded yet → we do not claim aged-out without evidence.
    expect(resetAvailability(ctx({ liveCheckpointIds: null })).canResetCode).toBe(true)
    // Loaded and present → still live.
    expect(resetAvailability(ctx({ liveCheckpointIds: ['cp-1', 'cp-0'] })).canResetCode).toBe(true)
    // Loaded and absent → aged out of the 50-entry per-root index.
    const gone = resetAvailability(ctx({ liveCheckpointIds: ['cp-9'] }))
    expect(gone.canResetCode).toBe(false)
    expect(gone.codeBlocker).toBe('aged-out')
  })

  it('trusts a real checkpoint over the currently-selected harness', () => {
    // The harness picker may have moved since the turn ran; a checkpoint id is
    // ground truth, so the row stays live.
    const a = resetAvailability(ctx({ harness: 'openclaude' }))
    expect(a.canResetCode).toBe(true)
    expect(a.cpId).toBe('cp-1')
  })
})

describe('shouldSliceChat — the RESET BOTH ordering rule', () => {
  it('chat-only always slices', () => {
    expect(shouldSliceChat('chat', null)).toBe(true)
    expect(shouldSliceChat('chat', false)).toBe(true)
  })

  it('code-only never slices the transcript', () => {
    expect(shouldSliceChat('code', true)).toBe(false)
    expect(shouldSliceChat('code', false)).toBe(false)
  })

  it('BOTH slices only after the code restore SUCCEEDED', () => {
    expect(shouldSliceChat('both', true)).toBe(true)
    // The safety property: a failed restore leaves the transcript intact, so
    // the operator still has the record of what produced the files on disk.
    expect(shouldSliceChat('both', false)).toBe(false)
    expect(shouldSliceChat('both', null)).toBe(false)
  })

  it('shouldRestoreCode covers exactly the file-touching choices', () => {
    expect(shouldRestoreCode('chat')).toBe(false)
    expect(shouldRestoreCode('code')).toBe(true)
    expect(shouldRestoreCode('both')).toBe(true)
  })
})

describe('stampTurnCheckpoint', () => {
  const msgs = (...types: string[]) => types.map((type, i) => ({ id: `m${i}`, event: { type } }))

  it('binds to the LAST user turn (the one the snapshot precedes)', () => {
    const list = stampTurnCheckpoint(
      msgs('user-text', 'text', 'tool-call', 'user-text'),
      [],
      { id: 'cp-a', root: 'D:/ws', label: 'before: fix it', at: 5 },
    )
    expect(list).not.toBeNull()
    expect(list![0]).toEqual({
      messageId: 'm3', cpId: 'cp-a', root: 'D:/ws', label: 'before: fix it', createdAt: 5,
    })
  })

  it('records an UNPROTECTED turn rather than dropping it', () => {
    const list = stampTurnCheckpoint(msgs('user-text'), [], {
      id: null, root: 'D:/ws', unavailable: 'no-git-backup', at: 1,
    })
    expect(list![0].cpId).toBeNull()
    expect(list![0].unavailable).toBe('no-git-backup')
  })

  it('no-ops when there is no user turn to bind to', () => {
    expect(stampTurnCheckpoint(msgs('text', 'tool-call'), [], { id: 'cp-a', root: 'D:/ws' })).toBeNull()
    expect(stampTurnCheckpoint([], [], { id: 'cp-a', root: 'D:/ws' })).toBeNull()
  })

  it('replaces the binding when the same turn is re-run', () => {
    const first = stampTurnCheckpoint(msgs('user-text'), [], { id: 'cp-a', root: 'D:/ws', at: 1 })!
    const again = stampTurnCheckpoint(msgs('user-text'), first, { id: 'cp-b', root: 'D:/ws', at: 2 })!
    expect(again).toHaveLength(1)
    expect(again[0].cpId).toBe('cp-b')
  })

  it('keeps newest first and caps the list', () => {
    let list: TurnCheckpoint[] = []
    for (let i = 0; i < 5; i++) {
      list = stampTurnCheckpoint([{ id: `m${i}`, event: { type: 'user-text' } }], list, { id: `cp-${i}`, root: 'D:/ws', at: i }, 3)!
    }
    expect(list.map(c => c.cpId)).toEqual(['cp-4', 'cp-3', 'cp-2'])
  })
})

describe('pruneTurnCheckpoints', () => {
  it('drops bindings whose turn is no longer in the transcript', () => {
    const list = [cp({ messageId: 'm1' }), cp({ messageId: 'm2' }), cp({ messageId: 'm3' })]
    expect(pruneTurnCheckpoints(list, new Set(['m1', 'm3'])).map(c => c.messageId)).toEqual(['m1', 'm3'])
  })
})
