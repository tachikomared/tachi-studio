// apps/desktop/src/pages/catalog/catalog.store.ts
//
// Catalog page state: hardware profile, curated/HF entries, installed set,
// in-flight download progress, capability-tag filter. Fit badges are computed
// in the component via @tachi/core estimateFit — not stored.
//
// Local media models (stable-diffusion.cpp image + video) are surfaced as
// curated CatalogEntry rows with modality tags (image-gen / video-gen) so they
// show + filter alongside the local text models. Their install state is tracked
// separately in `sdInstalledIds` (they are not classic InstalledModel rows).

import { create } from 'zustand'
import type { HardwareProfile, CatalogEntry, InstalledModel, RuntimeId, Capability } from '@tachi/core'
import type { CivitaiSearchRow } from '../../types/electron'
import i18n from '../../i18n'
import { hfSearchCoordinator, civitaiSearchCoordinator } from './search'
import { cachedFetch, invalidateCachePrefix } from './modelSelectCache'
import { blockedLocalCatalogEntries } from './blockedLocalRows'
import {
  CIVITAI_DEFAULT_PERIOD,
  CIVITAI_DEFAULT_SORT,
  CIVITAI_PAGE_LIMIT,
  CIVITAI_FOR_MY_MODELS_TYPE,
  civitaiBaseModelsForFamilies,
  civitaiForMyModelsUsable,
  civitaiInstalledChipFamilies,
  civitaiPeriodValue,
  civitaiSortValue,
  civitaiTypesFor,
  mergeCivitaiRows,
  normalizeFilteredCount,
  toggleCivitaiBaseModel,
  type CivitaiChipFamily,
  type CivitaiPeriodId,
  type CivitaiSortId,
  type CivitaiTypeFilterId,
} from './civitaiRow'
import {
  civitaiDetailOpening,
  civitaiDetailResolved,
  type CivitaiDetailState,
} from './civitaiDetail'

/** Exported so the tab bar and its tests agree on the closed set. */
export type SourceTab = 'curated' | 'hf' | 'installed' | 'civitai'

interface DownloadState { ref: string; pct: number; label: string; speedBytesPerSec?: number; etaSec?: number; runtime?: string }

// ---------------------------------------------------------------------------
// Favorites + Recents — renderer-side localStorage persistence
// DevToys pattern: `{name}_IsFavorite` + capped 6-slot recents ring buffer.
// ---------------------------------------------------------------------------
const LS_FAVORITES = 'tachi:catalog-favorites'
const LS_RECENTS   = 'tachi:catalog-recents'
const RECENTS_CAP  = 6

function lsGet<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v !== null ? (JSON.parse(v) as T) : fallback }
  catch { return fallback }
}

function lsSet(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota or SSR */ }
}

/** Shift `id` to front of the recents list, capping at RECENTS_CAP entries. */
function pushRecent(current: string[], id: string): string[] {
  const next = [id, ...current.filter(x => x !== id)]
  return next.slice(0, RECENTS_CAP)
}

/** Build a CatalogEntry row for a local sd.cpp model so it renders in the grid
 *  with the right modality tag. `kind: 'text'` is a benign placeholder (not shown);
 *  the `capabilities` tag carries the real modality. */
function sdCatalogEntry(m: { id: string; name: string; kind: 'image' | 'video'; family: string; sizeMbTotal: number; minVramGb?: number; minRamGb?: number }): CatalogEntry {
  return {
    id: `sdcpp:${m.id}`,
    name: m.name,
    family: m.family,
    params: '',
    kind: 'text',
    source: 'curated',
    quants: [{ label: 'GGUF', sizeBytes: Math.round(m.sizeMbTotal * 1024 * 1024), runtime: 'sdcpp', ref: m.id }],
    capabilities: [m.kind === 'video' ? 'video-gen' : 'image-gen'],
    // The structured fit numbers (W4-A) ride to ModelCard's mediaFitNote —
    // without this projection line the data reached the renderer and was
    // dropped one hop before the surface that renders "needs ~N GB VRAM".
    ...(typeof m.minVramGb === 'number' ? { minVramGb: m.minVramGb } : {}),
    ...(typeof m.minRamGb === 'number' ? { minRamGb: m.minRamGb } : {}),
  } as CatalogEntry
}

