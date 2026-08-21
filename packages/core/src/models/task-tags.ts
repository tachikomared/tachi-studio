// packages/core/src/models/task-tags.ts
//
// THE beginner-facing task taxonomy for the model chooser: a small, closed set
// of tags a newcomer recognises ("coding", "works on its own", "reads images"),
// plus the evidence tables the resolver derives them from.
//
// PURE DATA + PURE TYPES. No node:*, no I/O. Renderer-safe via the subpath
// `@tachi/core/src/models/task-tags`.
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE ─────────────────────────────────────
// Every tag is either DERIVED from a fact we hold (tool support, context size,
// modality, price) or CURATED with a source and a date. Where neither exists,
// the model gets NO tag — never a guessed one.
//
// This repo has twice shipped a claim that was asserted instead of derived: a
// LOCAL badge over a cloud relay (registry.ts::localityOf), and a `:free`
// suffix read as a price (pricing.ts::VERIFIED_FREE_MODELS). A taxonomy that
// said "good at coding" because the id contains "coder" would be the same bug
// wearing a friendlier face. So:
//
//   FORBIDDEN, and pinned by tests:
//     · deriving any tag from a substring of a model id;
//     · tagging a model `agentic` when it has no tool support;
//     · a curated entry without a source AND a date;
//     · defaulting an unknown model to anything other than "no tags".
//
//   ALLOWED as evidence:
//     · packages/core/src/tachi/models.ts capability rows (tools, context,
//       agentCapable) — the same facts the TACHI harness already trusts;
//     · packages/core/src/providers/registry.ts (egress, billing);
//     · packages/core/src/pricing.ts (VERIFIED_FREE_MODELS, MODEL_RATES);
//     · a provider catalog's live row handed in at call time (UnifiedModel);
//     · the dated tables below: our own measured catalog reads, a vendor's own
//       catalog `description` field, or a published benchmark WITH its name.

import type { ModelCapability as ProviderModelCapability } from '../providers/registry.js'

// ── The tag vocabulary ───────────────────────────────────────────────────────

/**
 * The closed set. EIGHT tags — a picker with fourteen groups helps nobody.
 *
 * Six at birth; `uncensored` and `frontier` joined on 2026-08-02 at the
 * owner's explicit request ("Топ тиер" group; "некоторые провайдеры дают
 * uncensored models — группирни"). Both stay inside the evidence rule:
 * `frontier` is derived from the SAME provable price the premium band is
 * built from, and `uncensored` is a dated curated quote of the serving
 * provider's own catalog. See the amended 'best / most capable' rejection.
 *
 * Each tag earns its place by being (a) something a beginner would actually
 * search for, and (b) derivable from evidence we hold. The rejected candidates
 * and the reason each was rejected are recorded in REJECTED_TAGS below, so the
 * next person doesn't re-litigate them from scratch.
 */
export type TaskTag =
  | 'agentic'
  | 'coding'
  | 'everyday'
  | 'long-context'
  | 'vision'
  | 'uncensored'
  | 'frontier'
  | 'free'

/**
 * Display order for a picker. Not a ranking — the resolver emits tags in this
 * order so output is stable and diffable. The two price poles (`frontier`,
 * `free`) sit together at the end, where the strip reads them as a pair.
 */
export const TASK_TAGS: readonly TaskTag[] = [
  'agentic',
  'coding',
  'everyday',
  'long-context',
  'vision',
  'uncensored',
  'frontier',
  'free',
] as const

/** Type guard for a tag coming in from the UI / settings / a saved filter. */
export function isTaskTag(v: unknown): v is TaskTag {
  return typeof v === 'string' && (TASK_TAGS as readonly string[]).includes(v)
}

// ── Beginner-facing copy (English only — see I18N note below) ────────────────

export interface TaskTagCopy {
  /** Short group heading. Two or three words; fits a chip. */
  label: string
  /** One sentence of plain English. No jargon, no vendor adjectives. */
  blurb: string
}

/**
 * ENGLISH ONLY, deliberately. The later UI lane owns the other seven locales.
 *
 * WHERE THESE SHOULD LIVE once the UI lands: add a `taskTags` block to the
 * EXISTING `providers` namespace — apps/desktop/src/i18n/locales/<lang>/providers.json
 * — rather than minting a 22nd namespace for twelve strings. The chooser is
 * part of the provider/model picker surface, and `providers.json` already
 * exists in all 8 locales.
 *
 * The key scheme is fixed by `taskTagI18nKey()` below so the UI lane cannot
 * invent a second one:
 *
 *   providers:taskTags.agentic.label
 *   providers:taskTags.agentic.blurb
 *   … × 8 tags
 *
 * i.e. exactly 16 keys per locale, 128 across the 8 locales. Copy the English
 * values below verbatim as the `en` source of truth.
 */
export const TASK_TAG_COPY: Record<TaskTag, TaskTagCopy> = {
  agentic: {
    label: 'Works on its own',
    blurb: 'Can use tools and take several steps by itself — reading files, searching, running commands — instead of only replying.',
  },
  coding: {
    label: 'Writing code',
    blurb: 'The people who made it publish it as a model built for programming; the claim and its date are shown on the model.',
  },
  everyday: {
    label: 'Everyday questions',
    blurb: 'Priced at the cheap end, so it is a sensible default for short questions, drafts and summaries.',
  },
  'long-context': {
    label: 'Long documents',
    blurb: 'Holds a very large amount of text at once — a long report, or a whole folder of notes.',
  },
  vision: {
    label: 'Reads images',
    blurb: 'You can attach a screenshot or a photo and ask questions about it.',
  },
  uncensored: {
    label: 'Uncensored',
    blurb: 'The provider itself describes this model as uncensored — fewer content refusals. Its own claim, with the date we read it, is shown on the model.',
  },
  frontier: {
    label: 'Top tier',
    blurb: 'The vendors’ flagship models, grouped purely by price: every one of these bills at the top rate we list. Costing the most is the fact; being best for your task is not promised.',
  },
  free: {
    label: 'Costs nothing',
    blurb: 'Free to use right now — either your own hardware, or a free tier we checked against the provider on the date shown.',
  },
}

/** The ONE i18n key scheme for tag copy. See the note on TASK_TAG_COPY. */
export function taskTagI18nKey(tag: TaskTag, field: keyof TaskTagCopy): string {
  return `providers:taskTags.${tag}.${field}`
}

/**
 * Candidates considered and REJECTED, with the reason. Kept in code (not only
 * in a report) because "why isn't there an image-generation group?" is a
 * question this file will be asked repeatedly.
 */
