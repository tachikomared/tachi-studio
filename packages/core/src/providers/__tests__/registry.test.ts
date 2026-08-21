import { describe, it, expect } from 'vitest'
import {
  PROVIDER_LIST,
  listProviders,
  getProvider,
  isProviderId,
  localProviderIds,
  cloudProviderIds,
  providerLocality,
  localityOf,
  providerBilling,
} from '../registry.js'

describe('provider registry', () => {
  it('exposes the 11 canonical providers in a stable (picker) order', () => {
    expect(listProviders().map(p => p.id)).toEqual([
      'ollama-local',
      'freellmapi-local',
      'free-claude-code',
      'llama-cpp',
      'opengateway',
      'bankr-gateway',
      'surplus',
      'anthropic-oauth',
      'openrouter-oauth',
      'venice',
      'imgnai',
    ])
  })

  it('a retired provider id claims nothing — old persisted rows stay readable', () => {
    // kilo-gateway was a registry provider until 2026-08-01, when Kilo became
    // an upstream behind the FreeLLM local router instead of a pickable
    // provider. Its ABSENCE is pinned by the exact-list assertion above and,
    // more strongly, by the ProviderId union itself — 'kilo-gateway' no longer
    // type-checks as a provider id, so a stale `find(id === 'kilo-gateway')`
    // here would be a compile error, not a passing test. That is the guard;
    // it must not be cast away.
    //
    // What still needs a RUNTIME check is the other half: old cost-ledger rows
    // and persisted conversations still carry the retired string. The lookup
    // helpers take a plain string precisely so those keep resolving, and they
    // must resolve in the claim-nothing direction rather than throwing or
    // inventing a $0.
    expect(providerBilling('kilo-gateway')).toBe('paid')
    expect(providerLocality('kilo-gateway')).toBe('cloud')
  })

  it('freellmapi-local carries the free route trains-on-prompts disclosure', () => {
    // The relay can be served by upstreams that train on prompts (Kilo says so
    // on every free row in its own catalog). Since the user picks the ROUTER,
    // not the upstream, the router's hint is the only picker-level place that
    // fact can appear. It moved here when the standalone provider was removed.
    const p = listProviders().find(x => x.id === 'freellmapi-local')!
    expect(p.billing).toBe('free')
    expect(providerLocality('freellmapi-local')).toBe('relay')  // localhost, cloud egress
    expect(p.hint).toMatch(/train on your prompts/i)
  })

  it('imgnai: full-stack gateway (text+image+video), combined-credential hint', () => {
    const p = listProviders().find(x => x.id === 'imgnai')!
    expect(p.openaiCompatible).toBe(true)
    expect(p.baseUrl).toBe('https://kat.imgnai.com/v1')
    expect(p.keychainId).toBe('imgnai')
    expect(p.capabilities).toEqual(expect.arrayContaining(['text', 'image', 'video']))
    expect(p.hint).toMatch(/api_key:api_secret/)
  })

  it('has unique ids', () => {
    const ids = PROVIDER_LIST.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keyed providers declare a keychainId; local/sidecar do not', () => {
    for (const p of PROVIDER_LIST) {
      if (p.auth === 'api_key' || p.auth === 'oauth_pkce' || p.auth === 'oauth_device') {
        expect(p.keychainId, `${p.id} must have a keychainId`).toBeTruthy()
      } else {
        expect(p.keychainId, `${p.id} must not have a keychainId`).toBeUndefined()
      }
    }
  })

  it('OpenAI-compatible cloud providers declare an https baseUrl', () => {
    for (const p of PROVIDER_LIST) {
      if (p.openaiCompatible && p.tier === 'cloud') {
        expect(p.baseUrl ?? '', `${p.id} needs a baseUrl`).toMatch(/^https:\/\//)
      }
    }
  })

  it('every provider has a defaultModel for the picker', () => {
    for (const p of PROVIDER_LIST) expect(p.defaultModel, p.id).toBeTruthy()
  })

  it('classifies egress: only ollama + llama.cpp are local', () => {
    expect(localProviderIds().sort()).toEqual(['llama-cpp', 'ollama-local'])
    expect(cloudProviderIds()).toContain('surplus')
    // sidecars proxy to cloud, so they are cloud-egress even though tier is local
    expect(cloudProviderIds()).toContain('freellmapi-local')
    expect(cloudProviderIds()).not.toContain('ollama-local')
  })

  it('locality never says "local" about a provider whose prompt leaves the machine', () => {
    // THE PIN: 64c837d removed "$0 (local)" from cloud calls; the same sentence
    // survived as a green LOCAL chip in the picker because that chip read
    // `tier`. Whatever the tier, egress decides.
    for (const p of PROVIDER_LIST) {
      if (p.egress === 'cloud') {
        expect(providerLocality(p.id), `${p.id} has cloud egress`).not.toBe('local')
      }
    }
    // The two localhost sidecars are tier 'local' — and still not local.
    expect(providerLocality('freellmapi-local')).toBe('relay')
    expect(providerLocality('free-claude-code')).toBe('relay')
    expect(providerLocality('ollama-local')).toBe('local')
    expect(providerLocality('llama-cpp')).toBe('local')
    expect(providerLocality('bankr-gateway')).toBe('cloud')
  })

  it('an unknown or missing id claims nothing — it resolves to cloud', () => {
    expect(providerLocality('nope')).toBe('cloud')
    expect(providerLocality(undefined)).toBe('cloud')
    expect(providerLocality(null)).toBe('cloud')
    expect(localityOf(undefined)).toBe('cloud')
    // A hypothetical descriptor cannot buy 'local' with its tier.
    expect(localityOf({ tier: 'local', egress: 'cloud' })).toBe('relay')
    expect(localityOf({ tier: 'cloud', egress: 'local' })).toBe('local')
  })

  it('price and privacy are TWO facts — neither one implies the other', () => {
    // THE PIN: run-cost.ts used to carry FREE_REMOTE_IDS, one hand-written set
    // meaning "free AND remote". A list that encodes two facts at once goes
    // wrong in two ways at once, and only when someone adds a provider.
    // Free and NOT local — the whole reason the conflated list existed:
    for (const id of ['freellmapi-local', 'free-claude-code'] as const) {
      expect(providerBilling(id)).toBe('free')
      expect(providerLocality(id)).not.toBe('local')
    }
    // Local and free (your own hardware) — free for a different reason.
    for (const id of ['ollama-local', 'llama-cpp'] as const) {
      expect(providerBilling(id)).toBe('free')
      expect(providerLocality(id)).toBe('local')
    }
    // Remote and paid.
    expect(providerBilling('bankr-gateway')).toBe('paid')
    // A ':free' model id, a 'local' tier, a '-local' suffix: none of them buy
    // 'free' — only the registry field does. OpenGateway ships a free model and
    // is still a paid provider.
    expect(providerBilling('opengateway')).toBe('paid')
    // …and a mixed catalog stays 'paid' at provider level: OpenRouter carries
    // 14 live-priced-$0 models among 322 paid ones. Flipping the provider would
    // promise free over claude/gpt — the free signal is PER MODEL (pricing 0/0
    // in the live catalog), never this field.
    expect(providerBilling('openrouter-oauth')).toBe('paid')
    // Remote-ish and free: the local relay — free, and NOT local ('relay'),
    // because the prompt still leaves the machine.
    expect(providerBilling('freellmapi-local')).toBe('free')
    expect(providerLocality('freellmapi-local')).toBe('relay')
  })

  it('an unknown id is never called free either — it resolves to paid', () => {
    expect(providerBilling('nope')).toBe('paid')
    expect(providerBilling(undefined)).toBe('paid')
    expect(providerBilling(null)).toBe('paid')
    // Every entry must state the fact (the type requires it; this catches a
    // typo'd value slipping through a cast).
    for (const p of PROVIDER_LIST) {
      expect(['free', 'paid'], `${p.id}.billing`).toContain(p.billing)
    }
  })

  it('lookup + type guard reject non-canonical short aliases', () => {
    expect(getProvider('surplus')?.label).toBe('Surplus Intelligence')
    expect(getProvider('nope')).toBeUndefined()
    expect(isProviderId('bankr-gateway')).toBe(true)
    expect(isProviderId('bankr')).toBe(false) // short alias is NOT canonical
  })
})
