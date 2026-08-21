// apps/desktop/electron/services/nook-service.ts
//
// First-class nookplot integration, main-process side.
//
// This wraps @nookplot/runtime (the "managed via gateway" SDK — 35 managers,
// WebSocket events, autonomous agent) in a single long-lived instance owned by
// the main process. The renderer drives it entirely through nook.ipc.ts; the
// renderer never touches the gateway or the agent's private key directly.
//
// WHY MAIN-PROCESS + LAZY IMPORT:
//   - @nookplot/runtime is ESM and pulls @nookplot/mcp (native build scripts).
//     electron-vite externalizes deps, so we `await import()` it at connect
//     time — it's require()'d from node_modules at runtime, never bundled.
//   - The agent private key is read from the encrypted OS keychain here and
//     handed only to the runtime for LOCAL EIP-712 signing. It is never sent to
//     the gateway and never crosses the IPC boundary back to the renderer.
//
// Non-custodial + privacy: connecting reaches gateway.nookplot.com (cloud), so
// connect() is gated by the same egress policy as every other outbound call.

import { BrowserWindow } from 'electron'
import { storeKey, retrieveKey, hasKey, deleteKey } from './keychain'
import { checkUrlEgress } from './egress-policy'

// Types only — no runtime import at module load (keeps startup cheap and avoids
// pulling the ESM package into the main bundle).
import type { NookplotRuntime, AutonomousAgent, RuntimeEvent } from '@nookplot/runtime'

const GATEWAY_URL = 'https://gateway.nookplot.com'

// Keychain ids for the two secrets this feature owns.
const KEY_API  = 'nook-api-key'
const KEY_PK   = 'nook-private-key'

// ── Token decode tables ─────────────────────────────────────────────────────
// The gateway returns rewardAmount as a base-unit string and tokenAddress as a
// raw address. We decode to a human symbol + display amount so the renderer
// never hand-parses wei.
export const TOKENS: Record<string, { symbol: string; decimals: number }> = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC',    decimals: 6  },
  '0xb233bdffd437e60fa451f62c6c09d3804d285ba3': { symbol: 'NOOK',    decimals: 18 },
  '0xa601877977340862ca67f816eb079958e5bd0ba3': { symbol: 'BOTCOIN', decimals: 18 },
}

const BOUNTY_STATUS: Record<number, string> = {
  0: 'open', 1: 'claimed', 2: 'submitted', 3: 'approved',
  4: 'disputed', 5: 'cancelled', 6: 'expired', 7: 'dispute_expired',
}

/** Format a base-unit string to a trimmed decimal string (no BigInt loss). */
export function formatUnits(amount: string, decimals: number): string {
  try {
    const neg = amount.startsWith('-')
    const raw = (neg ? amount.slice(1) : amount).padStart(decimals + 1, '0')
    const whole = raw.slice(0, raw.length - decimals) || '0'
    const frac = decimals > 0 ? raw.slice(raw.length - decimals).replace(/0+$/, '') : ''
    return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole)
  } catch { return amount }
}

export interface NookBountyView {
  id: string
  title: string
  description: string
  community: string
  rewardDisplay: string      // e.g. "250 NOOK"
  rewardToken: string        // symbol
  status: string             // label
  statusCode: number
  deadline: number           // unix seconds
  applicationCount: number
  claimer: string | null
  raw: Record<string, unknown>
}

export interface NookStatus {
  connected:     boolean
  connecting:    boolean
  online:        boolean   // autonomous agent running
  address:       string | null
  name:          string | null
  credits:       number | null
  reputation:    number | null
  hasApiKey:     boolean
  hasPrivateKey: boolean
  /** Whether this wallet has an on-chain agent registration. null = unknown/not-checked. */
  registered:    boolean | null
  error:         string | null
}

export interface NookWalletInfo {
  address:    string
  privateKey: string
  mnemonic?:  string
}

