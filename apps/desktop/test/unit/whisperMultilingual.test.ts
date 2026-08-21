// apps/desktop/test/unit/whisperMultilingual.test.ts
//
// R9 (the dead chat mic) + R10 (multilingual STT) — the headless half of the
// proof. What is asserted here:
//
//   R10  · the `large-v3-turbo-q5_0` registry row carries the LIVE-verified
//          name / file / url / byte size / sha256 (a typo in any of them turns
//          into a 547 MB download that fails SHA verification on the user's
//          machine, so pin them in a test).
//        · language threading: `-l auto` by default, the active i18n locale
//          when given, and a LOUD failure when an English-only model is asked
//          to transcribe another language (it would otherwise emit confident
//          phonetic garbage — the worst failure mode).
//        · every UI locale can be sent as a hint and survives normalization.
//
//   R9   · source assertions on InputBar.tsx: the composer mic is wired to
//          useWhisperRecognition, useSpeechRecognition survives as the
//          `supported === false` fallback (dev browser), and the new
//          transcribing state is rendered + translated in all 8 locales.
//
// Pure data / source-text test: no electron runtime, no DOM, no React render.

import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// whisper-service imports electron's `app`; mock it so the pure arg builder can
// be imported without an Electron runtime.
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))

import { buildWhisperArgs } from '../../electron/services/whisper-service'
import {
  WHISPER_MODELS, MULTILINGUAL_WHISPER_MODEL, WHISPER_LANGUAGES,
  normalizeWhisperLang, isEnglishOnlyModel, resolveWhisperLanguage, pickWhisperModel,
} from '../../electron/services/whisper-models'

const DESKTOP = path.resolve(__dirname, '../..')
const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

// ─── R10 · the model row ──────────────────────────────────────────────────────

describe('R10 — large-v3-turbo-q5_0 registry row', () => {
  const asset = WHISPER_MODELS['large-v3-turbo-q5_0']

  it('is the multilingual model the rest of the code reaches for', () => {
    expect(MULTILINGUAL_WHISPER_MODEL).toBe('large-v3-turbo-q5_0')
    expect(asset).toBeDefined()
  })

  it('pins the live-verified name / file / url / size / sha256', () => {
    expect(asset.name).toBe('large-v3-turbo-q5_0')
    expect(asset.file).toBe('ggml-large-v3-turbo-q5_0.bin')
    expect(asset.url).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    )
    expect(asset.sizeBytes).toBe(574041195)
    expect(asset.sha256).toBe('394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2')
  })

  it('advertises a size label consistent with the exact byte count', () => {
    // ~547 MB — deliberately SMALLER than the medium.en (~1.5 GB) already offered.
    expect(asset.sizeLabel).toBe('~547 MB')
    const labelledMb = Number(/([\d.]+)\s*MB/.exec(asset.sizeLabel)![1])
    expect(Math.abs(labelledMb - asset.sizeBytes! / 1024 ** 2)).toBeLessThan(1)
  })

  it('is the only multilingual row — every other model is English-only', () => {
    for (const m of Object.values(WHISPER_MODELS)) {
      expect(isEnglishOnlyModel(m.name)).toBe(m.name !== 'large-v3-turbo-q5_0')
      expect(isEnglishOnlyModel(m.file)).toBe(m.name !== 'large-v3-turbo-q5_0')
    }
  })

  it('is reachable from the settings model picker + has a description in all 8 locales', () => {
    const section = fs.readFileSync(path.join(DESKTOP, 'src/pages/settings/WhisperSection.tsx'), 'utf8')
    expect(section).toContain("value: 'large-v3-turbo-q5_0'")
    for (const lang of LANGS) {
      const json = JSON.parse(fs.readFileSync(path.join(DESKTOP, `src/i18n/locales/${lang}/settings.json`), 'utf8'))
      const desc = json.whisper.modelDescriptions['large-v3-turbo-q5_0']
      expect(typeof desc, `${lang}/settings.json`).toBe('string')
      expect(desc.length, `${lang}/settings.json`).toBeGreaterThan(0)
    }
  })
})

// ─── R10 · language normalization ─────────────────────────────────────────────

