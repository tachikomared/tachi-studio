// apps/desktop/electron/services/agentkit-adapters.ts
//
// Provider adapters for Inngest agent-kit (@inngest/agent-kit + @inngest/ai).
//
// agent-kit's AiAdapter is a pure config object: it carries a URL, auth key,
// optional headers, an I/O format hint, and an `onCall` hook that mutates the
// outgoing request body just before the runtime fires it. The runtime (in
// @inngest/ai/model.ts) does the actual HTTP — these factories must NOT call
// fetch() themselves.
//
// We expose four factories that map TachiDesk's existing provider clients
// (Bankr LLM Gateway, Ollama, llama.cpp server, freellmapi-local) onto the
// AiAdapter shape so the future Nodes/Workflow runtime can drive them through
// agent-kit without duplicating the HTTP plumbing.
//
// Reference: @inngest/ai's `openai()` factory at
// node_modules/@inngest/ai/dist/models/openai.js — we mirror its pattern of
// URL construction (`new URL(path, baseUrl).href` with a forced trailing
// slash on baseUrl) and config-object return.

import type { AiAdapter } from '@inngest/ai'

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

export interface BankrAdapterOpts {
  /** Bankr catalog model id, e.g. 'claude-sonnet-4.6', 'gpt-5.2', 'gemini-3-pro'. */
  model:    string
  /** Bankr LLM gateway API key (bk_*). */
  apiKey:   string
  /** Override gateway base URL. Default: 'https://llm.bankr.bot/v1/'. */
  baseUrl?: string
}

export interface OllamaAdapterOpts {
  /** Ollama model tag, e.g. 'llama3.3:70b'. */
  model:    string
  /** Ollama base URL. Default: 'http://127.0.0.1:11434/v1/' (OpenAI-compat). */
  baseUrl?: string
}

export interface LlamaCppAdapterOpts {
  /** Model identifier reported by llama-server (or arbitrary label). */
  model:   string
  /**
   * User-supplied llama-server base URL. No default — llama.cpp users run
   * the server on whichever port they like and there's no canonical bind.
   * Typical value: 'http://127.0.0.1:8080/v1/'.
   */
  baseUrl: string
  /** Optional bearer token. llama-server is keyless by default. */
  apiKey?: string
}

export interface FreellmapiLocalAdapterOpts {
  /** Provider-qualified model id, e.g. 'mistralai/mistral-large-3-675b-instruct-2512'. */
  model:    string
  /** Override sidecar base URL. Default: 'http://127.0.0.1:31415/v1/'. */
  baseUrl?: string
  /** Sidecar API key (issued by freellmapi at startup). */
  apiKey?:  string
}

export interface OpenGatewayAdapterOpts {
  /** Catalog model id, e.g. 'mimo-v2.5-pro', 'claude-sonnet-4.6'. */
  model:    string
  /** OpenGateway API key (stored in the keychain under 'opengateway'). */
  apiKey:   string
  /** Override gateway base URL. Default: 'https://opengateway.gitlawb.com/v1/'. */
  baseUrl?: string
}

export interface SurplusAdapterOpts {
  /** Surplus catalog model id, e.g. 'claude-sonnet-4.5', 'gpt-5.4'. */
  model:    string
  /** Surplus buyer API key (inf_*), stored in the keychain under 'surplus'. */
  apiKey:   string
  /** Override base URL. Default: '.../api/inference/v1/' (NOTE: not bare /v1). */
  baseUrl?: string
}

export interface VeniceAdapterOpts {
  /** Venice catalog model id, e.g. 'zai-org-glm-4.7', 'llama-3.3-70b'. */
  model:    string
  /** Venice API key, stored in the keychain under 'venice'. */
  apiKey:   string
  /** Override base URL. Default: 'https://api.venice.ai/api/v1/'. */
  baseUrl?: string
}

export interface ImgnaiAdapterOpts {
  /** Katana catalog model id, e.g. 'glm-5-2', 'q-naifu-a3b'. */
  model:    string
  /** COMBINED credential "api_key:api_secret", stored under 'imgnai'. */
  apiKey:   string
  /** Override base URL. Default: 'https://kat.imgnai.com/v1/'. */
  baseUrl?: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Mirror @inngest/ai's URL-building convention: ensure baseUrl ends with `/`
 * so `new URL(path, baseUrl)` appends instead of replacing the trailing path
 * segment.
 */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL(path, base).href
}