/** Build a CatalogEntry for a local piper TTS voice (tts tag). Run routes to
 *  the Media studio (Local provider, TTS modality). */
function piperCatalogEntry(v: { id: string; name: string; lang: string; quality: string; sizeMb: number }): CatalogEntry {
  return {
    id: `piper:${v.id}`,
    name: v.name,
    family: `piper · ${v.lang}`,
    params: v.quality,
    kind: 'speech',
    source: 'curated',
    quants: [{ label: 'ONNX', sizeBytes: Math.round(v.sizeMb * 1024 * 1024), runtime: 'piper', ref: v.id }],
    capabilities: ['tts'],
  }
}

/** "~75 MB" / "~1.5 GB" → bytes (best-effort; 0 if unparseable). */
function parseSizeLabel(label: string): number {
  const m = label.match(/([\d.]+)\s*(MB|GB)/i)
  if (!m) return 0
  return Math.round(parseFloat(m[1]) * (m[2].toUpperCase() === 'GB' ? 1024 ** 3 : 1024 ** 2))
}

/** Build a CatalogEntry for a local whisper.cpp STT model (stt tag). Run routes
 *  to Chat, where the mic uses it for transcription. */
function whisperCatalogEntry(m: { name: string; sizeLabel: string }): CatalogEntry {
  return {
    id: `whisper:${m.name}`,
    name: `Whisper ${m.name}`,
    family: 'whisper.cpp',
    params: m.sizeLabel.replace(/^~\s*/, ''),
    kind: 'speech',
    source: 'curated',
    quants: [{ label: 'GGML', sizeBytes: parseSizeLabel(m.sizeLabel), runtime: 'whisper', ref: m.name }],
    capabilities: ['stt'],
  }
}

/**
 * Every sd.cpp id that is ON DISK, from one status snapshot.
 *
 * `adapters` is read DEFENSIVELY (`?? []`): an older main build has no such
 * field, and the whole point of this helper is that forgetting the adapter half
 * is exactly the bug it fixes. A missing field means "no adapters", never a
 * crash on the models half.
 */
export function sdInstalledIdsFrom(st: {
  models?: ReadonlyArray<{ id: string }>
  adapters?: ReadonlyArray<{ id: string }>
} | null | undefined): string[] {
  const ids = [
    ...(st?.models ?? []).map(m => m.id),
    ...(st?.adapters ?? []).map(a => a.id),
  ].filter((id): id is string => typeof id === 'string' && id !== '')
  return [...new Set(ids)]
}

interface CatalogStore {
  hardware: HardwareProfile | null
  curated: CatalogEntry[]
  hfResults: CatalogEntry[]
  installed: InstalledModel[]
  /**
   * sd.cpp ids currently ON DISK — checkpoints AND adapters, in one set.
   *
   * The adapter half is not cosmetic. Since the gate lane flipped
   * LoRA/embedding/VAE to installable, an installed adapter comes back from
   * `sd-cpp:status` under `adapters`, not `models`; reading only `models` left
   * every installed LoRA card still offering INSTALL, which is both a lie and
   * a re-download. The two id spaces cannot collide — a Civitai version id is
   * either a checkpoint or an adapter, never both, and the curated ids
   * ('sd15', 'wan21-t2v-1.3b') are not version ids at all.
   */
  sdInstalledIds: string[]
  /** piper voice ids currently downloaded. */
  piperInstalledIds: string[]
  /** whisper STT model names currently on disk. */
  whisperInstalledIds: string[]
  sourceTab: SourceTab
  query: string
  /** Capability tags the user has toggled on; empty = show all. */
  activeTags: Capability[]
  loading: boolean
  hfError: string | null
  download: DownloadState | null
  notice: { kind: 'ok' | 'error'; msg: string } | null

