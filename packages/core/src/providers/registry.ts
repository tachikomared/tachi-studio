// packages/core/src/providers/registry.ts
//
// THE single source of truth for "which inference providers exist and what
// are their properties". Chat, the Agents/Code tab, and the Nodes editor all
// derive their provider + model pickers from this table, so a provider added
// here appears EVERYWHERE, and a new OpenAI-compatible provider (e.g. Venice)
// is a single entry instead of a six-file shotgun edit.
//
// PURE DATA + PURE FUNCTIONS ONLY. No node:* imports, no I/O, no keychain.
// This file is imported by the RENDERER via the subpath
// `@tachi/core/src/providers/registry` (bypassing the Node-only core barrel —
// see commit 6f6172f) and by the MAIN process via `@tachi/core`. Keep it
// dependency-free so the browser bundle stays clean.
//
// ID VOCABULARY (canonical): we standardise on the chat/keychain ids — e.g.
// `bankr-gateway`, `surplus`, `ollama-local`, `anthropic-oauth`. The Nodes
// surface historically used short ids (`bankr`, `ollama`, `llamacpp`); those
// are migrated onto these canonical ids. `keychainId` is the id under which
// the secret is stored and may differ from the provider id (e.g. OAuth).

/** Canonical provider id — the ONE vocabulary used across chat, agents, nodes. */
export type ProviderId =
  | 'ollama-local'
  | 'llama-cpp'
  | 'freellmapi-local'
  | 'free-claude-code'
  | 'opengateway'
  | 'bankr-gateway'
  | 'surplus'
  | 'anthropic-oauth'
  | 'openrouter-oauth'
  | 'venice'
  | 'imgnai'

/**
 * UI GROUPING ONLY — "is there a process on this machine at all". It answers a
 * plumbing question, never a privacy one, and MUST NOT drive a locality badge:
 * freellmapi-local is tier 'local' and sends every prompt to the internet. Use
 * `providerLocality()` below for anything the user reads as a claim.
 */
export type ProviderTier = 'local' | 'cloud'

/**
 * Private-mode (egress) classification. Distinct from `tier`: the freellmapi
 * and free-claude-code sidecars run on localhost but PROXY to cloud endpoints,
 * so their egress is 'cloud' even though their tier is 'local'. Only providers
 * with egress 'local' are permitted in PRIVATE MODE.
 */
export type EgressClass = 'local' | 'cloud'

export type AuthKind = 'none' | 'api_key' | 'oauth_pkce' | 'oauth_device' | 'sidecar'

/**
 * PRICE, not privacy — deliberately a SEPARATE fact from `egress`.
 *
 *   'free' — using it costs the user nothing whatever model it resolves to:
 *            their own hardware, or a keyless free tier / free-router sidecar.
 *   'paid' — the user pays, per token or via a subscription/credit balance.
 *            The safe default: a provider is only 'free' when we know it.
 *
 * These two facts used to be conflated in a hand-maintained id list
 * (run-cost.ts::FREE_REMOTE_IDS = "free AND remote"), which is exactly how a
 * new provider gets silently mislabelled: whoever adds it must remember an
 * unrelated file. `egress` answers "does the prompt leave", `billing` answers
 * "does it cost", and a surface that wants "$0 but the prompt still left" now
 * asks both instead of asking a list.
 */
export type ProviderBilling = 'free' | 'paid'

/** Coarse, provider-level capability. Per-model capabilities live on UnifiedModel. */
export type ModelCapability =
  | 'text' | 'vision' | 'tools' | 'image' | 'tts' | 'stt' | 'video' | 'embedding'

