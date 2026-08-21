// apps/desktop/test/unit/civitaiVersionMini.test.ts
//
// THE DOWNLOAD-AUTH PRE-FLIGHT: `GET /api/v1/model-versions/mini/:id`.
//
// `requireAuth` is a DOCUMENTED field on that endpoint — "When `true`, the
// `downloadUrls` require a token"
// (<https://developer.civitai.com/site/reference/model-versions.md>) — and it
// matched live behaviour exactly on 2026-07-31, 3/3
// (notes/CIVITAI-AUTH-RESEARCH-2026-08-01.md §5):
//     mini/1833157 requireAuth=true  → the download first-hops 401
//     mini/9208    requireAuth=false → 307
//     mini/290640  requireAuth=false → 307
//
// TWO THINGS THIS FILE IS HERE TO PIN, and they pull in opposite directions:
//   1. When the pre-flight ANSWERS, the download host is not touched at all for
//      an open file, and a gated file goes straight to the authed attempt.
//   2. When it does not answer — for ANY reason, including a missing field — the
//      verdict falls back to the blind Range probe rather than to a guess. An
//      absent `requireAuth` read as `false` would mean "no model needs a key".
//
// Mocking follows civitaiEgress.test.ts: hoisted privacy/keychain doubles and a
// spy on global.fetch that routes by URL. No new pattern.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  mode: 'open' as 'open' | 'private',
  key: null as string | null,
}))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => h.mode }))
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: () => h.key,
  hasKey: () => h.key !== null,
}))

import {
  civitaiVersionFromDownloadUrl,
  fetchCivitaiVersionMini,
  probeCivitaiDownloadAuth,
} from '../../electron/services/civitai-search'

const realFetch = globalThis.fetch
let fetchSpy: ReturnType<typeof vi.fn>

const jsonRes = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map() as unknown as Headers,
  json: async () => body,
})
const statusRes = (code: number) => ({ ok: code < 400, status: code, headers: new Map() as unknown as Headers })

const isMini = (u: unknown) => String(u).includes('/model-versions/mini/')
const isDownload = (u: unknown) => String(u).includes('/api/download/')
const miniCalls = () => fetchSpy.mock.calls.filter(c => isMini(c[0]))
const dlCalls = () => fetchSpy.mock.calls.filter(c => isDownload(c[0]))

/**
 * `mini` is either a JSON body (served 200) or a bare status code; the download
 * host answers `dl` in order, repeating the last one.
 */
function serve(mini: unknown, ...dl: number[]) {
  let i = 0
  fetchSpy.mockImplementation(async (u: unknown) => {
    if (isMini(u)) return typeof mini === 'number' ? statusRes(mini) : jsonRes(mini)
    const code = dl.length ? dl[Math.min(i, dl.length - 1)]! : 307
    i++
    return statusRes(code)
  })
}

