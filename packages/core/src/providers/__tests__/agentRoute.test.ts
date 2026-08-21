import { describe, it, expect } from 'vitest'
import { OPENGATEWAY_AGENT_MODEL, pickDefaultAgentRoute } from '../agent-route.js'
import { isVerifiedFreeModel } from '../../pricing.js'
import { resolveCapability } from '../../tachi/models.js'
import { getProvider } from '../registry.js'

// THE PIN (2026-08-01): both harnesses pinned 'mimo-v2.5-pro' for opengateway
// after MiMo went paid (07-16), while the badge/hints said "nemotron :free".
// The routing and every label now derive from OPENGATEWAY_AGENT_MODEL, and
// these tests keep the id honest: it must stay VERIFIED FREE and AGENT-CAPABLE.
// If either fact breaks, change the id — do not relax the test.
describe('OPENGATEWAY_AGENT_MODEL', () => {
  it('is verified free — unconditionally (no promo end date)', () => {
    expect(isVerifiedFreeModel(OPENGATEWAY_AGENT_MODEL)).toBe(true)
    // Undated entry: still free far in the future — a dated promo would rot
    // into a paid pin exactly the way mimo did.
    expect(isVerifiedFreeModel(OPENGATEWAY_AGENT_MODEL, Date.parse('2030-01-01T00:00:00Z'))).toBe(true)
  })

  it('can drive the agent loop per the capability catalog (tools + context)', () => {
    const cap = resolveCapability(OPENGATEWAY_AGENT_MODEL)
    expect(cap.agentCapable).toBe(true)
    expect(cap.supportsTools).toBe(true)
    // It must resolve to the ULTRA row, not the generic nemotron bucket — the
    // meter and the harness budget both derive from whatever this returns.
    expect(cap.match).toBe('nemotron-3-ultra')
    // …and that row says 131_072, NOT the 1_000_000 this test used to pin.
    // OpenGateway — the gateway this very constant routes to — publishes
    // 131_072 for this id in its own keyless catalog (read 2026-08-02);
    // OpenRouter publishes 1_000_000 for the identical id. The old number was
    // the other gateway's, so the harness sized history 7.6× larger than the
    // one it actually talks to would accept.
    expect(cap.contextWindow).toBe(131_072)
    // And it is deliberately NOT presented as certain: one id, two gateways,
    // two windows, and this table has no provider dimension to tell them apart.
    expect(cap.contextWindowKnown).toBe(false)
  })
})

describe('pickDefaultAgentRoute', () => {
  it('OpenGateway key wins the ladder and the rung is FREE', () => {
    const r = pickDefaultAgentRoute({ opengateway: true, bankr: true })
    expect(r.providerId).toBe('opengateway')
    expect(r.modelId).toBe(OPENGATEWAY_AGENT_MODEL)
    expect(r.free).toBe(true)
  })

  it('Bankr rung is PAID — a FREE label must never cover it', () => {
    const r = pickDefaultAgentRoute({ opengateway: false, bankr: true })
    expect(r.providerId).toBe('bankr-gateway')
    // The auto-pick is the registry row's defaultModel — one source of truth.
    expect(r.modelId).toBe(getProvider('bankr-gateway')!.defaultModel)
    expect(r.free).toBe(false)
  })

  it('no keys → the local free router, FREE', () => {
    const r = pickDefaultAgentRoute({ opengateway: false, bankr: false })
    expect(r.providerId).toBe('freellmapi-local')
    expect(r.modelId).toBe('auto')
    expect(r.free).toBe(true)
  })

  it('free is a derived fact: true only on rungs whose pricing/billing say so', () => {
    // Every combination: free ⇔ the rung cannot bill the user.
    for (const opengateway of [true, false]) {
      for (const bankr of [true, false]) {
        const r = pickDefaultAgentRoute({ opengateway, bankr })
        const paidPossible = !opengateway && bankr
        expect(r.free).toBe(!paidPossible)
      }
    }
  })
})
