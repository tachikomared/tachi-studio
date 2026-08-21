// apps/desktop/test/unit/catalogSdInstalled.test.ts
//
// WAVE 1 LANE D — the Installed tab can finally SEE (and free) sd.cpp weights.
//
// catalog-service.listInstalledModels covered llama.cpp, piper, whisper and
// Ollama and NOT sd.cpp — so the largest things the app ever writes (5-18 GB of
// local image/video checkpoints) were listed by nothing, and `sd-cpp:remove-model`
// sat fully implemented with zero renderer callers. There was no way to free
// those gigabytes from the UI at all.
//
// The hard part is not the listing, it is the ARITHMETIC. Curated sd rows share
// components on purpose (one 5.6 GB umt5 encoder, hard-linked into three rows),
// so the naive per-row sum invents tens of gigabytes that are not on the volume,
// and a REMOVE dialog that quotes it promises back bytes the disk is going to
// keep. This file drives the service against a FAKE REGISTRY and a FAKE fs whose
// inodes and link counts are set by hand, and pins:
//
//   • each physical file charged EXACTLY once across the whole list (Σ rows ==
//     Σ distinct inodes — the identity asserted below);
//   • `freeableBytes` = what deleting the row actually returns, never more;
//   • `sharedWith` naming the other INSTALLED rows that keep the rest;
//   • the COPY fallback (distinct inodes, no hard link) counted twice, because
//     it really is two copies;
//   • one unreadable sd surface never taking the other four runtimes down.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const MB = 1024 * 1024

/** One fake file on the fake volume. `nlink` is the real filesystem fact the
 *  accounting leans on: 2 means another NAME for these exact bytes exists. */
interface FakeFile { ino: number; sizeMb: number; nlink: number }

const fixture = vi.hoisted(() => ({
  /** Installed rows, exactly as listInstalledSdModels returns them. */
  rows: [] as Array<{ id: string; name: string; kind: 'image' | 'video'; family: string; steps: number; cfgScale: number; samplingMethod: string }>,
  /** modelId -> role -> path */
  paths: new Map<string, Record<string, string>>(),
  /** path -> the file it names (absent = ENOENT) */
  files: new Map<string, { ino: number; sizeMb: number; nlink: number }>(),
  /** listInstalledSdModels blows up (unreadable model dirs). */
  listThrows: false,
}))

// Only statSync is faked — this file also READS the renderer source through the
// same module, and a wholesale mock would take readFileSync with it.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const statSync = (p: string, opts?: { bigint?: boolean }) => {
    const f = fixture.files.get(p)
    if (!f) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    // The service asks for bigint stats (dev/ino are 64-bit); mirror that.
    return opts?.bigint
      ? { dev: 1n, ino: BigInt(f.ino), size: BigInt(f.sizeMb * MB), nlink: BigInt(f.nlink) }
      : { dev: 1, ino: f.ino, size: f.sizeMb * MB, nlink: f.nlink }
  }
  return { ...actual, default: { ...actual, statSync }, statSync }
})

vi.mock('../../electron/services/sd-cpp-installer', () => ({
  listInstalledSdModels: () => {
    if (fixture.listThrows) throw new Error('model root unreadable')
    return fixture.rows
  },
  modelComponentPaths: (id: string) => fixture.paths.get(id) ?? null,
}))

// Everything else catalog-service imports is stubbed to nothing — this file is
// about the sd section, and the real modules reach for `electron`.
vi.mock('@tachi/core', () => ({ deriveCapabilities: () => [] }))
vi.mock('../../electron/services/llama-cpp-models', () => ({ GGUF_MODELS: [] }))
vi.mock('../../electron/services/llama-cpp-installer', () => ({ listDownloadedModels: () => [], ggufModelPath: (id: string) => `/gguf/${id}` }))
vi.mock('../../electron/services/ollama-service', () => ({ listOllamaModels: async () => [], isOllamaRunning: async () => false }))
vi.mock('../../electron/services/piper-models', () => ({ PIPER_VOICES: [{ id: 'en_US-amy-low', name: 'Amy (low)', sizeMb: 28 }] }))
vi.mock('../../electron/services/piper-installer', () => ({ listInstalledVoices: () => [{ id: 'en_US-amy-low' }], voiceOnnxPath: (id: string) => `/piper/${id}.onnx` }))
vi.mock('../../electron/services/whisper-models', () => ({ WHISPER_MODELS: {} }))
vi.mock('../../electron/services/whisper-installer', () => ({ whisperModelPath: (n: string) => `/whisper/${n}.bin` }))

