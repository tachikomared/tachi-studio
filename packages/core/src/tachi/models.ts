// packages/core/src/tachi/models.ts
//
// Static model-capability catalog for the TACHI harness, plus a resolver that
// maps an arbitrary provider model id onto the right capability profile.
//
// Why this exists: TachiDesk talks to a "provider zoo" (Anthropic, OpenAI/codex,
// OpenGateway MiMo, Qwen-coder, DeepSeek, Llama, Gemini, tiny local Gemma builds…).
// The agent loop needs to know, per model, how big the context is, whether it can
// take native tool calls or needs text-salvage, which edit format to drive, and
// — critically — whether it is even worth running the agent loop at all (an 8k
// local model can't). Rather than scatter these assumptions through the loop, we
// centralise them here as plain data + a deterministic, dependency-free lookup.
//
// Matching contract (resolveCapability):
//   1. exact, case-insensitive match on `match` wins;
//   2. otherwise the LONGEST `match` that occurs in the id at a TOKEN BOUNDARY
//      wins (so 'codex' beats 'gpt' when both appear, and 'gpt' does not match
//      inside 'regpts'). See isBoundedMatch for the exact boundary rule.
//   3. otherwise a conservative DEFAULT that assumes a capable, tool-driving
//      model — but which asserts NO context window (see contextWindowKnown).
//
// CONTEXT WINDOWS — read resolveContextWindow(), not `cap.contextWindow`.
// A context window is a per-MODEL fact, and this file is keyed by substrings of
// a model id with no provider dimension at all: the same key answers for Venice,
// OpenRouter, Bankr and imgnAI alike. That makes a bare family row ('llama',
// 'qwen', 'gpt') a guess about every variant any provider ever serves under that
// name, and a guess is not a number we may show a user or silently truncate
// their history against. So:
//
//   * the PROVIDER'S LIVE CATALOG is the authority for a model it serves;
//   * rows here are the offline fallback, and each declares whether its window
//     is sourced (`contextWindowKnown: true`) or a conservative estimate;
//   * an id that matches nothing has an UNKNOWN window — never 32k-as-fact.
//
// resolveContextWindow() implements that order and reports which source
// answered, so display surfaces can label a guess as a guess.

import type { ModelCapability } from './contract.js'

/**
 * The TACHI model-capability catalog. Order is informational only — resolution
 * is by exact match then longest-substring, never by position (see DEFAULT note
 * in resolveCapability for the one tie-break detail). Keys are kept lowercase so
 * the case-insensitive comparison in resolveCapability is a straight lowercase
 * compare with no per-entry normalisation.
 */