// ── Module state ────────────────────────────────────────────────────────────
let runtime:   NookplotRuntime | null = null
let autonomous: AutonomousAgent | null = null
let connecting = false
let connectError: string | null = null
let profileCache: { address: string | null; name: string | null; reputation: number | null } = {
  address: null, name: null, reputation: null,
}
let creditsCache: number | null = null
let registeredCache: boolean | null = null

/**
 * Mint a gateway session key from a private key via /v1/auth/wallet-session —
 * the exact flow @nookplot/runtime uses internally (sign the canonical
 * "Sign in to Nookplot" message, POST, read the nk_ key from Set-Cookie).
 * We sign via @nookplot/sdk's wallet helper because bare `ethers` is not
 * directly resolvable from this app's node_modules (it's nested under the SDK).
 *
 * Returns { key } for a registered wallet, or { registered:false } for a wallet
 * that has no on-chain agent yet (the gateway issues no cookie in that case).
 */
async function mintSessionKey(privateKey: string): Promise<{ key?: string; registered: boolean; address?: string }> {
  try {
    const sdk = await import('@nookplot/sdk')
    const wallet = sdk.walletFromPrivateKey(privateKey)
    const address = wallet.address
    const timestamp = Date.now()
    const signature = await wallet.signMessage(`Sign in to Nookplot\n\nTimestamp: ${timestamp}`)
    const res = await fetch(`${GATEWAY_URL}/v1/auth/wallet-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, signature, timestamp }),
      signal: AbortSignal.timeout(15_000) as AbortSignal,
    })
    if (!res.ok) return { registered: false, address }
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) {
      const m = setCookie.match(/(?:^|;\s*)([^=;\s]+)=([^;]+)/)
      const key = m?.[2]
      if (key && key.startsWith('nk_')) return { key, registered: true, address }
    }
    // No cookie → not registered. The body confirms ({authenticated, registered}).
    try {
      const body = await res.json() as { registered?: boolean }
      return { registered: Boolean(body.registered), address }
    } catch { return { registered: false, address } }
  } catch (e) {
    console.error('[nook] wallet-session mint failed:', e)
    return { registered: false }
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

function snapshot(): NookStatus {
  return {
    connected:     runtime != null && !connecting,
    connecting,
    online:        autonomous != null,
    address:       profileCache.address,
    name:          profileCache.name,
    credits:       creditsCache,
    reputation:    profileCache.reputation,
    hasApiKey:     hasKey(KEY_API),
    hasPrivateKey: hasKey(KEY_PK),
    registered:    registeredCache,
    error:         connectError,
  }
}

function pushStatus(): void { broadcast('nook:status', snapshot()) }

// ── Public API (called from nook.ipc.ts) ──────────────────────────────────────

export function getStatus(): NookStatus { return snapshot() }

/** Persist credentials to the encrypted keychain. Does not connect. */
export function configure(input: { apiKey?: string; privateKey?: string }): NookStatus {
  if (typeof input.apiKey === 'string') {
    const v = input.apiKey.trim()
    if (v) storeKey(KEY_API, v); else deleteKey(KEY_API)
  }
  if (typeof input.privateKey === 'string') {
    const v = input.privateKey.trim()
    if (v) storeKey(KEY_PK, v); else deleteKey(KEY_PK)
  }
  return snapshot()
}

/** Forget credentials and disconnect. */
export async function clearCredentials(): Promise<NookStatus> {
  await disconnect()
  deleteKey(KEY_API)
  deleteKey(KEY_PK)
  profileCache = { address: null, name: null, reputation: null }
  creditsCache = null
  registeredCache = null
  connectError = null
  return snapshot()
}

/**
 * Instantiate the runtime, open the WebSocket, fetch profile + credits, and
 * wire the live event feed. Idempotent: a second call while connected is a
 * no-op that just returns the current snapshot.
 */
export async function connect(): Promise<NookStatus> {
  if (runtime || connecting) return snapshot()

  // Privacy gate — nookplot is a cloud service.
  const egress = checkUrlEgress(GATEWAY_URL)
  if (!egress.allowed) { connectError = egress.reason ?? 'blocked by privacy mode'; return snapshot() }

  // A private key alone is enough: the runtime's auto-reauth signs a
  // /v1/auth/wallet-session challenge and mints a session key on first 401.
  // An API key, if present, is used directly (faster first call).
  let apiKey = retrieveKey(KEY_API) ?? ''
  const privateKey = retrieveKey(KEY_PK) ?? undefined
  if (!apiKey && !privateKey) {
    connectError = 'No credentials configured — generate or import an agent key first.'
    return snapshot()
  }

  connecting = true
  connectError = null
  pushStatus()

  try {
    // The runtime constructor REQUIRES a non-empty apiKey. If we only have a
    // private key, mint a session key first via /v1/auth/wallet-session (the
    // same flow the runtime uses internally for auto-reauth). This only works
    // for ALREADY-REGISTERED wallets — a brand-new wallet returns
    // {registered:false} with no cookie, which we surface cleanly (no retry loop).
    if (!apiKey && privateKey) {
      const minted = await mintSessionKey(privateKey)
      registeredCache = minted.registered
      if (minted.address) profileCache.address = minted.address
      if (minted.key) {
        apiKey = minted.key
        storeKey(KEY_API, minted.key)
      } else {
        connecting = false
        connectError = 'This wallet has no on-chain agent yet. Complete the one-time gasless registration on nookplot.com, then reconnect.'
        pushStatus()
        return snapshot()
      }
    }
    console.log(`[nook] connecting… apiKey=${apiKey ? 'set' : 'empty'} privateKey=${privateKey ? 'set' : 'none'}`)
    const { NookplotRuntime } = await import('@nookplot/runtime')
    const rt = new NookplotRuntime({ gatewayUrl: GATEWAY_URL, apiKey, privateKey })
    await rt.connect()
    console.log('[nook] connected; address=', rt.identity.getAddress())
    runtime = rt

    // Live event feed → renderer.
    try {
      rt.events.subscribeAll((evt: RuntimeEvent) => {
        broadcast('nook:event', { type: evt.type, data: evt.data, at: Date.now() })
      })
    } catch { /* event stream optional */ }

    profileCache.address = rt.identity.getAddress()
    await refreshProfile()
    await refreshCredits()
    await refreshRegistered()
    connecting = false
    pushStatus()
    return snapshot()
  } catch (err) {
    connecting = false
    connectError = err instanceof Error ? err.message : String(err)
    console.error('[nook] connect failed:', err)
    runtime = null
    pushStatus()
    return snapshot()
  }
}

export async function disconnect(): Promise<NookStatus> {
  try { autonomous?.stop() } catch { /* ignore */ }
  autonomous = null
  const rt = runtime
  runtime = null
  if (rt) { try { await rt.disconnect() } catch { /* ignore */ } }
  connecting = false
  pushStatus()
  return snapshot()
}

async function refreshProfile(): Promise<void> {
  if (!runtime) return
  try {
    // AgentInfo = { id, address, displayName, description, didCid, status, createdAt }.
    // It carries no reputation field (reputation is served by a separate engine),
    // so we only pull name + address here.
    const p = await runtime.identity.getProfile()
    profileCache.name = p.displayName ?? null
    if (p.address) profileCache.address = p.address
  } catch { /* profile may 404 for unregistered agents */ }
}

async function refreshCredits(): Promise<void> {
  if (!runtime) return
  try {
    // BalanceInfo = { credits: { available, spent, dailySpent, dailyLimit, ... },
    //                 revenue: { claimable, totalEarned } }.
    const b = await runtime.economy.getBalance()
    creditsCache = b.credits?.available ?? null
  } catch { creditsCache = null }
}

/** Check whether this wallet has an on-chain agent registration. */
async function refreshRegistered(): Promise<void> {
  const addr = profileCache.address
  if (!addr) { registeredCache = null; return }
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/auth/wallet-check/${addr}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) as AbortSignal,
    })
    if (!res.ok) { registeredCache = null; return }
    const body = await res.json() as Record<string, unknown>
    // wallet-check returns { exists, onChain }. `exists` is true even for a
    // brand-new wallet that has an off-chain record but NO on-chain agent — only
    // `onChain` means truly registered. (Reading `exists` falsely marked new
    // wallets as registered and skipped the registration step.)
    registeredCache = Boolean(body.onChain ?? body.registered ?? body.isRegistered)
  } catch { registeredCache = null }
}

/**
 * Generate a brand-new agent wallet and persist its private key to the OS
 * keychain. Returns the key material ONCE so the renderer can show a one-time
 * backup. The caller is responsible for warning the user to save it.
 */
export async function generateWallet(): Promise<NookWalletInfo> {
  // Use ethers' HD wallet so the backup screen can show a real 12-word recovery
  // phrase (the @nookplot/sdk generator returns only a raw hex key). Same
  // keychain id as the global wallet — the wallet IS the nook agent.
  const { Wallet } = await import('ethers')
  const w = Wallet.createRandom()
  storeKey(KEY_PK, w.privateKey)
  registeredCache = false   // brand-new wallet is definitely unregistered
  pushStatus()
  return { address: w.address, privateKey: w.privateKey, mnemonic: w.mnemonic?.phrase }
}

/**
 * Register this wallet as an on-chain agent (gasless: the gateway builds the
 * DID doc, pins it to IPFS, prepares the tx; the runtime signs locally with the
 * private key and the gateway relays it). Returns the updated status. The
 * registration call also yields a session apiKey, which we persist so future
 * connects are fast.
 */
export async function register(input: { name?: string; description?: string }): Promise<NookStatus> {
  if (!runtime) { await connect() }
  if (!runtime) throw new Error('Could not connect to nookplot to register.')
  if (!hasKey(KEY_PK)) throw new Error('Registration is on-chain — an agent key is required.')
  const res = await runtime.identity.register({ name: input.name, description: input.description })
  if (res.apiKey) storeKey(KEY_API, res.apiKey)
  registeredCache = true
  await refreshProfile()
  await refreshCredits()
  pushStatus()
  return snapshot()
}

/**
 * In-app, two-step, non-custodial, GASLESS agent registration — works for a
 * brand-new wallet that only has a private key in the keychain (no prior
 * session/runtime), so the user never has to leave for nookplot.com.
 *
 *   1) Sign the canonical ownership message and POST /v1/agents (NO auth) → the
 *      gateway returns a one-time { apiKey: "nk_..." } which we persist.
 *   2) prepare → sign → relay POST /v1/prepare/register (Bearer apiKey) to put
 *      the agent on-chain. We reuse @nookplot/runtime's prepareSignRelay so the
 *      relay body shape (flat) + per-agent nonce serialization + retry match the
 *      live gateway exactly.
 *   3) Mark registered and bring up the full connected runtime via connect().
 *
 * The private key signs locally (via @nookplot/sdk's wallet) and is never sent.
 */
export async function registerInApp(input: {
  name: string
  description?: string
  model?: { provider: string; name: string }
  capabilities?: string[]
}): Promise<NookStatus> {
  const egress = checkUrlEgress(GATEWAY_URL)
  if (!egress.allowed) throw new Error(egress.reason ?? 'Registration blocked by privacy mode.')

  const privateKey = retrieveKey(KEY_PK)
  if (!privateKey) throw new Error('Registration is on-chain — generate or import an agent key first.')
  if (!input.name?.trim()) throw new Error('An agent name is required to register.')

  const sdk = await import('@nookplot/sdk')
  const wallet = sdk.walletFromPrivateKey(privateKey)
  const address = wallet.address

  // ── Step 1: create the agent + obtain the one-time API key (NO auth header) ──
  const ownershipSig = await wallet.signMessage('I am registering this address with the Nookplot Agent Gateway')
  const createRes = await fetch(`${GATEWAY_URL}/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      signature: ownershipSig,
      name: input.name.trim(),
      description: input.description ?? '',
      ...(input.model ? { model: input.model } : {}),
      ...(input.capabilities?.length ? { capabilities: input.capabilities } : {}),
    }),
    signal: AbortSignal.timeout(20_000) as AbortSignal,
  })
  let apiKey: string | undefined
  if (createRes.ok) {
    const created = await createRes.json() as { apiKey?: string; address?: string }
    if (!created.apiKey || !created.apiKey.startsWith('nk_')) throw new Error('Registration did not return an API key.')
    apiKey = created.apiKey
    storeKey(KEY_API, apiKey)
    profileCache.address = created.address ?? address
  } else if (createRes.status === 409) {
    // Agent already exists off-chain (e.g. a prior attempt created it but the
    // on-chain relay didn't finish) — resume Step 2 with the stored API key.
    apiKey = retrieveKey(KEY_API) ?? undefined
    if (!apiKey) throw new Error('This wallet already has a nookplot agent, but its API key isn\'t stored on this machine. Use "Use a different wallet / paste my key" to import it.')
    profileCache.address = address
  } else {
    const txt = await createRes.text().catch(() => '')
    throw new Error(`Registration failed (${createRes.status})${txt ? `: ${txt}` : ''}`)
  }
  profileCache.name = input.name.trim()

  // ── Step 2: put the agent on-chain (gasless prepare → local sign → relay) ──
  // A bare runtime gives us a ConnectionManager (Bearer apiKey + privateKey)
  // without a full WebSocket connect() — which would 403 pre-registration.
  const { NookplotRuntime, prepareSignRelay } = await import('@nookplot/runtime')
  const bootstrap = new NookplotRuntime({ gatewayUrl: GATEWAY_URL, apiKey, privateKey })
  await prepareSignRelay(bootstrap.connection, '/v1/prepare/register', {})

  registeredCache = true
  pushStatus()

  // ── Step 3: bring up the full connected runtime with the fresh API key ──
  return await connect()
}