type Svc = typeof import('../../electron/services/catalog-service')
let listInstalledSdRows: Svc['listInstalledSdRows']
let listInstalledModels: Svc['listInstalledModels']

/** Register one row and its components on the fake volume. */
function install(
  row: { id: string; name: string; kind: 'image' | 'video' },
  components: Record<string, FakeFile>,
): void {
  fixture.rows.push({ ...row, family: 'wan', steps: 20, cfgScale: 7, samplingMethod: 'euler' })
  const paths: Record<string, string> = {}
  for (const [role, f] of Object.entries(components)) {
    const p = `/models/sd/${row.id}/${role}.safetensors`
    paths[role] = p
    fixture.files.set(p, f)
  }
  fixture.paths.set(row.id, paths)
}

// The real shape, in miniature: the two Wan rows hard-link one umt5 encoder and
// one vae between them; FLUX's autoencoder is hard-linked to a Z-Image row that
// is NOT fully installed (so it is not a holder, but the link count is still 2).
const T5XXL   = { ino: 100, sizeMb: 5600, nlink: 2 }
const WAN_VAE = { ino: 101, sizeMb:  500, nlink: 2 }
function installTheRealShape(): void {
  install({ id: 'wan21-t2v-1.3b',     name: 'Wan 2.1 T2V 1.3B', kind: 'video' },
    { model: { ino: 102, sizeMb: 1400, nlink: 1 }, vae: WAN_VAE, t5xxl: T5XXL })
  install({ id: 'wan21-i2v-14b-480p', name: 'Wan 2.1 I2V 14B',  kind: 'video' },
    { model: { ino: 103, sizeMb: 16000, nlink: 1 }, vae: WAN_VAE, t5xxl: T5XXL })
  install({ id: 'sd-turbo',           name: 'SD-Turbo',         kind: 'image' },
    { model: { ino: 200, sizeMb: 2500, nlink: 1 } })
  install({ id: 'flux-schnell-q4',    name: 'FLUX.1 schnell',   kind: 'image' },
    { model: { ino: 300, sizeMb: 6800, nlink: 1 }, vae: { ino: 301, sizeMb: 160, nlink: 2 } })
}

/** True bytes on the fake volume: every distinct inode, once. */
function trueDiskMb(): number {
  const seen = new Map<number, number>()
  for (const f of fixture.files.values()) seen.set(f.ino, f.sizeMb)
  return [...seen.values()].reduce((a, b) => a + b, 0)
}

beforeEach(async () => {
  fixture.rows = []
  fixture.paths = new Map()
  fixture.files = new Map()
  fixture.listThrows = false
  ;({ listInstalledSdRows, listInstalledModels } = await import('../../electron/services/catalog-service'))
})

const by = (rows: Array<{ ref: string }>, ref: string) => rows.find(r => r.ref === ref)!

describe('sd.cpp rows appear on the Installed tab at all', () => {
  it('lists one row per installed checkpoint, refd by the id the remove IPC takes', () => {
    installTheRealShape()
    const rows = listInstalledSdRows()
    expect(rows.map(r => r.ref)).toEqual(['wan21-t2v-1.3b', 'wan21-i2v-14b-480p', 'sd-turbo', 'flux-schnell-q4'])
    expect(rows.every(r => r.runtime === 'sdcpp')).toBe(true)
    // the NAME, never the raw id — 'civitai-812345' is what the media dropdown
    // used to render and the same mistake was available here.
    expect(by(rows, 'sd-turbo').name).toBe('SD-Turbo')
  })

  it('carries the modality the one-verb RUN needs (image vs video open different composers)', () => {
    installTheRealShape()
    const rows = listInstalledSdRows()
    expect(by(rows, 'wan21-i2v-14b-480p').mediaKind).toBe('video')
    expect(by(rows, 'sd-turbo').mediaKind).toBe('image')
  })
})

