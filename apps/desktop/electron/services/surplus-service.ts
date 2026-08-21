// apps/desktop/electron/services/surplus-service.ts
//
// Thin wrapper around Surplus Intelligence's model catalog. Surplus is a
// crypto-native, OpenAI-compatible LLM marketplace on Base (USDC settlement).
// The canonical Bearer route is a drop-in OpenAI-compatible API — we hit
// /api/inference/v1/models and cache briefly so the renderer's picker doesn't
// refetch on every dropdown open. Mirrors bankr-service.ts.
//
// Auth: `Authorization: Bearer <inf_*>`. Key acquisition is web3 (SIWE +
// USDC allowance on Base) — see the "Get a key" link in SettingsPage.
//
// NOTE: the base path is `/api/inference/v1`, NOT a bare `/v1`.
import { pickLiveContextTokens } from '@tachi/core'
import { retrieveKey } from './keychain'

const SURPLUS_BASE_URL = 'https://www.surplusintelligence.ai/api/inference/v1'
const CACHE_TTL_MS      = 60_000

export interface SurplusModel {
  id:      string
  /** Human-readable label (best-effort from /models or fallback formatting). */
  label:   string
  /** Optional family hint for grouping ("Claude", "Gemini", "GPT", …). */
  family?: string
  /** Whether the model came from the live API (vs the static fallback). */
  live:    boolean
  /** Surplus's own context window, when it publishes one. Absent = UNKNOWN
   *  (the caller falls back to the static capability rows and says so). */
  contextTokens?: number
}

interface CatalogResponse {
  ok:     boolean
  models: SurplusModel[]
  /** Set if we returned the fallback catalog because the live fetch failed. */
  stale?: boolean
  error?: string
}

// Curated fallback — a small representative slice of Surplus's live catalog.
// Used when no key is set or the live fetch fails so the picker always has
// something usable. The live /models fetch overwrites this with the full list.
const FALLBACK_CATALOG: SurplusModel[] = [
  { id: 'claude-opus-4.6',          label: 'Claude Opus 4.6',     family: 'Claude',   live: false },
  { id: 'claude-sonnet-4.5',        label: 'Claude Sonnet 4.5',   family: 'Claude',   live: false },
  { id: 'claude-haiku-4.5',         label: 'Claude Haiku 4.5',    family: 'Claude',   live: false },
  { id: 'gpt-5.4',                  label: 'GPT-5.4',             family: 'GPT',      live: false },
  { id: 'gpt-5-mini',               label: 'GPT-5 Mini',          family: 'GPT',      live: false },
  { id: 'gemini-3.1-pro',           label: 'Gemini 3.1 Pro',      family: 'Gemini',   live: false },
  { id: 'gemini-2.5-flash',         label: 'Gemini 2.5 Flash',    family: 'Gemini',   live: false },
  { id: 'deepseek-v3.2',            label: 'DeepSeek V3.2',       family: 'DeepSeek', live: false },
  { id: 'qwen3-235b-a22b-2507',     label: 'Qwen3 235B A22B',     family: 'Qwen',     live: false },
  { id: 'llama-3.3-70b-instruct',   label: 'Llama 3.3 70B',       family: 'Llama',    live: false },
  { id: 'mistral-large',            label: 'Mistral Large',       family: 'Mistral',  live: false },
  // NOT `grok-4`: xAI retired that line on 2026-05-15 and now SILENTLY
  // redirects it to grok-4.3 — no error, no 404 — so offering it here handed
  // the user a different model than the row said, at a different price than we
  // charged. xAI's own model index points new work at Grok 4.5 for everything
  // except the cases it names, so that is what the picker offers.
  // The retired id keeps a correct PRICE (pricing.ts::RETIRED_MODELS) so a saved
  // conversation pinned to it still costs out — it just stops being offered.
  { id: 'grok-4.5',                 label: 'Grok 4.5',            family: 'Grok',     live: false },
  { id: 'kimi-k2',                  label: 'Kimi K2',             family: 'Other',    live: false },
]

let cache: { at: number; models: SurplusModel[] } | null = null

function familyOf(id: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('claude'))   return 'Claude'
  if (lower.includes('gemini'))   return 'Gemini'
  if (lower.includes('gpt'))      return 'GPT'
  if (lower.includes('llama'))    return 'Llama'
  if (lower.includes('deepseek')) return 'DeepSeek'
  if (lower.includes('qwen'))     return 'Qwen'
  if (lower.includes('mistral'))  return 'Mistral'
  if (lower.includes('grok'))     return 'Grok'
  return 'Other'
}

function prettify(id: string): string {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/Gpt/g, 'GPT')
}

/**
 * Returns Surplus's model catalog. Live-fetches /models when a key is
 * available; falls back to the curated catalog otherwise. Cached for
 * CACHE_TTL_MS to avoid hammering the gateway on every picker open.
 */
export async function listSurplusModels(opts: { force?: boolean } = {}): Promise<CatalogResponse> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ok: true, models: cache.models }
  }
  const key = retrieveKey('surplus')
  if (!key) {
    return { ok: true, models: FALLBACK_CATALOG, stale: true, error: 'No Surplus key configured' }
  }
  try {
    const res = await fetch(`${SURPLUS_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}`, 'Accept-Encoding': 'identity' },
      signal:  AbortSignal.timeout(8_000) as AbortSignal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // Open row shape: /v1/models has no standard context field, so
    // pickLiveContextTokens sniffs the spellings gateways actually use and
    // returns undefined when Surplus publishes none — we then leave the field
    // off and the static capability rows answer instead.
    type RawRow = { id?: string; name?: string } & Record<string, unknown>
    const body = await res.json() as { data?: RawRow[] }
    const items = Array.isArray(body.data) ? body.data : []
    const models: SurplusModel[] = items
      .filter((m): m is RawRow & { id: string } => typeof m.id === 'string' && m.id.length > 0)
      .map(m => {
        const ctx = pickLiveContextTokens(m)
        return {
          id: m.id,
          label: typeof m.name === 'string' && m.name ? m.name : prettify(m.id),
          family: familyOf(m.id), live: true,
          ...(ctx === undefined ? {} : { contextTokens: ctx }),
        }
      })
    if (models.length === 0) throw new Error('Empty model list')
    cache = { at: Date.now(), models }
    return { ok: true, models }
  } catch (err) {
    return {
      ok:     true,
      models: FALLBACK_CATALOG,
      stale:  true,
      error:  err instanceof Error ? err.message : String(err),
    }
  }
}

export function surplusBaseUrl(): string { return SURPLUS_BASE_URL }
