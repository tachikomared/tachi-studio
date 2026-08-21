// electron/services/network-audit.ts
//
// Thin ring-buffer around the Node/Electron global fetch.
// Call loggedFetch() in place of fetch(), or monkey-patch globalThis.fetch
// once at startup (see main.ts) so every call in the main process is captured.
//
// Stores the last MAX_ENTRIES requests.  Bodies are never retained — only sizes.

export type NetworkAuditCategory =
  | 'anthropic'
  | 'openai'
  | 'github'
  | 'openrouter'
  | 'opengateway'
  | 'bankr'
  | 'venice'
  | 'surplus'
  | 'ollama'
  | 'other'

export interface NetworkAuditEntry {
  id:         number
  url:        string
  host:       string
  method:     string
  status:     number | null   // null = network error (never got a response)
  durationMs: number
  bytesIn:    number          // response content-length (or -1 if unknown)
  bytesOut:   number          // request content-length (or -1 if unknown)
  startedAt:  string          // ISO 8601
  category:   NetworkAuditCategory
  /** Tokens written to the Anthropic prompt cache on this request. */
  cacheCreateTokens?: number
  /** Tokens served from the Anthropic prompt cache on this request. */
  cacheReadTokens?:   number
}

// ── internals ─────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 500

const ring: NetworkAuditEntry[] = []
let   seq = 0

function categoryFromHost(host: string): NetworkAuditCategory {
  if (host.includes('anthropic.com'))              return 'anthropic'
  if (host.includes('openai.com'))                 return 'openai'
  if (host.includes('api.github.com') ||
      host.includes('github.com'))                 return 'github'
  if (host.includes('openrouter.ai'))              return 'openrouter'
  if (host.includes('opengateway') ||
      host.includes('opengateway.ai'))             return 'opengateway'
  if (host.includes('bankr.ai') ||
      host.includes('bankr'))                      return 'bankr'
  if (host.includes('venice.ai'))                  return 'venice'
  if (host.includes('surplus'))                    return 'surplus'
  if (host.includes('ollama') ||
      host === '127.0.0.1' ||
      host === 'localhost')                        return 'ollama'
  return 'other'
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function extractBytesOut(init: RequestInit | undefined): number {
  if (!init?.body) return 0
  const body = init.body
  if (typeof body === 'string')       return Buffer.byteLength(body, 'utf8')
  if (body instanceof Uint8Array)     return body.byteLength
  if (body instanceof ArrayBuffer)    return body.byteLength
  // ReadableStream / FormData / URLSearchParams — we don't buffer them
  return -1
}

function extractBytesIn(res: Response): number {
  const cl = res.headers.get('content-length')
  if (cl) {
    const n = parseInt(cl, 10)
    if (!isNaN(n)) return n
  }
  return -1
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for the global fetch that records every request into
 * the ring buffer.  Callers get back the original Response object unchanged.
 */
export async function loggedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url      = typeof input === 'string' ? input
                 : input instanceof URL      ? input.toString()
                 : (input as Request).url
  const method   = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const host     = extractHost(url)
  const category = categoryFromHost(host)
  const bytesOut = extractBytesOut(init)
  const startedAt = new Date().toISOString()
  const t0       = Date.now()
  // Reserve the audit-entry ID synchronously before any await so callers that
  // previously read peekNextId() will reliably match this request even when
  // other fetches interleave during the network round-trip.
  const id       = ++seq

  let status: number | null = null
  let bytesIn = -1

  try {
    // Use the *original* fetch stored before any patching.
    const res = await _originalFetch(input, init)
    status  = res.status
    bytesIn = extractBytesIn(res)

    const entry: NetworkAuditEntry = {
      id,
      url,
      host,
      method,
      status,
      durationMs: Date.now() - t0,
      bytesIn,
      bytesOut,
      startedAt,
      category,
    }
    _push(entry)
    return res
  } catch (err) {
    const entry: NetworkAuditEntry = {
      id,
      url,
      host,
      method,
      status: null,
      durationMs: Date.now() - t0,
      bytesIn: -1,
      bytesOut,
      startedAt,
      category,
    }
    _push(entry)
    throw err
  }
}

function _push(entry: NetworkAuditEntry): void {
  if (ring.length >= MAX_ENTRIES) ring.shift()
  ring.push(entry)
}

/** Return the most-recent `n` entries (default 100, max MAX_ENTRIES). */
export function getRecent(n = 100): NetworkAuditEntry[] {
  const limit = Math.max(1, Math.min(n, MAX_ENTRIES))
  return ring.slice(-limit)
}

/** Wipe the ring buffer. */
export function clear(): void {
  ring.length = 0
}

/**
 * Return the ID that the *next* call to loggedFetch will receive.
 * Call this immediately before a fetch you intend to patch with
 * cache-usage data, then pass the returned ID to patchEntry() after
 * the response stream is consumed.
 */
export function peekNextId(): number {
  return seq + 1
}

/**
 * Merge `patch` fields into the ring-buffer entry with the given `id`.
 * No-ops silently if the entry has already been evicted from the ring.
 * Intended for post-stream enrichment with Anthropic cache token counts.
 */
export function patchEntry(id: number, patch: Partial<Pick<NetworkAuditEntry, 'cacheCreateTokens' | 'cacheReadTokens'>>): void {
  const entry = ring.find(e => e.id === id)
  if (!entry) return
  if (patch.cacheCreateTokens !== undefined) entry.cacheCreateTokens = patch.cacheCreateTokens
  if (patch.cacheReadTokens   !== undefined) entry.cacheReadTokens   = patch.cacheReadTokens
}

// ── monkey-patch helper ───────────────────────────────────────────────────────

// Keep a reference to the native fetch so loggedFetch can call it safely even
// after we replace globalThis.fetch.
let _originalFetch: typeof fetch = globalThis.fetch

/**
 * Call once at startup to replace the main-process global fetch with
 * loggedFetch.  Idempotent — safe to call multiple times.
 */
export function installFetchPatch(): void {
  if ((globalThis as Record<string, unknown>).__networkAuditPatched) return
  _originalFetch = globalThis.fetch
  ;(globalThis as Record<string, unknown>).fetch = loggedFetch
  ;(globalThis as Record<string, unknown>).__networkAuditPatched = true
}