describe('the shared-bytes rule', () => {
  it('charges every physical file EXACTLY once — Σ rows equals the real volume', () => {
    installTheRealShape()
    const rows = listInstalledSdRows()
    const summed = rows.reduce((a, r) => a + r.sizeBytes, 0)
    expect(summed).toBe(trueDiskMb() * MB)
    // and the naive sum it replaces would have invented the shared 6.1 GB twice
    expect(summed).toBeLessThan((trueDiskMb() + T5XXL.sizeMb + WAN_VAE.sizeMb) * MB)
  })

  it('charges the shared encoder to the FIRST holder and zero to the second', () => {
    installTheRealShape()
    const rows = listInstalledSdRows()
    expect(by(rows, 'wan21-t2v-1.3b').sizeBytes).toBe((1400 + 500 + 5600) * MB)
    // 16 GB of its own DiT and not one byte of the encoder it merely links to
    expect(by(rows, 'wan21-i2v-14b-480p').sizeBytes).toBe(16000 * MB)
  })

  it('names the other INSTALLED rows holding the shared components', () => {
    installTheRealShape()
    const rows = listInstalledSdRows()
    expect(by(rows, 'wan21-t2v-1.3b').sharedWith).toEqual(['Wan 2.1 I2V 14B'])
    expect(by(rows, 'wan21-i2v-14b-480p').sharedWith).toEqual(['Wan 2.1 T2V 1.3B'])
    // an unshared row must not carry an empty badge
    expect(by(rows, 'sd-turbo').sharedWith).toBeUndefined()
  })

  it('never claims a saving a hard link will not give back', () => {
    installTheRealShape()
    const rows = listInstalledSdRows()
    // The T2V row is CHARGED for the encoder but cannot FREE it: deleting one of
    // two names for an inode returns nothing. Only its own 1.4 GB DiT is freed.
    expect(by(rows, 'wan21-t2v-1.3b').freeableBytes).toBe(1400 * MB)
    expect(by(rows, 'wan21-t2v-1.3b').freeableBytes!)
      .toBeLessThan(by(rows, 'wan21-t2v-1.3b').sizeBytes)
    // Nothing shared at all → the whole row comes back.
    expect(by(rows, 'sd-turbo').freeableBytes).toBe(2500 * MB)
  })

  it('withholds a component whose extra link is OUTSIDE the installed set', () => {
    installTheRealShape()
    const flux = by(listInstalledSdRows(), 'flux-schnell-q4')
    // The autoencoder is hard-linked to a Z-Image row that never finished
    // installing: no installed row to name, and still no bytes to promise.
    expect(flux.sharedWith).toBeUndefined()
    expect(flux.sizeBytes).toBe((6800 + 160) * MB)
    expect(flux.freeableBytes).toBe(6800 * MB)
  })

  it('counts the COPY fallback twice, because it IS two copies', () => {
    // Same registry sha, different volumes → placeReusedComponent copies rather
    // than links, and both rows genuinely own their bytes.
    install({ id: 'a', name: 'Row A', kind: 'image' }, { model: { ino: 1, sizeMb: 100, nlink: 1 }, vae: { ino: 2, sizeMb: 50, nlink: 1 } })
    install({ id: 'b', name: 'Row B', kind: 'image' }, { model: { ino: 3, sizeMb: 100, nlink: 1 }, vae: { ino: 4, sizeMb: 50, nlink: 1 } })
    const rows = listInstalledSdRows()
    expect(rows.map(r => r.sizeBytes)).toEqual([150 * MB, 150 * MB])
    expect(rows.map(r => r.freeableBytes)).toEqual([150 * MB, 150 * MB])
    expect(rows.every(r => r.sharedWith === undefined)).toBe(true)
    expect(rows.reduce((a, r) => a + r.sizeBytes, 0)).toBe(trueDiskMb() * MB)
  })

  it('skips a component that vanished mid-list instead of throwing', () => {
    install({ id: 'a', name: 'Row A', kind: 'image' }, { model: { ino: 1, sizeMb: 100, nlink: 1 }, vae: { ino: 2, sizeMb: 50, nlink: 1 } })
    fixture.files.delete('/models/sd/a/vae.safetensors')
    const rows = listInstalledSdRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].sizeBytes).toBe(100 * MB)
  })

  it('answers empty — not a crash — when the sd surface is unreadable', () => {
    fixture.listThrows = true
    expect(listInstalledSdRows()).toEqual([])
  })
})

