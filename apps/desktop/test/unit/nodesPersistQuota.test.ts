// apps/desktop/test/unit/nodesPersistQuota.test.ts
//
// NIGHT QUEUE 2026-07-31, lane 3D — item 4: THE QUOTA BANNER.
//
// nodes.store's throttled persistence (PERSIST_THROTTLE_MS = 500) has always
// caught a QuotaExceededError from localStorage.setItem so a huge graph (or an
// artifact that dodged partialize's b64 strip) does not crash the app — but
// the ONLY symptom was a console.warn. "the graph would just quietly stop
// persisting" (the partialize comment's own words) had no visible half: a user
// could keep editing a flow for an hour believing it was saved while nothing
// after the failure ever landed in localStorage.
//
// This pins the FIX at the store level (the seam RepairBanner reads):
//   • a failed flush latches `persistFailed`
//   • a LATER, smaller flush that succeeds clears it again
//   • the flag itself is never written to storage (partialize excludes it) —
//     a fresh load always starts clean
//   • the store action never throws out of a mutator — the app stays alive,
//     exactly as the pre-existing catch already guaranteed
//
// The store persists through plain localStorage (no encryption) — shimmed the
// same way nodesHistory.test.ts / fanout.test.ts already do — and the flush
// itself is gated behind a 500ms throttle timer, so these tests drive fake
// timers rather than sleeping.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const _ls = new Map<string, string>()
let throwOnSetItem = false
/** How many times the REAL localStorage.setItem actually ran — the write
 *  count a self-rescheduling flush (the reentrancy bug this lane's fix
 *  guards against) would inflate on every throttle tick even with the
 *  canvas completely idle. */
let setItemCalls = 0

;(globalThis as any).localStorage = {
  getItem: (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem: (k: string, v: string) => {
    setItemCalls++
    if (throwOnSetItem) throw new Error('QuotaExceededError (test)')
    _ls.set(k, String(v))
  },
  removeItem: (k: string) => { _ls.delete(k) },
  clear: () => { _ls.clear() },
}

import { useNodesStore } from '../../src/pages/nodes/store/nodes.store'

const S = () => useNodesStore.getState()
/** addNode takes a partial without id/position; cast keeps the test terse
 *  (same shortcut nodesHistory.test.ts uses). */
const add = (label: string) => S().addNode({ type: 'text', data: { label } } as never)

/** Push the mutation through the store, then run the throttled flush that a
 *  real 500ms tick would eventually fire. */
function flushPersist() {
  vi.advanceTimersByTime(600)
}

function reset() {
  useNodesStore.setState({
    nodes: [], edges: [], flowName: 'Untitled flow',
    undoStack: [], redoStack: [], persistFailed: false,
  })
  _ls.clear()
  throwOnSetItem = false
  setItemCalls = 0
}

beforeEach(() => {
  vi.useFakeTimers()
  reset()
})

afterEach(() => {
  // A test that leaves throwOnSetItem=true with a pending timer would otherwise
  // fire a real setTimeout the moment fake timers are torn down — flush it (or
  // let it fail harmlessly) before switching the clock back.
  try { vi.runOnlyPendingTimers() } catch { /* the throw is expected in some cases */ }
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('nodes.store: persistFailed starts clear', () => {
  it('is false before anything has ever been written', () => {
    expect(S().persistFailed).toBe(false)
  })
})

describe('a throttled flush that throws latches persistFailed', () => {
  it('sets the flag once the flush actually runs', () => {
    throwOnSetItem = true
    add('A')
    expect(S().persistFailed, 'the throttle has not fired yet').toBe(false)
    flushPersist()
    expect(S().persistFailed).toBe(true)
  })

  it('never throws out of the mutator itself — the app stays alive', () => {
    throwOnSetItem = true
    expect(() => { add('A'); flushPersist() }).not.toThrow()
  })

  it('a normal write never latches it', () => {
    add('A')
    flushPersist()
    expect(S().persistFailed).toBe(false)
  })
})

describe('a later, successful flush clears the latch', () => {
  it('recovers once localStorage accepts a write again', () => {
    throwOnSetItem = true
    add('A')
    flushPersist()
    expect(S().persistFailed).toBe(true)

    throwOnSetItem = false
    add('B')
    flushPersist()
    expect(S().persistFailed).toBe(false)
  })

  it('a flush that keeps failing leaves it latched', () => {
    throwOnSetItem = true
    add('A')
    flushPersist()
    add('B')
    flushPersist()
    expect(S().persistFailed).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// THE REENTRANCY THIS FIX HAD TO AVOID — found while writing this suite
// ═════════════════════════════════════════════════════════════════════════════
//
// zustand's persist wrapper calls storage.setItem() on EVERY set(), even a
// value-preserving no-op (`api.setState = (s, r) => { savedSetState(s, r);
// void setItem() }` — unconditional). flush() runs INSIDE the storage
// adapter, so notifying the store from there via a BARE
// `useNodesStore.getState().clearPersistFailed()` — called every time a flush
// merely SUCCEEDS, not only when it actually recovers from a failure —
// re-enters setItem() before flush() even returns, which schedules ANOTHER
// throttle timer. That timer's own flush repeats the same call, and so on:
// a single edit would perpetually re-persist itself every throttle tick,
// forever, with the canvas sitting completely idle. Both notifiers are
// guarded (only call the mutator when the flag would actually change) so a
// `set()` — and the reentrant setItem() — fires only on the rare TRANSITION.
describe('a flush never reschedules itself — no perpetual re-persist on an idle canvas', () => {
  it('one edit writes once; idle time afterward writes nothing more', () => {
    add('A')
    flushPersist()
    expect(setItemCalls).toBe(1)
    // Many throttle windows with NO further edits. A self-rescheduling flush
    // would keep firing across this span; the fix goes fully idle.
    vi.advanceTimersByTime(5000)
    expect(setItemCalls).toBe(1)
  })

  it('a FAILED flush writes (and throws) once per real edit, not once per tick', () => {
    throwOnSetItem = true
    add('A')
    flushPersist()
    expect(setItemCalls).toBe(1)
    expect(S().persistFailed).toBe(true)
    vi.advanceTimersByTime(5000)
    expect(setItemCalls).toBe(1)
    expect(S().persistFailed).toBe(true)
  })
})

describe('the flag is session-only — never written to storage', () => {
  it('partialize excludes persistFailed from the persisted JSON', () => {
    add('A')
    flushPersist()
    const raw = _ls.get('tachi-nodes-v1')
    expect(raw, 'the flush should have written something').toBeTruthy()
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> }
    expect(parsed.state).not.toHaveProperty('persistFailed')
    // sanity: the fields partialize DOES carry are still there.
    expect(parsed.state).toHaveProperty('flowName')
    expect(parsed.state).toHaveProperty('nodes')
    expect(parsed.state).toHaveProperty('edges')
  })
})

describe('the mutators RepairBanner would trigger indirectly are directly callable', () => {
  it('latchPersistFailed / clearPersistFailed toggle the flag on their own', () => {
    expect(S().persistFailed).toBe(false)
    S().latchPersistFailed()
    expect(S().persistFailed).toBe(true)
    S().clearPersistFailed()
    expect(S().persistFailed).toBe(false)
  })

  it('latching twice stays true — the second call is a genuine no-op set', () => {
    S().latchPersistFailed()
    expect(S().persistFailed).toBe(true)
    S().latchPersistFailed()
    expect(S().persistFailed).toBe(true)
  })
})
