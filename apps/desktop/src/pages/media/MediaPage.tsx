// apps/desktop/src/pages/media/MediaPage.tsx
//
// Brutalist Surplus MEDIA studio. Pick a modality → a model (filtered to that
// modality) → SCHEMA-DRIVEN params (rendered by <ParamFields> from
// window.tachi.surplusMedia.modelParams) → Generate. Results land in a
// PERSISTENT gallery (media.store, localStorage) with per-item Save / Reveal,
// favorite/pin, Remix, fullscreen preview, and an auto-save-folder toggle.
// STT keeps its real File picker (uploads bytes, not a filename). Renderer-only:
// everything routes through window.tachi.surplusMedia.* (Layer A IPC). Cloud-only
// (blocked in PRIVATE MODE by egress-policy on the main side — surfaced as an
// error toast here).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageTopbar } from '../../components/layout/PageTopbar'
import { TabTour, useTourFirstVisit, type TourStep } from '../../components/TabTour'
import { showToast } from '../../components/Toaster'
import type { SurplusMediaModelInfo, SurplusMediaModality, ParamSpec, Artifact } from '../../types/electron'
import {
  artifactSrc, AUDIO_ACCEPT, fileToBytes, PROMPT_PRESETS, promptPresetLabelKey, SD_STYLES, applyStyle, presetsForRow,
  providerServesModality, pollinationsVisibleSchema, mediaProviderLabel,
  resolveProviderForModality, resolveRouteEcho, runFailureToastKind, sdDownloadRowState,
  interpolatedGalleryEntry, upscaledGalleryEntry, mediaFitLine, galleryTimestamp,
  sdDownloadSize, sdRowLicense, speedPackDiscountNote,
  sortGalleryForDisplay, adapterFamilyVerdict, partitionAdaptersByFamily,
  stampLocalSelections, readLocalSelections, withoutLocalSelections, NO_LOCAL_SELECTIONS,
  withoutLocalImageAspectRatio,
  type MediaProvider, type MediaRoute, type SdDownloadRowState,
} from './mediaHelpers'
import { useConfirm } from '../../components/ConfirmProvider'
// The stale-response guard, borrowed rather than re-implemented: the Catalog
// tab's HF and Civitai searches race the same way and this counter is what
// orders them (see pages/catalog/search.ts). Type-only deps, no bundle cost.
import { createRequestCoordinator } from '../catalog/search'
import { subscribeKokoroProgress, type TtsEngine } from './audioOverviewHelpers'
import { installMediaProgressBridge, setSdPhaseLabels } from './mediaProgressBridge'
import { parseTachiGenMetaFromFile } from './exifMeta'
import { fmtBytesPerSec, fmtEta } from '../../utils/progressFormat'
import { ParamFields } from './ParamFields'
import {
  healParamsForSchema, reseedRecipeParams,
  resolveLocalGenParams, resolveLocalInitImage, resolveLocalNegative, resolveLocalSpeedMode,
  resolveLocalBatch, resolveLocalHires, localImagesOf,
  resolveLocalClipSkip, resolveLocalMemoryFlags, schemaOffersClipSkip,
  resolveLocalSdSize, resolveLocalStrength, resolveLocalWanFrames, resolveLocalWanSize,
  schemaNegativeDefault, schemaOffersInitImage, stampLocalEngineParams, stampLocalSeed, stampLocalWanTime,
  hasTriggerWord, toggleTriggerWord, normalizeLoraWeight, resolveTypedLoraTags,
  resolveLocalIpAdapter, schemaOffersIpAdapter,
  LORA_WEIGHT_MIN, LORA_WEIGHT_MAX, LORA_WEIGHT_DEFAULT,
  RECIPE_OWNED_PARAMS, LOCAL_ROW_OWNED_PARAMS,
} from './localGenParams'
import { ImportFromUrl } from './ImportFromUrl'
import { RifeAction } from './RifeAction'
import { UpscaleAction } from './UpscaleAction'
import { useMediaStore, GALLERY_CAP, type MediaGalleryEntry } from '../../store/media.store'
import { modelDisplayName } from '../../utils/model-display'

/** MB → the "12.5" the local-model rows print (one decimal, binary GB). */
const gbLabel = (mb: number): string => (mb / 1024).toFixed(1)

/**
 * MB → a size with its own UNIT, for rows that can be smaller than a gigabyte.
 *
 * `gbLabel` is right for every checkpoint (4.9 GB, 9.2 GB) and wrong the moment
 * a row is small: the reference-image weights are 43 MiB once their encoder is
 * already on disk, and the live build printed **"0.0 GB"** on the download
 * button — a price that reads as "nothing", on a button that transfers 43 MB.
 * The unit therefore lives INSIDE the string here rather than in the translated
 * template, which is what lets it change.
 */
