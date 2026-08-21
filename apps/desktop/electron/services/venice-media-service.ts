// apps/desktop/electron/services/venice-media-service.ts
//
// STANDALONE Venice media engine — image / TTS / STT / video / music. Talks to
// api.venice.ai DIRECTLY on the user's Venice key (retrieveKey('venice')).
// Completely independent of Surplus. Shapes per Venice's OpenAPI spec:
//   image  POST /images/generations    sync       → { data:[{b64_json|url}] }
//   tts    POST /audio/speech           sync       → binary audio
//   stt    POST /audio/transcriptions   multipart  → { text }
//   video  POST /video/queue → poll POST /video/retrieve
//            queue → { model, queue_id, download_url? }
//            retrieve → JSON { status: PROCESSING|COMPLETED, … } while running,
//                       then `video/mp4` binary (or fetch download_url) when done
//   music  POST /audio/queue → poll POST /audio/retrieve   (same lifecycle)
//   models GET /models?type=image|tts|asr|video|music
//
// Egress: 'venice' is classified cloud → PRIVATE MODE blocks all media here.
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { retrieveKey } from './keychain'
import { enforceProviderEgress } from './egress-policy'
import { writeStorageFile } from './storage-root'

const VENICE_BASE      = 'https://api.venice.ai/api/v1'
const CACHE_TTL_MS     = 60_000
const POLL_TIMEOUT_MS  = 5 * 60_000
const POLL_INTERVAL_MS = 3_000

export type VeniceMediaModality = 'image' | 'tts' | 'stt' | 'video' | 'music'

// MediaPage modality → Venice catalog `type`. Venice uses 'asr' for stt.
const TYPE_FOR: Record<VeniceMediaModality, string> = {
  image: 'image', tts: 'tts', stt: 'asr', video: 'video', music: 'music',
}

export interface VeniceMediaModel {
  id:       string
  label:    string
  modality: VeniceMediaModality
  live:     boolean
}

export interface VeniceArtifact {
  kind:     'image' | 'audio' | 'video' | 'text'
  mimeType: string
  path?:    string
  b64?:     string
  text?:    string
}

function requireKey(): string {
  const k = retrieveKey('venice')
  if (!k) throw new Error('No Venice key configured — add one in Settings → Venice.')
  return k
}

function jsonHeaders(accept = 'application/json'): Record<string, string> {
  return {
    'Content-Type':    'application/json',
    Accept:            accept,
    'Accept-Encoding': 'identity',
    Authorization:     `Bearer ${requireKey()}`,
  }
}

/**
 * writeStorageFile, not a bare writeFileSync: when the cached storage root has
 * gone unwritable mid-session (Defender Controlled Folder Access on Documents —
 * LANE J/L) it re-probes the fallback chain once and retries, so a generated
 * artifact lands somewhere real instead of dying on a raw ENOENT. The returned
 * path is what the renderer serves/reveals, so it must be the path ACTUALLY
 * written — which may sit under a healed root.
 */
function writeBytes(jobId: string, index: number, bytes: Uint8Array, ext: string): string {
  return writeStorageFile('media', join(jobId, `${index}.${ext}`), bytes)
}

async function toError(res: Response): Promise<Error> {
  const t = await res.text().catch(() => '')
  return new Error(`Venice error ${res.status}: ${t.slice(0, 200)}`)
}

/** Merge schema-driven extras defensively (typed fields already on body win). */
function mergeExtras(body: Record<string, unknown>, params?: Record<string, unknown>): void {
  if (!params) return
  for (const [k, v] of Object.entries(params)) {
    if (k in body || k === 'model') continue
    if (v === undefined || v === null || v === '') continue
    body[k] = v
  }
}

// ── Models ────────────────────────────────────────────────────────────────────
const catalog = new Map<string, { at: number; models: VeniceMediaModel[] }>()

