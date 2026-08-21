// apps/desktop/test/unit/downloadStorageRootMove.test.ts
//
// A DOWNLOAD PAUSED BEFORE A STORAGE MOVE RESUMED INTO THE ROOT THE USER LEFT.
//
// Weights are located by CONVENTION — `<storageRoot>/Models/<engine>/…` — and
// nothing anywhere records a weight's absolute path (model-storage.ts). But
// `downloads.json` DOES persist `destPath` absolute, so:
//
//   pause a 2 GB download  →  Settings → move the model folder to another drive
//   →  click RESUME  →  the file finishes into the OLD root, where no resolver
//   looks. The model reads "not installed" while occupying the abandoned disk.
//
// The fix re-resolves the spec against the CURRENT root at resume time (not at
// rehydrate time — the root can move while a task sits paused mid-session) and
// carries the `.part` across. The two things this file pins are the ones that
// could quietly go wrong:
//
//   1. The partial is not TRUSTED to have arrived. `renameSync` returning
//      without throwing is not evidence; the moved file is re-stat'd and must
//      be a real file of exactly the same size — the `destSatisfies()` rule
//      model-storage learned the hard way, where `existsSync` let a directory
//      or a truncated stub pass for the real thing and the only good copy was
//      then deleted.
//   2. A cross-volume move (EXDEV) — the exact case the storage-move feature
//      exists FOR — REFUSES to resume and says so, naming both paths. It does
//      not silently re-download multi-GB, and it does not touch the partial.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'


// Paths are built in the SHAPE OF THE HOST PLATFORM: the code under test walks
// them with node:path, and a `C:\…` literal is a RELATIVE path to a POSIX runner,
// which silently inverts every assertion that depends on being absolute.
const USERDATA = vi.hoisted(() => (process.platform === 'win32' ? 'C:\\FakeUserData' : '/FakeUserData'))
const OLD_ROOT = vi.hoisted(() => (process.platform === 'win32' ? 'D:\\Tachi Studio' : '/mnt/one/Tachi Studio'))
const NEW_ROOT = vi.hoisted(() => (process.platform === 'win32' ? 'E:\\Tachi Studio' : '/mnt/two/Tachi Studio'))

const modelFile = (root: string, ext = '') =>
  join(root, 'Models', 'sd', 'sd-turbo', `model.safetensors${ext}`)
const OLD_DEST = modelFile(OLD_ROOT)
const OLD_PART = modelFile(OLD_ROOT, '.part')
const NEW_DEST = modelFile(NEW_ROOT)
const NEW_PART = modelFile(NEW_ROOT, '.part')

const ID = 'sd:sd-turbo:model'
const PARTIAL_BYTES = 1_599_861_658

// ─── fake fs ──────────────────────────────────────────────────────────────────

const fsState = vi.hoisted(() => ({
  files: new Map<string, number>(),
  dirs: new Set<string>(),
  /** Force renameSync to fail like a cross-device move. */
  renameError: null as null | NodeJS.ErrnoException,
  /** Size renameSync writes at the destination (defaults to the source size). */
  renameLands: null as null | number,
  renames: [] as Array<{ src: string; dst: string }>,
  removed: [] as string[],
  writtenBodies: [] as Array<{ path: string; body: string }>,
}))

vi.mock('fs', () => ({
  existsSync: (p: string) => fsState.files.has(String(p)) || fsState.dirs.has(String(p)),
  statSync: (p: string) => {
    const path = String(p)
    if (fsState.dirs.has(path)) return { size: 0, isFile: () => false }
    if (!fsState.files.has(path)) {
      const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { size: fsState.files.get(path)!, isFile: () => true }
  },
  mkdirSync: () => undefined,
  readFileSync: () => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e },
  writeFileSync: (p: string, body: string) => { fsState.writtenBodies.push({ path: String(p), body: String(body) }) },
  renameSync: (src: string, dst: string) => {
    fsState.renames.push({ src: String(src), dst: String(dst) })
    if (fsState.renameError) throw fsState.renameError
    fsState.files.set(String(dst), fsState.renameLands ?? fsState.files.get(String(src)) ?? 0)
    fsState.files.delete(String(src))
  },
  rmSync: (p: string) => { fsState.removed.push(String(p)); fsState.files.delete(String(p)) },
}))

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}))

vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: () => null,
  hasKey: () => false,
}))

// The two modules that decide where "here" is. Driving them directly is the
// point of the test — the fake fs has no settings file to read.
const rootState = vi.hoisted(() => ({
  current: process.platform === 'win32' ? 'D:\\Tachi Studio' : '/mnt/one/Tachi Studio',
  history: [] as string[],
}))

vi.mock('../../electron/services/storage-root', () => ({
  getStorageRoot: () => rootState.current,
}))
vi.mock('../../electron/services/settings-store', () => ({
  loadSettings: () => ({ modelRootHistory: rootState.history }),
  saveSettings: () => undefined,
}))

// ─── controllable installer-kit ───────────────────────────────────────────────

const kit = vi.hoisted(() => ({
  starts: 0,
  /** Every `.part` path resumableDownload was pointed at, in order. */
  destsSeen: [] as string[],
  pending: null as null | { resolve: () => void; reject: (e: unknown) => void },
}))

vi.mock('../../electron/services/util/installer-kit', () => ({
  resumableDownload: (
    _url: string,
    dest: string,
    _onChunk?: unknown,
    _retries?: number,
    signal?: AbortSignal,
  ) => new Promise<void>((resolve, reject) => {
    kit.starts += 1
    kit.destsSeen.push(String(dest))
    kit.pending = { resolve, reject }
    signal?.addEventListener('abort', () => reject(new Error('Download cancelled')), { once: true })
  }),
  sha256File: async () => 'a'.repeat(64),
  freeDiskBytes: async () => 4_000_000_000_000,
  requiredDiskBytes: (total: number, start: number) => Math.max(0, total - start) + 500 * 1024 * 1024,
  diskShortfallMessage: () => 'Not enough disk space',
}))

import {
  runManagedDownload,
  pauseManagedDownload,
  resumeManagedDownload,
  listDownloads,
} from '../../electron/services/download-manager'

const flush = () => new Promise(r => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 6; i++) await flush() }
const row = () => listDownloads().find(d => d.id === ID)

function spec() {
  return {
    id: ID,
    name: 'SD-Turbo — model',
    kind: 'sd-model' as const,
    url: 'https://huggingface.co/stabilityai/sd-turbo/resolve/main/sd_turbo.safetensors',
    destPath: OLD_DEST,
    partPath: OLD_PART,
    approxTotalBytes: 5_214_561_328,
  }
}

/** Start a download against the OLD root and pause it with bytes on disk. */
async function pausedUnderOldRoot(): Promise<void> {
  runManagedDownload(spec()).catch(() => { /* coded PAUSED rejection */ })
  await settle()
  fsState.files.set(OLD_PART, PARTIAL_BYTES)
  pauseManagedDownload(ID)
  await settle()
  expect(row()?.state).toBe('paused')
  kit.starts = 0
  kit.destsSeen = []
}

/** The user moved the model folder: current root is NEW, old root is history. */
function userMovedTheModelFolder(): void {
  rootState.current = NEW_ROOT
  rootState.history = [OLD_ROOT]
}

beforeEach(async () => {
  fsState.files.clear()
  fsState.dirs.clear()
  fsState.renameError = null
  fsState.renameLands = null
  fsState.renames = []
  fsState.removed = []
  fsState.writtenBodies = []
  kit.starts = 0
  kit.destsSeen = []
  kit.pending = null
  rootState.current = OLD_ROOT
  rootState.history = []
  // Drop any task left by a previous case.
  const { cancelManagedDownload } = await import('../../electron/services/download-manager')
  cancelManagedDownload(ID)
  await settle()
  cancelManagedDownload(ID)
})

