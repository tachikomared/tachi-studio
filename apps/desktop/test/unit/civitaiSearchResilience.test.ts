// apps/desktop/test/unit/civitaiSearchResilience.test.ts
//
// TWO DRIVER-FOUND WAYS THE CIVITAI TAB LIED ABOUT ITSELF.
//
//  1. THE SILENT SFW DROP. `realistic` fetched a 24-row page and rendered TWO
//     cards. Nothing on screen said why, so a working content gate read as a
//     broken search. The service always knew the number — mapCivitaiPage threw
//     it away. `filteredCount` now rides the response and the tab prints it.
//     The GATE IS NOT WEAKENED by any of this: the count is the honesty, not a
//     knob (civitaiGate.test.ts still owns what gets through).
//
//  2. THE 503 THAT KILLED THE SEARCH. ~8 intermittent 503s in a 35-minute live
//     session, each one emptying the grid with no recovery but retyping the
//     query. ONE polite retry after ~2s on a 5xx — never on a 4xx, never a
//     loop — plus a Try-again affordance in the tab's error state.
//
// The fixture is the SAME 13-model live capture civitaiMapping.test.ts uses
// (2026-07-28), whose three gate-dropped models make the expected count a fact
// about real bytes rather than a hand-made object.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('../../electron/services/keychain', () => ({ retrieveKey: () => null }))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => 'open' }))

import {
  mapCivitaiPage,
  mapCivitaiPageCounted,
  searchCivitai,
  fetchCivitaiModelRows,
  isCivitaiRetryableStatus,
  CIVITAI_RETRY_DELAY_MS,
} from '../../electron/services/civitai-search'

const FIXTURES = fileURLToPath(new URL('../fixtures/civitai/', import.meta.url))
const rawPage = JSON.parse(readFileSync(join(FIXTURES, 'models-page.json'), 'utf8')) as {
  items: Array<Record<string, unknown>>
}
/** Protogen v2.2 — a model that sails through the gate (see the fixture map). */
const protogen = rawPage.items.find(m => (m as { id?: number }).id === 3627)!

// ─── 1. the count the tab needs ──────────────────────────────────────────────

describe('mapCivitaiPageCounted — the SFW drop is counted, not swallowed', () => {
  it('counts the models the gate removed entirely, on real captured bytes', () => {
    const { rows, filteredCount } = mapCivitaiPageCounted(rawPage)
    // 13 models in, 3 gate-dropped (4201 / 257749 / 122359 — see the fixture
    // header in civitaiMapping.test.ts), 10 cards out.
    expect(rows).toHaveLength(10)
    expect(filteredCount).toBe(3)
    expect(rows.length + filteredCount).toBe(rawPage.items.length)
  })

  it('is the same rows mapCivitaiPage always returned (no behaviour moved)', () => {
    expect(mapCivitaiPageCounted(rawPage).rows).toEqual(mapCivitaiPage(rawPage))
  })

  it('counts a MODEL once, not once per gated version', () => {
    // The failure this rules out: a card-level line reading "57 hidden" for a
    // 3-model drop, because each model carries ~19 versions.
    const gated = {
      items: [{
        id: 1, name: 'X', type: 'Checkpoint', nsfwLevel: 28,
        modelVersions: Array.from({ length: 19 }, (_, i) => ({
          id: 100 + i, name: `v${i}`, baseModel: 'SD 1.5', nsfwLevel: 28,
          files: [{ primary: true, name: 'x.safetensors', sizeKB: 1024, metadata: { format: 'SafeTensor' }, hashes: { SHA256: 'a'.repeat(64) }, downloadUrl: 'https://civitai.com/x' }],
        })),
      }],
    }
    expect(mapCivitaiPageCounted(gated).filteredCount).toBe(1)
  })

  it('a model that SURVIVES is never counted as filtered', () => {
    const { rows, filteredCount } = mapCivitaiPageCounted({ items: [protogen] })
    expect(rows.length).toBeGreaterThan(0)
    expect(filteredCount).toBe(0)
  })

  it('malformed data is not claimed as censorship', () => {
    // No usable version id ⇒ nothing was JUDGED, so nothing was hidden.
    expect(mapCivitaiPageCounted({ items: [{ id: 5, modelVersions: [] }] }).filteredCount).toBe(0)
    expect(mapCivitaiPageCounted({ items: [{ id: 5, modelVersions: [{ name: 'no id' }] }] }).filteredCount).toBe(0)
    expect(mapCivitaiPageCounted({ items: [] }).filteredCount).toBe(0)
    expect(mapCivitaiPageCounted(null).filteredCount).toBe(0)
  })

  it('the fast exit does not miscount a model whose LATER versions are gated', () => {
    // perModel is non-empty ⇒ a card exists ⇒ nothing was hidden from the grid.
    const mixed = {
      items: [{
        id: 7, name: 'Mixed', type: 'Checkpoint', nsfwLevel: 1,
        modelVersions: [
          { id: 70, name: 'clean', baseModel: 'SD 1.5', nsfwLevel: 1,
            files: [{ primary: true, name: 'x.safetensors', sizeKB: 1024, metadata: { format: 'SafeTensor' }, hashes: { SHA256: 'a'.repeat(64) }, downloadUrl: 'https://civitai.com/x' }] },
          { id: 71, name: 'adult', baseModel: 'SD 1.5', nsfwLevel: 28, files: [] },
        ],
      }],
    }
    const { rows, filteredCount } = mapCivitaiPageCounted(mixed)
    expect(rows).toHaveLength(1)
    expect(filteredCount).toBe(0)
  })
})

