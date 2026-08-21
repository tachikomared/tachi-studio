// apps/desktop/src/pages/nodes/webhookTrigger.ts
//
// BATCH35 lane B — PURE helpers for the inbound webhook TRIGGER node
// (canvas/nodeTypes/WebhookNode.tsx). Everything here is data-in/data-out so the
// interesting decisions — what state the node is in, what the alert reads as,
// whether an auto-run may fire — are unit-testable without a DOM, matching the
// house pattern of paletteDrag.ts / run-eligibility.ts.
//
// The node is an INBOUND SIGNAL. An alert lands, becomes text, and is referenced
// downstream. Nothing in this file (or anywhere in the feature) places a trade,
// and `mayAutoRun` exists precisely so an untrusted external POST cannot spend
// tokens unless the user opted in on that node.

/** Alert providers this build understands. Mirrors WEBHOOK_SOURCES in main. */
export const WEBHOOK_SOURCE_LABELS: Record<string, string> = {
  tradingview: 'TradingView',
}

/**
 * A hook id is a URL path segment. Same shape main enforces (HOOK_ID_RE in
 * services/webhook-hooks.ts) — duplicated as a CHECK, never as a second source
 * of truth: main rejects anything that fails there regardless of what we send.
 */
export const HOOK_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/

export function isValidHookId(v: unknown): v is string {
  return typeof v === 'string' && HOOK_ID_RE.test(v)
}

/**
 * Mint a fresh hook id: `hook-` + 16 hex chars from the platform CSPRNG. Not a
 * secret (the token is) — it only has to be unguessable enough that two canvases
 * never collide and a bored scanner never enumerates one.
 */
export function newHookId(): string {
  const bytes = new Uint8Array(8)
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `hook-${hex}`
}

// ── Node state machine ────────────────────────────────────────────────────────

/**
 * What the node is doing right now, in the order the UI cares about:
 *   server-off  — the local API server is disabled in Settings → no route can
 *                 exist. The node says so honestly instead of showing a URL
 *                 that answers nothing.
 *   server-down — enabled but not listening yet (booting, or the port bind
 *                 failed). Same honesty, different remedy.
 *   error       — arming was refused (bad id, too many hooks).
 *   disarmed    — the user has the node switched off; the path 404s.
 *   listening   — armed and answering.
 */
export type WebhookNodeState = 'server-off' | 'server-down' | 'error' | 'disarmed' | 'listening'

export interface WebhookStateInput {
  serverEnabled: boolean
  serverRunning: boolean
  armed: boolean
  /** True once main confirmed the arm and handed back a URL. */
  live: boolean
  error?: string | undefined
}

export function webhookNodeState(input: WebhookStateInput): WebhookNodeState {
  if (!input.serverEnabled) return 'server-off'
  if (!input.serverRunning) return 'server-down'
  if (input.error) return 'error'
  if (!input.armed) return 'disarmed'
  return input.live ? 'listening' : 'server-down'
}

/** Only a LISTENING node has a URL worth copying. */
export function canCopyUrl(state: WebhookNodeState, url: string | null | undefined): boolean {
  return state === 'listening' && typeof url === 'string' && url.length > 0
}

/**
 * May an inbound alert start a flow run?
 *
 * Deliberately conservative, and the reason this is a function rather than an
 * `if` inside a component: an external party controls WHEN this fires, so the
 * user's explicit per-node opt-in is the only thing that makes it legitimate,
 * and a run already in flight must never be stacked on top of.
 */
export function mayAutoRun(opts: { autoRun: boolean | undefined; state: WebhookNodeState; running: boolean }): boolean {
  return opts.autoRun === true && opts.state === 'listening' && !opts.running
}

// ── Alert rendering ───────────────────────────────────────────────────────────

export interface WebhookAlertLike {
  receivedAt: number
  text: string
  bytes?: number
}

/**
 * Collapse an alert body to ONE informative line.
 *
 * The subtlety is that main's `normalizeAlertBody` (services/webhook-hooks.ts)
 * PRETTY-PRINTS a parsed JSON alert — `JSON.stringify(parsed, null, 2)` — which
 * is right for the node's downstream output and catastrophic for a one-line
 * readout: the first non-empty line of every pretty-printed object is `{`, so
 * the node showed `Last: 09:05:03 · {` for every JSON alert TradingView sends,
 * identically, forever. Taking line 2 instead would be just as arbitrary.
 *
 * So: re-parse a JSON document and re-serialize it COMPACT
 * (`{"ticker":"BTCUSD","action":"test"}`), which fits the real payloads and
 * degrades by clipping rather than by lying. Anything that is not a JSON
 * object/array — plain text, a JSON scalar main deliberately keeps as text,
 * a malformed `{not json` — keeps the historic first-non-empty-line behavior.
 */
export function compactAlertLine(text: string | null | undefined): string {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return ''
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      // Mirrors normalizeAlertBody's own object/array test — a scalar reaches
      // us as raw text and must stay that way.
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed)
    } catch { /* not JSON after all — fall through to the first-line path */ }
  }
  return trimmed.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
}

/**
 * One-line readout for the node body: `HH:MM:SS · <summary, clipped>`.
 * A 40-line alert can't stretch the tile; the full body is still the node's
 * output. See compactAlertLine for how a JSON payload is summarized.
 */
export function alertSummary(alert: WebhookAlertLike | null | undefined, max = 64): string {
  if (!alert) return ''
  const firstLine = compactAlertLine(alert.text)
  const clipped = firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine
  const d = new Date(alert.receivedAt)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return clipped ? `${hh}:${mm}:${ss} · ${clipped}` : `${hh}:${mm}:${ss}`
}

/**
 * Mask a secret for on-screen display: first 6 and last 4 chars. The full token
 * only ever leaves through an explicit Copy (the same posture as the API-server
 * key, which is never in a status payload).
 */
export function maskToken(token: string | null | undefined): string {
  if (!token) return ''
  if (token.length <= 14) return '•'.repeat(token.length)
  return `${token.slice(0, 6)}…${token.slice(-4)}`
}

// ── Auto-run bus ──────────────────────────────────────────────────────────────
//
// A webhook node cannot run the flow itself (only NodesPage owns the run path),
// and threading a callback through ReactFlow's node props would mean a new prop
// on every node type. A module-level bus keeps the coupling to one import each
// side and stays trivially testable.

export interface WebhookFiredEvent {
  nodeId: string
  hookId: string
  text: string
  receivedAt: number
}

type FiredListener = (e: WebhookFiredEvent) => void
const firedListeners = new Set<FiredListener>()

export function onWebhookFired(cb: FiredListener): () => void {
  firedListeners.add(cb)
  return () => { firedListeners.delete(cb) }
}

export function emitWebhookFired(e: WebhookFiredEvent): void {
  for (const cb of [...firedListeners]) {
    try { cb(e) } catch { /* one bad subscriber must not swallow the trigger */ }
  }
}

/** Test seam — drop every subscriber. */
export function resetWebhookFiredListeners(): void {
  firedListeners.clear()
}
