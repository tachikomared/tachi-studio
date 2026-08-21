// apps/desktop/electron/services/chat-recall-service.ts
//
// BATCH33 STAGE 2 — SCORED RECALL over the existing chat FTS5 index.
//
// chat-search-service already owns the index (SQLite FTS5 via wasm, derived
// from the conversation JSON, incremental, CJK-safe). It ranks by bm25, which
// is a good CANDIDATE generator and a mediocre final ranker for "what of my
// past chats is relevant to THIS agent task" — bm25 rewards rare terms in short
// documents, so a one-line message that happens to contain a rare token
// outranks the paragraph that actually answers the question.
//
// So: FTS5 for RECALL (cheap, indexed, wide net), @tachi/core's `scoreRecall`
// for PRECISION (distinct-query-token coverage with a sublinear tf bonus),
// `packContext` for the budget-bounded, anti-lost-in-the-middle render.
//
//     query ──► chat-search FTS5 (candidateLimit) ──► scoreRecall rerank
//                                                   ──► topK snippets
//                                                   ──► packContext(charBudget)
//                                                   ──► wrapUntrusted block
//
// NO NEW INDEX, NO EMBEDDINGS. The ACE-style embedding cosine rerank is a
// LATER upgrade path (notes/RESEARCH-2026-06-09.md §1 "agentic-context-
// engine" / §4 item 3) and deliberately not built here — this stage is lexical
// only, which is why it needs no model, no download and no warm-up.
//
// ── PRIVACY ──────────────────────────────────────────────────────────────────
// This surface inherits chat-search's gating EXACTLY, and adds none of its own.
// What that means, verified against the code and pinned in
// test/unit/chatRecall.test.ts:
//
//  * DELETED CONVERSATIONS. `chat:delete-conversation` (chat.ipc.ts) unlinks the
//    JSON file; every `search()` calls `sync()` first, which drops the rows of
//    any conversation whose file has vanished. Recall goes through the same
//    `search()`, so a deleted chat stops being recallable on the very next call
//    — there is no separate cache to invalidate.
//  * PRIVATE MODE. chat-search is deliberately NOT gated on private mode: the
//    index is local, read-only and offline, and loop.ts already exposes
//    `conversation_search` to the model unconditionally for exactly that reason
//    (see the comment above `conversationSearch` in tachi/loop.ts). Recall keeps
//    that parity rather than inventing a second, divergent policy. The user's
//    control over automatic injection is the `tachiRecallEnabled` setting.
//  * UNTRUSTED BY DEFAULT. Chat history can contain previously-ingested hostile
//    text (pasted web pages, old tool output). Anything this module renders for
//    a prompt goes through `wrapUntrusted` first — same seam, same policy line
//    as the `conversation_search` tool.

import { packContext, scoreRecall, type PackItem } from '@tachi/core'
import type { ChatSearchHit } from './chat-search-service'

/** One recalled past-chat snippet, with its provenance and its rerank score. */
export interface ChatRecallSnippet {
  /** Snippet text, FTS5 highlight markers stripped. */
  text: string
  conversationId: string
  title: string
  turnIndex: number
  role: string
  /** Lexical rerank score from @tachi/core scoreRecall (higher = better). */
  score: number
  updatedAt: string
}

export interface ChatRecallOptions {
  /** Snippets returned after the rerank. Default 5. */
  topK?: number
  /**
   * FTS5 candidates pulled before reranking. Default topK * 5 (min 10, max 50)
   * — a wide enough net that the rerank has something to reorder, small enough
   * that the SQLite round-trip stays sub-millisecond-ish on a chat-scale index.
   */
  candidateLimit?: number
  /**
   * Drop snippets whose rerank score is below this. Default 0 (exclusive) —
   * a snippet sharing NO content word with the query is noise, not recall.
   */
  minScore?: number
}

/** The one method this module needs from chat-search-service (injectable for tests). */
export interface ChatSearchLike {
  search(query: string, limit?: number): { hits: ChatSearchHit[]; mode: 'fts' | 'like' }
}

/** FTS5's snippet() decorations — stripped so the model reads plain prose. */
const HIGHLIGHT_OPEN = '«'
const HIGHLIGHT_CLOSE = '»'

