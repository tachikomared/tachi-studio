// apps/desktop/test/unit/mcpPermission.test.ts
import { describe, it, expect } from 'vitest'
import {
  mcpToolTier, isMcpToolAllowed, MCP_TOOL_TIERS,
  type McpMode,
} from '../../electron/mcp/mcp-permission'

// The full set of tools the server registers (registry.set in electron/mcp/tools/*).
const ALL_TOOLS = [
  'activity_feed', 'llm_list_providers', 'conversations_search', 'conversations_read',
  'expand_output',
  'git_status', 'git_diff', 'git_log_search', 'git_commit',
  'fs_list', 'fs_read', 'fs_search', 'fs_write', 'fs_apply_diff',
  'http_fetch', 'llm_complete',
]

describe('mcpToolTier', () => {
  it('tiers reads, writes, and network tools correctly', () => {
    expect(mcpToolTier('fs_read')).toBe('read')
    expect(mcpToolTier('git_status')).toBe('read')
    expect(mcpToolTier('fs_write')).toBe('write')
    expect(mcpToolTier('fs_apply_diff')).toBe('write')
    expect(mcpToolTier('git_commit')).toBe('write')
    expect(mcpToolTier('http_fetch')).toBe('network')
    expect(mcpToolTier('llm_complete')).toBe('network')
  })

  it('returns undefined for an unknown tool', () => {
    expect(mcpToolTier('totally_made_up')).toBeUndefined()
  })

  it('every registered tool has a tier (completeness — catches an un-tiered new tool)', () => {
    for (const t of ALL_TOOLS) expect(MCP_TOOL_TIERS[t], t).toBeDefined()
    expect(Object.keys(MCP_TOOL_TIERS).sort()).toEqual([...ALL_TOOLS].sort())
  })
})

describe('isMcpToolAllowed', () => {
  it('full mode allows everything, including unknown tools', () => {
    for (const t of [...ALL_TOOLS, 'unknown_tool']) {
      expect(isMcpToolAllowed(t, 'full'), t).toBe(true)
    }
  })

  it('read_write allows read + local writes but blocks network egress and unknowns', () => {
    const m: McpMode = 'read_write'
    expect(isMcpToolAllowed('fs_read', m)).toBe(true)
    expect(isMcpToolAllowed('fs_write', m)).toBe(true)
    expect(isMcpToolAllowed('git_commit', m)).toBe(true)
    expect(isMcpToolAllowed('http_fetch', m)).toBe(false)
    expect(isMcpToolAllowed('llm_complete', m)).toBe(false)
    expect(isMcpToolAllowed('unknown_tool', m)).toBe(false)
  })

  it('read_only allows only the read tier', () => {
    const m: McpMode = 'read_only'
    expect(isMcpToolAllowed('fs_read', m)).toBe(true)
    expect(isMcpToolAllowed('git_diff', m)).toBe(true)
    expect(isMcpToolAllowed('fs_write', m)).toBe(false)
    expect(isMcpToolAllowed('git_commit', m)).toBe(false)
    expect(isMcpToolAllowed('http_fetch', m)).toBe(false)
  })

  it('expand_output (compaction recovery) is allowed in every non-locked mode', () => {
    // H2 regression: a compacted result tells the agent to call expand_output;
    // that recovery must not be blocked under restricted scopes.
    expect(isMcpToolAllowed('expand_output', 'read_only')).toBe(true)
    expect(isMcpToolAllowed('expand_output', 'read_write')).toBe(true)
    expect(isMcpToolAllowed('expand_output', 'full')).toBe(true)
    expect(isMcpToolAllowed('expand_output', 'locked')).toBe(false)
  })

  it('locked allows nothing', () => {
    for (const t of [...ALL_TOOLS, 'unknown_tool']) {
      expect(isMcpToolAllowed(t, 'locked'), t).toBe(false)
    }
  })
})
