// apps/desktop/electron/services/kokoro-tts.ts
//
// Studio-quality LOCAL text-to-speech via kokoro-js (Kokoro-82M ONNX running
// on onnxruntime-node, device 'cpu', dtype 'q8' — ~92 MB one-time download,
// then fully offline). This is the "A-grade voice" tier above the piper
// sidecar: no external binary, the model runs IN-PROCESS in main.
//
// IPC surface (registered in electron/ipc/piper.ipc.ts):
//   kokoro:status     → { installed, downloading, progress?, voices, modelDir }
//   kokoro:ensure     → download the model if missing (broadcasts 'kokoro:progress')
//   kokoro:synthesize → { text, voice } → { ok, b64? (WAV bytes), error? }
//   media:save-wav    → { b64, name }   → { ok, path?, error? } (Artifacts library)
//
// MODULE-INSTANCE GOTCHA (load-bearing): the desktop app depends on
// @huggingface/transformers@4.x for RAG, but kokoro-js pins its OWN 3.x copy
// (pnpm keeps both). `import('@huggingface/transformers')` here would resolve
// the 4.x instance and setting env.cacheDir on it would do NOTHING for kokoro.
// We must resolve transformers THROUGH kokoro-js's own resolution
// (createRequire(require.resolve('kokoro-js'))) so we mutate the exact env
// object kokoro's from_pretrained reads. Both loads use the CJS `require`
// condition, so they share one module instance (no dual-package hazard).
//
// OFFLINE HONESTY: `installed` = the q8 .onnx actually present in our cache
// dir. status/synthesize NEVER trigger a download — only ensure() does, and
// ensure() is gated by PRIVATE MODE (mirrors rag-service's model gate).
// kokoro-js ships the per-voice style vectors (voices/*.bin) inside the npm
// package itself, so voices need no download at all.
//
// CONCURRENCY: one lazy KokoroTTS instance; synth calls are serialized on a
// single promise chain (the onnxruntime session is not reentrant-safe).
//
// DOWNLOAD-MANAGER (deliberately NOT routed): every other model download
// (llama/sd/piper/whisper) goes through services/download-manager.ts for the
// DownloadStrip + resume + integrity. Kokoro cannot cleanly join them —
// transformers.js's from_pretrained owns its own fetch/cache pipeline
// (multi-file manifest, internal cache layout, its own progress protocol),
// and intercepting it would mean hacking transformers internals. The model
// keeps its dedicated kokoro:progress channel instead.

import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { join, basename } from 'path'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { createRequire } from 'module'
import { getCurrentPrivacyMode } from '../ipc/privacy.ipc'
import { ensureStorageDir, writeStorageFile } from './storage-root'

// Lazy (inside loadTts) — the bundled main is CJS so __filename exists there,
// but building it at import time would break ESM test transforms for the pure
// helpers below.
function getNodeRequire(): NodeJS.Require {
  return createRequire(__filename)
}

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
/** Hard cap: kokoro degrades on very long inputs; callers chunk above this. */
const MAX_TEXT_CHARS = 4000

// ─── Voice catalog (static, curated) ─────────────────────────────────────────
//
// Kokoro ships 28 voices with wildly varying quality. We surface only the ~10
// best (grade B- and up, plus the strongest male options). Grades come from
// the official VOICES table inside kokoro-js 1.2.1. The label is what the UI
// renders directly (English product copy, not a translated UI string).

export interface KokoroVoice {
  id:     string
  label:  string
  gender: 'f' | 'm'
  accent: 'us' | 'gb'
  grade:  string
}

