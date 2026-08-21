// packages/core/src/pricing.ts
//
// Single source of truth for the static $/M-token model price table, shared by
// the main-process cost ledger (electron/services/cost-pricing.ts) AND the
// renderer's per-conversation estimates (ObservabilityTab.tsx). Pure data with
// no Node dependencies — safe to import from either side of the electron
// main/renderer boundary.
//
// STEAL 2026-07-09 (codeburn, MIT — ADAPTED, not the live LiteLLM bundler):
// the old table was 8 hand-entered rows with a 3-segment family fallback, so
// EVERY cloud/OpenRouter/Venice/Surplus model TachiDesk actually routes to
// (gpt-5*, gemini-*, deepseek-*, grok-*, glm-*, o3/o4, llama-*, mistral-*, …)
// resolved to null → recorded as $0. This expands the table to the families we
// route to and adds codeburn's robust matching: OpenRouter `org/model` prefix
// stripping, routing-suffix handling, progressive dash-prefix fallback, and a
// substring keyword fallback.
//
// Unknown model → null, NEVER a fabricated number: unpriced usage is recorded
// with costUsd 0 and priced:false so the dashboard can show it honestly. The
// cost ledger additionally tags WHY it was unpriced, so an unknown price does
// not read to the 30-day spend cap as a free one — see cost-ledger.ts.
//
// ── AUDIT 2026-08-02: EVERY ROW RE-READ FROM ITS SOURCE ──────────────────────
// The table had drifted in BOTH directions and the under-counting half was a
// live hole in the llmBudgetUsd30d spend control:
//
//   · claude-opus-5 was charged at $15/$75 against a real $5/$25 (3× OVER).
//   · gpt-5.5 was charged at $1.25/$10 against a real $5/$30 (4×/3× UNDER).
//   · gemini-2.5-flash, gemini-3.1-pro, glm-5, glm-4.7 and deepseek-r1 were all
//     UNDER, and the `flash` keyword fallback under-priced the current Flash
//     generation by 10× on output.
//
// Two rules now govern this file, and both are load-bearing:
//
//   1. EVERY RATE CARRIES ITS SOURCE AND THE DATE IT WAS READ. An undated rate
//      is how this table got stale in the first place — the same discipline
//      VERIFIED_FREE_MODELS already applies to free-ness now applies to money.
//      The maker's own pricing page wins; a gateway's live catalog is used for
//      models only served through a gateway.
//   2. WHERE A RATE IS GENUINELY UNCERTAIN, ERR HIGH. Between over-counting and
//      under-counting against a SPEND CAP, under-counting is the dangerous
//      direction — the principle already written into cost-ledger.ts's
//      UNKNOWN_PRICE_ESTIMATE. Where two providers serve the same model id at
//      different rates (this table is keyed by model, not by provider) the
//      HIGHER rate is recorded and the collision is noted on the row.
//
// Prices still drift. This is a dated snapshot, not a feed — see
// `openrouter-service.ts`, which now carries LIVE per-model rates for the one
// provider that publishes them, and cost-ledger.ts, which prefers a live rate
// at RECORD time and never re-prices a stored event.
//
// ── THE STRUCTURAL HOLE: THIS TABLE HAS NO PROVIDER DIMENSION ────────────────
// It is keyed by MODEL ID ALONE, and that is structurally wrong the moment one
// model is resold by two gateways at different markups. Measured 2026-08-02,
// same model id, same day:
//
//     glm-5.2   OpenGateway (effective_pricing)  $1.68 / $5.28
//     glm-5.2   OpenRouter  (live catalog)       $0.37 / $1.16      ← 4.5× spread
//     glm-5.2   Z.ai        (maker list price)   $1.40 / $4.40
//
// `hy3`, `kimi-k3`, `mimo-v2.5*` and `qwen3.7-max` have the same shape. So no
// single number in this table can be right for every route to that model.
//
// THIS IS THE SECOND TABLE IN THIS REPO WITH THIS EXACT HOLE — the model
// capability/context rows have no provider dimension either, which is how one
// gateway's row came to answer for another gateway's model. Expect a third.
//
// THE DECISION, stated plainly so the next person does not re-litigate it:
//
//   1. THIS TABLE IS GENERIC AND DELIBERATELY PESSIMISTIC. Where routes
//      disagree, it records the HIGHEST rate we have evidence any provider we
//      route to charges for that id — the err-high rule, applied to a
//      collision rather than to ignorance. It is a FLOOR OF LAST RESORT for
//      "some provider is about to bill us for this model", not a claim about
//      any particular provider's price list.
//
//   2. THE PROVIDER DIMENSION IS RESOLVED WHERE THE PROVIDER IS KNOWN, not
//      here. Two seams already do it and both are live:
//        · cost-ledger.ts takes a LiveRateResolver keyed on (provider, model)
//          and prefers it over this table at record time;
//        · resolve-task-tags.ts::resolveModelPrice prefers a live catalog row
//          handed in by the surface that fetched it, and labels the provenance.
//      Adding a provider is therefore a matter of teaching its service to
//      publish rates, NOT of adding provider-keyed rows here.
//
//   3. KEYING THIS TABLE BY provider+id WAS CONSIDERED AND REJECTED. It
//      multiplies every row by the number of gateways that resell the model,
//      leaves the same staleness problem in each copy, and still cannot answer
//      for a gateway nobody has enumerated — while the live-rate seam answers
//      all three by construction. The generic row remains the honest fallback
//      for a route we know nothing about.

export interface ModelRates {
  inputPerM: number
  outputPerM: number
  /** Cost per M cached-prompt-read tokens (prompt-cache hit). Default heuristic: 0.1× input. */
  cacheReadPerM?: number
  /** Cost per M cache-write tokens (creating a prompt cache entry). Default heuristic: 1.25× input. */
  cacheWritePerM?: number
  /**
   * Published SECOND price tier for requests above a prompt-token threshold.
   *
   * Google, xAI and MiniMax all bill long prompts at a higher rate — Gemini 3.1
   * Pro doubles at 200k tokens, Grok 4.3 doubles at 200k, MiniMax M3 doubles at
   * 512k. Before this field the table could only hold one of the two numbers,
   * and BOTH choices were wrong: the base rate under-counts every long agent
   * run (the dangerous direction), while recording the long rate would have
   * over-stated the price the picker prints for the common short request.
   *
   * So the base fields stay the maker's headline rate — that is what a
   * user-facing surface shows — and costUsd() switches to this tier when the
   * request actually crosses `minPromptTokens`. The tier is a fact about the
   * request, not a guess about the model.
   */
  longContext?: { minPromptTokens: number; inputPerM: number; outputPerM: number }
  /**
   * A published rate that EXPIRES on a date, after which the base fields apply.
   *
   * The generalisation of VERIFIED_FREE_MODELS.freeUntil, and it exists for the
   * same reason: a temporary price that is hard-coded as if it were permanent
   * rots silently. Claude Sonnet 5 is on introductory pricing through
   * 2026-08-31 and reverts on 09-01 — recording only the promo would under-count
   * from September, and recording only the standard rate over-counts until then.
   * Holding BOTH with the switchover date means the table survives the revert
   * without anyone remembering to edit it.
   *
   * `until` is an ISO date; the promotional rate applies while `now < until`.
   */
  promotional?: {
    until: string
    inputPerM: number
    outputPerM: number
    cacheReadPerM?: number
    cacheWritePerM?: number
  }
}

