// apps/desktop/src/pages/catalog/civitaiRow.ts
//
// Pure adapters for the Catalog `civitai` source tab. Everything the tab
// DECIDES lives here — what a row looks like as a catalog card, which license
// badges it earns, and (the one that matters) WHICH AFFORDANCE the card is
// allowed to draw. No React, no electron, no i18n: data in, verdict out, so
// each decision is assertable in the node-env unit suite instead of only being
// reachable through a render we cannot run here.
//
// The row shape itself is main's: electron/services/civitai-search.ts owns
// CivitaiSearchRow and mirrors it into src/types/electron.d.ts. This file never
// re-derives a fact main already decided — `installable` / `reason` are read,
// never recomputed, because main re-fetches and re-gates on install anyway and
// a second opinion in the renderer could only ever disagree with the one that
// actually governs.

import type { CatalogEntry } from '@tachi/core'
import type { CivitaiSearchRow } from '../../types/electron'

// ─── search tuning ───────────────────────────────────────────────────────────

/**
 * Keystroke → request delay for the Civitai tab.
 *
 * The HF tab is Enter/button-driven and needs none of this. Civitai searches as
 * you type, and every returned row costs main ONE thumbnail fetch against
 * image.civitai.com, so an un-debounced field would fire a page of ~24 image
 * requests per keystroke. 350ms is the usual "typing paused" threshold; the
 * stale-response coordinator (search.ts) is still what makes out-of-order
 * answers safe — the debounce only reduces how many are issued.
 */
export const CIVITAI_SEARCH_DEBOUNCE_MS = 350

/**
 * Rows per page. Deliberately well under the API's 100 max: main resolves one
 * PG preview per SURVIVING row in parallel, so the page size is also the
 * thumbnail fan-out. "Load more" appends the next cursor page — there is no
 * page number anywhere in this feature, by API contract (`page` 429s past 1000
 * rows and 400s outright when combined with `query`).
 */
export const CIVITAI_PAGE_LIMIT = 24

// ─── the honest "N hidden" line ──────────────────────────────────────────────

/**
 * Coerce main's `filteredCount` into a number the UI may print.
 *
 * Defensive because the field is NEW: an older main build (or a bridge that
 * resolved before this field existed) sends `undefined`, and the tab must then
 * say NOTHING rather than "NaN results hidden". Negatives and fractions are
 * likewise not counts.
 */
export function normalizeFilteredCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0
  return Math.floor(raw)
}

/**
 * Should the tab print the "N results hidden by the SFW filter" line?
 *
 * Driver-found symptom: `realistic` returned a 24-row page that rendered TWO
 * cards, with no explanation anywhere — which reads as a broken search. The
 * count has always existed in main; the fix is to say it.
 *
 * NOT shown while the first page is still loading (the grid is skeletons, and
 * a count next to skeletons describes nothing), and not shown when nothing was
 * dropped — a permanent "0 hidden" is noise that trains people to ignore the
 * line on the day it matters.
 */
export function shouldShowFilteredNotice(
  filteredCount: number,
  state: { loading?: boolean },
): boolean {
  return !state.loading && normalizeFilteredCount(filteredCount) > 0
}

// ─── type filter chips ───────────────────────────────────────────────────────

/**
 * Where a chip sits in the filter row. The grouping is OUR ENGINE'S, not
 * Civitai's taxonomy: what matters to someone browsing here is whether a thing
 * is a model you run, a thing you hang on a model, or neither.
 */
export type CivitaiTypeGroup = 'models' | 'adapters' | 'other'

/**
 * What filtering to this type will actually get you, said BEFORE the search
 * runs. This is the chip row's half of the honesty law: the card already
 * refuses per row with main's own reason, but a user who picks `DoRA` and gets
 * 24 blocked cards has been let walk into a wall. One line under the chips
 * says which wall it is.
 *
 *   'runs'       — installs and generates on its own (Checkpoint).
 *   'needs-base' — the ADAPTER rule: LoRA / LoCon / embedding / VAE install
 *                  only when a checkpoint of the same family is already on
 *                  disk. Mirrors main's CIVITAI_ADAPTER_TYPES + the
 *                  `needs-base` reason code.
 *   'later'      — the engine can do it, the app has no surface yet
 *                  (ControlNet / Upscaler / AnimateDiff — main's phase-4
 *                  reasons).
 *   'no'         — never installable here. DoRA is the sharp case: the binary
 *                  has no dora_scale, so it would render silently wrong.
 *
 * These four map 1:1 onto main's verdict table (civitai-search.ts
 * CIVITAI_REASONS / CIVITAI_ADAPTER_TYPES / TYPE_REASON). A drift test asserts
 * every `types` string here is one main will forward.
 */
