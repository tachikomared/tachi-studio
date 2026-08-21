// apps/desktop/electron/services/civitai-search.ts
//
// Live search against the public Civitai Site API, mapped to ONE flat row that
// the renderer can render without knowing anything about Civitai's shape.
// Mirrors hf-search.ts (fetch + shaping, no SDK — there is no official SDK for
// the Site API; npm `civitai` is a generation client and the python client is
// retired) with three things hf-search did not have:
//
//   1. enforceProviderEgress() at the TOP of every network entry point.
//      (hf-search was MISSING it — PRIVATE MODE did not stop HF search from
//      hitting the network. Fixed in the same pass; see hf-search.ts.)
//   2. The content gate (civitai-gate.ts), applied to every row.
//   3. Run-truth verdicts: `installable` is false unless our own engine can
//      actually run the artifact, and `reason` says why not. Allowlist, not
//      denylist — the honesty law (same class as 061112d / 2bd48fc).
//
// PAGINATION IS CURSOR-ONLY. `page` is a trap on this endpoint: page*limit>1000
// returns 429, and combining `query` with `page` returns 400. `metadata.
// nextCursor` is an opaque string like "155969|8154|2458426" — pass it back
// verbatim (URLSearchParams encodes the pipes).

import { enforceProviderEgress } from './egress-policy'
import { retrieveKey, hasKey as keychainHasKey } from './keychain'
// The rejected/unverified vocabulary is defined once, next to the four provider
// validators that also speak it — see provider-key-probe.ts.
import { verdictFor, unverified, type KeyProbeFailure } from './provider-key-probe'
import {
  civitaiAdultUnlocked,
  civitaiRowAllowed,
  isAdultPreviewImage,
  isPgPreviewImage,
  NSFW_BIT,
  type CivitaiAdultUnlockInput,
} from './civitai-gate'

// ─── THE HOST IS THE GATE ────────────────────────────────────────────────────
//
// Civitai split its domains on 2026-04-15: civitai.com is the "green" SFW site
// and civitai.red carries SFW+NSFW. Same accounts, same database, same API
// paths. Incumbents broke on this (StabilityMatrix #1610/#1611 closed
// not-planned, gallery-dl); SwarmUI and ComfyUI core normalise to .red.
//
// We do the opposite of a normalise: the HOST IS THE MODE. SFW browsing talks
// to .com and literally cannot receive an adult listing from it; unlocked
// browsing talks to .red. That is one switch, in one place, and it is checkable
// by looking at the URL in a network log rather than by auditing a filter.
//
// LIVE-VERIFIED 2026-07-28, and RE-VERIFIED on the phase-3 pass the same day
// (public API, no account, no key — the containment rule is the one thing in
// this file that must never be taken on trust from a previous session):
//   civitai.com  → image urls image.civitai.com · downloadUrl host civitai.com
//   civitai.red  → image urls image.civitai.com · downloadUrl host civitai.red
//                  (GET civitai.red/api/v1/models?limit=5&nsfw=false → 200,
//                   5 models, EVERY images[].url on image.civitai.com and
//                   EVERY files[].downloadUrl on civitai.red)
//   image.civitai.red → NXDOMAIN (the host does not exist)
// So the thumbnail containment below stays image.civitai.com in BOTH modes.
// Adding image.civitai.red "for symmetry" would allowlist a host that does not
// resolve — a fabricated allowance, and exactly the kind of guess this file
// exists to avoid. Download urls come back VERBATIM from the API, so the .red
// download host needs no code at all; it arrives with the row.
const CIVITAI_HOST_SFW = 'https://civitai.com'
const CIVITAI_HOST_ADULT = 'https://civitai.red'

/** The API root for a resolved mode. `adult` here is ALWAYS the output of
 *  civitaiAdultUnlocked() — never a raw setting and never a renderer claim. */
export function civitaiApiBase(adult: boolean): string {
  return `${adult ? CIVITAI_HOST_ADULT : CIVITAI_HOST_SFW}/api/v1`
}

/**
 * `nsfw` IS AN INCLUDE FLAG, NOT A "SHOW ONLY ADULT" FLAG. Measured on the live
 * .red host 2026-07-28 (limit=20, sort=Most Downloaded, three requests):
 *
 *   nsfw=true   → 20 models, model.nsfw {false:17, true:3},
 *                 levels {1:1, 3:1, 7:2, 15:5, 23:1, 31:7, 60:3}
 *   nsfw=false  → 20 models, model.nsfw {false:20},
 *                 levels {1:1, 3:1, 7:4, 15:5, 23:1, 31:8}
 *   (omitted)   → BYTE-IDENTICAL distribution to nsfw=false
 *
 * Three things fall out of that and all three are load-bearing:
 *   1. omitting the param is NOT neutral — it is nsfw=false. So SFW mode sets
 *      it explicitly anyway (it keeps the response's preview images clamped to
 *      PG, which is what makes thumbnail fetching safe at all) and adult mode
 *      must set nsfw=true or the unlock would change the host and nothing else.
 *   2. nsfw=true still returns mostly SFW models — an adult browse is a WIDER
 *      listing, not a different one, so the tab does not suddenly become a
 *      porn grid the moment the switch is flipped.
 *   3. THE LEAK IS ON BOTH HOSTS: even at nsfw=false, 8 of 20 .red models carry
 *      level 31. The bitmask pass (layer 1 / layer 2) is what filters; the flag
 *      only shapes the thumbnails.
 */
function nsfwParamFor(adult: boolean): 'true' | 'false' {
  return adult ? 'true' : 'false'
}

const SEARCH_TIMEOUT_MS = 15_000
const THUMB_TIMEOUT_MS = 8_000
/** Civitai caps `limit` at 100; anything higher 400s. */
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 50
/** Thumbnails are base64'd into the IPC payload — keep them small. The CDN's
 *  width=450/320 variants measured 55-86 KB, so this leaves real headroom while
 *  still refusing anything multi-megabyte (see the measurement table below). */
const THUMB_MAX_BYTES = 200 * 1024
const THUMB_CACHE_MAX = 240

/** The keychain id. Search works WITHOUT a key; the key only matters for the
 *  minority of models whose download is gated behind an account — and for the
 *  18+ unlock, where it is a POLICY requirement (see civitaiAdultUnlocked). */
export const CIVITAI_KEY_ID = 'civitai'

/** Is the user's own Civitai credential in the keychain RIGHT NOW? Never
 *  retrieves the secret — the unlock only needs to know that one exists. */
export function civitaiKeyStored(): boolean {
  try {
    return keychainHasKey(CIVITAI_KEY_ID)
  } catch {
    return false   // keychain unavailable ⇒ no key ⇒ SFW. Fail closed.
  }
}

/**
 * THE ONE PLACE THE MODE IS DECIDED. Every network entry point in this file
 * calls it; nothing else may compute an adult flag.
 *
 * It takes the two SETTINGS as arguments and ANDs them with a LIVE keychain
 * read. That is why the settings alone can never unlock anything: a
 * hand-edited tachi-settings.json with `civitaiAdultMode: true` and a
 * plausible timestamp still resolves to SFW while no credential is stored, and
 * deleting the key in Settings → Keys returns the whole surface to civitai.com
 * on the very next request — no second confirmation, no restart, no stale
 * cached verdict, because there is no cached verdict.
 *
 * The renderer cannot pass this decision in. `CivitaiSearchQuery` carries the
 * two settings only, the IPC layer reads them from the settings store rather
 * than from the payload, and the answer is recomputed here per request.
 */
export function resolveCivitaiAdult(
  q: { adultMode?: boolean; adultAcceptedAt?: number } = {},
): boolean {
  return civitaiAdultUnlocked({
    adultMode: q.adultMode,
    acceptedAt: q.adultAcceptedAt,
    hasKey: civitaiKeyStored(),
  } satisfies CivitaiAdultUnlockInput)
}

// ─── THE SHARED ROW CONTRACT ─────────────────────────────────────────────────
// Other lanes (catalog tab, install path, user-model registry) build against
// this exact shape. Change it and they break.

export interface CivitaiSearchRow {
  /** `civitai-<versionId>`, [a-z0-9-] ONLY. A `:` here would break
   *  sdManagedIdPrefix's load-bearing trailing-colon Stop sweep (risk R10). */
  id: string
  modelId: number
  versionId: number
  /** `<model.name> - <version.name>` */
  name: string
  /** raw Civitai type, unmapped (Checkpoint | LORA | TextualInversion | …) */
  type: string
  /** null = unmapped or not runnable by our engine in this phase */
  family: CivitaiFamily | null
  baseModel: string
  /** ceil(sizeKB / 1024). NEVER under-declares: the download manager's disk
   *  preflight is keyed on it. */
  sizeMb: number
  /** LOWERCASED (the API returns uppercase hex). */
  sha256: string | null
  /** VERBATIM from files[].downloadUrl — it pre-solves component selection via
   *  ?type=&format=&fp= for multi-file models. Never reconstruct it. */
  downloadUrl: string
  fileName: string
  format: string
  fp: string | null
  nsfwLevelModel: number
  /** The chosen VERSION's level. Threaded because a model-level number cannot
   *  describe the artifact the card actually installs. */
  nsfwLevelVersion: number
  downloads: number
  likes: number
  /** data: URI, or null. Never a remote URL — the prod CSP has no https: in
   *  img-src, and a remote URL in the renderer would leak a request per card.
   *  MEMORY-ONLY end to end: nothing from image.civitai.com is ever written to
   *  disk, in either mode (see the thumbnail section). */
  thumbnail: string | null
  /**
   * The nsfwLevel of the image `thumbnail` was fetched from; 0 when there is no
   * thumbnail. THE BLUR CONTRACT for the catalog card: blur when
   * `(thumbnailNsfwLevel & ~3) !== 0`, i.e. anything above PG13. In SFW mode
   * this is always 0 or 1 by construction, so the card never blurs there.
   */
  thumbnailNsfwLevel: number
  /**
   * THIS VERSION's page on the host the row was served from, or null.
   *
   * BUILT IN MAIN from the RESOLVED mode (civitaiModelPageUrl), exactly like the
   * detail payload's — the renderer must never choose between `.com` and `.red`,
   * and a row is the only thing the detail panel has on its first frame. Without
   * it "Open on Civitai" appeared only after the by-id fetch landed: the one
   * control that could have been live immediately was the one that was not.
   *
   * It is the same string the detail's lead version carries for the same
   * (model, version) pair, so the button does not change when the fetch arrives.
   */
  pageUrl: string | null
  trainedWords: string[]
  license: { commercial: string[]; noCredit: boolean; derivatives: boolean }
  /** run-truth verdict */
  installable: boolean
  /** honest why-not, present iff !installable */
  reason?: string
  /** stable machine key for the same refusal (i18n / tests), iff !installable */
  reasonCode?: CivitaiReasonCode
}

export interface CivitaiSearchResult {
  rows: CivitaiSearchRow[]
  nextCursor: string | null
  /**
   * How many models the server sent that produced NO card, because every one
   * of their versions was refused by the content gate.
   *
   * Driver-found: a `limit=24` page can render 2 cards ("realistic" → 2), and
   * with no explanation that reads as a broken search rather than as a working
   * filter. The service has always known this number; it just threw it away.
   * The gate itself is NOT weakened — the count is the honesty, not a knob.
   */
  filteredCount: number
  /**
   * The mode this page was ACTUALLY served in — the RESOLVED answer, not the
   * requested one. It is the only honest way for the renderer to learn that its
   * `adultMode: true` did nothing because the credential was removed, and it
   * lets the tab label the listing without recomputing a predicate that lives
   * in main. Absent on an error result: nothing was served, so no mode was.
   */
  adult?: boolean
}

// ─── THE FILTER VOCABULARY (live enum, fetched 2026-07-28) ───────────────────
//
// GET https://civitai.com/api/v1/enums is the source of truth and it answered
// with EXACTLY these 22 ModelType values. Two things this pins that a hand-
// written list got wrong before:
//   • `LyCORIS` IS NOT A TYPE. `types=LyCORIS` returns 400 (verified). It was
//     folded into LoCon upstream. It survives only as a legacy `model.type`
//     string in the reason table below, never as a request value.
//   • `TextEncoder` / `UNet` / `CLIPVision` / `VisionLanguage` / `CLIP` / `LLM`
//     are real, current types — a filter UI that omits them is showing the user
//     a menu of a subset without saying so.
// Static because a 22-item list is not worth a network round-trip on every
// keystroke; the /enums endpoint is the fallback-refresh path if it ever drifts
// (ActiveBaseModel already drifted 65 → 66 between the research pass and now).
export const CIVITAI_MODEL_TYPES = [
  'Checkpoint', 'TextualInversion', 'Hypernetwork', 'AestheticGradient', 'LORA',
  'LoCon', 'DoRA', 'Controlnet', 'Upscaler', 'MotionModule', 'VAE', 'TextEncoder',
  'UNet', 'CLIPVision', 'Poses', 'Wildcards', 'Workflows', 'Detection',
  'VisionLanguage', 'CLIP', 'LLM', 'Other',
] as const
export type CivitaiModelType = typeof CIVITAI_MODEL_TYPES[number]