// Specific model ids / family keys. Values are a $/M snapshot (input, output).
// Cache fields omitted use the codeburn heuristic (read 0.1×, write 1.25×).
export const MODEL_RATES: Record<string, ModelRates> = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  // ALL rows below read first-party from the Anthropic pricing page
  // (platform.claude.com/docs/en/about-claude/pricing) on 2026-08-02, including
  // the published cache columns — no more 0.1×/1.25× heuristic for this family.
  //
  // WHAT WAS WRONG: every Claude row carried the Opus 4.1-era $15/$75. Anthropic
  // cut the Opus tier to $5/$25 at 4.5 and the Fable tier sits at $10/$50, so
  // this family was over-counted 3× — the safe direction, but wrong, and it made
  // the spend cap fire on roughly a third of the real budget.
  'claude-fable-5':    { inputPerM: 10,  outputPerM: 50, cacheReadPerM: 1,    cacheWritePerM: 12.5 },  // Anthropic pricing page, read 2026-08-02
  'claude-fable':      { inputPerM: 10,  outputPerM: 50, cacheReadPerM: 1,    cacheWritePerM: 12.5 },  // ditto (family alias)
  'claude-mythos-5':   { inputPerM: 10,  outputPerM: 50, cacheReadPerM: 1,    cacheWritePerM: 12.5 },  // ditto (Project Glasswing)
  'claude-opus-5':     { inputPerM: 5,   outputPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },  // Anthropic pricing page, read 2026-08-02
  'claude-opus-4.8':   { inputPerM: 5,   outputPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },  // ditto
  'claude-opus-4.7':   { inputPerM: 5,   outputPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },  // ditto
  'claude-opus-4.6':   { inputPerM: 5,   outputPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },  // ditto
  'claude-opus-4.5':   { inputPerM: 5,   outputPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },  // ditto
  'claude-opus-4-8':   { inputPerM: 5,   outputPerM: 25, cacheReadPerM: 0.5,  cacheWritePerM: 6.25 },  // dashed spelling (Anthropic's own model id)
  'claude-opus-4.1':   { inputPerM: 15,  outputPerM: 75, cacheReadPerM: 1.5,  cacheWritePerM: 18.75 }, // deprecated, still billed at the old tier
  // The BARE family key deliberately keeps the $15/$75 tier: it is the fallback
  // for an Opus id we have not enumerated, and Opus 4.1 / Opus 4 really do still
  // bill at that rate. Erring high on an unrecognised Opus is the safe direction.
  'claude-opus':       { inputPerM: 15,  outputPerM: 75, cacheReadPerM: 1.5,  cacheWritePerM: 18.75 },
  // Sonnet 5 carries BOTH of its published rates. Anthropic's pricing page
  // (read 2026-08-02) lists introductory $2/$10 "through August 31, 2026" and
  // standard $3/$15 "starting September 1, 2026". The base fields hold the
  // standard rate and `promotional` holds the intro one with its expiry, so the
  // table is correct on both sides of the switchover and nobody has to remember
  // to edit it on 09-01. Recording only one number would have been wrong for
  // half the year in one direction or the other.
  'claude-sonnet-5':   {
    inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWritePerM: 3.75,
    promotional: { until: '2026-09-01T00:00:00Z', inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWritePerM: 2.5 },
  },
  'claude-sonnet-4.6': { inputPerM: 3,   outputPerM: 15, cacheReadPerM: 0.3,  cacheWritePerM: 3.75 },  // Anthropic pricing page, read 2026-08-02
  'claude-sonnet-4.5': { inputPerM: 3,   outputPerM: 15, cacheReadPerM: 0.3,  cacheWritePerM: 3.75 },  // ditto
  'claude-sonnet':     { inputPerM: 3,   outputPerM: 15, cacheReadPerM: 0.3,  cacheWritePerM: 3.75 },  // ditto (family)
  'claude-haiku-4.5':  { inputPerM: 1,   outputPerM: 5,  cacheReadPerM: 0.1,  cacheWritePerM: 1.25 },  // ditto
  'claude-haiku-3.5':  { inputPerM: 0.8, outputPerM: 4,  cacheReadPerM: 0.08, cacheWritePerM: 1 },     // ditto (retired except Bedrock/Vertex)
  'claude-haiku':      { inputPerM: 1,   outputPerM: 5,  cacheReadPerM: 0.1,  cacheWritePerM: 1.25 },  // ditto (family)

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  // ALL rows read first-party from developers.openai.com/api/docs/pricing on
  // 2026-08-02, cross-checked against OpenRouter's live catalog the same day
  // (they agree to the cent). `cacheReadPerM` is OpenAI's published cached-input
  // price, which is NOT a uniform 0.1× — gpt-4o caches at 0.5×, gpt-4.1 at
  // 0.25×, o3-mini at 0.5× — so the heuristic was wrong for those rows too.
  //
  // WHAT WAS WRONG: the whole gpt-5.x line was pinned at gpt-5's $1.25/$10.
  // OpenAI prices each release separately and UPWARD, so gpt-5.5 was under-
  // counted 4× on input and 3× on output. This is the under-counting direction
  // and it let real spend slip past the 30-day cap.
  // gpt-5.5 also has a LONG-CONTEXT tier, and it is the one a 1M-context model
  // in an agent loop will actually hit: OpenAI's pricing table splits at
  // "<272K context length", above which input is 2× ($10) and output 1.5× ($45),
  // applied to the WHOLE session rather than only the tokens past the threshold
  // (developers.openai.com/api/docs/pricing, read 2026-08-02). Same tier on
  // gpt-5.5-pro. A flat pair could not express this at all; before `longContext`
  // the honest options were a known under-estimate or a 2× over-charge on every
  // short request.
  'gpt-5.5':           { inputPerM: 5,    outputPerM: 30,  cacheReadPerM: 0.5,
                         longContext: { minPromptTokens: 272_000, inputPerM: 10, outputPerM: 45 } },  // OpenAI pricing, read 2026-08-02 (was 1.25/10 — 4×/3× UNDER)
  'gpt-5.4':           { inputPerM: 2.5,  outputPerM: 15,  cacheReadPerM: 0.25 },   // OpenAI pricing, read 2026-08-02 (was 1.25/10 — 2×/1.5× UNDER)
  'gpt-5.2':           { inputPerM: 1.75, outputPerM: 14,  cacheReadPerM: 0.175 },  // OpenAI pricing, read 2026-08-02 (was 1.25/10 — UNDER)
  'gpt-5-mini':        { inputPerM: 0.25, outputPerM: 2,   cacheReadPerM: 0.025 },  // OpenAI pricing, read 2026-08-02 (unchanged)
  'gpt-5-nano':        { inputPerM: 0.05, outputPerM: 0.4, cacheReadPerM: 0.005 },  // ditto (unchanged)
  'gpt-5':             { inputPerM: 1.25, outputPerM: 10,  cacheReadPerM: 0.125 },  // ditto (unchanged)
  'gpt-4o-mini':       { inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075 },  // ditto (unchanged)
  'gpt-4o':            { inputPerM: 2.5,  outputPerM: 10,  cacheReadPerM: 1.25 },   // ditto (unchanged)
  'gpt-4.1-mini':      { inputPerM: 0.4,  outputPerM: 1.6, cacheReadPerM: 0.1 },    // ditto (unchanged)
  'gpt-4.1':           { inputPerM: 2,    outputPerM: 8,   cacheReadPerM: 0.5 },    // ditto (unchanged)
  'o4-mini':           { inputPerM: 1.1,  outputPerM: 4.4, cacheReadPerM: 0.275 },  // ditto (unchanged)
  'o3-mini':           { inputPerM: 1.1,  outputPerM: 4.4, cacheReadPerM: 0.55 },   // ditto (unchanged)
  'o3':                { inputPerM: 2,    outputPerM: 8,   cacheReadPerM: 0.5 },    // ditto (unchanged)
  'o1':                { inputPerM: 15,   outputPerM: 60,  cacheReadPerM: 7.5 },    // ditto (unchanged)
  // o1-mini is NO LONGER on OpenAI's pricing page or OpenRouter's catalog
  // (both read 2026-08-02) — see RETIRED_MODELS.

  // ── Google Gemini ──────────────────────────────────────────────────────────
  // Read first-party from ai.google.dev/gemini-api/docs/pricing on 2026-08-02.
  // Google bills a SECOND tier above 200k prompt tokens — carried in
  // `longContext` rather than folded into the headline rate.
  //
  // WHAT WAS WRONG: the whole family was pinned at the 2.5-generation Flash/Pro
  // rates. Flash in particular moved from $0.15/$0.60 to $0.30/$2.50, so every
  // Flash call was under-counted more than 4× on output.
  'gemini-3.1-pro':    { inputPerM: 2,    outputPerM: 12,   cacheReadPerM: 0.2,  longContext: { minPromptTokens: 200_000, inputPerM: 4, outputPerM: 18 } },  // Google pricing, read 2026-08-02 (was 1.25/10 — UNDER)
  'gemini-2.5-pro':    { inputPerM: 1.25, outputPerM: 10,   cacheReadPerM: 0.125, longContext: { minPromptTokens: 200_000, inputPerM: 2.5, outputPerM: 15 } }, // ditto (base unchanged; long tier added)
  'gemini-3.6-flash':  { inputPerM: 1.5,  outputPerM: 7.5,  cacheReadPerM: 0.15 },  // Google pricing, read 2026-08-02 (NEW row — was falling to the `flash` keyword at 0.15/0.6)
  'gemini-3.5-flash':  { inputPerM: 1.5,  outputPerM: 9,    cacheReadPerM: 0.15 },  // ditto (NEW row)
  // `gemini-3-flash` is served as a PREVIEW id and Google's pricing page lists
  // only the 3.5/3.6 Flash rows; OpenRouter's live catalog prices
  // google/gemini-3-flash-preview at $0.50/$3.00 (read 2026-08-02). Gateway
  // rate for a gateway-only id — the documented fallback source.
  'gemini-3-flash':    { inputPerM: 0.5,  outputPerM: 3,    cacheReadPerM: 0.05 },  // OpenRouter live catalog, read 2026-08-02 (was 0.15/0.6 — UNDER)
  'gemini-2.5-flash':  { inputPerM: 0.3,  outputPerM: 2.5,  cacheReadPerM: 0.03 },  // Google pricing, read 2026-08-02 (was 0.15/0.6 — 2×/4× UNDER)
  'gemini-2.5-flash-lite': { inputPerM: 0.1, outputPerM: 0.4, cacheReadPerM: 0.01 }, // OpenRouter live catalog, read 2026-08-02

  // ── DeepSeek ───────────────────────────────────────────────────────────────
  // Read first-party from api-docs.deepseek.com/quick_start/pricing on
  // 2026-08-02, which now documents ONLY deepseek-v4-flash and deepseek-v4-pro.
  //
  // ERR-HIGH APPLIED: that page states "prices will be 2x the regular prices"
  // during peak hours (09:00–12:00 and 14:00–18:00 Beijing time) — seven hours
  // of every working day. The table cannot see the wall clock, so recording the
  // off-peak rate would under-count a large share of real usage, which is the
  // dangerous direction against a spend cap. THE PEAK (2×) RATE IS RECORDED.
  // Off-peak halves of each pair, for reference: v4-pro 0.435/0.87,
  // v4-flash 0.14/0.28.
  'deepseek-v4-pro':   { inputPerM: 0.87, outputPerM: 1.74, cacheReadPerM: 0.00725 }, // DeepSeek pricing (peak), read 2026-08-02 (was 0.55/2.2)
  'deepseek-v4-flash': { inputPerM: 0.28, outputPerM: 0.56, cacheReadPerM: 0.0056 },  // ditto (NEW row)
  //
  // NO ROW FOR BARE `deepseek-v4`, AND THAT IS THE ANSWER, NOT A GAP.
  // Re-checked first-party 2026-08-03: DeepSeek's price list documents exactly
  // two v4 models, `-flash` and `-pro`. There is no product called
  // `deepseek-v4`. Bankr serves that id (bankr-service.ts) and the Surplus
  // router routes to it (surplus-router.ts), so it is a GATEWAY's own name for
  // whatever it decides to run — which means the gateway, not this table, is
  // the only thing that can price it.
  //
  // What happens today is already correct in both directions: `ratesFor` walks
  // the dash-prefix and lands on v4-pro's PEAK rate, which OVER-counts against
  // the spend cap (the safe direction), while `resolveModelPrice` refuses it
  // and the picker shows no band (the honest direction — we are not going to
  // print a number for a model its maker does not sell). Inventing a row here
  // would break the second to flatter the first.
  // The v3 line is gone from DeepSeek's own page but STILL SERVED by OpenRouter,
  // so these keep a rate rather than vanishing — a saved conversation pinned to
  // one must still price. Values are the HIGHER of the old snapshot and
  // OpenRouter's live rate (read 2026-08-02: v3.2 0.269/0.40, r1 0.70/2.50,
  // chat 0.2574/1.0287) per the cross-provider err-high rule.
  'deepseek-v3.2':     { inputPerM: 0.27, outputPerM: 1.1,  cacheReadPerM: 0.135 },  // max(snapshot, OpenRouter live 2026-08-02)
  'deepseek-r1':       { inputPerM: 0.7,  outputPerM: 2.5 },                          // OpenRouter live, read 2026-08-02 (was 0.55/2.2 — UNDER)
  'deepseek-chat':     { inputPerM: 0.27, outputPerM: 1.1,  cacheReadPerM: 0.135 },  // max(snapshot, OpenRouter live 2026-08-02)

  // ── xAI Grok ───────────────────────────────────────────────────────────────
  // Read first-party from docs.x.ai/docs/models on 2026-08-02. xAI bills a
  // second tier at 200k prompt tokens, carried in `longContext`.
  //
  // WHAT WAS WRONG: grok-4.3 was charged at $3/$15 against a real $1.25/$2.50 —
  // over-counting by 2.4× on input and 6× on output. See RETIRED_MODELS for the
  // eight ids xAI retired on 2026-05-15 and now silently redirects here.
  'grok-4.5':          { inputPerM: 2,    outputPerM: 6,   cacheReadPerM: 0.3, longContext: { minPromptTokens: 200_000, inputPerM: 4, outputPerM: 12 } },   // xAI pricing, read 2026-08-02 (NEW row)
  'grok-4.3':          { inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.2, longContext: { minPromptTokens: 200_000, inputPerM: 2.5, outputPerM: 5 } },  // ditto (was 3/15 — OVER)
  'grok-4.20':         { inputPerM: 1.25, outputPerM: 2.5, cacheReadPerM: 0.2, longContext: { minPromptTokens: 200_000, inputPerM: 2.5, outputPerM: 5 } },  // ditto (NEW row)
  'grok-build-0.1':    { inputPerM: 1,    outputPerM: 2,   cacheReadPerM: 0.2, longContext: { minPromptTokens: 200_000, inputPerM: 2, outputPerM: 4 } },    // ditto (NEW row; the grok-code-fast-1 successor)

  // ── Zhipu / Z.ai GLM ───────────────────────────────────────────────────────
  // Read first-party from docs.z.ai/guides/overview/pricing on 2026-08-02.
  // Both bare rows were UNDER-counted against Z.ai's own list price.
  'glm-5':             { inputPerM: 1,    outputPerM: 3.2 },  // Z.ai pricing, read 2026-08-02 (was 0.6/2.2 — UNDER)
  'glm-4.7':           { inputPerM: 0.6,  outputPerM: 2.2 },  // ditto (was 0.5/1.5 — UNDER)

  // ── Mistral / MiniMax / Qwen ───────────────────────────────────────────────
  // mistral-large: mistral.ai/pricing states "$2 /M tokens in and $6 /M tokens
  // out" (read 2026-08-02) and OpenRouter's live mistralai/mistral-large agrees.
  // NOTE the bare aliases are no longer documented as model ids — see
  // RETIRED_MODELS — but they keep a rate so a pinned conversation still prices.
  'mistral-large':     { inputPerM: 2,    outputPerM: 6,   cacheReadPerM: 0.2 },  // mistral.ai/pricing + OpenRouter live, read 2026-08-02 (unchanged)
  'mistral-small':     { inputPerM: 0.2,  outputPerM: 0.6, cacheReadPerM: 0.02 }, // max(snapshot, OpenRouter mistral-small-2603 0.15/0.6), read 2026-08-02
  // MiniMax publishes $0.30/$1.20 standard at ≤512k input and $0.60/$2.40 above
  // it (minimax.io platform pricing, read 2026-08-02). m2.5 output was 1.1 here
  // against a real 1.2 — a small UNDER, corrected.
  'minimax-m2.5':      { inputPerM: 0.3,  outputPerM: 1.2, cacheReadPerM: 0.05 }, // MiniMax pricing, read 2026-08-02 (was 0.3/1.1 — UNDER on output)

  // ── OpenGateway (gitlawb) ──────────────────────────────────────────────────
  // REAL rates, not a guess: read from the keyless catalog
  // https://opengateway.gitlawb.com/v1/models on 2026-08-01, which publishes
  // per-token `pricing` and `effective_pricing` per model. We take
  // `effective_pricing` (base × the gateway's ~1.2 markup) because that is what
  // the user is actually billed, and it is the larger of the two — the safe
  // direction for a spend cap. Values are $/M = per-token × 1e6. Keys are the
  // bare model segment, matched after the `org/` prefix is stripped.
  //
  // RE-CHECKED 2026-08-02 against OpenRouter's live catalog and each maker's own
  // page. Every one of these rows is the HIGHER of the rates found, which is the
  // cross-provider collision rule: this table is keyed by model, not provider,
  // and over-counting is the safe side. Comparison rates are noted per row.
  'hy3':                   { inputPerM: 0.24,  outputPerM: 0.96,  cacheReadPerM: 0.06 },    // OpenGateway effective 2026-08-01 > OpenRouter live 0.132/0.528 (2026-08-02)
  'mimo-v2.5-pro':         { inputPerM: 0.522, outputPerM: 1.044, cacheReadPerM: 0.00432 }, // OpenGateway > OpenRouter live 0.435/0.87 (2026-08-02)
  'mimo-v2.5':             { inputPerM: 0.168, outputPerM: 0.336, cacheReadPerM: 0.00336 }, // OpenGateway > OpenRouter live 0.14/0.28 (2026-08-02)
  'gemini-3.1-flash-lite': { inputPerM: 0.3,   outputPerM: 1.8,   cacheReadPerM: 0.03 },    // OpenGateway > Google list 0.25/1.50 (2026-08-02)
  'minimax-m3':            { inputPerM: 0.36,  outputPerM: 1.44,  cacheReadPerM: 0.072,
                             // MiniMax's own >512k tier ($0.60/$2.40) exceeds the
                             // gateway rate, so the long tier is the maker's.
                             longContext: { minPromptTokens: 512_000, inputPerM: 0.6, outputPerM: 2.4 } }, // OpenGateway + MiniMax pricing, read 2026-08-02
  'qwen3.7-max':           { inputPerM: 1.5,   outputPerM: 4.5,   cacheReadPerM: 0.3 },     // OpenGateway > OpenRouter live 1.475/4.425 (2026-08-02)
  'kimi-k3':               { inputPerM: 3.6,   outputPerM: 18,    cacheReadPerM: 0.36 },    // OpenGateway effective 2026-08-01; not served by OpenRouter (checked 2026-08-02)
  'glm-5.2':               { inputPerM: 1.68,  outputPerM: 5.28,  cacheReadPerM: 0.312 },   // OpenGateway > Z.ai list 1.4/4.4 and OpenRouter live 0.368/1.157 (2026-08-02)
  //
  // NO ROW FOR `kimi-k2`, for the same reason as bare `deepseek-v4` above.
  // Moonshot's own price list (platform.kimi.ai/docs/pricing, read 2026-08-03)
  // documents K3, K2.7 Code, K2.6 and the sunsetting Moonshot V1 line — plain
  // K2 is gone from it. The model itself is very much alive as OPEN WEIGHTS
  // (its curated coding note cites Moonshot's HuggingFace card), which is
  // precisely why a third party — Surplus serves it — runs it at a rate
  // Moonshot has no say in.
  //
  // So the maker publishes no price because the maker no longer sells it. That
  // is a fact about the market, not a hole in this table, and the fix is a live
  // catalog from whoever is actually serving it, not a number chosen here.
  // Meanwhile `ratesFor` walks to k3's $3.60/$18 — comfortably above any real
  // K2 rate, so the cap over-counts rather than under-counts.
}

