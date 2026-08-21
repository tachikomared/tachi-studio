// apps/desktop/electron/services/user-sd-models.ts
//
// USER-INSTALLED sd.cpp MODELS — the registry that makes a downloaded Civitai
// checkpoint EXIST (spec §4-1, risk R3 "the invisible model").
//
// Before this file, sd.cpp knew exactly two hardcoded consts: SD_IMAGE_MODELS
// and SD_VIDEO_MODELS. A weight the user installed from anywhere else was
// invisible to findSdModel → invisible to modelComponentPaths → invisible to
// isSdModelInstalled → absent from sd-cpp:status → absent from the MediaPage
// dropdown, and a generate call naming it threw "Unknown sd.cpp model id".
// The bytes were on disk and nothing could run them.
//
// SHAPE: a user row is an SdImageModel — the SAME shape the curated rows use,
// deliberately, so every consumer downstream (installer, client arg builder,
// catalog, composer schema) gets user models for free instead of growing a
// second code path. sd-cpp-models.ts merges these into allSdModels() /
// findSdModel(); nothing else had to change.
//
// STORAGE: `${userData}/user-sd-models.json`, written ATOMICALLY (temp file in
// the same directory + rename) so a crash mid-write cannot leave a truncated
// registry behind — the failure mode would be "every installed model vanished".
//
// ── TWO RULES THIS FILE ENFORCES RATHER THAN DOCUMENTS ───────────────────────
//
// 1. NO CREDENTIAL EVER REACHES THIS FILE ON DISK. `headers` exists on the
//    in-memory row (a Civitai download for a gated model needs
//    `Authorization: Bearer …`), and add() STRIPS it before persisting —
//    exactly the rule download-manager.ts states for ManagedDownloadSpec.headers:
//    downloads.json is plaintext under userData while the key's home is the
//    DPAPI-encrypted keychain, so the secret is re-attached per call by the
//    caller and never written down. `requiresKey` is persisted instead: a
//    fact, not a secret.
//
// 2. IDS ARE `[a-z0-9-]` ONLY (risk R10). sdManagedIdPrefix builds a Stop sweep
//    out of `sd:<id>:` and matches on that trailing colon — an id containing a
//    colon would make one model's Stop button pause another model's download.
//    Every id is validated on the way IN and re-validated on the way OUT, so a
//    hand-edited json cannot smuggle one past.
//
// A row that fails validation is DROPPED on read (with a warning), never
// thrown: a corrupt or hand-edited registry must degrade to "that one model is
// missing", never to "the local engine has no models at all".

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { SdAdapter, SdAdapterKind, SdFileRole, SdImageModel, SdModelFamily, SdModelFile } from './sd-cpp-models'
// Same shared pure module sd-cpp-client reads the tag builder from, for the same
// reason: the slug the app WRITES and the key a typed tag is matched by are one
// transformation. See adapterSlug.
import { loraNameKey } from '../../src/pages/media/localGenParams'

// ─── Shape ────────────────────────────────────────────────────────────────────

/** Where a user row came from — provenance, shown in the UI, never a secret. */
export interface UserSdModelSource {
  kind:        'civitai'
  /** Civitai model + version ids (hash-first identity lives in files[].sha256). */
  modelId:     number
  versionId:   number
  /** The upstream `baseModel` string VERBATIM ('SDXL 1.0', 'Pony', …) — the
   *  mapped `family` is our verdict, this is what they said. */
  baseModel:   string
  /** Prompt tokens the creator says the weights respond to (phase-2 chips). */
  trainedWords?: string[]
  /** Informational only — the app surfaces license terms, it cannot enforce them. */
  license?:    { commercial: string[]; noCredit: boolean; derivatives: boolean }
}

/**
 * A user-installed model. Structurally an SdImageModel (see the header) plus
 * provenance and the two auth-related fields.
 */
export interface UserSdModel extends SdImageModel {
  /**
   * Request headers for the download — IN MEMORY ONLY. add() strips this
   * before writing; list() therefore never returns one. The caller re-attaches
   * a fresh credential per download (downloadSdModel's `opts.headers`).
   */
  headers?:     Record<string, string>
  /** Persisted fact: this host wanted an Authorization header at install time. */
  requiresKey?: boolean
  source?:      UserSdModelSource
  /** Epoch ms — ordering + "recently added" affordances. */
  addedAt?:     number
}

/**
 * The subset of the shared `CivitaiSearchRow` contract the mapper reads.
 * STRUCTURAL on purpose: lane B owns the full row type in civitai-search.ts,
 * and any object matching this shape maps — no cross-lane import, no cycle.
 */
