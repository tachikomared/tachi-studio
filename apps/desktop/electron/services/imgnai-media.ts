// apps/desktop/electron/services/imgnai-media.ts
//
// imgnAI Katana MEDIA engine (image + video) — kat.imgnai.com. Mirrors
// venice-media-service.ts in shape: a standalone service the Media tab calls
// through a typed IPC router (electron/ipc/imgnai-media.ipc.ts).
//
// Auth: the SAME keychain entry as the 'imgnai' TEXT provider holds a COMBINED
// "api_key:api_secret" credential; the media endpoints want it SPLIT into
// `X-API-Key` / `X-API-Secret` headers (split on the FIRST ':' —
// imgnai-media-core.ts). HTTPS only.
//
// Endpoints (per https://kat.imgnai.com/llms.txt):
//   image  POST /v1/images/generations?wait=false → { request_id, … }
//   video  POST /v1/videos/generations?wait=false → { request_id, … }
//   poll   GET  /v1/generation-requests/{request_id}  (same auth) until
//          status ∈ completed | partial_failure | failed, honoring
//          poll_after_seconds (default ~5s). Wall-clock deadline: 600s image /
//          6000s video. Output asset URLs are SIGNED AND EXPIRE — download to
//          <storage root>/Media/<request_id>/<index>.<ext> immediately.
//   models GET /v1/models (same auth) — best-effort catalog enrichment over
//          the static lists; NEVER blocks the picker.
//
// The poll loop lives HERE (main), pushing 'imgnai:gen-progress' events to all
// windows (same broadcast style as agent-runtime.store / download-manager) so
// the renderer shows live progress while the router promise stays pending.
//
// Egress: 'imgnai' is classified cloud (egress-policy.ts) → PRIVATE MODE
// blocks generation and catalog calls here.

import { BrowserWindow } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { retrieveKey } from './keychain'
import { enforceProviderEgress } from './egress-policy'
import { writeStorageFile } from './storage-root'
import {
  IMGNAI_CREDENTIAL_HINT,
  splitImgnaiCredential,
  imgnaiStaticModels,
  parseImgnaiMediaCatalog,
  parseImgnaiTextCatalog,
  coerceImgnaiAspectRatio,
  coerceImgnaiOutputFormat,
  parseImgnaiPoll,
  isImgnaiTerminal,
  pickImgnaiOutcome,
  type ImgnaiCredentials,
  type ImgnaiModelInfo,
  type ImgnaiAsset,
  type ImgnaiPollState,
} from './imgnai-media-core'

const IMGNAI_BASE = 'https://kat.imgnai.com'
const CATALOG_TTL_MS = 60_000
/** Wall-clock polling deadlines per llms.txt. */
const IMAGE_DEADLINE_MS = 600_000     // 600 s
const VIDEO_DEADLINE_MS = 6_000_000   // 6000 s
/** Per-request fetch timeout (submit / poll / asset download). */
const FETCH_TIMEOUT_MS = 60_000

// Same Artifact shape as surplus-media-service / venice-media-service so the
// renderer gallery + IPC schemas stay identical across providers.
export interface ImgnaiArtifact {
  kind:     'image' | 'audio' | 'video' | 'text'
  mimeType: string
  path?:    string
  b64?:     string
  text?:    string
}

export interface ImgnaiGenerateImageInput {
  model:         string
  prompt:        string
  aspectRatio?:  string
  outputFormat?: string
  /** Optional reference images (https or data: URLs). */
  imageUrls?:    string[]
  isUhd?:        boolean
  isFast?:       boolean
  /** Copy finished artifacts here as well (Media tab auto-save folder). */
  autoSaveDir?:  string
}

export interface ImgnaiGenerateVideoInput {
  model:                string
  prompt:               string
  durationSeconds?:     number
  aspectRatio?:         string
  /** Optional first frame (image→video), https or data: URL. */
  firstFrameImageUrl?:  string
  autoSaveDir?:         string
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireImgnaiCredentials(): ImgnaiCredentials {
  const creds = splitImgnaiCredential(retrieveKey('imgnai'))
  if (!creds) throw new Error(IMGNAI_CREDENTIAL_HINT)
  return creds
}

function mediaHeaders(creds: ImgnaiCredentials, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-API-Key':       creds.apiKey,
    'X-API-Secret':    creds.apiSecret,
    'Accept-Encoding': 'identity',
    ...extra,
  }
}

