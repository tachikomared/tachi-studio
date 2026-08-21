// apps/desktop/electron/mcp/registry.ts
//
// Shared registry shape for the in-process MCP server's tool modules.
// Every tool module (fs, git, fetch, llm, history, meta) calls register()
// once at startup to mutate the registry Map.
//
// The handler receives:
//   - args   : opaque JSON value as sent by the MCP client. The handler is
//              responsible for validating/normalising before use.
//   - actor  : "claude" / "codex" / "agent" / etc, derived by the server
//              from the request's User-Agent + clientInfo. Used by tools
//              that record mutations into the activity feed.
//
// The handler must return a JSON-serialisable value that will become the
// `result.content` of the JSON-RPC tools/call response.

export type ToolHandler = (args: unknown, actor: string) => Promise<unknown>

export interface ToolDef {
  description: string
  /** JSON Schema (Draft 7) describing the `args` input shape. */
  schema: Record<string, unknown>
  handler: ToolHandler
}

export type ToolRegistry = Map<string, ToolDef>

export function newRegistry(): ToolRegistry {
  return new Map<string, ToolDef>()
}
