// apps/desktop/src/pages/catalog/civitaiDetail.ts
//
// The DETAIL PANEL's decisions, as pure functions — same discipline as
// civitaiRow.ts and for the same reason: the unit suite runs in a node
// environment with no DOM, so anything that only exists inside a render is
// unassertable. Data in, verdict out.
//
// NOTHING HERE RECOMPUTES A FACT MAIN ALREADY DECIDED. `installable` / `reason`
// are read; the preview blur DELEGATES to civitaiRow's committed predicate
// rather than restating its bitmask; the gate is never consulted a second time.
// The panel's job is to say what main said, in the place a reader is looking.

import type { CivitaiModelDetail, CivitaiDetailVersion, CivitaiDetailPreview } from '../../types/electron'
import { civitaiAffordance, civitaiPreviewBlurred, type CivitaiAffordance } from './civitaiRow'

// ─── the panel's own load state ──────────────────────────────────────────────

/**
 * What the panel is showing about the model beyond the row it opened from.
 *
 * THE PANEL OPENS ON THE ROW, NOT ON THE FETCH, and that is the whole shape of
 * this type. Name, type, base model, size, format, trigger words, licence,
 * verdict and thumbnail all arrive with the row the card already had, so the
 * header and the Install control are correct and interactive on the first frame.
 * Only the three things a row cannot hold — the description, the creator, the
 * sibling versions — are 'loading', and only that region shows it.
 *
 * 'error' therefore does NOT blank the panel: the row facts are still true, so
 * the failure is a line inside the description region with a retry next to it.
 */
export type CivitaiDetailPhase = 'loading' | 'ready' | 'error'

export interface CivitaiDetailState {
  /** The row's model id — the panel is open for this, whatever the fetch did. */
  modelId: number
  /** The version the CARD resolved to. Leads the version list. */
  versionId: number
  phase: CivitaiDetailPhase
  detail: CivitaiModelDetail | null
  error: string | null
}

/** A fresh panel: open, waiting on prose, already able to render the row. */
export function civitaiDetailOpening(modelId: number, versionId: number): CivitaiDetailState {
  return { modelId, versionId, phase: 'loading', detail: null, error: null }
}

/**
 * Fold an IPC answer into the panel state, IGNORING a reply for a model the user
 * has already navigated away from.
 *
 * The staleness check is on `modelId`, not a request counter, because the panel
 * is single-instance: closing it and opening another card is the only way to
 * change what is in flight, and the id is the thing that actually identifies
 * what the reader is looking at. A late reply for the previous card must not
 * repaint the current one.
 */
export function civitaiDetailResolved(
  state: CivitaiDetailState | null,
  modelId: number,
  res: { detail?: CivitaiModelDetail | null; error?: string } | null | undefined,
): CivitaiDetailState | null {
  if (!state) return null
  if (state.modelId !== modelId) return state
  const detail = res?.detail ?? null
  if (!detail) {
    return { ...state, phase: 'error', detail: null, error: res?.error ?? null }
  }
  // A detail that arrived but that the GATE emptied is not an error — it is a
  // working filter, and `filteredVersionCount` is how the panel says so.
  return { ...state, phase: 'ready', detail, error: res?.error ?? null }
}

// ─── which version leads, and what the others are ────────────────────────────

/**
 * The version the panel is ABOUT.
 *
 * Main already sorted the requested version first, so this is `versions[0]` —
 * but it is asked for by id anyway, because "the version the card showed" and
 * "the first element" agreeing is a property of main's sort, not something the
 * panel should assume. Falls back to the lead when the requested version was
 * gated away (an unlock that lapsed between the browse and the click).
 */
export function civitaiLeadVersion(
  detail: CivitaiModelDetail | null | undefined,
  versionId?: number,
): CivitaiDetailVersion | null {
  const versions = detail?.versions ?? []
  if (versions.length === 0) return null
  if (typeof versionId === 'number') {
    const exact = versions.find(v => v.versionId === versionId)
    if (exact) return exact
  }
  return versions[0] ?? null
}

