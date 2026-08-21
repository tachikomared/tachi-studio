// apps/desktop/electron/services/nook-network-service.ts
//
// "Network" tab service — knowledge feed, contributor leaderboard, agent
// discovery + follow. Builds on the single connected runtime owned by
// nook-service.ts (do NOT duplicate connection state here).
//
// Reads go through the runtime managers (discovery / leaderboard / memory),
// which attach the gateway session automatically. The leaderboard endpoint is
// public, but we still route it through the runtime so a future
// auth-only-feed never silently breaks. All write paths (publish, follow)
// require a connected runtime + a private key for on-chain signing.
//
// Verified field shapes against the live gateway (0.5.138 runtime):
//   discovery.browseFeed()   → { contents: FeedPost[] } where FeedPost has
//                              { id, cid, author_id, community_id, title, body,
//                                tags, score, upvotes, downvotes, comment_count,
//                                timestamp (unix-seconds string) }
//   leaderboard.getTop()     → { entries: [{ rank, address, displayName, score,
//                                breakdown, velocityMultiplier, challengesSolved,
//                                nookEarned }], total, limit, offset }
//   discovery.searchAgents() → { results: [{ type, id, title, snippet, relevance,
//                                metadata:{address,...}, createdAt }], total, ... }

import { getRuntime, nookGatewayUrl } from './nook-service'

// ── Renderer-facing view shapes ───────────────────────────────────────────────

export interface NookPostView {
  id: string
  title: string
  author: string          // author address
  community: string
  preview: string         // body snippet (may be empty until IPFS cache warms)
  tags: string[]
  score: number
  upvotes: number
  downvotes: number
  comments: number
  timestamp: number       // unix seconds
  cid: string
}

export interface NookPostDetail extends NookPostView {
  body: string   // FULL body (not the 240-char preview)
}

export interface NookLeaderEntryView {
  rank: number
  address: string
  name: string | null
  score: number
  challengesSolved: number
  velocityMultiplier: number
}

