// apps/desktop/src/pages/catalog/blockedLocalRows.ts
//
// LOCAL MODEL ROWS WE REFUSE TO SHIP, AS CARDS THAT SAY WHY.
//
// electron/services/sd-cpp-models.ts keeps a third registry next to the image
// and video ones: SD_BLOCKED_MODELS, "a row whose DATA is verified but which we
// refuse to ship, with the reason". Its whole purpose is that the research does
// not evaporate and the refusal is stated rather than implied by an absence.
//
// It was stated to no one. The `sd-cpp:catalog` IPC maps SD_IMAGE_MODELS and
// SD_VIDEO_MODELS and stops there, so the blocked row never reached the
// renderer — a driver enumerating all 55 catalog rows found no Klein entry
// anywhere, and the honest-refusal intent of 0fab056 was unmet from the moment
// it landed.
//
// ── WHY A MIRROR AND NOT AN IMPORT ───────────────────────────────────────────
//
// sd-cpp-models.ts imports user-sd-models, which reads the filesystem through
// electron's app paths. The renderer cannot import that, and widening the IPC
// is not this lane's territory. The house pattern for exactly this situation is
// a renderer-side copy pinned by a test against the authoritative main-process
// one — mediaHelpers' SD_PRESETS / presetsForRow mirror the same file and
// test/unit/mediaLocalGenParams.test.ts pins them. Here the pin lives in
// test/unit/sdBlockedCatalogRow.test.ts, which imports BOTH sides and compares
// id / name / family / reason field by field. Editing SD_BLOCKED_MODELS without
// editing this file fails there.
//
// ── WHAT THE CARD MAY CLAIM ──────────────────────────────────────────────────
//
// No quants. A quant is a downloadable artifact, and by definition this row has
// none that resolve — the DiT is pinned but the VAE and the text encoder are
// not. Declaring one would hand the card a "Download size: 2.3 GB" chip and a
// VRAM fit verdict about a model nobody can obtain: a confident number printed
// underneath a refusal. Empty quants also mean the install-state check
// (`quants.some(q => isInstalled(...))`) can never call it installed.
//
// NOT THE CLOUD MODEL OF THE SAME NAME. The Surplus dropdown offers
// "flux.2-klein-4b | FLUX.2 Klein 4B" — that is the provider's own hosted
// model, served over their API, and nothing here touches it. This file is only
// about weights we would run locally.

import type { CatalogEntry, Capability } from '@tachi/core'

/** The renderer's view of one SD_BLOCKED_MODELS row. */
export interface BlockedLocalRow {
  id:     string
  name:   string
  family: string
  /** Which grid tag it would carry if it shipped. */
  kind:   'image' | 'video'
  /** WHY it is not offered — main's own words, verbatim. */
  reason: string
}

/**
 * MIRROR of SD_BLOCKED_MODELS (electron/services/sd-cpp-models.ts), which is
 * the authoritative copy. `reason` is that row's `blocked` field unchanged: it
 * was written for the person who unblocks the model, and paraphrasing it into
 * marketing-speak would lose the two decisions it is actually recording.
 */
export const BLOCKED_LOCAL_ROWS: readonly BlockedLocalRow[] = [
  {
    id: 'flux2-klein-4b',
    name: 'FLUX.2 Klein 4B (Q4_0)',
    // `flux2`, not `flux`: a different architecture (different VAE latent
    // format, LLM conditioning), and calling it 'flux' would poison the compat
    // gate the day it ships.
    family: 'flux2',
    kind: 'image',
    // The tail sentence is the "what you would get" half, added deliberately:
    // a refusal that lists only blockers reads as a model we could not be
    // bothered to finish. Klein is EDIT-capable at our own pin (research:
    // LOWVRAM-META-RESEARCH-2026-07-28, DELTA ADDENDUM §B), which is a
    // capability class no shipped local row has — worth stating, and stated
    // subjunctively because the row still cannot load.
    reason:
      'Needs two components we cannot pin yet. VAE: upstream docs/flux2.md points at flux2_ae.safetensors in the GATED, NON-COMMERCIAL black-forest-labs/FLUX.2-dev repo; the apache-2.0 klein-4B repo ships one only in DIFFUSERS layout (a container the installer refuses), and FLUX.2-small-decoder is an untested alternative — pick one and prove it loads. LLM encoder: upstream uses qwen_3_4b.safetensors, PLAIN Qwen3-4B, which is a different checkpoint from the Qwen3-4B-Instruct-2507 the Z-Image row pins, and no re-host with a published sha256 was found. What unlocking it would buy: this is not another text-to-image model. Klein edits an existing picture against a reference image, and our pinned engine already speaks it — upstream docs/flux2.md ships Klein edit examples driven by `-r ref.png`, and the flag is parsed as a list, so two of them (`-r a.png -r b.png`) drive the face-swap and merge tricks the model is known for. Nothing we ship locally today can edit a photo against a reference at all, so these two files would add a capability, not just another checkpoint.',
  },
  // ── LTX-2.3 LEFT THIS LIST, and the reason is worth keeping here ───────────
  //
  // b56c3d7 added it as the first blocked VIDEO row and the first refusal that
  // was not about missing files: all five components resolved anonymously and
  // every source repo declared a redistributable licence. One of its five
  // stated blockers was "the model registry has no way to surface a licence
  // today", and the reasoning underneath it treated the LTX-2 agreement's
  // pass-through duties as OURS. They belong to a DISTRIBUTOR; this app is an
  // MIT download client that re-hosts nothing, so the duty that was actually
  // ours was informed consent — which SdLicensedRow (licenseName / licenseUrl)
  // and the download panel's licence line now discharge.
  //
  // It is a shipped row in SD_VIDEO_MODELS. Do NOT re-add it here.
  //
  // The Wan 2.1 TI2V / A14B distill packs stay blocked in
  // SD_BLOCKED_SPEED_ADAPTERS, and that is a different case entirely: those
  // weights have no grant at the source at all.
]

/**
 * Entry-id namespace. Deliberately NOT `sdcpp:` — that prefix means "an
 * installable local row" everywhere else (favorites, recents, the install-state
 * lookup), and a blocked row must not be able to answer to it.
 */
export const BLOCKED_LOCAL_ID_PREFIX = 'sdcpp-blocked:'

/** Build the grid row. `kind: 'text'` is the same benign placeholder
 *  sdCatalogEntry uses — the real modality rides on `capabilities`. */
export function blockedLocalCatalogEntry(row: BlockedLocalRow): CatalogEntry {
  return {
    id: `${BLOCKED_LOCAL_ID_PREFIX}${row.id}`,
    name: row.name,
    family: row.family,
    params: '',
    kind: 'text',
    source: 'curated',
    quants: [],
    capabilities: [(row.kind === 'video' ? 'video-gen' : 'image-gen') as Capability],
  }
}

/** Every blocked row as a grid entry. */
export function blockedLocalCatalogEntries(): CatalogEntry[] {
  return BLOCKED_LOCAL_ROWS.map(blockedLocalCatalogEntry)
}

/**
 * The refusal to print on a card, or null when the row is a normal one.
 *
 * Null — not an empty string — so the card's `blockedReason ? …` branch is a
 * clean either/or and an ordinary row can never fall into the refusal shape.
 */
export function blockedLocalReasonFor(entryId: string): string | null {
  if (!entryId.startsWith(BLOCKED_LOCAL_ID_PREFIX)) return null
  const id = entryId.slice(BLOCKED_LOCAL_ID_PREFIX.length)
  return BLOCKED_LOCAL_ROWS.find(r => r.id === id)?.reason ?? null
}