export type CivitaiTypeOutlook = 'runs' | 'needs-base' | 'later' | 'no'

/**
 * The type filter, as `types=` values for the API.
 *
 * `undefined` types = send no filter at all (All). Every named filter uses
 * Civitai's OWN enum spelling — `LORA`, `TextualInversion`, `MotionModule` are
 * the raw strings the API returns and the strings main's verdict table is
 * keyed on.
 *
 * ALL 22 LIVE TYPES ARE OFFERED, including the ones we never install. Hiding
 * them would be the more flattering lie: the user would conclude we cannot see
 * them at all, then go install them by hand somewhere else. What we owe them
 * instead is the outlook line and, per card, main's own reason.
 *
 * `LyCORIS` is deliberately NOT a chip — `types=LyCORIS` returns 400 upstream
 * (it was folded into LoCon). It survives only as a legacy `row.type` string,
 * which civitaiTypeFilterIdForType() maps onto the LoCon label.
 */
export interface CivitaiTypeFilter {
  /** i18n key suffix under `catalog:civitai.types.*` — also the chip's React key. */
  id: CivitaiTypeFilterId
  /** Verbatim Civitai `types=` values, or undefined for no filter. */
  types?: readonly string[]
  /** Which chip row it renders in. Absent on `all`, which sits above them. */
  group?: CivitaiTypeGroup
  /** What picking it will get you. Absent on `all` — it is every outlook. */
  outlook?: CivitaiTypeOutlook
}

export type CivitaiTypeFilterId =
  // ungrouped
  | 'all'
  // models — a whole model, or a component of one
  | 'checkpoint' | 'unet' | 'text-encoder' | 'clip' | 'clip-vision'
  | 'vision-language' | 'llm'
  // adapters — things that run ON TOP of a model
  | 'lora' | 'locon' | 'dora' | 'embedding' | 'vae' | 'controlnet'
  | 'upscaler' | 'motion' | 'hypernetwork' | 'aesthetic'
  // other — not weights at all
  | 'poses' | 'wildcards' | 'workflows' | 'detection' | 'other'

export const CIVITAI_TYPE_FILTERS: readonly CivitaiTypeFilter[] = [
  { id: 'all' },

  // ── models ────────────────────────────────────────────────────────────────
  { id: 'checkpoint',      types: ['Checkpoint'],      group: 'models',   outlook: 'runs' },
  { id: 'unet',            types: ['UNet'],            group: 'models',   outlook: 'no' },
  { id: 'text-encoder',    types: ['TextEncoder'],     group: 'models',   outlook: 'no' },
  { id: 'clip',            types: ['CLIP'],            group: 'models',   outlook: 'no' },
  { id: 'clip-vision',     types: ['CLIPVision'],      group: 'models',   outlook: 'no' },
  { id: 'vision-language', types: ['VisionLanguage'],  group: 'models',   outlook: 'no' },
  { id: 'llm',             types: ['LLM'],             group: 'models',   outlook: 'no' },

  // ── adapters ──────────────────────────────────────────────────────────────
  { id: 'lora',            types: ['LORA'],            group: 'adapters', outlook: 'needs-base' },
  { id: 'locon',           types: ['LoCon'],           group: 'adapters', outlook: 'needs-base' },
  { id: 'embedding',       types: ['TextualInversion'], group: 'adapters', outlook: 'needs-base' },
  { id: 'vae',             types: ['VAE'],             group: 'adapters', outlook: 'needs-base' },
  { id: 'controlnet',      types: ['Controlnet'],      group: 'adapters', outlook: 'later' },
  { id: 'upscaler',        types: ['Upscaler'],        group: 'adapters', outlook: 'later' },
  { id: 'motion',          types: ['MotionModule'],    group: 'adapters', outlook: 'later' },
  { id: 'dora',            types: ['DoRA'],            group: 'adapters', outlook: 'no' },
  { id: 'hypernetwork',    types: ['Hypernetwork'],    group: 'adapters', outlook: 'no' },
  { id: 'aesthetic',       types: ['AestheticGradient'], group: 'adapters', outlook: 'no' },

  // ── other ─────────────────────────────────────────────────────────────────
  { id: 'poses',           types: ['Poses'],           group: 'other',    outlook: 'no' },
  { id: 'wildcards',       types: ['Wildcards'],       group: 'other',    outlook: 'no' },
  { id: 'workflows',       types: ['Workflows'],       group: 'other',    outlook: 'no' },
  { id: 'detection',       types: ['Detection'],       group: 'other',    outlook: 'no' },
  { id: 'other',           types: ['Other'],           group: 'other',    outlook: 'no' },
]

