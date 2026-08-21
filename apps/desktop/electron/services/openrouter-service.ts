// apps/desktop/electron/services/openrouter-service.ts
//
// OpenRouter live text-model catalog for the chat model picker, carrying the
// PER-MODEL FREE SIGNAL the free-fleet sweep called for
// (docs/app/FREE-FLEET-SWEEP-2026-08-01.md §3):
//
//   free ⇔ live `pricing.prompt === 0 AND pricing.completion === 0`
//
// NEVER from the `:free` id suffix (a name, not a price — 322 of 336 OpenRouter
// models are paid), and never a provider-level billing flip: the registry's
// `openrouter-oauth` stays billing 'paid' because the provider is genuinely
// mixed. The catalog endpoint answers KEYLESS (probed 2026-08-01: 200, 336
// models), so the picker works before sign-in too; the OAuth key is attached
// when present only because it may unlock account-scoped rows.
//
// LIMITS (OpenRouter docs, quoted in the sweep): free models are capped at
// "20" requests/min and "50" requests/day without purchased credits ("1000"/day
// with ≥$10 of credits). Surfaced as picker copy — not enforced here.
//
// ── LIVE PER-MODEL RATES (2026-08-02) ────────────────────────────────────────
// The `free` boolean above was DERIVED from `pricing`, and then the rest of the
// payload was thrown away. That was the whole reason 281 of 337 rows showed no
// price band in the picker: the resolver refuses to price a row from the static
// table's keyword fallback (a rate guessed from a NAME is not a fact you may
// show a user), and the only per-model number we kept was "is it zero".
//
// The number was already on the wire. We now keep the full `pricing` object —
// prompt, completion, and the cache read/write rates OpenRouter also publishes —
// converted from its per-token strings to the $/M the rest of the app speaks.
// `free` is still computed from the same payload, so the two can never disagree.
//
// TWO CONSUMERS, DELIBERATELY DIFFERENT:
//   · the PICKER wants the rate as it is RIGHT NOW, because the user is about to
//     start a job at that rate. It reads these live values.
//   · the COST LEDGER prices a run AFTER it happened, so it must use the rate
//     that was in force at the time. It reads a live rate only at record() time
//     and stamps the resulting dollar figure onto the event — it never re-derives
//     a stored event's cost from a later catalog. See cost-ledger.ts.
import { pickLiveContextTokens, type ModelRates } from '@tachi/core'
import { retrieveKey } from './keychain'
import { registerLiveRateResolver } from './cost-ledger'

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const CACHE_TTL_MS          = 60_000

export interface OpenrouterModel {
  id:    string
  label: string
  /** Context length from the live catalog, when published. */
  contextTokens?: number
  /** LIVE pricing signal: prompt AND completion priced at exactly 0. */
  free:  boolean
  /** Came from the live catalog (vs the curated fallback). */
  live:  boolean
  /**
   * LIVE per-model $/M rates from the same `pricing` object `free` is derived
   * from. Present only on `live` rows whose prompt AND completion prices both
   * parsed — a half-published price is no price, so the field is omitted rather
   * than filled with a zero that would read as "free".
   */
  rates?: ModelRates
}

interface CatalogResponse {
  ok:     boolean
  models: OpenrouterModel[]
  stale?: boolean
  error?: string
}

