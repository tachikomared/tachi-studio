// apps/desktop/electron/ipc/sd-cpp.ipc.ts
//
// IPC surface for the stable-diffusion.cpp sidecar (LOCAL image gen).
//   sd-cpp:catalog        — curated image models + release assets
//   sd-cpp:status         — { installed, models: [{id}] }
//   sd-cpp:install        — download + extract the sd-cli binary (progress events)
//   sd-cpp:update-engine  — swap an EXISTING sd-cli onto the pinned release
//   sd-cpp:download-model — download a model's component files (progress events)
//   sd-cpp:remove-model   — delete a downloaded model
//   sd-cpp:generate       — run one text→image / img2img generation
//   sd-cpp:cancel-generation — kill the RUNNING sd-cli (image or video)
// Push: sd-cpp:install-progress  (install + model-download progress)

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { rmSync } from 'fs'
import {
  SD_CPP_RELEASES, SD_IMAGE_MODELS, SD_VIDEO_MODELS, sdCatalogFiles,
  SD_BLOCKED_SPEED_ADAPTERS, speedAdapterCatalogFiles, findSpeedAdapter,
  upscalerCatalogFiles, findUpscaler, SD_IP_ADAPTER_BLOCKED,
  type SdCatalogFile,
} from '../services/sd-cpp-models'
import {
  installSdCppBinary, downloadSdModel, removeSdModel, cancelSdModelDownload,
  downloadSdAdapter, removeSdAdapterFile, downloadSdSpeedAdapter, listSpeedAdapters,
  sdModelOnDiskMb, downloadSdUpscaler, listUpscalers, updateSdCppToPinned,
  downloadSdIpAdapter, listIpAdapters,
} from '../services/sd-cpp-installer'
import { removeUserSdAdapter, removeUserSdModel } from '../services/user-sd-models'
import { sdStatus, generateImage, generateVideo, cancelGeneration, upscaleImage, type SdGenerateInput, type SdVideoInput } from '../services/sd-cpp-client'
import { materializeInitImageOwned } from '../services/util/init-image'
import { registerRifeIpc } from './rife.ipc'

// ── The composer's INIT FRAME crosses here ───────────────────────────────────
//
// The renderer has a browser File, so ParamFields stores a `data:` URL — and
// sd-cli takes `-i <path>`. This boundary is where the one becomes the other:
// the renderer sends `initImage` (data: URL or an on-disk path), main writes it
// out and hands the service the `initImagePath` it already understood. Without
// it the INIT FRAME (IMAGE→VIDEO) control was decorative — the driver's capture
// of a live spawn had no `-i` at all and the render was a pure T2V.
//
// Untrusted-input note: `initImage` is data from the renderer, so the only
// things that become a path are a decoded data: URL (written into the OS temp
// dir) or a file that already exists — never an arbitrary string.
//
// …AND WHOEVER WRITES IT, DELETES IT. This route materialised and then walked
// away: one `sd-init-*` per Generate click stayed in %TEMP% forever, which is
// the same leak (882 files on the driver's machine) the CANVAS route was fixed
// for and this one was not. So the preparation hands back the temp it created
// alongside the payload, and both handlers drop it in a `finally`. What it must
// never drop is a frame it did not create: the same control also accepts a PATH
// (a Remix of an entry that recorded one), and that file is the user's own
// picture in the user's own folder.
//
// TWO PICTURES CAN ARRIVE NOW, not one: the init frame (`-i`, img2img) and the
// REFERENCE IMAGE (`--ip-adapter-image`, style/subject). They are independent —
// a run may carry either, both or neither — and each is a data: URL from the
// same control kind, so each needs the same conversion and the same cleanup.
type WithInitImage<T> = T & { initImage?: string; ipAdapterImage?: string }

/** The payload the service gets, plus the temps THIS call wrote (if any). */
interface PreparedInit<T> { input: T; ownTempInit?: string; ownTempRef?: string }

function withInitImagePath<T extends { initImagePath?: string; ipAdapterImagePath?: string }>(
  input: WithInitImage<T>,
): PreparedInit<T> {
  const { initImage, ipAdapterImage, ...rest } = input
  const out = { ...(rest as T) }
  const prepared: PreparedInit<T> = { input: out }
  const init = materializeInitImageOwned(initImage)
  // An explicit path from a caller that already has one still wins — the canvas
  // node path materialises on its own side and calls the service directly.
  if (init.path) {
    out.initImagePath = init.path
    prepared.ownTempInit = init.ownTemp
  }
  // THE SAME MATERIALISER, AND DELIBERATELY THE SAME `sd-init-` FILE NAME. To the
  // %TEMP% sweep these are one shape — a picture this app decoded for one run —
  // and reusing the name means the reference image is collected by a pattern
  // already pinned against every extension extForMime can emit. A fourth prefix
  // would need its own regex and its own mime-coverage test, which is exactly how
  // the .jpg/.webp/.bmp init temps escaped the sweep forever the first time.
  const ref = materializeInitImageOwned(ipAdapterImage)
  if (ref.path) {
    out.ipAdapterImagePath = ref.path
    prepared.ownTempRef = ref.ownTemp
  }
  return prepared
}

