// apps/desktop/src/pages/status/freellmapi-providers.ts
//
// Canonical list of providers that freellmapi knows about. Platform IDs must
// match the PLATFORMS enum in freellmapi/server/src/db/index.ts exactly —
// these are sent as the `platform` field in POST /api/keys.
//
// State: V13 (2026-08-01). Kilo Gateway and OpenCode Zen are keyless upstreams
// vendored into the relay by scripts/patches/freellmapi-kilo-zen-freeroute.patch;
// Pollinations and OVHcloud were dropped from the keyless set the same day after
// live probes returned 402 and 403 respectively.
// Platforms added in early migrations (moonshot, minimax, huggingface) are still
// valid for key storage but are excluded from this UI list — only enabled /
// free-tier ones are shown.
//
// noKey: providers that accept anonymous requests (Kilo, Zen, LLM7). The
// sidecar-manager seeds a placeholder key for these automatically. These are
// shown with [FREE · NO KEY] instead of "Get key / Add key" buttons.
//
// Anon providers appear FIRST so the user immediately sees zero-config options.

export interface FreellmapiProvider {
  /** Storage key — matches the platform id in freellmapi's keys table. */
  id: string
  label: string
  signupUrl: string
  /** Human-readable free quota summary shown in the UI. */
  dailyFree: string
  /** True for providers that need no API key (anonymous-access tier). */
  noKey?: boolean
  /**
   * This upstream may train on the prompts routed to it.
   *
   * Kilo publishes `mayTrainOnYourPrompts: true` on every one of its free rows.
   * It used to be a standalone provider whose own card carried that warning;
   * now it is reached only through this router, so the flag rides the row and
   * ProvidersCard renders it. Never drop this silently — it is the price of the
   * free route, and this list is one of the few places a user can read it.
   */
  trainsOnPrompts?: boolean
  /**
   * PRIVATE MODE classification.
   *   'cloud' — outbound HTTPS to a third-party endpoint. Locked when the
   *             privacy store is in 'private' mode. Default for every entry.
   *   'local' — runs on the user's own machine (e.g. local Ollama). Stays
   *             enabled in private mode. Reserved for future local-only
   *             entries; none of the current freellmapi providers qualify
   *             (the "Ollama Cloud" entry below talks to ollama.com).
   */
  kind?: 'cloud' | 'local'
}

/** Default to 'cloud' when an entry omits the explicit kind. */
export function providerKind(p: FreellmapiProvider): 'cloud' | 'local' {
  return p.kind ?? 'cloud'
}

/**
 * The quota phrase for a row.
 *
 * The card's row template used to render `{p.dailyFree} free`, which printed
 * "20 req/day free free" for Google, "GPU-time quota (free) free" for Ollama and
 * "200 req/day (:free) free" for OpenRouter — a template joining a word onto a
 * value that already carried it. The word is added only when the value does not
 * already say it, so both the quota strings and the template can stay readable
 * on their own.
 */
export function quotaLabel(p: FreellmapiProvider): string {
  return /free/i.test(p.dailyFree) ? p.dailyFree : `${p.dailyFree} free`
}

// ── ONE denominator for the Free Providers card ──────────────────────────────
//
// On the 2026-08-02 packaged build this card showed THREE different numbers for
// one install: the header said "12 / 16 connected", the list rendered 16 rows
// with 6 connected badges, and the relay's own registry reported 18 platforms
// with 6 healthy. Each number was computed from a different thing:
//
//   12 — `settings:list-keys`, i.e. EVERY credential in Tachi's keychain, which
//        includes Bankr, Venice, Brave Search, Tavily, Civitai, HuggingFace…
//        None of those is a free-router platform. The numerator was measuring a
//        different population from its own denominator.
//   16 — the length of FREELLMAPI_PROVIDERS, the platforms this build lists.
//   18 — what the relay actually carries, including migration-era platforms
//        (moonshot, minimax, huggingface) this UI deliberately does not list.
//
// So: ONE state per row, derived here, and the header, the row badge and the
// count all read it. See RELAY_DENOMINATOR for what the printed x / y means.

/** The relay's own row for a platform (freellmapi:list-platforms). */
export interface RelayPlatformFacts {
  modelCount:  number
  keyCount:    number
  healthyKeys: number
  invalidKeys: number
}

/**
 * What one expected platform is doing, in the relay's terms.
 *
 *   'ready'         the relay carries the platform AND holds an enabled key —
 *                   the router can route through it right now.
 *   'rejected'      the relay holds keys for it and the provider rejected every
 *                   one. Reads as connected in a keychain, routes nothing.
 *   'unseeded'      carried, but with no enabled key row: the router skips the
 *                   platform before it opens a socket.
 *   'missing'       the relay does not carry this platform at all (a vendor
 *                   patch that did not land).
 *   'key-saved'     the relay did not answer, and we hold a key for it. The
 *                   only thing we actually know, and it is not verification.
 *   'unknown'       the relay did not answer and we hold nothing.
 */
