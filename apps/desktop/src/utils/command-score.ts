// apps/desktop/src/utils/command-score.ts
//
// Weighted command ranking — nocodb-style tiered match scoring.
//
// Scoring tiers (higher = better match):
//   EXACT        — query === candidate (normalised, case-insensitive)
//   PREFIX       — candidate starts with query
//   WORD_PREFIX  — any whitespace-delimited word in candidate starts with query
//   SUBSTRING    — candidate contains query as a contiguous substring
//   SUBSEQUENCE  — every character of query appears in candidate in order
//   NO_MATCH     — 0, filtered out by rankItems
//
// All comparisons are lower-cased and trim()-ed. Scores are plain numbers so
// callers can sort ascending (lower index = better) or descending (higher = better).
// rankItems sorts descending, so the best match is first.
//
// Zero external dependencies. Pure functions only.

export const SCORE = {
  EXACT:        1000,
  PREFIX:        800,
  WORD_PREFIX:   600,
  SUBSTRING:     400,
  SUBSEQUENCE:   200,
  NO_MATCH:        0,
} as const

/**
 * Score how well `query` matches `text`. Returns a number in the range
 * [0, 1000+]. A return value of 0 means no match; > 0 means some match.
 *
 * The score has two components:
 *   - A tier base (EXACT / PREFIX / WORD_PREFIX / SUBSTRING / SUBSEQUENCE)
 *   - A fractional bonus in [0, 1) reflecting how early the match starts and
 *     how much of `text` is covered. This keeps equal-tier items stable while
 *     still differentiating "go" matching "Go to Chat" vs "Go to Nodes".
 */
export function scoreMatch(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  const t = text.trim().toLowerCase()

  if (!q || !t) return 0

  // EXACT
  if (q === t) return SCORE.EXACT + 1

  // PREFIX — text starts with the full query
  if (t.startsWith(q)) {
    // Bonus: the shorter the text relative to query, the closer to exact.
    const coverage = q.length / t.length          // (0, 1]
    return SCORE.PREFIX + coverage
  }

  // WORD_PREFIX — any word in text starts with the full query
  const words = t.split(/\s+/)
  const wordPrefixIdx = words.findIndex(w => w.startsWith(q))
  if (wordPrefixIdx !== -1) {
    // Earlier word = better bonus (wordPrefixIdx 0 → bonus 0.9, later → smaller).
    const posBonus = 1 / (wordPrefixIdx + 1)
    return SCORE.WORD_PREFIX + posBonus
  }

  // SUBSTRING — text contains query as a contiguous run
  const subIdx = t.indexOf(q)
  if (subIdx !== -1) {
    // Earlier position = better. bonus in (0, 1).
    const posBonus = 1 - subIdx / t.length
    return SCORE.SUBSTRING + posBonus
  }

  // SUBSEQUENCE / FUZZY — every character of query appears in order in text
  if (isSubsequence(q, t)) {
    // Bonus: ratio of matched chars to text length (higher density = better).
    const density = q.length / t.length
    return SCORE.SUBSEQUENCE + density
  }

  return SCORE.NO_MATCH
}

/**
 * Score `query` against multiple fields and return the highest score.
 * Useful when an item has both a label and a hint/group string.
 */
export function scoreMatchMulti(query: string, fields: string[]): number {
  let best = 0
  for (const f of fields) {
    const s = scoreMatch(query, f)
    if (s > best) best = s
  }
  return best
}

/**
 * Return true if every character of `needle` appears in `haystack` in order.
 * Classic O(n) two-pointer walk.
 */
function isSubsequence(needle: string, haystack: string): boolean {
  let ni = 0
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (haystack[hi] === needle[ni]) ni++
  }
  return ni === needle.length
}

/**
 * Rank an array of items by how well they match `query`.
 *
 * @param query   — the search string typed by the user
 * @param items   — the full item array (any type)
 * @param getText — extractor: given an item, return the string(s) to score
 *                  against. Return a single string or an array for multi-field.
 * @returns a new sorted array with NO_MATCH items excluded when `query` is
 *          non-empty. When `query` is blank/empty the original order is returned
 *          (pass-through, no copy, no filter) so callers keep their natural
 *          ordering at rest.
 */
export function rankItems<T>(
  query: string,
  items: T[],
  getText: (item: T) => string | string[],
): T[] {
  const q = query.trim()
  if (!q) return items                          // no query → preserve order

  // Score every item
  const scored: Array<{ item: T; score: number }> = []
  for (const item of items) {
    const raw = getText(item)
    const fields = Array.isArray(raw) ? raw : [raw]
    const score = scoreMatchMulti(q, fields)
    if (score > SCORE.NO_MATCH) {
      scored.push({ item, score })
    }
  }

  // Sort descending (best score first), stable within same score (insertion order)
  scored.sort((a, b) => b.score - a.score)

  return scored.map(s => s.item)
}