/** Sort values, live-verified 200 on 2026-07-28. (`Oldest` and `Most Liked`
 *  also answer 200 but are not offered — three orderings is a filter, six is a
 *  menu.) */
export const CIVITAI_SORTS = ['Most Downloaded', 'Newest', 'Highest Rated'] as const
export type CivitaiSort = typeof CIVITAI_SORTS[number]

/** Period values, live-verified: AllTime/Year/Month/Week/Day → 200,
 *  `Hour` → 400. It is NOT an open string. */
export const CIVITAI_PERIODS = ['AllTime', 'Year', 'Month', 'Week', 'Day'] as const
export type CivitaiPeriod = typeof CIVITAI_PERIODS[number]

const TYPE_SET: ReadonlySet<string> = new Set(CIVITAI_MODEL_TYPES)
const SORT_SET: ReadonlySet<string> = new Set(CIVITAI_SORTS)
const PERIOD_SET: ReadonlySet<string> = new Set(CIVITAI_PERIODS)

export const isCivitaiModelType = (v: unknown): v is CivitaiModelType =>
  typeof v === 'string' && TYPE_SET.has(v)
export const isCivitaiSort = (v: unknown): v is CivitaiSort =>
  typeof v === 'string' && SORT_SET.has(v)
export const isCivitaiPeriod = (v: unknown): v is CivitaiPeriod =>
  typeof v === 'string' && PERIOD_SET.has(v)

/**
 * The engine families a compatible BASE CHECKPOINT is installed for. An
 * adapter (LoRA / embedding / VAE) is only installable on top of one.
 *
 * `zimage` joined on 2026-07-31. It is deliberately NOT symmetric with the
 * others: see civitaiInstallVerdict — a Z-Image CHECKPOINT is refused (three
 * files, Civitai ships one) while a Z-Image ADAPTER is allowed on top of the
 * curated `z-image-turbo` row. The family exists so that second half can be
 * expressed at all.
 *
 * There is no `wan` member and there must not be: this union is assignable to
 * sd-cpp-models' SdModelFamily, which keys an IMAGE-only defaults table and is
 * the equality test in isAdapterCompatible. Wan is handled by baseModel string
 * (CIVITAI_WAN_BASE_MODELS) instead, which is why Wan rows map to family null.
 */
export type CivitaiFamily = 'sd15' | 'sdxl' | 'flux' | 'zimage'
export type InstalledFamilies = ReadonlySet<CivitaiFamily>
const NO_FAMILIES: InstalledFamilies = new Set<CivitaiFamily>()

export interface CivitaiSearchQuery {
  query?: string
  cursor?: string | null
  /** Repeatable `types=` filter. Values outside CIVITAI_MODEL_TYPES are DROPPED
   *  rather than forwarded — one bad value 400s the entire request. */
  types?: string[]
  baseModels?: string[]
  /** One of CIVITAI_SORTS. Ignored on a cursor page (the cursor already encodes
   *  the ordering; changing it mid-walk is how you get duplicates). */
  sort?: string
  /** One of CIVITAI_PERIODS. Same cursor rule as `sort`. */
  period?: string
  limit?: number
  /** Thumbnails cost one fetch per row; the tests turn them off. */
  thumbnails?: boolean
  /**
   * The 18+ SETTINGS the IPC layer read. NOT the answer — `resolveCivitaiAdult`
   * ANDs these with a live keychain check, so a caller that passes
   * `{ adultMode: true, adultAcceptedAt: 1 }` with no key still browses SFW.
   */
  adultMode?: boolean
  adultAcceptedAt?: number
  /** Families with an installed base checkpoint; drives the adapter verdict.
   *  ABSENT ⇒ empty ⇒ every adapter reads "needs an SDXL checkpoint". Fail
   *  closed: a forgotten wire under-promises, it never over-promises. */
  installedFamilies?: InstalledFamilies
}

// ─── raw API shapes (only the fields we read) ────────────────────────────────

interface RawFile {
  sizeKB?: unknown
  name?: unknown
  type?: unknown
  metadata?: { format?: unknown; fp?: unknown; size?: unknown } | null
  hashes?: Record<string, unknown> | null
  downloadUrl?: unknown
  primary?: unknown
}
interface RawImage { url?: unknown; nsfwLevel?: unknown; type?: unknown }
interface RawVersion {
  id?: unknown
  name?: unknown
  baseModel?: unknown
  nsfwLevel?: unknown
  trainedWords?: unknown
  files?: RawFile[] | null
  images?: RawImage[] | null
  downloadUrl?: unknown
  /** HTML, per version. Present on the LIST response too — measured identical
   *  to the by-id copy — and frequently `null`. Read only by the detail view. */
  description?: unknown
  /** ISO string. Read only by the detail view. */
  publishedAt?: unknown
}
interface RawModel {
  id?: unknown
  name?: unknown
  type?: unknown
  poi?: unknown
  minor?: unknown
  mode?: unknown
  nsfw?: unknown
  nsfwLevel?: unknown
  tags?: unknown
  allowNoCredit?: unknown
  allowCommercialUse?: unknown
  allowDerivatives?: unknown
  stats?: { downloadCount?: unknown; thumbsUpCount?: unknown } | null
  modelVersions?: RawVersion[] | null
  /** HTML written by the uploader. Read only by the detail view, shipped to the
   *  renderer VERBATIM and parsed there (see src/pages/catalog/civitaiHtml.ts).
   *  MEASURED 2026-07-31: byte-identical between the list and by-id responses on
   *  6/6 sampled models (3 528 – 10 809 bytes), i.e. the list does NOT truncate
   *  it. Main deliberately does not pre-clean it — a half-sanitised string across
   *  IPC would be a second, weaker sanitizer that nobody tests. */
  description?: unknown
  creator?: { username?: unknown; image?: unknown } | null
}
export interface RawCivitaiPage {
  items?: RawModel[] | null
  metadata?: { nextCursor?: unknown } | null
}

// ─── pure mappers (unit-tested against captured live JSON) ───────────────────

/**
 * `allowCommercialUse` is a POSTGRES ARRAY LITERAL STRING, not JSON:
 *     "{Image,RentCivit,Rent,Sell}"   "{}"   "{RentCivit,Rent,Image}"
 * The order is NOT stable — across 100 live rows the same set appeared as
 * `{Image,RentCivit,Rent}` (28×) and `{RentCivit,Rent,Image}` (2×). So it must
 * be parsed as a SET; any consumer comparing arrays positionally is wrong.
 *
 * Returns a de-duplicated, SORTED array so equality is order-independent by
 * construction. Also tolerates the real JSON array some endpoints return.
 */
export function parseCommercialUse(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return [...new Set(raw.filter((v): v is string => typeof v === 'string' && v.length > 0))].sort()
  }
  if (typeof raw !== 'string') return []
  const inner = raw.trim().replace(/^\{/, '').replace(/\}$/, '')
  if (!inner.trim()) return []
  const parts = inner
    .split(',')
    .map(s => s.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter(s => s.length > 0)
  return [...new Set(parts)].sort()
}

/**
 * baseModel → the family OUR engine runs.
 *
 * The strings below are the LIVE enum values, counted over 1 908 versions on
 * 2026-07-28 (GET /api/v1/models?limit=100&nsfw=false&sort=Most Downloaded):
 *
 *   SD 1.5 584 · SDXL 1.0 278 · Illustrious 218 · Pony 203 · Flux.1 D 43 ·
 *   ZImageTurbo 37 · NoobAI 23 · SDXL Lightning 21 · Other 11 · Anima 11 ·
 *   SD 1.5 LCM 10 · ZImageBase 8 · SDXL Hyper 7 · Krea 2 5 · Flux.1 S 4 ·
 *   SDXL 0.9 3 · SDXL 1.0 LCM 3 · Upscaler 3 · SD 1.5 Hyper 2 ·
 *   Flux.1 Krea 1 · HiDream 1 · Ernie 1
 *
 * The Hyper/LCM/Lightning suffixes are DISTILLATION SCHEDULES, not
 * architectures — an "SDXL Lightning" checkpoint is an SDXL checkpoint that
 * wants fewer steps, and sd.cpp loads it as one. They are mapped.
 *
 * FLUX RETURNS null IN PHASE 1, deliberately: Civitai ships Flux checkpoints as
 * the UNET alone, while our flux row needs four components (diffusion + vae +
 * clip_l + t5xxl). Installing the UNET on its own would produce a model that
 * cannot generate — the exact fabricated-capability failure the honesty law
 * exists to stop. The reason string says so.
 */
export function familyForBaseModel(baseModel: unknown): CivitaiFamily | null {
  if (typeof baseModel !== 'string') return null
  switch (baseModel.trim()) {
    case 'SD 1.5':
    case 'SD 1.5 LCM':
    case 'SD 1.5 Hyper':
      return 'sd15'
    // ── Z-Image ─────────────────────────────────────────────────────────────
    // ECHO-TESTED 2026-07-31 against the live API, because the guessable
    // spelling is wrong and fails SILENTLY (an unknown `baseModels` value
    // returns an empty page, not a 400):
    //   baseModels=ZImageTurbo    → 100 models / 402 versions
    //   baseModels=ZImageBase     →  99 models / 194 versions
    //   baseModels=Z-Image Turbo  →   0 models /   0 versions   ← the trap
    // Both are in /api/v1/enums ActiveBaseModel. Mapping them does NOT make a
    // Z-Image checkpoint installable (the verdict refuses it as a bundle); it
    // makes the 235 measured Z-Image LoRAs installable on top of the curated
    // `z-image-turbo` row, which is the whole point.
    case 'ZImageTurbo':
    case 'ZImageBase':
      return 'zimage'
    case 'SDXL 1.0':
    case 'SDXL 0.9':
    case 'SDXL 1.0 LCM':
    case 'SDXL Lightning':
    case 'SDXL Hyper':
    case 'SDXL Turbo':
    case 'Pony':
    case 'Illustrious':
    case 'NoobAI':
      return 'sdxl'
    default:
      return null
  }
}

/** TRUE for the Flux family strings, so the verdict can give the real reason
 *  ("needs a component bundle") instead of the generic unsupported one. */
function isFluxBaseModel(baseModel: string): boolean {
  return /^Flux\.\d/i.test(baseModel.trim())
}

/**
 * Civitai's Wan vocabulary, ECHO-TESTED 2026-07-31 (models / versions returned
 * by GET /api/v1/models?limit=100&nsfw=false&baseModels=<X>):
 *
 *   Wan Video 1.3B t2v       52 / 65     Wan Video 2.2 TI2V-5B    50 / 69
 *   Wan Video 14B t2v       100 / 174    Wan Video 2.2 I2V-A14B  100 / 252
 *   Wan Video 14B i2v 480p  100 / 127    Wan Video 2.2 T2V-A14B  100 / 240
 *   Wan Video 14B i2v 720p  100 / 132
 *   Wan Video               100 / 195    ← RETIRED, and that matters
 *
 * The last one is in `BaseModel` but NOT in `ActiveBaseModel`: Civitai stopped
 * offering it when the variants landed, yet 195 live versions still carry it.
 * So it is READ here (those cards get the honest reason) and never OFFERED as a
 * filter chip — a retired value is exactly the kind of filter that quietly
 * stops matching anything.
 *
 * `Wan Video 2.5 *` and `Wan Image/Video 2.7` are active upstream but omitted:
 * we ship no 2.5/2.7 row, so this app has nothing true to say about them.
 */
export const CIVITAI_WAN_BASE_MODELS: readonly string[] = [
  'Wan Video 1.3B t2v',
  'Wan Video 14B t2v',
  'Wan Video 14B i2v 480p',
  'Wan Video 14B i2v 720p',
  'Wan Video 2.2 TI2V-5B',
  'Wan Video 2.2 I2V-A14B',
  'Wan Video 2.2 T2V-A14B',
  /** Retired upstream, still on live rows. Read-only — never a chip. */
  'Wan Video',
]
const WAN_BASE_SET: ReadonlySet<string> = new Set(CIVITAI_WAN_BASE_MODELS)

