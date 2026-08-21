import { ModelInfo } from '../../chat/backend.js'

// Keys are FAMILY-level substrings on purpose, so a new version inside a known
// family needs no edit here — 'claude-opus' covers claude-opus-4.8 AND the
// Claude 5 family id claude-opus-5, 'claude-sonnet' covers claude-sonnet-5.
const TIER_HINTS: Record<string, ModelInfo['tier']> = {
  'claude-haiku': 'fast',
  'claude-sonnet': 'balanced',
  'claude-opus': 'powerful',
  'gpt-4o-mini': 'fast',
  'gpt-4o': 'balanced',
  'gemini-flash': 'fast',
  'gemini-pro': 'balanced',
}

function inferTier(modelId: string): ModelInfo['tier'] | undefined {
  for (const [key, tier] of Object.entries(TIER_HINTS)) {
    if (modelId.toLowerCase().includes(key)) return tier
  }
  return undefined
}

export async function fetchBankrModels(
  apiKey: string,
  fetchFn: typeof fetch = fetch
): Promise<ModelInfo[]> {
  const res = await fetchFn('https://llm.bankr.bot/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Models fetch failed: ${res.status}`)
  const data = await res.json() as { data: Array<{ id: string }> }
  return data.data.map(m => ({
    id: m.id,
    displayName: m.id,
    tier: inferTier(m.id),
    isDefault: m.id.toLowerCase().includes('sonnet'),
  }))
}
