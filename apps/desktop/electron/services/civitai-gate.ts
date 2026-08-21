// apps/desktop/electron/services/civitai-gate.ts
//
// THE CIVITAI CONTENT GATE — pure predicates, no I/O, no settings, no clock.
//
// Everything in this file is a function of its arguments alone. That is the
// whole point: LAYER 0 takes no configuration parameter, so there is no flag,
// no preference, no unlock and no future 18+ mode that can route around it.
// A unit test walks the cartesian product of every boolean the API exposes and
// asserts nothing gets past it (civitaiGate.test.ts).
//
// ─── WHY A CLIENT-SIDE LEVEL PASS IS MANDATORY ───────────────────────────────
// `nsfwLevel` is a BITMASK SET, not an ordinal:
//     PG=1  PG13=2  R=4  X=8  XXX=16  Blocked=32
// Test it with `&`, NEVER with `>=` (a model at level 24 = X|XXX is not
// "greater than" R in any meaningful sense — it simply does not carry R).
//
// The request-side `nsfw=false` filter is NOT sufficient. It filters the
// creator's coarse boolean toggle only. MEASURED against the live API on
// 2026-07-28 (GET /api/v1/models?limit=100&nsfw=false&sort=Most Downloaded):
//
//     80 of the 100 rows returned by the "SFW" request carried R/X/XXX bits
//     by bitmask (model.nsfwLevel & ~3 !== 0).
//
// (The 2026-07-27 research pass measured 58/100 on a different sort; the leak
// is not a fluke and it is not shrinking.) So: request nsfw=false AND run
// sfwOnly() over BOTH the model level and the version level, AND run layer 0.
// Three fences, and the outermost one is unconditional.
//
// ─── WHAT LAYER 0 IS FOR ─────────────────────────────────────────────────────
// poi / minor / mode:'TakenDown' were 0/500 positive in live listings — removed
// content simply is not served by the browse endpoint. So `true` is a
// kill-switch we honour, but `false` is NOT evidence of safety. The bitmask and
// the token denylist do the real work; the flags are the cheap belt.
//
// ─── THE THREE LAYERS ────────────────────────────────────────────────────────
//   LAYER 0  layer0Excluded()   — UNCONDITIONAL. No mode parameter exists.
//   LAYER 1  layer1SfwPass()    — default. Ceiling 3  (PG|PG13).
//   LAYER 2  layer2AdultPass()  — 18+ unlocked. Ceiling 31 (…|R|X|XXX). NOT 60.
// civitaiRowAllowed() composes them, and it runs layer 0 first on every path.
// The unlock itself is civitaiAdultUnlocked() below: three facts, all required.

/** nsfwLevel bit values (a SET, not an ordinal). */
export const NSFW_BIT = {
  PG: 1,
  PG13: 2,
  R: 4,
  X: 8,
  XXX: 16,
  BLOCKED: 32,
} as const

/** Everything that is NOT PG or PG13. `~3` = every bit above PG13, incl. Blocked. */
const ADULT_BITS = ~(NSFW_BIT.PG | NSFW_BIT.PG13)

/**
 * THE ADULT CEILING — 31 = PG|PG13|R|X|XXX. NEVER 60.
 *
 * 60 is the sentinel the API stamps on `nsfw: true` models, and it is
 * `R|X|XXX|Blocked` — it CARRIES THE BLOCKED BIT. Capping at 60 (or at "any
 * level") would therefore admit Blocked content through the front door of the
 * very mode that is supposed to be the careful one. 31 is the largest level
 * that carries no bit above XXX.
 *
 * MEASURED 2026-07-28 against the live .red host with `nsfw=true`
 * (GET civitai.red/api/v1/models?limit=20&nsfw=true&sort=Most Downloaded):
 *   model levels  → {1:1, 3:1, 7:2, 15:5, 23:1, 31:7, 60:3}
 *   image levels  → {1:2357, 2:467, 4:609, 8:339, 16:323, 32:3}
 * i.e. adult browsing really does serve level-60 models and level-32 IMAGES.
 * Both are refused here, and layer 0 refuses the models a second time.
 */
const BLOCKED_AND_ABOVE = ~(NSFW_BIT.PG | NSFW_BIT.PG13 | NSFW_BIT.R | NSFW_BIT.X | NSFW_BIT.XXX)

