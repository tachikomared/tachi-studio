// apps/desktop/src/pages/catalog/familySiblings.ts
//
// Open-GenAI family-sibling coherence.
//
// Given a model id or family string, this module maps between related modality
// variants within the same model family — e.g. a text LLM suggests its vision
// sibling, or an image-gen model suggests its video (T2V/I2V) counterpart.
//
// The lookup is pure: it reads from the flat CatalogEntry array already loaded
// into the store and never does I/O. It returns CatalogEntry objects (not just
// ids) so call sites can display name + capabilities immediately.
//
// Sibling modality table (based on known Open-GenAI / HF family patterns):
//   chat / reasoning / code / tools  →  vision          (text → multimodal)
//   vision                           →  chat            (multimodal → text base)
//   image-gen (T2I)                  →  video-gen (T2V) (image → video gen)
//   video-gen (T2V)                  →  image-gen       (video → image gen)
//   tts                              →  stt             (TTS ↔ STT for same voice family)
//   stt                              →  tts
//
// Zero dependencies — pure TypeScript, uses only @tachi/core CatalogEntry type.

import type { CatalogEntry, Capability } from '@tachi/core'

// ---------------------------------------------------------------------------
// Modality adjacency table
// ---------------------------------------------------------------------------

/**
 * For a given source capability, which capabilities are considered "siblings"?
 * Order matters: the first non-empty match from the catalog wins.
 */
const SIBLING_CAP_MAP: Partial<Record<Capability, Capability[]>> = {
  // Text LLMs suggest their vision / multimodal variant.
  chat:      ['vision'],
  reasoning: ['vision'],
  code:      ['vision'],
  tools:     ['vision'],
  // Vision models suggest the plain-text base.
  vision:    ['chat'],
  // Image generation suggests video generation and vice-versa.
  'image-gen': ['video-gen'],
  'video-gen': ['image-gen'],
  // Speech: TTS ↔ STT pairings within the same family.
  tts:  ['stt'],
  stt:  ['tts'],
}

// ---------------------------------------------------------------------------
// Family-normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a family string for loose comparison:
 * lower-case, collapse separators, strip trailing size tokens like "7b", "13b".
 *
 * Examples:
 *   "Llama-3.2-Vision"  →  "llama32vision"
 *   "piper · en_GB"     →  "piper"
 *   "Wan 2.1"           →  "wan"
 */
function normaliseFamily(family: string): string {
  return family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '') // strip non-alphanum
    .replace(/\d+b$/g, '')      // strip trailing "7b", "13b" etc.
}

/**
 * Two entries are "family-related" if their normalised family strings share a
 * common prefix of at least MIN_FAMILY_PREFIX_LEN characters.  This tolerates
 * small suffixes like locale codes in piper voice names without being so loose
 * that unrelated families collide.
 */
const MIN_FAMILY_PREFIX_LEN = 3