/** Everything except the lead, in main's order. The "other versions" section. */
export function civitaiOtherVersions(
  detail: CivitaiModelDetail | null | undefined,
  lead: CivitaiDetailVersion | null,
): CivitaiDetailVersion[] {
  const versions = detail?.versions ?? []
  if (!lead) return [...versions]
  return versions.filter(v => v.versionId !== lead.versionId)
}

/**
 * The honest line under the version list, or null when there is nothing to say.
 *
 *   'hidden'  — the gate refused some versions. Said out loud for the same
 *               reason the grid says `filteredCount`: a list that is shorter
 *               than the model's real version count, with no explanation, reads
 *               as a broken panel instead of a working filter.
 *   'capped'  — the model has more versions than the payload carries (a real
 *               case: 31 measured on DreamShaper against a cap of 8).
 *
 * `hidden` OUTRANKS `capped`, because a refusal is a fact about content and a
 * cap is a fact about our transport — and when both are true, the one the reader
 * needs is the one that explains a MISSING version rather than a truncated list.
 * A permanent "0 hidden" is never printed; the grid learned that lesson already.
 */
export type CivitaiVersionNotice =
  | { kind: 'hidden'; count: number }
  | { kind: 'capped'; shown: number; total: number }

export function civitaiVersionNotice(
  detail: CivitaiModelDetail | null | undefined,
): CivitaiVersionNotice | null {
  if (!detail) return null
  const hidden = normalizeCount(detail.filteredVersionCount)
  if (hidden > 0) return { kind: 'hidden', count: hidden }
  const shown = detail.versions?.length ?? 0
  const total = normalizeCount(detail.versionsTotal)
  if (total > shown && shown > 0) return { kind: 'capped', shown, total }
  return null
}

/** A count the UI may print. Defensive: an older main build sends undefined. */
function normalizeCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.floor(raw)
}

// ─── the affordance, reused verbatim ─────────────────────────────────────────

/**
 * What the panel may draw for one version — THE SAME FUNCTION THE CARD USES.
 *
 * Reused rather than re-derived on purpose: a panel that offered Install where
 * the card it opened from showed a refusal (or the reverse) would be a
 * contradiction the user can see and nobody can explain. `blocked` still means
 * NO BUTTON — the reason goes where the button would have been, and in the
 * panel it goes there in full, prominently, because there is finally room to
 * print "Needs an SDXL checkpoint — install one first…" as a sentence.
 */
export function civitaiVersionAffordance(
  version: Pick<CivitaiDetailVersion, 'installable' | 'reason'>,
  state: { installed?: boolean; installing?: boolean },
): CivitaiAffordance {
  return civitaiAffordance(version, state)
}

/**
 * Does this version's refusal deserve the PROMINENT banner rather than a line
 * under the button?
 *
 * TRUE for every refusal, and the asymmetry with the card is deliberate. On a
 * card there is room for one dim sentence; in the panel the reason is the answer
 * to the question the user opened the panel to ask ("can I use this?"), so it
 * leads. The only case with nothing to lead with is a version with no reason
 * string at all, which is a row disagreeing with its own contract.
 */
export function civitaiShowsVerdictBanner(affordance: CivitaiAffordance): boolean {
  return affordance.kind === 'blocked' && affordance.reason.trim() !== ''
}

// ─── previews ────────────────────────────────────────────────────────────────

/**
 * Should this detail preview go up blurred?
 *
 * DELEGATES to civitaiRow's committed predicate by adapting the shape — the
 * bitmask rule (`& ~3`, never `>=`) and the "SFW mode never blurs / unknown
 * level blurs in adult mode" asymmetry live in ONE function, and this is not a
 * second copy of them. A `CivitaiDetailPreview` is a thumbnail with a level; so
 * is a row. Same question, same answer.
 */