/**
 * Model ids a provider no longer serves as themselves, with what happens now.
 *
 * WHY THIS EXISTS. `grok-4` sat in MODEL_RATES with a price and a context row,
 * describing a model that has not existed since 2026-05-15. xAI does not error
 * on it — it silently redirects to grok-4.3 and bills at grok-4.3's rates — so
 * the failure was invisible in both directions at once: the metadata we held
 * described a model that is not there, and the rate we charged was for a model
 * that no longer serves the request.
 *
 * NOTHING IS DELETED. A user may have a saved conversation pinned to one of
 * these ids, and deleting the row would make that conversation unpriceable
 * (null → the ledger's `unknown` estimate) and its metadata vanish. Instead
 * `ratesFor()` prices a retired id AT ITS SUCCESSOR'S RATE, which is exactly
 * what the provider bills, and surfaces stay able to label the row as retired.
 *
 * `evidence` records HOW we know, because the two cases are not equally strong:
 *   'retirement-notice' — the maker published a dated retirement, named the
 *                         successor, and stated the billing. Load-bearing.
 *   'absent-from-catalog' — the id is simply gone from the maker's current
 *                         catalog. Weaker: it is evidence the id is no longer
 *                         offered, NOT proof a request would fail, so these
 *                         keep their own rate where one is still defensible.
 */
