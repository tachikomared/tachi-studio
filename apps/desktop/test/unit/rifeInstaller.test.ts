// apps/desktop/test/unit/rifeInstaller.test.ts
//
// THE INSTALLER, WITH THE 431 MB FAKED AND THE DISK REAL.
//
// This sidecar is by far the largest single download the app performs, which
// changes what "correct" means for its installer:
//
//   • A FAILED ATTEMPT MUST NOT COST THE BYTES AGAIN. The partial is kept on a
//     network failure (resume), and a COMPLETE verified zip left behind by an
//     attempt that died in the extract is reused rather than re-fetched.
//   • PROVEN-BAD BYTES ARE DELETED. A sha mismatch is the one case where the
//     partial must go: resuming onto it would append good bytes to bad ones.
//   • "INSTALLED" MEANS BINARY *AND* MODEL. A half-extracted tree that has the
//     exe but not rife-v4.6/flownet.bin fails minutes into the user's first
//     run, so it must read as not-installed and re-install.
//   • THE RAIL NEVER STICKS. Every exit path pushes a terminal done/error —
//     the exact property that keeps yt-dlp OFF the activity rail today.
//
// The download/extract primitives are mocked at the installer-kit boundary
// (they have their own suites); everything the installer itself decides runs
// for real against a real temp userData.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const HOST = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return { userData: mk(j(td(), 'tachi-rife-inst-')) }
})

vi.mock('electron', () => ({
  app: { getPath: () => HOST.userData, isPackaged: false },
  BrowserWindow: class {},
}))

const kit = vi.hoisted(() => ({
  downloads: [] as Array<{ url: string; dest: string }>,
  /** What resumableDownload does: throw, or "land" bytes. */
  downloadFails: null as string | null,
  /** What sha256File answers for the downloaded tmp. */
  sha: '',
  extracts: [] as Array<{ archive: string; dest: string }>,
  /** What extractArchive materialises under dest. */
  extractLayout: null as null | ((dest: string) => void),
  /** canReuseLandedArchive's verdict. */
  reuse: false,
}))

vi.mock('../../electron/services/util/installer-kit', () => ({
  resumableDownload: async (url: string, dest: string) => {
    kit.downloads.push({ url, dest })
    if (kit.downloadFails) throw new Error(kit.downloadFails)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(dest, 'ZIPBYTES')
  },
  sha256File: async () => kit.sha,
  extractArchive: async (archive: string, dest: string) => {
    kit.extracts.push({ archive, dest })
    kit.extractLayout?.(dest)
  },
  prepareResumablePartial: (p: string) => ({ path: p, recovery: 'ready' as const }),
}))

// The reuse gate lives in sd-cpp-installer (shared, already suite-covered);
// mocking it here keeps that module's heavy graph out of this test.
vi.mock('../../electron/services/sd-cpp-installer', () => ({
  canReuseLandedArchive: async () => kit.reuse,
}))

const sanity = vi.hoisted(() => ({ stderr: 'Usage: rife-ncnn-vulkan -0 infile\n', code: 255, spawnThrows: false }))

vi.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events')
  return {
    spawn: () => {
      if (sanity.spawnThrows) throw new Error('spawn ENOENT')
      const p = new EE() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill(): void }
      p.stdout = new EE()
      p.stderr = new EE()
      p.kill = () => { /* */ }
      setTimeout(() => {
        if (sanity.stderr) p.stderr.emit('data', Buffer.from(sanity.stderr))
        p.emit('close', sanity.code)
      }, 0)
      return p
    },
  }
})

import type { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  installRife, uninstallRife, rifeStatus, isRifeInstalled, rifeBinDir, rifeModelDir,
} from '../../electron/services/rife-installer'
import { RIFE_RELEASES, RIFE_VERSION, defaultRifeRelease, rifeExeName } from '../../electron/services/rife-plan'

const ASSET = defaultRifeRelease(process.platform)!
const EXE = rifeExeName(process.platform)