const sizeLabel = (mb: number): string =>
  mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`

// Modalities the studio can generate. (text/embedding excluded — not media.)
// Labels are resolved via t('modalities.<id>') inside the component.
const MODALITIES: { id: SurplusMediaModality }[] = [
  { id: 'image' },
  { id: 'video' },
  { id: 'music' },
  { id: 'tts'   },
  { id: 'stt'   },
]

// Interactive walkthrough for the Media tab (opens on first visit + the "How to"
// button). Keys are resolved against the 'media' namespace inside the component.
// ORDERED TO MATCH THE DOM, top to bottom: a tour that jumps up and down the
// page reads as a list of features rather than a walkthrough.
//
// Two steps were added with lane 5B's local-first rewrite. `media-import` is an
// anchor that ALREADY EXISTED (ImportFromUrl) and had no step pointing at it —
// the first block of the composer, silently untoured. `media-local` is the
// engine/download panel: the tour used to describe this tab as a choice between
// two paid providers, so the panel that installs a free local engine and pulls
// the weights was the one thing a newcomer most needed pointed out.
const MEDIA_TOUR_KEYS: { titleKey: string; bodyKey: string; selector?: string }[] = [
  { titleKey: 'tour.intro.title', bodyKey: 'tour.intro.body' },
  { titleKey: 'tour.importUrl.title', bodyKey: 'tour.importUrl.body', selector: '[data-tour="media-import"]' },
  { titleKey: 'tour.modality.title', bodyKey: 'tour.modality.body', selector: '[data-tour="media-modality"]' },
  { titleKey: 'tour.localEngine.title', bodyKey: 'tour.localEngine.body', selector: '[data-tour="media-local"]' },
  { titleKey: 'tour.model.title', bodyKey: 'tour.model.body', selector: '[data-tour="media-model"]' },
  { titleKey: 'tour.prompt.title', bodyKey: 'tour.prompt.body' },
  { titleKey: 'tour.generate.title', bodyKey: 'tour.generate.body', selector: '[data-tour="media-generate"]' },
  { titleKey: 'tour.gallery.title', bodyKey: 'tour.gallery.body', selector: '[data-tour="media-gallery"]' },
  { titleKey: 'tour.workflow.title', bodyKey: 'tour.workflow.body' },
]

// ── Shared brutalist styles ───────────────────────────────────────────────────
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 4,
}
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px',
  border: '2px solid var(--border)', background: 'var(--bg-inset)',
  color: 'var(--text-primary)', fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12, outline: 'none',
}
const btnStyle: React.CSSProperties = {
  padding: '4px 10px', border: '2px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text-muted)',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
}

/** STT is handled with a dedicated File picker (uploads bytes), so its schema's
 *  `file` audio control is suppressed in ParamFields. */
function visibleSchema(modality: SurplusMediaModality, schema: ParamSpec[]): ParamSpec[] {
  if (modality === 'stt') return schema.filter(s => s.name !== 'file')
  return schema
}

// ── STUDIO (kokoro) TTS artifacts must land on disk, not just in memory ─────
//
// Audit 1C-1: `kokoro.synthesize` only ever returns bytes — the entry pushed
// with `{ b64 }` and no `path` renders fine THIS session, but Save (which
// reads `a.path`, see saveArtifactToFolder in mediaHelpers) is dead, and the
// entry does not survive a restart the way every sd.cpp / piper artifact does
// (they all carry a `path`; only kokoro's did not). DesignPage's voiceover
// chain (DesignPage.tsx:264) already solved this for design-audio — kokoro
// synth → media.saveWav (writes under <userData>/media/kokoro) → keep the
// returned path — so this is the same wire for the Media tab's gallery.

/** Deterministic filename for a STUDIO render, mirroring DesignPage's
 *  `vo-<slug>-<ts>.wav` shape so the saveWav wire gets a readable name. */
export function kokoroTtsFileName(promptText: string, now: number): string {
  const slug = promptText.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'tts'
  return `tts-${slug}-${now}.wav`
}

/**
 * Synthesize with STUDIO (kokoro) and immediately save the WAV to disk, so
 * the caller always has a `path` to hand the gallery entry. Throws on either
 * step's failure — mirroring DesignPage's wire exactly — rather than falling
 * back to a b64-only artifact that would reintroduce the same bug.
 */
export async function synthesizeKokoroTts(
  synth: (input: { text: string; voice: string }) => Promise<{ ok: boolean; b64?: string; error?: string }>,
  saveWav: (input: { b64: string; name: string }) => Promise<{ ok: boolean; path?: string; error?: string }>,
  input: { text: string; voice: string; now: number },
): Promise<{ b64: string; path: string; mime: 'audio/wav' }> {
  const r = await synth({ text: input.text, voice: input.voice })
  if (!r.ok || !r.b64) throw new Error(r.error || 'Local TTS failed')
  const saved = await saveWav({ b64: r.b64, name: kokoroTtsFileName(input.text, input.now) })
  if (!saved.ok || !saved.path) throw new Error(saved.error || 'Local TTS save failed')
  return { b64: r.b64, path: saved.path, mime: 'audio/wav' }
}

// ── A resolved `{ ok:false }` is a failure the same way a rejection is ──────
//
// Audit 1C-2: `sd-cpp:download-speed-adapter` and `piper:download-voice`
// RESOLVE with `{ ok:false, error }` on failure — they don't reject — so the
// panel's `.catch(() => {})` on both buttons only ever caught the rejection
// half. A bad id, a full disk, a 404 on the asset: all landed exactly like
// success, with the progress line left parked on "downloading…" forever.
// downloadSdRow (below) already gets this right for checkpoints; this is the
// same check, shared so the other two buttons stop disagreeing with it.

/** The toast text for a `{ ok?, error? }`-shaped download resolution, or null
 *  when it did not fail (so the caller knows to say nothing). */
export function downloadRowFailureText(
  res: { ok?: boolean; error?: string } | null | undefined,
  fallback: string,
): string | null {
  if (!res || res.ok !== false) return null
  return (res.error ?? '').trim() || fallback
}

// ── The download panel must know which MODALITY it is downloading FOR ──────
//
// Audit 1C-3: `sd-cpp:catalog` tags every row `kind: 'image' | 'video'`, and
// the panel used to drop that field on the floor — so a Wan checkpoint's
// download button rendered under IMAGE and an SDXL row rendered under VIDEO,
// regardless of which modality tab was active. A row of the OTHER kind is
// kept — and marked, never silently blended in — only while a download for
// it is genuinely in flight or interrupted: hiding it there would orphan a
// transfer the user is mid-way through paying for.

/** May this catalog row's DOWNLOAD button render under the active modality? */
export function isSdDownloadRowVisible(
  rowKind: 'image' | 'video',
  activeModality: SurplusMediaModality,
  state: SdDownloadRowState,
  isActivelyDownloading: boolean,
): boolean {
  if (rowKind === activeModality) return true
  return state === 'resume' || isActivelyDownloading
}

/**
 * Should a just-finished OTHER-KIND download flip the composer over to it?
 * The user asked for a video checkpoint while looking at IMAGE — left alone,
 * they would generate an image with whatever model was already selected, or
 * never notice VIDEO now has a model at all. Only fires for a download this
 * panel is tracking as active AND of a different kind than what is showing.
 */
export function shouldFlipModalityOnDownloadDone(
  downloading: { id: string; kind: 'image' | 'video' } | null,
  activeModality: SurplusMediaModality,
): { modality: 'image' | 'video' } | null {
  if (!downloading) return null
  if (downloading.kind === activeModality) return null
  return { modality: downloading.kind }
}

// ── THE FUNNEL: a dead end that says "fund USDC" beside a free engine ────────
//
// A newcomer's FIRST Media screen, on a profile with no keys, reads "No models —
// add a Surplus key and fund USDC." The LOCAL chip one inch above runs sd.cpp on
// their own machine for nothing, and nothing on the screen says so. The same
// class of sentence arrives from MAIN when a cloud GENERATE fails without a key
// or with a 402 (surplus-media-service's mapSurplusError). That file belongs to
// another lane, so the reword happens HERE: main keeps saying what happened, the
// composer adds the door.
//
// TWO DIFFERENT PIECES OF EVIDENCE, on purpose:
//
//  • The empty CATALOG is decided STRUCTURALLY — a cloud provider with no models
//    for a modality the local engine serves. No string matching: the picker's
//    message is one of OUR OWN translated strings (models.error.noSurplus /
//    noVenice / noImgnai), so a regex over it would answer 'yes' in English and
//    'no' in the other seven languages.
//
//  • A settled RUN carries main's English sentence, which is the only evidence
//    there is that a failure was about money rather than about a broken model.
//    That one IS matched, narrowly, and the patterns are pinned against main's
//    source by test — if it rewords them the test fails, rather than the button
//    quietly disappearing.

/** Can the LOCAL engine serve this modality while the user is NOT on it? */
export function canOfferLocalSwitch(provider: MediaProvider, modality: SurplusMediaModality): boolean {
  return provider !== 'local' && providerServesModality('local', modality)
}

/** The signals that mark a cloud failure as "no key / no money" rather than
 *  "it broke". Narrow on purpose: a 500 from the gateway, a bad prompt or a
 *  network drop is not something switching provider fixes, and offering the
 *  local door for those would make the button noise. */
const CLOUD_FUNDING_SIGNALS: readonly RegExp[] = [
  /\bfund\s+usdc\b/i,                // 'Add a key and fund USDC in Settings → Surplus'
  /\bno\s+surplus\s+key\b/i,         // 'No Surplus key configured.'
  /\bpayment\s+required\b/i,         // 'Payment required (402) — insufficient funds.'
  /\binsufficient\s+funds\b/i,
  /\bcheck your key\b/i,             // 'Surplus auth failed (401). Check your key.'
  /\bno\s+venice\s+key\b/i,          // venice-media-service's own missing-key sentence
]

/** Does this failure message say "no key / no money"? */
export function isCloudKeyOrFundingFailure(message: string | null | undefined): boolean {
  const m = (message ?? '').trim()
  if (!m) return false
  return CLOUD_FUNDING_SIGNALS.some(re => re.test(m))
}

/** Offer the local door beside a SETTLED RUN's failure row. */
export function shouldOfferLocalSwitchOnFailure(input: {
  provider: MediaProvider
  modality: SurplusMediaModality
  message:  string | null
}): boolean {
  return canOfferLocalSwitch(input.provider, input.modality)
    && isCloudKeyOrFundingFailure(input.message)
}

// ── THE ZERO-CONFIG PATH: install → download → prompt → render, in one click ──
//
// Everything the free route needs already exists as three separate buttons in
// three different states, each of which only appears once the previous one has
// been found and pressed: install the engine, pick a checkpoint out of a list of
// eight and pay ~5 GB for it, then discover that the composer wants a prompt.
// A first-time user does not know that sd.cpp is a thing, which of the rows is
// small enough for their machine, or that SD-Turbo needs one step.
//
// THE PLAN IS RE-DERIVED FROM DISK ON EVERY CLICK, never stored. That is what
// makes a failure resumable at no cost: the engine landed but the weights died
// half-way → the next click plans ['weights','generate'] and the download picks
// up from the `.part` bytes main already has (the RESUME state of 597eaa6).
// It is also why walking away mid-chain is free — the component's chain state
// dies with the tab, the bytes do not, and the CTA comes back offering exactly
// what is left.

/** The curated row the zero-config path installs: sd-cpp-models' own
 *  "SD-Turbo (fast — recommended first try)". Pinned by test. */
export const FIRST_IMAGE_STARTER_ID = 'sd-turbo'

/** One leg of the journey. Order is the order they run in. */
export type FirstImageStep = 'engine' | 'weights' | 'generate'

/** What is still owed, given what is on disk RIGHT NOW. */
export function firstImagePlan(input: { sdInstalled: boolean; starterInstalled: boolean }): FirstImageStep[] {
  const steps: FirstImageStep[] = []
  if (!input.sdInstalled)      steps.push('engine')
  if (!input.starterInstalled) steps.push('weights')
  steps.push('generate')
  return steps
}

/**
 * May the CTA be on screen?
 *
 * `installedImageModelCount` is the composer's OWN model list — for
 * provider=local + modality=image that list IS the set of installed image
 * checkpoints (loadModels filters sd-cpp:status by kind), so there is no second
 * source of truth to drift. Hidden while that list is still loading, or while
 * anything is running: a button that promises a first image must not appear
 * beside a render in flight.
 *
 * `chainInPlay` covers a chain that is RUNNING **and** one that has stopped with
 * a resume on screen. Both own this surface: two buttons that start the same
 * journey is confusing, and the CTA's own price would be the WRONG one after a
 * part-finished download (it quotes from fully-installed rows, while the resume
 * knows about the `.part` bytes).
 */
export function shouldOfferFirstImage(input: {
  provider:                 MediaProvider
  modality:                 SurplusMediaModality
  sdInstalled:              boolean
  installedImageModelCount: number
  loadingModels:            boolean
  busy:                     boolean
  chainInPlay:              boolean
}): boolean {
  if (input.provider !== 'local' || input.modality !== 'image') return false
  if (input.loadingModels || input.busy || input.chainInPlay) return false
  return !input.sdInstalled || input.installedImageModelCount === 0
}

/** The prompt the chain renders with. A prompt the user already typed WINS —
 *  the CTA is a shortcut past the empty state, not an editor of their words. */
export function firstImageSeedPrompt(existing: unknown, preset: string): string {
  const cur = typeof existing === 'string' ? existing.trim() : ''
  return cur || preset
}

/**
 * Is the composer actually ready to run the last leg?
 *
 * The weights landing does not make it ready: the model list reloads, the model
 * is re-pointed, and only then does the param SCHEMA arrive over IPC. Firing
 * Generate before that means a run with no prompt key and no size — so the chain
 * hands off to an effect that waits for all the facts instead of guessing at a
 * delay.
 *
 * THE PROVIDER IS ONE OF THOSE FACTS. A chain started from the local panel keeps
 * running if the user clicks the SURPLUS chip while a 5 GB download finishes —
 * and the handoff would then fire Generate on a CLOUD route the user never asked
 * to spend on. Leaving `local` abandons the last leg (the timeout says so);
 * nothing is ever billed on its behalf.
 */
export function firstImageReadyToGenerate(input: {
  provider:    MediaProvider
  model:       string
  starterId:   string
  schemaCount: number
  promptKey:   string | null
  busy:        boolean
}): boolean {
  if (input.provider !== 'local') return false
  if (input.busy) return false
  if (input.model !== input.starterId) return false
  return input.schemaCount > 0 && input.promptKey !== null
}

// ── WHAT THE ENGINE BUTTON COSTS ─────────────────────────────────────────────
//
// "Install sd.cpp (one-time)" says nothing about size, and on a Windows machine
// with an NVIDIA card it is 883 MB (the CUDA build plus its separate cudart
// archive) against 23 MB for the CPU build — a 38x spread behind identical copy.
// RIFE's button has said its 431 MB since it shipped ("SIZE, HONESTLY" in
// rife-installer); these two never did.
//
// `SdRelease` / `PiperRelease` carry NO size field, so there is nothing to read
// off the row — hence a MEASURED table here, keyed by the archive FILENAME the
// release rows already carry to the renderer on their catalog payloads. Keyed by
// filename precisely so a pin bump cannot leave a stale number on a button: an
// asset this table has never measured contributes NOTHING to the quote. When
// those interfaces grow a `sizeBytes` (the shape rife-plan.ts already uses),
// delete this table and read it from the row.
//
// KEYED BY FILENAME, WHICH IS WHY THIS TABLE IS DANGEROUS TO FORGET. An entry
// that does not match a shipped release row is not an error — the quote loop
// `continue`s past it — so a stale key does not break the button, it silently
// removes the price from it. Bumping SD_CPP_VERSION means updating this table
// in the same commit; the sd-cpp asset names carry the tag's short hash, so
// EVERY sd row changes at once. (mediaFirstRunFunnel.test.ts cross-checks the
// two lists against each other for exactly this reason.)
//
// sd.cpp figures REFRESHED 2026-08-03 for master-810-db99efd, from the release
// API's own `size`. The win-cpu archive was additionally downloaded and
// measured on disk — 23 834 751 B, equal to the API's number to the byte, which
// is what makes quoting the API for the other five defensible. Piper is
// unchanged (still PIPER_VERSION 2023.11.14-2, HEAD-measured 2026-07-31).
//
//   sd-master-db99efd-bin-win-cuda12-x64.zip             362_013_051
//   cudart-sd-bin-win-cu12-x64.zip                       563_452_046  (CUDA companion, unchanged)
//   sd-master-db99efd-bin-win-vulkan-x64.zip              37_829_640
//   sd-master-db99efd-bin-win-rocm-7.14.0-x64.zip        200_234_508
//   sd-master-db99efd-bin-win-cpu-x64.zip                 23_834_751  (disk-verified)
//   sd-master-db99efd-bin-Darwin-macOS-26.5.2-arm64.zip   49_595_370
//   piper_windows_amd64.zip                               22_477_236
//   piper_macos_aarch64.tar.gz                            19_146_957
//   piper_macos_x64.tar.gz                                19_146_927
export const ENGINE_ARCHIVE_BYTES: Readonly<Record<string, number>> = {
  'sd-master-db99efd-bin-win-cuda12-x64.zip':            362_013_051,
  'cudart-sd-bin-win-cu12-x64.zip':                      563_452_046,
  'sd-master-db99efd-bin-win-vulkan-x64.zip':             37_829_640,
  'sd-master-db99efd-bin-win-rocm-7.14.0-x64.zip':       200_234_508,
  'sd-master-db99efd-bin-win-cpu-x64.zip':                23_834_751,
  'sd-master-db99efd-bin-Darwin-macOS-26.5.2-arm64.zip':  49_595_370,
  'piper_windows_amd64.zip':                              22_477_236,
  'piper_macos_aarch64.tar.gz':                           19_146_957,
  'piper_macos_x64.tar.gz':                               19_146_927,
}

/** MiB the install may cost on THIS platform. min === max ⇒ one build. */
export interface EngineSizeQuote { minMb: number; maxMb: number }

/**
 * Quote what an engine install will transfer, from the release rows main sends
 * (`sd-cpp:catalog` / `piper:catalog` both carry `releases`) crossed with the
 * measured table.
 *
 * A RANGE rather than a single number because WHICH build gets picked is main's
 * decision (defaultReleaseAsset, per platform + detected GPU backend) and
 * re-deriving that rule here would be a second truth that goes stale the moment
 * a backend is added. Both ends of the range are measured, and a row whose
 * archive — or whose declared companion archive — is unmeasured is skipped
 * entirely: half a price is a wrong price. Null ⇒ nothing to say, and the button
 * keeps its plain label.
 */
export function engineDownloadQuoteMb(
  releases: unknown,
  isMac: boolean,
  bytesByFilename: Readonly<Record<string, number>> = ENGINE_ARCHIVE_BYTES,
): EngineSizeQuote | null {
  if (!Array.isArray(releases)) return null
  const sizes: number[] = []
  for (const raw of releases) {
    const row = (raw ?? {}) as { platform?: unknown; filename?: unknown; cudartFilename?: unknown }
    const platform = typeof row.platform === 'string' ? row.platform : ''
    const filename = typeof row.filename === 'string' ? row.filename : ''
    if (!filename) continue
    // 'win' / 'win-cuda' / 'win-cpu' vs 'mac-arm64' / 'mac-x64' — the two
    // registries spell their platforms differently and agree on the prefix.
    if (isMac ? !platform.startsWith('mac') : !platform.startsWith('win')) continue
    const own = bytesByFilename[filename]
    if (own === undefined) continue
    let total = own
    if (typeof row.cudartFilename === 'string' && row.cudartFilename) {
      const companion = bytesByFilename[row.cudartFilename]
      if (companion === undefined) continue
      total += companion
    }
    sizes.push(total)
  }
  if (sizes.length === 0) return null
  const mb = sizes.map(b => Math.round(b / 1_048_576))
  return { minMb: Math.min(...mb), maxMb: Math.max(...mb) }
}

// ── THE FAST PATH, OFFERED ONCE THE SLOW ONE HAS MADE THE POINT ──────────────
//
// A local video render on a row whose 4-step pack is not installed spends 10x
// the sampling passes it needs to. The pack row is in the panel, priced and
// explained — but it renders below the download list, and someone who just
// waited out a 27-minute render is looking at the gallery, not at the panel.
// So the finished run says it, ONCE per row per app session: a second telling
// after the same choice is nagging, and the pack is a legitimate choice to
// decline (it changes the recipe).

/** Every curated speed pack is a 4-STEP distill (SD_SPEED_ADAPTERS presets, all
 *  `steps: 4`) — pinned by test, because this number is quoted at the user. */
export const SPEED_PACK_STEPS = 4

/** Rows already pitched in THIS app session. Module scope, not component state:
 *  the page unmounts on every tab switch and "once per session" has to mean
 *  more than "once per visit". */
const speedPackPitched = new Set<string>()

/** Has this row a pack that is worth telling this user about right now? */
export function shouldPitchSpeedPack(input: {
  modelId: string
  packs:   ReadonlyArray<{ modelId: string; installed: boolean }>
  pitched: ReadonlySet<string>
}): boolean {
  if (!input.modelId) return false
  if (input.pitched.has(input.modelId)) return false
  const pack = input.packs.find(p => p.modelId === input.modelId)
  return pack !== undefined && !pack.installed
}

/** The numbers the pitch quotes, or null when there is no honest pitch to make. */
export interface SpeedPackPitch { sizeMb: number; runSteps: number; ratio: number }

/**
 * Build the pitch from the run that just finished: its OWN effective step count
 * (main reports it — the pack out-votes the composer, so this is the only true
 * source) against the pack's four, and the pack's INCREMENTAL size (the two
 * packs share one byte-identical LoRA, so the second one is ~0.6 GB).
 *
 * Null when the engine reported no recipe, when the saving does not reach a
 * whole 2x (nothing to advertise), or when the pack would cost nothing — every
 * one of those is a claim not worth interrupting for.
 *
 * FLOORED, not rounded: at 6 steps against 4 the real saving is 1.5x and
 * rounding would print "2× fewer" at the user. The number goes on screen, so it
 * errs downwards — a 7-step run is offered nothing rather than a 2x it will not
 * get.
 */
export function speedPackPitch(input: {
  runSteps:      number | undefined
  incrementalMb: number
}): SpeedPackPitch | null {
  const steps = input.runSteps
  if (typeof steps !== 'number' || !Number.isFinite(steps) || steps <= 0) return null
  if (!Number.isFinite(input.incrementalMb) || input.incrementalMb <= 0) return null
  const ratio = Math.floor(steps / SPEED_PACK_STEPS)
  if (ratio < 2) return null
  return { sizeMb: input.incrementalMb, runSteps: steps, ratio }
}

// ── Local sd.cpp param plumbing — MOVED OUT ──────────────────────────────────
//
// Every resolver below used to be defined HERE, which is precisely why the
// canvas media node never got the size / duration / frames / negative fixes
// (audit D3): its local branch runs in MAIN and cannot import a React page.
// They now live in ./localGenParams — a pure module both surfaces import — and
// are re-exported from this file so the existing mediaLocalSdSize test suite
// (which imports them through MediaPage) keeps pinning them where it always did.
export {
  parseSizeParam, resolveLocalSdSize,
  parseVideoSizeParams, resolveLocalWanSize,
  durationSecondsToWanFrames, wanFramesToSeconds, resolveLocalWanFrames,
  stampLocalWanTime, stampLocalSeed, stampLocalEngineParams,
  schemaOffersInitImage, resolveLocalInitImage, resolveLocalStrength,
  resolveLocalGenParams, resolveLocalNegative, resolveLocalSpeedMode, LOCAL_GEN_LEGACY_KEYS,
  healParamsForSchema, reseedRecipeParams, RECIPE_OWNED_PARAMS, LOCAL_ROW_OWNED_PARAMS,
  promptWithLoraTags, normalizeLoraWeight, toggleTriggerWord, hasTriggerWord,
  LORA_WEIGHT_MIN, LORA_WEIGHT_MAX, LORA_WEIGHT_DEFAULT,
} from './localGenParams'

/** The schema key that holds the prompt/text for a modality (presets fill this). */
function promptKeyFor(schema: ParamSpec[]): string | null {
  const required = schema.find(s => s.required && (s.kind === 'text' || s.kind === 'string'))
  if (required) return required.name
  const named = schema.find(s => s.name === 'prompt' || s.name === 'input')
  return named?.name ?? null
}

export function MediaPage() {
  const { t, i18n } = useTranslation('media')
  /**
   * THE IN-APP DIALOG, never `window.confirm`.
   *
   * Clear-all and the per-entry ✕ destroy persisted rows and asked nothing at
   * all — one misclick on CLEAR ALL took a 60-entry gallery with it. The native
   * confirm is not the fix: it opens a modal that BLOCKS Electron's renderer
   * event loop (ConfirmProvider's header states the ban), which on this page
   * would freeze a live sd-cli progress stream behind the dialog.
   */
  const confirm = useConfirm()
  const [tourOpen, setTourOpen] = useState(false)
  useTourFirstVisit('media', setTourOpen)

  // Resolve the walkthrough steps for the active language.
  const MEDIA_TOUR: TourStep[] = useMemo(
    () => MEDIA_TOUR_KEYS.map(s => ({ title: t(s.titleKey), body: t(s.bodyKey), ...(s.selector ? { selector: s.selector } : {}) })),
    [t],
  )

  // ── Persisted form + gallery (media.store) ──────────────────────────────────
  const modality          = useMediaStore(s => s.modality)
  const setModality       = useMediaStore(s => s.setModality)
  const modelByModality   = useMediaStore(s => s.modelByModality)
  const setModel          = useMediaStore(s => s.setModel)
  const paramsByModality  = useMediaStore(s => s.paramsByModality)
  const setParam          = useMediaStore(s => s.setParam)
  const setParams         = useMediaStore(s => s.setParams)
  const autoSaveDir       = useMediaStore(s => s.autoSaveDir)
  const setAutoSaveDir    = useMediaStore(s => s.setAutoSaveDir)
  const gallery           = useMediaStore(s => s.gallery)
  const addEntry          = useMediaStore(s => s.addEntry)
  const toggleFavorite    = useMediaStore(s => s.toggleFavorite)
  const removeEntry       = useMediaStore(s => s.removeEntry)
  const clearGallery      = useMediaStore(s => s.clearGallery)

  // ── In-flight run (media.store, NOT persisted) ──────────────────────────────
  // These four used to be useState in this component, which is why a tab switch
  // erased a running render from the UI (the render itself never stopped). They
  // live in the store now so a remount re-reads the live run.
  const run             = useMediaStore(s => s.run)
  const beginRun        = useMediaStore(s => s.beginRun)
  const setRunProgress  = useMediaStore(s => s.setRunProgress)
  const markRunStopping = useMediaStore(s => s.markRunStopping)
  const failRun         = useMediaStore(s => s.failRun)
  const endRun          = useMediaStore(s => s.endRun)
  const clearRunError   = useMediaStore(s => s.clearRunError)
  const busy     = run.busy
  const progress = run.progress
  const genError = run.error
  /**
   * Is the settled-with-a-message run something the USER asked for?
   *
   * The SAME mapper the toast uses, with the SAME two signals — that shared
   * call is the point. 6227a0e taught the toast that a stop is not a fault and
   * flagged that this row still error-styled one; two surfaces answering the
   * same question with two rules is how that gap existed at all, so there is
   * one function and one answer.
   *
   * `run.stoppedByUser`, not `run.stopping`: this renders AFTER failRun settled
   * the run, and `stopping` is cleared as part of settling — reading it here
   * always answered false, which left the row with only the message-sniffing
   * half of the evidence.
   */
  const genErrorIsStop = genError !== null
    && runFailureToastKind({ message: genError, stopping: run.stoppedByUser }) === 'info'

  const model  = modelByModality[modality] ?? ''
  const params = useMemo(() => paramsByModality[modality] ?? {}, [paramsByModality, modality])

  // ── Performance preset + style (local image/video only) ────────────────────
  /** Currently selected SD_PRESETS id, or null = no preset active. */
  const [activePerfPreset, setActivePerfPreset] = useState<string | null>(null)
  /**
   * Currently selected SD_STYLES id (default 'none') — THE STORE'S.
   *
   * This and the two adapter selections below were `useState`, the last three
   * composer fields that were not persisted, and they cost twice: a tab switch
   * reset them while the prompt / size / model / provider all came back, and
   * nothing recorded them on the entry, so REMIX rebuilt the params faithfully
   * and re-ran with a different style and no LoRAs. See media.store's styleId.
   */
  const activeStyle    = useMediaStore(s => s.styleId)
  const setActiveStyle = useMediaStore(s => s.setStyleId)

  // ── Transient run state ─────────────────────────────────────────────────────
  const [models, setModels]   = useState<SurplusMediaModelInfo[]>([])
  /**
   * The route `models` was loaded FOR — the fact the applier and the footer both
   * needed and neither had.
   *
   * Two model-list loads can be in flight at once (click a modality, then the
   * Local chip within a second): the cloud one goes over the network, the local
   * one is an IPC, and the slow loser used to land last and paint its list under
   * the wrong chip. Tagging the snapshot lets a superseded response be dropped,
   * and lets the resolved-route echo refuse to pair a provider with a list that
   * is not its own.
   */
  const [modelsRoute, setModelsRoute] = useState<MediaRoute | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  /**
   * Monotonic request id for the model-list load — the SAME primitive the
   * Catalog tab uses to order its two racing searches (createRequestCoordinator
   * in pages/catalog/search.ts). One counter per mounted page, so a load issued
   * by this component can only ever be invalidated by a later load of its own.
   */
  const modelLoadSeq = useRef(createRequestCoordinator())
  const [schema, setSchema]   = useState<ParamSpec[]>([])
  const [loadingSchema, setLoadingSchema] = useState(false)
  const [sttFile, setSttFile] = useState<File | null>(null)
  // busy / progress / genError are the store's `run` slice (above). GENERATION
  // failure is shown inline under the Generate button until dismissed: a toast
  // is not enough when a local render can run for over an hour, and the
  // driver's VRAM-killed 49-frame Wan job left the UI at an idle Generate with
  // nothing to read. No RETRY button — re-running a job that died on memory is
  // another hour to the same death; the hint says what to change instead.
  /** Fullscreen preview target (image/video artifact). */
  const [fullscreen, setFullscreen] = useState<Artifact | null>(null)
  /**
   * Media provider: 'surplus' (marketplace), 'venice' (direct), 'local' (sd.cpp),
   * or 'imgnai' (Katana, image+video).
   *
   * THE STORE'S, not this component's. It was `useState('surplus')` — the last
   * composer field that was not persisted — so a tab switch unmounted the page
   * and the initializer re-ran on remount: LOCAL came back as SURPLUS with a
   * cloud catalog under it while the prompt and size (which live in the store)
   * were intact. That is one unintended billed request per tab return.
   */
  const mediaProvider    = useMediaStore(s => s.provider)
  const setMediaProvider = useMediaStore(s => s.setProvider)
  // Local sd.cpp engine state (install status, curated models, progress line).
  const [sdInstalled, setSdInstalled] = useState(false)
  // The installed engine's own commit vs the one this app pins. `installed`
  // alone could not tell them apart, which is exactly why a bumped
  // SD_CPP_VERSION used to reach new users and nobody else.
  const [sdEngineStale, setSdEngineStale] = useState(false)
  const [updatingEngine, setUpdatingEngine] = useState(false)
  const [sdModels, setSdModels] = useState<Array<{
    id: string; name: string; sizeMbTotal: number; notes: string
    /** image vs video — the DOWNLOAD MODEL panel filters to the active
     *  modality on this (audit 1C-3); it used to be dropped here entirely. */
    kind: 'image' | 'video'
    /** The licence these weights land under. Kept because a licence is the one
     *  thing on this row a user has to read BEFORE the button, not after — see
     *  sdRowLicense. Absent on a row whose source licence has not been read. */
    licenseName?: string; licenseUrl?: string
    /** Component files, each naming the OTHER rows that declare the same bytes
     *  — the evidence behind the honest (incremental) download size. */
    files: Array<{ sizeMb: number; sharedWith?: string[] }>
    /** What the row's OWN notes say the machine needs (W4-A). Kept because THIS
     *  panel is where the multi-GB button is — the number was collected for two
     *  surfaces and reached only the Catalog card. Absent on a row whose notes
     *  state no figure, and absent has to stay absent: see mediaFitLine. */
    minVramGb?: number; minRamGb?: number
  }>>([])
  /** The sd.cpp checkpoint download this panel itself started, until its
   *  terminal progress event lands (audit 1C-3: the shared install-progress
   *  channel's 'done'/'error' carries no model id at all, so this is the only
   *  way to know WHICH row just finished — and hence whether to flip the
   *  composer's modality over to it). */
  const downloadingSdRowRef = useRef<{ id: string; kind: 'image' | 'video' } | null>(null)
  /** CURATED SPEED PACKS (4-step distill LoRAs), one per video row that has one,
   *  plus the rows we will not ship one for and why. A pack is in NEITHER
   *  status() list — it is not a checkpoint and not a user adapter — so its
   *  install state rides on the catalog payload. */
  const [sdSpeedPacks, setSdSpeedPacks] = useState<Array<{
    id: string; modelId: string; name: string; sizeMbTotal: number; installed: boolean; notes: string
    files: Array<{ sizeMb: number; sharedWith: string[] }>
  }>>([])
  const [sdSpeedBlocked, setSdSpeedBlocked] = useState<Array<{ modelId: string; blocked: string }>>([])
  /** THE REFERENCE-IMAGE WEIGHTS (IP-Adapter), one row per checkpoint family.
   *  Install state and the shared-bytes discount ride on the catalog payload for
   *  the same reason a speed pack's do — these are in neither status() list. */
  const [sdIpAdapters, setSdIpAdapters] = useState<Array<{
    id: string; name: string; family: string; sizeMbTotal: number; installed: boolean; notes: string
    files: Array<{ sizeMb: number; sharedWith: string[] }>
  }>>([])
  /** The RELEASE ROWS main already ships on both engine catalogs, kept only so
   *  the install buttons can quote a size (engineDownloadQuoteMb). Held as
   *  `unknown[]` — the shape they are declared with in electron.d.ts — and
   *  narrowed inside that pure function rather than trusted here. */
  const [sdReleases, setSdReleases] = useState<unknown[]>([])
  const [piperReleases, setPiperReleases] = useState<unknown[]>([])
  /** modelId → why THIS checkpoint has no reference-image option, even though
   *  its declared family has a row. Measured refusals only. */
  const [sdIpAdapterBlocked, setSdIpAdapterBlocked] = useState<Record<string, string>>({})
  /**
   * THE ZERO-CONFIG JOURNEY, while it is happening.
   *
   * `steps` is the plan derived from disk at the click (never stored across
   * clicks — see firstImagePlan's header), `step` is the leg running now, and
   * `failed` is where it stopped. Deliberately component state: the plan is
   * cheap to re-derive and the bytes live in main, so losing this on a tab
   * switch costs nothing but the progress line.
   */
  const [chain, setChain] = useState<{
    steps: FirstImageStep[]
    step:  FirstImageStep
    failed?: { step: FirstImageStep; message: string }
  } | null>(null)
  /** The last leg is a HANDOFF, not a call: Generate can only run once the model
   *  list, the model and the param schema have all landed (firstImageReadyToGenerate). */
  const [chainAwaitingGenerate, setChainAwaitingGenerate] = useState(false)
  /** id → the INSTALLED row's own recipe (sd-cpp:status): declared family plus
   *  steps/cfg/sampler. Feeds `modelFamily`, the preset picker's honesty check
   *  and the LoRA compat gate; a curated row and a user-installed Civitai row
   *  are indistinguishable here on purpose. */
  const [localRows, setLocalRows] = useState<Record<string, { family: string; steps: number; cfgScale: number; samplingMethod: string }>>({})
  /** Every INSTALLED adapter (LoRA / embedding / VAE), unfiltered — the compat
   *  gate is applied at RENDER time against the active checkpoint's family. */
  const [localAdapters, setLocalAdapters] = useState<Array<{ id: string; kind: 'lora' | 'embedding' | 'vae'; name: string; slug: string; family: string; triggerWords: string[]; defaultWeight?: number }>>([])
  /** Every name a `<lora:…>` tag could resolve to, straight from the main process
   *  — the SAME list the arg builder uses, so the hint under the prompt and the
   *  command line cannot disagree. Includes files placed by hand, which the
   *  `localAdapters` registry above does not know about. */
  const [localLoraNames, setLocalLoraNames] = useState<Array<{ name: string; slug: string }>>([])
  /** LoRA id → weight, for the ones the user switched ON (the store's — see activeStyle). */
  const selectedLoras    = useMediaStore(s => s.loraWeights)
  const setSelectedLoras = useMediaStore(s => s.setLoraWeights)
  /** The VAE adapter id to swap in, or '' for the checkpoint's own (the store's). */
  const selectedVae    = useMediaStore(s => s.vaeAdapterId)
  const setSelectedVae = useMediaStore(s => s.setVaeAdapterId)
  const [piperInstalled, setPiperInstalled] = useState(false)
  const [piperVoices, setPiperVoices] = useState<Array<{ id: string; name: string; sizeMb: number }>>([])
  const [sdProgress, setSdProgress] = useState<string | null>(null)  // shared local-engine progress line
  // Engine INSTALL failure, shown inline on the card that owns it. The install
  // IPCs RESOLVE with { ok:false, error } instead of rejecting, so the old
  // `install().catch(() => {})` swallowed every failure and the button just
  // looked dead (driver: a wedged sd.cpp install reported nothing at all).
  const [engineError, setEngineError] = useState<{ engine: 'sdcpp' | 'piper'; msg: string } | null>(null)
  // Local TTS engine split: STUDIO (kokoro, English studio voices behind a
  // one-time ~92MB download) is the default; PIPER stays for multilingual /
  // fallback. kokoroInstalled === null means the surface is absent (pre-sidecar
  // build) — the toggle hides and everything behaves exactly like before.
  const [localTtsEngine, setLocalTtsEngine] = useState<TtsEngine>('kokoro')
  const [kokoroInstalled, setKokoroInstalled] = useState<boolean | null>(null)
  const [kokoroBusy, setKokoroBusy] = useState(false)
  const [kokoroPct, setKokoroPct] = useState(0)

  const audioInputRef   = useRef<HTMLInputElement>(null)
  const restoreInputRef = useRef<HTMLInputElement>(null)
  /** The exact params bag an explicit Remix / restore-from-PNG wrote. The next
   *  schema arrival seeds into it but does NOT heal it — see the schema effect. */
  const explicitParamsRef = useRef<Record<string, unknown> | null>(null)
  /** The model each modality's params were last seeded for, so the schema effect
   *  can tell a real CHECKPOINT SWITCH (re-seed the row's recipe) from a remount
   *  or a re-fetch of the same model (keep whatever the user set). Per modality,
   *  because the params bag is per modality: bouncing image→video→image is not a
   *  switch of the image model. */
  const seededForModelRef = useRef<Partial<Record<SurplusMediaModality, string>>>({})

  // Live generation progress (sd.cpp + the imgnAI poll loop in MAIN). The
  // listeners live in a MODULE, not in this effect: unmounting the page used to
  // unsubscribe them, so a render that outlived a tab switch went dark. No
  // cleanup returned — that is the point (see mediaProgressBridge).
  useEffect(() => { installMediaProgressBridge() }, [])

  // The two engine phases that are NOT progress of the render — the weight load
  // and the VAE decode — are shown as PROSE so nothing downstream can draw a bar
  // from them (see mediaProgressBridge.formatSdProgress). The bridge installs
  // once for the life of the app and the locale does not, so the phrases are
  // re-registered whenever `t` changes rather than captured at first mount.
  useEffect(() => {
    setSdPhaseLabels({
      loading:  (percent) => t('progress.loadingModel', { percent }),
      decoding: () => t('progress.decoding'),
    })
  }, [t])

  // ── Preset + adapter helpers (local image/video only) ───────────────────────
  //
  // THE FAMILY IS NEVER GUESSED HERE ANY MORE. There used to be a `modelFamily`
  // memo that read the id string (`startsWith('flux')`, `includes('xl')`, else
  // sd15) and handed its verdict to the preset table. It survived only because
  // the three curated ids happen to spell their family out: a user-installed
  // row is `civitai-812345` — no substring at all — so an SDXL checkpoint got
  // the sd15 tiers, and any id containing "xl" claimed SDXL.
  //
  // The memo is GONE rather than fixed, because the question it answered was
  // the wrong one. What the picker needs is not "which of three columns" but
  // "what can THIS ROW run", and presetsForRow answers that from the row itself
  // (family included). A guess has nowhere left to live.

  /** The INSTALLED row behind the selected local model (undefined for cloud). */
  const activeLocalRow = localRows[model]

  /** Every sd.cpp id that is ON DISK — the DOWNLOAD MODEL panel's install-state
   *  source. `localRows` is already keyed by installed id (sd-cpp:status), so
   *  this is a view of the map that gates generation, not a second truth. */
  const installedSdIds = useMemo(() => Object.keys(localRows), [localRows])

  /**
   * The performance tiers this ROW can honestly offer (audit D5). Empty for a
   * distilled checkpoint — SD-Turbo has exactly one setting that works, and the
   * sd15 ladder it used to be handed topped out at 28 steps for a 1-step model.
   * Empty ⇒ the picker is not rendered at all.
   */
  const offeredPresets = useMemo(
    () => (activeLocalRow ? presetsForRow(activeLocalRow) : []),
    [activeLocalRow],
  )

  /**
   * Adapters that run on the ACTIVE checkpoint — compat AT GENERATE, keyed off
   * the two declared families (spec §5-6). An SD 1.5 LoRA on an SDXL checkpoint
   * is not "weak", it is a tensor-shape mismatch that the whole ecosystem
   * silently no-ops with a console-only warning. Holding the family per
   * artifact and running ONE engine makes refusing it trivial, and it is the
   * feature InvokeAI users name first.
   *
   * THE FILTER USED TO BE A BARE EQUALITY between the adapter's declared family
   * and the row's, and that equality answered a question nobody asked: an
   * adapter whose family is NOT RECORDED compared unequal to everything and
   * DISAPPEARED — the app rendering "we do not know" as the verdict "it does not
   * fit", and then counting it in the "installed for a different base model"
   * line, which is a claim about it that is not known to be true. The row's own
   * family can be missing too (`x.family ?? ''` in the status mapper), and the
   * same applies in that direction. partitionAdaptersByFamily hides only a KNOWN
   * mismatch; see its header.
   */
  const adapterPartition = useMemo(
    () => (activeLocalRow
      ? partitionAdaptersByFamily(localAdapters, activeLocalRow.family)
      : { offered: [] as typeof localAdapters, mismatchCount: 0 }),
    [localAdapters, activeLocalRow],
  )
  const compatibleAdapters = adapterPartition.offered
  const compatibleLoras = useMemo(() => compatibleAdapters.filter(a => a.kind === 'lora'), [compatibleAdapters])
  const compatibleVaes  = useMemo(() => compatibleAdapters.filter(a => a.kind === 'vae'),  [compatibleAdapters])
  /** Adapters INSTALLED but not runnable here — counted, never silently hidden. */
  const incompatibleAdapterCount = adapterPartition.mismatchCount
  /** Offered, but with no recorded base model — shown, and SAID so. */
  const unknownFamilyLoraCount = useMemo(
    () => compatibleLoras.filter(a => adapterFamilyVerdict(a.family, activeLocalRow?.family) === 'unknown').length,
    [compatibleLoras, activeLocalRow],
  )

  // A tier the new row does not offer must stop claiming to be active: the
  // picker HIDES for a distilled checkpoint, and a "Quality" chip left selected
  // behind a hidden control is a label with nothing behind it.
  useEffect(() => {
    setActivePerfPreset(prev => (prev && !offeredPresets.some(p => p.id === prev) ? null : prev))
  }, [offeredPresets])

  // Switching checkpoint drops any selection the new one cannot run. Without
  // this the tag would still be emitted and the engine would load a LoRA whose
  // shapes do not match — the exact silent no-op the compat gate exists to stop.
  //
  // …BUT NEVER ON IGNORANCE. `activeLocalRow` is `localRows[model]`, and that map
  // is filled by an ASYNC sd-cpp:status load: for the frames between a Remix
  // pointing `model` at a checkpoint and the status arriving, the row is
  // undefined, `compatibleAdapters` is empty, and this effect used to read that
  // emptiness as "the new checkpoint runs none of them" and wipe the selections
  // Remix had just restored. Now that the selections are persisted, the same
  // window exists on every cold mount. No row ⇒ no verdict ⇒ no prune.
  useEffect(() => {
    if (!activeLocalRow) return
    const ok = new Set(compatibleAdapters.map(a => a.id))
    const prev = useMediaStore.getState().loraWeights
    const next = Object.fromEntries(Object.entries(prev).filter(([id]) => ok.has(id)))
    if (Object.keys(next).length !== Object.keys(prev).length) setSelectedLoras(next)
    const vae = useMediaStore.getState().vaeAdapterId
    if (vae && !ok.has(vae)) setSelectedVae('')
  }, [compatibleAdapters, activeLocalRow, setSelectedLoras, setSelectedVae])

  /** The LoRAs to send: slug + weight, in selection order. */
  const activeLoras = useMemo(
    () => compatibleLoras
      .filter(a => selectedLoras[a.id] !== undefined)
      .map(a => ({ slug: a.slug, weight: selectedLoras[a.id] })),
    [compatibleLoras, selectedLoras],
  )

  /**
   * Apply a performance preset: fills steps / cfg / sampler into the persisted
   * params for the current modality.
   *
   * THE NAMES ARE THE SCHEMA'S (audit D1). This picker used to write `cfgScale`
   * and `samplingMethod` — names nothing else in the app reads — so it was the
   * only thing that ever populated them, the sliders showed something else, and
   * the values that ran were the model row's. One name at both ends now.
   */
  const applyPerfPreset = useCallback((presetId: string) => {
    const tier = offeredPresets.find(p => p.id === presetId)?.params
    if (!tier) return
    setParams(modality, {
      ...params,
      steps:   tier.steps,
      sampler: tier.samplingMethod,
      cfg:     tier.cfgScale,
    })
    setActivePerfPreset(presetId)
  }, [offeredPresets, modality, params, setParams])

  // ── Load the catalog for the selected modality ──────────────────────────────
  const loadModels = useCallback(async (m: SurplusMediaModality) => {
    // The route this load is FOR, captured before the first await, and a request
    // id that a later load invalidates. Everything below is applied only while
    // this is still the newest load — otherwise a slow cloud response repaints
    // the dropdown under a Local chip (and, worse, re-points `model` at a cloud
    // id via the default-selection branch at the bottom).
    const route: MediaRoute = { provider: mediaProvider, modality: m }
    const reqId = modelLoadSeq.current.next()
    const stillCurrent = () => modelLoadSeq.current.isCurrent(reqId)
    setLoadingModels(true)
    setModelsError(null)
    try {
      let res: { ok: boolean; models: SurplusMediaModelInfo[]; error?: string }
      if (mediaProvider === 'local' && m === 'tts') {
        // ENGINE = STUDIO (kokoro): the "models" are its curated voices. Falls
        // back to the piper listing when the kokoro surface is absent.
        const ks = localTtsEngine === 'kokoro'
          ? await window.tachi.kokoro?.status().catch(() => undefined)
          : undefined
        if (localTtsEngine === 'kokoro' && ks) {
          res = {
            ok: ks.installed,
            models: ks.voices.map(v => ({ id: v.id, label: v.label })) as unknown as SurplusMediaModelInfo[],
            error: ks.installed ? (ks.voices.length ? undefined : t('models.error.noLocalVoices')) : t('models.error.installKokoro'),
          }
        } else {
          const s = await window.tachi.piper.status()
          res = {
            ok: s.installed,
            models: s.voices.map(v => ({ id: v.id, label: v.id })) as unknown as SurplusMediaModelInfo[],
            error: s.installed ? (s.voices.length ? undefined : t('models.error.noLocalVoices')) : t('models.error.installPiper'),
          }
        }
      } else if (mediaProvider === 'local') {
        const s = await window.tachi.sdCpp.status()
        const want = m === 'video' ? 'video' : 'image'
        const ms = s.models.filter(x => x.kind === want)
        // The DECLARED family of every installed model, kept for the preset /
        // size logic (see `modelFamily`) — recorded for both modalities, since
        // the dropdown for the other one is one click away.
        setLocalRows(Object.fromEntries(s.models.map(x => [x.id, {
          family: x.family ?? '', steps: x.steps ?? 20, cfgScale: x.cfgScale ?? 7, samplingMethod: x.samplingMethod ?? 'euler',
        }])))
        setLocalAdapters(s.adapters ?? [])
        setLocalLoraNames(s.loraNames ?? [])
        res = {
          ok: s.installed,
          // label = the row's NAME. This used to be `x.id`, so the dropdown read
          // 'sd-turbo' / 'wan21-t2v-1.3b' — and a user-installed model would
          // have read 'civitai-812345'. `|| x.id` keeps a stale preload honest
          // rather than blank.
          models: ms.map(x => ({ id: x.id, label: x.name || x.id })) as unknown as SurplusMediaModelInfo[],
          error: s.installed ? (ms.length ? undefined : t('models.error.noLocalModels', { kind: want })) : t('models.error.installSdCpp'),
        }
      } else if (mediaProvider === 'venice') {
        const v = await window.tachi.venice.listMediaModels({ modality: m as 'image' | 'tts' | 'stt' | 'video' | 'music' })
        res = { ok: v.ok, models: v.models as SurplusMediaModelInfo[], error: v.error }
      } else if (mediaProvider === 'imgnai') {
        // imgnAI Katana covers image + video only (static catalog, enriched live).
        if (m !== 'image' && m !== 'video') {
          res = { ok: true, models: [], error: t('models.error.noImgnai') }
        } else {
          const r = await window.tachi.imgnaiMedia.listModels({ modality: m })
          res = { ok: r.ok, models: r.models as SurplusMediaModelInfo[], error: r.error }
        }
      } else if (mediaProvider === 'pollinations') {
        // Pollinations is image-only AND keyless: the live list ("sana") falls
        // back to a static snapshot in main, so a fresh install — even offline —
        // always has a model here. Nothing to configure is the whole point.
        if (m !== 'image') {
          res = { ok: true, models: [], error: t('models.error.noPollinations') }
        } else {
          const r = await window.tachi.pollinationsMedia.listModels({})
          res = { ok: r.ok, models: r.models as unknown as SurplusMediaModelInfo[], error: r.error }
        }
      } else {
        res = await window.tachi.surplusMedia.listModels({ modality: m })
      }
      // SUPERSEDED — a later load (a different modality, a different provider)
      // has already been issued. Dropping the whole apply is the point: painting
      // a stale list is the visible half of the bug, and re-defaulting `model`
      // from it is the half that silently changes what GENERATE would run.
      if (!stillCurrent()) return
      if (!res.ok) { setModels([]); setModelsRoute(route); setModelsError(res.error ?? t('models.error.couldNotLoad')); return }
      setModels(res.models)
      setModelsRoute(route)
      if (res.models.length === 0) setModelsError(res.error ?? (mediaProvider === 'venice' ? t('models.error.noVenice') : mediaProvider === 'imgnai' ? t('models.error.noImgnai') : mediaProvider === 'pollinations' ? t('models.error.noPollinations') : t('models.error.noSurplus')))
      // Keep the persisted model if still valid; else default to the first.
      const current = useMediaStore.getState().modelByModality[m]
      if (!current || !res.models.some(x => x.id === current)) {
        setModel(m, res.models[0]?.id ?? '')
      }
    } catch (err) {
      if (!stillCurrent()) return
      setModels([])
      setModelsRoute(route)
      setModelsError(err instanceof Error ? err.message : String(err))
    } finally {
      // A superseded load must not clear the spinner the CURRENT one put up.
      if (stillCurrent()) setLoadingModels(false)
    }
  }, [setModel, mediaProvider, t, localTtsEngine])

  useEffect(() => { loadModels(modality) }, [modality, loadModels])

  // A provider that cannot serve the modality the user just picked is the ONE
  // legitimate reason to move the chip — and it is announced. Local covers
  // image/video/tts (sd.cpp + piper/kokoro), imgnAI image/video; everything
  // else falls back to Surplus. This used to flip silently, which is
  // indistinguishable from the remount bug it now shares a lane with.
  useEffect(() => {
    const { provider: usable, fellBack } = resolveProviderForModality(mediaProvider, modality)
    if (!fellBack) return
    setMediaProvider(usable)
    showToast({ kind: 'info', text: t('toast.providerFellBack', {
      // Brand spellings ('imgnAI', 'Pollinations') come from one helper.
      provider: mediaProviderLabel(mediaProvider),
      modality: t(`modalities.${modality}`),
    }) })
  }, [modality, mediaProvider, setMediaProvider, t])

  /** Re-read sd.cpp status + catalog. Published by the effect below (which owns
   *  the real reader) for the click handlers, which live outside it and must not
   *  keep a second copy. A no-op before it has run, or while the Local provider
   *  is not the active one. */
  const refreshSdPanel = useRef<() => void>(() => {})

  /**
   * WHAT THIS MACHINE HAS, for the fits-line under the download rows.
   *
   * Fetched here rather than read off the catalog store because that store is
   * the Catalog TAB's, and a Media-tab visit must not depend on whether the user
   * has opened Catalog yet (its profile is populated by that page's own mount
   * effect). `catalog:hardware` shells out to WMI/nvidia-smi and takes ~2 s, so
   * it is fired once per mount and never awaited by anything that renders — the
   * rows draw immediately and the line appears when the probe lands.
   *
   * Null is a first-class answer: an unknown machine gets NO verdict, because
   * "amber" would be a claim about a number we do not have.
   */
  const [hardware, setHardware] = useState<{ vramFreeBytes: number | null; ramTotalBytes: number } | null>(null)
  useEffect(() => {
    let cancelled = false
    window.tachi.catalog?.hardware?.()
      .then(hw => {
        if (cancelled || !hw) return
        setHardware({ vramFreeBytes: hw.vramFreeBytes ?? null, ramTotalBytes: hw.ramTotalBytes ?? 0 })
      })
      .catch(() => { /* no probe ⇒ no line, which is the honest default */ })
    return () => { cancelled = true }
  }, [])

  // Local engine: load install status + curated models, and stream install /
  // download progress, while the Local provider is active.
  useEffect(() => {
    if (mediaProvider !== 'local') return
    let cancelled = false
    const refresh = async () => {
      try {
        const [s, c] = await Promise.all([window.tachi.sdCpp.status(), window.tachi.sdCpp.catalog()])
        if (!cancelled) {
          setSdInstalled(s.installed)
          setSdEngineStale(s.engine?.updateAvailable === true)
          setLocalRows(Object.fromEntries(s.models.map(x => [x.id, {
            family: x.family ?? '', steps: x.steps ?? 20, cfgScale: x.cfgScale ?? 7, samplingMethod: x.samplingMethod ?? 'euler',
          }])))
          setLocalAdapters(s.adapters ?? [])
          setLocalLoraNames(s.loraNames ?? [])
          // `files` is kept (it used to be dropped here): each one names the
          // other rows declaring the same bytes, which is what lets the download
          // button quote the INCREMENTAL size instead of the full total —
          // and `onDiskMb` is this row's OWN interrupted bytes, which is what
          // lets it say RESUME instead of pretending it was never started.
          // `minVramGb` / `minRamGb` are kept for the same reason `files` and
          // the licence fields are: they were dropped here, so W4-A's numbers
          // reached the Catalog card and not the panel that actually spends the
          // bytes. See mediaFitLine for why they are compared rather than
          // computed, and why an absent one stays absent.
          if (c.ok) setSdModels(c.models.map(mm => ({
            id: mm.id, name: mm.name, sizeMbTotal: mm.sizeMbTotal, notes: mm.notes, kind: mm.kind,
            licenseName: mm.licenseName, licenseUrl: mm.licenseUrl,
            minVramGb: mm.minVramGb, minRamGb: mm.minRamGb,
            files: (mm.files ?? []).map(f => ({ sizeMb: f.sizeMb, sharedWith: f.sharedWith, onDiskMb: f.onDiskMb })),
          })))
          if (c.ok) {
            setSdSpeedPacks((c.speedAdapters ?? []).map(a => ({
              id: a.id, modelId: a.modelId, name: a.name, sizeMbTotal: a.sizeMbTotal,
              installed: a.installed, notes: a.notes,
              files: (a.files ?? []).map(f => ({ sizeMb: f.sizeMb, sharedWith: f.sharedWith ?? [] })),
            })))
            setSdSpeedBlocked(c.blockedSpeedAdapters ?? [])
            setSdIpAdapters((c.ipAdapters ?? []).map(a => ({
              id: a.id, name: a.name, family: a.family, sizeMbTotal: a.sizeMbTotal,
              installed: a.installed, notes: a.notes,
              files: (a.files ?? []).map(f => ({ sizeMb: f.sizeMb, sharedWith: f.sharedWith ?? [] })),
            })))
            setSdIpAdapterBlocked(c.blockedIpAdapters ?? {})
          }
          // The release rows were already on this payload and were dropped here
          // — the same omission `files` had. They are what lets the INSTALL
          // button quote a size instead of ambushing a metered connection.
          if (c.ok) setSdReleases(Array.isArray(c.releases) ? c.releases : [])
        }
      } catch { /* ignore */ }
      try {
        const [ps, pc] = await Promise.all([window.tachi.piper.status(), window.tachi.piper.catalog()])
        if (!cancelled) {
          setPiperInstalled(ps.installed)
          if (pc.ok) setPiperVoices(pc.voices.map(v => ({ id: v.id, name: v.name, sizeMb: v.sizeMb })))
          if (pc.ok) setPiperReleases(Array.isArray(pc.releases) ? pc.releases : [])
        }
      } catch { /* ignore */ }
      try {
        const ks = await window.tachi.kokoro?.status()
        if (!cancelled) setKokoroInstalled(ks ? ks.installed : null)
      } catch { if (!cancelled) setKokoroInstalled(null) }
    }
    void refresh()
    const onProg = (p: { stage: string; message: string; percent: number; speedBytesPerSec?: number; etaSec?: number }) => {
      if (cancelled) return
      if (p.stage === 'done') {
        setSdProgress(null); setEngineError(null)
        // The shared install-progress channel carries no model id, so whether
        // to flip modality rides entirely on what THIS panel last started
        // downloading (audit 1C-3) — read it before clearing.
        const finished = downloadingSdRowRef.current
        downloadingSdRowRef.current = null
        const flip = shouldFlipModalityOnDownloadDone(finished, modality)
        void refresh()
        if (flip) {
          setModality(flip.modality)
          if (finished) setModel(flip.modality, finished.id)
          showToast({ kind: 'info', text: t('local.modalitySwitched', { modality: t(`modalities.${flip.modality}`) }) })
          loadModels(flip.modality)
        } else {
          loadModels(modality)
        }
      }
      // A FAILURE HAS TO LEAVE SOMETHING BEHIND. The toast is the part the user
      // sees NOW; the refresh is the part that survives them walking away — it
      // re-reads what is on disk, so the row that just died renders its RESUME
      // state instead of reverting to the virgin download label (driver rows5:
      // the TI2V install died twice and the panel looked untouched both times).
      else if (p.stage === 'error') { setSdProgress(null); downloadingSdRowRef.current = null; showToast({ kind: 'error', text: p.message }); void refresh() }
      else {
        const parts = [p.message]
        if (p.percent >= 0) parts.push(`${p.percent}%`)
        const speed = fmtBytesPerSec(p.speedBytesPerSec ?? 0)
        if (speed) parts.push(speed)
        const eta = fmtEta(p.etaSec ?? -1)
        if (eta) parts.push(`ETA ${eta}`)
        setSdProgress(parts.join(' — '))
      }
    }
    refreshSdPanel.current = () => { void refresh() }
    const offSd = window.tachi.sdCpp.onInstallProgress(onProg)
    const offPiper = window.tachi.piper.onInstallProgress(onProg)
    return () => { cancelled = true; offSd(); offPiper() }
  }, [mediaProvider, modality, loadModels, setModality, setModel, t])

  /**
   * Start (or RESUME) one model's download.
   *
   * `sd-cpp:download-model` RESOLVES with `{ ok:false, error }` — it never
   * throws — so the old `.catch(() => {})` here discarded every failure that
   * came back through the promise instead of the event channel. The driver's
   * TI2V install died twice with nothing on screen either way; this is the
   * belt to the progress handler's braces, and it re-reads the disk afterwards
   * so the row settles into RESUME rather than back to the virgin label.
   */
  const downloadSdRow = useCallback(async (id: string, name: string, kind: 'image' | 'video'): Promise<{ ok: boolean; error?: string }> => {
    // Recorded BEFORE the await: the terminal 'done'/'error' progress event
    // carries no model id, so this is the only record of which row (and which
    // KIND) this download was for — the flip-modality check above reads it.
    downloadingSdRowRef.current = { id, kind }
    setSdProgress(t('progress.downloading', { name }))
    try {
      const res = await window.tachi.sdCpp.downloadModel(id)
      const text = downloadRowFailureText(res, t('local.installFailed'))
      if (text) {
        setSdProgress(null)
        showToast({ kind: 'error', text })
        // The verdict is RETURNED as well as toasted: the zero-config chain has
        // to know whether to keep walking, and it must read the same answer this
        // button acts on rather than re-deciding from its own call.
        return { ok: false, error: text }
      }
      return { ok: true }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      setSdProgress(null)
      showToast({ kind: 'error', text })
      return { ok: false, error: text }
    } finally {
      refreshSdPanel.current()
    }
  }, [t])

  /**
   * Download one piper voice. `piper:download-voice` resolves `{ ok:false,
   * error }` on failure rather than throwing (audit 1C-2) — the button used
   * to fire-and-forget with `.catch(() => {})`, which only ever caught the
   * rejection half and left a bad download parked on "downloading…" forever
   * with nothing on screen. Same shape as downloadSdRow, above.
   */
  const downloadVoiceRow = useCallback(async (id: string, name: string) => {
    setSdProgress(t('progress.downloading', { name }))
    try {
      const res = await window.tachi.piper.downloadVoice(id)
      const text = downloadRowFailureText(res, t('local.installFailed'))
      if (text) {
        setSdProgress(null)
        showToast({ kind: 'error', text })
      }
    } catch (err) {
      setSdProgress(null)
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      refreshSdPanel.current()
    }
  }, [t])

  /** Download one curated speed pack. Same swallowed-`{ok:false}` bug as the
   *  voice button above (audit 1C-2), same fix. */
  const downloadSpeedPackRow = useCallback(async (id: string, name: string) => {
    setSdProgress(t('progress.downloading', { name }))
    try {
      const res = await window.tachi.sdCpp.downloadSpeedAdapter(id)
      const text = downloadRowFailureText(res, t('local.installFailed'))
      if (text) {
        setSdProgress(null)
        showToast({ kind: 'error', text })
      }
    } catch (err) {
      setSdProgress(null)
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      refreshSdPanel.current()
    }
  }, [t])

  /** Download the reference-image weights for the active row's family. Same
   *  inspected-`{ok:false}` shape as the speed pack above, same reason. */
  const downloadIpAdapterRow = useCallback(async (id: string, name: string) => {
    setSdProgress(t('progress.downloading', { name }))
    try {
      const res = await window.tachi.sdCpp.downloadIpAdapter(id)
      const text = downloadRowFailureText(res, t('local.installFailed'))
      if (text) {
        setSdProgress(null)
        showToast({ kind: 'error', text })
      }
    } catch (err) {
      setSdProgress(null)
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      refreshSdPanel.current()
    }
  }, [t])

  // ── Local engine install (sd.cpp / piper) ───────────────────────────────────
  // Both IPCs return { ok, error? } rather than throwing, so the result MUST be
  // inspected: on failure the message lands inline next to the button with a
  // RETRY affordance (plus a toast), never in a swallowed .catch().
  // …and the verdict is RETURNED as well as rendered, for the same reason
  // downloadSdRow returns one: the zero-config chain must not re-decide whether
  // an install worked from a second call of its own.
  // useCallback so the zero-config chain (which depends on it) is not rebuilt on
  // every keystroke — `t` is the only thing here that ever changes.
  /**
   * Swap the installed sd-cli onto the pinned release.
   *
   * Deliberately NOT `installEngine`: that call short-circuits the moment a
   * binary exists, which is the whole reason a bumped pin never reached an
   * existing install. Main picks the right asset for this machine's backend and
   * verifies its sha before the swap, so there is nothing to choose here.
   */
  const updateEngine = async () => {
    setUpdatingEngine(true)
    try {
      const r = await window.tachi.sdCpp.updateEngine()
      if (r.ok) {
        setSdEngineStale(false)
      } else {
        window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'error', text: r.error } }))
      }
    } catch (err) {
      window.dispatchEvent(new CustomEvent('tachi:toast', { detail: { kind: 'error', text: err instanceof Error ? err.message : String(err) } }))
    } finally {
      setUpdatingEngine(false)
    }
  }

  const installEngine = useCallback(async (engine: 'sdcpp' | 'piper'): Promise<{ ok: boolean; error?: string }> => {
    setEngineError(null)
    setSdProgress(t('progress.starting'))
    const fail = (msg: string): { ok: false; error: string } => {
      const text = msg.trim() || t('local.installFailed')
      setEngineError({ engine, msg: text })
      setSdProgress(null)
      showToast({ kind: 'error', text })
      return { ok: false, error: text }
    }
    try {
      const res = engine === 'sdcpp'
        ? await window.tachi.sdCpp.install()
        : await window.tachi.piper.install()
      if (res && (res as { ok?: boolean }).ok === false) {
        return fail((res as { error?: string }).error ?? '')
      }
      setSdProgress(null)
      return { ok: true }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }, [t])

  /** Inline install-failure row: the error text + a RETRY button. */
  const engineErrorRow = (engine: 'sdcpp' | 'piper') => (
    engineError?.engine === engine ? (
      <div style={{
        border: '2px solid var(--danger, #c00)', padding: 6, display: 'flex',
        flexDirection: 'column', gap: 4,
      }}>
        <span style={{ fontSize: 9, color: 'var(--danger, #c00)', wordBreak: 'break-word', lineHeight: 1.4 }}>
          {engineError.msg}
        </span>
        <button onClick={() => void installEngine(engine)} style={{ ...btnStyle, width: '100%' }}>
          {t('local.retryInstall')}
        </button>
      </div>
    ) : null
  )

  // ── STUDIO VOICES (kokoro) one-time model download ──────────────────────────
  // Honest progress: 'kokoro:progress' events when the preload exposes them,
  // plus a kokoro:status poll (status carries downloading/progress) as fallback.
  const downloadKokoro = async () => {
    if (kokoroBusy || !window.tachi.kokoro) return
    setKokoroBusy(true)
    setKokoroPct(0)
    const offEvents = subscribeKokoroProgress(p => {
      setKokoroPct(prev => Math.max(prev, Math.min(1, Math.max(0, p.progress))))
    })
    const poll = window.setInterval(() => {
      window.tachi.kokoro?.status()
        .then(s => { if (typeof s.progress === 'number') setKokoroPct(prev => Math.max(prev, Math.min(1, s.progress ?? 0))) })
        .catch(() => {})
    }, 1000)
    try {
      const r = await window.tachi.kokoro.ensure()
      if (!r.ok) throw new Error(r.error || t('local.kokoro.downloadFailed'))
      setKokoroInstalled(true)
      loadModels('tts') // the voice list is the model list for STUDIO
    } catch (err) {
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      window.clearInterval(poll)
      offEvents()
      setKokoroBusy(false)
    }
  }

  // ── Re-fetch the param schema whenever (modality, model) changes ────────────
  useEffect(() => {
    let cancelled = false
    if (!model) { setSchema([]); return }
    setLoadingSchema(true)
    window.tachi.surplusMedia.modelParams({ modality, modelId: model })
      .then(res => {
        if (cancelled) return
        setSchema(res.params)
        // Seed unset params with their schema defaults AND heal the ones this
        // schema excludes — params persist per modality, so a cloud run's 10 s /
        // 1080p arrives selected in a local composer that offers neither.
        const existing = useMediaStore.getState().paramsByModality[modality] ?? {}
        // …unless this exact bag was written by an explicit restore/remix: that
        // is provenance, and ParamFields' out-of-enum display exists to show it.
        // Identity, not a flag: any later edit replaces the object (setParam
        // spreads a new one), which drops the exemption on its own.
        const explicit = explicitParamsRef.current === existing
        // A CHECKPOINT SWITCH re-seeds the params the ROW owns (steps / cfg /
        // sampler): their spec default IS the new row's own recipe, which is
        // what the Steps hint already tells the user is happening. Without this
        // the bounds and the hint re-derived while the VALUE stayed — SD-Turbo's
        // 1 step / euler ran on a 20-step checkpoint and produced mush, out of
        // sight inside a collapsed Advanced disclosure. In-range and in-enum, so
        // healParamsForSchema below could never catch it.
        //
        // Only on a real switch: a remount, or a re-fetch for the SAME model,
        // must keep what the user set. No provider gate is needed FOR THE THREE
        // — a cloud schema declares no defaults for them, so it is a no-op there.
        //
        // SIZE is the exception, and the reason the list is chosen per route:
        // its spec default is the row's native grid on a local checkpoint (the
        // second half of the same driver finding — 512x512 survived a switch to
        // a 1024-native row and rendered a quarter of the area), but every CLOUD
        // image schema declares a `size` default too, so re-seeding it there
        // would throw away a deliberate 1536x1536 on each model change.
        //
        // The provider is READ FROM THE STORE rather than added to this effect's
        // deps: it already persists there (mediaProviderPersistence), and a dep
        // would re-fetch the whole schema on every chip toggle.
        const rowOwned = useMediaStore.getState().provider === 'local'
          ? LOCAL_ROW_OWNED_PARAMS
          : RECIPE_OWNED_PARAMS
        const priorModel   = seededForModelRef.current[modality]
        const modelChanged = priorModel !== undefined && priorModel !== model
        seededForModelRef.current[modality] = model
        const reseed = modelChanged && !explicit
          ? reseedRecipeParams(existing, res.params, rowOwned)
          : { next: existing, changed: false }
        const healed = healParamsForSchema(reseed.next, res.params, { healExcluded: !explicit })
        const next    = healed.next
        const changed = reseed.changed || healed.changed
        if (changed) setParams(modality, next)
        // Seeding rewrote the bag, so re-pin the exemption onto what is in the
        // store now — otherwise a second schema arrival for the same restore
        // (the catalog reload can re-pick the model) would heal the provenance
        // away. Any real user edit still replaces the object and drops it.
        if (explicit) explicitParamsRef.current = changed ? next : existing
      })
      .catch(err => { if (!cancelled) showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) }) })
      .finally(() => { if (!cancelled) setLoadingSchema(false) })
    return () => { cancelled = true }
  }, [modality, model, setParams])

  const shownSchema  = useMemo(() => {
    const visible = visibleSchema(modality, schema)
    // Pollinations' GET carries only prompt / size / seed — the curated image
    // schema's other controls (steps, cfg, sampler, negative, n, init image)
    // would render and do nothing, the audit-D1 class. Hidden, not ignored.
    return mediaProvider === 'pollinations' ? pollinationsVisibleSchema(visible) : visible
  }, [modality, schema, mediaProvider])
  const promptKey    = useMemo(() => promptKeyFor(schema), [schema])
  /** The resolved-route line, from ONE snapshot — see the render note below. */
  const routeEcho = useMemo(
    () => resolveRouteEcho(
      { provider: mediaProvider, modality },
      model,
      modelsRoute ? { route: modelsRoute, models } : null,
    ),
    [mediaProvider, modality, model, modelsRoute, models],
  )

  // ── THE FUNNEL, WIRED ───────────────────────────────────────────────────────

  /** Move the whole route to the free local engine — the one-click answer to a
   *  key/funding dead end. The stale cloud failure is DISMISSED with it: a red
   *  row about a Surplus key under a LOCAL composer is the same staleness the
   *  route echo exists to prevent. */
  const switchToLocal = useCallback(() => {
    setMediaProvider('local')
    clearRunError()
    showToast({ kind: 'info', text: t('local.switchedToast') })
  }, [setMediaProvider, clearRunError, t])

  /** Beside the model picker's empty/failed state — structural, never string-matched. */
  const offerLocalSwitchForCatalog = canOfferLocalSwitch(mediaProvider, modality)
  /** Beside a settled run's failure row — main's own sentence is the evidence. */
  const offerLocalSwitchForRun = shouldOfferLocalSwitchOnFailure({
    provider: mediaProvider, modality, message: genError,
  })

  /** Mac vs Windows, the same read four other surfaces already use — only ever
   *  to pick which release rows to price, never to decide what gets installed. */
  const isMacUi = useMemo(
    () => typeof navigator !== 'undefined'
      && /mac/i.test(((navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform) ?? navigator.platform),
    [],
  )
  const sdEngineQuote    = useMemo(() => engineDownloadQuoteMb(sdReleases, isMacUi),    [sdReleases, isMacUi])
  const piperEngineQuote = useMemo(() => engineDownloadQuoteMb(piperReleases, isMacUi), [piperReleases, isMacUi])
  /** "~23 MB" / "23–883 MB" — one build or a range, both ends measured. */
  const engineSizeText = useCallback((q: EngineSizeQuote | null): string | null => {
    if (!q) return null
    return q.minMb === q.maxMb
      ? t('local.engineSizeOne', { size: q.minMb })
      : t('local.engineSizeRange', { min: q.minMb, max: q.maxMb })
  }, [t])

  /** The starter row, as the catalog prices it for THIS disk. */
  const starterRow = useMemo(() => sdModels.find(m => m.id === FIRST_IMAGE_STARTER_ID), [sdModels])
  const starterSizeGb = useMemo(() => {
    if (!starterRow) return null
    return gbLabel(sdDownloadSize({ files: starterRow.files ?? [], installedIds: installedSdIds }).incrementalMb)
  }, [starterRow, installedSdIds])

  const offerFirstImage = shouldOfferFirstImage({
    provider: mediaProvider,
    modality,
    sdInstalled,
    // The composer's own list: for local+image it IS the installed image set.
    installedImageModelCount: models.length,
    loadingModels,
    busy,
    chainInPlay: chain !== null,
  })

  /** Where the running journey is, for the one combined progress line. */
  const chainPosition = useMemo(() => {
    if (!chain) return null
    const index = chain.steps.indexOf(chain.failed?.step ?? chain.step)
    return { index: (index < 0 ? 0 : index) + 1, total: chain.steps.length }
  }, [chain])

  /**
   * ONE LINE FOR THE WHOLE JOURNEY, in the row that already existed.
   *
   * Install, download and render each report through their own channel
   * (`sd-cpp:install-progress` twice over, then the gen ticks in the store), and
   * three unrelated lines appearing in sequence is not a journey — it is three
   * things happening to you. The step counter is the frame; the engine's own
   * words stay verbatim inside it.
   */
  const localProgressLine = useMemo(() => {
    if (!chain || chain.failed || !chainPosition) return sdProgress
    return t('firstRun.progress', {
      step:  chainPosition.index,
      total: chainPosition.total,
      label: t(`firstRun.step.${chain.step}`),
      line:  sdProgress ?? progress ?? t('progress.starting'),
    })
  }, [chain, chainPosition, sdProgress, progress, t])

  /**
   * Run — or RESUME — the zero-config first image.
   *
   * The plan comes from `sd-cpp:status`, i.e. from DISK, not from this
   * component's snapshot: after a failed weights step the React state is a
   * refresh behind, and a plan built from it would try to install an engine that
   * is already there. Each leg reuses the SAME function its own button uses, so
   * the inline failure row, the toast and the RESUME state of the download row
   * are all exactly what a manual click produces.
   */
  const runFirstImage = useCallback(async () => {
    const failAt = (steps: FirstImageStep[], step: FirstImageStep, message: string) => {
      setChain({ steps, step, failed: { step, message: message.trim() || t('local.installFailed') } })
    }
    let plan: FirstImageStep[]
    try {
      const s = await window.tachi.sdCpp.status()
      plan = firstImagePlan({
        sdInstalled:      s.installed,
        starterInstalled: s.models.some(m => m.id === FIRST_IMAGE_STARTER_ID),
      })
    } catch (err) {
      // Not even the disk answered — that is a first leg that failed, and it is
      // shown as one rather than as a click that did nothing.
      failAt(['engine', 'weights', 'generate'], 'engine', err instanceof Error ? err.message : String(err))
      return
    }
    for (const step of plan) {
      setChain({ steps: plan, step })
      if (step === 'engine') {
        const res = await installEngine('sdcpp')
        if (!res.ok) { failAt(plan, step, res.error ?? ''); return }
      } else if (step === 'weights') {
        const res = await downloadSdRow(FIRST_IMAGE_STARTER_ID, starterRow?.name ?? FIRST_IMAGE_STARTER_ID, 'image')
        if (!res.ok) { failAt(plan, step, res.error ?? ''); return }
      } else {
        // THE HANDOFF. Point the composer at the starter row, give it a prompt if
        // the user has not, and let the effect below fire Generate once the model
        // list and the param schema have actually landed.
        setModality('image')
        setModel('image', FIRST_IMAGE_STARTER_ID)
        // `promptKey` is null on the FIRST click (no model ⇒ no schema yet), and
        // the local image schema's own key is `prompt` (CURATED_SCHEMA) — the
        // fallback is that name, not a guess. The waiting effect re-checks the
        // key once the real schema lands.
        const key = promptKey ?? 'prompt'
        const seeded = firstImageSeedPrompt(
          (useMediaStore.getState().paramsByModality.image ?? {})[key],
          PROMPT_PRESETS.image?.[0]?.text ?? '',
        )
        if (seeded) setParam('image', key, seeded)
        setChainAwaitingGenerate(true)
      }
    }
  }, [t, installEngine, downloadSdRow, starterRow, promptKey, setModality, setModel, setParam])

  // ── Async (video/music) poll loop with a 5-min cap ──────────────────────────
  // Returns artifacts on success, or an `error` string (job failed / timed out)
  // so the caller can surface a PERSISTENT failed entry — a long-queued job that
  // fails (e.g. a Surplus-side upstream error) must not be a missed toast.
  const pollUntilSettled = async (jobId: string): Promise<{ artifacts?: Artifact[]; error?: string }> => {
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      const res = await window.tachi.surplusMedia.pollJob({ jobId })
      if (res.status === 'succeeded') return { artifacts: res.artifacts ?? [] }
      if (res.status === 'failed') {
        const msg = res.error ?? t('toast.jobFailed')
        showToast({ kind: 'error', text: msg })
        return { error: msg }
      }
      setRunProgress(typeof res.progress === 'number' ? `${Math.round(res.progress * 100)}%` : res.status)
      await new Promise(r => setTimeout(r, 3000))
    }
    const timeoutMsg = t('toast.timedOut')
    showToast({ kind: 'warning', text: timeoutMsg })
    return { error: timeoutMsg }
  }

  // ── Generate ─────────────────────────────────────────────────────────────────
  const generate = async () => {
    if (busy || !model) return
    const promptText = promptKey ? String(params[promptKey] ?? '').trim() : ''

    if (modality === 'stt') {
      if (!sttFile) { showToast({ kind: 'error', text: t('toast.chooseAudio') }); return }
    } else {
      // Block on required text params (the prompt/input).
      const missing = shownSchema.find(s => s.required && (s.kind === 'text' || s.kind === 'string')
        && String(params[s.name] ?? '').trim() === '')
      if (missing) { showToast({ kind: 'error', text: t('toast.enterField', { field: missing.label.toLowerCase() }) }); return }
    }

    // The run state is the STORE's, not this component's — a tab switch used to
    // unmount it and show an idle GENERATE while sd-cli held the GPU. Only a
    // LOCAL sd.cpp render has a child process we can kill, so only that one
    // advertises Stop.
    beginRun({ cancellable: mediaProvider === 'local' && (modality === 'image' || modality === 'video') })
    const entryId = globalThis.crypto.randomUUID()
    const dir = autoSaveDir ?? undefined
    // Snapshot the params so an entry's Remix restores exactly this run.
    const runParams = { ...params }
    /**
     * …and the three composer selections that are NOT params, because Remix
     * without them reproduces a different image: the style rewrites the prompt
     * that is sent, the LoRAs are `<lora:…>` tags appended to it, and the VAE
     * changes the decode. The entry recorded neither, so the button that exists
     * to reproduce a result could not.
     *
     * Applied to the ENTRY's bag only, never to `runParams` — the cloud
     * providers are handed `params: runParams` verbatim and must not receive a
     * key describing a local checkpoint's adapters.
     */
    const localSelections = { style: activeStyle, loras: selectedLoras, vae: selectedVae }
    try {
      const venice = mediaProvider === 'venice'
      if (modality === 'image') {
        let artifacts: Artifact[]
        /** What the ENTRY records — runParams, plus anything the engine told us
         *  afterwards that the request could not know (the real seed). */
        let entryParams = runParams
        /** Pollinations only: the fetch was already in flight when PRIVATE MODE
         *  was engaged, so this entry's file was written after the flip — see
         *  pollinations-media.ts's "neighbouring case". */
        let completedAfterPrivate: boolean | undefined
        if (mediaProvider === 'local') {
          // Apply the active style preset: wraps the user prompt + appends any
          // negative. (style 'none' is a pass-through that leaves prompt intact.)
          const styleObj = SD_STYLES.find(s => s.id === activeStyle) ?? SD_STYLES[0]
          // ONE rule for the negative on every local assembly (canvas node, this
          // image call, the video call below): the resolver with the ROW's own
          // default as fallback. This site used to read `runParams.negative_prompt`
          // raw — no legacy `negative` key, no absent-vs-cleared distinction, and
          // no row default when the schema effect had not seeded the bag yet (a
          // failed fetch, or GENERATE before it resolved). `shownSchema` on
          // purpose: a control the user cannot see must not condition the run.
          const existingNeg = resolveLocalNegative(runParams, schemaNegativeDefault(shownSchema))
          const { positive: styledPrompt, negative: styledNeg } = applyStyle(styleObj, promptText, existingNeg)
          // The composer's SIZE is a "WxH" string — parse it into the numeric
          // -W/-H sd-cli wants, or the dropdown is silently ignored and every
          // image comes out at the model's baseSize.
          // …and the REFERENCE IMAGE is a data: URL under `image_url`, which
          // main turns into the `-i <path>` sd-cli takes. Without it the picker
          // (and its thumbnail) drove nothing and every run was pure txt2img.
          const initImg = resolveLocalInitImage(runParams, schemaOffersInitImage(shownSchema))
          const r = await window.tachi.sdCpp.generate({
            modelId: model,
            prompt: styledPrompt,
            ...(styledNeg ? { negative: styledNeg } : {}),
            ...resolveLocalSdSize(runParams),
            ...initImg,
            ...resolveLocalStrength(runParams, initImg.initImage !== undefined),
            ...(typeof runParams.seed === 'number' ? { seed: runParams.seed } : {}),
            // steps / cfg / sampler under the SCHEMA's names (audit D1): the
            // reads this replaces were `runParams.cfgScale` /
            // `runParams.samplingMethod`, keys only the preset picker ever wrote,
            // so both controls were decorative on every local model.
            ...resolveLocalGenParams(runParams),
            // `n` → --batch-count and the hires toggle, both live in the
            // schema since W3-A; without these two spreads the controls are
            // decorative (n=4 yields 1 image) — the exact D1 class again.
            ...resolveLocalBatch(runParams),
            ...resolveLocalHires(runParams),
            // …and the same rule for the advanced group: CLIP skip and the
            // low-VRAM ladder. A schema that renders five toggles the payload
            // does not carry is the D1 class freshly minted, so these two spreads
            // land with the controls, not after them.
            // …gated on the LIVE schema still offering it, exactly like the init
            // frame above: the bag is persisted per modality and this control only
            // exists on the CLIP families, so a 2 set for an SD 1.5 merge would
            // otherwise ride onto a Z-Image run from a control that is no longer
            // on screen.
            ...resolveLocalClipSkip(runParams, schemaOffersClipSkip(shownSchema)),
            // THE REFERENCE IMAGE (IP-Adapter), gated the same way and for a
            // sharper version of the same reason: this control exists only while
            // compatible weights are on disk, so a path left in the bag by a row
            // that had them would otherwise travel with a row that does not.
            ...resolveLocalIpAdapter(runParams, schemaOffersIpAdapter(shownSchema)),
            ...resolveLocalMemoryFlags(runParams),
            // `<lora:slug:weight>` goes in the PROMPT (there is no --lora flag);
            // main builds the tag from these so the composer and the engine
            // cannot disagree about the syntax.
            ...(activeLoras.length > 0 ? { loras: activeLoras } : {}),
            ...(selectedVae ? { vaeAdapterId: selectedVae } : {}),
          })
          // ONE entry with N artifacts — the cloud n>1 pattern; each image
          // carries its own seed in its own tEXt chunk (engine-verified).
          const localImages = localImagesOf(r)
          if (!r.ok || localImages.length === 0) throw new Error(r.error || 'Local generation failed')
          artifacts = localImages.map(i => ({ kind: 'image', mimeType: i.mime, path: i.path, b64: i.b64 } as Artifact))
          // The engine's own seed, not the -1 we asked with — so Remix
          // reproduces the image instead of re-rolling a new one…
          entryParams = stampLocalSeed(entryParams, localImages[0].seed)
          // …and the recipe it was actually given, for the same reason: a row
          // whose own steps/cfg out-voted an empty composer left the entry
          // describing numbers nothing ran at.
          entryParams = stampLocalEngineParams(entryParams, r.effective)
          // …and the style / LoRAs / VAE that shaped the prompt and the decode.
          entryParams = stampLocalSelections(entryParams, localSelections)
          // …and the dead `aspect_ratio` a cloud run (or an older session) left
          // in the bag: the local IMAGE schema drops the control entirely (`size`
          // already carries orientation), so a stale ratio next to the real size
          // reads as a lie rather than an unused field.
          entryParams = withoutLocalImageAspectRatio(entryParams)
        } else if (mediaProvider === 'imgnai') {
          // imgnAI Katana — async server-side; MAIN submits + polls (≤600s) and
          // resolves with on-disk artifacts. Progress ticks via onGenProgress.
          setRunProgress(t('progress.queuedImgnai'))
          const ref = typeof runParams.image_url === 'string' && runParams.image_url.trim() ? [runParams.image_url.trim()] : undefined
          artifacts = (await window.tachi.imgnaiMedia.generateImage({
            model,
            prompt: promptText,
            aspectRatio: typeof runParams.aspect_ratio === 'string' ? runParams.aspect_ratio : undefined,
            imageUrls: ref,
            autoSaveDir: dir,
          })).artifacts
        } else if (mediaProvider === 'pollinations') {
          // Pollinations — keyless CLOUD GET. MAIN paces every request behind
          // their 1-per-15s anonymous limit (a 'queued' tick, never a fake bar),
          // then runs the single fetch and saves to disk. Latency is load-
          // dependent: a few seconds to about a minute (measured 2 s twice on
          // 2026-08-01, 42 s in an earlier probe — hence no single number in
          // the copy). The prompt LEAVES this machine; the run is free, not local.
          setRunProgress(t('progress.queuedPollinations'))
          const res = await window.tachi.pollinationsMedia.generateImage({
            model,
            prompt: promptText,
            size: typeof runParams.size === 'string' ? runParams.size : undefined,
            seed: typeof runParams.seed === 'number' ? runParams.seed : undefined,
            autoSaveDir: dir,
          })
          artifacts = res.artifacts
          // The seed that ACTUALLY ran — main re-rolls a -1 because Pollinations
          // caches by prompt+seed (a server-side "random" would replay the first
          // render forever). Recorded so Remix reproduces THIS image.
          entryParams = { ...entryParams, seed: res.seed }
          completedAfterPrivate = res.completedAfterPrivate || undefined
        } else {
          artifacts = venice
            ? (await window.tachi.venice.generateImage({ model, prompt: promptText, size: typeof runParams.size === 'string' ? runParams.size : undefined })).artifacts
            : (await window.tachi.surplusMedia.generateImage({ model, prompt: promptText, autoSaveDir: dir, params: runParams })).artifacts
        }
        pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts, params: entryParams, completedAfterPrivate })
      } else if (modality === 'tts') {
        if (mediaProvider === 'local') {
          // STUDIO (kokoro) — the picked "model" IS the kokoro voice id.
          // synthesizeKokoroTts saves the WAV via media.saveWav (the wire
          // DesignPage.tsx:264 already uses) so the artifact carries a `path`
          // — a b64-only kokoro artifact could not be Saved and did not
          // survive a restart, unlike every other local TTS/image/video row.
          if (localTtsEngine === 'kokoro' && kokoroInstalled === true) {
            const kokoro = window.tachi.kokoro
            if (!kokoro) throw new Error('Local TTS failed')
            const saved = await synthesizeKokoroTts(
              args => kokoro.synthesize(args),
              args => window.tachi.media.saveWav(args),
              { text: promptText, voice: model, now: Date.now() },
            )
            pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts: [{ kind: 'audio', mimeType: saved.mime, path: saved.path, b64: saved.b64 } as Artifact], params: runParams })
          } else {
            const r = await window.tachi.piper.synthesize({ voiceId: model, text: promptText })
            if (!r.ok || !r.b64) throw new Error(r.error || 'Local TTS failed')
            pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts: [{ kind: 'audio', mimeType: r.mime ?? 'audio/wav', path: r.path, b64: r.b64 } as Artifact], params: runParams })
          }
        } else {
          const format = typeof runParams.response_format === 'string' ? runParams.response_format : undefined
          const speed  = typeof runParams.speed === 'number' ? runParams.speed : undefined
          const { artifacts } = venice
            ? await window.tachi.venice.generateSpeech({ model, input: promptText, format, speed, params: runParams })
            : await window.tachi.surplusMedia.generateSpeech({ model, input: promptText, format, speed, autoSaveDir: dir, params: runParams })
          pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts, params: runParams })
        }
      } else if (modality === 'stt') {
        const bytes = await fileToBytes(sttFile!)
        const language = typeof runParams.language === 'string' && runParams.language.trim() ? runParams.language : undefined
        const { text } = venice
          ? await window.tachi.venice.transcribe({ model, audioBytes: bytes, fileName: sttFile!.name, language })
          : await window.tachi.surplusMedia.transcribe({ model, audioBytes: bytes, fileName: sttFile!.name, language, params: runParams })
        pushEntry({ id: entryId, model, modality, prompt: sttFile!.name, artifacts: [], text, params: runParams })
      } else if (modality === 'video' || modality === 'music') {
        if (mediaProvider === 'local' && modality === 'video') {
          setRunProgress(t('progress.renderingLocally'))
          // The composer's VIDEO dimension controls are RESOLUTION + ASPECT
          // RATIO — there are no numeric width/height in the video schema — so
          // map them onto Wan's real pixel pairs, or both pickers are silently
          // ignored and every render lands at the model row's 832x480.
          const offeredRes = shownSchema.find(s => s.name === 'resolution')?.enum
          // …and the LENGTH control is DURATION IN SECONDS. The video schema has
          // no `frames` at all, so the old `typeof runParams.frames === 'number'`
          // spread never fired and every clip was the model row's 33 frames.
          // Map seconds → Wan's 4n+1 law at its native 16 fps instead.
          // …at THIS checkpoint's frame rate, which the duration spec carries
          // (16 fps on the Wan 2.1 rows, 24 on Wan 2.2 TI2V-5B). The same spec
          // is the bound AND the rate, so one lookup answers both — and the
          // canvas gets it from the same place without a second wiring.
          const durationSpec = shownSchema.find(s => s.name === 'duration')
          const localFrames = resolveLocalWanFrames(runParams, durationSpec)
          // …and the INIT FRAME is a data: URL under `image_url` that main turns
          // into `-i <path>`. Gated on the LIVE schema still offering the
          // control: a checkpoint that is not i2v drops the spec (see
          // surplus-media-service), and a value stranded there by an earlier
          // cloud run must not smuggle an `-i` onto a text→video model.
          const initImg = resolveLocalInitImage(runParams, schemaOffersInitImage(shownSchema))
          // …and the NEGATIVE PROMPT, which this call never sent at all: the
          // video schema renders the textarea and SdVideoInput has always had
          // `-n`, so it was a dead control by pure omission (audit D6b).
          // Same ONE rule as the image branch above and the canvas node: the
          // resolver, with the visible schema's own default as the fallback.
          const localNeg = resolveLocalNegative(runParams, schemaNegativeDefault(shownSchema))
          const r = await window.tachi.sdCpp.generateVideo({
            modelId: model,
            prompt: promptText,
            ...(localNeg ? { negative: localNeg } : {}),
            ...resolveLocalWanSize(runParams, offeredRes),
            ...localFrames,
            ...initImg,
            ...(typeof runParams.seed === 'number' ? { seed: runParams.seed } : {}),
            ...resolveLocalGenParams(runParams),
            // …and the SPEED PACK toggle, when this row has one installed. An
            // absent key means "use it if it is there" (main's rule), so this
            // spread only ever carries an explicit on/off the user can see.
            ...resolveLocalSpeedMode(runParams),
            // …and the low-VRAM ladder, which matters MORE here than on the image
            // route: this is the path whose 6-9 GB VAE decode the OS actually
            // reaps, 40 minutes into a render, with nothing to show for it.
            ...resolveLocalMemoryFlags(runParams),
            ...(activeLoras.length > 0 ? { loras: activeLoras } : {}),
            ...(selectedVae ? { vaeAdapterId: selectedVae } : {}),
          })
          if (!r.ok || !r.b64) throw new Error(r.error || 'Local video generation failed')
          // The webm has no tEXt chunk — this entry IS the provenance, so it
          // records the frame count, the seed AND the recipe that actually
          // rendered. The last one is the speed-pack finding: the pack
          // out-votes the composer in MAIN, so an entry built from `runParams`
          // alone claimed 20 steps at guidance 6 for a run that went out at 4
          // and 1, and Remix reproduced the claim rather than the clip.
          const videoParams = stampLocalSelections(
            stampLocalEngineParams(
              stampLocalSeed(stampLocalWanTime(runParams, localFrames.frames, durationSpec?.fps), r.seed),
              r.effective,
            ),
            // The video route has no style wrapper, but it DOES take loras and a
            // vae swap — recording only two of the three would leave Remix
            // half-honest in exactly the way this fix is about. The style is
            // recorded as 'none' rather than as whatever the (hidden, image-only)
            // dropdown happens to hold: no style shaped this clip, and an entry
            // says what ran.
            { ...localSelections, style: 'none' },
          )
          pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts: [{ kind: 'video', mimeType: r.mime ?? 'video/webm', path: r.path, b64: r.b64 } as Artifact], params: videoParams })
          // …and NOW, with the wait fresh in mind, the row's 4-step pack — once
          // per row per session. `r.effective.steps` is what the engine really
          // sampled, which is the only number worth comparing against 4.
          pitchSpeedPackAfterRun(model, r.effective?.steps)
        } else if (mediaProvider === 'imgnai' && modality === 'video') {
          // imgnAI Katana video — MAIN submits + polls (≤6000s) and resolves
          // with the downloaded MP4. Progress ticks arrive via onGenProgress.
          setRunProgress(t('progress.queuedImgnai'))
          const durNum = typeof runParams.duration === 'number' ? runParams.duration
            : typeof runParams.duration === 'string' ? parseInt(runParams.duration, 10) : NaN
          const ref = typeof runParams.image_url === 'string' && runParams.image_url.trim() ? runParams.image_url.trim() : undefined
          const { artifacts } = await window.tachi.imgnaiMedia.generateVideo({
            model,
            prompt: promptText,
            durationSeconds: Number.isFinite(durNum) ? Math.round(durNum) : undefined,
            aspectRatio: typeof runParams.aspect_ratio === 'string' ? runParams.aspect_ratio : undefined,
            firstFrameImageUrl: ref,
            autoSaveDir: dir,
          })
          if (artifacts.length > 0) {
            pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts, params: runParams })
          } else {
            pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts: [], text: t('result.failedNoOutput'), params: runParams })
          }
        } else if (venice) {
          // Venice queues + polls its queue API server-side; resolves when ready.
          setRunProgress(t('progress.queuedVenice'))
          const lyrics   = typeof runParams.lyrics === 'string' && runParams.lyrics.trim() ? runParams.lyrics : undefined
          const negative = typeof runParams.negative_prompt === 'string' ? runParams.negative_prompt : undefined
          // Venice VIDEO `duration` is a REQUIRED enum '4s'..'15s'; the UI slider is a
          // number of seconds → clamp to 4–15 and format. Music uses duration_seconds (number).
          const durNum = typeof runParams.duration === 'number' ? runParams.duration
            : typeof runParams.duration === 'string' ? parseInt(runParams.duration, 10) : NaN
          const durationEnum = `${Math.min(15, Math.max(4, Number.isFinite(durNum) ? Math.round(durNum) : 5))}s`
          const { artifacts } = modality === 'video'
            ? await window.tachi.venice.generateVideo({ model, prompt: promptText, negativePrompt: negative, duration: durationEnum, params: runParams })
            : await window.tachi.venice.generateMusic({ model, prompt: promptText, lyrics, durationSeconds: Number.isFinite(durNum) ? Math.round(durNum) : undefined })
          if (artifacts.length > 0) {
            pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts, params: runParams })
          } else {
            pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts: [], text: t('result.failedNoOutput'), params: runParams })
          }
        } else {
          const submit = modality === 'video'
            ? await window.tachi.surplusMedia.submitVideo({ model, prompt: promptText, params: runParams })
            : await window.tachi.surplusMedia.submitMusic({
                model, prompt: promptText,
                lyrics: typeof runParams.lyrics === 'string' && runParams.lyrics.trim() ? runParams.lyrics : undefined,
                params: runParams,
              })
          const r = await pollUntilSettled(submit.jobId)
          if (r.artifacts && r.artifacts.length > 0) {
            pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts: r.artifacts, params: runParams })
          } else {
            pushEntry({ id: entryId, model, modality, prompt: promptText, artifacts: [], text: t('result.failedReason', { reason: r.error ?? t('result.noOutput') }), params: runParams })
          }
        }
      }
    } catch (err) {
      // The message carries sd-cli's exit code / signal and the tail of its
      // stderr (describeSdExit in sd-cpp-client). Both surfaces: the toast for
      // whoever is watching, the row for whoever walked away.
      const text = (err instanceof Error ? err.message : String(err)).trim() || t('genError.unknown')
      // A STOP THE USER ASKED FOR IS NOT AN ERROR. Sampled BEFORE failRun, which
      // clears `stopping` as part of settling the run — read it after and the
      // evidence is already gone. (The message itself is the second signal, for
      // a cancel that did not come from this component's button.)
      const kind = runFailureToastKind({
        message: text,
        stopping: useMediaStore.getState().run.stopping,
      })
      // failRun writes the message AND drops busy — one store write, so the row
      // and the button can never disagree after a remount.
      failRun(text)
      showToast({ kind, text })
    } finally {
      // Success path only (the catch already settled the run): endRun leaves the
      // previous error alone, so a failure the user has not dismissed survives.
      if (useMediaStore.getState().run.busy) endRun()
    }
  }

  const pushEntry = (e: Omit<MediaGalleryEntry, 'createdAt'>) =>
    addEntry({ ...e, provider: mediaProvider, createdAt: Date.now() })

  /**
   * Tell the user about this row's speed pack, at most once per row per session.
   *
   * The one-shot is spent only when a pitch is actually SHOWN: a run that came
   * back without a recipe (no `effective`) must not burn the single chance to
   * mention a 10x saving. The size is the INCREMENTAL one — the two packs share a
   * byte-identical LoRA, so the second costs ~0.6 GB, and quoting the full 1.3
   * would be the same over-quote the download rows were fixed for.
   */
  const pitchSpeedPackAfterRun = (modelId: string, runSteps: number | undefined) => {
    if (!shouldPitchSpeedPack({ modelId, packs: sdSpeedPacks, pitched: speedPackPitched })) return
    const pack = sdSpeedPacks.find(p => p.modelId === modelId)
    if (!pack) return
    const dl = sdDownloadSize({
      files: pack.files,
      installedIds: sdSpeedPacks.filter(p => p.installed).map(p => p.id),
    })
    const pitch = speedPackPitch({ runSteps, incrementalMb: dl.incrementalMb })
    if (!pitch) return
    speedPackPitched.add(modelId)
    showToast({ kind: 'info', text: t('local.speedPackPitch', {
      name:  pack.name,
      size:  gbLabel(pitch.sizeMb),
      steps: pitch.runSteps,
      ratio: pitch.ratio,
    }) })
  }

  // ── The zero-config chain's last leg ────────────────────────────────────────
  //
  // `generate` is re-created every render, so the handoff effect reads it through
  // a ref: depending on the function itself would re-run the effect on every
  // keystroke, and depending on nothing would fire Generate with a stale closure.
  const generateRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => { generateRef.current = generate })

  // The wait: the weights landing does not make the composer ready (the list
  // reloads, the model is re-pointed, the schema arrives last) — and the route
  // must still be the local one, or this fires a paid request nobody asked for.
  // Every fact, then one call.
  useEffect(() => {
    if (!chainAwaitingGenerate) return
    if (!firstImageReadyToGenerate({
      provider: mediaProvider, model, starterId: FIRST_IMAGE_STARTER_ID,
      schemaCount: schema.length, promptKey, busy,
    })) return
    setChainAwaitingGenerate(false)
    void generateRef.current()
  }, [chainAwaitingGenerate, mediaProvider, model, schema.length, promptKey, busy])

  // …and a wait that never ends is a failure like any other. Without this the
  // chain would sit on "step 3/3" forever if the schema fetch died — visible,
  // but not actionable. 90 s is far longer than a local IPC round trip.
  useEffect(() => {
    if (!chainAwaitingGenerate) return
    const timer = window.setTimeout(() => {
      setChainAwaitingGenerate(false)
      setChain(c => (c ? { ...c, failed: { step: 'generate', message: t('firstRun.error.notReady') } } : c))
    }, 90_000)
    return () => window.clearTimeout(timer)
  }, [chainAwaitingGenerate, t])

  // The journey ends when the render settles. A render that FAILED is already
  // explained by the genError row (the surface built for exactly that), so the
  // chain simply steps out of the way rather than adding a second verdict.
  useEffect(() => {
    if (!chain || chain.failed || chain.step !== 'generate') return
    if (chainAwaitingGenerate || busy) return
    setChain(null)
  }, [chain, chainAwaitingGenerate, busy])

  // ── Stop ─────────────────────────────────────────────────────────────────────
  // «i cant stop it» — the owner, watching a 70-minute Wan render hold the GPU
  // with no cancel anywhere in the UI. The kill lands in main (one child, one
  // handle); the run then rejects through the SAME failure path every other
  // death uses, so the inline row explains itself and the queue frees itself.
  //
  // Nothing is set to "stopped" here on our own authority: the button only
  // LATCHES (so it cannot be clicked twice) and the real state change arrives
  // when the child actually dies. A stop that raced a finishing render leaves
  // `cancelled:false` and the successful entry lands as normal.
  const stopGeneration = async () => {
    if (!run.busy || !run.cancellable || run.stopping) return
    markRunStopping()
    try {
      await window.tachi.sdCpp.cancelGeneration()
    } catch (e) {
      showToast({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    }
  }

  // ── Remix: load an entry's model + params + prompt back into the composer ────
  const remix = (entry: MediaGalleryEntry, rerollSeed = false) => {
    // Restore the whole route: a remixed Venice/local/imgnai entry must also
    // flip the PROVIDER chip, or the model id lands under the wrong provider
    // (chip said SURPLUS, model was Venice's — mis-billed, seen in audit #10c).
    if (entry.provider && entry.provider !== mediaProvider
        && ['surplus', 'venice', 'local', 'imgnai', 'pollinations'].includes(entry.provider)) {
      setMediaProvider(entry.provider as MediaProvider)
    }
    setModality(entry.modality)
    setModel(entry.modality, entry.model)
    // THE THREE SELECTIONS THE COMPOSER SHOWS BUT THE PARAMS BAG DOES NOT HOLD.
    // `null` — a cloud run, or an entry from before they were recorded — restores
    // the DEFAULTS rather than leaving whatever is currently picked: Remix has to
    // describe the run it is about to reproduce, and "the style still on screen
    // from ten minutes ago" is not part of that run.
    const sel = readLocalSelections(entry.params) ?? NO_LOCAL_SELECTIONS
    setActiveStyle(sel.style)
    setSelectedLoras(sel.loras)
    setSelectedVae(sel.vae)
    // …and they are lifted straight back OUT of the bag, so the reserved key
    // never reaches the schema, a cloud request, or a re-stamp.
    const next = withoutLocalSelections({ ...(entry.params ?? {}) })
    if (rerollSeed && 'seed' in next) next.seed = -1
    // Deliberate restore of a run that really happened: the schema arrival that
    // follows must seed into this bag, not heal a non-tier size out of it.
    explicitParamsRef.current = next
    setParams(entry.modality, next)
    showToast({ kind: 'info', text: rerollSeed ? t('toast.loadedRerolled') : t('toast.loaded') })
  }

  // ── Destroying persisted rows asks first ─────────────────────────────────────
  //
  // Both of these deleted gallery entries — the app's only route back to a file
  // it generated — on a single unguarded click, and CLEAR ALL took the whole
  // gallery. `window.confirm` is not available as the fix (it blocks the
  // renderer's event loop, which here would freeze a live render's progress
  // stream behind the modal); ConfirmProvider is the in-app replacement the rest
  // of the app already uses.
  //
  // The copy says what is NOT destroyed, because that is the question: the files
  // stay on disk, this removes the entry.
  const confirmClearGallery = async () => {
    const ok = await confirm({
      message:  t('gallery.clearAllConfirm', { count: gallery.length }),
      okLabel:  t('gallery.clearAll'),
      danger:   true,
    })
    if (ok) clearGallery()
  }

  const confirmRemoveEntry = async (id: string) => {
    const ok = await confirm({ message: t('entry.removeConfirm'), okLabel: t('entry.remove'), danger: true })
    if (ok) removeEntry(id)
  }

  // ── Auto-save folder ─────────────────────────────────────────────────────────
  const pickAutoSaveDir = async () => {
    const dir = await window.tachi.agent.pickFolder()
    if (dir) setAutoSaveDir(dir)
  }

  const saveArtifact = async (a: Artifact) => {
    if (!a.path) { showToast({ kind: 'error', text: t('toast.nothingToSave') }); return }
    const dir = await window.tachi.agent.pickFolder()
    if (!dir) return
    try {
      const res = await window.tachi.surplusMedia.saveArtifact({ jobId: '', index: 0, destDir: dir, srcPath: a.path })
      showToast({ kind: 'info', text: t('toast.savedTo', { path: res.path }) })
    } catch (err) {
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  // ── Restore params from a locally-generated PNG (tachi-gen tEXt chunk) ─────
  /**
   * Parse a dropped or picked PNG, read the "tachi-gen" tEXt chunk, and
   * populate the composer fields so the user can regenerate from provenance.
   * Only the local image provider embeds this metadata (sd.cpp).
   */
  const restoreFromImage = useCallback(async (file: File) => {
    try {
      const meta = await parseTachiGenMetaFromFile(file)
      if (!meta) { showToast({ kind: 'warning', text: t('restore.noMeta') }); return }
      setModality('image')
      setModel('image', meta.modelId)
      // Provenance, not staleness: exempt this bag from the schema-arrival heal
      // so a size the model's curated tiers don't list still survives (that is
      // what ParamFields' out-of-enum option is for).
      const restored: Record<string, unknown> = {
        prompt:          meta.prompt,
        negative_prompt: meta.negative,
        steps:           meta.steps,
        // THE SCHEMA'S NAMES, not the tEXt chunk's field names (audit D1's twin).
        // This wrote `cfgScale` / `samplingMethod`, which resolveLocalGenParams
        // reads only as a LEGACY FALLBACK — so the schema-arrival seeding, which
        // fills `cfg` / `sampler` from the checkpoint row's own recipe, out-voted
        // the provenance and the restored PNG re-rendered at the row's numbers
        // while the sliders showed them. The chunk itself has carried composer
        // key names since 24dbb71; this is the other half of that symmetry.
        cfg:             meta.cfgScale,
        sampler:         meta.samplingMethod,
        seed:            meta.seed,
        width:           meta.width,
        height:          meta.height,
        // `size` is the control the composer RENDERS and the one generate reads
        // first — seed it from the provenance too, or the schema-default seeding
        // would drop a 1024x1024 in on top and the restore would silently
        // regenerate at the wrong size.
        size:            `${meta.width}x${meta.height}`,
      }
      explicitParamsRef.current = restored
      setParams('image', restored)
      if (mediaProvider !== 'local') setMediaProvider('local')
      showToast({ kind: 'info', text: t('restore.success') })
    } catch {
      showToast({ kind: 'error', text: t('restore.error') })
    }
    // setMediaProvider is the STORE's action (stable for the store's lifetime),
    // not a useState setter eslint knows about — hence the explicit dep.
  }, [t, setModality, setModel, setParams, mediaProvider, setMediaProvider])

  // ── Esc closes the fullscreen preview ───────────────────────────────────────
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  const presets = PROMPT_PRESETS[modality]

  /** The gallery AS RENDERED: pins first, newest-first inside each group. The
   *  store keeps insertion/time order; only the display is sorted, and it is
   *  sorted by the SAME comparator the Artifacts tab uses. */
  const galleryItems = useMemo(() => sortGalleryForDisplay(gallery), [gallery])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <PageTopbar section="Media" rightAction={
        <button
          onClick={() => setTourOpen(true)}
          title={t('topbar.howToTitle')}
          style={{ padding: '4px 10px', border: '2px solid var(--accent)', background: 'var(--accent)', color: '#ffffff', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', cursor: 'pointer', textTransform: 'uppercase' }}
        >{t('topbar.howTo')}</button>
      } />
      <TabTour open={tourOpen} onClose={() => setTourOpen(false)} steps={MEDIA_TOUR} title={t('tour.windowTitle')} />

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0 }}>
        {/* ── Left: composer ──────────────────────────────────────────────── */}
        <div
          style={{
            width: 340,
            flexShrink: 0,
            borderRight: '2px solid var(--border)',
            background: 'var(--bg-surface)',
            padding: 16,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            fontFamily: 'JetBrains Mono, monospace',
          }}
          onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
          onDrop={e => {
            e.preventDefault(); e.stopPropagation()
            const file = e.dataTransfer.files[0]
            if (file && (file.type === 'image/png' || file.name.toLowerCase().endsWith('.png'))) {
              void restoreFromImage(file)
            }
          }}
        >
          {/* Import from URL (yt-dlp) — download then remix/edit below */}
          <ImportFromUrl />

          {/* Modality selector */}
          <div data-tour="media-modality">
            <span style={labelStyle}>{t('composer.modality')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {MODALITIES.map(m => {
                const active = modality === m.id
                return (
                  <button
                    key={m.id}
                    onClick={() => setModality(m.id)}
                    aria-pressed={active}
                    style={{
                      ...btnStyle,
                      border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                      background: active ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                      color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                    }}
                  >
                    {t(`modalities.${m.id}`)}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Media provider — Surplus vs Venice, both standalone. Venice generates
              directly on your Venice key across ALL modalities: image/tts/stt via
              OpenAI-compatible endpoints, video/music via Venice's queue API. */}
          {(modality === 'image' || modality === 'tts' || modality === 'stt' || modality === 'video' || modality === 'music') && (
            <div>
              <span style={labelStyle}>{t('composer.provider')}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {([
                  'surplus', 'venice',
                  ...((modality === 'image' || modality === 'video' || modality === 'tts') ? ['local'] : []),
                  ...((modality === 'image' || modality === 'video') ? ['imgnai'] : []),
                  // Pollinations — image only, keyless, works on a fresh install.
                  ...(modality === 'image' ? ['pollinations'] : []),
                ] as MediaProvider[]).map(p => {
                  const active = mediaProvider === p
                  return (
                    <button
                      key={p}
                      onClick={() => setMediaProvider(p)}
                      aria-pressed={active}
                      style={{
                        ...btnStyle,
                        border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                        background: active ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                        color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                        // 'imgnAI' is a brand spelling — keep it verbatim.
                        textTransform: p === 'imgnai' ? 'none' : 'capitalize',
                      }}
                    >
                      {p === 'imgnai' ? 'imgnAI' : p}
                    </button>
                  )
                })}
              </div>
              {/* THE HONEST KEYLESS CARD. Pollinations is the one route that
                  works on a fresh install with nothing pasted — and the one
                  free route here that is NOT local. Both facts are stated in
                  the same breath so "free" can never read as "on this
                  machine": the prompt is sent to pollinations.ai. */}
              {mediaProvider === 'pollinations' && (
                <div style={{
                  marginTop: 6, border: '2px solid var(--border)', padding: 6,
                  fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5,
                }}>
                  {t('pollinations.hint')}
                </div>
              )}
            </div>
          )}

          {/* Local TTS engines — STUDIO (kokoro, English default) + piper
              (multilingual/fallback). The toggle only renders when the kokoro
              surface exists; otherwise this is the classic piper-only panel. */}
          {mediaProvider === 'local' && modality === 'tts' && (
            <div style={{ border: '2px solid var(--border)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {kokoroInstalled !== null && (
                <div>
                  <span style={labelStyle}>{t('local.engine')}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['kokoro', 'piper'] as TtsEngine[]).map(en => {
                      const active = localTtsEngine === en
                      return (
                        <button
                          key={en}
                          onClick={() => setLocalTtsEngine(en)}
                          style={{
                            ...btnStyle, flex: 1,
                            border: `2px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                            background: active ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                            color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                          }}
                        >
                          {en === 'kokoro' ? t('local.kokoro.chip') : t('local.piperChip')}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {kokoroInstalled !== null && localTtsEngine === 'kokoro' ? (
                kokoroInstalled ? (
                  <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('local.kokoro.installed')}</span>
                ) : kokoroBusy ? (
                  <div>
                    <div style={{ border: '2px solid var(--border)', height: 12, background: 'var(--bg-inset)' }}>
                      <div style={{ height: '100%', width: `${Math.round(kokoroPct * 100)}%`, background: 'var(--accent)', transition: 'width 300ms linear' }} />
                    </div>
                    <div style={{ marginTop: 4, fontSize: 9, color: 'var(--accent-text)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      {t('local.kokoro.downloading', { percent: Math.round(kokoroPct * 100) })}
                    </div>
                  </div>
                ) : (
                  <>
                    <span style={{ fontSize: 9, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('local.kokoro.card')}</span>
                    <button onClick={() => void downloadKokoro()} style={{ ...btnStyle, width: '100%', border: '2px solid var(--accent)', color: 'var(--accent-text)' }}>
                      {t('local.kokoro.download')}
                    </button>
                  </>
                )
              ) : (
                <>
                  {!piperInstalled ? (
                    <>
                      {/* Same rule as the sd.cpp button: the size is on it. */}
                      <button
                        onClick={() => void installEngine('piper')}
                        title={piperEngineQuote && piperEngineQuote.minMb !== piperEngineQuote.maxMb ? t('local.engineSizeRangeTitle') : undefined}
                        style={{ ...btnStyle, width: '100%' }}
                      >
                        {piperEngineQuote
                          ? t('local.piper.installSized', { size: engineSizeText(piperEngineQuote) })
                          : t('local.piper.install')}
                      </button>
                      {engineErrorRow('piper')}
                    </>
                  ) : (
                    <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('local.piper.installed')}</span>
                  )}
                  {piperInstalled && piperVoices.length > 0 && (
                    <>
                      <span style={labelStyle}>{t('local.piper.downloadVoice')}</span>
                      {piperVoices.map(v => (
                        <button key={v.id} onClick={() => { void downloadVoiceRow(v.id, v.name) }}
                          style={{ ...btnStyle, width: '100%', textAlign: 'left' }}>
                          {t('local.voiceItem', { name: v.name, size: v.sizeMb })}
                        </button>
                      ))}
                    </>
                  )}
                </>
              )}
              {sdProgress && <span style={{ fontSize: 9, color: 'var(--accent-text)', wordBreak: 'break-word' }}>{sdProgress}</span>}
            </div>
          )}

          {/* Local sd.cpp engine (image/video) — install + per-model download */}
          {mediaProvider === 'local' && modality !== 'tts' && (
            /* data-tour="media-local" — the anchor lane 5B's local-first tour
               step spotlights. It goes on the WHOLE local panel, not the install
               button alone: the step's point is that this tab has a free local
               engine with its own model downloads at all, and the ring has to
               enclose the engine row AND the weights it pulls. */
            <div data-tour="media-local" style={{ border: '2px solid var(--border)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* ── THE ZERO-CONFIG CTA ───────────────────────────────────────
                  First, because it is the whole panel in one button for someone
                  who has never heard of sd.cpp: it installs the engine, takes
                  the curated starter row, writes a prompt and renders. The
                  manual controls stay exactly where they were underneath — this
                  is a shortcut, not a mode. */}
              {offerFirstImage && (
                <>
                  <button
                    onClick={() => { void runFirstImage() }}
                    title={t('firstRun.ctaTitle', {
                      name: starterRow?.name ?? FIRST_IMAGE_STARTER_ID,
                      engine: engineSizeText(sdEngineQuote) ?? '',
                    })}
                    style={{
                      ...btnStyle, width: '100%', padding: '8px 10px',
                      border: '2px solid var(--accent)', background: 'var(--accent)',
                      color: '#ffffff', boxShadow: '2px 2px 0 rgba(0,0,0,0.3)',
                    }}
                  >
                    {starterSizeGb ? t('firstRun.cta', { size: starterSizeGb }) : t('firstRun.ctaNoSize')}
                  </button>
                  <span style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                    {t('firstRun.ctaHint')}
                  </span>
                </>
              )}
              {/* WHERE THE JOURNEY STOPPED, and the one button that continues it.
                  RESUME rather than "retry": the plan is re-derived from disk, so
                  a click after a dead download picks up the `.part` bytes instead
                  of starting the 5 GB again. */}
              {chain?.failed && chainPosition && (
                <div style={{
                  border: '2px solid var(--danger, #c00)', padding: 6,
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                    color: 'var(--danger, #c00)',
                  }}>
                    {t('firstRun.failedTitle', {
                      step:  chainPosition.index,
                      total: chainPosition.total,
                      label: t(`firstRun.step.${chain.failed.step}`),
                    })}
                  </span>
                  <span style={{ fontSize: 9, color: 'var(--danger, #c00)', wordBreak: 'break-word', lineHeight: 1.4 }}>
                    {chain.failed.message}
                  </span>
                  <button onClick={() => { void runFirstImage() }} style={{ ...btnStyle, width: '100%' }}>
                    {t('firstRun.resume')}
                  </button>
                  <button onClick={() => setChain(null)} style={{ ...btnStyle, width: '100%', color: 'var(--text-dim)' }}>
                    {t('firstRun.dismiss')}
                  </button>
                </div>
              )}
              {!sdInstalled ? (
                <>
                  {/* THE PRICE OF THE ENGINE, BEFORE THE CLICK. On Windows with
                      an NVIDIA card this is 883 MB (the CUDA build plus its
                      separate cudart archive) against 23 MB for the CPU build,
                      and the copy said neither. See engineDownloadQuoteMb. */}
                  <button
                    onClick={() => void installEngine('sdcpp')}
                    title={sdEngineQuote && sdEngineQuote.minMb !== sdEngineQuote.maxMb ? t('local.engineSizeRangeTitle') : undefined}
                    style={{ ...btnStyle, width: '100%' }}
                  >
                    {sdEngineQuote
                      ? t('local.sdCpp.installSized', { size: engineSizeText(sdEngineQuote) })
                      : t('local.sdCpp.install')}
                  </button>
                  {engineErrorRow('sdcpp')}
                </>
              ) : (
                <>
                  <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>{t('local.sdCpp.installed')}</span>
                  {/* A NEWER ENGINE IS ONLY NEWS IF SOMETHING SAYS SO. The
                      install button short-circuits on "a binary exists", so
                      before this the app could pin a new build and the person
                      with the old one would never hear about it. Shown only
                      when the installed binary REPORTED a commit and it differs
                      — an engine that would not answer is not accused. */}
                  {sdEngineStale && (
                    <button
                      onClick={() => { void updateEngine() }}
                      disabled={updatingEngine}
                      style={{ ...btnStyle, width: '100%', opacity: updatingEngine ? 0.7 : 1 }}
                    >
                      {updatingEngine ? t('local.sdCpp.updating') : t('local.sdCpp.update')}
                    </button>
                  )}
                </>
              )}
              {sdInstalled && sdModels.length > 0 && (
                <>
                  <span style={labelStyle}>{t('local.sdCpp.downloadModel')}</span>
                  {/* AN INSTALLED ROW IS NOT A DOWNLOAD. Every row here used to
                      render the same button whether or not the weights were
                      already on disk — several GB one click away, to arrive
                      exactly where you started. `localRows` is the sd-cpp:status
                      snapshot keyed by installed id: the same map that decides
                      what may be generated with, so the panel and the composer
                      cannot disagree. An installed row keeps its size and its
                      notes tooltip and loses only the affordance that lied. */}
                  {/* THE PRICE ON THE BUTTON IS THE PRICE OF THE DOWNLOAD.
                      The I2V row quoted its full 17.6 GB while its own tooltip
                      said ~11.7 GB, because two of its four components are the
                      2.1 files a Wan owner already has — and the tooltip was
                      right. sdDownloadSize crosses the catalog's `sharedWith`
                      with what is installed; a row that shares nothing still
                      shows its full size, unchanged. */}
                  {/* …AND AN INTERRUPTED DOWNLOAD IS NOT A VIRGIN ONE.
                      The TI2V row died mid-file twice on network flake and both
                      times this panel re-rendered the plain download label over
                      5-6.5 GB of resumable partials — the failure lived only in
                      a progress event, and a multi-GB transfer outlives the tab
                      that subscribed to it. `onDiskMb` is the durable evidence
                      (main stats the landed files + `.part`s), so the row says
                      RESUME and quotes only what is still owed. */}
                  {/* …AND THE LICENCE IS NOT A TOOLTIP.
                      `notes` is hoverable prose and that is the right home for
                      "start at 480p if you are on 8 GB". A LICENCE is different
                      in kind: LTX-2.3 is not Apache, its commercial grant stops
                      at $10M in annual revenue, and its text encoder carries
                      Google's Gemma Terms — so it has to be legible without
                      hovering and openable in one click, BEFORE 20.8 GB moves.
                      Rendered for every row that declares one (the Apache rows
                      too: the point is that the field is always answered, so a
                      row that says something unusual is visibly unusual rather
                      than merely silent-in-a-different-way). */}
                  {sdModels
                    // Filtered to the ACTIVE modality (audit 1C-3): a row of
                    // the other kind is kept only while its own download is
                    // in flight or interrupted — never installed-and-idle —
                    // so hiding it here can never orphan a real transfer.
                    .filter(m => isSdDownloadRowVisible(
                      m.kind, modality,
                      sdDownloadRowState(m.id, installedSdIds, sdDownloadSize({ files: m.files ?? [], installedIds: installedSdIds }).onDiskMb),
                      downloadingSdRowRef.current?.id === m.id,
                    ))
                    .map(m => {
                    // `sizeMbTotal` stays the source of the FULL price: a main
                    // build that sends no `files` would otherwise quote 0.0 GB.
                    const dl = sdDownloadSize({ files: m.files ?? [], installedIds: installedSdIds })
                    const state = sdDownloadRowState(m.id, installedSdIds, dl.onDiskMb)
                    const lic = sdRowLicense(m)
                    // This row survived the filter above DESPITE not matching
                    // the active modality — the only way that happens is an
                    // in-flight/interrupted download of the OTHER kind, which
                    // needs a badge or it reads as the panel mixing kinds again.
                    const otherKindBadge = m.kind !== modality ? (
                      <span style={{
                        fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                        color: 'var(--text-dim)', border: '1px solid var(--border)', padding: '1px 4px',
                        alignSelf: 'flex-start',
                      }}>
                        {t('local.otherKindBadge', { kind: t(`modalities.${m.kind}`) })}
                      </span>
                    ) : null
                    // Both fields or neither, https only — see sdRowLicense. An
                    // older main build sends none and this collapses to null.
                    const licenseLine = lic ? (
                      <button
                        onClick={() => { void window.tachi.shell.openExternal(lic.url) }}
                        title={lic.url}
                        style={{
                          background: 'none', border: 'none', padding: '0 0 2px 2px', margin: 0,
                          font: 'inherit', fontSize: 9, lineHeight: 1.4, textAlign: 'left',
                          color: 'var(--text-dim)', textDecoration: 'underline', cursor: 'pointer',
                        }}>
                        {t('local.modelLicense', { name: lic.name })}
                      </button>
                    ) : null
                    // THE SPEED PACK'S PRICE, WHERE THE CHECKPOINT'S PRICE IS.
                    // The two packs share one byte-identical LoRA, so once
                    // either is installed the other costs ~0.6 GB instead of
                    // 1.3 — but that subtraction is only rendered inside the
                    // pack block below, which appears ONLY for the model that
                    // is selected AND installed. Reading the A14B's 12.1 GB
                    // button, the thing that makes it usable looked like
                    // another 1.3 GB. One line, on the row, before the money
                    // moves; null (and nothing rendered) whenever there is no
                    // real discount to quote.
                    const packDiscount = speedPackDiscountNote({
                      modelId: m.id,
                      packs: sdSpeedPacks.map(p => ({
                        modelId: p.modelId,
                        sizeMbTotal: p.sizeMbTotal,
                        installed: p.installed,
                        incrementalMb: sdDownloadSize({
                          files: p.files,
                          installedIds: sdSpeedPacks.filter(q => q.installed).map(q => q.id),
                        }).incrementalMb,
                      })),
                    })
                    const packDiscountLine = packDiscount ? (
                      <span style={{ fontSize: 9, lineHeight: 1.4, color: 'var(--accent-text)', padding: '0 0 2px 2px' }}>
                        {t('local.modelSpeedPackDiscount', { size: gbLabel(packDiscount.incrementalMb) })}
                      </span>
                    ) : null
                    // WILL IT RUN HERE — compared, never computed. The row states
                    // what it needs (from its own notes) and the probe states what
                    // this machine has; null when either is unknown, so the panel
                    // stays silent rather than inventing a threshold. AMBER IS A
                    // HEADS-UP, NOT A REFUSAL: peak memory moves with resolution
                    // and the offload flags, which is exactly why the fabricated
                    // size-times-1.2 verdict was removed from the catalog card.
                    const fit = mediaFitLine({
                      row: m,
                      vramFreeBytes: hardware?.vramFreeBytes ?? null,
                      ramTotalBytes: hardware?.ramTotalBytes ?? null,
                    })
                    const fitLine = fit ? (
                      <span style={{
                        fontSize: 9, lineHeight: 1.4, padding: '0 0 2px 2px',
                        color: fit.fits ? 'var(--accent-text)' : 'var(--warning)',
                      }}>
                        {t(fit.fits
                          ? (fit.kind === 'vram' ? 'local.fitVramOk'    : 'local.fitRamOk')
                          : (fit.kind === 'vram' ? 'local.fitVramTight' : 'local.fitRamTight'),
                        { need: fit.needGb, have: fit.haveGb })}
                      </span>
                    ) : null
                    if (state === 'installed') return (
                      <React.Fragment key={m.id}>
                        {otherKindBadge}
                        <div title={m.notes} style={{
                          ...btnStyle, width: '100%', textAlign: 'left', cursor: 'default',
                          border: '2px solid var(--accent)', color: 'var(--accent-text)',
                          boxSizing: 'border-box',
                        }}>
                          {t('local.modelInstalled', { name: m.name, size: gbLabel(m.sizeMbTotal) })}
                        </div>
                        {/* Still shown on an INSTALLED row: the question "will
                            this actually run on my card" outlives the download,
                            and this is the row the user comes back to. */}
                        {fitLine}
                        {licenseLine}
                      </React.Fragment>
                    )
                    return (
                      <React.Fragment key={m.id}>
                        {otherKindBadge}
                        <button onClick={() => { void downloadSdRow(m.id, m.name, m.kind) }}
                          title={m.notes} style={{
                            ...btnStyle, width: '100%', textAlign: 'left', boxSizing: 'border-box',
                            // The interrupted row is MARKED, not just reworded: it
                            // is the one thing on this panel that is mid-flight.
                            ...(state === 'resume' ? { border: '2px solid var(--warning)' } : {}),
                          }}>
                          {state === 'resume'
                            ? t('local.modelItemResume', {
                                name: m.name,
                                size:  gbLabel(dl.incrementalMb),
                                done:  gbLabel(dl.onDiskMb),
                                total: gbLabel(dl.totalMb || m.sizeMbTotal),
                              })
                            : dl.savedMb > 0
                              ? t('local.modelItemShared', { name: m.name, size: gbLabel(dl.incrementalMb), saved: gbLabel(dl.savedMb) })
                              : t('local.modelItem',       { name: m.name, size: gbLabel(m.sizeMbTotal) })}
                        </button>
                        {fitLine}
                        {packDiscountLine}
                        {licenseLine}
                      </React.Fragment>
                    )
                  })}
                </>
              )}
              {/* ── THE SPEED PACK, for the model that is SELECTED ──────────────
                  Scoped to the active row rather than listed with the models:
                  a distill LoRA is meaningless on its own, and the question it
                  answers ("why does this take 44 minutes") is only being asked
                  about the checkpoint currently in the picker.

                  The BLOCKED case is rendered too. A user who selects the 1.3B
                  and finds no speed row would read the absence as a missing
                  feature; it is a licence verdict, and the tooltip is the whole
                  reason (SD_BLOCKED_SPEED_ADAPTERS). */}
              {sdInstalled && modality === 'video' && (() => {
                const pack = sdSpeedPacks.find(p => p.modelId === model)
                if (pack) {
                  if (pack.installed) {
                    return (
                      <div title={pack.notes} style={{
                        ...btnStyle, width: '100%', textAlign: 'left', cursor: 'default',
                        border: '2px solid var(--accent)', color: 'var(--accent-text)', boxSizing: 'border-box',
                      }}>
                        {t('local.speedPackInstalled', { name: pack.name })}
                      </div>
                    )
                  }
                  // Two packs share one byte-identical LoRA, so the honest price
                  // of the second one is what is NEW — the same subtraction the
                  // model buttons above make, over installed PACK ids.
                  const dl = sdDownloadSize({ files: pack.files, installedIds: sdSpeedPacks.filter(p => p.installed).map(p => p.id) })
                  return (
                    <button onClick={() => { void downloadSpeedPackRow(pack.id, pack.name) }}
                      title={pack.notes} style={{ ...btnStyle, width: '100%', textAlign: 'left' }}>
                      {dl.savedMb > 0
                        ? t('local.speedPackShared', { name: pack.name, size: gbLabel(dl.incrementalMb), saved: gbLabel(dl.savedMb) })
                        : t('local.speedPack',       { name: pack.name, size: gbLabel(pack.sizeMbTotal) })}
                    </button>
                  )
                }
                const blocked = sdSpeedBlocked.find(b => b.modelId === model)
                if (!blocked) return null
                return (
                  <span title={blocked.blocked} style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                    {t('local.speedPackNone')}
                  </span>
                )
              })()}
              {/* ── THE REFERENCE-IMAGE WEIGHTS, for the SELECTED image row ─────
                  Scoped to the active row exactly like the speed pack above, and
                  for the same reason: these weights are trained per checkpoint
                  family, so the only question worth answering is whether THIS
                  model can use a reference image.

                  Once installed the composer grows two controls (the schema gate
                  is the same lookup), so the INSTALLED state renders as a plain
                  statement rather than a button — there is nothing left to press.
                  A family with no row renders NOTHING: SD 1.5 and SDXL are what
                  upstream supports, and an absence with no explanation is better
                  than inventing a verdict about Z-Image or Wan. */}
              {sdInstalled && modality === 'image' && activeLocalRow && (() => {
                // A MEASURED refusal renders as the reason, not as an absence —
                // the same courtesy the blocked speed pack gets. SD-Turbo is
                // declared sd15 and is really SD 2.x; see SD_IP_ADAPTER_BLOCKED.
                const blocked = sdIpAdapterBlocked[model]
                if (blocked) {
                  return (
                    <span title={blocked} style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                      {t('local.ipAdapterNone')}
                    </span>
                  )
                }
                const row = sdIpAdapters.find(a => a.family === activeLocalRow.family)
                if (!row) return null
                if (row.installed) {
                  return (
                    <div title={row.notes} style={{
                      ...btnStyle, width: '100%', textAlign: 'left', cursor: 'default',
                      border: '2px solid var(--accent)', color: 'var(--accent-text)', boxSizing: 'border-box',
                    }}>
                      {t('local.ipAdapterInstalled')}
                    </div>
                  )
                }
                // The 1.2 GB encoder is shared with the sibling row AND with Wan
                // 2.1 image→video, so the honest price is what is NEW — the same
                // subtraction the model buttons make, over installed row ids.
                const dl = sdDownloadSize({
                  files: row.files,
                  // BOTH kinds of id, because `sharedWith` names both: the sibling
                  // IP-Adapter row and the MODEL rows that pin the same encoder.
                  // Passing only the adapter ids would quote the full 1,249 MiB to
                  // a Wan 2.1 i2v owner whose disk already holds 1,206 of it.
                  installedIds: [
                    ...sdIpAdapters.filter(a => a.installed).map(a => a.id),
                    ...Object.keys(localRows),
                  ],
                })
                return (
                  <button onClick={() => { void downloadIpAdapterRow(row.id, row.name) }}
                    title={row.notes} style={{ ...btnStyle, width: '100%', textAlign: 'left' }}>
                    {dl.savedMb > 0
                      ? t('local.ipAdapterShared', { size: sizeLabel(dl.incrementalMb), saved: sizeLabel(dl.savedMb) })
                      : t('local.ipAdapter',       { size: sizeLabel(row.sizeMbTotal) })}
                  </button>
                )
              })()}
              {/* THE SAME ROW, one line — install, download and render report
                  through three different channels and this is where all three
                  have always landed. The chain only adds the step counter around
                  the engine's own words (see localProgressLine). */}
              {localProgressLine && <span style={{ fontSize: 9, color: 'var(--accent-text)', wordBreak: 'break-word' }}>{localProgressLine}</span>}
            </div>
          )}

          {/* Model picker */}
          <div data-tour="media-model">
            <span style={labelStyle}>{t('composer.model')}</span>
            {loadingModels ? (
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('composer.loadingCatalog')}</div>
            ) : models.length === 0 ? (
              /* THE DEAD END, WITH A DOOR IN IT. A cloud provider with nothing to
                 offer for a modality the LOCAL engine serves is the newcomer's
                 first screen, and "add a Surplus key and fund USDC" was the whole
                 of it. The condition is structural (canOfferLocalSwitch), not a
                 match on this sentence: the sentence is one of our own translated
                 strings, so matching it would work in English only. */
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 10, color: 'var(--warning)', lineHeight: 1.4 }}>
                  {modelsError ?? t('models.error.noneAvailable')}
                </div>
                {offerLocalSwitchForCatalog && (
                  <button
                    onClick={switchToLocal}
                    title={t('local.switchToLocalTitle')}
                    style={{
                      ...btnStyle, width: '100%', textAlign: 'left',
                      border: '2px solid var(--accent)', color: 'var(--accent-text)',
                    }}
                  >
                    {t('local.switchToLocal')}
                  </button>
                )}
              </div>
            ) : (
              <select value={model} onChange={e => setModel(modality, e.target.value)} style={inputStyle}>
                {models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            )}
          </div>

          {/* ── Performance preset (local image / video only) ─────────────────── */}
          {/* Fills steps/samplingMethod/cfgScale in the existing schema controls.
              Only useful for local sd.cpp where those params are forwarded to IPC. */}
          {mediaProvider === 'local' && (modality === 'image' || modality === 'video') && (
            <div style={{ display: 'flex', gap: 8 }}>
              {/* Performance tier — HIDDEN when the row can offer none (audit
                  D5): a 1-step distilled checkpoint has exactly one setting
                  that works, and the ladder it used to be handed went to 28. */}
              {offeredPresets.length > 0 && (
                <div style={{ flex: 1 }}>
                  <span style={labelStyle}>{t('composer.perfPreset')}</span>
                  <select
                    value={activePerfPreset ?? ''}
                    onChange={e => {
                      const id = e.target.value
                      if (id) applyPerfPreset(id)
                      else setActivePerfPreset(null)
                    }}
                    style={{ ...inputStyle, cursor: 'pointer' }}
                  >
                    <option value="">{t('composer.perfPresetPlaceholder')}</option>
                    {offeredPresets.map(p => (
                      // The REAL numbers, next to the name. The labels used to
                      // bake ranges into the translated text ("Quality (20–28
                      // steps)") — true for sd15, wrong for every other row.
                      <option
                        key={p.id}
                        value={p.id}
                        title={`${p.params.steps} · cfg ${p.params.cfgScale} · ${p.params.samplingMethod}`}
                      >
                        {t(`presets.${p.id}.label`)} · {p.params.steps}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {/* Style preset (image only — video doesn't use a style wrapper) */}
              {modality === 'image' && (
                <div style={{ flex: 1 }}>
                  <span style={labelStyle}>{t('composer.stylePreset')}</span>
                  <select
                    value={activeStyle}
                    onChange={e => setActiveStyle(e.target.value)}
                    style={{ ...inputStyle, cursor: 'pointer' }}
                  >
                    {SD_STYLES.map(s => (
                      <option key={s.id} value={s.id}>{t(`styles.${s.id}.label`)}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* ── LoRAs + trigger words + VAE (local image/video) ────────────────
              Only adapters whose DECLARED family matches the active checkpoint
              are listed — compat at generate (spec §5-6). Anything installed
              for another base is COUNTED rather than silently dropped, because
              "my LoRA disappeared" is the same confusion as "my LoRA did
              nothing", one step earlier.

              …and an adapter with NO recorded base model is LISTED, marked with
              a `?`. Hiding it was the app treating its own missing metadata as
              a fact about the weights — the loudest possible version of the
              same confusion, since that row is exactly the one the user has to
              go looking for. */}
          {mediaProvider === 'local' && (modality === 'image' || modality === 'video') && activeLocalRow && (
            <div>
              <span style={labelStyle}>{t('composer.loras')}</span>
              {compatibleLoras.length === 0 ? (
                <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                  {t('composer.lorasNone')}
                  {incompatibleAdapterCount > 0 && ` ${t('composer.lorasIncompatible', { count: incompatibleAdapterCount })}`}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {compatibleLoras.map(a => {
                    const on = selectedLoras[a.id] !== undefined
                    const weight = on ? selectedLoras[a.id] : (a.defaultWeight ?? LORA_WEIGHT_DEFAULT)
                    const unknownFamily = adapterFamilyVerdict(a.family, activeLocalRow.family) === 'unknown'
                    // The tag preview is how a user finds this file on disk, so the
                    // unknown-family hint is APPENDED to it rather than replacing it.
                    const loraTitle = unknownFamily
                      ? `<lora:${a.slug}:${weight}> — ${t('composer.loraUnknownFamily')}`
                      : `<lora:${a.slug}:${weight}>`
                    return (
                      <div key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button
                          onClick={() => {
                            const next = { ...selectedLoras }
                            if (on) delete next[a.id]
                            else next[a.id] = normalizeLoraWeight(a.defaultWeight ?? LORA_WEIGHT_DEFAULT)
                            setSelectedLoras(next)
                          }}
                          title={loraTitle}
                          style={{
                            ...btnStyle, flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis',
                            borderColor: on ? 'var(--accent)' : undefined,
                            color: on ? 'var(--accent-text)' : undefined,
                          }}
                        >
                          {on ? '● ' : '○ '}{a.name}
                          {/* Subtle, not a warning: the weights may well be
                              perfect, we simply have no record of their base. */}
                          {unknownFamily && <span style={{ opacity: 0.55, marginLeft: 4 }}>?</span>}
                        </button>
                        {on && (
                          <input
                            type="number"
                            value={weight}
                            min={LORA_WEIGHT_MIN} max={LORA_WEIGHT_MAX} step={0.05}
                            onChange={e => {
                              const w = normalizeLoraWeight(e.target.value)
                              setSelectedLoras({ ...selectedLoras, [a.id]: w })
                            }}
                            title={t('composer.loraWeight')}
                            style={{ ...inputStyle, width: 64 }}
                          />
                        )}
                      </div>
                    )
                  })}
                  {incompatibleAdapterCount > 0 && (
                    <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                      {t('composer.lorasIncompatible', { count: incompatibleAdapterCount })}
                    </div>
                  )}
                  {unknownFamilyLoraCount > 0 && (
                    <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                      {t('composer.lorasUnknownFamilyNote', { count: unknownFamilyLoraCount })}
                    </div>
                  )}
                </div>
              )}

              {/* TAGS THE USER TYPED. A prompt pasted from Civitai arrives with
                  `<lora:…>` already in it, naming the file as it was on THAT
                  machine. What happens to it is decided in the arg builder
                  (resolveTypedLoraTags) — this says so BEFORE the GPU time is
                  spent, using the same function and the same list, so the two
                  cannot disagree. Nothing renders when the prompt has no tag. */}
              {promptKey && (() => {
                const r = resolveTypedLoraTags(String(params[promptKey] ?? ''), localLoraNames)
                const lines: string[] = []
                for (const a of r.applied) lines.push(t('composer.loraTagFound', { name: a.name, weight: a.weight }))
                for (const n of r.unknown) lines.push(t('composer.loraTagUnknown', { name: n }))
                for (const n of r.ambiguous) lines.push(t('composer.loraTagAmbiguous', { name: n }))
                if (lines.length === 0) return null
                return (
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {lines.map((line, i) => (
                      <div key={i} style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4 }}>{line}</div>
                    ))}
                  </div>
                )
              })()}

              {/* Trigger words: the creator's own tokens, as TOGGLES on the
                  prompt (the applyStyle machinery, one token at a time).
                  Whole-token, case-insensitive — a substring match would let
                  "girl" hide "1girl" and the chip would go dead. */}
              {promptKey && activeLoras.length > 0 && (() => {
                const words = compatibleLoras
                  .filter(a => selectedLoras[a.id] !== undefined)
                  .flatMap(a => a.triggerWords)
                if (words.length === 0) return null
                const promptText = String(params[promptKey] ?? '')
                return (
                  <div style={{ marginTop: 6 }}>
                    <span style={labelStyle}>{t('composer.triggerWords')}</span>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {Array.from(new Set(words)).map(w => {
                        const on = hasTriggerWord(promptText, w)
                        return (
                          <button
                            key={w}
                            onClick={() => setParam(modality, promptKey, toggleTriggerWord(promptText, w))}
                            style={{
                              ...btnStyle, fontSize: 9, padding: '2px 6px',
                              borderColor: on ? 'var(--accent)' : undefined,
                              color: on ? 'var(--accent-text)' : undefined,
                            }}
                          >
                            {on ? '✓ ' : '+ '}{w}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}

              {/* VAE swap — reachable on the SINGLE-FILE branch for the first
                  time (the fp16-VAE black-image trap had no way out before). */}
              {compatibleVaes.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <span style={labelStyle}>{t('composer.vaeSwap')}</span>
                  <select value={selectedVae} onChange={e => setSelectedVae(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
                    <option value="">{t('composer.vaeDefault')}</option>
                    {/* Same rule as the LoRA rows: an unrecorded base model is
                        marked, not hidden. An <option> takes text only, so the
                        marker is the same `?` glyph appended. */}
                    {compatibleVaes.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.name}{adapterFamilyVerdict(a.family, activeLocalRow.family) === 'unknown' ? ' ?' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Prompt presets (image/video/music/tts). TODO(prompt-enhance): a
              "rewrite/expand prompt" button needs a TEXT-model round-trip; there
              is no clean ≤1-IPC text path on surplusMedia (it only does media),
              so it's deferred rather than inventing new IPC. */}
          {presets && presets.length > 0 && promptKey && (
            <div>
              <span style={labelStyle}>{t('composer.preset')}</span>
              <select
                value=""
                onChange={e => {
                  const p = presets.find(x => x.id === e.target.value)
                  if (p) setParam(modality, promptKey, p.text)
                  e.target.value = ''
                }}
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                <option value="">{t('composer.presetPlaceholder')}</option>
                {presets.map(p => (
                  <option key={p.id} value={p.id}>
                    {t(promptPresetLabelKey(modality, p.id), { defaultValue: p.label })}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* STT: dedicated File picker (uploads bytes, not a filename) */}
          {modality === 'stt' && (
            <div>
              <span style={labelStyle}>{t('composer.audioFile')}<span style={{ color: 'var(--warning)', marginLeft: 4 }}>*</span></span>
              <input
                ref={audioInputRef}
                type="file"
                accept={AUDIO_ACCEPT}
                style={{ display: 'none' }}
                onChange={e => { setSttFile(e.target.files?.[0] ?? null); e.target.value = '' }}
              />
              <button onClick={() => audioInputRef.current?.click()} style={{ ...btnStyle, width: '100%' }}>
                {sttFile ? t('composer.changeFile') : t('composer.chooseAudioFile')}
              </button>
              {sttFile && (
                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                  {sttFile.name}
                </div>
              )}
            </div>
          )}

          {/* Schema-driven params (prompt/input/negative_prompt/seed/cfg/… by data) */}
          {loadingSchema ? (
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('composer.loadingParams')}</div>
          ) : shownSchema.length > 0 ? (
            <ParamFields
              schema={shownSchema}
              values={params}
              onChange={(name, value) => setParam(modality, name, value)}
            />
          ) : model ? (
            <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.4 }}>
              {t('composer.noParams')}
            </div>
          ) : null}

          {/* Auto-save folder toggle */}
          <div>
            <span style={labelStyle}>{t('composer.autoSaveFolder')}</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button onClick={pickAutoSaveDir} style={btnStyle}>
                {autoSaveDir ? t('actions.change') : t('composer.setFolder')}
              </button>
              {autoSaveDir && (
                <button onClick={() => setAutoSaveDir(null)} style={{ ...btnStyle, color: 'var(--text-dim)' }}>{t('actions.clear')}</button>
              )}
            </div>
            {autoSaveDir && (
              <div style={{ marginTop: 4, fontSize: 9, color: 'var(--text-dim)', wordBreak: 'break-all' }}>
                {autoSaveDir}
              </div>
            )}
          </div>

          {/* Restore params from a locally-generated PNG (local image provider only) */}
          {modality === 'image' && (
            <div>
              <span style={labelStyle}>{t('restore.button')}</span>
              <input
                ref={restoreInputRef}
                type="file"
                accept="image/png,.png"
                style={{ display: 'none' }}
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) void restoreFromImage(file)
                  e.target.value = ''
                }}
              />
              <button
                onClick={() => restoreInputRef.current?.click()}
                title={t('restore.buttonTitle')}
                style={{ ...btnStyle, width: '100%' }}
              >
                {t('restore.button')}
              </button>
            </div>
          )}

          {/* Resolved route echo — the chip and the model dropdown are two
              controls; this one line is the single truth of what GENERATE
              will actually run (and bill).

              DERIVED FROM ONE SNAPSHOT. It used to take the provider from live
              state and the label from whatever list was loaded, so during a
              modality fallback it spent ~250 ms reading "SURPLUS · SD-TURBO" —
              a cloud provider beside a local checkpoint, a route that does not
              exist. resolveRouteEcho returns null until the two agree, and a
              blank beat is the honest thing to show in the meantime. */}
          {routeEcho && (
            <div style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
              color: 'var(--text-dim)', letterSpacing: '0.06em',
              textTransform: 'uppercase', marginBottom: 4,
            }} title={model}>
              {routeEcho.provider} · {routeEcho.label ?? modelDisplayName(model)}
            </div>
          )}

          {/* Generate */}
          <button
            data-tour="media-generate"
            onClick={generate}
            disabled={busy || !model}
            style={{
              padding: '10px 12px',
              border: '2px solid var(--accent)',
              background: busy || !model ? 'var(--bg-elevated)' : 'var(--accent)',
              color: busy || !model ? 'var(--text-dim)' : '#ffffff',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              cursor: busy || !model ? 'not-allowed' : 'pointer',
              boxShadow: busy || !model ? 'none' : '2px 2px 0 rgba(0,0,0,0.3)',
            }}
          >
            {busy ? (progress ? t('actions.workingProgress', { progress }) : t('actions.working')) : (modality === 'stt' ? t('actions.transcribe') : t('actions.generate'))}
          </button>

          {/* STOP — only while a KILLABLE render is in flight. A cloud job has
              no child process to kill, so offering it there would be a button
              that lies. Rendered from the STORE, so it is still here after a
              tab switch: this is exactly the control the owner went looking for
              and could not find («i cant stop it»). */}
          {busy && run.cancellable && (
            <button
              data-tour="media-stop"
              onClick={() => void stopGeneration()}
              disabled={run.stopping}
              title={t('actions.stopTitle')}
              style={{
                padding: '8px 12px',
                border: '2px solid var(--danger, #c00)',
                background: 'var(--bg-elevated)',
                color: 'var(--danger, #c00)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                cursor: run.stopping ? 'progress' : 'pointer',
                opacity: run.stopping ? 0.7 : 1,
              }}
            >
              {run.stopping ? t('actions.stopping') : t('actions.stop')}
            </button>
          )}

          {/* THE PICTURE, WHILE IT IS STILL BECOMING ONE.
              A local render showed a bar and nothing else for as long as eleven
              minutes; sd.cpp has always been able to decode its own latents
              mid-run and we simply never asked. Frames arrive every few sampler
              steps, so this appears once sampling starts and then keeps the
              newest one — a slot that emptied between frames would flicker.

              Labelled, because a half-denoised latent is not the result and
              must never be mistaken for one, and `alt` says the same thing to a
              screen reader. It disappears with `busy`; the finished image
              belongs to the gallery. */}
          {busy && run.preview && (
            <div style={{ border: '2px solid var(--border)', background: 'var(--bg-elevated)' }}>
              <img
                src={run.preview}
                alt={t('livePreview.alt')}
                style={{ display: 'block', width: '100%', imageRendering: 'auto' }}
              />
              <div style={{
                padding: '3px 6px', borderTop: '2px solid var(--border)',
                fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                color: 'var(--text-dim)',
              }}>
                {t('livePreview.label')}
              </div>
            </div>
          )}

          {/* How a run ENDED — persists until dismissed (a toast cannot survive
              a 70-minute render the user walked away from, which is the whole
              reason this row exists).

              A STOP THE USER ASKED FOR IS NOT A FAILURE, and this is the
              surface most likely to be read: it is still here when they come
              back. So the stop wears neutral chrome, gets `role="status"`
              rather than the assertive `alert` (being interrupted about your
              own Stop is the audible version of the red border), and swaps the
              out-of-memory hint — which blames the GPU for something the user
              did on purpose — for copy that says what actually happened. Only
              the framing changes: main's own sentence is still printed
              verbatim, and a real failure is untouched. */}
          {genError && (
            <div role={genErrorIsStop ? 'status' : 'alert'} style={{
              border: `2px solid ${genErrorIsStop ? 'var(--border)' : 'var(--danger, #c00)'}`, padding: 6,
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <span style={{
                fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: genErrorIsStop ? 'var(--text-dim)' : 'var(--danger, #c00)',
              }}>{genErrorIsStop ? t('genError.stoppedTitle') : t('genError.title')}</span>
              <span style={{
                fontSize: 9, wordBreak: 'break-word', lineHeight: 1.4,
                color: genErrorIsStop ? 'var(--text)' : 'var(--danger, #c00)',
              }}>
                {genError}
              </span>
              <span style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                {genErrorIsStop ? t('genError.stoppedHint') : t('genError.hint')}
              </span>
              {/* …and when what failed was the WALLET rather than the render, the
                  free engine is one button away. Main's sentence stays verbatim
                  above; this only adds the door it never mentioned. */}
              {offerLocalSwitchForRun && (
                <button
                  onClick={switchToLocal}
                  title={t('local.switchToLocalTitle')}
                  style={{
                    ...btnStyle, width: '100%', textAlign: 'left',
                    border: '2px solid var(--accent)', color: 'var(--accent-text)',
                  }}
                >
                  {t('local.switchToLocal')}
                </button>
              )}
              <button onClick={() => clearRunError()} style={{ ...btnStyle, width: '100%' }}>
                {t('genError.dismiss')}
              </button>
            </div>
          )}
        </div>

        {/* ── Right: persistent result gallery ─────────────────────────────── */}
        <div data-tour="media-gallery" style={{
          flex: 1,
          overflowY: 'auto',
          padding: 16,
          background: 'var(--bg-base)',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {gallery.length === 0 ? (
            <div style={{
              color: 'var(--text-dim)', fontSize: 12, lineHeight: 1.6,
              border: '2px dashed var(--border)', padding: 24, textAlign: 'center',
            }}>
              {t('gallery.empty')}
            </div>
          ) : (
            <>
              {/* Gallery toolbar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                  {/* AT THE CAP THE NUMBER STOPS MOVING — SAY SO. Three new
                      entries evict three old ones, so "Gallery (60)" is correct
                      and looks frozen; a reader cannot tell 60-of-60 from
                      60-and-growing. The full variant names the cap, which is
                      the fact behind the stillness. */}
                  {gallery.length >= GALLERY_CAP
                    ? t('gallery.titleFull', { count: gallery.length })
                    : t('gallery.title', { count: gallery.length })}
                </span>
                {/* THE COUNT IS NOT EVIDENCE ONCE THE GALLERY IS FULL.
                    GALLERY_CAP is 60, and the driver's gallery was already at
                    60: a finished 27-minute render left this line reading
                    "Gallery (60)" exactly as it read before the click. Its own
                    harness gave up on the number and watched the newest entry's
                    id instead. So the newest entry's TIME rides alongside — it
                    changes on every landing whether the count can or not, and
                    it is the one fact the user is looking for. */}
                {gallery[0] && (() => {
                  const newest = galleryTimestamp(gallery[0].createdAt, i18n.language)
                  return (
                    <span
                      title={newest.full}
                      style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-dim)', opacity: 0.7 }}
                    >
                      {t('gallery.newest', { time: newest.time })}
                    </span>
                  )
                })()}
                <button onClick={() => { void confirmClearGallery() }} style={{ ...btnStyle, marginLeft: 'auto', color: 'var(--text-dim)' }}>
                  {t('gallery.clearAll')}
                </button>
              </div>

              {/* PINNED FIRST. The card's own button says "Pin to top" and this
                  list rendered the store's insertion order, so the pin moved
                  nothing — while the Artifacts tab, over the same store, has
                  always sorted. One comparator, shared, so the two tabs cannot
                  answer "where does a pin go" differently again. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {galleryItems.map(entry => (
                  <div key={entry.id} style={{
                    border: `2px solid ${entry.favorite ? 'var(--accent)' : 'var(--border)'}`,
                    background: 'var(--bg-surface)',
                  }}>
                    <div style={{
                      padding: '6px 10px',
                      borderBottom: '2px solid var(--border)',
                      display: 'flex', alignItems: 'center', gap: 8,
                      background: 'var(--bg-elevated)',
                    }}>
                      <button
                        onClick={() => toggleFavorite(entry.id)}
                        title={entry.favorite ? t('entry.unpin') : t('entry.pinToTop')}
                        style={{
                          ...btnStyle, padding: '2px 6px',
                          border: `2px solid ${entry.favorite ? 'var(--accent)' : 'var(--border)'}`,
                          background: entry.favorite ? 'var(--accent-muted)' : 'var(--bg-elevated)',
                          color: entry.favorite ? 'var(--accent-text)' : 'var(--text-dim)',
                        }}
                      >
                        {entry.favorite ? t('entry.pinned') : t('entry.pin')}
                      </button>
                      <span style={{
                        fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                        textTransform: 'uppercase', color: 'var(--accent-text)',
                      }}>{entry.modality}</span>
                      <span style={{ fontSize: 10, color: 'var(--text-dim)' }} title={entry.model}>{modelDisplayName(entry.model)}</span>
                      {entry.completedAfterPrivate && (
                        <span
                          title={t('entry.completedAfterPrivateTitle')}
                          style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
                            color: 'var(--text-dim)', border: '2px solid var(--border)', padding: '1px 6px',
                          }}
                        >
                          {t('entry.completedAfterPrivate')}
                        </span>
                      )}
                      <span style={{
                        flex: 1, fontSize: 10, color: 'var(--text-muted)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{entry.prompt}</span>
                      {entry.params && (
                        <button onClick={() => remix(entry, entry.modality === 'image')} style={{ ...btnStyle, padding: '2px 8px' }}>
                          {t('entry.remix')}
                        </button>
                      )}
                      <button onClick={() => { void confirmRemoveEntry(entry.id) }} title={t('entry.remove')} style={{ ...btnStyle, padding: '2px 8px', color: 'var(--text-dim)' }}>
                        ✕
                      </button>
                    </div>
                    <div style={{ padding: 12, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                      {entry.text !== undefined ? (
                        <div style={{
                          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                          fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6, width: '100%',
                        }}>
                          {entry.text}
                        </div>
                      ) : (
                        entry.artifacts.map((a, i) => (
                          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {a.kind === 'image' && (
                              <img src={artifactSrc(a)} alt={t('entry.generatedAlt')}
                                onClick={() => setFullscreen(a)}
                                style={{ maxWidth: 320, maxHeight: 320, border: '2px solid var(--border)', display: 'block', cursor: 'zoom-in' }} />
                            )}
                            {a.kind === 'audio' && (
                              <audio controls src={artifactSrc(a)} style={{ display: 'block', maxWidth: 320 }} />
                            )}
                            {a.kind === 'video' && (
                              <video controls src={artifactSrc(a)}
                                onClick={() => setFullscreen(a)}
                                style={{ maxWidth: 320, border: '2px solid var(--border)', display: 'block', cursor: 'zoom-in' }} />
                            )}
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button onClick={() => saveArtifact(a)} style={btnStyle} disabled={!a.path}>{t('actions.save')}</button>
                              {a.path && (
                                <button onClick={() => { if (a.path) window.tachi.shell.revealInFolder(a.path).catch(() => {}) }} style={btnStyle}>{t('actions.reveal')}</button>
                              )}
                              {(a.kind === 'image' || a.kind === 'video') && (
                                <button onClick={() => setFullscreen(a)} style={btnStyle}>{t('actions.fullscreen')}</button>
                              )}
                              {/* Local frame interpolation. Only on a video that
                                  actually has a file on disk — the pipeline
                                  reads bytes, not a media:// URL.

                                  onSaved IS THE ROUTE BACK TO THE FILE. Without
                                  it a finished run left a new mp4 on disk that
                                  the app could not open, list or reveal once the
                                  toast was gone (driver: two successful runs,
                                  gallery still at 22). The derived clip lands
                                  through the same addEntry every generation
                                  uses; the entry says what it was made from and
                                  by what — see interpolatedGalleryEntry. */}
                              {a.kind === 'video' && a.path && (
                                <RifeAction
                                  path={a.path}
                                  style={btnStyle}
                                  onSaved={out => {
                                    const derived = interpolatedGalleryEntry({
                                      source:     entry,
                                      sourcePath: a.path,
                                      outputPath: out,
                                      now:        Date.now(),
                                      label:      name => t('rife.derived', { source: name }),
                                      // The LIVE gallery, not this render's closure:
                                      // the same file must never land twice.
                                      existing:   useMediaStore.getState().gallery,
                                    })
                                    if (derived) addEntry(derived)
                                  }}
                                />
                              )}
                              {/* MAKE IT BIGGER — the #1 follow-up to a finished
                                  render. Only on an IMAGE with a file on disk:
                                  `-M upscale` reads bytes, so a cloud artifact
                                  served from a URL has nothing to offer.

                                  Files its output the same way the interpolation
                                  above does, and for the same reason — a derived
                                  file that is not in the gallery does not exist.
                                  The entry carries no params, which is load-bearing
                                  here: the engine stamps the upscaled PNG with its
                                  OWN default `parameters` chunk claiming 20 steps
                                  and seed 42 for a run that sampled nothing. See
                                  upscaledGalleryEntry. */}
                              {a.kind === 'image' && a.path && (
                                <UpscaleAction
                                  path={a.path}
                                  style={btnStyle}
                                  onSaved={(out, scale) => {
                                    const derived = upscaledGalleryEntry({
                                      source:     entry,
                                      sourcePath: a.path,
                                      outputPath: out,
                                      now:        Date.now(),
                                      scale,
                                      label:      name => t('upscale.derived', { scale, source: name }),
                                      existing:   useMediaStore.getState().gallery,
                                    })
                                    if (derived) addEntry(derived)
                                  }}
                                />
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Fullscreen preview overlay ───────────────────────────────────────── */}
      {fullscreen && (
        <div
          onClick={() => setFullscreen(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.88)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 32,
          }}
        >
          <button
            onClick={() => setFullscreen(null)}
            style={{
              position: 'absolute', top: 16, right: 16,
              ...btnStyle, padding: '6px 12px',
              border: '2px solid var(--accent)', background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            }}
          >
            {t('preview.close')}
          </button>
          {fullscreen.kind === 'image' ? (
            <img
              src={artifactSrc(fullscreen)}
              alt={t('preview.alt')}
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: '100%', maxHeight: '100%', border: '2px solid var(--border)', objectFit: 'contain' }}
            />
          ) : (
            <video
              src={artifactSrc(fullscreen)}
              controls
              autoPlay
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: '100%', maxHeight: '100%', border: '2px solid var(--border)' }}
            />
          )}
        </div>
      )}
    </div>
  )
}
