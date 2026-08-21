// apps/desktop/src/pages/catalog/search.ts
//
// Weighted multi-factor search for the curated catalog.
//
// Score weights (inspired by DevToys GuiToolProvider.SearchTools / WeightMatch
// and nocodb command-score.ts):
//
//   EXACT_WORD_MATCH      100  – whole token in name exactly matches query
//   PREFIX_MATCH           35  – name / family starts with query
//   SUBSTRING_MATCH        15  – query is a substring of name
//   FAMILY_PREFIX          12  – family starts with query
//   FAMILY_SUBSTRING        8  – query is substring of family
//   CAPABILITY_MATCH        5  – query matches a capability tag token
//   PARAMS_MATCH            4  – query matches params token (e.g. "7b")
//   FUZZY_BONUS             2  – all query chars appear in order (non-contiguous)
//
// Scores accumulate — a model that matches in multiple fields scores higher.
// Capability-tag pre-filter is applied BEFORE scoring (unchanged behaviour).
//
// Request-coordinator (pattern from VidBee video-request-coordinator):
// A monotonically-increasing counter guards async HF searches so that only the
// response to the *latest* issued request is ever applied to state.

import type { CatalogEntry, Capability } from '@tachi/core'

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------
const W_EXACT_WORD   = 100
const W_PREFIX_NAME  = 35
const W_SUBSTR_NAME  = 15
const W_PREFIX_FAM   = 12
const W_SUBSTR_FAM   = 8
const W_CAPABILITY   = 5
const W_PARAMS       = 4
const W_FUZZY        = 2

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a string into lowercase alpha-numeric tokens. */
function tokens(s: string): string[] {
  return s.toLowerCase().split(/[\s\-_./:]+/).filter(Boolean)
}

/** True if every character in `needle` appears in `haystack` in order
 *  (non-contiguous subsequence). */
function isFuzzyMatch(needle: string, haystack: string): boolean {
  let hi = 0
  for (let ni = 0; ni < needle.length; ni++) {
    const ch = needle[ni]
    while (hi < haystack.length && haystack[hi] !== ch) hi++
    if (hi >= haystack.length) return false
    hi++
  }
  return true
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScoredEntry {
  entry: CatalogEntry
  score: number
}

/**
 * Score a single CatalogEntry against a query string.
 * Returns 0 when there is no match at all (should be excluded from results).
 */
export function scoreEntry(entry: CatalogEntry, rawQuery: string): number {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return 1 // blank query → always include, neutral score

  const nameLower = entry.name.toLowerCase()
  const famLower  = entry.family.toLowerCase()
  const paramsLower = (entry.params ?? '').toLowerCase()
  const qTokens = tokens(q)

  let score = 0

  // 1. Exact-word match — any query token equals a name token exactly (100 pts each)
  const nameTokens = tokens(nameLower)
  for (const qt of qTokens) {
    if (nameTokens.includes(qt)) score += W_EXACT_WORD
  }

  // 2. Name prefix (full query)
  if (nameLower.startsWith(q)) score += W_PREFIX_NAME

  // 3. Name substring
  if (nameLower.includes(q)) score += W_SUBSTR_NAME

  // 4. Family prefix
  if (famLower.startsWith(q)) score += W_PREFIX_FAM

  // 5. Family substring
  if (famLower.includes(q)) score += W_SUBSTR_FAM

  // 6. Capability tag token match
  const caps: Capability[] = entry.capabilities ?? []
  for (const cap of caps) {
    const capLower = cap.toLowerCase()
    for (const qt of qTokens) {
      if (capLower.includes(qt) || qt.includes(capLower)) {
        score += W_CAPABILITY
        break
      }
    }
  }

  // 7. Params match (e.g. typing "7b" should match "7B" in params)
  if (paramsLower) {
    for (const qt of qTokens) {
      if (paramsLower.includes(qt)) score += W_PARAMS
    }
  }

  // 8. Fuzzy bonus — all chars of query appear in name in order
  if (score === 0 && isFuzzyMatch(q, nameLower)) score += W_FUZZY
  else if (isFuzzyMatch(q, nameLower)) score += W_FUZZY

  return score
}

/**
 * Filter and rank a list of CatalogEntry objects by relevance to `query`.
 * Entries with score 0 are excluded.  Falls through to original order on ties.
 *
 * `activeTags` is applied as a pre-filter (unchanged behaviour).
 */
export function searchEntries(
  entries: CatalogEntry[],
  query: string,
  activeTags: Capability[],
): CatalogEntry[] {
  const q = query.trim()

  // Capability pre-filter (unchanged from original)
  const tagFiltered = activeTags.length === 0
    ? entries
    : entries.filter(e => (e.capabilities ?? []).some(c => activeTags.includes(c)))

  if (!q) return tagFiltered

  const scored: ScoredEntry[] = tagFiltered
    .map(entry => ({ entry, score: scoreEntry(entry, q) }))
    .filter(s => s.score > 0)

  scored.sort((a, b) => b.score - a.score)
  return scored.map(s => s.entry)
}

// ---------------------------------------------------------------------------
// Request coordinator
// ---------------------------------------------------------------------------

export interface RequestCoordinator {
  /** Issue a new request id (invalidates all previous ids). */
  next(): number
  /** True iff `id` is still the most-recently issued id. */
  isCurrent(id: number): boolean
}

/**
 * Monotonically-increasing request counter — the stale-response guard.
 *
 * Usage in the store:
 *   const id = someCoordinator.next()
 *   const res = await doSearch(q)
 *   if (!someCoordinator.isCurrent(id)) return   // stale — discard
 *   applyResult(res)
 *
 * This used to be a single hand-rolled IIFE for the HF tab. The Civitai tab
 * needs the SAME rule — and needs its OWN counter, because one shared counter
 * would let a keystroke on one tab silently discard the other tab's in-flight
 * response (and, worse, a Civitai "Load more" would be invalidated by an
 * unrelated HF search). The closure body is unchanged; only its birth moved
 * into a factory, so the two surfaces cannot drift.
 */
export function createRequestCoordinator(): RequestCoordinator {
  let _current = 0
  return {
    next(): number { return ++_current },
    isCurrent(id: number): boolean { return id === _current },
  }
}

/** Guards the HuggingFace search on the Catalog `hf` tab. */
export const hfSearchCoordinator: RequestCoordinator = createRequestCoordinator()

/**
 * Guards the Civitai search AND its cursor "Load more" on the `civitai` tab.
 *
 * Deliberately the same counter for both: a fresh search MUST invalidate an
 * in-flight page append, or the appended page would land under a query that no
 * longer produced it (rows from "anime" showing up beneath results for "realism").
 */
export const civitaiSearchCoordinator: RequestCoordinator = createRequestCoordinator()
