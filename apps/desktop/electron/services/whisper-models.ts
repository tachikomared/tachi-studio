// apps/desktop/electron/services/whisper-models.ts
//
// Pinned registries for the local Whisper speech-to-text engine.
//   - WHISPER_RELEASES: prebuilt whisper-cli binary per platform. We ship the
//     official ggml-org/whisper.cpp release zip (Windows x64, CPU build) so a
//     clean machine WITHOUT a C++ toolchain can transcribe — the audit H3 fix.
//     macOS/Linux have no official runnable CLI in the release assets, so they
//     return null and the service falls back to the build-from-source path +
//     the clear-error floor.
//   - WHISPER_MODELS: the ggml model weights (ggerganov/whisper.cpp on HF),
//     downloaded directly (decoupling model download from the cmake build).
//
// SHAs are authoritative: the binary digest is from the GitHub release API
// (asset.digest); model SHAs are HuggingFace LFS oids (the publisher's hash).
// Resolved/refreshable via scripts/fetch-model-shas.mjs conventions.

// v1.9.1: fixes split-UTF-8 tokens in verbose JSON output (garbled CJK/Cyrillic)
// + a more portable Windows BLAS build. Pins only — no new features wired.
export const WHISPER_VERSION = 'v1.9.1'
const REL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}`

export type WhisperPlatform = 'win-x64'
export interface WhisperRelease {
  platform: WhisperPlatform
  filename: string
  url:      string
  sha256:   string
}

export const WHISPER_RELEASES: WhisperRelease[] = [
  {
    platform: 'win-x64',
    filename:  'whisper-bin-x64.zip',
    url:       `${REL}/whisper-bin-x64.zip`,
    // v1.9.1 (CPU build; bundles whisper-cli.exe + DLLs). Hash computed from a
    // fresh download AND cross-checked against the GitHub release API digest.
    sha256:    '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
  },
]

export type WhisperModelName =
  | 'tiny.en' | 'base.en' | 'small.en' | 'medium.en'
  // R10 — the ONLY multilingual model we offer. Note it is *smaller* than the
  // medium.en (~1.5 GB) we already ship, and covers all 8 UI languages.
  | 'large-v3-turbo-q5_0'

export interface WhisperModelAsset {
  name:      WhisperModelName
  file:      string   // ggml-<model>.bin
  url:       string
  sha256:    string   // HuggingFace LFS oid
  /** Human label for the UI (binary units, rounded up). Display only. */
  sizeLabel: string
  /**
   * EXACT byte length, measured against the live URL and cross-checked with the
   * HF LFS pointer. This is what whisper-installer hands the download manager as
   * `approxTotalBytes`, i.e. what the DISK PREFLIGHT reserves against —
   * `approxBytesFromSizeLabel(sizeLabel)` is only the fallback for an asset that
   * has not been measured, and it can silently under-reserve by up to a MiB
   * because it re-parses a rounded string. Every asset here is measured, so the
   * fallback is never taken.
   */
  sizeBytes: number
}

// MEASURED 2026-07-27 by HEAD + redirect on every URL below: the numbers are the
// `Content-Length` of the 200 response, the 302's `X-Linked-Size` agreed on all
// five, and every `X-Linked-ETag` equalled the sha256 pinned here — so these
// URLs still serve the pinned bytes. Pinned by
// test/unit/speechModelSizes.test.ts; re-measure whenever a URL is repointed
// (a moved file changes both the size AND the sha).
//
//   model                  bytes          MiB       label
//   tiny.en                  77_704_715     74.105  ~75 MB
//   base.en                 147_964_211    141.110  ~142 MB
//   small.en                487_614_201    465.025  ~466 MB
//   medium.en             1_533_774_781   1462.722  ~1.5 GB
//   large-v3-turbo-q5_0     574_041_195    547.448  ~547 MB
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
export const WHISPER_MODELS: Record<WhisperModelName, WhisperModelAsset> = {
  'tiny.en':   { name: 'tiny.en',   file: 'ggml-tiny.en.bin',   url: `${HF}/ggml-tiny.en.bin`,   sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f', sizeLabel: '~75 MB',  sizeBytes:    77704715 },
  'base.en':   { name: 'base.en',   file: 'ggml-base.en.bin',   url: `${HF}/ggml-base.en.bin`,   sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', sizeLabel: '~142 MB', sizeBytes:   147964211 },
  'small.en':  { name: 'small.en',  file: 'ggml-small.en.bin',  url: `${HF}/ggml-small.en.bin`,  sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d', sizeLabel: '~466 MB', sizeBytes:   487614201 },
  'medium.en': { name: 'medium.en', file: 'ggml-medium.en.bin', url: `${HF}/ggml-medium.en.bin`, sha256: 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356', sizeLabel: '~1.5 GB', sizeBytes:  1533774781 },
  // Verified live 2026-07-26 against ggerganov/whisper.cpp on HuggingFace.
  'large-v3-turbo-q5_0': {
    name:      'large-v3-turbo-q5_0',
    file:      'ggml-large-v3-turbo-q5_0.bin',
    url:       `${HF}/ggml-large-v3-turbo-q5_0.bin`,
    sha256:    '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    sizeLabel: '~547 MB',
    sizeBytes: 574041195,
  },
}

/** The multilingual model to use when the user is not speaking English. */
export const MULTILINGUAL_WHISPER_MODEL: WhisperModelName = 'large-v3-turbo-q5_0'

export function isWhisperShaPlaceholder(sha: string): boolean {
  return /^__SHA_PLACEHOLDER_.*__$/.test(sha)
}

// ─── Language handling (R10) ──────────────────────────────────────────────────

/**
 * Languages we thread through the whisper CLI. `auto` = let whisper.cpp detect.
 * The non-auto entries mirror SUPPORTED_LOCALES in src/i18n/index.ts, because
 * the renderer sends the active UI locale as the transcription hint.
 */
export const WHISPER_LANGUAGES = ['auto', 'en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const
export type WhisperLanguage = typeof WHISPER_LANGUAGES[number]

/**
 * Normalize an i18n locale tag (`en`, `en-US`, `zh-Hans`, `pt-BR`) to a whisper
 * language code we support. Anything unknown (or absent) degrades to `auto`,
 * which is always safe — whisper.cpp then detects the language itself.
 */
export function normalizeWhisperLang(input?: string | null): WhisperLanguage {
  if (!input) return 'auto'
  const base = String(input).trim().toLowerCase().split(/[-_]/)[0]
  if (base === 'auto') return 'auto'
  return (WHISPER_LANGUAGES as readonly string[]).includes(base) ? (base as WhisperLanguage) : 'auto'
}

/**
 * True for the English-only ggml weights (`ggml-base.en.bin`, `small.en`, …).
 * Accepts either a bare model name or a full path.
 */
export function isEnglishOnlyModel(modelNameOrPath: string): boolean {
  return /\.en(\.bin)?$/i.test(String(modelNameOrPath).trim())
}

/**
 * Resolve the `-l` value for a given model.
 *
 * English-only weights CANNOT transcribe another language — they emit confident
 * garbage (phonetic English) rather than failing, which is the worst possible
 * outcome. So we fail loudly with an actionable message instead. `auto` on an
 * `.en` model is pinned to `en` (detection is meaningless there).
 */
export function resolveWhisperLanguage(modelNameOrPath: string, lang?: string | null): WhisperLanguage {
  const wanted = normalizeWhisperLang(lang)
  if (!isEnglishOnlyModel(modelNameOrPath)) return wanted
  if (wanted === 'auto' || wanted === 'en') return 'en'
  throw new Error(
    `This Whisper model is English-only and cannot transcribe "${wanted}". `
    + `Download the multilingual model (${MULTILINGUAL_WHISPER_MODEL}) in Settings → Speech-to-text.`,
  )
}

/**
 * Pick the model to transcribe with, given the locally-available models and the
 * language hint. English → prefer a ready `.en` model (they are small and fast);
 * anything else → the multilingual model (returned even when not yet downloaded,
 * so the caller's ensureModel() fetches it).
 */
export function pickWhisperModel(
  models: ReadonlyArray<{ name: string; ready?: boolean }>,
  lang?: string | null,
): WhisperModelName {
  const wanted = normalizeWhisperLang(lang)
  const ready = new Set(models.filter(m => m.ready).map(m => m.name))
  if (wanted !== 'en' && wanted !== 'auto') return MULTILINGUAL_WHISPER_MODEL
  const englishPreference: WhisperModelName[] = ['base.en', 'small.en', 'medium.en', 'tiny.en']
  return englishPreference.find(n => ready.has(n)) ?? 'base.en'
}

/**
 * Prebuilt whisper-cli release for this platform, or null (→ build/error path).
 *
 * macOS DECISION (audit H3 #3): ggml-org/whisper.cpp publishes no official
 * runnable macOS CLI (only an xcframework). The only prebuilt mac CLI is the
 * single-maintainer third-party `bizenlabs/whisper-cpp-macos-bin`, which we
 * deliberately do NOT bundle — pulling an unvetted third-party binary into a
 * privacy-first app is a supply-chain risk we won't take by default. macOS
 * therefore stays on the nodejs-whisper build-from-source path (Xcode CLT is
 * widely present on Macs) with the clear error-floor when no toolchain exists.
 */
export function defaultWhisperRelease(platform: NodeJS.Platform, arch: string): WhisperRelease | null {
  if (platform === 'win32' && arch === 'x64') return WHISPER_RELEASES.find(r => r.platform === 'win-x64') ?? null
  return null
}