async function toImgnaiError(res: Response): Promise<Error> {
  const bodyText = await res.text().catch(() => '')
  let message = bodyText
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string; detail?: string }
    message = (typeof j.error === 'object' ? j.error?.message : j.error) || j.message || j.detail || bodyText
  } catch { /* keep raw text */ }
  if (res.status === 401 || res.status === 403) {
    return new Error(`imgnAI auth failed (${res.status}). ${IMGNAI_CREDENTIAL_HINT}. ${message}`.trim())
  }
  return new Error(`imgnAI HTTP ${res.status}: ${message || res.statusText}`)
}

// ── Disk helpers (same layout as the other media services) ────────────────────

/**
 * writeStorageFile, not a bare writeFileSync: a storage root that turned
 * unwritable mid-session (Defender Controlled Folder Access on Documents —
 * LANE J/L) is re-probed once and the write retried against the healed root.
 * Returns the path ACTUALLY written (what the renderer serves/reveals).
 */
function writeBytes(jobId: string, index: number, bytes: Uint8Array, ext: string): string {
  const safe = jobId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'job'
  return writeStorageFile('media', join(safe, `${index}.${ext}`), bytes)
}

function copyToDir(srcPath: string, destDir: string): void {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  const base = srcPath.split(/[\\/]/).pop() || 'artifact'
  copyFileSync(srcPath, join(destDir, base))
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}

function extFor(mime: string, fallback: string): string {
  return EXT_BY_MIME[mime.split(';')[0].trim().toLowerCase()] ?? fallback
}

// ── Progress push (main → renderer, 'imgnai:gen-progress') ────────────────────

export interface ImgnaiGenProgress {
  requestId:  string
  kind:       'image' | 'video'
  /** queued | processing | completed | partial_failure | failed | downloading */
  status:     string
  elapsedSec: number
}

function pushGenProgress(p: ImgnaiGenProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue
    w.webContents.send('imgnai:gen-progress', p)
  }
}

// ── Models (live catalog first, static snapshot as offline fallback) ──────────

let liveCatalogBody: { at: number; body: unknown } | null = null

/**
 * Best-effort GET /v1/models (answers keyless; credentials attached when
 * present). Katana's response is NOT OpenAI-shaped — it is
 * { images: [...], videos: [...], text: [...] } with `public_model_name` as
 * the only valid request id (parsed by imgnai-media-core). Any failure → null.
 */
async function fetchLiveCatalogBody(): Promise<unknown> {
  if (liveCatalogBody && Date.now() - liveCatalogBody.at < CATALOG_TTL_MS) return liveCatalogBody.body
  try {
    const creds = splitImgnaiCredential(retrieveKey('imgnai'))
    const res = await fetch(`${IMGNAI_BASE}/v1/models`, {
      headers: creds ? mediaHeaders(creds) : { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000) as AbortSignal,
    })
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    if (body) liveCatalogBody = { at: Date.now(), body }
    return body
  } catch {
    return null   // NEVER block the picker on the live catalog
  }
}

export async function listImgnaiMediaModels(
  modality: 'image' | 'video',
): Promise<{ ok: boolean; models: ImgnaiModelInfo[]; error?: string }> {
  enforceProviderEgress('imgnai')
  // LIVE list wins outright when reachable — the static snapshot can go stale
  // and a stale id is a hard "no such model" at submit time.
  const live = parseImgnaiMediaCatalog(await fetchLiveCatalogBody()).filter(m => m.modality === modality)
  if (live.length > 0) return { ok: true, models: live }
  return { ok: true, models: [...imgnaiStaticModels(modality)] }
}

/** TEXT models for the chat / CODE / node pickers — live list, [] offline.
 *  Rows carry `contextTokens` only when Katana published one for that model. */