export interface NookAgentView {
  address: string
  name: string            // display title from search
  snippet: string         // why-it-matched HTML-ish snippet (tags stripped client-side)
  relevance: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rt() {
  const r = getRuntime()
  if (!r) throw new Error('Not connected to nookplot.')
  return r
}

/** FeedPost.timestamp is a unix-seconds STRING; some endpoints return ms. */
function toUnixSeconds(v: unknown): number {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

// ── Feed ────────────────────────────────────────────────────────────────────

export async function getFeed(opts?: {
  limit?: number
  community?: string
  sort?: 'hot' | 'new' | 'top' | 'reputation'
}): Promise<NookPostView[]> {
  const res = await rt().discovery.browseFeed({
    limit: opts?.limit ?? 25,
    community: opts?.community || undefined,
    sort: opts?.sort ?? 'hot',
  })
  const posts = Array.isArray(res?.contents) ? res.contents : []
  return posts.map((p) => {
    const body = typeof p.body === 'string' ? p.body : ''
    return {
      id: String(p.id ?? p.cid ?? ''),
      title: (p.title && String(p.title)) || '(untitled)',
      author: String(p.author_id ?? ''),
      community: String(p.community_id ?? ''),
      preview: body.length > 240 ? body.slice(0, 240) + '…' : body,
      tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
      score: Number(p.score ?? 0),
      upvotes: Number(p.upvotes ?? 0),
      downvotes: Number(p.downvotes ?? 0),
      comments: Number(p.comment_count ?? 0),
      timestamp: toUnixSeconds(p.timestamp),
      cid: String(p.cid ?? ''),
    }
  })
}

/** Fetch one post's FULL content + live counts by CID (both endpoints public). */
export async function getPost(cid: string): Promise<NookPostDetail> {
  if (!cid) throw new Error('A content CID is required.')
  const gw = nookGatewayUrl()
  const enc = encodeURIComponent(cid)
  const [metaRes, ipfsRes] = await Promise.allSettled([
    fetch(`${gw}/v1/index/content/${enc}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) as AbortSignal }).then(r => r.ok ? r.json() : null),
    fetch(`${gw}/v1/ipfs/${enc}`,          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) as AbortSignal }).then(r => r.ok ? r.json() : null),
  ])
  const c = (metaRes.status === 'fulfilled' && metaRes.value ? (metaRes.value as Record<string, unknown>).content : null) as Record<string, unknown> | null ?? {}
  const ipfs = ipfsRes.status === 'fulfilled' && ipfsRes.value ? ipfsRes.value as Record<string, unknown> : null
  const ipfsContent = (ipfs?.content as Record<string, unknown>) ?? ipfs ?? {}
  const body = String(ipfsContent.body ?? c.body ?? '')
  return {
    id: String(c.id ?? cid),
    cid,
    title: String(ipfsContent.title ?? c.title ?? '(untitled)'),
    author: String(c.author_id ?? ipfs?.author ?? ''),
    community: String(c.community_id ?? ''),
    preview: body.slice(0, 240),
    body,
    tags: Array.isArray(c.tags) ? c.tags.map(String) : Array.isArray(ipfsContent.tags) ? (ipfsContent.tags as unknown[]).map(String) : [],
    score: Number(c.score ?? 0),
    upvotes: Number(c.upvotes ?? 0),
    downvotes: Number(c.downvotes ?? 0),
    comments: Number(c.comment_count ?? 0),
    timestamp: toUnixSeconds(c.timestamp),
  }
}

// ── Publish ─────────────────────────────────────────────────────────────────

export async function publishPost(input: {
  title: string
  body: string
  community: string
  tags?: string[]
}): Promise<{ cid: string; txHash?: string }> {
  const title = input.title.trim()
  const body = input.body.trim()
  const community = input.community.trim()
  if (!title) throw new Error('A title is required.')
  if (!body) throw new Error('A body is required.')
  if (!community) throw new Error('A community slug is required.')
  // publishKnowledge uploads to IPFS and, with a private key configured, signs +
  // relays the on-chain index tx so the post appears in the feed. Without a key
  // it still returns the CID (IPFS-only) — surface that to the user.
  const res = await rt().memory.publishKnowledge({ title, body, community, tags: input.tags })
  return { cid: res.cid, txHash: res.txHash }
}

/** Public community list for the composer dropdown (best-effort). */
export async function listCommunities(limit = 50): Promise<{ slug: string; totalPosts: number }[]> {
  try {
    const res = await rt().memory.listCommunities(limit)
    return (res.communities ?? []).map((c) => ({ slug: c.slug, totalPosts: c.totalPosts }))
  } catch {
    return []
  }
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

export async function getLeaderboard(opts?: { limit?: number }): Promise<NookLeaderEntryView[]> {
  const res = await rt().leaderboard.getTop(opts?.limit ?? 25)
  const entries = Array.isArray(res?.entries) ? res.entries : []
  return entries.map((e) => {
    const x = e as unknown as Record<string, unknown>
    return {
      rank: Number(x.rank ?? 0),
      address: String(x.address ?? ''),
      name: (x.displayName as string) ?? null,
      score: Number(x.score ?? 0),
      challengesSolved: Number(x.challengesSolved ?? 0),
      velocityMultiplier: Number(x.velocityMultiplier ?? 1),
    }
  })
}

// ── Agent search + follow ──────────────────────────────────────────────────────

export async function searchAgents(query: string, limit = 20): Promise<NookAgentView[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const res = await rt().discovery.searchAgents(q, limit)
  const results = Array.isArray(res?.results) ? res.results : []
  return results.map((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    const snippet = String(r.snippet ?? '').replace(/<\/?[^>]+>/g, '')   // strip <b> match markers
    return {
      address: String(meta.address ?? r.id ?? ''),
      name: String(r.title ?? '(agent)'),
      snippet,
      relevance: Number(r.relevance ?? 0),
    }
  })
}

export async function follow(address: string): Promise<{ ok: true; txHash: string }> {
  const addr = address.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('Invalid agent address.')
  // follow() uses the non-custodial prepare+sign+relay flow — requires a private
  // key. The runtime throws a clear message if signing isn't configured.
  const res = await rt().social.follow(addr)
  return { ok: true, txHash: res.txHash }
}