export const KOKORO_VOICES: KokoroVoice[] = [
  { id: 'af_heart',    label: 'Heart — US female, studio (A)',     gender: 'f', accent: 'us', grade: 'A'  },
  { id: 'af_bella',    label: 'Bella — US female, warm (A-)',      gender: 'f', accent: 'us', grade: 'A-' },
  { id: 'af_nicole',   label: 'Nicole — US female, whisper (B-)',  gender: 'f', accent: 'us', grade: 'B-' },
  { id: 'am_michael',  label: 'Michael — US male, steady (C+)',    gender: 'm', accent: 'us', grade: 'C+' },
  { id: 'am_fenrir',   label: 'Fenrir — US male, deep (C+)',       gender: 'm', accent: 'us', grade: 'C+' },
  { id: 'am_puck',     label: 'Puck — US male, bright (C+)',       gender: 'm', accent: 'us', grade: 'C+' },
  { id: 'bf_emma',     label: 'Emma — GB female, calm (B-)',       gender: 'f', accent: 'gb', grade: 'B-' },
  { id: 'bf_isabella', label: 'Isabella — GB female, soft (C)',    gender: 'f', accent: 'gb', grade: 'C'  },
  { id: 'bm_george',   label: 'George — GB male, classic (C)',     gender: 'm', accent: 'gb', grade: 'C'  },
  { id: 'bm_fable',    label: 'Fable — GB male, narrator (C)',     gender: 'm', accent: 'gb', grade: 'C'  },
]

const VOICE_IDS = new Set(KOKORO_VOICES.map(v => v.id))

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KokoroStatus {
  installed:   boolean
  downloading: boolean
  /** 0..1 while downloading (when totals are known). */
  progress?:   number
  voices:      KokoroVoice[]
  modelDir:    string
}

export interface KokoroProgressEvent {
  /** 0..1 overall download progress. */
  progress: number
  /** The file currently transferring (e.g. "onnx/model_quantized.onnx"). */
  file?:    string
}

export interface KokoroSynthesizeInput  { text: string; voice: string }
export interface KokoroSynthesizeResult { ok: boolean; b64?: string; error?: string }
export interface SaveWavInput           { b64: string; name: string }
export interface SaveWavResult          { ok: boolean; path?: string; error?: string }

// Minimal structural types for the lazily-required kokoro-js surface (its own
// .d.ts is ESM-only; we require the CJS build, so we type what we touch).
interface RawAudioLike   { toWav(): ArrayBuffer }
interface KokoroTTSLike  { generate(text: string, opts?: { voice?: string; speed?: number }): Promise<RawAudioLike> }
interface KokoroModule   {
  KokoroTTS: {
    from_pretrained(modelId: string, opts: {
      dtype?: string
      device?: string | null
      progress_callback?: (p: TransformersProgress) => void
    }): Promise<KokoroTTSLike>
  }
}
/** transformers.js ProgressCallback payload (v3 convention; progress is 0-100). */
interface TransformersProgress {
  status?:   string
  file?:     string
  progress?: number
  loaded?:   number
  total?:    number
}
interface TransformersModuleLike { env: { cacheDir: string } }

// ─── Paths / installed check ─────────────────────────────────────────────────

function modelDir(): string {
  return join(app.getPath('userData'), 'kokoro-tts')
}

// The full-precision fp32 weights (onnx/model.onnx, ~326 MB) — chosen over the
// q8 build for audibly better voices; the machine can spare the RAM/CPU. The
// installed check is fp32-SPECIFIC so a leftover q8 cache doesn't report
// "installed" and skip the (larger) fp32 fetch — that would strand the first
// synth on a silent, progress-less download.
const ONNX_FILE = 'model.onnx'

/**
 * Recursively scan for the fp32 weights file (bounded depth — the transformers
 * cache nests <cacheDir>/<org>/<repo>/onnx/model.onnx). Pure fs, cheap.
 */
function dirHasOnnx(dir: string, depth = 0): boolean {
  if (depth > 6 || !existsSync(dir)) return false
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return false }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      // fp32 model.onnx is tens of MB — the >5 MB floor rejects the tiny
      // q8/q4 siblings so a partial-quant cache never masks a missing fp32.
      if (st.isFile() && name.toLowerCase() === ONNX_FILE && st.size > 5_000_000) return true
      if (st.isDirectory() && dirHasOnnx(p, depth + 1)) return true
    } catch { /* unreadable entry — skip */ }
  }
  return false
}