// Curated fallback when the live fetch fails — the router id plus the free rows
// VERIFIED against the live catalog on 2026-08-01 (pricing 0/0; the same dated
// set pricing.ts::VERIFIED_FREE_MODELS carries). A static `free: true` here is
// a dated whitelist entry, not a suffix rule. live:false marks the staleness.
const FALLBACK: OpenrouterModel[] = [
  { id: 'openrouter/auto', label: 'Auto (best for prompt)', free: false, live: false },
  ...[
    ['nvidia/nemotron-3-ultra-550b-a55b:free', 1_000_000],
    ['google/gemma-4-31b-it:free', 262_144],
    ['google/gemma-4-26b-a4b-it:free', 262_144],
    ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 256_000],
    ['nvidia/nemotron-nano-12b-v2-vl:free', 128_000],
    ['nvidia/nemotron-3-super-120b-a12b:free', 262_144],
    ['inclusionai/ling-3.0-flash:free', 262_144],
    ['poolside/laguna-s-2.1:free', 262_144],
    ['poolside/laguna-xs-2.1:free', 262_144],
    ['cohere/north-mini-code:free', 256_000],
    ['nvidia/nemotron-3-nano-30b-a3b:free', 256_000],
    ['nvidia/nemotron-nano-9b-v2:free', 128_000],
    ['nvidia/nemotron-3.5-content-safety:free', 128_000],
    ['openai/gpt-oss-20b:free', 131_072],
  ].map(([id, ctx]) => ({
    id: id as string, label: id as string, contextTokens: ctx as number, free: true, live: false,
  })),
]

let cache: { at: number; models: OpenrouterModel[] } | null = null

/**
 * Strictly-zero test for OpenRouter's string-typed per-token prices. The
 * catalog publishes "0" for free rows; Number('') and Number(undefined-ish
 * shapes) must NOT read as zero, so absence or an empty string is "not free"
 * (claim-nothing default, same posture as providerBilling()).
 */
function isZeroPrice(v: unknown): boolean {
  if (typeof v === 'number') return v === 0
  if (typeof v !== 'string' || v.trim() === '') return false
  const n = Number(v)
  return Number.isFinite(n) && n === 0
}

/**
 * OpenRouter's per-TOKEN price string → $/M, or null when the field is absent,
 * empty, unparseable or negative. Same claim-nothing posture as isZeroPrice():
 * a price we cannot read is not a price, and must never become 0 — that is the
 * exact confusion between "free" and "unknown" the free-signal fix removed.
 */
function perMillion(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v * 1e6 : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n * 1e6 : null
}

/**
 * The live `pricing` object → ModelRates, or null when either half is missing.
 * Cache rates are optional: OpenRouter publishes `input_cache_read` /
 * `input_cache_write` for some models and omits them for others, and an omitted
 * one correctly falls back to the shared 0.1× / 1.25× heuristic downstream.
 */
function ratesFromPricing(p: { prompt?: unknown; completion?: unknown } & Record<string, unknown>): ModelRates | null {
  const inputPerM = perMillion(p.prompt)
  const outputPerM = perMillion(p.completion)
  if (inputPerM === null || outputPerM === null) return null
  const cacheReadPerM = perMillion(p.input_cache_read)
  const cacheWritePerM = perMillion(p.input_cache_write)
  return {
    inputPerM,
    outputPerM,
    ...(cacheReadPerM !== null ? { cacheReadPerM } : {}),
    ...(cacheWritePerM !== null ? { cacheWritePerM } : {}),
  }
}

/**
 * OpenRouter model catalog with the per-model free flag. Free rows sort first
 * (after the auto router) so the free fleet is visible without scrolling 336
 * rows; within each group the catalog's own order is kept.
 */
