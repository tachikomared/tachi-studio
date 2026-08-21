// apps/desktop/electron/ipc/civitai.ipc.ts
//
//   civitai:search       { query?, cursor?, types?, baseModels?, sort?, period? }
//                          → { rows, nextCursor, filteredCount, adult, error? }
//   civitai:detail       { modelId, versionId? } → { detail, error? }
//   civitai:install      { row }  → { ok, error? }
//   civitai:adult-state  { }      → { unlocked, adultMode, acceptedAt, hasKey }
//   civitai:validate-key { key }  → { ok, username? }
//                                 | { ok: false, verdict: 'rejected' | 'unverified', status? }
//
// REGISTERED FROM model-catalog.ipc.ts, not from main.ts. electron-vite bundles
// electron/ into one entry chunk, so an import in main.ts is an import on the
// boot path (see test/unit/startupDeferredImports.test.ts). The Civitai surface
// is part of the model catalog, so it hangs off the catalog's registrar.
//
// ─── WHY INSTALL RE-FETCHES ──────────────────────────────────────────────────
// The `row` in the install payload came from the renderer. It is treated as a
// HINT — which model, which version — and nothing more. Every fact that decides
// whether bytes land on disk (the gate verdict, the download url, the SHA256,
// the declared size) is re-read from the API inside main and re-run through
// layer 0 + the install verdict. A renderer that sent
// `{ installable: true, downloadUrl: 'http://evil/…' }` gets a refusal, not a
// download.
//
// ─── WHY 18+ IS NOT A REQUEST PARAMETER ──────────────────────────────────────
// Neither handler accepts an adult flag from the renderer, and both zod schemas
// `.strip()` so one cannot be smuggled in. Main reads the two settings itself
// (loadSettings) and hands them to resolveCivitaiAdult, which ANDs them with a
// LIVE keychain read. A compromised — or merely buggy — renderer therefore
// cannot switch the host: the worst it can do is ask, and the answer is
// computed from facts it does not control.
//
// ─── AND WHY installedFamilies IS COMPUTED HERE ──────────────────────────────
// The adapter verdict ("needs an SDXL checkpoint") depends on what is ON DISK,
// which is the installer's knowledge, not the search service's. Computing it in
// the IPC keeps civitai-search.ts free of an sd-cpp-installer import (and of
// the import cycle that would come with it) while the verdict itself still runs
// in main, on main's own answer.

import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  searchCivitai,
  fetchCivitaiModelRows,
  fetchCivitaiModelDetail,
  probeCivitaiDownloadAuth,
  validateCivitaiKey,
  resolveCivitaiAdult,
  civitaiKeyStored,
  type CivitaiFamily,
  type CivitaiSearchRow,
  type InstalledFamilies,
} from '../services/civitai-search'
// The gate itself, imported for ONE reason: the install path learns a
// version-level fact (`minor`) after the row was mapped, and it must be judged
// by the same predicate the browse path used rather than by a local `if`.
import { layer0Excluded } from '../services/civitai-gate'
import { unverified } from '../services/provider-key-probe'
import {
  downloadSdModel,
  downloadSdAdapter,
  listInstalledSdModels,
} from '../services/sd-cpp-installer'
import { loadSettings } from '../services/settings-store'
// LANE C's module. Contract (fixed cross-lane):
//   userSdModelFromCivitaiRow(row) -> SdImageModel-shaped
//     { id, name, family, baseSize, files: [{ role:'model', url, sha256, sizeMb }], headers? }
//   addUserSdModel(spec) -> void      (persists so findSdModel/allSdModels see it)
//   listUserSdModels()   -> spec[]
// and the adapter half of the same module:
//   adapterKindForCivitaiType(type) -> 'lora'|'embedding'|'vae'|null  (allowlist)
//   userSdAdapterFromCivitaiRow(row, { headers }) -> SdAdapter-shaped (+slug)
//   addUserSdAdapter(spec) -> void    (strips headers before it writes to disk)
import {
  addUserSdModel,
  userSdModelFromCivitaiRow,
  addUserSdAdapter,
  userSdAdapterFromCivitaiRow,
  adapterKindForCivitaiType,
} from '../services/user-sd-models'

// `.strip()` — an `adultMode` / `adult` / `installedFamilies` key in the
// payload is DISCARDED here, not honoured. Those three are main's to decide.
const searchSchema = z.object({
  query:      z.string().max(200).optional(),
  cursor:     z.string().max(200).nullish(),
  // 24 ≥ the 22 live ModelType values, so every one of them can be sent at
  // once. Unknown strings are dropped by the service (one bad value 400s the
  // whole request), which is why this stays a plain string array: a zod enum
  // here would reject the WHOLE search over one stale filter chip.
  types:      z.array(z.string().max(40)).max(24).optional(),
  baseModels: z.array(z.string().max(40)).max(24).optional(),
  sort:       z.string().max(40).optional(),
  period:     z.string().max(20).optional(),
  limit:      z.number().int().min(1).max(100).optional(),
}).strip()

