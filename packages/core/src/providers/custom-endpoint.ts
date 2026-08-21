// packages/core/src/providers/custom-endpoint.ts
//
// PURE helpers for USER-ADDED "custom OpenAI-compatible" endpoints — the
// "Add endpoint: name + base URL + key" feature (USER-PAINS T17). These reach a
// LM Studio / Ollama / llama.cpp / vLLM server that the user runs on their own
// machine or another box on the LAN.
//
// Registry providers are compile-time constants (registry.ts). Custom endpoints
// are RUNTIME data the user configures — persisted in AppSettings.providers with
// kind 'custom-openai'. This module is the single source of truth for the three
// pure operations both the renderer AND the main process need to agree on:
//
//   1. base-URL NORMALIZATION   — so `${base}/chat/completions` and
//      `${base}/models` never double a `/v1` or a pasted endpoint suffix.
//   2. hostname LOCALITY        — localhost / 127.* / 192.168.* / 10.* / …
//      classify as LAN-LOCAL; everything else is CLOUD. Drives the PRIVATE MODE
//      egress rule (cloud custom endpoints are hidden/blocked; local ones stay)
//      and the LAN-LOCAL / CLOUD badge in the chat provider picker.
//   3. the `custom:<id>` PROVIDER-ID scheme that namespaces a custom endpoint's
//      id (from settings) away from the canonical registry ids.
//
// PURE DATA + PURE FUNCTIONS ONLY. No node:* imports, no I/O, no keychain — this
// file is imported by the RENDERER via the subpath
// `@tachi/core/src/providers/custom-endpoint` (same pattern as registry.ts) and
// by the MAIN process via `@tachi/core`.

// ── Provider-id scheme ────────────────────────────────────────────────────────

/** Prefix that namespaces a user-added endpoint's id into a provider id. */
export const CUSTOM_PROVIDER_PREFIX = 'custom:'

/** settings.id → provider id used across chat / picker / chat-service. */
export function customProviderId(settingsId: string): string {
  return `${CUSTOM_PROVIDER_PREFIX}${settingsId}`
}

/** provider id → the settings.id it wraps, or null when it isn't a custom id. */
export function parseCustomProviderId(providerId: string | null | undefined): string | null {
  if (!providerId || !providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) return null
  const id = providerId.slice(CUSTOM_PROVIDER_PREFIX.length)
  return id.length > 0 ? id : null
}

/** True when a provider id belongs to a user-added custom endpoint. */
export function isCustomProviderId(providerId: string | null | undefined): boolean {
  return parseCustomProviderId(providerId) !== null
}

/**
 * Keychain id holding a custom endpoint's OPTIONAL API key. Deliberately the
 * same string as the provider id (`custom:<settingsId>`) — the keychain and
 * settings stores are separate, so there is no collision, and one id is easier
 * to reason about than two.
 */
export function customEndpointKeychainId(settingsId: string): string {
  return `${CUSTOM_PROVIDER_PREFIX}${settingsId}`
}

// ── Base-URL normalization ────────────────────────────────────────────────────

export interface NormalizeBaseUrlResult {
  ok: boolean
  /** Origin + path with NO trailing slash, ready to append `/chat/completions`. */
  url?: string
  error?: string
}

/**
 * Normalize a user-typed base URL into the OpenAI-base convention the rest of
 * the app expects: `<origin>[/path]` WITHOUT a trailing slash and WITHOUT the
 * endpoint segment, so callers can safely append `/chat/completions` or
 * `/models`.
 *
 * Rules:
 *   - must parse as an absolute http(s) URL (anything else is rejected);
 *   - query + hash are dropped (a models base never carries them);
 *   - trailing slashes are stripped;
 *   - a pasted endpoint the user copied wholesale (`/chat/completions` or
 *     `/models`, the two suffixes THIS app appends) is stripped so we never
 *     send `/v1/chat/completions/chat/completions`;
 *   - an accidentally doubled version segment (`/v1/v1`) is collapsed to `/v1`.
 *
 * We deliberately do NOT auto-append `/v1`: some servers serve the OpenAI
 * surface at the root, and forcing `/v1` would break them. The picker copy
 * guides the user to include it (LM Studio / Ollama / vLLM all use `/v1`).
 */
export function normalizeBaseUrl(raw: string): NormalizeBaseUrlResult {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: false, error: 'Enter a base URL.' }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'Not a valid URL — include http:// or https://.' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must start with http:// or https://.' }
  }
  if (!parsed.hostname) return { ok: false, error: 'URL is missing a host.' }

  let path = parsed.pathname
  // strip trailing slashes
  path = path.replace(/\/+$/, '')
  // strip a pasted endpoint the user may have copied whole (the two suffixes we append)
  path = path.replace(/\/(chat\/completions|models)$/i, '')
  // collapse an accidental doubled version segment: /v1/v1 -> /v1
  path = path.replace(/\/v(\d+)\/v\1(?=\/|$)/i, '/v$1')
  // re-strip in case the endpoint strip exposed a new trailing slash
  path = path.replace(/\/+$/, '')

  // Rebuild from origin (protocol + host[:port]) + normalized path. Using
  // `.host` preserves a non-default port; `.origin` would too, but `.host`
  // avoids surprises for exotic schemes (already gated to http/https above).
  return { ok: true, url: `${parsed.protocol}//${parsed.host}${path}` }
}

// ── Hostname locality (PRIVATE MODE egress + picker badge) ─────────────────────

export type EndpointLocality = 'lan-local' | 'cloud'

/**
 * Classify a raw hostname as LAN-LOCAL (loopback, RFC1918 private, link-local,
 * mDNS `.local`, IPv6 ULA/link-local) or CLOUD (anything routable on the public
 * internet). This is the egress rule: in PRIVATE MODE, CLOUD custom endpoints
 * are hidden from the picker and blocked at send time; LAN-LOCAL ones stay,
 * because reaching an LM Studio box at 192.168.x.y is the whole point of T17.
 */
export function classifyHostLocality(host: string): EndpointLocality {
  // Lower-case + strip IPv6 brackets (`[::1]` → `::1`).
  const h = (host ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!h) return 'cloud'

  if (h === 'localhost' || h.endsWith('.localhost')) return 'lan-local'
  if (h.endsWith('.local')) return 'lan-local' // mDNS / Bonjour

  // IPv6 loopback / ULA (fc00::/7) / link-local (fe80::/10)
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return 'lan-local'
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return 'lan-local'
  if (/^fe[89ab][0-9a-f]:/.test(h)) return 'lan-local'

  // IPv4 loopback / RFC1918 private / link-local
  if (/^127\./.test(h)) return 'lan-local'
  if (/^10\./.test(h)) return 'lan-local'
  if (/^192\.168\./.test(h)) return 'lan-local'
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return 'lan-local'
  if (/^169\.254\./.test(h)) return 'lan-local'

  return 'cloud'
}

/** Locality of a base URL (parses the host, defaults to 'cloud' on a bad URL). */
export function endpointLocality(baseUrl: string): EndpointLocality {
  try {
    return classifyHostLocality(new URL(baseUrl).hostname)
  } catch {
    return 'cloud'
  }
}

/** True when the endpoint's host is loopback/LAN-private (PRIVATE-MODE-safe). */
export function isLocalCustomEndpoint(baseUrl: string): boolean {
  return endpointLocality(baseUrl) === 'lan-local'
}
