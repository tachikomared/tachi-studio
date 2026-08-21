// apps/desktop/electron/services/imgnai-media-core.ts
//
// PURE helpers for the imgnAI Katana media engine (kat.imgnai.com) — no
// electron imports so these are unit-testable directly (see
// test/unit/imgnaiMedia.test.ts). The IO half lives in imgnai-media.ts.
//
// Credential model: the SAME keychain entry as the 'imgnai' TEXT provider
// holds a COMBINED "api_key:api_secret" string — the Settings card shows two
// separate fields (API key / API secret) and joins them on save. Text auth
// uses it whole as a Bearer; the media endpoints need it SPLIT into
// X-API-Key / X-API-Secret headers — split on the FIRST ':' only (secrets may
// themselves contain ':').

import { pickLiveContextTokens } from '@tachi/core'

// ── Credential split ──────────────────────────────────────────────────────────

/** The one canonical "fix your key" message (also thrown by the service). */
export const IMGNAI_CREDENTIAL_HINT =
  'Image & video need both the imgnAI API key AND API secret — fill in both fields in Settings → imgnAI Katana (from app.imgnai.com/katana-api)'

export interface ImgnaiCredentials {
  apiKey:    string
  apiSecret: string
}

/**
 * Split the combined "api_key:api_secret" credential on the FIRST ':'.
 * Returns null when the input is missing/blank, has no ':', or either half is
 * empty — the caller surfaces IMGNAI_CREDENTIAL_HINT.
 */
export function splitImgnaiCredential(raw: string | null | undefined): ImgnaiCredentials | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  const idx = trimmed.indexOf(':')
  if (idx <= 0) return null                 // no ':' or empty key part
  const apiKey    = trimmed.slice(0, idx).trim()
  const apiSecret = trimmed.slice(idx + 1).trim()
  if (!apiKey || !apiSecret) return null
  return { apiKey, apiSecret }
}

// ── Static model catalogs (fallback; live /v1/models may enrich) ──────────────

export interface ImgnaiModelInfo {
  id:       string
  label:    string
  modality: 'image' | 'video'
  live:     boolean
  /** Video models: the clip length the model produces (informational). */
  durationSeconds?: number
}

// OFFLINE-FALLBACK catalogs — a snapshot of GET /v1/models `public_model_name`
// ids (2026-07-14). The llms.txt shorthand names ("seedance-2", "google-omni")
// are NOT valid request ids — submitting one returns "no such model". When the
// endpoint is reachable (it answers keyless) the LIVE catalog replaces these.
export const IMGNAI_IMAGE_MODELS: ImgnaiModelInfo[] = [
  { id: 'pink-image',    label: 'Pink Image (default)', modality: 'image', live: false },
  { id: 'gpt-image-2',   label: 'GPT Image 2',          modality: 'image', live: false },
  { id: 'nano-banana-2', label: 'Nano Banana 2',        modality: 'image', live: false },
  { id: 'anima-base',    label: 'Anima',                modality: 'image', live: false },
  { id: 'anima-pink',    label: 'Anima Pink',           modality: 'image', live: false },
  { id: 'flux-2-pro',    label: 'FLUX 2 Pro',           modality: 'image', live: false },
]

export const IMGNAI_VIDEO_MODELS: ImgnaiModelInfo[] = [
  { id: 'seedance-2-0',           label: 'Seedance 2.0 (default)',  modality: 'video', live: false, durationSeconds: 5 },
  { id: 'seedance-2-0-mini',      label: 'Seedance 2.0 Mini',       modality: 'video', live: false, durationSeconds: 5 },
  { id: 'seedance-2-0-mini-480p', label: 'Seedance 2.0 Mini 480p',  modality: 'video', live: false, durationSeconds: 5 },
  { id: 'seedance-2-0-fast',      label: 'Seedance 2.0 Fast',       modality: 'video', live: false, durationSeconds: 5 },
  { id: 'gemini-omni',            label: 'Gemini Omni',             modality: 'video', live: false },
  { id: 'happy-horse-1-0-720p',   label: 'Happy Horse 1.0 720p',    modality: 'video', live: false },
  { id: 'wan-2-7-720p',           label: 'Wan 2.7 720p',            modality: 'video', live: false },
  { id: 'veo3-1',                 label: 'Veo 3.1',                 modality: 'video', live: false },
]

