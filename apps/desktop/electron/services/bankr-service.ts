// apps/desktop/electron/services/bankr-service.ts
//
// Thin wrapper around Bankr's LLM Gateway model catalog. The gateway is
// OpenAI-compatible and exposes /v1/models — we cache the list briefly in
// memory so the renderer's picker doesn't refetch on every dropdown open.
//
// Auth: `Authorization: Bearer <bk_*>` (per docs.bankr.bot — the gateway
// also accepts X-API-Key but Bearer is the documented Aeon workflow form
// and matches what we use in chat-service.ts).
import { pickLiveContextTokens } from '@tachi/core'
import { retrieveKey } from './keychain'

const BANKR_BASE_URL = 'https://llm.bankr.bot'
const CACHE_TTL_MS   = 60_000

export interface BankrModel {
  id:        string
  /** Human-readable label (best-effort from /v1/models or fallback formatting). */
  label:     string
  /** Optional family hint for grouping ("Claude", "Gemini", "GPT", "Llama", "Other"). */
  family?:   string
  /** Whether the model came from the live API (vs the static fallback). */
  live:      boolean
  /** The gateway's own context window, when it publishes one. Absent = UNKNOWN
   *  (the caller falls back to the static capability rows and says so). */
  contextTokens?: number
}

interface CatalogResponse {
  ok:      boolean
  models:  BankrModel[]
  /** Set if we returned the fallback catalog because the live fetch failed. */
  stale?:  boolean
  error?:  string
}

// Curated fallback — kept roughly in sync with Bankr's catalog. Used ONLY when
// no key is set or the live /v1/models fetch fails, so the picker always has
// something usable as a pre-auth/offline preview. When a key is present the live
// list overrides this entirely, so new Bankr models surface automatically.
const FALLBACK_CATALOG: BankrModel[] = [
  { id: 'claude-fable-5',    label: 'Claude Fable 5',    family: 'Claude',   live: false },
  { id: 'claude-opus-5',     label: 'Claude Opus 5',     family: 'Claude',   live: false },
  { id: 'claude-sonnet-5',   label: 'Claude Sonnet 5',   family: 'Claude',   live: false },
  { id: 'claude-opus-4.8',   label: 'Claude Opus 4.8',   family: 'Claude',   live: false },
  { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6', family: 'Claude',   live: false },
  { id: 'claude-haiku-4.5',  label: 'Claude Haiku 4.5',  family: 'Claude',   live: false },
  { id: 'gpt-5.5',           label: 'GPT-5.5',           family: 'GPT',      live: false },
  { id: 'gpt-5-mini',        label: 'GPT-5 Mini',        family: 'GPT',      live: false },
  { id: 'gemini-3.1-pro',    label: 'Gemini 3.1 Pro',    family: 'Gemini',   live: false },
  { id: 'gemini-3-flash',    label: 'Gemini 3 Flash',    family: 'Gemini',   live: false },
  { id: 'glm-5.2',           label: 'GLM 5.2',           family: 'GLM',      live: false },
  { id: 'deepseek-v4',       label: 'DeepSeek V4',       family: 'DeepSeek', live: false },
]

let cache: { at: number; models: BankrModel[] } | null = null

function familyOf(id: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('claude')) return 'Claude'
  if (lower.includes('gemini')) return 'Gemini'
  if (lower.includes('gpt') || lower.includes('o3') || lower.includes('o4')) return 'GPT'
  if (lower.includes('glm') || lower.includes('zhipu')) return 'GLM'
  if (lower.includes('deepseek')) return 'DeepSeek'
  if (lower.includes('qwen')) return 'Qwen'
  if (lower.includes('mistral') || lower.includes('mixtral')) return 'Mistral'
  if (lower.includes('grok'))  return 'Grok'
  if (lower.includes('kimi'))  return 'Kimi'
  if (lower.includes('llama')) return 'Llama'
  return 'Other'
}

function prettify(id: string): string {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/Gpt/g, 'GPT')
    .replace(/Glm/g, 'GLM')
}

/**
 * Returns Bankr's model catalog. Live-fetches /v1/models when a key is
 * available; falls back to the curated catalog otherwise. Cached for
 * CACHE_TTL_MS to avoid hammering the gateway on every picker open.
 */
export async function listBankrModels(opts: { force?: boolean } = {}): Promise<CatalogResponse> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ok: true, models: cache.models }
  }
  const key = retrieveKey('bankr-gateway')
  if (!key) {
    // No key — return the static catalog so the picker still works as a
    // pre-auth preview. The chat send-path will surface the missing-key
    // error separately when the user actually tries to chat.
    return { ok: true, models: FALLBACK_CATALOG, stale: true, error: 'No Bankr key configured' }
  }
  try {
    const res = await fetch(`${BANKR_BASE_URL}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal:  AbortSignal.timeout(5_000) as AbortSignal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // Row shape is deliberately open: /v1/models has no standard context field,
    // so pickLiveContextTokens sniffs the spellings gateways actually use and
    // returns undefined when Bankr publishes none — we then leave the field off
    // and the static capability rows answer instead.
    type RawRow = { id?: string; name?: string } & Record<string, unknown>
    const body = await res.json() as { data?: RawRow[] }
    const items = Array.isArray(body.data) ? body.data : []
    const models: BankrModel[] = items
      .filter((m): m is RawRow & { id: string } => typeof m.id === 'string' && m.id.length > 0)
      .map(m => {
        const ctx = pickLiveContextTokens(m)
        return {
          id: m.id, label: prettify(m.id), family: familyOf(m.id), live: true,
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

export function bankrBaseUrl(): string { return BANKR_BASE_URL }
