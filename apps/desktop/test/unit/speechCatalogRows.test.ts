// apps/desktop/test/unit/speechCatalogRows.test.ts
//
// BATCH35 LANE A — piper TTS voices + whisper STT weights as first-class rows
// in the unified catalog browser.
//
// The curated rows themselves already existed; what did not was everything that
// makes a row honest once it is on screen:
//   - Stop on an in-flight download (both route through the download-manager;
//     whisper medium.en is ~1.5 GB)
//   - a place to SEE and REMOVE what is on disk (the Installed tab listed
//     neither, so a 1.5 GB weight had no delete surface at all)
// This file drives the store's init() against a stubbed window.tachi to assert
// the ROWS, then pins the main-process wiring by source (no electron in a
// node-env test).

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// --- shims installed BEFORE the store module is imported ---------------------
const lsMap = new Map<string, string>()
;(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (lsMap.has(k) ? lsMap.get(k)! : null),
  setItem: (k: string, v: string) => { lsMap.set(k, v) },
  removeItem: (k: string) => { lsMap.delete(k) },
  clear: () => { lsMap.clear() },
  key: (i: number) => Array.from(lsMap.keys())[i] ?? null,
  get length() { return lsMap.size },
}

const PIPER_VOICES = [
  { id: 'en_US-amy-medium', name: 'Amy — US English (medium)', lang: 'en_US', quality: 'medium', sizeMb: 63 },
  { id: 'en_US-amy-low',    name: 'Amy — US English (low, smallest)', lang: 'en_US', quality: 'low', sizeMb: 28 },
]
const WHISPER_MODELS = [
  { name: 'tiny.en',   sizeLabel: '~75 MB',  ready: false },
  { name: 'base.en',   sizeLabel: '~142 MB', ready: true  },
  { name: 'medium.en', sizeLabel: '~1.5 GB', ready: false },
]

;(globalThis as unknown as { window: unknown }).window = globalThis
;(globalThis as unknown as { tachi: unknown }).tachi = {
  catalog: {
    hardware:  async () => ({ platform: 'win32', arch: 'x64', ramTotalBytes: 32e9, ramFreeBytes: 16e9, cpuCores: 8, gpus: [], vramFreeBytes: 8e9, isAppleSilicon: false }),
    installed: async () => ({ models: [] }),
    curated:   async () => ({ entries: [] }),
  },
  sdCpp:   { catalog: async () => ({ ok: true, models: [] }), status: async () => ({ models: [] }) },
  piper:   { catalog: async () => ({ ok: true, voices: PIPER_VOICES }), status: async () => ({ voices: [{ id: 'en_US-amy-low' }] }) },
  whisper: { checkInstalled: async () => ({ models: WHISPER_MODELS }) },
}

type StoreMod = typeof import('../../src/pages/catalog/catalog.store')
let useCatalogStore: StoreMod['useCatalogStore']

beforeAll(async () => {
  ;({ useCatalogStore } = await import('../../src/pages/catalog/catalog.store'))
  await useCatalogStore.getState().init()
})

const byId = (id: string) => useCatalogStore.getState().curated.find(e => e.id === id)

describe('piper voice rows', () => {
  it('builds one curated row per catalog voice', () => {
    expect(byId('piper:en_US-amy-medium')).toBeDefined()
    expect(byId('piper:en_US-amy-low')).toBeDefined()
  })

  it('carries the tts capability so the TTS filter chip finds it', () => {
    expect(byId('piper:en_US-amy-medium')!.capabilities).toEqual(['tts'])
  })

  it('is a speech row (so ModelCard suppresses the VRAM verdict)', () => {
    expect(byId('piper:en_US-amy-medium')!.kind).toBe('speech')
  })

  it('carries the language and quality where the card shows family/params', () => {
    const row = byId('piper:en_US-amy-medium')!
    expect(row.family).toContain('en_US')
    expect(row.params).toBe('medium')
  })

  it('exposes exactly one piper quant whose ref is the voice id the IPC takes', () => {
    const q = byId('piper:en_US-amy-medium')!.quants
    expect(q).toHaveLength(1)
    expect(q[0].runtime).toBe('piper')
    expect(q[0].ref).toBe('en_US-amy-medium')
    expect(q[0].sizeBytes).toBe(63 * 1024 * 1024)
  })

  it('tracks installed voices separately from the InstalledModel list', () => {
    const s = useCatalogStore.getState()
    expect(s.piperInstalledIds).toEqual(['en_US-amy-low'])
    expect(s.isInstalled('piper', 'en_US-amy-low')).toBe(true)
    expect(s.isInstalled('piper', 'en_US-amy-medium')).toBe(false)
  })
})