export interface ProviderDescriptor {
  id: ProviderId
  label: string
  tier: ProviderTier
  egress: EgressClass
  /** Does using it cost money? REQUIRED so a new provider cannot omit the fact. */
  billing: ProviderBilling
  auth: AuthKind
  /**
   * Keychain id holding the credential. Undefined for local/no-auth providers.
   * For OAuth providers this is the access-token key. Doubles as the picker's
   * `requiresKey` gate.
   */
  keychainId?: string
  /**
   * True → speaks the OpenAI `/chat/completions` + `/models` contract, so it
   * can run through the generic chat path and a generic model-list fetch.
   */
  openaiCompatible: boolean
  /**
   * OpenAI-style API base WITHOUT a trailing slash and WITHOUT the endpoint:
   * append `/chat/completions` or `/models`. Set only for fixed cloud
   * endpoints; local/sidecar providers resolve their base (dynamic port) at
   * runtime in the main process, so this is undefined for them.
   */
  baseUrl?: string
  /** Default model id to send when the provider is picked with no explicit model. */
  defaultModel?: string
  capabilities: ModelCapability[]
  /** One-line hint shown under the provider in the picker. */
  hint?: string
}

/**
 * Unified, renderer-safe model shape. Collapses the previously-divergent
 * BankrModel / SurplusModel / ModelInfo shapes into one. Provider services map
 * their live `/models` responses into this; the pickers render it uniformly.
 */
export interface UnifiedModel {
  id: string
  providerId: ProviderId
  label: string
  family?: string
  contextTokens?: number
  capabilities?: ModelCapability[]
  pricing?: { inUsdPerMTok?: number; outUsdPerMTok?: number }
  /** Came from a live API call (vs a static fallback list). */
  live?: boolean
  isDefault?: boolean
}

// ── The registry ─────────────────────────────────────────────────────────────
// Ordered to match the historical chat ProviderPicker order so the migration is
// behaviour-preserving.