// ── Encrypted keystore backup / restore ────────────────────────────────────────
// Standard Web3 Secret Storage JSON (ethers wallet.encrypt) — password-protected,
// interoperable with MetaMask/geth. The raw key never leaves the keychain except
// inside this encrypted blob; we never log it.

/** Export the current agent key as a password-encrypted keystore JSON string. */
export async function exportKeystore(password: string): Promise<string> {
  const pk = retrieveKey(KEY_PK)
  if (!pk) throw new Error('No agent key to export. Generate or import one first.')
  if (!password || password.length < 8) throw new Error('Choose a backup password of at least 8 characters.')
  const { Wallet } = await import('ethers')
  return await new Wallet(pk).encrypt(password)
}

/** Import a password-encrypted keystore JSON, replace the stored key, reconnect. */
export async function importKeystore(json: string, password: string): Promise<NookStatus> {
  const { Wallet } = await import('ethers')
  let wallet
  try {
    wallet = await Wallet.fromEncryptedJson(json.trim(), password)
  } catch {
    throw new Error('Could not decrypt — wrong password or invalid keystore file.')
  }
  await disconnect()
  storeKey(KEY_PK, wallet.privateKey)
  deleteKey(KEY_API)   // force a fresh wallet-session mint for the imported wallet
  profileCache = { address: null, name: null, reputation: null }
  creditsCache = null
  registeredCache = null
  return await connect()
}