export const REJECTED_TAGS: ReadonlyArray<{ candidate: string; reason: string }> = [
  {
    candidate: 'image generation',
    reason:
      'Belongs to the Media/Studio surface, which has its own per-modality catalogs. The only evidence a TEXT model picker holds is ' +
      "ProviderDescriptor.capabilities containing 'image' — a PROVIDER-level fact that cannot be attributed to an individual model " +
      "(Venice's text LLM is not an image generator). Tagging from it would be exactly the guess this file forbids.",
  },
  {
    candidate: 'audio input / omni',
    reason:
      'Exactly one model we serve accepts audio (nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free, measured 2026-08-01), and no chat ' +
      'surface accepts an audio attachment today. One model with nowhere to use it is not a group.',
  },
  {
    candidate: 'reasoning / thinking',
    reason:
      'The only signals available are a "-reasoning" id suffix and a `reasoning_content` field seen in one probe. The first is a substring ' +
      'rule; the second says a field exists, not that reasoning is good. No honest derivation.',
  },
  {
    candidate: 'fast',
    reason:
      'We have never measured per-model latency — only per-gateway burst timings (5 sequential requests). "Fast" would be a vendor adjective ' +
      'relabelled as a fact. The `everyday` tag carries the price half of what people mean by "fast and cheap", and says so.',
  },
  {
    candidate: 'private / local',
    reason:
      'Not a task, and locality already has exactly one honest owner — registry.ts::providerLocality(). A second surface making a locality ' +
      'claim is how the LOCAL-over-a-relay bug happened. The recommender still USES locality for ordering and private-mode filtering; it just ' +
      'does not mint a competing badge.',
  },
  {
    candidate: 'best / most capable',
    reason:
      'No leaderboard we can cite covers the models we actually route to, and "bigger parameter count" is not a capability. A beginner ' +
      'asking for "the best one" is better served by the `coding` / `agentic` groups plus the honest price, which they get. ' +
      'AMENDED 2026-08-02: the owner asked for a top-tier group outright, and it shipped — as `frontier`, whose membership is the ' +
      'premium PRICE band and nothing else, and whose copy says so. The QUALITY claim stays rejected: nothing here calls a model better.',
  },
]

// ── Thresholds (stated once, here, so no caller invents a second one) ────────

/**
 * A model earns `long-context` at 200,000 tokens or more.
 *
 * This IS a threshold choice, not a measurement, so it is written down once.
 * 200k is roughly a 500-page book at ~4 characters per token, and it is where
 * our own catalog naturally splits: the values we hold cluster at
 * 8k / 32k / 64k / 128k, then jump to 200k / 256k / 262k / 500k / 1M. Every
 * model above the line genuinely serves that window — the number is measured,
 * only the line is a judgement.
 */
export const LONG_CONTEXT_MIN_TOKENS = 200_000

/**
 * A model earns `everyday` at or below $1.00/M input AND $5.00/M output.
 *
 * Anchored, not invented: that is exactly Claude Haiku 4.5's published rate,
 * and Anthropic's own catalog positions Haiku as the "fastest and most
 * cost-effective model for simple tasks" (Anthropic model catalog, read via the
 * bundled claude-api skill, cached 2026-06-24). So the line is drawn at a real
 * published cheap-tier model rather than at a round number someone liked.
 */
export const EVERYDAY_MAX_INPUT_USD_PER_M = 1
export const EVERYDAY_MAX_OUTPUT_USD_PER_M = 5

/**
 * How long a curated claim stays usable before it goes stale and its tags are
 * dropped. Model families are re-released under the same name, so an undated —
 * or indefinitely-dated — citation rots invisibly.
 *
 * 180 days: quality positioning drifts far slower than price (pricing.ts's
 * snapshot drifts in weeks) but a family rarely survives two quarters unchanged.
 * `staleCuratedModelIds()` makes expiry visible instead of silent.
 */
export const CURATION_MAX_AGE_DAYS = 180

// ── The PRICE axis (a second vocabulary, deliberately not a seventh tag) ──────
//
// WHY THIS IS NOT A TAG. The six tags answer "what is this model FOR". Price
// answers "what will this cost me", and a model is routinely both `coding` and
// expensive — the two are orthogonal, so folding price into the same closed set
// would make the filter strip answer two different questions with one control.
// It also would not fit: the strip already carries six chips.
//
// WHY IT IS NEEDED ANYWAY. Price was already half-present and illegible. The
// `everyday` tag is defined ENTIRELY by price (see the threshold above) but is
// NAMED for a task, so a newcomer reading "Everyday questions" has no way to
// know they are looking at the cheap tier — and nothing at all told them that
// the row above it bills at fifteen times the rate. This vocabulary states the
// money in money's own words.
//
// THE SAME REFUSAL AS THE TAGS. A band is derived from a price we can PROVE:
// a live catalog row, the dated verified-free list, or an EXACT row in
// pricing.ts::MODEL_RATES. Never from `ratesFor()`'s keyword fallback, which
// prices a model off its NAME ('gpt-4', 'qwen', 'flash') — that is fine for a
// spend cap that must not under-count, and disqualifying for a claim shown to a
// user. A model whose price we do not know gets NO band, exactly as an
// unclassifiable model gets no tags.

/**
 * FOUR bands, and the count is the argument.
 *
 * Two would be the obvious reading of "most expensive and cheapest" — but then
 * every model priced between the poles carries no band, which on screen is
 * indistinguishable from "we do not know what this costs". That collapse is
 * exactly what this module exists to prevent: the absence of a band has to mean
 * ONE thing. So the bands PARTITION the prices we can prove, and `null` is
 * reserved for ignorance.
 *
 * `free` is separate from `budget` rather than folded into it because $0 is a
 * different kind of statement from "cheap" — it is the only price with no risk
 * attached, and it is the one a newcomer is looking for first.
 */
export type PriceBand = 'free' | 'budget' | 'mid' | 'premium'

/** Cheapest → dearest. Also the display order. */
export const PRICE_BANDS: readonly PriceBand[] = ['free', 'budget', 'mid', 'premium'] as const

/** Type guard for a band arriving from the UI / settings / a saved filter. */
export function isPriceBand(v: unknown): v is PriceBand {
  return typeof v === 'string' && (PRICE_BANDS as readonly string[]).includes(v)
}

/**
 * ENGLISH ONLY, same contract as TASK_TAG_COPY — the eight locales carry the
 * rest under `providers:priceBands.<band>.{label,blurb}`.
 *
 * NAMING RULE, and it is why none of these say "frontier" or "flagship": the
 * label has to mean something to somebody who has never bought a token. It also
 * must not read as a QUALITY claim — "premium" and "top-tier" both imply the
 * model is BETTER, which is a claim this module has no evidence for and
 * REJECTED_TAGS explicitly refuses to make. Every label below names money and
 * only money.
 *
 * And a band is a SUMMARY. The exact $/M rate is printed next to it on the row,
 * because the summary is our judgement and the number is the fact.
 */
export const PRICE_BAND_COPY: Record<PriceBand, TaskTagCopy> = {
  free: {
    label: 'No charge',
    blurb: 'Nothing is billed for this one — the rate shown beside this label is $0.',
  },
  budget: {
    label: 'Low cost',
    blurb: 'At the cheap end of what we list. The exact rate is printed beside this label.',
  },
  mid: {
    label: 'Mid-priced',
    blurb: 'Between the cheap tier and the most expensive tier. The exact rate is printed beside this label.',
  },
  premium: {
    label: 'Priciest',
    blurb: 'Among the most expensive models we list. Check the rate beside this label before you start a long job.',
  },
}

/** The ONE i18n key scheme for band copy. Mirrors taskTagI18nKey(). */
export function priceBandI18nKey(band: PriceBand, field: keyof TaskTagCopy): string {
  return `providers:priceBands.${band}.${field}`
}

/**
 * THE CHEAP LINE is not a second line: `budget` reuses EVERYDAY_MAX_* above.
 *
 * Deliberate. Those constants already draw a cheap-tier boundary at Claude
 * Haiku 4.5's published rate, and two boundaries for the same idea would sooner
 * or later disagree — one gets nudged, the other does not, and the picker shows
 * a model tagged "Everyday questions" next to a band saying it is mid-priced.
 * One line, one anchor, one place to change it.
 */