export type RelayRowState =
  | 'ready' | 'rejected' | 'unseeded' | 'missing' | 'key-saved' | 'unknown'

export function relayRowState(input: {
  /** The relay's row, or undefined when the relay has no such platform. */
  row?: RelayPlatformFacts
  /** False when the relay is not running / did not answer at all. */
  relayAnswered: boolean
  /** A credential for this platform id exists in Tachi's keychain. */
  hasSavedKey: boolean
}): RelayRowState {
  if (!input.relayAnswered) return input.hasSavedKey ? 'key-saved' : 'unknown'
  const row = input.row
  if (!row || row.modelCount === 0) return 'missing'
  if (row.invalidKeys > 0 && row.healthyKeys === 0) return 'rejected'
  if (row.keyCount === 0) return 'unseeded'
  return 'ready'
}

/**
 * THE definition of "connected" on this card: the free router can route through
 * this platform right now. Nothing else counts — not a key in our keychain the
 * router never received, not a platform the router carries with no key.
 */
export function isRelayConnected(state: RelayRowState): boolean {
  return state === 'ready'
}

/**
 * What the header's `x / y` means, in one sentence, kept next to the code that
 * computes it because the meaning is the part that drifted.
 */
export const RELAY_DENOMINATOR =
  'x = platforms the free router can route through right now (it carries the platform and holds a usable key); '
  + 'y = the platforms this build lists. The router may also carry platforms this list does not show.'

export const FREELLMAPI_PROVIDERS: FreellmapiProvider[] = [
  // ── Anonymous / no-key providers (auto-seeded by sidecar-manager) ──────────
  // These work immediately without any configuration. MUST stay in sync with
  // the `anon` seed list in sidecar-manager.ts: a row here that is not seeded
  // there shows a [FREE · NO KEY] badge for a platform the router will skip.
  //
  // Probed live 2026-08-01. Pollinations (402 + deprecation notice) and
  // OVHcloud (403 — its anonymous tier became an OAuth flow) were REMOVED from
  // this list and un-seeded the same day: a badge promising a free tier that
  // 4xxs is worse than no row at all.
  {
    id: 'kilo',
    label: 'Kilo Gateway',
    signupUrl: 'https://kilo.ai/',
    dailyFree: 'Anonymous (no key) · to 1M ctx',
    noKey: true,
    // The price of free — see the field docs above.
    trainsOnPrompts: true,
  },
  {
    id: 'zen',
    label: 'OpenCode Zen',
    signupUrl: 'https://opencode.ai/zen',
    dailyFree: 'Anonymous (no key) · best-effort',
    noKey: true,
  },
  {
    id: 'llm7',
    label: 'LLM7',
    signupUrl: 'https://llm7.io/',
    dailyFree: '100 req/hr (anon)',
    noKey: true,
  },

  // ── API-key providers ────────────────────────────────────────────────────────
  {
    id: 'google',
    label: 'Google Gemini',
    signupUrl: 'https://aistudio.google.com/apikey',
    dailyFree: '20 req/day free',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    signupUrl: 'https://openrouter.ai/keys',
    dailyFree: '200 req/day (:free)',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    signupUrl: 'https://cloud.cerebras.ai/platform/keys',
    dailyFree: '~30M tokens/mo',
  },
  {
    id: 'groq',
    label: 'Groq',
    signupUrl: 'https://console.groq.com/keys',
    dailyFree: '1,000 req/day',
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    signupUrl: 'https://cloud.sambanova.ai/apis',
    dailyFree: '20 req/day',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    signupUrl: 'https://console.mistral.ai/api-keys',
    dailyFree: '~1B tokens/mo (shared)',
  },
  {
    id: 'github',
    label: 'GitHub Models',
    signupUrl: 'https://github.com/settings/personal-access-tokens',
    dailyFree: '50 req/day',
  },
  {
    id: 'cohere',
    label: 'Cohere',
    signupUrl: 'https://dashboard.cohere.com/api-keys',
    dailyFree: '1,000 calls/mo',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare AI',
    signupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    dailyFree: '10,000 Neurons/day',
  },
  {
    id: 'zhipu',
    label: 'Zhipu (GLM)',
    signupUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys',
    dailyFree: '~30M tokens/mo',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    signupUrl: 'https://build.nvidia.com/settings/api-keys',
    dailyFree: '1,000 starter credits',
  },
  {
    id: 'ollama',
    label: 'Ollama Cloud',
    signupUrl: 'https://ollama.com/settings/keys',
    dailyFree: 'GPU-time quota (free)',
  },
  {
    id: 'scaleway',
    label: 'Scaleway',
    signupUrl: 'https://console.scaleway.com/iam/api-keys',
    dailyFree: '1M free tokens (EU)',
  },
]
