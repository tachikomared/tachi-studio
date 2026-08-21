// apps/desktop/test/unit/mcpRateLimit.test.ts
//
// Sliding-window per-tier rate limiter for the in-process MCP server
// (STEAL 2026-06-12 cluster B; gridex MCPRateLimiter pattern).

import { describe, it, expect } from 'vitest'
import { McpRateLimiter, tierForTool, DEFAULT_LIMITS } from '../../electron/mcp/rate-limit'

describe('tierForTool', () => {
  it('maps tools to tiers', () => {
    expect(tierForTool('llm_complete')).toBe('llm')
    expect(tierForTool('llm_list_providers')).toBe('read')
    expect(tierForTool('http_fetch')).toBe('network')
    expect(tierForTool('fs_write')).toBe('write')
    expect(tierForTool('fs_apply_diff')).toBe('write')
    expect(tierForTool('git_commit')).toBe('write')
    expect(tierForTool('fs_read')).toBe('read')
    expect(tierForTool('some_future_tool')).toBe('read')
  })
})

describe('McpRateLimiter', () => {
  function makeLimiter(max: number, windowMs = 1000) {
    let now = 0
    const limiter = new McpRateLimiter(
      { read: { windowMs, max }, write: { windowMs, max }, network: { windowMs, max }, llm: { windowMs, max } },
      () => now,
    )
    return { limiter, advance: (ms: number) => { now += ms } }
  }

  it('allows calls under the limit', () => {
    const { limiter } = makeLimiter(3)
    expect(limiter.check('fs_read').allowed).toBe(true)
    expect(limiter.check('fs_read').allowed).toBe(true)
    expect(limiter.check('fs_read').allowed).toBe(true)
  })

  it('denies at the limit and reports retryAfterMs', () => {
    const { limiter } = makeLimiter(2, 1000)
    limiter.check('http_fetch')
    limiter.check('http_fetch')
    const d = limiter.check('http_fetch')
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.retryAfterMs).toBeGreaterThan(0)
  })

  it('window slides — old hits expire', () => {
    const { limiter, advance } = makeLimiter(2, 1000)
    limiter.check('llm_complete')
    limiter.check('llm_complete')
    expect(limiter.check('llm_complete').allowed).toBe(false)
    advance(1001)
    expect(limiter.check('llm_complete').allowed).toBe(true)
  })

  it('tiers are independent buckets', () => {
    const { limiter } = makeLimiter(1)
    expect(limiter.check('fs_write').allowed).toBe(true)   // write bucket full
    expect(limiter.check('fs_read').allowed).toBe(true)    // read bucket untouched
    expect(limiter.check('git_commit').allowed).toBe(false) // write bucket shared
  })

  it('ships sane defaults', () => {
    expect(DEFAULT_LIMITS.llm.max).toBeLessThan(DEFAULT_LIMITS.read.max)
    expect(DEFAULT_LIMITS.network.max).toBeLessThan(DEFAULT_LIMITS.read.max)
  })
})