export const PROVIDER_LIST: readonly ProviderDescriptor[] = [
  {
    id: 'ollama-local',
    label: 'Ollama (local)',
    tier: 'local',
    egress: 'local',
    billing: 'free',  // your own hardware
    auth: 'none',
    openaiCompatible: false, // native /api/chat + /api/tags
    defaultModel: 'auto',
    capabilities: ['text', 'tools', 'vision'],
    hint: '100% local · uses your pulled models on :11434',
  },
  {
    id: 'freellmapi-local',
    label: 'FreeLLM (local router)',
    tier: 'local',
    egress: 'cloud', // localhost sidecar that PROXIES to cloud providers
    billing: 'free',  // keyless: the sidecar fans out to free upstreams
    auth: 'sidecar',
    openaiCompatible: true,
    defaultModel: 'auto',
    capabilities: ['text', 'tools'],
    // THE DISCLOSURE LIVES HERE, and this is the only place it can live.
    //
    // Kilo Gateway used to be a standalone provider with its own Settings card
    // and its own picker hint, both of which said that its free rows may train
    // on your prompts (every one self-reports `mayTrainOnYourPrompts: true` in
    // Kilo's public catalog). Kilo is now an UPSTREAM INSIDE this router, near
    // the head of its failover chain — so a user who picks "the free router"
    // can be served by Kilo without ever having seen that card. The fact had to
    // move with the traffic, or the refactor would have made the app quieter
    // about the same risk. Repeated in the Free Providers card and, in eight
    // languages, in the freellmapi namespace's `disclosure` block.
    hint: 'Free upstreams via local sidecar · some may train on your prompts',
  },
  {
    id: 'free-claude-code',
    label: 'free-claude-code',
    tier: 'local',
    egress: 'cloud', // proxies to Anthropic
    billing: 'free',  // keyless proxy to free upstreams
    auth: 'sidecar',
    openaiCompatible: false, // Anthropic Messages shape
    defaultModel: 'claude-3-5-sonnet-20241022',
    capabilities: ['text', 'tools'],
    hint: 'Anthropic Messages proxy',
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp (local)',
    tier: 'local',
    egress: 'local',
    billing: 'free',  // your own hardware
    auth: 'none',
    openaiCompatible: true, // llama-server exposes an OpenAI-compatible endpoint
    defaultModel: 'auto',
    capabilities: ['text'],
    hint: 'Truly local — pick a downloaded model in the model dropdown →',
  },
  {
    id: 'opengateway',
    label: 'OpenGateway',
    tier: 'cloud',
    egress: 'cloud',
    billing: 'paid',
    auth: 'api_key',
    keychainId: 'opengateway',
    openaiCompatible: true,
    baseUrl: 'https://opengateway.gitlawb.com/v1',
    // 2026-07-16: gateway went pay-as-you-go — MiMo is PAID.
    // 2026-08-01: tencent/hy3 has ALSO gone paid ($0.24/M in · $0.96/M out,
    // promo: null per the keyless catalog) — it merely keeps a legacy
    // `tencent/hy3:free` ALIAS, which is a name, not a price. nemotron-3-ultra
    // is the only unconditionally-free model left. Ids must be the FULL
    // provider/model form; 'auto' = gateway-side smart routing.
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    capabilities: ['text', 'tools'],
    hint: 'gitlawb gateway — free: nemotron-3-ultra; hy3/MiMo/Gemini/Qwen/GLM pay-as-you-go',
  },
  {
    id: 'bankr-gateway',
    label: 'Bankr Gateway',
    tier: 'cloud',
    egress: 'cloud',
    billing: 'paid',
    auth: 'api_key',
    keychainId: 'bankr-gateway',
    openaiCompatible: true,
    baseUrl: 'https://llm.bankr.bot/v1',
    defaultModel: 'claude-sonnet-4.6',
    capabilities: ['text', 'vision', 'tools'],
    hint: 'Claude / Gemini / GPT / Llama via docs.bankr.bot',
  },
  {
    id: 'surplus',
    label: 'Surplus Intelligence',
    tier: 'cloud',
    egress: 'cloud',
    billing: 'paid',
    auth: 'api_key',
    keychainId: 'surplus',
    openaiCompatible: true,
    // NOTE: base already includes /api/inference/v1 (NOT a bare /v1).
    baseUrl: 'https://www.surplusintelligence.ai/api/inference/v1',
    defaultModel: 'claude-sonnet-4.5',
    capabilities: ['text', 'vision', 'tools'],
    hint: 'Cheapest-seller routing · USDC on Base (surplusintelligence.ai)',
  },
  {
    id: 'anthropic-oauth',
    label: 'Anthropic (Pro/Max OAuth)',
    tier: 'cloud',
    egress: 'cloud',
    billing: 'paid',
    auth: 'oauth_pkce',
    keychainId: 'anthropic-oauth-access',
    openaiCompatible: false, // Anthropic Messages API
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-5-sonnet-20241022',
    capabilities: ['text', 'vision', 'tools'],
    hint: 'Sign-in required',
  },
  {
    id: 'openrouter-oauth',
    label: 'OpenRouter (OAuth)',
    tier: 'cloud',
    egress: 'cloud',
    billing: 'paid',
    auth: 'oauth_pkce',
    keychainId: 'openrouter-oauth',
    openaiCompatible: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
    capabilities: ['text', 'vision', 'tools'],
    hint: 'Sign-in required',
  },
  {
    id: 'venice',
    label: 'Venice',
    tier: 'cloud',
    egress: 'cloud',
    billing: 'paid',
    auth: 'api_key',
    keychainId: 'venice',
    openaiCompatible: true,
    baseUrl: 'https://api.venice.ai/api/v1',
    defaultModel: 'zai-org-glm-4.7',
    capabilities: ['text', 'vision', 'tools', 'image', 'embedding'],
    hint: 'Privacy-first · uncensored models, web search, image gen (venice.ai)',
  },
  {
    id: 'imgnai',
    label: 'imgnAI Katana',
    tier: 'cloud',
    egress: 'cloud',
    billing: 'paid',
    auth: 'api_key',
    keychainId: 'imgnai',
    openaiCompatible: true,
    // Text is OpenAI-compatible with a COMBINED bearer: "api_key:api_secret"
    // (one keychain entry). Image/video use X-API-Key/X-API-Secret headers —
    // the imgnai-media service splits the same stored credential.
    baseUrl: 'https://kat.imgnai.com/v1',
    defaultModel: 'glm-5-2',
    capabilities: ['text', 'vision', 'tools', 'image', 'video'],
    hint: 'Text + image + video gateway · key at app.imgnai.com/katana-api (paste as api_key:api_secret)',
  },
]

