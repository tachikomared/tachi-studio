// apps/desktop/electron/services/openai-api-server.ts
//
// Local OpenAI-compatible API server — lets any external tool (IDE plugins,
// scripts, other apps) use Tachi Studio as a drop-in OpenAI/Ollama-style
// endpoint. #1 user-wants item (notes/USER-WANTS-2026-07-08.md): serve the
// bundled FreeLLM router + llama.cpp behind one 127.0.0.1 URL.
//
// Design mirrors the in-process MCP server (mcp-server.ts):
//   - Bind 127.0.0.1:11435 with +5 fallback. 11434 is Ollama's port — sitting
//     right next to it signals "same job, different engine room".
//   - Bearer token via the shared token-store util (${userData}/api-token.enc),
//     revealed only through an explicit IPC channel.
//   - Loopback only; requests never leave the machine except through the
//     engines the user already runs (freellmapi's own upstreams, llama.cpp).
//
// Routes:
//   GET  /                    (no auth) → plain-text banner (Ollama-style liveness)
//   GET  /healthz             (no auth) → { ok, name, version }
//   GET  /v1/models           (Bearer)  → llama.cpp model + freellmapi catalog
//   POST /v1/chat/completions (Bearer)  → verbatim proxy to llama.cpp | freellmapi
//   POST /v1/completions      (Bearer)  → same routing (both engines support it)
//   POST /v1/messages         (Bearer)  → Anthropic Messages shape, translated
//                                         to/from the same OpenAI upstreams
//
// The OpenAI proxy is deliberately byte-verbatim in BOTH directions: the
// client's JSON body is forwarded untouched (so temperature/tools/stream/etc
// all work), and the upstream's SSE/JSON response is piped through
// chunk-by-chunk. We parse the body once only to read `model` for routing.
// /v1/messages is the one translated route (api-messages-translate.ts) — it
// lets Anthropic-SDK tools (Claude Code et al) point at Tachi Studio.

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'

import { loadOrCreateToken, rotateToken, safeCompareToken } from './util/token-store'
import { pickUpstream, mergeModelLists, openAiError, type UpstreamContext } from './util/api-route'
import {
  deliverWebhook,
  parseWebhookPath,
  WEBHOOK_MAX_BODY_BYTES,
} from './webhook-hooks'
import {
  anthropicError,
  anthropicToOpenAiRequest,
  formatSseEvent,
  openAiToAnthropicResponse,
  OpenAiToAnthropicStream,
  type OpenAiChatResponse,
} from './api-messages-translate'

const DEFAULT_PORT = 11435
const PORT_FALLBACK_RANGE = 5
const SERVER_NAME = 'tachi-studio-api'
const SERVER_VERSION = '0.1.0'

// Agent-facing discovery doc served (unauthenticated) at GET /llms.txt — the
// llmstxt.org convention. Documents the LOCAL surfaces only; the public docs
// site ships its own llms.txt for the app as a whole.
const LLMS_TXT = `# Tachi Studio — local API

> Local-first AI workbench running on this machine. This server is its
> OpenAI-compatible API; everything below stays on localhost.

## Endpoints

- GET /healthz — liveness, no auth
- GET /v1/models — available model ids (Bearer)
- POST /v1/chat/completions — OpenAI-compatible chat, streaming supported (Bearer)
- POST /v1/messages — Anthropic Messages-compatible chat, streaming supported (Bearer or x-api-key, same token)

## Auth

All /v1 routes need \`Authorization: Bearer <token>\`. The user reveals the
token in Tachi Studio → Settings → Connections → OPENAI API. There is no
other way to obtain it — ask the user.

## Models

Use model id \`auto\` to let the local router pick (free cloud providers via
the FreeLLM sidecar, or a llama.cpp model when one is being served locally).
GET /v1/models lists everything currently reachable.

## Webhook triggers (inbound only)

POST /webhooks/tradingview/<hookId>?token=<per-hook secret> delivers an alert
to a Nodes-canvas trigger node. The path exists ONLY while a canvas node has
armed that hook, carries its own 32-byte secret (never the Bearer above), and
is rate-limited + size-capped. It is an inbound SIGNAL: the body becomes text
on a node. It cannot place an order or move money.

## Also on this machine

- MCP server: http://127.0.0.1:7421/mcp — tools include conversation_search
  over the user's chat history (token via Settings → Connections → MCP SERVER).
- Flow files: the Nodes tab exports .tachiflow.json (versioned envelope,
  format "tachiflow"), importable by any Tachi Studio.

## Notes

- Requests never leave this machine unless the routed provider is a cloud one.
- PRIVATE MODE in the app blocks all cloud egress; local models keep working.
`
const MAX_BODY_BYTES = 20 * 1024 * 1024 // vision payloads are base64 images
const TOKEN_BASENAME = 'api-token'

