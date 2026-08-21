// apps/desktop/test/unit/civitaiDetailFetch.test.ts
//
// THE NETWORK HALF of the detail view — the only new fetch this feature adds.
// Same discipline as civitaiEgress.test.ts: drive the real function with a spy
// on global.fetch and assert on what it DID, so a gate placed after the request
// fails here rather than passing a source read.
//
// What is pinned:
//   • PRIVATE MODE refuses BEFORE the url is built (no request at all)
//   • the mode decides the HOST, and it is re-resolved per call — deleting the
//     key between browsing and clicking really returns the panel to civitai.com
//   • the 18+ resolution is main's: settings alone unlock nothing
//   • a 5xx gets the same single polite retry search and install already get
//   • preview images become data: URIs through the SAME thumbnail path (host
//     containment + the CDN width transform + the byte cap)
//   • a failed preview contributes nothing instead of a broken tile

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  mode: 'open' as 'open' | 'private',
  key: null as string | null,
  hasKey: false,
}))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => h.mode }))
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: () => h.key,
  hasKey: () => h.hasKey,
}))

import {
  fetchCivitaiModelDetail,
  clearCivitaiThumbnailCache,
  CIVITAI_RETRY_DELAY_MS,
} from '../../electron/services/civitai-search'

const FIXTURES = fileURLToPath(new URL('../fixtures/civitai/', import.meta.url))
const SFW_MODEL = JSON.parse(readFileSync(join(FIXTURES, 'model-detail.json'), 'utf8'))
const NSFW_MODEL = JSON.parse(readFileSync(join(FIXTURES, 'model-detail-nsfw.json'), 'utf8'))

const realFetch = globalThis.fetch
let calls: string[]

/** A JSON Response double. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>() as unknown as Headers,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

/** An image Response double, big enough to be real and small enough to pass. */
function imageResponse(bytes = 64, contentType = 'image/jpeg') {
  const buf = new Uint8Array(bytes).fill(7)
  return {
    ok: true,
    status: 200,
    headers: new Map<string, string>([
      ['content-type', contentType],
      ['content-length', String(bytes)],
    ]) as unknown as Headers,
    json: async () => ({}),
    arrayBuffer: async () => buf.buffer,
  }
}

/** Route by url: the model json, or an image. */
function router(model: unknown, imageFor: (url: string) => unknown = () => imageResponse()) {
  return vi.fn(async (url: string) => {
    calls.push(url)
    if (url.includes('/api/v1/models/')) return jsonResponse(model)
    return imageFor(url)
  })
}

beforeEach(() => {
  h.mode = 'open'
  h.key = null
  h.hasKey = false
  calls = []
  clearCivitaiThumbnailCache()
})
afterEach(() => { globalThis.fetch = realFetch; vi.useRealTimers() })

describe('fetchCivitaiModelDetail — egress', () => {
  it('makes NO request at all in PRIVATE MODE', async () => {
    h.mode = 'private'
    const spy = router(SFW_MODEL)
    globalThis.fetch = spy as unknown as typeof fetch
    await expect(fetchCivitaiModelDetail(260267)).rejects.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('fetchCivitaiModelDetail — the host is the mode', () => {
  it('reads civitai.com when 18+ is not unlocked', async () => {
    globalThis.fetch = router(SFW_MODEL) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(260267, { previews: false })
    expect(calls[0]).toBe('https://civitai.com/api/v1/models/260267')
    expect(detail.adult).toBe(false)
    expect(detail.pageUrl).toBe('https://civitai.com/models/260267')
  })

  it('reads civitai.red only when ALL THREE unlock facts hold', async () => {
    h.hasKey = true
    h.key = 'sk-civitai'
    globalThis.fetch = router(NSFW_MODEL) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(4201, {
      adultMode: true, adultAcceptedAt: 1_700_000_000_000, previews: false,
    })
    expect(calls[0]).toBe('https://civitai.red/api/v1/models/4201')
    expect(detail.adult).toBe(true)
  })

  it('ignores the settings when no credential is stored — the panel stays SFW', async () => {
    h.hasKey = false                       // key removed since the browse
    globalThis.fetch = router(NSFW_MODEL) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(4201, {
      adultMode: true, adultAcceptedAt: 1_700_000_000_000, previews: false,
    })
    expect(calls[0]).toBe('https://civitai.com/api/v1/models/4201')
    expect(detail.adult).toBe(false)
    // …and the SFW ceiling then empties this level-15 model, honestly counted.
    expect(detail.versions).toEqual([])
    expect(detail.filteredVersionCount).toBe(4)
  })

  it('ignores a timestamp of 0 (a hand-edited settings file)', async () => {
    h.hasKey = true
    globalThis.fetch = router(NSFW_MODEL) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(4201, {
      adultMode: true, adultAcceptedAt: 0, previews: false,
    })
    expect(detail.adult).toBe(false)
  })
})

describe('fetchCivitaiModelDetail — failures', () => {
  it('throws with the status on a 404', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({}, 404)) as unknown as typeof fetch
    await expect(fetchCivitaiModelDetail(1, { previews: false }))
      .rejects.toThrow('Civitai model lookup returned 404')
  })

  it('retries a 503 EXACTLY once, then succeeds', async () => {
    vi.useFakeTimers()
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      return n === 1 ? jsonResponse({}, 503) : jsonResponse(SFW_MODEL)
    }) as unknown as typeof fetch
    const p = fetchCivitaiModelDetail(260267, { previews: false })
    await vi.advanceTimersByTimeAsync(CIVITAI_RETRY_DELAY_MS + 10)
    const detail = await p
    expect(n).toBe(2)
    expect(detail.modelId).toBe(260267)
  })

  it('does NOT retry a 429 — re-asking a rate limiter is actively harmful', async () => {
    let n = 0
    globalThis.fetch = vi.fn(async () => { n++; return jsonResponse({}, 429) }) as unknown as typeof fetch
    await expect(fetchCivitaiModelDetail(1, { previews: false })).rejects.toThrow('429')
    expect(n).toBe(1)
  })
})

