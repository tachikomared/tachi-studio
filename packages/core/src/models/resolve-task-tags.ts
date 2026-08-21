// packages/core/src/models/resolve-task-tags.ts
//
// The pure resolver (model id + provider → task tags) and the recommendation
// helper the chooser UI calls. No node:*, no I/O, no keychain — renderer-safe
// via the subpath `@tachi/core/src/models/resolve-task-tags`.
//
// Read task-tags.ts first: it holds the vocabulary, the copy, the thresholds
// and the two dated evidence tables. This file holds only the DERIVATION, and
// every rule below states which fact it rests on.

import {
  TASK_TAGS,
  TASK_TAG_COPY,
  LONG_CONTEXT_MIN_TOKENS,
  EVERYDAY_MAX_INPUT_USD_PER_M,
  EVERYDAY_MAX_OUTPUT_USD_PER_M,
  PREMIUM_MIN_INPUT_USD_PER_M,
  PREMIUM_MIN_OUTPUT_USD_PER_M,
  IMAGE_INPUT_MODELS,
  CURATED_MODEL_NOTES,
  isCurationFresh,
  type TaskTag,
  type PriceBand,
  type LiveModelFacts,
  type CuratedModelNote,
} from './task-tags.js'
import { resolveCapability } from '../tachi/models.js'
import { getProvider, providerBilling, localityOf } from '../providers/registry.js'
import { isVerifiedFreeModel, MODEL_RATES, retirementOf, type ModelRates, type RetiredModel } from '../pricing.js'
import type { ModelCapability as TachiCapability } from '../tachi/contract.js'

// ── Result shape ─────────────────────────────────────────────────────────────

export interface TaskTagResult {
  /** Tags this model has earned, in TASK_TAGS order. Empty when we know nothing. */
  tags: TaskTag[]
  /**
   * One plain-English line per tag saying WHICH fact produced it. The UI can
   * show this in a tooltip; the tests assert on it. A tag with no reason is a
   * bug, and `resolveTaskTags` never emits one.
   */
  reasons: Partial<Record<TaskTag, string>>
  /**
   * Which TACHI capability-catalog key supplied tools/context, or null when the
   * catalog did not recognise the id at all.
   *
   * INHERITED CAVEAT, disclosed rather than hidden: tachi/models.ts matches by
   * exact key then LONGEST-substring over a curated family list, so a novel id
   * containing 'gpt' resolves to the GPT family row. That is the contract the
   * agent harness already runs on and this file adds no new matching of its
   * own — but a surface that wants to show provenance should show this field.
   */
  capabilityMatch: string | null
  /** The curated citation behind `coding` / `uncensored`, when there is one
   *  and it is fresh. */
  curated?: CuratedModelNote
  /**
   * Set when the curated table says this is not a general-purpose chat model
   * (a moderation classifier, a guardrail). `recommendModels` refuses to
   * shortlist these.
   */
  notGeneralChat?: string
  /**
   * The $/M rates we can PROVE for this model, or null when we cannot.
   * null is "we do not know", never "it is free" and never "it is expensive".
   */
  price: ModelPrice | null
  /**
   * Which price band those rates fall in, or null when the price is unknown.
   * ALWAYS non-null when `price` is non-null and vice versa — the bands
   * partition the provable prices, so an absent band means exactly one thing.
   */
  priceBand: PriceBand | null
  /**
   * Set when the provider no longer serves this id as itself — the dated record
   * from pricing.ts::RETIRED_MODELS.
   *
   * This is the honest answer to a genuinely nasty failure: xAI retired eight
   * Grok ids on 2026-05-15 and now SILENTLY redirects them, so a picker row for
   * `grok-4` showed a name, a context window and a price for a model that has
   * not existed for months, with no error anywhere to reveal it. A surface that
   * still lists such an id must be able to say so; `price` meanwhile reports the
   * SUCCESSOR's rate, because that is what the user is actually billed.
   */
  retired?: RetiredModel
}

/** A fresh "we know nothing about this model" result. Never a shared object — a
 *  caller that mutates its own copy must not poison the next call. */