/**
 * TRUE for a Wan row. EXACT membership, never a prefix test: "Wandering
 * Diffusion" starts with "Wan" and is an SD 1.5 checkpoint.
 *
 * This exists so the verdict can stop telling Wan rows something false. We run
 * Wan — four curated rows of it — so "our engine does not run this base model"
 * was simply untrue on those cards; the truth is narrower and more useful.
 */
export function isCivitaiWanBaseModel(baseModel: unknown): boolean {
  return typeof baseModel === 'string' && WAN_BASE_SET.has(baseModel.trim())
}

/**
 * Civitai's LTX vocabulary, ECHO-TESTED 2026-07-31 the same way the Wan list
 * above was (GET /api/v1/models?limit=100&nsfw=false&baseModels=<X>) and
 * cross-checked against /api/v1/enums's `ActiveBaseModel`, which is where the
 * exact wire spellings below come from (not a guess — see the Z-Image comment
 * for what a guessed spelling costs: it 400s nothing and returns an empty page
 * instead, so the only way to know a string is right is to read it off the
 * enum and then see it come back rows):
 *
 *   LTXV        76 models / 144 versions  (Workflows 37 · LORA 36 · Checkpoint 3)
 *   LTXV 2.3   100 models / 209 versions  (Workflows 37 · LORA 56 · Checkpoint 7)
 *
 * `LTXV2` is ALSO a live ActiveBaseModel value (96 / 133 versions, echo-tested
 * the same way) and is deliberately NOT included: this lane's brief named only
 * `LTXV` and `LTXV 2.3`, and unlike those two, `LTXV2` was not the base model
 * documented for a checkpoint this app's engine can be shown to run — adding
 * it would be exactly the class of guess the echo-test discipline exists to
 * catch. It is a candidate for whoever verifies which of our curated rows (if
 * any) it corresponds to.
 *
 * SAME FAMILY-UNION RULE AS WAN, and for the identical reason: `CivitaiFamily`
 * is deliberately assignable to sd-cpp-models' `SdModelFamily`, and
 * `SdModelFamily` keys an EXHAUSTIVE `Record` (`FAMILY_DEFAULTS` in
 * user-sd-models.ts) that the image-only LoRA/VAE compat gate reads. Widening
 * either union to add `ltx2` would either fail to compile at that Record (a
 * missing key) or — worse, if `FAMILY_DEFAULTS` grew a filler entry just to
 * satisfy the compiler — let an LTX video row flow through code that computes
 * an IMAGE baseSize/steps/cfg default for it, the same "recognized-but-not-
 * backed" failure user-sd-models.ts's own comment warns a Z-Image lookalike
 * bug into being. So `ltx2`, like `wan`, is decided on the RAW baseModel
 * string, one level before any family lookup, never as a family value itself.
 */
export const CIVITAI_LTX_BASE_MODELS: readonly string[] = [
  'LTXV',
  'LTXV 2.3',
]
const LTX_BASE_SET: ReadonlySet<string> = new Set(CIVITAI_LTX_BASE_MODELS)

/** TRUE for an LTX row. EXACT membership, same discipline as
 *  isCivitaiWanBaseModel — a prefix test would catch unrelated models that
 *  merely start with the same letters. */
export function isCivitaiLtxBaseModel(baseModel: unknown): boolean {
  return typeof baseModel === 'string' && LTX_BASE_SET.has(baseModel.trim())
}