describe('R10 — normalizeWhisperLang', () => {
  it('passes through every supported UI locale', () => {
    for (const lang of LANGS) expect(normalizeWhisperLang(lang)).toBe(lang)
  })
  it('strips region / script subtags from i18n locale tags', () => {
    expect(normalizeWhisperLang('en-US')).toBe('en')
    expect(normalizeWhisperLang('ru-RU')).toBe('ru')
    expect(normalizeWhisperLang('zh-Hans')).toBe('zh')
    expect(normalizeWhisperLang('pt_BR')).toBe('auto')   // unsupported → detect
  })
  it('degrades anything unknown / absent to auto (never throws)', () => {
    expect(normalizeWhisperLang(undefined)).toBe('auto')
    expect(normalizeWhisperLang(null)).toBe('auto')
    expect(normalizeWhisperLang('')).toBe('auto')
    expect(normalizeWhisperLang('klingon')).toBe('auto')
    expect(normalizeWhisperLang('; rm -rf /')).toBe('auto')
  })
  it('only ever yields a whitelisted value (nothing unvetted reaches the CLI)', () => {
    for (const input of ['en-GB', 'ZH', 'xx', 'auto', '--output-file', undefined]) {
      expect(WHISPER_LANGUAGES).toContain(normalizeWhisperLang(input))
    }
  })
})

// ─── R10 · the arg builder ────────────────────────────────────────────────────

describe('R10 — buildWhisperArgs language threading', () => {
  const MULTI = '/models/ggml-large-v3-turbo-q5_0.bin'
  const EN    = '/models/ggml-base.en.bin'

  it('emits -l auto by default on a multilingual model', () => {
    expect(buildWhisperArgs(MULTI, '/tmp/a.wav'))
      .toEqual(['-m', MULTI, '-f', '/tmp/a.wav', '-l', 'auto'])
  })

  it('emits the active locale when given one', () => {
    expect(buildWhisperArgs(MULTI, '/tmp/a.wav', 'ru')).toEqual(['-m', MULTI, '-f', '/tmp/a.wav', '-l', 'ru'])
    expect(buildWhisperArgs(MULTI, '/tmp/a.wav', 'zh-Hans')).toEqual(['-m', MULTI, '-f', '/tmp/a.wav', '-l', 'zh'])
  })

  it('accepts every shipped UI locale as a hint', () => {
    for (const lang of LANGS) {
      expect(buildWhisperArgs(MULTI, '/tmp/a.wav', lang).slice(-2)).toEqual(['-l', lang])
    }
  })

  it('falls back to auto for a locale whisper has no code for', () => {
    expect(buildWhisperArgs(MULTI, '/tmp/a.wav', 'pt-BR').slice(-2)).toEqual(['-l', 'auto'])
  })

  it('THROWS for an .en model + a non-English language instead of emitting garbage', () => {
    expect(() => buildWhisperArgs(EN, '/tmp/a.wav', 'ru')).toThrow(/English-only/i)
    expect(() => buildWhisperArgs(EN, '/tmp/a.wav', 'ru')).toThrow(/large-v3-turbo-q5_0/)
    expect(() => buildWhisperArgs(EN, '/tmp/a.wav', 'ja')).toThrow()
  })

  it('pins an .en model to en for both `en` and `auto`', () => {
    expect(buildWhisperArgs(EN, '/tmp/a.wav', 'en').slice(-2)).toEqual(['-l', 'en'])
    expect(buildWhisperArgs(EN, '/tmp/a.wav', 'auto').slice(-2)).toEqual(['-l', 'en'])
    expect(buildWhisperArgs(EN, '/tmp/a.wav', 'en-US').slice(-2)).toEqual(['-l', 'en'])
  })

  it('resolveWhisperLanguage is the single source of that contract', () => {
    expect(resolveWhisperLanguage('large-v3-turbo-q5_0', 'ru')).toBe('ru')
    expect(resolveWhisperLanguage('base.en', 'auto')).toBe('en')
    expect(() => resolveWhisperLanguage('base.en', 'de')).toThrow(/English-only/i)
  })
})

// ─── R10 · model selection from the locale ────────────────────────────────────

describe('R10 — pickWhisperModel', () => {
  const ready = (...names: string[]) =>
    Object.values(WHISPER_MODELS).map(m => ({ name: m.name, ready: names.includes(m.name) }))

  it('reaches for the multilingual model whenever the UI is not English', () => {
    for (const lang of ['ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko']) {
      expect(pickWhisperModel(ready('base.en'), lang)).toBe('large-v3-turbo-q5_0')
    }
  })

  it('returns the multilingual model even when it is not downloaded yet (caller fetches it)', () => {
    expect(pickWhisperModel(ready(), 'ru')).toBe('large-v3-turbo-q5_0')
  })

  it('prefers a ready English model for en / auto', () => {
    expect(pickWhisperModel(ready('small.en'), 'en')).toBe('small.en')
    expect(pickWhisperModel(ready('base.en', 'small.en'), 'en-US')).toBe('base.en')
    expect(pickWhisperModel(ready('tiny.en'), 'auto')).toBe('tiny.en')
  })

  it('falls back to base.en when nothing is downloaded and the UI is English', () => {
    expect(pickWhisperModel([], 'en')).toBe('base.en')
    expect(pickWhisperModel([], undefined)).toBe('base.en')
  })
})