export const TACHI_MODEL_CAPABILITIES: ModelCapability[] = [
  // Anthropic Claude — first-class: huge context, reliable native tool calls.
  // Baseline 200k covers Haiku 4.5 and older models; the current frontier tier
  // (Fable 5 / Mythos 5 / Opus 4.6+ / Sonnet 4.6+) actually serves a 1M window
  // — the longer-match entries below override this for those ids. (Real limits
  // per Anthropic docs 2026: 1M context, 128k max output.)
  // contextWindowKnown: true — 200k is a vendor-published floor across the whole
  // served Claude line, not a family-average guess.
  {
    match: 'claude',
    contextWindow: 200000,
    contextWindowKnown: true,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native',
    editFormat: 'edit-cascade',
    agentCapable: true,
  },
  // 1M-context Claude tier. Longest-substring matching makes each of these win
  // over the generic 'claude' entry; dot and dash id variants both appear in
  // provider catalogs (Bankr serves dashed ids, some gateways dotted).
  // NOTE: 'claude-fable'/'claude-mythos' are needed alongside the bare keys —
  // 'fable' (5 chars) alone would LOSE the longest-substring race to 'claude'
  // (6 chars) on ids like "claude-fable-5"; the bare keys still cover
  // unprefixed gateway ids ("fable-5"). SAME TRAP for Opus 5: 'opus-5' is
  // exactly 6 chars, so on "claude-opus-5" it TIES 'claude' and the earlier
  // (200k) entry would win — 'claude-opus-5' is the key that actually decides
  // it, and the bare 'opus-5' covers unprefixed ids.
  ...['claude-fable', 'claude-mythos', 'fable', 'mythos', 'claude-opus-5', 'opus-5', 'opus-4-6', 'opus-4.6', 'opus-4-7', 'opus-4.7', 'opus-4-8', 'opus-4.8', 'sonnet-5', 'sonnet-4-6', 'sonnet-4.6'].map((match): ModelCapability => ({
    match,
    contextWindow: 1000000,
    contextWindowKnown: true,   // named variants, per Anthropic's published limits
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native',
    editFormat: 'edit-cascade',
    agentCapable: true,
  })),
  // imgnAI Katana gateway ids (kat.imgnai.com llms.txt, 2026-07-11). glm-5-2 /
  // deepseek-v4 / gpt-5-6 are ~1M-window; 'deepseek-v4' (11) outranks the
  // generic 'deepseek' (8) in the longest-substring race, same trick as
  // 'claude-fable' above. q-naifu-a3b: 262k, no tool calling advertised.
  // NOTE: these are imgnAI's servings. Another gateway may serve a same-named
  // model at a different window (Venice's `deepseek-v4-pro` matches the
  // 'deepseek-v4' key here but is Venice's own serving) — which is exactly why
  // a live catalog value outranks every row in this file.
  ...['glm-5-2', 'gpt-5-6', 'deepseek-v4'].map((match): ModelCapability => ({
    match,
    contextWindow: 1000000,
    contextWindowKnown: true,   // named variants, kat.imgnai.com llms.txt 2026-07-11
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native-then-salvage',
    editFormat: 'edit-cascade',
    agentCapable: true,
  })),
  {
    match: 'grok-4-5',
    contextWindow: 500000,
    contextWindowKnown: true,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native',
    editFormat: 'edit-cascade',
    agentCapable: true,
  },
  {
    match: 'q-naifu',
    contextWindow: 262000,
    contextWindowKnown: true,
    supportsTools: false,
    supportsTemperature: true,
    toolProtocol: 'none',
    editFormat: 'whole-file',
    agentCapable: false,
  },
  // ── FAMILY rows (contextWindowKnown: false) ────────────────────────────────
  // Everything below marked `contextWindowKnown: false` is a bare family bucket
  // that spans variants, generations AND vendors with materially different
  // windows — 'llama' covers Llama 2 (4k) and Llama 3.3 (131k); 'qwen' covers
  // Qwen2.5 (32k) and Qwen3 (262k); 'gpt' covers gpt-4o (128k) and gpt-5 (much
  // larger). The number kept on each row is a conservative budgeting estimate so
  // the agent loop still has something to bound history against; it is NOT a
  // claim about any particular model and must not be displayed as one. The real
  // number comes from the provider's live catalog (resolveContextWindow).
  //
  // OpenAI GPT family — native tools, but we drive the apply-patch edit format
  // (the format OpenAI's own coding stack expects).
  {
    match: 'gpt',
    contextWindow: 128000,
    contextWindowKnown: false,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native',
    editFormat: 'apply-patch',
    agentCapable: true,
  },
  // gpt-oss — OpenAI's OPEN-WEIGHTS line, served by Venice ('e2ee-gpt-oss-120b-p',
  // 'openai-gpt-oss-120b'), OpenRouter ('openai/gpt-oss-20b:free') and others.
  // It is not the proprietary GPT stack: without this row it inherited the 'gpt'
  // row's 128k AND its apply-patch edit format — the format OpenAI's own hosted
  // coding models expect, which an open-weights build does not drive. 131_072 is
  // the window the free-fleet catalog read of 2026-08-01 recorded for
  // openai/gpt-oss-20b:free (see openrouter-service.ts FALLBACK).
  {
    match: 'gpt-oss',
    contextWindow: 131072,
    contextWindowKnown: true,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native-then-salvage',
    editFormat: 'edit-cascade',
    agentCapable: true,
  },
  // OpenAI codex models — same protocol/format as gpt, but a distinct (longer)
  // key so an id carrying both 'gpt' and 'codex' resolves to codex.
  {
    match: 'codex',
    contextWindow: 128000,
    contextWindowKnown: false,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native',
    editFormat: 'apply-patch',
    agentCapable: true,
  },
  // OpenGateway Xiaomi MiMo — advertises tools but is flaky enough that we keep
  // the text-salvage fallback armed.
  {
    match: 'mimo',
    contextWindow: 128000,
    contextWindowKnown: false,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native-then-salvage',
    editFormat: 'edit-cascade',
    agentCapable: true,
  },
  // Qwen-coder — capable coder at a tighter context; salvage fallback on.
  {
    match: 'qwen',
    contextWindow: 32000,
    contextWindowKnown: false,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native-then-salvage',
    editFormat: 'edit-cascade',
    agentCapable: true,
  },
  // DeepSeek — mid context, salvage fallback on.
  {
    match: 'deepseek',
    contextWindow: 64000,
    contextWindowKnown: false,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native-then-salvage',
    editFormat: 'edit-cascade',
    agentCapable: true,
  },
  // Llama family — tool support varies wildly across fine-tunes, so salvage on.
  // Also the widest window spread of any bucket here (Llama 2 4k → Llama 3.x
  // 131k), which is why 'hermes-3-llama-3.1-405b' must not take its number.
  {
    match: 'llama',
    contextWindow: 32000,
    contextWindowKnown: false,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native-then-salvage',
    editFormat: 'edit-cascade',
    agentCapable: true,
  },
  // Google Gemini — very large context, reliable native tools.
  //
  // THE COMMENT HERE USED TO READ "1M is published across the whole served
  // Gemini line, so this one family row IS sourced", and both halves were
  // wrong. Measured 2026-08-02 against two keyless catalogs:
  //
  //   OpenRouter, 19 `google/gemini*` rows — 1_048_576 (×13), 131_072 (×2),
  //     65_536 (×3, the `-image` variants), 32_768 (×1).
  //   OpenGateway, `google/gemini-3.1-flash-lite` — 1_048_576.
  //
  // So the family spans a 32× range, and the number this row carried was both
  // a ROUNDING of the common case (1_000_000 for 1_048_576 — "a window we round
  // is a window we made up", per the test two files over) and an over-claim of
  // up to 32× for a third of the line. Marked `known: true`, it authorised a
  // percentage on the meter and a long-context tag for models that have neither.
  //
  // Now an estimate, exactly like the `nemotron` bucket below: the common value,
  // stated as the guess it is. A gemini row whose window we really know arrives
  // from the provider's live catalog and outranks this one.
  {
    match: 'gemini',
    contextWindow: 1048576,
    contextWindowKnown: false,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native',
    editFormat: 'edit-cascade',
    agentCapable: true,
  },
  // Small local Gemma builds — an 8k window can't sustain the agent loop, so we
  // mark it not-agent-capable, no tool protocol, and whole-file edits only. This
  // is a deliberate "stop" marker, not a model we expect to drive TACHI.
  // contextWindowKnown: false — 8192 is the local-build floor this stop marker
  // exists for, not a fact about Gemma 3/4 (which reach 128k/262k). agentCapable
  // stays false regardless: that is a deliberate policy, not a window claim.
  {
    match: 'gemma',
    contextWindow: 8192,
    contextWindowKnown: false,
    supportsTools: false,
    supportsTemperature: true,
    toolProtocol: 'none',
    editFormat: 'whole-file',
    agentCapable: false,
  },
  // Gemma 4 (OpenRouter :free rows, 2026-08-01: google/gemma-4-31b-it:free at
  // 262k, multimodal). 'gemma-4' (7 chars) outranks the 8k local-'gemma' stop
  // marker above in the longest-substring race — without this entry the free
  // multimodal Gemma resolved to "8k, not agent-capable" and TACHI refused it.
  {
    match: 'gemma-4',
    contextWindow: 262144,   // exact catalog value, not the rounded 262_000
    contextWindowKnown: true,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native-then-salvage',
    editFormat: 'edit-cascade',
    agentCapable: true,
  },
  // ── Free-gateway verified rows (catalogs read 2026-08-01) ──
  // These match on MODEL ID, not on provider, so they stay correct however the
  // row is reached. They were added when Kilo was a standalone provider; Kilo is
  // now an upstream INSIDE the FreeLLM local router (and OpenCode Zen serves
  // several of the same families), so these rows are load-bearing for the free
  // route rather than for a picker entry — do not delete them with a provider.
  // Every one of these rows advertises `tools` in supported_parameters; salvage
  // stays armed because none of them have a tool-reliability track record here.
  // Windows are the EXACT values that catalog read recorded (see the FALLBACK
  // list in openrouter-service.ts, the same dated evidence) — 262_144, not the
  // rounded 262_000 these rows previously carried.
  //
  // `nemotron` and `kilo-auto` are the two rows here that are NOT a per-model
  // fact: the nemotron bucket spans 128_000 (nano-9b-v2, nano-12b-v2-vl,
  // 3.5-content-safety) to 262_144 (3-super-120b) in that same catalog read, and
  // kilo-auto is a gateway-side ROUTER whose window is whatever it routes to.
  //
  // `nemotron-3-ultra` USED TO READ `1_000_000, true` — a confident number, and
  // false for the gateway that matters most here. Both catalogs were read again
  // on 2026-08-02, keyless, for the identical id
  // `nvidia/nemotron-3-ultra-550b-a55b:free`:
  //
  //     OpenRouter    (openrouter.ai/api/v1/models)          1_000_000
  //     OpenGateway   (opengateway.gitlawb.com/v1/models)      131_072
  //     …and OpenRouter's PAID twin, without the `:free` suffix, 512_288.
  //
  // One id, three windows. This table has no provider dimension (see the header
  // note on that limitation), so a single row cannot be right for all of them —
  // and the row was right for the one we do NOT pin: OPENGATEWAY_AGENT_MODEL
  // routes the agent harness at OpenGateway, where the harness was sizing
  // history against a window 7.6× larger than the gateway will accept.
  //
  // So it takes the SMALLEST measured value with `known:false`, exactly as the
  // bucket row below it already does. Under-estimating truncates history, which
  // is recoverable; over-estimating by 7.6× is a request the gateway rejects or
  // silently trims. `known:false` also means no surface prints a percentage of
  // it and no `long-context` tag is earned — honest, because the true answer
  // depends on who is serving, and this row cannot know that.
  //
  // THE REAL FIX is a live OpenGateway catalog: it is keyless and publishes
  // `context_window`, `pricing`, `effective_pricing` and `promo.ends_at` per
  // model. Wiring it makes live beat static on that route (and retires the
  // hand-dated free-promo list at the same time). See the plan's P1 item.
  ...([
    ['nemotron-3-ultra', 131072, false],
    ['nemotron',          256000, false],  // 128k…262k across the bucket — an estimate
    ['kilo-auto',         256000, false],  // router: window depends on the route taken
    ['ling-3.0',          262144, true],
    ['laguna',            262144, true],   // poolside coding rows
    ['north-mini-code',   256000, true],
    ['step-3.7',          262000, true],   // stepfun vision row
  ] as Array<[string, number, boolean]>).map(([match, contextWindow, contextWindowKnown]): ModelCapability => ({
    match,
    contextWindow,
    contextWindowKnown,
    supportsTools: true,
    supportsTemperature: true,
    toolProtocol: 'native-then-salvage',
    editFormat: 'edit-cascade',
    agentCapable: true,
  })),
]