export interface CivitaiRowLike {
  id:          string
  modelId:     number
  versionId:   number
  name:        string
  /** null = unmapped/not runnable. The mapper REFUSES those (fail closed). */
  family:      SdModelFamily | null
  baseModel:   string
  sizeMb:      number
  sha256:      string | null
  downloadUrl: string
  fileName:    string
  format:      string
  fp?:            string | null
  trainedWords?:  string[]
  license?:       { commercial: string[]; noCredit: boolean; derivatives: boolean }
}

// ─── Per-family generation defaults ───────────────────────────────────────────
//
// A Civitai row carries weights, not sampler settings, so the mapper has to
// supply them. These are the SAME numbers the CURATED ROW of each family
// declares in sd-cpp-models.ts — sd15 → 20/7/euler_a (the `sd15` row),
// sdxl → 28/5/dpm++2m (the `sdxl-base-1.0` row), flux → 4/1/euler (the
// `flux-schnell-q4` row) — so a user model and a shipped model of the same
// family start from one story instead of two. The test recomputes them FROM
// those rows, so repointing a curated row and forgetting this table fails.
//
// `baseSize` is the pixel grid, not a preference: 512 for SD 1.5, 1024 for SDXL
// and Flux. It is what sd-cli falls back to when no -W/-H is passed, and what
// the composer's local size tiers are derived from.

const FAMILY_DEFAULTS: Record<SdModelFamily, {
  baseSize: 512 | 1024; steps: number; cfgScale: number; samplingMethod: string
}> = {
  sd15:   { baseSize: 512,  steps: 20, cfgScale: 7, samplingMethod: 'euler_a' },
  sdxl:   { baseSize: 1024, steps: 28, cfgScale: 5, samplingMethod: 'dpm++2m' },
  flux:   { baseSize: 1024, steps: 4,  cfgScale: 1, samplingMethod: 'euler'   },
  // The `z-image-turbo` row's own numbers (upstream's `--steps 8 --cfg-scale
  // 1.0`). Not reachable from the Civitai mapper today — isFamily below accepts
  // only the three families Civitai's `baseModel` strings name — but the table
  // is exhaustive by TYPE, so the day a z-image checkpoint can be registered it
  // starts from the same story the curated row tells instead of the sd15 one.
  zimage: { baseSize: 1024, steps: 8,  cfgScale: 1, samplingMethod: 'euler'   },
}

/** Read-only view of the defaults (tests + the mapper; never mutated). */
export function familyDefaults(family: SdModelFamily): {
  baseSize: 512 | 1024; steps: number; cfgScale: number; samplingMethod: string
} {
  return { ...FAMILY_DEFAULTS[family] }
}

/**
 * Every legal SdFileRole, as a RUNTIME set.
 *
 * Written as an exhaustive Record rather than an array so `tsc` fails here the
 * day a new role is added to SdFileRole — a role the validator does not know
 * would otherwise silently reject a legitimate component file. Deliberately a
 * local literal (not a runtime import from sd-cpp-models) because that module
 * imports THIS one: the type import above is erased, so there is no cycle.
 */
const ROLE_SET: Record<SdFileRole, true> = {
  model: true, diffusion: true, vae: true, clip_l: true, clip_g: true, t5xxl: true, clip_vision: true,
  // `diffusion_high` — the second DiT of a Wan 2.2 A14B MoE pair
  // (`--high-noise-diffusion-model`). A SEPARATE role rather than a flag on the
  // file, because the one-file-per-role rule below is also what keeps the two
  // experts from colliding at `models/<id>/diffusion.gguf`.
  diffusion_high: true,
  // `audio_vae` + `embeddings_connectors` — the two LTX-2.3 roles
  // (`--audio-vae`, `--embeddings-connectors`). No shipped row declares either;
  // accepting them here is what lets a verified file be carried as data.
  audio_vae: true,
  embeddings_connectors: true,
  // `llm` (the `--llm` text encoder — Z-Image / Flux.2 / Qwen-Image condition on
  // an LLM where Flux.1 uses T5-XXL). Accepting it here is what lets a
  // user-registered LLM-conditioned model carry its encoder as a component.
  llm: true,
  // `tae` (the 22.6 MB Tiny AutoEncoder decoder swap) is a legal component role
  // — see SdFileRole. No curated row ships one yet; the validator accepting it
  // is what lets one be added as DATA instead of as a code change.
  tae: true,
}

/** Upstream weight formats we REFUSE outright (SwarmUI precedent, spec §4-4).
 *  Pickle formats execute arbitrary code on load; Diffusers is a directory
 *  layout our single-file/component downloader cannot represent at all. */
const REFUSED_FORMATS = new Set(['pickletensor', 'pickle', 'ckpt', 'diffusers'])

/** True when `format` names a weights container we refuse to install. */
export function isRefusedWeightFormat(format: string | null | undefined): boolean {
  if (typeof format !== 'string') return false
  return REFUSED_FORMATS.has(format.trim().toLowerCase())
}

