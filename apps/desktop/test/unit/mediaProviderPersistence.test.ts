// apps/desktop/test/unit/mediaProviderPersistence.test.ts
//
// THE PROVIDER CHIP MUST SURVIVE A TAB SWITCH — IT SPENDS MONEY.
//
// Driver finding (owner, live): on Media the provider was LOCAL (accent border)
// with a local checkpoint selected. Navigate media → chat → media, and the chip
// came back SURPLUS with Venice's cloud model list under it. The prompt, the
// size and the modality all persisted — only the provider reverted, silently,
// and the next Generate went out as a real cloud request nobody asked for.
//
// ROOT CAUSE, the same shape as the run-state lane (mediaRunState.test.ts) one
// field over: everything that persisted lives in media.store, and the provider
// did not —
//     const [mediaProvider, setMediaProvider] = useState<...>('surplus')
// React unmounts MediaPage on a tab switch, throws that useState away, and the
// initializer re-runs on remount. Nothing "raced" and nothing overrode a
// persisted value: there was no persisted value.
//
// Pinned here: the provider is part of the persisted composer form, it survives
// a remount AND a fresh store (a restart), and the one legitimate reset — a
// provider that cannot serve the active modality — is EXPLICIT, not silent.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

// --- in-memory localStorage shim, installed BEFORE the store is imported -----
// (the idiom mediaRunState.test.ts / catalogStore.test.ts use)
const ls = new Map<string, string>()
const localStorageShim = {
  getItem: (k: string): string | null => (ls.has(k) ? ls.get(k)! : null),
  setItem: (k: string, v: string): void => { ls.set(k, v) },
  removeItem: (k: string): void => { ls.delete(k) },
  clear: (): void => { ls.clear() },
  key: (i: number): string | null => Array.from(ls.keys())[i] ?? null,
  get length(): number { return ls.size },
}
;(globalThis as unknown as { localStorage: typeof localStorageShim }).localStorage = localStorageShim

type StoreMod   = typeof import('../../src/store/media.store')
type HelpersMod = typeof import('../../src/pages/media/mediaHelpers')
let useMediaStore: StoreMod['useMediaStore']
let helpers: HelpersMod

beforeAll(async () => {
  ;({ useMediaStore } = await import('../../src/store/media.store'))
  helpers = await import('../../src/pages/media/mediaHelpers')
})

beforeEach(() => {
  useMediaStore.setState({ provider: 'surplus', modality: 'image' })
  ls.clear()
})

const persisted = () => JSON.parse(ls.get('tachi-media-v1') ?? '{"state":{}}').state as Record<string, unknown>

describe('provider lives in the store, next to the params that already survived', () => {
  it('defaults to surplus', () => {
    expect(useMediaStore.getState().provider).toBe('surplus')
  })

  it('setProvider records the choice', () => {
    useMediaStore.getState().setProvider('local')
    expect(useMediaStore.getState().provider).toBe('local')
  })

  it('SURVIVES A REMOUNT — the store outlives the component (the repro)', () => {
    // A tab switch unmounts MediaPage and mounts it again; the store is module
    // state, so "remount" is simply reading it again. This is the assertion the
    // old useState('surplus') could not satisfy.
    useMediaStore.getState().setProvider('local')
    useMediaStore.getState().setModel('image', 'civitai-142421')
    useMediaStore.getState().setParam('image', 'prompt', 'a cat')

    const afterRemount = useMediaStore.getState()
    expect(afterRemount.provider).toBe('local')
    // …and it comes back together with the things that ALREADY came back.
    expect(afterRemount.modelByModality.image).toBe('civitai-142421')
    expect(afterRemount.paramsByModality.image?.prompt).toBe('a cat')
  })

  it('is written to localStorage alongside the rest of the composer form', () => {
    useMediaStore.getState().setProvider('venice')
    expect(persisted().provider).toBe('venice')
  })

  it('rehydrates into a FRESH store — an app restart keeps the route', async () => {
    ls.set('tachi-media-v1', JSON.stringify({
      state: { provider: 'local', modality: 'image', modelByModality: { image: 'sd-turbo' }, paramsByModality: {}, gallery: [], autoSaveDir: null },
      version: 0,
    }))
    vi.resetModules()
    const fresh = await import('../../src/store/media.store')
    expect(fresh.useMediaStore.getState().provider).toBe('local')
  })

  it('an OLD save with no provider key still parses, at the default', async () => {
    ls.set('tachi-media-v1', JSON.stringify({
      state: { modality: 'image', modelByModality: {}, paramsByModality: {}, gallery: [], autoSaveDir: null },
      version: 0,
    }))
    vi.resetModules()
    const fresh = await import('../../src/store/media.store')
    expect(fresh.useMediaStore.getState().provider).toBe('surplus')
  })

  it('the run slice is still NOT persisted (no regression from adding a field)', () => {
    useMediaStore.getState().setProvider('local')
    useMediaStore.getState().beginRun({ cancellable: true })
    expect(persisted().run).toBeUndefined()
  })
})