const BY_ID: Record<string, ProviderDescriptor> =
  Object.fromEntries(PROVIDER_LIST.map(p => [p.id, p]))

/** All provider descriptors, in display order. */
export function listProviders(): readonly ProviderDescriptor[] {
  return PROVIDER_LIST
}

/** Lookup a descriptor by id; undefined for unknown/non-canonical ids. */
export function getProvider(id: string | null | undefined): ProviderDescriptor | undefined {
  return id ? BY_ID[id] : undefined
}

/** Type guard for a canonical provider id. */
export function isProviderId(id: string | null | undefined): id is ProviderId {
  return !!id && id in BY_ID
}

/** Provider ids whose egress is truly local (permitted in PRIVATE MODE). */
export function localProviderIds(): ProviderId[] {
  return PROVIDER_LIST.filter(p => p.egress === 'local').map(p => p.id)
}

/** Provider ids whose egress reaches the public internet (blocked in PRIVATE MODE). */
export function cloudProviderIds(): ProviderId[] {
  return PROVIDER_LIST.filter(p => p.egress === 'cloud').map(p => p.id)
}

// ── Locality: the ONE derivation any user-visible locality claim may use ──────

/**
 * What a badge / label / heading is ALLOWED to tell the user about where their
 * prompt goes. Derived from `egress` — never from `tier`, the label, the id
 * suffix, or a hand-maintained list.
 *
 *   'local' — served on this machine; the prompt never leaves it.
 *   'relay' — a process on THIS machine serves the request and forwards the
 *             prompt to a cloud provider (freellmapi-local, free-claude-code).
 *             Privacy-identical to 'cloud'; only the plumbing is local, so it
 *             must never be coloured or worded like 'local'.
 *   'cloud' — the prompt goes straight to a remote API.
 *
 * Why this exists: 64c837d fixed "$0 (local)" being printed over a cloud call
 * because in a local-first app "local" is read as "my data never left this
 * machine" — a claim about privacy, not a price. The same sentence survived as
 * a green LOCAL chip in the chat provider picker, which was driven by `tier`.
 * Unknown ids resolve to 'cloud': never claim locality about something we
 * cannot look up.
 */
export type ProviderLocality = 'local' | 'relay' | 'cloud'

/** Locality of a descriptor-shaped value (also covers non-registry endpoints). */
export function localityOf(p: Pick<ProviderDescriptor, 'tier' | 'egress'> | null | undefined): ProviderLocality {
  if (!p) return 'cloud'
  if (p.egress === 'local') return 'local'
  // egress is cloud from here on — tier may only pick the WORDING, never the claim.
  return p.tier === 'local' ? 'relay' : 'cloud'
}

/** Locality of a canonical provider id. Unknown id → 'cloud' (claim nothing). */
export function providerLocality(id: string | null | undefined): ProviderLocality {
  return localityOf(getProvider(id))
}

/**
 * Does this provider cost the user money? Unknown id → 'paid', the same
 * claim-nothing default `providerLocality` uses: "free" is a promise too, and
 * an id we cannot look up earns neither promise.
 *
 * Deliberately independent of locality — ask BOTH when a surface needs "$0, and
 * the prompt still left this machine" (see run-cost.ts).
 */
export function providerBilling(id: string | null | undefined): ProviderBilling {
  return getProvider(id)?.billing ?? 'paid'
}