/**
 * The context window the agent loop budgets against when NOTHING is known about
 * the model — no live catalog row, no catalog match. The loop needs a number to
 * function at all, so this is an explicit, conservative GUESS, and every surface
 * that uses it must say so (resolveContextWindow reports source 'assumed').
 *
 * It is deliberately the same 32k the old wildcard asserted, so behaviour for a
 * genuinely unknown model is unchanged — what changed is that we no longer
 * PRESENT it as the model's window.
 */
export const ASSUMED_CONTEXT_WINDOW = 32000

/**
 * Conservative profile for an id we don't recognise. We assume a reasonably
 * capable, tool-driving model (better to attempt the loop with salvage armed
 * than to refuse a model we simply haven't catalogued).
 *
 * It asserts NO context window: `contextWindowKnown` is false and the number is
 * ASSUMED_CONTEXT_WINDOW, present only so budgeting callers have something to
 * divide by. A model we have never heard of has an UNKNOWN window, not 32k —
 * `olafangensan-glm-4.7-glash-heretic` really serves 200k and was being told 32k,
 * which silently truncated the user's own history.
 */
const DEFAULT: ModelCapability = {
  match: '*',
  contextWindow: ASSUMED_CONTEXT_WINDOW,
  contextWindowKnown: false,
  supportsTools: true,
  supportsTemperature: true,
  toolProtocol: 'native-then-salvage',
  editFormat: 'edit-cascade',
  agentCapable: true,
}