function cleanSnippet(s: string): string {
  return s.replaceAll(HIGHLIGHT_OPEN, '').replaceAll(HIGHLIGHT_CLOSE, '').trim()
}

/**
 * FTS5 candidates → lexically reranked, deduped top-k snippets.
 *
 * Pure with respect to the injected index: no globals, no electron. Ties break
 * on the FTS5 (bm25) order, so equal-score snippets keep the engine's opinion.
 */
export function recallFromIndex(
  index: ChatSearchLike,
  query: string,
  opts: ChatRecallOptions = {},
): ChatRecallSnippet[] {
  const q = query.trim()
  if (!q) return []

  const topK = Math.max(1, Math.min(25, Math.floor(opts.topK ?? 5)))
  const candidateLimit = Math.max(
    10,
    Math.min(50, Math.floor(opts.candidateLimit ?? topK * 5)),
  )
  const minScore = opts.minScore ?? 0

  const { hits } = index.search(q, candidateLimit)
  if (hits.length === 0) return []

  // Dedupe on (conversation, turn): the same turn can surface twice when the
  // engine falls back from the FTS path to the LIKE scan mid-query.
  const seen = new Set<string>()
  const scored: Array<{ snip: ChatRecallSnippet; rank: number }> = []
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    const key = `${h.convId}#${h.turnIndex}`
    if (seen.has(key)) continue
    seen.add(key)
    const text = cleanSnippet(h.snippet)
    if (!text) continue
    const score = scoreRecall(q, text)
    if (score <= minScore) continue
    scored.push({
      rank: i,
      snip: {
        text,
        conversationId: h.convId,
        title: h.title,
        turnIndex: h.turnIndex,
        role: h.role,
        score,
        updatedAt: h.updatedAt,
      },
    })
  }

  return scored
    .sort((a, b) => (b.snip.score - a.snip.score) || (a.rank - b.rank))
    .slice(0, topK)
    .map(x => x.snip)
}

/**
 * Render reranked snippets as ONE prompt block, budget-bounded by packContext
 * and sandbox-wrapped. Returns null when there is nothing worth injecting.
 *
 * `wrap` is injected so this stays testable without node:crypto randomness in
 * the assertion; production passes prompt-sandbox's wrapUntrusted.
 */
export function buildRecallBlock(
  snippets: ChatRecallSnippet[],
  opts: { maxChars: number; wrap: (content: string, source: string) => string },
): string | null {
  if (snippets.length === 0) return null
  const items: PackItem[] = snippets.map(s => ({
    text: `[${s.title || 'untitled'} · id=${s.conversationId} · turn ${s.turnIndex} · ${s.role}] ${s.text}`,
    score: s.score,
  }))
  const packed = packContext(items, {
    targetItems: snippets.length,
    maxTotalChars: Math.max(120, Math.floor(opts.maxChars)),
    minItemChars: 60,
    maxItemChars: 320,
  })
  if (packed.items.length === 0) return null
  const body = packed.items.map(s => `- ${s}`).join('\n')
  return [
    '<recalled-conversations>',
    'Possibly-relevant excerpts from your saved chats, recalled automatically for this request.',
    opts.wrap(body, 'chat_recall'),
    '</recalled-conversations>',
  ].join('\n')
}

// ── App-level convenience over the real singletons ───────────────────────────

/**
 * Recall + render in one call, against the app's real chat index.
 *
 * Best-effort by contract: any failure (index unavailable, wasm not loadable,
 * a corrupt db) returns null so the caller's context assembly is simply
 * unchanged — recall must never be able to break a run.
 */
export async function recallChatContext(
  query: string,
  opts: { maxChars: number; topK?: number },
): Promise<string | null> {
  try {
    const { getChatIndex } = await import('./chat-search-service')
    const { wrapUntrusted } = await import('./prompt-sandbox')
    const snippets = recallFromIndex(getChatIndex(), query, { topK: opts.topK ?? 5 })
    return buildRecallBlock(snippets, { maxChars: opts.maxChars, wrap: wrapUntrusted })
  } catch {
    return null
  }
}