export async function listImgnaiTextModels(): Promise<Array<{ id: string; label: string; contextTokens?: number }>> {
  enforceProviderEgress('imgnai')
  return parseImgnaiTextCatalog(await fetchLiveCatalogBody())
}

// ── Submit + poll (shared by image/video) ─────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * POST the generation, then poll GET /v1/generation-requests/{id} until a
 * terminal status or the wall-clock deadline. Progress is pushed on
 * 'imgnai:gen-progress' every submit/poll tick. Returns the terminal state.
 */
async function submitAndPoll(
  kind: 'image' | 'video',
  path: string,
  body: Record<string, unknown>,
  creds: ImgnaiCredentials,
  deadlineMs: number,
): Promise<ImgnaiPollState> {
  const res = await fetch(`${IMGNAI_BASE}${path}?wait=false`, {
    method:  'POST',
    headers: mediaHeaders(creds, { 'Content-Type': 'application/json', Accept: 'application/json' }),
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS) as AbortSignal,
  })
  if (!res.ok) throw await toImgnaiError(res)

  const startedAt = Date.now()
  let state = parseImgnaiPoll(await res.json().catch(() => null))
  const requestId = state.requestId
  if (!requestId) throw new Error(`imgnAI ${kind} submit returned no request_id`)

  pushGenProgress({ requestId, kind, status: 'queued', elapsedSec: 0 })

  while (!isImgnaiTerminal(state.status)) {
    if (Date.now() - startedAt > deadlineMs) {
      pushGenProgress({ requestId, kind, status: 'failed', elapsedSec: elapsed(startedAt) })
      throw new Error(
        `imgnAI ${kind} generation timed out after ${Math.round(deadlineMs / 1000)}s — request ${requestId} may still complete on imgnAI's side.`,
      )
    }
    await delay(state.pollAfterSeconds * 1000)
    // Same-instant gate before EVERY poll: the mode can flip while the job
    // runs server-side, and no cloud request may begin after the flip. (The
    // surplus poll loop has the same per-poll gate — this is the shared rule.)
    enforceProviderEgress('imgnai')
    const poll = await fetch(`${IMGNAI_BASE}/v1/generation-requests/${encodeURIComponent(requestId)}`, {
      headers: mediaHeaders(creds, { Accept: 'application/json' }),
      signal:  AbortSignal.timeout(FETCH_TIMEOUT_MS) as AbortSignal,
    })
    if (!poll.ok) throw await toImgnaiError(poll)
    state = parseImgnaiPoll(await poll.json().catch(() => null))
    if (!state.requestId) state.requestId = requestId
    pushGenProgress({
      requestId, kind,
      status: isImgnaiTerminal(state.status) ? state.status : 'processing',
      elapsedSec: elapsed(startedAt),
    })
  }
  return state
}

function elapsed(startedAt: number): number {
  return Math.round((Date.now() - startedAt) / 1000)
}

/**
 * Download an asset URL (SIGNED — expires!) to disk; return the Artifact.
 *
 * Gated on entry, not just by the poll loop that led here: the last poll's
 * own gate check covers ITS fetch, but this is a DIFFERENT request that has
 * not started yet — the job finishing server-side and the mode flipping can
 * land in the same instant. Unlike the poll fetch already in flight (which
 * cannot be un-sent and is left to finish, same as pollinations' single GET),
 * this one has not been dispatched at all, so THE RULE still applies: no
 * cloud request may BEGIN without a same-instant check. A signed asset URL
 * that expires before the user re-opens the mode is the cost of that; it is
 * cheaper than an image quietly downloading while PRIVATE MODE reads on.
 */