export async function listVeniceMediaModels(
  modality: VeniceMediaModality,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; models: VeniceMediaModel[]; error?: string }> {
  enforceProviderEgress('venice')
  const type = TYPE_FOR[modality]
  const c = catalog.get(type)
  if (!opts.force && c && Date.now() - c.at < CACHE_TTL_MS) return { ok: true, models: c.models }
  const k = retrieveKey('venice')
  try {
    const headers: Record<string, string> = { 'Accept-Encoding': 'identity' }
    if (k) headers.Authorization = `Bearer ${k}`
    const res = await fetch(`${VENICE_BASE}/models?type=${type}`, {
      headers, signal: AbortSignal.timeout(8_000) as AbortSignal,
    })
    if (!res.ok) throw await toError(res)
    const body = await res.json() as { data?: Array<{ id?: string; name?: string }> }
    const models = (body.data ?? [])
      .filter((m): m is { id: string; name?: string } => typeof m.id === 'string' && m.id.length > 0)
      .map(m => ({ id: m.id, label: m.name || m.id, modality, live: true }))
    catalog.set(type, { at: Date.now(), models })
    return { ok: true, models }
  } catch (e) {
    return { ok: true, models: [], error: e instanceof Error ? e.message : String(e) }
  }
}

// ── Image (sync) ────────────────────────────────────────────────────────────────
// ── Per-model constraints (capability-aware param selection) ───────────────────
// Venice video/audio params are PER-MODEL: /models exposes model_spec.constraints
// with the aspect_ratios / resolutions / durations a model supports (empty array =
// the model rejects that param; non-empty usually means it's REQUIRED). We read
// these so we send a VALID value the model accepts — fixes both "X is required"
// and "this model does not support X" 400s. Cached 5 min per type.
const specCache = new Map<string, { at: number; byId: Map<string, Record<string, unknown>> }>()

async function veniceModelConstraints(
  type: 'video' | 'music',
  modelId: string,
): Promise<{ aspectRatios: string[]; resolutions: string[]; durations: string[] }> {
  const empty = { aspectRatios: [] as string[], resolutions: [] as string[], durations: [] as string[] }
  const key = retrieveKey('venice')
  if (!key) return empty
  let cached = specCache.get(type)
  if (!cached || Date.now() - cached.at > 5 * 60_000) {
    try {
      const res = await fetch(`${VENICE_BASE}/models?type=${type}`, {
        headers: { Authorization: `Bearer ${key}`, 'Accept-Encoding': 'identity' },
        signal: AbortSignal.timeout(8_000) as AbortSignal,
      })
      if (!res.ok) return empty
      const body = await res.json() as { data?: Array<{ id?: string; model_spec?: { constraints?: Record<string, unknown> } }> }
      const byId = new Map<string, Record<string, unknown>>()
      for (const m of body.data ?? []) {
        if (typeof m.id === 'string') byId.set(m.id, (m.model_spec?.constraints ?? {}) as Record<string, unknown>)
      }
      cached = { at: Date.now(), byId }
      specCache.set(type, cached)
    } catch {
      return empty
    }
  }
  const c = (cached.byId.get(modelId) ?? {}) as Record<string, unknown>
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  // Venice uses both camelCase (image models) and snake_case (video/audio) shapes.
  return {
    aspectRatios: arr(c.aspect_ratios ?? c.aspectRatios),
    resolutions:  arr(c.resolutions),
    durations:    arr(c.durations),
  }
}