export async function listOpenrouterModels(opts: { force?: boolean } = {}): Promise<CatalogResponse> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ok: true, models: cache.models }
  }
  try {
    const key = retrieveKey('openrouter-oauth')
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: {
        Accept: 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      signal: AbortSignal.timeout(8_000) as AbortSignal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // `context_length` is OpenRouter's own field and stays the primary source;
    // pickLiveContextTokens reads it first and only falls back to
    // `top_provider.context_length` when the top-level one is missing.
    type RawModel = {
      id?: string
      name?: string
      pricing?: { prompt?: unknown; completion?: unknown } & Record<string, unknown>
    } & Record<string, unknown>
    const body = await res.json() as { data?: RawModel[] }
    const items = Array.isArray(body.data) ? body.data : []
    const seen = new Set<string>()
    const mapped: OpenrouterModel[] = []
    for (const m of items) {
      if (typeof m.id !== 'string' || m.id.length === 0 || seen.has(m.id)) continue
      seen.add(m.id)
      // Both come from the SAME payload, so "is it free" and "what does it
      // cost" can never contradict each other on a row.
      const rates = m.pricing ? ratesFromPricing(m.pricing) : null
      mapped.push({
        id:    m.id,
        label: typeof m.name === 'string' && m.name ? m.name : m.id,
        contextTokens: pickLiveContextTokens(m),
        // THE free signal: both live prices exactly zero. Never the id suffix.
        free:  isZeroPrice(m.pricing?.prompt) && isZeroPrice(m.pricing?.completion),
        live:  true,
        ...(rates ? { rates } : {}),
      })
    }
    if (mapped.length === 0) throw new Error('Empty model list')
    const auto = mapped.filter(m => m.id === 'openrouter/auto')
    const free = mapped.filter(m => m.id !== 'openrouter/auto' && m.free)
    const paid = mapped.filter(m => m.id !== 'openrouter/auto' && !m.free)
    const models = [...auto, ...free, ...paid]
    cache = { at: Date.now(), models }
    return { ok: true, models }
  } catch (err) {
    return {
      ok:     true,
      models: FALLBACK,
      stale:  true,
      error:  err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Live $/M rates for an OpenRouter model id, read from the LAST FETCHED catalog
 * only. Null when the catalog has not been fetched this session, the id is not
 * OpenRouter's, or the row carried no readable price.
 *
 * DELIBERATELY CACHE-ONLY, AND IT IS THE WHOLE POINT. This is what the cost
 * ledger calls while recording a usage event, on the main process's hot path:
 *
 *   · it NEVER triggers a network fetch, so a slow or down catalog can never
 *     stall or fail a ledger write (the ledger is the spend cap's data — it must
 *     not acquire a network dependency);
 *   · it is read ONCE, at record() time, and the resulting dollar figure is
 *     stamped onto the event. Nothing re-derives a stored event's cost later, so
 *     a rate change next month cannot retro-reprice last month's usage. That is
 *     the correctness rule for a ledger: price at the rate in force at the time.
 *
 * When it returns null the ledger falls back to the dated static table exactly
 * as before — a missing live rate degrades to the old behaviour, never to $0.
 */
export function liveOpenrouterRates(model: string): ModelRates | null {
  if (!cache || !model) return null
  const wanted = model.toLowerCase().trim()
  const hit = cache.models.find(m => m.live && m.id.toLowerCase() === wanted)
  return hit?.rates ?? null
}

// ── Publishing those rates to the cost ledger ────────────────────────────────
//
// The arrow points THIS WAY on purpose, and the reason is mechanical rather
// than aesthetic. The ledger cannot reach for this module:
//   · a lazy `require('./openrouter-service')` does not survive bundling —
//     electron-vite emits ONE out/main/index.js, so the relative path does not
//     exist inside app.asar and the require throws in every packaged build
//     while working perfectly in `pnpm dev`;
//   · a static import would drag `retrieveKey` → keychain → electron into every
//     vitest run of cost-ledger, and permanently attach a module that fetches
//     to a module whose whole design rule is "acquire no network dependency".
// So the module that OWNS the catalog hands its cache-only lookup over instead.
//
// ORDERING: this runs when the module is first evaluated. In main that is
// during bundle init — main.ts statically imports openrouter.ipc, which
// statically imports this file — so the resolver is in place long before a
// window exists, let alone a chat that could record a usage event. If it
// somehow had not run, the ledger simply prices from the bundled table: the
// pre-existing behaviour, and exactly what the old lazy require produced
// anyway, since an unloaded catalog has an empty cache.
registerLiveRateResolver((provider, model) =>
  // OpenRouter's rows only. Everything else is someone else's to claim (or the
  // static table's), and this resolver must never guess on their behalf.
  provider.startsWith('openrouter') ? liveOpenrouterRates(model) : null)