/**
 * THE EXPENSIVE LINE: $5.00/M input OR $25.00/M output.
 *
 * Anchored on a measurement, not a round number. Read from OpenRouter's keyless
 * live catalog (openrouter.ai/api/v1/models) on 2026-08-02, the flagship tier of
 * every vendor we route to lands on exactly this step:
 *
 *     anthropic/claude-opus-5    $5.00 in / $25.00 out
 *     anthropic/claude-opus-4.8  $5.00 in / $25.00 out
 *     anthropic/claude-opus-4.6  $5.00 in / $25.00 out
 *     openai/gpt-5.5             $5.00 in / $30.00 out
 *     openai/gpt-5.6-sol         $5.00 in / $30.00 out
 *
 * …and the next rung down is a clear gap away (claude-sonnet-4.6 $3/$15,
 * gpt-5.4 $2.50/$15, claude-sonnet-5 $2/$10). Above the line the catalog runs
 * all the way to $30/$180 (openai/gpt-5.5-pro, openai/gpt-5.4-pro) and $30/$150
 * (anthropic/claude-opus-4.7-fast), so "priciest" is not an overstatement.
 *
 * OR, NOT AND — the mirror of the cheap line's AND. Both rules err toward
 * telling the user the truth they would rather hear early: a model only counts
 * as cheap when BOTH halves are cheap, and counts as expensive when EITHER half
 * is at the top tier. A dear output rate cannot hide behind a cheap input rate.
 */
export const PREMIUM_MIN_INPUT_USD_PER_M = 5
export const PREMIUM_MIN_OUTPUT_USD_PER_M = 25

// ── Evidence table 1: image input (the `vision` fact) ────────────────────────

export interface ImageInputFact {
  /** Where the modality was read. Must name the catalog/doc, not "the internet". */
  source: string
  /** ISO date the source was read. */
  readOn: string
}

/**
 * One fact under every SPELLING a gateway serves the same model as.
 *
 * This is bookkeeping, NOT a normalisation rule: each accepted spelling is
 * written out by hand, and a spelling that does not unambiguously name the same
 * model is simply not in the list. A rule ("strip the org prefix and match")
 * would silently accept `acme/claude-opus-5`, which is how a substring
 * inference gets back in through the door marked convenience.
 */
function sameImageFact(ids: readonly string[], fact: ImageInputFact): Record<string, ImageInputFact> {
  return Object.fromEntries(ids.map(id => [id, fact]))
}

/**
 * Models VERIFIED to accept image input, per model, with a source and a date.
 *
 * Deliberately NOT derived from providers/vision.ts::isVisionModel(), which is
 * an explicit regex heuristic over the model ID ("/gemini/i", "/grok-?4/i").
 * That function is fine for its job — showing a soft hint on the Nodes canvas,
 * where a miss costs nothing — but a beginner-facing "Reads images" group that
 * came from a regex over names is the id-substring rule under another name.
 *
 * A live catalog row handed to the resolver (UnifiedModel.capabilities
 * containing 'vision') always wins over this table; the table is the fallback
 * for surfaces that have only an id.
 *
 * Keys are matched against the RAW lowercased id — every accepted spelling is
 * listed explicitly, exactly as VERIFIED_FREE_MODELS does. Gateway spellings of
 * the same model (dotted vs dashed Claude ids) are listed as separate rows.
 */
export const IMAGE_INPUT_MODELS: Record<string, ImageInputFact> = {
  // ── Free rows, from OUR OWN measured catalog reads ────────────────────────
  // notes/FREE-FLEET-SWEEP-2026-08-01.md §3 — OpenRouter live catalogue,
  // `architecture.input_modalities` per model.
  'google/gemma-4-31b-it:free': {
    source: 'OpenRouter live catalogue, input_modalities [image, text, video] — notes/FREE-FLEET-SWEEP-2026-08-01.md §3',
    readOn: '2026-08-01',
  },
  'google/gemma-4-26b-a4b-it:free': {
    source: 'OpenRouter live catalogue, input_modalities [image, text, video] — notes/FREE-FLEET-SWEEP-2026-08-01.md §3',
    readOn: '2026-08-01',
  },
  'nvidia/nemotron-nano-12b-v2-vl:free': {
    source: 'OpenRouter live catalogue, input_modalities [image, text, video] — notes/FREE-FLEET-SWEEP-2026-08-01.md §3',
    readOn: '2026-08-01',
  },
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': {
    source: 'OpenRouter live catalogue, input_modalities [text, audio, image, video] — notes/FREE-FLEET-SWEEP-2026-08-01.md §3',
    readOn: '2026-08-01',
  },
  'nvidia/nemotron-3.5-content-safety:free': {
    source: 'OpenRouter live catalogue, input_modalities [text, image] — notes/FREE-FLEET-SWEEP-2026-08-01.md §3',
    readOn: '2026-08-01',
  },
  // notes/OMNIROUTE-PROVIDER-RESEARCH-2026-08-01.md §4 — Kilo Gateway
  // keyless catalog. Independently re-read 2026-08-01 during this work and the
  // modalities agreed; the doc stays the cited source because it is ours and
  // it is what the shipped whitelist was built from.
  'stepfun/step-3.7-flash:free': {
    source: 'Kilo Gateway keyless catalog, text+image — notes/OMNIROUTE-PROVIDER-RESEARCH-2026-08-01.md §4',
    readOn: '2026-08-01',
  },
  'openrouter/free': {
    source: 'Kilo Gateway keyless catalog, text+image — notes/OMNIROUTE-PROVIDER-RESEARCH-2026-08-01.md §4',
    readOn: '2026-08-01',
  },

  // ── Paid flagships a user with a key meets first ──────────────────────────
  // Anthropic states image input for the WHOLE family in one line — "All
  // current Claude models support text and image input, text output,
  // multilingual capabilities, and vision" — and the Vision docs' resolution
  // table assigns every model a tier, which is a per-model statement rather
  // than a family generalisation. Re-read first-party on 2026-08-02.
  //
  // Gateways spell these differently (bankr-gateway dotted, Venice dashed,
  // OpenRouter `anthropic/`-prefixed), so every spelling that reaches this app
  // is written out. No normalisation RULE is applied — that is how a substring
  // inference gets in.
  ...sameImageFact(
    [
      'claude-fable-5',                        'anthropic/claude-fable-5',
      'claude-opus-5',                         'anthropic/claude-opus-5',
      'claude-opus-4-8',   'claude-opus-4.8',  'anthropic/claude-opus-4.8',
      'claude-opus-4-6',   'claude-opus-4.6',  'anthropic/claude-opus-4.6',
      'claude-sonnet-5',                       'anthropic/claude-sonnet-5',
      'claude-sonnet-4-6', 'claude-sonnet-4.6','anthropic/claude-sonnet-4.6',
      'claude-sonnet-4-5', 'claude-sonnet-4.5','anthropic/claude-sonnet-4.5',
      'claude-haiku-4-5',  'claude-haiku-4.5', 'anthropic/claude-haiku-4.5',
    ],
    {
      source: 'Anthropic docs, Models overview ("All current Claude models support text and image input") + the Vision docs per-model resolution-tier table (platform.claude.com/docs/en/docs/build-with-claude/vision)',
      readOn: '2026-08-02',
    },
  ),

  // OpenAI publishes input modalities per model page. NOTE the two gpt-oss
  // models are deliberately ABSENT: their pages state "Input modalities: text",
  // so an open-weight sibling of an image-capable family gets no vision row.
  ...sameImageFact(
    ['gpt-5.5', 'openai/gpt-5.5', 'gpt-5.4', 'openai/gpt-5.4', 'gpt-5-mini', 'openai/gpt-5-mini'],
    {
      source: 'OpenAI API docs, per-model pages listing text and image inputs (developers.openai.com/api/docs/models/…)',
      readOn: '2026-08-02',
    },
  ),

  // Google states inputs on the model card / API docs page per model.
  ...sameImageFact(
    [
      'gemini-3.1-pro', 'gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview',
      'gemini-3-flash', 'gemini-3-flash-preview',
      'gemini-2.5-flash', 'google/gemini-2.5-flash',
      'gemini-3.1-flash-lite',
    ],
    {
      source: 'Google DeepMind model cards + ai.google.dev/gemini-api/docs/models — Inputs row lists text, images, audio and video',
      readOn: '2026-08-02',
    },
  ),

  // Remaining gateway models, from OpenRouter's live catalogue
  // `architecture.input_modalities` (openrouter.ai/api/v1/models), re-read
  // 2026-08-02. Same field, same endpoint, same discipline as the free rows.
  ...sameImageFact(['kimi-k3', 'moonshotai/kimi-k3'], {
    source: 'OpenRouter live catalogue, input_modalities [text, image] for moonshotai/kimi-k3 (openrouter.ai/api/v1/models)',
    readOn: '2026-08-02',
  }),
  ...sameImageFact(['minimax-m3', 'minimax/minimax-m3'], {
    source: 'OpenRouter live catalogue, input_modalities [text, image, video] for minimax/minimax-m3 (openrouter.ai/api/v1/models)',
    readOn: '2026-08-02',
  }),
  ...sameImageFact(['mimo-v2.5', 'xiaomi/mimo-v2.5'], {
    source: 'OpenRouter live catalogue, input_modalities [text, audio, image, video] for xiaomi/mimo-v2.5 (openrouter.ai/api/v1/models)',
    readOn: '2026-08-02',
  }),
  ...sameImageFact(['grok-4.3', 'x-ai/grok-4.3'], {
    source: 'OpenRouter live catalogue, input_modalities [text, image, file] for x-ai/grok-4.3 (openrouter.ai/api/v1/models)',
    readOn: '2026-08-02',
  }),
  ...sameImageFact(['mistralai/mistral-small-3.1-24b-instruct'], {
    source: 'Mistral model card for Mistral Small 3.1 24B Instruct — "Vision: Vision capabilities enable the model to analyze images", with a published Vision Evals table (huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503)',
    readOn: '2026-08-02',
  }),

  // Venice's two image-capable rows, from Venice's OWN catalog fields — the
  // same catalog the Venice picker forwards live. Kept here so the fact
  // survives a fallback render, when nothing live is forwarded.
  ...sameImageFact(['venice-uncensored-1-2'], {
    source: "Venice live model catalog (api.venice.ai/api/v1/models) — `supportsVision: true`, `supportsMultipleImages: true` on this entry",
    readOn: '2026-08-02',
  }),
  ...sameImageFact(['qwen-2.5-vl'], {
    source: 'Qwen model card for Qwen2.5-VL — "highly capable of analyzing texts, charts, icons, graphics, and layouts within images", with an image-passing quickstart (huggingface.co/Qwen/Qwen2.5-VL-72B-Instruct)',
    readOn: '2026-08-02',
  }),
  // NOT here, and each is a trap the family name would have walked into:
  // kimi-k2 (text-only while k2.5/k2.6/k3 have vision), minimax-m2.5 (text-only
  // while minimax-m3 is multimodal), mimo-v2.5-pro (text-only while the SMALLER
  // mimo-v2.5 takes images), qwen3.7-max (the bare alias is text-only; only the
  // pinned qwen3.7-max-2026-06-08 snapshot accepts images), and every GLM /
  // DeepSeek / Llama 3.3 row we serve. All confirmed per-model on the vendor's
  // own page, 2026-08-02. "This family is multimodal" was wrong about half the
  // time across that sweep.
}

