// apps/desktop/electron/services/venice-service.ts
//
// STANDALONE Venice provider — privacy-first, OpenAI-compatible inference at
// api.venice.ai. Completely INDEPENDENT of Surplus (different company, key,
// catalog, endpoints). This service backs Venice's chat model picker (text
// models). Mirrors bankr-service.ts / surplus-service.ts in shape but talks to
// Venice's own endpoints with retrieveKey('venice').
//
// Auth: `Authorization: Bearer <venice key>`. Catalog: GET /models?type=text.
//
// CONTEXT WINDOWS: Venice publishes `model_spec.availableContextTokens` per
// model, and it is the ONLY authority for what Venice serves. We used to parse
// `model_spec.capabilities` and drop the window sitting right next to it, so
// every Venice model fell back to @tachi/core's static substring rows — which
// have no provider dimension and answered 32k for 31 of Venice's 106 text
// models (and a wrong family number for several more). Carrying contextTokens
// through lets resolveContextWindow() prefer Venice's own number.
//
// ── LIVE PER-MODEL RATES (2026-08-03) ────────────────────────────────────────
// The same omission, one field along. `model_spec.pricing` sits next to the
// capabilities block we already parse and was thrown away, so nothing
// downstream could price a Venice model except @tachi/core's bundled table —
// and that table answers EXACTLY for 2 of the 9 curated ids (measured against
// MODEL_RATES on 2026-08-03: only `claude-opus-4-8` and `deepseek-v4-pro`).
// The picker's price band deliberately refuses the table's substring keyword
// fallback, because a rate inferred from a NAME is not a fact you may print at
// a user, so the other 7 rows showed nothing at all. The ledger had the same
// hole from the other side: a Venice run priced from a keyword row, or from
// nothing.
//
// THE UNIT IS THE TRAP, and it is why this file cannot copy the two sibling
// services line for line. OpenRouter and OpenGateway publish PER-TOKEN prices
// as strings and their readers multiply by 1e6. Venice publishes
// `{ usd, diem }` objects that are ALREADY USD PER MILLION TOKENS — verified
// against the live payload on 2026-08-03: `venice-uncensored-1-2` reads
// 0.2 / 0.9 and `claude-opus-5` reads 6 / 30, which are $/M figures on their
// face (0.2 USD *per token* would be absurd, and cache_input tracks input at
// 0.1x throughout, the same ratio the $/M tables use). A borrowed `* 1e6` here
// would have over-counted every Venice run by a factor of a million.
//
// `diem` is Venice's own settlement unit and was equal to `usd` on all 106 rows
// that day. We read `usd` regardless: the ledger and the spend cap are
// denominated in dollars, and a second currency that happens to agree today is
// not a reason to make the reader guess which one it is looking at.
//
// SAME TWO-CONSUMER SPLIT the sibling services document: the picker wants the
// rate as it is right now (it is about to start a job at that rate), while the
// ledger wants the rate that was in force when the tokens were spent — read
// once at record() time and stamped onto the event, never re-derived.
import { parseLiveContextTokens, type ModelRates } from '@tachi/core'
import { retrieveKey } from './keychain'
import { registerLiveRateResolver } from './cost-ledger'

const VENICE_BASE_URL = 'https://api.venice.ai/api/v1'
const CACHE_TTL_MS     = 60_000

export interface VeniceModel {
  id:      string
  label:   string
  /** Family hint for grouping (GLM, Claude, Qwen, GPT, Llama, …). */
  family?: string
  /** Whether the model came from the live API (vs the curated fallback). */
  live:    boolean
  /** Model accepts image input (vision) — needed to feed a Reference-Image node
   *  into a Prompt node. From model_spec.capabilities.supportsVision. */
  vision?: boolean
  /** Short capability tags for display: vision · reasoning · tools · web · code
   *  (from model_spec.capabilities). */
  caps?: string[]
  /** Venice's own context window for this model (model_spec.availableContextTokens).
   *  Absent when the catalog omitted it — absent means UNKNOWN, never a default. */
  contextTokens?: number
  /**
   * LIVE $/M rates from `model_spec.pricing`, present only on `live` rows whose
   * input AND output both parsed. A half-published price is no price, so the
   * field is omitted rather than filled with a zero that would read as "free" —
   * Venice has no $0 text model at all (0 of 106 on 2026-08-03), so a zero here
   * could only ever be a parse failure wearing a price's clothes.
   *
   * NEVER set on a curated fallback row. Those numbers would be ours, and a
   * hand-written rate laundered into "the provider says" is the exact confusion
   * the `live` flag exists to prevent.
   */
  rates?: ModelRates
}