/**
 * Does `key` occur in `id` at a token boundary?
 *
 * A bare `includes()` lets a family key match inside an unrelated word — 'gpt'
 * inside 'regpts', 'llama' inside 'myllamaish-7b' — and hand that model an
 * unrelated family's protocol, edit format and window. The rule:
 *
 *   * the character BEFORE the match must not be a letter (start-of-string,
 *     '-', '_', '.', '/', ':' and digits are all fine);
 *   * the character AFTER the match must not be a letter either.
 *
 * Digits are allowed on both sides on purpose, because real ids run key and
 * version together: 'Qwen2.5-Coder', 'claude3-opus', 'gemma2b'.
 */
function isBoundedMatch(id: string, key: string): boolean {
  const isLetter = (c: string): boolean => /[a-z]/.test(c)
  let from = 0
  for (;;) {
    const i = id.indexOf(key, from)
    if (i < 0) return false
    const before = i === 0 ? '' : id[i - 1]!
    const after = i + key.length >= id.length ? '' : id[i + key.length]!
    if (!isLetter(before) && !isLetter(after)) return true
    from = i + 1
  }
}

/**
 * Resolve an arbitrary provider model id to its capability profile.
 *
 *   1. exact (case-insensitive) match on `match` wins;
 *   2. else the LONGEST `match` occurring in the id at a token boundary;
 *   3. else DEFAULT — capable and tool-driving, but asserting no context window.
 *
 * Pure. The returned object is the catalog entry itself (or DEFAULT) — callers
 * must treat it as read-only. For the context window specifically, prefer
 * resolveContextWindow(), which lets the provider's live catalog answer first.
 */