export interface RetiredModel {
  /**
   * What the provider SERVES AND BILLS the request with now, or null when
   * nothing does. This is a billing fact, NOT a recommendation: xAI redirects
   * the retired Grok slugs to grok-4.3 while its own model index tells you to
   * use grok-4.5 for new work. Use this field to price a request; do not use it
   * to suggest a replacement to a user.
   */
  successor: string | null
  /** ISO date the id stopped being served as itself. */
  retiredOn: string
  /** Where that was read. Must name the page, not "the internet". */
  source: string
  /** ISO date the source was read. */
  readOn: string
  /** How strong the evidence is — see the doc comment. */
  evidence: 'retirement-notice' | 'absent-from-catalog'
  /** What a request naming this id does today. */
  behaviour: 'redirects-silently' | 'no-longer-offered'
  note?: string
}

const XAI_RETIREMENT =
  'xAI migration notice, docs.x.ai/developers/migration/may-15-retirement — the slugs "continue to resolve" and redirect, billed at the successor\'s rate'

/** The retired ids, keyed by the RAW lowercased id (no normalisation rule). */
export const RETIRED_MODELS: Record<string, RetiredModel> = {
  // ── xAI, retired 2026-05-15 12:00 PT. GENUINELY GONE, SILENTLY REDIRECTED ──
  // These eight are the ids xAI's own migration notice lists. Requests do not
  // 404: they redirect and bill at the successor's rate, so our table was
  // charging $3/$15 for work billed at grok-4.3's $1.25/$2.50.
  'grok-4-1-fast-reasoning':     { successor: 'grok-4.3', retiredOn: '2026-05-15', source: XAI_RETIREMENT, readOn: '2026-08-02', evidence: 'retirement-notice', behaviour: 'redirects-silently' },
  'grok-4-1-fast-non-reasoning': { successor: 'grok-4.3', retiredOn: '2026-05-15', source: XAI_RETIREMENT, readOn: '2026-08-02', evidence: 'retirement-notice', behaviour: 'redirects-silently' },
  'grok-4-fast-reasoning':       { successor: 'grok-4.3', retiredOn: '2026-05-15', source: XAI_RETIREMENT, readOn: '2026-08-02', evidence: 'retirement-notice', behaviour: 'redirects-silently' },
  'grok-4-fast-non-reasoning':   { successor: 'grok-4.3', retiredOn: '2026-05-15', source: XAI_RETIREMENT, readOn: '2026-08-02', evidence: 'retirement-notice', behaviour: 'redirects-silently' },
  'grok-4-0709':                 { successor: 'grok-4.3', retiredOn: '2026-05-15', source: XAI_RETIREMENT, readOn: '2026-08-02', evidence: 'retirement-notice', behaviour: 'redirects-silently' },
  'grok-3':                      { successor: 'grok-4.3', retiredOn: '2026-05-15', source: XAI_RETIREMENT, readOn: '2026-08-02', evidence: 'retirement-notice', behaviour: 'redirects-silently' },
  'grok-code-fast-1':            { successor: 'grok-build-0.1', retiredOn: '2026-05-15', source: XAI_RETIREMENT, readOn: '2026-08-02', evidence: 'retirement-notice', behaviour: 'redirects-silently' },
  'grok-imagine-image-pro':      { successor: 'grok-imagine-image-quality', retiredOn: '2026-05-15', source: XAI_RETIREMENT, readOn: '2026-08-02', evidence: 'retirement-notice', behaviour: 'redirects-silently', note: 'Image model — priced per image, not per token, so no MODEL_RATES row applies.' },

  // ── The two xAI ids OUR table actually carried ─────────────────────────────
  // Neither `grok-4` nor `grok-3-mini` appears in xAI's current model list
  // (docs.x.ai/docs/models, read 2026-08-02). `grok-4` is the bare family alias
  // for the retired grok-4-0709 line; `grok-3-mini` belongs to the grok-3 line
  // the notice retired. Both resolve to grok-4.3 like the rest of the family.
  'grok-4':      { successor: 'grok-4.3', retiredOn: '2026-05-15', source: 'Absent from docs.x.ai/docs/models; the grok-4-0709 line is on the May-15 retirement notice', readOn: '2026-08-02', evidence: 'absent-from-catalog', behaviour: 'redirects-silently', note: 'The id this repo shipped. Priced as grok-4.3 because that is what serves and bills the request.' },
  'grok-3-mini': { successor: 'grok-4.3', retiredOn: '2026-05-15', source: 'Absent from docs.x.ai/docs/models; the grok-3 line is on the May-15 retirement notice', readOn: '2026-08-02', evidence: 'absent-from-catalog', behaviour: 'redirects-silently', note: 'The id this repo shipped. Its old $0.30/$0.50 row would have under-counted grok-4.3 rates 4×/5×.' },

  // ── NOT xAI: ids absent from their maker's current catalog ─────────────────
  // Weaker evidence, so each keeps a working price rather than being cut.
  'o1-mini':          { successor: 'o4-mini',          retiredOn: '2026-08-02', source: 'Absent from developers.openai.com/api/docs/pricing and from OpenRouter\'s live catalog', readOn: '2026-08-02', evidence: 'absent-from-catalog', behaviour: 'no-longer-offered', note: 'Priced as o4-mini, which carried the identical $1.10/$4.40 rate anyway.' },
  'gemini-2.0-flash': { successor: 'gemini-2.5-flash', retiredOn: '2026-06-01', source: 'ai.google.dev/gemini-api/docs/pricing — "Gemini 2.0 Flash is deprecated and has been shut down June 1, 2026"', readOn: '2026-08-02', evidence: 'retirement-notice', behaviour: 'no-longer-offered', note: 'Google published a shutdown, not a redirect: a request should fail rather than bill. Priced as 2.5 Flash so a historical event still prices.' },
  'gemini-3-pro':     { successor: 'gemini-3.1-pro',   retiredOn: '2026-08-02', source: 'Absent from ai.google.dev/gemini-api/docs/pricing and from OpenRouter\'s live catalog (which serves gemini-3.1-pro-preview)', readOn: '2026-08-02', evidence: 'absent-from-catalog', behaviour: 'no-longer-offered' },
  'deepseek-v3':      { successor: 'deepseek-v3.2',    retiredOn: '2026-08-02', source: 'Absent from api-docs.deepseek.com/quick_start/pricing, which now documents only the v4 line', readOn: '2026-08-02', evidence: 'absent-from-catalog', behaviour: 'no-longer-offered' },
  'deepseek-reasoner':{ successor: 'deepseek-v4-pro',  retiredOn: '2026-08-02', source: 'Absent from api-docs.deepseek.com/quick_start/pricing, which now documents only deepseek-v4-flash and deepseek-v4-pro', readOn: '2026-08-02', evidence: 'absent-from-catalog', behaviour: 'no-longer-offered' },
}

