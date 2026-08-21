// apps/desktop/test/unit/mcpToolHints.test.ts
//
// Session-aware next-tool suggestions for the in-process MCP server
// (STEAL 2026-06-12 cluster B; code-review-graph hints.py pattern).
// Each tool response carries next_tool_suggestions: which tools logically
// follow, minus what the session just called — so an external agent can
// navigate the 16-tool surface without exhaustive discovery.

import { describe, it, expect } from 'vitest'
import { HintTracker, WORKFLOW } from '../../electron/mcp/tool-hints'

describe('WORKFLOW map', () => {
  it('covers the core tool chains', () => {
    expect(WORKFLOW.fs_search).toContain('fs_read')
    expect(WORKFLOW.fs_read).toContain('fs_apply_diff')
    expect(WORKFLOW.git_status).toContain('git_diff')
    expect(WORKFLOW.git_diff).toContain('git_commit')
    expect(WORKFLOW.conversations_search).toContain('conversations_read')
  })
})

describe('HintTracker', () => {
  it('suggests followers for a known tool', () => {
    const t = new HintTracker()
    const hints = t.afterCall('claude', 'fs_search')
    expect(hints).toContain('fs_read')
    expect(hints.length).toBeLessThanOrEqual(3)
  })

  it('filters out tools the session just called', () => {
    const t = new HintTracker()
    t.afterCall('claude', 'fs_read')      // fs_read now recent
    const hints = t.afterCall('claude', 'fs_search')
    expect(hints).not.toContain('fs_read') // already used moments ago
  })

  it('keeps sessions independent per actor', () => {
    const t = new HintTracker()
    t.afterCall('codex', 'fs_read')
    const hints = t.afterCall('claude', 'fs_search')
    expect(hints).toContain('fs_read')    // claude never called it
  })

  it('returns [] for unknown tools', () => {
    const t = new HintTracker()
    expect(t.afterCall('claude', 'mystery_tool')).toEqual([])
  })

  it('recency window slides — old calls stop suppressing', () => {
    const t = new HintTracker(2) // tiny window for the test
    t.afterCall('claude', 'fs_read')
    t.afterCall('claude', 'git_status')
    t.afterCall('claude', 'git_diff')     // fs_read now outside the window
    const hints = t.afterCall('claude', 'fs_search')
    expect(hints).toContain('fs_read')
  })
})
