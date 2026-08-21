// apps/desktop/src/store/media.store.ts
//
// Persistent state for the Surplus MEDIA studio (apps/desktop/src/pages/media).
// Follows the nodes.store.ts pattern: zustand + persist middleware over plain
// localStorage (name 'tachi-media-v1') — media metadata is NOT sensitive.
//
// What persists:
//   • gallery  — produced results (capped at GALLERY_CAP), newest first, with a
//                `favorite` pin that sorts to the top. Binary artifacts persist
//                as their on-disk `path` ONLY — inline base64 (`b64`) is stripped
//                before persisting (it would bloat localStorage). After a restart
//                the renderer loads previews via file://<path>; b64 is kept only
//                for the current session's instant preview.
//   • form     — last-used composer values so the studio restores on mount:
//                modality, the chosen model PER modality, the collected params PER
//                modality (keyed by ParamSpec.name), and autoSaveDir. The prompt
//                lives INSIDE paramsByModality under its schema key ('prompt' for
//                image/video/music, 'input' for tts) — there is no separate prompt
//                field, so each modality keeps its own prompt across switches.
//
// The store is the single source of truth the MediaPage binds to.
//
// IN-FLIGHT RUN STATE LIVES HERE TOO (the `run` slice), and is NOT persisted.
// It used to be MediaPage's own useState: the owner started a local Wan render,
// switched to another tab, came back — and the composer showed an idle GENERATE
// button while sd-cli held the GPU at 95%. React had unmounted the component and
// thrown its state away; the render itself never noticed. The slice below
// outlives the component, so a remount re-reads the live run (busy label,
// progress line, Stop button, and the failure of the last one) instead of
// inventing an idle one. Nothing polls: the same 'sd-cpp:gen-progress'
// subscription writes here (see mediaProgressBridge.ts) and it now outlives the
// page as well.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { Artifact, SurplusMediaModality } from '../types/electron'
import type { MediaProvider } from '../pages/media/mediaHelpers'

/** Cap the persisted gallery so localStorage doesn't grow unbounded.
 *  Exported so a test can fill it exactly rather than guess. */
export const GALLERY_CAP = 60

/**
 * Trim a newest-first gallery to the cap, KEEPING THE ENTRY THAT WAS JUST ADDED.
 *
 * Favorites are protected from eviction — that is the whole reason this is not
 * a `slice(0, CAP)` — but they were protected too well: `keepOthers` was
 * `others.slice(0, CAP - favorites.length)`, and with CAP favorites that is
 * `slice(0, 0)`. The entry being added lives in `others`, so a gallery pinned to
 * the brim silently swallowed a finished render. A pin means "do not evict
 * this", never "do not record anything else".
 *
 * `next[0]` is the new entry by construction — both add() callers prepend. The
 * THIRD caller is `partialize`, where the head is the NEWEST entry rather than an
 * incoming one; protecting it there means the same thing (the most recent result
 * is never the one the cap throws away) and, more importantly, means the trim
 * that decides what survives a RESTART is the same function that decides what
 * survives the click.
 */
export function trimGallery(next: MediaGalleryEntry[]): MediaGalleryEntry[] {
  if (next.length <= GALLERY_CAP) return next
  const incoming = next[0]
  const rest     = next.slice(1)
  // The incoming entry is taken off the top of the budget; what is left goes to
  // favorites first, then to the newest ordinary entries.
  const budget    = Math.max(0, GALLERY_CAP - 1)
  const favorites = rest.filter(e => !!e.favorite).slice(0, budget)
  const others    = rest.filter(e => !e.favorite).slice(0, Math.max(0, budget - favorites.length))
  return [incoming, ...favorites, ...others].sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * NO `data:` URL EVER REACHES localStorage.
 *
 * The composer's INIT FRAME control (ParamFields' `image` kind) stores the
 * picked file as a `data:` URL under the schema's own param name. That value
 * lands in TWO persisted places at once: `paramsByModality` (one per modality,
 * kept forever) and every gallery `entry.params` that recorded a run using it.
 * A 3 MB reference photo is ~4 MB of base64, so a handful of img2img runs is the
 * whole ~5 MB localStorage budget — and the failure is not "the picture is
 * lost", it is QuotaExceeded on the write, which loses the ENTIRE store: the
 * gallery, the form, the provider.
 *
 * Artifact `b64` has been stripped on the way out since day one for exactly this
 * reason and params never were. Same rule, one line lower: a persisted param
 * keeps a PATH (which is a route back to a file) and drops the BYTES.
 *
 * Strings only — the recorded `localSelections` object must survive untouched.
 */
export function stripUnpersistableParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return params
  let hit = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' && v.startsWith('data:')) { hit = true; continue }
    out[k] = v
  }
  return hit ? out : params
}