/**
 * Shape required by the `AiAdapter["~types"]` slot. The field exists purely
 * for type inference inside agent-kit; runtime never reads it.
 */
const PHANTOM_TYPES = { input: {} as unknown, output: {} as unknown } as {
  input:  unknown
  output: unknown
}

// ---------------------------------------------------------------------------
// Bankr LLM Gateway
// ---------------------------------------------------------------------------

/**
 * Bankr LLM Gateway adapter.
 *
 * NOTE on format choice: Bankr's gateway is OpenAI-compatible across its
 * whole catalog (Claude, Gemini, GPT, Llama all routed through
 * `/v1/chat/completions` with `Authorization: Bearer bk_*`). The original
 * spec for this file suggested defaulting to `anthropic` format for Claude
 * coverage, but that would target `/v1/messages` which the gateway does not
 * expose. We use `openai-chat` to match the real endpoint shape — verified
 * against apps/desktop/electron/services/chat-service.ts (Bankr Gateway
 * branch) and apps/desktop/electron/services/bankr-service.ts.
 *
 * If Bankr later adds a native /v1/messages endpoint, add a sibling
 * `makeBankrAnthropicAdapter` that returns format `'anthropic'`.
 */
export function makeBankrAdapter(opts: BankrAdapterOpts): AiAdapter.Any {
  const baseUrl = opts.baseUrl || 'https://llm.bankr.bot/v1/'
  const url     = joinUrl(baseUrl, 'chat/completions')
  return {
    url,
    authKey: opts.apiKey || '',
    format:  'openai-chat',
    headers: { 'Accept-Encoding': 'identity' },
    onCall(_model, body) {
      const b = body as Record<string, unknown>
      if (b.model == null) b.model = opts.model
      // Anthropic (which Bankr routes Claude through) rejects the OpenAI-only
      // `parallel_tool_calls` param with a generic provider error.
      delete b.parallel_tool_calls
    },
    '~types': PHANTOM_TYPES,
    options:  opts,
  }
}

// ---------------------------------------------------------------------------
// Ollama (local)
// ---------------------------------------------------------------------------

/**
 * Ollama adapter. Ollama exposes an OpenAI-compatible endpoint under
 * `/v1/chat/completions` since 0.1.30, so we target that instead of the
 * native `/api/chat` shape — keeps agent-kit happy with `openai-chat`
 * format. Ollama is keyless, so `authKey` is empty.
 */
export function makeOllamaAdapter(opts: OllamaAdapterOpts): AiAdapter.Any {
  const baseUrl = opts.baseUrl || 'http://127.0.0.1:11434/v1/'
  const url     = joinUrl(baseUrl, 'chat/completions')
  return {
    url,
    authKey: '',
    format:  'openai-chat',
    headers: { 'Accept-Encoding': 'identity' },
    onCall(_model, body) {
      const b = body as Record<string, unknown>
      if (b.model == null) b.model = opts.model
    },
    '~types': PHANTOM_TYPES,
    options:  opts,
  }
}

// ---------------------------------------------------------------------------
// llama.cpp (llama-server)
// ---------------------------------------------------------------------------

/**
 * llama-server adapter. llama.cpp's bundled server speaks the OpenAI chat
 * completions shape. No default baseUrl because there's no canonical
 * llama-server bind — the user must supply one. apiKey is optional; the
 * server runs keyless unless launched with `--api-key`.
 */
export function makeLlamaCppAdapter(opts: LlamaCppAdapterOpts): AiAdapter.Any {
  const url = joinUrl(opts.baseUrl, 'chat/completions')
  return {
    url,
    authKey: opts.apiKey || '',
    format:  'openai-chat',
    headers: { 'Accept-Encoding': 'identity' },
    onCall(_model, body) {
      const b = body as Record<string, unknown>
      if (b.model == null) b.model = opts.model
    },
    '~types': PHANTOM_TYPES,
    options:  opts,
  }
}

// ---------------------------------------------------------------------------
// freellmapi (local sidecar)
// ---------------------------------------------------------------------------

