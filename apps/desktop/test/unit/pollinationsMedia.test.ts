// apps/desktop/test/unit/pollinationsMedia.test.ts
//
// Pollinations — the KEYLESS cloud image provider (image.pollinations.ai),
// wired per FREE-FLEET-SWEEP-2026-08-01 §3#2 and a same-day live re-probe
// (nonce in every prompt; 200 image/jpeg ×4/4 fresh, 2–42 s; an 8.3k-char
// encoded path still answered 200; an immediate second request was QUEUED
// server-side rather than 429'd).
//
// THE FOUR PINS this file exists for:
//   1. a Pollinations run is BLOCKED in private mode — before any fetch,
//      INCLUDING one already sitting in the pacing queue when the mode flips
//      (the gate is re-checked at the last instant before the fetch);
//   2. its artifacts carry CLOUD provenance, never "local" — free ≠ local;
//   3. the pacing queue HOLDS a second request until 15 s have passed since
//      the first one started (their documented anonymous limit);
//   4. a keyless fresh install reaches generation with ZERO configuration —
//      no keychain read anywhere on the path, and a model list even offline.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const h = vi.hoisted(() => ({
  mode: 'open' as 'open' | 'private',
  writes: [] as Array<{ rel: string; bytes: number }>,
  progressTicks: [] as Array<{ status: string; completedAfterPrivate?: boolean }>,
}))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => h.mode }))
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (_channel: string, p: { status: string; completedAfterPrivate?: boolean }) => { h.progressTicks.push(p) },
      },
    }],
  },
}))
vi.mock('../../electron/services/storage-root', () => ({
  writeStorageFile: (_area: string, rel: string, bytes: Uint8Array) => {
    h.writes.push({ rel, bytes: bytes.byteLength })
    return `C:/storage/Media/${rel.replace(/\\/g, '/')}`
  },
}))

import { classifyProvider, CLOUD_PROVIDER_IDS, LOCAL_PROVIDER_IDS } from '../../electron/services/egress-policy'
import {
  POLLINATIONS_MIN_INTERVAL_MS,
  POLLINATIONS_PROMPT_MAX_CHARS,
  POLLINATIONS_STATIC_MODELS,
  POLLINATIONS_DEFAULT_MODEL,
  parsePollinationsModels,
  resolvePollinationsSize,
  rollPollinationsSeed,
  buildPollinationsImageUrl,
  pollinationsPacingDelay,
  isPollinationsImageResponse,
} from '../../electron/services/pollinations-media-core'
import {
  listPollinationsModels,
  pollinationsGenerateImage,
  resetPollinationsMediaForTests,
} from '../../electron/services/pollinations-media'
import { pollinationsVisibleSchema, POLLINATIONS_PARAM_NAMES, mediaProviderLabel, providerServesModality } from '../../src/pages/media/mediaHelpers'
import type { ParamSpec } from '../../src/types/electron'

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const LOCALES = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

const realFetch = globalThis.fetch
let fetchSpy: ReturnType<typeof vi.fn>

/** A minimal image Response double — what a healthy generation returns. */
function imageResponse(bytes = 64, ct = 'image/jpeg', status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? ct : null) } as unknown as Headers,
    arrayBuffer: async () => new ArrayBuffer(bytes),
    text: async () => '',
    json: async () => null,
  }
}

function textResponse(body: string, status = 200, ct = 'text/html') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? ct : null) } as unknown as Headers,
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => body,
    json: async () => { try { return JSON.parse(body) } catch { return null } },
  }
}