export interface ApiServerHandle {
  port: number
  /** OpenAI-style base URL, e.g. http://127.0.0.1:11435/v1 */
  baseUrl: string
  token: string
  stop: () => Promise<void>
}

export interface ApiServerDeps {
  /** Live upstream lookup — read per request so engines can start/stop freely. */
  upstreams: () => UpstreamContext & { freellmApiKey?: string | null }
  /**
   * Start a downloaded-but-unloaded GGUF, fire-and-forget. Called when a
   * request named a local model that is not resident: we answer 503 +
   * Retry-After immediately rather than blocking the caller for a multi-GB
   * load, and the retry lands on a warm engine.
   *
   * Optional so the server stays testable without an engine behind it.
   */
  wakeLocalModel?: (modelId: string | null) => void
}

/** Blank the persisted API key and mint a fresh one (server restart applies it). */
export function rotateOpenAiApiToken(): string {
  return rotateToken(TOKEN_BASENAME)
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, anthropic-version')
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders })
  res.end(body)
}

/** How long a caller should wait before retrying a model we are waking. Loading
 *  a multi-GB GGUF from an SSD is seconds, not milliseconds. */
const WAKE_RETRY_AFTER_S = 5

/**
 * What we say instead of quietly answering from the cloud.
 *
 * The message names the model and the reason, because the alternative this
 * replaces was indistinguishable from success: the caller asked for a model on
 * their own machine, a cloud provider answered, and the response looked the
 * same. A 503 the client can retry is worth more than an answer they cannot
 * trust the origin of.
 */
function wakeMessage(modelId: string | null): string {
  return modelId
    ? `"${modelId}" is on this machine but not loaded — it is being started now. Retry in a few seconds. `
      + 'This request was NOT sent to a cloud provider.'
    : 'no local model is downloaded on this machine, so a local-only request cannot be served. '
      + 'This request was NOT sent to a cloud provider.'
}

function bearerFrom(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? ''
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim()
  // Anthropic SDKs (Claude Code included) send the key as `x-api-key` rather
  // than a Bearer header — accept the same token there.
  const xApiKey = req.headers['x-api-key']
  return typeof xApiKey === 'string' ? xApiKey.trim() : ''
}

function readBody(req: IncomingMessage, cap: number = MAX_BODY_BYTES): Promise<Buffer | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > cap) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(null))
  })
}

