// apps/desktop/electron/services/util/rrf.ts
//
// Reciprocal-Rank-Fusion + a dependency-free BM25-lite lexical ranker. Ported
// from code-review-graph search.py (rrf_merge: sum 1/(k+rank+1), k=60). Used by
// conversations_search to upgrade unranked substring hits into relevance-ranked
// results by fusing the substring-discovery order with a term-frequency /
// doc-length ranking computed over the SAME conversation text.
//
// TachiDesk has no embedder, so this is LEXICAL fusion only: there is no vector
// list to merge — just two views of the lexical signal (presence order +
// weighted term overlap).
//
// Pure TypeScript — no imports, no side-effects (vitest-importable; no electron
// dependency).

// RRF damping constant. Higher k flattens the contribution of rank differences
// so a strong-in-both item still beats a strong-in-one item without being
// dominated by a single list's top slot. 60 is the value from the steal source.
export const RRF_K = 60

/**
 * Reciprocal Rank Fusion over any number of ordered id lists.
 *
 * Each input is an ordered list of ids (best first). An id's fused score is the
 * sum across the lists it appears in of 1/(k + rank + 1), where rank is its
 * 0-based position in that list. Ids are returned best-first.
 *
 * Properties relied on by the caller: every id present in ANY input appears
 * exactly once in the output (fusion only re-orders, never drops). Ties keep
 * first-seen order, so the result is deterministic. A repeated id within one
 * list contributes only its FIRST (best) position.
 */
export function rrfMerge(lists: string[][], k: number = RRF_K): string[] {
  const scores = new Map<string, number>()
  // Insertion order of this Map doubles as the stable tiebreak: an id first
  // seen earlier keeps its edge when scores are equal.
  for (const list of lists) {
    const seenInList = new Set<string>()
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!
      if (seenInList.has(id)) continue // first (best) position wins within a list
      seenInList.add(id)
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
    }
  }

  // Stable sort by score descending; Array.prototype.sort is stable in V8, and
  // Map iteration preserves insertion order, so equal scores keep first-seen
  // order.
  return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!)
}

// Word tokens: runs of letters/digits, lowercased. Good enough for chat prose;
// no stemming (matches the simple, no-external-dep contract).
function tokenize(text: string): string[] {
  const out: string[] = []
  const re = /[a-z0-9]+/g
  let m: RegExpExecArray | null
  const lower = text.toLowerCase()
  while ((m = re.exec(lower)) !== null) out.push(m[0])
  return out
}

// BM25 saturation/length-normalization params (Robertson/Sparck-Jones defaults).
const BM25_K1 = 1.5
const BM25_B = 0.75

/**
 * BM25-lite: rank docs by weighted query-term overlap, with term-frequency
 * saturation (k1) and document-length normalization (b). No external dep, no
 * persisted index — the corpus is the docs passed in, scored in one pass.
 *
 * Returns the ids of docs with > 0 score, best first. Docs with zero
 * query-term overlap are omitted (they are noise for a lexical search). Empty
 * query or empty corpus -> [].
 */
export function bm25Lite(query: string, docs: Array<{ id: string; text: string }>): string[] {
  const qTerms = [...new Set(tokenize(query))]
  if (qTerms.length === 0 || docs.length === 0) return []

  // Tokenize once; collect per-doc term frequencies, lengths, and document
  // frequency per query term (for the IDF weight).
  const tokenized = docs.map(d => tokenize(d.text))
  const lengths = tokenized.map(t => t.length)
  const avgLen = lengths.reduce((a, b) => a + b, 0) / docs.length || 1

  const df = new Map<string, number>()
  const tfs: Array<Map<string, number>> = []
  for (const tokens of tokenized) {
    const tf = new Map<string, number>()
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1)
    tfs.push(tf)
    for (const qt of qTerms) if (tf.has(qt)) df.set(qt, (df.get(qt) ?? 0) + 1)
  }

  const N = docs.length
  // Standard BM25 IDF with the +1 floor so a term present in every doc still
  // carries a small positive weight (never negative — that would let a long doc
  // win by sheer length).
  const idf = new Map<string, number>()
  for (const qt of qTerms) {
    const n = df.get(qt) ?? 0
    idf.set(qt, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
  }

  const scored: Array<{ id: string; score: number; ord: number }> = []
  for (let i = 0; i < docs.length; i++) {
    const tf = tfs[i]!
    const len = lengths[i]!
    let score = 0
    for (const qt of qTerms) {
      const f = tf.get(qt) ?? 0
      if (f === 0) continue
      const numer = f * (BM25_K1 + 1)
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (len / avgLen))
      score += idf.get(qt)! * (numer / denom)
    }
    if (score > 0) scored.push({ id: docs[i]!.id, score, ord: i })
  }

  // Score descending; original order breaks ties (deterministic).
  scored.sort((a, b) => b.score - a.score || a.ord - b.ord)
  return scored.map(s => s.id)
}