/** A faithful extraction: one top-level dir holding the exe + the model dir. */
function goodLayout(dest: string): void {
  const root = join(dest, ASSET.archiveRoot)
  mkdirSync(join(root, 'rife-v4.6'), { recursive: true })
  writeFileSync(join(root, EXE), 'BIN')
  writeFileSync(join(root, 'rife-v4.6', 'flownet.param'), 'P')
  writeFileSync(join(root, 'rife-v4.6', 'flownet.bin'), 'B')
  // A model dir we do NOT run — the archive ships eleven of them.
  mkdirSync(join(root, 'rife-anime'), { recursive: true })
  writeFileSync(join(root, 'rife-anime', 'flownet.bin'), 'B')
}

interface Ev { stage: string; message: string; percent: number }

function fakeWin(sent: Ev[]): never {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (_c: string, e: Ev) => { sent.push(e) } },
  } as never
}

beforeEach(() => {
  rmSync(join(HOST.userData, 'rife'), { recursive: true, force: true })
  rmSync(join(HOST.userData, 'install-locks'), { recursive: true, force: true })
  kit.downloads.length = 0
  kit.extracts.length = 0
  kit.downloadFails = null
  kit.sha = ASSET.sha256
  kit.extractLayout = goodLayout
  kit.reuse = false
  sanity.stderr = 'Usage: rife-ncnn-vulkan -0 infile\n'
  sanity.code = 255
  sanity.spawnThrows = false
})

// ── status ────────────────────────────────────────────────────────────────────

describe('rifeStatus', () => {
  it('reports the download size BEFORE the click — 431 MB is not an ambush', () => {
    const s = rifeStatus()
    expect(s.installed).toBe(false)
    expect(s.version).toBe(RIFE_VERSION)
    expect(s.model).toBe('rife-v4.6')
    expect(s.downloadBytes).toBe(ASSET.sizeBytes)
    expect(s.downloadBytes).toBeGreaterThan(400_000_000)
    expect(s.supported).toBe(true)
  })

  it('hides the paths until they really exist', () => {
    expect(rifeStatus().binPath).toBeNull()
    expect(rifeStatus().modelDir).toBeNull()
  })
})

// ── the happy install ─────────────────────────────────────────────────────────

describe('installRife', () => {
  it('downloads the PINNED url and lands the engine + the model', async () => {
    const sent: Ev[] = []
    await installRife(fakeWin(sent))
    expect(kit.downloads.length).toBe(1)
    expect(kit.downloads[0]!.url).toBe(ASSET.url)
    expect(kit.downloads[0]!.url).toContain(`/releases/download/${RIFE_VERSION}/`)
    expect(isRifeInstalled()).toBe(true)
    expect(existsSync(join(rifeBinDir(), EXE))).toBe(true)
    expect(existsSync(join(rifeModelDir(), 'flownet.bin'))).toBe(true)
  })

  it('lifts the archive root\'s CONTENTS into bin/, not the root itself', async () => {
    await installRife(null)
    expect(existsSync(join(rifeBinDir(), ASSET.archiveRoot))).toBe(false)
    expect(existsSync(join(rifeBinDir(), 'rife-anime'))).toBe(true)
  })

  it('ends with a terminal done — the rail must never stick', async () => {
    const sent: Ev[] = []
    await installRife(fakeWin(sent))
    expect(sent[sent.length - 1]!.stage).toBe('done')
    expect(sent[sent.length - 1]!.percent).toBe(100)
  })

  it('deletes the 431 MB archive once everything has landed', async () => {
    await installRife(null)
    expect(existsSync(join(HOST.userData, 'rife', 'downloads', ASSET.filename))).toBe(false)
  })

  it('is a no-op fast path when it is already installed', async () => {
    await installRife(null)
    kit.downloads.length = 0
    const sent: Ev[] = []
    await installRife(fakeWin(sent))
    expect(kit.downloads).toEqual([])
    expect(sent.map(e => e.stage)).toEqual(['done'])
  })

  it('skips the download entirely when a verified archive is already on disk', async () => {
    kit.reuse = true
    mkdirSync(join(HOST.userData, 'rife', 'downloads'), { recursive: true })
    writeFileSync(join(HOST.userData, 'rife', 'downloads', ASSET.filename), 'ZIPBYTES')
    await installRife(null)
    expect(kit.downloads).toEqual([])          // 431 MB not re-fetched
    expect(isRifeInstalled()).toBe(true)
  })
})

// ── integrity ─────────────────────────────────────────────────────────────────

