// apps/desktop/test/unit/providerContextWindow.test.ts
//
// THE rule this file pins: **the provider's live catalog is the authority for a
// model it serves.**
//
// @tachi/core's capability rows are keyed by SUBSTRINGS of a model id and carry
// no provider dimension at all — the same 'llama' row answers for Venice,
// OpenRouter, Bankr and imgnAI alike. That makes them a reasonable offline
// fallback and a bad source of truth: 31 of Venice's 106 text models matched no
// row at all and were told 32k (the wildcard's flat assertion), while several
// more inherited a family number that was wrong for the variant. A too-small
// context window is not cosmetic — the harness truncates the user's own history
// against it.
//
// So each catalog service must carry the provider's own number through when it
// publishes one, and must leave the field ABSENT when it doesn't. Absent means
// UNKNOWN; substituting a default here would launder a guess into a number the
// pickers print and the harness budgets against.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: vi.fn(() => 'test-key'),
}))

import { listVeniceModels } from '../../electron/services/venice-service'
import { listBankrModels } from '../../electron/services/bankr-service'
import { listSurplusModels } from '../../electron/services/surplus-service'
import { resolveContextWindow } from '@tachi/core'

const catalog = (data: unknown) =>
  ({ ok: true, status: 200, json: async () => ({ data }) }) as unknown as Response

beforeEach(() => { vi.restoreAllMocks() })

describe('Venice: model_spec.availableContextTokens', () => {
  it('reads the window Venice publishes — the field we were already fetching and dropping', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      // THE owner's model. It matches NO capability row, so before this it was
      // answered by the wildcard at 32k while Venice serves it at 200k.
      { id: 'olafangensan-glm-4.7-glash-heretic', model_spec: { availableContextTokens: 200_000 } },
      // Matches the 'llama' FAMILY row (32k) — wrong for a Llama 3.1 variant.
      { id: 'hermes-3-llama-3.1-405b', model_spec: { availableContextTokens: 131_072 } },
      // Matches the 'qwen' family row (32k).
      { id: 'e2ee-qwen-2-5-7b-p', model_spec: { availableContextTokens: 32_768 } },
    ])))
    const byId = Object.fromEntries((await listVeniceModels({ force: true })).models.map(m => [m.id, m]))
    expect(byId['olafangensan-glm-4.7-glash-heretic']!.contextTokens).toBe(200_000)
    expect(byId['hermes-3-llama-3.1-405b']!.contextTokens).toBe(131_072)
    expect(byId['e2ee-qwen-2-5-7b-p']!.contextTokens).toBe(32_768)
  })

  it('end to end: Venice\'s number beats the static row it used to be stuck with', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'olafangensan-glm-4.7-glash-heretic', model_spec: { availableContextTokens: 200_000 } },
      { id: 'hermes-3-llama-3.1-405b', model_spec: { availableContextTokens: 131_072 } },
    ])))
    const models = (await listVeniceModels({ force: true })).models

    for (const m of models) {
      const withoutLive = resolveContextWindow(m.id)
      const withLive = resolveContextWindow(m.id, m.contextTokens)
      expect(withoutLive.known, m.id).toBe(false)          // static rows knew nothing
      expect(withLive.source, m.id).toBe('live')
      expect(withLive.tokens, m.id).toBe(m.contextTokens)
      expect(withLive.tokens, m.id).toBeGreaterThan(withoutLive.tokens)
    }
  })

  it('a Venice row without the field publishes NO window rather than a default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      { id: 'quiet-model', model_spec: { capabilities: { supportsVision: true } } },
      { id: 'zero-model', model_spec: { availableContextTokens: 0 } },
      { id: 'no-spec-model' },
    ])))
    for (const m of (await listVeniceModels({ force: true })).models) {
      expect(m, m.id).not.toHaveProperty('contextTokens')
      // …and the consumer then reports the weaker source honestly.
      expect(resolveContextWindow(m.id, m.contextTokens).source, m.id).toBe('assumed')
    }
  })

  it('still parses the capability flags it always did (no regression alongside the window)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => catalog([
      {
        id: 'mistral-31-24b',
        name: 'Mistral 3.1 24B',
        model_spec: {
          availableContextTokens: 131_072,
          capabilities: { supportsVision: true, supportsFunctionCalling: true },
        },
      },
    ])))
    const m = (await listVeniceModels({ force: true })).models[0]!
    expect(m.label).toBe('Mistral 3.1 24B')
    expect(m.vision).toBe(true)
    expect(m.caps).toEqual(['vision', 'tools'])
    expect(m.contextTokens).toBe(131_072)
  })
})

describe('Bankr / Surplus: opportunistic window read', () => {
  // /v1/models has no standard context field, so each gateway invented its own
  // spelling. We sniff the known ones and stay silent when none are present —
  // never defaulting, because a wrong window silently truncates history.
  const cases: Array<[string, (o?: { force?: boolean }) => Promise<{ models: Array<{ id: string; contextTokens?: number }> }>]> = [
    ['bankr', listBankrModels],
    ['surplus', listSurplusModels],
  ]

  for (const [name, list] of cases) {
    it(`${name}: reads each recognised spelling and omits the field when the gateway is silent`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => catalog([
        { id: 'a-context-length', context_length: 200_000 },
        { id: 'b-context-window', context_window: 128_000 },
        { id: 'c-max-model-len', max_model_len: '32768' },
        { id: 'd-silent', name: 'Says Nothing' },
        { id: 'e-junk', context_length: 'plenty' },
      ])))
      const byId = Object.fromEntries((await list({ force: true })).models.map(m => [m.id, m]))
      expect(byId['a-context-length']!.contextTokens).toBe(200_000)
      expect(byId['b-context-window']!.contextTokens).toBe(128_000)
      expect(byId['c-max-model-len']!.contextTokens).toBe(32_768)
      expect(byId['d-silent']).not.toHaveProperty('contextTokens')
      expect(byId['e-junk']).not.toHaveProperty('contextTokens')
    })

    it(`${name}: rows without a usable id are still dropped`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => catalog([
        { id: 'keep-me', context_length: 100 },
        { id: '' }, { name: 'no id' }, { id: 42 },
      ])))
      expect((await list({ force: true })).models.map(m => m.id)).toEqual(['keep-me'])
    })
  }
})