export function civitaiDetailPreviewBlurred(
  preview: Pick<CivitaiDetailPreview, 'dataUri' | 'level'> | null | undefined,
  ctx: { adult?: boolean },
): boolean {
  if (!preview?.dataUri) return false
  // ─── ONE NORMALISATION, AND IT IS LOAD-BEARING ──────────────────────────────
  // A level of 0 (or a negative, or a fraction) is UNKNOWN. That is the GATE's
  // own convention — sfwOnly() and adultAllowed() both refuse `level <= 0` as
  // "no level assigned, which is unknown-not-safe" — but civitaiPreviewBlurred's
  // "unknown blurs" arm keys on NON-NUMERIC only, and it is right to: on a row,
  // main sets `thumbnail` and `thumbnailNsfwLevel` together, so 0-with-a-picture
  // cannot happen and 0 there means "there is no picture".
  //
  // It CAN happen here. civitaiGalleryImages falls back to the row's thumbnail,
  // and a row from a main build that predates `thumbnailNsfwLevel` carries a
  // real data: URI with no level at all — which this file coerces to 0 to keep
  // the payload JSON-safe. Handing that 0 straight through would render an
  // unrated image UNBLURRED in the one mode where X and XXX are on the wire.
  //
  // So unknown is normalised to a non-number and the SINGLE bitmask rule below
  // decides. Nothing about the ceiling is restated here.
  const level = preview.level
  const known = typeof level === 'number' && Number.isInteger(level) && level > 0
  return civitaiPreviewBlurred(
    { thumbnail: preview.dataUri, thumbnailNsfwLevel: known ? level : Number.NaN },
    ctx,
  )
}

/**
 * The images the gallery may render, with the row's own thumbnail as a fallback.
 *
 * A detail whose preview fetches all failed still has the picture the card was
 * already showing — it is the same CDN image, already in main's memory cache —
 * and rendering it beats an empty gallery. The row's thumbnail is used ONLY as a
 * fallback, never merged in: it is one of these images, and showing it twice is
 * how a two-image gallery becomes a duplicate.
 */
export function civitaiGalleryImages(
  version: Pick<CivitaiDetailVersion, 'previews'> | null | undefined,
  rowFallback: { thumbnail: string | null; thumbnailNsfwLevel: number } | null | undefined,
): CivitaiDetailPreview[] {
  const previews = (version?.previews ?? []).filter(p => typeof p?.dataUri === 'string' && p.dataUri !== '')
  if (previews.length > 0) return previews
  if (rowFallback?.thumbnail) {
    const level = typeof rowFallback.thumbnailNsfwLevel === 'number' ? rowFallback.thumbnailNsfwLevel : 0
    return [{ dataUri: rowFallback.thumbnail, level }]
  }
  return []
}

// ─── small formatters ────────────────────────────────────────────────────────

/**
 * Compact popularity count — `1.2M` / `52.7k` / `931`.
 *
 * Lives here rather than staying private to ModelCard because the panel prints
 * the SAME two numbers, and two implementations of "how do we abbreviate a
 * download count" is how a card and its own detail view end up disagreeing
 * about the same model.
 */
export function civitaiCompactCount(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${Math.floor(n)}`
}

/**
 * `publishedAt` as a Date, or null.
 *
 * PARSING IS SEPARATE FROM FORMATTING so the parse is testable in a node env
 * with no locale surprises: the component formats with toLocaleDateString, this
 * decides whether there is anything to format. An unparseable or absent string
 * yields null and the panel prints no date at all rather than "Invalid Date".
 */
export function civitaiPublishedDate(iso: unknown): Date | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * The one-line file summary for a version: size · format · precision.
 *
 * Empty segments are DROPPED rather than rendered as a gap — the same rule
 * ModelCard's metaLine follows, and for the same reason: `· SafeTensor ·` was a
 * real card. Size comes first because it is the fact that decides whether
 * someone clicks Install.
 */
export function civitaiVersionFileLine(
  version: Pick<CivitaiDetailVersion, 'sizeMb' | 'format'> & { fp?: string | null },
): string {
  const size = civitaiFormatMb(version?.sizeMb)
  return [size, (version?.format ?? '').trim(), (version?.fp ?? '')?.trim() ?? '']
    .filter(part => part !== '' && part !== 'Unknown')
    .join(' · ')
}

/** MB → a human size. Zero/absent yields '' so the caller drops the segment. */
export function civitaiFormatMb(sizeMb: unknown): string {
  if (typeof sizeMb !== 'number' || !Number.isFinite(sizeMb) || sizeMb <= 0) return ''
  if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`
  return `${Math.round(sizeMb)} MB`
}
