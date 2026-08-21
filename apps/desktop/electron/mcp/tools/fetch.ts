// apps/desktop/electron/mcp/tools/fetch.ts
//
// http_fetch — outbound HTTP from external agents via the in-process MCP server.
//
// Policy: allow any URL with a 5 MiB response cap and a 30 s timeout, subject
// to the PRIVATE MODE egress gate (`checkUrlEgress`). The MCP server itself
// is bound to 127.0.0.1, so only the user's local processes can reach this
// tool — but anything we hit goes out to the network with Tachi's IP. When
// PRIVATE MODE is on, only loopback hosts are reachable.

import type { ToolRegistry } from '../registry'
import { checkUrlEgressSafe } from '../../services/egress-policy'
import { wrapUntrusted } from '../../services/prompt-sandbox'
import { resolveAndAssertSafe } from '../../services/ssrf-guard'
import { assertString, optionalString } from './args'

const MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const HARD_TIMEOUT_MS = 120_000
const MAX_REDIRECT_HOPS = 10

/**
 * Full egress screen for ONE url: protocol allowlist + PRIVATE-MODE gate +
 * SSRF DNS screen with a rebind-TOCTOU recheck. Throws on any block. Shared by
 * the initial request AND every redirect hop (STEAL 2026-07-08, firecrawl:
 * a clean url can 30x to an internal host that never faced the guards).
 */
async function assertUrlEgressSafe(rawUrl: string): Promise<URL> {
  let parsed: URL
  try { parsed = new URL(rawUrl) } catch { throw new Error(`invalid URL: ${rawUrl}`) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http:// and https:// URLs are allowed')
  }
  const decision = await checkUrlEgressSafe(parsed.toString())
  if (!decision.allowed) throw new Error(decision.reason)
  // DNS-rebind TOCTOU close: resolve twice and fail if the address set moved
  // between validation and (the caller's imminent) connect. IP-literal hosts
  // resolve to the literal both times — trivially equal.
  const validatedIps = await resolveAndAssertSafe(parsed.toString())
  const recheckIps = await resolveAndAssertSafe(parsed.toString())
  if (validatedIps.join(',') !== recheckIps.join(',')) {
    throw new Error(
      `http_fetch blocked: DNS for "${parsed.hostname}" changed between validation ` +
      `and fetch (possible DNS-rebind). Validated [${validatedIps.join(', ')}], ` +
      `re-resolved [${recheckIps.join(', ')}].`,
    )
  }
  return parsed
}

export function register(registry: ToolRegistry): void {
  registry.set('http_fetch', {
    description: 'Fetch a URL and return the response. Body capped at 5 MiB; binary responses are base64-encoded. Default timeout 30 s.',
    schema: {
      type: 'object',
      properties: {
        url:     { type: 'string', description: 'http:// or https:// URL.' },
        method:  { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body:    { type: 'string', description: 'Request body (POST/PUT/PATCH/DELETE). UTF-8.' },
        timeoutMs: { type: 'integer', description: `Per-request timeout (default ${DEFAULT_TIMEOUT_MS}, max ${HARD_TIMEOUT_MS}).` },
      },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const rawUrl = assertString(args, 'url')
      // Validate the requested URL (protocol + egress + SSRF + rebind).
      let parsed = await assertUrlEgressSafe(rawUrl)

      const method = (optionalString(args, 'method') ?? 'GET').toUpperCase()
      const body = optionalString(args, 'body')
      const headersRaw = (args as { headers?: unknown })?.headers
      const headers: Record<string, string> = {}
      if (headersRaw !== undefined) {
        if (typeof headersRaw !== 'object' || headersRaw === null || Array.isArray(headersRaw)) {
          throw new Error('headers must be an object of string→string')
        }
        for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
          if (typeof v !== 'string') throw new Error(`header ${k} must be a string`)
          headers[k] = v
        }
      }
      const timeoutRaw = (args as { timeoutMs?: unknown })?.timeoutMs
      const timeoutMs = typeof timeoutRaw === 'number'
        ? Math.max(1, Math.min(HARD_TIMEOUT_MS, Math.floor(timeoutRaw)))
        : DEFAULT_TIMEOUT_MS

      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(new Error(`http_fetch: timeout after ${timeoutMs} ms`)), timeoutMs)
      // Follow redirects MANUALLY (redirect:'manual') so each Location is run
      // through assertUrlEgressSafe BEFORE we connect to it — 'follow' would
      // deliver the request to an internal redirect target unscreened.
      let res: Response
      try {
        let currentUrl = parsed.toString()
        for (let hop = 0; ; hop++) {
          res = await fetch(currentUrl, {
            method,
            headers,
            body: body !== undefined ? body : undefined,
            signal: ctrl.signal as AbortSignal,
            redirect: 'manual',
          })
          if (res.status < 300 || res.status >= 400) break
          const location = res.headers.get('location')
          if (!location) break                              // 3xx without Location — treat as final
          if (hop >= MAX_REDIRECT_HOPS) throw new Error(`http_fetch: too many redirects (>${MAX_REDIRECT_HOPS})`)
          const nextUrl = new URL(location, currentUrl).toString()
          parsed = await assertUrlEgressSafe(nextUrl)       // screen the hop before following
          currentUrl = nextUrl
        }
      } catch (e) {
        clearTimeout(timer)
        throw new Error(`http_fetch failed: ${(e as Error).message}`)
      }
      clearTimeout(timer)

      // Read body in chunks, enforce cap, decide on text vs base64.
      const reader = res.body?.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      let truncated = false
      if (reader) {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          total += value.byteLength
          if (total > MAX_BYTES) {
            truncated = true
            // Keep what we have up to the cap.
            const excess = total - MAX_BYTES
            if (excess < value.byteLength) {
              chunks.push(value.subarray(0, value.byteLength - excess))
            }
            try { await reader.cancel() } catch { /* ignore */ }
            break
          }
          chunks.push(value)
        }
      }
      const buf = Buffer.concat(chunks.map(u => Buffer.from(u)))
      const contentType = res.headers.get('content-type') ?? ''
      const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|.+\+(json|xml))/i.test(contentType)
      const responseHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => { responseHeaders[k] = v })

      // Prompt-injection sandbox (STEAL 2026-06-12 #2): text bodies are about
      // to enter some agent's LLM context — wrap them so embedded instructions
      // are delimited as data. Binary bodies are base64 (not prompt-readable).
      const rawBody = isText ? buf.toString('utf8') : buf.toString('base64')
      return {
        url: res.url,
        status: res.status,
        statusText: res.statusText,
        headers: responseHeaders,
        body: isText ? wrapUntrusted(rawBody, `http_fetch:${parsed.hostname}`) : rawBody,
        bodyEncoding: isText ? 'utf8' : 'base64',
        bytes: total,
        truncated,
        ...(isText ? { sandboxed: true } : {}),
      }
    },
  })
}
