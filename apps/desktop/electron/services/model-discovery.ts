// apps/desktop/electron/services/model-discovery.ts
//
// Provider connectivity probe via OpenAI-compatible `/v1/models`.
//
// Lifted from hermes-desktop's model-discovery + Nango's `proxy.verification`
// pattern. We hit the upstream's models endpoint with the user-supplied key
// and treat any 2xx response (or 200 with a `data: []` list) as a real
// connectivity success. 401/403 → bad key; everything else → network/host.
//
// One-shot Node `https`/`http` only — no external dep, runs in the main
// process so it bypasses CSP/CORS that would block the renderer.
//
// Used by:
//   - onboarding ProviderStep (the "Test" button on provider cards)
//   - Future Settings → Providers card-level verification
//
// Returns a discriminated result so the caller can render a precise error.

import { request as httpRequest, type IncomingMessage } from 'http'
import { request as httpsRequest } from 'https'
import { URL } from 'url'

// ─── Provider catalog ─────────────────────────────────────────────────────────
//
// Maps providerId → { baseUrl, authHeader }. We support OpenAI-compatible
// gateways (path is always /v1/models, header is Authorization: Bearer …) plus
// a couple Anthropic-shaped providers that use x-api-key. Local providers
// (Ollama) don't need a key.
//
// `baseUrl` always ends without a trailing slash — we append `/v1/models`
// (or the override) at probe time.
type AuthKind = 'bearer' | 'anthropic' | 'none'

interface ProviderProbe {
  baseUrl:   string
  endpoint:  string    // path; defaults to '/v1/models'
  authKind:  AuthKind
  /** Header to send the key as. For anthropic it's the version header in addition. */
  extraHeaders?: Record<string, string>
}

const PROBES: Record<string, ProviderProbe> = {
  // ── OpenAI-shaped gateways ───────────────────────────────────────────
  'bankr-gateway':  { baseUrl: 'https://llm.bankr.bot',                 endpoint: '/v1/models', authKind: 'bearer' },
  'imgnai':         { baseUrl: 'https://kat.imgnai.com',                endpoint: '/v1/models', authKind: 'bearer' },
  'opengateway':    { baseUrl: 'https://opengateway.gitlawb.com',       endpoint: '/v1/models', authKind: 'bearer' },
  'openrouter':     { baseUrl: 'https://openrouter.ai/api',             endpoint: '/v1/models', authKind: 'bearer' },
  'openai':         { baseUrl: 'https://api.openai.com',                endpoint: '/v1/models', authKind: 'bearer' },
  'groq':           { baseUrl: 'https://api.groq.com',                  endpoint: '/openai/v1/models', authKind: 'bearer' },
  'mistral':        { baseUrl: 'https://api.mistral.ai',                endpoint: '/v1/models', authKind: 'bearer' },
  'cerebras':       { baseUrl: 'https://api.cerebras.ai',               endpoint: '/v1/models', authKind: 'bearer' },
  'cohere':         { baseUrl: 'https://api.cohere.com',                endpoint: '/v1/models', authKind: 'bearer' },
  // ── Anthropic-shaped ─────────────────────────────────────────────────
  'anthropic':      { baseUrl: 'https://api.anthropic.com',             endpoint: '/v1/models', authKind: 'anthropic',
                      extraHeaders: { 'anthropic-version': '2023-06-01' } },
  // ── Local — no key needed ────────────────────────────────────────────
  'ollama':         { baseUrl: 'http://127.0.0.1:11434',                endpoint: '/api/tags',   authKind: 'none' },
}

// ─── Result type ──────────────────────────────────────────────────────────────

export type DiscoveryResult =
  | { ok: true;  models: string[]; latencyMs: number }
  | { ok: false; reason: 'unknown-provider' | 'unauthorized' | 'forbidden' | 'rate-limited' | 'network' | 'timeout' | 'http-error'
                 status?: number; message: string }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function authHeaders(probe: ProviderProbe, apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'Accept': 'application/json', 'User-Agent': 'TachiDesk/1.0' }
  if (probe.authKind === 'bearer'    && apiKey) h['Authorization'] = `Bearer ${apiKey}`
  if (probe.authKind === 'anthropic' && apiKey) h['x-api-key']     = apiKey
  return { ...h, ...(probe.extraHeaders ?? {}) }
}