/** Chip-row order. `all` is rendered above these, on its own. */
export const CIVITAI_TYPE_GROUPS: readonly CivitaiTypeGroup[] = ['models', 'adapters', 'other']

/** The chips in one group, in declaration order. */
export function civitaiTypeFiltersIn(group: CivitaiTypeGroup): CivitaiTypeFilter[] {
  return CIVITAI_TYPE_FILTERS.filter(f => f.group === group)
}

/** The `types` array to send for a filter id (undefined = unfiltered). */
export function civitaiTypesFor(id: CivitaiTypeFilterId): string[] | undefined {
  const f = CIVITAI_TYPE_FILTERS.find(x => x.id === id)
  return f?.types ? [...f.types] : undefined
}

/**
 * What the active chip will get you, or null for `all` (which is every
 * outlook at once and therefore describes nothing).
 *
 * An id we do not know also returns null — a note we cannot stand behind is
 * worse than no note.
 */
export function civitaiTypeOutlook(id: CivitaiTypeFilterId): CivitaiTypeOutlook | null {
  return CIVITAI_TYPE_FILTERS.find(x => x.id === id)?.outlook ?? null
}

/** Narrow an arbitrary string (a persisted chip, a stale prop) to a known id. */
export function isCivitaiTypeFilterId(v: unknown): v is CivitaiTypeFilterId {
  return typeof v === 'string' && CIVITAI_TYPE_FILTERS.some(f => f.id === v)
}

/**
 * The chip id whose LABEL describes a raw `row.type`, or null when the API sent
 * a type we have no word for.
 *
 * Null is rendered as the raw string, verbatim: the card says what the API
 * said. Inventing a friendly name for an unknown type is how a UI ends up
 * describing something it does not understand.
 *
 * `LyCORIS` resolves to the LoCon label — the two are one thing upstream now,
 * and an old row still carries the retired string.
 */
export function civitaiTypeFilterIdForType(type: unknown): CivitaiTypeFilterId | null {
  if (typeof type !== 'string' || type.trim() === '') return null
  const raw = type.trim()
  if (raw === 'LyCORIS') return 'locon'
  return CIVITAI_TYPE_FILTERS.find(f => (f.types ?? []).includes(raw))?.id ?? null
}

// ─── sort / period / base-model filters ──────────────────────────────────────

/**
 * Sort options. The `value` strings are main's CIVITAI_SORTS verbatim —
 * anything else is DROPPED by buildCivitaiSearchUrl rather than forwarded, so a
 * typo here would silently un-sort the grid instead of erroring.
 *
 * `id` is the i18n key suffix, because 'Most Downloaded' is not a translation
 * key and 'mostDownloaded' is.
 */
export interface CivitaiSortOption { id: 'mostDownloaded' | 'newest' | 'highestRated'; value: string }
export type CivitaiSortId = CivitaiSortOption['id']

export const CIVITAI_SORT_OPTIONS: readonly CivitaiSortOption[] = [
  { id: 'mostDownloaded', value: 'Most Downloaded' },
  { id: 'newest',         value: 'Newest' },
  { id: 'highestRated',   value: 'Highest Rated' },
]

/** Main's own default, so the initial chip matches the initial grid. */
export const CIVITAI_DEFAULT_SORT: CivitaiSortId = 'mostDownloaded'

export function civitaiSortValue(id: CivitaiSortId): string {
  return CIVITAI_SORT_OPTIONS.find(s => s.id === id)?.value ?? 'Most Downloaded'
}

/**
 * Period options — CIVITAI_PERIODS verbatim (`Hour` 400s upstream, so it is not
 * an open string and is not offered).
 *
 * `allTime` sends 'AllTime' explicitly rather than omitting the param. Omitting
 * it happens to be the same thing today, but "the filter I picked is the filter
 * that was sent" is a property worth having when the default drifts.
 */
export interface CivitaiPeriodOption { id: 'allTime' | 'year' | 'month' | 'week' | 'day'; value: string }
export type CivitaiPeriodId = CivitaiPeriodOption['id']

export const CIVITAI_PERIOD_OPTIONS: readonly CivitaiPeriodOption[] = [
  { id: 'allTime', value: 'AllTime' },
  { id: 'year',    value: 'Year' },
  { id: 'month',   value: 'Month' },
  { id: 'week',    value: 'Week' },
  { id: 'day',     value: 'Day' },
]

