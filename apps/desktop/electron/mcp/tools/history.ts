// apps/desktop/electron/mcp/tools/history.ts
//
// Conversation-history tools — read-only access to Tachi's saved chat
// conversations (the JSON files persisted by chat.ipc.ts → chat:save-
// conversation under ${userData}/conversations/).
//
// Tools:
//   conversations_search — substring search across saved conversations.
//                          Returns hit snippets (conversationId, turnIndex,
//                          snippet).
//   conversations_read   — return full turns of a single conversation
//                          (optionally a slice).
//
// We treat these as read-only — no write tool. External agents shouldn't
// be able to delete the user's chat history through MCP.
//
// Hardening: conversation file names must match /^[\w-]{1,128}$/ (same regex
// chat.ipc.ts enforces on save). The conversationId from the wire is
// re-validated here so a malformed id can't traverse out of the dir.

import { readdir, readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { app } from 'electron'
import type { ToolRegistry } from '../registry'
import { rrfMerge, bm25Lite } from '../../services/util/rrf'
import { assertString } from './args'

const ID_RE = /^[\w-]{1,128}$/

interface SavedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string | Array<{ type: string; text?: string; filename?: string }>
  model?: string
}

interface SavedConversation {
  id: string
  title: string
  messages: SavedMessage[]
  providerId: string
  model: string
  createdAt: string
  updatedAt: string
  workspaceDir?: string
}

function conversationsDir(): string {
  return join(app.getPath('userData'), 'conversations')
}

function messageText(m: SavedMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('')
}