describe('fetchCivitaiModelDetail — previews', () => {
  it('resolves the lead version\'s previews to data: URIs through the CDN transform', async () => {
    globalThis.fetch = router(SFW_MODEL) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(260267)
    const lead = detail.versions[0]!
    expect(lead.previews.length).toBeGreaterThan(0)
    expect(lead.previews.length).toBeLessThanOrEqual(4)
    for (const p of lead.previews) {
      expect(p.dataUri.startsWith('data:image/jpeg;base64,')).toBe(true)
      expect(p.level).toBe(1)
    }
    // NEVER the multi-megabyte original: every image request went through the
    // CDN's own /original=true/ → /width=N/ transform.
    const imageCalls = calls.filter(u => u.includes('image.civitai.com'))
    expect(imageCalls.length).toBeGreaterThan(0)
    for (const u of imageCalls) {
      expect(u).toContain('/width=')
      expect(u).not.toContain('/original=true/')
    }
  })

  it('fetches previews for the LEAD VERSION ONLY, never for all of them', async () => {
    globalThis.fetch = router(SFW_MODEL) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(260267)
    expect(detail.versions.length).toBe(3)
    for (const v of detail.versions.slice(1)) expect(v.previews).toEqual([])
    // 1 model json + at most 4 images. A per-version gallery would be ~21 here.
    expect(calls.length).toBeLessThanOrEqual(5)
  })

  it('honours versionId — the gallery is the version the card resolved to', async () => {
    globalThis.fetch = router(SFW_MODEL) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(260267, { versionId: 293564 })
    expect(detail.versions[0]!.versionId).toBe(293564)
    expect(detail.versions[0]!.previews.length).toBeGreaterThan(0)
  })

  it('NEVER fetches an R/X image in SFW mode, even though by-id serves them', async () => {
    // 4201 is level 15 at the model, so SFW empties it entirely and there is
    // nothing to fetch. That is the strongest form of the guarantee.
    globalThis.fetch = router(NSFW_MODEL) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(4201)
    expect(detail.versions).toEqual([])
    expect(calls.filter(u => u.includes('image.civitai.com'))).toEqual([])
  })

  it('under the ADULT ceiling, fetches the LEAST explicit images first', async () => {
    h.hasKey = true
    globalThis.fetch = router(NSFW_MODEL) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(4201, {
      adultMode: true, adultAcceptedAt: 1, versionId: 501240,
    })
    const levels = detail.versions[0]!.previews.map(p => p.level)
    expect(levels.length).toBeGreaterThan(0)
    // v501240's images are levels [2,1,1,1,4,…,8]; four picks, mildest first.
    expect(levels).toEqual([...levels].sort((a, b) => a - b))
    expect(levels[0]).toBe(1)
  })

  it('drops a preview whose fetch failed instead of rendering a broken tile', async () => {
    globalThis.fetch = router(SFW_MODEL, () => jsonResponse({}, 500)) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(260267)
    expect(detail.versions[0]!.previews).toEqual([])
    // and the detail itself still arrived — a picture is not the point of the panel
    expect(detail.description).toBe(SFW_MODEL.description)
  })

  it('drops a preview that is not actually an image', async () => {
    globalThis.fetch = router(SFW_MODEL, () => imageResponse(64, 'text/html')) as unknown as typeof fetch
    const detail = await fetchCivitaiModelDetail(260267)
    expect(detail.versions[0]!.previews).toEqual([])
  })

  it('skips the image fetches entirely when previews are off', async () => {
    globalThis.fetch = router(SFW_MODEL) as unknown as typeof fetch
    await fetchCivitaiModelDetail(260267, { previews: false })
    expect(calls).toHaveLength(1)
  })
})

describe('fetchCivitaiModelDetail — the verdict travels with the payload', () => {
  it('refuses an adapter with no base installed, and allows it with one', async () => {
    const lora = { ...SFW_MODEL, type: 'LORA' }
    globalThis.fetch = router(lora) as unknown as typeof fetch
    const cold = await fetchCivitaiModelDetail(260267, { previews: false })
    expect(cold.versions[0]!.installable).toBe(false)
    expect(cold.versions[0]!.reasonCode).toBe('needs-base')

    globalThis.fetch = router(lora) as unknown as typeof fetch
    const warm = await fetchCivitaiModelDetail(260267, {
      previews: false, installedFamilies: new Set(['sdxl' as const]),
    })
    expect(warm.versions[0]!.installable).toBe(true)
  })
})