/**
 * Retirement record for a model id, honouring the same id normalisation
 * `ratesFor` uses (routing suffix and `org/` prefix stripped). Null when the id
 * is still served as itself — never a guess from the name.
 *
 * Exposed so a picker can label a row "retired, now served by X" instead of
 * silently showing metadata for a model that is not there.
 */
export function retirementOf(model: string): (RetiredModel & { id: string }) | null {
  if (!model || typeof model !== 'string') return null
  const raw = model.toLowerCase().trim()
  const direct = RETIRED_MODELS[raw]
  if (direct) return { ...direct, id: raw }
  const norm = normaliseId(raw)
  const hit = RETIRED_MODELS[norm]
  return hit ? { ...hit, id: norm } : null
}

// Substring keyword fallback (codeburn pattern): matched longest-key-first when
// neither an exact id nor a dash-prefix hits. Catches host-prefixed / versioned
// names we didn't enumerate (e.g. "meta-llama-3.2-90b", "qwen2.5-72b").
//
// RE-ANCHORED 2026-08-02. These are the LAST line before a model is recorded as
// unpriced, so each one now sits at (or near) the DEAREST current member of its
// family rather than an arbitrary mid-point — an unrecognised id is exactly the
// "genuinely uncertain" case the err-high rule was written for. The old values
// were anchored on a generation that has since been superseded upward, and
// `flash` in particular under-priced the current Flash tier more than 10× on
// output. Every number below names the model it is anchored on.
const FAMILY_KEYWORDS_UNSORTED: Array<[string, ModelRates]> = [
  ['gpt-4o-mini', { inputPerM: 0.15, outputPerM: 0.6 }],   // exact rate; unambiguous name
  ['gpt-5-mini',  { inputPerM: 0.25, outputPerM: 2 }],     // exact rate
  ['gpt-5-nano',  { inputPerM: 0.05, outputPerM: 0.4 }],   // exact rate
  ['deepseek',    { inputPerM: 0.87, outputPerM: 1.74 }],  // deepseek-v4-pro at peak (was 0.27/1.1)
  ['gemini',      { inputPerM: 4,    outputPerM: 18 }],    // gemini-3.1-pro long-context tier (was 0.5/2)
  ['claude-opus', { inputPerM: 15,   outputPerM: 75 }],    // Opus 4.1, still the dearest Opus (unchanged)
  ['sonnet',      { inputPerM: 3,    outputPerM: 15 }],    // Sonnet standard tier (unchanged)
  ['haiku',       { inputPerM: 1,    outputPerM: 5 }],     // Haiku 4.5 (unchanged)
  ['mistral',     { inputPerM: 2,    outputPerM: 6 }],     // mistral-large (was 1/3)
  ['minimax',     { inputPerM: 0.6,  outputPerM: 2.4 }],   // MiniMax >512k tier (was 0.3/1.1)
  ['qwen',        { inputPerM: 1.03, outputPerM: 6.17 }],  // qwen3.6-max-preview, OpenRouter live (was 0.4/1.2)
  ['llama',       { inputPerM: 0.8,  outputPerM: 1.6 }],   // dearest llama on OpenRouter live (was 0.2/0.3)
  ['flash',       { inputPerM: 1.5,  outputPerM: 9 }],     // gemini-3.5-flash (was 0.15/0.6 — 10× UNDER on output)
  ['grok',        { inputPerM: 4,    outputPerM: 12 }],    // grok-4.5 long-context tier (was 3/15)
  ['glm',         { inputPerM: 1.68, outputPerM: 5.28 }],  // glm-5.2 at the OpenGateway rate (was 0.5/1.5)
  ['kimi',        { inputPerM: 3.6,  outputPerM: 18 }],    // kimi-k3 at the OpenGateway rate (NEW)
  ['gpt-5',       { inputPerM: 5,    outputPerM: 30 }],    // gpt-5.5; the -pro tier is dearer but is its own id (was 1.25/10)
  ['gpt-4',       { inputPerM: 10,   outputPerM: 30 }],    // gpt-4-turbo; every cheaper gpt-4* has an exact row above (was 2.5/10)
]
// Longest keyword first so 'gpt-5-mini' wins over 'gpt-5', 'gpt-4o-mini' over 'gpt-4'.
const FAMILY_KEYWORDS: Array<[string, ModelRates]> =
  [...FAMILY_KEYWORDS_UNSORTED].sort((a, b) => b[0].length - a[0].length)