// ─── Id + field validation ────────────────────────────────────────────────────

/** `[a-z0-9-]`, must start alphanumeric, ≤ 64 chars. NO colon (risk R10). */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidUserSdModelId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

/** The canonical id for a Civitai version — `civitai-<versionId>`, nothing else. */
export function civitaiModelId(versionId: number): string {
  return `civitai-${Math.trunc(versionId)}`
}

/** 64 lowercase hex, or one of the build-time placeholders sd-cpp-models mints. */
const SHA_RE = /^[0-9a-f]{64}$/
const SHA_PLACEHOLDER_RE = /^__SHA_PLACEHOLDER_.*__$/

/** The fail-closed stand-in used when an upstream publishes no hash. The
 *  installer REFUSES a placeholder in a packaged build (audit C2), so an
 *  unverifiable weight can be registered but never silently installed. */
export function shaPlaceholderFor(id: string): string {
  return `__SHA_PLACEHOLDER_${id.toUpperCase().replace(/-/g, '_')}__`
}

function isUsableSha(s: unknown): s is string {
  return typeof s === 'string' && (SHA_RE.test(s) || SHA_PLACEHOLDER_RE.test(s))
}

/** https only. A weights URL on http: is a downgrade we never take. */
function isHttpsUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0) return false
  try { return new URL(u).protocol === 'https:' } catch { return false }
}

/** Header maps carry secrets AND go on the wire — reject anything that could
 *  smuggle a second header (CR/LF) or an empty name. */
function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) return undefined
    if (typeof v !== 'string' || /[\r\n]/.test(v)) return undefined
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The families a PERSISTED user row may declare.
 *
 * `zimage` was added 2026-07-31 and it is load-bearing, not tidying: this
 * predicate guards BOTH normalizers (normalizeUserSdModel and
 * normalizeUserSdAdapter), which run on every read of user-sd-models.json.
 * Once familyForBaseModel started mapping `ZImageTurbo`/`ZImageBase`, a
 * Z-Image LoRA would install and work for the session and then VANISH on the
 * next app start — rejected here, silently, as a poisoned row. FAMILY_DEFAULTS
 * has carried its `zimage` entry since the row landed, waiting for exactly
 * this.
 *
 * Still NOT `wan`: SdModelFamily has no such member (it keys an image-only
 * defaults table and is the equality test in isAdapterCompatible), so a Wan
 * LoRA is refused upstream in the verdict rather than half-accepted here.
 */
function isFamily(f: unknown): f is SdModelFamily {
  return f === 'sd15' || f === 'sdxl' || f === 'flux' || f === 'zimage'
}

/** Provenance block, shared by the checkpoint and the adapter row. */
function normalizeSource(raw: unknown): UserSdModelSource | undefined {
  const src = raw as Record<string, unknown> | undefined
  if (!src || src.kind !== 'civitai' || typeof src.modelId !== 'number' || typeof src.versionId !== 'number') return undefined
  const source: UserSdModelSource = {
    kind: 'civitai',
    modelId:   Math.trunc(src.modelId),
    versionId: Math.trunc(src.versionId),
    baseModel: typeof src.baseModel === 'string' ? src.baseModel : '',
  }
  if (src.trainedWords !== undefined) {
    const words = normalizeTriggerWords(src.trainedWords)
    if (words.length > 0) source.trainedWords = words
  }
  const lic = src.license as Record<string, unknown> | undefined
  if (lic && typeof lic === 'object') {
    source.license = {
      commercial:  Array.isArray(lic.commercial) ? lic.commercial.filter((c): c is string => typeof c === 'string') : [],
      noCredit:    lic.noCredit === true,
      derivatives: lic.derivatives === true,
    }
  }
  return source
}

function normalizeFile(raw: unknown): SdModelFile | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Record<string, unknown>
  const role = f.role
  if (typeof role !== 'string' || !(role in ROLE_SET)) return null
  if (!isHttpsUrl(f.url)) return null
  if (!isUsableSha(f.sha256)) return null
  const sizeMb = typeof f.sizeMb === 'number' && Number.isFinite(f.sizeMb) ? Math.ceil(f.sizeMb) : NaN
  if (!Number.isFinite(sizeMb) || sizeMb <= 0) return null
  if (isRefusedWeightFormat(typeof f.format === 'string' ? f.format : null)) return null
  const out: SdModelFile = { role: role as SdFileRole, url: f.url, sha256: (f.sha256 as string).toLowerCase(), sizeMb }
  if (typeof f.fileName === 'string' && f.fileName.trim()) out.fileName = f.fileName.trim()
  if (typeof f.format === 'string' && f.format.trim()) out.format = f.format.trim()
  return out
}

/**
 * Validate + normalize one row. Returns null (never throws) for anything that
 * would poison the registry — read() drops those, add() converts the null into
 * a precise Error so the CALLER learns why.
 */
