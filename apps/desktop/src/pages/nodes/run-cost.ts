// apps/desktop/src/pages/nodes/run-cost.ts
//
// NODES-RESEARCH #4: per-node run-cost ESTIMATE for the canvas. Pure and
// honest: it only prices what it can attribute — the model on the provider
// node wired into the agent, chars/4 token math on upstream inputs + the
// produced output.
//
// HONESTY FIX 2026-08-01. The estimate now carries a BASIS as well as a number,
// because "$0" alone was being rendered as "$0 (local)" and in a local-first app
// "local" is read as "my data never left this machine" — a privacy claim, not a
// cost one. Two separate ways that was false:
//   * a genuinely free CLOUD model (`nvidia/nemotron-3-ultra-550b-a55b:free`)
//     prices at $0 and read as "local";
//   * the freellmapi router was in the LOCAL set, but the provider registry
//     classifies its egress as 'cloud' — it is a loopback sidecar that PROXIES
//     to third parties, and it is the default provider in every starter
//     template. It is free, not local.
// Local-ness is therefore taken from the registry's `egress` field (the same
// classifier PRIVATE MODE uses), never from a name.
//
// DEDUPED 2026-08-01. The "free but remote" case was itself a hand-maintained
// id list here, which is the same bug one level up: a second place that has to
// be remembered, and stale the moment a provider is added. Both facts now come
// from the registry — `providerLocality()` for the claim, `billing` for the
// price — and they are asked as two questions, because conflating them is what
// produced "$0 (local)" in the first place.

import { ratesFor } from '@tachi/core/src/pricing'
import { providerLocality, providerBilling } from '@tachi/core/src/providers/registry'
import { canonicalProviderId } from './providerCompat'
import type { TachiNode, TachiEdge, RunCostBasis } from './types'

/**
 * WHY the estimate is what it is (defined in types.ts — it is persisted node
 * data). Drives the chip label, so each value is a claim we must defend:
 *   'priced'  — a real rate was found; the number is an estimate of real money.
 *   'local'   — the provider runs on this machine (registry egress 'local'):
 *               $0 AND no egress.
 *   'free'    — $0, but REMOTE: a free tier / verified-free model, or a loopback
 *               proxy to the cloud. Costs nothing; data still left the machine.
 *   'unknown' — no price is available. NOT $0 — we simply do not know.
 */
export type { RunCostBasis }

export interface RunCostEstimate {
  /** USD estimate, or null when the basis is 'unknown' (never fake a 0). */
  usd: number | null
  /** null = not applicable (not an agent node / no provider wired) → no chip. */
  basis: RunCostBasis | null
}

/**
 * Provider ids that mean "on this machine" but predate / sit outside the
 * registry. `canonicalProviderId` handles the legacy short ids the registry does
 * know ('ollama' → 'ollama-local', 'llamacpp' → 'llama-cpp'); this covers the
 * bare 'local' seen in hand-written flows. Registry `egress` decides everything
 * else.
 */
const EXTRA_LOCAL_IDS = new Set(['local', 'llama-cpp-local'])

/** Assumed output token floor so a one-word answer still shows a non-zero cost path. */
const MIN_OUT_TOKENS = 16

