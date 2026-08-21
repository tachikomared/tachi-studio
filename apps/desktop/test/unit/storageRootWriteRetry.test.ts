// apps/desktop/test/unit/storageRootWriteRetry.test.ts
//
// LANE J — the storage root must HEAL when it goes unwritable mid-session.
//
// Live defect: Defender Controlled Folder Access blocked every write to
// %USERPROFILE%\Documents\Tachi Studio, but getStorageRoot() had cached that
// root at boot and never re-probed, so the fallback chain that exists for
// exactly this case never fired — every save surfaced a raw ENOENT on a
// directory the user could plainly SEE. Only storage:reset healed it.
//
// So writeStorageFile() re-probes ONCE on a permission-shaped failure and
// retries against whatever root the chain then yields, and a still-failing
// write under Documents is reported as Controlled Folder Access instead of an
// errno nobody can act on.
//
// fs is an in-memory fake whose write path can be blocked by prefix (that IS
// what CFA does: existsSync keeps telling the truth, writes just fail).
//
// WINDOWS-SHAPED by design: the paths are `C:\…` and the CFA copy is a Windows
// claim (macOS blocks Documents through TCC and needs different words), so this
// file asserts the win32 behaviour of a Windows-first app.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'

const DOCS = 'C:\\FakeDocs'
const HOME = 'C:\\FakeHome'
const USERDATA = 'C:\\FakeUserData'

const fsState = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  /** Path prefixes whose writes fail, with the errno to throw. */
  blocked: [] as Array<{ prefix: string; code: string }>,
  /** Every writeFileSync target, in order — proves "retried ONCE". */
  writes: [] as string[],
}))

vi.mock('fs', () => {
  function existsSync(p: string): boolean {
    if (fsState.files.has(p) || fsState.dirs.has(p)) return true
    const prefix = p.endsWith('\\') ? p : p + '\\'
    for (const f of fsState.files.keys()) if (f.startsWith(prefix)) return true
    for (const d of fsState.dirs) if (d.startsWith(prefix)) return true
    return false
  }
  function blockFor(p: string): { code: string } | null {
    for (const b of fsState.blocked) if (p.toLowerCase().startsWith(b.prefix.toLowerCase())) return b
    return null
  }
  function statSync(p: string) {
    if (fsState.files.has(p)) return { isDirectory: () => false, size: fsState.files.get(p)!.length }
    if (fsState.dirs.has(p) || existsSync(p)) return { isDirectory: () => true, size: 0 }
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
    err.code = 'ENOENT'
    throw err
  }
  return {
    existsSync,
    statSync,
    readdirSync: (p: string) => {
      const prefix = p.endsWith('\\') ? p : p + '\\'
      const names = new Set<string>()
      for (const f of fsState.files.keys()) {
        if (f.startsWith(prefix)) {
          const rest = f.slice(prefix.length)
          if (!rest.includes('\\')) names.add(rest)
        }
      }
      return [...names]
    },
    // CFA also blocks directory CREATION inside a protected folder — but the
    // dirs already exist there (that's what made the live ENOENT so confusing),
    // so mkdir is allowed to "succeed" and only writes fail.
    mkdirSync: (p: string) => { fsState.dirs.add(p) },
    writeFileSync: (p: string, content: string | Uint8Array) => {
      fsState.writes.push(p)
      const b = blockFor(p)
      if (b) {
        const err = new Error(`${b.code}: write blocked ${p}`) as NodeJS.ErrnoException
        err.code = b.code
        throw err
      }
      fsState.files.set(p, typeof content === 'string' ? content : Buffer.from(content).toString('utf8'))
    },
    readFileSync: (p: string) => {
      if (!fsState.files.has(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        err.code = 'ENOENT'
        throw err
      }
      return fsState.files.get(p)!
    },
    rmSync: (p: string) => { fsState.files.delete(p); fsState.dirs.delete(p) },
    copyFileSync: (src: string, dest: string) => { fsState.files.set(dest, fsState.files.get(src) ?? '') },
  }
})

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getPath: (name: string) => ({ documents: DOCS, home: HOME, userData: USERDATA }[name] ?? USERDATA),
  },
  ipcMain: { handle: () => {}, on: () => {} },
}))