/**
 * freellmapi-local adapter. The bundled freellmapi sidecar exposes an
 * OpenAI-compatible `/v1/chat/completions` on a port (default 31415) chosen
 * at startup — callers should resolve the actual port via
 * sidecar-manager.getFreellmapiPort() and pass it through `baseUrl`. The
 * sidecar issues a per-session API key; pass it via `apiKey`.
 */
export function makeFreellmapiAdapter(opts: FreellmapiLocalAdapterOpts): AiAdapter.Any {
  const baseUrl = opts.baseUrl || 'http://127.0.0.1:31415/v1/'
  const url     = joinUrl(baseUrl, 'chat/completions')
  return {
    url,
    authKey: opts.apiKey || '',
    format:  'openai-chat',
    headers: { 'Accept-Encoding': 'identity' },
    onCall(_model, body) {
      const b = body as Record<string, unknown>
      if (b.model == null) b.model = opts.model
    },
    '~types': PHANTOM_TYPES,
    options:  opts,
  }
}

// ---------------------------------------------------------------------------
// OpenGateway (gitlawb.com)
// ---------------------------------------------------------------------------

/**
 * OpenGateway adapter. OpenGateway exposes an OpenAI-compatible
 * `/v1/chat/completions` endpoint (verified against chat-service.ts's
 * opengateway branch, which POSTs there with `Authorization: Bearer <key>`).
 * The key is stored in the keychain under 'opengateway'.
 *
 * NOTE: the GitHub-Actions/aeon path uses OpenGateway as an
 * `ANTHROPIC_BASE_URL` for Claude Code, but the gateway itself is
 * OpenAI-compatible, so `openai-chat` is the correct format here.
 */
export function makeOpenGatewayAdapter(opts: OpenGatewayAdapterOpts): AiAdapter.Any {
  const baseUrl = opts.baseUrl || 'https://opengateway.gitlawb.com/v1/'
  const url     = joinUrl(baseUrl, 'chat/completions')
  return {
    url,
    authKey: opts.apiKey || '',
    format:  'openai-chat',
    headers: { 'Accept-Encoding': 'identity' },
    onCall(_model, body) {
      const b = body as Record<string, unknown>
      if (b.model == null) b.model = opts.model
      delete b.parallel_tool_calls
    },
    '~types': PHANTOM_TYPES,
    options:  opts,
  }
}

// ---------------------------------------------------------------------------
// Surplus Intelligence (surplusintelligence.ai)
// ---------------------------------------------------------------------------

/**
 * Surplus Intelligence adapter. Surplus is an OpenAI-compatible LLM marketplace
 * on Base — the canonical Bearer route (`/api/inference/v1/chat/completions`
 * with `Authorization: Bearer inf_*`) is a drop-in for the openai-chat format.
 * Models route to the cheapest seller; settlement is USDC on Base.
 *
 * NOTE: the base path is `/api/inference/v1`, NOT a bare `/v1`. `parallel_tool_calls`
 * is pass-through on the marketplace (not guaranteed per-seller), so we strip it
 * defensively — same as Bankr/OpenGateway, since Anthropic-backed sellers 400 on it.
 */
export function makeSurplusAdapter(opts: SurplusAdapterOpts): AiAdapter.Any {
  const baseUrl = opts.baseUrl || 'https://www.surplusintelligence.ai/api/inference/v1/'
  const url     = joinUrl(baseUrl, 'chat/completions')
  return {
    url,
    authKey: opts.apiKey || '',
    format:  'openai-chat',
    headers: { 'Accept-Encoding': 'identity' },
    onCall(_model, body) {
      const b = body as Record<string, unknown>
      if (b.model == null) b.model = opts.model
      delete b.parallel_tool_calls
    },
    '~types': PHANTOM_TYPES,
    options:  opts,
  }
}

// ---------------------------------------------------------------------------
// Venice (api.venice.ai)
// ---------------------------------------------------------------------------

/**
 * Venice adapter — privacy-first, OpenAI-compatible (`/api/v1/chat/completions`,
 * Bearer auth). Key stored in the keychain under 'venice'. parallel_tool_calls
 * is stripped defensively (some Venice-routed models reject the OpenAI param).
 */