interface CatalogResponse {
  ok:     boolean
  models: VeniceModel[]
  stale?: boolean
  error?: string
}

// Curated fallback — a representative slice of Venice's live text catalog. Used
// when no key is set or the live fetch fails so the picker always has something.
// The live /models fetch overwrites this with the full list.
//
// CHECKED AGAINST THE LIVE CATALOG ON 2026-08-03 (106 models, snapshot in
// test/fixtures/live-catalogs-2026-08-03.json, and a test below re-checks it).
// Two entries named models Venice no longer serves — `qwen-2.5-vl` and
// `mistral-31-24b` — and they were the list's ONLY two vision models, so a user
// without a live catalog was offered a choice of two dead ids for images.
//
// AND NO CAPABILITIES ARE CLAIMED HERE ANY MORE. `vision`, `tools` and
// `reasoning` were hand-written on three of these rows. The live path reads
// them from `model_spec.capabilities` — real evidence from the serving provider
// — and a hand-written copy is a claim with nothing behind it that goes stale
// silently, which is exactly what happened. Offline we know which models exist
// (they are pinned) and not what they can do, and the honest fallback says the
// first without pretending to the second.
const FALLBACK_TEXT: VeniceModel[] = [
  { id: 'zai-org-glm-5',                 label: 'GLM 5',                family: 'GLM',      live: false },
  { id: 'zai-org-glm-4.7',               label: 'GLM 4.7',              family: 'GLM',      live: false },
  { id: 'qwen3-vl-235b-a22b',            label: 'Qwen3 VL 235B',        family: 'Qwen',     live: false },
  { id: 'mistral-small-3-2-24b-instruct', label: 'Mistral Small 3.2 24B', family: 'Mistral', live: false },
  { id: 'qwen3-235b-a22b-thinking-2507', label: 'Qwen3 235B Thinking',  family: 'Qwen',     live: false },
  { id: 'claude-opus-5',                 label: 'Claude Opus 5',        family: 'Claude',   live: false },
  { id: 'llama-3.3-70b',                 label: 'Llama 3.3 70B',        family: 'Llama',    live: false },
  { id: 'deepseek-v4-pro',               label: 'DeepSeek V4 Pro',      family: 'DeepSeek', live: false },
  { id: 'openai-gpt-oss-120b',           label: 'GPT-OSS 120B',         family: 'GPT',      live: false },
  { id: 'venice-uncensored-1-2',         label: 'Venice Uncensored',    family: 'Venice',   live: false },
]

/** Exported so a test can hold the fallback against a dated real catalog. */
export const VENICE_FALLBACK_IDS: readonly string[] = FALLBACK_TEXT.map(m => m.id)

let cache: { at: number; models: VeniceModel[] } | null = null