/** The numeric ceiling, exported so a test can pin "31, never 60". */
export const NSFW_ADULT_CAP = NSFW_BIT.PG | NSFW_BIT.PG13 | NSFW_BIT.R | NSFW_BIT.X | NSFW_BIT.XXX

/**
 * SFW pass for one nsfwLevel. TRUE only when the level carries no bit above
 * PG13.
 *
 * A non-number, a negative, a non-integer or 0 is NOT a pass. 0 in particular
 * is "no level assigned", which is unknown-not-safe — and it does not cost us
 * anything real: across 100 live rows (and their 1 908 versions) the minimum
 * observed level was 1. Same paranoid default as classifyProvider().
 */
export function sfwOnly(level: unknown): boolean {
  if (typeof level !== 'number' || !Number.isInteger(level) || level <= 0) return false
  return (level & ADULT_BITS) === 0
}

/**
 * ADULT pass for one nsfwLevel — the layer-1 predicate when 18+ is unlocked.
 *
 * Same paranoid shape as sfwOnly (a non-number / 0 / negative / fraction is not
 * a pass), and it differs from it in exactly one way: the ceiling is 31 instead
 * of 3. It is STILL a bitmask test, not `level <= 31`: a hypothetical level 33
 * (PG|Blocked) is numerically greater than 31 and an ordinal implementation
 * would reject it by luck, but level 32 alone (`Blocked` with nothing else)
 * would slip through `level <= 60`-shaped code. `& ~31` cannot.
 */
export function adultAllowed(level: unknown): boolean {
  if (typeof level !== 'number' || !Number.isInteger(level) || level <= 0) return false
  return (level & BLOCKED_AND_ABOVE) === 0
}

// ─── the unlock predicate (THE ONLY PLACE THE THREE FACTS MEET) ──────────────

/** Everything the unlock decision is allowed to depend on. */
export interface CivitaiAdultUnlockInput {
  /** `AppSettings.civitaiAdultMode` — the switch the dialog writes. */
  adultMode?: unknown
  /** `AppSettings.civitaiAdultAcceptedAt` — epoch ms of the affirmation. */
  acceptedAt?: unknown
  /** Is the user's OWN Civitai credential in the keychain RIGHT NOW? */
  hasKey?: unknown
}

/**
 * Is 18+ actually unlocked? THREE conditions, all required, no exceptions:
 *
 *   1. `adultMode === true`   — an explicit switch, default off.
 *   2. `acceptedAt > 0`       — a timestamped affirmation from the dedicated
 *                               dialog. A hand-edited settings file that flips
 *                               only the boolean does NOT unlock anything.
 *   3. `hasKey === true`      — the user's own Civitai credential is stored.
 *
 * HONESTY NOTE FOR WHOEVER READS THIS NEXT — DO NOT DELETE CONDITION 3 AS DEAD
 * WEIGHT. It is NOT a technical unlock and we know it: live probes on
 * 2026-07-28 returned adult listings and unauthenticated 307 downloads for
 * nsfwLevel-60 models with no credential at all, and Civitai's OAuth scopes
 * contain no adult scope. The credential is a POLICY choice — it ties adult
 * browsing to an account that accepted Civitai's own 18+ terms, it adds
 * deliberate friction, and it is revocable in one click (removing the key
 * returns the app to SFW instantly, with no second confirmation). The 18+ gate
 * is entirely OUR obligation; this is how we chose to carry it.
 *
 * PURE. No settings read, no keychain read, no clock — the caller supplies all
 * three facts, which is what lets a unit test walk the whole truth table.
 */
export function civitaiAdultUnlocked(input: CivitaiAdultUnlockInput | null | undefined): boolean {
  if (!input) return false
  if (input.adultMode !== true) return false
  if (input.hasKey !== true) return false
  const at = input.acceptedAt
  return typeof at === 'number' && Number.isFinite(at) && at > 0
}