  // ── Civitai source tab ────────────────────────────────────────────────────
  // Kept in its OWN slice rather than folded into hfResults/hfError: the rows
  // are a different shape (CivitaiSearchRow, not CatalogEntry — the card is
  // built from it at render time), the paging is cursor-based, and a failure on
  // one tab must never blank the other.
  /** Rows accumulated across cursor pages, in server order. */
  civitaiRows: CivitaiSearchRow[]
  /** Opaque `metadata.nextCursor`; null = no further page. NEVER a page number. */
  civitaiCursor: string | null
  civitaiError: string | null
  /**
   * Models the content gate removed from the page(s) currently on screen.
   *
   * ACCUMULATED across cursor pages, exactly like `civitaiRows` is: the line
   * describes the grid the user is looking at, so appending 24 more results of
   * which 20 were gated has to move it. Reset on every fresh search.
   */
  civitaiFilteredCount: number
  /** First page / re-search in flight (the grid shows skeletons). */
  civitaiLoading: boolean
  /** A cursor append is in flight (only the Load-more button shows it). */
  civitaiLoadingMore: boolean
  /** Active type chip (single-select — `types=` narrows, it does not widen). */
  civitaiType: CivitaiTypeFilterId
  /** Active sort chip. */
  civitaiSort: CivitaiSortId
  /** Active period chip. */
  civitaiPeriod: CivitaiPeriodId
  /**
   * Active base-model chips. MULTI-select: `baseModels` is a repeatable query
   * param, so two chips is a union server-side and costs one request.
   */
  civitaiBaseModels: string[]
  /**
   * "For my models" — the discovery toggle.
   *
   * ON, the search is CONSTRAINED to the base models of the families the user
   * actually has installed, and the type chip is pointed at LoRA. It never
   * makes a card installable: the per-card verdict is still main's, computed
   * from what is on disk, and a Wan card still says installing it here is not
   * wired. This narrows the BROWSE, nothing else.
   *
   * It overrides the manual base-model chips while it is on rather than
   * intersecting with them — two filters both claiming to own `baseModels=`
   * produce a grid neither of them describes.
   */
  civitaiForMyModels: boolean
  /**
   * Chip families the user has an installed row for, derived from the sd-cpp
   * status snapshot the catalog already fetches. Empty until the first status
   * lands, which is also the state in which the toggle is disabled.
   */
  civitaiInstalledFamilies: CivitaiChipFamily[]
  /**
   * The mode the rows ON SCREEN were served in (main's `result.adult`), NOT the
   * setting. Undefined until a page lands — the tab then falls back to
   * `civitaiAdultState` for the pre-first-search window.
   */
  civitaiAdultServed: boolean | undefined
  /** Main's own 18+ verdict + the three facts behind it. Null until read. */
  civitaiAdultState: { unlocked: boolean; adultMode: boolean; acceptedAt: number; hasKey: boolean } | null
  /** Row id whose install is in flight, or null. */
  civitaiInstalling: string | null
  /** The query the currently-displayed rows were fetched for (debounce guard). */
  civitaiLastQuery: string
  /**
   * The open detail panel, or null.
   *
   * SINGLE-INSTANCE by design: clicking a card while a panel is open replaces
   * it, which is why the staleness check on a late reply is the model id rather
   * than a request counter (civitaiDetailResolved).
   *
   * The ROW it was opened from is held alongside, because the panel renders its
   * header, chips, verdict and thumbnail from that row and must keep doing so
   * while — and after — the fetch fails. Looking the row back up out of
   * `civitaiRows` would break the moment a re-search replaced the array under an
   * open panel.
   */
  civitaiDetail: CivitaiDetailState | null
  civitaiDetailRow: CivitaiSearchRow | null

  /** Polled llama.cpp server snapshot — drives the one-verb RUN button states
   *  (RUN / STARTING… / OPEN CHAT). Null until the first status poll lands. */
  llamaStatus: { state: string; modelId?: string } | null
  /** GGUF ref currently going through the one-verb RUN pipeline
   *  (download → install → start). Null = no pipeline in flight. */
  runBusyRef: string | null

  /** Set of favorited catalog entry ids (persisted to localStorage). */
  favorites: string[]
  /** Ordered list of recently-run entry ids, newest first (max RECENTS_CAP, persisted). */
  recents: string[]

  init: () => Promise<void>
  refreshInstalled: () => Promise<void>
  setSourceTab: (t: SourceTab) => void
  setQuery: (q: string) => void
  toggleTag: (cap: Capability) => void
  clearTags: () => void
  runHfSearch: () => Promise<void>