export function normalizeUserSdModel(raw: unknown): UserSdModel | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (!isValidUserSdModelId(m.id)) return null
  const name = typeof m.name === 'string' ? m.name.trim().slice(0, 200) : ''
  if (!name) return null
  if (!isFamily(m.family)) return null
  if (m.baseSize !== 512 && m.baseSize !== 1024) return null
  const steps = typeof m.steps === 'number' && Number.isFinite(m.steps) ? Math.trunc(m.steps) : NaN
  if (!Number.isFinite(steps) || steps <= 0 || steps > 200) return null
  const cfgScale = typeof m.cfgScale === 'number' && Number.isFinite(m.cfgScale) ? m.cfgScale : NaN
  if (!Number.isFinite(cfgScale) || cfgScale <= 0 || cfgScale > 30) return null
  const samplingMethod = typeof m.samplingMethod === 'string' ? m.samplingMethod.trim() : ''
  if (!samplingMethod) return null
  if (!Array.isArray(m.files) || m.files.length === 0 || m.files.length > 8) return null
  const files: SdModelFile[] = []
  const seenRoles = new Set<string>()
  for (const rf of m.files) {
    const f = normalizeFile(rf)
    if (!f) return null
    if (seenRoles.has(f.role)) return null          // one file per role, or the paths collide
    seenRoles.add(f.role)
    files.push(f)
  }
  const out: UserSdModel = {
    id: m.id, name, family: m.family, baseSize: m.baseSize, steps, cfgScale, samplingMethod, files,
  }
  if (typeof m.notes === 'string' && m.notes.trim()) out.notes = m.notes.trim().slice(0, 400)
  const headers = normalizeHeaders(m.headers)
  if (headers) out.headers = headers
  if (m.requiresKey === true || headers) out.requiresKey = true
  const source = normalizeSource(m.source)
  if (source) out.source = source
  if (typeof m.addedAt === 'number' && Number.isFinite(m.addedAt)) out.addedAt = m.addedAt
  return out
}

// ─── The Civitai mapper (the cross-lane export contract) ─────────────────────

/**
 * Map one CivitaiSearchRow onto an SdImageModel-shaped user row.
 *
 * FAIL CLOSED, twice:
 *  • `family === null` (the row's own "we could not map this baseModel"
 *    verdict) THROWS. A registry row we cannot pick presets or a pixel grid
 *    for is a fabricated capability — the honesty law, same class as the
 *    speech-row and Wan over-promise fixes (061112d / 2bd48fc).
 *  • a refused container (PickleTensor / Diffusers) THROWS, even though lane
 *    B's `installable` verdict already filters it. Defense in depth: this is
 *    the last layer before bytes are fetched.
 *
 * A row with NO sha256 is registered with the build-time PLACEHOLDER, which
 * the installer refuses in a packaged build (audit C2) — the whisper/piper
 * precedent. Registering it is still useful: the failure names the model and
 * says why, instead of the download silently landing unverified bytes.
 */
export function userSdModelFromCivitaiRow(
  row: CivitaiRowLike,
  opts: { headers?: Record<string, string> } = {},
): UserSdModel {
  if (!row || typeof row !== 'object') throw new Error('civitai row: not an object')
  if (!Number.isFinite(row.versionId)) throw new Error('civitai row: versionId is required')
  if (!row.family) {
    throw new Error(`Refusing to register "${row.name || row.id}": its base model (${row.baseModel || 'unknown'}) does not map to a family this engine runs.`)
  }
  if (isRefusedWeightFormat(row.format)) {
    throw new Error(`Refusing to register "${row.name || row.id}": ${row.format} weights are not supported (pickle formats execute code on load).`)
  }
  const id = civitaiModelId(row.versionId)
  const d = FAMILY_DEFAULTS[row.family]
  const sizeMb = Number.isFinite(row.sizeMb) && row.sizeMb > 0 ? Math.ceil(row.sizeMb) : 1
  const file: SdModelFile = {
    role:   'model',
    url:    row.downloadUrl,
    sha256: typeof row.sha256 === 'string' && row.sha256 ? row.sha256.toLowerCase() : shaPlaceholderFor(id),
    sizeMb,
  }
  if (row.fileName) file.fileName = row.fileName
  if (row.format)   file.format   = row.format
  const notes = [
    `Civitai · ${row.baseModel || row.family}`,
    row.license && row.license.commercial.length === 0 ? 'no commercial use' : null,
    row.license && !row.license.noCredit ? 'credit required' : null,
  ].filter(Boolean).join(' · ')
  const out: UserSdModel = {
    id,
    name:           row.name || id,
    family:         row.family,
    baseSize:       d.baseSize,
    steps:          d.steps,
    cfgScale:       d.cfgScale,
    samplingMethod: d.samplingMethod,
    notes,
    files:          [file],
    source: {
      kind: 'civitai', modelId: Math.trunc(row.modelId), versionId: Math.trunc(row.versionId),
      baseModel: row.baseModel ?? '',
      ...(normalizeTriggerWords(row.trainedWords).length ? { trainedWords: normalizeTriggerWords(row.trainedWords) } : {}),
      ...(row.license ? { license: row.license } : {}),
    },
    addedAt: Date.now(),
  }
  const headers = normalizeHeaders(opts.headers)
  if (headers) { out.headers = headers; out.requiresKey = true }
  return out
}