export interface MediaGalleryEntry {
  id:        string
  model:     string
  modality:  SurplusMediaModality
  /** The prompt actually used (resolved). For STT this is the audio file name. */
  prompt:    string
  artifacts: Artifact[]
  /** STT transcript (modality === 'stt'). */
  text?:     string
  /** Pinned favorites sort to the top of the gallery. */
  favorite?: boolean
  /** Epoch ms — newest first within the favorite/non-favorite groups. */
  createdAt: number
  /**
   * The full collected param values for this run, so "Remix" can restore the
   * composer exactly (model + params + prompt). Keyed by ParamSpec.name.
   */
  params?:   Record<string, unknown>
  /**
   * Where this entry came from. 'studio' = the Media composer (default);
   * 'node' = a media node run on the Studio canvas; 'import' = downloaded from a
   * URL via yt-dlp; 'derived' = produced FROM another entry's artifact by a
   * local post-process (frame interpolation) rather than generated — see
   * mediaHelpers' interpolatedGalleryEntry, which is why such a row carries no
   * `params` and no `provider`. The Artifacts library shows everything
   * regardless of source. Optional so older saves still parse.
   */
  source?:   'studio' | 'node' | 'import' | 'derived'
  /**
   * Media provider the entry was generated with ('surplus' | 'venice' |
   * 'local' | 'imgnai' | 'pollinations') — lets Remix restore the WHOLE
   * route, not just the model (a Venice model id under a SURPLUS chip
   * silently mis-billed). 'pollinations' is a CLOUD provenance despite being
   * keyless and free — the prompt left the machine. Optional so older saves
   * still parse.
   */
  provider?: string
  /**
   * PRIVATE MODE was already engaged by the time this entry's cloud fetch
   * settled — the fetch itself was already in flight when the mode flipped
   * (the prompt had already left the machine, so refusing would restore no
   * privacy), so the artifact was written rather than discarded. Set only by
   * pollinations-media.ts's `completedAfterPrivate` result. Without this the
   * entry would be indistinguishable from the queued-request bug fixed in
   * `4266c62` (which refuses and writes nothing) — see the tile badge that
   * reads this flag. Optional so every older/other-provider entry parses as
   * "no note".
   */
  completedAfterPrivate?: boolean
}

/**
 * The generation that is running RIGHT NOW (or the last one's failure).
 * Deliberately NOT persisted: a render dies with the app, so a restart that
 * restored `busy: true` would show a Stop button for a process that no longer
 * exists.
 */
export interface MediaRunState {
  busy:     boolean
  /** The line the Generate button shows while working ("12/20", "48%", "…"). */
  progress: string | null
  /** The last run's failure, shown inline until dismissed (survives a remount). */
  error:    string | null
  /** Stop was clicked; the kill is issued and we are waiting for the child. */
  stopping: boolean
  /**
   * Stop was clicked AT ANY POINT IN THIS RUN — and unlike `stopping`, this
   * survives the run settling.
   *
   * The two are not redundant. `stopping` describes an in-flight state and MUST
   * clear when the run ends, or the Stop button stays latched forever. But the
   * settled state still needs to know WHY it settled: the inline failure row
   * renders after `failRun`, so reading `stopping` there always answered false
   * and the row painted a user's own Stop as GENERATION FAILED in danger red —
   * the same lie 6227a0e fixed on the toast and explicitly left here.
   *
   * Only `beginRun` clears it (via the reset to IDLE_RUN), so it is scoped to
   * exactly one run and cannot tint the next one.
   */
  stoppedByUser: boolean
  /** Only a LOCAL sd.cpp render has a child we can kill — cloud jobs do not. */
  cancellable: boolean
  /**
   * THE NEWEST LOOK AT THE LATENTS, as a `data:` URI, or null.
   *
   * A local render used to show a bar and nothing else, for as long as eleven
   * minutes. The engine can decode its own latents mid-run; this is what it
   * decoded most recently.
   *
   * STICKY WITHIN A RUN and cleared by `beginRun`. Frames arrive every few
   * steps, not every tick, so a slot that emptied between them would flicker —
   * and the last frame of a finished run is a truthful thing to keep on screen
   * until the finished image replaces it.
   */
  preview: string | null
}

const IDLE_RUN: MediaRunState = {
  busy: false, progress: null, error: null, stopping: false, stoppedByUser: false, cancellable: false,
  preview: null,
}