describe('whisper STT rows', () => {
  it('builds one curated row per registry model, downloaded or not', () => {
    for (const m of WHISPER_MODELS) expect(byId(`whisper:${m.name}`), m.name).toBeDefined()
  })

  it('carries the stt capability and the speech kind', () => {
    const row = byId('whisper:base.en')!
    expect(row.capabilities).toEqual(['stt'])
    expect(row.kind).toBe('speech')
  })

  it('parses the registry size label into real bytes for the size line', () => {
    expect(byId('whisper:tiny.en')!.quants[0].sizeBytes).toBe(75 * 1024 * 1024)
    expect(byId('whisper:medium.en')!.quants[0].sizeBytes).toBe(Math.round(1.5 * 1024 ** 3))
  })

  it('refs the bare model name — what whisper:download-model / :remove-model take', () => {
    expect(byId('whisper:medium.en')!.quants[0].ref).toBe('medium.en')
    expect(byId('whisper:medium.en')!.quants[0].runtime).toBe('whisper')
  })

  it('marks only READY models installed — a listed-but-absent weight must still offer DOWNLOAD', () => {
    const s = useCatalogStore.getState()
    expect(s.whisperInstalledIds).toEqual(['base.en'])
    expect(s.isInstalled('whisper', 'base.en')).toBe(true)
    expect(s.isInstalled('whisper', 'medium.en')).toBe(false)
  })
})

describe('filter + search reach the new rows', () => {
  it('every speech row has exactly one of the tts/stt tags the chip row renders', async () => {
    const { searchEntries } = await import('../../src/pages/catalog/search')
    const all = useCatalogStore.getState().curated
    expect(searchEntries(all, '', ['tts'] as never).map(e => e.id).sort())
      .toEqual(['piper:en_US-amy-low', 'piper:en_US-amy-medium'])
    expect(searchEntries(all, '', ['stt'] as never)).toHaveLength(WHISPER_MODELS.length)
  })

  it('the tts and stt chips are both in the rendered ALL_TAGS list', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/pages/catalog/CatalogPage.tsx'), 'utf8')
    const line = src.split('\n').find(l => l.includes('const ALL_TAGS'))!
    expect(line).toContain("'tts'")
    expect(line).toContain("'stt'")
  })

  it('finds a whisper model by name and a voice by its language', async () => {
    const { searchEntries } = await import('../../src/pages/catalog/search')
    const all = useCatalogStore.getState().curated
    expect(searchEntries(all, 'whisper', []).length).toBeGreaterThan(0)
    expect(searchEntries(all, 'amy', []).map(e => e.id)).toContain('piper:en_US-amy-medium')
  })
})

// ─── main-process wiring (source pins) ───────────────────────────────────────

const svc = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../electron', rel), 'utf8')

describe('piper: stop + one managed-id source of truth', () => {
  const inst = svc('services/piper-installer.ts')
  const ipc  = svc('ipc/piper.ipc.ts')

  it('derives the manager task id from one helper, used by BOTH download and stop', () => {
    expect(inst).toContain('export function voiceManagedId')
    expect(inst).toContain('const managedId = voiceManagedId(id)')
    expect(inst).toContain('return pauseManagedDownload(voiceManagedId(id))')
  })

  it('stop is PAUSE — it must not delete the partial', () => {
    expect(inst).toContain('pauseManagedDownload')
    expect(inst).not.toContain('cancelManagedDownload')
  })

  it('documents that the tiny .onnx.json sidecar is NOT pausable rather than implying it is', () => {
    expect(inst).toContain('HONEST SCOPE')
    expect(inst).toMatch(/onnx\.json[\s\S]{0,200}not pausable/)
  })

  it('exposes piper:cancel-download and reports cancelled:false honestly', () => {
    expect(ipc).toContain("ipcMain.handle('piper:cancel-download'")
    expect(ipc).toContain('cancelled: cancelVoiceDownload(id)')
    expect(ipc).toContain('cancelled:false')
  })
})

