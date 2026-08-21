// apps/desktop/test/unit/whisper.test.ts
//
// Audit H3 — local STT via prebuilt whisper-cli. These pure-function tests are
// the headless proof of the value (the actual transcription quality + 16 kHz
// WAV handling need a clean-Windows manual QA, tracked as a chip).

import { describe, it, expect, vi } from 'vitest'

// whisper-service (and whisper-installer) import electron's `app`; mock it so
// the pure helpers can be imported without an Electron runtime.
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))

import { buildWhisperArgs, parseWhisperOutput } from '../../electron/services/whisper-service'
import { defaultWhisperRelease, isWhisperShaPlaceholder, WHISPER_MODELS, WHISPER_RELEASES } from '../../electron/services/whisper-models'

describe('buildWhisperArgs', () => {
  it('builds the exact whisper-cli arg vector', () => {
    expect(buildWhisperArgs('/m/ggml-base.en.bin', '/tmp/a.wav', 'en'))
      .toEqual(['-m', '/m/ggml-base.en.bin', '-f', '/tmp/a.wav', '-l', 'en'])
  })
  // R10: the default is now `auto` (whisper.cpp detects the language) for
  // multilingual weights; `.en` weights still pin to `en`.
  it('defaults language to auto for multilingual weights', () => {
    expect(buildWhisperArgs('m', 'w')).toEqual(['-m', 'm', '-f', 'w', '-l', 'auto'])
  })
  it('pins an .en model to en even when asked for auto', () => {
    expect(buildWhisperArgs('/m/ggml-base.en.bin', 'w')).toEqual(['-m', '/m/ggml-base.en.bin', '-f', 'w', '-l', 'en'])
  })
})

describe('parseWhisperOutput', () => {
  it('extracts speech from timestamped whisper-cli stdout', () => {
    const raw = [
      '[00:00:00.000 --> 00:00:02.340]  Hello world.',
      '[00:00:02.340 --> 00:00:04.100]  How are you?',
    ].join('\n')
    expect(parseWhisperOutput(raw)).toBe('Hello world. How are you?')
  })
  it('ignores non-segment noise lines', () => {
    const raw = 'whisper_init_from_file: loading model\n[00:00:00.000 --> 00:00:01.000]  Hi.\nsystem_info: n_threads = 4'
    expect(parseWhisperOutput(raw)).toBe('Hi.')
  })
  it('falls back to stripping timestamp headers when no segment matches cleanly', () => {
    expect(parseWhisperOutput('[00:00:00.000 --> 00:00:01.000] Test')).toBe('Test')
  })
})

describe('whisper-models registry', () => {
  it('offers a Windows-x64 prebuilt with a real (non-placeholder) SHA', () => {
    const r = defaultWhisperRelease('win32', 'x64')
    expect(r).not.toBeNull()
    expect(r!.filename).toBe('whisper-bin-x64.zip')
    expect(isWhisperShaPlaceholder(r!.sha256)).toBe(false)
    expect(r!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
  it('returns null for platforms without an official prebuilt CLI (mac/linux)', () => {
    expect(defaultWhisperRelease('darwin', 'arm64')).toBeNull()
    expect(defaultWhisperRelease('linux', 'x64')).toBeNull()
  })
  it('every release + model has a real pinned SHA (fail-closed-ready)', () => {
    for (const r of WHISPER_RELEASES) expect(isWhisperShaPlaceholder(r.sha256)).toBe(false)
    for (const m of Object.values(WHISPER_MODELS)) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(m.url).toContain('huggingface.co/ggerganov/whisper.cpp')
    }
  })
})