/** `civitai-<versionId>` — [a-z0-9-] only (risk R10). */
export function civitaiRowId(versionId: number): string {
  return `civitai-${versionId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

/**
 * The primary file. `primary: true` marks it; the key is ABSENT (not false) on
 * the others, so `.find(f => f.primary)` is the correct test. Falls back to the
 * first `type: 'Model'` entry, then to files[0] — a version always has files.
 */
export function pickPrimaryFile(files: RawFile[] | null | undefined): RawFile | null {
  if (!Array.isArray(files) || files.length === 0) return null
  return files.find(f => f?.primary === true)
    ?? files.find(f => f?.type === 'Model')
    ?? files[0]
    ?? null
}

const num = (v: unknown, dflt = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : dflt
const str = (v: unknown, dflt = ''): string => (typeof v === 'string' ? v : dflt)

// ─── run-truth verdict ───────────────────────────────────────────────────────

/**
 * THE INSTALL ALLOWLIST. `installable` is TRUE only for
 *   • type === 'Checkpoint'                — runs on its own, and
 *   • an ADAPTER on an INSTALLED BASE      — LoRA / LoCon / embedding / VAE,
 *     but ONLY when a checkpoint of the same family is already on disk,
 * and in both cases only when format !== PickleTensor AND sha256 !== null.
 * Every other case gets an honest reason.
 *
 * ── WHY THE ADAPTER RULE IS "INSTALLED", NOT "SUPPORTED" ────────────────────
 * A LoRA is not a model, it is a modifier. sd.cpp applies it via
 * `--lora-model-dir` plus a `<lora:name:weight>` tag IN THE PROMPT; an
 * embedding via `--embd-dir` plus its filename as a token; a VAE via `--vae`.
 * All three need a checkpoint of the matching architecture underneath, and the
 * failure when one is missing is SILENT — ComfyUI's ecosystem no-ops a
 * mismatched LoRA with a console-only warning (comfy/lora.py:93), which is
 * precisely the class of lie this app refuses to ship. We hold `family` per
 * artifact and run one engine, so we can simply check.
 *
 * `installedFamilies` ABSENT ⇒ empty ⇒ every adapter is refused with a reason
 * naming the checkpoint it wants. A forgotten wire under-promises.
 *
 * ORDER MATTERS and it is safety-first: the PickleTensor refusal is checked
 * BEFORE any capability reason, so a `.ckpt` is always told the true blocking
 * reason rather than a softer one.
 *
 * The STATIC reason strings are a closed set (CIVITAI_REASONS); the one dynamic
 * family-dependent string is built by civitaiNeedsBaseReason(). Both paths also
 * set `reasonCode`, a stable machine key, so a UI lane can key i18n off the
 * code instead of string-matching prose.
 */
export const CIVITAI_REASONS = {
  pickle: 'Pickle format is never installed — a .ckpt can execute arbitrary code on load.',
  noHash: 'No SHA256 published — we only install files we can verify.',
  noFile: 'This version publishes no downloadable file.',
  controlnet: 'ControlNet support comes in phase 4.',
  upscaler: 'Upscaler support comes in phase 4.',
  motion: 'AnimateDiff support comes in phase 4.',
  dora: 'DoRA is never offered — our engine drops the magnitude vector and would render silently wrong output.',
  unsupportedType: 'This model type does not run in our image engine.',
  flux: 'Flux needs a component bundle (VAE + CLIP-L + T5) that Civitai does not ship with the checkpoint.',
  // Same shape as the Flux refusal, same reason: our z-image-turbo row is
  // diffusion + VAE + Qwen3-4B-Instruct-2507, and Civitai publishes the
  // diffusion file alone. LoRAs for it ARE installable — this refusal is only
  // ever reached by a Checkpoint.
  zimageBundle: 'Z-Image needs a component bundle (VAE + Qwen3 text encoder) that Civitai does not ship with the checkpoint. Install Z-Image Turbo from the local models list, then Z-Image LoRAs work on top of it.',
  // NOT "we don't run this": we run four Wan rows. What we cannot do is build
  // one out of a single Civitai file, or file a Wan LoRA in an adapter registry
  // whose family union is image-only. Both halves are said out loud.
  wan: 'Wan video installs from the local models list (it needs diffusion + VAE + T5 together), and Wan LoRAs cannot be registered here yet. Browsing them is fine — installing from Civitai is not wired.',
  // Same shape as the Wan refusal: we run LTX-2.3 (five curated components —
  // diffusion + VAE + audio VAE + embeddings connectors + an LLM encoder), so
  // "our engine does not run this" would be false, and no single Civitai file
  // can assemble that bundle either.
  ltx: 'LTX video installs from the local models list (it needs diffusion + VAE + text encoder together), and LTX LoRAs cannot be registered here yet. Browsing them is fine — installing from Civitai is not wired.',
  unsupportedBase: 'Our engine does not run this base model yet.',
} as const

export type CivitaiReason = typeof CIVITAI_REASONS[keyof typeof CIVITAI_REASONS]

/** Stable machine keys for every refusal, for i18n and for tests that should
 *  not assert on prose. `needs-base` is the only one whose text varies. */
export const CIVITAI_REASON_CODES = [
  'no-file', 'pickle', 'no-hash', 'needs-base', 'controlnet', 'upscaler',
  'motion', 'dora', 'unsupported-type', 'flux', 'zimage-bundle', 'wan', 'ltx',
  'unsupported-base',
] as const
export type CivitaiReasonCode = typeof CIVITAI_REASON_CODES[number]

/**
 * The artifact kinds that run ON TOP OF an installed checkpoint.
 *
 * Source-asserted against the installed sd-cli (master-782-b290693): LoRA /
 * LoCon carry LoHa+LoKr keymaps in the DLL, TextualInversion loads via
 * `--embd-dir` with a hidden-size check that rejects a wrong base, and VAE via
 * `--vae`. DoRA is deliberately ABSENT — the binary has no `dora_scale`
 * strings, so it would silently drop the magnitude vector and render subtly
 * wrong output. That is a never, not a phase.
 *
 * `LyCORIS` is a LEGACY `model.type` string only: `types=LyCORIS` 400s on the
 * live API (verified 2026-07-28) because it was folded into LoCon. It is listed
 * so an old row still resolves, and it is NOT in CIVITAI_MODEL_TYPES.
 */
export const CIVITAI_ADAPTER_TYPES = ['LORA', 'LoCon', 'LyCORIS', 'TextualInversion', 'VAE'] as const
const ADAPTER_SET: ReadonlySet<string> = new Set(CIVITAI_ADAPTER_TYPES)
export const isCivitaiAdapterType = (t: unknown): boolean =>
  typeof t === 'string' && ADAPTER_SET.has(t)

/** What the user calls this thing, for the reason sentence. */
const ADAPTER_LABEL: Record<string, string> = {
  LORA: 'LoRA', LoCon: 'LoRA', LyCORIS: 'LoRA',
  TextualInversion: 'embedding', VAE: 'VAE',
}

/** How Civitai's own users name the base — matches the chips on the card, with
 *  the article that goes in front of it. "a SD 1.5 checkpoint" is wrong: the
 *  article follows the SOUND, and both `SD` and `SDXL` open on "ess". A table
 *  because a vowel-letter test would get both of them backwards. */
const FAMILY_LABEL: Record<CivitaiFamily, { article: string; label: string }> = {
  sd15:   { article: 'an', label: 'SD 1.5' },
  sdxl:   { article: 'an', label: 'SDXL' },
  flux:   { article: 'a',  label: 'Flux' },
  // The name the local row uses ("Z-Image Turbo"), hyphenated — NOT Civitai's
  // `ZImageTurbo` wire spelling. This string is prose for a human; the wire
  // spelling belongs only where a request is built.
  zimage: { article: 'a',  label: 'Z-Image' },
}

/**
 * "Needs an SDXL checkpoint" — the honest refusal for a runnable adapter with
 * no base under it. It names BOTH the base to install and what this artifact
 * is, because "needs an SDXL checkpoint" alone does not tell a user why the
 * thing they clicked is not a model.
 */
export function civitaiNeedsBaseReason(family: CivitaiFamily, type: string): string {
  const what = ADAPTER_LABEL[type] ?? 'add-on'
  const { article, label } = FAMILY_LABEL[family]
  return `Needs ${article} ${label} checkpoint — install one first and this ${what} runs on top of it.`
}

export interface InstallVerdict {
  installable: boolean
  reason?: string
  reasonCode?: CivitaiReasonCode
}

/** Static-reason types, in the order they are checked. */
const TYPE_REASON: Record<string, { reason: string; code: CivitaiReasonCode }> = {
  DoRA:         { reason: CIVITAI_REASONS.dora,       code: 'dora' },
  Controlnet:   { reason: CIVITAI_REASONS.controlnet, code: 'controlnet' },
  Upscaler:     { reason: CIVITAI_REASONS.upscaler,   code: 'upscaler' },
  MotionModule: { reason: CIVITAI_REASONS.motion,     code: 'motion' },
}

export function civitaiInstallVerdict(
  row: {
    type: string
    family: CivitaiFamily | null
    baseModel: string
    format: string
    sha256: string | null
    downloadUrl: string
  },
  ctx: { installedFamilies?: InstalledFamilies } = {},
): InstallVerdict {
  if (!row.downloadUrl) return { installable: false, reason: CIVITAI_REASONS.noFile, reasonCode: 'no-file' }
  // Safety first — before any capability softener.
  if (row.format === 'PickleTensor') return { installable: false, reason: CIVITAI_REASONS.pickle, reasonCode: 'pickle' }
  if (!row.sha256) return { installable: false, reason: CIVITAI_REASONS.noHash, reasonCode: 'no-hash' }

  const installed = ctx.installedFamilies ?? NO_FAMILIES

  // WAN IS DECIDED ON THE BASE MODEL, BEFORE THE TYPE BRANCHES, and it has to
  // be: a Wan row maps to family null, so a Wan LoRA would otherwise fall into
  // the adapter branch's `family === null` arm and be told "our engine does not
  // run this base model yet" — false, since we ship four Wan rows — while a Wan
  // checkpoint would get the same false line from the checkpoint arm. One
  // check, above both, gives both the same true answer.
  if (isCivitaiWanBaseModel(row.baseModel)) {
    return { installable: false, reason: CIVITAI_REASONS.wan, reasonCode: 'wan' }
  }

  // SAME REASONING, SAME PLACEMENT: an LTX row also maps to family null (no
  // `ltx2` member on CivitaiFamily — see the comment on CIVITAI_LTX_BASE_MODELS
  // for why), so without this check both a Checkpoint and an adapter would
  // fall into the `family === null` arms below and be told the generic,
  // FALSE "our engine does not run this base model yet" — false because we
  // ship a curated LTX-2.3 row.
  if (isCivitaiLtxBaseModel(row.baseModel)) {
    return { installable: false, reason: CIVITAI_REASONS.ltx, reasonCode: 'ltx' }
  }

  if (row.type === 'Checkpoint') {
    if (row.family === null) {
      return isFluxBaseModel(row.baseModel)
        ? { installable: false, reason: CIVITAI_REASONS.flux, reasonCode: 'flux' }
        : { installable: false, reason: CIVITAI_REASONS.unsupportedBase, reasonCode: 'unsupported-base' }
    }
    // A COMPONENT-BUNDLE FAMILY IS NOT INSTALLABLE AS A CHECKPOINT. Flux never
    // reaches here (familyForBaseModel returns null for it), but Z-Image does —
    // it needs a family so its ADAPTERS can be judged, and that same family
    // arriving on a Checkpoint must not be read as permission. Civitai ships
    // the diffusion file; our row needs diffusion + VAE + Qwen3 encoder.
    if (row.family === 'zimage') {
      return { installable: false, reason: CIVITAI_REASONS.zimageBundle, reasonCode: 'zimage-bundle' }
    }
    // Single-file checkpoints only.
    return { installable: true }
  }

  if (isCivitaiAdapterType(row.type)) {
    // An adapter for a base we cannot run at all is refused on the BASE, not on
    // the missing-checkpoint story — telling someone to install a Wan checkpoint
    // so their Wan LoRA works would be a promise we cannot keep.
    if (row.family === null) {
      return { installable: false, reason: CIVITAI_REASONS.unsupportedBase, reasonCode: 'unsupported-base' }
    }
    if (!installed.has(row.family)) {
      return {
        installable: false,
        reason: civitaiNeedsBaseReason(row.family, row.type),
        reasonCode: 'needs-base',
      }
    }
    return { installable: true }
  }

  const known = TYPE_REASON[row.type]
  return known
    ? { installable: false, reason: known.reason, reasonCode: known.code }
    : { installable: false, reason: CIVITAI_REASONS.unsupportedType, reasonCode: 'unsupported-type' }
}

// ─── mapping ─────────────────────────────────────────────────────────────────

/**
 * Map one raw page to rows. PURE — no network, no thumbnails (thumbnail is left
 * null and filled in by the caller).
 *
 * ONE ROW PER MODEL BY DEFAULT, and that is a correctness decision, not a
 * cosmetic one. `/models` embeds EVERY version of every model: measured live on
 * 2026-07-28, 5 models came back carrying 55 versions and 100 models carried
 * 1477. Emitting a row per version would turn a `limit=50` search into ~700
 * cards and ~700 thumbnail fetches — a browse that is slow, unreadable, and
 * hammers their CDN. The catalog card is a MODEL; the version is what the card
 * resolves to.
 *
 * The version chosen is the first one that passes the gate AND is installable
 * (the array is newest-first), falling back to the first gate-passing version
 * so a model we cannot run still gets a card with an honest reason rather than
 * silently vanishing. Pass `allVersions` for a future version picker.
 *
 * Every (model, version) pair runs through civitaiRowAllowed() either way: a
 * model contributes 0 rows when nothing survives the gate, which is normal.
 */
export function mapCivitaiPage(
  page: RawCivitaiPage | null | undefined,
  opts: CivitaiMapOptions = {},
): CivitaiSearchRow[] {
  return mapCivitaiPageCounted(page, opts).rows
}

/**
 * What the mapper is allowed to know. NOTE what is NOT here: any way to relax
 * layer 0. `adult` selects between two LAYER-1 ceilings and nothing else.
 */
export interface CivitaiMapOptions {
  /** One row per VERSION instead of one per model (the install lookup path). */
  allVersions?: boolean
  /**
   * The RESOLVED mode — always the return value of resolveCivitaiAdult(), never
   * a setting and never a renderer claim. Default false, so every caller that
   * forgets it maps SFW.
   */
  adult?: boolean
  /** Families with an installed base checkpoint (the adapter verdict). */
  installedFamilies?: InstalledFamilies
}

/**
 * `mapCivitaiPage` plus the number the tab has to be able to say out loud.
 *
 * `filteredCount` counts MODELS, not versions, and that is the only count that
 * matches what the user sees: the browse grid is one card per model, so
 * "22 hidden" must mean "22 cards you would otherwise have" — counting the
 * ~19 gated versions behind each of them would print a number nobody can
 * reconcile with a 24-row page.
 *
 * A model is counted ONLY when it had at least one version to judge and the
 * GATE refused every one of them. A model with no usable version id at all is
 * malformed data, not censored data, and is not claimed as either.
 */
export function mapCivitaiPageCounted(
  page: RawCivitaiPage | null | undefined,
  opts: CivitaiMapOptions = {},
): { rows: CivitaiSearchRow[]; filteredCount: number } {
  const items = Array.isArray(page?.items) ? page!.items! : []
  const rows: CivitaiSearchRow[] = []
  let filteredCount = 0
  // Resolved upstream. `adult: true` widens layer 1 to the 31 ceiling and does
  // nothing else — layer 0 below takes no mode argument at all.
  const mode = { adult: opts.adult === true }
  const verdictCtx = { installedFamilies: opts.installedFamilies }

  for (const model of items) {
    const modelId = num(model?.id, -1)
    if (modelId < 0) continue
    const versions = Array.isArray(model?.modelVersions) ? model!.modelVersions! : []
    const perModel: CivitaiSearchRow[] = []
    /** Versions the gate actually got to judge (a bad id is not a refusal). */
    let judged = 0
    let refused = 0

    for (const version of versions) {
      const versionId = num(version?.id, -1)
      if (versionId < 0) continue
      judged++

      // THE GATE. Layer 0 (unconditional, takes no mode) then the layer-1
      // ceiling for the resolved mode — the bitmask pass over BOTH levels that
      // neither `nsfw=false` nor the .red host does for us.
      if (!civitaiRowAllowed(model, version, mode)) { refused++; continue }

      const file = pickPrimaryFile(version.files)
      const meta = (file?.metadata ?? null) as { format?: unknown; fp?: unknown } | null
      const hashes = (file?.hashes ?? null) as Record<string, unknown> | null
      const rawSha = hashes?.SHA256
      const sha256 = typeof rawSha === 'string' && rawSha.length > 0 ? rawSha.toLowerCase() : null

      const baseModel = str(version.baseModel)
      const family = familyForBaseModel(baseModel)
      const type = str(model?.type)
      const format = str(meta?.format, 'Unknown')
      // downloadUrl VERBATIM from the file (it carries ?type=&format=&fp= for
      // multi-file models); the version-level url is the fallback.
      const downloadUrl = str(file?.downloadUrl) || str(version.downloadUrl)
      // ceil(decimal KB / 1024) — over-declaring is safe, under-declaring makes
      // the disk preflight reserve too little.
      const sizeKB = num(file?.sizeKB, 0)
      const sizeMb = sizeKB > 0 ? Math.ceil(sizeKB / 1024) : 0

      const verdict = civitaiInstallVerdict(
        { type, family, baseModel, format, sha256, downloadUrl },
        verdictCtx,
      )

      perModel.push({
        id: civitaiRowId(versionId),
        modelId,
        versionId,
        name: `${str(model?.name, 'Untitled')} - ${str(version.name, 'v?')}`,
        type,
        family,
        baseModel,
        sizeMb,
        sha256,
        downloadUrl,
        fileName: str(file?.name),
        format,
        fp: typeof meta?.fp === 'string' ? meta.fp : null,
        nsfwLevelModel: num(model?.nsfwLevel, 0),
        // The VERSION's own level. A model-level number cannot describe the
        // artifact the card installs (Pony Diffusion is level 15 at the model
        // and 3 at the version the card resolves to), and the blur decision in
        // the catalog is about THIS row, not about its neighbours.
        nsfwLevelVersion: num(version?.nsfwLevel, 0),
        downloads: num(model?.stats?.downloadCount, 0),
        likes: num(model?.stats?.thumbsUpCount, 0),
        thumbnail: null,
        // 0 until the network half actually lands a thumbnail; a failed fetch
        // leaves both fields at their honest "there is no image" values rather
        // than advertising a level for a picture nobody has.
        thumbnailNsfwLevel: 0,
        // The SAME builder the detail payload uses, on the SAME resolved mode —
        // so the panel's "Open on Civitai" is live on the first frame and points
        // at the identical url the by-id fetch will bring. `mode.adult` is
        // resolveCivitaiAdult()'s answer, never a renderer claim.
        pageUrl: civitaiModelPageUrl(modelId, mode.adult, versionId),
        trainedWords: normalizeTrainedWords(version.trainedWords),
        license: {
          commercial: parseCommercialUse(model?.allowCommercialUse),
          noCredit: model?.allowNoCredit === true,
          derivatives: model?.allowDerivatives === true,
        },
        ...verdict,
      })

      // Fast exit: with one-row-per-model we can stop as soon as we have an
      // installable candidate — the newest runnable version wins.
      if (!opts.allVersions && perModel.some(r => r.installable)) break
    }

    if (opts.allVersions) rows.push(...perModel)
    else if (perModel.length > 0) rows.push(perModel.find(r => r.installable) ?? perModel[0]!)

    // The whole model vanished, and the gate is why. (The fast exit above can
    // leave `judged > refused` with rows present — that is a survivor, not a
    // drop, so the emptiness of perModel is the condition, not the counters.)
    if (perModel.length === 0 && judged > 0 && refused === judged) filteredCount++
  }
  return { rows, filteredCount }
}

/**
 * Trigger words. Real data is messy: usually a proper array, but frequently a
 * SINGLE comma-joined string with trailing junk. Split, trim, drop empties,
 * de-dup, cap — these become prompt chips in phase 2.
 */
export function normalizeTrainedWords(raw: unknown): string[] {
  const parts: string[] = []
  const push = (v: unknown) => {
    if (typeof v !== 'string') return
    for (const piece of v.split(',')) {
      const t = piece.trim().replace(/^[,\s]+|[,\s]+$/g, '')
      if (t) parts.push(t)
    }
  }
  if (Array.isArray(raw)) raw.forEach(push)
  else push(raw)
  return [...new Set(parts)].slice(0, 24)
}

/** The PG preview url for a version, or null. Equality on level 1, never a
 *  bitmask pass — see isPgPreviewImage. */
export function pgPreviewUrl(version: RawVersion | null | undefined): string | null {
  return pickPreviewImage(version, false)?.url ?? null
}

/** A chosen preview and the level it carries, so the card can blur without
 *  guessing and without a second lookup. */
export interface CivitaiPreviewPick {
  url: string
  /** The image's own nsfwLevel. 1 in SFW mode, by construction. */
  level: number
}

/**
 * THE PREVIEW CHOICE, for both modes.
 *
 * SFW: the first level-1 https image, exactly as before — an equality test, not
 * a ceiling, because a PG13 preview buys the card nothing and the FETCH itself
 * is the thing being careful about.
 *
 * ADULT: the LEAST EXPLICIT image that passes the 31 ceiling, not the first
 * one. Civitai orders `images` by its own ranking, so "first" on an unlocked
 * row is routinely an X/XXX frame while a PG13 sample of the same model sits
 * two entries down. Picking the minimum level means a great many unlocked cards
 * still render an unblurred, unremarkable thumbnail, and the ones that cannot
 * are honestly marked instead of being quietly the worst available. Ties keep
 * source order (the ranking is a real signal once the level is equal).
 *
 * BOTH paths refuse http:, refuse videos, and refuse the Blocked bit —
 * `isAdultPreviewImage` runs `adultAllowed`, which is why a level-32 image
 * (measured: 3 of 4 095 on an nsfw=true page) never becomes a thumbnail.
 */
export function pickPreviewImage(
  version: RawVersion | null | undefined,
  adult: boolean,
): CivitaiPreviewPick | null {
  const images = Array.isArray(version?.images) ? version!.images! : []
  let best: CivitaiPreviewPick | null = null
  for (const img of images) {
    const candidate = img as { nsfwLevel?: unknown; type?: unknown }
    if (!(adult ? isAdultPreviewImage(candidate) : isPgPreviewImage(candidate))) continue
    const url = str(img?.url)
    if (!url.startsWith('https://')) continue
    const level = num(img?.nsfwLevel, 0)
    if (!adult) return { url, level }          // SFW: level is 1 by definition
    if (best === null || level < best.level) best = { url, level }
    if (best.level === NSFW_BIT.PG) break      // cannot do better than PG
  }
  return best
}

/**
 * THE DETAIL GALLERY'S picks — the plural sibling of pickPreviewImage.
 *
 * IT EXISTS BECAUSE THE BY-ID ENDPOINT DOES NOT HONOUR `nsfw`. Measured
 * 2026-07-31 on the live API, no key:
 *   GET /models?limit=24&nsfw=false → model 4201 v501240 carried 16 images,
 *                                     EVERY one at level 1
 *   GET /models/4201                → the SAME version carried 20 images at
 *                                     levels [2,1,1,1,4,1,1,1,1,2,1,1,1,1,1,
 *                                     1,1,1,1,8]
 *   GET /models/4201?nsfw=false     → 20 images. IDENTICAL. The param is ignored.
 * So the grid's thumbnail picker gets to lean on a server that already clamped
 * the response to PG, and the detail panel does NOT: it receives R (4) and X (8)
 * images in SFW mode. The bitmask pass below is therefore the ONLY thing between
 * an unlocked user's ceiling and an unrelated stranger's model page.
 *
 * Same predicates as everywhere else — isPgPreviewImage / isAdultPreviewImage
 * from civitai-gate.ts. No second gate, no inlined `&`: if the ceiling ever
 * moves it moves in one file.
 *
 * SORTED LEAST EXPLICIT FIRST in adult mode (stable within a level, so Civitai's
 * own ranking still decides ties), because a gallery that opens on the mildest
 * sample is the one a user can close before it surprises them. In SFW mode every
 * survivor is level 1 by construction, so the sort is a no-op there.
 */
export function pickPreviewImages(
  version: RawVersion | null | undefined,
  adult: boolean,
  max: number,
): CivitaiPreviewPick[] {
  const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0
  if (cap === 0) return []
  const images = Array.isArray(version?.images) ? version!.images! : []
  const out: CivitaiPreviewPick[] = []
  const seen = new Set<string>()
  for (const img of images) {
    const candidate = img as { nsfwLevel?: unknown; type?: unknown }
    if (!(adult ? isAdultPreviewImage(candidate) : isPgPreviewImage(candidate))) continue
    const url = str(img?.url)
    if (!url.startsWith('https://')) continue
    if (seen.has(url)) continue          // the API repeats a url across versions
    seen.add(url)
    out.push({ url, level: num(img?.nsfwLevel, 0) })
  }
  // Stable ascending sort. Array.prototype.sort is stable in V8, which is what
  // preserves the upstream ranking among equally-rated images.
  out.sort((a, b) => a.level - b.level)
  return out.slice(0, cap)
}

// ─── thumbnails ──────────────────────────────────────────────────────────────
//
// Main-process fetch → data: URI. Three reasons it cannot be a plain <img src>:
//   - the prod CSP's img-src has no https:
//   - a remote src is one request per card, from the renderer, to a host we do
//     not control
//   - the data: URI is capped and MEMORY-ONLY. Nothing from image.civitai.com
//     is ever written to disk: an on-disk cache would outlive the SFW mode that
//     produced it, and phase 3 makes that a real hazard rather than a
//     hypothetical one.
//
// WE NEVER FETCH THE `original=true` IMAGE. MEASURED 2026-07-28 over six real
// PG previews from the fixture's own rows:
//
//     original=true   839 KB · 998 KB · 947 KB · 2.71 MB · 2.45 MB · 2.63 MB
//     width=450        55 KB ·  64 KB ·  55 KB ·   404   ·   75 KB ·   86 KB
//     width=320 (the 404 case, retried)                     57 KB
//
// The spec assumed the PG preview was already thumbnail-sized and that a
// straight pass-through under a ~200 KB cap would work. It is not: EVERY
// original blows the cap, so that implementation would have shipped a catalog
// with zero thumbnails and no error anywhere. `/original=true/` → `/width=N/`
// is the CDN's OWN transform, so this is still pass-through — we decode
// nothing, resize nothing, and ship no image library. 450 is the primary; one
// of the six deterministically 404s at 450 (retried, still 404) and serves fine
// at 320, so 320 is the fallback and there is no third attempt: 50 cards ×
// 2.7 MB of base64 is not a thumbnail strategy, it is an OOM.
//
// HOST CONTAINMENT (spec risk R7): only image.civitai.com is ever fetched here.
// The url arrives from an API response; treating it as an arbitrary fetch
// target would make one compromised response an SSRF primitive.

const THUMB_WIDTHS = [450, 320] as const
const THUMB_HOST = 'image.civitai.com'

/**
 * The urls we are willing to fetch for one preview, in order. Empty = refuse.
 * PURE — no network, so the containment rule is unit-testable on its own.
 */
export function civitaiThumbnailCandidates(rawUrl: string): string[] {
  if (typeof rawUrl !== 'string' || !rawUrl) return []
  let u: URL
  try { u = new URL(rawUrl) } catch { return [] }
  if (u.protocol !== 'https:') return []
  if (u.hostname.toLowerCase() !== THUMB_HOST) return []
  if (!rawUrl.includes('/original=true/')) return [rawUrl]   // already derived
  return THUMB_WIDTHS.map(w => rawUrl.replace('/original=true/', `/width=${w}/`))
}

const thumbCache = new Map<string, string | null>()

/** Test seam + a real one: PRIVATE MODE toggling should not serve stale art. */
export function clearCivitaiThumbnailCache(): void {
  thumbCache.clear()
}

/** One candidate. Returns a data: URI or null; never throws. */
async function fetchOneThumbnail(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(THUMB_TIMEOUT_MS) as AbortSignal })
    if (!res.ok) return null
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (!ct.startsWith('image/')) return null      // an HTML/JSON error page is not a thumbnail
    if (declared > THUMB_MAX_BYTES) return null
    const buf = Buffer.from(await res.arrayBuffer())
    // Re-check against the ACTUAL bytes: content-length is a claim, not a fact.
    if (buf.byteLength === 0 || buf.byteLength > THUMB_MAX_BYTES) return null
    return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`
  } catch {
    return null   // never let a thumbnail failure fail a search
  }
}

