// apps/desktop/src/pages/catalog/modelSelectCache.ts
//
// AppFlowy model_select.rs pattern: a generic TTL cache with stale-on-failure.
//
// Behaviour summary:
//   - cachedFetch(key, fetcher, opts) returns FRESH data when the cached value
//     is younger than ttlMs (default 300 s).
//   - When the cache is EXPIRED, it kicks off a background refetch. It RETURNS
//     the stale cached value immediately so the picker never goes empty while the
//     network is slow or unreliable.
//   - If the background refetch succeeds, the cache is updated; the caller may
//     call cachedFetch again to pick up the fresh value.
//   - If the background refetch throws (transient HF / network failure), the
//     stale value is kept — the error is swallowed here because showing an
//     empty picker is worse than showing slightly-outdated data.
//   - A MISS (nothing in cache) awaits the fetcher synchronously and stores the
//     result, then returns it. Any throw on a cold miss propagates to the caller
//     so the UI can show a proper loading/error state on first load.
//
// Zero dependencies — pure TypeScript, no npm packages.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options accepted by cachedFetch. */
export interface CachedFetchOpts {
  /**
   * Time-to-live in milliseconds. After this window the cached value is
   * considered EXPIRED and a background refetch is triggered.
   * Default: 300_000 ms (5 minutes).
   */
  ttlMs?: number
}

/** Internal cache entry. Not exported — callers only see the value T. */
interface CacheEntry<T> {
  value: T
  /** Epoch ms when this entry was stored. */
  storedAt: number
  /** True while a background refetch is in flight (prevents duplicate requests). */
  refreshing: boolean
}

// ---------------------------------------------------------------------------
// Module-level cache storage
// ---------------------------------------------------------------------------

// Using a plain Map keyed by the caller-supplied string key.
// One global map is intentional: same key across different call sites shares
// the same cache, which is the correct behaviour for a model-list cache (the
// source of truth is the remote endpoint, not the component).
const _cache = new Map<string, CacheEntry<unknown>>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch-with-TTL, stale-on-failure.
 *
 * @param key     Unique cache key — recommend namespaced strings like
 *                `"hf:search:${query}"` or `"curated:entries"`.
 * @param fetcher Async function that returns the fresh value.
 * @param opts    Optional TTL override.
 *
 * @returns The cached value (possibly stale) or the result of awaiting
 *          `fetcher` on a cold miss.
 *
 * @throws  Only on cold miss when `fetcher` throws. Never throws when
 *          returning a stale value.
 *
 * @example
 *   // In catalog.store.ts runHfSearch:
 *   const entries = await cachedFetch(
 *     `hf:search:${q}`,
 *     () => window.tachi.catalog.searchHf(q).then(r => r.entries),
 *     { ttlMs: 60_000 },
 *   )
 */
export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts: CachedFetchOpts = {},
): Promise<T> {
  const ttlMs = opts.ttlMs ?? 300_000
  const now = Date.now()
  const entry = _cache.get(key) as CacheEntry<T> | undefined

  // --- COLD MISS: nothing in cache — must await synchronously so the caller
  //     gets a real value (or a real error) rather than undefined.
  if (entry === undefined) {
    const value = await fetcher() // may throw — propagated to caller
    _cache.set(key, { value, storedAt: Date.now(), refreshing: false })
    return value
  }

  const age = now - entry.storedAt

  // --- FRESH: within TTL window — return as-is.
  if (age < ttlMs) {
    return entry.value
  }

  // --- EXPIRED: return stale value immediately and trigger a background
  //     refetch, guarded so at most one concurrent fetch runs per key.
  if (!entry.refreshing) {
    // Mark as refreshing before the async call so parallel callers don't
    // stack up identical fetches.
    entry.refreshing = true
    _backgroundRefetch(key, fetcher)
  }

  // Return the stale value — the picker stays populated.
  return entry.value
}

/**
 * Explicitly invalidate a cache key so the next cachedFetch call is a cold
 * miss. Useful after a successful model install/delete to force a fresh list.
 */
export function invalidateCache(key: string): void {
  _cache.delete(key)
}

/**
 * Invalidate all keys whose string matches the given prefix.
 * Useful for clearing all `"hf:search:*"` entries at once.
 */
export function invalidateCachePrefix(prefix: string): void {
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) _cache.delete(k)
  }
}

/**
 * Return how many milliseconds ago the key was stored, or null if absent.
 * Primarily for diagnostics / testing.
 */
export function cacheAge(key: string): number | null {
  const entry = _cache.get(key)
  return entry !== undefined ? Date.now() - entry.storedAt : null
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget background refetch. Updates the cache entry on success,
 * clears `refreshing` flag on failure (so a future call retries), and never
 * propagates — swallowing errors here is intentional (stale > empty).
 */
function _backgroundRefetch<T>(key: string, fetcher: () => Promise<T>): void {
  fetcher().then(
    (value) => {
      // Success — replace the entry with fresh data.
      _cache.set(key, { value, storedAt: Date.now(), refreshing: false })
    },
    (_err) => {
      // Failure — clear the refreshing flag so the next call tries again.
      // The existing stale value is kept unchanged.
      const existing = _cache.get(key)
      if (existing) existing.refreshing = false
      // Intentionally not surfacing the error: stale > empty.
    },
  )
}