export const CIVITAI_DEFAULT_PERIOD: CivitaiPeriodId = 'allTime'

export function civitaiPeriodValue(id: CivitaiPeriodId): string {
  return CIVITAI_PERIOD_OPTIONS.find(p => p.id === id)?.value ?? 'AllTime'
}

/**
 * The engine families the chip row can express — one per family this app has
 * an installable LOCAL ROW for, which is the only honest basis for a chip.
 *
 * `flux` is absent even though the app runs Flux: Civitai's Flux checkpoints
 * are the UNET alone, main's familyForBaseModel returns null for them, and a
 * chip whose entire grid is refusals is a filter whose only outcome is
 * disappointment. `ltx2` is absent because Civitai's `LTXV`/`LTXV 2.3` values
 * describe a different pin than our row.
 *
 * Rendered as one labelled sub-row per family, which is how a 13-chip set stays
 * a filter instead of becoming a menu.
 */
export type CivitaiChipFamily = 'sd15' | 'sdxl' | 'zimage' | 'wan'

export const CIVITAI_CHIP_FAMILIES: readonly CivitaiChipFamily[] = ['sd15', 'sdxl', 'zimage', 'wan']

export interface CivitaiBaseModelChip {
  /** Civitai's OWN enum spelling. THE LABEL IS THE QUERY VALUE — this string is
   *  what goes on the wire as `baseModels=`, so it is never translated and
   *  never prettified. */
  value: string
  family: CivitaiChipFamily
  /**
   * Versions the live API returned for `baseModels=<value>` on 2026-07-31.
   *
   * Recorded per chip rather than in a comment because it is the ADMISSION
   * TEST, and a test asserts it is > 0 for every chip. An unknown `baseModels`
   * value does not 400 — it returns an EMPTY PAGE — so a misspelled chip is
   * indistinguishable from an unpopular one at runtime. `Z-Image Turbo` (the
   * spelling anyone would guess) measured 0 and is the reason this field exists.
   */
  measuredVersions: number
}

/**
 * Base-model chips — MULTI-SELECT, because `baseModels` is a repeatable query
 * param and that makes run-truth filtering free on the server side.
 *
 * Every value is Civitai's own enum spelling, shown UNTRANSLATED on purpose:
 * these are the same words the user sees on civitai.com, and a localised
 * "SDXL 1.0" would be a different filter than the one being sent.
 *
 * GROWN 2026-07-31 from five to thirteen. The original five covered the two
 * families the app could install a checkpoint for; the app now also runs
 * Z-Image and four Wan rows, and a user who has those installed was being shown
 * a filter row that pretended they did not exist. Every string below was
 * echo-tested (see `measuredVersions`); the retired bare `Wan Video` value is
 * deliberately NOT a chip even though it still matches 195 live versions.
 */
export const CIVITAI_BASE_MODEL_CHIPS: readonly CivitaiBaseModelChip[] = [
  { value: 'SD 1.5',                 family: 'sd15',   measuredVersions: 584 },

  { value: 'SDXL 1.0',               family: 'sdxl',   measuredVersions: 278 },
  { value: 'Pony',                   family: 'sdxl',   measuredVersions: 203 },
  { value: 'Illustrious',            family: 'sdxl',   measuredVersions: 218 },
  { value: 'NoobAI',                 family: 'sdxl',   measuredVersions: 23 },

  { value: 'ZImageTurbo',            family: 'zimage', measuredVersions: 402 },
  { value: 'ZImageBase',             family: 'zimage', measuredVersions: 194 },

  { value: 'Wan Video 1.3B t2v',     family: 'wan',    measuredVersions: 65 },
  { value: 'Wan Video 14B t2v',      family: 'wan',    measuredVersions: 174 },
  { value: 'Wan Video 14B i2v 480p', family: 'wan',    measuredVersions: 127 },
  { value: 'Wan Video 14B i2v 720p', family: 'wan',    measuredVersions: 132 },
  { value: 'Wan Video 2.2 TI2V-5B',  family: 'wan',    measuredVersions: 69 },
  { value: 'Wan Video 2.2 I2V-A14B', family: 'wan',    measuredVersions: 252 },
  { value: 'Wan Video 2.2 T2V-A14B', family: 'wan',    measuredVersions: 240 },
]

/** The flat wire vocabulary — every value a chip may put on `baseModels=`. */
export const CIVITAI_BASE_MODEL_FILTERS: readonly string[] = CIVITAI_BASE_MODEL_CHIPS.map(c => c.value)