export async function fetchCivitaiThumbnail(url: string): Promise<string | null> {
  const candidates = civitaiThumbnailCandidates(url)
  if (candidates.length === 0) return null

  if (thumbCache.has(url)) {
    const hit = thumbCache.get(url)!
    thumbCache.delete(url)      // LRU touch
    thumbCache.set(url, hit)
    return hit
  }

  let out: string | null = null
  try {
    enforceProviderEgress(CIVITAI_KEY_ID)
    for (const candidate of candidates) {
      out = await fetchOneThumbnail(candidate)
      if (out) break
    }
  } catch {
    return null   // PRIVATE MODE: refuse WITHOUT caching, so the toggle is live
  }

  thumbCache.set(url, out)
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value
    if (oldest === undefined) break
    thumbCache.delete(oldest)
  }
  return out
}

// ─── network ─────────────────────────────────────────────────────────────────

/**
 * Bearer header when the user stored a key, else {}. Search works without one.
 *
 * WHAT THE KEY BUYS, PRECISELY: account-gated downloads — the versions whose
 * documented `requireAuth` is true (see fetchCivitaiVersionMini below), plus the
 * authenticated-only endpoints and filters we do not currently call.
 *
 * IT DOES NOT RAISE RATE LIMITS. That claim used to be on this line and it was
 * uncited: <https://developer.civitai.com/site/guide/errors.md> states there is
 * no per-endpoint rate limit exposed as a stable contract, that the Cloudflare
 * edge limits are operational rather than a published SLA, and that a 429 is a
 * signal to back off rather than a scheme to code against. No authenticated
 * tier, and no higher-limit-with-key statement, exists anywhere in their corpus.
 */
export function civitaiAuthHeaders(): Record<string, string> {
  try {
    const key = retrieveKey(CIVITAI_KEY_ID)
    return key ? { Authorization: `Bearer ${key}` } : {}
  } catch {
    return {}   // keychain unavailable ⇒ anonymous, not broken
  }
}

// ─── VALIDATING A PASTED KEY (the Settings card's ping) ──────────────────────
//
// THE PROBLEM THIS SOLVES: a public Civitai endpoint IGNORES a bad bearer token
// instead of rejecting it, so a typo used to be stored happily and then surface
// hours later as "Civitai rejected the stored API key for this download (401)".
//
// MEASURED 2026-08-01 — every cell live, with a DELIBERATELY FAKE key (the
// owner's real key was never used). `garbage` = junk; `32hex` = a well-formed
// 32-hex string that is not a key:
//
//   endpoint                              no header   Bearer garbage   Bearer 32hex
//   /api/v1/models?limit=1                200         200              200
//   /api/v1/model-versions/mini/1833157   200         200              200
//   /api/v1/model-versions/mini/9208      200         200              200
//   /api/v1/me                            401         401              401
//   /api/v1/models?limit=1&favorites=true 401         401              401
//   /api/v1/models?limit=1&hidden=true    401         401              401
//
// All six 401s carried the identical body `{"error":"Unauthorized"}`.
//
// ⇒ PUBLIC ENDPOINTS ARE USELESS AS A VALIDATOR (a fake key gets a clean 200);
//   /api/v1/me is the only reachable endpoint that reacts to the caller at all.
//
// Their docs close the loop on the half we cannot measure without a real key
// (<https://developer.civitai.com/site/reference/users.md>):
//   • `GET /api/v1/me` — "Auth: Authenticated — a valid token is required.
//     Returns 401 otherwise", and "Use this to confirm which account a token
//     belongs to". Response: `{ id, username, tier, status, isMember,
//     subscriptions }`.
//   • "Returned for missing, malformed, or revoked tokens alike — the API does
//     not distinguish between them" — which is exactly the three identical 401s
//     above, and it is fine here: this function always sends the pasted key, so
//     the only question is accepted-or-not, never which flavour of not.
//   • <https://developer.civitai.com/site/guide/authentication.md> uses this
//     very request as its example of passing a PERSONAL API key.
//
// WHAT A GREEN ANSWER PROVES, AND WHAT IT DOES NOT:
//   ✓ the key is a live account credential accepted for authenticated reads, and
//     it names WHICH account — the thing the user can actually check.
//   ✗ nothing about any particular `requireAuth` download. That is per-version
//     and this call cannot speak for it.
//   ✗ nothing about adult content. There is no adult scope and the SFW clamp
//     applies "regardless of session" — a key is not the 18+ gate, ours is.
//
// MAIN-PROCESS ONLY, and that is not a preference: their docs state
// "authenticated requests are restricted to Civitai-owned origins", so a
// renderer fetch would be refused by CORS. The renderer asks over IPC.

/** The answer to "is this key live, and whose is it?" — never the key back. */
export type CivitaiKeyProbe =
  | { ok: true; username: string }
  | KeyProbeFailure