function noTags(): TaskTagResult {
  return { tags: [], reasons: {}, capabilityMatch: null, price: null, priceBand: null }
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface ResolveTaskTagsInput {
  /** Raw model id exactly as the provider serves it. */
  id: string
  /** Canonical provider id (registry.ts). Optional — some surfaces only have an id. */
  providerId?: string | null
  /** A live catalog row, when the surface fetched one. Always the strongest evidence. */
  live?: LiveModelFacts | null
  /**
   * MIXED-GATEWAY ESCAPE HATCH. A provider whose registry `billing` is 'free'
   * asserts — in the registry's own words — that it "costs the user nothing
   * WHATEVER model it resolves to". For a gateway that ALSO serves paid models
   * that assertion is too broad per-model, and trusting it would promise $0 over
   * a paid row: the exact shape of the `:free`-suffix bug pricing.ts fixed.
   *
   * When a caller knows the provider is mixed, it passes that provider's dated
   * per-model free whitelist here. Provider-level 'free' is then IGNORED and
   * membership of this list decides.
   *
   * Left to the caller on purpose: this module must not hard-code a gateway's
   * name (the Kilo whitelist that motivated this lived in providers/kilo.ts and
   * was deleted the same day Kilo moved inside the FreeLLM router).
   */
  freeModelIds?: readonly string[] | null
  /** Injectable clock so curation expiry and free-promo windows are testable. */
  now?: number
}

// ── Small, honest helpers ────────────────────────────────────────────────────

/**
 * The TACHI capability row for this id, or null when the catalog does not know
 * it. resolveCapability() falls back to a permissive DEFAULT (`match: '*'`,
 * tools on, agentCapable true) so the harness will still ATTEMPT an unknown
 * model — a fine default for "try it", a terrible one for a badge. We reject it
 * here, which is what makes an unknown model come back with zero tags.
 */
function knownCapability(id: string): TachiCapability | null {
  const cap = resolveCapability(id)
  return cap.match === '*' ? null : cap
}

/**
 * Price from an EXACT MODEL_RATES row only.
 *
 * Deliberately NOT `ratesFor()`: that function's job is to never under-price a
 * spend cap, so it falls back to a dash-prefix walk and then to a substring
 * keyword list ('gpt-4', 'qwen', 'flash'…). Those fallbacks are right for a
 * ledger and wrong for a user-facing "this one is cheap" claim — a keyword hit
 * would put a model in the cheap group on the strength of its name.
 *
 * The id normalisation here is the same as pricing.ts step 2: drop a known
 * ROUTING suffix and the `org/` prefix. That is address normalisation, not a
 * capability inference — `:free` is still never read as a price.
 */
function exactRates(id: string): ModelRates | null {
  const raw = id.toLowerCase().trim()
  if (MODEL_RATES[raw]) return MODEL_RATES[raw]
  let m = raw.replace(/:(free|nitro|floor|extended|online|thinking)$/, '')
  const slash = m.lastIndexOf('/')
  if (slash >= 0) m = m.slice(slash + 1)
  const direct = MODEL_RATES[m]
  if (direct) return direct

  // A RETIRED id has no row of its own, but its price is not unknown: the
  // provider silently redirects the request and bills the successor's rate
  // (pricing.ts::RETIRED_MODELS, each entry dated and sourced). Showing that
  // number is a provable claim about what the user will be charged — the same
  // bar an exact row clears — so it is admissible here, unlike the keyword
  // fallback. ONE hop, and only into an EXACT row: a successor we cannot price
  // exactly yields null rather than dropping into the name-matching path.
  const retired = retirementOf(raw)
  if (retired?.successor) {
    const s = retired.successor.toLowerCase().trim()
    return MODEL_RATES[s] ?? null
  }
  return null
}

/** Price the live catalog row reports, when it reports both halves. */
function livePrice(live?: LiveModelFacts | null): { inPerM: number; outPerM: number } | null {
  const inPerM = live?.pricing?.inUsdPerMTok
  const outPerM = live?.pricing?.outUsdPerMTok
  if (typeof inPerM !== 'number' || typeof outPerM !== 'number') return null
  if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM)) return null
  return { inPerM, outPerM }
}

/**
 * Where a price came from. Carried on ModelPrice so a surface can disclose the
 * provenance of a number it prints, exactly as `reasons` does for a tag.
 */
export type PriceSource =
  | 'live-catalog'      // the provider's own catalog row, fetched this session
  | 'verified-free'     // pricing.ts::VERIFIED_FREE_MODELS, dated, per model
  | 'free-whitelist'    // a caller-supplied per-model list on a mixed gateway
  | 'local-hardware'    // runs on this machine; there is no bill
  | 'provider-registry' // registry.ts records the whole provider as free
  | 'price-table'       // an EXACT row in pricing.ts::MODEL_RATES