/**
 * The two 18+ settings, read from MAIN's own store. Never from the payload.
 * `loadSettings()` merges over DEFAULT_SETTINGS, so a settings file written
 * before these keys existed reads as `{ false, 0 }` — off.
 */
function adultSettings(): { adultMode: boolean; adultAcceptedAt: number } {
  try {
    const s = loadSettings()
    return {
      adultMode: s.civitaiAdultMode === true,
      adultAcceptedAt: typeof s.civitaiAdultAcceptedAt === 'number' ? s.civitaiAdultAcceptedAt : 0,
    }
  } catch {
    return { adultMode: false, adultAcceptedAt: 0 }   // unreadable ⇒ SFW
  }
}

/**
 * The engine families our verdict table knows about.
 *
 * `zimage` is here so an installed `z-image-turbo` row actually counts as a
 * base: without it the 235 live Z-Image LoRAs would say "needs a Z-Image
 * checkpoint" forever, including on a machine that has one. (The Z-Image
 * CHECKPOINT is still refused — that decision lives in civitaiInstallVerdict,
 * which reads this set only for the ADAPTER rule.)
 */
const VERDICT_FAMILIES = new Set<string>(['sd15', 'sdxl', 'flux', 'zimage'])

/**
 * Which base-checkpoint families are ON DISK right now.
 *
 * CHECKPOINTS ONLY, and kind 'image' only. An installed LoRA does not make its
 * own family "available" — the whole point of the rule is that an adapter needs
 * a checkpoint underneath it — and lane C keeps adapters in a separate registry
 * for exactly that reason, so this filter is belt as well as braces. A video
 * row is not a base for an image adapter either.
 *
 * Recomputed per request: install a checkpoint and the LoRA cards stop saying
 * "needs an SDXL checkpoint" on the next search, with nothing to invalidate.
 */
function installedFamilies(): InstalledFamilies {
  const out = new Set<CivitaiFamily>()
  try {
    for (const m of listInstalledSdModels()) {
      if (m.kind !== 'image') continue
      if (VERDICT_FAMILIES.has(m.family)) out.add(m.family as CivitaiFamily)
    }
  } catch {
    // A registry we cannot read means we cannot promise an adapter will run.
    // Empty = every adapter says what it needs. Fail closed, under-promise.
  }
  return out
}

/**
 * The detail lookup. Two ids and nothing else — `.strip()` means an `adultMode`,
 * a `description` or an `installable` in the payload is DISCARDED, not honoured.
 * Everything the panel reads is re-derived in main from the API's own answer.
 */
const detailSchema = z.object({
  modelId:   z.number().int().nonnegative(),
  versionId: z.number().int().nonnegative().optional(),
}).strip()

// Only the two identity fields are trusted, and even they are just a lookup key.
const installSchema = z.object({
  row: z.object({
    modelId:   z.number().int().nonnegative(),
    versionId: z.number().int().nonnegative(),
  }).passthrough(),
}).strip()

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * THE Layer-0 refusal on the install path. ONE string, two call sites, on
 * purpose: a layer-0 exclusion normally makes the row VANISH from
 * fetchCivitaiModelRows (the gate runs inside it), so the install sees `!fresh`
 * and says this. The version-level `minor` check below reaches the same verdict
 * one step later — after the pre-flight taught us a fact the browse payload does
 * not carry — and it must be indistinguishable from the first, both to the user
 * and to a test. A second, chattier message would be a second error path and
 * would also tell a flagged-content probe exactly which fence it hit.
 */
const LAYER0_INSTALL_REFUSAL = 'That model version is no longer available for install.'