export interface NookProfileView {
  address: string | null
  name: string | null
  reputation: number | null
  credits: number | null
}

export async function getProfile(): Promise<NookProfileView> {
  if (runtime) { await refreshProfile(); await refreshCredits() }
  return { ...profileCache, credits: creditsCache }
}

/** Normalize a raw gateway bounty into the renderer-friendly view. */
function viewBounty(b: Record<string, unknown>): NookBountyView {
  const tokenAddr = String(b.tokenAddress ?? '').toLowerCase()
  const tok = TOKENS[tokenAddr] ?? { symbol: 'TOKEN', decimals: 18 }
  const amount = String(b.rewardAmount ?? '0')
  const statusCode = Number(b.status ?? 0)
  return {
    id: String(b.id ?? ''),
    title: String(b.title ?? '(untitled)'),
    description: String(b.description ?? ''),
    community: String(b.community ?? ''),
    rewardDisplay: `${formatUnits(amount, tok.decimals)} ${tok.symbol}`,
    rewardToken: tok.symbol,
    status: BOUNTY_STATUS[statusCode] ?? String(statusCode),
    statusCode,
    deadline: Number(b.deadline ?? 0),
    applicationCount: Number(b.applicationCount ?? 0),
    claimer: (b.claimer as string) ?? null,
    raw: b,
  }
}

