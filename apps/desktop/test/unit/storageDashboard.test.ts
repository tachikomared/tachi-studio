// apps/desktop/test/unit/storageDashboard.test.ts
//
// Storage dashboard + model-weight relocation (USER-PAINS T5+T6).
//
// Part 1 — PURE units (no electron, no fs): the migration planner, the
// dual-root resolver ORDER, and size aggregation / low-disk gate.
// Part 2 — temp-dir integration: listing across both roots, a real
// copy-verify-delete relocation, dual-root read after the move, and removal.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'

import {
  planMigration, firstExisting, sumBytes, hasEnoughFreeSpace, requiredFreeBytes, formatBytes,
} from '../../electron/services/util/model-storage'

// ─── Part 1: pure planner ─────────────────────────────────────────────────────

describe('planMigration', () => {
  it('emits every copy BEFORE every delete-src (never delete before a verified copy)', () => {
    const plan = planMigration([
      { relPath: 'b.gguf', bytes: 200 },
      { relPath: 'a.gguf', bytes: 100 },
    ])
    const firstDelete = plan.steps.findIndex(s => s.kind === 'delete-src')
    const lastCopy = plan.steps.map(s => s.kind).lastIndexOf('copy')
    expect(firstDelete).toBeGreaterThan(lastCopy) // all copies precede all deletes
  })

  it('is deterministic: steps sorted by relPath', () => {
    const plan = planMigration([
      { relPath: 'zeta', bytes: 1 },
      { relPath: 'alpha', bytes: 1 },
      { relPath: 'mid', bytes: 1 },
    ])
    const copies = plan.steps.filter(s => s.kind === 'copy').map(s => s.relPath)
    expect(copies).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('reports fileCount and totalBytes', () => {
    const plan = planMigration([
      { relPath: 'a', bytes: 100 },
      { relPath: 'b', bytes: 250 },
    ])
    expect(plan.fileCount).toBe(2)
    expect(plan.totalBytes).toBe(350)
    // one copy + one delete per file
    expect(plan.steps.filter(s => s.kind === 'copy')).toHaveLength(2)
    expect(plan.steps.filter(s => s.kind === 'delete-src')).toHaveLength(2)
  })

  it('handles an empty list', () => {
    const plan = planMigration([])
    expect(plan.steps).toEqual([])
    expect(plan.fileCount).toBe(0)
    expect(plan.totalBytes).toBe(0)
  })

  it('ignores negative byte sizes in the total', () => {
    expect(planMigration([{ relPath: 'x', bytes: -5 }, { relPath: 'y', bytes: 10 }]).totalBytes).toBe(10)
  })
})

// ─── Part 1: dual-root resolver ORDER ─────────────────────────────────────────

describe('firstExisting (NEW root first, legacy fallback)', () => {
  it('returns the NEW path when it exists', () => {
    const exists = (p: string) => p === '/root/x' || p === '/legacy/x'
    expect(firstExisting(['/root/x', '/legacy/x'], exists)).toBe('/root/x')
  })
  it('falls back to legacy when only legacy exists', () => {
    const exists = (p: string) => p === '/legacy/x'
    expect(firstExisting(['/root/x', '/legacy/x'], exists)).toBe('/legacy/x')
  })
  it('returns null when neither exists', () => {
    expect(firstExisting(['/root/x', '/legacy/x'], () => false)).toBeNull()
  })
  it('respects candidate order (first match wins)', () => {
    const order: string[] = []
    firstExisting(['a', 'b', 'c'], p => { order.push(p); return p === 'b' })
    expect(order).toEqual(['a', 'b']) // stops at first hit, never checks 'c'
  })
})

// ─── Part 1: size aggregation + low-disk gate ─────────────────────────────────

describe('sumBytes', () => {
  it('sums positive sizes and ignores negatives / non-finite', () => {
    expect(sumBytes([{ bytes: 10 }, { bytes: 20 }, { bytes: -5 }, { bytes: NaN }])).toBe(30)
  })
  it('is 0 for an empty list', () => {
    expect(sumBytes([])).toBe(0)
  })
})

describe('hasEnoughFreeSpace / requiredFreeBytes (need size * 1.1)', () => {
  it('requires a 10% headroom', () => {
    expect(requiredFreeBytes(1000)).toBe(1100)
    expect(hasEnoughFreeSpace(1000, 1100)).toBe(true)
    expect(hasEnoughFreeSpace(1000, 1099)).toBe(false)
  })
  it('always passes a zero-byte payload', () => {
    expect(hasEnoughFreeSpace(0, 0)).toBe(true)
  })
  it('fails closed on an unreadable free-space figure', () => {
    expect(hasEnoughFreeSpace(100, -1)).toBe(false)
    expect(hasEnoughFreeSpace(100, Number.NaN)).toBe(false)
  })
})

describe('formatBytes', () => {
  it('scales to human units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5 GB')
  })
})