// ─── R9 · the composer mic is wired to whisper ────────────────────────────────

describe('R9 — chat composer mic runs on local whisper', () => {
  const inputBar = fs.readFileSync(path.join(DESKTOP, 'src/pages/chat/InputBar.tsx'), 'utf8')
  const hook     = fs.readFileSync(path.join(DESKTOP, 'src/hooks/useWhisperRecognition.ts'), 'utf8')

  it('imports and calls useWhisperRecognition', () => {
    expect(inputBar).toContain("import { useWhisperRecognition } from '../../hooks/useWhisperRecognition'")
    expect(inputBar).toMatch(/useWhisperRecognition\(\{[^}]*onFinal/)
  })

  it('passes the active i18n locale through as the transcription hint', () => {
    expect(inputBar).toMatch(/useTranslation\('chat'\)/)
    expect(inputBar).toContain('lang: i18n.language')
  })

  it('keeps useSpeechRecognition as the supported === false fallback (dev browser)', () => {
    expect(inputBar).toContain("import { useSpeechRecognition } from '../../hooks/useSpeechRecognition'")
    expect(inputBar).toContain('whisperVoice.supported ? whisperVoice : webSpeechVoice')
  })

  it('renders a distinct transcribing state on the mic button', () => {
    expect(inputBar).toContain("t('composer.transcribing')")
    expect(inputBar).toContain('const voiceProcessing =')
    // The button must not stay clickable (and lying "REC") while transcribing.
    expect(inputBar).toContain('disabled={voiceProcessing}')
    expect(inputBar).toContain('const recording = listening && !voiceProcessing')
  })

  it('ships composer.transcribing in all 8 locales (no English leak)', () => {
    const seen = new Set<string>()
    for (const lang of LANGS) {
      const json = JSON.parse(fs.readFileSync(path.join(DESKTOP, `src/i18n/locales/${lang}/chat.json`), 'utf8'))
      const v = json.composer.transcribing
      expect(typeof v, `${lang}/chat.json`).toBe('string')
      expect(v.length, `${lang}/chat.json`).toBeGreaterThan(0)
      seen.add(v)
    }
    // Sanity: not the same English string copy-pasted into every locale.
    expect(seen.size).toBeGreaterThan(4)
  })

  it('the hook forwards model + language to the transcribe IPC', () => {
    expect(hook).toContain('window.tachi.whisper.transcribe(audioBase64, effectiveModel, language)')
    expect(hook).toContain('normalizeWhisperLang')
    expect(hook).toContain('pickWhisperModel')
    // Contract kept: whisper returns final text only, so no English placeholder
    // ever lands in the interim banner.
    expect(hook).not.toContain("setInterim('Recording…')")
    expect(hook).not.toContain("setInterim('Transcribing…')")
  })
})

// ─── R10 · IPC + preload thread the lang through ──────────────────────────────

describe('R10 — transcribe IPC carries the language hint', () => {
  it('the zod payload accepts an optional lang and the new model name', () => {
    const ipc = fs.readFileSync(path.join(DESKTOP, 'electron/ipc/whisper.ipc.ts'), 'utf8')
    expect(ipc).toContain("'large-v3-turbo-q5_0'")
    expect(ipc).toContain('lang:        LangSchema.optional()')
    expect(ipc).toContain('transcribe(audio, modelName as WhisperModelName, lang)')
  })

  it('preload forwards lang to the main process', () => {
    const preload = fs.readFileSync(path.join(DESKTOP, 'electron/preload.ts'), 'utf8')
    expect(preload).toContain("ipcRenderer.invoke('whisper:transcribe', { audioBase64, modelName, lang })")
  })

  it('all four WhisperModelName declarations list the multilingual model', () => {
    for (const rel of [
      'electron/services/whisper-service.ts',
      'electron/services/whisper-models.ts',
      'electron/ipc/whisper.ipc.ts',
      'src/types/electron.d.ts',
    ]) {
      expect(fs.readFileSync(path.join(DESKTOP, rel), 'utf8'), rel).toContain("'large-v3-turbo-q5_0'")
    }
  })
})