/** Drop the temps THIS process wrote — and only those. Best effort: sd-cli is
 *  long gone by now, but a virus scanner holding a file open is not a reason to
 *  turn a finished render into an error. */
function dropOwnTempInit(...paths: Array<string | undefined>): void {
  for (const path of paths) {
    if (!path) continue
    try { rmSync(path, { force: true }) } catch { /* the boot sweep will get it */ }
  }
}

export function registerSdCppIpc(win: BrowserWindow): void {
  ipcMain.handle('sd-cpp:catalog', () => {
    const sz = (files: { sizeMb: number }[]) => files.reduce((a, f) => a + f.sizeMb, 0)
    // WHAT THIS ROW ALREADY HAS. One statSync per component, read once per row.
    //
    // Driver finding (rows5): a download that died mid-file was indistinguishable
    // from one never started — the panel re-rendered the virgin label over 5-6.5
    // GB of resumable partials, and quoted the full price for the rest. The
    // progress EVENT that knew was long gone (a multi-GB download outlives the
    // tab that subscribed to it). The bytes are the durable fact, so they travel
    // with the row that is about to be priced.
    const withDisk = (id: string) => {
      const disk = sdModelOnDiskMb(id)
      return (f: SdCatalogFile) => ({ ...f, onDiskMb: disk[f.role] ?? 0 })
    }
    return {
      ok: true as const,
      models: [
        // `files` goes through sdCatalogFiles so each one carries the OTHER rows
        // that declare the same bytes: without that the panel cannot tell a
        // shared component from a fresh one, and the I2V button quoted its full
        // 17.6 GB while the tooltip promised ~11.7 GB. See SdCatalogFile.
        // `licenseName` / `licenseUrl` ride along because a licence the user is
        // accepting cannot live only in main. The blocked LTX-2.3 row named the
        // gap in as many words — "the model registry has no way to surface a
        // licence today" — and these two fields are it: the download panel
        // prints the name and opens the text, BEFORE the button is pressed.
        // Undefined on a row whose source licence has not been read; the panel
        // then renders nothing rather than a guess.
        // `minVramGb` / `minRamGb` ride along for the same reason the licence
        // fields do: the number exists in the row and the surface that has to
        // print it is in the renderer. The catalog card's alternative was
        // `estimateFit(sizeBytes x 1.2)`, which told a 12 GB owner that Flux was
        // too big for a card that runs it — file size is not peak memory for a
        // staged pipeline. UNDEFINED on every row whose notes state no figure, and
        // undefined has to stay undefined: the card then renders the prose, which
        // is honest, instead of a plausible-looking number nobody measured.
        ...SD_IMAGE_MODELS.map(m => ({ id: m.id, name: m.name, kind: 'image' as const, family: m.family, sizeMbTotal: sz(m.files), notes: m.notes ?? '', licenseName: m.licenseName, licenseUrl: m.licenseUrl, minVramGb: m.minVramGb, minRamGb: m.minRamGb, files: sdCatalogFiles(m).map(withDisk(m.id)) })),
        ...SD_VIDEO_MODELS.map(m => ({ id: m.id, name: m.name, kind: 'video' as const, family: m.family, sizeMbTotal: sz(m.files), notes: m.notes ?? '', licenseName: m.licenseName, licenseUrl: m.licenseUrl, minVramGb: m.minVramGb, minRamGb: m.minRamGb, files: sdCatalogFiles(m).map(withDisk(m.id)) })),
      ],
      // ── THE SPEED PACKS, and the rows that honestly have none ──────────────
      //
      // `installed` rides along (unlike the model list, which the renderer
      // crosses with sd-cpp:status) because a pack is not in the status model
      // list at all — it is neither a checkpoint nor a user adapter. One field
      // beats a third round trip.
      //
      // The BLOCKED list ships too: a user who picks the 1.3B and sees no speed
      // toggle deserves the reason ("the weights exist and their licence does
      // not let us fetch them") rather than an absence they read as a bug.
      speedAdapters: listSpeedAdapters().map(a => ({
        ...a,
        files: speedAdapterCatalogFiles(findSpeedAdapter(a.id)!),
      })),
      blockedSpeedAdapters: SD_BLOCKED_SPEED_ADAPTERS.map(b => ({ modelId: b.modelId, blocked: b.blocked })),
      // ── THE UPSCALERS ──────────────────────────────────────────────────────
      //
      // `installed` rides along for exactly the reason a speed pack's does: an
      // upscaler is in NEITHER status() list — not a checkpoint, not a user
      // adapter — so the catalog payload is the only place the gallery button
      // can learn whether the 64 MB is already on disk. Without it the UPSCALE
      // button would have to either fire a status IPC per tile (a storm on every
      // scroll) or guess.
      upscalers: listUpscalers().map(u => ({
        ...u,
        files: upscalerCatalogFiles(findUpscaler(u.id)!),
      })),
      // ── THE REFERENCE-IMAGE WEIGHTS (IP-Adapter) ───────────────────────────
      //
      // Same reason as the two lists above — neither a checkpoint nor a user
      // adapter, so nothing in status() knows whether they are on disk. `files`
      // carries the `sharedWith` cross-check that spans the MODEL rows too,
      // because the 1.2 GB encoder is the Wan i2v component: a panel that quoted
      // the full total to someone who already has those bytes would be the
      // over-count that field exists to prevent.
      ipAdapters: listIpAdapters(),
      // …and the checkpoints that HAVE a row for their declared family and
      // measurably cannot run it (SD-Turbo is declared sd15 and is SD 2.x).
      // Shipped for the same reason blockedSpeedAdapters is: an absence the
      // user reads as a missing feature deserves the verdict instead.
      blockedIpAdapters: SD_IP_ADAPTER_BLOCKED,
      releases: SD_CPP_RELEASES,
    }
  })

  ipcMain.handle('sd-cpp:status', () => sdStatus())

  // sd-cpp:update-engine — move an EXISTING install onto the pinned release.
  // Separate from `install` because install SHORT-CIRCUITS on "a binary
  // exists": without this verb a bumped SD_CPP_VERSION reaches new users only,
  // and everyone who already had the engine keeps the old one forever with no
  // surface saying so. `sd-cpp:status` carries `engine.updateAvailable`, which
  // is what decides whether this is offered at all.
  ipcMain.handle('sd-cpp:update-engine', async () => {
    try { return { ok: true as const, ...(await updateSdCppToPinned(win)) } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  ipcMain.handle('sd-cpp:install', async () => {
    try { await installSdCppBinary(win); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  ipcMain.handle('sd-cpp:download-model', async (_e, { id }: { id: string }) => {
    try { await downloadSdModel(win, id); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  // sd-cpp:cancel-download — STOP an in-flight model download. Maps to the
  // manager's PAUSE (exactly like llama-cpp:cancel-download): every component
  // `.part` is KEPT so the strip / a Catalog re-click resumes from the offset
  // already on disk. `cancelled:false` = nothing was pausable for that id.
  ipcMain.handle('sd-cpp:cancel-download', (_e, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) return { ok: false as const, error: 'id required' }
    return { ok: true as const, cancelled: cancelSdModelDownload(id) }
  })

  // Removing a model drops BOTH halves, mirroring remove-adapter below: the
  // weights AND the user-registry row. Leaving the row behind would keep a
  // phantom entry in the download panel offering a re-install the user just
  // said no to — a few hundred bytes of recipe masquerading as a choice.
  // Curated rows have no registry row, so removeUserSdModel is a no-op there.
  ipcMain.handle('sd-cpp:remove-model', (_e, { id }: { id: string }) => {
    const weights = removeSdModel(id)
    removeUserSdModel(id)
    return weights
  })

  // ── ADAPTERS (LoRA / textual inversion / VAE) ──────────────────────────────
  // The listing rides on sd-cpp:status (one round trip for "what can I run"),
  // so only the two lifecycle verbs need handlers of their own.
  ipcMain.handle('sd-cpp:download-adapter', async (_e, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) return { ok: false as const, error: 'id required' }
    try { await downloadSdAdapter(win, id); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  // A CURATED SPEED PACK: several LoRA files that are worthless apart, so one
  // verb installs all of them. No `remove` sibling on purpose — two packs share
  // one byte-identical file under one slug, and a naive per-pack delete would
  // silently disarm the other one's preset. Removing the model row's weights is
  // the coarse action that already exists.
  ipcMain.handle('sd-cpp:download-speed-adapter', async (_e, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) return { ok: false as const, error: 'id required' }
    try { await downloadSdSpeedAdapter(win, id); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  // Removing an adapter drops BOTH halves: the weights (which are the disk
  // cost) and the registry row (which is what makes it offerable). Leaving the
  // row behind would keep a dead entry in the LoRA picker whose tag names a
  // file that is gone — the engine's own silent-no-op failure mode, reproduced
  // by us.
  ipcMain.handle('sd-cpp:remove-adapter', (_e, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) return { ok: false as const, error: 'id required' }
    const file = removeSdAdapterFile(id)
    const row  = removeUserSdAdapter(id)
    if (!file.ok && !row) return { ok: false as const, error: file.error ?? `Unknown adapter: ${id}` }
    return { ok: true as const }
  })

  // Both generate handlers RESOLVE with { ok:false, error } (never reject), so
  // the renderer can render the failure inline. They also LOG it: a run that
  // dies after an hour (VRAM overflow reaping sd-cli) left no trace anywhere in
  // main, which is what made the driver's dead render un-diagnosable.
  ipcMain.handle('sd-cpp:generate', async (_e, input: WithInitImage<SdGenerateInput>) => {
    const prepared = withInitImagePath(input)
    try { const r = await generateImage(prepared.input, win); return { ok: true as const, ...r } }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error('[sd-cpp] image generation failed:', error)
      return { ok: false as const, error }
    }
    finally { dropOwnTempInit(prepared.ownTempInit, prepared.ownTempRef) }
  })

  ipcMain.handle('sd-cpp:generate-video', async (_e, input: WithInitImage<SdVideoInput>) => {
    const prepared = withInitImagePath(input)
    try { const r = await generateVideo(prepared.input, win); return { ok: true as const, ...r } }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error('[sd-cpp] video generation failed:', error)
      return { ok: false as const, error }
    }
    finally { dropOwnTempInit(prepared.ownTempInit, prepared.ownTempRef) }
  })

  // ── UPSCALE ────────────────────────────────────────────────────────────────
  //
  // Two verbs, the RifeAction shape: the button installs before it can run, and
  // it must be able to say the price first. Both resolve with { ok:false, error }
  // rather than rejecting, so a gallery tile renders the failure inline.
  ipcMain.handle('sd-cpp:download-upscaler', async (_e, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) return { ok: false as const, error: 'id required' }
    try { await downloadSdUpscaler(win, id); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  // The reference-image weights (IP-Adapter). Same shape as the upscaler verb
  // above — resolves with { ok:false, error } so the composer renders the failure
  // inline instead of a rejected promise nobody catches.
  ipcMain.handle('sd-cpp:download-ip-adapter', async (_e, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !id) return { ok: false as const, error: 'id required' }
    try { await downloadSdIpAdapter(win, id); return { ok: true as const } }
    catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : String(e) } }
  })

  // The PATH is validated as a path, not trusted as a string: the renderer sends
  // an artifact path it read off a gallery entry, and the service checks the file
  // exists before it spawns. No data: URL branch here (unlike the init frame
  // above) — an upscale is only ever offered for a file that is already on disk,
  // which is the same rule RifeAction's `if (!path) return null` enforces.
  ipcMain.handle('sd-cpp:upscale', async (_e, payload: unknown) => {
    const p = (payload ?? {}) as { path?: unknown; upscalerId?: unknown; repeats?: unknown; tileSize?: unknown }
    if (typeof p.path !== 'string' || !p.path.trim()) return { ok: false as const, error: 'path required' }
    try {
      const r = await upscaleImage({
        inputPath: p.path,
        ...(typeof p.upscalerId === 'string' && p.upscalerId ? { upscalerId: p.upscalerId } : {}),
        ...(typeof p.repeats  === 'number' ? { repeats:  p.repeats  } : {}),
        ...(typeof p.tileSize === 'number' ? { tileSize: p.tileSize } : {}),
      }, win)
      return { ok: true as const, ...r }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      console.error('[sd-cpp] upscale failed:', error)
      return { ok: false as const, error }
    }
  })

  // sd-cpp:cancel-generation — STOP the running render. Not the same verb as
  // cancel-download (which PAUSES and keeps the bytes): there is no partial
  // result to resume here, so this is a kill and the run reports itself as
  // stopped through the same failure path every other death uses.
  // `cancelled:false` = nothing was running, which the UI treats as a no-op.
  ipcMain.handle('sd-cpp:cancel-generation', () => {
    const r = cancelGeneration()
    if (r.cancelled) console.warn('[sd-cpp] generation stopped by the user (pid', r.pid, ')')
    return { ok: true as const, ...r }
  })

  // The RIFE frame-interpolation sidecar registers HERE rather than in main.ts —
  // it is a sibling local media engine, and main.ts naming it would put it in
  // the hoisted boot prelude (the rule civitaiIpcWiring pins for civitai.ipc).
  registerRifeIpc(win)
}