// ─── Part 2: temp-dir integration (real copy-verify-delete) ───────────────────

const h = vi.hoisted(() => ({ tmp: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => require('path').join(h.tmp, 'userData') },
}))
vi.mock('../../electron/services/storage-root', () => ({
  getStorageRoot: () => require('path').join(h.tmp, 'storage'),
}))

// Import AFTER the mocks are declared (vitest hoists vi.mock above imports).
import {
  engineLegacyBase, engineNewBase, resolveModelPath, listEngineItemIds,
  getStorageUsage, migrateEngine, removeModelItem, invalidateUsageCache,
  invalidateModelTargetProbe, partPathFor,
} from '../../electron/services/model-storage'
import { UserSdModelStore, setUserSdModelStore, addUserSdModel } from '../../electron/services/user-sd-models'
import { SD_ADAPTER_DIR, SD_SPEED_ADAPTERS } from '../../electron/services/sd-cpp-models'

function write(p: string, bytes: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Buffer.alloc(bytes, 1))
}

describe('model-storage service (temp dir)', () => {
  beforeEach(() => {
    h.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tachi-modstore-'))
    invalidateUsageCache()
    invalidateModelTargetProbe() // the storage root moves with h.tmp each test
    // The sd engine's usage report resolves names through the user model/
    // adapter registry (allSdModels/allSdAdapters). Point its module singleton
    // at THIS test's temp dir so a fixture written here is what it reads, and
    // so no state leaks between tests (the store is otherwise a module-level
    // singleton created once and cached).
    setUserSdModelStore(new UserSdModelStore(path.join(h.tmp, 'userData', 'user-sd-models.json')))
  })
  afterEach(() => {
    setUserSdModelStore(null)
    try { fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* ignore */ }
  })

  it('lists a flat-file engine (whisper .bin) across roots and reports usage', () => {
    write(path.join(engineLegacyBase('whisper'), 'ggml-tiny.en.bin'), 2048)
    expect(listEngineItemIds('whisper')).toEqual(['ggml-tiny.en'])
    const usage = getStorageUsage(true)
    const w = usage.engines.find(e => e.engine === 'whisper')!
    expect(w.totalBytes).toBe(2048)
    expect(w.items[0]).toMatchObject({ id: 'ggml-tiny.en', location: 'legacy', bytes: 2048 })
    expect(usage.canRelocate).toBe(true)
  })

  it('resolveModelPath keeps an existing legacy file on legacy but sends a NEW download to the root', () => {
    write(path.join(engineLegacyBase('llama'), 'phi.gguf'), 16)
    expect(resolveModelPath('llama', 'phi.gguf')).toBe(path.join(engineLegacyBase('llama'), 'phi.gguf'))
    // LANE U: a not-yet-downloaded model targets <storage root>/Models/llama
    // (its .part rides along, so the landing rename still never crosses devices)
    expect(resolveModelPath('llama', 'never.gguf')).toBe(path.join(engineNewBase('llama'), 'never.gguf'))
  })

  it('a .part in the legacy tree is neither listed as a model nor swept into a relocation', async () => {
    const finished = path.join(engineLegacyBase('piper'), 'en_voice', 'en_voice.onnx')
    write(finished, 1000)
    write(partPathFor(finished), 400)                       // download in flight
    write(partPathFor(path.join(engineLegacyBase('llama'), 'half.gguf')), 700)

    expect(listEngineItemIds('llama')).toEqual([])           // ext gate already hides it
    expect(listEngineItemIds('piper')).toEqual(['en_voice']) // dir engine: the .part is not an item

    const res = await migrateEngine('piper', null)
    expect(res.ok).toBe(true)
    expect(res.movedFiles).toBe(1)                           // only the finished .onnx
    expect(fs.existsSync(path.join(engineNewBase('piper'), 'en_voice', 'en_voice.onnx'))).toBe(true)
    expect(fs.existsSync(path.join(engineNewBase('piper'), 'en_voice', 'en_voice.onnx' + '.part'))).toBe(false)
    expect(fs.existsSync(partPathFor(finished))).toBe(true)  // the in-flight bytes are left alone
  })

  it('relocates weights (copy-verify-delete) then reads them NEW-first', async () => {
    const legacy = path.join(engineLegacyBase('whisper'), 'ggml-base.en.bin')
    write(legacy, 4096)

    const res = await migrateEngine('whisper', null)
    expect(res.ok).toBe(true)
    expect(res.movedFiles).toBe(1)

    const moved = path.join(engineNewBase('whisper'), 'ggml-base.en.bin')
    expect(fs.existsSync(moved)).toBe(true)        // copied to the storage root
    expect(fs.existsSync(legacy)).toBe(false)      // original deleted only after verify
    expect(resolveModelPath('whisper', 'ggml-base.en.bin')).toBe(moved) // dual-root read hits NEW

    const usage = getStorageUsage(true)
    expect(usage.engines.find(e => e.engine === 'whisper')!.items[0].location).toBe('root')
    expect(usage.canRelocate).toBe(false)          // nothing left in legacy
  })

  it('relocates a dir-based engine (piper voice subdir with two files)', async () => {
    const base = path.join(engineLegacyBase('piper'), 'en_voice')
    write(path.join(base, 'en_voice.onnx'), 1000)
    write(path.join(base, 'en_voice.onnx.json'), 50)

    const res = await migrateEngine('piper', null)
    expect(res.ok).toBe(true)
    expect(res.movedFiles).toBe(2)
    expect(fs.existsSync(path.join(engineNewBase('piper'), 'en_voice', 'en_voice.onnx'))).toBe(true)
    expect(fs.existsSync(path.join(engineNewBase('piper'), 'en_voice', 'en_voice.onnx.json'))).toBe(true)
    expect(fs.existsSync(base)).toBe(false)
  })

  it('is a no-op skip when there is nothing in the legacy location', async () => {
    const res = await migrateEngine('llama', null)
    expect(res.ok).toBe(true)
    expect(res.skipped).toBe(true)
    expect(res.movedFiles).toBe(0)
  })

  it('removes a model from disk', async () => {
    write(path.join(engineLegacyBase('llama'), 'gemma.gguf'), 8)
    expect(listEngineItemIds('llama')).toContain('gemma')
    const r = removeModelItem('llama', 'gemma')
    expect(r.ok).toBe(true)
    expect(listEngineItemIds('llama')).not.toContain('gemma')
  })

  // ── WAVE 2 LANE D — the sd storage dashboard footgun + honesty fixes ────────
  //
  // listEngineItemIds('sd') returns raw subdirs: most are one installed
  // CHECKPOINT (named by its registry id — 'civitai-812345', not a name a
  // human wrote), and three of them ('loras'/'embeddings'/'vae') are SHARED
  // CONTAINERS the installer places every adapter of one kind into. A plain
  // Remove on a container id used to rmSync the WHOLE directory, and a
  // checkpoint's dirBytes double-counted every hard-linked shared component
  // (t5xxl, autoencoders) once per row that names it.

  function link(target: string, linkPath: string): void {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true })
    fs.linkSync(target, linkPath)
  }

  describe('sd checkpoint dedup (hard-linked shared components)', () => {
    it('charges a shared hard-linked file to the FIRST holder (alpha order) only — Σ items equals true disk usage', () => {
      const base = engineLegacyBase('sd')
      write(path.join(base, 'ckpt-a', 'model.bin'), 1000)
      write(path.join(base, 'ckpt-b', 'model.bin'), 16000)
      const shared = path.join(base, 'ckpt-a', 't5xxl.bin')
      write(shared, 5000)
      link(shared, path.join(base, 'ckpt-b', 't5xxl.bin')) // same inode, two names

      const usage = getStorageUsage(true)
      const sd = usage.engines.find(e => e.engine === 'sd')!
      const a = sd.items.find(i => i.id === 'ckpt-a')!
      const b = sd.items.find(i => i.id === 'ckpt-b')!

      expect(a.bytes).toBe(1000 + 5000) // its own file + the shared encoder (first holder)
      expect(b.bytes).toBe(16000)       // its own file only — the encoder is charged to 'ckpt-a'
      // the naive per-row sum would have invented the shared 5000 bytes twice
      expect(a.bytes + b.bytes).toBe(1000 + 16000 + 5000)
      expect(sd.totalBytes).toBe(a.bytes + b.bytes)
    })

    it('names the other installed checkpoint holding the shared component', () => {
      const base = engineLegacyBase('sd')
      write(path.join(base, 'ckpt-a', 'model.bin'), 1000)
      write(path.join(base, 'ckpt-b', 'model.bin'), 16000)
      const shared = path.join(base, 'ckpt-a', 't5xxl.bin')
      write(shared, 5000)
      link(shared, path.join(base, 'ckpt-b', 't5xxl.bin'))

      const usage = getStorageUsage(true)
      const sd = usage.engines.find(e => e.engine === 'sd')!
      expect(sd.items.find(i => i.id === 'ckpt-a')!.sharedWith).toEqual(['ckpt-b'])
      expect(sd.items.find(i => i.id === 'ckpt-b')!.sharedWith).toEqual(['ckpt-a'])
    })

    it('an unshared checkpoint carries no sharedWith badge', () => {
      write(path.join(engineLegacyBase('sd'), 'solo-ckpt', 'model.bin'), 2000)
      const usage = getStorageUsage(true)
      const item = usage.engines.find(e => e.engine === 'sd')!.items.find(i => i.id === 'solo-ckpt')!
      expect(item.bytes).toBe(2000)
      expect(item.sharedWith).toBeUndefined()
    })

    it('counts the COPY fallback (distinct inodes, identical bytes) twice — it really is two copies', () => {
      const base = engineLegacyBase('sd')
      write(path.join(base, 'ckpt-c', 'model.bin'), 100)
      write(path.join(base, 'ckpt-c', 'vae.bin'), 50)
      write(path.join(base, 'ckpt-d', 'model.bin'), 100)
      write(path.join(base, 'ckpt-d', 'vae.bin'), 50) // NOT linked — a real second copy
      const usage = getStorageUsage(true)
      const sd = usage.engines.find(e => e.engine === 'sd')!
      expect(sd.items.find(i => i.id === 'ckpt-c')!.bytes).toBe(150)
      expect(sd.items.find(i => i.id === 'ckpt-d')!.bytes).toBe(150)
      expect(sd.items.every(i => i.sharedWith === undefined)).toBe(true)
    })

    it('resolves a checkpoint id through the user registry — civitai-812345 becomes its real name, not the raw id', () => {
      addUserSdModel({
        id: 'civitai-812345',
        name: 'Juggernaut XL - v9',
        family: 'sdxl',
        baseSize: 1024,
        steps: 28,
        cfgScale: 5,
        samplingMethod: 'dpm++2m',
        files: [{ role: 'model', url: 'https://civitai.com/api/download/models/812345', sha256: 'a'.repeat(64), sizeMb: 100 }],
      })
      write(path.join(engineLegacyBase('sd'), 'civitai-812345', 'model.safetensors'), 4096)

      const usage = getStorageUsage(true)
      const item = usage.engines.find(e => e.engine === 'sd')!.items.find(i => i.id === 'civitai-812345')!
      expect(item.displayName).toBe('Juggernaut XL - v9')
    })

    it('falls back to the raw id when a checkpoint directory matches no registry row', () => {
      write(path.join(engineLegacyBase('sd'), 'orphaned-ckpt-dir', 'model.bin'), 512)
      const usage = getStorageUsage(true)
      const item = usage.engines.find(e => e.engine === 'sd')!.items.find(i => i.id === 'orphaned-ckpt-dir')!
      expect(item.displayName).toBe('orphaned-ckpt-dir')
    })
  })

  describe('sd adapter containers (loras/embeddings/vae)', () => {
    it('never lists a container dir as a plain checkpoint item — it carries adapterKind + containerFiles instead', () => {
      write(path.join(engineLegacyBase('sd'), SD_ADAPTER_DIR.lora, 'some-lora.safetensors'), 100)
      const usage = getStorageUsage(true)
      const row = usage.engines.find(e => e.engine === 'sd')!.items.find(i => i.id === SD_ADAPTER_DIR.lora)!
      expect(row.adapterKind).toBe('lora')
      expect(row.containerFiles).toBeDefined()
    })

    it('lists one entry per adapter file, and the container total sums them', () => {
      const dir = path.join(engineLegacyBase('sd'), SD_ADAPTER_DIR.lora)
      write(path.join(dir, 'aaa.safetensors'), 100)
      write(path.join(dir, 'bbb.safetensors'), 250)
      const usage = getStorageUsage(true)
      const row = usage.engines.find(e => e.engine === 'sd')!.items.find(i => i.id === SD_ADAPTER_DIR.lora)!
      expect(row.bytes).toBe(350)
      expect(row.containerFiles).toHaveLength(2)
      expect(row.containerFiles!.map(f => f.bytes).sort((x, y) => x - y)).toEqual([100, 250])
    })

    it('resolves a curated speed-pack lora slug to the pack name (deliberately absent from the user registry)', () => {
      const pack = SD_SPEED_ADAPTERS[0]
      const file = pack.files[0]
      write(path.join(engineLegacyBase('sd'), SD_ADAPTER_DIR.lora, `${file.slug}.safetensors`), 999)
      const usage = getStorageUsage(true)
      const row = usage.engines.find(e => e.engine === 'sd')!.items.find(i => i.id === SD_ADAPTER_DIR.lora)!
      expect(row.containerFiles![0].displayName).toBe(pack.name)
    })

    it('falls back to the raw stem when nothing recognizes the slug', () => {
      write(path.join(engineLegacyBase('sd'), SD_ADAPTER_DIR.lora, 'totally-unregistered-slug.safetensors'), 100)
      const usage = getStorageUsage(true)
      const row = usage.engines.find(e => e.engine === 'sd')!.items.find(i => i.id === SD_ADAPTER_DIR.lora)!
      expect(row.containerFiles![0].displayName).toBe('totally-unregistered-slug')
    })

    it('a per-file Remove (`<container>/<file>` id) deletes ONE adapter file and leaves the rest', () => {
      const dir = path.join(engineLegacyBase('sd'), SD_ADAPTER_DIR.lora)
      write(path.join(dir, 'keep-me.safetensors'), 100)
      write(path.join(dir, 'delete-me.safetensors'), 200)

      const r = removeModelItem('sd', `${SD_ADAPTER_DIR.lora}/delete-me.safetensors`)
      expect(r.ok).toBe(true)
      expect(fs.existsSync(path.join(dir, 'delete-me.safetensors'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'keep-me.safetensors'))).toBe(true)

      // the footgun this lane closes: the OLD behaviour was a single Remove on
      // the bare 'loras' id taking out every LoRA at once — the other file
      // must still be there and still listed.
      const usage = getStorageUsage(true)
      const row = usage.engines.find(e => e.engine === 'sd')!.items.find(i => i.id === SD_ADAPTER_DIR.lora)!
      expect(row.containerFiles!.map(f => f.name)).toEqual(['keep-me.safetensors'])
    })

    it('the bare container id still removes the WHOLE directory — the explicit "delete all" path the renderer gates behind a count-naming confirm', () => {
      const dir = path.join(engineLegacyBase('sd'), SD_ADAPTER_DIR.lora)
      write(path.join(dir, 'a.safetensors'), 100)
      write(path.join(dir, 'b.safetensors'), 200)

      const r = removeModelItem('sd', SD_ADAPTER_DIR.lora)
      expect(r.ok).toBe(true)
      expect(fs.existsSync(dir)).toBe(false)
    })

    it('an empty container directory produces no row at all', () => {
      fs.mkdirSync(path.join(engineLegacyBase('sd'), SD_ADAPTER_DIR.vae), { recursive: true })
      const usage = getStorageUsage(true)
      const sd = usage.engines.find(e => e.engine === 'sd')!
      expect(sd.items.some(i => i.id === SD_ADAPTER_DIR.vae)).toBe(false)
    })
  })
})