export function asArray(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[]
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>
    for (const k of ['bounties', 'listings', 'items', 'results', 'data']) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[]
    }
  }
  return []
}

export async function listBounties(opts?: { limit?: number; community?: string }): Promise<NookBountyView[]> {
  if (!runtime) throw new Error('Not connected to nookplot.')
  const res = await runtime.bounties.list({ first: opts?.limit ?? 25, community: opts?.community })
  return asArray(res).map(viewBounty)
}

export async function claimBounty(id: string): Promise<{ ok: true }> {
  if (!runtime) throw new Error('Not connected to nookplot.')
  if (!hasKey(KEY_PK)) throw new Error('Claiming is on-chain — add your agent private key first to enable signing.')
  await runtime.bounties.claim(Number(id))
  return { ok: true }
}

export async function submitWork(id: string, description: string, deliverables: string[]): Promise<{ ok: true }> {
  if (!runtime) throw new Error('Not connected to nookplot.')
  if (!hasKey(KEY_PK)) throw new Error('Submitting work is on-chain — add your agent private key first.')
  await runtime.bounties.submit(Number(id), description, deliverables)
  return { ok: true }
}

export interface NookListingView {
  id: string
  title: string
  description: string
  priceDisplay: string
  domains: string[]
  provider: string
  raw: Record<string, unknown>
}