function familiesAreRelated(a: string, b: string): boolean {
  const na = normaliseFamily(a)
  const nb = normaliseFamily(b)
  if (!na || !nb) return false
  const len = Math.min(na.length, nb.length, MIN_FAMILY_PREFIX_LEN + 4)
  return na.slice(0, len) === nb.slice(0, len)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result returned by findSiblings.  May contain zero, one, or multiple
 * entries per sibling capability type.
 */
export interface SiblingResult {
  /** The capability this sibling entry represents (e.g. "vision"). */
  siblingCap: Capability
  /** Matching catalog entries, sorted by downloads desc (popularity). */
  entries: CatalogEntry[]
}

/**
 * Find sibling-modality catalog entries for a given source entry.
 *
 * The algorithm:
 *   1. Derive the source capability set from `source.capabilities`.
 *   2. For each source cap, look up SIBLING_CAP_MAP to get candidate sibling caps.
 *   3. Walk the `catalog` array for entries that:
 *       a. Have at least one of the sibling caps.
 *       b. Are in the same (or closely-related) family as `source`.
 *       c. Are NOT the source entry itself.
 *   4. Deduplicate by entry id.
 *   5. Group by sibling cap, sort each group by popularity (downloads desc).
 *
 * @param source   The entry the user has selected or is hovering.
 * @param catalog  All catalog entries (curated + hf results from the store).
 * @param maxPerCap Maximum siblings to return per sibling-cap type (default 3).
 *
 * @returns Array of SiblingResult, one per unique sibling cap that had matches.
 *          Returns [] when no siblings exist.
 *
 * @example
 *   // In a ModelCard or QuantPicker:
 *   const siblings = findSiblings(entry, [...curated, ...hfResults])
 *   // siblings might be [{ siblingCap: 'vision', entries: [llama-vision-entry] }]
 */
export function findSiblings(
  source: CatalogEntry,
  catalog: CatalogEntry[],
  maxPerCap = 3,
): SiblingResult[] {
  const sourceCaps: Capability[] = source.capabilities ?? []
  if (sourceCaps.length === 0) return []

  // Collect all unique sibling capability targets.
  const targetCaps = new Set<Capability>()
  for (const cap of sourceCaps) {
    const targets = SIBLING_CAP_MAP[cap]
    if (targets) targets.forEach(c => targetCaps.add(c))
  }
  if (targetCaps.size === 0) return []

  // Find candidate entries for each sibling cap.
  // Use a Map to deduplicate by entry id across caps.
  const byCap = new Map<Capability, Map<string, CatalogEntry>>()
  for (const cap of targetCaps) {
    byCap.set(cap, new Map())
  }

  for (const entry of catalog) {
    if (entry.id === source.id) continue

    const entryCaps: Capability[] = entry.capabilities ?? []

    for (const cap of targetCaps) {
      if (!entryCaps.includes(cap)) continue

      // Family relatedness check — skip if family is too different.
      if (!familiesAreRelated(source.family, entry.family)) continue

      const bucket = byCap.get(cap)!
      if (!bucket.has(entry.id)) bucket.set(entry.id, entry)
    }
  }

  // Build results, sorted by popularity.
  const results: SiblingResult[] = []
  for (const [siblingCap, entryMap] of byCap.entries()) {
    if (entryMap.size === 0) continue

    const sorted = Array.from(entryMap.values()).sort(
      (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0),
    )
    results.push({
      siblingCap,
      entries: sorted.slice(0, maxPerCap),
    })
  }

  // Sort result groups: text-adjacent caps first (vision, chat), then media.
  const CAP_ORDER: Capability[] = ['vision', 'chat', 'image-gen', 'video-gen', 'tts', 'stt']
  results.sort(
    (a, b) =>
      (CAP_ORDER.indexOf(a.siblingCap) === -1 ? 99 : CAP_ORDER.indexOf(a.siblingCap)) -
      (CAP_ORDER.indexOf(b.siblingCap) === -1 ? 99 : CAP_ORDER.indexOf(b.siblingCap)),
  )

  return results
}

/**
 * Convenience: return the single best sibling for a given target capability.
 * Returns null when no sibling exists.
 *
 * @example
 *   const visionSibling = findBestSibling(textEntry, catalog, 'vision')
 *   if (visionSibling) showSiblingBadge(visionSibling)
 */
export function findBestSibling(
  source: CatalogEntry,
  catalog: CatalogEntry[],
  targetCap: Capability,
): CatalogEntry | null {
  const results = findSiblings(source, catalog, 1)
  const match = results.find(r => r.siblingCap === targetCap)
  return match?.entries[0] ?? null
}

/**
 * True when `source` has a sibling of the given capability in `catalog`.
 * Cheap pre-check to decide whether to show a suggestion badge at all.
 */
export function hasSibling(
  source: CatalogEntry,
  catalog: CatalogEntry[],
  targetCap: Capability,
): boolean {
  return findBestSibling(source, catalog, targetCap) !== null
}