function classifyHttpError(status: number, body: string): DiscoveryResult {
  if (status === 401) return { ok: false, reason: 'unauthorized', status, message: 'API key was rejected (401). Double-check the key.' }
  if (status === 403) return { ok: false, reason: 'forbidden',    status, message: 'API key is valid but lacks access (403).' }
  if (status === 429) return { ok: false, reason: 'rate-limited', status, message: 'Rate-limited (429). Try again in a moment.' }
  // Everything else: surface a short body snippet so the user can act on it.
  const snippet = body.slice(0, 200)
  return { ok: false, reason: 'http-error', status, message: `Upstream returned ${status}. ${snippet}` }
}

// Extract a `models: string[]` array from a few known response shapes.
//   OpenAI:  { data: [{ id: '...' }, ...] }
//   Ollama:  { models: [{ name: '...' }, ...] }
//   Anthropic: { data: [{ id: '...' }, ...] }
function parseModels(body: string): string[] {
  try {
    const json = JSON.parse(body) as {
      data?: Array<{ id?: string }>
      models?: Array<{ name?: string }>
      // imgnAI Katana shape: sectioned arrays of { public_model_name }.
      text?: Array<{ public_model_name?: string }>
      images?: Array<{ public_model_name?: string }>
      videos?: Array<{ public_model_name?: string }>
    }
    if (Array.isArray(json.data))   return json.data.map(m => m.id ?? '').filter(Boolean)
    if (Array.isArray(json.models)) return json.models.map(m => m.name ?? '').filter(Boolean)
    if (Array.isArray(json.text) || Array.isArray(json.images) || Array.isArray(json.videos)) {
      return [...(json.text ?? []), ...(json.images ?? []), ...(json.videos ?? [])]
        .map(m => m.public_model_name ?? '').filter(Boolean)
    }
  } catch { /* fall through */ }
  return []
}

// ─── Probe ────────────────────────────────────────────────────────────────────

/**
 * Hit `<baseUrl>/v1/models` (or the provider-specific path) and classify the
 * response. Returns inside `TIMEOUT_MS` regardless — never hangs the UI.
 *
 * `apiKey` may be undefined for providers that don't take one (Ollama etc).
 */
const TIMEOUT_MS = 8_000

export async function testProviderConnection(
  providerId: string,
  apiKey?: string,
  /** Optional override — useful for self-hosted gateways with custom URLs. */
  baseUrlOverride?: string,
): Promise<DiscoveryResult> {
  const probe = PROBES[providerId]
  if (!probe) {
    return { ok: false, reason: 'unknown-provider', message: `Unknown provider id "${providerId}"` }
  }

  const base = baseUrlOverride?.replace(/\/+$/, '') ?? probe.baseUrl
  const url  = new URL(probe.endpoint, base + '/')
  const isHttps = url.protocol === 'https:'

  const headers = authHeaders(probe, apiKey)
  const started = Date.now()

  return new Promise<DiscoveryResult>((resolve) => {
    const req = (isHttps ? httpsRequest : httpRequest)({
      method:   'GET',
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      headers,
      timeout:  TIMEOUT_MS,
    }, (res: IncomingMessage) => {
      let body = ''
      res.on('data', chunk => { body += chunk.toString('utf-8') })
      res.on('end', () => {
        const latencyMs = Date.now() - started
        const status    = res.statusCode ?? 0
        if (status >= 200 && status < 300) {
          const models = parseModels(body)
          resolve({ ok: true, models, latencyMs })
          return
        }
        resolve(classifyHttpError(status, body))
      })
    })

    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, reason: 'timeout', message: `Timed out after ${TIMEOUT_MS / 1000}s` })
    })

    req.on('error', err => {
      // Common cases: ENOTFOUND (DNS), ECONNREFUSED (host down), TLS errors.
      const msg = err instanceof Error ? err.message : String(err)
      resolve({ ok: false, reason: 'network', message: msg })
    })

    req.end()
  })
}

/** List the provider ids we know how to probe. */
export function knownProviderIds(): string[] {
  return Object.keys(PROBES)
}