// ─── the normalized whole-token denylist ─────────────────────────────────────
//
// WHOLE TOKENS, never substrings — the spec is explicit and the reason is that
// substring matching is both leaky in one direction and absurd in the other
// ("analog" contains "anal"). Variants that a stemmer would have caught are
// therefore spelled out one by one below.
//
// FALSE POSITIVES ARE THE CHEAP ERROR HERE. A wrongly excluded model costs one
// missing row in a catalog of ~1.2 M; a wrongly included one costs something we
// are not willing to trade. Where a term is ambiguous in art contexts ("kid",
// "teen"), it stays on the list.
const DENY_TOKENS: readonly string[] = [
  // explicit minor-sexualisation subculture terms
  'loli', 'lolis', 'lolicon', 'lolita', 'lolicons',
  'shota', 'shotas', 'shotacon', 'shotacons',
  'toddlercon', 'cub', 'cubs', 'cp',
  'pedo', 'pedophile', 'pedophilia', 'paedo', 'paedophile', 'nepiophile',
  'jailbait', 'jb',
  // age words
  'child', 'children', 'childs', 'childlike', 'childish',
  'kid', 'kids', 'kiddie', 'kiddo',
  'minor', 'minors', 'underage', 'underaged',
  'infant', 'infants', 'baby', 'babies', 'newborn', 'toddler', 'toddlers',
  'preteen', 'preteens', 'tween', 'tweens',
  'teen', 'teens', 'teenage', 'teenager', 'teenagers', 'teenaged',
  'juvenile', 'prepubescent', 'prepuberty', 'pubescent',
  'youngster', 'youngsters',
  // institution words that only ever narrow the subject's age
  'schoolgirl', 'schoolgirls', 'schoolboy', 'schoolboys',
  'kindergarten', 'preschool', 'elementary', 'gradeschool',
  // roleplay shorthand
  'ageplay', 'ddlg', 'cgl', 'abdl',
] as const

/**
 * Multi-word phrases, matched against the normalized string with token
 * boundaries. Single tokens above cannot express these ("young" alone is a
 * false-positive machine; "young girl" is not).
 */
const DENY_PHRASES: readonly string[] = [
  'young girl', 'young girls', 'young boy', 'young boys',
  'little girl', 'little girls', 'little boy', 'little boys',
  'small girl', 'small boy',
  'age play', 'age regression',
  'middle school', 'high school', 'grade school', 'primary school',
  'not safe for kids',
] as const

const DENY_TOKEN_SET = new Set<string>(DENY_TOKENS)

/**
 * Normalize a tag / name for denylist matching:
 *   NFKD → strip combining marks (so `lóli` folds to `loli`)
 *   lowercase
 *   every non-alphanumeric run (space, `_`, `-`, `.`, CJK punctuation, emoji…)
 *   becomes a single space
 *
 * Digits are KEPT (so `sd15` stays one token and cannot be mangled into a
 * denied word). No leetspeak folding: it would turn `sd15` into `sdis` and
 * `3d` into `ed`, buying obfuscation coverage at the price of unpredictable
 * false positives. Documented as a known limit rather than hidden.
 */