export function registerCivitaiIpc(): void {
  // Resolves (never rejects) so the Catalog tab can render the failure inline.
  // `rows`/`nextCursor` are always present — the contract other lanes build
  // against — with `error` added on failure.
  ipcMain.handle('civitai:search', async (_event, payload: unknown) => {
    try {
      const q = searchSchema.parse(payload ?? {})
      return await searchCivitai({
        query: q.query,
        cursor: q.cursor ?? null,
        types: q.types,
        baseModels: q.baseModels,
        sort: q.sort,
        period: q.period,
        limit: q.limit,
        installedFamilies: installedFamilies(),
        ...adultSettings(),
      })
    } catch (e) {
      // `adult` is deliberately ABSENT here, not false: no page was served, so
      // claiming a mode for it would be inventing one.
      return { rows: [] as CivitaiSearchRow[], nextCursor: null, filteredCount: 0, error: msg(e) }
    }
  })

  /**
   * ONE MODEL, READ TO BE READ — the description, the creator and the sibling
   * versions the grid row cannot carry.
   *
   * Resolves (never rejects) with the same shape either way, so the panel can
   * render its failure inline next to the row facts it already has: a detail
   * fetch that fails must not blank a panel whose header, chips, verdict and
   * thumbnail all came from the row and are still true.
   *
   * `versionId` is a HINT ONLY — it decides which version leads the list and
   * which one's images the gallery shows. It grants nothing: every version still
   * runs through the same gate, and the install verdict is still main's.
   *
   * NO ADULT FLAG, same as search: `.strip()` discards one if it is sent, and
   * the mode is resolved here from the settings store AND a live keychain read.
   */
  ipcMain.handle('civitai:detail', async (_event, payload: unknown) => {
    try {
      const q = detailSchema.parse(payload ?? {})
      const detail = await fetchCivitaiModelDetail(q.modelId, {
        versionId: q.versionId,
        installedFamilies: installedFamilies(),
        ...adultSettings(),
      })
      return { detail, error: undefined as string | undefined }
    } catch (e) {
      return { detail: null, error: msg(e) }
    }
  })

  /**
   * The 18+ state, computed by MAIN's own predicate.
   *
   * The Settings card and the catalog tab both need to know whether the switch
   * is actually doing anything, and the honest answer involves a keychain read
   * the renderer cannot make. Handing back the three raw facts NEXT TO the
   * resolved verdict is what lets the UI say "on, but no key stored — browsing
   * is SFW" instead of showing a lit switch that means nothing.
   *
   * Read-only. Flipping the switch goes through `settings:save`, whose schema is
   * the write-side allowlist for both keys; there is deliberately no
   * `civitai:unlock-adult` channel to call by accident.
   */
  ipcMain.handle('civitai:adult-state', () => {
    const s = adultSettings()
    const hasKey = civitaiKeyStored()
    return {
      unlocked: resolveCivitaiAdult(s),
      adultMode: s.adultMode,
      acceptedAt: s.adultAcceptedAt,
      hasKey,
    }
  })

  /**
   * civitai:validate-key — the Settings card's "is this key live, and WHOSE?"
   * ping, symmetric with `hf:validate-token`.
   *
   * Takes the TYPED key so the card can refuse to store a rejected one, and
   * answers with the account USERNAME only — never the key back across the
   * bridge. Resolves (never rejects) so the card renders a failure instead of
   * catching one.
   *
   * `/api/v1/me` is the only endpoint that reacts to the caller at all: a bad
   * key gets a clean 200 from every public endpoint (measured — see
   * validateCivitaiKey). It has to run HERE rather than in the renderer because
   * Civitai restricts authenticated requests to Civitai-owned origins.
   */
  ipcMain.handle('civitai:validate-key', async (_event, payload: unknown) => {
    const { key } = (payload as { key?: unknown } | null | undefined) ?? {}
    // A malformed payload is NOT a statement about the credential, so it carries
    // the same 'unverified' verdict every other could-not-ask failure does —
    // otherwise the card would receive a failure with no verdict at all, and the
    // one place that acts on the distinction would have to guess.
    if (typeof key !== 'string') return unverified()
    return await validateCivitaiKey(key)
  })

  ipcMain.handle('civitai:install', async (event, payload: unknown) => {
    try {
      const { row } = installSchema.parse(payload)

      // 1. RE-READ from the API. fetchCivitaiModelRows runs the same gate as
      //    search — same host, same ceiling, same verdict inputs — so a model
      //    that layer 0 excludes yields no row at all, and one that was only
      //    visible under an unlock that has since lapsed (key deleted) is gone
      //    too.
      const authoritative = await fetchCivitaiModelRows(row.modelId, {
        ...adultSettings(),
        installedFamilies: installedFamilies(),
      })
      const fresh = authoritative.find(r => r.versionId === row.versionId)
      if (!fresh) {
        return { ok: false as const, error: LAYER0_INSTALL_REFUSAL }
      }
      // 2. RE-CHECK the verdict main-side. `fresh.installable` was computed here
      //    in main, from the API's own answer — never from the payload.
      if (!fresh.installable) {
        return { ok: false as const, error: fresh.reason ?? 'This model cannot be installed.' }
      }

      // 3. Auth: try unauthenticated first (most models need nothing).
      const probe = await probeCivitaiDownloadAuth(fresh.downloadUrl)

      // 3a. LAYER 0 AGAIN, ARMED WITH THE ONE FACT THE BROWSE PAYLOAD CANNOT
      //     CARRY. `probe.version` is the `/model-versions/mini/:id` record the
      //     auth pre-flight ALREADY fetched — so this costs ZERO extra requests
      //     — and it is the only source we have for the VERSION-level `minor`
      //     flag: the `modelVersions[]` embedded in a `/models` page does not
      //     carry the field at all (verified against the captured live fixture —
      //     its version keys are availability, baseModel, baseModelType,
      //     downloadUrl, files, id, images, index, name, nsfwLevel,
      //     trainedWords). The field IS documented on the mini endpoint
      //     (<https://developer.civitai.com/site/reference/model-versions.md>).
      //
      //     THE SAME PREDICATE, NOT A SECOND CHECK. layer0Excluded already ran
      //     over the MODEL half of this pair inside fetchCivitaiModelRows (a
      //     layer-0 exclusion there makes the row vanish, which is the `!fresh`
      //     refusal above), so the only thing left to hand it is the new version
      //     fact — which is why the model argument is empty rather than
      //     re-derived. It can only ever BLOCK: no branch of layer 0 reads
      //     `minor` to ADMIT anything, so this cannot unblock a row the
      //     model-level pass refused.
      //
      //     FAIL CLOSED ON PRESENCE, NOT ON ABSENCE. An explicit `true` refuses.
      //     `null` (the response omitted the field), `undefined` (the pre-flight
      //     did not answer, e.g. the blind-probe fallback) and any non-boolean
      //     behave EXACTLY as they did before this line existed — a missing
      //     signal must not be inflated into a refusal. `sfwOnly` from the same
      //     record is deliberately not read at all: it restricts how a resource
      //     may be USED, it does not say the resource is adult, so `true` would
      //     block SFW content and `false` would be evidence of nothing.
      if (layer0Excluded({}, { minor: probe.version?.minor })) {
        return { ok: false as const, error: LAYER0_INSTALL_REFUSAL }
      }

      if (probe.kind === 'needs-key') {
        return {
          ok: false as const,
          error: 'This model requires a Civitai account. Add your Civitai API key in Settings → Keys, then try again.',
        }
      }
      if (probe.kind === 'key-rejected') {
        return {
          ok: false as const,
          error: 'Civitai rejected the stored API key for this download (401). Replace it in Settings → Keys.',
        }
      }

      // 4. Register with the user-model registry so the downloaded file is
      //    visible to findSdModel / status / MediaPage, THEN drive the existing
      //    managed-download path by id (resumable, SHA-verified, Stop-able).
      //
      //    The credential is passed TWICE and that is not redundancy:
      //    userSdModelFromCivitaiRow(row, { headers }) records the durable fact
      //    `requiresKey: true`, while addUserSdModel STRIPS the header before
      //    writing to disk — a bearer token must never land in
      //    user-sd-models.json. So the live header has to be handed separately
      //    to downloadSdModel for this transfer, and re-attached from the
      //    keychain on any future resume.
      //
      //    AN ADAPTER IS NOT A CHECKPOINT and must not be registered as one.
      //    Now that the verdict says yes to a LoRA / embedding / VAE with a
      //    compatible base on disk, the install has to take lane C's SECOND
      //    registry: an adapter has a slug, a kind and a shared per-kind
      //    directory instead of a baseSize/steps/sampler and a model dir.
      //    Registering one as a checkpoint would put it in the model dropdown
      //    and hand `-m a-lora.safetensors` to the engine — a working button
      //    that produces garbage, which is the exact failure this whole file
      //    is built to refuse. The branch is on `adapterKindForCivitaiType`,
      //    the same allowlist the verdict used, so the two cannot drift.
      const authOpts = probe.kind === 'authed' ? { headers: probe.headers } : {}
      const win = BrowserWindow.fromWebContents(event.sender)

      if (adapterKindForCivitaiType(fresh.type)) {
        const adapter = userSdAdapterFromCivitaiRow(fresh, authOpts)
        addUserSdAdapter(adapter)
        await downloadSdAdapter(win, adapter.id, authOpts)
        return { ok: true as const }
      }

      const spec = userSdModelFromCivitaiRow(fresh, authOpts)
      addUserSdModel(spec)
      await downloadSdModel(win, spec.id, authOpts)
      return { ok: true as const }
    } catch (e) {
      return { ok: false as const, error: msg(e) }
    }
  })
}