/** The chips in one family sub-row, in declaration order. */
export function civitaiChipsForFamily(family: CivitaiChipFamily): CivitaiBaseModelChip[] {
  return CIVITAI_BASE_MODEL_CHIPS.filter(c => c.family === family)
}

/** Toggle one base-model chip, preserving the declared chip order. */
export function toggleCivitaiBaseModel(current: readonly string[], value: string): string[] {
  const on = new Set(current)
  if (on.has(value)) on.delete(value)
  else on.add(value)
  return CIVITAI_BASE_MODEL_FILTERS.filter(b => on.has(b))
}

// ─── "for my models" ─────────────────────────────────────────────────────────
//
// THE DISCOVERY QUESTION, which is not the verdict question.
//
// The per-card verdict asks "may this be installed?" and answers from what is
// on disk as an IMAGE BASE CHECKPOINT. That is the right question for a button
// and the wrong one for a browse: it cannot see a Wan install at all (video
// rows are excluded by construction), so a user whose whole reason for opening
// the tab is their Wan setup gets a grid that has never heard of it.
//
// This half asks "what did the user actually install?", answers from the SAME
// sd-cpp status snapshot the catalog already fetches, and uses it only to
// PRE-SELECT filters. Nothing here can make a card installable — the verdict
// still governs the button, and a Wan card still says honestly that installing
// it from Civitai is not wired.

const CHIP_FAMILY_SET: ReadonlySet<string> = new Set(CIVITAI_CHIP_FAMILIES)

/**
 * The chip families the user has at least one installed row for.
 *
 * Reads `sd-cpp:status`, which has carried `family` since the media lane needed
 * it for the preset picker — so this costs no new IPC channel and no new
 * main-process knowledge.
 *
 * BOTH KINDS COUNT, unlike the verdict's installedFamilies(): a `video` row is
 * a model you own, and "show me things for the models I have" is exactly the
 * question a Wan owner is asking. Families with no chip (`ltx2`, and `flux`
 * until Civitai ships something we can use) are dropped rather than turned into
 * an empty filter — sending `baseModels=` with nothing in it would silently
 * widen the search to everything, which is the opposite of what the toggle
 * promises.
 */
export function civitaiInstalledChipFamilies(
  status: { models?: ReadonlyArray<{ family?: unknown }> } | null | undefined,
): CivitaiChipFamily[] {
  const seen = new Set<string>()
  for (const m of status?.models ?? []) {
    if (typeof m?.family === 'string' && CHIP_FAMILY_SET.has(m.family)) seen.add(m.family)
  }
  // Declaration order, so the constraint we send is stable across snapshots.
  return CIVITAI_CHIP_FAMILIES.filter(f => seen.has(f))
}

/** Every measured `baseModels=` value for a set of families, in chip order. */
export function civitaiBaseModelsForFamilies(families: readonly CivitaiChipFamily[]): string[] {
  const want = new Set<string>(families)
  return CIVITAI_BASE_MODEL_CHIPS.filter(c => want.has(c.family)).map(c => c.value)
}

/**
 * May the toggle be offered at all?
 *
 * FALSE with nothing installed, and the control is disabled rather than hidden:
 * an empty constraint would send no `baseModels` and quietly behave like OFF,
 * which is a switch that lies about what it did. A disabled chip with nothing
 * installed also says something true — install a model and this starts working.
 */
export function civitaiForMyModelsUsable(families: readonly CivitaiChipFamily[]): boolean {
  return civitaiBaseModelsForFamilies(families).length > 0
}

/**
 * The type the toggle biases to.
 *
 * A CHECKPOINT is a REPLACEMENT for the model you have; an ADAPTER is an
 * ADDITION to it. "Useful for my models" means the second one, and LoRA is both
 * the overwhelming majority of adapters upstream (235 measured for Z-Image
 * alone) and the one type whose verdict already keys on what is installed.
 */
export const CIVITAI_FOR_MY_MODELS_TYPE: CivitaiTypeFilterId = 'lora'

/** True when any filter differs from the default — drives the Clear control. */
export function civitaiFiltersActive(f: {
  type: CivitaiTypeFilterId
  sort: CivitaiSortId
  period: CivitaiPeriodId
  baseModels: readonly string[]
  forMyModels?: boolean
}): boolean {
  return f.type !== 'all'
    || f.sort !== CIVITAI_DEFAULT_SORT
    || f.period !== CIVITAI_DEFAULT_PERIOD
    || f.baseModels.length > 0
    || f.forMyModels === true
}

// ─── row → catalog card ──────────────────────────────────────────────────────

const MB = 1024 * 1024