async function downloadAsset(
  asset: ImgnaiAsset,
  requestId: string,
  index: number,
  kind: 'image' | 'video',
  fallbackMime: string,
  fallbackExt: string,
): Promise<ImgnaiArtifact> {
  enforceProviderEgress('imgnai')
  const res = await fetch(asset.url, {
    headers:  { 'Accept-Encoding': 'identity' },
    redirect: 'follow',
    signal:   AbortSignal.timeout(FETCH_TIMEOUT_MS * (kind === 'video' ? 5 : 1)) as AbortSignal,
  })
  if (!res.ok) throw new Error(`imgnAI asset download failed (HTTP ${res.status}) — the signed URL may have expired.`)
  const mime  = res.headers.get('content-type')?.split(';')[0].trim() || fallbackMime
  const bytes = new Uint8Array(await res.arrayBuffer())
  const path  = writeBytes(requestId, index, bytes, extFor(mime, fallbackExt))
  const small = kind === 'image' && bytes.byteLength <= 512 * 1024
  return {
    kind,
    mimeType: mime,
    path,
    ...(small ? { b64: Buffer.from(bytes).toString('base64') } : {}),
  }
}

/** Terminal state → downloaded artifacts (throws the verbatim-ish API error on failure). */
async function settleToArtifacts(
  state: ImgnaiPollState,
  kind: 'image' | 'video',
  fallbackMime: string,
  fallbackExt: string,
  autoSaveDir?: string,
): Promise<{ artifacts: ImgnaiArtifact[] }> {
  const outcome = pickImgnaiOutcome(state)
  if ('error' in outcome) throw new Error(outcome.error)
  const requestId = state.requestId ?? `imgnai-${Date.now()}`
  pushGenProgress({ requestId, kind, status: 'downloading', elapsedSec: 0 })
  const artifacts: ImgnaiArtifact[] = []
  for (let i = 0; i < outcome.assets.length; i++) {
    artifacts.push(await downloadAsset(outcome.assets[i], requestId, i, kind, fallbackMime, fallbackExt))
  }
  if (autoSaveDir) {
    for (const a of artifacts) if (a.path) copyToDir(a.path, autoSaveDir)
  }
  return { artifacts }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function imgnaiGenerateImage(input: ImgnaiGenerateImageInput): Promise<{ artifacts: ImgnaiArtifact[] }> {
  enforceProviderEgress('imgnai')
  const creds = requireImgnaiCredentials()
  const format = coerceImgnaiOutputFormat(input.outputFormat)
  const body: Record<string, unknown> = {
    model:         input.model,
    prompt:        input.prompt,
    aspect_ratio:  coerceImgnaiAspectRatio(input.aspectRatio),
    output_format: format,
  }
  const refs = (input.imageUrls ?? []).filter(u => typeof u === 'string' && u.trim()).map(u => u.trim())
  if (refs.length > 0) body.image_urls = refs
  if (typeof input.isUhd  === 'boolean') body.is_uhd  = input.isUhd
  if (typeof input.isFast === 'boolean') body.is_fast = input.isFast

  const state = await submitAndPoll('image', '/v1/images/generations', body, creds, IMAGE_DEADLINE_MS)
  return settleToArtifacts(state, 'image', `image/${format === 'jpeg' ? 'jpeg' : format}`, format === 'jpeg' ? 'jpg' : format, input.autoSaveDir)
}

export async function imgnaiGenerateVideo(input: ImgnaiGenerateVideoInput): Promise<{ artifacts: ImgnaiArtifact[] }> {
  enforceProviderEgress('imgnai')
  const creds = requireImgnaiCredentials()
  const body: Record<string, unknown> = {
    model:  input.model,
    prompt: input.prompt,
  }
  // Video: only send a CONCRETE allowed ratio ('auto' is documented for image
  // only) — anything else is omitted so the model's own default applies.
  const ratio = coerceImgnaiAspectRatio(input.aspectRatio)
  if (ratio !== 'auto') body.aspect_ratio = ratio
  if (typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0) {
    body.duration_seconds = Math.round(input.durationSeconds)
  }
  if (typeof input.firstFrameImageUrl === 'string' && input.firstFrameImageUrl.trim()) {
    body.video_image_data = { first_frame_image_url: input.firstFrameImageUrl.trim() }
  }

  const state = await submitAndPoll('video', '/v1/videos/generations', body, creds, VIDEO_DEADLINE_MS)
  return settleToArtifacts(state, 'video', 'video/mp4', 'mp4', input.autoSaveDir)
}