/**
 * Validate a PASTED key against `/api/v1/me`.
 *
 * Takes the key as an ARGUMENT and never reads the keychain: the card pings
 * BEFORE it saves, so a rejected key is never stored — and pinging the stored
 * copy would report on the credential being replaced rather than the new one.
 * For the same reason it does NOT go through civitaiFetchWithRetry, whose
 * headers come from the keychain (it would validate the OLD key, or none).
 *
 * Never throws: an offline machine, a PRIVATE MODE denial and a 500 all come
 * back as a FAILURE OBJECT, because a Settings card must render a failure rather
 * than catch one.
 *
 * REJECTED vs UNVERIFIED (`verdictFor`, shared with the four provider validators
 * in provider-key-probe.ts): Civitai's own docs say `/api/v1/me` returns 401 for
 * "missing, malformed, or revoked tokens alike", so a 401 IS an answer about the
 * credential and nothing is stored. Everything else — offline, PRIVATE MODE,
 * 429, 5xx — is UNVERIFIED: the key is stored and the card says it could not be
 * checked, because refusing the save teaches the user nothing and costs them a
 * key that may be perfectly good.
 *
 * ALWAYS civitai.com, never the .red mirror: a key is account-scoped, the host
 * split is about CONTENT, and identity is not content. Asking the adult host to
 * check a credential would tie the two together for no gain.
 */