// No settings file in the fake fs → loadSettings falls through to the defaults.
vi.mock('../../electron/services/settings-store', () => ({
  loadSettings: () => ({}),
}))

import {
  getStorageRoot, invalidateStorageRootCache, writeStorageFile,
  reprobeStorageRootAfterWriteFailure, defaultStorageRoot, CFA_ERROR_TAG,
} from '../../electron/services/storage-root'

const DOCS_ROOT = join(DOCS, 'Tachi Studio')
const HOME_ROOT = join(HOME, 'Tachi Studio')
const USERDATA_ROOT = join(USERDATA, 'Tachi Studio')

/** Simulate Controlled Folder Access over the whole Documents tree. */
function blockDocuments(code = 'EPERM'): void {
  fsState.blocked.push({ prefix: DOCS, code })
}

beforeEach(() => {
  fsState.files.clear()
  fsState.dirs.clear()
  fsState.blocked.length = 0
  fsState.writes.length = 0
  invalidateStorageRootCache()
})

// ── baseline ────────────────────────────────────────────────────────────────

describe('getStorageRoot', () => {
  it('prefers Documents\\Tachi Studio when it is writable', () => {
    expect(getStorageRoot()).toBe(DOCS_ROOT)
    expect(defaultStorageRoot()).toBe(DOCS_ROOT)
  })

  it('falls back past a folder that fails the write probe', () => {
    blockDocuments()
    expect(getStorageRoot()).toBe(HOME_ROOT)
  })

  it('caches for the session (the behaviour that made the live bug permanent)', () => {
    expect(getStorageRoot()).toBe(DOCS_ROOT)
    blockDocuments() // CFA switched on AFTER boot
    expect(getStorageRoot()).toBe(DOCS_ROOT) // still the stale cached root
  })
})

// ── the fix: re-probe on write failure ──────────────────────────────────────

