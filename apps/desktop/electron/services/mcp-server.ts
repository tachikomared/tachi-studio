// apps/desktop/electron/services/mcp-server.ts
//
// In-process Model-Context-Protocol server. Inspired by Clauge's auto-start
// pattern: bind 127.0.0.1:7421 (with +5 fallback), gate with a bearer token
// stored encrypted via Electron's safeStorage, attribute every request to its
// caller via User-Agent + clientInfo, and expose a curated set of code-centric
// tools (see ./mcp/tools/*).
//
// Implementation rules (per the parent task spec):
//   1. Port fallback 7421..7426, 127.0.0.1 only.
//   2. Token: randomUUID, persisted encrypted in ${userData}/mcp-token.enc.
//      Never logged. Reaches the renderer only via 'mcp:reveal-token' IPC.
//   3. Actor attribution: User-Agent slug match → clientInfo.name → 'agent'.
//   4. 202 Accepted for notifications (rmcp / Codex compat).
//   5. Bearer auth: strict equality. 401 + JSON-RPC -32001 on mismatch.
//   6. Single shared Server + StreamableHTTPServerTransport (stateless).
//   7. Tools live in ./mcp/tools/<group>.ts; each exports register(registry, deps).

import { app } from 'electron'
import express, { type Request, type Response } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { join } from 'node:path'

import { loadOrCreateToken, rotateToken, safeCompareToken } from './util/token-store'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js'

import type { ToolDef, ToolRegistry } from '../mcp/registry'
import { newRegistry } from '../mcp/registry'
import { isMcpToolAllowed } from '../mcp/mcp-permission'
import { McpRateLimiter, tierForTool } from '../mcp/rate-limit'
import { appendAudit } from '../mcp/audit-log'
import { HintTracker } from '../mcp/tool-hints'
import { loadSettings } from './settings-store'
import * as fsTools from '../mcp/tools/fs'
import * as gitTools from '../mcp/tools/git'
import * as fetchTools from '../mcp/tools/fetch'
import * as llmTools from '../mcp/tools/llm'
import * as historyTools from '../mcp/tools/history'
import * as metaTools from '../mcp/tools/meta'
import { compactResponse, registerExpandOutput } from '../mcp/response-compactor'

// Per-request actor context. Scoped via AsyncLocalStorage so two concurrent
// /mcp requests can't mis-attribute each other's tool calls (previously a
// module-scoped `let` was vulnerable to the await between handleMcp setting
// the actor and the CallTool handler reading it).
const actorContext = new AsyncLocalStorage<string>()

export interface McpHandle {
  port: number
  url: string
  token: string
  stop: () => Promise<void>
}

export interface McpDeps {
  /** Lookup at request time so the workspace can change without restarting the server. */
  workspaceRoot: () => string
}

const DEFAULT_PORT = 7421
const PORT_FALLBACK_RANGE = 5
const SERVER_NAME = 'tachidesk-mcp'
const SERVER_VERSION = '0.1.0'

// ── Token storage ─────────────────────────────────────────────────────────────
//
// Delegated to the shared token-store util (safeStorage-encrypted with a
// chmod-600 plaintext fallback on keyring-less Linux). File names are
// unchanged across the extraction (${userData}/mcp-token.enc / .txt) so
// tokens minted by older builds keep working.

const TOKEN_BASENAME = 'mcp-token'

export function rotateMcpToken(): string {
  return rotateToken(TOKEN_BASENAME)
}

// ── Actor attribution ─────────────────────────────────────────────────────────

const ACTOR_SLUGS = ['claude', 'codex', 'gemini', 'opencode', 'aider', 'cline', 'cursor', 'continue', 'sourcegraph']

function actorFromUserAgent(ua: string | undefined): string | null {
  if (!ua) return null
  const lc = ua.toLowerCase()
  for (const slug of ACTOR_SLUGS) {
    if (lc.includes(slug)) return slug
  }
  return null
}

// ── Tool result wrapping ──────────────────────────────────────────────────────
//
// The MCP spec wants tool results as { content: [{type:'text',text:string}, ...],
// structuredContent?: object, isError?: boolean }. We JSON-stringify the tool's
// return value into a single text content block AND attach it as
// structuredContent for callers that prefer parsed JSON.

function wrapToolResult(value: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } {
  const json = JSON.stringify(value, null, 2)
  const out: { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } = {
    content: [{ type: 'text', text: json }],
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    out.structuredContent = value as Record<string, unknown>
  }
  return out
}

function wrapToolError(message: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true }
}

// ── HTTP wiring ───────────────────────────────────────────────────────────────

interface PerRequestContext {
  actor: string
}