/**
 * $/M rates we can prove, with their provenance.
 *
 * There is no "estimated" variant on purpose. Every field here is read from a
 * source, and a model we cannot source gets `null` instead of this object.
 */
export interface ModelPrice {
  inPerM: number
  outPerM: number
  source: PriceSource
  /** One plain-English line naming the evidence. Same contract as `reasons`. */
  why: string
}

interface FreeEvidence { why: string; source: PriceSource }

/**
 * Is this model free, and on what evidence? Ordered strongest-first.
 * Returns null when nothing establishes it — which is NOT the same as "paid",
 * it is "we do not know", and an unknown price earns no promise.
 */
function freeEvidence(
  id: string,
  providerId: string | null | undefined,
  live: LiveModelFacts | null | undefined,
  freeModelIds: readonly string[] | null | undefined,
  now: number,
): FreeEvidence | null {
  const lp = livePrice(live)
  if (lp && lp.inPerM === 0 && lp.outPerM === 0) {
    return {
      why: "the provider's own live catalog prices this model at $0 in and $0 out",
      source: 'live-catalog',
    }
  }
  if (isVerifiedFreeModel(id, now)) {
    return {
      why: 'on the dated verified-free list, checked against the provider catalog (pricing.ts)',
      source: 'verified-free',
    }
  }
  // A mixed gateway: the caller supplied a per-model whitelist, so that list is
  // the whole answer and the provider-level billing fact is not consulted.
  if (freeModelIds) {
    const wanted = id.toLowerCase().trim()
    return freeModelIds.some(x => x.toLowerCase().trim() === wanted)
      ? { why: "on this provider's dated free-model whitelist", source: 'free-whitelist' }
      : null
  }
  const p = getProvider(providerId)
  if (p?.egress === 'local') {
    return {
      why: 'runs on your own machine, so there is nothing to pay',
      source: 'local-hardware',
    }
  }
  if (providerId && providerBilling(providerId) === 'free') {
    // registry.ts defines billing:'free' as "costs the user nothing WHATEVER
    // model it resolves to" — a reviewed, single-source-of-truth fact. We defer
    // to it rather than second-guessing it (and it follows the registry if the
    // registry changes).
    return {
      why: 'this provider is recorded as free to use in the provider registry',
      source: 'provider-registry',
    }
  }
  return null
}

// ── Price: the one place a $/M number is established ─────────────────────────

/**
 * The model's $/M rates, or null when we cannot prove any.
 *
 * THE WHOLE POINT: this is the ONLY price path a user-facing surface may use.
 * `pricing.ts::ratesFor()` deliberately never returns null if it can help it —
 * it walks dash-prefixes and then a substring keyword list ('gpt-4', 'qwen',
 * 'flash') so a spend cap can never under-count an unknown model. Those
 * fallbacks price a model off its NAME. Correct for a ledger, disqualifying for
 * a badge, so neither is reachable from here: we go live row → dated free
 * evidence → EXACT MODEL_RATES row → null.
 *
 * Ordered strongest-first, and free evidence outranks the table because the
 * table has no way to express "this provider bills you nothing".
 */
export function resolveModelPrice(input: ResolveTaskTagsInput): ModelPrice | null {
  const id = (input.id ?? '').trim()
  if (!id) return null
  const now = input.now ?? Date.now()

  const free = freeEvidence(id, input.providerId ?? null, input.live ?? null, input.freeModelIds, now)
  if (free) return { inPerM: 0, outPerM: 0, source: free.source, why: free.why }

  const lp = livePrice(input.live ?? null)
  if (lp) {
    return {
      inPerM: lp.inPerM,
      outPerM: lp.outPerM,
      source: 'live-catalog',
      why: "read from the provider's own live catalog this session",
    }
  }

  const rates = exactRates(id)
  if (rates) {
    return {
      inPerM: rates.inputPerM,
      outPerM: rates.outputPerM,
      source: 'price-table',
      why: 'an exact row in the bundled price table — a snapshot, so it can drift',
    }
  }
  return null
}

