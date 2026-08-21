import {
  BankrProvider, OpenAiCompatBackend, getProvider, type ChatBackend, ModelInfo, HealthStatus,
  parseCustomProviderId, customEndpointKeychainId, normalizeBaseUrl, isLocalCustomEndpoint,
  type ProviderSettings, type ProviderId,
} from '@tachi/core'
import { retrieveKey } from './keychain'
import { loadSettings } from './settings-store'
import { testProviderConnection, knownProviderIds, type DiscoveryResult } from './model-discovery'

const bankr = new BankrProvider()

// ── Custom OpenAI-compatible endpoints (USER-PAINS T17) ───────────────────────
//
// User-added LM Studio / Ollama / llama.cpp / vLLM servers, persisted in
// AppSettings.providers with kind 'custom-openai' and a provider id of
// `custom:<settingsId>`. Everything below resolves that id back to a normalized
// base URL + keychain key so the dedicated custom branch in chat-service and the
// picker's live model list can reach them.

export interface ResolvedCustomEndpoint {
  /** settings.id (without the `custom:` prefix). */
  settingsId: string
  /** provider id as seen by chat / picker (`custom:<settingsId>`). */
  providerId: string
  displayName: string
  /** Normalized base URL — append `/chat/completions` or `/models`. */
  baseUrl: string
  /** Keychain id holding the optional API key. */
  keychainId: string
  /** True when the host is loopback/LAN-private (PRIVATE-MODE-safe egress). */
  local: boolean
  selectedModel?: string
}

/**
 * Resolve a `custom:<id>` provider id to its persisted, normalized endpoint, or
 * null when it isn't a custom id, isn't found, is disabled, or has a malformed
 * base URL. Reads settings fresh each call (cheap JSON read; settings change
 * out-of-band from the Settings card).
 */
export function resolveCustomEndpoint(providerId: string): ResolvedCustomEndpoint | null {
  const settingsId = parseCustomProviderId(providerId)
  if (!settingsId) return null
  const entry = loadSettings().providers?.find(
    (p: ProviderSettings) => p.id === settingsId && p.kind === 'custom-openai' && p.enabled,
  )
  if (!entry) return null
  const norm = normalizeBaseUrl(entry.baseUrl)
  if (!norm.ok || !norm.url) return null
  return {
    settingsId,
    providerId,
    displayName: entry.displayName || 'Custom endpoint',
    baseUrl: norm.url,
    keychainId: customEndpointKeychainId(settingsId),
    local: isLocalCustomEndpoint(norm.url),
    selectedModel: entry.selectedModel,
  }
}

// NOTE: custom endpoints deliberately do NOT reuse OpenAiCompatBackend for chat —
// that backend hard-errors on an empty API key, but local LM Studio / Ollama /
// llama.cpp / vLLM servers are keyless. chat-service.ts has a dedicated custom
// branch (optional Authorization header) that reuses the shared SSE machinery.

// ── Custom endpoint /models fetch (TEST button + live model picker) ────────────

export interface CustomModelsResult {
  ok: boolean
  models: string[]
  error?: string
}

/**
 * GET `<baseUrl>/models` in the main process (bypasses renderer CSP/CORS) with a
 * hard timeout. No spawn — plain fetch (undici) with an AbortController, so
 * windowsHide is N/A. Deliberately does NOT run the SSRF/loopback guard: reaching
 * a LAN box (192.168.x / 10.x) is the entire feature, and this call is only ever
 * triggered by an explicit user action in Settings or the chat picker.
 */
