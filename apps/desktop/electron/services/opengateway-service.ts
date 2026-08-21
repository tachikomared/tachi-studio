// apps/desktop/electron/services/opengateway-service.ts
//
// OpenGateway's live model catalog (https://opengateway.gitlawb.com/v1/models).
//
// WHY THIS FILE EXISTS, in the two numbers that forced it. Both keyless
// catalogs were read on 2026-08-02 for the IDENTICAL id
// `nvidia/nemotron-3-ultra-550b-a55b:free`:
//
//     OpenRouter    1,000,000        OpenGateway    131,072
//
// Our capability table has no provider dimension, so its single row could only
// ever be right for one of them — and it carried OpenRouter's number while
// `OPENGATEWAY_AGENT_MODEL` routes the agent harness at OpenGateway. Every run
// on that route sized its history against a window 7.6× larger than the gateway
// will accept. `36a945f5` made the static row an honest estimate; only a LIVE
// catalog can make both gateways right at once, and this is that catalog.
//
// It buys three more things the static tables cannot:
//
//   · PRICES. `pricing` and `effective_pricing` are separate fields, so a promo
//     rate never has to be inferred from a list rate. They reach the cost ledger
//     through the same registration seam OpenRouter uses.
//   · EXPIRY DATES WE CURRENTLY HAND-MAINTAIN. The gateway publishes
//     `promo: { discount, ends_at, note }` — and on 2026-08-02 its dates for
//     `ling-3.0-flash:free` (2026-08-03T10:00:00Z) and `macaron-v1-tall`
//     (2026-08-10T10:00:00Z) matched pricing.ts::VERIFIED_FREE_MODELS exactly.
//     A hand-dated list that agrees with the source is a list that can be
//     retired in favour of the source.
//   · THE ALIAS TRAP, VISIBLE IN ITS OWN STRUCTURE. `tencent/hy3` is PAID and
//     carries `aliases: ["tencent/hy3:free"]`. A `:free` suffix has never been
//     a price in this codebase, and here is the gateway itself proving why.
//     Nothing in this file reads an id or an alias to decide cost.
//
// SAME TWO-CONSUMER SPLIT AS openrouter-service.ts, and for the same reasons:
// a picker wants the rate as it is right now; the ledger wants the rate that was
// in force when the tokens were spent, read once at record() time and stamped.

import { pickLiveContextTokens, type ModelRates } from '@tachi/core'
import { registerLiveRateResolver } from './cost-ledger'

const OPENGATEWAY_MODELS_URL = 'https://opengateway.gitlawb.com/v1/models'
const CACHE_TTL_MS           = 60_000

export interface OpengatewayModel {
  id: string
  label: string
  /** The window THIS gateway serves the model at. The whole point of the file. */
  contextTokens?: number
  /**
   * Both live prices exactly zero — read from `effective_pricing` when the
   * gateway publishes one (a promo rate is what you are actually charged),
   * else from `pricing`. NEVER from the id and never from an alias.
   */
  free: boolean
  /** Came from the live catalog rather than the curated fallback. */
  live: boolean
  /** Live $/M rates, present only when BOTH halves parsed. */
  rates?: ModelRates
  /**
   * The gateway's own promo record, when it publishes one. `endsAt` is the
   * date pricing.ts currently hand-maintains for the same models.
   */
  promo?: { endsAt: string; note?: string }
  /** Other ids the gateway accepts for this row. Recorded, never priced from. */
  aliases?: string[]
}

interface CatalogResponse {
  ok: boolean
  models: OpengatewayModel[]
  stale?: boolean
  error?: string
}

/**
 * Curated fallback for a failed fetch — the 2026-08-02 catalog read, with THIS
 * gateway's windows. `live: false` marks every row as ours rather than theirs,
 * which is what keeps a hand-written number out of a "the provider says" claim.
 */
const FALLBACK: OpengatewayModel[] = ([
  ['auto',                                   null,     false],
  ['xiaomi/mimo-v2.5-pro',                    262_144, false],
  ['xiaomi/mimo-v2.5',                        262_144, false],
  ['google/gemini-3.1-flash-lite',          1_048_576, false],
  ['minimax/minimax-m3',                      204_800, false],
  ['qwen/qwen3.7-max',                        262_144, false],
  ['moonshotai/kimi-k3',                    1_048_576, false],
  ['z-ai/glm-5.2',                          1_048_576, false],
  ['nvidia/nemotron-3-ultra-550b-a55b:free',  131_072, true],
  ['inclusionai/ling-3.0-flash:free',         262_144, true],
  ['tencent/hy3',                             262_144, false],
  ['mindai/macaron-v1-tall',                  262_144, true],
] as Array<[string, number | null, boolean]>).map(([id, ctx, free]) => ({
  id,
  label: id,
  ...(ctx !== null ? { contextTokens: ctx } : {}),
  free,
  live: false,
}))

let cache: { at: number; models: OpengatewayModel[] } | null = null

