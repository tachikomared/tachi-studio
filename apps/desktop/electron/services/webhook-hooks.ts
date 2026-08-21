// apps/desktop/electron/services/webhook-hooks.ts
//
// BATCH35 lane B — inbound WEBHOOK TRIGGERS for the Nodes canvas (community
// idea: "TradingView-webhook node"). A trigger node on the canvas ARMS a hook;
// while it is armed, the local API server (openai-api-server.ts, 127.0.0.1:11435)
// answers POSTs at
//
//     /webhooks/<source>/<hookId>?token=<token>
//
// and hands the alert body to the canvas as that node's output.
//
// INBOUND SIGNAL ONLY. Nothing here places an order, moves money, or talks to a
// broker — an alert becomes TEXT on a node, full stop. The app's money-path caps
// are a hard law and a trigger must never become a way around them.
//
// SECURITY MODEL (deliberately stricter than the /v1 routes, because this is the
// one surface a THIRD PARTY is invited to call):
//   1. DEFAULT-CLOSED. The registry starts empty, so every path 404s until a
//      canvas node arms a hook. Closing the canvas disarms it again.
//   2. PER-HOOK SECRET, 32 bytes (WEBHOOK_TOKEN_BYTES) from crypto.randomBytes —
//      not the 16-byte randomUUID the /v1 bearer uses, because this token travels
//      in a URL a user pastes into a third-party alert box. Compared in constant
//      time (same reasoning as util/token-store.safeCompareToken, reimplemented
//      here only so this module stays electron-free and unit-testable in node).
//   3. SIZE CAP. Bodies over WEBHOOK_MAX_BODY_BYTES (64 KiB) are refused — an
//      alert is a sentence, not an upload.
//   4. RATE LIMIT. Sliding windows per hook AND across all hooks (the
//      McpRateLimiter shape from electron/mcp/rate-limit.ts), so a leaked URL
//      cannot spin the canvas.
//   5. LOOPBACK ONLY — the bind address is the API server's and is not touched
//      here. TradingView's own servers cannot reach 127.0.0.1; reaching this
//      endpoint from the internet requires a tunnel the USER chooses to run, and
//      the node says so out loud instead of pretending otherwise.
//
// PURE + INJECTED: no electron, no fs, no timers. `now` is a parameter and token
// persistence is an injected adapter (nodes.ipc.ts supplies the encrypted one),
// so the whole file is drivable from a node-env unit test.

import { randomBytes, timingSafeEqual } from 'node:crypto'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Alert providers this build understands. v1 ships TradingView only. */
export const WEBHOOK_SOURCES = ['tradingview'] as const
export type WebhookSource = (typeof WEBHOOK_SOURCES)[number]

/** Secret size in BYTES (hex-encoded → 64 chars). Brief: min 32 bytes. */
export const WEBHOOK_TOKEN_BYTES = 32

/** An alert is a sentence; anything larger is refused with 413. */
export const WEBHOOK_MAX_BODY_BYTES = 64 * 1024

/** Sliding-window caps: per hook, and across every armed hook. */
export const WEBHOOK_RATE_LIMIT = { windowMs: 60_000, max: 60 } as const
export const WEBHOOK_GLOBAL_RATE_LIMIT = { windowMs: 60_000, max: 240 } as const

/** How many hooks may be armed at once (one canvas = a handful of nodes). */
export const WEBHOOK_MAX_HOOKS = 32

/** Ring-buffer depth of delivered alerts kept per hook for the node's readout. */
export const WEBHOOK_RECENT_MAX = 20

/**
 * A hook id is a URL PATH SEGMENT, so it is restricted to a shape that cannot
 * traverse, encode, or collide: lowercase alphanumerics + hyphen, 8-64 chars.
 * Validated on arm AND on delivery, so a crafted request can never reach the
 * registry with something exotic.
 */
export const HOOK_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WebhookAlert {
  hookId: string
  source: WebhookSource
  /** Epoch ms the alert was accepted. */
  receivedAt: number
  /** Normalized text — this is what the canvas node emits as its output. */
  text: string
  /** Parsed body when the alert arrived as JSON (TradingView sends either). */
  json?: unknown
  /** Raw Content-Type as sent, lowercased ('' when absent). */
  contentType: string
  /** Byte length of the received body. */
  bytes: number
}

