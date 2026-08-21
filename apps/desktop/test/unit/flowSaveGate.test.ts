// apps/desktop/test/unit/flowSaveGate.test.ts
//
// LANE J — "a failed save must ABORT the clear".
//
// Near-miss on a live run: FlowsRail's saveCurrent() was
// `try { await saveFlow(...) } catch { /* ignore */ }`, so under Controlled
// Folder Access the "+ New flow" click saved NOTHING and then ran
// clearCanvas() anyway — a ten-node, never-saved canvas vanished (recovered
// only because clear is undoable). These cover the rule that replaced it, plus
// the CFA error classification the toast keys on and the unique-name guard that
// stops a fresh canvas adopting a name that already exists on disk.

import { describe, it, expect } from 'vitest'
import {
  runFlowSave, describeSaveFailure, nextUntitledFlowName, uniqueFlowName, CFA_ERROR_TAG,
} from '../../src/pages/nodes/flow-save'

/** The exact rail sequence: save, and only then do the destructive thing. */
async function newFlowLike(
  hasContent: boolean,
  save: () => Promise<{ ok: boolean; error?: string }>,
): Promise<{ cleared: boolean; error?: string }> {
  const saved = await runFlowSave(hasContent, save)
  if (!saved.ok) return { cleared: false, error: saved.error }
  return { cleared: true }
}

describe('runFlowSave', () => {
  it('reports success when the save lands', async () => {
    expect(await runFlowSave(true, async () => ({ ok: true }))).toEqual({ ok: true, saved: true })
  })

  it('skips (and allows) the save on an empty canvas without calling IPC', async () => {
    let called = false
    const res = await runFlowSave(false, async () => { called = true; return { ok: true } })
    expect(res).toEqual({ ok: true, saved: false })
    expect(called).toBe(false)
  })

  it('reports { ok:false } replies with their reason', async () => {
    const res = await runFlowSave(true, async () => ({ ok: false, error: 'ENOENT: no such file' }))
    expect(res).toEqual({ ok: false, error: 'ENOENT: no such file' })
  })

  it('turns a THROWN save into a failure instead of swallowing it', async () => {
    const res = await runFlowSave(true, async () => { throw new Error('IPC channel closed') })
    expect(res).toEqual({ ok: false, error: 'IPC channel closed' })
  })

  it('treats a missing reply as a failure (fail-closed)', async () => {
    const res = await runFlowSave(true, async () => undefined)
    expect(res.ok).toBe(false)
  })

  it('never leaves an ok:false without a message', async () => {
    const res = await runFlowSave(true, async () => ({ ok: false }))
    expect(res).toEqual({ ok: false, error: 'save failed' })
  })
})

describe('a failed pre-save blocks the destructive step', () => {
  it('does NOT clear the canvas when the save failed (the live near-miss)', async () => {
    const res = await newFlowLike(true, async () => ({ ok: false, error: 'ENOENT: …\\Flows\\x.tachi-flow.json' }))
    expect(res.cleared).toBe(false)
    expect(res.error).toContain('ENOENT')
  })

  it('does NOT clear the canvas when the save threw', async () => {
    expect((await newFlowLike(true, async () => { throw new Error('boom') })).cleared).toBe(false)
  })

  it('clears when the save succeeded', async () => {
    expect(await newFlowLike(true, async () => ({ ok: true }))).toEqual({ cleared: true })
  })

  it('clears an EMPTY canvas — nothing to lose, so the IPC result is irrelevant', async () => {
    expect(await newFlowLike(false, async () => ({ ok: false, error: 'nope' }))).toEqual({ cleared: true })
  })
})

describe('describeSaveFailure', () => {
  it('turns the main-process CFA marker into actionable copy with the fallback root', () => {
    const raw = `${CFA_ERROR_TAG}C:\\Users\\dev\\Tachi Studio|Windows Controlled Folder Access is blocking writes to C:\\Users\\dev\\Documents\\Tachi Studio — allow Tachi Studio in Windows Security`
    expect(describeSaveFailure(raw)).toEqual({ key: 'cfaBlocked', fallback: 'C:\\Users\\dev\\Tachi Studio' })
  })

  it('keeps an ordinary error as its raw text (never hide information)', () => {
    expect(describeSaveFailure('EBUSY: resource busy')).toEqual({ key: 'saveFailed', error: 'EBUSY: resource busy' })
  })

  it('falls back to the message when the marker carries no path', () => {
    expect(describeSaveFailure(`${CFA_ERROR_TAG}|something went wrong`)).toEqual({
      key: 'saveFailed', error: 'something went wrong',
    })
  })

  it('always produces something to show', () => {
    expect(describeSaveFailure('')).toEqual({ key: 'saveFailed', error: 'unknown error' })
    expect(describeSaveFailure(undefined)).toEqual({ key: 'saveFailed', error: 'unknown error' })
  })
})

// ── unique name for a fresh canvas ──────────────────────────────────────────
//
// FlowsRail's newFlow used `Untitled flow ${flows.length + 1}` with no
// uniqueness check and produced a name that ALREADY existed on disk (deleting
// flows makes length+1 collide) — the next Save would have silently overwritten
// someone else's graph. This is the naming rule it now uses, mirroring the
// import/template path.

describe('nextUntitledFlowName', () => {
  it('numbers from the flow count on a clean list', () => {
    expect(nextUntitledFlowName([])).toBe('Untitled flow 1')
    expect(nextUntitledFlowName(['A', 'B'])).toBe('Untitled flow 3')
  })

  it('never reuses a name that already exists (the silent-overwrite path)', () => {
    // Two saved flows, one of them already called "Untitled flow 3" — the old
    // code handed back exactly that name.
    expect(nextUntitledFlowName(['Untitled flow 3', 'Keep me'])).toBe('Untitled flow 4')
  })

  it('skips a whole run of taken numbers', () => {
    const existing = ['Untitled flow 1', 'Untitled flow 2', 'Untitled flow 3', 'Untitled flow 4']
    expect(existing).not.toContain(nextUntitledFlowName(existing))
    expect(nextUntitledFlowName(existing)).toBe('Untitled flow 5')
  })

  it('is stable under repeated creation (each new name is free)', () => {
    const flows: string[] = []
    for (let i = 0; i < 5; i++) {
      const name = nextUntitledFlowName(flows)
      expect(flows).not.toContain(name)
      flows.push(name)
    }
    expect(new Set(flows).size).toBe(5)
  })

  it('falls back to the " (n)" suffix when every number is somehow taken', () => {
    // uniqueFlowName is the same guard import/templates use — assert it directly
    // so the shared helper keeps its contract.
    expect(uniqueFlowName('Imported flow', new Set(['Imported flow']))).toBe('Imported flow (2)')
    expect(uniqueFlowName('Imported flow', new Set(['Imported flow', 'Imported flow (2)']))).toBe('Imported flow (3)')
    expect(uniqueFlowName('Fresh', new Set())).toBe('Fresh')
  })
})
