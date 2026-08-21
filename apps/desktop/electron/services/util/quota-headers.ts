// apps/desktop/electron/services/util/quota-headers.ts
//
// Rate-limit-header quota parsing. Ported from free-coding-models
// (src/core/ping.js extractQuotaPercent): providers expose remaining quota via
// rate-limit headers under several different names. We probe the four common
// remaining/limit pairs in priority order and return remaining-as-a-percentage
// so the router can preemptively deprioritize a nearly-exhausted model.
//
// Pure TypeScript — no imports, no side-effects (vitest-importable).

// Recognized (remaining, limit) header-name pairs, most-specific first. The
// non-suffixed `*-remaining`/`*-limit` pair is preferred over the
// `*-remaining-requests` pair, and `x-ratelimit-*` over the bare `ratelimit-*`.
const QUOTA_HEADER_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ['x-ratelimit-remaining', 'x-ratelimit-limit'],
  ['x-ratelimit-remaining-requests', 'x-ratelimit-limit-requests'],
  ['ratelimit-remaining', 'ratelimit-limit'],
  ['ratelimit-remaining-requests', 'ratelimit-limit-requests'],
]

/** Read a header value from a fetch Headers instance or a plain object (case-tolerant). */
function getHeaderValue(headers: Record<string, string> | Headers, key: string): string | null {
  if (!headers) return null
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(key)
  }
  const obj = headers as Record<string, string>
  return obj[key] ?? obj[key.toLowerCase()] ?? null
}

/**
 * Parse rate-limit headers into a remaining-quota percentage (0..100), or null
 * when no recognized remaining/limit pair is present (or the limit is invalid).
 * The first variant that yields a finite remaining + positive limit wins.
 */
export function extractQuotaPercent(headers: Record<string, string> | Headers): number | null {
  for (const [remainingKey, limitKey] of QUOTA_HEADER_VARIANTS) {
    const remaining = parseFloat(getHeaderValue(headers, remainingKey) ?? '')
    const limit = parseFloat(getHeaderValue(headers, limitKey) ?? '')
    if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      const pct = Math.round((remaining / limit) * 100)
      return Math.max(0, Math.min(100, pct))
    }
  }
  return null
}