interface MediaStore {
  // ── In-flight run (NOT persisted) ──────────────────────────────────────────
  run: MediaRunState
  /** A generation started. Clears the previous failure, as the old code did. */
  beginRun(opts?: { cancellable?: boolean }): void
  /** Live progress line (engine events, poll ticks, stage labels). */
  setRunProgress(line: string | null): void
  /** Newest decoded latent frame for this run (see MediaRunState.preview). */
  setRunPreview(dataUri: string | null): void
  /** Stop was clicked — the button latches so it cannot be clicked twice. */
  markRunStopping(): void
  /** The run failed (or was stopped): keep the message, drop the busy state. */
  failRun(message: string): void
  /** The run settled successfully — back to idle, error untouched. */
  endRun(): void
  /** Dismiss the inline failure row. */
  clearRunError(): void

  // ── Persisted gallery ──────────────────────────────────────────────────────
  gallery: MediaGalleryEntry[]
  addEntry(entry: MediaGalleryEntry): void
  /**
   * Append artifacts produced by a media NODE run on the Studio canvas, so the
   * Artifacts library is truly "everything generated". Deduped by the set of
   * on-disk artifact paths: re-running a node (which yields the SAME files) is a
   * no-op, while a fresh generation (new files) is added. No-op when there are no
   * artifacts. Returns nothing — the gallery is the source of truth.
   */
  addNodeRunArtifacts(entry: Omit<MediaGalleryEntry, 'createdAt' | 'source'>): void
  toggleFavorite(id: string): void
  removeEntry(id: string): void
  clearGallery(): void

  // ── Persisted composer form (last-used) ─────────────────────────────────────
  /**
   * The media PROVIDER route ('surplus' | 'venice' | 'local' | 'imgnai' |
   * 'pollinations').
   *
   * This was MediaPage's own `useState('surplus')` — the last field of the
   * composer that was not here. A tab switch unmounts the page, React throws
   * that state away, and the initializer re-runs on remount: the driver came
   * back to Media with LOCAL selected and found the chip on SURPLUS and Venice's
   * cloud catalog underneath, while the prompt, the size and the modality had
   * all persisted. Nothing raced and nothing overrode a stored value — there was
   * no stored value. The next Generate was a real, unintended cloud request.
   */
  provider: MediaProvider
  setProvider(p: MediaProvider): void
  // ── THE LOCAL COMPOSER'S THREE SELECTIONS — style, LoRAs, VAE swap ─────────
  //
  // They were `useState` in MediaPage, which is the same defect the provider had
  // before f19ffdd, twice over: a tab switch reset them while everything around
  // them persisted, AND Remix could not restore them because nothing recorded
  // them. They are part of the composer form, so they live here with the rest of
  // it and are snapshot onto the entry at generate time (stampLocalSelections).
  //
  // Not per-modality: one picker set serves image and video, and the
  // checkpoint-switch prune in MediaPage is what drops a selection the new row
  // cannot run.
  /** SD_STYLES id; 'none' is the pass-through. */
  styleId: string
  setStyleId(id: string): void
  /** adapter id → weight, for the LoRAs switched ON. */
  loraWeights: Record<string, number>
  setLoraWeights(next: Record<string, number>): void
  /** VAE adapter id to swap in, '' = the checkpoint's own. */
  vaeAdapterId: string
  setVaeAdapterId(id: string): void
  modality: SurplusMediaModality
  /** Last-selected model id per modality (so switching modalities is stable). */
  modelByModality: Partial<Record<SurplusMediaModality, string>>
  /** Collected param values per modality (keyed by ParamSpec.name; includes the prompt). */
  paramsByModality: Partial<Record<SurplusMediaModality, Record<string, unknown>>>
  autoSaveDir: string | null

  setModality(m: SurplusMediaModality): void
  setModel(modality: SurplusMediaModality, modelId: string): void
  /** Replace the entire param map for a modality (used by Remix / schema reset). */
  setParams(modality: SurplusMediaModality, params: Record<string, unknown>): void
  /** Patch a single param value for a modality. */
  setParam(modality: SurplusMediaModality, name: string, value: unknown): void
  setAutoSaveDir(dir: string | null): void
}

