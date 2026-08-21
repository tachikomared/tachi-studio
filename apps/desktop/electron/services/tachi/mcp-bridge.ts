// apps/desktop/electron/services/tachi/mcp-bridge.ts
//
// Bridge user-configured MCP servers (mcp-manager.ts) into the TACHI loop as
// plain tool descriptors. Each RUNNING server's tools become `mcp_<server>_<tool>`
// entries the loop can register with AI SDK `tool()`; the execute closure calls
// the server through callMcpTool and prompt-sandbox-wraps the result — a
// third-party server's output is DATA, never instructions.
//
// mcp-manager is imported DYNAMICALLY: it touches electron's `app` at module
// load, and this module's pure helpers (sanitizeMcpName/dedupeMcpName) are
// imported by unit tests — the top-level graph stays electron-free, same
// convention as loop.ts's injected tools.

import { wrapUntrusted } from '../prompt-sandbox'

/** One MCP tool, flattened to what the loop needs to register it. */
export interface McpToolDescriptor {
  name:        string
  description: string
  inputSchema: Record<string, unknown>
  execute:     (args: Record<string, unknown>) => Promise<string>
}

/** Hard cap on a bridged tool result (chars) — MCP servers can return anything. */
const MAX_RESULT_CHARS = 20_000
/** Model-facing tool names must stay short (provider limits are typically 64). */
const MAX_NAME_CHARS = 60

/** Lowercase, keep [a-z0-9_] only, collapse runs of '_', trim edge '_'. */
function sanitizeSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * Build the model-facing tool name: `mcp__<server>__<tool>`, capped at 60 chars.
 * The DOUBLE underscore is the namespace separator (server ids and tool names
 * may each contain single underscores, so a single separator would be
 * ambiguous); it also matches the convention other MCP hosts use, which helps
 * models that have seen those names. Pure — exported for unit tests. Collision
 * handling lives in dedupeMcpName (sanitization is lossy, e.g. "wea/ther" ≡
 * "wea ther").
 *
 * NOTE: the `mcp_` prefix is load-bearing — permission-service.ts keys its
 * "third-party tool, always prompt" rule off `startsWith('mcp_')`.
 */
export function sanitizeMcpName(server: string, tool: string): string {
  const name = `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`
    .replace(/_{3,}/g, '__')  // an empty segment would leave 3+ underscores
    .replace(/_+$/, '')       // trailing separator when the tail segment is empty
  return name.slice(0, MAX_NAME_CHARS).replace(/_+$/, '')
}

/**
 * Resolve a name collision with a numeric suffix (_2, _3, …), keeping the
 * result within the 60-char cap. Pure — exported for unit tests.
 */
export function dedupeMcpName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  for (let i = 2; ; i++) {
    const suffix = `_${i}`
    const candidate = name.slice(0, MAX_NAME_CHARS - suffix.length).replace(/_+$/, '') + suffix
    if (!taken.has(candidate)) return candidate
  }
}

/** Options for buildMcpToolDescriptors. */
export interface BuildMcpToolsOptions {
  /**
   * PRIVATE MODE. Servers that reach the public internet are dropped; local-only
   * ones (Filesystem, SQLite, Memory, Git — `requiresNetwork: false` in the
   * marketplace catalog) still contribute their tools, because keeping local
   * tools working offline is the whole point of the mode. mcp-manager.startServer
   * refuses to spawn network servers under the same rule; this is the second
   * fence, for a server already running when the user flipped the toggle.
   */
  privateMode?: boolean
}

/**
 * Enumerate every tool on every RUNNING user-configured MCP server as a
 * descriptor the loop can register. ENABLED-but-stopped servers are connected
 * first (lazy connect at session start), so a server the user switched on in
 * Settings contributes tools without a manual START. A server that fails to
 * start or list is skipped (one flaky server must not break the others); no
 * servers → empty array.
 */
export async function buildMcpToolDescriptors(
  opts: BuildMcpToolsOptions = {},
): Promise<McpToolDescriptor[]> {
  const mcp = await import('../mcp-manager')
  const descriptors: McpToolDescriptor[] = []
  const taken = new Set<string>()

  // Lazy connect: bring up anything the user marked ENABLED. Never throws —
  // per-server failures land on the server's own status row.
  try { await mcp.ensureEnabledServersStarted() } catch { /* best-effort */ }

  for (const server of mcp.listServers()) {
    if (server.status !== 'running') continue
    // Egress: in PRIVATE MODE only network-free servers may contribute tools.
    if (opts.privateMode && server.requiresNetwork !== false) continue
    let tools: Awaited<ReturnType<typeof mcp.listTools>>
    try {
      tools = await mcp.listTools(server.name)
    } catch {
      continue // server died between listServers and listTools → skip it
    }
    for (const t of tools) {
      const name = dedupeMcpName(sanitizeMcpName(server.name, t.name), taken)
      taken.add(name)
      const description = `[${server.name}] ${t.description || t.name}`.slice(0, 300)
      // Pass the server's JSON Schema through untouched; an absent/empty schema
      // falls back to a bare object schema so registration never fails on it.
      const inputSchema =
        t.inputSchema && typeof t.inputSchema === 'object' && Object.keys(t.inputSchema).length > 0
          ? t.inputSchema
          : { type: 'object' }
      const serverName = server.name
      const toolName   = t.name
      descriptors.push({
        name,
        description,
        inputSchema,
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const text = await mcp.callMcpTool(serverName, toolName, args)
          // Third-party output must not become instructions (prompt-sandbox),
          // and must not flood the context (hard cap).
          return wrapUntrusted(text.slice(0, MAX_RESULT_CHARS), `mcp:${serverName}`)
        },
      })
    }
  }
  return descriptors
}
