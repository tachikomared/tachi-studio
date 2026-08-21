// apps/desktop/test/unit/permissionQueue.test.ts
//
// Renderer half of the parallel-permission deadlock fix (live dogfood, 2026-07-25).
// The CODE tab held ONE pendingPermission in useState, so a second
// agent:permission-request arriving 10 ms after the first overwrote its card —
// the first request was never answered and the main process, which awaits the
// decision, hung the run in WORKING forever.
//
// The reducer's contract: a queued request only ever leaves through an explicit
// decision or an explicit cancel from main. Nothing is silently overwritten.

import { describe, it, expect } from 'vitest'
import {
  enqueuePermission,
  resolvePermission,
  dropPermissions,
  activePermission,
  queuedBehind,
} from '../../src/pages/agent/permissionQueue'
import type { PermissionRequest } from '../../src/pages/agent/PermissionCard'

function req(id: string, toolName = 'bash'): PermissionRequest {
  return { id, toolName, toolInput: { command: `echo ${id}` }, reason: 'shell command', recommendedDecision: 'deny' }
}

describe('permission queue reducer', () => {
  it('keeps BOTH parallel requests instead of overwriting the first', () => {
    let q: PermissionRequest[] = []
    q = enqueuePermission(q, req('a'))
    q = enqueuePermission(q, req('b'))     // arrived 10 ms later — the old bug
    expect(q.map(r => r.id)).toEqual(['a', 'b'])
    expect(activePermission(q)?.id).toBe('a')
    expect(queuedBehind(q)).toBe(1)
  })

  it('shows the next card after the visible one is decided (FIFO)', () => {
    let q = enqueuePermission(enqueuePermission([], req('a')), req('b'))
    q = resolvePermission(q, 'a')
    expect(activePermission(q)?.id).toBe('b')
    expect(queuedBehind(q)).toBe(0)
    q = resolvePermission(q, 'b')
    expect(activePermission(q)).toBeNull()
    expect(q).toHaveLength(0)
  })

  it('lets a later request be answered out of order without losing the others', () => {
    let q = enqueuePermission(enqueuePermission(enqueuePermission([], req('a')), req('b')), req('c'))
    q = resolvePermission(q, 'b')
    expect(q.map(r => r.id)).toEqual(['a', 'c'])
  })

  it('is idempotent on a re-delivered id and returns the SAME array (no re-render)', () => {
    const q = enqueuePermission([], req('a'))
    const again = enqueuePermission(q, req('a'))
    expect(again).toBe(q)
    expect(again).toHaveLength(1)
  })

  it('ignores a malformed request rather than queueing an unanswerable card', () => {
    const q: PermissionRequest[] = []
    expect(enqueuePermission(q, { ...req('x'), id: '' })).toBe(q)
    expect(enqueuePermission(q, undefined as unknown as PermissionRequest)).toBe(q)
  })

  it('resolving an unknown id changes nothing (identity preserved)', () => {
    const q = enqueuePermission([], req('a'))
    expect(resolvePermission(q, 'zzz')).toBe(q)
  })

  it('drops cards main already settled (timeout / abort / answered elsewhere)', () => {
    let q = enqueuePermission(enqueuePermission(enqueuePermission([], req('a')), req('b')), req('c'))
    q = dropPermissions(q, ['a', 'c'])
    expect(q.map(r => r.id)).toEqual(['b'])
  })

  it('dropping nothing / unknown ids preserves identity', () => {
    const q = enqueuePermission([], req('a'))
    expect(dropPermissions(q, [])).toBe(q)
    expect(dropPermissions(q, ['other'])).toBe(q)
  })

  it('an empty queue has no active card and nothing behind it', () => {
    expect(activePermission([])).toBeNull()
    expect(queuedBehind([])).toBe(0)
  })
})