export async function validateCivitaiKey(key: unknown): Promise<CivitaiKeyProbe> {
  const k = typeof key === 'string' ? key.trim() : ''
  // No request for an empty box — and no egress check either, since nothing
  // would be sent. Nothing was asked, so nothing was rejected.
  if (!k) return unverified()
  try {
    enforceProviderEgress(CIVITAI_KEY_ID)
    const res = await fetch(`${CIVITAI_HOST_SFW}/api/v1/me`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${k}` },
      // Never `?token=`: the docs call the query form leaky (logs, caches) and
      // this is the one request whose whole payload IS the credential.
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) as AbortSignal,
    })
    if (!res.ok) return verdictFor(res.status)
    const body = await res.json() as { username?: unknown } | null
    // A 200 with no username is still an accepted key — the card falls back to
    // an empty name rather than calling a live credential rejected.
    return { ok: true, username: typeof body?.username === 'string' ? body.username : '' }
  } catch {
    return unverified()
  }
}

// ─── ONE polite retry on a 5xx ───────────────────────────────────────────────
//
// Driver-measured: ~8 intermittent 503s in a 35-minute live session, each one
// surfacing as a DEAD search — the grid emptied and the only recovery was to
// retype the query. Civitai's edge sheds load; a single retry a couple of
// seconds later succeeded every time it was tried by hand.
//
// STRICTLY ONE RETRY, AND ONLY ON 5xx:
//  • 4xx is our fault or theirs-permanently (400 bad param, 401 bad key, 404,
//    429 rate limit). Re-asking cannot change the answer and a 429 in
//    particular is the one status where retrying is actively harmful.
//  • one attempt, not a loop: N clients backing off in lockstep against a
//    struggling edge is how a brownout becomes an outage. The user has a
//    Try-again button for the second opinion — that is a human-paced retry.

/** Statuses worth exactly one more attempt. */
export function isCivitaiRetryableStatus(status: number): boolean {
  return status >= 500 && status <= 599
}

/** Delay before the single retry. Long enough for an edge to shed, short
 *  enough that the tab still feels like it is searching. */
export const CIVITAI_RETRY_DELAY_MS = 2_000

/**
 * GET with one retry on 5xx. Network/timeout failures are NOT retried here —
 * `AbortSignal.timeout` already bounds them and the caller surfaces them
 * honestly; this is about the specific, measured, transient-5xx shape.
 */
async function civitaiFetchWithRetry(url: string): Promise<Response> {
  const once = (): Promise<Response> => fetch(url, {
    headers: { Accept: 'application/json', ...civitaiAuthHeaders() },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) as AbortSignal,
  })
  const first = await once()
  if (!isCivitaiRetryableStatus(first.status)) return first
  await new Promise(r => setTimeout(r, CIVITAI_RETRY_DELAY_MS))
  return once()
}

/**
 * The search URL for a resolved mode.
 *
 * `adult` is a SECOND ARGUMENT, not a field on the query, and that is the
 * point: the query object is renderer-shaped data, while this flag is only ever
 * the return value of resolveCivitaiAdult(). It defaults to false, so every
 * call site that has not thought about the mode builds an SFW url.
 *
 * VALIDATION IS DROP, NOT FORWARD. A single unknown `types` value 400s the
 * WHOLE request — the user typed nothing wrong, they just have a stale filter
 * chip, and the honest answer to that is "the filter you can actually use",
 * never an empty grid with a 400 behind it. Same for sort and period, which are
 * closed enums on this endpoint (`Hour` 400s; `LyCORIS` 400s).
 */
export function buildCivitaiSearchUrl(q: CivitaiSearchQuery, adult = false): string {
  const p = new URLSearchParams()
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(q.limit ?? DEFAULT_LIMIT)))
  p.set('limit', String(limit))
  // ALWAYS SET EXPLICITLY — omitting it is not neutral, it is nsfw=false
  // (measured; see nsfwParamFor). In SFW mode it also keeps the response's
  // preview images clamped to PG, which is what makes thumbnail fetching safe
  // at all. In adult mode it WIDENS the listing; the bitmask ceiling in the
  // gate, not this flag, is what filters.
  p.set('nsfw', nsfwParamFor(adult))
  const query = (q.query ?? '').trim()
  if (query) p.set('query', query)
  // All 22 live ModelType values are accepted; anything else is dropped.
  for (const t of q.types ?? []) if (isCivitaiModelType(t)) p.append('types', t)
  // REPEATABLE param — server-side run-truth filtering for free. (Caveat: it
  // matches a model if ANY of its versions matches, so the client-side family
  // check still runs per version.) Not enum-validated: ActiveBaseModel is a
  // 66-entry list that drifts, an unknown value here returns an empty page
  // rather than a 400, and hard-coding it would silently hide new architectures
  // the day Civitai ships them.
  for (const b of q.baseModels ?? []) if (typeof b === 'string' && b.trim()) p.append('baseModels', b)
  // Cursor pagination ONLY. `page` 429s past 1000 rows and 400s with `query`.
  if (q.cursor) {
    p.set('cursor', q.cursor)
    // sort/period are DELIBERATELY dropped on a cursor page: the cursor encodes
    // the ordering it was minted under, and changing either mid-walk re-anchors
    // the window and duplicates rows.
  } else {
    p.set('sort', isCivitaiSort(q.sort) ? q.sort : 'Most Downloaded')
    if (isCivitaiPeriod(q.period)) p.set('period', q.period)
  }
  return `${civitaiApiBase(adult)}/models?${p.toString()}`
}

/**
 * One page of search results, gated and mapped.
 *
 * Throws on network/HTTP failure so the IPC layer can surface a typed failure
 * (hf-search's contract). PRIVATE MODE denial also throws, from the very first
 * line — before the URL is even built.
 */
export async function searchCivitai(q: CivitaiSearchQuery = {}): Promise<CivitaiSearchResult> {
  enforceProviderEgress(CIVITAI_KEY_ID)

  // ONE resolution, used for the host, the nsfw flag, the gate ceiling and the
  // preview rule — so those four can never disagree about which mode this
  // request is in.
  const adult = resolveCivitaiAdult(q)

  const url = buildCivitaiSearchUrl(q, adult)
  const res = await civitaiFetchWithRetry(url)
  if (!res.ok) throw new Error(`Civitai search returned ${res.status}`)
  const page = await res.json() as RawCivitaiPage

  const { rows, filteredCount } = mapCivitaiPageCounted(page, {
    adult,
    installedFamilies: q.installedFamilies,
  })

  if (q.thumbnails !== false) {
    // One preview per SURVIVING row, resolved in parallel. Failures are null.
    const byVersion = new Map<number, RawVersion>()
    for (const m of page.items ?? []) {
      for (const v of m?.modelVersions ?? []) {
        const id = num(v?.id, -1)
        if (id >= 0) byVersion.set(id, v)
      }
    }
    await Promise.all(rows.map(async row => {
      const preview = pickPreviewImage(byVersion.get(row.versionId), adult)
      if (!preview) return
      const data = await fetchCivitaiThumbnail(preview.url)
      if (!data) return
      row.thumbnail = data
      // The level travels WITH the picture, set only once the bytes actually
      // arrived. This is the whole blur contract for the catalog card.
      row.thumbnailNsfwLevel = preview.level
    }))
  }

  const rawCursor = page.metadata?.nextCursor
  const nextCursor = typeof rawCursor === 'string' && rawCursor.length > 0
    ? rawCursor
    : typeof rawCursor === 'number' ? String(rawCursor) : null

  return { rows, nextCursor, filteredCount, adult }
}

/**
 * Re-read ONE model straight from the API and return its gated rows.
 *
 * This is what makes `civitai:install` trustworthy: the row the renderer sends
 * is a hint (which model, which version), never the source of truth for the
 * download url, the hash, the size or the verdict. Everything that decides
 * whether bytes get written to disk is re-derived here from the server's own
 * answer.
 */
export async function fetchCivitaiModelRows(
  modelId: number,
  opts: {
    adultMode?: boolean
    adultAcceptedAt?: number
    installedFamilies?: InstalledFamilies
  } = {},
): Promise<CivitaiSearchRow[]> {
  enforceProviderEgress(CIVITAI_KEY_ID)
  // THE SAME resolution the browse used. It has to be: an adult row was found
  // on .red under the 31 ceiling, so re-reading it on .com under the SFW
  // ceiling would return nothing and the install would fail as "no longer
  // available" — a lie about the model instead of the truth about the mode.
  // And it has to be RE-RESOLVED rather than carried in the payload, so
  // removing the key between browsing and clicking install really does refuse.
  const adult = resolveCivitaiAdult(opts)
  // Same single 5xx retry as search: this runs on the install click, where a
  // transient 503 costs the user their download rather than their grid.
  const res = await civitaiFetchWithRetry(
    `${civitaiApiBase(adult)}/models/${encodeURIComponent(String(modelId))}`,
  )
  if (!res.ok) throw new Error(`Civitai model lookup returned ${res.status}`)
  const model = await res.json() as RawModel
  // allVersions: TRUE here. The browse list collapses to one card per model,
  // but the install lookup is BY VERSION ID — collapsing here would make every
  // version except the newest un-installable, and the failure would read as
  // "no longer available" rather than as the bug it is.
  return mapCivitaiPage({ items: [model] }, {
    allVersions: true,
    adult,
    installedFamilies: opts.installedFamilies,
  })
}

// ─── THE DETAIL VIEW ─────────────────────────────────────────────────────────
//
// "this things in catalog aren't really useful, user should be able to open and
// read what about that checkpoint or lora" — the grid card shows a thumbnail,
// chips and Install, and NOWHERE says what the model IS. This is the read.
//
// ─── WHY A BY-ID FETCH, GIVEN THE LIST IS NOT TRUNCATED ──────────────────────
// MEASURED against the live API on 2026-07-31, six top models, list vs by-id:
//
//   model.description            byte-IDENTICAL 6/6 (3 528 – 10 809 bytes)
//   modelVersions[].description  byte-IDENTICAL wherever present
//   creator / stats / files      present and identical in the LIST
//   images                       list = the level-1 subset, exactly
//                                (byid level-1 count == list count, 3/3 checked)
//
// So this fetch buys NO field the list did not already carry. It is a TRANSPORT
// decision, and these are the numbers behind it:
//   • one `limit=24` page is 1.51 MB of JSON carrying 334 versions and 2 563
//     images; the descriptions alone are 105 KB (model) + 83 KB (version).
//     Threading all of that onto every row would inflate a search — already
//     carrying 24 base64 thumbnails — by ~190 KB of prose per page for text a
//     user reads on at most one or two rows.
//   • the row the renderer holds ALREADY answers name / type / base model /
//     size / format / sha / trigger words / licence / verdict / thumbnail. The
//     panel opens on those instantly and refetches none of them. Only the three
//     things a row cannot hold — the description, the creator, and the sibling
//     versions — arrive here.
//   • it reuses the endpoint and the discipline `civitai:install` already has
//     (fetchCivitaiModelRows, same url, same gate, same re-resolution of the
//     mode), so there is no new network shape and no cache lifetime to get wrong.
//
// AND ONE THING THE FETCH MAKES WORSE, WHICH IS WHY pickPreviewImages EXISTS:
// the by-id endpoint IGNORES `nsfw`. The list pre-clamps images to PG; by-id
// serves the raw set — measured levels [2,1,1,1,4,…,8] on a model whose list
// entry carried only level-1 images, in SFW mode, with no key. The gallery
// therefore gates its own images through civitai-gate.ts rather than trusting a
// request parameter that this endpoint does not read.

/** One gated preview, as a data: URI. Never a remote url — same reason as the
 *  grid thumbnail: the prod CSP has no https: in img-src. */
export interface CivitaiDetailPreview {
  /** `data:image/…;base64,…` */
  dataUri: string
  /** the source image's own nsfwLevel, so the panel can blur without guessing */
  level: number
}

export interface CivitaiDetailVersion {
  /** `civitai-<versionId>` — THE SAME id the grid row carries, so the panel can
   *  ask `isInstalled('sdcpp', id)` and offer RUN on a version already on disk. */
  id: string
  versionId: number
  name: string
  baseModel: string
  family: CivitaiFamily | null
  /** HTML, VERBATIM from the API. Parsed in the renderer, never innerHTML'd. */
  description: string | null
  /** the API's own ISO string, unformatted — locale formatting is the UI's job */
  publishedAt: string | null
  trainedWords: string[]
  /** ceil(sizeKB / 1024) of the primary file */
  sizeMb: number
  format: string
  fileName: string
  nsfwLevel: number
  /** this version's page on the host the detail was served from */
  pageUrl: string | null
  /** filled by fetchCivitaiModelDetail; EMPTY from the pure mapper */
  previews: CivitaiDetailPreview[]
  /** main's own verdict — the panel renders it, it never recomputes it */
  installable: boolean
  reason?: string
  reasonCode?: CivitaiReasonCode
}

export interface CivitaiModelDetail {
  modelId: number
  /** the MODEL name alone — not the row's `<model> - <version>` join */
  name: string
  type: string
  /** HTML, VERBATIM. `null` when the uploader wrote none. */
  description: string | null
  /**
   * The uploader. USERNAME ONLY, deliberately: `creator.image` is a remote
   * image.civitai.com avatar, and rendering it would mean another main-side
   * fetch + base64 for a 96px decoration the panel does not need.
   */
  creator: { username: string } | null
  downloads: number
  likes: number
  license: { commercial: string[]; noCredit: boolean; derivatives: boolean }
  /** the model page on the host this detail was served from */
  pageUrl: string | null
  /** gated, capped, requested version first */
  versions: CivitaiDetailVersion[]
  /** versions the GATE refused. The panel says this out loud, exactly as the
   *  grid says `filteredCount` — an empty version list with no explanation
   *  reads as a broken panel rather than as a working filter. */
  filteredVersionCount: number
  /** how many versions the model really has, so a capped list can say so */
  versionsTotal: number
  /** the mode this detail was ACTUALLY served in (resolved in main) */
  adult: boolean
}

/**
 * Versions carried per detail. A model can publish 31 (measured: DreamShaper),
 * and every extra one costs its own description on the wire for a row the reader
 * scrolled past. Eight covers "which version should I take" with the honest
 * total printed next to it.
 */
export const CIVITAI_DETAIL_MAX_VERSIONS = 8

/**
 * Preview images per detail. Four, for ONE version — the one the card that was
 * clicked resolved to. Per-version galleries would multiply this by
 * CIVITAI_DETAIL_MAX_VERSIONS thumbnail fetches on a single panel open, against
 * a CDN we do not control, for images nobody asked to see.
 */
export const CIVITAI_DETAIL_MAX_PREVIEWS = 4

/**
 * The model's page on civitai.com / civitai.red.
 *
 * BUILT IN MAIN, and that is the point: `adult` here is the RESOLVED mode, so
 * the host follows the same "the host is the gate" rule the rest of this file
 * does and the renderer never picks between the two domains. Returns null for a
 * nonsense id rather than a url to `/models/NaN`.
 */
export function civitaiModelPageUrl(
  modelId: number,
  adult: boolean,
  versionId?: number,
): string | null {
  if (!Number.isInteger(modelId) || modelId < 0) return null
  const host = adult ? CIVITAI_HOST_ADULT : CIVITAI_HOST_SFW
  const base = `${host}/models/${modelId}`
  if (versionId === undefined) return base
  if (!Number.isInteger(versionId) || versionId < 0) return base
  return `${base}?modelVersionId=${versionId}`
}

export interface CivitaiDetailMapOptions {
  /** RESOLVED mode — always resolveCivitaiAdult()'s answer, never a setting. */
  adult?: boolean
  /** Families with an installed base checkpoint (the adapter verdict). */
  installedFamilies?: InstalledFamilies
  /** The version the CARD resolved to. Sorted first so the gallery and the
   *  highlighted version match what the user clicked. */
  versionId?: number
}

/**
 * Map one raw by-id model onto the detail payload. PURE — no network, no
 * thumbnails (`previews` is empty; the caller fills it from `previewPicks`).
 *
 * EVERY VERSION GOES THROUGH civitaiRowAllowed(), the same composed gate the
 * grid uses: layer 0 unconditionally, then the layer-1 ceiling for the resolved
 * mode. A model the SFW ceiling excludes therefore yields ZERO versions here —
 * measured on the 4201 fixture, whose model level is 15 — and the panel says
 * how many were hidden instead of rendering an unexplained blank.
 */
export function mapCivitaiModelDetail(
  model: RawModel | null | undefined,
  opts: CivitaiDetailMapOptions = {},
): { detail: CivitaiModelDetail; previewPicks: Map<number, CivitaiPreviewPick[]> } {
  const adult = opts.adult === true
  const mode = { adult }
  const verdictCtx = { installedFamilies: opts.installedFamilies }
  const modelId = num(model?.id, -1)
  const rawVersions = Array.isArray(model?.modelVersions) ? model!.modelVersions! : []

  const versions: CivitaiDetailVersion[] = []
  const previewPicks = new Map<number, CivitaiPreviewPick[]>()
  /** Versions the gate actually judged, and how many it refused. */
  let judged = 0
  let refused = 0
  /** Keyed by versionId so the requested version can take its previews later. */
  const rawById = new Map<number, RawVersion>()

  for (const version of rawVersions) {
    const versionId = num(version?.id, -1)
    if (versionId < 0) continue
    judged++
    if (!civitaiRowAllowed(model, version, mode)) { refused++; continue }
    rawById.set(versionId, version)

    const file = pickPrimaryFile(version.files)
    const meta = (file?.metadata ?? null) as { format?: unknown; fp?: unknown } | null
    const hashes = (file?.hashes ?? null) as Record<string, unknown> | null
    const rawSha = hashes?.SHA256
    const sha256 = typeof rawSha === 'string' && rawSha.length > 0 ? rawSha.toLowerCase() : null

    const baseModel = str(version.baseModel)
    const family = familyForBaseModel(baseModel)
    const type = str(model?.type)
    const format = str(meta?.format, 'Unknown')
    const downloadUrl = str(file?.downloadUrl) || str(version.downloadUrl)
    const sizeKB = num(file?.sizeKB, 0)

    // THE SAME verdict function the grid row got. Not a second opinion: main
    // re-fetches and re-gates on install anyway, and a panel that disagreed with
    // the card it opened from would be the worse kind of bug — one the user can
    // see but not explain.
    const verdict = civitaiInstallVerdict(
      { type, family, baseModel, format, sha256, downloadUrl },
      verdictCtx,
    )

    versions.push({
      id: civitaiRowId(versionId),
      versionId,
      name: str(version.name, 'v?'),
      baseModel,
      family,
      description: typeof version.description === 'string' && version.description.trim() !== ''
        ? version.description
        : null,
      publishedAt: typeof version.publishedAt === 'string' && version.publishedAt !== ''
        ? version.publishedAt
        : null,
      trainedWords: normalizeTrainedWords(version.trainedWords),
      sizeMb: sizeKB > 0 ? Math.ceil(sizeKB / 1024) : 0,
      format,
      fileName: str(file?.name),
      nsfwLevel: num(version?.nsfwLevel, 0),
      pageUrl: civitaiModelPageUrl(modelId, adult, versionId),
      previews: [],
      ...verdict,
    })
  }

  // THE REQUESTED VERSION FIRST, the rest in API order (which is newest-first).
  // A stable partition, not a sort: the API's ordering is a real signal and
  // re-ranking it by anything of ours would quietly disagree with civitai.com.
  const wanted = opts.versionId
  if (typeof wanted === 'number') {
    const at = versions.findIndex(v => v.versionId === wanted)
    if (at > 0) versions.unshift(...versions.splice(at, 1))
  }

  const versionsTotal = judged
  const capped = versions.slice(0, CIVITAI_DETAIL_MAX_VERSIONS)

  // Previews for the LEAD version only — see CIVITAI_DETAIL_MAX_PREVIEWS.
  const lead = capped[0]
  if (lead) {
    const picks = pickPreviewImages(rawById.get(lead.versionId), adult, CIVITAI_DETAIL_MAX_PREVIEWS)
    if (picks.length > 0) previewPicks.set(lead.versionId, picks)
  }

  const rawCreator = model?.creator ?? null
  const username = str(rawCreator?.username).trim()

  const detail: CivitaiModelDetail = {
    modelId: modelId < 0 ? -1 : modelId,
    name: str(model?.name, 'Untitled'),
    type: str(model?.type),
    description: typeof model?.description === 'string' && model.description.trim() !== ''
      ? model.description
      : null,
    creator: username !== '' ? { username } : null,
    downloads: num(model?.stats?.downloadCount, 0),
    likes: num(model?.stats?.thumbsUpCount, 0),
    license: {
      commercial: parseCommercialUse(model?.allowCommercialUse),
      noCredit: model?.allowNoCredit === true,
      derivatives: model?.allowDerivatives === true,
    },
    pageUrl: civitaiModelPageUrl(modelId, adult),
    versions: capped,
    // Counts VERSIONS, unlike the grid's model-level filteredCount — this panel
    // is one model, so versions are the only unit a reader can reconcile.
    filteredVersionCount: refused,
    versionsTotal,
    adult,
  }
  return { detail, previewPicks }
}

/**
 * Read ONE model's detail from the API, gated, with its preview images resolved
 * to data: URIs.
 *
 * Throws on network/HTTP failure so the IPC layer can surface it inline, exactly
 * like searchCivitai. PRIVATE MODE denial throws from the first line.
 *
 * The mode is RE-RESOLVED here rather than carried from the browse, for the same
 * reason fetchCivitaiModelRows re-resolves it: deleting the Civitai key between
 * opening the grid and clicking a card must really return the panel to the SFW
 * ceiling, with no cached verdict to go stale.
 */
export async function fetchCivitaiModelDetail(
  modelId: number,
  opts: {
    adultMode?: boolean
    adultAcceptedAt?: number
    installedFamilies?: InstalledFamilies
    versionId?: number
    /** The tests turn previews off; the panel never does. */
    previews?: boolean
  } = {},
): Promise<CivitaiModelDetail> {
  enforceProviderEgress(CIVITAI_KEY_ID)
  const adult = resolveCivitaiAdult(opts)
  // Same single 5xx retry as search and as the install lookup: this runs on a
  // click, where a transient 503 costs the user the thing they asked to read.
  const res = await civitaiFetchWithRetry(
    `${civitaiApiBase(adult)}/models/${encodeURIComponent(String(modelId))}`,
  )
  if (!res.ok) throw new Error(`Civitai model lookup returned ${res.status}`)
  const model = await res.json() as RawModel

  const { detail, previewPicks } = mapCivitaiModelDetail(model, {
    adult,
    installedFamilies: opts.installedFamilies,
    versionId: opts.versionId,
  })

  if (opts.previews !== false) {
    // fetchCivitaiThumbnail carries the whole safety envelope already: host
    // containment to image.civitai.com, the CDN's own /original=true/ → /width=N/
    // transform (an original preview measured 839 KB – 2.71 MB and would blow
    // the cap every time), the byte cap, the memory-only LRU, and a second
    // enforceProviderEgress. The lead version's first pick is usually the card's
    // own thumbnail, so it is normally a cache hit and costs nothing.
    await Promise.all([...previewPicks.entries()].map(async ([versionId, picks]) => {
      const version = detail.versions.find(v => v.versionId === versionId)
      if (!version) return
      const resolved = await Promise.all(picks.map(async pick => {
        const dataUri = await fetchCivitaiThumbnail(pick.url)
        return dataUri ? { dataUri, level: pick.level } : null
      }))
      // A failed fetch contributes NOTHING rather than a broken tile — and the
      // level travels with the picture, set only once the bytes arrived, so the
      // panel never advertises a rating for an image nobody has.
      version.previews = resolved.filter((p): p is CivitaiDetailPreview => p !== null)
    }))
  }

  return detail
}

// ─── download auth probe ─────────────────────────────────────────────────────

/**
 * The four verdicts — AND NOTHING ELSE. `version` is an OPTIONAL FIELD ON EACH
 * OF THEM, deliberately NOT a fifth `kind`.
 *
 * WHY THAT IS A SAFETY PROPERTY, not a style choice: the install path
 * (civitai.ipc.ts) special-cases `needs-key` and `key-rejected` and otherwise
 * FALLS THROUGH TO THE DOWNLOAD. A new `kind` would therefore be fail-OPEN in
 * every caller that has not been taught about it — bytes on disk for a verdict
 * nobody read. An extra optional field cannot do that: a caller that ignores it
 * behaves exactly as it did before.
 *
 * `version` is the `/model-versions/mini/:id` record the pre-flight ALREADY
 * fetched for `requireAuth` (see below), handed on so the install path can read
 * the version-level `minor` flag at ZERO extra requests. It is present only when
 * the pre-flight answered — absent on every blind-probe path, and absent means
 * UNKNOWN, never `false`.
 */
export type CivitaiAuthProbe =
  | { kind: 'open'; version?: CivitaiVersionMini }
  | { kind: 'authed'; headers: Record<string, string>; version?: CivitaiVersionMini }
  | { kind: 'needs-key'; version?: CivitaiVersionMini }
  | { kind: 'key-rejected'; version?: CivitaiVersionMini }

// ─── THE DOCUMENTED PRE-FLIGHT: /model-versions/mini/:id ─────────────────────
//
// `GET /api/v1/model-versions/mini/:id` carries `requireAuth`: "When `true`, the
// `downloadUrls` require a token (passed as `Authorization: Bearer` or
// `?token=`)" — <https://developer.civitai.com/site/reference/model-versions.md>.
//
// It is the ONLY documented predictor of a gated download, and it needs its own
// request because the field is ABSENT from the full `/model-versions/:id`
// response and from the `modelVersions[]` embedded in a `/models` search page
// (both verified — the browse fixture's version keys are availability, baseModel,
// baseModelType, downloadUrl, files, id, images, index, name, nsfwLevel,
// trainedWords, and nothing else).
//
// LIVE-MATCHED 3/3 on 2026-07-31, anonymous probes
// (notes/CIVITAI-AUTH-RESEARCH-2026-08-01.md §5):
//     mini/1833157  requireAuth=true   → the download first-hops 401
//     mini/9208     requireAuth=false  → 307
//     mini/290640   requireAuth=false  → 307

/** The two hosts a Civitai download url may legally name. THE HOST IS THE MODE
 *  (see the header of this file): the API hands `.red` urls back verbatim on the
 *  adult host, so both are real and neither is normalised away. Anything else is
 *  not a Civitai download url as far as the pre-flight is concerned. */
const CIVITAI_DOWNLOAD_HOSTS: readonly string[] = ['civitai.com', 'civitai.red']

/**
 * The version id inside a Civitai download url, with the origin that named it.
 *
 * SHAPE VERIFIED AGAINST THIS REPO, not assumed: download urls reach us VERBATIM
 * from the API (`files[].downloadUrl`, falling back to `version.downloadUrl` —
 * mapCivitaiPageCounted), every captured fixture is
 * `https://civitai.com/api/download/models/<versionId>` with an optional
 * `?type=&format=&size=&fp=` query, and sd-cpp-models.ts documents the same
 * shape ("no extension anywhere in the path").
 *
 * THE ORIGIN TRAVELS WITH THE ID on purpose. The pre-flight has to be asked on
 * the SAME host the row came from, or an adult-mode install would quietly send a
 * civitai.com request for a civitai.red row — breaking the one-switch
 * host-is-the-mode rule this file is built on. `.red` is therefore ACCEPTED, not
 * rejected: both hosts served the same version ids identically in the live
 * probes (§5), and refusing `.red` would silently disable the pre-flight for
 * every unlocked row.
 *
 * NULL for anything that does not match exactly — another host, http, a port, an
 * extra path segment, junk. Null means UNKNOWN, and unknown costs nothing but
 * the pre-flight itself (probeCivitaiDownloadAuth falls back to its blind probe).
 */
export function civitaiVersionFromDownloadUrl(
  downloadUrl: unknown,
): { versionId: number; origin: string } | null {
  if (typeof downloadUrl !== 'string' || downloadUrl.length === 0) return null
  let u: URL
  try {
    u = new URL(downloadUrl)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (u.port !== '') return null
  const host = u.hostname.toLowerCase()
  if (!CIVITAI_DOWNLOAD_HOSTS.includes(host)) return null
  const m = /^\/api\/download\/models\/(\d+)$/.exec(u.pathname)
  if (!m) return null
  const versionId = Number(m[1])
  if (!Number.isSafeInteger(versionId) || versionId <= 0) return null
  return { versionId, origin: `https://${host}` }
}

/** The documented fields we read off `/model-versions/mini/:id`. A `null` on a
 *  field means the response did not carry it — never a guess. */
export interface CivitaiVersionMini {
  versionId: number
  /** "When `true`, the `downloadUrls` require a token." The whole point. */
  requireAuth: boolean
  /**
   * VERSION-level content flags — the same two names layer 0 reads at MODEL
   * level (civitai-gate.ts).
   *
   * `minor` is a creator-declared kill switch and layer 0 honours it at either
   * level. `sfwOnly` is carried FOR THE RECORD ONLY and is deliberately wired to
   * nothing: it is a usage restriction on the resource ("may only be used for
   * SFW generation"), not a statement that the resource is adult, so `true`
   * would block SFW content and `false` would be evidence of nothing. Reading it
   * as an adult signal either way would be an invention.
   */
  sfwOnly: boolean | null
  minor: boolean | null
}

/**
 * The mini record for ONE version id, or null for UNKNOWN.
 *
 * UNKNOWN IS THE ONLY FAILURE MODE, and it is deliberate: a non-2xx, malformed
 * JSON, a missing `requireAuth`, a bad id, an unexpected origin, a timeout and a
 * dead network all return null, and null degrades to exactly today's behaviour
 * in probeCivitaiDownloadAuth. It must never degrade to a GUESS — reading an
 * absent `requireAuth` as `false` would turn one bad deploy into "no model needs
 * a key", which is a lie about auth rather than a missing optimisation.
 *
 * Retry and timeout policy is civitaiFetchWithRetry's — ONE more attempt, 5xx
 * only, bounded by SEARCH_TIMEOUT_MS — the same one search, the install re-read
 * and the detail panel use. Deliberately not a second policy.
 */
export async function fetchCivitaiVersionMini(
  versionId: number,
  origin: string = CIVITAI_HOST_SFW,
): Promise<CivitaiVersionMini | null> {
  enforceProviderEgress(CIVITAI_KEY_ID)
  if (!Number.isSafeInteger(versionId) || versionId <= 0) return null
  // No third host, ever — this is a url we build, so it is an allowlist.
  if (origin !== CIVITAI_HOST_SFW && origin !== CIVITAI_HOST_ADULT) return null
  try {
    const res = await civitaiFetchWithRetry(`${origin}/api/v1/model-versions/mini/${versionId}`)
    if (!res.ok) return null
    const body = await res.json() as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return null
    if (typeof body.requireAuth !== 'boolean') return null
    return {
      versionId,
      requireAuth: body.requireAuth,
      sfwOnly: typeof body.sfwOnly === 'boolean' ? body.sfwOnly : null,
      minor: typeof body.minor === 'boolean' ? body.minor : null,
    }
  } catch {
    return null
  }
}

/**
 * Does this download need the user's credential?
 *
 * ORDER OF OPERATIONS — the documented pre-flight FIRST, the blind probe only as
 * a fallback:
 *
 *   1. Ask `/api/v1/model-versions/mini/:id` for `requireAuth`
 *      (fetchCivitaiVersionMini above;
 *      <https://developer.civitai.com/site/reference/model-versions.md>;
 *      live-matched 3/3 on 2026-07-31).
 *        • false ⇒ `open` immediately, with ZERO requests to the download host.
 *          That is the common case and the point of the change: 6 of 7 measured
 *          public files, including a 6.78 GB checkpoint, download with no
 *          credential at all.
 *        • true + no key in the keychain ⇒ `needs-key` immediately, again
 *          without touching the download host.
 *        • true + a key ⇒ ONE authed probe. The key is still VERIFIED rather
 *          than assumed, because a stored key can be stale and `key-rejected`
 *          has to stay detectable — but the anonymous probe that used to come
 *          first is now skipped, since `requireAuth` already answered it.
 *      Whichever of the three it is, the mini record is ATTACHED to the verdict
 *      as `version`, so the install path can read the version-level `minor`
 *      flag without a second request (see CivitaiAuthProbe above).
 *   2. UNKNOWN pre-flight (unparseable url, non-2xx, malformed JSON, missing
 *      field, network failure) ⇒ the original blind probe below, UNCHANGED —
 *      and with NO `version` on the verdict, because nothing was learned.
 *      `requireAuth` appears on no other endpoint we call, so there is no second
 *      source to consult and inventing an answer would be a lie about auth.
 *
 * THE BLIND FALLBACK, AND WHY IT IS STILL HERE — TRY UNAUTHENTICATED FIRST: the
 * overwhelming majority of Civitai models download anonymously (live probes
 * returned 307 with no auth even for nsfwLevel-60 models). Only on a 401/403 do
 * we reach for the key, and only once.
 *
 * A one-byte Range request is enough: the interesting status is on the FIRST
 * hop (`redirect: 'manual'`), before the presigned CDN url. That matters twice
 * over, because the presigned url signs `X-Amz-SignedHeaders=host` only —
 * forwarding `Authorization` across that hop is a 400 InvalidRequest, not a
 * harmless extra header (landmine R1). The header this function returns is for
 * the FIRST hop only; dropping it cross-origin is the downloader's job.
 *
 * Never uses `?token=` — the docs call it leaky, and downloads.json persists
 * spec.url in PLAINTEXT while the keychain copy is DPAPI-encrypted.
 */
export async function probeCivitaiDownloadAuth(downloadUrl: string): Promise<CivitaiAuthProbe> {
  enforceProviderEgress(CIVITAI_KEY_ID)
  const probe = async (headers: Record<string, string>): Promise<number> => {
    const res = await fetch(downloadUrl, {
      method: 'GET',
      headers: { Range: 'bytes=0-0', ...headers },
      redirect: 'manual',
      signal: AbortSignal.timeout(THUMB_TIMEOUT_MS) as AbortSignal,
    })
    // Drain nothing — a manual redirect has no body worth reading.
    return res.status
  }

  /** The authed half, shared by both paths. An `authed` verdict is EARNED by a
   *  request that came back non-401/403 — never assumed from the key existing,
   *  which is what keeps `key-rejected` a real verdict. */
  const verifyWithKey = async (): Promise<CivitaiAuthProbe> => {
    const auth = civitaiAuthHeaders()
    if (!auth.Authorization) return { kind: 'needs-key' }
    try {
      const authedStatus = await probe(auth)
      if (authedStatus === 401 || authedStatus === 403) return { kind: 'key-rejected' }
      return { kind: 'authed', headers: auth }
    } catch {
      return { kind: 'authed', headers: auth }
    }
  }

  /** Hand the already-fetched record on with the verdict, WITHOUT touching the
   *  verdict. Written out per kind rather than as a spread so that adding a
   *  field to one variant can never silently drop `headers` from another. */
  const withVersion = (p: CivitaiAuthProbe, version: CivitaiVersionMini): CivitaiAuthProbe => {
    switch (p.kind) {
      case 'authed':       return { kind: 'authed', headers: p.headers, version }
      case 'needs-key':    return { kind: 'needs-key', version }
      case 'key-rejected': return { kind: 'key-rejected', version }
      case 'open':         return { kind: 'open', version }
    }
  }

  // 1. THE DOCUMENTED PRE-FLIGHT. Not wrapped in a try: fetchCivitaiVersionMini
  //    already answers UNKNOWN for every network and parse failure, and its one
  //    remaining throw is the PRIVATE MODE denial, which must propagate.
  const parsed = civitaiVersionFromDownloadUrl(downloadUrl)
  const mini = parsed ? await fetchCivitaiVersionMini(parsed.versionId, parsed.origin) : null
  if (mini) {
    // The record rides along on the verdict — the install path reads its
    // version-level `minor` (civitai.ipc.ts), which costs no request because
    // this one already happened for `requireAuth`. It is attached HERE ONLY:
    // the blind fallback below never learns these fields, so an absent
    // `version` on a verdict means the pre-flight did not answer.
    const verdict: CivitaiAuthProbe = mini.requireAuth ? await verifyWithKey() : { kind: 'open' }
    return withVersion(verdict, mini)
  }

  // 2. UNKNOWN ⇒ the blind probe, exactly as it was before the pre-flight.
  let status: number
  try {
    status = await probe({})
  } catch {
    // A probe that cannot complete must not block the install: the download
    // manager will surface the real failure with its own retries.
    return { kind: 'open' }
  }
  if (status !== 401 && status !== 403) return { kind: 'open' }

  return verifyWithKey()
}