async function listSavedIds(): Promise<string[]> {
  try {
    const dirents = await readdir(conversationsDir(), { withFileTypes: true })
    return dirents
      .filter(d => d.isFile() && d.name.endsWith('.json'))
      .map(d => d.name.replace(/\.json$/, ''))
      .filter(id => ID_RE.test(id))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

async function readConvSafe(id: string): Promise<SavedConversation | null> {
  if (!ID_RE.test(id)) return null
  const root = conversationsDir()
  const fp = join(root, `${id}.json`)
  if (!fp.startsWith(root + sep) && !fp.startsWith(root + '/')) return null
  try {
    const raw = await readFile(fp, 'utf8')
    return JSON.parse(raw) as SavedConversation
  } catch { return null }
}

export function register(registry: ToolRegistry): void {
  // ── conversations_search ───────────────────────────────────────────────────
  registry.set('conversations_search', {
    description: 'Full-text search over Tachi\'s saved chat conversations (ranked, with snippets). Returns up to `limit` (default 25, max 100) hits. Set caseSensitive for an exact substring scan instead.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', description: 'Default 25, max 100.' },
        caseSensitive: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const query = assertString(args, 'query')
      if (query.length === 0) throw new Error('query must be non-empty')
      const limitRaw = ((args as { limit?: unknown })?.limit as number | undefined) ?? 25
      const limit = Math.max(1, Math.min(100, Math.floor(limitRaw)))
      const cs = !!(args as { caseSensitive?: boolean })?.caseSensitive
      const needle = cs ? query : query.toLowerCase()

      // Primary path (2026-07-08): the SQLite FTS5 chat index (chat-search-
      // service) — ranked, snippeted, incremental, CJK-safe. caseSensitive
      // queries keep the legacy substring scan (FTS5 is case-insensitive), and
      // any index failure falls through to the scan too.
      if (!cs) {
        try {
          const { getChatIndex } = await import('../../services/chat-search-service')
          const { hits } = getChatIndex().search(query, limit)
          return {
            query,
            hits: hits.map(h => ({
              conversationId: h.convId,
              title: h.title,
              turnIndex: h.turnIndex,
              role: h.role,
              snippet: h.snippet,
              updatedAt: h.updatedAt || undefined,
            })),
            truncated: hits.length >= limit,
          }
        } catch { /* index unavailable → legacy substring scan below */ }
      }

      // Gather ALL substring matches (up to a bounded candidate pool) before
      // ranking, so RRF can fuse the substring-discovery order with a BM25-lite
      // term-overlap order computed over the same matched text. We cap the pool
      // at limit*4 so a huge history can't blow memory; relevance ranking only
      // matters within a reasonable candidate set anyway.
      const POOL_CAP = limit * 4
      type Hit = {
        conversationId: string
        title: string
        turnIndex: number
        role: string
        snippet: string
        updatedAt?: string
      }
      const ids = await listSavedIds()
      const hitsByKey = new Map<string, Hit>()
      // Ordered list of keys in substring-discovery order + the full matched
      // text per key (BM25 corpus). A key is conversationId#turnIndex.
      const substringKeys: string[] = []
      const docs: Array<{ id: string; text: string }> = []

      outer: for (const id of ids) {
        if (substringKeys.length >= POOL_CAP) break
        const conv = await readConvSafe(id)
        if (!conv) continue
        for (let i = 0; i < conv.messages.length; i++) {
          if (substringKeys.length >= POOL_CAP) break outer
          const m = conv.messages[i] as SavedMessage
          const text = messageText(m)
          const hay = cs ? text : text.toLowerCase()
          const idx = hay.indexOf(needle)
          if (idx === -1) continue
          // Build a 200-char snippet around the match
          const start = Math.max(0, idx - 80)
          const end   = Math.min(text.length, idx + needle.length + 120)
          let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
          if (start > 0) snippet = '…' + snippet
          if (end < text.length) snippet = snippet + '…'
          const key = `${conv.id}#${i}`
          hitsByKey.set(key, {
            conversationId: conv.id,
            title: conv.title,
            turnIndex: i,
            role: m.role,
            snippet,
            updatedAt: conv.updatedAt,
          })
          substringKeys.push(key)
          docs.push({ id: key, text })
        }
      }

      // Fuse substring-discovery order with the BM25-lite relevance order over
      // the same matched texts. RRF only re-orders — every substring hit is
      // preserved (bm25Ids ⊆ substringKeys, and rrfMerge keeps all input ids).
      const bm25Keys = bm25Lite(query, docs)
      const fusedKeys = rrfMerge([substringKeys, bm25Keys])
      const hits: Hit[] = fusedKeys.slice(0, limit).map(k => hitsByKey.get(k)!)
      // `truncated` keeps its original meaning: more candidates existed than we
      // returned (the substring pool overflowed the requested limit).
      return { query, hits, truncated: substringKeys.length > limit }
    },
  })

  // ── conversations_read ─────────────────────────────────────────────────────
  registry.set('conversations_read', {
    description: 'Return the turns of a saved conversation. Pass `from`/`to` (turn indices) to slice.',
    schema: {
      type: 'object',
      properties: {
        conversationId: { type: 'string' },
        from: { type: 'integer', description: 'First turn index (inclusive). Default 0.' },
        to:   { type: 'integer', description: 'Last turn index (exclusive). Default end.' },
      },
      required: ['conversationId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = assertString(args, 'conversationId')
      const conv = await readConvSafe(id)
      if (!conv) throw new Error(`conversation not found: ${id}`)
      const fromRaw = (args as { from?: unknown })?.from
      const toRaw   = (args as { to?:   unknown })?.to
      const from = typeof fromRaw === 'number' ? Math.max(0, Math.floor(fromRaw)) : 0
      const to   = typeof toRaw   === 'number' ? Math.max(from, Math.floor(toRaw)) : conv.messages.length
      const slice = conv.messages.slice(from, to)
      return {
        id: conv.id,
        title: conv.title,
        providerId: conv.providerId,
        model: conv.model,
        workspaceDir: conv.workspaceDir ?? null,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        totalTurns: conv.messages.length,
        from, to,
        turns: slice.map((m, i) => ({
          index: from + i,
          id: m.id,
          role: m.role,
          model: m.model,
          text: messageText(m),
        })),
      }
    },
  })
}
