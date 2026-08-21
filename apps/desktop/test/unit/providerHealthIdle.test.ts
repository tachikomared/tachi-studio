// apps/desktop/test/unit/providerHealthIdle.test.ts
//
// LANE V — idle honesty for the provider health sweep.
//
// A sweep is five probes, two of them CLOUD round-trips (bankr, surplus). It
// used to fire every 5 minutes forever, including at a window the user had
// minimised. These tests pin the two halves of the fix:
//   1. a hidden window is not swept;
//   2. becoming visible again catches up — but only when the readings actually
//      went stale, so an alt-tab a second after a sweep re-probes nothing.
//
// Runs in the `node` environment (see vitest.config.ts), so `document` is
// stubbed by hand — which also exercises the store's typeof-guards.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type Listener = () => void

interface FakeDoc {
  visibilityState: 'visible' | 'hidden'
  listeners: Map<string, Set<Listener>>
  addEventListener(type: string, fn: Listener): void
  removeEventListener(type: string, fn: Listener): void
  fire(type: string): void
}

function fakeDocument(): FakeDoc {
  const listeners = new Map<string, Set<Listener>>()
  return {
    visibilityState: 'visible',
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn()
    },
  }
}

const g = globalThis as unknown as { document?: FakeDoc; window?: unknown }

let doc: FakeDoc
let probeCalls: number

/** Fresh module per test — the interval handle + refcount are module-scoped. */
async function loadStore() {
  vi.resetModules()
  return (await import('../../src/store/provider-health.store')).useProviderHealthStore
}

beforeEach(() => {
  vi.useFakeTimers()
  doc = fakeDocument()
  g.document = doc
  probeCalls = 0
  // One probeable bridge is enough — every probe funnels through checkAll().
  g.window = {
    tachi: {
      bankr: {
        listModels: async () => {
          probeCalls += 1
          return { ok: true, models: [{ id: 'm' }] }
        },
      },
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
  delete g.document
  delete g.window
})

describe('provider health sweep — idle honesty', () => {
  it('does NOT sweep while the window is hidden', async () => {
    const store = await loadStore()
    const { HEALTH_CHECK_INTERVAL_MS } = await import('../../src/store/provider-health.store')
    const stop = store.getState().start()
    await vi.advanceTimersByTimeAsync(0)
    const afterMount = probeCalls
    expect(afterMount).toBeGreaterThan(0) // the mount sweep still runs

    doc.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS * 3)
    expect(probeCalls).toBe(afterMount) // three intervals elapsed, zero probes

    stop()
  })

  it('still sweeps on the interval while visible', async () => {
    const store = await loadStore()
    const { HEALTH_CHECK_INTERVAL_MS } = await import('../../src/store/provider-health.store')
    const stop = store.getState().start()
    await vi.advanceTimersByTimeAsync(0)
    const afterMount = probeCalls

    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS)
    expect(probeCalls).toBeGreaterThan(afterMount)

    stop()
  })

  it('catches up on becoming visible when the readings went stale', async () => {
    const store = await loadStore()
    const { HEALTH_CHECK_INTERVAL_MS } = await import('../../src/store/provider-health.store')
    const stop = store.getState().start()
    await vi.advanceTimersByTimeAsync(0)

    doc.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_INTERVAL_MS * 2)
    const whileHidden = probeCalls

    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    await vi.advanceTimersByTimeAsync(0)
    expect(probeCalls).toBeGreaterThan(whileHidden)

    stop()
  })

  it('does NOT re-probe on an alt-tab that happens right after a sweep', async () => {
    const store = await loadStore()
    const stop = store.getState().start()
    await vi.advanceTimersByTimeAsync(0)
    const afterMount = probeCalls

    // Away and back inside the staleness window.
    doc.visibilityState = 'hidden'
    await vi.advanceTimersByTimeAsync(1_000)
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    await vi.advanceTimersByTimeAsync(0)

    expect(probeCalls).toBe(afterMount)
    stop()
  })

  it('the last disposer detaches the visibility listener', async () => {
    const store = await loadStore()
    const stop = store.getState().start()
    expect(doc.listeners.get('visibilitychange')?.size ?? 0).toBe(1)
    stop()
    expect(doc.listeners.get('visibilitychange')?.size ?? 0).toBe(0)
  })
})