describe('the ONE legitimate reset is explicit, not silent', () => {
  it('local serves image / video / tts and nothing else', () => {
    expect(helpers.providerServesModality('local', 'image')).toBe(true)
    expect(helpers.providerServesModality('local', 'video')).toBe(true)
    expect(helpers.providerServesModality('local', 'tts')).toBe(true)
    expect(helpers.providerServesModality('local', 'music')).toBe(false)
    expect(helpers.providerServesModality('local', 'stt')).toBe(false)
  })

  it('imgnai serves image / video only', () => {
    expect(helpers.providerServesModality('imgnai', 'image')).toBe(true)
    expect(helpers.providerServesModality('imgnai', 'video')).toBe(true)
    expect(helpers.providerServesModality('imgnai', 'music')).toBe(false)
    expect(helpers.providerServesModality('imgnai', 'tts')).toBe(false)
    expect(helpers.providerServesModality('imgnai', 'stt')).toBe(false)
  })

  it('surplus and venice serve every modality', () => {
    for (const m of ['image', 'video', 'music', 'tts', 'stt'] as const) {
      expect(helpers.providerServesModality('surplus', m)).toBe(true)
      expect(helpers.providerServesModality('venice', m)).toBe(true)
    }
  })

  it('keeps the persisted provider when it CAN serve the modality', () => {
    expect(helpers.resolveProviderForModality('local', 'image')).toEqual({ provider: 'local', fellBack: false })
  })

  it('falls back to surplus when it cannot — and SAYS SO', () => {
    // `fellBack` is the whole point: the old code flipped the chip with no
    // notice at all, which is how a cloud request got made unintentionally.
    expect(helpers.resolveProviderForModality('local', 'music')).toEqual({ provider: 'surplus', fellBack: true })
    expect(helpers.resolveProviderForModality('imgnai', 'stt')).toEqual({ provider: 'surplus', fellBack: true })
  })
})

// ── THE 1-SECOND RACE: the chip and the list must name the same provider ─────
//
// Driver finding (owner, live): click a MODALITY, then the LOCAL chip inside
// ~1 s, and the MODEL dropdown keeps showing the cloud list (Venice / Surplus
// rows) while the Local chip is highlighted. It self-heals only on a provider
// toggle.
//
// ROOT CAUSE: two model-list loads are in flight and NOTHING orders them. The
// modality click issues load A for the OLD provider (a network call to the
// gateway); the chip click issues load B for LOCAL (an sd-cpp status IPC, an
// order of magnitude faster). B lands first and paints the local list; A lands
// second and overwrites it — the loser of the race wins the screen. Neither
// call was cancellable and neither response carried the route it was fetched
// for, so the applier could not tell them apart.
//
// …and the SAME missing fact produced the transient footer "SURPLUS · SD-TURBO"
// during a modality fallback: the echo line took the provider from live state
// and the model label from whatever list happened to be loaded, so for ~250 ms
// it paired a cloud provider with a local checkpoint. Two derivations, one
// snapshot — that is the fix for both.
describe('one route, one model list', () => {
  const R = (provider: string, modality: string) =>
    ({ provider, modality }) as Parameters<HelpersMod['sameMediaRoute']>[0]

  it('a route is provider AND modality — either one differing is a different route', () => {
    expect(helpers.sameMediaRoute(R('local', 'image'), R('local', 'image'))).toBe(true)
    expect(helpers.sameMediaRoute(R('local', 'image'), R('surplus', 'image'))).toBe(false)
    expect(helpers.sameMediaRoute(R('local', 'image'), R('local', 'video'))).toBe(false)
    expect(helpers.sameMediaRoute(null, R('local', 'image'))).toBe(false)
    expect(helpers.sameMediaRoute(R('local', 'image'), null)).toBe(false)
    expect(helpers.sameMediaRoute(null, null)).toBe(false)
  })

  it('THE REPRO: the slow cloud response is discarded once Local is active', () => {
    // Load A was issued for surplus/image, load B for local/image. B is applied
    // (it matches the live route); A must not be, however late it arrives.
    const active = R('local', 'image')
    expect(helpers.sameMediaRoute(R('surplus', 'image'), active)).toBe(false)
    expect(helpers.sameMediaRoute(R('local', 'image'), active)).toBe(true)
  })
})

