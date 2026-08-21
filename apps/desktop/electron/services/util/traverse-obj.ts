// apps/desktop/electron/services/util/traverse-obj.ts
//
// Safe nested-object traversal with multi-path fallback and type coercion.
// Inspired by the yt-dlp traverse_obj utility (yt_dlp/utils/traversal.py).
//
// Primary use-case: safely extracting fields from provider API responses (e.g.
// Bankr, Surplus, Venice) where the shape may vary by model or API version.
// Avoids `?.` chains that get unwieldy at 4+ levels or with array indexing.
//
// Usage:
//   // Simple dot-path:
//   traverseObj(res, 'choices.0.message.content', { expectedType: 'string' })
//
//   // Multi-path fallback (first non-null hit wins):
//   traverseObj(res, ['choices.0.message.content', 'text', 'output'], {
//     expectedType: 'string',
//     default: '',
//   })
//
//   // Array of all items matching a key:
//   traverseObj(data, 'models', { expectedType: 'array', default: [] })
//
// Pure TypeScript — no imports, no side-effects.

// ─── Types ────────────────────────────────────────────────────────────────────

/** The supported expected-type checks. */
export type TraverseExpectedType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any'

export interface TraverseOptions<T> {
  /**
   * If specified, the resolved value is only returned when
   * `typeof value === expectedType` (or 'array' uses `Array.isArray`).
   * 'any' skips the type check.
   * Defaults to 'any'.
   */
  expectedType?: TraverseExpectedType
  /**
   * Value returned when no path resolves to a conforming value.
   * Defaults to `undefined`.
   */
  default?: T
  /**
   * When true, an empty string / empty array counts as "not found" and the
   * next path (or default) is tried.  Defaults to false.
   */
  skipEmpty?: boolean
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Safely traverse `obj` using one or more dot-notation paths, returning the
 * first value that satisfies the expected type check.
 *
 * Path segments:
 *   - Plain string keys: `'choices.0.message.content'`
 *   - Numeric indices: `'0'` or `'data.0.id'`
 *   - Wildcard `'*'`: collect all values at this level into an array, then
 *     continue traversal on each element and flatten one level.
 *
 * @param obj     - The root object to traverse (any value, safely handles null/undefined).
 * @param path    - A single dot-path string or an array of paths tried in order.
 * @param options - Type expectation, default, and skip-empty behaviour.
 * @returns The resolved value cast to T, or `options.default` (default `undefined`).
 */
export function traverseObj<T = unknown>(
  obj: unknown,
  path: string | string[],
  options?: TraverseOptions<T>,
): T | undefined {
  const paths = Array.isArray(path) ? path : [path]
  const expectedType: TraverseExpectedType = options?.expectedType ?? 'any'
  const skipEmpty = options?.skipEmpty ?? false
  const fallback  = options?.default

  for (const p of paths) {
    const value = _resolvePath(obj, p)
    if (value === undefined || value === null) continue
    if (!_typeMatches(value, expectedType)) continue
    if (skipEmpty && _isEmpty(value)) continue
    return value as T
  }

  return fallback
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Walk a single dot-separated path through `root`.
 * A numeric segment is treated as an array index.
 * A `*` segment collects all own values at that level and continues
 * traversal, returning a flattened array.
 *
 * Returns `undefined` on any access error (null dereference, missing key, etc.).
 */
function _resolvePath(root: unknown, path: string): unknown {
  if (path === '' || path === '.') return root

  const segments = path.split('.')
  // Walk iteratively to avoid stack growth on long paths.
  let current: unknown = root

  for (let i = 0; i < segments.length; i++) {
    if (current === undefined || current === null) return undefined

    const seg = segments[i]

    if (seg === '*') {
      // Wildcard: collect all own-enumerable values at this level.
      if (typeof current !== 'object') return undefined
      const rest = segments.slice(i + 1).join('.')
      const items = Object.values(current as Record<string, unknown>)
      if (!rest) return items
      // Recurse and flatten one level.
      const collected: unknown[] = []
      for (const item of items) {
        const v = _resolvePath(item, rest)
        if (v !== undefined && v !== null) {
          if (Array.isArray(v)) collected.push(...v)
          else collected.push(v)
        }
      }
      return collected.length > 0 ? collected : undefined
    }

    // Normal key access.
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[seg]
  }

  return current
}

/** Returns true when the value satisfies the expected type constraint. */
function _typeMatches(value: unknown, expected: TraverseExpectedType): boolean {
  switch (expected) {
    case 'any':     return true
    case 'array':   return Array.isArray(value)
    case 'string':  return typeof value === 'string'
    case 'number':  return typeof value === 'number'
    case 'boolean': return typeof value === 'boolean'
    case 'object':  return typeof value === 'object' && !Array.isArray(value) && value !== null
    default:        return false
  }
}

/** True when the value is considered "empty" for skipEmpty purposes. */
function _isEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.length === 0
  if (Array.isArray(value))      return value.length === 0
  return false
}
