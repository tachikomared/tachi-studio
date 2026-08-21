// apps/desktop/src/pages/media/audioOverviewHelpers.ts
//
// Pure helpers for the AUDIO OVERVIEW panel (NotebookLM-style two-host podcast
// from pasted notes). Everything here is framework-free and unit-tested in
// test/unit/audioOverview.test.ts:
//   • buildScriptPrompt / parsePodcastScript — the LLM round-trip contract
//     (strict JSON, fence-tolerant parsing, host normalization).
//   • concatWithGaps / encodeWavPcm16 — renderer-side WAV stitching (decoded
//     Float32 PCM → one mono PCM16 WAV with 350ms silence between turns).
// The panel itself (AudioOverviewPanel.tsx) owns all IPC + WebAudio calls.

export type PodcastHost = 'A' | 'B'

export interface PodcastTurn {
  host: PodcastHost
  text: string
}

export interface PodcastScript {
  title: string
  turns: PodcastTurn[]
}

export type OverviewLength = 'short' | 'standard'

/** Silence inserted between consecutive turns when stitching. */
export const TURN_GAP_MS = 350

/**
 * The quick-ask IPC truncates prompts to 4000 chars server-side; keep the
 * instructions + source safely under that so nothing is cut mid-sentence.
 */
export const MAX_SOURCE_CHARS = 3000

const LENGTH_RULES: Record<OverviewLength, string> = {
  short:    'Exactly 8 to 10 turns, about 160 spoken words in total (~1 minute of audio).',
  standard: 'Exactly 14 to 18 turns, about 450 spoken words in total (~3 minutes of audio).',
}

/**
 * Build the one-shot prompt that turns pasted notes into a strict-JSON
 * two-host dialogue. `strict` prepends a corrective reminder — used for the
 * single retry after a parse failure (re-sending the task beats echoing the
 * malformed output back, which would blow the 4000-char cap).
 */
export function buildScriptPrompt(
  source: string,
  title: string,
  length: OverviewLength,
  strict = false,
): string {
  const trimmedSource = source.trim().slice(0, MAX_SOURCE_CHARS)
  const lines = [
    ...(strict
      ? ['REMINDER: your reply must be ONLY one JSON object, starting with { and ending with }. No code fences, no prose before or after.']
      : []),
    'Write a two-host podcast dialogue script from the SOURCE below.',
    'Reply with ONLY a JSON object — no prose, no markdown fences, no commentary.',
    'Schema: {"title": "...", "turns": [{"host": "A", "text": "..."}, {"host": "B", "text": "..."}]}',
    'Rules:',
    '- Host A is a curious anchor: opens the show, asks sharp questions, reacts briefly.',
    '- Host B is the expert: explains clearly, using concrete details from the source.',
    '- Conversational spoken language, short sentences. No stage directions, no sound effects, no markdown, no host name prefixes inside "text".',
    `- ${LENGTH_RULES[length]}`,
    '- Turn 1 is A welcoming listeners and naming the topic; the last turn is A wrapping up.',
    ...(title.trim() ? [`TITLE HINT: ${title.trim().slice(0, 120)}`] : []),
    'SOURCE:',
    trimmedSource,
  ]
  return lines.join('\n')
}

/**
 * Fence-tolerant strict parse of the model's reply into a PodcastScript.
 * Accepts raw JSON or JSON wrapped in prose / ``` fences (extracts the first
 * '{' → last '}' span). Throws with a human-readable reason on any failure —
 * the caller retries once, then errors honestly.
 */
export function parsePodcastScript(raw: string, fallbackTitle = ''): PodcastScript {
  const text = (raw ?? '').trim()
  if (!text) throw new Error('empty reply')

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object in reply')

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('reply is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('reply is not a JSON object')
  }

  const obj = parsed as { title?: unknown; turns?: unknown }
  if (!Array.isArray(obj.turns)) throw new Error('missing "turns" array')

  const turns: PodcastTurn[] = []
  for (const entry of obj.turns) {
    if (typeof entry !== 'object' || entry === null) continue
    const { host, text: turnText } = entry as { host?: unknown; text?: unknown }
    if (typeof turnText !== 'string') continue
    const cleaned = cleanTurnText(turnText)
    if (!cleaned) continue
    const normalizedHost = String(host ?? '').trim().toUpperCase()
    if (normalizedHost !== 'A' && normalizedHost !== 'B') continue
    turns.push({ host: normalizedHost, text: cleaned })
  }
  if (turns.length < 2) throw new Error(`only ${turns.length} usable turn(s) in reply`)

  const title = typeof obj.title === 'string' && obj.title.trim()
    ? obj.title.trim().slice(0, 160)
    : (fallbackTitle.trim() || 'Audio overview')

  return { title, turns }
}

/**
 * Strip artifacts the TTS should never speak: leading "A:" / "Host B:" name
 * prefixes, [bracketed] / (parenthesized) stage directions, markdown asterisks,
 * and collapsed whitespace.
 */