// ── Evidence table 2: curated quality claims (the `coding` tag) ──────────────

export interface CuratedModelNote {
  /** Which tags this citation supports. 'coding' and 'uncensored' are the
   *  curated tags today; everything else is derived, never curated. */
  tags: readonly TaskTag[]
  /** A specific, re-checkable source. Never "benchmarks" or "widely regarded". */
  source: string
  /** ISO date the source was read. Required — an undated citation rots invisibly. */
  readOn: string
  /** The claim, quoted or closely paraphrased from that source. */
  claim: string
  /** Named benchmark + number, when the source published one. Name is required. */
  benchmark?: { name: string; score: string }
  /**
   * Set when the model is NOT a general-purpose chat model. The recommender
   * refuses to shortlist these — a beginner must not be handed a moderation
   * classifier because it happens to read images.
   */
  notGeneralChat?: string
}

/** The CuratedModelNote twin of sameImageFact(). Same reasoning: spellings are
 *  enumerated, never derived. */
function sameCuratedNote(ids: readonly string[], note: CuratedModelNote): Record<string, CuratedModelNote> {
  return Object.fromEntries(ids.map(id => [id, note]))
}

/**
 * DATED, SOURCED quality claims — the half that cannot be derived.
 *
 * The bar, and it is the whole point of this table:
 *   · a vendor's own catalog description for a model it serves;
 *   · a published benchmark WITH the benchmark named and the number recorded;
 *   · our own live measurement.
 * NOT admissible: a marketing adjective with no number ("blazing fast",
 * "best-in-class") stated as fact; a number without its source; extrapolation
 * from a sibling model ("the 118B is good at code so the 33B must be").
 *
 * Populated from the models a newcomer meets FIRST — the keyless free rows we
 * surface, then the flagship behind the key the owner is likeliest to have.
 * A perfect table covering 300 models nobody sees is worth less than a correct
 * one covering the dozen a newcomer hits on day one.
 *
 * Every entry expires at CURATION_MAX_AGE_DAYS. Refreshing one means re-reading
 * the source and bumping `readOn` — not deleting the date.
 *
 * ID SPELLING: keys are matched against the RAW lowercased id. Where a gateway
 * serves the same model under a different spelling (Bankr's dotted Claude ids),
 * both spellings are listed. A spelling that does not unambiguously name the
 * same model is NOT listed — no normalisation rule is applied.
 */