async function tryBind(httpServer: HttpServer, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const onError = (err: NodeJS.ErrnoException) => {
      httpServer.off('listening', onListening)
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false)
      else resolve(false)
    }
    const onListening = () => {
      httpServer.off('error', onError)
      resolve(true)
    }
    httpServer.once('error', onError)
    httpServer.once('listening', onListening)
    httpServer.listen(port, '127.0.0.1')
  })
}

// ── Main entry ────────────────────────────────────────────────────────────────

export interface McpServerCore {
  /** The MCP protocol server with list/call handlers wired (no transport yet). */
  server: Server
  /** Absolute path to the JSONL audit trail this server's CallTool handler writes. */
  auditFile: string
  /** The per-tier rate limiter (one instance per server lifetime). */
  rateLimiter: McpRateLimiter
}

/**
 * Build the MCP protocol Server with its tool registry and the
 * permission → rate-limit → audit → dispatch handler wired up — but DO NOT
 * connect any transport. startMcpServer() connects it to StreamableHTTP over a
 * bound port; tests connect it to an in-memory transport to exercise the
 * composed dispatch pipeline (auth aside) without binding a socket.
 */
export function buildMcpServer(deps: McpDeps): McpServerCore {
  // 1. Build the registry and let every tool module attach itself.
  const registry: ToolRegistry = newRegistry()
  fsTools.register(registry, { workspaceRoot: deps.workspaceRoot })
  gitTools.register(registry, { workspaceRoot: deps.workspaceRoot })
  fetchTools.register(registry)
  llmTools.register(registry)
  historyTools.register(registry)
  metaTools.register(registry)
  // CONTEXT-ECONOMY P1: recovery tool for compacted large tool responses.
  registerExpandOutput(registry)

  // Per-tier sliding-window rate limiter (STEAL 2026-06-12 cluster B). One
  // instance per server lifetime; counters reset on app restart by design.
  const rateLimiter = new McpRateLimiter()
  // Durable audit trail — one JSONL line per tool call, every exit path.
  const auditFile = join(app.getPath('userData'), 'mcp-audit.jsonl')
  // Session-aware next-tool suggestions (per-actor recency window).
  const hintTracker = new HintTracker()

  // 2. Build the MCP Server + register list/call handlers.
  const mcp = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = []
    for (const [name, def] of registry.entries()) {
      tools.push({
        name,
        description: def.description,
        // The MCP spec calls this `inputSchema`. We store it as `schema` in our
        // registry; expose it verbatim. The schema must be an object schema.
        inputSchema: def.schema as { type: 'object'; properties?: Record<string, unknown>; required?: string[] },
      })
    }
    return { tools }
  })

  // Per-request actor is read from the module-level AsyncLocalStorage which
  // handleMcp populates via actorContext.run(). This avoids the race that
  // existed when `currentActor` was a closure-scoped `let` mutated between
  // overlapping HTTP requests.
  mcp.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
    const name = req.params.name
    const args = (req.params.arguments ?? {}) as unknown
    const def: ToolDef | undefined = registry.get(name)
    if (!def) return wrapToolError(`unknown tool: ${name}`)
    // Permission-mode gate (Claude-style scopes, user-selected in Settings).
    // Read per call so a Settings change applies immediately, no server restart.
    // Unknown tools only pass in 'full'. FAIL-CLOSED: if mcpMode is somehow
    // unset, default to read_only (never network egress) rather than 'full' —
    // this server is reachable on loopback by any local process.
    const mode = loadSettings().mcpMode ?? 'read_only'
    const actor = actorContext.getStore() ?? 'agent'
    const startedAt = Date.now()
    if (!isMcpToolAllowed(name, mode)) {
      appendAudit(auditFile, { ts: startedAt, actor, tool: name, status: 'denied', durationMs: 0, detail: `mcpMode=${mode}` })
      return wrapToolError(
        `tool "${name}" is blocked by the MCP permission mode "${mode}" — change the mode in Settings if this was intended`,
      )
    }
    const rl = rateLimiter.check(name)
    if (!rl.allowed) {
      appendAudit(auditFile, { ts: startedAt, actor, tool: name, status: 'denied', durationMs: 0, detail: 'rate-limited' })
      return wrapToolError(
        `rate limit: too many "${tierForTool(name)}"-tier calls — retry after ${Math.ceil(rl.retryAfterMs / 1000)} s`,
      )
    }
    try {
      const value = await def.handler(args, actor)
      appendAudit(auditFile, { ts: startedAt, actor, tool: name, status: 'ok', durationMs: Date.now() - startedAt })
      // next_tool_suggestions (STEAL 2026-06-12 cluster B): attach navigational
      // hints to plain-object results BEFORE compaction so they survive it.
      const hints = hintTracker.afterCall(actor, name)
      const enriched = (hints.length > 0 && value !== null && typeof value === 'object' && !Array.isArray(value))
        ? { ...(value as Record<string, unknown>), next_tool_suggestions: hints }
        : value
      // CONTEXT-ECONOMY P1: compact large results (with expand_output recovery)
      // before they reach the external agent's context. Verbatim tools (file
      // reads) and small results pass through untouched. When compacted we drop
      // structuredContent so the full payload isn't smuggled back in whole.
      const json = JSON.stringify(enriched, null, 2)
      const c = compactResponse(name, json)
      if (!c.compacted) return wrapToolResult(enriched)
      return { content: [{ type: 'text' as const, text: c.text }] }
    } catch (e) {
      const message = (e as Error).message || String(e)
      appendAudit(auditFile, { ts: startedAt, actor, tool: name, status: 'error', durationMs: Date.now() - startedAt, detail: message.slice(0, 200) })
      return wrapToolError(message)
    }
  })

  return { server: mcp, auditFile, rateLimiter }
}

