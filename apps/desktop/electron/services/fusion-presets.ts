// Shared Fusion panel/judge selection — used by both the chat-service forks and
// the agentic consult_panel tool. Per-provider presets resolved against each
// provider's LIVE catalog so we send real versioned ids.
import { listBankrModels } from './bankr-service'
import { listVeniceModels } from './venice-service'
import { listSurplusModels } from './surplus-service'

export type FusionPreset = 'budget' | 'frontier'

// BUDGET = cheap cross-family; FRONTIER = top models. Patterns are matched
// (case-insensitive substring) against the live catalog; an unmatched pattern
// passes through as-is (and fails soft in runFusion). Venice is OSS-only.
export const FUSION_PRESETS: Record<string, Record<FusionPreset, { panel: string[]; judge: string }>> = {
  'bankr-gateway': {
    budget:   { panel: ['claude-haiku', 'gemini-3-flash', 'gpt-5-mini'], judge: 'claude-sonnet-4.6' },
    // frontier = the plan-Fusion panel (fuse_plan / consult_panel). Patterns are
    // substring-matched against Bankr's live catalog; glm-5.2 falls soft if Bankr
    // doesn't serve it (the leg errors, the judge synthesizes from the rest).
    frontier: { panel: ['claude-opus-5', 'gpt-5.5', 'glm-5.2'], judge: 'claude-opus-5' },
  },
  'venice': {
    budget:   { panel: ['qwen3-30b', 'mistral-small', 'llama-3.3-70b'], judge: 'glm-4' },
    frontier: { panel: ['deepseek-v4', 'glm-5', 'qwen3-235b'], judge: 'glm-5' },
  },
  'surplus': {
    budget:   { panel: ['claude-haiku', 'gemini-3-flash', 'gpt-5-mini'], judge: 'claude-sonnet' },
    frontier: { panel: ['claude-opus', 'gpt-5.5', 'gemini-3.1-pro'], judge: 'claude-opus' },
  },
}

const fusionCatalog = (providerId: string): Promise<{ models: { id: string }[] }> =>
  providerId === 'venice'  ? listVeniceModels()
  : providerId === 'surplus' ? listSurplusModels()
  : listBankrModels()

/**
 * Resolve a Fusion panel + judge to real catalog ids for the given provider +
 * preset. Explicit reqPanel/reqJudge override the preset. Patterns are matched
 * (case-insensitive substring) against the provider's live catalog.
 */
export async function resolveFusion(
  providerId: string,
  preset: FusionPreset,
  reqPanel?: string[],
  reqJudge?: string,
): Promise<{ panel: string[]; judge: string }> {
  const presets = FUSION_PRESETS[providerId] ?? FUSION_PRESETS['bankr-gateway']
  const def = presets[preset] ?? presets.budget
  let catalog: string[] = []
  try { catalog = (await fusionCatalog(providerId)).models.map(m => m.id) } catch { /* offline */ }
  // Local panel legs (UX #6) are namespaced `ollama:<model>` / `llamacpp:<id>`
  // and must NEVER be substring-matched against the cloud catalog — they pass
  // through verbatim and are routed by the local-aware backend.
  const isLocal = (id: string) => id.startsWith('ollama:') || id.startsWith('llamacpp:')
  const match = (pat: string): string =>
    isLocal(pat) ? pat : (catalog.find(id => id.toLowerCase().includes(pat.toLowerCase())) ?? pat)
  const wantPanel = reqPanel && reqPanel.length > 0 ? reqPanel : def.panel
  const panel = [...new Set(wantPanel.map(match))]
  const judge = match(reqJudge?.trim() || def.judge)
  return { panel, judge }
}