describe('resume after the storage root moved', () => {
  it('re-resolves dest + part against the CURRENT root instead of the old one', async () => {
    await pausedUnderOldRoot()
    userMovedTheModelFolder()

    expect(resumeManagedDownload(ID)).toBe(true)
    await settle()

    // The transfer continues into the NEW root — this is the whole bug.
    expect(kit.destsSeen).toEqual([NEW_PART])
    expect(kit.destsSeen[0]).not.toBe(OLD_PART)
  })

  it('carries the partial across, and the old copy no longer holds the bytes', async () => {
    await pausedUnderOldRoot()
    userMovedTheModelFolder()

    resumeManagedDownload(ID)
    await settle()

    expect(fsState.renames).toContainEqual({ src: OLD_PART, dst: NEW_PART })
    expect(fsState.files.get(NEW_PART)).toBe(PARTIAL_BYTES)
    expect(fsState.files.has(OLD_PART)).toBe(false)
    // The resume offset follows the file, so nothing re-downloads.
    expect(row()?.receivedBytes).toBe(PARTIAL_BYTES)
  })

  it('persists the corrected paths, so a later restart does not regress', async () => {
    await pausedUnderOldRoot()
    userMovedTheModelFolder()

    resumeManagedDownload(ID)
    await settle()

    const last = fsState.writtenBodies.filter(w => w.path.endsWith('downloads.json')).pop()
    expect(last, 'downloads.json should have been rewritten').toBeTruthy()
    expect(last!.body).toContain('E:')
    expect(JSON.parse(last!.body).tasks[0].destPath).toBe(NEW_DEST)
  })

  it('a cross-volume partial REFUSES to resume and keeps the bytes where they are', async () => {
    await pausedUnderOldRoot()
    userMovedTheModelFolder()
    const exdev = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException
    exdev.code = 'EXDEV'
    fsState.renameError = exdev

    expect(resumeManagedDownload(ID)).toBe(false)
    await settle()

    // No transfer started — a silent multi-GB re-download is the failure this
    // refusal exists to prevent.
    expect(kit.starts).toBe(0)
    // And the partial is exactly where the user left it.
    expect(fsState.files.get(OLD_PART)).toBe(PARTIAL_BYTES)
    expect(fsState.removed).not.toContain(OLD_PART)

    const r = row()
    expect(r?.state).toBe('error')
    expect(r?.errorCode).toBe('STORAGE_MOVED')
    // The message has to be actionable: both ends of the move, by name.
    expect(r?.error).toContain(OLD_PART)
    expect(r?.error).toContain(NEW_PART)
    expect(r?.error).toContain(NEW_ROOT)
  })

  it('a rename that "succeeds" but lands the wrong size is refused, not appended to', async () => {
    await pausedUnderOldRoot()
    userMovedTheModelFolder()
    fsState.renameLands = 8_239_898 // a truncated stub, the classic

    expect(resumeManagedDownload(ID)).toBe(false)
    await settle()

    expect(kit.starts).toBe(0)
    expect(row()?.errorCode).toBe('STORAGE_MOVED')
  })

  it('a directory squatting at the new part path is not mistaken for the partial', async () => {
    await pausedUnderOldRoot()
    userMovedTheModelFolder()
    // renameSync "succeeds" but a DIRECTORY is what statSync finds there.
    fsState.renameError = null
    fsState.renameLands = PARTIAL_BYTES
    fsState.dirs.add(NEW_PART)
    fsState.files.delete(NEW_PART)
    // The fake fs answers dirs before files, so this is the existsSync trap.

    expect(resumeManagedDownload(ID)).toBe(false)
    await settle()
    expect(kit.starts).toBe(0)
    expect(row()?.errorCode).toBe('STORAGE_MOVED')
  })
})

describe('resume when nothing moved', () => {
  it('leaves the spec alone and resumes at the original path', async () => {
    await pausedUnderOldRoot()
    // No history, root unchanged.

    expect(resumeManagedDownload(ID)).toBe(true)
    await settle()

    expect(kit.destsSeen).toEqual([OLD_PART])
    expect(fsState.renames).toEqual([])
  })

  it('a root in history that this download does not live under is ignored', async () => {
    await pausedUnderOldRoot()
    rootState.current = NEW_ROOT
    rootState.history = ['Z:\\Somewhere Else']

    expect(resumeManagedDownload(ID)).toBe(true)
    await settle()

    expect(kit.destsSeen).toEqual([OLD_PART])
  })
})