describe('writeStorageFile', () => {
  it('writes under the current root when nothing is blocked', () => {
    const p = writeStorageFile('flows', 'demo.tachi-flow.json', '{"a":1}')
    expect(p).toBe(join(DOCS_ROOT, 'Flows', 'demo.tachi-flow.json'))
    expect(fsState.files.get(p)).toBe('{"a":1}')
  })

  it('re-probes and retries ONCE against the new root when the cached root turns unwritable', () => {
    expect(getStorageRoot()).toBe(DOCS_ROOT) // cached at "boot"
    blockDocuments('EPERM')
    fsState.writes.length = 0

    const p = writeStorageFile('flows', 'demo.tachi-flow.json', '{"a":1}')

    expect(p).toBe(join(HOME_ROOT, 'Flows', 'demo.tachi-flow.json'))
    expect(fsState.files.get(p)).toBe('{"a":1}')
    // Exactly one blocked attempt on the old root — no retry loop.
    expect(fsState.writes.filter(w => w.startsWith(DOCS) && w.endsWith('demo.tachi-flow.json'))).toHaveLength(1)
    expect(fsState.writes.filter(w => w.endsWith('demo.tachi-flow.json'))).toHaveLength(2)
  })

  it('leaves the healed root cached so later saves go straight there', () => {
    getStorageRoot()
    blockDocuments()
    writeStorageFile('flows', 'a.tachi-flow.json', 'x')

    expect(getStorageRoot()).toBe(HOME_ROOT)
    fsState.writes.length = 0
    writeStorageFile('flows', 'b.tachi-flow.json', 'y')
    expect(fsState.writes.filter(w => w.endsWith('b.tachi-flow.json'))).toEqual([
      join(HOME_ROOT, 'Flows', 'b.tachi-flow.json'),
    ])
  })

  it('retries on EACCES and ENOENT too (CFA surfaced as ENOENT on a dir that exists)', () => {
    for (const code of ['EACCES', 'ENOENT', 'EBUSY']) {
      fsState.blocked.length = 0
      invalidateStorageRootCache()
      expect(getStorageRoot()).toBe(DOCS_ROOT)
      blockDocuments(code)
      expect(writeStorageFile('flows', `${code}.tachi-flow.json`, 'x')).toBe(
        join(HOME_ROOT, 'Flows', `${code}.tachi-flow.json`),
      )
    }
  })

  it('creates nested subfolders on the retry path too (media/refs)', () => {
    getStorageRoot()
    blockDocuments()
    const p = writeStorageFile('media', join('refs', 'pic.png'), 'bytes')
    expect(p).toBe(join(HOME_ROOT, 'Media', 'refs', 'pic.png'))
  })

  it('rethrows a non-permission error without touching the root', () => {
    getStorageRoot()
    fsState.blocked.push({ prefix: DOCS, code: 'ENOSPC' })
    expect(() => writeStorageFile('flows', 'demo.tachi-flow.json', 'x')).toThrow(/ENOSPC/)
    expect(getStorageRoot()).toBe(DOCS_ROOT)
  })

  it('names Controlled Folder Access when the Documents write fails and no fallback works', () => {
    expect(getStorageRoot()).toBe(DOCS_ROOT) // cached at "boot"
    // Then the whole drive turns hostile: the retry has nowhere to land, so the
    // user gets actionable copy instead of "ENOENT".
    fsState.blocked.push({ prefix: 'C:\\', code: 'EPERM' })
    let err: unknown
    try { writeStorageFile('flows', 'demo.tachi-flow.json', 'x') } catch (e) { err = e }

    const msg = (err as Error).message
    expect(msg.startsWith(CFA_ERROR_TAG)).toBe(true)
    expect(msg).toContain('Controlled Folder Access')
    expect(msg).toContain(DOCS_ROOT)
    // …and it carries the fallback root the renderer shows the user.
    expect(msg.slice(CFA_ERROR_TAG.length).split('|')[0]).toBe(USERDATA_ROOT)
  })

  it('heals a second time when the FALLBACK root goes unwritable too', () => {
    blockDocuments()
    expect(getStorageRoot()).toBe(HOME_ROOT) // already on the fallback root
    fsState.blocked.push({ prefix: HOME, code: 'EPERM' })

    expect(writeStorageFile('flows', 'demo.tachi-flow.json', 'x')).toBe(
      join(USERDATA_ROOT, 'Flows', 'demo.tachi-flow.json'),
    )
  })

  it('does NOT claim Controlled Folder Access when no attempt touched Documents', () => {
    blockDocuments()
    expect(getStorageRoot()).toBe(HOME_ROOT)
    fsState.blocked.push({ prefix: HOME, code: 'EPERM' })
    fsState.blocked.push({ prefix: USERDATA, code: 'EPERM' })

    let err: unknown
    try { writeStorageFile('flows', 'demo.tachi-flow.json', 'x') } catch (e) { err = e }
    expect((err as Error).message).not.toContain(CFA_ERROR_TAG)
    expect((err as Error).message).toContain('EPERM')
  })
})

// ── concurrency ─────────────────────────────────────────────────────────────

describe('reprobeStorageRootAfterWriteFailure', () => {
  it('re-uses a root another failing write already healed to (no second probe)', () => {
    getStorageRoot()
    blockDocuments()
    const healed = reprobeStorageRootAfterWriteFailure(DOCS_ROOT)
    expect(healed).toBe(HOME_ROOT)

    // A concurrent save that failed against the SAME stale root must not walk
    // the chain again — it just picks up the already-healed root.
    fsState.writes.length = 0
    expect(reprobeStorageRootAfterWriteFailure(DOCS_ROOT)).toBe(HOME_ROOT)
    expect(fsState.writes).toEqual([]) // no probe file written
  })

  it('keeps the root when it is still writable (an unrelated failure must not move data)', () => {
    expect(getStorageRoot()).toBe(DOCS_ROOT)
    expect(reprobeStorageRootAfterWriteFailure(DOCS_ROOT)).toBe(DOCS_ROOT)
  })
})