export function normalizeTag(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * TRUE when a denied term is present. Three passes, all token-aligned:
 *
 *   1. whole token          — `loli`, `toddler`
 *   2. ADJACENT-PAIR JOIN   — `under-age` and `under_age` both normalize to the
 *                             two tokens `under age`, which pass 1 cannot see;
 *                             joining neighbours recovers `underage`. This also
 *                             covers `school girl`, `jail bait`, `loli con`.
 *                             It stays token-aligned (only neighbours, never an
 *                             arbitrary span), so `analog`/`kidney`/`protein`
 *                             are still untouched.
 *   3. phrase               — multi-word terms whose parts are individually
 *                             harmless (`young girl`).
 */
export function hasDeniedTag(values: readonly unknown[]): boolean {
  for (const v of values) {
    const norm = normalizeTag(v)
    if (!norm) continue
    const tokens = norm.split(' ')

    for (const tok of tokens) {
      if (DENY_TOKEN_SET.has(tok)) return true
    }
    for (let i = 0; i + 1 < tokens.length; i++) {
      if (DENY_TOKEN_SET.has(tokens[i]! + tokens[i + 1]!)) return true
    }
    // ` x ` padding gives token boundaries without building a regex.
    const padded = ` ${norm} `
    for (const phrase of DENY_PHRASES) {
      if (padded.includes(` ${phrase} `)) return true
    }
  }
  return false
}

// ─── layer 0 ─────────────────────────────────────────────────────────────────

/** The subset of the Civitai model object layer 0 reads. All fields optional:
 *  the API omits `mode` entirely on healthy rows (100/100 undefined, live). */
export interface CivitaiLayer0Model {
  name?: unknown
  poi?: unknown
  minor?: unknown
  mode?: unknown
  nsfwLevel?: unknown
  tags?: unknown
  availability?: unknown
}

/** The subset of the version object layer 0 reads. */
export interface CivitaiLayer0Version {
  name?: unknown
  nsfwLevel?: unknown
  trainedWords?: unknown
  availability?: unknown
  /**
   * VERSION-level `minor`, treated as the same kill switch as the model-level
   * one. Optional and ADDITIVE: absent ⇒ this reads exactly as it did before.
   *
   * WHO SUPPLIES IT, PRECISELY — one caller, and it is not the browse path. The
   * `modelVersions[]` embedded in a `/models` page does NOT carry the field
   * (verified against the captured live fixture: version keys are availability,
   * baseModel, baseModelType, downloadUrl, files, id, images, index, name,
   * nsfwLevel, trainedWords), so every row that reaches civitaiRowAllowed from a
   * search or a detail fetch still passes `minor: undefined` and this line does
   * nothing for it.
   *
   * `GET /api/v1/model-versions/mini/:id` DOES carry it
   * (<https://developer.civitai.com/site/reference/model-versions.md>).
   * fetchCivitaiVersionMini returns it, probeCivitaiDownloadAuth attaches that
   * record to its verdict as `version`, and `civitai:install` (civitai.ipc.ts)
   * hands the flag straight back to layer0Excluded before any byte is requested
   * — at zero extra cost, because the pre-flight fetch had already happened for
   * `requireAuth`. So: ARMED ON THE INSTALL PATH, still dark on the browse path,
   * and absent ⇒ unchanged behaviour everywhere.
   *
   * `sfwOnly` from that same response is NOT read here, on purpose: it is a usage
   * restriction on the resource, not a statement that the resource is adult.
   * `true` would block SFW content and `false` is evidence of nothing.
   */
  minor?: unknown
}

/**
 * LAYER 0 — hard exclude. NO PARAMETERS beyond the payload itself: there is
 * deliberately no `opts`, no `adultUnlocked`, no settings read. Phase 3's 18+
 * unlock will widen layer 1 only; this predicate keeps returning true for the
 * same inputs forever.
 *
 * Excluded when ANY of:
 *   - poi === true                    (real person)
 *   - minor === true                  (creator-declared) on the model OR on the
 *                                     version — the same both-levels symmetry the
 *                                     Blocked-bit check below already has. Only
 *                                     an explicit `true` excludes, so a version
 *                                     object without the field (every browse
 *                                     payload today) behaves exactly as before;
 *                                     see CivitaiLayer0Version.minor for who
 *                                     supplies it and who does not.
 *   - mode === 'TakenDown'            (also 'Archived' — unfetchable either way)
 *   - nsfwLevel carries the Blocked bit (32) on the model OR the version
 *   - a denied whole token appears in the model name, version name, tags, or
 *     trained words
 *
 * NOTE the deliberate asymmetry with sfwOnly(): layer 0 checks only the Blocked
 * BIT, not the whole SFW pass. Layer 0 is the unconditional floor that must
 * survive into phase 3 when adult content is legitimately visible; the SFW pass
 * is layer 1 and is applied separately (see civitai-search.ts).
 */
export function layer0Excluded(
  model: CivitaiLayer0Model | null | undefined,
  version: CivitaiLayer0Version | null | undefined,
): boolean {
  if (!model || !version) return true   // malformed ⇒ excluded (fail closed)

  if (model.poi === true) return true
  if (model.minor === true) return true
  // Version-level `minor`: BLOCKS, and can only block. There is no branch below
  // that reads it, so it cannot widen anything the model-level check refused.
  if (version.minor === true) return true
  if (model.mode === 'TakenDown' || model.mode === 'Archived') return true

  const blocked = (lvl: unknown) =>
    typeof lvl === 'number' && Number.isInteger(lvl) && (lvl & NSFW_BIT.BLOCKED) !== 0
  if (blocked(model.nsfwLevel)) return true
  if (blocked(version.nsfwLevel)) return true

  const tags = Array.isArray(model.tags) ? model.tags : []
  const words = Array.isArray(version.trainedWords) ? version.trainedWords : []
  if (hasDeniedTag([model.name, version.name, ...tags, ...words])) return true

  return false
}

/**
 * LAYER 1 (SFW) — the client-side bitmask pass that the `nsfw=false` request
 * parameter does NOT give us. BOTH levels must pass.
 */
export function layer1SfwPass(
  model: { nsfwLevel?: unknown } | null | undefined,
  version: { nsfwLevel?: unknown } | null | undefined,
): boolean {
  if (!model || !version) return false
  return sfwOnly(model.nsfwLevel) && sfwOnly(version.nsfwLevel)
}

/**
 * LAYER 2 (18+ unlocked) — the SAME shape as layer 1 with the ceiling raised
 * from 3 to 31. BOTH levels still have to pass; a clean version under a level-60
 * model is still not shown, because the model's own level carries Blocked.
 *
 * This is the ONLY thing the unlock widens. It is deliberately written as a
 * sibling of layer1SfwPass rather than as a parameter on it, so that reading
 * either function tells you its whole ceiling with nothing to look up.
 */
export function layer2AdultPass(
  model: { nsfwLevel?: unknown } | null | undefined,
  version: { nsfwLevel?: unknown } | null | undefined,
): boolean {
  if (!model || !version) return false
  return adultAllowed(model.nsfwLevel) && adultAllowed(version.nsfwLevel)
}

/** Which layer-1 ceiling is in force. `adult: true` is only ever produced by
 *  civitaiAdultUnlocked() — never by a raw setting read. */
export interface CivitaiGateMode { adult?: boolean }

/**
 * The one call the search service makes. TRUE = this (model, version) pair may
 * be shown.
 *
 * ORDER IS THE WHOLE DESIGN: layer 0 runs FIRST and takes no mode argument, so
 * there is no value of `mode` — present or future — that can reach past it.
 * Only the second line branches, and it branches between two ceilings that are
 * both bitmask tests.
 */
export function civitaiRowAllowed(
  model: CivitaiLayer0Model | null | undefined,
  version: CivitaiLayer0Version | null | undefined,
  mode: CivitaiGateMode = {},
): boolean {
  if (layer0Excluded(model, version)) return false
  const m = model as { nsfwLevel?: unknown }
  const v = version as { nsfwLevel?: unknown }
  return mode.adult === true ? layer2AdultPass(m, v) : layer1SfwPass(m, v)
}

/**
 * Preview images: PG ONLY, and it is an equality test on purpose. `nsfwLevel
 * === 1` is not "≤ PG13" and not a bitmask pass — we never fetch a PG13 preview
 * either, because the card does not need it and the fetch itself is the thing
 * we are being careful about. (Live check: the `nsfw=false` browse response had
 * 7966/7966 images already clamped to level 1; this asserts it rather than
 * trusting it.)
 */
export function isPgPreviewImage(img: { nsfwLevel?: unknown; type?: unknown } | null | undefined): boolean {
  if (!img) return false
  if (img.nsfwLevel !== NSFW_BIT.PG) return false
  // `type` is 'image' | 'video'; a video preview is not a thumbnail.
  return img.type === undefined || img.type === 'image'
}

/**
 * Preview images when 18+ is unlocked: anything up to the 31 ceiling, still an
 * image and never Blocked.
 *
 * MEASURED (see NSFW_ADULT_CAP): an `nsfw=true` page really does carry level-32
 * images — 3 of 4 095 in a 20-model sample. `adultAllowed` refuses them, which
 * is why the adult path has its own predicate instead of "no filter".
 *
 * The chosen preview is still the LEAST explicit one available (see
 * pickPreviewImage in civitai-search.ts) and the row carries the level it
 * ended up with, so the card can blur above PG13 without guessing.
 */
export function isAdultPreviewImage(img: { nsfwLevel?: unknown; type?: unknown } | null | undefined): boolean {
  if (!img) return false
  if (!adultAllowed(img.nsfwLevel)) return false
  return img.type === undefined || img.type === 'image'
}
