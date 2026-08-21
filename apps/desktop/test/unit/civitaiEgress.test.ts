// apps/desktop/test/unit/civitaiEgress.test.ts
//
// PRIVATE MODE over the two weights sources.
//
// HALF OF THIS FILE IS A REGRESSION PIN FOR A BUG THAT WAS ALREADY SHIPPED:
// hf-search.ts had NO egress gate. Typing in the Catalog's search box reached
// huggingface.co with PRIVATE MODE on, every time, and the UI said nothing.
// The provider sweep of the 2026-06-12 audit never covered it because
// HuggingFace is a weights host, not a "provider" — so `classifyProvider` was
// never consulted on that path at all. Found while wiring Civitai (spec risk
// R6) and fixed in the same pass.
//
// The tests below assert BEHAVIOUR, not the presence of a line: each one drives
// the real function with a spy on global.fetch and asserts the spy was never
// called. A gate that is present but placed after the fetch would fail here.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  mode: 'open' as 'open' | 'private',
  key: null as string | null,
  keychainBroken: false,
}))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => h.mode }))
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: () => {
    if (h.keychainBroken) throw new Error('Encryption not available on this system')
    return h.key
  },
}))

import { classifyProvider, CLOUD_PROVIDER_IDS } from '../../electron/services/egress-policy'
import {
  searchCivitai,
  fetchCivitaiModelRows,
  fetchCivitaiThumbnail,
  probeCivitaiDownloadAuth,
  civitaiAuthHeaders,
  clearCivitaiThumbnailCache,
  civitaiThumbnailCandidates,
  CIVITAI_KEY_ID,
} from '../../electron/services/civitai-search'
import { searchHuggingFace } from '../../electron/services/hf-search'

const realFetch = globalThis.fetch
let fetchSpy: ReturnType<typeof vi.fn>

/** A minimal Response double — enough for the happy paths below. */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map<string, string>() as unknown as Headers,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