/**
 * Which band a proven price falls in, or null when there is no proven price.
 *
 * The four bands PARTITION every price we can prove, so `null` here means
 * exactly one thing — "we do not know what this costs" — and can never be
 * confused on screen with "this one is mid-priced".
 *
 * Order of the tests is load-bearing:
 *   free     $0 on both sides. Checked first so it is never merely "cheap".
 *   premium  EITHER side at the top-tier rate. Checked before budget so a dear
 *            output rate cannot hide behind a cheap input rate.
 *   budget   BOTH sides at or under the cheap-tier line (the SAME constants the
 *            `everyday` tag uses — one line, one anchor).
 *   mid      everything else we can price.
 */
export function priceBandOf(price: ModelPrice | null | undefined): PriceBand | null {
  if (!price) return null
  const { inPerM, outPerM } = price
  if (!Number.isFinite(inPerM) || !Number.isFinite(outPerM)) return null
  // A negative rate is not a cheaper rate, it is a corrupt one. Claim nothing.
  if (inPerM < 0 || outPerM < 0) return null
  if (inPerM === 0 && outPerM === 0) return 'free'
  if (inPerM >= PREMIUM_MIN_INPUT_USD_PER_M || outPerM >= PREMIUM_MIN_OUTPUT_USD_PER_M) return 'premium'
  if (inPerM <= EVERYDAY_MAX_INPUT_USD_PER_M && outPerM <= EVERYDAY_MAX_OUTPUT_USD_PER_M) return 'budget'
  return 'mid'
}

/**
 * A $/M rate as a bare number string for the UI to drop into a translated
 * phrase — "15", "0.25", "0.522". No currency symbol and no unit, because the
 * locale owns those words.
 *
 * NEVER ROUNDS A REAL PRICE DOWN TO ZERO: a rate too small for four decimals
 * falls back to significant figures, because "$0" is the one thing a price
 * string must not say when money is actually charged.
 */
export function formatUsdPerM(n: number): string {
  if (!Number.isFinite(n) || n < 0) return ''
  if (n === 0) return '0'
  const rounded = Number(n.toFixed(4))
  if (rounded === 0) return n.toPrecision(2)
  return String(rounded)
}

// ── The resolver ─────────────────────────────────────────────────────────────

/**
 * Model id (+ provider, + a live catalog row when the caller has one) → tags.
 *
 * The complete rule set, each with its evidence:
 *
 *   agentic      REQUIRES tool support. A model without `supportsTools` can
 *                never be agentic — the loop physically cannot run. Source:
 *                tachi/models.ts `supportsTools && agentCapable`; vetoed if a
 *                live catalog row lists capabilities and 'tools' is not among
 *                them. Unknown id → no tag.
 *   long-context contextWindow >= LONG_CONTEXT_MIN_TOKENS. A number, not an
 *                opinion. Live row's contextTokens wins; else the catalog row.
 *   vision       live capabilities include 'vision', else an entry in the dated
 *                IMAGE_INPUT_MODELS table. NEVER providers/vision.ts (a regex
 *                over the id) and never the provider-level capability list.
 *   free         see freeEvidence() above.
 *   everyday     free, or an EXACT price row at/below the Haiku-anchored
 *                threshold. Never a keyword-matched price.
 *   frontier     priceBand === 'premium' — the SAME provable price the band is
 *                built from (either side at the flagship rate). A money fact,
 *                never a quality claim; no provable price, no tag.
 *   coding       a fresh, sourced, dated entry in CURATED_MODEL_NOTES. Not
 *                derivable, so not derived.
 *   uncensored   a fresh, dated CURATED_MODEL_NOTES entry quoting the SERVING
 *                provider's own catalog. Same mechanism as coding; never the id.
 *
 * It also returns the PRICE axis — `price` and `priceBand` — which is not a tag
 * (see the price section of task-tags.ts for why) and follows the same refusal:
 * an unprovable price yields null on both, never a band and never a number.
 *
 * Pure. An id we cannot look up returns `{ tags: [], reasons: {} }` — no tags
 * beats a guessed one.
 */
