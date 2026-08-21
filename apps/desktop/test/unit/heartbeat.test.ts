// apps/desktop/test/unit/heartbeat.test.ts
//
// Sidecar heartbeat transition tracker (STEAL 2026-06-21 #5, checkcle
// notification_monitor: fire on status CHANGE only, not every probe). Pure +
// dependency-free; sidecar-manager.healthCheckSidecar feeds it each probe and
// notifies on a transition. The first observation is a silent baseline so a
// never-started sidecar doesn't spam a "down" notification.

import { describe, it, expect } from 'vitest'
import { HeartbeatTracker } from '../../electron/services/heartbeat'

describe('HeartbeatTracker', () => {
  it('treats the first observation as a silent baseline (no transition)', () => {
    const h = new HeartbeatTracker()
    expect(h.record('a', true)).toMatchObject({ status: 'up', transitioned: false })

    const h2 = new HeartbeatTracker()
    expect(h2.record('a', false)).toMatchObject({ status: 'down', transitioned: false })
  })

  it('flags up→down once, then stays down without re-flagging', () => {
    const h = new HeartbeatTracker()
    h.record('a', true) // baseline up
    expect(h.record('a', false)).toMatchObject({ status: 'down', transitioned: true, consecutiveFailures: 1 })
    expect(h.record('a', false)).toMatchObject({ status: 'down', transitioned: false, consecutiveFailures: 2 })
    expect(h.record('a', false)).toMatchObject({ status: 'down', transitioned: false, consecutiveFailures: 3 })
  })

  it('flags down→up (recovery) and resets the failure count', () => {
    const h = new HeartbeatTracker()
    h.record('a', true)
    h.record('a', false)
    expect(h.record('a', true)).toMatchObject({ status: 'up', transitioned: true, consecutiveFailures: 0 })
    expect(h.record('a', true)).toMatchObject({ status: 'up', transitioned: false })
  })

  it('tracks each sidecar id independently', () => {
    const h = new HeartbeatTracker()
    h.record('a', true)
    h.record('b', true)
    expect(h.record('a', false)).toMatchObject({ status: 'down', transitioned: true })
    expect(h.record('b', false)).toMatchObject({ status: 'down', transitioned: true })
    // a's state didn't leak into b's failure count
    expect(h.record('b', false).consecutiveFailures).toBe(2)
  })

  it('exposes the current status without recording an observation', () => {
    const h = new HeartbeatTracker()
    expect(h.statusOf('a')).toBeNull()
    h.record('a', true)
    expect(h.statusOf('a')).toBe('up')
  })
})