  /** Switch the type chip and re-run the search from page one. */
  setCivitaiType: (t: CivitaiTypeFilterId) => void
  /** Switch the sort chip and re-run from page one (a cursor encodes the old order). */
  setCivitaiSort: (s: CivitaiSortId) => void
  /** Switch the period chip and re-run from page one. */
  setCivitaiPeriod: (p: CivitaiPeriodId) => void
  /** Add/remove one base-model chip and re-run from page one. */
  toggleCivitaiBase: (baseModel: string) => void
  /** Flip "for my models" and re-run from page one. */
  setCivitaiForMyModels: (on: boolean) => void
  /** Reset type/sort/period/base to the defaults and re-run (no-op when clean). */
  clearCivitaiFilters: () => void
  /** Re-read main's 18+ verdict (settings AND a live keychain check). */
  refreshCivitaiAdultState: () => Promise<void>
  /** Fetch the FIRST page for the current query+type (replaces the rows). */
  runCivitaiSearch: () => Promise<void>
  /** Append the next cursor page. No-op when there is no cursor or one is in flight. */
  loadMoreCivitai: () => Promise<void>
  /** Mark a Civitai row id as having an install in flight (null clears). */
  setCivitaiInstalling: (id: string | null) => void
  /** Open the detail panel for a row and fetch its description/versions. */
  openCivitaiDetail: (row: CivitaiSearchRow) => void
  /** Close the panel. Any reply still in flight is dropped by the id check. */
  closeCivitaiDetail: () => void
  /** Re-fetch after a failure, without closing the panel. */
  retryCivitaiDetail: () => Promise<void>

  setDownload: (d: DownloadState | null) => void
  setNotice: (n: { kind: 'ok' | 'error'; msg: string } | null) => void
  isInstalled: (runtime: RuntimeId, ref: string) => boolean

  /** Refresh the llama.cpp server snapshot (cheap local IPC — safe to poll). */
  refreshLlamaStatus: () => Promise<void>
  /** Mark a GGUF ref as busy in the one-verb RUN pipeline (null clears). */
  setRunBusy: (ref: string | null) => void

  /** Toggle the starred state for a catalog entry id. */
  toggleFavorite: (id: string) => void
  /** Record a model as recently used (called when a model is run or downloaded). */
  recordRecent: (id: string) => void
}