export function makeVeniceAdapter(opts: VeniceAdapterOpts): AiAdapter.Any {
  const baseUrl = opts.baseUrl || 'https://api.venice.ai/api/v1/'
  const url     = joinUrl(baseUrl, 'chat/completions')
  return {
    url,
    authKey: opts.apiKey || '',
    format:  'openai-chat',
    headers: { 'Accept-Encoding': 'identity' },
    onCall(_model, body) {
      const b = body as Record<string, unknown>
      if (b.model == null) b.model = opts.model
      delete b.parallel_tool_calls
    },
    '~types': PHANTOM_TYPES,
    options:  opts,
  }
}

// ---------------------------------------------------------------------------
// imgnAI Katana (kat.imgnai.com)
// ---------------------------------------------------------------------------

/**
 * imgnAI Katana adapter — OpenAI-compatible (`/v1/chat/completions`). The
 * bearer is the COMBINED "api_key:api_secret" credential (keychain 'imgnai');
 * the gateway splits it server-side. parallel_tool_calls stripped defensively
 * (mixed upstream models behind one gateway).
 */
export function makeImgnaiAdapter(opts: ImgnaiAdapterOpts): AiAdapter.Any {
  const baseUrl = opts.baseUrl || 'https://kat.imgnai.com/v1/'
  const url     = joinUrl(baseUrl, 'chat/completions')
  return {
    url,
    authKey: opts.apiKey || '',
    format:  'openai-chat',
    headers: { 'Accept-Encoding': 'identity' },
    onCall(_model, body) {
      const b = body as Record<string, unknown>
      if (b.model == null) b.model = opts.model
      delete b.parallel_tool_calls
    },
    '~types': PHANTOM_TYPES,
    options:  opts,
  }
}

// ---------------------------------------------------------------------------
// Convenience dispatcher
// ---------------------------------------------------------------------------

/**
 * TachiDesk provider ids supported by this adapter layer. Kept narrow on
 * purpose — provider ids that don't yet have an agent-kit adapter (e.g.
 * `bankr-oauth`, MCP-only providers) return null from `makeAdapterFor`.
 */
export type AgentKitProviderId =
  | 'bankr'
  | 'ollama'
  | 'llamacpp'
  | 'freellmapi-local'
  | 'opengateway'
  | 'surplus'
  | 'venice'
  | 'imgnai'

/**
 * Build an adapter from a TachiDesk-style ProviderId + loose options dict.
 * Returns null if the provider isn't supported by agent-kit yet, or if the
 * options dict is missing required fields for the requested provider
 * (`model` for all, `apiKey` for Bankr, `baseUrl` for llama.cpp).
 *
 * Callers should treat null as "fall back to the legacy chat-service code
 * path" rather than as a hard error.
 */
export function makeAdapterFor(
  provider: AgentKitProviderId,
  opts:     Record<string, unknown>,
): AiAdapter.Any | null {
  const model    = typeof opts.model    === 'string' ? opts.model    : ''
  const baseUrl  = typeof opts.baseUrl  === 'string' ? opts.baseUrl  : undefined
  const apiKey   = typeof opts.apiKey   === 'string' ? opts.apiKey   : undefined

  if (!model) return null

  switch (provider) {
    case 'bankr':
      if (!apiKey) return null
      return makeBankrAdapter({ model, apiKey, baseUrl })

    case 'ollama':
      return makeOllamaAdapter({ model, baseUrl })

    case 'llamacpp':
      if (!baseUrl) return null
      return makeLlamaCppAdapter({ model, baseUrl, apiKey })

    case 'freellmapi-local':
      return makeFreellmapiAdapter({ model, baseUrl, apiKey })

    case 'opengateway':
      if (!apiKey) return null
      return makeOpenGatewayAdapter({ model, apiKey, baseUrl })

    case 'surplus':
      if (!apiKey) return null
      return makeSurplusAdapter({ model, apiKey, baseUrl })

    case 'venice':
      if (!apiKey) return null
      return makeVeniceAdapter({ model, apiKey, baseUrl })

    case 'imgnai':
      if (!apiKey) return null
      return makeImgnaiAdapter({ model, apiKey, baseUrl })

    default: {
      // Exhaustiveness guard — unreachable as long as the union stays in sync.
      const _exhaustive: never = provider
      void _exhaustive
      return null
    }
  }
}