// ─── ADAPTERS: LoRA / LyCORIS, Textual Inversion, VAE ────────────────────────
//
// Same file, same atomic write, second array. A separate registry file would
// have doubled the corruption surface for no gain, and an adapter is not an
// SdImageModel: it has no baseSize / steps / cfg / sampler of its own, it has a
// SLUG the app owns and a FAMILY that is a compat gate rather than a preset key.

/** A user-installed adapter, plus the two auth fields and provenance. */
export interface UserSdAdapter extends SdAdapter {
  /** IN MEMORY ONLY — addAdapter strips it (RULE 1 in the header). */
  headers?:     Record<string, string>
  requiresKey?: boolean
  source?:      UserSdModelSource
  addedAt?:     number
}

/**
 * Civitai `type` → our adapter kind. ALLOWLIST, not denylist (the honesty law):
 * a type absent from this table is not installable as an adapter, full stop.
 *
 * LoCon / LyCORIS map to `lora` because they ARE loras to this engine — the DLL
 * at our pin carries the LoHa and LoKr keymaps (spec §3). DoRA is deliberately
 * ABSENT and must stay absent: the binary has no `dora_scale` handling, so it
 * would load, silently drop the magnitude vector, and render something that is
 * quietly not what the weights encode.
 */
export const CIVITAI_ADAPTER_TYPES: Readonly<Record<string, SdAdapterKind>> = {
  LORA:             'lora',
  LoCon:            'lora',
  LyCORIS:          'lora',
  DoRA:             undefined as unknown as SdAdapterKind,   // see below — pruned
  TextualInversion: 'embedding',
  VAE:              'vae',
}
// DoRA is written above only so the omission is visible next to the types it
// resembles; it is removed here so no lookup can ever succeed for it.
delete (CIVITAI_ADAPTER_TYPES as Record<string, SdAdapterKind | undefined>).DoRA

/** The adapter kind for a raw Civitai `type`, or null when we do not run it. */
export function adapterKindForCivitaiType(type: unknown): SdAdapterKind | null {
  if (typeof type !== 'string') return null
  return CIVITAI_ADAPTER_TYPES[type.trim()] ?? null
}

function isAdapterKind(k: unknown): k is SdAdapterKind {
  return k === 'lora' || k === 'embedding' || k === 'vae'
}

/** `[a-z0-9-]`, must start alphanumeric, ≤ 72 chars. This lands on disk AND
 *  inside a `<lora:…:…>` prompt tag, so nothing else is acceptable. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,71}$/

export function isValidAdapterSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s)
}

/** Cheap, stable, dependency-free 32-bit hash (FNV-1a) — the slug's suffix. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * The on-disk slug for an adapter: `<slugified-name>-<8 hex>`, `[a-z0-9-]` only.
 *
 * The suffix comes from the artifact's SHA256 when there is one (hash-first
 * identity, moat #2) and from the id otherwise, so two LoRAs called
 * "detail tweaker" cannot collide, and the same bytes always produce the same
 * slug — a re-install overwrites rather than accumulating `-2` copies.
 *
 * The name half is kept because `<lora:add-detail-9f3c1a2b:0.8>` is something a
 * user can read in their own prompt; it is truncated hard because a prompt tag
 * is not a place for a 180-character title.
 */
export function adapterSlug(name: string, identity: string): string {
  // The name half is `loraNameKey` and MUST STAY IT: that function is also how a
  // tag the user typed by hand is matched back to this file (see
  // resolveTypedLoraTags). Two copies of this transformation means a typed name
  // that can never resolve, so there is one, and a test asserts this prefix.
  const base = loraNameKey(name)
  const hex = /^[0-9a-f]{8}/i.test(identity)
    ? identity.slice(0, 8).toLowerCase()
    : fnv1a32(String(identity)).toString(16).padStart(8, '0')
  return base ? `${base}-${hex}` : `adapter-${hex}`
}

/**
 * Normalize Civitai's `trainedWords`.
 *
 * Real data is NOT a clean array: it is frequently ONE comma-joined string with
 * trailing junk ("masterpiece, best quality, <lora:foo:1>, "), so it is split,
 * trimmed, de-duplicated case-insensitively, and any `<lora:…>` tag the creator
 * pasted in is dropped — the app owns the tag, and echoing theirs would name a
 * file that is not on this disk.
 */
