// apps/desktop/electron/services/whisper-service.ts
//
// Wraps nodejs-whisper to provide model management and audio transcription for
// the local speech-to-text feature.  The service is imported from the main
// process only — it must NOT be imported by renderer code.
//
// Key design decisions:
//   - Models are stored in {userData}/whisper-models/ so they survive app
//     reinstalls and are not inside node_modules.
//   - autoDownloadModelName is passed to nodejs-whisper on every transcribe
//     call so it will re-download if the file was somehow deleted.
//   - We stream progress via an EventEmitter so the IPC layer can relay
//     download/build events to the renderer.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { join, extname, dirname } from 'path'
import { spawn } from 'child_process'
import { app } from 'electron'
import { EventEmitter } from 'events'
import { resolveBinary } from './util/resolve-binary'
import { TaskFSM } from './util/task-fsm'
import { withInstallLock } from './util/install-lock'
import { whisperWavError } from './util/wav-format'
import { defaultWhisperRelease, resolveWhisperLanguage } from './whisper-models'
import {
  getWhisperCliPath, installWhisperCli, downloadWhisperModel, whisperModelPath,
} from './whisper-installer'
import { isEngineMigrating } from './model-storage'

// ─── Types ────────────────────────────────────────────────────────────────────

export type WhisperModelName =
  | 'tiny.en' | 'base.en' | 'small.en' | 'medium.en'
  | 'large-v3-turbo-q5_0'   // R10 — multilingual (and smaller than medium.en)

export interface WhisperTranscribeResult {
  text:        string
  duration_ms: number
}

export interface WhisperModelInfo {
  name:      WhisperModelName
  sizeLabel: string   // e.g. "~75 MB"
  ready:     boolean  // model file exists locally
}