export const useCatalogStore = create<CatalogStore>((set, get) => ({
  hardware: null,
  curated: [],
  hfResults: [],
  installed: [],
  sdInstalledIds: [],
  piperInstalledIds: [],
  whisperInstalledIds: [],
  sourceTab: 'curated',
  query: '',
  activeTags: [],
  loading: false,
  hfError: null,
  download: null,
  notice: null,
  civitaiRows: [],
  civitaiCursor: null,
  civitaiError: null,
  civitaiFilteredCount: 0,
  civitaiLoading: false,
  civitaiLoadingMore: false,
  civitaiType: 'all',
  civitaiSort: CIVITAI_DEFAULT_SORT,
  civitaiPeriod: CIVITAI_DEFAULT_PERIOD,
  civitaiBaseModels: [],
  civitaiForMyModels: false,
  civitaiInstalledFamilies: [],
  civitaiAdultServed: undefined,
  civitaiAdultState: null,
  civitaiInstalling: null,
  civitaiLastQuery: '',
  civitaiDetail: null,
  civitaiDetailRow: null,
  llamaStatus: null,
  runBusyRef: null,
  favorites: lsGet<string[]>(LS_FAVORITES, []),
  recents: lsGet<string[]>(LS_RECENTS, []),

  init: async () => {
    set({ loading: true })
    // Every source paints INDEPENDENTLY as it lands. The curated registry is
    // ~1ms; catalog:hardware shells out to WMI/nvidia-smi and used to take ~2s
    // cold — a Promise.all here gated the whole grid on it, so the tab sat
    // BLANK for seconds on every mount. Fit badges simply hydrate when the
    // hardware profile arrives.
    const parts: { core?: CatalogEntry[]; sd?: CatalogEntry[]; piper?: CatalogEntry[]; whisper?: CatalogEntry[] } = {}
    const applyCurated = () => set({
      curated: [...(parts.core ?? []), ...(parts.sd ?? []), ...(parts.piper ?? []), ...(parts.whisper ?? [])],
    })
    const jobs: Promise<void>[] = [
      window.tachi.catalog.hardware()
        .then(hardware => set({ hardware }))
        .catch(() => { /* fit badges stay hidden */ }),
      window.tachi.catalog.installed()
        .then(r => set({ installed: r.models }))
        .catch(() => { /* installed list stays empty */ }),
      cachedFetch('curated:entries', () => window.tachi.catalog.curated(), { ttlMs: 300_000 })
        .then(r => {
          parts.core = r.entries
          applyCurated()
          // The main grid is usable as soon as the core registry is in.
          set({ loading: false })
        })
        .catch(() => { /* grid shows the explicit empty state */ }),
      // Local sd.cpp (image + video) models as tagged catalog rows.
      Promise.all([window.tachi.sdCpp.catalog(), window.tachi.sdCpp.status()])
        .then(([cat, st]) => {
          // ONE snapshot, two readings: the id set drives per-card RUN/INSTALL,
          // the family set drives the "for my models" filter. status() has
          // carried `family` since the media lane needed it, so neither costs a
          // second call.
          set({ sdInstalledIds: sdInstalledIdsFrom(st), civitaiInstalledFamilies: civitaiInstalledChipFamilies(st) })
          // …plus the rows we REFUSE to ship, which the IPC does not carry:
          // main keeps SD_BLOCKED_MODELS precisely so the refusal is stated,
          // and until 0fab056's Klein row appeared here it was stated to
          // nobody. They render as cards with the reason and no buttons.
          if (cat.ok) { parts.sd = [...cat.models.map(sdCatalogEntry), ...blockedLocalCatalogEntries()]; applyCurated() }
        })
        .catch(() => { /* sd.cpp IPC unavailable (older main build) — skip */ }),
      // Local piper voices (tts) as tagged catalog rows.
      Promise.all([window.tachi.piper.catalog(), window.tachi.piper.status()])
        .then(([pc, ps]) => {
          set({ piperInstalledIds: ps.voices.map(v => v.id) })
          if (pc.ok) { parts.piper = pc.voices.map(piperCatalogEntry); applyCurated() }
        })
        .catch(() => { /* piper IPC unavailable — skip */ }),
      // Local whisper.cpp STT models (stt) as tagged catalog rows.
      window.tachi.whisper.checkInstalled()
        .then(w => {
          set({ whisperInstalledIds: w.models.filter(m => m.ready).map(m => m.name) })
          parts.whisper = w.models.map(whisperCatalogEntry)
          applyCurated()
        })
        .catch(() => { /* whisper IPC unavailable — skip */ }),
    ]
    await Promise.allSettled(jobs)
    // Whatever happened, never leave the page in a permanent loading state.
    set({ loading: false })
  },

  refreshInstalled: async () => {
    const res = await window.tachi.catalog.installed()
    let sdInstalledIds = get().sdInstalledIds
    let civitaiInstalledFamilies = get().civitaiInstalledFamilies
    try {
      const st = await window.tachi.sdCpp.status()
      sdInstalledIds = sdInstalledIdsFrom(st)
      // Install a checkpoint and the filter that knows about it updates on the
      // same refresh the RUN buttons do — nothing to invalidate separately.
      civitaiInstalledFamilies = civitaiInstalledChipFamilies(st)
    } catch { /* keep prior */ }
    let piperInstalledIds = get().piperInstalledIds
    try { piperInstalledIds = (await window.tachi.piper.status()).voices.map(v => v.id) } catch { /* keep prior */ }
    let whisperInstalledIds = get().whisperInstalledIds
    try { whisperInstalledIds = (await window.tachi.whisper.checkInstalled()).models.filter(m => m.ready).map(m => m.name) } catch { /* keep prior */ }
    set({ installed: res.models, sdInstalledIds, civitaiInstalledFamilies, piperInstalledIds, whisperInstalledIds })
  },

  setSourceTab: (t) => set({ sourceTab: t }),
  setQuery: (q) => set({ query: q }),
  toggleTag: (cap) => set(s => ({
    activeTags: s.activeTags.includes(cap) ? s.activeTags.filter(c => c !== cap) : [...s.activeTags, cap],
  })),
  clearTags: () => set({ activeTags: [] }),

  runHfSearch: async () => {
    const q = get().query.trim()
    if (!q) return
    // Acquire a request id before the async call. If the user types faster than
    // the network responds, only the response matching the *latest* id is applied.
    const reqId = hfSearchCoordinator.next()
    set({ loading: true, hfError: null })
    try {
      const res = await cachedFetch(`hf:search:${q}`, () => window.tachi.catalog.searchHf(q), { ttlMs: 60_000 })
      // Discard stale responses — another runHfSearch call superseded this one.
      if (!hfSearchCoordinator.isCurrent(reqId)) return
      set({
        hfResults: res.entries,
        hfError: res.ok ? null : (res.error ?? i18n.t('catalog:searchUnavailable')),
        loading: false,
      })
    } catch {
      if (!hfSearchCoordinator.isCurrent(reqId)) return
      // Hard error on the synchronous path — clear the poisoned cache entry so the
      // next attempt re-tries the network instead of re-serving a failed result.
      invalidateCachePrefix('hf:search:')
      set({ loading: false, hfError: i18n.t('catalog:searchUnavailable') })
    }
  },

  // ── Civitai ───────────────────────────────────────────────────────────────
  //
  // The stale-response guard is the HF tab's, VERBATIM — same
  // next()/isCurrent() rule from search.ts, on its own counter (see
  // createRequestCoordinator). Every await is followed by an isCurrent() check
  // before ANY set(), including the failure paths: a rejected request that
  // wrote its error after a newer one already succeeded would blank a healthy
  // grid with a dead error.
  //
  // No cachedFetch here, unlike runHfSearch. That cache stores whatever the IPC
  // resolved with — including a failure — and these rows carry an install
  // verdict that a 60s-old copy can be wrong about. The debounce is what keeps
  // the request count down; a cache would trade honesty for a saving we do not
  // need.

  setCivitaiType: (t) => {
    if (get().civitaiType === t) return
    set({ civitaiType: t })
    void get().runCivitaiSearch()
  },

  // sort and period re-search from page ONE rather than re-paging: main drops
  // both on a cursor request (the cursor encodes the ordering it was minted
  // under, and changing either mid-walk re-anchors the window and duplicates
  // rows), so appending under a new sort would silently keep the old one.
  setCivitaiSort: (s) => {
    if (get().civitaiSort === s) return
    set({ civitaiSort: s })
    void get().runCivitaiSearch()
  },

  setCivitaiPeriod: (p) => {
    if (get().civitaiPeriod === p) return
    set({ civitaiPeriod: p })
    void get().runCivitaiSearch()
  },

  toggleCivitaiBase: (baseModel) => {
    // Touching a chip by hand turns the automatic constraint OFF: leaving both
    // on would show a grid neither control describes.
    set(s => ({
      civitaiBaseModels: toggleCivitaiBaseModel(s.civitaiBaseModels, baseModel),
      civitaiForMyModels: false,
    }))
    void get().runCivitaiSearch()
  },

  setCivitaiForMyModels: (on) => {
    const s = get()
    if (s.civitaiForMyModels === on) return
    // Refuse to switch ON with nothing installed: the constraint would be empty,
    // which sends no `baseModels` and behaves exactly like OFF — a lit switch
    // that did nothing.
    if (on && !civitaiForMyModelsUsable(s.civitaiInstalledFamilies)) return
    set({
      civitaiForMyModels: on,
      // The manual chips are cleared rather than remembered: restoring them on
      // toggle-off would resurrect a filter the user set minutes ago and has no
      // reason to expect back.
      civitaiBaseModels: [],
      // Adapters are the point of "for my models" — a checkpoint replaces what
      // you have, an adapter adds to it. Turning it OFF leaves the type where
      // it is; silently reverting a chip the user can see is worse than a
      // stale one.
      civitaiType: on ? CIVITAI_FOR_MY_MODELS_TYPE : s.civitaiType,
    })
    void get().runCivitaiSearch()
  },

  clearCivitaiFilters: () => {
    const s = get()
    const clean = s.civitaiType === 'all'
      && s.civitaiSort === CIVITAI_DEFAULT_SORT
      && s.civitaiPeriod === CIVITAI_DEFAULT_PERIOD
      && s.civitaiBaseModels.length === 0
      && !s.civitaiForMyModels
    if (clean) return
    set({
      civitaiType: 'all',
      civitaiSort: CIVITAI_DEFAULT_SORT,
      civitaiPeriod: CIVITAI_DEFAULT_PERIOD,
      civitaiBaseModels: [],
      civitaiForMyModels: false,
    })
    void get().runCivitaiSearch()
  },

  refreshCivitaiAdultState: async () => {
    try {
      const st = await window.tachi.civitai.adultState()
      set({ civitaiAdultState: st })
    } catch { /* older main build has no such channel — the line stays SFW */ }
  },

  runCivitaiSearch: async () => {
    const q = get().query.trim()
    const {
      civitaiType, civitaiSort, civitaiPeriod, civitaiBaseModels,
      civitaiForMyModels, civitaiInstalledFamilies,
    } = get()
    // THE CONSTRAINT. When "for my models" is on it REPLACES the manual chips
    // (both own `baseModels=`, and honouring both would produce a grid neither
    // one describes). The expansion is measured strings only, so an empty
    // result here means "nothing installed we can filter by" — and the toggle
    // refuses to switch on in that state, so it cannot silently widen.
    const baseModels = civitaiForMyModels
      ? civitaiBaseModelsForFamilies(civitaiInstalledFamilies)
      : civitaiBaseModels
    const reqId = civitaiSearchCoordinator.next()
    // The count describes the rows on screen; a fresh search has none yet.
    set({ civitaiLoading: true, civitaiError: null, civitaiFilteredCount: 0 })
    // Fire-and-forget, deliberately NOT awaited: it is a local settings +
    // keychain read that only feeds the mode line, and blocking the grid on it
    // would make every keystroke wait for DPAPI.
    void get().refreshCivitaiAdultState()
    try {
      const res = await window.tachi.civitai.search({
        query: q || undefined,
        cursor: null,
        types: civitaiTypesFor(civitaiType),
        baseModels: baseModels.length > 0 ? [...baseModels] : undefined,
        sort: civitaiSortValue(civitaiSort),
        period: civitaiPeriodValue(civitaiPeriod),
        limit: CIVITAI_PAGE_LIMIT,
      })
      if (!civitaiSearchCoordinator.isCurrent(reqId)) return
      set({
        civitaiRows: res.rows ?? [],
        civitaiCursor: res.nextCursor ?? null,
        civitaiError: res.error ?? null,
        civitaiFilteredCount: normalizeFilteredCount(res.filteredCount),
        // The RESOLVED mode, and only when main actually served a page. An
        // error result carries no `adult` — claiming one would invent a mode
        // for rows that do not exist.
        civitaiAdultServed: typeof res.adult === 'boolean' ? res.adult : undefined,
        civitaiLoading: false,
        civitaiLoadingMore: false,
        civitaiLastQuery: q,
      })
    } catch (err) {
      if (!civitaiSearchCoordinator.isCurrent(reqId)) return
      // Reaching here means the bridge itself failed (an older main build with
      // no civitai channel), not a search failure — that resolves with `error`.
      set({
        civitaiLoading: false,
        civitaiLoadingMore: false,
        civitaiError: err instanceof Error ? err.message : i18n.t('catalog:searchUnavailable'),
      })
    }
  },

  loadMoreCivitai: async () => {
    const {
      civitaiCursor, civitaiLoading, civitaiLoadingMore, civitaiType, civitaiBaseModels,
      civitaiForMyModels, civitaiInstalledFamilies,
    } = get()
    // No cursor = the server said this is the last page. Never synthesise one.
    if (!civitaiCursor || civitaiLoading || civitaiLoadingMore) return
    // THE SAME constraint as page one. A filter that forgets itself on "Load
    // more" appends rows the active chip excludes — the grid then contradicts
    // its own filter row halfway down.
    const baseModels = civitaiForMyModels
      ? civitaiBaseModelsForFamilies(civitaiInstalledFamilies)
      : civitaiBaseModels
    const q = get().query.trim()
    const reqId = civitaiSearchCoordinator.next()
    set({ civitaiLoadingMore: true })
    try {
      const res = await window.tachi.civitai.search({
        query: q || undefined,
        cursor: civitaiCursor,
        types: civitaiTypesFor(civitaiType),
        baseModels: baseModels.length > 0 ? [...baseModels] : undefined,
        // sort/period are NOT sent on a cursor page. Main drops them there by
        // design, so sending them would be a request that reads as if it did
        // something. `types`/`baseModels` ARE honoured on a cursor page.
        limit: CIVITAI_PAGE_LIMIT,
      })
      if (!civitaiSearchCoordinator.isCurrent(reqId)) return
      set(s => ({
        civitaiRows: mergeCivitaiRows(s.civitaiRows, res.rows ?? []),
        civitaiCursor: res.nextCursor ?? null,
        civitaiError: res.error ?? null,
        civitaiFilteredCount: s.civitaiFilteredCount + normalizeFilteredCount(res.filteredCount),
        civitaiAdultServed: typeof res.adult === 'boolean' ? res.adult : s.civitaiAdultServed,
        civitaiLoadingMore: false,
      }))
    } catch (err) {
      if (!civitaiSearchCoordinator.isCurrent(reqId)) return
      set({
        civitaiLoadingMore: false,
        civitaiError: err instanceof Error ? err.message : i18n.t('catalog:searchUnavailable'),
      })
    }
  },

  setCivitaiInstalling: (id) => set({ civitaiInstalling: id }),

  // ─── the detail panel ──────────────────────────────────────────────────────
  //
  // Opens SYNCHRONOUSLY on the row and fetches after. The panel is already fully
  // useful at that first frame — name, type, base model, size, trigger words,
  // licence, verdict, Install and the thumbnail all come from the row — so there
  // is nothing to wait for before showing it, and a slow network makes the
  // description arrive late rather than making the panel arrive late.

  openCivitaiDetail: (row) => {
    if (!row || typeof row.modelId !== 'number') return
    set({
      civitaiDetail: civitaiDetailOpening(row.modelId, row.versionId),
      civitaiDetailRow: row,
    })
    void get().retryCivitaiDetail()
  },

  closeCivitaiDetail: () => {
    if (!get().civitaiDetail) return
    // A reply still in flight is not cancelled — it is DROPPED, by the model-id
    // check in civitaiDetailResolved. There is nothing to abort in main (one GET
    // that is already on the wire), and a panel that reopens on the same card
    // gets the request's benefit through main's thumbnail cache anyway.
    set({ civitaiDetail: null, civitaiDetailRow: null })
  },

  retryCivitaiDetail: async () => {
    const open = get().civitaiDetail
    if (!open) return
    const { modelId, versionId } = open
    set({ civitaiDetail: { ...open, phase: 'loading', error: null } })
    try {
      const res = await window.tachi.civitai.detail({ modelId, versionId })
      set({ civitaiDetail: civitaiDetailResolved(get().civitaiDetail, modelId, res) })
    } catch (err) {
      // Reaching here means the BRIDGE failed (an older main build with no
      // `civitai:detail` channel) — the handler itself resolves with `error`.
      set({
        civitaiDetail: civitaiDetailResolved(get().civitaiDetail, modelId, {
          detail: null,
          error: err instanceof Error ? err.message : i18n.t('catalog:civitai.detail.loadFailed'),
        }),
      })
    }
  },

  setDownload: (d) => set({ download: d }),
  setNotice: (n) => set({ notice: n }),

  isInstalled: (runtime, ref) =>
    runtime === 'sdcpp' ? get().sdInstalledIds.includes(ref)
    : runtime === 'piper' ? get().piperInstalledIds.includes(ref)
    : runtime === 'whisper' ? get().whisperInstalledIds.includes(ref)
    : get().installed.some(m => m.runtime === runtime && m.ref === ref),

  refreshLlamaStatus: async () => {
    try {
      const st = await window.tachi.llamaCpp.status()
      set({ llamaStatus: { state: st.state, modelId: st.modelId } })
    } catch { /* IPC unavailable (older main build) — keep the prior snapshot */ }
  },

  setRunBusy: (ref) => set({ runBusyRef: ref }),

  toggleFavorite: (id) => {
    const current = get().favorites
    const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id]
    lsSet(LS_FAVORITES, next)
    set({ favorites: next })
  },

  recordRecent: (id) => {
    const next = pushRecent(get().recents, id)
    lsSet(LS_RECENTS, next)
    set({ recents: next })
  },
}))
