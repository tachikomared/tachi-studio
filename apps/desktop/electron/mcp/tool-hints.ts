// apps/desktop/electron/mcp/tool-hints.ts
//
// next_tool_suggestions for the in-process MCP server (STEAL 2026-06-12
// cluster B; code-review-graph hints.py pattern). A static adjacency map of
// "what logically follows this tool" + a tiny per-actor recency window so we
// don't suggest what the session literally just did. No storage, no LLM —
// the value is purely navigational: external agents discover the 16-tool
// surface without trial-and-error tools/list spelunking.

/** Which tools logically follow each tool (hand-curated for our registry). */
export const WORKFLOW: Record<string, string[]> = {
  fs_list:              ['fs_read', 'fs_search'],
  fs_search:            ['fs_read', 'fs_apply_diff'],
  fs_read:              ['fs_apply_diff', 'fs_write', 'fs_search'],
  fs_write:             ['git_status', 'fs_read'],
  fs_apply_diff:        ['git_status', 'git_diff'],
  git_status:           ['git_diff', 'fs_read'],
  git_diff:             ['git_commit', 'fs_apply_diff'],
  git_commit:           ['git_status', 'git_log_search'],
  git_log_search:       ['git_diff', 'fs_read'],
  http_fetch:           ['fs_write', 'llm_complete'],
  llm_list_providers:   ['llm_complete'],
  llm_complete:         ['fs_write'],
  conversations_search: ['conversations_read'],
  conversations_read:   ['conversations_search'],
  activity_feed:        ['git_status'],
  expand_output:        [],
}

/**
 * Per-actor recency tracking + suggestion filtering. One instance per server
 * lifetime; state is a bounded sliding window (no persistence by design).
 */
export class HintTracker {
  private recent = new Map<string, string[]>()

  constructor(private windowSize = 5) {}

  /**
   * Record `tool` as called by `actor` and return up to 3 suggested
   * follow-ups, excluding tools inside the actor's recency window.
   */
  afterCall(actor: string, tool: string): string[] {
    const seen = this.recent.get(actor) ?? []
    const suggestions = (WORKFLOW[tool] ?? []).filter(t => !seen.includes(t)).slice(0, 3)
    seen.push(tool)
    if (seen.length > this.windowSize) seen.splice(0, seen.length - this.windowSize)
    this.recent.set(actor, seen)
    return suggestions
  }
}
