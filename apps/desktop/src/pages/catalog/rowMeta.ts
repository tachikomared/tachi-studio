// apps/desktop/src/pages/catalog/rowMeta.ts
//
// Pure row-classification helpers for the unified catalog browser. Extracted
// out of CatalogPage/ModelCard so the *decisions* (can this download be
// stopped? does a VRAM verdict mean anything for this row?) are assertable in a
// node-env unit test instead of only reachable through a React render.
//
// No React, no electron, no i18n — data in, verdict out.

import type { CatalogEntry, RuntimeId } from '@tachi/core'

/**
 * Runtimes whose weight files go through the central download-manager, and can
 * therefore be PAUSED from the Catalog progress strip.
 *
 * The contract is uniform across all four: Stop keeps the `.part` bytes on
 * disk, the DOWNLOADS strip offers RESUME, and a re-click in Catalog resumes
 * from the same offset. Nothing here is a hard cancel, and nothing here deletes
 * a partial file.
 *
 * `ollama` is deliberately absent: its pull is driven by the Ollama daemon, not
 * by our manager, so we have no pause handle for it and must not draw a button
 * that cannot do anything.
 */
export const STOPPABLE_RUNTIMES: readonly RuntimeId[] = ['llamacpp', 'sdcpp', 'piper', 'whisper']

/** True when a Stop button is honest for this in-flight runtime. */
export function canStopDownload(runtime: string | undefined | null): boolean {
  return runtime != null && (STOPPABLE_RUNTIMES as readonly string[]).includes(runtime)
}

/**
 * What the Stop button may honestly do RIGHT NOW.
 *
 *   'hidden'  — this runtime has no pause handle at all (an Ollama pull), or
 *               there is no download to stop.
 *   'pending' — the strip is up but nothing is transferring: either the
 *               transfer has not started yet, or it has finished and the file
 *               is being verified. Neither is pausable.
 *   'ready'   — bytes are moving; Stop pauses and keeps the `.part`.
 *
 * The 'pending' state is the one that had to be named. CatalogPage puts the
 * strip on screen (`⏳ Starting…`, 0%) the instant the user clicks DOWNLOAD,
 * BEFORE the IPC round-trip, before the installer takes its lock, and before
 * `runManagedDownload` registers the task. Inside that window
 * `pauseManagedDownload` returns false twice over — first because no task
 * exists, then because a freshly registered one is `state: 'queued'`, and it
 * only pauses `'active'`. So Stop was drawn as a live control that did nothing,
 * and a user with a slow hand read the silence as a broken button.
 *
 * Cancelling the queued task instead is NOT the fix: the manager's
 * `cancelManagedDownload` deletes the partial (the opposite of this Stop's
 * pause-and-keep contract, which the installers are source-pinned to), and it
 * cannot touch the earlier half of the window where no task exists at all.
 * Honest disabling is the whole of it.
 *
 * "Bytes are moving" is read off the progress the sidecar streams — a non-zero
 * percent or a non-zero speed. Both are zero exactly in the two windows where
 * the manager cannot pause anything: before the transfer starts, and during
 * post-transfer verification (which reports percent -1, floored to 0). The
 * pending tooltip therefore states the RULE ("Stop is available while the
 * download is transferring") rather than guessing which of the two you are in.
 */
export type StopAvailability = 'hidden' | 'pending' | 'ready'

export interface StopAvailabilityInput {
  runtime?: string | null | undefined
  ref?: string | null | undefined
  pct?: number | undefined
  speedBytesPerSec?: number | undefined
}

export function stopAvailability(d: StopAvailabilityInput | null | undefined): StopAvailability {
  if (!d || !d.ref || !canStopDownload(d.runtime)) return 'hidden'
  const moving = (d.pct ?? 0) > 0 || (d.speedBytesPerSec ?? 0) > 0
  return moving ? 'ready' : 'pending'
}

/** Runtimes that produce SPEECH models (TTS voices / STT weights). */
export const SPEECH_RUNTIMES: readonly RuntimeId[] = ['piper', 'whisper']

/**
 * True for a piper voice or a whisper STT row.
 *
 * These carry `kind: 'speech'` from the store builders; the runtime check is the
 * belt-and-braces half so a row built by an older main-process build (or a
 * future speech engine that forgets the `kind`) still classifies correctly.
 */
export function isSpeechRow(entry: Pick<CatalogEntry, 'kind' | 'quants'>): boolean {
  if (entry.kind === 'speech') return true
  const quants = entry.quants ?? []
  return quants.length > 0 && quants.every(q => (SPEECH_RUNTIMES as readonly string[]).includes(q.runtime))
}

/**
 * Whether the VRAM/RAM fit verdict says anything TRUE about this row.
 *
 * It does not for speech models: a 28-63 MB piper voice and a 75 MB-1.5 GB
 * whisper weight are compared against a text-transformer heuristic (1.2x
 * overhead for a KV cache these engines do not have), so every one of them
 * came back "Fits in GPU (fast)" — a confident, meaningless verdict on a row
 * that never touches the GPU offload path at all. Show the honest download size
 * instead; see fitOrSizeLine() below.
 *
 * It does not for sd.cpp media rows either — the SAME fabricated-verdict
 * class, just a different heuristic gap. estimateFit()'s `sizeBytes * 1.2`
 * overhead models a text-transformer's KV cache; a diffusion/video model's
 * real peak is decided by resolution, frame count and which offload flags are
 * on, none of which the download size encodes. That produced a Flux
 * checkpoint reading "too big" on hardware that runs it fine, right next to a
 * Wan 1.4 GB DiT reading "Fits in GPU (fast)" on a card whose VAE decode is
 * the actual peak. See mediaFitNote() below for the honest replacement.
 */