export async function fetchCustomEndpointModels(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 5_000,
): Promise<CustomModelsResult> {
  const norm = normalizeBaseUrl(baseUrl)
  if (!norm.ok || !norm.url) return { ok: false, models: [], error: norm.error ?? 'Invalid base URL.' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey && apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`
    const res = await fetch(`${norm.url}/models`, { method: 'GET', headers, signal: controller.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 401 || res.status === 403) {
        return { ok: false, models: [], error: `Auth failed (${res.status}) — check the API key.` }
      }
      return { ok: false, models: [], error: `Endpoint returned ${res.status}. ${body.slice(0, 160)}`.trim() }
    }
    // OpenAI shape: { data: [{ id }] }. Some servers use { models: [{ name|id }] }.
    const json = await res.json().catch(() => null) as
      | { data?: Array<{ id?: string }>; models?: Array<{ id?: string; name?: string }> }
      | null
    const models = Array.isArray(json?.data)
      ? json!.data.map(m => m.id ?? '').filter(Boolean)
      : Array.isArray(json?.models)
        ? json!.models.map(m => m.id ?? m.name ?? '').filter(Boolean)
        : []
    return { ok: true, models }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const friendly = controller.signal.aborted
      ? `Timed out after ${timeoutMs / 1000}s — is the server running and reachable?`
      : `Could not reach the endpoint: ${msg}`
    return { ok: false, models: [], error: friendly }
  } finally {
    clearTimeout(timer)
  }
}

/** TEST button entry: probe an UNSAVED endpoint (raw base URL + optional key). */
export async function testCustomEndpoint(baseUrl: string, apiKey?: string): Promise<CustomModelsResult> {
  return fetchCustomEndpointModels(baseUrl, apiKey, 5_000)
}

// Live model list for the chat picker, cached 60s per provider id so opening the
// dropdown doesn't hammer the server. Fails open — callers fall back to a manual
// model text input when this returns !ok.
const customModelCache = new Map<string, { at: number; result: CustomModelsResult }>()
const CUSTOM_MODEL_TTL_MS = 60_000

export async function listCustomEndpointModels(providerId: string, force = false): Promise<CustomModelsResult> {
  const ep = resolveCustomEndpoint(providerId)
  if (!ep) return { ok: false, models: [], error: 'Endpoint not found or disabled.' }
  const cached = customModelCache.get(providerId)
  if (!force && cached && Date.now() - cached.at < CUSTOM_MODEL_TTL_MS) return cached.result
  const key = retrieveKey(ep.keychainId) ?? undefined
  const result = await fetchCustomEndpointModels(ep.baseUrl, key, 5_000)
  // Only cache successes; a transient failure shouldn't poison the next open.
  if (result.ok) customModelCache.set(providerId, { at: Date.now(), result })
  return result
}

// Generic OpenAI-compat backends for the other gateways (Venice, Surplus) — built
// from the registry's baseUrl/keychainId so Fusion's runFusion can fan out over
// any of them. Cached per provider id.
const compatCache = new Map<string, OpenAiCompatBackend>()
function getCompatBackend(providerId: ProviderId): ResolvedChatBackend | null {
  const desc = getProvider(providerId)
  if (!desc?.baseUrl || !desc.keychainId) return null
  let be = compatCache.get(providerId)
  if (!be) {
    be = new OpenAiCompatBackend({ id: providerId, displayName: desc.label, baseUrl: desc.baseUrl })
    compatCache.set(providerId, be)
  }
  return { backend: be, key: retrieveKey(desc.keychainId), providerId }
}

/**
 * Map a model-discovery probe result to the existing HealthStatus shape so the
 * renderer can keep using `window.tachi.provider.testKey()` without protocol
 * changes. (Sprint A — A2 hookup.)
 */
function discoveryToHealth(r: DiscoveryResult): HealthStatus {
  if (r.ok) return { status: 'healthy' }
  switch (r.reason) {
    case 'unauthorized':
    case 'forbidden':
      return { status: 'reachable_auth_invalid' }
    case 'rate-limited':
      return { status: 'degraded', message: r.message }
    case 'http-error':
      return { status: 'degraded', message: r.message }
    case 'timeout':
    case 'network':
    case 'unknown-provider':
    default:
      return { status: 'unreachable' }
  }
}

/** What `getChatBackend` resolved a caller-supplied provider id into. */
export interface ResolvedChatBackend {
  backend: ChatBackend
  key: string | null
  /**
   * The CANONICAL registry id this backend actually is — not the string the
   * caller passed in. `getChatBackend` accepts the legacy short alias 'bankr'
   * and `ChatBackend.id` is itself a legacy short id ('bankr'), so neither the
   * argument nor the backend can be trusted as the provider's identity.
   *
   * Load-bearing for money (2026-08-01): the Fusion re-run path meters usage to
   * the cost ledger under this id. It used to record the literal 'tachi' — the
   * harness's own name, which is not a billing entity and matches nothing in the
   * ledger's registry-derived local/free check. Same defect class as
   * tachi/loop.ts before 64c837d; same fix — the resolver returns the identity
   * it already decided, and the ledger records that.
   */
  providerId: ProviderId
}

/** Returns the backend instance and API key for the given provider, or null if unknown. */
export function getChatBackend(providerId: string): ResolvedChatBackend | null {
  if ((providerId === 'bankr' || providerId === 'bankr-gateway')) {
    return { backend: bankr, key: retrieveKey('bankr-gateway'), providerId: 'bankr-gateway' }
  }
  // Venice + Surplus (and any future OpenAI-compat gateway) go through the
  // generic backend, sourced from the registry. Used by the Fusion forks.
  if (providerId === 'venice' || providerId === 'surplus') {
    return getCompatBackend(providerId)
  }
  // Custom OpenAI-compatible endpoints (`custom:<id>`, USER-PAINS T17) are NOT
  // routed here — they have a dedicated, keyless-tolerant branch in chat-service.
  return null
}

export async function listModels(providerId: string): Promise<ModelInfo[]> {
  if ((providerId === 'bankr' || providerId === 'bankr-gateway')) {
    const key = retrieveKey('bankr-gateway')
    if (!key) return []
    return bankr.listModels(key)
  }
  // imgnAI Katana: /v1/models answers keyless with a NON-OpenAI shape
  // ({text: [{public_model_name, display_name}]}) — parsed by imgnai-media.
  if (providerId === 'imgnai') {
    const { listImgnaiTextModels } = await import('./imgnai-media')
    const models = await listImgnaiTextModels()
    return models.map(m => ({ id: m.id, displayName: m.label }))
  }
  return []
}

export async function healthCheck(providerId: string): Promise<HealthStatus> {
  if ((providerId === 'bankr' || providerId === 'bankr-gateway')) {
    const key = retrieveKey('bankr-gateway')
    if (!key) return { status: 'reachable_auth_invalid' }
    return bankr.healthCheck(key)
  }
  return { status: 'unreachable' }
}

export async function testKey(providerId: string, key: string): Promise<HealthStatus> {
  // Keep the dedicated Bankr path — it talks to a richer endpoint than the
  // generic /v1/models probe (it returns usage/scope metadata).
  if ((providerId === 'bankr' || providerId === 'bankr-gateway')) {
    return bankr.healthCheck(key)
  }
  // A2: every other known provider routes through the generic OpenAI-shaped
  // /v1/models probe (model-discovery.ts). Treat an empty key as a query
  // against the public endpoint — useful for Ollama / freellmapi.
  if (knownProviderIds().includes(providerId)) {
    const r = await testProviderConnection(providerId, key || undefined)
    return discoveryToHealth(r)
  }
  return { status: 'unreachable' }
}

/**
 * Side-channel for surfaces (onboarding, future Settings card) that want the
 * raw probe payload — latency, parsed model list, machine-readable reason —
 * not the compressed HealthStatus enum.
 */
export async function probeConnection(providerId: string, key?: string): Promise<DiscoveryResult> {
  return testProviderConnection(providerId, key && key.length > 0 ? key : undefined)
}