/** The full estimate: number + why. */
export function estimateNodeRunCost(
  nodes: TachiNode[],
  edges: TachiEdge[],
  nodeId: string,
  outputText: string,
): RunCostEstimate {
  const NA: RunCostEstimate = { usd: null, basis: null }
  const node = nodes.find(n => n.id === nodeId)
  if (!node || node.type !== 'agent') return NA

  // The provider node wired INTO this agent decides the model + pricing.
  const providerNode = edges
    .filter(e => e.target === nodeId)
    .map(e => nodes.find(n => n.id === e.source))
    .find(n => n?.type === 'provider')
  if (!providerNode) return NA

  const pd = providerNode.data as { providerId?: unknown; model?: unknown }
  const rawProviderId = String(pd.providerId ?? '').toLowerCase()
  const canonical = canonicalProviderId(rawProviderId)
  // TWO REGISTRY FACTS, ASKED SEPARATELY — never a hand-maintained id list.
  //   locality → may this chip say "local"? (egress, the same derivation the
  //              picker badge uses; 'relay' and 'cloud' both mean it left)
  //   billing  → does it cost anything?
  // The pair replaces FREE_REMOTE_IDS, which re-encoded BOTH facts as the two
  // sidecar ids and would have mislabelled the next provider added to the
  // registry by whoever forgot this file. A free relay (freellmapi, whose model
  // is usually 'auto' and unpriceable) now lands on 'free' because it is free
  // and not local — not because it was listed here.
  if (providerLocality(canonical) === 'local' || EXTRA_LOCAL_IDS.has(canonical)) {
    return { usd: 0, basis: 'local' }
  }
  if (providerBilling(canonical) === 'free') return { usd: 0, basis: 'free' }

  const model = typeof pd.model === 'string' ? pd.model.trim() : ''
  if (!model || model === 'auto') return { usd: null, basis: 'unknown' }
  const rates = ratesFor(model)
  if (!rates) return { usd: null, basis: 'unknown' }

  // Input estimate: upstream outputs + the node's own instructions.
  let inChars = 0
  for (const e of edges.filter(e => e.target === nodeId)) {
    const src = nodes.find(n => n.id === e.source)
    const lo = (src?.data as { lastOutput?: unknown } | undefined)?.lastOutput
    if (typeof lo === 'string') inChars += lo.length
    const prompt = (src?.data as { text?: unknown } | undefined)?.text
    if (typeof prompt === 'string') inChars += prompt.length
  }
  const sys = (node.data as { systemPrompt?: unknown }).systemPrompt
  if (typeof sys === 'string') inChars += sys.length

  const inTok = inChars / 4
  const outTok = Math.max(outputText.length / 4, MIN_OUT_TOKENS)
  const usd = (inTok / 1e6) * rates.inputPerM + (outTok / 1e6) * rates.outputPerM
  if (!isFinite(usd)) return NA
  // A priced-at-zero model is genuinely free — but it is a REMOTE free model
  // (a local provider already returned above), so it must not claim "local".
  return { usd, basis: usd === 0 ? 'free' : 'priced' }
}

/**
 * Back-compat numeric view. Unknown collapses to null exactly as before, so
 * callers that only track a running dollar total are unaffected.
 */
export function estimateNodeRunCostUsd(
  nodes: TachiNode[],
  edges: TachiEdge[],
  nodeId: string,
  outputText: string,
): number | null {
  return estimateNodeRunCost(nodes, edges, nodeId, outputText).usd
}

const ALL_BASES: readonly string[] = ['priced', 'local', 'free', 'unknown']

/**
 * Narrow a value read back out of PERSISTED node data (typed `unknown`) to a
 * basis. Flows saved before 2026-08-01 have none → null, and the chip then makes
 * no local/free claim at all.
 */
export function asRunCostBasis(v: unknown): RunCostBasis | null {
  return typeof v === 'string' && ALL_BASES.includes(v) ? (v as RunCostBasis) : null
}

/** i18n keys (namespace `nodes`) for the qualifier each basis renders. */
const BASIS_LABEL: Record<'local' | 'free' | 'unknown', { key: string; en: string }> = {
  local:   { key: 'costChip.local',   en: 'local' },
  free:    { key: 'costChip.free',    en: 'free cloud' },
  unknown: { key: 'costChip.unknown', en: 'price unknown' },
}

/**
 * Compact chip text: "≈$0.0031" / "≈$0.12" / "$0 (local)" / "$0 (free cloud)" /
 * "$? (price unknown)". Returns null when there is nothing honest to say.
 *
 * `t` is an injected translator — this module stays pure (no react-i18next), and
 * omitting it yields the English source strings, which is what the unit tests
 * assert against.
 */
export function formatCostChip(
  usd: number | null | undefined,
  basis?: RunCostBasis | null,
  t?: (key: string, fallback: string) => string,
): string | null {
  const label = (k: 'local' | 'free' | 'unknown'): string => {
    const { key, en } = BASIS_LABEL[k]
    return t ? t(key, en) : en
  }
  // An unknown price is not zero. Say so rather than showing nothing, so an
  // unpriced run can't be mistaken for a free one.
  if (basis === 'unknown') return `$? (${label('unknown')})`
  if (usd == null) return null
  if (usd === 0) {
    // No basis = a flow saved before the basis was recorded. We cannot tell
    // local from free-remote, so we claim neither.
    if (basis !== 'local' && basis !== 'free') return '$0'
    return `$0 (${label(basis)})`
  }
  if (usd < 0.0001) return '≈$0.0001'
  return usd < 0.01 ? `≈$${usd.toFixed(4)}` : `≈$${usd.toFixed(2)}`
}