describe('whisper: stop + remove', () => {
  const inst = svc('services/whisper-installer.ts')
  const ipc  = svc('ipc/whisper.ipc.ts')

  it('derives the manager task id from one helper, used by BOTH download and stop', () => {
    expect(inst).toContain('export function whisperManagedId')
    expect(inst).toContain('const managedId = whisperManagedId(name)')
    expect(inst).toContain('return pauseManagedDownload(whisperManagedId(name))')
  })

  it('stop is PAUSE — the up-to-1.5 GB partial survives', () => {
    expect(inst).toContain('pauseManagedDownload')
    expect(inst).not.toContain('cancelManagedDownload')
  })

  it('removes by the REGISTRY filename, never by re-deriving ggml-<name>.bin', () => {
    expect(inst).toContain('export function removeWhisperModel')
    expect(inst).toContain('WHISPER_MODELS as Record<string, { file: string } | undefined>')
    expect(inst).toContain("removeResolved('whisper', asset.file)")
    // an unknown name is refused, not turned into a path
    expect(inst).toContain('Unknown whisper model')
  })

  it('validates both new channels against the model-name enum', () => {
    expect(ipc).toContain("ipcMain.handle('whisper:cancel-download'")
    expect(ipc).toContain("ipcMain.handle('whisper:remove-model'")
    expect(ipc.match(/z\.object\(\{ modelName: ModelNameSchema \}\)\.safeParse/g) ?? []).toHaveLength(2)
  })
})

describe('preload exposes the new channels', () => {
  const pre = svc('preload.ts')

  it('piper.cancelDownload', () => {
    expect(pre).toContain("ipcRenderer.invoke('piper:cancel-download', { id })")
  })

  it('whisper.cancelDownload + whisper.removeModel', () => {
    expect(pre).toContain("ipcRenderer.invoke('whisper:cancel-download', { modelName })")
    expect(pre).toContain("ipcRenderer.invoke('whisper:remove-model', { modelName })")
  })
})

describe('the Installed tab can finally see (and free) speech weights', () => {
  const cat = svc('services/catalog-service.ts')

  it('lists downloaded piper voices with the REAL .onnx byte size', () => {
    expect(cat).toContain('listInstalledVoices()')
    expect(cat).toContain('statSync(voiceOnnxPath(id)).size')
    expect(cat).toContain("runtime: 'piper'")
  })

  it('lists downloaded whisper weights, skipping the ones not on disk', () => {
    expect(cat).toContain('whisperModelPath(name)')
    expect(cat).toContain("runtime: 'whisper'")
    expect(cat).toMatch(/statSync\(path\)\.size \} catch \{ continue \}/)
  })

  it('never fails the whole installed list when one engine dir is unreadable', () => {
    // both new sections are individually try/caught, like the ollama one
    expect(cat.match(/catch \{ \/\* (piper|whisper) dirs unreadable/g) ?? []).toHaveLength(2)
  })

  it('routes REMOVE per runtime — ollama.delete() on a voice would be a confident no-op', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../src/pages/catalog/CatalogPage.tsx'), 'utf8')
    expect(page).toContain('window.tachi.piper.removeVoice(m.ref)')
    expect(page).toContain('window.tachi.whisper.removeModel(m.ref as never)')
  })

  it('formats small weights with the shared binary formatter, not a hardcoded GB.toFixed(1)', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../src/pages/catalog/CatalogPage.tsx'), 'utf8')
    expect(page).toContain('formatModelSize(m.sizeBytes)')
    expect(page).not.toContain('(m.sizeBytes / (1024 ** 3)).toFixed(1)')
  })
})

describe('catalog i18n — the new keys exist in all 8 locales', () => {
  const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

  it('downloadSize + notice.nothingToStop are present and non-empty everywhere', () => {
    for (const lang of LANGS) {
      const j = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, `../../src/i18n/locales/${lang}/catalog.json`), 'utf8'))
      expect(typeof j.downloadSize, lang).toBe('string')
      expect(j.downloadSize.length, lang).toBeGreaterThan(0)
      expect(typeof j.notice?.nothingToStop, lang).toBe('string')
      expect(j.notice.nothingToStop.length, lang).toBeGreaterThan(0)
    }
  })

  it('keeps the tts/stt capability labels the chips render', () => {
    for (const lang of LANGS) {
      const j = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, `../../src/i18n/locales/${lang}/catalog.json`), 'utf8'))
      expect(j.capabilities?.tts, lang).toBeTruthy()
      expect(j.capabilities?.stt, lang).toBeTruthy()
    }
  })
})