export function showsFitVerdict(entry: Pick<CatalogEntry, 'kind' | 'quants'>): boolean {
  return !isSpeechRow(entry) && !isMediaRow(entry)
}

/** Runtimes that produce local MEDIA weights (sd.cpp image + video models). */
export const MEDIA_RUNTIMES: readonly RuntimeId[] = ['sdcpp']

/**
 * True for a local image/video row (sd.cpp).
 *
 * These rows cannot be recognised by `kind`: catalog.store's sdCatalogEntry
 * writes `kind: 'text'` as a deliberate placeholder and carries the real
 * modality in `capabilities` — so the runtime IS the classifier here, unlike
 * the speech rows where `kind` is authoritative and the runtime is the fallback.
 */
export function isMediaRow(entry: Pick<CatalogEntry, 'quants'>): boolean {
  const quants = entry.quants ?? []
  return quants.length > 0 && quants.every(q => (MEDIA_RUNTIMES as readonly string[]).includes(q.runtime))
}

/** The honest replacement for a suppressed sd.cpp fit verdict: a real
 *  structured VRAM estimate when the payload carries one. */
export interface MediaFitVramEstimate {
  kind: 'vram'
  /** Rounded to one decimal. */
  gb: number
}

/** The honest replacement when no structured estimate is available: a
 *  generic sentence naming what actually decides the peak. */
export interface MediaFitSentence {
  kind: 'sentence'
}

export type MediaFitNote = MediaFitVramEstimate | MediaFitSentence

/**
 * What an sd.cpp row should say INSTEAD of the suppressed fit verdict (see
 * showsFitVerdict) — never nothing, and never a number this module cannot
 * stand behind.
 *
 * `minVramGb` is feature-detected rather than declared on `CatalogEntry`:
 * a per-row structured estimate is wired into the sd.cpp catalog payload
 * separately (main-process work), and an older payload — or a row built
 * before that field existed — simply omits it. That is not an error case;
 * this function still owes the card an honest line, so it falls back to the
 * sentence rather than returning null or a fabricated number.
 *
 * Returns null for a non-media row — there is nothing to say here, the
 * computed verdict already applies (or the row is a speech weight with its
 * own suppression).
 */
export function mediaFitNote(
  entry: Pick<CatalogEntry, 'quants'> & { minVramGb?: number | null },
): MediaFitNote | null {
  if (!isMediaRow(entry)) return null
  const gb = entry.minVramGb
  if (typeof gb === 'number' && Number.isFinite(gb) && gb > 0) {
    return { kind: 'vram', gb: Math.round(gb * 10) / 10 }
  }
  return { kind: 'sentence' }
}

/**
 * Whether the card shows an explicit "Download size: N GB" chip.
 *
 * It used to be the strict inverse of showsFitVerdict — the size line existed
 * ONLY as a replacement for the suppressed speech verdict — which left sd.cpp
 * media rows with no size anywhere on the card: sd-turbo rendered
 * `sd15 · · sdcpp` and a fit verdict, and its 4.9 GB download was invisible
 * until the disk preflight mentioned it. Those are the biggest downloads in the
 * app; they are exactly the rows a size belongs on.
 *
 * Text rows are still excluded: their size is already implied by the params +
 * quant line the fit verdict sits on, and adding a chip to every llama.cpp /
 * Ollama / HF row is a redesign, not a bug fix.
 */
export function showsSizeChip(entry: Pick<CatalogEntry, 'kind' | 'quants'>): boolean {
  return isSpeechRow(entry) || isMediaRow(entry)
}

/**
 * Human download size for a catalog row. Binary units (what every other size
 * label in the app uses), one decimal under 10 GB, none for whole MB.
 * Returns null for a 0/unknown size — callers render nothing rather than "0 MB".
 */
export function formatModelSize(bytes: number): string | null {
  if (!(bytes > 0)) return null
  const MB = 1024 * 1024
  const GB = 1024 * MB
  if (bytes >= GB) {
    const gb = bytes / GB
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`
  }
  const mb = bytes / MB
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}

// ── The star is a control too ────────────────────────────────────────────────
//
// Driver finding (owner, live): the Klein card says NOT AVAILABLE and prints
// the reason where its buttons would be — and still offered the ☆. Favouriting
// a model that can never be installed pins a permanent "no" to the top of the
// rail.
//
// The refusal branch is checked before every FOOTER button, but the star lives
// above it in its own absolutely-positioned corner and was guarded only by
// `!civitai`. This is the same law applied one control further up.
//
// UNDO SURVIVES. Hiding it outright would strand anyone who starred the row
// before this rule existed: a favourite with no control to remove it. A blocked
// row therefore keeps the star exactly while it IS favourited — the pin can be
// taken back, a new one cannot be made, and once removed the star is gone.

export interface FavoriteControlInput {
  /** This card is a Civitai search result. */
  isCivitaiRow?: boolean
  /** The row is refused (blockedLocalRows) — null/'' when it is not. */
  blockedReason?: string | null
  /** It is pinned right now. */
  favorite?: boolean
}

export function showsFavoriteControl(input: FavoriteControlInput): boolean {
  // A Civitai row: never. Favorites + recents resolve against the CURATED list
  // (catalog.store's allCuratedById), so a starred search result would never
  // appear in the rail — a control that visibly does nothing.
  if (input.isCivitaiRow) return false
  if (input.blockedReason) return input.favorite === true
  return true
}

/** Total download size of a row = its smallest quant (what the card offers). */
export function rowSizeBytes(entry: Pick<CatalogEntry, 'quants'>): number {
  const quants = entry.quants ?? []
  if (quants.length === 0) return 0
  return [...quants].sort((a, b) => a.sizeBytes - b.sizeBytes)[0].sizeBytes
}