const FREE_RATE: ModelRates = { inputPerM: 0, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 }

/**
 * Models VERIFIED free against their provider's own catalog — the only way a
 * model is priced at $0 here.
 *
 * FIX 2026-08-01: `ratesFor` used to return {0,0} for ANY id ending in `:free`.
 * That read a NAMING CONVENTION as a fact about money, and it was already false:
 * OpenGateway's keyless catalog (https://opengateway.gitlawb.com/v1/models,
 * fetched 2026-08-01) bills `tencent/hy3` at $0.24/M in · $0.96/M out
 * (`promo: null`) while STILL publishing the alias `tencent/hy3:free`. A route
 * through that alias recorded $0 in the cost ledger and therefore never counted
 * toward the llmBudgetUsd30d cap — a hole in a deliberate spend control.
 *
 * So free-ness must be asserted per model against real catalog data. Anything
 * not listed here falls through to the normal price lookup, and to null =
 * UNKNOWN if that misses. UNKNOWN is not $0: the ledger tags it and the spend
 * cap charges it a conservative estimate (see cost-ledger.ts).
 *
 * Keys are matched against the RAW lowercased id BEFORE any `org/` prefix or
 * `:suffix` stripping, so every accepted spelling must be listed explicitly.
 *
 * `freeUntil` = a promo window whose end date the catalog publishes. Past it the
 * model resolves to UNKNOWN rather than free — a launch promo must not silently
 * become a permanent $0, which is the same class of bug as the `:free` shortcut.
 */
