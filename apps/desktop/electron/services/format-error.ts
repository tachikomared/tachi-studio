// apps/desktop/electron/services/format-error.ts
//
// One honest way to turn a thrown/streamed error value into a human string.
//
// WHY: the AI SDK's `fullStream` emits `{ type: 'error', error }` where `error`
// is an OBJECT (e.g. AI_InvalidToolInputError when a gateway truncates streamed
// tool-call arguments mid-JSON). `String(obj)` on that renders the literal
// "[object Object]" — which is exactly what the Code tab showed on a live run,
// telling the user nothing. Likewise `(e as Error).message` yields `undefined`
// for anything thrown that isn't an Error.
//
// This formatter never returns "[object Object]" and never returns "undefined":
//   - Error-shaped values  -> "Name: message" (the bare "Error" name is dropped
//                             — it says nothing; real class names are kept)
//   - provider metadata    -> " (HTTP 429, code rate_limit_exceeded)"
//   - AI SDK tool errors   -> " (tool bash)"
//   - `cause` chains       -> " <- caused by: ..." (depth-capped, cycle-safe)
//   - anything else        -> compact JSON, or a typed placeholder
//
// Pure module: no electron, no node built-ins — unit-testable and importable
// from the (electron-free) TACHI loop.

/** Hard cap so a giant provider payload can't flood the log/UI. */
const DEFAULT_MAX_LEN = 2000

/** How deep a `cause` chain is followed before it is truncated. */
const MAX_CAUSE_DEPTH = 4

/** Keys whose values are huge/noisy and never help a human read the failure. */
const NOISY_KEYS = new Set(['stack', 'cause', 'request', 'response', 'headers', 'responseHeaders'])

export interface FormatErrorOptions {
  /** Truncate the rendered string to this many characters (default 2000). */
  maxLen?: number
}

/**
 * Render any thrown/streamed error value as a single readable line.
 * Never throws, never returns an empty string.
 */
export function formatError(err: unknown, opts: FormatErrorOptions = {}): string {
  const maxLen = opts.maxLen ?? DEFAULT_MAX_LEN
  let text: string
  try {
    text = describe(err, 0, new Set<unknown>())
  } catch {
    // A getter on the error object threw — still say something useful.
    text = 'unknown error (unreadable error object)'
  }
  return clamp(text.trim() || 'unknown error', maxLen)
}

// ── internals ────────────────────────────────────────────────────────────────

function describe(err: unknown, depth: number, seen: Set<unknown>): string {
  if (err === null || err === undefined) return 'unknown error'

  switch (typeof err) {
    case 'string':   return err.trim() || 'unknown error'
    case 'number':
    case 'boolean':
    case 'bigint':   return String(err)
    case 'symbol':   return err.toString()
    case 'function': return `[function ${(err as { name?: string }).name || 'anonymous'}]`
    case 'object':   break
    default:         return String(err)
  }

  if (seen.has(err)) return '[circular error reference]'
  seen.add(err)

  if (Array.isArray(err)) {
    // AI SDK aggregate shapes (e.g. retry errors carry an `errors` array).
    const parts = err.slice(0, 4).map(e => describe(e, depth + 1, seen)).filter(Boolean)
    return parts.length > 0 ? parts.join('; ') : safeJson(err)
  }

  const o = err as Record<string, unknown>
  const name    = typeof o.name === 'string' ? o.name.trim() : ''
  const message = typeof o.message === 'string' ? o.message.trim() : ''

  // The bare "Error" name carries no information (every thrown Error has it),
  // so a plain `new Error('boom')` still renders as "boom" — but a meaningful
  // class name (AI_InvalidToolInputError, TypeError, …) is always kept.
  const usefulName = name && name !== 'Error' ? name : ''

  let head: string
  if (usefulName && message)      head = message.startsWith(usefulName) ? message : `${usefulName}: ${message}`
  else if (usefulName || message) head = usefulName || message
  else                            head = safeJson(o)

  const meta = metaOf(o)
  if (meta) head += ` (${meta})`

  // Follow the cause chain — the real reason usually lives at the bottom.
  if (depth < MAX_CAUSE_DEPTH && o.cause !== undefined && o.cause !== null) {
    const causeText = describe(o.cause, depth + 1, seen)
    if (causeText && causeText !== 'unknown error' && !head.includes(causeText)) {
      head += ` <- caused by: ${causeText}`
    }
  }

  return head
}

/** Provider/tool metadata worth showing inline: HTTP status, error code, tool name. */
function metaOf(o: Record<string, unknown>): string {
  const bits: string[] = []

  const status = firstNumber(o.statusCode, o.status, nested(o.response, 'status'))
  if (status !== null) bits.push(`HTTP ${status}`)

  const code = firstScalar(o.code, o.errorCode, nested(o.error, 'code'))
  if (code !== null && code !== '' && code !== o.name) bits.push(`code ${code}`)

  const type = firstScalar(o.type)
  if (type !== null && type !== '' && type !== code) bits.push(`type ${type}`)

  if (typeof o.toolName === 'string' && o.toolName) bits.push(`tool ${o.toolName}`)

  return bits.join(', ')
}

function nested(v: unknown, key: string): unknown {
  return v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined
}

function firstNumber(...vals: unknown[]): number | null {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

function firstScalar(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/** JSON without circulars, noisy keys, or the "[object Object]" trap. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    const json = JSON.stringify(value, (key, v) => {
      if (NOISY_KEYS.has(key)) return undefined
      if (typeof v === 'bigint') return String(v)
      if (v && typeof v === 'object') {
        if (seen.has(v as object)) return '[circular]'
        seen.add(v as object)
      }
      return v
    })
    if (json && json !== '{}' && json !== '[]' && json !== 'null') return json
  } catch { /* fall through to the typed placeholder */ }
  const ctor = (value as { constructor?: { name?: string } } | null)?.constructor?.name
  return `unknown error (${ctor && ctor !== 'Object' ? ctor : 'non-error value'} with no message)`
}

function clamp(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
}
