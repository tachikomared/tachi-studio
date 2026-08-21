// apps/desktop/test/unit/providerCompat.test.ts
//
// Unit tests for the Nodes↔registry provider-compat bridge:
//   - GRAPH_PROVIDER_IDS: which providers the agent-kit runtime can compile
//   - canonicalProviderId(): legacy short id → canonical registry id
//   - providerEndpointHint(): non-absolute endpoint label per provider
//   - graphProviderSeeds(): registry-derived seeds for graph-capable providers
//
// These assert the module's REAL behavior against the real provider registry
// (packages/core/src/providers/registry), which is the single source of truth.
import { describe, it, expect } from 'vitest'
import {
  GRAPH_PROVIDER_IDS,
  canonicalProviderId,
  providerEndpointHint,
  graphProviderSeeds,
} from '../../src/pages/nodes/providerCompat'
import { getProvider } from '@tachi/core/src/providers/registry'

describe('GRAPH_PROVIDER_IDS', () => {
  it('lists exactly the agent-kit-compilable providers in display order', () => {
    expect(GRAPH_PROVIDER_IDS).toEqual([
      'bankr-gateway',
      'opengateway',
      'surplus',
      'venice',
      'imgnai',
      'ollama-local',
      'llama-cpp',
      'freellmapi-local',
    ])
  })

  it('every id resolves to a real registry provider', () => {
    for (const id of GRAPH_PROVIDER_IDS) {
      expect(getProvider(id), id).toBeDefined()
    }
  })

  it('excludes providers with no agent-kit adapter (anthropic / openrouter / free-claude-code)', () => {
    expect(GRAPH_PROVIDER_IDS).not.toContain('anthropic-oauth')
    expect(GRAPH_PROVIDER_IDS).not.toContain('openrouter-oauth')
    expect(GRAPH_PROVIDER_IDS).not.toContain('free-claude-code')
  })
})

describe('canonicalProviderId', () => {
  it('normalizes legacy short node ids to canonical registry ids', () => {
    expect(canonicalProviderId('bankr')).toBe('bankr-gateway')
    expect(canonicalProviderId('ollama')).toBe('ollama-local')
    expect(canonicalProviderId('llamacpp')).toBe('llama-cpp')
    expect(canonicalProviderId('freellmapi')).toBe('freellmapi-local')
    expect(canonicalProviderId('anthropic')).toBe('anthropic-oauth')
  })

  it('passes canonical ids through unchanged', () => {
    expect(canonicalProviderId('bankr-gateway')).toBe('bankr-gateway')
    expect(canonicalProviderId('venice')).toBe('venice')
    expect(canonicalProviderId('surplus')).toBe('surplus')
  })

  it('passes unknown ids through unchanged (no rejection)', () => {
    expect(canonicalProviderId('totally-unknown')).toBe('totally-unknown')
  })

  it('returns empty string for null/undefined/empty input', () => {
    expect(canonicalProviderId(null)).toBe('')
    expect(canonicalProviderId(undefined)).toBe('')
    expect(canonicalProviderId('')).toBe('')
  })
})

describe('providerEndpointHint', () => {
  it('returns the registry baseUrl with the scheme stripped for fixed-endpoint providers', () => {
    expect(providerEndpointHint('bankr-gateway')).toBe('llm.bankr.bot/v1')
    expect(providerEndpointHint('venice')).toBe('api.venice.ai/api/v1')
    expect(providerEndpointHint('surplus')).toBe('www.surplusintelligence.ai/api/inference/v1')
    expect(providerEndpointHint('opengateway')).toBe('opengateway.gitlawb.com/v1')
  })

  it('resolves through legacy ids by canonicalizing first', () => {
    expect(providerEndpointHint('bankr')).toBe('llm.bankr.bot/v1')
  })

  it('never returns an absolute (scheme-bearing) url', () => {
    for (const id of GRAPH_PROVIDER_IDS) {
      expect(providerEndpointHint(id)).not.toMatch(/^https?:\/\//)
    }
  })

  it('falls back to a localhost label for local sidecars with no baseUrl', () => {
    // ollama-local / freellmapi-local / llama-cpp have no registry baseUrl.
    expect(providerEndpointHint('ollama-local')).toBe('localhost:11434')
    expect(providerEndpointHint('freellmapi-local')).toBe('localhost:8080')
    expect(providerEndpointHint('llama-cpp')).toBe('local llama-server')
  })

  it('resolves the llama-cpp fallback through its legacy id too', () => {
    expect(providerEndpointHint('llamacpp')).toBe('local llama-server')
    expect(providerEndpointHint('ollama')).toBe('localhost:11434')
    expect(providerEndpointHint('freellmapi')).toBe('localhost:8080')
  })

  it('returns empty string for an unknown provider with no fallback', () => {
    expect(providerEndpointHint('made-up-provider')).toBe('')
  })
})

describe('graphProviderSeeds', () => {
  it('produces one seed per graph-capable provider in display order', () => {
    const seeds = graphProviderSeeds()
    expect(seeds.map(s => s.providerId)).toEqual(GRAPH_PROVIDER_IDS)
  })

  it('seeds carry label, default model, and endpoint from the registry', () => {
    const byId = Object.fromEntries(graphProviderSeeds().map(s => [s.providerId, s]))

    expect(byId['bankr-gateway']).toEqual({
      providerId: 'bankr-gateway',
      label: 'Bankr Gateway',
      model: 'claude-sonnet-4.6',
      endpoint: 'llm.bankr.bot/v1',
    })

    expect(byId['venice']).toEqual({
      providerId: 'venice',
      label: 'Venice',
      model: 'zai-org-glm-4.7',
      endpoint: 'api.venice.ai/api/v1',
    })
  })

  it('uses the registry defaultModel verbatim (and "auto" where that is the default)', () => {
    const byId = Object.fromEntries(graphProviderSeeds().map(s => [s.providerId, s]))
    expect(byId['ollama-local'].model).toBe('auto')
    expect(byId['llama-cpp'].model).toBe('auto')
    expect(byId['freellmapi-local'].model).toBe('auto')
    expect(byId['surplus'].model).toBe('claude-sonnet-4.5')
    // Kilo Gateway was removed as a standalone provider on 2026-08-01 (it is
    // now an upstream inside the FreeLLM relay), so it must NOT appear here.
    expect(byId['kilo-gateway']).toBeUndefined()
    // 2026-07: OpenGateway went pay-as-you-go — the default is the
    // free-for-everyone nemotron, not the now-paid MiMo.
    expect(byId['opengateway'].model).toBe('nvidia/nemotron-3-ultra-550b-a55b:free')
  })

  it('local sidecar seeds get the localhost endpoint label, not a cloud url', () => {
    const byId = Object.fromEntries(graphProviderSeeds().map(s => [s.providerId, s]))
    expect(byId['ollama-local'].endpoint).toBe('localhost:11434')
    expect(byId['freellmapi-local'].endpoint).toBe('localhost:8080')
    expect(byId['llama-cpp'].endpoint).toBe('local llama-server')
  })

  it('every seed mirrors the registry label exactly', () => {
    for (const seed of graphProviderSeeds()) {
      expect(seed.label).toBe(getProvider(seed.providerId)!.label)
    }
  })
})