export const VERIFIED_FREE_MODELS: Record<string, { freeUntil?: string }> = {
  // ── OpenGateway (opengateway.gitlawb.com/v1/models, read 2026-08-01) ────────
  // pricing + effective_pricing all "0", promo: null → unconditionally free.
  'nvidia/nemotron-3-ultra-550b-a55b:free': {},
  'nemotron-3-ultra-550b-a55b:free': {},   // same model, org prefix omitted
  // promo {discount: 1, ends_at} → free only inside the published window.
  //
  // CROSS-GATEWAY COLLISION, resolved in the conservative direction: OpenRouter's
  // live catalog (2026-08-01) serves the SAME id at pricing 0/0 with no printed
  // expiry, but this table is keyed by model id, not by provider — and for a
  // spend cap, over-counting after 08-03 (OpenRouter runs charged the unknown
  // estimate) is safer than under-counting (OpenGateway runs free forever). The
  // earliest published expiry wins.
  'inclusionai/ling-3.0-flash:free': { freeUntil: '2026-08-03T10:00:00Z' },
  'ling-3.0-flash:free':             { freeUntil: '2026-08-03T10:00:00Z' },
  'mindai/macaron-v1-tall':          { freeUntil: '2026-08-10T10:00:00Z' },
  'macaron-v1-tall':                 { freeUntil: '2026-08-10T10:00:00Z' },

  // ── OpenRouter :free rows (openrouter.ai/api/v1/models) ────────────────────
  // Verified per model against the LIVE catalog's `pricing.prompt === "0" &&
  // pricing.completion === "0"` — never from the `:free` id suffix. RE-READ
  // 2026-08-02: 337 rows, of which 17 are priced 0/0; all 12 below still are.
  // No printed expiry on any of these; docs cap the free tier at 20 req/min ·
  // 50 req/day without purchased credits
  // (notes/FREE-FLEET-SWEEP-2026-08-01.md §3).
  // OpenRouter always sends the full `org/model` id, so only that spelling is
  // listed. Since 2026-08-02 the OpenRouter picker also forwards the LIVE
  // per-model rate for every row, so this list is no longer the only pricing
  // signal for that provider — it remains the offline fallback.
  // (nvidia/nemotron-3-ultra…:free and inclusionai/ling…:free appear above.)
  'google/gemma-4-31b-it:free': {},
  'google/gemma-4-26b-a4b-it:free': {},
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': {},
  'nvidia/nemotron-nano-12b-v2-vl:free': {},
  'nvidia/nemotron-3-super-120b-a12b:free': {},
  'poolside/laguna-s-2.1:free': {},
  'poolside/laguna-xs-2.1:free': {},
  'cohere/north-mini-code:free': {},
  'nvidia/nemotron-3-nano-30b-a3b:free': {},
  'nvidia/nemotron-nano-9b-v2:free': {},
  'nvidia/nemotron-3.5-content-safety:free': {},
  'openai/gpt-oss-20b:free': {},
}

/**
 * Is this model VERIFIED free right now (honouring any published promo window)?
 * Same lookup ratesFor() step 1 performs, exposed so the cost ledger can tag
 * the resulting $0 with unpricedReason 'free' (known $0 — no money moved)
 * instead of leaving a zero-priced event indistinguishable from real spend
 * bookkeeping. Matches the RAW lowercased id — never a `:free` suffix rule.
 */
export function isVerifiedFreeModel(model: string, now: number = Date.now()): boolean {
  if (!model || typeof model !== 'string') return false
  const v = VERIFIED_FREE_MODELS[model.toLowerCase().trim()]
  return !!v && (!v.freeUntil || now < Date.parse(v.freeUntil))
}

/**
 * Rows whose published promo window has CLOSED at `now`, newest expiry first.
 *
 * Expiry already works — `isVerifiedFreeModel` stops saying yes the moment the
 * date passes, and the model correctly falls through to UNKNOWN rather than
 * staying free forever. What was missing is that it happens SILENTLY: the row
 * sits in the table looking authoritative, the model quietly stops being free,
 * and nobody learns that a price needs re-reading until someone notices a
 * changed number on a dashboard.
 *
 * `ling-3.0-flash:free` expires 2026-08-03T10:00:00Z and `macaron-v1-tall` on
 * 08-10 — both dates published by the gateway, both now also readable live from
 * `liveOpengatewayPromoEndsAt()`. This makes the moment visible instead of
 * merely correct, the same way `staleCuratedModelIds()` made a rotting citation
 * visible rather than letting a tag quietly vanish.
 *
 * Deliberately NOT a mutation: nothing is removed from the table. A closed
 * promo is a fact to act on, not a row to delete — the entry still records what
 * was true, and re-verifying it is a person's job.
 */
export function expiredFreeModelIds(now: number = Date.now()): Array<{ id: string; freeUntil: string }> {
  return Object.entries(VERIFIED_FREE_MODELS)
    .filter(([, v]) => !!v.freeUntil && Number.isFinite(Date.parse(v.freeUntil!)) && now >= Date.parse(v.freeUntil!))
    .map(([id, v]) => ({ id, freeUntil: v.freeUntil! }))
    .sort((a, b) => Date.parse(b.freeUntil) - Date.parse(a.freeUntil))
}

/**
 * ADDRESS normalisation, not capability inference: drop a known ROUTING suffix
 * and the `org/` prefix. `:free` is treated as a routing/alias suffix here and
 * is never read as a price (see VERIFIED_FREE_MODELS).
 */
