// packages/core/src/chat/classify-error.ts
//
// Classify a raw provider/agent error string into a coarse, user-explainable
// kind. The renderer maps kinds to localized, ACTIONABLE copy ("add a key in
// Settings") instead of dumping the raw provider payload at the user — the
// raw text stays available as a secondary detail line.
//
// Heuristic + ordered: auth beats no-key (an "invalid api key" is auth, not
// missing), specific kinds beat network, unknown is the fallthrough. Pure and
// dependency-free so both the renderer and main can share it.

export type ProviderErrorKind =
  | 'no-key'          // no key configured / provider not set up
  | 'auth'            // key present but rejected (401/403/invalid)
  | 'rate-limit'      // 429 / too many requests
  | 'quota'           // credits/billing/quota exhausted
  | 'context-length'  // prompt too large for the model window
  | 'network'         // dns/timeout/refused/offline
  | 'upstream'        // provider 5xx / overloaded
  | 'unknown'

const AUTH_RE = /\b401\b|\b403\b|unauthorized|forbidden|invalid[ _-]?(?:api[ _-]?)?key|invalid[ _-]?token|incorrect api key|authentication|x-api-key/i
const NO_KEY_RE = /NO_PROVIDER|no api key|missing (?:api )?key|api key (?:not|is not) (?:set|configured|found)|add .{0,24}api key/i
const RATE_RE = /\b429\b|rate[ _-]?limit|too many requests/i
const QUOTA_RE = /\b402\b|insufficient[ _-]?quota|quota|credit|billing|payment required|exceeded your current/i
const CTX_RE = /context[ _-]?length|maximum context|context window|too many tokens|prompt is too long|context_length_exceeded/i
const NETWORK_RE = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|network|socket hang up|\btimeout\b|timed out|offline|dns/i
const UPSTREAM_RE = /\b50[0234]\b|internal server error|bad gateway|service unavailable|overloaded|upstream/i

export function classifyProviderError(raw: string | undefined | null): ProviderErrorKind {
  const s = (raw ?? '').slice(0, 2000)
  if (!s.trim()) return 'unknown'
  // AUTH first: a 401 whose body ALSO says "no api key found" is a REJECTED
  // key, not a missing one — the user must fix the key, not add another.
  if (AUTH_RE.test(s)) return 'auth'
  if (NO_KEY_RE.test(s)) return 'no-key'
  if (RATE_RE.test(s)) return 'rate-limit'
  if (QUOTA_RE.test(s)) return 'quota'
  if (CTX_RE.test(s)) return 'context-length'
  if (UPSTREAM_RE.test(s)) return 'upstream'
  if (NETWORK_RE.test(s)) return 'network'
  return 'unknown'
}
