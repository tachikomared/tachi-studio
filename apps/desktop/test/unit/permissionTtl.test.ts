// Tests for the TTL session-approval cache in permission-service.ts.
//
// Adapted from gridex's MCPApprovalGate.sessionApprovals — an [actor+tool: Date]
// cache checked BEFORE prompting, with an "Approve for 30 min" path that expires
// silently so the next request re-prompts. The permanent session "always allow"
// (alwaysAllowedTools / families) is a separate, unaffected mechanism.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  approveForSession,
  isSessionApproved,
  recordDecision,
  isAutoAllowed,
  clearSessionApprovals,
  checkAutoApproval,
  type PermissionRequest,
} from '../../electron/services/permission-service'
import { CapabilityService, type CapabilityRequest } from '../../electron/services/capability-service'

/** A controllable clock so TTL expiry is deterministic. */
function fakeClock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

beforeEach(() => {
  clearSessionApprovals()
})

describe('TTL session-approval cache', () => {
  it('grants then allows within the TTL window, keyed by tool+actor', () => {
    const clock = fakeClock()
    approveForSession({ toolName: 'fs_write', actor: 'darksol' }, 30 * 60_000, clock.now)
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'darksol' }, clock.now)).toBe(true)
  })

  it('re-prompts (no longer approved) once the TTL has elapsed', () => {
    const clock = fakeClock()
    approveForSession({ toolName: 'fs_write', actor: 'darksol' }, 30 * 60_000, clock.now)
    clock.advance(30 * 60_000 + 1) // just past the window
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'darksol' }, clock.now)).toBe(false)
  })

  it('stays approved exactly at the boundary, expires strictly after', () => {
    const clock = fakeClock()
    approveForSession({ toolName: 'Bash', actor: 'tachi' }, 1000, clock.now)
    clock.advance(1000)
    expect(isSessionApproved({ toolName: 'Bash', actor: 'tachi' }, clock.now)).toBe(true) // inclusive boundary
    clock.advance(1)
    expect(isSessionApproved({ toolName: 'Bash', actor: 'tachi' }, clock.now)).toBe(false)
  })

  it('scopes approvals by actor: a grant for one actor does not cover another', () => {
    const clock = fakeClock()
    approveForSession({ toolName: 'fs_write', actor: 'darksol' }, 60_000, clock.now)
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'darksol' }, clock.now)).toBe(true)
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'nook' }, clock.now)).toBe(false)
    expect(isSessionApproved({ toolName: 'fs_read', actor: 'darksol' }, clock.now)).toBe(false)
  })

  it('defaults the TTL to 30 minutes when none is given', () => {
    const clock = fakeClock()
    approveForSession({ toolName: 'fs_write', actor: 'darksol' }, undefined, clock.now)
    clock.advance(29 * 60_000)
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'darksol' }, clock.now)).toBe(true)
    clock.advance(2 * 60_000) // now 31 min in
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'darksol' }, clock.now)).toBe(false)
  })

  it('the permanent always-allow is unaffected by TTL expiry', () => {
    const req: PermissionRequest = {
      id: 'r1', toolName: 'fs_write', toolInput: {}, reason: 'x', recommendedDecision: 'allow',
    }
    recordDecision(req, 'always_allow_tool')
    // Permanent grant — no TTL, isAutoAllowed stays true forever.
    expect(isAutoAllowed('fs_write')).toBe(true)
    // And clearing only the TTL cache must not revoke the permanent grant.
    clearSessionApprovals()
    expect(isAutoAllowed('fs_write')).toBe(true)
  })

  it('clearSessionApprovals drops all live TTL grants', () => {
    const clock = fakeClock()
    approveForSession({ toolName: 'fs_write', actor: 'darksol' }, 60_000, clock.now)
    clearSessionApprovals()
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'darksol' }, clock.now)).toBe(false)
  })

  it('checkAutoApproval honours a live TTL grant for the matching actor', () => {
    // checkAutoApproval reads the cache with the real Date.now clock, so grant
    // with the default clock too (a fake-clock grant would read as already expired).
    // fs_write outside a protected path already auto-allows; use a Bash tool which
    // otherwise always prompts, to prove the TTL short-circuits the prompt.
    expect(checkAutoApproval('bash', { command: 'ls' }, { workingDir: '/w', actor: 'tachi' })).toBe('needs-prompt')
    approveForSession({ toolName: 'bash', actor: 'tachi' }, 60_000)
    expect(checkAutoApproval('bash', { command: 'ls' }, { workingDir: '/w', actor: 'tachi' })).toBe('auto-allow')
    // A different actor still has to prompt.
    expect(checkAutoApproval('bash', { command: 'ls' }, { workingDir: '/w', actor: 'nook' })).toBe('needs-prompt')
  })
})

describe('capability-service "Approve for N min" → TTL session approval', () => {
  function makeReq(over: Partial<CapabilityRequest> = {}): CapabilityRequest {
    return {
      id: 'cap-1', toolName: 'fs_write', toolInput: {}, reason: 'x',
      recommendedDecision: 'allow', sessionId: 'sess-A', workingDir: '/w', pushedAt: 0,
      ...over,
    }
  }

  it('deliverDecision(allow, {ttlMs}) records a TTL grant keyed by toolName+sessionId', async () => {
    const svc = new CapabilityService()
    const req = makeReq()
    const p = svc.awaitDecision(req)
    svc.deliverDecision(req.id, 'allow', { ttlMs: 60_000 })
    await expect(p).resolves.toBe('allow')
    // sessionId is the actor; the same tool from the same session now auto-approves.
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'sess-A' })).toBe(true)
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'sess-B' })).toBe(false)
  })

  it('a plain allow (no ttlMs) records NO TTL grant', async () => {
    const svc = new CapabilityService()
    const req = makeReq({ id: 'cap-2', sessionId: 'sess-C' })
    const p = svc.awaitDecision(req)
    svc.deliverDecision(req.id, 'allow')
    await expect(p).resolves.toBe('allow')
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'sess-C' })).toBe(false)
  })

  it('a deny never records a TTL grant even if ttlMs is supplied', async () => {
    const svc = new CapabilityService()
    const req = makeReq({ id: 'cap-3', sessionId: 'sess-D' })
    const p = svc.awaitDecision(req)
    svc.deliverDecision(req.id, 'deny', { ttlMs: 60_000 })
    await expect(p).resolves.toBe('deny')
    expect(isSessionApproved({ toolName: 'fs_write', actor: 'sess-D' })).toBe(false)
  })
})