export async function veniceGenerateImage(input: {
  model: string; prompt: string; size?: string; n?: number; params?: Record<string, unknown>
}): Promise<{ artifacts: VeniceArtifact[] }> {
  enforceProviderEgress('venice')
  const p = input.params ?? {}
  const ref = typeof p.image_url === 'string' && p.image_url.trim() ? p.image_url.trim() : undefined

  // ── IMAGE EDITING: a reference image present → POST /api/v1/image/edit.
  // (Text→image /images/generations has NO image input, so a reference there is
  // silently ignored — that was the bug.) The edit endpoint takes the reference
  // as the `image` field (RAW base64, no data: prefix, or an http(s) URL),
  // returns RAW BINARY, and needs an "-edit" model (gpt-image-1-5 →
  // gpt-image-1-5-edit; qwen-image-2 → qwen-image-2-edit; …).
  if (ref) {
    const model = /edit/i.test(input.model) ? input.model : `${input.model}-edit`
    const dm = /^data:[^;,]+;base64,(.+)$/s.exec(ref)
    const image = dm ? dm[1] : ref
    const body: Record<string, unknown> = { model, prompt: input.prompt, image, output_format: 'png' }
    if (typeof p.aspect_ratio === 'string' && p.aspect_ratio) body.aspect_ratio = p.aspect_ratio
    if (typeof p.resolution === 'string' && p.resolution)     body.resolution = p.resolution
    const res = await fetch(`${VENICE_BASE}/image/edit`, {
      method: 'POST', headers: jsonHeaders('image/png'), body: JSON.stringify(body),
    })
    if (!res.ok) throw await toError(res)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const mime  = res.headers.get('content-type') || 'image/png'
    const ext   = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
    const path  = writeBytes(`ven-img-${Date.now()}`, 0, bytes, ext)
    return { artifacts: [{ kind: 'image', mimeType: mime, path, b64: Buffer.from(bytes).toString('base64') }] }
  }

  // ── TEXT → IMAGE: OpenAI-compatible /images/generations (JSON, data[]).
  const body: Record<string, unknown> = { model: input.model, prompt: input.prompt, response_format: 'b64_json' }
  if (input.size) body.size = input.size
  if (input.n)    body.n = input.n

  const res = await fetch(`${VENICE_BASE}/images/generations`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body),
  })
  if (!res.ok) throw await toError(res)
  const json = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> }
  const jobId = `ven-img-${Date.now()}`
  const artifacts: VeniceArtifact[] = []
  const data = json.data ?? []
  for (let i = 0; i < data.length; i++) {
    const it = data[i]
    if (it.b64_json) {
      const pth = writeBytes(jobId, i, Buffer.from(it.b64_json, 'base64'), 'png')
      artifacts.push({ kind: 'image', mimeType: 'image/png', path: pth, b64: it.b64_json })
    } else if (it.url) {
      const r = await fetch(it.url)
      const bytes = new Uint8Array(await r.arrayBuffer())
      const mime = r.headers.get('content-type') || 'image/png'
      const pth = writeBytes(jobId, i, bytes, mime.includes('jpeg') ? 'jpg' : 'png')
      artifacts.push({ kind: 'image', mimeType: mime, path: pth })
    }
  }
  return { artifacts }
}