export const CURATED_MODEL_NOTES: Record<string, CuratedModelNote> = {
  // ── Keyless free rows (OpenRouter / Kilo catalog `description` field) ──────
  'poolside/laguna-s-2.1:free': {
    tags: ['coding'],
    source: "OpenRouter model catalog, `description` field for poolside/laguna-s-2.1 (openrouter.ai/api/v1/models)",
    readOn: '2026-08-01',
    claim: 'Poolside describes it as "the latest coding agent model from Poolside", a 118B/8B-active model.',
    benchmark: { name: 'Terminal-Bench 2.1', score: '70.2% (reported by Poolside via the OpenRouter catalog)' },
  },
  'poolside/laguna-xs-2.1:free': {
    tags: ['coding'],
    source: "OpenRouter model catalog, `description` field for poolside/laguna-xs-2.1 (openrouter.ai/api/v1/models)",
    readOn: '2026-08-01',
    claim: 'Poolside describes it as "the latest coding agent model in the 33B-A3B category".',
    // No benchmark number published for this size in the catalog row — and the
    // sibling's 70.2% is NOT borrowed. Size is not a capability.
  },
  'cohere/north-mini-code:free': {
    tags: ['coding'],
    source: "OpenRouter model catalog, `description` field for cohere/north-mini-code (openrouter.ai/api/v1/models)",
    readOn: '2026-08-01',
    claim: 'Cohere describes it as "Cohere\'s first agentic coding model", a 30B/3B-active sparse MoE optimized for agentic coding.',
  },
  'stepfun/step-3.7-flash:free': {
    tags: ['coding'],
    source: 'Kilo Gateway model catalog, `description` field for stepfun/step-3.7-flash:free (api.kilo.ai/api/gateway/models)',
    readOn: '2026-08-01',
    claim: 'StepFun states it is "Designed for coding, agentic workflows, structured outputs, and long-context productivity tasks."',
  },

  // ── Not a general chat model — kept OUT of every shortlist ─────────────────
  'nvidia/nemotron-3.5-content-safety:free': {
    tags: [],
    source: 'Kilo Gateway model catalog, `description` field (api.kilo.ai/api/gateway/models)',
    readOn: '2026-08-01',
    claim: 'NVIDIA describes it as a 4B "multimodal guardrail model" that "moderates both inputs to and responses from LLMs and VLMs".',
    notGeneralChat: 'This is a content-moderation classifier, not a chat model — it scores text instead of answering it.',
  },

  // ══ PAID MODELS, first-party sources, all re-read 2026-08-02 ═══════════════
  //
  // WHEN TWO ADMISSIBLE SOURCES DISAGREE, THE MAKER WINS — and if the maker
  // declines to make the claim, we decline too. A reseller's catalogue blurb is
  // admissible evidence (it is how the free rows below are sourced) but it is a
  // summary written by someone who did not build the model. Three entries in
  // this table exist ONLY to record that decision, with `tags: []`, so the next
  // person does not redo the research and reach the opposite answer from the
  // easier source. See claude-fable-5, claude-opus-4.8 and gemini-2.5-flash.

  ...sameCuratedNote(['claude-opus-5', 'anthropic/claude-opus-5'], {
    tags: ['coding'],
    source: 'Anthropic docs, Models overview comparison table (platform.claude.com/docs/en/docs/about-claude/models/overview)',
    readOn: '2026-08-02',
    claim: 'Anthropic\'s own description row reads "For complex agentic coding and enterprise work", and its guidance line tells you to start here for exactly that.',
    // Anthropic NAMES Frontier-Bench v0.1, CursorBench 3.2 and Terminal-Bench
    // but publishes the coding numbers only inside chart images; the prose
    // carries relative claims ("more than doubles Opus 4.8"). A number we
    // cannot read is not a number, so no benchmark is recorded.
  }),
  ...sameCuratedNote(['claude-sonnet-5', 'anthropic/claude-sonnet-5'], {
    tags: ['coding'],
    source: 'Anthropic product page for Claude Sonnet 5 (anthropic.com/claude/sonnet) + launch post (anthropic.com/news/claude-sonnet-5)',
    readOn: '2026-08-02',
    claim: 'Anthropic states it "delivers exceptional coding performance across the entire software development lifecycle".',
    // The numeric footnotes on that page restate SONNET 4.6 scores. A sibling's
    // number is never borrowed, so none is recorded here.
  }),
  ...sameCuratedNote(['claude-sonnet-4.6', 'claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'], {
    tags: ['coding'],
    source: 'Anthropic launch post for Claude Sonnet 4.6 (anthropic.com/news/claude-sonnet-4-6)',
    readOn: '2026-08-02',
    claim: 'Anthropic states that "Sonnet 4.6 brings much-improved coding skills to more of our users".',
    benchmark: { name: 'SWE-bench Verified', score: '79.2% (reported by Anthropic; 80.2% with a prompt modification)' },
    // THIS ROW USED TO BE A DELIBERATE ABSENCE. The previous citation was an
    // older Anthropic catalog entry that called it "previous-generation Sonnet"
    // and named no coding positioning, so it earned no tag — correctly, on the
    // evidence then held. A first-party re-read on 2026-08-02 found the launch
    // post, which makes the claim outright and publishes a number. The rule did
    // not change; the evidence did.
  }),
  ...sameCuratedNote(['claude-haiku-4.5', 'claude-haiku-4-5', 'anthropic/claude-haiku-4.5'], {
    tags: ['coding'],
    source: 'Anthropic launch post for Claude Haiku 4.5 (anthropic.com/news/claude-haiku-4-5)',
    readOn: '2026-08-02',
    claim: 'Anthropic states it "gives you similar levels of coding performance but at one-third the cost and more than twice the speed" of Claude Sonnet 4.',
    benchmark: { name: 'SWE-bench Verified', score: '73.3% (reported by Anthropic)' },
  }),
  ...sameCuratedNote(['claude-opus-4.6', 'claude-opus-4-6', 'anthropic/claude-opus-4.6'], {
    tags: ['coding'],
    source: 'Anthropic launch post for Claude Opus 4.6 (anthropic.com/news/claude-opus-4-6)',
    readOn: '2026-08-02',
    claim: 'Anthropic states it "improves on its predecessor\'s coding skills", plans more carefully and "can operate more reliably in larger codebases".',
    benchmark: { name: 'SWE-bench Verified', score: '81.42% with a prompt modification (reported by Anthropic)' },
  }),
  ...sameCuratedNote(['claude-sonnet-4.5', 'claude-sonnet-4-5', 'anthropic/claude-sonnet-4.5'], {
    tags: ['coding'],
    source: 'Anthropic launch post for Claude Sonnet 4.5 (anthropic.com/news/claude-sonnet-4-5)',
    readOn: '2026-08-02',
    claim: 'Anthropic states "Claude Sonnet 4.5 is the best coding model in the world" and the strongest for building complex agents.',
    benchmark: { name: 'SWE-bench Verified', score: '77.2% (82.0% high-compute, reported by Anthropic)' },
  }),
  ...sameCuratedNote(['gpt-5.5', 'openai/gpt-5.5'], {
    tags: ['coding'],
    source: 'OpenAI API docs, GPT-5.5 model page (developers.openai.com/api/docs/models/gpt-5.5)',
    readOn: '2026-08-02',
    claim: 'OpenAI opens the model page with "A new class of intelligence for coding and professional work".',
  }),
  ...sameCuratedNote(['gemini-3.1-pro', 'gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview'], {
    tags: ['coding'],
    source: 'Google DeepMind, Gemini 3.1 Pro model card (deepmind.google/models/model-cards/gemini-3-1-pro/) + ai.google.dev/gemini-api/docs/models',
    readOn: '2026-08-02',
    claim: 'Google describes it as offering "powerful agentic and vibe coding capabilities" and well-suited to advanced coding and algorithmic development.',
    benchmark: { name: 'SWE-Bench Verified', score: '80.6% (reported by Google DeepMind; Terminal-Bench 2.0 68.5%)' },
  }),
  ...sameCuratedNote(['gemini-3-flash', 'gemini-3-flash-preview'], {
    tags: ['coding'],
    source: 'Google, Gemini 3 Flash launch post (blog.google/products-and-platforms/products/gemini/gemini-3-flash/) + ai.google.dev/gemini-api/docs/models',
    readOn: '2026-08-02',
    claim: 'Google calls it "our most powerful agentic and vibe-coding model yet", promising Pro-grade coding performance at low latency.',
    benchmark: { name: 'SWE-bench Verified', score: '78% (reported by Google)' },
  }),

  // ── Dated NEGATIVES: we looked, and the maker does not make the claim ──────
  ...sameCuratedNote(['claude-fable-5', 'anthropic/claude-fable-5'], {
    tags: [],
    source: 'Anthropic docs, Fable 5 / Mythos 5 introduction page + Models overview comparison table (platform.claude.com/docs/en/docs/about-claude/models/)',
    readOn: '2026-08-02',
    claim: 'Anthropic positions it for "the most demanding reasoning and long-horizon agentic work" and never names coding — even though it is the dearest model we list. OpenRouter\'s catalogue blurb DOES say "knowledge work and coding"; the maker\'s own page wins, so no coding tag.',
  }),
  ...sameCuratedNote(['claude-opus-4.8', 'claude-opus-4-8', 'anthropic/claude-opus-4.8'], {
    tags: [],
    source: 'Anthropic launch post for Claude Opus 4.8 (anthropic.com/news/claude-opus-4-8) + Models overview "Legacy models" table',
    readOn: '2026-08-02',
    claim: 'Anthropic says only that it "builds on Opus 4.7 with improvements across benchmarks, and is a more effective collaborator" — no coding positioning. This row previously carried a coding tag on the strength of a claim about agentic and knowledge work, which is not the same claim; a first-party re-read removed it.',
  }),
  ...sameCuratedNote(['gemini-2.5-flash', 'google/gemini-2.5-flash'], {
    tags: [],
    source: 'Google, Gemini 2.5 Flash model page (ai.google.dev/gemini-api/docs/models/gemini-2.5-flash)',
    readOn: '2026-08-02',
    claim: 'Google positions it on price-performance for "large scale processing, low-latency, high volume tasks" and names no coding role. OpenRouter\'s blurb calls it "specifically designed for advanced reasoning, coding, mathematics"; the maker\'s page wins, so no coding tag.',
  }),
  // gemini-3.1-flash-lite is ALSO absent, and it is the instructive case: Google
  // DeepMind's model card publishes LiveCodeBench 72.0% — a named coding
  // benchmark with a real number — while positioning the model for extraction,
  // routing and high-volume work. A score is not a positioning, and the tag's
  // own blurb promises "the people who made it publish it as a model built for
  // programming". They do not, so it does not get the tag.

  // ══ OPEN-WEIGHT AND GATEWAY MODELS — vendor-primary, read 2026-08-02 ════════
  // These are the models the paid gateways (Bankr, Surplus, Venice,
  // OpenGateway) put in front of a user. Every claim below was re-read on the
  // MAKER's own docs or model card, not on a reseller's summary, and the
  // benchmark numbers are the ones the maker published as TEXT — several
  // vendors ship their tables as images only, and a number we cannot read is
  // not a number we may quote.
  ...sameCuratedNote(['glm-5.2', 'z-ai/glm-5.2'], {
    tags: ['coding'],
    source: 'Z.ai model docs for GLM-5.2 (docs.z.ai/guides/llm/glm-5.2)',
    readOn: '2026-08-02',
    claim: 'Z.ai builds it for "long-horizon tasks" with "stronger project-level context capacity" and improved "adherence to production-grade engineering standards".',
    benchmark: { name: 'Terminal-Bench 2.1', score: '81.0 (reported by Z.ai; SWE-bench Pro 62.1)' },
  }),
  ...sameCuratedNote(['glm-5', 'z-ai/glm-5'], {
    tags: ['coding'],
    source: 'Z.ai model docs for GLM-5 (docs.z.ai/guides/llm/glm-5)',
    readOn: '2026-08-02',
    claim: 'Z.ai states it is "designed for Agentic Engineering" and has "achieved state-of-the-art (SOTA) performance in open source" on coding and agent capabilities.',
    benchmark: { name: 'SWE-bench Verified', score: '77.8 (reported by Z.ai; Terminal-Bench 2.0 56.2)' },
  }),
  ...sameCuratedNote(['glm-4.7', 'zai-org-glm-4.7', 'z-ai/glm-4.7'], {
    tags: ['coding'],
    source: 'Z.ai model docs for GLM-4.7 (docs.z.ai/guides/llm/glm-4.7)',
    readOn: '2026-08-02',
    claim: 'Z.ai says it "focuses on \'task completion\' rather than single-point code generation" and autonomously handles requirement comprehension and multi-stack integration.',
    benchmark: { name: 'SWE-bench Verified', score: '73.8% (reported by Z.ai; LiveCodeBench V6 84.9)' },
  }),
  ...sameCuratedNote(['deepseek-v4-pro', 'deepseek/deepseek-v4-pro'], {
    tags: ['coding'],
    source: 'DeepSeek model card for DeepSeek-V4-Pro (huggingface.co/deepseek-ai/DeepSeek-V4-Pro) + release note (api-docs.deepseek.com)',
    readOn: '2026-08-02',
    claim: 'DeepSeek headlines the release "Open-source SOTA in Agentic Coding benchmarks" and says it "achieves top-tier performance in coding benchmarks".',
    // The card's numbers are its V4-Pro-MAX column, which the card itself
    // defines as "the maximum reasoning effort mode of DeepSeek-V4-Pro" — the
    // same model turned up, not a sibling. Recorded with that disclosed.
    benchmark: { name: 'SWE-bench Verified', score: '80.6 resolved at max reasoning effort (reported by DeepSeek; LiveCodeBench pass@1 93.5)' },
  }),
  ...sameCuratedNote(['deepseek-v3.2', 'deepseek/deepseek-v3.2'], {
    tags: ['coding'],
    source: 'DeepSeek-AI technical report "DeepSeek-V3.2: Pushing the Frontier of Open Large Language Models", Table 2 (arxiv.org/pdf/2512.02556)',
    readOn: '2026-08-02',
    claim: 'DeepSeek-AI writes that "in code agent evaluations, DeepSeek-V3.2 significantly outperforms open-source LLMs on both SWE-bench Verified and Terminal Bench 2.0".',
    benchmark: { name: 'SWE-bench Verified', score: '73.1 resolved (reported by DeepSeek-AI; Terminal-Bench 2.0 46.4 via the Claude Code framework, 39.3 via Terminus)' },
  }),
  ...sameCuratedNote(['kimi-k3', 'moonshotai/kimi-k3'], {
    tags: ['coding'],
    source: 'Moonshot AI model card for Kimi K3 (huggingface.co/moonshotai/Kimi-K3) + platform.kimi.ai/docs/models',
    readOn: '2026-08-02',
    claim: 'Moonshot AI presents it as their flagship "built for long-horizon coding and end-to-end knowledge work", sustaining long engineering sessions across massive repositories.',
    benchmark: { name: 'Terminal-Bench 2.1', score: '88.3 (reported by Moonshot AI; FrontierSWE 81.2)' },
  }),
  ...sameCuratedNote(['kimi-k2', 'moonshotai/kimi-k2'], {
    tags: ['coding'],
    source: 'Moonshot AI model card for Kimi K2 Instruct (huggingface.co/moonshotai/Kimi-K2-Instruct)',
    readOn: '2026-08-02',
    claim: 'Moonshot AI states it "achieves exceptional performance across frontier knowledge, reasoning, and coding tasks while being meticulously optimized for agentic capabilities".',
    benchmark: { name: 'SWE-bench Verified', score: '65.8% agentic, single attempt (reported by Moonshot AI; LiveCodeBench v6 53.7% pass@1)' },
  }),
  ...sameCuratedNote(['qwen3.7-max', 'qwen/qwen3.7-max'], {
    tags: ['coding'],
    source: 'Alibaba Cloud Model Studio, Qwen3.7-Max model page (alibabacloud.com/help/en/model-studio/qwen3-7-max)',
    readOn: '2026-08-02',
    claim: 'Alibaba Cloud describes it as "a next-generation flagship model designed for the agent-centric era" that "excels at programming, office and productivity tasks, and long-term autonomous execution".',
    // Alibaba publishes NO benchmark table on that page. SWE-bench Verified
    // 80.4 / Terminal-Bench 2.0 69.7 circulate widely but only from third
    // parties, so neither is recorded.
  }),
  ...sameCuratedNote(['qwen3-235b-a22b-thinking-2507', 'qwen/qwen3-235b-a22b-thinking-2507'], {
    tags: ['coding'],
    source: 'Qwen model card for Qwen3-235B-A22B-Thinking-2507 (huggingface.co/Qwen/Qwen3-235B-A22B-Thinking-2507)',
    readOn: '2026-08-02',
    claim: 'The Qwen team headlines "significantly improved performance on reasoning tasks, including logical reasoning, mathematics, science, coding and academic benchmarks".',
    benchmark: { name: 'LiveCodeBench v6', score: '74.1 (reported by Qwen; CFEval 2134)' },
  }),
  ...sameCuratedNote(['qwen3-235b-a22b-2507', 'qwen/qwen3-235b-a22b-2507'], {
    tags: ['coding'],
    source: 'Qwen model card for Qwen3-235B-A22B-Instruct-2507 (huggingface.co/Qwen/Qwen3-235B-A22B-Instruct-2507)',
    readOn: '2026-08-02',
    claim: 'Qwen headlines "significant improvements in general capabilities, including instruction following, logical reasoning, text comprehension, mathematics, science, coding and tool usage".',
    // Qwen's OWN table shows Claude Opus 4 ahead on MultiPL-E and
    // Aider-Polyglot. The score is recorded as published, not as a ranking.
    benchmark: { name: 'LiveCodeBench v6', score: '51.8 (reported by Qwen; MultiPL-E 87.9)' },
  }),
  ...sameCuratedNote(['minimax-m3', 'minimax/minimax-m3'], {
    tags: ['coding'],
    source: 'MiniMax launch post for MiniMax-M3 (minimax.io/blog/minimax-m3) + model card (huggingface.co/MiniMaxAI/MiniMax-M3)',
    readOn: '2026-08-02',
    claim: 'MiniMax states "M3 achieves frontier-level performance across long-horizon agentic benchmarks, excelling in both coding and cowork".',
    benchmark: { name: 'SWE-Bench Pro', score: '59.0% (reported by MiniMax, run on its own infrastructure with Claude Code as scaffolding; Terminal-Bench 2.1 66.0)' },
  }),
  ...sameCuratedNote(['minimax-m2.5', 'minimax/minimax-m2.5'], {
    tags: ['coding'],
    source: 'MiniMax model card for MiniMax-M2.5 (huggingface.co/MiniMaxAI/MiniMax-M2.5)',
    readOn: '2026-08-02',
    claim: 'MiniMax states it "is SOTA in coding, agentic tool use and search, office work, and a range of other economically valuable tasks".',
    benchmark: { name: 'SWE-Bench Verified', score: '80.2% (reported by MiniMax; Multi-SWE-Bench 51.3%)' },
  }),
  ...sameCuratedNote(['mimo-v2.5-pro', 'xiaomi/mimo-v2.5-pro'], {
    tags: ['coding'],
    source: 'Xiaomi MiMo Team model card + launch page (huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro, mimo.xiaomi.com/mimo-v2-5-pro)',
    readOn: '2026-08-02',
    claim: 'Xiaomi calls it "our most capable model to date, designed for the most demanding agentic, complex software engineering, and long-horizon tasks", under a section headed "Frontier Coding Intelligence".',
    // The HumanEval+/MBPP+/SWE-Bench figures on that card belong to the BASE
    // model, not this instruct model, so they are NOT carried across. ClawEval
    // is the one number published for this model itself.
    benchmark: { name: 'ClawEval', score: '64% Pass^3 at ~70K tokens per trajectory (reported by the Xiaomi MiMo Team)' },
  }),
  ...sameCuratedNote(['hy3', 'tencent/hy3'], {
    tags: ['coding'],
    source: 'Tencent Hy Team model card for Hy3 (huggingface.co/tencent/Hy3)',
    readOn: '2026-08-02',
    claim: 'The Tencent Hy Team writes that "in productivity scenarios such as coding, office work, financial modeling, frontend design, and game development, Hy3 has made remarkable progress".',
    // Tencent ships its benchmark tables as images (assets/benchmark.png). The
    // only text-published figures are a scaffolding-variance bound and an
    // internal blind eval, neither of which is a named public benchmark score.
  }),
  ...sameCuratedNote(['mistralai/mistral-small-3.1-24b-instruct'], {
    tags: ['coding'],
    source: 'Mistral model card for Mistral Small 3.1 24B Instruct 2503 (huggingface.co/mistralai/Mistral-Small-3.1-24B-Instruct-2503)',
    readOn: '2026-08-02',
    claim: 'Mistral lists "Programming and math reasoning" verbatim among the uses it says the model is ideal for, and publishes coding scores for it.',
    benchmark: { name: 'HumanEval', score: '88.41% (reported by Mistral; MBPP 74.71%)' },
    // Weaker positioning than the rest of this block — one bullet in a list of
    // seven — but it is the maker's own bullet AND the maker's own numbers for
    // this exact model, which clears the bar as written. Venice's `mistral-31-24b`
    // spelling is deliberately NOT listed: Mistral deprecated Small 3.1 and the
    // bare spelling does not unambiguously name this snapshot.
  }),

  // ── More dated negatives, from the same 2026-08-02 vendor-primary sweep ────
  ...sameCuratedNote(['mistral-large', 'mistralai/mistral-large'], {
    tags: [],
    source: 'Mistral docs, Mistral Large 3 model card + models overview (docs.mistral.ai/models/model-cards/mistral-large-3-25-12)',
    readOn: '2026-08-02',
    claim: 'Mistral calls the current Large-line model "a state-of-the-art, open-weight, general-purpose multimodal model" and on the SAME overview reserves coding positioning for other models (Medium 3.5 "optimized for agentic and coding", Codestral for code completion). It no longer documents a bare `mistral-large` alias at all, so the id does not even name a fixed snapshot. OpenRouter\'s blurb quotes the 2407 release; that is a different, pinned model.',
  }),
  ...sameCuratedNote(['venice-uncensored-1-2'], {
    tags: ['uncensored'],
    source: "Venice's own live model catalog (api.venice.ai/api/v1/models), entry `venice-uncensored-1-2`",
    readOn: '2026-08-02',
    claim: 'Venice names it "Venice Uncensored 1.2", carries the trait `most_uncensored` on the entry, and describes it as "designed for maximum creative freedom" — "built for open-ended exploration, roleplay, and unfiltered dialogue". The SAME entry is the coding negative it always was: Venice sets `optimizedForCode: false` on this model while setting true on others it serves.',
  }),
  // ══ UNCENSORED — the SERVING provider's own catalog says so, dated ══════════
  //
  // The group the owner asked for on 2026-08-02. The bar is the same as every
  // other curated claim, with one sharpening: the authority is the provider
  // SERVING the row — "uncensored" is a claim about how the served variant
  // behaves, and the server is the one who decensored it — quoted from its own
  // catalog fields (name, description, traits). NEVER the id: Venice's
  // `qwen-3-6-plus` carries the claim only in its NAME ("Qwen 3.6 Plus
  // Uncensored") while the id says nothing, and an id that merely contains the
  // word earns nothing without a catalog row behind it. The substring rule
  // fails in BOTH directions here, which is exactly why it stays forbidden.
  //
  // Quality positioning is NOT borrowed along the way: Venice's blurb for
  // qwen-3-6-plus also calls it a flagship "with exceptional performance
  // across coding" — a reseller summary, so no coding tag rides in with the
  // uncensored one (maker-wins, same rule as everywhere above).
  ...sameCuratedNote(['venice-uncensored-role-play'], {
    tags: ['uncensored'],
    source: "Venice's own live model catalog (api.venice.ai/api/v1/models), entry `venice-uncensored-role-play`",
    readOn: '2026-08-02',
    claim: 'Venice names the entry "Venice Role Play Uncensored" (dphnAI 24B-3.2-RP) and describes it as "optimized for creative roleplay scenarios with maximum freedom".',
  }),
  ...sameCuratedNote(['qwen-3-6-plus'], {
    tags: ['uncensored'],
    source: "Venice's own live model catalog (api.venice.ai/api/v1/models), entry `qwen-3-6-plus`",
    readOn: '2026-08-02',
    claim: 'Venice names the entry "Qwen 3.6 Plus Uncensored" and its description opens with the same phrase — while the id itself never says so.',
  }),
  ...sameCuratedNote(['gemma-4-uncensored'], {
    tags: ['uncensored'],
    source: "Venice's own live model catalog (api.venice.ai/api/v1/models), entry `gemma-4-uncensored`",
    readOn: '2026-08-02',
    claim: 'Venice describes it as "an uncensored variant of Google Gemma 4 26B", "fine-tuned for uncensored chat without content filtering".',
  }),
  ...sameCuratedNote(['olafangensan-glm-4.7-flash-heretic'], {
    tags: ['uncensored'],
    source: "Venice's own live model catalog (api.venice.ai/api/v1/models), entry `olafangensan-glm-4.7-flash-heretic`",
    readOn: '2026-08-02',
    claim: 'Venice describes it as "an uncensored experimental variant of GLM-4.7-Flash, optimized for creative freedom and unfiltered dialogue" — nothing in the id says so.',
  }),
  ...sameCuratedNote(['e2ee-venice-uncensored-24b-p'], {
    tags: ['uncensored'],
    source: "Venice's own live model catalog (api.venice.ai/api/v1/models), entry `e2ee-venice-uncensored-24b-p`",
    readOn: '2026-08-02',
    claim: 'Venice names it "Venice Uncensored 1.1" — the same Dolphin-Mistral Venice Edition lineage — "running in a Trusted Execution Environment (TEE)".',
  }),
  ...sameCuratedNote(['e2ee-gemma-4-26b-a4b-uncensored-p'], {
    tags: ['uncensored'],
    source: "Venice's own live model catalog (api.venice.ai/api/v1/models), entry `e2ee-gemma-4-26b-a4b-uncensored-p`",
    readOn: '2026-08-02',
    claim: 'Venice describes it as "an uncensored variant of Google\'s Gemma 4 MoE model", served "running in a Trusted Execution Environment (TEE)".',
  }),
  ...sameCuratedNote(['e2ee-qwen3-6-35b-a3b-uncensored-p'], {
    tags: ['uncensored'],
    source: "Venice's own live model catalog (api.venice.ai/api/v1/models), entry `e2ee-qwen3-6-35b-a3b-uncensored-p`",
    readOn: '2026-08-02',
    claim: 'Venice describes it as "an uncensored variant of Alibaba\'s Qwen3.6 MoE model", served "running in a Trusted Execution Environment (TEE)".',
  }),
  ...sameCuratedNote(['thedrummer/cydonia-24b-v4.1'], {
    tags: ['uncensored'],
    source: 'OpenRouter model catalog, `description` field for thedrummer/cydonia-24b-v4.1 (openrouter.ai/api/v1/models)',
    readOn: '2026-08-02',
    claim: 'The catalog description opens "Uncensored and creative writing model based on Mistral Small 3.2 24B with good recall, prompt adherence, and intelligence."',
  }),
  ...sameCuratedNote(['cognitivecomputations/dolphin-mistral-24b-venice-edition'], {
    tags: ['uncensored'],
    source: 'OpenRouter model catalog, `name` + `description` fields for cognitivecomputations/dolphin-mistral-24b-venice-edition (openrouter.ai/api/v1/models)',
    readOn: '2026-08-02',
    claim: 'OpenRouter lists it as "Venice: Uncensored", and the description says it "is designed as an \'uncensored\' instruct-tuned LLM" by dphn.ai in collaboration with Venice.ai.',
  }),
  ...sameCuratedNote(['q-naifu-a3b'], {
    tags: ['uncensored'],
    source: 'imgnAI Katana live model catalog (kat.imgnai.com/v1/models), `description` field for q-naifu-a3b, publisher imgnAI',
    readOn: '2026-08-02',
    claim: 'imgnAI — the model\'s own publisher, not a reseller — describes it as "imgnAI\'s fully uncensored and unrestricted Agentic Model, built upon the Qwen 3.6 A3B architecture for Roleplay and Agentic use-cases". The strongest claim in this block: maker and server are the same party.',
  }),

  // Also deliberately absent, each for a stated reason:
  //   llama-3.3-70b(-instruct) — Meta publishes HumanEval 88.4 for it, but
  //     positions it as an "assistant-like chat" model. A score inside a general
  //     sweep is not a claim that it was built for programming. Same call as
  //     gemini-3.1-flash-lite above.
  //   mimo-v2.5 — Xiaomi's headline is "a leap in agency and multimodality";
  //     coding appears only as a secondary mention backed by an INTERNAL bench
  //     with no published number.
  //   inclusionai/ling-3.0-flash:free — Ant Ling's primary positioning is cost
  //     and throughput ("up to 1000 tokens/s"), not programming.
  //   grok-4 — xAI RETIRED the id on 2026-05-15 and now silently redirects it
  //     to grok-4.3. There is no live vendor page describing grok-4 at all, so
  //     no claim about it — capability, modality or price — is admissible.
}

