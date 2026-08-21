// packages/core/src/providers/agent-route.ts
//
// THE single source of truth for the agent harnesses' OpenGateway model pin
// and for the 'default' provider ladder's pick. Pure (no I/O, no keychain) so
// BOTH sides import the same facts:
//
//   main:     tachi/provider.ts (resolveTachiRouting) and sidecar-manager.ts
//             (startOpenClaude) route with these values;
//   renderer: the Code tab's model badge, provider hints, chain row, cost hint
//             and context meter DISPLAY these values.
//
// History that shaped this file (2026-08-01): both harnesses pinned
// 'mimo-v2.5-pro' for opengateway while the badge and hints said
// "nemotron-3-ultra :free" — the pin predated the gateway's 2026-07-16 move to
// pay-as-you-go (MiMo was free when it was written), so the UI told users a
// free model ran while a paid one billed. The fix is twofold: the routing
// moved to the verified-free nemotron (owner decision), and the id now lives
// HERE so a label can never again be written apart from the routing.

import { getProvider, providerBilling } from './registry.js'
import { isVerifiedFreeModel } from '../pricing.js'

/**
 * The model BOTH agent harnesses (TACHI + openclaude) pin for OpenGateway
 * routes — explicit picks and the default ladder's opengateway rung alike.
 *
 * 'nvidia/nemotron-3-ultra-550b-a55b:free' is the one unconditionally-free
 * OpenGateway model (catalog read 2026-08-01: pricing all "0", promo: null —
 * see VERIFIED_FREE_MODELS in pricing.ts) and its capability row
 * (tachi/models.ts 'nemotron-3-ultra') is agent-capable: 1M context, tools
 * with salvage armed. Both facts are pinned by agent-route.test.ts — if either
 * stops being true, change this id, don't relax the test.
 *
 * OPERATIONAL LIMIT: OpenGateway free models carry a daily quota
 * ("free-models-per-day"). When it is exhausted the gateway answers 429 with
 * its own error body; the harness error path surfaces that honestly (TACHI:
 * format-error.ts renders "message (HTTP 429, code …)" into the run log;
 * openclaude: the wrapper's /preflight + SDK error stream carry the body).
 * No client-side quota bookkeeping — the gateway's answer is the truth.
 */
export const OPENGATEWAY_AGENT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free'

/** What the 'default' agent provider would actually run, given stored keys. */
export interface DefaultAgentRoute {
  providerId: 'opengateway' | 'bankr-gateway' | 'freellmapi-local'
  modelId: string
  /**
   * Derived from pricing/registry facts (isVerifiedFreeModel / providerBilling)
   * — NEVER hand-set. A surface may render a FREE label only when this is true.
   */
  free: boolean
}

/**
 * The 'default' provider ladder, as ONE pure decision both sides share:
 * OpenGateway key → Bankr key → local freellmapi router. main resolves keys
 * from the keychain and routes; the renderer resolves key PRESENCE from
 * settings.listKeys() and labels. Same function, so label and route cannot
 * drift.
 *
 * NOTE: this mirrors the TACHI (default) harness ladder. The openclaude
 * sidecar's default ladder has no Bankr rung (opengateway key → freellmapi),
 * so for a bankr-key-only user on openclaude this is conservative: it reports
 * the PAID bankr rung while openclaude would actually fall to the free router.
 * Conservative is the right direction — a FREE label must never cover a path
 * that can pick a paid key.
 */
export function pickDefaultAgentRoute(keys: { opengateway: boolean; bankr: boolean }): DefaultAgentRoute {
  if (keys.opengateway) {
    return {
      providerId: 'opengateway',
      modelId: OPENGATEWAY_AGENT_MODEL,
      free: isVerifiedFreeModel(OPENGATEWAY_AGENT_MODEL),
    }
  }
  if (keys.bankr) {
    // The auto-pick for a Bankr key with no explicit model choice — the
    // registry row's defaultModel (claude-sonnet-4.6), a PAID model.
    const modelId = getProvider('bankr-gateway')?.defaultModel ?? 'claude-sonnet-4.6'
    return { providerId: 'bankr-gateway', modelId, free: isVerifiedFreeModel(modelId) }
  }
  // Terminal rung: the local free router. Its registry billing fact is 'free'
  // (it fans out to verified-free upstreams); 'auto' is its routing id.
  return {
    providerId: 'freellmapi-local',
    modelId: 'auto',
    free: providerBilling('freellmapi-local') === 'free',
  }
}