/**
 * Map one Civitai row onto the shared CatalogEntry so it renders through the
 * SAME ModelCard as every other row — one card component, one visual family.
 *
 * Three fields carry load-bearing decisions:
 *
 *  • `quants[0].runtime = 'sdcpp'` — not decoration. rowMeta's isMediaRow() is
 *    runtime-keyed, and it is what turns on the honest "Download size: 6.6 GB"
 *    chip. A Civitai checkpoint is the biggest thing this app downloads; the
 *    size belongs on the card, and this is the wire that puts it there.
 *  • `kind: 'text'` is the same deliberate placeholder catalog.store's
 *    sdCatalogEntry uses: the real modality rides in `capabilities`, and
 *    `kind: 'speech'` is the only value rowMeta actually branches on.
 *  • `downloads` / `likes` are copied straight through. They used to be gated
 *    behind `source === 'hf'` in ModelCard; that condition is now data-driven,
 *    because popularity is a property of the ROW, not of which API served it.
 *
 * `family` is the DECLARED family ('sd15' | 'sdxl' | 'flux'), never guessed —
 * an empty string when main mapped none, so the meta line degrades to just the
 * runtime rather than printing a family we do not stand behind.
 */
export function civitaiCatalogEntry(row: CivitaiSearchRow): CatalogEntry {
  const sizeMb = Number.isFinite(row.sizeMb) && row.sizeMb > 0 ? row.sizeMb : 0
  const entry: CatalogEntry = {
    id: row.id,
    name: row.name,
    family: row.family ?? '',
    params: '',
    kind: 'text',
    source: 'civitai',
    quants: [{
      label: row.format || 'SafeTensor',
      sizeBytes: Math.round(sizeMb * MB),
      runtime: 'sdcpp',
      ref: row.id,
    }],
    capabilities: ['image-gen'],
  }
  if (Number.isFinite(row.downloads)) entry.downloads = row.downloads
  if (Number.isFinite(row.likes)) entry.likes = row.likes
  return entry
}

/**
 * Model name and version name, split back apart for display.
 *
 * Main joins them as `${model.name} - ${version.name}` (civitai-search.ts's
 * mapper) and that single string is all the renderer gets. A Civitai card
 * everywhere else in the world shows a big model name and a small version
 * badge, and one run-on line is measurably harder to scan in a grid — so the
 * join is undone here, on the LAST separator, which is the one the mapper
 * added.
 *
 * IT IS A SPLIT OF A JOIN, SO IT CAN BE WRONG, AND THE FAILURE IS DESIGNED TO
 * BE HARMLESS. A version whose own name contains " - " ("v1 - beta") moves one
 * word into the title; nothing is lost or invented either way, because the two
 * halves are always rendered together on the card. Two guards keep it from
 * mangling ordinary names:
 *   • both halves must be non-empty (a name ENDING in " - " is not a version),
 *   • the tail must be short (≤ MAX_VERSION_LEN) — version names are short,
 *     model names with a dash in them ("Realistic Vision - Photorealism Pack")
 *     are not, and a long tail is far more likely to be part of the title.
 * When either guard fails the whole string is the title and the version is
 * empty, which renders exactly as the card did before this existed.
 */
const MAX_VERSION_LEN = 40

export interface CivitaiNameParts {
  /** The model name (or the whole string when no version could be separated). */
  title: string
  /** The version name, or '' when it could not be separated. */
  version: string
}

export function civitaiNameParts(row: Pick<CivitaiSearchRow, 'name'>): CivitaiNameParts {
  const full = typeof row?.name === 'string' ? row.name.trim() : ''
  const at = full.lastIndexOf(' - ')
  if (at <= 0) return { title: full, version: '' }
  const title = full.slice(0, at).trim()
  const version = full.slice(at + 3).trim()
  if (title === '' || version === '' || version.length > MAX_VERSION_LEN) {
    return { title: full, version: '' }
  }
  return { title, version }
}

// ─── what a row IS (type badge + what a VRAM verdict may claim) ──────────────

/**
 * Whether a VRAM fit verdict says anything true about this row.
 *
 * ONLY a checkpoint. The estimator is a text-transformer heuristic over the
 * download size (`sizeBytes × 1.2` for a KV cache that does not exist here), so
 * pointing it at a 150 MB LoRA returns a confident "Fits in GPU (fast)" about a
 * file that is not a model and never occupies VRAM on its own. That is the same
 * fabricated-verdict class rowMeta already suppresses for piper voices — and it
 * only became reachable when the gate lane flipped adapters to installable, so
 * it is fixed in the same wave that created it.
 *
 * The honest replacement is already on the card: the download-size chip.
 */