// ── the ghost row (checkpoint-A driver finding) ──────────────────────────────
//
// _doDownloadModel mkdirs the model dir BEFORE the first byte lands, so a
// cancelled first download leaves a real-but-empty directory. The dashboard
// rendered it as "<friendly name> · 0 B · REMOVE" for a model that was never
// installed. The gate is component PRESENCE, not bytes===0 — an all-shared
// row charges 0 bytes and is fully installed.
describe('empty checkpoint dirs are not rows', () => {
  beforeEach(() => {
    h.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tachi-modstore-'))
    invalidateUsageCache()
    invalidateModelTargetProbe()
    setUserSdModelStore(new UserSdModelStore(path.join(h.tmp, 'userData', 'user-sd-models.json')))
  })
  afterEach(() => {
    setUserSdModelStore(null)
    try { fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* ignore */ }
  })

  it('a dir with no files inside yields no usage item', () => {
    fs.mkdirSync(path.join(engineNewBase('sd'), 'sdxl-base-1.0'), { recursive: true }) // ghost
    write(path.join(engineNewBase('sd'), 'sd-turbo', 'model.safetensors'), 64)
    const usage = getStorageUsage(true)
    const sd = usage.engines.find(e => e.engine === 'sd')!
    const ids = sd.items.map(i => i.id)
    expect(ids).toContain('sd-turbo')
    expect(ids).not.toContain('sdxl-base-1.0')
  })
})