export function normalizeTriggerWords(raw: unknown): string[] {
  const flat: string[] = []
  const push = (s: unknown): void => {
    if (typeof s !== 'string') return
    for (const part of s.split(',')) {
      const w = part.trim()
      if (!w) continue
      if (/^<[^>]*>$/.test(w)) continue                    // a pasted <lora:…> tag
      flat.push(w.slice(0, 80))
    }
  }
  if (Array.isArray(raw)) for (const r of raw) push(r)
  else push(raw)
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of flat) {
    const k = w.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(w)
    if (out.length >= 20) break
  }
  return out
}

/** Validate + normalize one adapter row. Null (never throws) for anything that
 *  would poison the registry — identical policy to normalizeUserSdModel. */
export function normalizeUserSdAdapter(raw: unknown): UserSdAdapter | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (!isValidUserSdModelId(a.id)) return null
  if (!isAdapterKind(a.kind)) return null
  if (!isValidAdapterSlug(a.slug)) return null
  if (!isFamily(a.family)) return null
  const name = typeof a.name === 'string' ? a.name.trim().slice(0, 200) : ''
  if (!name) return null
  const file = normalizeFile(a.file)
  if (!file) return null
  const out: UserSdAdapter = { id: a.id, kind: a.kind, name, slug: a.slug, family: a.family, file }
  const words = normalizeTriggerWords(a.triggerWords)
  if (words.length > 0) out.triggerWords = words
  if (typeof a.defaultWeight === 'number' && Number.isFinite(a.defaultWeight)) {
    out.defaultWeight = Math.min(2, Math.max(-2, Math.round(a.defaultWeight * 100) / 100))
  }
  if (typeof a.notes === 'string' && a.notes.trim()) out.notes = a.notes.trim().slice(0, 400)
  const headers = normalizeHeaders(a.headers)
  if (headers) out.headers = headers
  if (a.requiresKey === true || headers) out.requiresKey = true
  const source = normalizeSource(a.source)
  if (source) out.source = source
  if (typeof a.addedAt === 'number' && Number.isFinite(a.addedAt)) out.addedAt = a.addedAt
  return out
}

/**
 * Map one CivitaiSearchRow onto an adapter row. FAILS CLOSED exactly like the
 * checkpoint mapper: an unmapped family, a refused container, or a type this
 * engine does not apply all THROW with a reason the install flow can show.
 */
export function userSdAdapterFromCivitaiRow(
  row: CivitaiRowLike & { type?: string },
  opts: { headers?: Record<string, string> } = {},
): UserSdAdapter {
  if (!row || typeof row !== 'object') throw new Error('civitai row: not an object')
  if (!Number.isFinite(row.versionId)) throw new Error('civitai row: versionId is required')
  const kind = adapterKindForCivitaiType(row.type)
  if (!kind) {
    throw new Error(`Refusing to register "${row.name || row.id}": ${row.type || 'this artifact type'} is not something this engine applies.`)
  }
  if (!row.family) {
    throw new Error(`Refusing to register "${row.name || row.id}": its base model (${row.baseModel || 'unknown'}) does not map to a family this engine runs.`)
  }
  if (isRefusedWeightFormat(row.format)) {
    throw new Error(`Refusing to register "${row.name || row.id}": ${row.format} weights are not supported (pickle formats execute code on load).`)
  }
  const id = civitaiModelId(row.versionId)
  const sha = typeof row.sha256 === 'string' && row.sha256 ? row.sha256.toLowerCase() : null
  const file: SdModelFile = {
    role:   'model',
    url:    row.downloadUrl,
    sha256: sha ?? shaPlaceholderFor(id),
    sizeMb: Number.isFinite(row.sizeMb) && row.sizeMb > 0 ? Math.ceil(row.sizeMb) : 1,
  }
  if (row.fileName) file.fileName = row.fileName
  if (row.format)   file.format   = row.format
  const out: UserSdAdapter = {
    id,
    kind,
    name:   row.name || id,
    // Hash-first when there is a hash; the version id is the stable fallback.
    slug:   adapterSlug(row.name || id, sha ?? String(row.versionId)),
    family: row.family,
    file,
    notes:  `Civitai · ${row.baseModel || row.family}`,
    ...(kind === 'lora' ? { defaultWeight: 1 } : {}),
    source: {
      kind: 'civitai', modelId: Math.trunc(row.modelId), versionId: Math.trunc(row.versionId),
      baseModel: row.baseModel ?? '',
      ...(row.license ? { license: row.license } : {}),
    },
    addedAt: Date.now(),
  }
  const words = normalizeTriggerWords(row.trainedWords)
  if (words.length > 0) {
    out.triggerWords = words
    if (out.source) out.source.trainedWords = words
  }
  const headers = normalizeHeaders(opts.headers)
  if (headers) { out.headers = headers; out.requiresKey = true }
  return out
}