export function civitaiShowsFitVerdict(row: Pick<CivitaiSearchRow, 'type'>): boolean {
  return row?.type === 'Checkpoint'
}

// ─── the 18+ preview blur ────────────────────────────────────────────────────

/**
 * Everything above PG13. PG=1, PG13=2 — so `& ~3` is "any bit that is not one
 * of those two". A bitmask test, never `>=`: the levels are a SET
 * (R=4 X=8 XXX=16 Blocked=32), and an ordinal comparison gets 32 wrong.
 *
 * This is main's own documented blur contract (CivitaiSearchRow.
 * thumbnailNsfwLevel), restated here as the one place the renderer computes it.
 */
export const NSFW_ABOVE_PG13 = ~3

/**
 * Should this card's preview go up blurred?
 *
 * TWO INPUTS, AND THE MODE IS THE OUTER ONE:
 *
 *  • SFW mode NEVER blurs. Main requests `nsfw=false`, which clamps the
 *    response's preview images to PG (measured 7 966/7 966), and the preview
 *    picker takes only level-1 images on top of that. A blur here would be
 *    theatre — and worse, an older main build that predates
 *    `thumbnailNsfwLevel` sends `undefined`, so a level-driven blur would fog
 *    every card in the safest mode there is.
 *
 *  • ADULT mode blurs unless the level is a NUMBER that passes. Absent, NaN or
 *    non-numeric is UNKNOWN, and unknown is not evidence of PG — in the mode
 *    where X and XXX are on the wire, unknown blurs. That is the only
 *    fail-direction that cannot surprise someone.
 *
 * `adult` is the mode the page was ACTUALLY SERVED IN (`result.adult`, resolved
 * in main), never the local setting: a user whose key was removed mid-session
 * is browsing .com and their cards must behave like it.
 *
 * A row with no thumbnail has nothing to blur.
 */
export function civitaiPreviewBlurred(
  row: Pick<CivitaiSearchRow, 'thumbnail' | 'thumbnailNsfwLevel'>,
  ctx: { adult?: boolean },
): boolean {
  if (!row?.thumbnail) return false
  if (ctx?.adult !== true) return false
  const level = row.thumbnailNsfwLevel
  if (typeof level !== 'number' || !Number.isFinite(level)) return true
  return (level & NSFW_ABOVE_PG13) !== 0
}

/**
 * Which sentence the tab prints about the mode it is browsing in.
 *
 *   'sfw'         — civitai.com, safe mode. The shipped default.
 *   'adult'       — the page really came back from civitai.red. This is the
 *                   one that earns the RED badge on the tab.
 *   'adult-inert' — 18+ is ON in Settings and the page was served SFW anyway.
 *                   Almost always a missing / removed API key, and it is the
 *                   single most confusing state this feature can be in: the
 *                   switch is lit, the grid is not. Saying it out loud is the
 *                   whole reason main threads `result.adult` back.
 *
 * `served` (result.adult) OUTRANKS the settings, because it is the only fact
 * that describes the rows on screen. The settings are used exactly once — for
 * the window before any page has been served, where `served` is undefined and
 * main's own `unlocked` predicate is the best answer available.
 *
 * Note the deliberate asymmetry: `served === false` with the setting on is
 * 'adult-inert', not 'sfw'. Reporting plain safe mode there would be true about
 * the rows and silent about the contradiction.
 */
export type CivitaiModeNotice = 'sfw' | 'adult' | 'adult-inert'

export function civitaiModeNotice(input: {
  /** `result.adult` — the mode the page on screen was actually served in. */
  served?: boolean
  /** The raw `civitaiAdultMode` setting. */
  adultMode?: boolean
  /** Main's resolved predicate (settings AND a live keychain read). */
  unlocked?: boolean
}): CivitaiModeNotice {
  if (input?.served === true) return 'adult'
  if (input?.served === false) return input.adultMode === true ? 'adult-inert' : 'sfw'
  if (input?.unlocked === true) return 'adult'
  return input?.adultMode === true ? 'adult-inert' : 'sfw'
}

/**
 * The small chips under the meta line: base model, container format, precision.
 *
 * The base model comes FIRST and is always present when the API gave one — it
 * is the single fact that decides whether the row runs at all, and for a row we
 * cannot run it is the only explanation the reason line refers back to
 * ("SDXL 1.0" vs "Flux.1 D"). Empty strings are dropped rather than rendered as
 * an empty box.
 */
