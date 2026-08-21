// apps/desktop/electron/services/tachi/provider.ts
//
// Resolves the active agent provider into an AI SDK v6 LanguageModel for the
// TACHI harness. Reuses the SAME provider override the Agent UI already sets
// (AgentProviderOverride) and the SAME keychain ids the openclaude
// sidecars read, so TACHI talks to whatever the user already configured —
// Bankr / Surplus / Venice / OpenGateway, or the local freellmapi router as the
// default ladder. Anthropic-direct is a later addition (v2); v1 is
// OpenAI-compatible across the gateway zoo.
//
// API verified against installed @ai-sdk/openai-compatible 2.0.48:
//   createOpenAICompatible({ name, baseURL, apiKey, headers?, queryParams?, fetch? })
//     → provider(modelId) : LanguageModelV2

import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { ProviderId } from '@tachi/core'
// OPENGATEWAY_AGENT_MODEL + pickDefaultAgentRoute are THE shared routing facts
// (packages/core/src/providers/agent-route.ts): the renderer's badge/hints
// import the same symbols, so what we route here is what the UI says — by
// construction, not by keeping two strings in sync.
import { OPENGATEWAY_AGENT_MODEL, pickDefaultAgentRoute } from '@tachi/core'
import { singleToolCallFetch, toolCallIndexFixFetch } from './wire'
import { retrieveKey } from '../keychain'
import {
  getAgentProviderOverride,
  getFreellmapiPort,
  getFreellmapiApiKey,
} from '../sidecar-manager'

// Public gateway base URLs — kept in sync with sidecar-manager.ts. These are
// stable third-party endpoints; duplicating the constant here avoids exporting
// sidecar-manager internals just for the harness.
const OPENGATEWAY_BASE_URL = 'https://opengateway.gitlawb.com/v1'
const BANKR_BASE_URL       = 'https://llm.bankr.bot/v1'
const VENICE_BASE_URL      = 'https://api.venice.ai/api/v1'
const SURPLUS_BASE_URL     = 'https://www.surplusintelligence.ai/api/inference/v1'
// imgnAI Katana — bearer = the COMBINED credential stored under 'imgnai'.
const IMGNAI_BASE_URL      = 'https://kat.imgnai.com/v1'

/** The fully-resolved routing for a TACHI session's LLM calls. */
export interface TachiRouting {
  /** AI SDK language model, ready to hand to streamText. */
  model: LanguageModel
  /** The model id actually selected (for the capability catalog + UI badge). */
  modelId: string
  /**
   * The CANONICAL provider actually serving this session (registry vocabulary —
   * same ids chat-service records). This is the fact; `modelId` is a guess,
   * because a model NAME cannot tell you who ran it.
   *
   * Load-bearing for money (2026-08-01): runTachiSession records every usage
   * event under this id, and the cost ledger's LOCAL_FREE_PROVIDERS check keys
   * off it. Before this field the ledger was told 'tachi' for every run, which
   * matched nothing — so a run on the free local router was priced at cloud
   * rates (or, after the unknown-price fix, charged the unknown estimate) and
   * ate a spend cap it had cost nothing to reach.
   */
  providerId: ProviderId
  /** Human label of the gateway, for logs/telemetry. */
  providerLabel: string
  /** Core-backend gateway id for agentic Fusion (consult_panel) — set only for
   *  gateways with a core ChatBackend (bankr/venice/surplus); undefined otherwise. */
  fusionProviderId?: 'bankr-gateway' | 'venice' | 'surplus'
}

export class TachiProviderError extends Error {
  constructor(msg: string) { super(msg); this.name = 'TachiProviderError' }
}

// Request shaping (single tool calls) over response repair (dense tool_call
// indices — gateways that omit/skip `index` crash the SDK assembler otherwise).
const tachiFetch = singleToolCallFetch(toolCallIndexFixFetch())

function compat(name: string, baseURL: string, apiKey: string, modelId: string): LanguageModel {
  const provider = createOpenAICompatible({ name, baseURL, apiKey, includeUsage: true, fetch: tachiFetch } as Parameters<typeof createOpenAICompatible>[0])
  return provider(modelId)
}

/**
 * Resolve the active agent routing. Mirrors the priority ladder in
 * sidecar-manager.startOpenClaude(): explicit override wins, else
 * OpenGateway key, else Bankr key, else the local freellmapi router.
 * Throws TachiProviderError with an actionable message when a chosen cloud
 * gateway has no key on file.
 */
