// apps/desktop/test/unit/catalogStore.test.ts
//
// Pure-mutation coverage for the catalog store's favorites + recents:
//   - toggleFavorite (on/off, multiple ids)
//   - recordRecent   (most-recent-first, dedupe, 6-slot cap)
//   - localStorage persistence shape written by both actions
//
// The store module reads localStorage at module-creation time (initial
// favorites/recents) and writes it in the two actions under test, so we install
// a minimal in-memory localStorage shim on globalThis BEFORE importing the
// store. This is a test shim only — no source change. i18n (imported by the
// store) also touches localStorage at init but is try/catch-guarded.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

const LS_FAVORITES = 'tachi:catalog-favorites'
const LS_RECENTS = 'tachi:catalog-recents'

// --- in-memory localStorage shim (installed before the store is imported) ----
const store = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => { store.set(k, v) },
  removeItem: (k: string): void => { store.delete(k) },
  clear: (): void => { store.clear() },
  key: (i: number): string | null => Array.from(store.keys())[i] ?? null,
  get length(): number { return store.size },
}
;(globalThis as unknown as { localStorage: typeof localStorageShim }).localStorage = localStorageShim

// Imported lazily after the shim is in place.
type CatalogStore = typeof import('../../src/pages/catalog/catalog.store')
let useCatalogStore: CatalogStore['useCatalogStore']

beforeAll(async () => {
  ;({ useCatalogStore } = await import('../../src/pages/catalog/catalog.store'))
})

beforeEach(() => {
  // Reset both the persisted shim and the in-memory store state so each test
  // starts from empty favorites/recents regardless of order.
  store.clear()
  useCatalogStore.setState({ favorites: [], recents: [] })
})

describe('toggleFavorite', () => {
  it('adds an id to favorites when not present', () => {
    useCatalogStore.getState().toggleFavorite('a')
    expect(useCatalogStore.getState().favorites).toEqual(['a'])
  })

  it('removes the id on a second toggle (on → off)', () => {
    const { toggleFavorite } = useCatalogStore.getState()
    toggleFavorite('a')
    toggleFavorite('a')
    expect(useCatalogStore.getState().favorites).toEqual([])
  })

  it('keeps other favorites when toggling one off', () => {
    const { toggleFavorite } = useCatalogStore.getState()
    toggleFavorite('a')
    toggleFavorite('b')
    toggleFavorite('a')
    expect(useCatalogStore.getState().favorites).toEqual(['b'])
  })

  it('appends new favorites in insertion order', () => {
    const { toggleFavorite } = useCatalogStore.getState()
    toggleFavorite('a')
    toggleFavorite('b')
    toggleFavorite('c')
    expect(useCatalogStore.getState().favorites).toEqual(['a', 'b', 'c'])
  })

  it('persists the favorites array as JSON under the favorites key', () => {
    useCatalogStore.getState().toggleFavorite('a')
    useCatalogStore.getState().toggleFavorite('b')
    expect(JSON.parse(localStorageShim.getItem(LS_FAVORITES)!)).toEqual(['a', 'b'])
  })

  it('persists the shortened array after toggling an id off', () => {
    const { toggleFavorite } = useCatalogStore.getState()
    toggleFavorite('a')
    toggleFavorite('a')
    expect(JSON.parse(localStorageShim.getItem(LS_FAVORITES)!)).toEqual([])
  })
})

describe('recordRecent', () => {
  it('records a single id', () => {
    useCatalogStore.getState().recordRecent('a')
    expect(useCatalogStore.getState().recents).toEqual(['a'])
  })

  it('puts the most-recent id first', () => {
    const { recordRecent } = useCatalogStore.getState()
    recordRecent('a')
    recordRecent('b')
    recordRecent('c')
    expect(useCatalogStore.getState().recents).toEqual(['c', 'b', 'a'])
  })

  it('dedupes — re-recording an existing id moves it to the front without growing', () => {
    const { recordRecent } = useCatalogStore.getState()
    recordRecent('a')
    recordRecent('b')
    recordRecent('a')
    expect(useCatalogStore.getState().recents).toEqual(['a', 'b'])
  })

  it('caps the list at 6 entries, dropping the oldest (most-recent-first)', () => {
    const { recordRecent } = useCatalogStore.getState()
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) recordRecent(id)
    const { recents } = useCatalogStore.getState()
    expect(recents).toHaveLength(6)
    // 'a' (oldest) is evicted; newest-first ordering preserved.
    expect(recents).toEqual(['g', 'f', 'e', 'd', 'c', 'b'])
  })

  it('caps at 6 even after a re-record promotes an old id past the boundary', () => {
    const { recordRecent } = useCatalogStore.getState()
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) recordRecent(id) // f..a, len 6
    recordRecent('a') // promote 'a' to front — still 6, 'b' now the tail to drop next
    const { recents } = useCatalogStore.getState()
    expect(recents).toHaveLength(6)
    expect(recents[0]).toBe('a')
    expect(recents).toEqual(['a', 'f', 'e', 'd', 'c', 'b'])
  })

  it('persists the capped recents array as JSON under the recents key', () => {
    const { recordRecent } = useCatalogStore.getState()
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) recordRecent(id)
    expect(JSON.parse(localStorageShim.getItem(LS_RECENTS)!)).toEqual(['g', 'f', 'e', 'd', 'c', 'b'])
  })
})