const PRICING_MODEL: Record<string, string> = { '0': 'per call', '1': 'per period', '2': 'milestone' }

/** Best-effort fetch of IPFS JSON metadata via the gateway (short timeout). */
async function fetchIpfsMeta(cid: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/ipfs/${cid}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6_000) as AbortSignal,
    })
    if (!res.ok) return null
    return await res.json() as Record<string, unknown>
  } catch { return null }
}

export async function listListings(opts?: { query?: string; limit?: number }): Promise<NookListingView[]> {
  if (!runtime) throw new Error('Not connected to nookplot.')
  // Real shape: { listings: [{ listing_id, category, price_amount, token_address,
  //   pricing_model, provider_address, tags, total_completed, metadata_cid, ... }] }.
  // Title/description live in the IPFS metadata_cid, so we enrich in parallel.
  const res = await runtime.marketplace.search({ first: opts?.limit ?? 24, query: opts?.query })
  const rows = asArray(res)
  return Promise.all(rows.map(async (l) => {
    const tokenAddr = String(l.token_address ?? '').toLowerCase()
    const tok = TOKENS[tokenAddr] ?? { symbol: 'TOKEN', decimals: 18 }
    const model = PRICING_MODEL[String(l.pricing_model ?? '')] ?? ''
    const category = l.category ? String(l.category) : ''
    const tags = Array.isArray(l.tags) ? (l.tags as string[]) : []
    let title = category || '(service)'
    let description = ''
    const cid = l.metadata_cid ? String(l.metadata_cid) : ''
    if (cid) {
      const meta = await fetchIpfsMeta(cid)
      if (meta) {
        if (meta.title || meta.name) title = String(meta.title ?? meta.name)
        if (meta.description) description = String(meta.description)
      }
    }
    const price = `${formatUnits(String(l.price_amount ?? '0'), tok.decimals)} ${tok.symbol}`
    return {
      id: String(l.listing_id ?? l.id ?? ''),
      title,
      description: description || (category ? `${category} service` : ''),
      priceDisplay: model ? `${price} / ${model}` : price,
      domains: tags.length ? tags : (category ? [category] : []),
      provider: String(l.provider_address ?? ''),
      raw: l,
    }
  }))
}

// ── Autonomy ──────────────────────────────────────────────────────────────────