describe('the full installed list', () => {
  it('carries the sd rows alongside the other runtimes', async () => {
    installTheRealShape()
    const all = await listInstalledModels()
    expect(all.filter(m => m.runtime === 'sdcpp').map(m => m.ref))
      .toEqual(['wan21-t2v-1.3b', 'wan21-i2v-14b-480p', 'sd-turbo', 'flux-schnell-q4'])
    // …and the four that already worked are untouched
    expect(all.some(m => m.runtime === 'piper' && m.ref === 'en_US-amy-low')).toBe(true)
  })

  it('tags a piper voice with the tts modality so RUN lands on the TTS composer', async () => {
    const all = await listInstalledModels()
    expect(all.find(m => m.runtime === 'piper')!.mediaKind).toBe('tts')
  })

  it('an exploding sd surface never blanks the rest of the list', async () => {
    fixture.listThrows = true
    const all = await listInstalledModels()
    expect(all.some(m => m.runtime === 'piper')).toBe(true)
    expect(all.some(m => m.runtime === 'sdcpp')).toBe(false)
  })
})

// ─── the renderer half, pinned by source (no DOM in this suite) ──────────────

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../', rel), 'utf8')

describe('REMOVE finally reaches the caller-less IPC', () => {
  const page = read('src/pages/catalog/CatalogPage.tsx')

  it('routes an sdcpp row to sd-cpp:remove-model', () => {
    expect(page).toContain('window.tachi.sdCpp.removeModel(m.ref)')
  })

  it('goes through the in-app confirm — a native one freezes the packaged renderer', () => {
    expect(page).toContain('const confirm = useConfirm()')
    expect(page).toContain('await confirm({')
    expect(page).not.toMatch(/(?<!\/\/.*)\bwindow\.confirm\(/)
  })

  it('quotes what the delete actually frees, not the row size', () => {
    expect(page).toContain('formatModelSize(m.freeableBytes ?? m.sizeBytes)')
    expect(page).toContain("t('sdRemove.frees'")
  })

  it('says out loud which shared components stay and who keeps them', () => {
    expect(page).toContain("t('sdRemove.sharedStay'")
    expect(page).toContain("t('sdRemove.sharedWith'")
  })
})

describe('the new strings exist in all 8 locales', () => {
  const LANGS = ['en', 'ru', 'es', 'fr', 'de', 'zh', 'ja', 'ko'] as const

  it('sdRemove.frees / .sharedStay / .sharedWith are present, non-empty and keep their interpolations', () => {
    for (const lang of LANGS) {
      const j = JSON.parse(read(`src/i18n/locales/${lang}/catalog.json`))
      expect(typeof j.sdRemove?.frees, lang).toBe('string')
      expect(j.sdRemove.frees, lang).toContain('{{size}}')
      expect(j.sdRemove.sharedStay, lang).toContain('{{models}}')
      expect(j.sdRemove.sharedWith, lang).toContain('{{models}}')
    }
  })
})
