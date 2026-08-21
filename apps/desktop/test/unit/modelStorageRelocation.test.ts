// apps/desktop/test/unit/modelStorageRelocation.test.ts
//
// The "какого хуя оно на диске Ц" lane — 9.7 GB of weights on the system drive.
//
// Three things this file pins, all of which were wrong or missing before:
//
//   1. HONESTY — the default storage root (Documents\Tachi Studio) is on the
//      SAME DRIVE as %APPDATA%, so "Move all to storage root" would shuffle
//      gigabytes around one volume and free nothing. `moveChangesDrive` reports
//      that truth so the dashboard can say it BEFORE the user starts.
//
//   2. SAME-VOLUME MOVES ARE RENAMES — they used to be a full copy-verify-delete
//      even within one drive, which meant a 7.7 GB relocation demanded 8.5 GB
//      free on a drive the user was trying to empty. A rename needs none, and
//      is checked here structurally: the file keeps its inode.
//
//   3. A FAILED MOVE LOSES NOTHING — with renames in play, the naive rollback
//      ("delete what we wrote") would DESTROY the only copy of every file
//      already moved. Renames must be renamed BACK. This is the test that would
//      have caught that.
//
// Plus the orphan rescue: weights left under a PREVIOUSLY-USED storage root are
// still found (they used to silently read as "not installed" while still
// filling the disk) and are ordinary migration sources.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'

const h = vi.hoisted(() => ({ tmp: '', root: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => require('path').join(h.tmp, 'userData') },
}))
// The storage root is a MUTABLE fixture here: several tests need to move it and
// watch what happens to weights left behind under the old one.
vi.mock('../../electron/services/storage-root', () => ({
  getStorageRoot: () => h.root,
}))
// settings-store resolves its file path ONCE at module load, which would freeze
// it to the temp dir of whichever test imported first. Re-derive it per call so
// each test reads and writes its own settings.
vi.mock('../../electron/services/settings-store', () => {
  const nodeFs = require('fs') as typeof import('fs')
  const nodePath = require('path') as typeof import('path')
  const file = (): string => nodePath.join(h.tmp, 'userData', 'tachi-settings.json')
  return {
    loadSettings: () => {
      try { return JSON.parse(nodeFs.readFileSync(file(), 'utf8')) } catch { return {} }
    },
    saveSettings: (partial: Record<string, unknown>) => {
      let cur: Record<string, unknown> = {}
      try { cur = JSON.parse(nodeFs.readFileSync(file(), 'utf8')) } catch { /* fresh */ }
      nodeFs.mkdirSync(nodePath.dirname(file()), { recursive: true })
      nodeFs.writeFileSync(file(), JSON.stringify({ ...cur, ...partial }), 'utf8')
    },
  }
})

import {
  engineLegacyBase, engineNewBase, resolveModelPath, listEngineItemIds,
  getStorageUsage, migrateEngine, invalidateUsageCache, invalidateModelTargetProbe,
  sameVolume, moveChangesDrive, recordPreviousModelRoot, previousModelRoots,
} from '../../electron/services/model-storage'

function write(p: string, bytes: number): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, Buffer.alloc(bytes, 1))
}