// ─── 2. the single 5xx retry ─────────────────────────────────────────────────

const realFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>() as unknown as Headers,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}
const EMPTY_PAGE = { items: [], metadata: { nextCursor: null } }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  globalThis.fetch = realFetch
})

/**
 * Drive a call to completion with the retry's timer auto-advanced.
 *
 * The rejection handler is attached SYNCHRONOUSLY (before any timer is
 * advanced): a promise that rejects on the first fake tick would otherwise be
 * reported as an unhandled rejection and poison the whole file's run.
 */
function withTimers<T>(run: () => Promise<T>): Promise<T> {
  const settled = run().then(
    v => ({ ok: true as const, v }),
    e => ({ ok: false as const, e }),
  )
  return (async () => {
    await vi.advanceTimersByTimeAsync(CIVITAI_RETRY_DELAY_MS * 2)
    const r = await settled
    if (r.ok) return r.v
    throw r.e
  })()
}

describe('isCivitaiRetryableStatus', () => {
  it('is 5xx and ONLY 5xx', () => {
    expect(isCivitaiRetryableStatus(500)).toBe(true)
    expect(isCivitaiRetryableStatus(503)).toBe(true)
    expect(isCivitaiRetryableStatus(599)).toBe(true)
    expect(isCivitaiRetryableStatus(499)).toBe(false)
    expect(isCivitaiRetryableStatus(600)).toBe(false)
  })

  it('never retries the 4xx family — 429 above all', () => {
    // Re-asking a rate limiter is how a throttle becomes a ban.
    for (const s of [400, 401, 403, 404, 429]) expect(isCivitaiRetryableStatus(s)).toBe(false)
    expect(isCivitaiRetryableStatus(200)).toBe(false)
  })
})

describe('searchCivitai — one polite retry on a 5xx', () => {
  it('a 503 followed by a 200 SUCCEEDS instead of surfacing a dead search', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ message: 'upstream' }, 503))
      .mockResolvedValueOnce(jsonResponse(EMPTY_PAGE, 200))
    globalThis.fetch = spy as unknown as typeof fetch
    const res = await withTimers(() => searchCivitai({ thumbnails: false }))
    expect(spy).toHaveBeenCalledTimes(2)
    expect(res.rows).toEqual([])
    expect(res.filteredCount).toBe(0)
  })

  it('waits before re-asking — no instant hammer on a struggling edge', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(EMPTY_PAGE, 200))
    globalThis.fetch = spy as unknown as typeof fetch
    const p = searchCivitai({ thumbnails: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(spy).toHaveBeenCalledTimes(1)          // still waiting
    await vi.advanceTimersByTimeAsync(CIVITAI_RETRY_DELAY_MS)
    await p
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('EXACTLY ONE retry — a second 503 is the honest answer, not a storm', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({}, 503))
    globalThis.fetch = spy as unknown as typeof fetch
    await expect(withTimers(() => searchCivitai({ thumbnails: false }))).rejects.toThrow(/503/)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('a 4xx is NOT retried — the answer cannot change', async () => {
    for (const status of [400, 401, 404, 429]) {
      const spy = vi.fn().mockResolvedValue(jsonResponse({}, status))
      globalThis.fetch = spy as unknown as typeof fetch
      await expect(withTimers(() => searchCivitai({ thumbnails: false })))
        .rejects.toThrow(new RegExp(String(status)))
      expect(spy).toHaveBeenCalledTimes(1)
    }
  })

  it('a healthy 200 makes exactly one request', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse(EMPTY_PAGE, 200))
    globalThis.fetch = spy as unknown as typeof fetch
    await withTimers(() => searchCivitai({ thumbnails: false }))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('search reports the gate count from the wire', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({ ...rawPage, metadata: { nextCursor: null } }, 200))
    globalThis.fetch = spy as unknown as typeof fetch
    const res = await withTimers(() => searchCivitai({ thumbnails: false }))
    expect(res.filteredCount).toBe(3)
    expect(res.rows).toHaveLength(10)
  })
})

describe('fetchCivitaiModelRows — the install lookup gets the same one retry', () => {
  it('a 503 on the install click does not cost the user the download', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse(protogen, 200))
    globalThis.fetch = spy as unknown as typeof fetch
    const rows = await withTimers(() => fetchCivitaiModelRows(3627))
    expect(spy).toHaveBeenCalledTimes(2)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('a 404 is final', async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({}, 404))
    globalThis.fetch = spy as unknown as typeof fetch
    await expect(withTimers(() => fetchCivitaiModelRows(1))).rejects.toThrow(/404/)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