export function imgnaiStaticModels(modality: 'image' | 'video'): ImgnaiModelInfo[] {
  return modality === 'video' ? IMGNAI_VIDEO_MODELS : IMGNAI_IMAGE_MODELS
}

// ── Live /v1/models parsing ───────────────────────────────────────────────────
// Katana's catalog is NOT OpenAI-shaped: { images: [...], videos: [...],
// text: [...], text_pricing } where each entry carries `public_model_name`
// (the ONLY valid request id) and `display_name`. Pure + testable.

interface ImgnaiCatalogEntry {
  public_model_name?: unknown
  display_name?: unknown
}

function catalogEntries(raw: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ id: string; label: string }> = []
  for (const item of raw as ImgnaiCatalogEntry[]) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.public_model_name === 'string' ? item.public_model_name.trim() : ''
    if (!id) continue
    const label = typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim() : id
    out.push({ id, label })
  }
  return out
}

/** Parse the media (image + video) sections of a GET /v1/models body. */
export function parseImgnaiMediaCatalog(body: unknown): ImgnaiModelInfo[] {
  if (body === null || typeof body !== 'object') return []
  const b = body as { images?: unknown; videos?: unknown }
  return [
    ...catalogEntries(b.images).map(e => ({ ...e, modality: 'image' as const, live: true })),
    ...catalogEntries(b.videos).map(e => ({ ...e, modality: 'video' as const, live: true })),
  ]
}

/**
 * Parse the TEXT section of a GET /v1/models body (chat/code model pickers).
 *
 * `contextTokens` is carried through ONLY when Katana publishes a window for the
 * row (pickLiveContextTokens knows the spellings gateways use). Absent means
 * UNKNOWN — the caller falls back to the static capability rows rather than
 * substituting a number. Media rows don't get this: a diffusion model has no
 * context window.
 */
export function parseImgnaiTextCatalog(body: unknown): Array<{ id: string; label: string; contextTokens?: number }> {
  if (body === null || typeof body !== 'object') return []
  const raw = (body as { text?: unknown }).text
  const rows = Array.isArray(raw) ? raw : []
  const byId = new Map<string, number>()
  for (const item of rows) {
    if (item === null || typeof item !== 'object') continue
    const id = (item as ImgnaiCatalogEntry).public_model_name
    const ctx = pickLiveContextTokens(item)
    if (typeof id === 'string' && id.trim() && ctx !== undefined) byId.set(id.trim(), ctx)
  }
  return catalogEntries(raw).map(e => {
    const ctx = byId.get(e.id)
    return ctx === undefined ? e : { ...e, contextTokens: ctx }
  })
}

// ── Request-param coercion ─────────────────────────────────────────────────────

/** The aspect ratios Katana accepts (image AND video). */
export const IMGNAI_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '21:9', 'auto'] as const
export type ImgnaiAspectRatio = (typeof IMGNAI_ASPECT_RATIOS)[number]

/**
 * Coerce a schema-driven aspect_ratio to one Katana accepts. Unknown / missing
 * values fall back to 'auto' (the API's own "let the model choose").
 */
export function coerceImgnaiAspectRatio(value: unknown): ImgnaiAspectRatio {
  return typeof value === 'string' && (IMGNAI_ASPECT_RATIOS as readonly string[]).includes(value)
    ? value as ImgnaiAspectRatio
    : 'auto'
}

export const IMGNAI_OUTPUT_FORMATS = ['png', 'jpeg', 'webp'] as const

export function coerceImgnaiOutputFormat(value: unknown): 'png' | 'jpeg' | 'webp' {
  return typeof value === 'string' && (IMGNAI_OUTPUT_FORMATS as readonly string[]).includes(value)
    ? value as 'png' | 'jpeg' | 'webp'
    : 'png'
}

// ── Poll-response parsing ──────────────────────────────────────────────────────
//
// Submit (POST …?wait=false) and poll (GET /v1/generation-requests/{id}) share
// one envelope:
//   { request_id, status, poll_after_seconds,
//     responses: [ { status, output_assets: [ { url, width, height, expires_at,
//                    thumbnail_silent_video_mp4_url?, duration_seconds? } ],
//                    error } ] }
// Terminal statuses: completed | partial_failure | failed. Everything else
// (queued / processing / …) is 'pending'. Parsed leniently — missing fields
// never throw.