describe('integrity', () => {
  it('refuses a sha mismatch, DELETES the bad bytes and does not install', async () => {
    kit.sha = 'f'.repeat(64)
    const sent: Ev[] = []
    await expect(installRife(fakeWin(sent))).rejects.toThrow(/SHA256 mismatch/)
    expect(existsSync(join(HOST.userData, 'rife', 'downloads', `${ASSET.filename}.tmp`))).toBe(false)
    expect(isRifeInstalled()).toBe(false)
    expect(sent[sent.length - 1]!.stage).toBe('error')
  })

  it('KEEPS the partial on a network failure so the retry resumes', async () => {
    kit.downloadFails = 'socket hang up'
    const sent: Ev[] = []
    await expect(installRife(fakeWin(sent))).rejects.toThrow(/partial kept/)
    expect(sent[sent.length - 1]!.stage).toBe('error')
  })

  it('every pinned digest is real hex — a placeholder must never ship', () => {
    for (const r of RIFE_RELEASES) expect(r.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── partial trees ─────────────────────────────────────────────────────────────

describe('a half-extracted tree is NOT installed', () => {
  it('rejects an archive with the binary but no model', async () => {
    kit.extractLayout = dest => {
      const root = join(dest, ASSET.archiveRoot)
      mkdirSync(root, { recursive: true })
      writeFileSync(join(root, EXE), 'BIN')
    }
    const sent: Ev[] = []
    await expect(installRife(fakeWin(sent))).rejects.toThrow(/missing/)
    expect(isRifeInstalled()).toBe(false)
    expect(sent[sent.length - 1]!.stage).toBe('error')
  })

  it('rejects an archive with no binary at all', async () => {
    kit.extractLayout = dest => { mkdirSync(join(dest, ASSET.archiveRoot), { recursive: true }) }
    await expect(installRife(null)).rejects.toThrow(/Could not locate/)
    expect(isRifeInstalled()).toBe(false)
  })

  it('finds the binary even if upstream renames the top-level directory', async () => {
    kit.extractLayout = dest => {
      const root = join(dest, 'some-other-name')
      mkdirSync(join(root, 'rife-v4.6'), { recursive: true })
      writeFileSync(join(root, EXE), 'BIN')
      writeFileSync(join(root, 'rife-v4.6', 'flownet.param'), 'P')
      writeFileSync(join(root, 'rife-v4.6', 'flownet.bin'), 'B')
    }
    await installRife(null)
    expect(isRifeInstalled()).toBe(true)
  })
})

// ── the sanity probe ──────────────────────────────────────────────────────────

describe('the post-install sanity probe', () => {
  it('ACCEPTS the usage banner even though the binary exits non-zero', async () => {
    sanity.code = 4294967295          // the Windows DWORD of `return -1`
    await installRife(null)
    expect(isRifeInstalled()).toBe(true)
  })

  it('rolls bin/ back when the binary cannot start — no half-install reads as ready', async () => {
    sanity.stderr = ''
    sanity.code = 3221225781          // STATUS_DLL_NOT_FOUND
    const sent: Ev[] = []
    await expect(installRife(fakeWin(sent))).rejects.toThrow(/did not respond/)
    expect(isRifeInstalled()).toBe(false)
    expect(existsSync(rifeBinDir())).toBe(false)
    expect(sent[sent.length - 1]!.stage).toBe('error')
  })

  it('rolls back when the binary cannot be spawned at all', async () => {
    sanity.spawnThrows = true
    await expect(installRife(null)).rejects.toThrow(/could not be started/)
    expect(isRifeInstalled()).toBe(false)
  })
})

// ── uninstall ─────────────────────────────────────────────────────────────────

describe('uninstallRife', () => {
  it('removes the engine and the downloads (that is why anyone clicks it)', async () => {
    await installRife(null)
    expect(isRifeInstalled()).toBe(true)
    expect(uninstallRife()).toEqual({ ok: true })
    expect(isRifeInstalled()).toBe(false)
    expect(existsSync(rifeBinDir())).toBe(false)
    expect(existsSync(join(HOST.userData, 'rife', 'downloads'))).toBe(false)
  })

  it('is safe on a machine that never installed it', () => {
    expect(uninstallRife()).toEqual({ ok: true })
  })
})