// ── Agent brain (TachiDesk's own providers) ─────────────────────────────────────
// The brain is whichever provider the user already runs in this app (freellmapi /
// OpenRouter / Bankr / Surplus / OpenGateway / Ollama) — see nook-brain.ts. Same
// chosen provider+model powers BOTH the autonomous agent and the mining solver.
let brainProvider = 'freellmapi'
let brainModel = ''

/** Set which app provider+model powers the agent (autonomous + mining). */
export function setBrain(provider: string, model?: string): void {
  if (provider) brainProvider = provider
  brainModel = model ?? ''
}
export function getBrain(): { provider: string; model: string } {
  return { provider: brainProvider, model: brainModel }
}

/** One LLM call via the chosen app provider (OpenAI-compatible, key from keychain). */
export async function brainComplete(prompt: string): Promise<string> {
  const brain = await import('./nook-brain')
  return brain.complete(prompt, brainProvider, brainModel || undefined)
}

/** The app providers available to power the agent (with availability + reason). */
export async function listBrainProviders(): Promise<{ id: string; label: string; available: boolean; reason?: string; defaultModel: string }[]> {
  const brain = await import('./nook-brain')
  return brain.listBrainProviders()
}

export async function goOnline(provider?: string, model?: string): Promise<NookStatus> {
  if (!runtime) throw new Error('Connect to nookplot first.')
  if (!hasKey(KEY_PK)) throw new Error('Autonomous mode needs your agent private key (it signs on-chain actions).')
  if (autonomous) return snapshot()
  const rt = runtime
  if (provider) setBrain(provider, model)
  const { AutonomousAgent } = await import('@nookplot/runtime')
  // AutonomousAgent with no generateResponse DROPS every signal. The brain runs
  // through the gateway BYOK proxy with the user's chosen provider+model.
  autonomous = new AutonomousAgent(rt, {
    generateResponse: async (prompt: string) => {
      try { return await brainComplete(prompt) }
      catch (e) { console.warn('[nook] brain failed:', (e as Error).message); return '' }
    },
  })
  autonomous.start()
  // Turn ON the server-side proactive scanner so "online" actually scans the network.
  try { await rt.proactive.enable() } catch { /* non-fatal */ }
  pushStatus()
  return snapshot()
}

export async function goOffline(): Promise<NookStatus> {
  try { autonomous?.stop() } catch { /* ignore */ }
  autonomous = null
  // Also stop the SERVER-SIDE scanner — otherwise the gateway keeps scanning,
  // queuing signals, and auto-executing actions even after the app disconnects
  // ("still runs on the website" after going offline).
  try { await runtime?.proactive.disable() } catch { /* non-fatal */ }
  pushStatus()
  return snapshot()
}

// ── Proactive approval queue ───────────────────────────────────────────────────

export async function getApprovals(): Promise<unknown[]> {
  if (!runtime) return []
  try {
    const res = await runtime.proactive.getPendingApprovals() as { approvals?: unknown[] }
    return res.approvals ?? []
  } catch { return [] }
}

export async function approveAction(id: string): Promise<{ ok: true }> {
  if (!runtime) throw new Error('Not connected to nookplot.')
  await runtime.proactive.approveAction(id)
  return { ok: true }
}

export async function rejectAction(id: string): Promise<{ ok: true }> {
  if (!runtime) throw new Error('Not connected to nookplot.')
  await runtime.proactive.rejectAction(id)
  return { ok: true }
}

export async function getActivity(limit = 30): Promise<unknown[]> {
  if (!runtime) return []
  try {
    const res = await runtime.proactive.getActivity(limit) as { activity?: unknown[]; entries?: unknown[] }
    return res.activity ?? res.entries ?? []
  } catch { return [] }
}

/** Called from app will-quit to tear down the WebSocket cleanly. */
export async function stopNook(): Promise<void> { await disconnect() }

// ── Shared accessors for domain modules (actions / knowledge / messaging) ──────
// These let separate service modules build on the single connected runtime + the
// decode helpers without duplicating connection state.
export function getRuntime(): NookplotRuntime | null { return runtime }
export function nookGatewayUrl(): string { return GATEWAY_URL }
export function isRegistered(): boolean | null { return registeredCache }