// Progress event shape — emitted on the `whisperEvents` emitter.
export interface WhisperProgressEvent {
  stage:    'checking' | 'downloading' | 'building' | 'done' | 'error'
  message:  string
  percent?: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL_META: Record<WhisperModelName, { file: string; sizeLabel: string }> = {
  'tiny.en':   { file: 'ggml-tiny.en.bin',   sizeLabel: '~75 MB'  },
  'base.en':   { file: 'ggml-base.en.bin',   sizeLabel: '~142 MB' },
  'small.en':  { file: 'ggml-small.en.bin',  sizeLabel: '~466 MB' },
  'medium.en': { file: 'ggml-medium.en.bin', sizeLabel: '~1.5 GB' },
  'large-v3-turbo-q5_0': { file: 'ggml-large-v3-turbo-q5_0.bin', sizeLabel: '~547 MB' },
}

// ─── State ────────────────────────────────────────────────────────────────────

// Single event emitter shared across all callers. The IPC layer subscribes once.
export const whisperEvents = new EventEmitter()

// Per-model in-flight download promises (replaces the boolean `downloading`
// flag, which couldn't distinguish between models or return an existing promise).
const _downloadingModel = new Map<string, Promise<void>>()

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Where THIS model actually lives — dual-root, via the installer's resolver
 * (`<storage root>/Models/whisper/` for anything downloaded since LANE U or
 * relocated from the Settings dashboard, legacy `<userData>/whisper-models/`
 * for everything older).
 *
 * This used to hardcode the legacy dir while `transcribe()` already spawned the
 * CLI with `whisperModelPath()`. The two disagreed the moment a model was NOT
 * in userData: `ready` read false, `ensureModel` re-downloaded on every call
 * and then threw "Model file not found after download" even though the file was
 * sitting in the storage root. Latent for relocated models; LANE U (new
 * downloads target the root) would have made it the default path.
 */
function modelFilePath(name: WhisperModelName): string {
  return whisperModelPath(name)
}

/** Parent of the resolved model file — what nodejs-whisper wants as its
 *  `modelRootPath` (it joins the model filename onto this itself). */
function modelDir(name: WhisperModelName): string {
  const dir = dirname(modelFilePath(name))
  mkdirSync(dir, { recursive: true })
  return dir
}

function emit(event: WhisperProgressEvent): void {
  whisperEvents.emit('progress', event)
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List all supported models with their local availability.
 */
export function listModels(): WhisperModelInfo[] {
  return (Object.keys(MODEL_META) as WhisperModelName[]).map(name => ({
    name,
    sizeLabel: MODEL_META[name].sizeLabel,
    ready: existsSync(modelFilePath(name)),
  }))
}

/**
 * Return true when the whisper-cli executable inside nodejs-whisper's bundled
 * whisper.cpp has been compiled (happens on first model download).
 *
 * Uses the binary-resolver cascade: env-var override → bundled paths → PATH.
 */
export function isWhisperCliBuilt(): boolean {
  // The prebuilt whisper-cli (audit H3, Windows) counts as "built" too — so
  // status reporting + the error-floor are accurate once it's installed.
  if (getWhisperCliPath() !== null) return true
  try {
    // nodejs-whisper ships whisper.cpp under its own package directory
    // (node_modules/nodejs-whisper/cpp/whisper.cpp/). After cmake build the
    // binary ends up at:
    //   build/bin/whisper-cli        (Linux/macOS)
    //   build/bin/Release/whisper-cli.exe  (Windows)
    const { WHISPER_CPP_PATH } = require('nodejs-whisper/dist/constants') as { WHISPER_CPP_PATH: string }
    const bundledCandidates = [
      join(WHISPER_CPP_PATH, 'build', 'bin', 'whisper-cli'),
      join(WHISPER_CPP_PATH, 'build', 'bin', 'Release', 'whisper-cli'),
      join(WHISPER_CPP_PATH, 'build', 'bin', 'Debug',   'whisper-cli'),
    ]
    const resolved = resolveBinary('whisper-cli', {
      envVar: 'WHISPER_CLI_PATH',
      bundledCandidates,
    })
    return resolved !== null
  } catch {
    return false
  }
}

/**
 * Return an overall "is whisper usable" status:
 *   - 'not-built'   — cmake/make has never run, no binary
 *   - 'no-model'    — binary exists but no model downloaded yet
 *   - 'ready'       — binary + at least one model available
 */
export function whisperStatus(): 'not-built' | 'no-model' | 'ready' {
  if (!isWhisperCliBuilt()) return 'not-built'
  const anyReady = listModels().some(m => m.ready)
  return anyReady ? 'ready' : 'no-model'
}

/**
 * Ensure the ggml model is present. Downloads it DIRECTLY from HuggingFace with
 * SHA verification (audit H3 — no more cmake-on-first-run side effect, which
 * silently failed on machines without a C++ toolchain). The installer owns the
 * per-model lock + SHA check; we mirror start/done onto whisperEvents for the
 * existing download UI. No-op if the file already exists.
 */
export async function ensureModel(name: WhisperModelName = 'base.en'): Promise<void> {
  if (existsSync(modelFilePath(name))) {
    emit({ stage: 'done', message: `Model ${name} already present`, percent: 100 })
    return
  }
  emit({ stage: 'downloading', message: `Downloading ${name}…`, percent: 10 })
  try {
    await downloadWhisperModel(name, null)
    if (!existsSync(modelFilePath(name))) {
      throw new Error(`Model file not found after download: ${MODEL_META[name].file}`)
    }
    emit({ stage: 'done', message: `${name} ready`, percent: 100 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emit({ stage: 'error', message: msg })
    throw err
  }
}

/**
 * Transcribe a raw audio buffer (WAV or WebM) using whisper.cpp.
 *
 * The buffer is written to a temp file, passed to nodewhisper, then cleaned up.
 * Returns the full transcript text and wall-clock duration in milliseconds.
 */
export async function transcribe(
  audio:      Buffer,
  modelName:  WhisperModelName = 'base.en',
  lang?:      string,
): Promise<WhisperTranscribeResult> {
  // Refuse while whisper weights are being relocated (Storage → Move models).
  if (isEngineMigrating('whisper')) {
    throw new Error('Whisper models are being moved to the storage folder — try again in a moment.')
  }
  // Resolve the language BEFORE downloading anything: an `.en` model + a
  // non-English hint must fail loudly rather than emit phonetic garbage (R10).
  const language = resolveWhisperLanguage(modelName, lang)

  // Ensure the ggml model is present (direct SHA-verified HF download, no cmake).
  await ensureModel(modelName)

  // ── Windows: prebuilt whisper-cli (audit H3) ──────────────────────────────
  // No C++ toolchain needed. Auto-install the binary on first use, then spawn it
  // directly — the headline "run locally, zero terminal" promise actually holds
  // on a clean machine. Falls through to the source-build / error-floor below if
  // the prebuilt install fails for some reason.
  if (defaultWhisperRelease(process.platform, process.arch)) {
    if (!getWhisperCliPath()) {
      try { await installWhisperCli(null) } catch { /* fall through to floor */ }
    }
    const cli = getWhisperCliPath()
    if (cli) return runPrebuilt(cli, audio, modelName, language)
  }

  // ── Other platforms: nodejs-whisper (builds from source) or honest floor ───
  // macOS/Linux have no official prebuilt CLI; dev machines with a toolchain can
  // still build from source via nodejs-whisper. If that hasn't built, surface a
  // clear, actionable message instead of a cryptic cmake failure.
  if (!isWhisperCliBuilt()) {
    throw new Error(
      'Local speech-to-text is unavailable on this platform: there is no prebuilt whisper.cpp '
      + 'binary for it, and building from source needs a C++ toolchain (CMake + a compiler). '
      + 'Install build tools and retry, or use a cloud speech provider.',
    )
  }

  const { nodewhisper } = await import('nodejs-whisper')
  const tmpFile = join(app.getPath('temp'), `tachi-whisper-${Date.now()}.wav`)
  writeFileSync(tmpFile, audio)
  const t0 = Date.now()
  let rawText: string
  try {
    rawText = await nodewhisper(tmpFile, {
      modelName,
      modelRootPath: modelDir(modelName),
      removeWavFileAfterTranscription: false,
      whisperOptions: { outputInText: false, outputInSrt: false, outputInVtt: false, outputInJson: false, language, splitOnWord: true },
    })
  } finally {
    try { unlinkSync(tmpFile) } catch { /* best-effort */ }
    for (const ext of ['.txt', '.srt', '.vtt', '.json']) {
      try { unlinkSync(tmpFile.replace('.wav', ext)) } catch { /* ignore */ }
    }
  }
  return { text: parseWhisperOutput(rawText), duration_ms: Date.now() - t0 }
}

/**
 * Build whisper-cli args. Pure + exported so the arg contract is unit-tested
 * without spawning anything. whisper-cli prints the transcript to stdout in the
 * `[ts --> ts] text` format parseWhisperOutput expects.
 *
 * NOTE: whisper-cli expects 16 kHz mono 16-bit PCM WAV. The in-app mic path
 * (useWhisperRecognition: 16 kHz AudioContext + wav-encoder) already produces
 * exactly that; runPrebuilt validates it via whisperWavError() and fails fast on
 * any other format (the prebuilt binary has no ffmpeg). The nodejs-whisper
 * fallback (macOS/Linux source build) still accepts other formats via its ffmpeg.
 *
 * LANGUAGE (R10): defaults to `auto` — whisper.cpp detects the spoken language,
 * which is the right default in an 8-language app. A caller-supplied i18n locale
 * (`en-US`, `ru`, …) is normalized; an unsupported tag degrades to `auto`. An
 * English-only model (`ggml-*.en.bin`) THROWS on a non-English request instead of
 * emitting phonetic garbage.
 */
export function buildWhisperArgs(modelPath: string, wavPath: string, lang: string = 'auto'): string[] {
  return ['-m', modelPath, '-f', wavPath, '-l', resolveWhisperLanguage(modelPath, lang)]
}

/** Spawn the prebuilt whisper-cli, capture stdout, parse to transcript text. */
async function runPrebuilt(cli: string, audio: Buffer, modelName: WhisperModelName, lang: string = 'auto'): Promise<WhisperTranscribeResult> {
  // The prebuilt whisper-cli has no ffmpeg: feed it anything but 16 kHz mono 16-bit
  // PCM WAV and it garbles or exits cryptically. Fail fast + clearly instead. (The
  // in-app mic path already produces this; only an off-format file would trip it.)
  const wavErr = whisperWavError(audio)
  if (wavErr) throw new Error(`Cannot transcribe: ${wavErr}. Record via the in-app mic, or convert the file to 16 kHz mono WAV first.`)
  const tmpFile = join(app.getPath('temp'), `tachi-whisper-${Date.now()}.wav`)
  writeFileSync(tmpFile, audio)
  const t0 = Date.now()
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const proc = spawn(cli, buildWhisperArgs(whisperModelPath(modelName), tmpFile, lang), { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''; let err = ''
      proc.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
      proc.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8') })
      proc.on('error', reject)
      proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(`whisper-cli exited ${code}${err ? `: ${err.slice(-500)}` : ''}`)))
    })
    return { text: parseWhisperOutput(raw), duration_ms: Date.now() - t0 }
  } finally {
    try { unlinkSync(tmpFile) } catch { /* best-effort */ }
  }
}

// ─── Output parser ────────────────────────────────────────────────────────────

/**
 * whisper-cli stdout lines look like:
 *   [00:00:00.000 --> 00:00:02.340]   Hello world.
 *
 * Concatenate all speech segments, trimmed.
 */
export function parseWhisperOutput(raw: string): string {
  // Match timestamp header lines and extract trailing speech
  const lines = raw.split(/\r?\n/)
  const segments: string[] = []

  for (const line of lines) {
    // Format: [00:00:00.000 --> 00:00:02.340]  <speech>
    const m = line.match(/^\[[\d:.]+ --> [\d:.]+\]\s+(.+)$/)
    if (m?.[1]?.trim()) {
      segments.push(m[1].trim())
    }
  }

  if (segments.length > 0) {
    return segments.join(' ').trim()
  }

  // Fallback: strip timestamp headers and return whatever is left
  return lines
    .map(l => l.replace(/^\[[\d:.]+ --> [\d:.]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim()
}