export const useMediaStore = create<MediaStore>()(
  persist(
    (set) => ({
      // ── In-flight run ─────────────────────────────────────────────────────
      run: IDLE_RUN,

      beginRun(opts) {
        set({ run: { ...IDLE_RUN, busy: true, cancellable: opts?.cancellable === true } })
      },

      setRunProgress(line) {
        // A progress tick for a run that already settled is stale noise — the
        // engine's heartbeat can land after the promise resolved.
        set(s => (s.run.busy ? { run: { ...s.run, progress: line } } : s))
      },

      setRunPreview(dataUri) {
        // Same staleness rule as the line above, and for the same reason: a
        // frame decoded just before the run settled must not repaint over the
        // finished image.
        set(s => (s.run.busy ? { run: { ...s.run, preview: dataUri } } : s))
      },

      markRunStopping() {
        // Both flags latch here, and only one of them is ever cleared by the
        // run settling — see MediaRunState.stoppedByUser.
        set(s => (s.run.busy ? { run: { ...s.run, stopping: true, stoppedByUser: true } } : s))
      },

      failRun(message) {
        set(s => ({ run: { ...s.run, busy: false, stopping: false, progress: null, error: message } }))
      },

      endRun() {
        set(s => ({ run: { ...s.run, busy: false, stopping: false, progress: null } }))
      },

      clearRunError() {
        set(s => ({ run: { ...s.run, error: null } }))
      },

      // ── Gallery ───────────────────────────────────────────────────────────
      gallery: [],

      addEntry(entry) {
        // Keep favorites even when over the cap, but never at the cost of the
        // result that just finished — see trimGallery.
        set(s => ({ gallery: trimGallery([entry, ...s.gallery]) }))
      },

      addNodeRunArtifacts(entry) {
        const artifacts = entry.artifacts ?? []
        if (artifacts.length === 0) return
        // Dedup key: the sorted set of on-disk artifact paths. Re-running a node
        // re-emits the SAME files, so an entry with the identical path-set already
        // exists → no-op. (Falls back to no dedup for path-less inline artifacts.)
        const paths = artifacts.map(a => a.path).filter((p): p is string => !!p).sort()
        const key = paths.join('|')
        set(s => {
          if (key && s.gallery.some(e =>
            e.source === 'node' &&
            e.artifacts.map(a => a.path).filter((p): p is string => !!p).sort().join('|') === key
          )) {
            return s // already captured this exact set of files
          }
          return { gallery: trimGallery([{ ...entry, source: 'node' as const, createdAt: Date.now() }, ...s.gallery]) }
        })
      },

      toggleFavorite(id) {
        set(s => ({
          gallery: s.gallery.map(e => e.id === id ? { ...e, favorite: !e.favorite } : e),
        }))
      },

      removeEntry(id) {
        set(s => ({ gallery: s.gallery.filter(e => e.id !== id) }))
      },

      clearGallery() {
        set({ gallery: [] })
      },

      // ── Composer form ───────────────────────────────────────────────────────
      provider: 'surplus',
      styleId: 'none',
      loraWeights: {},
      vaeAdapterId: '',
      modality: 'image',
      modelByModality: {},
      paramsByModality: {},
      autoSaveDir: null,

      setProvider(p) { set({ provider: p }) },

      setStyleId(id) { set({ styleId: id }) },

      setLoraWeights(next) { set({ loraWeights: next }) },

      setVaeAdapterId(id) { set({ vaeAdapterId: id }) },

      setModality(m) { set({ modality: m }) },

      setModel(modality, modelId) {
        set(s => ({ modelByModality: { ...s.modelByModality, [modality]: modelId } }))
      },

      setParams(modality, params) {
        set(s => ({ paramsByModality: { ...s.paramsByModality, [modality]: params } }))
      },

      setParam(modality, name, value) {
        set(s => ({
          paramsByModality: {
            ...s.paramsByModality,
            [modality]: { ...(s.paramsByModality[modality] ?? {}), [name]: value },
          },
        }))
      },

      setAutoSaveDir(dir) { set({ autoSaveDir: dir }) },
    }),
    {
      name: 'tachi-media-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        // THE SAME TRIM addEntry USES, not a second rule (the cap had two edges).
        // The plain head-slice this replaces was favorites-BLIND: what survived the CLICK
        // was decided by trimGallery (pins are exempt, the newcomer is budgeted
        // first) and what survived the RESTART was decided by raw position, so a
        // gallery whose pins had aged down the list persisted without them. One
        // function, both edges — and it protects the head entry here too, which
        // is the newest one.
        //
        // Persist file paths, not inline base64 — strip b64 to keep localStorage
        // lean — and now the same rule for `data:` URLs inside params, which
        // were the far bigger half (see stripUnpersistableParams).
        gallery: trimGallery(s.gallery).map(e => ({
          ...e,
          artifacts: e.artifacts.map(({ b64: _b64, ...rest }) => rest),
          ...(e.params ? { params: stripUnpersistableParams(e.params) } : {}),
        })),
        provider:         s.provider,
        styleId:          s.styleId,
        loraWeights:      s.loraWeights,
        vaeAdapterId:     s.vaeAdapterId,
        modality:         s.modality,
        modelByModality:  s.modelByModality,
        // The COMPOSER copy of the init frame is the long-lived one — one per
        // modality, kept until it is replaced — so it is stripped on the way out
        // exactly like the gallery's.
        paramsByModality: Object.fromEntries(
          Object.entries(s.paramsByModality).map(([m, p]) => [m, stripUnpersistableParams(p)]),
        ) as MediaStore['paramsByModality'],
        autoSaveDir:      s.autoSaveDir,
      }),
    },
  ),
)