export async function startMcpServer(deps: McpDeps): Promise<McpHandle> {
  const { server: mcp } = buildMcpServer(deps)

  // 3. StreamableHTTP transport (stateless).
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await mcp.connect(transport)

  // 4. Bearer token (load once for the life of the handle; rotate via stop+restart).
  const token = loadOrCreateToken(TOKEN_BASENAME)

  // 5. Express app — only one route: POST/GET /mcp. Plus a tiny /healthz so the
  //    UI can probe liveness without burning a token.
  const httpApp = express()
  httpApp.use(express.json({ limit: '2mb' }))

  httpApp.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION })
  })

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    // Bearer auth — constant-time compare via crypto.timingSafeEqual.
    const auth = req.header('authorization') ?? ''
    const supplied = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
    if (!safeCompareToken(supplied, token)) {
      // JSON-RPC error code -32001 for "unauthorized" (custom range).
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'unauthorized' },
        id: (req.body as { id?: unknown })?.id ?? null,
      })
      return
    }

    // Actor attribution: User-Agent slug → clientInfo.name (from initialize body) → 'agent'.
    const ua = req.header('user-agent')
    let actor = actorFromUserAgent(ua)
    if (!actor) {
      const body = req.body as { method?: string; params?: { clientInfo?: { name?: string } } } | undefined
      if (body?.method === 'initialize' && typeof body?.params?.clientInfo?.name === 'string') {
        actor = body.params.clientInfo.name
      }
    }
    const resolvedActor = actor ?? 'agent'

    // 202 Accepted is required for JSON-RPC notifications (no `id` field) per
    // rmcp / Codex compat — the transport itself handles this via res.writeHead.
    // Wrap the transport call in AsyncLocalStorage so the CallTool handler
    // reads THIS request's actor (immune to concurrent /mcp overlap).
    try {
      await actorContext.run(resolvedActor, async () => {
        await transport.handleRequest(req, res, req.body)
      })
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `internal error: ${(e as Error).message}` },
          id: (req.body as { id?: unknown })?.id ?? null,
        })
      }
    }
  }

  httpApp.post('/mcp', handleMcp)
  httpApp.get('/mcp', handleMcp)
  httpApp.delete('/mcp', handleMcp)

  // 6. Try ports DEFAULT_PORT..DEFAULT_PORT+PORT_FALLBACK_RANGE.
  let httpServer: HttpServer | null = null
  let boundPort = 0
  for (let i = 0; i <= PORT_FALLBACK_RANGE; i++) {
    const candidate = DEFAULT_PORT + i
    const s = createHttpServer(httpApp)
    // eslint-disable-next-line no-await-in-loop
    const ok = await tryBind(s, candidate)
    if (ok) {
      httpServer = s
      boundPort = candidate
      break
    }
    // Otherwise tear it down and try the next port.
    try { s.close() } catch { /* ignore */ }
  }
  if (!httpServer) {
    await transport.close().catch(() => {})
    throw new Error(`MCP server: could not bind to any port in ${DEFAULT_PORT}..${DEFAULT_PORT + PORT_FALLBACK_RANGE}`)
  }

  const url = `http://127.0.0.1:${boundPort}/mcp`
  // Surface a one-line startup log so devs can spot it in the Electron console —
  // intentionally does NOT log the token.
  console.log(`[mcp] in-process server listening on ${url} (token hidden)`)

  const stop = async (): Promise<void> => {
    try { await transport.close() } catch { /* ignore */ }
    try { await mcp.close() } catch { /* ignore */ }
    await new Promise<void>(resolve => {
      if (!httpServer) return resolve()
      httpServer.close(() => resolve())
    })
  }

  return { port: boundPort, url, token, stop }
}