/** Model files present on disk? Exact expected path first, then a lenient scan. */
export function kokoroInstalled(): boolean {
  const exact = join(modelDir(), ...MODEL_ID.split('/'), 'onnx', ONNX_FILE)
  if (existsSync(exact)) return true
  return dirHasOnnx(modelDir())
}

// ─── Status ──────────────────────────────────────────────────────────────────

const downloadState = { active: false, progress: 0 }

export function kokoroStatus(): KokoroStatus & { device?: 'dml' | 'cpu' | null } {
  return {
    installed:   kokoroInstalled(),
    downloading: downloadState.active,
    ...(downloadState.active ? { progress: downloadState.progress } : {}),
    voices:      KOKORO_VOICES,
    modelDir:    modelDir(),
    // Which execution provider the loaded session runs on (null until first
    // load): 'dml' = the user's GPU via DirectML, 'cpu' = fallback.
    device:      activeDevice,
  }
}

// ─── Progress aggregation (pure — unit-tested) ───────────────────────────────

/**
 * Fold a stream of transformers.js progress events (per-file, progress 0-100)
 * into one overall 0..1 number: sum(loaded)/sum(total) across all files whose
 * totals are known. Returns the previous value when nothing is known yet.
 */
export function foldDownloadProgress(
  files: Map<string, { loaded: number; total: number }>,
  event: TransformersProgress,
  previous: number,
): number {
  if (event.status === 'progress' && event.file && typeof event.loaded === 'number' && typeof event.total === 'number' && event.total > 0) {
    files.set(event.file, { loaded: event.loaded, total: event.total })
  } else if (event.status === 'done' && event.file) {
    const f = files.get(event.file)
    if (f) files.set(event.file, { loaded: f.total, total: f.total })
  }
  let loaded = 0
  let total = 0
  for (const f of files.values()) { loaded += f.loaded; total += f.total }
  if (total <= 0) return previous
  return Math.min(1, Math.max(previous, loaded / total))
}

// ─── Lazy model load (ONE instance) ──────────────────────────────────────────

let ttsPromise: Promise<KokoroTTSLike> | null = null

/**
 * Resolve kokoro-js AND its own @huggingface/transformers instance (see module
 * header), point the cache at userData/kokoro-tts, and load the model. The
 * progress callback only fires for files not already cached, so a warm load
 * emits (almost) nothing.
 */
/** Which execution device the loaded session actually uses ('dml' = GPU via DirectML). */
let activeDevice: 'dml' | 'cpu' | null = null
export function kokoroDevice(): 'dml' | 'cpu' | null { return activeDevice }
/** Set when DML failed AT INFERENCE (session loads, ConvTranspose op fails) — skip it from then on. */
let dmlBlocked = false

