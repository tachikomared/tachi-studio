// apps/desktop/electron/mcp/activity.ts
//
// In-memory ring buffer of mutating MCP tool calls. Used by the activity_feed
// tool to give external agents a way to see what other agents have touched.
//
// Mutation tools (fs_write, fs_apply_diff, git_commit) push entries here;
// read-only tools (fs_read, fs_search, git_status, ...) do not.
//
// Buffer is bounded (last MAX_ENTRIES). The since/limit query params on the
// activity_feed tool slice into this same buffer.

const MAX_ENTRIES = 500

export interface ActivityEntry {
  ts:     number          // ms since epoch
  actor:  string          // 'claude', 'codex', 'agent', ...
  tool:   string          // 'fs_write', 'git_commit', ...
  target: string          // path / commit message / etc — short, human-readable
  detail?: Record<string, unknown>
}

const buf: ActivityEntry[] = []

export function recordActivity(entry: Omit<ActivityEntry, 'ts'>): void {
  buf.push({ ...entry, ts: Date.now() })
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES)
}

export function readActivity(since?: number, limit?: number): ActivityEntry[] {
  const filtered = since !== undefined ? buf.filter(e => e.ts >= since) : buf.slice()
  // Reverse-chronological — newest first — capped by limit (default 100).
  const out = filtered.slice().reverse()
  const cap = limit !== undefined ? Math.max(1, Math.min(500, limit)) : 100
  return out.slice(0, cap)
}
