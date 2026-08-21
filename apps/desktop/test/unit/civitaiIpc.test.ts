// apps/desktop/test/unit/civitaiIpc.test.ts
//
// The IPC contract, and the trust boundary underneath it.
//
// THE ONE THING THIS FILE EXISTS FOR: `civitai:install` receives a row from the
// RENDERER. That row is a hint — which model, which version — and nothing else
// in it may influence what gets downloaded. The tests below hand the handler
// rows that LIE (installable:true on a pickle, a rewritten downloadUrl, a
// gate-excluded model) and assert the handler refuses anyway, because it
// re-reads the model from the API and re-runs the gate in main.
//
// Lane C's electron/services/user-sd-models.ts is mocked here (and may not
// exist on disk yet); the mock's shape IS the cross-lane contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const h = vi.hoisted(() => ({
  mode: 'open' as 'open' | 'private',
  key: null as string | null,
  /** The two 18+ SETTINGS as they would sit in tachi-settings.json. */
  settings: { civitaiAdultMode: false, civitaiAdultAcceptedAt: 0 } as Record<string, unknown>,
  /** Checkpoints on disk, as listInstalledSdModels would report them. */
  installed: [] as Array<{ id: string; name: string; kind: 'image' | 'video'; family: string }>,
}))

interface Handler { (event: unknown, payload: unknown): unknown }
const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => unknown>())

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: Handler) => { handlers.set(ch, fn) } },
  BrowserWindow: { fromWebContents: () => null },
}))
vi.mock('../../electron/ipc/privacy.ipc', () => ({ getCurrentPrivacyMode: () => h.mode }))
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: () => h.key,
  hasKey: () => h.key !== null,
}))
// The settings STORE is mocked, not the file: it is the source main reads the
// 18+ pair from, and the whole point of the design is that the renderer cannot
// supply it. (Mocking it also keeps electron's `app` out of this suite.)
vi.mock('../../electron/services/settings-store', () => ({
  loadSettings: () => ({ ...h.settings }),
  saveSettings: () => undefined,
}))

// ── LANE C's CONTRACT, as a double ───────────────────────────────────────────
//   userSdModelFromCivitaiRow(row) -> SdImageModel-shaped
//     { id, name, family, baseSize, files:[{role:'model',url,sha256,sizeMb}], headers? }
//   addUserSdModel(spec) -> void
const laneC = vi.hoisted(() => ({
  added: [] as Array<Record<string, unknown>>,
  addedAdapters: [] as Array<Record<string, unknown>>,
  fromAdapterRow: vi.fn((row: Record<string, unknown>, opts: { headers?: Record<string, string> } = {}) => ({
    id: row.id as string,
    kind: ({ LORA: 'lora', LoCon: 'lora', TextualInversion: 'embedding', VAE: 'vae' } as Record<string, string>)[
      String(row.type)
    ],
    name: row.name as string,
    slug: 'a-slug',
    family: row.family as string,
    file: { role: 'model', url: row.downloadUrl, sha256: row.sha256, sizeMb: row.sizeMb },
    ...(opts.headers ? { headers: opts.headers, requiresKey: true } : {}),
  } as Record<string, unknown>)),
  fromRow: vi.fn((row: Record<string, unknown>, opts: { headers?: Record<string, string> } = {}) => ({
    id: row.id as string,
    name: row.name as string,
    family: row.family as string,
    baseSize: row.family === 'sdxl' ? 1024 : 512,
    files: [{ role: 'model', url: row.downloadUrl, sha256: row.sha256, sizeMb: row.sizeMb }],
    // The real mapper sets both of these off opts.headers and then
    // addUserSdModel STRIPS `headers` before persisting.
    ...(opts.headers ? { headers: opts.headers, requiresKey: true } : {}),
  } as Record<string, unknown>)),
}))
vi.mock('../../electron/services/user-sd-models', () => ({
  addUserSdModel: (spec: Record<string, unknown>) => {
    const { headers: _stripped, ...persisted } = spec
    laneC.added.push(persisted)
    return persisted
  },
  listUserSdModels: () => laneC.added,
  userSdModelFromCivitaiRow: laneC.fromRow,
  // The ADAPTER half of the same contract. An adapter is not a checkpoint: it
  // has a slug and a kind, lives in a shared per-kind directory, and must never
  // be handed to `-m`.
  adapterKindForCivitaiType: (t: unknown) =>
    ({ LORA: 'lora', LoCon: 'lora', LyCORIS: 'lora', TextualInversion: 'embedding', VAE: 'vae' } as Record<string, string>)[
      String(t)
    ] ?? null,
  userSdAdapterFromCivitaiRow: laneC.fromAdapterRow,
  addUserSdAdapter: (spec: Record<string, unknown>) => {
    const { headers: _stripped, ...persisted } = spec
    laneC.addedAdapters.push(persisted)
    return persisted
  },
}))