export interface ArmedHook {
  hookId: string
  source: WebhookSource
  /** Epoch ms the hook was armed. */
  armedAt: number
  /** Alerts delivered since arming. */
  hits: number
  /** Epoch ms of the most recent accepted alert, or null. */
  lastAt: number | null
}

export type WebhookDenyCode =
  | 'not-armed'
  | 'bad-hook-id'
  | 'bad-source'
  | 'bad-token'
  | 'too-large'
  | 'rate-limited'
  | 'too-many-hooks'

export type WebhookDeliveryResult =
  | { ok: true; alert: WebhookAlert }
  | { ok: false; status: number; code: WebhookDenyCode; message: string; retryAfterMs?: number }

/** Persistence adapter for hook secrets (injected — see the header). */
export interface WebhookTokenStore {
  load(): Record<string, string>
  save(tokens: Record<string, string>): void
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function isWebhookSource(v: unknown): v is WebhookSource {
  return typeof v === 'string' && (WEBHOOK_SOURCES as readonly string[]).includes(v)
}

export function isValidHookId(v: unknown): v is string {
  return typeof v === 'string' && HOOK_ID_RE.test(v)
}

/** A fresh 32-byte secret, hex-encoded (64 chars). */
export function mintWebhookToken(): string {
  return randomBytes(WEBHOOK_TOKEN_BYTES).toString('hex')
}

/**
 * Constant-time secret equality. Same contract as
 * util/token-store.safeCompareToken — duplicated (4 lines) rather than imported
 * so this module never pulls `electron` in. A plain `===` short-circuits on the
 * first differing byte and leaks length/prefix information over many tries.
 */
export function safeCompareSecret(supplied: string, expected: string): boolean {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false
  if (supplied.length === 0 || supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}

/**
 * Turn a raw alert body into the node's output text.
 *
 * TradingView alerts are free-form: the message box sends PLAIN TEXT unless the
 * user typed JSON (the documented `{{strategy.order.action}}` recipes produce
 * both in the wild). So: try JSON first, pretty-print it when it parses to an
 * object/array (readable on the node AND stable for downstream prompts), keep
 * the trimmed raw string otherwise. A JSON scalar (`"buy"`, `42`) is treated as
 * text — pretty-printing `"buy"` into `"buy"` with quotes helps nobody.
 */
export function normalizeAlertBody(raw: string): { text: string; json?: unknown } {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return { text: '' }
  if (!/^[[{]/.test(trimmed)) return { text: trimmed }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed !== null && typeof parsed === 'object') {
      return { text: JSON.stringify(parsed, null, 2), json: parsed }
    }
  } catch { /* not JSON after all — fall through to the raw text */ }
  return { text: trimmed }
}

/**
 * The path a hook answers on. Kept here (not in the server) so the renderer's
 * copyable URL and the route matcher can never drift apart.
 */
export function webhookPath(source: WebhookSource, hookId: string): string {
  return `/webhooks/${source}/${hookId}`
}

/** Full copyable URL for a hook, secret included (it must live in the URL —
 *  TradingView's alert box has no place to put a header). */
export function webhookUrl(baseOrigin: string, source: WebhookSource, hookId: string, token: string): string {
  const origin = baseOrigin.replace(/\/+$/, '')
  return `${origin}${webhookPath(source, hookId)}?token=${token}`
}

/**
 * Match a request path against the webhook route. Returns null for anything that
 * is not exactly `/webhooks/<source>/<hookId>` — extra segments, unknown sources
 * and malformed ids are rejected HERE, before any registry lookup.
 */
export function parseWebhookPath(path: string): { source: WebhookSource; hookId: string } | null {
  const parts = (path ?? '').split('/')
  // ['', 'webhooks', source, hookId]
  if (parts.length !== 4 || parts[0] !== '' || parts[1] !== 'webhooks') return null
  const source = parts[2]
  let hookId = parts[3] ?? ''
  try { hookId = decodeURIComponent(hookId) } catch { return null }
  if (!isWebhookSource(source) || !isValidHookId(hookId)) return null
  return { source, hookId }
}

// ── Sliding-window limiter (shape borrowed from electron/mcp/rate-limit.ts) ────

class SlidingWindow {
  private hits: number[] = []
  constructor(private readonly windowMs: number, private readonly max: number) {}
  check(now: number): { allowed: true } | { allowed: false; retryAfterMs: number } {
    this.hits = this.hits.filter(ts => now - ts < this.windowMs)
    if (this.hits.length >= this.max) {
      const oldest = this.hits[0] as number
      return { allowed: false, retryAfterMs: Math.max(1, oldest + this.windowMs - now) }
    }
    this.hits.push(now)
    return { allowed: true }
  }
}

// ── Registry (module state — one per main process) ─────────────────────────────

interface HookEntry {
  hookId: string
  source: WebhookSource
  token: string
  armedAt: number
  hits: number
  lastAt: number | null
  limiter: SlidingWindow
  recent: WebhookAlert[]
}

const hooks = new Map<string, HookEntry>()
const listeners = new Set<(alert: WebhookAlert) => void>()
let globalLimiter = new SlidingWindow(WEBHOOK_GLOBAL_RATE_LIMIT.windowMs, WEBHOOK_GLOBAL_RATE_LIMIT.max)
let tokenStore: WebhookTokenStore | null = null
/** Secrets that survive an app restart, so a pasted alert URL keeps working. */
let persistedTokens: Record<string, string> = {}

/** Install the (encrypted) persistence adapter. Called once from nodes.ipc. */
export function setWebhookTokenStore(store: WebhookTokenStore | null): void {
  tokenStore = store
  if (!store) { persistedTokens = {}; return }
  try {
    const loaded = store.load()
    persistedTokens = {}
    for (const [k, v] of Object.entries(loaded ?? {})) {
      // Only keep well-formed pairs — a corrupt file must not arm anything.
      if (isValidHookId(k) && typeof v === 'string' && v.length === WEBHOOK_TOKEN_BYTES * 2) {
        persistedTokens[k] = v
      }
    }
  } catch { persistedTokens = {} }
}

function persist(): void {
  if (!tokenStore) return
  try { tokenStore.save({ ...persistedTokens }) } catch { /* best-effort */ }
}

/**
 * Arm a hook: the route goes live and the secret is returned ONCE per call for
 * the node to display. A re-arm of the same id keeps the existing secret (so the
 * URL a user already pasted into TradingView survives a canvas reload).
 */
export function armWebhook(
  hookId: string,
  source: WebhookSource,
  now: number = Date.now(),
): { ok: true; hookId: string; source: WebhookSource; token: string; path: string }
  | { ok: false; code: WebhookDenyCode; message: string } {
  if (!isValidHookId(hookId)) {
    return { ok: false, code: 'bad-hook-id', message: 'hook id must be 8-64 chars of a-z, 0-9 or "-"' }
  }
  if (!isWebhookSource(source)) {
    return { ok: false, code: 'bad-source', message: `unknown webhook source: ${String(source)}` }
  }
  const existing = hooks.get(hookId)
  if (existing) {
    return { ok: true, hookId, source: existing.source, token: existing.token, path: webhookPath(existing.source, hookId) }
  }
  if (hooks.size >= WEBHOOK_MAX_HOOKS) {
    return { ok: false, code: 'too-many-hooks', message: `at most ${WEBHOOK_MAX_HOOKS} webhook triggers can be armed at once` }
  }
  const token = persistedTokens[hookId] ?? mintWebhookToken()
  persistedTokens[hookId] = token
  persist()
  hooks.set(hookId, {
    hookId, source, token, armedAt: now, hits: 0, lastAt: null,
    limiter: new SlidingWindow(WEBHOOK_RATE_LIMIT.windowMs, WEBHOOK_RATE_LIMIT.max),
    recent: [],
  })
  return { ok: true, hookId, source, token, path: webhookPath(source, hookId) }
}

/** Take a hook off the air. Idempotent; the persisted secret is kept so a later
 *  re-arm reuses the same URL (use forgetWebhook to rotate it). */
export function disarmWebhook(hookId: string): boolean {
  return hooks.delete(hookId)
}

/** Disarm AND drop the persisted secret — the next arm mints a fresh URL. */
export function forgetWebhook(hookId: string): void {
  hooks.delete(hookId)
  if (hookId in persistedTokens) {
    delete persistedTokens[hookId]
    persist()
  }
}

/** Rotate one hook's secret in place (stays armed, old URL stops working). */
export function rotateWebhookToken(hookId: string): string | null {
  const entry = hooks.get(hookId)
  const token = mintWebhookToken()
  persistedTokens[hookId] = token
  persist()
  if (entry) entry.token = token
  return entry ? token : null
}

export function isWebhookArmed(hookId: string): boolean {
  return hooks.has(hookId)
}

export function revealWebhookToken(hookId: string): string | null {
  return hooks.get(hookId)?.token ?? null
}

export function listArmedWebhooks(): ArmedHook[] {
  return [...hooks.values()].map(h => ({
    hookId: h.hookId, source: h.source, armedAt: h.armedAt, hits: h.hits, lastAt: h.lastAt,
  }))
}

export function recentWebhookAlerts(hookId: string): WebhookAlert[] {
  return [...(hooks.get(hookId)?.recent ?? [])]
}

/** Subscribe to accepted alerts. Returns an unsubscribe function. */
export function onWebhookAlert(cb: (alert: WebhookAlert) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Drop every armed hook + listener. Used by tests and at app shutdown. */
export function resetWebhookRegistry(): void {
  hooks.clear()
  listeners.clear()
  globalLimiter = new SlidingWindow(WEBHOOK_GLOBAL_RATE_LIMIT.windowMs, WEBHOOK_GLOBAL_RATE_LIMIT.max)
}

// ── Delivery ──────────────────────────────────────────────────────────────────

export interface WebhookDeliveryInput {
  source: string
  hookId: string
  /** Secret as supplied by the caller (query param or header). */
  token: string
  /** Raw body bytes as received. */
  body: Buffer | string
  contentType?: string | undefined
  /** True when the transport already refused the body for exceeding its cap. */
  oversized?: boolean
}

/**
 * Validate + record one inbound alert. The ORDER of checks is deliberate:
 * shape → armed → token → size → rate. Shape/armed first so a malformed or
 * unknown path costs nothing; token before size so a stranger cannot learn the
 * body cap; rate LAST so a flood of authenticated requests is what gets
 * throttled (a wrong-token flood is already cheap to reject).
 */
export function deliverWebhook(input: WebhookDeliveryInput, now: number = Date.now()): WebhookDeliveryResult {
  if (!isValidHookId(input.hookId)) {
    return { ok: false, status: 404, code: 'bad-hook-id', message: 'no such webhook' }
  }
  if (!isWebhookSource(input.source)) {
    return { ok: false, status: 404, code: 'bad-source', message: 'no such webhook' }
  }
  const entry = hooks.get(input.hookId)
  // Not armed reads as "does not exist" — the canvas node is the only thing that
  // can bring a path into being, and a probe should not learn otherwise.
  if (!entry || entry.source !== input.source) {
    return { ok: false, status: 404, code: 'not-armed', message: 'no such webhook' }
  }
  if (!safeCompareSecret(input.token ?? '', entry.token)) {
    return { ok: false, status: 401, code: 'bad-token', message: 'invalid webhook token' }
  }

  const buf = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : (input.body ?? Buffer.alloc(0))
  if (input.oversized || buf.length > WEBHOOK_MAX_BODY_BYTES) {
    return {
      ok: false, status: 413, code: 'too-large',
      message: `alert body exceeds ${WEBHOOK_MAX_BODY_BYTES} bytes`,
    }
  }

  const perHook = entry.limiter.check(now)
  if (!perHook.allowed) {
    return { ok: false, status: 429, code: 'rate-limited', message: 'too many alerts for this webhook', retryAfterMs: perHook.retryAfterMs }
  }
  const global = globalLimiter.check(now)
  if (!global.allowed) {
    return { ok: false, status: 429, code: 'rate-limited', message: 'too many alerts across all webhooks', retryAfterMs: global.retryAfterMs }
  }

  const { text, json } = normalizeAlertBody(buf.toString('utf8'))
  const alert: WebhookAlert = {
    hookId: entry.hookId,
    source: entry.source,
    receivedAt: now,
    text,
    ...(json !== undefined ? { json } : {}),
    contentType: (input.contentType ?? '').toLowerCase(),
    bytes: buf.length,
  }

  entry.hits += 1
  entry.lastAt = now
  entry.recent.unshift(alert)
  if (entry.recent.length > WEBHOOK_RECENT_MAX) entry.recent.length = WEBHOOK_RECENT_MAX

  for (const cb of [...listeners]) {
    try { cb(alert) } catch { /* one bad listener must not drop the alert */ }
  }
  return { ok: true, alert }
}