/** Persist settings the way settings-store reads them (same temp userData). */
function writeSettings(partial: Record<string, unknown>): void {
  const file = path.join(h.tmp, 'userData', 'tachi-settings.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(partial), 'utf8')
}

beforeEach(() => {
  h.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tachi-reloc-'))
  h.root = path.join(h.tmp, 'storage')
  fs.mkdirSync(h.root, { recursive: true })
  fs.mkdirSync(path.join(h.tmp, 'userData'), { recursive: true })
  invalidateUsageCache()
  invalidateModelTargetProbe()
})
afterEach(() => {
  try { fs.rmSync(h.tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* ignore */ }
})

// ─── 1. Same-volume honesty ──────────────────────────────────────────────────

describe('sameVolume / moveChangesDrive', () => {
  it('reports two dirs on one volume as the same volume', () => {
    const a = path.join(h.tmp, 'a')
    const b = path.join(h.tmp, 'b')
    fs.mkdirSync(a); fs.mkdirSync(b)
    expect(sameVolume(a, b)).toBe(true)
  })

  it('is false (never throws) when a dir does not exist', () => {
    expect(sameVolume(path.join(h.tmp, 'nope'), h.root)).toBe(false)
  })

  it('moveChangesDrive is FALSE when the storage root shares a volume with userData — the stock Documents case, where a move frees nothing', () => {
    expect(moveChangesDrive()).toBe(false)
    write(path.join(engineLegacyBase('whisper'), 'ggml-tiny.en.bin'), 2048)
    const usage = getStorageUsage(true)
    expect(usage.canRelocate).toBe(true)     // there IS something to move…
    expect(usage.moveChangesDrive).toBe(false) // …but it would not free the drive
  })

  it('reports free/total for the LEGACY drive too — the drive the user is trying to rescue', () => {
    const usage = getStorageUsage(true)
    expect(usage.legacyTotalBytes === null || usage.legacyTotalBytes > 0).toBe(true)
  })
})

// ─── 2. Same-volume relocation is a rename ───────────────────────────────────

describe('migrateEngine — same volume', () => {
  it('MOVES the file (source gone, destination present, bytes intact)', async () => {
    const src = path.join(engineLegacyBase('whisper'), 'ggml-tiny.en.bin')
    write(src, 4096)
    const res = await migrateEngine('whisper', null)
    expect(res.ok).toBe(true)
    const dst = path.join(engineNewBase('whisper'), 'ggml-tiny.en.bin')
    expect(fs.existsSync(src)).toBe(false)
    expect(fs.existsSync(dst)).toBe(true)
    expect(fs.statSync(dst).size).toBe(4096)
    expect(resolveModelPath('whisper', 'ggml-tiny.en.bin')).toBe(dst)
  })

  it('RENAMES rather than copies — the file keeps its inode, so the move needs no free space', async () => {
    const src = path.join(engineLegacyBase('whisper'), 'ggml-base.bin')
    write(src, 2048)
    const inoBefore = fs.statSync(src).ino
    const res = await migrateEngine('whisper', null)
    expect(res.ok).toBe(true)
    const dst = path.join(engineNewBase('whisper'), 'ggml-base.bin')
    const inoAfter = fs.statSync(dst).ino
    // A copy would mint a NEW inode; a rename preserves it. Guarded because some
    // filesystems report 0 and cannot answer the question at all.
    if (inoBefore !== 0 && inoAfter !== 0) expect(inoAfter).toBe(inoBefore)
  })

  it('keeps a multi-file item together (piper voice: both files land)', async () => {
    const base = path.join(engineLegacyBase('piper'), 'en_US-amy')
    write(path.join(base, 'en_US-amy.onnx'), 1024)
    write(path.join(base, 'en_US-amy.onnx.json'), 128)
    const res = await migrateEngine('piper', null)
    expect(res.ok).toBe(true)
    const dst = path.join(engineNewBase('piper'), 'en_US-amy')
    expect(fs.existsSync(path.join(dst, 'en_US-amy.onnx'))).toBe(true)
    expect(fs.existsSync(path.join(dst, 'en_US-amy.onnx.json'))).toBe(true)
    expect(fs.existsSync(base)).toBe(false)
  })
})

// ─── 3. A failed move must lose nothing ──────────────────────────────────────

describe('migrateEngine — failure rollback', () => {
  it('renames already-moved files BACK when a later file fails — no source is ever destroyed', async () => {
    const legacy = engineLegacyBase('whisper')
    write(path.join(legacy, 'a.bin'), 512)
    write(path.join(legacy, 'b.bin'), 512)
    write(path.join(legacy, 'c.bin'), 512)
    // Files are processed in sorted relPath order, so 'a' moves first and then
    // 'b' hits a destination that is a DIRECTORY — every way of placing a file
    // there fails. Without the rename-back rollback, 'a' would be deleted here:
    // it is no longer at the source (it was renamed) and the old rollback path
    // simply rmSync'd everything this run had produced.
    fs.mkdirSync(path.join(engineNewBase('whisper'), 'b.bin'), { recursive: true })

    const res = await migrateEngine('whisper', null)
    expect(res.ok).toBe(false)

    for (const n of ['a.bin', 'b.bin', 'c.bin']) {
      expect(fs.existsSync(path.join(legacy, n))).toBe(true)
      expect(fs.statSync(path.join(legacy, n)).size).toBe(512)
    }
    // …and nothing of ours was left at the destination.
    expect(fs.existsSync(path.join(engineNewBase('whisper'), 'a.bin'))).toBe(false)
    expect(fs.existsSync(path.join(engineNewBase('whisper'), 'a.bin.migrating'))).toBe(false)
  })

  it('is resumable: a second run finishes what a first run already placed', async () => {
    const legacy = engineLegacyBase('whisper')
    write(path.join(legacy, 'x.bin'), 256)
    // Pretend a previous run already landed this file at the destination.
    write(path.join(engineNewBase('whisper'), 'x.bin'), 256)
    const res = await migrateEngine('whisper', null)
    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(legacy, 'x.bin'))).toBe(false) // source cleaned up
    expect(fs.existsSync(path.join(engineNewBase('whisper'), 'x.bin'))).toBe(true)
  })
})