const dl = vi.hoisted(() => ({ calls: [] as unknown[][], adapterCalls: [] as unknown[][] }))
vi.mock('../../electron/services/sd-cpp-installer', () => ({
  downloadSdModel: (...args: unknown[]) => { dl.calls.push(args); return Promise.resolve() },
  downloadSdAdapter: (...args: unknown[]) => { dl.adapterCalls.push(args); return Promise.resolve() },
  listInstalledSdModels: () => h.installed,
}))

import { registerCivitaiIpc } from '../../electron/ipc/civitai.ipc'

// ── fixture + fetch double ───────────────────────────────────────────────────

const FIXTURES = fileURLToPath(new URL('../fixtures/civitai/', import.meta.url))
const page = JSON.parse(readFileSync(join(FIXTURES, 'models-page.json'), 'utf8')) as {
  items: Array<Record<string, unknown> & { id: number }>
}
/**
 * A synthetic multi-version model. Live models carry 2-16 versions (measured:
 * 5 models → 55 versions), the browse list collapses them to one card, and this
 * proves the install path can still reach the ones the card did not show.
 */
const file = (n: string) => ({
  name: n, primary: true, sizeKB: 2_000_000,
  metadata: { format: 'SafeTensor', fp: 'fp16' },
  hashes: { SHA256: 'A'.repeat(64) },
  downloadUrl: `https://civitai.com/api/download/models/${n}`,
})
const MULTI = {
  id: 900, name: 'Many Versions', type: 'Checkpoint',
  poi: false, minor: false, nsfw: false, nsfwLevel: 1, tags: ['anime'],
  allowCommercialUse: '{Image}', allowNoCredit: false, allowDerivatives: true,
  stats: { downloadCount: 5, thumbsUpCount: 1 },
  modelVersions: [9001, 9002, 9003].map(id => ({
    id, name: `v${id}`, baseModel: 'SD 1.5', nsfwLevel: 1,
    trainedWords: [], files: [file(String(id))], images: [],
  })),
}

const model = (id: number) =>
  id === 900 ? MULTI as unknown as Record<string, unknown> : page.items.find(m => m.id === id)!

const realFetch = globalThis.fetch
let fetchSpy: ReturnType<typeof vi.fn>

/**
 * Routes /models/:id to the fixture, /model-versions/mini/:id to `opts.mini`,
 * and /api/download/* to a status.
 *
 * `mini` is ABSENT BY DEFAULT (404 ⇒ the pre-flight answers UNKNOWN), so every
 * test written before the pre-flight existed keeps driving the blind Range probe
 * it was written for, with `downloadStatus` still deciding the verdict.
 */
function installFetch(opts: { downloadStatus?: number | number[]; mini?: Record<string, unknown> } = {}) {
  const statuses = Array.isArray(opts.downloadStatus)
    ? [...opts.downloadStatus]
    : [opts.downloadStatus ?? 307]
  fetchSpy = vi.fn(async (url: unknown) => {
    const u = String(url)
    if (u.includes('/api/v1/model-versions/mini/')) {
      return opts.mini
        ? { ok: true, status: 200, headers: new Map() as unknown as Headers, json: async () => opts.mini }
        : { ok: false, status: 404, headers: new Map() as unknown as Headers, json: async () => ({}) }
    }
    if (u.includes('/api/download/')) {
      const code = statuses.length > 1 ? statuses.shift()! : statuses[0]!
      return { ok: code < 400, status: code, headers: new Map() as unknown as Headers }
    }
    const m = /\/api\/v1\/models\/(\d+)/.exec(u)
    if (m) return { ok: true, status: 200, json: async () => model(Number(m[1])) }
    return { ok: true, status: 200, json: async () => ({ items: [], metadata: { nextCursor: null } }) }
  })
  globalThis.fetch = fetchSpy as unknown as typeof fetch
}

const call = (channel: string, payload: unknown) => handlers.get(channel)!({ sender: {} }, payload)

beforeEach(() => {
  h.mode = 'open'
  h.key = null
  h.settings = { civitaiAdultMode: false, civitaiAdultAcceptedAt: 0 }
  h.installed = []
  handlers.clear()
  laneC.added.length = 0
  laneC.addedAdapters.length = 0
  laneC.fromRow.mockClear()
  laneC.fromAdapterRow.mockClear()
  dl.calls.length = 0
  dl.adapterCalls.length = 0
  installFetch()
  registerCivitaiIpc()
})
afterEach(() => { globalThis.fetch = realFetch })

