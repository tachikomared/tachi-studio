// apps/desktop/electron/services/cache-stats.ts
//
// Process-lifetime, in-memory aggregate of provider PROMPT-CACHE hits — how many
// input tokens the gateway served from its cache instead of re-charging full
// price. It powers the Observability tab's "PROMPT CACHE" row and is the
// measurable side of the cache-alignment work (CACHE-ALIGN-AUDIT-2026-07-21
// recommendation #2: verify cache hits actually materialize rather than assume).
//
// No persistence, no egress: a plain counter fed from the TACHI loop's finish
// usage and read back over the existing router:stats observability channel (the
// same read-only IPC the tab already polls) — mirroring compaction-stats.ts.
//
// HONESTY: gateways (Bankr / OpenGateway / Venice / Surplus) may simply not
// return a cached-token field. When NOTHING is ever reported, `reported` stays
// false and the UI shows "--" — never a fabricated 0-as-fact. A genuine
// provider-reported 0 (a real cache miss) DOES count as reported.

// ── Pure extraction ──────────────────────────────────────────────────────────

function finiteNum(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined
}

/**
 * Pull the cached-input-token count out of a usage object, tolerant of every
 * shape our stack can hand us. Returns undefined (NOT 0) when the provider
 * reported no cache field at all — the caller distinguishes "unknown" from
 * "zero" on that basis.
 *
 * Shapes checked, in order:
 *  - ai@7 `LanguageModelUsage`         → `inputTokenDetails.cacheReadTokens`
 *  - provider `LanguageModelV2Usage`   → `cachedInputTokens`
 *  - raw OpenAI-compatible usage        → `raw.prompt_tokens_details.cached_tokens`
 *  - raw usage passed directly          → `prompt_tokens_details.cached_tokens`
 */
export function extractCachedInputTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>

  const details = u.inputTokenDetails as Record<string, unknown> | undefined
  const fromDetails = details && typeof details === 'object' ? finiteNum(details.cacheReadTokens) : undefined
  if (fromDetails !== undefined) return fromDetails

  const fromV2 = finiteNum(u.cachedInputTokens)
  if (fromV2 !== undefined) return fromV2

  const raw = u.raw as Record<string, unknown> | undefined
  const rawPtd = raw && typeof raw === 'object' ? (raw.prompt_tokens_details as Record<string, unknown> | undefined) : undefined
  const fromRaw = rawPtd && typeof rawPtd === 'object' ? finiteNum(rawPtd.cached_tokens) : undefined
  if (fromRaw !== undefined) return fromRaw

  const ptd = u.prompt_tokens_details as Record<string, unknown> | undefined
  const fromPtd = ptd && typeof ptd === 'object' ? finiteNum(ptd.cached_tokens) : undefined
  if (fromPtd !== undefined) return fromPtd

  return undefined
}

/**
 * Cache hit ratio = cached input tokens / total input tokens. Null when the
 * total is unknown/zero (avoid divide-by-zero and never fabricate a rate).
 */
export function cacheHitRatio(cachedInputTokens: number, totalInputTokens: number): number | null {
  if (!(totalInputTokens > 0)) return null
  return cachedInputTokens / totalInputTokens
}

// ── Process aggregate ────────────────────────────────────────────────────────

let cachedInputTokens = 0        // Σ reported cached input tokens
let inputTokensReported = 0      // Σ input tokens on events that reported cached
let reportingSamples = 0         // # events that reported a cached number

/**
 * Record one run's usage. `cachedInputTokens` is undefined when the provider
 * reported nothing → the sample is ignored (keeps `reported` honest). A reported
 * 0 counts (a genuine cache miss the provider told us about).
 */
export function recordCacheUsage(inputTokens: number | undefined, cachedTokens: number | undefined): void {
  const cached = finiteNum(cachedTokens)
  if (cached === undefined) return
  cachedInputTokens += cached
  const inp = finiteNum(inputTokens)
  if (inp !== undefined) inputTokensReported += inp
  reportingSamples += 1
}

export interface CacheSavings {
  /** Total input tokens served from the provider prompt-cache this process. */
  cachedInputTokens: number
  /** Total input tokens on the events that reported a cache figure (ratio base). */
  totalInputTokens: number
  /** cached / total, or null when the base is unknown. */
  hitRatio: number | null
  /** How many run-usage events reported a cache figure. */
  samples: number
  /** Did ANY event report a cache field? false → UI shows "--", not 0. */
  reported: boolean
}

export function getCacheSavings(): CacheSavings {
  return {
    cachedInputTokens,
    totalInputTokens: inputTokensReported,
    hitRatio: cacheHitRatio(cachedInputTokens, inputTokensReported),
    samples: reportingSamples,
    reported: reportingSamples > 0,
  }
}

/** Test/dev helper — reset the counters. */
export function resetCacheStats(): void {
  cachedInputTokens = 0
  inputTokensReported = 0
  reportingSamples = 0
}