export interface ImgnaiAsset {
  url:               string
  width?:            number
  height?:           number
  /** Video assets: clip length reported by the API. */
  durationSeconds?:  number
  /** Video assets: silent MP4 thumbnail preview. */
  thumbnailVideoUrl?: string
  /** ISO timestamp — the signed URL EXPIRES; download immediately. */
  expiresAt?:        string
}

export interface ImgnaiPollState {
  requestId?:        string
  status:            'pending' | 'completed' | 'partial_failure' | 'failed'
  /** Seconds the API asks us to wait before the next poll (default 5). */
  pollAfterSeconds:  number
  assets:            ImgnaiAsset[]
  /** Verbatim-ish per-response error strings (surfaced to the user). */
  errors:            string[]
}

const TERMINAL_STATUSES = new Set(['completed', 'partial_failure', 'failed'])

export function isImgnaiTerminal(status: ImgnaiPollState['status']): boolean {
  return TERMINAL_STATUSES.has(status)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

function numberOr(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Stringify a response `error` field verbatim-ish (string | {message} | other). */
function errorText(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.trim() || null
  const rec = asRecord(v)
  if (rec && typeof rec.message === 'string' && rec.message.trim()) return rec.message.trim()
  try { return JSON.stringify(v) } catch { return String(v) }
}

/** Parse one output_assets[] entry; null when it has no usable url. */
function parseAsset(v: unknown): ImgnaiAsset | null {
  const rec = asRecord(v)
  if (!rec || typeof rec.url !== 'string' || !rec.url.trim()) return null
  const asset: ImgnaiAsset = { url: rec.url.trim() }
  const width  = numberOr(rec.width)
  const height = numberOr(rec.height)
  const dur    = numberOr(rec.duration_seconds)
  if (width  !== undefined) asset.width = width
  if (height !== undefined) asset.height = height
  if (dur    !== undefined) asset.durationSeconds = dur
  if (typeof rec.thumbnail_silent_video_mp4_url === 'string' && rec.thumbnail_silent_video_mp4_url) {
    asset.thumbnailVideoUrl = rec.thumbnail_silent_video_mp4_url
  }
  if (typeof rec.expires_at === 'string' && rec.expires_at) asset.expiresAt = rec.expires_at
  return asset
}

/**
 * Parse a submit/poll envelope into a normalized ImgnaiPollState. Never throws:
 * a malformed body parses to { status: 'pending', assets: [], errors: [] } so
 * the caller's deadline (not a crash) ends the loop.
 */
export function parseImgnaiPoll(json: unknown): ImgnaiPollState {
  const rec = asRecord(json)
  const state: ImgnaiPollState = { status: 'pending', pollAfterSeconds: 5, assets: [], errors: [] }
  if (!rec) return state

  if (typeof rec.request_id === 'string' && rec.request_id) state.requestId = rec.request_id

  const raw = typeof rec.status === 'string' ? rec.status.toLowerCase() : ''
  if (TERMINAL_STATUSES.has(raw)) state.status = raw as ImgnaiPollState['status']

  const wait = numberOr(rec.poll_after_seconds)
  if (wait !== undefined && wait > 0) state.pollAfterSeconds = Math.min(30, Math.max(1, wait))

  const responses = Array.isArray(rec.responses) ? rec.responses : []
  for (const r of responses) {
    const rr = asRecord(r)
    if (!rr) continue
    const err = errorText(rr.error)
    if (err) state.errors.push(err)
    const assets = Array.isArray(rr.output_assets) ? rr.output_assets : []
    for (const a of assets) {
      const parsed = parseAsset(a)
      if (parsed) state.assets.push(parsed)
    }
  }
  return state
}

/**
 * Decide the outcome of a TERMINAL poll state: assets to download, or the
 * error to throw. partial_failure WITH assets still succeeds (errors are
 * carried alongside); zero assets on any terminal status is a failure whose
 * message quotes the API's responses[].error verbatim-ish.
 */
export function pickImgnaiOutcome(state: ImgnaiPollState): { assets: ImgnaiAsset[] } | { error: string } {
  if (state.status === 'failed' || state.assets.length === 0) {
    return { error: state.errors.join('; ') || `imgnAI generation ${state.status === 'failed' ? 'failed' : 'returned no assets'}` }
  }
  return { assets: state.assets }
}