// ─── channels ────────────────────────────────────────────────────────────────

describe('registerCivitaiIpc — the channel surface', () => {
  it('registers exactly search, detail, install, adult-state and validate-key', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'civitai:adult-state', 'civitai:detail', 'civitai:install', 'civitai:search',
      'civitai:validate-key',
    ])
  })
})

// ─── validate-key: the ping that makes a typo legible AT PASTE TIME ──────────
//
// MEASURED 2026-08-01 with a deliberately fake key: every PUBLIC Civitai
// endpoint answers 200 to a garbage bearer (/models, /model-versions/mini/*),
// while /api/v1/me answers 401 to missing, malformed and wrong keys alike — the
// docs say so too ("the API does not distinguish between them",
// developer.civitai.com/site/reference/users.md). So /me is the ONLY endpoint
// that can reject a bad key, and the card refuses to store one that it rejects.

describe('civitai:validate-key', () => {
  /** Serve /api/v1/me with a status and body; everything else 404s. */
  const serveMe = (status: number, body: unknown = {}) => {
    fetchSpy = vi.fn(async (url: unknown) =>
      String(url).includes('/api/v1/me')
        ? { ok: status < 400, status, headers: new Map() as unknown as Headers, json: async () => body }
        : { ok: false, status: 404, headers: new Map() as unknown as Headers, json: async () => ({}) })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
  }

  it('a live key comes back with the ACCOUNT NAME — the part a user can check', async () => {
    serveMe(200, { id: 12345, username: 'smolemaru', tier: 'free' })
    await expect(call('civitai:validate-key', { key: ' k-live ' }))
      .resolves.toEqual({ ok: true, username: 'smolemaru' })
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://civitai.com/api/v1/me')
  })

  it('sends the TYPED key, not the stored one — and never as ?token=', async () => {
    // The card pings BEFORE it saves, so the keychain still holds the credential
    // being replaced. Validating that one would report on the wrong key.
    h.key = 'the-old-stored-key'
    serveMe(200, { username: 'x' })
    await call('civitai:validate-key', { key: 'the-newly-typed-key' })
    const [url, init] = fetchSpy.mock.calls[0]! as [string, { headers: Record<string, string> }]
    expect(init.headers.Authorization).toBe('Bearer the-newly-typed-key')
    expect(String(url)).not.toContain('token=')
    expect(String(url)).not.toContain('the-newly-typed-key')
  })

  it('401 is reported WITH the status, so the card can say "Civitai said no"', async () => {
    serveMe(401, { error: 'Unauthorized' })
    await expect(call('civitai:validate-key', { key: 'garbage' }))
      .resolves.toEqual({ ok: false, verdict: 'rejected', status: 401 })
  })

  it('a 5xx or a dead network is "could not ask", NOT "rejected"', async () => {
    // The verdict is the whole point of this test: only an affirmative 401 may
    // cost the user a save, so everything here must read 'unverified'.
    serveMe(503)
    await expect(call('civitai:validate-key', { key: 'k' }))
      .resolves.toEqual({ ok: false, verdict: 'unverified', status: 503 })
    fetchSpy.mockRejectedValue(new Error('ETIMEDOUT'))
    await expect(call('civitai:validate-key', { key: 'k' }))
      .resolves.toEqual({ ok: false, verdict: 'unverified' })
  })

  it('a 200 with no username is still ACCEPTED — a live key is not called dead', async () => {
    serveMe(200, { id: 1 })
    await expect(call('civitai:validate-key', { key: 'k' })).resolves.toEqual({ ok: true, username: '' })
  })

  it('an empty or non-string key never reaches the network', async () => {
    serveMe(200, { username: 'x' })
    for (const bad of [undefined, null, '', '   ', 42, {}, []]) {
      await expect(call('civitai:validate-key', { key: bad }), JSON.stringify(bad))
        .resolves.toEqual({ ok: false, verdict: 'unverified' })
    }
    await expect(call('civitai:validate-key', null)).resolves.toEqual({ ok: false, verdict: 'unverified' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is gated by PRIVATE MODE, and reports it as "could not ask"', async () => {
    h.mode = 'private'
    serveMe(200, { username: 'x' })
    await expect(call('civitai:validate-key', { key: 'k' }))
      .resolves.toEqual({ ok: false, verdict: 'unverified' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ─── search ──────────────────────────────────────────────────────────────────

describe('civitai:search', () => {
  it('returns { rows, nextCursor } and never rejects', async () => {
    const res = await call('civitai:search', { query: 'anime' }) as { rows: unknown[]; nextCursor: unknown }
    expect(Array.isArray(res.rows)).toBe(true)
    expect(res.nextCursor).toBe(null)
  })

  it('accepts an empty/absent payload (the first page needs no arguments)', async () => {
    await expect(call('civitai:search', undefined)).resolves.toMatchObject({ rows: [], nextCursor: null })
  })

  it('resolves with an error field instead of rejecting when the API fails', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    const res = await call('civitai:search', { query: 'x' }) as { rows: unknown[]; nextCursor: unknown; error: string }
    expect(res.rows).toEqual([])
    expect(res.nextCursor).toBe(null)
    expect(res.error).toMatch(/503/)
  })

  it('reports the PRIVATE MODE denial through the same shape, having fetched nothing', async () => {
    h.mode = 'private'
    const res = await call('civitai:search', { query: 'x' }) as { rows: unknown[]; error: string }
    expect(res.rows).toEqual([])
    expect(res.error).toMatch(/PRIVATE MODE/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('strips unknown payload keys rather than forwarding them', async () => {
    await call('civitai:search', { query: 'x', nsfw: true, browsingLevel: 16, page: 3 })
    const url = String(fetchSpy.mock.calls[0]![0])
    expect(url).toContain('nsfw=false')      // ours, not theirs
    expect(url).not.toContain('nsfw=true')
    expect(url).not.toContain('browsingLevel')
    expect(url).not.toContain('page=')
  })

  it('rejects a malformed payload into the error field (never throws at the boundary)', async () => {
    const res = await call('civitai:search', { limit: 9999 }) as { rows: unknown[]; error: string }
    expect(res.rows).toEqual([])
    expect(res.error).toBeTruthy()
  })
})

// ─── install: the trust boundary ─────────────────────────────────────────────

describe('civitai:install — main NEVER trusts the row it is handed', () => {
  const installable = { modelId: 3627, versionId: 4007 }   // Protogen v2.2, SD 1.5, SafeTensor

  it('happy path: re-fetches, registers with lane C, then drives the managed download', async () => {
    const res = await call('civitai:install', { row: installable })
    expect(res).toEqual({ ok: true })

    // It re-read the model rather than trusting the payload.
    expect(fetchSpy.mock.calls.some(c => String(c[0]).includes('/api/v1/models/3627'))).toBe(true)

    // Lane C got the AUTHORITATIVE row (server-derived url + hash), not the payload.
    expect(laneC.fromRow).toHaveBeenCalledTimes(1)
    const handed = laneC.fromRow.mock.calls[0]![0] as Record<string, unknown>
    expect(handed.versionId).toBe(4007)
    expect(handed.installable).toBe(true)
    expect(String(handed.sha256)).toMatch(/^[0-9a-f]{64}$/)
    expect(String(handed.downloadUrl)).toContain('civitai.com/api/download/models/4007')

    // …and the existing sd download path was driven BY ID.
    expect(laneC.added).toHaveLength(1)
    expect(dl.calls).toHaveLength(1)
    expect(dl.calls[0]![1]).toBe(laneC.added[0]!.id)
    expect(laneC.added[0]!.id).toBe('civitai-4007')
  })

  it('REFUSES a row that claims installable:true on a PickleTensor checkpoint', async () => {
    // Dreamlike Diffusion 1.0 — real, SFW, SD 1.5, and a .ckpt. The renderer
    // says "install it"; main re-derives the verdict and says no.
    const res = await call('civitai:install', {
      row: { modelId: 1274, versionId: 1356, installable: true, reason: undefined, format: 'SafeTensor' },
    }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/[Pp]ickle/)
    expect(laneC.added).toHaveLength(0)
    expect(dl.calls).toHaveLength(0)
  })

  it('IGNORES a rewritten downloadUrl / sha256 / sizeMb in the payload', async () => {
    await call('civitai:install', {
      ...{ row: { ...installable, downloadUrl: 'https://evil.example/payload.exe', sha256: 'deadbeef', sizeMb: 1 } },
    })
    const handed = laneC.fromRow.mock.calls[0]![0] as Record<string, unknown>
    expect(handed.downloadUrl).not.toContain('evil.example')
    expect(handed.sha256).not.toBe('deadbeef')
    expect(handed.sizeMb).toBeGreaterThan(100)
  })

  it('REFUSES a model the gate excludes — it simply has no row', async () => {
    // 4201 Realistic Vision: nsfw:false, nsfwLevel:15. mapCivitaiPage drops it,
    // so the lookup finds nothing and the answer is honest rather than a crash.
    const res = await call('civitai:install', { row: { modelId: 4201, versionId: 501240 } }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no longer available/i)
    expect(dl.calls).toHaveLength(0)
  })

  it('installs an OLDER version the browse card never showed', async () => {
    // The catalog collapses this model to one card (v9001). Install must still
    // resolve v9003 — the re-fetch runs with allVersions, so every gate-passing
    // version stays reachable by id.
    const res = await call('civitai:install', { row: { modelId: 900, versionId: 9003 } })
    expect(res).toEqual({ ok: true })
    expect(laneC.added[0]!.id).toBe('civitai-9003')
    expect(dl.calls[0]![1]).toBe('civitai-9003')
  })

  it('REFUSES a version id that does not belong to the model id', async () => {
    const res = await call('civitai:install', { row: { modelId: 3627, versionId: 999999 } }) as { ok: boolean }
    expect(res.ok).toBe(false)
    expect(dl.calls).toHaveLength(0)
  })

  it('REFUSES an adapter with NO base installed, naming the checkpoint it needs', async () => {
    // h.installed is empty in beforeEach — nothing to run this LoRA on top of.
    const res = await call('civitai:install', { row: { modelId: 25995, versionId: 32988 } }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/SD 1\.5 checkpoint/)
    expect(dl.calls).toHaveLength(0)
    expect(dl.adapterCalls).toHaveLength(0)
  })

  it('REFUSES Flux with the component-bundle reason', async () => {
    const res = await call('civitai:install', { row: { modelId: 618692, versionId: 691639 } }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/component bundle/i)
  })

  it('is blocked by PRIVATE MODE before any network call', async () => {
    h.mode = 'private'
    const res = await call('civitai:install', { row: installable }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/PRIVATE MODE/)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(dl.calls).toHaveLength(0)
  })

  it('rejects a malformed payload without throwing across the IPC boundary', async () => {
    for (const bad of [null, {}, { row: {} }, { row: { modelId: 'x', versionId: 1 } }, { row: { modelId: -3, versionId: 1 } }]) {
      const res = await call('civitai:install', bad) as { ok: boolean; error?: string }
      expect(res.ok, JSON.stringify(bad)).toBe(false)
      expect(res.error).toBeTruthy()
    }
    expect(dl.calls).toHaveLength(0)
  })
})

describe('civitai:install — the auth path (try anonymous FIRST)', () => {
  const installable = { modelId: 3627, versionId: 4007 }

  it('attaches NO Authorization header when the download is open', async () => {
    await call('civitai:install', { row: installable })
    expect(laneC.fromRow.mock.calls[0]![1]).toEqual({})
    expect(laneC.added[0]!.requiresKey).toBeUndefined()
    expect((dl.calls[0]![2] as { headers?: unknown })?.headers).toBeUndefined()
  })

  it('401 + no stored key ⇒ honest refusal pointing at Settings, nothing registered', async () => {
    installFetch({ downloadStatus: 401 })
    const res = await call('civitai:install', { row: installable }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Civitai account/)
    expect(res.error).toMatch(/Settings/)
    expect(laneC.added).toHaveLength(0)
    expect(dl.calls).toHaveLength(0)
  })

  it('401 + a stored key ⇒ retries once and threads headers to BOTH consumers', async () => {
    h.key = 'civ-secret'
    installFetch({ downloadStatus: [401, 307] })
    const res = await call('civitai:install', { row: installable })
    expect(res).toEqual({ ok: true })

    // (a) the registry mapper, which records the durable `requiresKey: true`…
    expect(laneC.fromRow.mock.calls[0]![1]).toEqual({ headers: { Authorization: 'Bearer civ-secret' } })
    expect(laneC.added[0]!.requiresKey).toBe(true)
    // (b) …and the download itself. addUserSdModel STRIPS `headers` before
    //     writing, so a bearer token never reaches user-sd-models.json — which
    //     means the live header MUST be handed to downloadSdModel separately or
    //     the authed download silently 401s.
    expect(laneC.added[0]!.headers).toBeUndefined()
    expect(dl.calls).toHaveLength(1)
    expect(dl.calls[0]![2]).toEqual({ headers: { Authorization: 'Bearer civ-secret' } })
  })

  it('401 + a REJECTED key ⇒ says the key was rejected, does not install', async () => {
    h.key = 'stale'
    installFetch({ downloadStatus: 401 })
    const res = await call('civitai:install', { row: installable }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/rejected/i)
    expect(dl.calls).toHaveLength(0)
  })
})

// ─── LAYER 0, VERSION LEVEL: the flag only the mini endpoint carries ─────────
//
// `minor` is absent from the `modelVersions[]` a /models page embeds, so the
// browse gate can never see it. `GET /api/v1/model-versions/mini/:id` carries it
// (<https://developer.civitai.com/site/reference/model-versions.md>), the auth
// pre-flight already fetches that record for `requireAuth`, and it rides back on
// the probe verdict — so this costs no extra request. These tests pin the two
// halves that matter: an explicit `true` refuses, and anything else is INVISIBLE.

describe('civitai:install — version-level minor is a kill switch', () => {
  const installable = { modelId: 3627, versionId: 4007 }
  /** The exact string the vanished-row (model-level) refusal uses. */
  const LAYER0 = 'That model version is no longer available for install.'

  it('REFUSES a version flagged minor:true, though the model itself is clean', async () => {
    // Protogen 4007 passes every model-level fence — poi/minor/mode/bitmask/tags
    // — and installs happily in the tests above. The ONLY new fact is the
    // version-level flag, and it is enough on its own.
    installFetch({ mini: { id: 4007, requireAuth: false, minor: true } })
    const res = await call('civitai:install', { row: installable }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toBe(LAYER0)
    expect(laneC.added).toHaveLength(0)
    expect(laneC.addedAdapters).toHaveLength(0)
    expect(dl.calls).toHaveLength(0)
    expect(dl.adapterCalls).toHaveLength(0)
  })

  it('is INDISTINGUISHABLE from the model-level refusal — one message, not two paths', async () => {
    // A chattier "flagged as depicting a minor" would be a second error path and
    // would also tell a probing caller exactly which fence it hit.
    const vanished = await call('civitai:install', { row: { modelId: 4201, versionId: 501240 } }) as { error: string }
    installFetch({ mini: { requireAuth: false, minor: true } })
    const flagged = await call('civitai:install', { row: installable }) as { error: string }
    expect(flagged.error).toBe(vanished.error)
  })

  it('beats the auth refusal: a flagged version that ALSO needs a key is a content refusal', async () => {
    // needs-key would be the truthful answer about auth and the wrong answer
    // about the model. Content refusals come first.
    installFetch({ mini: { requireAuth: true, minor: true } })
    const res = await call('civitai:install', { row: installable }) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toBe(LAYER0)
    expect(res.error).not.toMatch(/Civitai account/)
  })

  it('minor:false installs exactly as before', async () => {
    installFetch({ mini: { id: 4007, requireAuth: false, minor: false, sfwOnly: false } })
    await expect(call('civitai:install', { row: installable })).resolves.toEqual({ ok: true })
    expect(dl.calls).toHaveLength(1)
  })

  it('an ABSENT minor changes nothing — the field, the record, or the whole pre-flight', async () => {
    // Fail closed on PRESENCE, not on absence. Three ways the signal can be
    // missing, and none of them may invent a refusal:
    //   1. the response omits `minor`      ⇒ mapped to null
    //   2. the pre-flight 404s             ⇒ no record at all (the default here)
    //   3. `minor` is a non-boolean        ⇒ mapped to null, never coerced
    for (const mini of [
      { requireAuth: false },
      undefined,
      { requireAuth: false, minor: 'true' },
      { requireAuth: false, minor: 1 },
      { requireAuth: false, minor: null },
    ] as Array<Record<string, unknown> | undefined>) {
      laneC.added.length = 0
      dl.calls.length = 0
      installFetch({ mini })
      await expect(call('civitai:install', { row: installable }), JSON.stringify(mini)).resolves.toEqual({ ok: true })
      expect(dl.calls).toHaveLength(1)
    }
  })

  it('sfwOnly:true does NOT block — it is a usage restriction, not an adult signal', async () => {
    // `true` here would refuse SFW-only resources, which is the opposite of what
    // the gate is for. Wired to nothing, on purpose (see CivitaiVersionMini).
    installFetch({ mini: { requireAuth: false, sfwOnly: true } })
    await expect(call('civitai:install', { row: installable })).resolves.toEqual({ ok: true })
  })
})

// ─── PHASE 3: the 18+ surface, and who is allowed to decide it ───────────────

describe('civitai:adult-state — main answers, the renderer only asks', () => {
  it('is OFF on a fresh install', async () => {
    expect(await call('civitai:adult-state', {})).toEqual({
      unlocked: false, adultMode: false, acceptedAt: 0, hasKey: false,
    })
  })

  it('reports the three raw facts NEXT TO the verdict, so the UI can explain', async () => {
    h.settings = { civitaiAdultMode: true, civitaiAdultAcceptedAt: 1_700_000_000_000 }
    // Affirmed, switched on — and still locked, because there is no key.
    expect(await call('civitai:adult-state', {})).toEqual({
      unlocked: false, adultMode: true, acceptedAt: 1_700_000_000_000, hasKey: false,
    })
    h.key = 'civ-secret'
    expect(await call('civitai:adult-state', {})).toEqual({
      unlocked: true, adultMode: true, acceptedAt: 1_700_000_000_000, hasKey: true,
    })
  })

  it('a settings file with the switch but NO timestamp does not unlock', async () => {
    // The shape a hand-edited tachi-settings.json would have.
    h.settings = { civitaiAdultMode: true, civitaiAdultAcceptedAt: 0 }
    h.key = 'civ-secret'
    const state = await call('civitai:adult-state', {}) as { unlocked: boolean }
    expect(state.unlocked).toBe(false)
  })
})

describe('the host switch — and the renderer inability to reach it', () => {
  const modelsUrl = () =>
    fetchSpy.mock.calls.map(c => String(c[0])).find(u => u.includes('/api/v1/models'))!

  it('SFW by default: civitai.com and nsfw=false', async () => {
    await call('civitai:search', { query: 'anime' })
    expect(modelsUrl()).toContain('https://civitai.com/api/v1/models')
    expect(modelsUrl()).toContain('nsfw=false')
  })

  it('UNLOCKED: civitai.red and nsfw=true', async () => {
    h.settings = { civitaiAdultMode: true, civitaiAdultAcceptedAt: 1 }
    h.key = 'civ-secret'
    await call('civitai:search', { query: 'anime' })
    expect(modelsUrl()).toContain('https://civitai.red/api/v1/models')
    expect(modelsUrl()).toContain('nsfw=true')
  })

  it('the RENDERER cannot switch the host — the flag is stripped, not honoured', async () => {
    const res = await call('civitai:search', {
      query: 'anime',
      // every shape a caller might try
      adult: true, adultMode: true, adultAcceptedAt: Date.now(), unlocked: true,
    }) as { adult?: boolean }
    expect(modelsUrl()).toContain('https://civitai.com/api/v1/models')
    expect(modelsUrl()).toContain('nsfw=false')
    // and the response says which mode it really was
    expect(res.adult).toBe(false)
  })

  it('deleting the key mid-session returns the very next search to .com', async () => {
    h.settings = { civitaiAdultMode: true, civitaiAdultAcceptedAt: 1 }
    h.key = 'civ-secret'
    await call('civitai:search', {})
    expect(modelsUrl()).toContain('civitai.red')

    installFetch()               // fresh spy
    h.key = null                 // the user hit "Remove key"
    const res = await call('civitai:search', {}) as { adult?: boolean }
    expect(modelsUrl()).toContain('civitai.com')
    expect(res.adult).toBe(false)
  })

  it('the INSTALL lookup uses the same host as the browse that produced the row', async () => {
    h.settings = { civitaiAdultMode: true, civitaiAdultAcceptedAt: 1 }
    h.key = 'civ-secret'
    await call('civitai:install', { row: { modelId: 900, versionId: 9001 } })
    const lookup = fetchSpy.mock.calls.map(c => String(c[0])).find(u => /\/api\/v1\/models\/\d+/.test(u))!
    expect(lookup).toContain('https://civitai.red/api/v1/models/900')
  })
})

describe('the adapter verdict is driven by what is ON DISK', () => {
  /** Neuron Mix (25995 / 32988) is a real SD 1.5 LORA row in the fixture. */
  const LORA = { row: { modelId: 25995, versionId: 32988 } }

  it('installs a LoRA once an SD 1.5 checkpoint exists — into the ADAPTER registry', async () => {
    h.installed = [{ id: 'sd-turbo', name: 'SD-Turbo', kind: 'image', family: 'sd15' }]
    const res = await call('civitai:install', LORA)
    expect(res).toEqual({ ok: true })
    // The adapter registry, NOT the model registry: registering a LoRA as a
    // checkpoint would put it in the model dropdown and hand it to `-m`.
    expect(laneC.addedAdapters).toHaveLength(1)
    expect(laneC.addedAdapters[0]!.kind).toBe('lora')
    expect(laneC.added).toHaveLength(0)
    expect(dl.adapterCalls).toHaveLength(1)
    expect(dl.calls).toHaveLength(0)
  })

  it('an SDXL checkpoint does NOT make an SD 1.5 LoRA installable', async () => {
    h.installed = [{ id: 'some-xl', name: 'XL', kind: 'image', family: 'sdxl' }]
    const res = await call('civitai:install', LORA) as { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/SD 1\.5 checkpoint/)
  })

  it('a VIDEO model of the right family is not a base for an image adapter', async () => {
    h.installed = [{ id: 'wan', name: 'Wan', kind: 'video', family: 'sd15' }]
    const res = await call('civitai:install', LORA) as { ok: boolean }
    expect(res.ok).toBe(false)
  })

  it('a search reflects the same fact — the LoRA card flips to installable', async () => {
    const rowFor = async () => {
      installFetch()
      fetchSpy.mockImplementation(async (url: unknown) => {
        const u = String(url)
        if (u.includes('/api/v1/models?')) {
          return { ok: true, status: 200, json: async () => ({ items: [model(25995)], metadata: {} }) }
        }
        return { ok: true, status: 200, json: async () => ({ items: [], metadata: {} }) }
      })
      const res = await call('civitai:search', { }) as {
        rows: Array<{ installable: boolean; reasonCode?: string }>
      }
      return res.rows[0]!
    }
    const before = await rowFor()
    expect(before.installable).toBe(false)
    expect(before.reasonCode).toBe('needs-base')

    h.installed = [{ id: 'sd-turbo', name: 'SD-Turbo', kind: 'image', family: 'sd15' }]
    const after = await rowFor()
    expect(after.installable).toBe(true)
    expect(after.reasonCode).toBeUndefined()
  })

  it('DoRA stays refused however many checkpoints are installed', async () => {
    h.installed = [
      { id: 'sd-turbo', name: 'SD-Turbo', kind: 'image', family: 'sd15' },
      { id: 'xl', name: 'XL', kind: 'image', family: 'sdxl' },
    ]
    // Synthesise a DoRA over a real row's shape — the fixture has none, and the
    // point is that the ALLOWLIST refuses it, not that Civitai happens not to
    // have served one today.
    const dora = { ...model(25995), id: 901, type: 'DoRA' }
    installFetch()
    fetchSpy.mockImplementation(async (url: unknown) =>
      /\/api\/v1\/models\/\d+/.test(String(url))
        ? { ok: true, status: 200, json: async () => dora }
        : { ok: true, status: 200, json: async () => ({ items: [], metadata: {} }) })
    const res = await call('civitai:install', { row: { modelId: 901, versionId: 32988 } }) as
      { ok: boolean; error: string }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/magnitude/i)
    expect(laneC.addedAdapters).toHaveLength(0)
  })
})

describe('the full filter vocabulary reaches the wire', () => {
  const modelsUrl = () =>
    new URL(fetchSpy.mock.calls.map(c => String(c[0])).find(u => u.includes('/api/v1/models'))!)

  it('forwards every one of the 22 live model types at once', async () => {
    const all = [
      'Checkpoint', 'TextualInversion', 'Hypernetwork', 'AestheticGradient', 'LORA',
      'LoCon', 'DoRA', 'Controlnet', 'Upscaler', 'MotionModule', 'VAE', 'TextEncoder',
      'UNet', 'CLIPVision', 'Poses', 'Wildcards', 'Workflows', 'Detection',
      'VisionLanguage', 'CLIP', 'LLM', 'Other',
    ]
    await call('civitai:search', { types: all })
    expect(modelsUrl().searchParams.getAll('types')).toEqual(all)
  })

  it('drops an unknown type instead of 400-ing the whole search', async () => {
    await call('civitai:search', { types: ['Checkpoint', 'LyCORIS', 'NotAType'] })
    expect(modelsUrl().searchParams.getAll('types')).toEqual(['Checkpoint'])
  })

  it('forwards sort and period, and repeats baseModels', async () => {
    await call('civitai:search', {
      sort: 'Newest', period: 'Week', baseModels: ['SD 1.5', 'SDXL 1.0'],
    })
    const p = modelsUrl().searchParams
    expect(p.get('sort')).toBe('Newest')
    expect(p.get('period')).toBe('Week')
    expect(p.getAll('baseModels')).toEqual(['SD 1.5', 'SDXL 1.0'])
  })

  it('falls back to the default sort on an invalid one, and drops a bad period', async () => {
    await call('civitai:search', { sort: 'Most Liked By Me', period: 'Hour' })
    const p = modelsUrl().searchParams
    expect(p.get('sort')).toBe('Most Downloaded')
    expect(p.has('period')).toBe(false)
  })
})