beforeEach(() => {
  h.mode = 'open'
  h.key = null
  h.keychainBroken = false
  clearCivitaiThumbnailCache()
  fetchSpy = vi.fn(async () => jsonResponse({ items: [], metadata: { nextCursor: null } }))
  globalThis.fetch = fetchSpy as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

// ─── classification ──────────────────────────────────────────────────────────

describe('the weights sources are classified as cloud', () => {
  it('civitai and huggingface are cloud, not unknown', () => {
    expect(classifyProvider('civitai')).toBe('cloud')
    expect(classifyProvider('huggingface')).toBe('cloud')
    expect(classifyProvider('hf')).toBe('cloud')
  })

  it('they are listed EXPLICITLY, so the denial names the real destination', () => {
    // unknown⇒denied would already block them, but the reason string would say
    // 'unknown provider' — useless when the user is looking at a search box.
    for (const id of ['civitai', 'huggingface']) {
      expect((CLOUD_PROVIDER_IDS as readonly string[]).includes(id), id).toBe(true)
    }
  })

  it('the keychain id and the egress id are the same string', () => {
    expect(CIVITAI_KEY_ID).toBe('civitai')
    expect(classifyProvider(CIVITAI_KEY_ID)).toBe('cloud')
  })
})

// ─── THE HF FIX ──────────────────────────────────────────────────────────────

describe('hf-search: the PRIVATE MODE hole is closed', () => {
  it('does NOT touch the network in private mode', async () => {
    h.mode = 'private'
    await expect(searchHuggingFace('llama')).rejects.toThrow(/PRIVATE MODE/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('names huggingface in the denial so the message is actionable', async () => {
    h.mode = 'private'
    await expect(searchHuggingFace('llama')).rejects.toThrow(/huggingface/)
  })

  it('still searches normally in open mode (the gate is not a kill switch)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse([]))
    await expect(searchHuggingFace('llama')).resolves.toEqual([])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('huggingface.co')
  })
})

// ─── civitai ─────────────────────────────────────────────────────────────────

describe('civitai: every network entry point is gated', () => {
  const entries: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'searchCivitai',            run: () => searchCivitai({ query: 'anime' }) },
    { name: 'fetchCivitaiModelRows',    run: () => fetchCivitaiModelRows(4201) },
    { name: 'probeCivitaiDownloadAuth', run: () => probeCivitaiDownloadAuth('https://civitai.com/api/download/models/1') },
  ]

  for (const { name, run } of entries) {
    it(`${name} refuses and never fetches in private mode`, async () => {
      h.mode = 'private'
      await expect(run()).rejects.toThrow(/PRIVATE MODE/)
      expect(fetchSpy, name).not.toHaveBeenCalled()
    })
  }

  it('fetchCivitaiThumbnail returns null (never throws) and never fetches in private mode', async () => {
    // A thumbnail must never be the thing that breaks a page — it degrades.
    h.mode = 'private'
    await expect(fetchCivitaiThumbnail('https://image.civitai.com/x/y.jpeg')).resolves.toBe(null)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the denial names civitai', async () => {
    h.mode = 'private'
    await expect(searchCivitai()).rejects.toThrow(/civitai/)
  })

  it('searches normally in open mode', async () => {
    // `adult: false` is the RESOLVED mode the page was served in — with no key
    // stored it cannot be anything else, whatever the settings say.
    await expect(searchCivitai({ query: 'anime' })).resolves.toEqual({
      rows: [], nextCursor: null, filteredCount: 0, adult: false,
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const url = String(fetchSpy.mock.calls[0]![0])
    expect(url).toContain('civitai.com/api/v1/models')
    expect(url).toContain('nsfw=false')
  })
})

describe('the Bearer key is optional and never leaks into the URL', () => {
  it('sends no Authorization header when no key is stored', async () => {
    expect(civitaiAuthHeaders()).toEqual({})
    await searchCivitai({ query: 'x' })
    const init = fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('sends Bearer when a key IS stored — and never as ?token=', async () => {
    h.key = 'civ-secret'
    expect(civitaiAuthHeaders()).toEqual({ Authorization: 'Bearer civ-secret' })
    await searchCivitai({ query: 'x' })
    const [url, init] = fetchSpy.mock.calls[0]! as [string, { headers: Record<string, string> }]
    expect(init.headers.Authorization).toBe('Bearer civ-secret')
    // ?token= is called out as leaky in the docs, and downloads.json persists
    // spec.url in PLAINTEXT while the keychain copy is DPAPI-encrypted.
    expect(String(url)).not.toContain('token=')
    expect(String(url)).not.toContain('civ-secret')
  })

  it('an unavailable keychain degrades to anonymous rather than throwing', async () => {
    // safeStorage.isEncryptionAvailable() is false on some Linux desktops — that
    // must cost the user the account-gated downloads (the `requireAuth` ones),
    // not the whole search. It costs no rate limit: Civitai publishes no
    // authenticated tier (developer.civitai.com/site/guide/errors.md).
    h.keychainBroken = true
    expect(civitaiAuthHeaders()).toEqual({})
    await expect(searchCivitai({ query: 'x' })).resolves.toEqual({
      rows: [], nextCursor: null, filteredCount: 0, adult: false,
    })
    h.keychainBroken = false
  })
})

describe('probeCivitaiDownloadAuth — pre-flight UNAVAILABLE ⇒ the blind probe, unchanged', () => {
  // The `/model-versions/mini/:id` pre-flight 404s in every test here, so each
  // one drives the ORIGINAL path: anonymous probe first, key only on a 401/403.
  // That fallback is not legacy — it is what keeps the verdicts honest on the day
  // the mini endpoint is down or stops carrying the field. The pre-flight's own
  // behaviour is pinned in civitaiVersionMini.test.ts.
  const URL_ = 'https://civitai.com/api/download/models/4007'
  const status = (code: number) => ({ ok: code < 400, status: code, headers: new Map() as unknown as Headers })
  const isMini = (u: unknown) => String(u).includes('/model-versions/mini/')
  /** Calls that reached the DOWNLOAD host — the count these assertions are about. */
  const dlCalls = () => fetchSpy.mock.calls.filter(c => !isMini(c[0]))

  /** Statuses served to the download host, in order; the last one repeats. */
  const serveDownload = (...codes: number[]) => {
    let i = 0
    fetchSpy.mockImplementation(async (u: unknown) => {
      if (isMini(u)) return status(404)      // pre-flight unavailable ⇒ unknown
      const code = codes[Math.min(i, codes.length - 1)]!
      i++
      return status(code)
    })
  }

  it('asks the pre-flight FIRST, then falls back — order, not just outcome', async () => {
    serveDownload(307)
    await probeCivitaiDownloadAuth(URL_)
    expect(isMini(fetchSpy.mock.calls[0]![0])).toBe(true)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://civitai.com/api/v1/model-versions/mini/4007')
    expect(dlCalls()).toHaveLength(1)
  })

  it('a 307 (the normal case) needs no key at all', async () => {
    serveDownload(307)
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({ kind: 'open' })
    expect(dlCalls()).toHaveLength(1)                            // no second, authed attempt
    const init = dlCalls()[0]![1] as { headers: Record<string, string>; redirect: string }
    expect(init.headers.Authorization).toBeUndefined()           // tried anonymous FIRST
    expect(init.redirect).toBe('manual')                         // status read on hop 1
    expect(init.headers.Range).toBe('bytes=0-0')                 // one byte, not 2 GB
  })

  it('a 401 with no stored key gives needs-key, not a silent failure', async () => {
    serveDownload(401)
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({ kind: 'needs-key' })
    expect(dlCalls()).toHaveLength(1)
  })

  it('a 401 with a stored key retries EXACTLY once and returns the header', async () => {
    h.key = 'civ-secret'
    serveDownload(401, 307)
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({
      kind: 'authed', headers: { Authorization: 'Bearer civ-secret' },
    })
    expect(dlCalls()).toHaveLength(2)
  })

  it('a key that is still refused reports key-rejected (not needs-key)', async () => {
    h.key = 'stale'
    serveDownload(401)
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({ kind: 'key-rejected' })
    expect(dlCalls()).toHaveLength(2)
  })

  it('treats 403 like 401', async () => {
    serveDownload(403)
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({ kind: 'needs-key' })
  })

  it('a probe that cannot complete does not block the install', async () => {
    fetchSpy.mockRejectedValue(new Error('ETIMEDOUT'))
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({ kind: 'open' })
  })
})

describe('civitaiThumbnailCandidates — host containment + the CDN width transform', () => {
  const ORIGINAL = 'https://image.civitai.com/xG1nk/b50708a9/original=true/8301359.jpeg'

  it('NEVER offers the original — it is 0.8-2.7 MB, measured', () => {
    // The whole reason this function exists: a straight pass-through of
    // `original=true` blows any sane cap on every single row, so the catalog
    // would render with zero thumbnails and no error to explain it.
    const c = civitaiThumbnailCandidates(ORIGINAL)
    expect(c.every(u => !u.includes('original=true'))).toBe(true)
  })

  it('offers width=450 then width=320 (one real preview 404s at 450, serves at 320)', () => {
    expect(civitaiThumbnailCandidates(ORIGINAL)).toEqual([
      'https://image.civitai.com/xG1nk/b50708a9/width=450/8301359.jpeg',
      'https://image.civitai.com/xG1nk/b50708a9/width=320/8301359.jpeg',
    ])
  })

  it('passes an already-derived url through unchanged', () => {
    const derived = 'https://image.civitai.com/xG1nk/b50708a9/width=450/8301359.jpeg'
    expect(civitaiThumbnailCandidates(derived)).toEqual([derived])
  })

  it('refuses every host but image.civitai.com (risk R7 — no SSRF primitive)', () => {
    for (const bad of [
      'https://evil.example/original=true/x.jpeg',
      'https://image.civitai.com.evil.example/a.jpeg',
      'https://civitai.com/a.jpeg',
      'http://image.civitai.com/a.jpeg',
      'file:///c:/secret.png',
      'data:image/png;base64,AA',
      'not a url', '',
    ]) {
      expect(civitaiThumbnailCandidates(bad), bad).toEqual([])
    }
  })
})

describe('thumbnails — capped, memory-only, degrade to null', () => {
  const imgResponse = (bytes: number, ct = 'image/jpeg', declared?: number) => ({
    ok: true, status: 200,
    headers: {
      get: (k: string) => k.toLowerCase() === 'content-type'
        ? ct
        : String(declared ?? bytes),
    } as unknown as Headers,
    arrayBuffer: async () => new ArrayBuffer(bytes),
  })

  it('returns a data: URI, never the remote url (prod CSP img-src has no https:)', async () => {
    fetchSpy.mockResolvedValue(imgResponse(1024))
    const out = await fetchCivitaiThumbnail('https://image.civitai.com/a/b.jpeg')
    expect(out).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('refuses a non-image content-type (an HTML error page is not a thumbnail)', async () => {
    fetchSpy.mockResolvedValue(imgResponse(1024, 'text/html'))
    await expect(fetchCivitaiThumbnail('https://image.civitai.com/a/b.jpeg')).resolves.toBe(null)
  })

  it('refuses anything over the cap — by declared length AND by real bytes', async () => {
    fetchSpy.mockResolvedValue(imgResponse(10, 'image/jpeg', 5_000_000))
    await expect(fetchCivitaiThumbnail('https://image.civitai.com/big.jpeg')).resolves.toBe(null)

    clearCivitaiThumbnailCache()
    // content-length LIES and says 10 bytes; the body is 5 MB.
    fetchSpy.mockResolvedValue(imgResponse(5_000_000, 'image/jpeg', 10))
    await expect(fetchCivitaiThumbnail('https://image.civitai.com/liar.jpeg')).resolves.toBe(null)
  })

  it('caches, including the null result, so a dead url is fetched once', async () => {
    fetchSpy.mockResolvedValue(imgResponse(64))
    await fetchCivitaiThumbnail('https://image.civitai.com/a.jpeg')
    await fetchCivitaiThumbnail('https://image.civitai.com/a.jpeg')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    fetchSpy.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(fetchCivitaiThumbnail('https://image.civitai.com/dead.jpeg')).resolves.toBe(null)
    await expect(fetchCivitaiThumbnail('https://image.civitai.com/dead.jpeg')).resolves.toBe(null)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('refuses a non-https / off-host url outright without fetching', async () => {
    for (const bad of ['http://image.civitai.com/a.jpeg', 'https://evil.example/a.jpeg', 'file:///c:/x.jpg', 'data:image/png;base64,AA', '']) {
      await expect(fetchCivitaiThumbnail(bad), bad).resolves.toBe(null)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back from width=450 to width=320 when the CDN 404s the first variant', async () => {
    // The real behaviour of one of the six measured previews: 450 → 404 (twice,
    // deterministically), 320 → 57 KB image/jpeg.
    fetchSpy.mockImplementation(async (u: unknown) =>
      String(u).includes('width=450')
        ? { ok: false, status: 404, headers: { get: () => 'application/json' } as unknown as Headers, arrayBuffer: async () => new ArrayBuffer(0) }
        : imgResponse(57_497))
    const out = await fetchCivitaiThumbnail('https://image.civitai.com/a/b/original=true/1.jpeg')
    expect(out).toMatch(/^data:image\/jpeg;base64,/)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('width=450')
    expect(String(fetchSpy.mock.calls[1]![0])).toContain('width=320')
  })

  it('stops after the fallback — it never reaches for the multi-MB original', async () => {
    fetchSpy.mockResolvedValue({
      ok: false, status: 404,
      headers: { get: () => 'application/json' } as unknown as Headers,
      arrayBuffer: async () => new ArrayBuffer(0),
    })
    await expect(fetchCivitaiThumbnail('https://image.civitai.com/a/b/original=true/1.jpeg')).resolves.toBe(null)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls.every(c => !String(c[0]).includes('original=true'))).toBe(true)
  })

  it('does NOT cache the PRIVATE MODE refusal — flipping the toggle back works', async () => {
    h.mode = 'private'
    await expect(fetchCivitaiThumbnail('https://image.civitai.com/a.jpeg')).resolves.toBe(null)
    h.mode = 'open'
    fetchSpy.mockResolvedValue(imgResponse(64))
    await expect(fetchCivitaiThumbnail('https://image.civitai.com/a.jpeg')).resolves.toMatch(/^data:/)
  })
})