export function civitaiRowChips(row: CivitaiSearchRow): string[] {
  return [row.baseModel, row.format, row.fp]
    .map(v => (typeof v === 'string' ? v.trim() : ''))
    .filter(v => v !== '')
}

// ─── license ─────────────────────────────────────────────────────────────────

/**
 * License badges. The app INFORMS, it cannot enforce — that is the reasonable
 * bar, and it is why these are badges and not gates.
 *
 * Read the Civitai fields exactly as they mean them:
 *  • `commercial` is a SET parsed from a postgres array literal. EMPTY means
 *    the creator allowed no commercial use at all — `"{}"`. Any member (Image /
 *    Rent / RentCivit / Sell) is some permission, so no badge.
 *  • `noCredit === false` means credit is REQUIRED (the field name is the
 *    permission, not the obligation — inverting it here is the whole point of
 *    naming this function rather than inlining `!license.noCredit`).
 *  • `derivatives === false` means no derivatives / no merges.
 *
 * TWO DIFFERENT DEFAULTS, on purpose:
 *  • NO license object at all ⇒ NO badges. Absence of data is not evidence of
 *    restriction, and a fabricated "no commercial use" on a permissive model is
 *    the same class of lie as a fabricated capability.
 *  • A license object with a MALFORMED field ⇒ the restrictive reading. Main
 *    always fills all three (civitai-search's mapper), so this only fires on a
 *    row that already disagrees with its own contract — and there, advising
 *    caution is the error that costs the user nothing, while the opposite tells
 *    them they may sell output they may not.
 */
export type CivitaiLicenseBadge = 'noCommercial' | 'attribution' | 'noDerivatives'

export function civitaiLicenseBadges(
  license: CivitaiSearchRow['license'] | null | undefined,
): CivitaiLicenseBadge[] {
  if (!license || typeof license !== 'object') return []
  const out: CivitaiLicenseBadge[] = []
  if (!Array.isArray(license.commercial) || license.commercial.length === 0) out.push('noCommercial')
  if (license.noCredit !== true) out.push('attribution')
  if (license.derivatives !== true) out.push('noDerivatives')
  return out
}

// ─── the affordance (THE HONESTY LAW) ────────────────────────────────────────

/**
 * What the card is ALLOWED to draw for this row.
 *
 *   'installed'  — the weights are on disk (sd.cpp status carries user models
 *                  through lane C's merged registry) → RUN, which opens Media.
 *   'installing' — this row's transfer is in flight → the shared progress strip
 *                  above the grid owns it; the card shows a disabled label.
 *   'blocked'    — main's run-truth verdict said no. NO BUTTON AT ALL. Not a
 *                  greyed one, not a tooltip'd one: an Install control that
 *                  cannot install is a fabricated affordance, the exact class
 *                  of bug 061112d/2bd48fc were. The reason main wrote is shown
 *                  in its place.
 *   'install'    — the only state that gets a button.
 *
 * ORDER IS LOAD-BEARING. `installed` is checked BEFORE `blocked` on purpose: a
 * model already on disk RUNS, whatever a later search says about installing it
 * again (Civitai can archive a version, or our allowlist can narrow). Taking
 * RUN away from working local weights because a remote listing changed its mind
 * would be dishonest in the other direction.
 */
export type CivitaiAffordance =
  | { kind: 'installed' }
  | { kind: 'installing' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'install' }

export function civitaiAffordance(
  row: Pick<CivitaiSearchRow, 'installable' | 'reason'>,
  state: { installed?: boolean; installing?: boolean },
): CivitaiAffordance {
  if (state.installed) return { kind: 'installed' }
  if (state.installing) return { kind: 'installing' }
  if (row.installable !== true) {
    return { kind: 'blocked', reason: typeof row.reason === 'string' ? row.reason.trim() : '' }
  }
  return { kind: 'install' }
}

// ─── paging ──────────────────────────────────────────────────────────────────

/**
 * Append a cursor page, de-duplicating by row id and KEEPING THE FIRST copy.
 *
 * Cursor pagination over a live, popularity-sorted collection can hand back a
 * row that was already on the previous page (an item's rank moved between the
 * two requests). React would then render duplicate keys and — worse — the same
 * model twice with two different install states. Keeping the first copy means
 * a row the user is already looking at does not silently jump position.
 */
export function mergeCivitaiRows(
  prev: readonly CivitaiSearchRow[],
  next: readonly CivitaiSearchRow[],
): CivitaiSearchRow[] {
  const seen = new Set(prev.map(r => r.id))
  const out = [...prev]
  for (const row of next) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  return out
}