function loadTts(onProgress?: (p: TransformersProgress) => void): Promise<KokoroTTSLike> {
  if (ttsPromise) return ttsPromise
  ttsPromise = (async () => {
    const nodeRequire   = getNodeRequire()
    const kokoroEntry   = nodeRequire.resolve('kokoro-js')
    const kokoroRequire = createRequire(kokoroEntry)
    // The SAME transformers instance kokoro's CJS build requires internally.
    const transformers  = kokoroRequire('@huggingface/transformers') as TransformersModuleLike
    mkdirSync(modelDir(), { recursive: true })
    transformers.env.cacheDir = modelDir()

    const { KokoroTTS } = nodeRequire('kokoro-js') as KokoroModule
    // fp32 (full precision) — the q8 build sounded noticeably worse (metallic,
    // quantization artifacts). Device: DirectML (any Windows GPU incl. the
    // user's RTX — transformers.node supports 'dml' on win32) with a clean CPU
    // fallback when the DML provider fails to initialize (no GPU / driver).
    const candidates: Array<'dml' | 'cpu'> = process.platform === 'win32' && !dmlBlocked ? ['dml', 'cpu'] : ['cpu']
    let lastErr: unknown = null
    for (const device of candidates) {
      try {
        const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype:  'fp32',
          device,
          ...(onProgress ? { progress_callback: onProgress } : {}),
        })
        activeDevice = device
        console.log(`[kokoro] loaded fp32 on ${device === 'dml' ? 'GPU (DirectML)' : 'CPU'}`)
        return tts
      } catch (err) {
        lastErr = err
        console.warn(`[kokoro] ${device} load failed${device === 'dml' ? ' — falling back to CPU' : ''}:`, err instanceof Error ? err.message : err)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  })()
  // A failed load must not poison future attempts (e.g. network drop mid-download).
  ttsPromise.catch(() => { ttsPromise = null })
  return ttsPromise
}

// ─── ensure: download the model if missing ───────────────────────────────────

function pushProgress(win: BrowserWindow | null, e: KokoroProgressEvent): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('kokoro:progress', e)
}

/**
 * Make the model ready: triggers the HF download into modelDir() when missing
 * (broadcasting 'kokoro:progress' events), or just warm-loads from disk when
 * present. The ONLY entry point that may egress.
 */
export async function ensureKokoro(win: BrowserWindow | null): Promise<{ ok: boolean; error?: string }> {
  const installed = kokoroInstalled()
  if (!installed && getCurrentPrivacyMode() === 'private') {
    return {
      ok: false,
      error: 'Kokoro TTS is not downloaded yet and PRIVATE MODE blocks the one-time download (~92 MB from huggingface.co). Leave private mode once to fetch it, then it runs fully offline.',
    }
  }
  const files = new Map<string, { loaded: number; total: number }>()
  let lastSent = 0
  if (!installed) { downloadState.active = true; downloadState.progress = 0 }
  try {
    await loadTts((p) => {
      downloadState.progress = foldDownloadProgress(files, p, downloadState.progress)
      // Throttle IPC to ~5 events/sec + always send terminal file events.
      const now = Date.now()
      if (p.status === 'done' || now - lastSent > 200) {
        lastSent = now
        pushProgress(win, { progress: downloadState.progress, ...(p.file ? { file: p.file } : {}) })
      }
    })
    pushProgress(win, { progress: 1 })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    downloadState.active = false
  }
}

// ─── synthesize (serialized queue) ───────────────────────────────────────────

let synthChain: Promise<unknown> = Promise.resolve()

/**
 * Text → WAV bytes (base64), fully local. Never downloads: errors when the
 * model isn't installed yet. Calls are serialized (one onnx session).
 */
export function kokoroSynthesize(input: KokoroSynthesizeInput): Promise<KokoroSynthesizeResult> {
  const run = synthChain.then(() => doSynthesize(input), () => doSynthesize(input))
  synthChain = run.then(() => undefined, () => undefined)
  return run
}