export function resolveTaskTags(input: ResolveTaskTagsInput): TaskTagResult {
  const id = (input.id ?? '').trim()
  if (!id) return noTags()

  const now = input.now ?? Date.now()
  const providerId = input.providerId ?? null
  const live = input.live ?? null
  const rawId = id.toLowerCase()

  const cap = knownCapability(id)
  const tags = new Set<TaskTag>()
  const reasons: Partial<Record<TaskTag, string>> = {}

  // ── agentic ────────────────────────────────────────────────────────────────
  // The hard invariant of this whole file: no tools, never agentic.
  const liveCaps = live?.capabilities
  const liveSaysNoTools = Array.isArray(liveCaps) && liveCaps.length > 0 && !liveCaps.includes('tools')
  if (cap && cap.supportsTools && cap.agentCapable && !liveSaysNoTools) {
    tags.add('agentic')
    reasons.agentic = `takes native tool calls (${cap.toolProtocol}) and its capability row is marked agent-capable`
  }

  // ── long-context ───────────────────────────────────────────────────────────
  const liveCtx = typeof live?.contextTokens === 'number' && Number.isFinite(live.contextTokens)
    ? live.contextTokens
    : null
  const ctx = liveCtx ?? cap?.contextWindow ?? null
  if (ctx !== null && ctx >= LONG_CONTEXT_MIN_TOKENS) {
    tags.add('long-context')
    reasons['long-context'] =
      `holds ${formatTokens(ctx)} tokens at once — measured from ${liveCtx !== null ? "the provider's live catalog" : 'the model-capability catalog'}`
  }

  // ── vision ─────────────────────────────────────────────────────────────────
  if (Array.isArray(liveCaps) && liveCaps.includes('vision')) {
    tags.add('vision')
    reasons.vision = "the provider's own live catalog lists image input for this model"
  } else {
    const img = IMAGE_INPUT_MODELS[rawId]
    if (img) {
      tags.add('vision')
      reasons.vision = `image input recorded ${img.readOn} — ${img.source}`
    }
  }

  // ── price (the whole axis: the tag below AND the band on the row) ──────────
  // Resolved ONCE, here, so the `everyday` tag and the price band can never be
  // computed from two different numbers.
  const price = resolveModelPrice(input)
  const priceBand = priceBandOf(price)

  // ── free ───────────────────────────────────────────────────────────────────
  const freeWhy = freeEvidence(id, providerId, live, input.freeModelIds, now)
  if (freeWhy) {
    tags.add('free')
    reasons.free = freeWhy.why
  }

  // ── everyday ───────────────────────────────────────────────────────────────
  // Same threshold as the `budget` band, because it IS the budget band: the tag
  // names the task, the band names the money, and both read one constant.
  if (freeWhy) {
    tags.add('everyday')
    reasons.everyday = 'costs nothing, so it is a sensible default for short questions'
  } else if (
    price &&
    price.inPerM <= EVERYDAY_MAX_INPUT_USD_PER_M &&
    price.outPerM <= EVERYDAY_MAX_OUTPUT_USD_PER_M
  ) {
    tags.add('everyday')
    reasons.everyday =
      `priced at $${price.inPerM}/M in · $${price.outPerM}/M out — at or below the cheap-tier line` +
      `${price.source === 'live-catalog' ? " (the provider's live catalog)" : ' (exact row in the price table)'}`
  }

  // ── frontier ───────────────────────────────────────────────────────────────
  // The owner's "top tier" group (2026-08-02). Membership IS the premium band —
  // the same resolved price, one test away in priceBandOf — so the chip and the
  // amber PRICIEST band can never disagree about who is in the group. It claims
  // money and only money (the copy in task-tags.ts says so out loud), and a
  // model whose price we cannot prove is not in it, exactly as it has no band.
  if (priceBand === 'premium' && price) {
    tags.add('frontier')
    reasons.frontier =
      `bills at the flagship rate — $${price.inPerM}/M in · $${price.outPerM}/M out (${price.why})`
  }

  // ── coding / uncensored (curated) ──────────────────────────────────────────
  const note = CURATED_MODEL_NOTES[rawId]
  let curated: CuratedModelNote | undefined
  let notGeneralChat: string | undefined
  if (note) {
    notGeneralChat = note.notGeneralChat
    if (isCurationFresh(note, now)) {
      curated = note
      for (const t of note.tags) {
        tags.add(t)
        reasons[t] =
          `${note.claim} Source: ${note.source}, read ${note.readOn}` +
          (note.benchmark ? ` · ${note.benchmark.name}: ${note.benchmark.score}` : '')
      }
    }
    // Stale → no tags at all. staleCuratedModelIds() makes the expiry visible.
  }

  // A retired id is a fact about the model, not a judgement about it — reported
  // whether or not anything else resolved, so a surface can never render one
  // silently. Null for every id the provider still serves as itself.
  const retired = retirementOf(rawId) ?? undefined

  return {
    tags: TASK_TAGS.filter(t => tags.has(t)),
    reasons,
    capabilityMatch: cap?.match ?? null,
    price,
    priceBand,
    ...(curated ? { curated } : {}),
    ...(notGeneralChat ? { notGeneralChat } : {}),
    ...(retired ? { retired } : {}),
  }
}