function familyOf(id: string): string {
  const l = id.toLowerCase()
  if (l.includes('glm'))                          return 'GLM'
  if (l.includes('claude'))                       return 'Claude'
  if (l.includes('gemini'))                       return 'Gemini'
  if (l.includes('gpt') || l.includes('openai'))  return 'GPT'
  if (l.includes('llama'))                         return 'Llama'
  if (l.includes('deepseek'))                      return 'DeepSeek'
  if (l.includes('qwen'))                          return 'Qwen'
  if (l.includes('mistral'))                       return 'Mistral'
  if (l.includes('grok'))                          return 'Grok'
  if (l.includes('venice') || l.includes('uncensored')) return 'Venice'
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
 * TEST-ONLY: drop the cached catalog.
 *
 * Module state outlives a test, and `liveVeniceRates` below reads it. Without a
 * reset, a suite that loads a catalog and then simulates a dead API still
 * answers from the earlier load — correct behaviour (a failed refresh must not
 * erase what we knew) but it makes the failure case untestable. Mirrors
 * opengateway-service's `__clearOpengatewayCacheForTests`.
 */
export function __clearVeniceCacheForTests(): void { cache = null }

/** One `{ usd, diem }` leaf of Venice's pricing block. */
interface RawPrice { usd?: unknown; diem?: unknown }

/**
 * `model_spec.pricing`. `extended` is Venice's SECOND price tier, charged above
 * `context_token_threshold` prompt tokens; it repeats the same leaf names.
 */
interface RawPricing {
  input?:       RawPrice
  output?:      RawPrice
  cache_input?: RawPrice
  cache_write?: RawPrice
  extended?:    RawPricing & { context_token_threshold?: unknown }
}

/**
 * A Venice price leaf → $/M, or null when absent, unreadable or negative.
 *
 * NOTE THE MISSING `* 1e6`, and do not "fix" it: Venice's numbers are already
 * per million tokens (see the unit note at the top of this file). The siblings
 * multiply because their catalogs publish per-token strings; this one does not.
 *
 * Empty-string handling is the shared trap: `Number('') === 0`, which would
 * turn "we could not read the price" into "this model is free". Absence is
 * never zero here.
 */
function perMillion(p: RawPrice | undefined): number | null {
  const v = p?.usd
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Venice's `extended` block → ModelRates.longContext, or undefined.
 *
 * WHY THIS IS NOT OPTIONAL DETAIL. Ten of the 106 text models bill a second,
 * higher tier above a prompt-token threshold, and the step is a straight
 * DOUBLING on most of them (grok-4-5 2.27/6.8 → 4.53/13.6 above 200k;
 * openai-gpt-55 6.25/37.5 → 12.5/56.25 above 272k). costUsdFromRates already
 * knows how to switch tiers — dropping the block would price every long agent
 * run on those models at half rate, and under-counting is the one direction a
 * spend cap may not err in.
 *
 * The tier is kept only when the threshold AND both halves are readable; a
 * partial block is discarded rather than half-applied, which leaves the base
 * rate in force (the pessimistic, safe direction).
 *
 * WHAT IS DELIBERATELY LOST: Venice also publishes an extended CACHE rate, and
 * ModelRates.longContext has no slot for one, so costUsdFromRates falls back to
 * scaling the base cache-read rate by the input ratio. Of the nine extended
 * rows that publish a cache rate at all, that scaling reproduces Venice's own
 * number on seven and OVER-states it on two — qwen-3-6-plus and
 * gemini-3-1-pro-preview hold their cache rate flat while their input doubles.
 * (The tenth, openai-gpt-54-pro, publishes no cache rate either side, so there
 * is nothing to compare.) Over-stating cached reads on two models is the safe
 * direction; recorded here rather than silently absorbed.
 */
function longContextOf(e: RawPricing['extended']): ModelRates['longContext'] | undefined {
  if (!e) return undefined
  const threshold = e.context_token_threshold
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return undefined
  const inputPerM  = perMillion(e.input)
  const outputPerM = perMillion(e.output)
  if (inputPerM === null || outputPerM === null) return undefined
  return { minPromptTokens: threshold, inputPerM, outputPerM }
}

/**
 * `model_spec.pricing` → ModelRates, or null when either required half is
 * missing. Cache rates are optional and OMITTED when absent rather than zeroed:
 * 33 of the 106 rows publish no `cache_input` and 84 no `cache_write`, and an
 * omitted field correctly falls through to the shared 0.1x / 1.25x heuristic
 * downstream, whereas a zero would claim cached reads are free.
 */
function ratesFromPricing(p: RawPricing | undefined): ModelRates | null {
  if (!p) return null
  const inputPerM  = perMillion(p.input)
  const outputPerM = perMillion(p.output)
  if (inputPerM === null || outputPerM === null) return null
  const cacheReadPerM  = perMillion(p.cache_input)
  const cacheWritePerM = perMillion(p.cache_write)
  const longContext    = longContextOf(p.extended)
  return {
    inputPerM,
    outputPerM,
    ...(cacheReadPerM  !== null ? { cacheReadPerM }  : {}),
    ...(cacheWritePerM !== null ? { cacheWritePerM } : {}),
    ...(longContext ? { longContext } : {}),
  }
}

/**
 * Venice text-model catalog for the chat picker. Live-fetches GET /models?type=text
 * when a Venice key is set; otherwise returns the curated fallback. Cached briefly
 * so the dropdown doesn't refetch on every open.
 */
export async function listVeniceModels(opts: { force?: boolean } = {}): Promise<CatalogResponse> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { ok: true, models: cache.models }
  }
  const key = retrieveKey('venice')
  if (!key) {
    return { ok: true, models: FALLBACK_TEXT, stale: true, error: 'No Venice key configured' }
  }
  try {
    const res = await fetch(`${VENICE_BASE_URL}/models?type=text`, {
      headers: { Authorization: `Bearer ${key}`, 'Accept-Encoding': 'identity' },
      signal:  AbortSignal.timeout(8_000) as AbortSignal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    type Caps = {
      supportsVision?: boolean; supportsReasoning?: boolean; supportsFunctionCalling?: boolean
      supportsWebSearch?: boolean; optimizedForCode?: boolean
    }
    type RawModel = {
      id?: string; name?: string
      model_spec?: { capabilities?: Caps; availableContextTokens?: unknown; pricing?: RawPricing }
    }
    const body = await res.json() as { data?: RawModel[] }
    const items = Array.isArray(body.data) ? body.data : []
    const models: VeniceModel[] = items
      .filter((m): m is RawModel & { id: string } => typeof m.id === 'string' && m.id.length > 0)
      .map(m => {
        const c = m.model_spec?.capabilities ?? {}
        const ctx = parseLiveContextTokens(m.model_spec?.availableContextTokens)
        const rates = ratesFromPricing(m.model_spec?.pricing)
        const caps: string[] = []
        if (c.supportsVision)          caps.push('vision')
        if (c.supportsReasoning)        caps.push('reasoning')
        if (c.supportsFunctionCalling)  caps.push('tools')
        if (c.supportsWebSearch)        caps.push('web')
        if (c.optimizedForCode)         caps.push('code')
        return {
          id:     m.id,
          label:  m.name || prettify(m.id),
          family: familyOf(m.id),
          live:   true,
          vision: c.supportsVision === true,
          caps,
          // Left OFF entirely when Venice omitted it — absent means unknown.
          ...(ctx === undefined ? {} : { contextTokens: ctx }),
          // Same rule for the price: omitted, never defaulted. Set only inside
          // this branch, which is the only place a row is stamped live:true.
          ...(rates ? { rates } : {}),
        }
      })
    if (models.length === 0) throw new Error('Empty model list')
    cache = { at: Date.now(), models }
    return { ok: true, models }
  } catch (err) {
    return {
      ok:     true,
      models: FALLBACK_TEXT,
      stale:  true,
      error:  err instanceof Error ? err.message : String(err),
    }
  }
}

export function veniceBaseUrl(): string { return VENICE_BASE_URL }

/**
 * Live $/M rates for a Venice model id, read from the LAST FETCHED catalog only.
 * Null when the catalog has not been fetched this session, the id is not one
 * Venice serves, or the row carried no readable price.
 *
 * DELIBERATELY CACHE-ONLY, on the same contract liveOpenrouterRates() documents.
 * This is what the cost ledger calls while recording a usage event, on the main
 * process's hot path:
 *   · it NEVER triggers a network fetch, so a slow or down catalog cannot stall
 *     or fail a ledger write (the ledger IS the spend cap's data);
 *   · it is read ONCE, at record() time, and the resulting dollar figure is
 *     stamped onto the event. Nothing re-derives a stored event's cost later, so
 *     a Venice price change next month cannot retro-reprice last month's usage.
 *
 * Only `live` rows answer. A fallback row's hand-written identity carries no
 * price at all, so this cannot return one — but the guard is explicit anyway,
 * because the day someone adds a rate to FALLBACK_TEXT this is the line that
 * must stop it reaching a bill.
 */
export function liveVeniceRates(model: string): ModelRates | null {
  if (!cache || !model) return null
  const wanted = model.toLowerCase().trim()
  const hit = cache.models.find(m => m.live && m.id.toLowerCase() === wanted)
  return hit?.rates ?? null
}

// ── Publishing those rates to the cost ledger ────────────────────────────────
//
// The arrow points THIS WAY for the mechanical reasons openrouter-service.ts
// spells out: a lazy `require('./venice-service')` inside the ledger does not
// survive bundling (electron-vite emits one out/main/index.js, so the relative
// path does not exist inside app.asar and the require throws in every packaged
// build while working perfectly in `pnpm dev`), and a static import would drag
// `retrieveKey` → keychain → electron into every vitest run of cost-ledger and
// permanently attach a fetching module to the one module whose design rule is
// "acquire no network dependency".
//
// ORDERING: this runs at module evaluation. In main that is during bundle init
// — main.ts statically imports venice.ipc, which statically imports this file —
// so the resolver is in place long before a window exists, let alone a chat that
// could record a usage event. Had it not run, the ledger simply prices from the
// bundled table: the pre-existing behaviour, never $0.
//
// EXACT PROVIDER MATCH, unlike OpenRouter's `startsWith`. Venice has exactly one
// id in the provider registry ('venice', registry.ts) and chat-service records
// under that same string; a prefix test would silently claim any future
// 'venice-*' route whose prices we have never read.
registerLiveRateResolver((provider, model) =>
  provider === 'venice' ? liveVeniceRates(model) : null)