// ─── 4. Orphan rescue: previously-used storage roots ─────────────────────────

describe('previously-used storage roots', () => {
  it('still FINDS weights left under an old root after the root changes — they used to read as "not installed" while still filling the disk', () => {
    const oldRoot = path.join(h.tmp, 'old-storage')
    const orphan = path.join(oldRoot, 'Models', 'llama', 'qwen3.gguf')
    write(orphan, 8192)
    writeSettings({ modelRootHistory: [oldRoot] })
    invalidateUsageCache()

    expect(previousModelRoots()).toEqual([oldRoot])
    expect(listEngineItemIds('llama')).toContain('qwen3')
    expect(resolveModelPath('llama', 'qwen3.gguf')).toBe(orphan)
  })

  it('reports an orphaned weight as movable, and MOVES it to the current root', async () => {
    const oldRoot = path.join(h.tmp, 'old-storage')
    write(path.join(oldRoot, 'Models', 'llama', 'qwen3.gguf'), 8192)
    writeSettings({ modelRootHistory: [oldRoot] })
    invalidateUsageCache()

    const usage = getStorageUsage(true)
    const llama = usage.engines.find(e => e.engine === 'llama')!
    expect(llama.items[0]).toMatchObject({ id: 'qwen3', location: 'legacy', bytes: 8192 })
    expect(usage.canRelocate).toBe(true)

    const res = await migrateEngine('llama', null)
    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(engineNewBase('llama'), 'qwen3.gguf'))).toBe(true)
    expect(fs.existsSync(path.join(oldRoot, 'Models', 'llama', 'qwen3.gguf'))).toBe(false)
  })

  it('recordPreviousModelRoot remembers a root that holds Models, and ignores the current one', () => {
    const oldRoot = path.join(h.tmp, 'old-storage')
    fs.mkdirSync(path.join(oldRoot, 'Models'), { recursive: true })
    writeSettings({})
    recordPreviousModelRoot(oldRoot)
    expect(previousModelRoots()).toEqual([oldRoot])
    // The CURRENT root is never recorded as a previous one.
    recordPreviousModelRoot(h.root)
    expect(previousModelRoots()).toEqual([oldRoot])
  })

  it('does not record a root that never held any weights', () => {
    writeSettings({})
    recordPreviousModelRoot(path.join(h.tmp, 'never-used'))
    expect(previousModelRoots()).toEqual([])
  })

  it('a corrupt history setting degrades to the plain two-root behaviour', () => {
    writeSettings({ modelRootHistory: 'not-an-array' })
    expect(previousModelRoots()).toEqual([])
    write(path.join(engineLegacyBase('whisper'), 'ggml-tiny.en.bin'), 64)
    expect(listEngineItemIds('whisper')).toEqual(['ggml-tiny.en'])
  })
})