function normaliseId(raw: string): string {
  const m = raw.replace(/:(free|nitro|floor|extended|online|thinking)$/, '')
  const slash = m.lastIndexOf('/')
  return slash >= 0 ? m.slice(slash + 1) : m
}

/** Table walk shared by ratesFor and its retired-successor recursion. */
function lookupRates(m: string): ModelRates | null {
  if (MODEL_RATES[m]) return MODEL_RATES[m]
  const parts = m.split('-')
  for (let n = parts.length; n >= 2; n--) {
    const key = parts.slice(0, n).join('-')
    if (MODEL_RATES[key]) return MODEL_RATES[key]
  }
  for (const [kw, r] of FAMILY_KEYWORDS) if (m.includes(kw)) return r
  return null
}

/**
 * Collapse a row's dated `promotional` rate into the rate actually in force at
 * `now`. The promo REPLACES the base input/output (and its own cache rates when
 * it publishes them); `longContext` is carried through unchanged because no
 * vendor has yet published a promotional long-context tier — if one does, this
 * is where it goes.
 */
function rateInForce(r: ModelRates, now: number): ModelRates {
  const p = r.promotional
  if (!p) return r
  const until = Date.parse(p.until)
  if (!Number.isFinite(until) || now >= until) return r
  return {
    ...r,
    inputPerM: p.inputPerM,
    outputPerM: p.outputPerM,
    cacheReadPerM: p.cacheReadPerM ?? r.cacheReadPerM,
    cacheWritePerM: p.cacheWritePerM ?? r.cacheWritePerM,
  }
}

/**
 * Rates for a model, or null when nothing matches. Matching order:
 *   1. VERIFIED_FREE_MODELS on the raw id (honouring any promo end date) → {0,0}.
 *   2. strip routing suffix (`:free`/`:nitro`/`:floor`/…) and the `org/` prefix.
 *      `:free` is treated as a ROUTING/ALIAS suffix, never as a price.
 *   3. RETIRED_MODELS — a retired id is priced AT ITS SUCCESSOR'S RATE, because
 *      that is the model that actually serves and bills the request. Checked
 *      BEFORE the table so a stale row can never out-rank the live successor.
 *   4. exact id.
 *   5. progressively shorter dash-prefixes (generalizes the old 3-segment key).
 *   6. substring keyword fallback (longest keyword first).
 *
 * `now` is injectable so the promo windows in (1) are testable.
 */
export function ratesFor(model: string, now: number = Date.now()): ModelRates | null {
  if (!model || typeof model !== 'string') return null
  const raw = model.toLowerCase().trim()
  const verifiedFree = VERIFIED_FREE_MODELS[raw]
  if (verifiedFree && (!verifiedFree.freeUntil || now < Date.parse(verifiedFree.freeUntil))) return FREE_RATE

  const m = normaliseId(raw)

  // A retired id describes a model that is not there. Price what actually runs.
  const retired = RETIRED_MODELS[raw] ?? RETIRED_MODELS[m]
  if (retired?.successor) {
    const viaSuccessor = lookupRates(normaliseId(retired.successor.toLowerCase()))
    if (viaSuccessor) return rateInForce(viaSuccessor, now)
    // No rate for the successor either — fall through rather than return null,
    // so a retired id never regresses to UNKNOWN when the table can still price
    // it from its family.
  }

  const hit = lookupRates(m)
  return hit ? rateInForce(hit, now) : null
}

/**
 * USD cost for a usage event, or null when the model has no known price.
 * `cachedInputTokens` (prompt-cache reads) are billed at the model's cache-read
 * rate (defaulting to 0.1× input) instead of full input — so cache-heavy
 * providers like Anthropic aren't mispriced. Cached tokens are assumed to be a
 * SUBSET of promptTokens and are re-priced, not double-counted.
 *
 * Applies the published long-context tier (ModelRates.longContext) when this
 * request's promptTokens crosses the provider's threshold — Gemini, Grok and
 * MiniMax all bill long prompts higher, and pricing a 400k-token agent run at
 * the short-prompt rate is exactly the under-count this file exists to prevent.
 * `cacheReadPerM` is scaled by the same ratio when the tier applies, since no
 * vendor publishes a separate long-context cache-read price.
 */
export function costUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedInputTokens = 0,
  now: number = Date.now(),
): number | null {
  const base = ratesFor(model, now)
  if (!base) return null
  const tier = base.longContext && promptTokens >= base.longContext.minPromptTokens
    ? base.longContext
    : null
  const inputPerM = tier ? tier.inputPerM : base.inputPerM
  const outputPerM = tier ? tier.outputPerM : base.outputPerM
  const baseCacheRead = base.cacheReadPerM ?? base.inputPerM * 0.1
  // Scale the cache-read rate by the same factor the input rate moved, so a
  // long-context request does not read cache at the short-prompt discount.
  const cacheRead = tier && base.inputPerM > 0
    ? baseCacheRead * (tier.inputPerM / base.inputPerM)
    : baseCacheRead

  const cached = Math.max(0, Math.min(cachedInputTokens, promptTokens))
  const fullInput = promptTokens - cached
  return (
    (fullInput / 1_000_000) * inputPerM +
    (cached / 1_000_000) * cacheRead +
    (completionTokens / 1_000_000) * outputPerM
  )
}

/**
 * Same as costUsd, but priced from rates the CALLER already holds — a live
 * provider catalog row, typically. Exists so the cost ledger can bill a run at
 * the rate that was in force when it ran (see cost-ledger.ts): the ledger
 * stamps the resulting dollar figure onto the event and never re-derives it, so
 * a catalog that changes next week cannot retro-reprice last week's usage.
 *
 * Returns null for a nonsensical rate rather than a fabricated number — the
 * same refusal ratesFor() makes for an unknown model.
 */
export function costUsdFromRates(
  rates: ModelRates,
  promptTokens: number,
  completionTokens: number,
  cachedInputTokens = 0,
): number | null {
  const { inputPerM, outputPerM } = rates
  if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM)) return null
  if (inputPerM < 0 || outputPerM < 0) return null
  const tier = rates.longContext && promptTokens >= rates.longContext.minPromptTokens
    ? rates.longContext
    : null
  const inRate = tier ? tier.inputPerM : inputPerM
  const outRate = tier ? tier.outputPerM : outputPerM
  const baseCacheRead = rates.cacheReadPerM ?? inputPerM * 0.1
  const cacheRead = tier && inputPerM > 0 ? baseCacheRead * (tier.inputPerM / inputPerM) : baseCacheRead
  const cached = Math.max(0, Math.min(cachedInputTokens, promptTokens))
  const fullInput = promptTokens - cached
  return (
    (fullInput / 1_000_000) * inRate +
    (cached / 1_000_000) * cacheRead +
    (completionTokens / 1_000_000) * outRate
  )
}
