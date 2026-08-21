// apps/desktop/test/unit/autoModelGather.test.ts
//
// The IMPURE half of the AUTO router (src/pages/chat/autoModelGather.ts) —
// specifically the FREE RUNG's membership.
//
// The rung has exactly ONE member: freellmapi-local, and only when its sidecar
// answers. Kilo Gateway briefly sat here as a second, straight-to-cloud member
// (2026-08-01); it is now an upstream INSIDE that relay, so the fan-out across
// free gateways happens server-side and the rung stopped naming it twice.
//
// Two properties are load-bearing and pinned below:
//   - every free-rung member is the local relay, so nothing on this rung can
//     reach a cloud gateway directly — that would bypass both the relay's
//     failover ordering and the trains-on-prompts disclosure that lives on the
//     relay's own surface;
//   - PRIVATE MODE empties the rung entirely, because the relay proxies to the
//     cloud ("free is a price, not a place").
//
// A machine WITHOUT the Node toolchain (no freellmapi sidecar) gets an EMPTY
// free rung and falls to the paid default. That is a real gap, and it belongs
// to the sidecar installer. window.tachi is stubbed per test; every stub
// failure path mirrors a real one (preload missing / sidecar stopped).
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { gatherAutoModelInputs } from '../../src/pages/chat/autoModelGather'
import { resolveAutoModel } from '../../src/utils/autoModel'

const DEFAULT = { provider: 'bankr-gateway', model: 'claude-sonnet-4.6' }

/** window.tachi stub: local engines absent; freellmapi behavior injectable. */
function installTachi(opts: {
  freellmapi?: () => Promise<{ ok: boolean; models: Array<{ id: string }> }>
}): void {
  const reject = async (): Promise<never> => { throw new Error('preload surface missing') }
  ;(globalThis as unknown as { window: unknown }).window = {
    tachi: {
      catalog:    { hardware: reject },
      llamaCpp:   { status: reject },
      ollama:     { status: reject },
      freellmapi: { listFallbackModels: opts.freellmapi ?? reject },
    },
  }
}

const sidecarUp   = async () => ({ ok: true,  models: [{ id: 'auto' }] })
const sidecarDown = async (): Promise<never> => { throw new Error('sidecar not installed') }

beforeEach(() => installTachi({}))
afterAll(() => { delete (globalThis as unknown as { window?: unknown }).window })

describe('gatherAutoModelInputs — free rung membership + ordering', () => {
  // Kilo Gateway sat on this rung as a second member while it was a standalone
  // provider. It is now an upstream INSIDE the relay, so the rung has exactly
  // one member again and the fan-out happens server-side. These tests pin the
  // rung's SHAPE, not any particular upstream's name.
  it('sidecar up → the relay is the whole free rung', async () => {
    installTachi({ freellmapi: sidecarUp })
    const input = await gatherAutoModelInputs(DEFAULT)
    expect(input.providers).toEqual([
      { provider: 'freellmapi-local', connected: true, models: [{ model: 'auto', free: true }] },
    ])
  })

  it('no toolchain (sidecar throws) → the free rung is empty', async () => {
    installTachi({ freellmapi: sidecarDown })
    const input = await gatherAutoModelInputs(DEFAULT)
    expect(input.providers).toEqual([])
  })

  it('sidecar answering with an empty catalog is treated as down', async () => {
    installTachi({ freellmapi: async () => ({ ok: true, models: [] }) })
    const input = await gatherAutoModelInputs(DEFAULT)
    expect(input.providers).toEqual([])
  })

  it("the relay's model stays the router alias 'auto' — the fan-out is server-side", async () => {
    installTachi({ freellmapi: sidecarUp })
    const input = await gatherAutoModelInputs(DEFAULT)
    const relay = input.providers?.find(p => p.provider === 'freellmapi-local')
    expect(relay?.models).toEqual([{ model: 'auto', free: true }])
  })

  it('no free-rung entry may reach the cloud DIRECTLY — the relay is the only door', async () => {
    installTachi({ freellmapi: sidecarUp })
    const input = await gatherAutoModelInputs(DEFAULT)
    // Every member must be the local relay. A future edit that re-adds a
    // straight-to-cloud gateway here bypasses the relay's ordering AND the
    // trains-on-prompts disclosure that lives on the relay's surface.
    for (const p of input.providers ?? []) {
      expect(p.provider).toBe('freellmapi-local')
    }
  })

  it('PRIVATE MODE empties the whole free rung', async () => {
    installTachi({ freellmapi: sidecarUp })
    const input = await gatherAutoModelInputs(DEFAULT, { privateMode: true })
    expect(input.providers).toEqual([])
  })
})

describe('gatherAutoModelInputs → resolveAutoModel — end to end', () => {
  it('toolchain-less machine: AUTO falls through the free rung to the paid default', async () => {
    // The honest consequence of removing the standalone gateway: without the
    // sidecar there is no free rung. That gap belongs to the sidecar installer,
    // not to a second AUTO entry that would bypass the relay's disclosure.
    installTachi({ freellmapi: sidecarDown })
    const decision = resolveAutoModel(await gatherAutoModelInputs(DEFAULT))
    expect(decision.provider).toBe(DEFAULT.provider)
    expect(decision.reason).not.toBe('free')
  })

  it('sidecar up: the relay wins the rung at reason free', async () => {
    installTachi({ freellmapi: sidecarUp })
    const decision = resolveAutoModel(await gatherAutoModelInputs(DEFAULT))
    expect(decision).toEqual({ provider: 'freellmapi-local', model: 'auto', reason: 'free' })
  })

  it('private mode with no local engines: paid default, never a cloud-free rung', async () => {
    installTachi({ freellmapi: sidecarUp })
    const decision = resolveAutoModel(await gatherAutoModelInputs(DEFAULT, { privateMode: true }))
    expect(decision).toEqual({ ...DEFAULT, reason: 'paid-default' })
  })
})