/** Convenience: does this model carry `tag`? */
export function hasTaskTag(input: ResolveTaskTagsInput, tag: TaskTag): boolean {
  return resolveTaskTags(input).tags.includes(tag)
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// ── The recommendation helper ────────────────────────────────────────────────

/** A model the chooser could offer, as the UI already knows it. */
export interface ModelCandidate {
  id: string
  providerId: string
  /** A live catalog row, if this candidate came from one. */
  live?: LiveModelFacts | null
  /** See ResolveTaskTagsInput.freeModelIds — the mixed-gateway escape hatch. */
  freeModelIds?: readonly string[] | null
}

/** What the user can actually reach right now. Supplied by the UI lane. */
export interface UserAvailability {
  /**
   * Providers usable THIS SECOND: keyless ones, ones whose key is in the
   * keychain, sidecars that are installed and running, and a local engine that
   * has at least one model downloaded. The caller owns that judgement — this
   * module never touches the keychain.
   */
  readyProviderIds?: readonly string[]
  /** PRIVATE MODE: only providers whose egress is truly local may be offered. */
  privateMode?: boolean
}

export interface Recommendation {
  id: string
  providerId: string
  /** One line the UI can print under the model name. */
  reason: string
  /**
   * The ordering criteria that put this entry where it is, in the order they
   * were applied. The ranking is a lexicographic sort over these named
   * criteria — there is no opaque score anywhere in this function, so any
   * position in the list can be explained by reading this array.
   */
  because: string[]
}

export interface RecommendOptions {
  /** How many to return. Default 5 — a shortlist, not a catalog. */
  limit?: number
  now?: number
}

/**
 * MAY this resolved model be OFFERED for `tag`?
 *
 * THE ONE PREDICATE. It exists because a chip and the list it labels were
 * computed apart: the picker's task strip counted every model whose tags
 * included the tag, while the list it filtered was `recommendModels`, which
 * additionally refuses a not-a-general-chat model. A driver read
 * `READS IMAGES 24` over 23 rendered rows — the 24th was
 * `nvidia/nemotron-3.5-content-safety`, a multimodal GUARDRAIL: it genuinely
 * carries `vision`, and it is genuinely not something to hand a beginner
 * looking for a model that reads images. Both halves were right; having two
 * functions answer them was the defect.
 *
 * So the count and the list now ask THIS. Anything that would hide a row must
 * be added here, never at a call site.
 *
 * NOT included: the private-mode egress drop. That one is availability, not a
 * property of the model — it belongs to `recommendModels`, whose caller passes
 * the availability. A surface that filters by availability must count with the
 * same availability; today's pickers pass none.
 */
export function isOfferableFor(res: TaskTagResult, tag: TaskTag): boolean {
  if (!res.tags.includes(tag)) return false
  if (res.notGeneralChat) return false
  return true
}

/**
 * Given a task tag and what the user can reach, return an ordered shortlist
 * with a one-line reason each.
 *
 * ORDERING — a lexicographic sort over named criteria, applied in this order.
 * No weights, no score:
 *
 *   0. does not carry the tag              → dropped, not ranked
 *   0. flagged not-a-general-chat-model    → dropped (a beginner must not be
 *                                            handed a moderation classifier)
 *   0. private mode and egress is not local→ dropped
 *   1. reachable right now                 → before not-reachable
 *   2. free                                → before paid (a newcomer should not
 *                                            be pointed at a bill first)
 *   3. tag-specific tie-break:
 *        long-context → bigger window first
 *        agentic      → native tool calls before salvage-fallback
 *        coding       → a citation WITH a named benchmark before one without
 *        everyday     → cheaper first; unknown price last
 *        frontier     → dearest first (the group is DEFINED by price, so it
 *                       orders by price — the ask was to see the top of the
 *                       market, not to soften it)
 *        vision, free, uncensored → none
 *   4. the caller's original order (usually the provider's catalog order)
 */
export function recommendModels(
  tag: TaskTag,
  candidates: readonly ModelCandidate[],
  availability: UserAvailability = {},
  opts: RecommendOptions = {},
): Recommendation[] {
  const now = opts.now ?? Date.now()
  const limit = opts.limit ?? 5
  const ready = new Set(availability.readyProviderIds ?? [])

  interface Row {
    cand: ModelCandidate
    res: TaskTagResult
    order: number
    reachable: boolean
    free: boolean
    tie: number          // lower sorts first
    tieLabel: string | null
  }

  const rows: Row[] = []
  candidates.forEach((cand, order) => {
    const res = resolveTaskTags({
      id: cand.id,
      providerId: cand.providerId,
      live: cand.live,
      freeModelIds: cand.freeModelIds,
      now,
    })
    // The SHARED predicate — the same one the pickers count with, so a task
    // chip can never name a number the list beneath it does not render.
    if (!isOfferableFor(res, tag)) return
    if (availability.privateMode && localityOf(getProvider(cand.providerId)) !== 'local') return

    const reachable = ready.size === 0 ? true : ready.has(cand.providerId)
    const free = res.tags.includes('free')
    const { tie, tieLabel } = tieBreak(tag, cand, res)
    rows.push({ cand, res, order, reachable, free, tie, tieLabel })
  })

  rows.sort((a, b) =>
    Number(b.reachable) - Number(a.reachable) ||
    Number(b.free) - Number(a.free) ||
    a.tie - b.tie ||
    a.order - b.order,
  )

  return rows.slice(0, limit).map(r => {
    const because: string[] = []
    if (ready.size > 0) {
      because.push(r.reachable
        ? 'you can use this provider right now'
        : 'needs a key or a download before it will run')
    }
    because.push(r.free ? 'costs nothing' : 'you pay for this one')
    if (r.tieLabel) because.push(r.tieLabel)
    because.push('otherwise kept in catalog order')

    return {
      id: r.cand.id,
      providerId: r.cand.providerId,
      reason: r.res.reasons[tag] ?? TASK_TAG_COPY[tag].blurb,
      because,
    }
  })
}

/**
 * The per-tag tie-break. Returns a sortable number (lower first) and the label
 * that goes into `because`, or null when the tag has no tie-break of its own.
 */
function tieBreak(tag: TaskTag, cand: ModelCandidate, res: TaskTagResult): { tie: number; tieLabel: string | null } {
  switch (tag) {
    case 'long-context': {
      const cap = resolveCapability(cand.id)
      const ctx = (typeof cand.live?.contextTokens === 'number' ? cand.live.contextTokens : null)
        ?? (cap.match === '*' ? 0 : cap.contextWindow)
      return { tie: -ctx, tieLabel: `bigger context window first (${formatTokens(ctx)})` }
    }
    case 'agentic': {
      const cap = resolveCapability(cand.id)
      const rank = cap.match === '*' ? 2 : cap.toolProtocol === 'native' ? 0 : cap.toolProtocol === 'native-then-salvage' ? 1 : 2
      return { tie: rank, tieLabel: 'reliable native tool calls before ones that need a text-salvage fallback' }
    }
    case 'coding': {
      const hasBenchmark = !!res.curated?.benchmark
      return { tie: hasBenchmark ? 0 : 1, tieLabel: 'a published benchmark number ranks above a vendor description alone' }
    }
    case 'everyday': {
      // The SAME price the badge shows — `res.price` was resolved by
      // resolveModelPrice, so the ranking and the printed rate can never come
      // from two different numbers. Unknown price sorts last rather than being
      // guessed at zero.
      const cost = res.price ? res.price.inPerM + res.price.outPerM : Number.MAX_SAFE_INTEGER
      return { tie: cost, tieLabel: 'cheaper first; a model with no known price goes last' }
    }
    case 'frontier': {
      // Everyday's mirror. The tag requires a proven premium price, so
      // `res.price` is always set here; the fallback merely keeps the sort
      // total if that invariant ever breaks upstream.
      const cost = res.price ? -(res.price.inPerM + res.price.outPerM) : 0
      return { tie: cost, tieLabel: 'the highest rate first — this group is defined by price' }
    }
    default:
      return { tie: 0, tieLabel: null }
  }
}