export function resolveCapability(modelId: string): ModelCapability {
  const id = modelId.toLowerCase()

  // 1. Exact match (case-insensitive).
  for (const cap of TACHI_MODEL_CAPABILITIES) {
    if (cap.match.toLowerCase() === id) return cap
  }

  // 2. Longest boundary-aligned match. On a (here impossible) length tie, the
  //    earlier catalog entry is kept, so resolution is fully deterministic.
  let best: ModelCapability | null = null
  for (const cap of TACHI_MODEL_CAPABILITIES) {
    if (isBoundedMatch(id, cap.match.toLowerCase())) {
      if (best === null || cap.match.length > best.match.length) best = cap
    }
  }
  if (best !== null) return best

  // 3. Conservative default.
  return DEFAULT
}

/**
 * Read a context window out of a provider catalog row.
 *
 * Gateways are inconsistent about the type: most publish a JSON number, some
 * publish a numeric string. Both are accepted; anything else — absent, null,
 * empty string, non-numeric, NaN, zero or negative — returns `undefined`,
 * meaning "this catalog did not tell us", NOT a default. Callers must leave the
 * field off rather than substitute a number, so resolveContextWindow can fall
 * through to the static rows and report the weaker source honestly.
 */
export function parseLiveContextTokens(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw
    : typeof raw === 'string' && raw.trim() !== '' ? Number(raw)
    : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/**
 * The key names OpenAI-compatible gateways use to publish a context window.
 *
 * `/v1/models` has no standard field for it, so each gateway invented its own.
 * These are the spellings seen in the wild; a gateway that publishes none of
 * them simply tells us nothing, and we say so rather than guess.
 */
const LIVE_CONTEXT_KEYS = [
  'context_length',        // OpenRouter, many OpenAI-compatible forks
  'context_window',
  'contextWindow',
  'contextTokens',
  'max_context_length',
  'max_context_tokens',
  'max_model_len',         // vLLM-backed gateways
  'n_ctx',                 // llama.cpp-backed gateways
] as const

/**
 * Opportunistically read a context window off ONE catalog row of unknown shape.
 *
 * Checks the recognised top-level keys, then the two nested shapes we know:
 * Venice's `model_spec.availableContextTokens` and OpenRouter's
 * `top_provider.context_length`. Returns `undefined` when the row publishes
 * nothing usable — the caller must then omit the field, not default it.
 */
export function pickLiveContextTokens(row: unknown): number | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const r = row as Record<string, unknown>
  for (const k of LIVE_CONTEXT_KEYS) {
    const n = parseLiveContextTokens(r[k])
    if (n !== undefined) return n
  }
  const spec = r['model_spec']
  if (spec !== null && typeof spec === 'object') {
    const n = parseLiveContextTokens((spec as Record<string, unknown>)['availableContextTokens'])
    if (n !== undefined) return n
  }
  const top = r['top_provider']
  if (top !== null && typeof top === 'object') {
    const n = parseLiveContextTokens((top as Record<string, unknown>)['context_length'])
    if (n !== undefined) return n
  }
  return undefined
}