export function cleanTurnText(text: string): string {
  return text
    .replace(/^\s*(host\s*)?[ab]\s*[:—-]\s*/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Concatenate decoded mono PCM chunks (one per turn) into a single Float32
 * signal with `gapMs` of silence between consecutive chunks (none at the ends).
 */
export function concatWithGaps(chunks: Float32Array[], sampleRate: number, gapMs = TURN_GAP_MS): Float32Array {
  const gapSamples = Math.round((gapMs / 1000) * sampleRate)
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
    + gapSamples * Math.max(0, chunks.length - 1)
  const out = new Float32Array(total)
  let offset = 0
  chunks.forEach((chunk, i) => {
    out.set(chunk, offset)
    offset += chunk.length
    if (i < chunks.length - 1) offset += gapSamples // silence = zero-filled by default
  })
  return out
}

/**
 * Encode mono Float32 samples ([-1, 1]) as a PCM16 WAV file (44-byte canonical
 * RIFF header + little-endian samples). Out-of-range samples are clamped.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataLen = samples.length * 2
  const buf = new ArrayBuffer(44 + dataLen)
  const view = new DataView(buf)

  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)         // RIFF chunk size
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)                  // fmt chunk size
  view.setUint16(20, 1, true)                   // audio format: PCM
  view.setUint16(22, 1, true)                   // channels: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)      // byte rate = rate * channels * 2
  view.setUint16(32, 2, true)                   // block align = channels * 2
  view.setUint16(34, 16, true)                  // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataLen, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(buf)
}

/** Decode base64 into bytes (browser atob when present, Buffer in node tests). */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** Encode bytes as base64 (chunked btoa in the browser, Buffer in node tests). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = ''
    const CHUNK = 0x8000 // keep String.fromCharCode arg counts sane
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(bin)
  }
  return Buffer.from(bytes).toString('base64')
}

// ── TTS engine routing (STUDIO/kokoro vs piper) ──────────────────────────────
// Voice pickers mix two local engines in one <select>, so option values carry
// the engine as a prefix ("kokoro:af_heart" / "piper:en_US-…"). Unprefixed
// values fall back to piper — the only engine that existed before this split.

export type TtsEngine = 'kokoro' | 'piper'

/** Default kokoro host voices (English studio-grade): A = anchor, B = expert. */
export const KOKORO_HOST_A_DEFAULT = 'af_heart'
export const KOKORO_HOST_B_DEFAULT = 'am_michael'

export function packVoice(engine: TtsEngine, id: string): string {
  return `${engine}:${id}`
}

export function unpackVoice(packed: string): { engine: TtsEngine; id: string } {
  if (packed.startsWith('kokoro:')) return { engine: 'kokoro', id: packed.slice('kokoro:'.length) }
  if (packed.startsWith('piper:')) return { engine: 'piper', id: packed.slice('piper:'.length) }
  return { engine: 'piper', id: packed }
}

/**
 * Is a script-generation failure worth ONE silent retry before surfacing the
 * error row? Only transient transport-ish failures qualify: HTTP 5xx status
 * codes and fetch/network-layer errors. Anything else (parse failures, empty
 * replies, router-not-running) already has its own honest handling.
 */
export function isTransientScriptError(message: string): boolean {
  const msg = message.toLowerCase()
  if (/\b5\d{2}\b/.test(msg)) return true
  return /fetch failed|failed to fetch|network error|econnreset|econnrefused|etimedout|socket hang up|fetcherror/.test(msg)
}

/**
 * Is this script-failure reason something a person could read as-is, or a
 * raw wire payload that only means something to someone reading the network
 * tab? quick-ask's only route back from a router that is UP but failing is
 * its own HTTP error text ("router 502: {...}") — the whole provider chain
 * (a dozen free-tier names, one of them 401ing) in one line, on a build that
 * just promised "drafted by the local keyless model". Engine failures
 * (piper/sd-cli exit lines, "empty reply", a parse-failure reason) are short,
 * English, single-line sentences — those are NOT this, and pass through
 * unchanged (the producer's own words rule stands for anything that IS one).
 */
export function isRawScriptFailurePayload(message: string): boolean {
  const msg = String(message ?? '').trim()
  if (!msg) return false
  // The keyless router's own error text: "router <status>: <body>".
  if (/^router\s+\d{3}\s*:/i.test(msg)) return true
  // Anywhere else a JSON object turns up in the reason is the same problem —
  // some upstream's own error body, not a sentence this app's producer wrote.
  if (/[{[]\s*"[^"]+"\s*:/.test(msg)) return true
  return false
}

/**
 * Does freellmapi's fallback catalog have at least one model the script
 * writer could actually route to? A PRESENCE/CONFIG check, not a live ping:
 * the only thing this gates on is "nothing is configured at all", so a
 * transient network fluke never blocks Create — only an honestly empty (or
 * all-disabled) catalog does. Mirrors the same probe provider-health.store
 * already runs for the freellmapi badge (probeFreellmapi) — not a new kind
 * of check, the same one reused for a second surface.
 */
export function hasUsableScriptModel(models: readonly { enabled?: boolean }[] | null | undefined): boolean {
  return Array.isArray(models) && models.some(m => !!m?.enabled)
}

// ── kokoro renderer surface (window.tachi.kokoro / window.tachi.media) ──────
// The sidecar wave lands the preload+types; the UI must degrade when absent.

export interface KokoroVoiceInfo {
  id: string
  label: string
  gender: 'f' | 'm'
  accent: 'us' | 'gb'
  grade: string
}

export interface KokoroProgressEvent { progress: number; file?: string }

/**
 * Subscribe to 'kokoro:progress' download events when the preload exposes a
 * subscription (idiom: onProgress, like piper.onInstallProgress). Returns a
 * no-op unsubscriber when the surface (or the event hook) is absent — callers
 * ALSO poll kokoro:status while ensure() is in flight, so progress still moves.
 */
export function subscribeKokoroProgress(cb: (p: KokoroProgressEvent) => void): () => void {
  const kokoro = (globalThis as unknown as {
    window?: { tachi?: { kokoro?: { onProgress?: (cb: (p: KokoroProgressEvent) => void) => () => void } } }
  }).window?.tachi?.kokoro
  if (kokoro && typeof kokoro.onProgress === 'function') return kokoro.onProgress(cb)
  return () => {}
}