async function doSynthesize(input: KokoroSynthesizeInput): Promise<KokoroSynthesizeResult> {
  try {
    const text = (input?.text ?? '').trim()
    if (!text) return { ok: false, error: 'No text to speak.' }
    if (text.length > MAX_TEXT_CHARS) {
      return { ok: false, error: `Text too long for one synthesis (${text.length} chars, max ${MAX_TEXT_CHARS}). Split it into shorter passages.` }
    }
    const voice = VOICE_IDS.has(input?.voice) ? input.voice : ''
    if (!voice) {
      return { ok: false, error: `Unknown voice "${input?.voice ?? ''}". Available: ${KOKORO_VOICES.map(v => v.id).join(', ')}.` }
    }
    if (!kokoroInstalled()) {
      return { ok: false, error: 'Kokoro model is not downloaded yet — run the one-time download first (kokoro:ensure).' }
    }
    const tts = await loadTts()
    let audio: Awaited<ReturnType<KokoroTTSLike['generate']>>
    try {
      audio = await tts.generate(text, { voice })
    } catch (inferErr) {
      // DirectML loads the session fine but FAILS AT INFERENCE on kokoro's
      // ConvTranspose op ("The parameter is incorrect", 0x80070057) — a
      // provider gap, not a config error. Blocklist DML for this process,
      // reload on CPU and retry once so the caller never sees the GPU bump.
      if (kokoroDevice() !== 'dml') throw inferErr
      console.warn('[kokoro] DML inference failed — reloading on CPU:', inferErr instanceof Error ? inferErr.message : inferErr)
      dmlBlocked = true
      ttsPromise = null
      const cpuTts = await loadTts()
      audio = await cpuTts.generate(text, { voice })
    }
    const wav = Buffer.from(audio.toWav())
    return { ok: true, b64: wav.toString('base64') }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── media:save-wav — persist into the media ARTIFACTS root ──────────────────
//
// The Artifacts gallery is a renderer-side store (media.store) whose entries
// point at absolute paths under the user-content roots (storage root's Media
// folder; legacy <userData>/media still served) — the ONLY roots the
// tachi-media:// protocol will serve. So "registering" from main means:
// write the WAV under that root and hand the path back; the renderer then
// adds a gallery entry (media.store.addEntry / addNodeRunArtifacts) with it,
// exactly like studio generations and node runs do.

/** Windows-safe WAV filename: strip paths/illegal chars, force .wav (pure — unit-tested). */
export function sanitizeWavName(name: string): string {
  let base = String(name ?? '')
    .split(/[\\/]/).pop()!                    // drop any directory components
    .replace(/[<>:"|?*]/g, '')             // Windows-illegal filename chars
    .split('').filter(c => c.charCodeAt(0) >= 32).join('')  // control chars
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.wav$/i, '')
    .replace(/[. ]+$/, '')                    // Windows: no trailing dots/spaces
  if (base.length > 80) base = base.slice(0, 80).trim()
  if (!base) base = `kokoro-${Date.now()}`
  return `${base}.wav`
}

/** RIFF/WAVE magic check on decoded bytes (pure — unit-tested). */
export function isWavBytes(bytes: Buffer | Uint8Array): boolean {
  if (bytes.length < 44) return false
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
}

/**
 * Decode base64 WAV bytes and save them under <storage root>/Media/kokoro/
 * (the artifacts root served by tachi-media://). Returns the absolute path for
 * the renderer to register in the Artifacts gallery.
 */
export function saveWavToMediaLibrary(input: SaveWavInput): SaveWavResult {
  try {
    const b64 = (input?.b64 ?? '').trim()
    if (!b64) return { ok: false, error: 'No audio data to save.' }
    const bytes = Buffer.from(b64, 'base64')
    if (!isWavBytes(bytes)) return { ok: false, error: 'Data is not a WAV file (missing RIFF/WAVE header).' }

    // ensureStorageDir heals a root that went unwritable mid-session BEFORE the
    // collision scan, so the "does this take already exist?" probe and the write
    // below agree on one root (LANE J/L).
    const dir = ensureStorageDir('media', 'kokoro')

    const fileName = sanitizeWavName(input?.name ?? '')
    let name = fileName
    // Never overwrite an earlier take: suffix -2, -3, … on collision.
    for (let n = 2; existsSync(join(dir, name)) && n < 1000; n++) {
      name = `${basename(fileName, '.wav')}-${n}.wav`
    }
    // writeStorageFile: one re-probe + retry, and the CFA-aware message in the
    // { ok:false, error } this function already returns.
    const path = writeStorageFile('media', join('kokoro', name), bytes)
    return { ok: true, path }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