// ─── The store ────────────────────────────────────────────────────────────────

export const USER_SD_MODELS_FILENAME = 'user-sd-models.json'

interface RegistryFile { version: 1; models: unknown[]; adapters?: unknown[] }

/**
 * File-backed registry. The path is INJECTED (cost-ledger's shape) so tests run
 * against a real temp file with no electron in sight.
 */
export class UserSdModelStore {
  private cache: { models: UserSdModel[]; adapters: UserSdAdapter[]; key: string } | null = null

  constructor(private readonly file: string) {}

  /** The registry file's path (diagnostics / tests). */
  path(): string { return this.file }

  /** Drop the in-memory cache (an external edit; tests). */
  invalidate(): void { this.cache = null }

  /** Parse both arrays once per file stamp. */
  private load(): { models: UserSdModel[]; adapters: UserSdAdapter[] } {
    const key = this.stamp()
    if (this.cache && this.cache.key === key) return this.cache
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(this.file, 'utf8')) }
    catch { this.cache = { models: [], adapters: [], key }; return this.cache }
    const doc = parsed as RegistryFile | null
    const models: UserSdModel[] = []
    if (Array.isArray(doc?.models)) {
      const seen = new Set<string>()
      for (const r of doc.models) {
        const m = normalizeUserSdModel(r)
        if (!m) { console.warn('[user-sd-models] dropping an invalid registry row'); continue }
        if (seen.has(m.id)) continue                 // first wins; a dup id would shadow itself
        seen.add(m.id)
        // A credential must never come back OUT of the file either: if an older
        // build (or a hand edit) wrote one, it is ignored here as well.
        delete m.headers
        models.push(m)
      }
    }
    const adapters: UserSdAdapter[] = []
    if (Array.isArray(doc?.adapters)) {
      const seenId = new Set<string>()
      const seenSlug = new Set<string>()
      for (const r of doc.adapters) {
        const a = normalizeUserSdAdapter(r)
        if (!a) { console.warn('[user-sd-models] dropping an invalid adapter row'); continue }
        if (seenId.has(a.id)) continue
        // A DUPLICATE SLUG is worse than a duplicate id: two rows would name the
        // same file on disk, so `<lora:slug:1>` would apply whichever landed
        // last. First wins, loudly.
        if (seenSlug.has(a.slug)) { console.warn(`[user-sd-models] adapter "${a.id}" repeats the on-disk slug "${a.slug}" — dropping it.`); continue }
        seenId.add(a.id); seenSlug.add(a.slug)
        delete a.headers
        adapters.push(a)
      }
    }
    this.cache = { models, adapters, key }
    return this.cache
  }

  /**
   * Every VALID row, in insertion order. Invalid rows are dropped with a
   * warning — a hand-edited or half-written file degrades to "that model is
   * missing", never to a throw that would take the curated registry down with it.
   */
  list(): UserSdModel[] {
    return this.load().models.map(m => ({ ...m }))
  }

  /** Every VALID adapter row, in insertion order. */
  listAdapters(): UserSdAdapter[] {
    return this.load().adapters.map(a => ({ ...a }))
  }

  /** One row by id, or undefined. */
  get(id: string): UserSdModel | undefined {
    return this.list().find(m => m.id === id)
  }

  /** One adapter by id, or undefined. */
  getAdapter(id: string): UserSdAdapter | undefined {
    return this.listAdapters().find(a => a.id === id)
  }

  /**
   * Add (or REPLACE, by id) one model. Throws a precise Error when the spec is
   * not registerable — the caller is a user-facing install flow and needs to
   * say why. Returns the row as PERSISTED (i.e. with `headers` stripped).
   */
  add(spec: UserSdModel): UserSdModel {
    const norm = normalizeUserSdModel(spec)
    if (!norm) throw new Error(`Refusing to register model "${String((spec as { id?: unknown } | null)?.id ?? '')}": the spec is not a valid sd.cpp model (id must be [a-z0-9-], every file needs an https url, a sha256 and a positive size).`)
    // RULE 1 (see the header): the secret never reaches the disk.
    const persisted: UserSdModel = { ...norm }
    delete persisted.headers
    if (norm.headers) persisted.requiresKey = true
    if (persisted.addedAt == null) persisted.addedAt = Date.now()
    const models = this.list()
    const at = models.findIndex(m => m.id === persisted.id)
    if (at >= 0) models[at] = persisted
    else models.push(persisted)
    this.write(models, this.listAdapters())
    return { ...persisted }
  }

  /**
   * Add (or REPLACE, by id) one adapter. Throws a precise Error when the spec is
   * not registerable. Returns the row as PERSISTED (headers stripped).
   */
  addAdapter(spec: UserSdAdapter): UserSdAdapter {
    const norm = normalizeUserSdAdapter(spec)
    if (!norm) throw new Error(`Refusing to register adapter "${String((spec as { id?: unknown } | null)?.id ?? '')}": the spec is not a valid sd.cpp adapter (id and slug must be [a-z0-9-], kind one of lora/embedding/vae, and the file needs an https url, a sha256 and a positive size).`)
    const persisted: UserSdAdapter = { ...norm }
    delete persisted.headers
    if (norm.headers) persisted.requiresKey = true
    if (persisted.addedAt == null) persisted.addedAt = Date.now()
    const adapters = this.listAdapters()
    // A slug held by a DIFFERENT id is a real collision: both would write the
    // same file. Refuse rather than silently shadowing the older install.
    const clash = adapters.find(a => a.slug === persisted.slug && a.id !== persisted.id)
    if (clash) throw new Error(`Refusing to register adapter "${persisted.id}": its on-disk name "${persisted.slug}" is already used by "${clash.id}".`)
    const at = adapters.findIndex(a => a.id === persisted.id)
    if (at >= 0) adapters[at] = persisted
    else adapters.push(persisted)
    this.write(this.list(), adapters)
    return { ...persisted }
  }

  /** Remove by id. Returns true when a row was actually removed. */
  remove(id: string): boolean {
    const models = this.list()
    const next = models.filter(m => m.id !== id)
    if (next.length === models.length) return false
    this.write(next, this.listAdapters())
    return true
  }

  /** Remove an adapter by id. Returns true when a row was actually removed. */
  removeAdapter(id: string): boolean {
    const adapters = this.listAdapters()
    const next = adapters.filter(a => a.id !== id)
    if (next.length === adapters.length) return false
    this.write(this.list(), next)
    return true
  }

  /** ATOMIC: full document to a sibling temp, then rename over the target. */
  private write(models: UserSdModel[], adapters: UserSdAdapter[]): void {
    const doc: RegistryFile = { version: 1, models, adapters }
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
      renameSync(tmp, this.file)                     // same directory ⇒ never EXDEV
    } catch (err) {
      try { rmSync(tmp, { force: true }) } catch { /* */ }
      throw err
    }
    this.cache = { models, adapters, key: this.stamp() }
  }

  /** Cheap change-stamp (mtime+size) so repeated reads do not re-parse. */
  private stamp(): string {
    try { const s = statSync(this.file); return `${s.mtimeMs}:${s.size}` } catch { return 'absent' }
  }
}