beforeEach(() => {
  h.mode = 'open'
  h.key = null
  fetchSpy = vi.fn(async () => jsonRes({}))
  globalThis.fetch = fetchSpy as unknown as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

// ─── the parser ──────────────────────────────────────────────────────────────

describe('civitaiVersionFromDownloadUrl — the version id, or honest UNKNOWN', () => {
  it('reads a real download url', () => {
    expect(civitaiVersionFromDownloadUrl('https://civitai.com/api/download/models/4007'))
      .toEqual({ versionId: 4007, origin: 'https://civitai.com' })
  })

  it('ignores the query the API actually appends', () => {
    // Verbatim shape from the fixtures: multi-file models carry ?type=&format=…
    expect(civitaiVersionFromDownloadUrl(
      'https://civitai.com/api/download/models/691639?type=Model&format=SafeTensor&size=full&fp=fp32',
    )).toEqual({ versionId: 691639, origin: 'https://civitai.com' })
  })

  it('ACCEPTS the .red mirror and keeps its origin — the host is the mode', () => {
    // Adult-mode rows arrive with civitai.red download urls verbatim from the
    // API, and both hosts served the same version ids identically in the live
    // probes. Rejecting .red would silently disable the pre-flight for every
    // unlocked row; rewriting it to .com would break host-is-the-mode.
    expect(civitaiVersionFromDownloadUrl('https://civitai.red/api/download/models/9208'))
      .toEqual({ versionId: 9208, origin: 'https://civitai.red' })
  })

  it('refuses every other host, scheme and port', () => {
    for (const bad of [
      'http://civitai.com/api/download/models/1',              // plain http
      'https://www.civitai.com/api/download/models/1',         // not a host the API emits
      'https://civitai.com.evil.example/api/download/models/1',
      'https://evil.example/api/download/models/1',
      'https://image.civitai.com/api/download/models/1',
      'https://civitai.com:8443/api/download/models/1',        // a port is not our url
      'file:///c:/api/download/models/1',
    ]) {
      expect(civitaiVersionFromDownloadUrl(bad), bad).toBe(null)
    }
  })

  it('refuses every path that is not exactly /api/download/models/<digits>', () => {
    for (const bad of [
      'https://civitai.com/api/download/models/128713/file',   // a REDIRECT target, not our input
      'https://civitai.com/api/download/models/',
      'https://civitai.com/api/download/models/abc',
      'https://civitai.com/api/download/models/4007/',
      'https://civitai.com/api/v1/models/4007',
      'https://civitai.com/api/download/models/-1',
      'https://civitai.com/api/download/models/99999999999999999999',   // past MAX_SAFE_INTEGER
    ]) {
      expect(civitaiVersionFromDownloadUrl(bad), bad).toBe(null)
    }
  })

  it('refuses junk and non-strings without throwing', () => {
    for (const bad of ['not a url', '', null, undefined, 4007, {}, []]) {
      expect(civitaiVersionFromDownloadUrl(bad as unknown), JSON.stringify(bad)).toBe(null)
    }
  })

  it('is pure — it never touches the network', () => {
    civitaiVersionFromDownloadUrl('https://civitai.com/api/download/models/4007')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─── the fetch + mapper ──────────────────────────────────────────────────────

describe('fetchCivitaiVersionMini — the documented fields, or null', () => {
  it('maps the happy path and asks the documented URL', async () => {
    serve({ id: 1833157, requireAuth: true, sfwOnly: false, minor: false, availability: 'Public' })
    await expect(fetchCivitaiVersionMini(1833157)).resolves.toEqual({
      versionId: 1833157, requireAuth: true, sfwOnly: false, minor: false,
    })
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://civitai.com/api/v1/model-versions/mini/1833157')
    const init = fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(init.headers.Accept).toBe('application/json')
  })

  it('asks the .red host when that is where the row came from', async () => {
    serve({ requireAuth: false })
    await expect(fetchCivitaiVersionMini(9208, 'https://civitai.red')).resolves.toMatchObject({ requireAuth: false })
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://civitai.red/api/v1/model-versions/mini/9208')
  })

  it('carries the Bearer when one is stored (this is the first-party API host, not the CDN)', async () => {
    h.key = 'civ-secret'
    serve({ requireAuth: false })
    await fetchCivitaiVersionMini(9208)
    const [url, init] = fetchSpy.mock.calls[0]! as [string, { headers: Record<string, string> }]
    expect(init.headers.Authorization).toBe('Bearer civ-secret')
    expect(String(url)).not.toContain('token=')     // never ?token= — downloads.json is plaintext
  })

  it('a non-2xx is UNKNOWN, not false', async () => {
    for (const code of [400, 401, 404]) {
      serve(code)
      await expect(fetchCivitaiVersionMini(4007), String(code)).resolves.toBe(null)
    }
  })

  it('malformed JSON is UNKNOWN', async () => {
    fetchSpy.mockImplementation(async () => ({
      ok: true, status: 200, headers: new Map() as unknown as Headers,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
    }))
    await expect(fetchCivitaiVersionMini(4007)).resolves.toBe(null)
  })

  it('a MISSING or non-boolean requireAuth is UNKNOWN — never read as false', async () => {
    // The whole failure mode this guards: one deploy that drops the field would
    // otherwise silently mean "no model on Civitai needs a key".
    for (const body of [
      {}, null, [], 'nope', { requireAuth: 'true' }, { requireAuth: 1 }, { requireAuth: null },
      { id: 4007, sfwOnly: false, minor: false },
    ]) {
      serve(body)
      await expect(fetchCivitaiVersionMini(4007), JSON.stringify(body)).resolves.toBe(null)
    }
  })

  it('a network failure is UNKNOWN', async () => {
    fetchSpy.mockRejectedValue(new Error('ETIMEDOUT'))
    await expect(fetchCivitaiVersionMini(4007)).resolves.toBe(null)
  })

  it('absent sfwOnly / minor become null rather than false', async () => {
    // `false` would be a claim about the content; null is the truth (absent).
    serve({ requireAuth: true })
    await expect(fetchCivitaiVersionMini(4007)).resolves.toEqual({
      versionId: 4007, requireAuth: true, sfwOnly: null, minor: null,
    })
  })

  it('a bad id or an unknown origin returns null WITHOUT fetching', async () => {
    for (const id of [0, -1, 1.5, NaN, Infinity]) {
      await expect(fetchCivitaiVersionMini(id), String(id)).resolves.toBe(null)
    }
    for (const origin of ['http://civitai.com', 'https://evil.example', 'https://civitai.com/api/v1', '']) {
      await expect(fetchCivitaiVersionMini(4007, origin), origin).resolves.toBe(null)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is gated by PRIVATE MODE like every other network entry point', async () => {
    h.mode = 'private'
    await expect(fetchCivitaiVersionMini(4007)).rejects.toThrow(/PRIVATE MODE/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─── the rewired probe ───────────────────────────────────────────────────────

describe('probeCivitaiDownloadAuth — the pre-flight decides first', () => {
  const URL_ = 'https://civitai.com/api/download/models/4007'

  /** The record as the mapper returns it — every verdict below carries it. */
  const rec = (over: Record<string, unknown> = {}) => ({
    versionId: 4007, requireAuth: false, sfwOnly: null, minor: null, ...over,
  })

  it('requireAuth=false ⇒ open, with ZERO requests to the download host', async () => {
    // The common case (6 of 7 measured public files) and the point of the change:
    // no Range request against the download endpoint at all.
    serve({ requireAuth: false })
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({ kind: 'open', version: rec() })
    expect(miniCalls()).toHaveLength(1)
    expect(dlCalls()).toHaveLength(0)
  })

  it('requireAuth=true with no key ⇒ needs-key, also without touching the download host', async () => {
    serve({ requireAuth: true })
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({
      kind: 'needs-key', version: rec({ requireAuth: true }),
    })
    expect(dlCalls()).toHaveLength(0)
  })

  it('requireAuth=true WITH a key still VERIFIES — one authed probe, no anonymous one', async () => {
    h.key = 'civ-secret'
    serve({ requireAuth: true }, 307)
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({
      kind: 'authed', headers: { Authorization: 'Bearer civ-secret' }, version: rec({ requireAuth: true }),
    })
    expect(dlCalls()).toHaveLength(1)
    const init = dlCalls()[0]![1] as { headers: Record<string, string>; redirect: string }
    expect(init.headers.Authorization).toBe('Bearer civ-secret')   // the anon probe is skipped
    expect(init.headers.Range).toBe('bytes=0-0')                   // still one byte, hop 1 only
    expect(init.redirect).toBe('manual')
  })

  it('a stale key is still caught — key-rejected survives the rewiring', async () => {
    // The reason the authed probe is not skipped too: `requireAuth` says the file
    // needs a token, it cannot say whether OUR token is any good.
    h.key = 'stale'
    serve({ requireAuth: true }, 401)
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({
      kind: 'key-rejected', version: rec({ requireAuth: true }),
    })
    expect(dlCalls()).toHaveLength(1)
  })

  // ── the record rides along (this is what arms layer 0's version-level minor) ──

  it('carries the mini record on the verdict — the FLAGS, not just requireAuth', async () => {
    // The whole point of attaching it: `minor` exists on NO other endpoint we
    // call, and the install path refuses on it (civitai.ipc.ts). It arrives for
    // free — this fetch already happened for `requireAuth`.
    serve({ requireAuth: false, sfwOnly: true, minor: true })
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({
      kind: 'open', version: { versionId: 4007, requireAuth: false, sfwOnly: true, minor: true },
    })
    expect(miniCalls()).toHaveLength(1)      // still ONE request, not two
  })

  it('the verdict KIND is untouched by the flags — the probe answers auth, nothing else', async () => {
    // A `minor: true` version whose file is public is still `open` HERE. The
    // refusal is layer 0's job and it happens in the install path; a probe that
    // started returning content verdicts would be a second, invisible gate.
    serve({ requireAuth: false, minor: true })
    const res = await probeCivitaiDownloadAuth(URL_) as { kind: string }
    expect(res.kind).toBe('open')
  })

  it('attaches NOTHING on the blind-probe path — absent means UNKNOWN, not false', async () => {
    // `toEqual` ignores undefined properties, so this asserts the KEY is missing
    // rather than merely undefined: a caller doing `'version' in probe` must see
    // the difference between "the pre-flight said no flag" and "nobody asked".
    serve(404, 307)
    const res = await probeCivitaiDownloadAuth(URL_)
    expect(res).toEqual({ kind: 'open' })
    expect(Object.hasOwn(res, 'version')).toBe(false)
  })

  it('an unparseable download url skips the pre-flight and goes straight to the blind probe', async () => {
    serve({ requireAuth: false }, 307)
    await expect(probeCivitaiDownloadAuth('https://example.invalid/whatever')).resolves.toEqual({ kind: 'open' })
    expect(miniCalls()).toHaveLength(0)        // nothing to ask about
    expect(fetchSpy).toHaveBeenCalledTimes(1)  // …and the url it DID probe is the given one
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://example.invalid/whatever')
  })

  it('an UNKNOWN pre-flight falls back to the blind probe rather than guessing open', async () => {
    // mini 404s, the download host 401s, no key ⇒ the honest answer is needs-key.
    // A pre-flight that guessed `requireAuth: false` would have said `open` here
    // and the download would have failed later with a raw 401.
    serve(404, 401)
    await expect(probeCivitaiDownloadAuth(URL_)).resolves.toEqual({ kind: 'needs-key' })
    expect(miniCalls()).toHaveLength(1)
    expect(dlCalls()).toHaveLength(1)
  })

  it('still refuses in PRIVATE MODE before any request, pre-flight included', async () => {
    h.mode = 'private'
    await expect(probeCivitaiDownloadAuth(URL_)).rejects.toThrow(/PRIVATE MODE/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