/** Which source answered for a context window, weakest last. */
export type ContextWindowSource =
  /** The provider's own live catalog for the model it serves. Authoritative. */
  | 'live'
  /** A sourced static row (exact id, named variant, or published family floor). */
  | 'catalog'
  /** A bare family row's conservative estimate — NOT a per-model fact. */
  | 'family-estimate'
  /** Nothing matched. ASSUMED_CONTEXT_WINDOW, so the loop can still run. */
  | 'assumed'

export interface ResolvedContextWindow {
  /** Always a usable positive number — safe to budget against. */
  tokens: number
  source: ContextWindowSource
  /**
   * True ⇔ `tokens` is evidence about THIS model. False means it is a guess:
   * display surfaces must label it (or show nothing) rather than print it as
   * the model's window.
   */
  known: boolean
}

/**
 * THE context-window entry point. Resolution order:
 *
 *   1. `liveContextTokens` — the number the provider's own catalog published for
 *      this model. It is the authority and beats every static row here, because
 *      the provider is the one actually serving the window.
 *   2. a static row whose window is sourced (`contextWindowKnown`).
 *   3. a static family row's estimate — returned so callers can budget, flagged
 *      `known: false` so callers cannot present it as fact.
 *   4. ASSUMED_CONTEXT_WINDOW, `source: 'assumed'`.
 *
 * A live value of 0, a negative, NaN or a non-number is treated as "the catalog
 * did not publish one" rather than as a window — a provider that omits the field
 * must not be able to claim a zero-token model.
 */
export function resolveContextWindow(
  modelId: string,
  liveContextTokens?: number | null,
): ResolvedContextWindow {
  if (typeof liveContextTokens === 'number' && Number.isFinite(liveContextTokens) && liveContextTokens > 0) {
    return { tokens: Math.floor(liveContextTokens), source: 'live', known: true }
  }
  const cap = resolveCapability(modelId)
  if (cap.match === '*') {
    return { tokens: ASSUMED_CONTEXT_WINDOW, source: 'assumed', known: false }
  }
  if (cap.contextWindowKnown) {
    return { tokens: cap.contextWindow, source: 'catalog', known: true }
  }
  return { tokens: cap.contextWindow, source: 'family-estimate', known: false }
}