// ── TTS (sync, binary audio) ────────────────────────────────────────────────────
export async function veniceSpeech(input: {
  model: string; input: string; voice?: string; format?: string; speed?: number; params?: Record<string, unknown>
}): Promise<{ artifacts: VeniceArtifact[] }> {
  enforceProviderEgress('venice')
  const format = input.format || 'mp3'
  const body: Record<string, unknown> = { model: input.model, input: input.input, response_format: format }
  if (input.voice) body.voice = input.voice
  if (typeof input.speed === 'number') body.speed = input.speed
  // Venice schemas are strict (video/music are additionalProperties:false and
  // duration is an enum like '4s'); do NOT forward the Surplus-oriented param
  // bag (seed/steps/numeric duration/…) — send only explicit typed fields.

  const res = await fetch(`${VENICE_BASE}/audio/speech`, {
    method: 'POST', headers: jsonHeaders('audio/*'), body: JSON.stringify(body),
  })
  if (!res.ok) throw await toError(res)
  const mime  = res.headers.get('content-type') || (format === 'mp3' ? 'audio/mpeg' : `audio/${format}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const p = writeBytes(`ven-tts-${Date.now()}`, 0, bytes, format)
  return { artifacts: [{ kind: 'audio', mimeType: mime, path: p }] }
}

// ── STT (multipart) ─────────────────────────────────────────────────────────────
export async function veniceTranscribe(input: {
  model: string; audioBytes?: Uint8Array; audioPath?: string; fileName?: string; language?: string; prompt?: string
}): Promise<{ text: string }> {
  enforceProviderEgress('venice')
  let bytes: Uint8Array
  let fileName: string
  if (input.audioBytes) {
    bytes = input.audioBytes; fileName = input.fileName || 'audio.wav'
  } else if (input.audioPath) {
    if (!existsSync(input.audioPath)) throw new Error(`Audio file not found: ${input.audioPath}`)
    bytes = new Uint8Array(readFileSync(input.audioPath)); fileName = input.audioPath.split(/[\\/]/).pop() || 'audio.wav'
  } else {
    throw new Error('transcribe: provide audioBytes or audioPath')
  }
  const form = new FormData()
  form.append('file', new Blob([bytes as BlobPart]), fileName)
  form.append('model', input.model)
  if (input.language) form.append('language', input.language)
  if (input.prompt)   form.append('prompt', input.prompt)
  // No Content-Type — fetch derives the multipart boundary from FormData.
  const res = await fetch(`${VENICE_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireKey()}`, 'Accept-Encoding': 'identity' },
    body: form,
  })
  if (!res.ok) throw await toError(res)
  const json = await res.json() as { text?: string }
  return { text: json.text ?? '' }
}

// ── Video / Music (queue → poll → binary) ───────────────────────────────────────
async function queueAndPoll(
  kind: 'video' | 'music',
  body: Record<string, unknown>,
): Promise<{ artifacts: VeniceArtifact[] }> {
  enforceProviderEgress('venice')
  const queuePath    = kind === 'video' ? '/video/queue'    : '/audio/queue'
  const retrievePath = kind === 'video' ? '/video/retrieve' : '/audio/retrieve'
  const accept       = kind === 'video' ? 'video/mp4'       : 'audio/*'
  const ext          = kind === 'video' ? 'mp4'             : 'mp3'
  const artKind: VeniceArtifact['kind'] = kind === 'video' ? 'video' : 'audio'
  const artMime      = kind === 'video' ? 'video/mp4'       : 'audio/mpeg'

  const qRes = await fetch(`${VENICE_BASE}${queuePath}`, {
    method: 'POST', headers: jsonHeaders('application/json'), body: JSON.stringify(body),
  })
  if (!qRes.ok) throw await toError(qRes)
  const q = await qRes.json() as { queue_id?: string; download_url?: string }
  if (!q.queue_id) throw new Error('Venice queue returned no queue_id')

  const save = (bytes: Uint8Array): { artifacts: VeniceArtifact[] } => {
    const p = writeBytes(`ven-${kind}-${Date.now()}`, 0, bytes, ext)
    return { artifacts: [{ kind: artKind, mimeType: artMime, path: p }] }
  }

  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    // Same-instant gate before EVERY poll: a video/music job polls for minutes,
    // and PRIVATE MODE can flip anywhere in that window. No cloud request may
    // BEGIN without a same-instant check — the rule the pollinations pacing
    // queue was caught breaking (driver-reproduced 2026-08-01). Matches the
    // per-poll gate surplus-media-service's pollMediaJob() already had.
    enforceProviderEgress('venice')
    const rRes = await fetch(`${VENICE_BASE}${retrievePath}`, {
      method: 'POST', headers: jsonHeaders(accept),
      body: JSON.stringify({ model: body.model, queue_id: q.queue_id }),
    })
    const ct = rRes.headers.get('content-type') || ''
    if (rRes.ok && !ct.includes('application/json')) {
      // Completed — body is the media binary.
      return save(new Uint8Array(await rRes.arrayBuffer()))
    }
    const j = await rRes.json().catch(() => ({})) as { status?: string }
    if (j.status === 'COMPLETED' && q.download_url) {
      // A DIFFERENT request from the retrieve poll above, and it has not
      // started yet — the poll's own gate check (line above) covers only ITS
      // fetch. The job finishing server-side and the mode flipping can land
      // in the same instant, so this fresh download gets its own same-instant
      // check rather than riding on a check that already happened.
      enforceProviderEgress('venice')
      const dl = await fetch(q.download_url)
      if (!dl.ok) throw await toError(dl)
      return save(new Uint8Array(await dl.arrayBuffer()))
    }
    if (!rRes.ok) throw await toError(rRes)
    // PROCESSING → keep polling.
  }
  throw new Error(`Venice ${kind} generation timed out after ${POLL_TIMEOUT_MS / 1000}s`)
}

export async function veniceSubmitVideo(input: {
  model: string; prompt: string; negativePrompt?: string; duration?: string; params?: Record<string, unknown>
}): Promise<{ artifacts: VeniceArtifact[] }> {
  const body: Record<string, unknown> = { model: input.model, prompt: input.prompt }
  if (input.negativePrompt) body.negative_prompt = input.negativePrompt
  const p = input.params ?? {}

  // Capability-aware: send duration/aspect_ratio/resolution ONLY when this model
  // defines them, using a value from its own allowed list (prefer the UI choice).
  const c = await veniceModelConstraints('video', input.model)
  if (c.durations.length > 0) {
    body.duration = input.duration && c.durations.includes(input.duration) ? input.duration : c.durations[0]
  } else if (input.duration) {
    body.duration = input.duration
  }
  if (c.aspectRatios.length > 0) {
    const want = typeof p.aspect_ratio === 'string' ? p.aspect_ratio : undefined
    body.aspect_ratio = want && c.aspectRatios.includes(want) ? want : c.aspectRatios[0]
  }
  if (c.resolutions.length > 0) {
    const want = typeof p.resolution === 'string' ? p.resolution : undefined
    body.resolution = want && c.resolutions.includes(want) ? want : c.resolutions[0]
  }
  // i2v frame inputs (data URL / public URL) — ONLY for image-to-video models.
  // Text-to-video models 400 on image_url ("not supported for text to video
  // models"), so we gate by the model id (Venice names them "...-image-to-video").
  const isImageToVideo = /image[-_ ]?to[-_ ]?video|img2(?:vid|video)|\bi2v\b/i.test(input.model)
  if (isImageToVideo) {
    for (const k of ['image_url', 'end_image_url']) {
      const v = p[k]
      if (typeof v === 'string' && v) body[k] = v
    }
  }
  return queueAndPoll('video', body)
}

export async function veniceSubmitMusic(input: {
  model: string; prompt: string; lyrics?: string; durationSeconds?: number; params?: Record<string, unknown>
}): Promise<{ artifacts: VeniceArtifact[] }> {
  const body: Record<string, unknown> = { model: input.model, prompt: input.prompt }
  if (input.lyrics) body.lyrics_prompt = input.lyrics
  const p = input.params ?? {}

  // Capability-aware (mirrors veniceSubmitVideo): read the model's constraints
  // and send only the fields it actually defines, each from its own allowed
  // list. Venice music/audio schemas are strict (additionalProperties:false) and
  // expose `durations` as an enum (e.g. '8s'), so prefer the enum `duration` over
  // a numeric `duration_seconds`; the numeric field is the legacy fallback used
  // only when the model declares no duration enum.
  const c = await veniceModelConstraints('music', input.model)
  if (c.durations.length > 0) {
    const wantStr     = typeof p.duration === 'string' ? p.duration : undefined
    const fromSeconds = typeof input.durationSeconds === 'number' ? `${input.durationSeconds}s` : undefined
    body.duration =
      (wantStr && c.durations.includes(wantStr) ? wantStr : undefined) ??
      (fromSeconds && c.durations.includes(fromSeconds) ? fromSeconds : undefined) ??
      c.durations[0]
  } else if (typeof input.durationSeconds === 'number') {
    body.duration_seconds = input.durationSeconds
  }
  if (c.aspectRatios.length > 0) {
    const want = typeof p.aspect_ratio === 'string' ? p.aspect_ratio : undefined
    body.aspect_ratio = want && c.aspectRatios.includes(want) ? want : c.aspectRatios[0]
  }
  if (c.resolutions.length > 0) {
    const want = typeof p.resolution === 'string' ? p.resolution : undefined
    body.resolution = want && c.resolutions.includes(want) ? want : c.resolutions[0]
  }
  return queueAndPoll('music', body)
}

/**
 * Vision chat — a single non-streaming /chat/completions where the user message
 * carries text PLUS one or more `image_url` parts, so a vision-capable Venice
 * TEXT model SEES the reference image(s) while it writes. Used by graph node
 * runs when a Reference-Image node is wired into a Prompt node ("write a prompt
 * that features THIS character/object"). Returns the assistant's text.
 *
 * The chosen model MUST support vision (e.g. qwen-2.5-vl, mistral-31-24b); a
 * text-only model returns a 4xx, surfaced verbatim to the caller.
 */
export async function veniceVisionChat(input: {
  model: string
  system?: string
  userText: string
  imageUrls: string[]
}): Promise<{ text: string }> {
  enforceProviderEgress('venice')
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: input.userText.trim() || 'Use the attached reference image(s).' },
  ]
  for (const url of input.imageUrls) {
    if (typeof url === 'string' && url) content.push({ type: 'image_url', image_url: { url } })
  }
  const messages: Array<Record<string, unknown>> = []
  if (input.system && input.system.trim()) messages.push({ role: 'system', content: input.system })
  messages.push({ role: 'user', content })

  const res = await fetch(`${VENICE_BASE}/chat/completions`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ model: input.model, messages, stream: false }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Venice vision chat ${res.status}: ${body.slice(0, 300)}`)
  }
  const json = await res.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: unknown } }> }
  const msg = json.choices?.[0]?.message?.content
  const text = typeof msg === 'string'
    ? msg
    : Array.isArray(msg)
      ? msg.map(p => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('')
      : ''
  return { text: text.trim() }
}
