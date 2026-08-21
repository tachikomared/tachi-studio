// packages/core/src/memory/recall.ts
//
// Lexical (embedder-free) RECALL scorer that feeds the context-packer.
// Lives in @tachi/core so BOTH the renderer and the Electron main process can
// import it (it started in apps/desktop/src/utils, which main can't reach).
//
// The "score candidate memory items, then budget-pack the best" shape is the
// idea behind ACE (kayba-ai/agentic-context-engine) and AppFlowy's RAG; this is
// an INDEPENDENT, dependency-free TypeScript implementation that uses plain
// lexical overlap (no embeddings model, no DB) so it runs anywhere with zero
// setup. When a real embedding pipeline lands, this becomes the cheap FTS5-style
// candidate pre-filter and an embedding cosine-rerank can sit on top.
//
// Pipeline:  recall(query, items) -> scored PackItem[]  ->  packContext(...)
// or in one call: recallAndPack(query, items, packOpts).

import { packContext, type PackItem, type PackOptions, type PackResult } from './context-packer.js'

// Common English function words — dropped so they don't dominate overlap. Kept
// small + generic (not domain-specific) so the scorer stays predictable.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those',
  'as', 'at', 'by', 'from', 'i', 'you', 'we', 'they', 'he', 'she', 'do', 'does',
  'did', 'how', 'what', 'why', 'when', 'where', 'which', 'who', 'can', 'will',
])

export interface RecallItem {
  /** The candidate text (a memory line, fact, summary, or past decision). */
  text: string
  /** Optional multiplier on the lexical score (e.g. recency / pin weight). Default 1. */
  boost?: number
}

/** Lowercase alphanumeric tokens; stopwords and 1-char tokens dropped. Pure. */
export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOPWORDS.has(t))
}

/**
 * Lexical relevance of `text` to `query`, in roughly [0, ~1.5]:
 * for each DISTINCT query token present in `text`, add 1 + a small sublinear
 * term-frequency bonus (a token that recurs in the text counts a touch more),
 * then normalize by the number of distinct query tokens. 0 = no overlap. Pure.
 */
export function scoreRecall(query: string, text: string): number {
  const qSet = new Set(tokenize(query))
  if (qSet.size === 0) return 0
  const textTokens = tokenize(text)
  if (textTokens.length === 0) return 0
  const tf = new Map<string, number>()
  for (const t of textTokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  let score = 0
  for (const qt of qSet) {
    const freq = tf.get(qt)
    if (!freq) continue
    score += 1 + Math.min(0.5, Math.log(1 + freq) * 0.2)
  }
  return score / qSet.size
}

/**
 * Score + rank `items` against `query`, returning the top matches as PackItems
 * (text + score) ready for packContext. Items with zero overlap are dropped
 * unless `keepZero` is set. Stable for equal scores (preserves input order).
 */
export function recall(
  query: string,
  items: RecallItem[],
  opts: { topK?: number; keepZero?: boolean } = {},
): PackItem[] {
  const { topK = 12, keepZero = false } = opts
  return items
    .map((it, i) => ({ text: it.text, score: scoreRecall(query, it.text) * (it.boost ?? 1), i }))
    .filter(s => keepZero || s.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .slice(0, Math.max(0, topK))
    .map(({ text, score }) => ({ text, score }))
}

/**
 * Recall + budget-pack in one call: lexically rank the candidates against the
 * query, then hand the scored survivors to packContext (which trims to a char
 * budget and reorders strongest-to-the-ends). Returns the packed PackResult.
 */
export function recallAndPack(
  query: string,
  items: RecallItem[],
  packOpts: PackOptions = {},
  recallOpts: { topK?: number } = {},
): PackResult {
  return packContext(recall(query, items, recallOpts), packOpts)
}