// ─── Electron-coupled singleton (lazy — vitest imports this module freely) ────

let singleton: UserSdModelStore | null = null

/** The app-wide store, rooted at `${userData}/user-sd-models.json`. */
export function getUserSdModelStore(): UserSdModelStore {
  if (!singleton) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    singleton = new UserSdModelStore(join(app.getPath('userData'), USER_SD_MODELS_FILENAME))
  }
  return singleton
}

/** Point the singleton at an explicit file (tests; a relocation). */
export function setUserSdModelStore(store: UserSdModelStore | null): void { singleton = store }

/**
 * Every user model — SOFT-FAILING by design.
 *
 * This is called from sd-cpp-models' allSdModels()/findSdModel(), i.e. from the
 * path that lists the CURATED models too. If an unreadable registry (or, in a
 * unit test, no electron at all) threw here, the local engine would report zero
 * models instead of the three it ships.
 */
export function listUserSdModels(): UserSdModel[] {
  try { return getUserSdModelStore().list() } catch { return [] }
}

/** Register (or replace) a user model. Throws on an invalid spec. */
export function addUserSdModel(spec: UserSdModel): UserSdModel {
  return getUserSdModelStore().add(spec)
}

/** Remove a user model from the registry (the weights are removed separately). */
export function removeUserSdModel(id: string): boolean {
  try { return getUserSdModelStore().remove(id) } catch { return false }
}

/** True when `id` belongs to the user registry rather than a curated row. */
export function isUserSdModelId(id: string): boolean {
  return listUserSdModels().some(m => m.id === id)
}

/** Every registered adapter — SOFT-FAILING, same reason as listUserSdModels. */
export function listUserSdAdapters(): UserSdAdapter[] {
  try { return getUserSdModelStore().listAdapters() } catch { return [] }
}

/** Register (or replace) an adapter. Throws on an invalid spec / slug clash. */
export function addUserSdAdapter(spec: UserSdAdapter): UserSdAdapter {
  return getUserSdModelStore().addAdapter(spec)
}

/** Remove an adapter from the registry (the weights are removed separately). */
export function removeUserSdAdapter(id: string): boolean {
  try { return getUserSdModelStore().removeAdapter(id) } catch { return false }
}
