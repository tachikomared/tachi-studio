// apps/desktop/electron/mcp/tools/meta.ts
//
// Meta tools — currently just activity_feed.
//
// activity_feed gives an external agent a way to see what other agents (and
// other Tachi surfaces, eventually) have been doing on this machine. The
// feed is populated by every mutating MCP tool (fs_write, fs_apply_diff,
// git_commit). Read-only tools don't contribute to the feed.

import type { ToolRegistry } from '../registry'
import { readActivity } from '../activity'

export function register(registry: ToolRegistry): void {
  registry.set('activity_feed', {
    description:
      'List recent mutating tool calls (fs_write, fs_apply_diff, git_commit) made through the Tachi MCP server, '
      + 'reverse-chronological. Each entry is attributed to its actor (claude/codex/agent/etc).',
    schema: {
      type: 'object',
      properties: {
        since: { type: 'integer', description: 'Only entries with ts >= this (ms since epoch).' },
        limit: { type: 'integer', description: 'Default 100, max 500.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const since = (args as { since?: unknown })?.since
      const limit = (args as { limit?: unknown })?.limit
      const entries = readActivity(
        typeof since === 'number' ? since : undefined,
        typeof limit === 'number' ? Math.floor(limit) : undefined,
      )
      return { entries }
    },
  })
}