/**
 * Curated entries whose `readOn` is older than CURATION_MAX_AGE_DAYS at `now`.
 * Their tags are dropped by the resolver; this makes the expiry VISIBLE so a
 * doctor panel or a test can surface it instead of the group silently emptying.
 */
export function staleCuratedModelIds(now: number = Date.now()): string[] {
  const cutoff = CURATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  return Object.entries(CURATED_MODEL_NOTES)
    .filter(([, note]) => now - Date.parse(note.readOn) > cutoff)
    .map(([id]) => id)
    .sort()
}

/** Is this curated claim still inside its shelf life? */
export function isCurationFresh(note: CuratedModelNote, now: number = Date.now()): boolean {
  const readAt = Date.parse(note.readOn)
  if (!Number.isFinite(readAt)) return false   // an unparseable date is not a date
  return now - readAt <= CURATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
}

// ── Live-row shape the resolver accepts ──────────────────────────────────────

/**
 * The subset of `UnifiedModel` (providers/registry.ts) that carries evidence.
 * Surfaces that fetched a live catalog pass this; surfaces that only have an id
 * pass nothing and the resolver falls back to the static tables.
 *
 * Structural, not an import of UnifiedModel itself, so a caller can hand over a
 * partially-populated row without casting.
 */
export interface LiveModelFacts {
  /** Context window the PROVIDER's own catalog reports for this model. */
  contextTokens?: number
  /** Per-model capabilities from the provider's catalog. */
  capabilities?: readonly ProviderModelCapability[]
  /** Per-model price from the provider's catalog. $0/$0 is the strongest free signal we have. */
  pricing?: { inUsdPerMTok?: number; outUsdPerMTok?: number }
}