/**
 * TEST-ONLY: drop the cached catalog.
 *
 * Module state outlives a test, and this cache is read by every `live*` lookup
 * below. Without a reset a suite that loads a catalog and then simulates a dead
 * gateway still answers from the earlier load — which is correct behaviour (a
 * failed refresh must not erase what we knew) but makes the failure case
 * untestable. Mirrors cost-ledger's `__clearLiveRateResolversForTests`.
 */
export function __clearOpengatewayCacheForTests(): void { cache = null }

/**
 * Strictly-zero test for a per-token price the gateway publishes as a string.
 * Absence or an empty string is NOT zero — `Number('') === 0` is the Windows
 * trap this repo has been bitten by, and here it would turn "we could not read
 * the price" into "this model is free".
 */
function isZeroPrice(v: unknown): boolean {
  if (typeof v === 'number') return v === 0
  if (typeof v !== 'string' || v.trim() === '') return false
  const n = Number(v)
  return Number.isFinite(n) && n === 0
}

/** Per-TOKEN price → $/M. Null for absent, empty, unparseable or negative. */
function perMillion(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v * 1e6 : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n * 1e6 : null
}

interface RawPricing { prompt?: unknown; completion?: unknown; input_cache_read?: unknown; input_cache_write?: unknown }

function ratesFromPricing(p: RawPricing | undefined): ModelRates | null {
  if (!p) return null
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
 * WHICH price object is the truth for this row, at `now`.
 *
 * `effective_pricing` is what you are actually charged, so it wins while it
 * applies — a promo that zeroes a price must not be reported at the list rate
 * for as long as it runs. The two are separate fields on the wire precisely so
 * neither has to be inferred from the other, and this is the one place that
 * chooses.
 *
 * AND THE DIRECTION IS NOT THE ONE THE NAME SUGGESTS. Measured across the whole
 * catalog on 2026-08-03, `effective_pricing` is EXACTLY 1.2x `pricing` on every
 * paid row and equal on every free one:
 *
 *     tencent/hy3          0.0000002   -> 0.00000024
 *     moonshotai/kimi-k3   0.000003    -> 0.0000036
 *     xiaomi/mimo-v2.5-pro 0.000000435 -> 0.000000522
 *
 * i.e. the gateway's margin over the upstream list rate, applied uniformly.
 * A ledger priced from the list rate — which is what a hand-entered static row
 * copies, because the list rate is the number the underlying vendor publishes —
 * therefore UNDER-COUNTS every OpenGateway run by 20%. Under-counting is the
 * one direction a spend cap may not err in, so `effective_pricing` is not
 * merely the more precise of two numbers here; it is the only honest one.
 * (The ratio is recorded as an observation, never encoded: it is the gateway's
 * business, and the day it changes the field will say so and this code will
 * not have to.)
 *
 * THE EXPIRY CHECK IS NOT DECORATION. A promo row carries its own `ends_at`,
 * and a row we hold past that moment — a 60 s cache straddling the deadline, a
 * catalog that stops answering and leaves us on the last good read — would keep
 * reporting $0 for a model that has started billing. `freeUntil` exists in
 * pricing.ts for exactly this failure; a live feed that ignored the date the
 * feed itself publishes would reintroduce it wearing fresher clothes. Past
 * `ends_at` we fall back to the LIST price, which is the pessimistic direction
 * and the safe one for a spend cap.
 */
function pricingForRow(
  m: { pricing?: RawPricing; effective_pricing?: RawPricing },
  promo: { endsAt: string } | undefined,
  now: number,
): RawPricing | undefined {
  if (promo && Date.parse(promo.endsAt) <= now) return m.pricing ?? m.effective_pricing
  return m.effective_pricing ?? m.pricing
}

/** The gateway's promo record, kept only when it carries a usable date. */
function promoOf(m: { promo?: unknown }): { endsAt: string; note?: string } | undefined {
  const p = m.promo as { ends_at?: unknown; note?: unknown } | null | undefined
  if (!p || typeof p !== 'object') return undefined
  const endsAt = typeof p.ends_at === 'string' ? p.ends_at.trim() : ''
  if (!endsAt || !Number.isFinite(Date.parse(endsAt))) return undefined
  return { endsAt, ...(typeof p.note === 'string' && p.note ? { note: p.note } : {}) }
}

/**
 * The live catalog. KEYLESS by design — probed 2026-08-02: 200, 12 models with
 * no Authorization header — so the windows and prices are available before the
 * user has a key, which is exactly when a wrong static number does the most
 * damage (the agent route is pinned to a model on this gateway).
 */
export async function listOpengatewayModels(
  opts: { force?: boolean; now?: number } = {},
): Promise<CatalogResponse> {
  const now = opts.now ?? Date.now()
  if (!opts.force && cache && now - cache.at < CACHE_TTL_MS) {
    return { ok: true, models: cache.models }
  }
  try {
    const res = await fetch(OPENGATEWAY_MODELS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000) as AbortSignal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    type RawModel = {
      id?: string
      name?: string
      aliases?: unknown
      pricing?: RawPricing
      effective_pricing?: RawPricing
      promo?: unknown
    } & Record<string, unknown>
    const body = await res.json() as { data?: RawModel[] }
    const items = Array.isArray(body.data) ? body.data : []
    const seen = new Set<string>()
    const mapped: OpengatewayModel[] = []
    for (const m of items) {
      if (typeof m.id !== 'string' || m.id.length === 0 || seen.has(m.id)) continue
      seen.add(m.id)
      const promo = promoOf(m)
      const priced = pricingForRow(m, promo, now)
      const rates = ratesFromPricing(priced)
      const aliases = Array.isArray(m.aliases)
        ? m.aliases.filter((a): a is string => typeof a === 'string' && a.length > 0)
        : []
      mapped.push({
        id: m.id,
        label: typeof m.name === 'string' && m.name ? m.name : m.id,
        // `context_window` is this gateway's field name and is already one of
        // pickLiveContextTokens' recognised keys (tachi/models.ts
        // LIVE_CONTEXT_KEYS), so the row goes in as it arrived. An earlier
        // draft re-mapped it onto `context_length` by hand — a second spelling
        // of a fact the shared reader already knew, which is how two readers of
        // one field start disagreeing.
        contextTokens: pickLiveContextTokens(m),
        // Free is BOTH effective halves at exactly zero. The alias list is never
        // consulted — `tencent/hy3` is paid and ships `tencent/hy3:free`.
        free: isZeroPrice(priced?.prompt) && isZeroPrice(priced?.completion),
        live: true,
        ...(rates ? { rates } : {}),
        ...(promo ? { promo } : {}),
        ...(aliases.length ? { aliases } : {}),
      })
    }
    if (mapped.length === 0) throw new Error('Empty model list')
    const auto = mapped.filter(m => m.id === 'auto')
    const free = mapped.filter(m => m.id !== 'auto' && m.free)
    const paid = mapped.filter(m => m.id !== 'auto' && !m.free)
    const models = [...auto, ...free, ...paid]
    cache = { at: now, models }
    return { ok: true, models }
  } catch (err) {
    return {
      ok: true,
      models: FALLBACK,
      stale: true,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** The cached row for an id, matched exactly or through the gateway's own
 *  alias list. Alias matching is an ADDRESSING fact the gateway publishes, not
 *  an inference from the id's shape — the row found this way still carries its
 *  own price, so `hy3:free` resolves to hy3's PAID rate. */
function cachedRow(model: string): OpengatewayModel | null {
  if (!cache || !model) return null
  const wanted = model.toLowerCase().trim()
  return cache.models.find(m =>
    m.live && (m.id.toLowerCase() === wanted
      || (m.aliases ?? []).some(a => a.toLowerCase() === wanted))) ?? null
}

/**
 * Live $/M rates for an OpenGateway model id, from the LAST FETCHED catalog
 * only — never a network call. Same contract as liveOpenrouterRates(): the
 * ledger reads it on its hot path while recording a usage event, so it must not
 * be able to stall, fail, or acquire a network dependency for the spend cap.
 */
export function liveOpengatewayRates(model: string): ModelRates | null {
  return cachedRow(model)?.rates ?? null
}

/**
 * The window THIS gateway serves `model` at, or null when the catalog has not
 * been fetched or does not know the id.
 *
 * This is the value that outranks our provider-less capability row. Callers
 * must pass it through as ABSENT when null — never as a number — so an unknown
 * id keeps falling through to the static estimate rather than being asserted.
 */
export function liveOpengatewayContextTokens(model: string): number | null {
  const t = cachedRow(model)?.contextTokens
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null
}

/**
 * Is this model free ON THIS GATEWAY right now, per its own published prices?
 * Null when the catalog has not been fetched or does not carry the id — which
 * is "we do not know", never "it is paid".
 */
export function liveOpengatewayFree(model: string): boolean | null {
  const row = cachedRow(model)
  return row ? row.free : null
}

/**
 * The gateway's own expiry date for a free-promo row, ISO, or null.
 *
 * Reported rather than acted upon here: pricing.ts::VERIFIED_FREE_MODELS is
 * still the dated list the resolver consults, and this is the source that list
 * was copied from by hand. Surfacing it lets a doctor row (or a future refresh)
 * compare the two instead of letting them drift silently.
 */
export function liveOpengatewayPromoEndsAt(model: string): string | null {
  return cachedRow(model)?.promo?.endsAt ?? null
}

// ── Publishing to the cost ledger ────────────────────────────────────────────
//
// The arrow points this way for the same mechanical reasons openrouter-service
// documents: a lazy relative require does not survive electron-vite's single
// out/main/index.js bundle, and a static import would attach a fetching module
// to the one module whose design rule is "acquire no network dependency".
registerLiveRateResolver((provider, model) =>
  provider === 'opengateway' ? liveOpengatewayRates(model) : null)