describe('the footer echo never pairs one provider with another\'s model', () => {
  const active = { provider: 'local', modality: 'image' } as Parameters<HelpersMod['resolveRouteEcho']>[0]
  const localList = { route: active, models: [{ id: 'sd-turbo', label: 'SD-Turbo' }] }

  it('renders provider + label when the snapshot was loaded for THIS route', () => {
    expect(helpers.resolveRouteEcho(active, 'sd-turbo', localList))
      .toEqual({ provider: 'local', label: 'SD-Turbo' })
  })

  it('THE REPRO: renders NOTHING while the list still belongs to another provider', () => {
    // The ~250 ms window during a modality fallback: provider already flipped to
    // surplus, the local list has not been replaced yet. "SURPLUS · SD-TURBO" is
    // a route that does not exist — so no line at all until the two agree.
    const afterFallback = { provider: 'surplus', modality: 'video' } as typeof active
    expect(helpers.resolveRouteEcho(afterFallback, 'sd-turbo', localList)).toBeNull()
  })

  it('renders nothing when no list has loaded yet, or no model is selected', () => {
    expect(helpers.resolveRouteEcho(active, 'sd-turbo', null)).toBeNull()
    expect(helpers.resolveRouteEcho(active, '', localList)).toBeNull()
  })

  it('reports a null LABEL — never a wrong one — for a model the list lacks', () => {
    // Right route, but the id is not in it (a Remix landing a moment before the
    // list catches up). The caller falls back to modelDisplayName(); the pairing
    // is still honest because the PROVIDER is the one the list was loaded for.
    expect(helpers.resolveRouteEcho(active, 'civitai-142421', localList))
      .toEqual({ provider: 'local', label: null })
  })
})

describe('MediaPage wiring', () => {
  const read = async (rel: string) => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    return readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
  }

  it('discards a superseded model-list response instead of painting it', async () => {
    const page = await read('src/pages/media/MediaPage.tsx')
    // A monotonic request id (the coordinator the Catalog tab already uses for
    // its two racing searches) plus the route the response was fetched FOR.
    expect(page).toMatch(/createRequestCoordinator/)
    expect(page).toMatch(/isCurrent\(reqId\)/)
    expect(page).toMatch(/setModelsRoute/)
  })

  it('derives the footer echo from that one snapshot', async () => {
    const page = await read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/resolveRouteEcho/)
    // The old line read `{mediaProvider} · {models.find(...)}` — two sources.
    expect(page).not.toMatch(/\{mediaProvider\} · \{models\.find/)
  })

  it('binds the provider to the store instead of a component useState', async () => {
    const page = await read('src/pages/media/MediaPage.tsx')
    expect(page).not.toMatch(/useState<'surplus'\s*\|\s*'venice'\s*\|\s*'local'\s*\|\s*'imgnai'>/)
    expect(page).toMatch(/useMediaStore\(s => s\.provider\)/)
    expect(page).toMatch(/useMediaStore\(s => s\.setProvider\)/)
  })

  it('the modality fallback goes through the helper and surfaces a notice', async () => {
    const page = await read('src/pages/media/MediaPage.tsx')
    expect(page).toMatch(/resolveProviderForModality/)
    expect(page).toMatch(/toast\.providerFellBack/)
  })

  it('the notice string exists in every locale', async () => {
    const locales = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']
    for (const l of locales) {
      const json = JSON.parse(await read(`src/i18n/locales/${l}/media.json`)) as {
        toast: Record<string, string>
      }
      expect(json.toast.providerFellBack, `${l}/media.json`).toBeTruthy()
      expect(json.toast.providerFellBack).toContain('{{provider}}')
    }
  })
})
