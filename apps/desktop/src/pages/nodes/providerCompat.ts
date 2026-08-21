// apps/desktop/src/pages/nodes/providerCompat.ts
//
// Bridges the Nodes canvas to the unified provider registry (packages/core) —
// the single source of truth for providers/models across chat, agents, and
// nodes. This module:
//   - normalizes legacy short node ids ('bankr', 'ollama', ...) to canonical
//     registry ids ('bankr-gateway', 'ollama-local', ...). The graph compiler
//     (graph-to-agentkit.ts mapProviderId) accepts BOTH, so flows saved with
//     the old short ids keep working.
//   - exposes the subset of providers the agent-kit runtime can actually
//     compile, so the palette/config dropdowns list only what a graph can run.
//
// Imported via the `@tachi/core/src/...` subpath to keep the Node-only core
// barrel out of the renderer bundle.
import { getProvider, type ProviderDescriptor, type ProviderId } from '@tachi/core/src/providers/registry'

// Canonical ids the Nodes/agent-kit runtime can compile, in palette display
// order. Mirrors mapProviderId() in graph-to-agentkit.ts. Anthropic / OpenRouter
// / free-claude-code are intentionally excluded — no agent-kit adapter yet.
export const GRAPH_PROVIDER_IDS: ProviderId[] = [
  'bankr-gateway',
  'opengateway',
  'surplus',
  'venice',
  'imgnai',
  'ollama-local',
  'llama-cpp',
  'freellmapi-local',
]

// Legacy short node ids → canonical registry ids (flows saved before the
// registry migration). Used for display + live-model-fetch branching in the
// node components.
const LEGACY_TO_CANONICAL: Record<string, ProviderId> = {
  bankr:      'bankr-gateway',
  ollama:     'ollama-local',
  llamacpp:   'llama-cpp',
  freellmapi: 'freellmapi-local',
  anthropic:  'anthropic-oauth',
}

/** Normalize any provider id (legacy short OR canonical) to the canonical form. */
export function canonicalProviderId(id: string | null | undefined): string {
  if (!id) return ''
  return LEGACY_TO_CANONICAL[id] ?? id
}

/**
 * Display endpoint hint for a provider node. Deliberately NON-absolute (no
 * scheme) so graph-to-agentkit's asAbsoluteUrl() ignores it and uses the
 * agent-kit adapter's built-in base URL — i.e. this is a label, not config.
 */
export function providerEndpointHint(id: string): string {
  const c = canonicalProviderId(id)
  const d = getProvider(c)
  if (d?.baseUrl) return d.baseUrl.replace(/^https?:\/\//, '')
  if (c === 'ollama-local')     return 'localhost:11434'
  if (c === 'freellmapi-local') return 'localhost:8080'
  if (c === 'llama-cpp')        return 'local llama-server'
  return ''
}

export interface GraphProviderSeed {
  providerId: ProviderId
  label: string
  model: string
  endpoint: string
}

/** Registry-derived seeds for the graph-capable providers, in display order. */
export function graphProviderSeeds(): GraphProviderSeed[] {
  return GRAPH_PROVIDER_IDS
    .map(id => getProvider(id))
    .filter((d): d is ProviderDescriptor => !!d)
    .map(d => ({
      providerId: d.id,
      label:      d.label,
      model:      d.defaultModel ?? 'auto',
      endpoint:   providerEndpointHint(d.id),
    }))
}