beforeEach(() => {
  h.mode = 'open'
  h.writes = []
  h.progressTicks = []
  resetPollinationsMediaForTests()
  fetchSpy = vi.fn(async () => imageResponse())
  globalThis.fetch = fetchSpy as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

// ── PIN 2 (half one): cloud classification — free is not local ───────────────

describe('egress classification: pollinations is CLOUD', () => {
  it('classifyProvider says cloud, and it is listed EXPLICITLY (denial names the destination)', () => {
    expect(classifyProvider('pollinations')).toBe('cloud')
    expect((CLOUD_PROVIDER_IDS as readonly string[]).includes('pollinations')).toBe(true)
  })

  it('it is NOT in the local list — keyless and free never made it local', () => {
    expect((LOCAL_PROVIDER_IDS as readonly string[]).includes('pollinations')).toBe(false)
  })
})

// ── PIN 1: PRIVATE MODE blocks it before any bytes leave ─────────────────────

describe('PRIVATE MODE blocks pollinations before any fetch', () => {
  it('generateImage refuses, names the destination, and never touches the network', async () => {
    h.mode = 'private'
    await expect(pollinationsGenerateImage({ model: 'sana', prompt: 'a fox' }))
      .rejects.toThrow(/PRIVATE MODE/)
    await expect(pollinationsGenerateImage({ model: 'sana', prompt: 'a fox' }))
      .rejects.toThrow(/pollinations/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(h.writes).toHaveLength(0)
  })

  it('the catalog call is gated by the SAME fence', async () => {
    h.mode = 'private'
    await expect(listPollinationsModels()).rejects.toThrow(/PRIVATE MODE/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('THE PIN: a flip to private DURING the pacing wait blocks the queued request — no egress after the flip', async () => {
    vi.useFakeTimers()
    await pollinationsGenerateImage({ model: 'sana', prompt: 'first' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const second = pollinationsGenerateImage({ model: 'sana', prompt: 'second' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)          // held by pacing, not yet sent

    h.mode = 'private'                                 // the flip lands MID-WAIT
    const refused = expect(second).rejects.toThrow(/PRIVATE MODE/)
    // Only ONE pacing tick (2 s), nowhere near the 15 s line: the in-loop
    // re-check must refuse at the next tick rather than sit on the news.
    await vi.advanceTimersByTimeAsync(2_100)
    await refused
    expect(fetchSpy).toHaveBeenCalledTimes(1)          // the queued request NEVER egressed
    expect(h.writes).toHaveLength(1)                   // only the first run's artifact

    // …and the refusal did not consume the pacing slot: the gate is checked
    // BEFORE lastRequestStartedAt is stamped, so a legitimate request once the
    // mode reopens still measures its wait from the FIRST run's start.
    h.mode = 'open'
    const third = pollinationsGenerateImage({ model: 'sana', prompt: 'third' })
    await vi.advanceTimersByTimeAsync(POLLINATIONS_MIN_INTERVAL_MS)
    await expect(third).resolves.toBeTruthy()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('flipping back to open works — the refusal is not latched', async () => {
    h.mode = 'private'
    await expect(pollinationsGenerateImage({ model: 'sana', prompt: 'x' })).rejects.toThrow()
    h.mode = 'open'
    await expect(pollinationsGenerateImage({ model: 'sana', prompt: 'x' })).resolves.toBeTruthy()
  })
})

// ── THE NEIGHBOURING CASE (driver-found alongside the PIN-1 bug, NOT the same
//    bug): a flip DURING the fetch that is already in flight. Refusing here
//    would refuse nothing real — the GET already carried the prompt off this
//    machine before the mode even changed — so the file is written, but the
//    result says so, and never looks like a queued request that should have
//    been (and still is) blocked. See pollinations-media.ts's header comment.

describe('a flip WHILE the fetch is already in flight: written, not discarded, but flagged', () => {
  it('completes, writes the file, and marks completedAfterPrivate — the queued case above still refuses', async () => {
    let resolveFetch!: (v: unknown) => void
    const pending = new Promise(resolve => { resolveFetch = resolve })
    fetchSpy.mockImplementationOnce(() => pending)

    const gen = pollinationsGenerateImage({ model: 'sana', prompt: 'already sent' })
    // Let the microtask queue run the pacing queue's `run()` up to its `await
    // fetch(...)` — the first request has no pacing wait, so this is the only
    // async gap before the fetch is dispatched.
    for (let i = 0; i < 20 && fetchSpy.mock.calls.length === 0; i++) await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledTimes(1)   // the request is already in flight

    h.mode = 'private'                          // the flip lands mid-fetch
    resolveFetch(imageResponse())
    const res = await gen

    expect(res.completedAfterPrivate).toBe(true)
    expect(h.writes).toHaveLength(1)            // the file WAS written — discarding it would restore nothing
    const completedTick = h.progressTicks.find(t => t.status === 'completed')
    expect(completedTick?.completedAfterPrivate).toBe(true)
  })

  it('control: no flip ⇒ completes normally with the flag absent/false', async () => {
    const { completedAfterPrivate } = await pollinationsGenerateImage({ model: 'sana', prompt: 'normal' })
    expect(completedAfterPrivate).toBe(false)
    const completedTick = h.progressTicks.find(t => t.status === 'completed')
    expect(completedTick?.completedAfterPrivate).toBeUndefined()
  })

  it('a flip AFTER the fetch resolves (no longer in flight) does not retroactively mark a prior write', async () => {
    // Sanity check on the semantics: completedAfterPrivate reflects the mode
    // AT settlement time, not "was ever private during this process's life".
    await pollinationsGenerateImage({ model: 'sana', prompt: 'first' })
    h.mode = 'private'
    // A SECOND call is refused outright (PIN 1) — this is not the neighbouring
    // case, it is the ordinary gate-before-fetch path.
    await expect(pollinationsGenerateImage({ model: 'sana', prompt: 'second' })).rejects.toThrow(/PRIVATE MODE/)
    expect(h.writes).toHaveLength(1)
  })
})

// ── PIN 4: keyless — zero configuration reaches generation ───────────────────

describe('keyless: a fresh install reaches generation with zero setup', () => {
  it('generateImage succeeds with NO key anywhere — nothing read, nothing sent', async () => {
    const { artifacts, seed } = await pollinationsGenerateImage({ model: 'sana', prompt: 'a paper crane' })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].kind).toBe('image')
    expect(artifacts[0].path).toContain('C:/storage/Media/')
    expect(typeof seed).toBe('number')
    // The URL carries generation facts only — never a credential-shaped param.
    const url = String(fetchSpy.mock.calls[0]![0])
    expect(url).toContain('https://image.pollinations.ai/prompt/')
    for (const leaky of ['token=', 'key=', 'api_key', 'secret', 'authorization']) {
      expect(url.toLowerCase()).not.toContain(leaky)
    }
    // …and no Authorization header either.
    const init = fetchSpy.mock.calls[0]![1] as { headers?: Record<string, string> }
    expect(init.headers?.Authorization).toBeUndefined()
  })

  it('the service module imports NO keychain — keyless by construction', () => {
    const src = read('electron/services/pollinations-media.ts')
    // prose may SAY "no keychain"; what must not exist is the wire to one.
    expect(src).not.toMatch(/from ['"]\.\/keychain['"]/)
    expect(src).not.toContain('retrieveKey')
  })

  it('the model list works OFFLINE (static snapshot) — the picker is never empty', async () => {
    fetchSpy.mockRejectedValue(new Error('ENOTFOUND'))
    await expect(listPollinationsModels()).resolves.toEqual({ ok: true, models: POLLINATIONS_STATIC_MODELS })
  })

  it('…and the live list replaces it when the endpoint answers (probed: ["sana"])', async () => {
    fetchSpy.mockResolvedValue(textResponse('["sana"]', 200, 'application/json'))
    const { models } = await listPollinationsModels()
    expect(models).toEqual([{ id: 'sana', label: 'Sana', modality: 'image', live: true }])
  })
})

// ── PIN 3: the pacing queue holds the second request for 15 s ────────────────

describe('pacing: one request per 15 s, enforced client-side', () => {
  it('THE PIN: a second request does not START until 15 s after the first started', async () => {
    vi.useFakeTimers()
    await pollinationsGenerateImage({ model: 'sana', prompt: 'first' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const second = pollinationsGenerateImage({ model: 'sana', prompt: 'second' })
    // give the queued run a chance to start its pacing wait
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)          // held immediately

    await vi.advanceTimersByTimeAsync(POLLINATIONS_MIN_INTERVAL_MS - 1_000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)          // still held at 14 s

    await vi.advanceTimersByTimeAsync(2_000)           // crosses the 15 s line
    await second
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('pollinationsPacingDelay is the pure rule the queue runs on', () => {
    expect(pollinationsPacingDelay(null, 1_000)).toBe(0)               // never ran ⇒ go now
    expect(pollinationsPacingDelay(0, 1_000)).toBe(0)
    expect(pollinationsPacingDelay(1_000, 1_000)).toBe(POLLINATIONS_MIN_INTERVAL_MS)
    expect(pollinationsPacingDelay(1_000, 9_000)).toBe(7_000)
    expect(pollinationsPacingDelay(1_000, 16_000)).toBe(0)             // window passed
    expect(pollinationsPacingDelay(1_000, 999_999)).toBe(0)
  })

  it('a failed run does not wedge the queue (chained regardless of outcome)', async () => {
    fetchSpy.mockResolvedValueOnce(textResponse('<html>err</html>', 500))
    await expect(pollinationsGenerateImage({ model: 'sana', prompt: 'boom' })).rejects.toThrow(/500/)
    fetchSpy.mockResolvedValue(imageResponse())
    vi.useFakeTimers()
    const next = pollinationsGenerateImage({ model: 'sana', prompt: 'after' })
    await vi.advanceTimersByTimeAsync(POLLINATIONS_MIN_INTERVAL_MS + 100)
    await expect(next).resolves.toBeTruthy()
  })
})

// ── An honest 200: a cached/HTML 200 is not an image ─────────────────────────

describe('response verdicts — the sweep\'s own "a 200 is not evidence" lesson', () => {
  it('a 200 whose body is not image/* FAILS with the body quoted, not a broken artifact', async () => {
    fetchSpy.mockResolvedValue(textResponse('{"error":"model warming up"}', 200, 'application/json'))
    await expect(pollinationsGenerateImage({ model: 'sana', prompt: 'x' }))
      .rejects.toThrow(/model warming up/)
    expect(h.writes).toHaveLength(0)
  })

  it('a 429 names the real limit — one image per 15 s', async () => {
    fetchSpy.mockResolvedValue(textResponse('rate limited', 429, 'text/plain'))
    await expect(pollinationsGenerateImage({ model: 'sana', prompt: 'x' }))
      .rejects.toThrow(/15 s/)
  })

  it('an empty 200 image body is a failure, not a 0-byte gallery entry', async () => {
    fetchSpy.mockResolvedValue(imageResponse(0))
    await expect(pollinationsGenerateImage({ model: 'sana', prompt: 'x' }))
      .rejects.toThrow(/empty/)
  })

  it('isPollinationsImageResponse: the pure verdict', () => {
    expect(isPollinationsImageResponse(200, 'image/jpeg')).toBe(true)
    expect(isPollinationsImageResponse(200, 'image/png; charset=binary')).toBe(true)
    expect(isPollinationsImageResponse(200, 'text/html')).toBe(false)
    expect(isPollinationsImageResponse(200, null)).toBe(false)
    expect(isPollinationsImageResponse(429, 'image/jpeg')).toBe(false)
    expect(isPollinationsImageResponse(500, 'text/plain')).toBe(false)
  })
})

// ── URL building — prompt in the path, capped, encoded ───────────────────────

describe('buildPollinationsImageUrl', () => {
  const base = { model: 'sana', width: 512, height: 768, seed: 7 }

  it('puts the encoded prompt in the PATH and the facts in the query', () => {
    const url = buildPollinationsImageUrl({ ...base, prompt: 'a red fox & friend' })
    expect(url).toBe('https://image.pollinations.ai/prompt/a%20red%20fox%20%26%20friend?width=512&height=768&seed=7&model=sana&nologo=true')
  })

  it('caps the prompt (probed: 8.3k encoded chars still answered; the cap keeps headroom)', () => {
    const url = buildPollinationsImageUrl({ ...base, prompt: 'x'.repeat(50_000) })
    const path = decodeURIComponent(new URL(url).pathname.replace('/prompt/', ''))
    expect(path.length).toBe(POLLINATIONS_PROMPT_MAX_CHARS)
  })

  it('a blank model falls back to the default rather than sending model=', () => {
    const url = buildPollinationsImageUrl({ ...base, model: '  ', prompt: 'p' })
    expect(url).toContain(`model=${POLLINATIONS_DEFAULT_MODEL}`)
  })
})

// ── Size + seed ───────────────────────────────────────────────────────────────

describe('resolvePollinationsSize / rollPollinationsSeed', () => {
  it('parses the composer\'s "WxH" tiers', () => {
    expect(resolvePollinationsSize('1024x1024')).toEqual({ width: 1024, height: 1024 })
    expect(resolvePollinationsSize('512x768')).toEqual({ width: 512, height: 768 })
    expect(resolvePollinationsSize(' 768X512 ')).toEqual({ width: 768, height: 512 })
  })

  it('garbage falls back to 1024x1024, and dimensions are clamped', () => {
    for (const junk of [undefined, null, 42, '', 'huge', '0x0', {}]) {
      expect(resolvePollinationsSize(junk)).toEqual({ width: 1024, height: 1024 })
    }
    expect(resolvePollinationsSize('99999x64')).toEqual({ width: 2048, height: 64 })
  })

  it('a real seed passes through; -1/absent is ROLLED (their cache replays prompt+seed)', () => {
    expect(rollPollinationsSeed(42)).toBe(42)
    expect(rollPollinationsSeed(7.9)).toBe(7)
    const rolled = rollPollinationsSeed(-1, () => 0.5)
    expect(rolled).toBe(Math.floor(0.5 * 2_147_483_647))
    expect(rollPollinationsSeed(undefined, () => 0.25)).toBe(Math.floor(0.25 * 2_147_483_647))
    expect(rollPollinationsSeed(Number.NaN, () => 0.25)).toBeGreaterThanOrEqual(0)
  })

  it('the SERVICE returns the seed that actually ran, so the entry can record it', async () => {
    const { seed } = await pollinationsGenerateImage({ model: 'sana', prompt: 'x', seed: 1234 })
    expect(seed).toBe(1234)
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('seed=1234')
    // …and a -1 never reaches the wire as -1.
    resetPollinationsMediaForTests()
    const rolled = await pollinationsGenerateImage({ model: 'sana', prompt: 'y', seed: -1 })
    expect(rolled.seed).toBeGreaterThanOrEqual(0)
    expect(String(fetchSpy.mock.calls[1]![0])).toContain(`seed=${rolled.seed}`)
  })
})

// ── Models parsing ────────────────────────────────────────────────────────────

describe('parsePollinationsModels', () => {
  it('parses the live array-of-strings shape', () => {
    expect(parsePollinationsModels(['sana', 'kontext'])).toEqual([
      { id: 'sana', label: 'Sana', modality: 'image', live: true },
      { id: 'kontext', label: 'Kontext', modality: 'image', live: true },
    ])
  })

  it('tolerates {name} objects and garbage', () => {
    expect(parsePollinationsModels([{ name: 'sana' }, '', null, 42, {}])).toEqual([
      { id: 'sana', label: 'Sana', modality: 'image', live: true },
    ])
    for (const junk of [null, undefined, 'x', 42, {}]) {
      expect(parsePollinationsModels(junk)).toEqual([])
    }
  })
})

// ── The honest schema filter (both surfaces use it) ──────────────────────────

describe('pollinationsVisibleSchema — only the controls the GET carries', () => {
  const spec = (name: string): ParamSpec => ({ name, label: name, kind: 'string' } as ParamSpec)

  it('keeps prompt/size/seed, drops the curated extras that would do nothing', () => {
    const curated = ['prompt', 'negative_prompt', 'aspect_ratio', 'size', 'n', 'seed', 'steps', 'cfg', 'sampler', 'strength', 'image_url'].map(spec)
    expect(pollinationsVisibleSchema(curated).map(s => s.name)).toEqual([...POLLINATIONS_PARAM_NAMES])
  })

  it('MediaPage filters shownSchema on the pollinations route', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/mediaProvider === 'pollinations' \? pollinationsVisibleSchema\(visible\) : visible/)
  })

  it('the canvas MediaNode applies the SAME filter', () => {
    const node = read('src/pages/nodes/canvas/nodeTypes/MediaNode.tsx')
    expect(node).toContain('pollinationsVisibleSchema')
  })
})

// ── PIN 2 (half two): renderer surfaces — cloud provenance, honest copy ──────

describe('renderer wiring: provenance and copy stay honest', () => {
  it('MediaPage has a pollinations generate branch, and pushEntry stamps the provider', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain("} else if (mediaProvider === 'pollinations')")
    // provenance: every composer entry records the route it ran on.
    expect(page).toMatch(/provider: mediaProvider/)
    // the recorded seed is the one main actually ran.
    expect(page).toMatch(/entryParams = \{ \.\.\.entryParams, seed: res\.seed \}/)
    // the neighbouring-case flag rides the entry so the gallery can say so.
    expect(page).toMatch(/completedAfterPrivate = res\.completedAfterPrivate \|\| undefined/)
    expect(page).toMatch(/pushEntry\(\{ id: entryId, model, modality, prompt: promptText, artifacts, params: entryParams, completedAfterPrivate \}\)/)
  })

  it('the gallery tile shows a note instead of looking like the queued-request bug', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    expect(page).toContain('entry.completedAfterPrivate &&')
    expect(page).toContain("t('entry.completedAfterPrivate')")
    expect(page).toContain("t('entry.completedAfterPrivateTitle')")
    const artifactsPage = read('src/pages/artifacts/ArtifactsPage.tsx')
    expect(artifactsPage).toContain('entry.completedAfterPrivate &&')
  })

  it('pollinations serves image only — the modality matrix says so', () => {
    expect(providerServesModality('pollinations', 'image')).toBe(true)
    for (const m of ['video', 'music', 'tts', 'stt'] as const) {
      expect(providerServesModality('pollinations', m)).toBe(false)
    }
  })

  it('the brand label helper spells it, so no toast prints a lowercase id', () => {
    expect(mediaProviderLabel('pollinations')).toBe('Pollinations')
    expect(mediaProviderLabel('imgnai')).toBe('imgnAI')
  })

  it('the hint states the CLOUD fact in every locale — free never reads as local', () => {
    const en = JSON.parse(read('src/i18n/locales/en/media.json'))
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      expect(json.pollinations?.hint, `${l}/media.json pollinations.hint`).toBeTruthy()
      // the one word that must survive every translation: the destination.
      expect(json.pollinations.hint, `${l} hint names the destination`).toContain('pollinations.ai')
      expect(json.progress?.queuedPollinations, `${l} queuedPollinations`).toBeTruthy()
      expect(json.models?.error?.noPollinations, `${l} noPollinations`).toBeTruthy()
      if (l !== 'en') {
        expect(json.pollinations.hint, `${l} hint is still the English string`).not.toBe(en.pollinations.hint)
      }
    }
  })

  it('the "completed after private mode" note ships a real translation in every locale, in both galleries', () => {
    const enMedia = JSON.parse(read('src/i18n/locales/en/media.json'))
    const enArtifacts = JSON.parse(read('src/i18n/locales/en/artifacts.json'))
    for (const l of LOCALES) {
      const media = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      const artifacts = JSON.parse(read(`src/i18n/locales/${l}/artifacts.json`))
      expect(media.entry?.completedAfterPrivate, `${l}/media.json entry.completedAfterPrivate`).toBeTruthy()
      expect(media.entry?.completedAfterPrivateTitle, `${l}/media.json entry.completedAfterPrivateTitle`).toBeTruthy()
      expect(artifacts.tile?.completedAfterPrivate, `${l}/artifacts.json tile.completedAfterPrivate`).toBeTruthy()
      expect(artifacts.tile?.completedAfterPrivateTitle, `${l}/artifacts.json tile.completedAfterPrivateTitle`).toBeTruthy()
      // "PRIVATE MODE" stays the untranslated feature name (same convention as
      // onboarding.json's privateBanner) so the note is unambiguous everywhere.
      expect(media.entry.completedAfterPrivateTitle, `${l} keeps the PRIVATE MODE term`).toContain('PRIVATE MODE')
      if (l !== 'en') {
        expect(media.entry.completedAfterPrivateTitle, `${l} entry.completedAfterPrivateTitle is still English`).not.toBe(enMedia.entry.completedAfterPrivateTitle)
        expect(artifacts.tile.completedAfterPrivateTitle, `${l} tile.completedAfterPrivateTitle is still English`).not.toBe(enArtifacts.tile.completedAfterPrivateTitle)
      }
    }
  })

  it('the hint promises NO fixed latency — "about 45 s" was one probe, not a fact', () => {
    // Driver-measured 2026-08-01: two runs finished in ~2 s against copy that
    // said "About 45 s per image". A number we cannot stand behind is worse
    // than an honest range, so no per-image duration is asserted in any locale.
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      const hint = String(json.pollinations.hint)
      expect(hint, `${l} hint must not promise a 45 s render`).not.toMatch(/45/)
      // the 15 s pacing limit IS documented by Pollinations and must survive.
      expect(hint, `${l} hint keeps the real 15 s limit`).toMatch(/15/)
    }
  })

  it('the hint does not borrow the local engine\'s promises', () => {
    for (const l of LOCALES) {
      const json = JSON.parse(read(`src/i18n/locales/${l}/media.json`))
      const hint = String(json.pollinations.hint).toLowerCase()
      // "nothing leaves your machine" belongs to local.switchedToast — never here.
      expect(hint).not.toContain('nothing leaves')
      expect(hint).not.toContain('on this machine')
      expect(hint).not.toContain('$0')
    }
  })

  it('the STOP button is never offered for a pollinations run (no child to kill)', () => {
    const page = read('src/pages/media/MediaPage.tsx')
    // cancellable is local-only — the pollinations branch must not widen it.
    expect(page).toMatch(/beginRun\(\{ cancellable: mediaProvider === 'local' && \(modality === 'image' \|\| modality === 'video'\) \}\)/)
  })

  it('the canvas node offers Pollinations for image, and main routes it', () => {
    const node = read('src/pages/nodes/canvas/nodeTypes/MediaNode.tsx')
    expect(node).toContain('<option value="pollinations">Pollinations</option>')
    const g2a = read('electron/services/graph-to-agentkit.ts')
    expect(g2a).toContain("media.data.provider === 'pollinations'")
    expect(g2a).toContain('pollinationsGenerateImage')
  })
})
