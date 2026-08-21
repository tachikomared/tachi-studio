// apps/desktop/electron/mcp/rate-limit.ts
//
// Per-tier sliding-window rate limiter for the in-process MCP server
// (STEAL 2026-06-12 cluster B; gridex MCPRateLimiter pattern). The server is
// loopback-only + bearer-token gated, but any local process that obtained the
// token (or any connected agent that goes rogue) could previously hammer
// llm_complete / http_fetch unbounded. Buckets are per TIER, not per tool, so
// an agent can't dodge the network cap by alternating tool names.

export type ToolTier = 'read' | 'write' | 'network' | 'llm'

export interface TierLimit { windowMs: number; max: number }

export const DEFAULT_LIMITS: Record<ToolTier, TierLimit> = {
  read:    { windowMs: 60_000, max: 120 }, // listings/reads/searches
  write:   { windowMs: 60_000, max: 30 },  // fs_write / fs_apply_diff / git_commit
  network: { windowMs: 60_000, max: 20 },  // http_fetch
  llm:     { windowMs: 60_000, max: 10 },  // llm_complete (costs money)
}

const WRITE_TOOLS = new Set(['fs_write', 'fs_apply_diff', 'git_commit'])

export function tierForTool(name: string): ToolTier {
  if (name === 'llm_complete') return 'llm'
  if (name === 'http_fetch') return 'network'
  if (WRITE_TOOLS.has(name)) return 'write'
  return 'read'
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterMs: number }

export class McpRateLimiter {
  private hits = new Map<ToolTier, number[]>()

  constructor(
    private limits: Record<ToolTier, TierLimit> = DEFAULT_LIMITS,
    private now: () => number = Date.now,
  ) {}

  check(toolName: string): RateDecision {
    const tier = tierForTool(toolName)
    const { windowMs, max } = this.limits[tier]
    const t = this.now()
    const fresh = (this.hits.get(tier) ?? []).filter(ts => t - ts < windowMs)
    if (fresh.length >= max) {
      this.hits.set(tier, fresh)
      const oldest = fresh[0] as number
      return { allowed: false, retryAfterMs: Math.max(1, oldest + windowMs - t) }
    }
    fresh.push(t)
    this.hits.set(tier, fresh)
    return { allowed: true }
  }
}