async function tryBind(server: HttpServer, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const onError = () => { server.off('listening', onListening); resolve(false) }
    const onListening = () => { server.off('error', onError); resolve(true) }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Pipe an upstream fetch Response into the node ServerResponse verbatim —
 * works for both SSE streams and plain JSON bodies. Client disconnect aborts
 * the upstream via the caller's AbortController.
 */
async function pipeUpstream(upstream: Response, res: ServerResponse): Promise<void> {
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    // SSE hygiene — harmless for JSON responses.
    'Cache-Control': 'no-cache',
  })
  const reader = upstream.body?.getReader()
  if (!reader) { res.end(); return }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
  } catch { /* client hung up or upstream died — nothing to salvage */ }
  res.end()
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function startOpenAiApiServer(deps: ApiServerDeps): Promise<ApiServerHandle> {
  const token = loadOrCreateToken(TOKEN_BASENAME)

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    setCors(res)
    const method = req.method ?? 'GET'
    const rawUrl = req.url ?? '/'
    const qIndex = rawUrl.indexOf('?')
    const path = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex)
    const search = qIndex === -1 ? '' : rawUrl.slice(qIndex + 1)

    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    // Unauthenticated liveness surface (mirrors Ollama's "GET / → banner").
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('Tachi Studio local API is running')
      return
    }
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, JSON.stringify({ ok: true, name: SERVER_NAME, version: SERVER_VERSION }))
      return
    }
    // llms.txt discovery surface (no auth — it documents how to GET the auth).
    // Agents running on this machine can learn the whole local surface from
    // one conventional fetch (llmstxt.org).
    if (method === 'GET' && path === '/llms.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(LLMS_TXT)
      return
    }

    // ── Inbound webhook triggers (Nodes canvas) ─────────────────────────────
    //
    // NOT Bearer-gated: this is the one route a THIRD PARTY is invited to call,
    // so it carries its own per-hook 32-byte secret instead (webhook-hooks.ts).
    // Handing out the app-wide /v1 bearer to TradingView would be handing out
    // the whole local LLM surface. The route is DEFAULT-CLOSED — the registry is
    // empty until a canvas node arms a hook, so everything below 404s until then.
    //
    // Inbound signal ONLY: the alert becomes text on a node. Nothing here can
    // place an order or move money.
    if (path.startsWith('/webhooks/')) {
      const route = parseWebhookPath(path)
      if (!route) {
        sendJson(res, 404, JSON.stringify({ ok: false, error: 'no such webhook' }))
        return
      }
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST')
        sendJson(res, 405, JSON.stringify({ ok: false, error: 'webhooks accept POST only' }))
        return
      }
      // Read with the WEBHOOK cap, not the 20 MB vision cap — an alert is a
      // sentence. `null` means the socket was destroyed mid-read for exceeding
      // it, which deliverWebhook reports as 413 through the same code path.
      const body = await readBody(req, WEBHOOK_MAX_BODY_BYTES)
      const headerToken = req.headers['x-webhook-token']
      const queryToken = new URLSearchParams(search).get('token') ?? ''
      const supplied = typeof headerToken === 'string' && headerToken.trim()
        ? headerToken.trim()
        : queryToken
      const result = deliverWebhook({
        source: route.source,
        hookId: route.hookId,
        token: supplied,
        body: body ?? Buffer.alloc(0),
        contentType: typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined,
        oversized: body === null,
      })
      if (!result.ok) {
        if (result.retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
        sendJson(res, result.status, JSON.stringify({ ok: false, error: result.message }))
        return
      }
      sendJson(res, 200, JSON.stringify({ ok: true, receivedAt: result.alert.receivedAt, bytes: result.alert.bytes }))
      return
    }

    // Everything under /v1 is Bearer-gated. /v1/messages speaks the Anthropic
    // error envelope; every other route speaks OpenAI's.
    if (!safeCompareToken(bearerFrom(req), token)) {
      const authMessage = 'invalid or missing API key — copy it from Tachi Studio → Settings → Connections → OPENAI API'
      if (path === '/v1/messages') {
        sendJson(res, 401, anthropicError('authentication_error', authMessage))
      } else {
        sendJson(res, 401, openAiError(authMessage, 'invalid_request_error', 'invalid_api_key'))
      }
      return
    }

    const up = deps.upstreams()

    if (method === 'GET' && path === '/v1/models') {
      // llama.cpp entry + freellmapi catalog (best-effort; empty on router-down).
      let freellmData: Array<{ id?: unknown }> | null = null
      if (up.freellmPort && up.freellmApiKey) {
        try {
          const r = await fetch(`http://127.0.0.1:${up.freellmPort}/v1/models`, {
            headers: { Authorization: `Bearer ${up.freellmApiKey}` },
            signal: AbortSignal.timeout(10_000) as AbortSignal,
          })
          if (r.ok) {
            const j = await r.json() as { data?: Array<{ id?: unknown }> }
            if (Array.isArray(j?.data)) freellmData = j.data
          }
        } catch { /* router down mid-request — list llama only */ }
      }
      sendJson(res, 200, JSON.stringify(mergeModelLists(freellmData, up.llamaModelId)))
      return
    }

    // Anthropic Messages-compatible route — translated (not verbatim) proxy to
    // the same OpenAI upstreams. The anthropic-version header is accepted
    // leniently (any value or absent): both engines behind us are versionless.
    if (method === 'POST' && path === '/v1/messages') {
      const body = await readBody(req)
      if (body === null) {
        sendJson(res, 413, anthropicError('invalid_request_error', 'request body too large or unreadable'))
        return
      }
      let parsedBody: unknown
      try {
        parsedBody = JSON.parse(body.toString('utf8'))
      } catch {
        sendJson(res, 400, anthropicError('invalid_request_error', 'request body is not valid JSON'))
        return
      }
      const translated = anthropicToOpenAiRequest(parsedBody)
      if (!translated.ok) {
        sendJson(res, translated.status, anthropicError(translated.errorType, translated.message))
        return
      }

      const pick = pickUpstream(translated.request.model, up)
      if (pick.kind === 'none') {
        sendJson(res, 503, anthropicError('api_error', pick.reason))
        return
      }
      if (pick.kind === 'llama-not-loaded') {
        // Same refusal on the Anthropic-shaped route. A client that asked for a
        // model on this machine is told to retry, never quietly given a cloud
        // one — see the refusal rule in util/api-route.ts.
        sendJson(res, 503, anthropicError('api_error', wakeMessage(pick.modelId)),
          { 'Retry-After': String(WAKE_RETRY_AFTER_S) })
        deps.wakeLocalModel?.(pick.modelId)
        return
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (pick.kind === 'freellm' && up.freellmApiKey) {
        headers.Authorization = `Bearer ${up.freellmApiKey}`
      }

      // Same disconnect hygiene as the OpenAI route: a closed consumer aborts
      // the upstream generation instead of leaving it running.
      const abort = new AbortController()
      res.on('close', () => { if (!res.writableEnded) abort.abort() })

      let upstream: Response
      try {
        upstream = await fetch(`http://127.0.0.1:${pick.port}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(translated.request),
          signal: abort.signal,
        })
      } catch {
        if (!res.headersSent) {
          sendJson(res, 502, anthropicError('api_error', `could not reach the ${pick.kind} engine`))
        }
        return
      }

      if (!upstream.ok) {
        // Re-shape the upstream's OpenAI error into the Anthropic envelope.
        let message = `upstream ${pick.kind} error (HTTP ${upstream.status})`
        try {
          const j = await upstream.json() as { error?: { message?: unknown } }
          if (typeof j?.error?.message === 'string') message = j.error.message
        } catch { /* non-JSON error body — keep the generic message */ }
        sendJson(res, upstream.status, anthropicError(
          upstream.status === 429 ? 'rate_limit_error' : 'api_error', message,
        ))
        return
      }

      if (translated.request.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        const streamTranslator = new OpenAiToAnthropicStream(translated.request.model)
        const reader = upstream.body?.getReader()
        const decoder = new TextDecoder()
        try {
          if (reader) {
            while (true) {
              // eslint-disable-next-line no-await-in-loop
              const { done, value } = await reader.read()
              if (done) break
              for (const ev of streamTranslator.pushSse(decoder.decode(value, { stream: true }))) {
                res.write(formatSseEvent(ev))
              }
            }
          }
          // finish() is idempotent — a no-op when [DONE] already closed it.
          for (const ev of streamTranslator.finish()) res.write(formatSseEvent(ev))
        } catch { /* client hung up or upstream died — nothing to salvage */ }
        res.end()
        return
      }

      let upstreamJson: unknown
      try {
        upstreamJson = await upstream.json()
      } catch {
        sendJson(res, 502, anthropicError('api_error', `the ${pick.kind} engine returned a non-JSON body`))
        return
      }
      sendJson(res, 200, JSON.stringify(
        openAiToAnthropicResponse(upstreamJson as OpenAiChatResponse, translated.request.model),
      ))
      return
    }

    if (method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/completions')) {
      const body = await readBody(req)
      if (body === null) {
        sendJson(res, 413, openAiError('request body too large or unreadable', 'invalid_request_error'))
        return
      }
      let model: string | undefined
      try {
        const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown }
        if (typeof parsed.model === 'string') model = parsed.model
      } catch {
        sendJson(res, 400, openAiError('request body is not valid JSON', 'invalid_request_error'))
        return
      }

      const pick = pickUpstream(model, up)
      if (pick.kind === 'none') {
        sendJson(res, 503, openAiError(pick.reason, 'api_error', 'engine_unavailable'))
        return
      }
      if (pick.kind === 'llama-not-loaded') {
        sendJson(res, 503, openAiError(wakeMessage(pick.modelId), 'api_error', 'model_not_loaded'),
          { 'Retry-After': String(WAKE_RETRY_AFTER_S) })
        deps.wakeLocalModel?.(pick.modelId)
        return
      }

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (pick.kind === 'freellm' && up.freellmApiKey) {
        headers.Authorization = `Bearer ${up.freellmApiKey}`
      }

      // Abort the upstream call when the client disconnects mid-stream, so a
      // closed SSE consumer doesn't leave a running generation behind.
      const abort = new AbortController()
      res.on('close', () => { if (!res.writableEnded) abort.abort() })

      let upstream: Response
      try {
        upstream = await fetch(`http://127.0.0.1:${pick.port}${path}`, {
          method: 'POST',
          headers,
          // Buffer isn't in undici's BodyInit typing — hand it the raw bytes.
          body: new Uint8Array(body),
          signal: abort.signal,
        })
      } catch {
        if (!res.headersSent) {
          sendJson(res, 502, openAiError(`could not reach the ${pick.kind} engine`, 'api_error', 'engine_unreachable'))
        }
        return
      }
      await pipeUpstream(upstream, res)
      return
    }

    sendJson(res, 404, openAiError(`unknown route: ${method} ${path}`, 'invalid_request_error'))
  }

  const httpServer = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, openAiError('internal error', 'api_error'))
      } else {
        try { res.end() } catch { /* already gone */ }
      }
    })
  })

  let boundPort = 0
  for (let i = 0; i <= PORT_FALLBACK_RANGE; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (await tryBind(httpServer, DEFAULT_PORT + i)) { boundPort = DEFAULT_PORT + i; break }
  }
  if (!boundPort) {
    throw new Error(`local API server: could not bind any port in ${DEFAULT_PORT}..${DEFAULT_PORT + PORT_FALLBACK_RANGE}`)
  }

  const baseUrl = `http://127.0.0.1:${boundPort}/v1`
  console.log(`[api-server] OpenAI-compatible server listening on ${baseUrl} (token hidden)`)

  const stop = async (): Promise<void> => {
    await new Promise<void>(resolve => { httpServer.close(() => resolve()) })
  }

  return { port: boundPort, baseUrl, token, stop }
}