export function resolveTachiRouting(): TachiRouting {
  const ov = getAgentProviderOverride()

  if (ov.kind === 'bankr') {
    const key = retrieveKey('bankr-gateway')
    if (!key) throw new TachiProviderError('Bankr selected but no Bankr Gateway key. Add one in Studio → Providers.')
    return { model: compat('bankr', BANKR_BASE_URL, key, ov.model), modelId: ov.model, providerId: 'bankr-gateway', providerLabel: `bankr (${ov.model})`, fusionProviderId: 'bankr-gateway' }
  }
  if (ov.kind === 'surplus') {
    const key = retrieveKey('surplus')
    if (!key) throw new TachiProviderError('Surplus selected but no Surplus key. Add one in Settings → Surplus Intelligence.')
    return { model: compat('surplus', SURPLUS_BASE_URL, key, ov.model), modelId: ov.model, providerId: 'surplus', providerLabel: `surplus (${ov.model})`, fusionProviderId: 'surplus' }
  }
  if (ov.kind === 'venice') {
    const key = retrieveKey('venice')
    if (!key) throw new TachiProviderError('Venice selected but no Venice key. Add one in Settings → Venice.')
    return { model: compat('venice', VENICE_BASE_URL, key, ov.model), modelId: ov.model, providerId: 'venice', providerLabel: `venice (${ov.model})`, fusionProviderId: 'venice' }
  }
  if (ov.kind === 'imgnai') {
    const key = retrieveKey('imgnai')
    if (!key) throw new TachiProviderError('Add your imgnAI API key in Settings → imgnAI Katana.')
    // No fusionProviderId — imgnAI has no core ChatBackend for consult_panel/fuse_plan.
    return { model: compat('imgnai', IMGNAI_BASE_URL, key, ov.model), modelId: ov.model, providerId: 'imgnai', providerLabel: `imgnai (${ov.model})` }
  }
  if (ov.kind === 'opengateway') {
    // Explicit pick works keyless: the pinned model is verified free (no
    // credits needed). 2026-08-01: repointed from the fossil 'mimo-v2.5-pro'
    // pin (MiMo was free when pinned, went paid 07-16 — the badge kept saying
    // a free model ran while mimo billed). Free models carry OpenGateway's
    // per-day quota; on exhaustion the gateway 429s and the loop's error
    // formatter surfaces its body — no client-side quota bookkeeping.
    const key = retrieveKey('opengateway') ?? ''
    const modelId = OPENGATEWAY_AGENT_MODEL
    return { model: compat('opengateway', OPENGATEWAY_BASE_URL, key, modelId), modelId, providerId: 'opengateway', providerLabel: `opengateway (${modelId})` }
  }

  // default ladder: OpenGateway key → Bankr key → local freellmapi router.
  // The PICK comes from pickDefaultAgentRoute — the same pure function the
  // renderer labels with — so the FREE/AUTO label and the actual route share
  // one decision. Only the key material and model construction live here.
  const ogwKey   = retrieveKey('opengateway')
  const bankrKey = retrieveKey('bankr-gateway')
  const route    = pickDefaultAgentRoute({ opengateway: !!ogwKey, bankr: !!bankrKey })
  if (route.providerId === 'opengateway') {
    return { model: compat('opengateway', OPENGATEWAY_BASE_URL, ogwKey!, route.modelId), modelId: route.modelId, providerId: 'opengateway', providerLabel: `opengateway (${route.modelId})` }
  }
  if (route.providerId === 'bankr-gateway') {
    return { model: compat('bankr', BANKR_BASE_URL, bankrKey!, route.modelId), modelId: route.modelId, providerId: 'bankr-gateway', providerLabel: `bankr-auto (${route.modelId})`, fusionProviderId: 'bankr-gateway' }
  }
  const port = getFreellmapiPort()
  const key  = getFreellmapiApiKey()
  if (!port || !key) {
    throw new TachiProviderError(
      'No agent provider configured. Add a Bankr/OpenGateway/Venice/Surplus key, or start the freellmapi sidecar (Studio → Providers).',
    )
  }
  const modelId = 'auto'
  // 'freellmapi-local' is the registry id for this loopback router. It bills
  // nothing (it fans out to free upstreams), which is why the ledger treats it
  // as known-FREE rather than unknown — its 'auto' model id is unpriceable by
  // construction and must not be charged the unknown-price estimate.
  return { model: compat('freellmapi', `http://127.0.0.1:${port}/v1`, key, modelId), modelId, providerId: 'freellmapi-local', providerLabel: 'freellmapi (auto)' }
}
