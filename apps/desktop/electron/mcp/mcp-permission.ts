// apps/desktop/electron/mcp/mcp-permission.ts
//
// Permission tiers for the in-process MCP server's tools — so an external agent
// (Claude Desktop, Cline, Codex, …) connected to our MCP endpoint can be run in
// a SCOPED mode instead of all-or-nothing. Idea adapted from gridex's per-
// connection MCP permission model (Apache-2.0): tier every tool, then gate by a
// mode. This module is PURE (no IO, no electron) so it is fully unit-testable;
// the server dispatch can consult isMcpToolAllowed() before invoking a handler.
//
// STATUS: WIRED. The dispatch consults isMcpToolAllowed() per call
// (mcp-server.ts), and the mode is a user setting (AppSettings.mcpMode, picked in
// Settings → MCP). Default is fail-closed (read_only).

export type McpToolTier = 'read' | 'write' | 'network'

/**
 * Connection scope, least → most capable:
 *   locked     — no tools
 *   read_only  — read tier only (inspect, never mutate or egress)
 *   read_write — read + local mutations (fs/git writes), but NO network egress
 *   full       — everything (current default behavior)
 */
export type McpMode = 'locked' | 'read_only' | 'read_write' | 'full'

// Every tool the server registers (electron/mcp/tools/*.ts -> registry.set).
// read    = no mutation, no egress
// write   = mutates local files / the git repo
// network = reaches the public internet (also separately gated by egress-policy/SSRF)
export const MCP_TOOL_TIERS: Record<string, McpToolTier> = {
  // meta / history / list — read
  activity_feed:        'read',
  llm_list_providers:   'read',
  conversations_search: 'read',
  conversations_read:   'read',
  // recovery for compacted large tool results — read-only paging, never mutates
  expand_output:        'read',
  // git — reads vs the one mutation (commit)
  git_status:           'read',
  git_diff:             'read',
  git_log_search:       'read',
  git_commit:           'write',
  // fs — reads vs the two mutations
  fs_list:              'read',
  fs_read:              'read',
  fs_search:            'read',
  fs_write:             'write',
  fs_apply_diff:        'write',
  // network egress
  http_fetch:           'network',
  llm_complete:         'network',
}

/** Tier of a known tool, or `undefined` for an unrecognised tool. */
export function mcpToolTier(name: string): McpToolTier | undefined {
  return MCP_TOOL_TIERS[name]
}

const ALLOWED_TIERS: Record<McpMode, ReadonlySet<McpToolTier>> = {
  locked:     new Set<McpToolTier>(),
  read_only:  new Set<McpToolTier>(['read']),
  read_write: new Set<McpToolTier>(['read', 'write']),
  full:       new Set<McpToolTier>(['read', 'write', 'network']),
}

/**
 * Whether `toolName` may run under `mode`.
 * An UNKNOWN tool is conservative: allowed only in `full` (so a newly-added tool
 * that hasn't been tiered yet can't slip past a restricted scope unnoticed).
 */
export function isMcpToolAllowed(toolName: string, mode: McpMode): boolean {
  const tier = MCP_TOOL_TIERS[toolName]
  if (!tier) return mode === 'full'
  return ALLOWED_TIERS[mode].has(tier)
}
