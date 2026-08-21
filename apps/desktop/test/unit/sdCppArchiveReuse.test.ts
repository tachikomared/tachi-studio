// apps/desktop/test/unit/sdCppArchiveReuse.test.ts
//
// THE 345 MB ENGINE ZIP IS DOWNLOADED ONCE.
//
// Two defects from the engine+generation driver, same file, same directory:
//
//   1. RETRY RE-DOWNLOADED THE WHOLE ZIP. _doInstallBinary resumed a
//      `<asset>.tmp`, but the moment the bytes verified it renamed that tmp to
//      the final `<asset>.zip`. When the SUBSEQUENT cudart download failed and
//      the user clicked Install again there was no tmp to resume — so 345 MB
//      came down the wire a second time while the complete, SHA-verified zip sat
//      untouched in the same directory.
//
//   2. LANDED ARCHIVES WERE NEVER SWEPT. sweepStalePartials only ever collected
//      `.tmp*` siblings, so a finished install left ~925 MB of extracted-and-
//      never-read-again zips parked on the userData volume (13 GB free on C: on
//      the reporting machine).
//
// The two pull against each other, and that tension is the contract this file
// pins: a kept zip is exactly what makes fix 1's skip work, so the sweep must
// fire ONLY past every failure exit.
//
// REAL fs against a temp userData root (electron's app.getPath is the only mock)
// — the verdict turns on real bytes and a real sha256, not on a fake.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

// hoisted: vi.mock factories run before module-level consts are initialized,
// and storage-root reads app.getPath() at IMPORT time.
const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdcpp-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import { canReuseLandedArchive, sweepLandedArchives } from '../../electron/services/sd-cpp-installer'

const DOWNLOADS = join(USERDATA, 'sd-cpp', 'downloads')
const ZIP = 'sd-master-b290693-bin-win-cuda12-x64.zip'
const CUDART = 'cudart-sd-bin-win-cu12-x64.zip'

const sha = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex')

function land(name: string, body: string): { path: string; sha256: string } {
  const path = join(DOWNLOADS, name)
  writeFileSync(path, body)
  return { path, sha256: sha(body) }
}

beforeEach(() => {
  rmSync(DOWNLOADS, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  mkdirSync(DOWNLOADS, { recursive: true })
})

afterAll(() => { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

// ─── 1. A verified archive on disk is REUSED, never re-downloaded ─────────────

describe('canReuseLandedArchive — the retry does not re-download 345 MB', () => {
  it('reuses a landed archive whose sha256 matches, and leaves it on disk', async () => {
    const { path, sha256 } = land(ZIP, 'engine-bytes')
    await expect(canReuseLandedArchive(path, sha256)).resolves.toBe(true)
    expect(existsSync(path)).toBe(true)              // the extractor still needs it
  })

  it('is case-insensitive about the registry sha (hex casing is not integrity)', async () => {
    const { path, sha256 } = land(ZIP, 'engine-bytes')
    await expect(canReuseLandedArchive(path, sha256.toUpperCase())).resolves.toBe(true)
  })

  it('DELETES a landed archive whose sha256 mismatches — proven-bad bytes never shadow the fresh download', async () => {
    const { path } = land(ZIP, 'truncated-or-corrupt')
    await expect(canReuseLandedArchive(path, sha('the-real-bytes'))).resolves.toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('deletes a zero-byte archive instead of trusting or resuming it', async () => {
    const { path } = land(ZIP, '')
    await expect(canReuseLandedArchive(path, sha('anything'))).resolves.toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('returns false for an absent archive without throwing (the first-ever install)', async () => {
    await expect(canReuseLandedArchive(join(DOWNLOADS, ZIP), sha('x'))).resolves.toBe(false)
  })

  it('never TRUSTS an unverifiable archive, and never destroys it either', async () => {
    for (const registrySha of ['__SHA_PLACEHOLDER_win_cuda__', undefined, '']) {
      const { path } = land(ZIP, 'engine-bytes')
      await expect(canReuseLandedArchive(path, registrySha)).resolves.toBe(false)
      expect(existsSync(path)).toBe(true)  // unproven ≠ proven bad
    }
  })

  it('covers the cudart archive on the same terms (its failure is what strands the engine zip)', async () => {
    const { path, sha256 } = land(CUDART, 'cudart-dlls')
    await expect(canReuseLandedArchive(path, sha256)).resolves.toBe(true)
    await expect(canReuseLandedArchive(path, sha('other'))).resolves.toBe(false)
    expect(existsSync(path)).toBe(false)
  })
})

// ─── 2. A fully successful install sweeps the landed archives ────────────────

describe('sweepLandedArchives — ~925 MB does not sit on the userData volume', () => {
  it('removes every landed archive it finds', () => {
    land(ZIP, 'engine-bytes')
    land(CUDART, 'cudart-dlls')
    expect(sweepLandedArchives()).toBe(2)
    expect(readdirSync(DOWNLOADS)).toEqual([])
  })

  it('leaves .tmp partials alone — a paused download must still be resumable', () => {
    land(ZIP, 'engine-bytes')
    writeFileSync(join(DOWNLOADS, `${CUDART}.tmp`), 'half-a-cudart')
    writeFileSync(join(DOWNLOADS, `${ZIP}.tmp.1`), 'older partial')
    expect(sweepLandedArchives()).toBe(1)
    expect(readdirSync(DOWNLOADS).sort()).toEqual([`${CUDART}.tmp`, `${ZIP}.tmp.1`])
  })

  it('does not walk into the staging directory (extraction scratch is not an archive)', () => {
    mkdirSync(join(DOWNLOADS, 'staging', 'build', 'bin'), { recursive: true })
    writeFileSync(join(DOWNLOADS, 'staging', 'build', 'bin', 'inner.zip'), 'nested')
    land(ZIP, 'engine-bytes')
    expect(sweepLandedArchives()).toBe(1)
    expect(existsSync(join(DOWNLOADS, 'staging', 'build', 'bin', 'inner.zip'))).toBe(true)
  })

  it('is a no-op (0, no throw) when downloads/ does not exist yet', () => {
    rmSync(DOWNLOADS, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    expect(sweepLandedArchives()).toBe(0)
  })

  it('is idempotent — a second Install click on an installed engine sweeps nothing', () => {
    land(ZIP, 'engine-bytes')
    expect(sweepLandedArchives()).toBe(1)
    expect(sweepLandedArchives()).toBe(0)
  })
})

// ─── 3. Ordering inside _doInstallBinary (unreachable without a network) ─────
//
// The runtime tests above prove the two helpers. What they cannot reach is
// WHERE the install calls them — and "where" IS the bug: a sweep one line too
// early destroys the very zip the reuse gate exists to find. Source assertions,
// the idiom installerAdoptContract.test.ts already uses for this file.

describe('_doInstallBinary wiring', () => {
  const src = readFileSync(resolve(__dirname, '..', '..', 'electron/services/sd-cpp-installer.ts'), 'utf8')
  const body = src.slice(src.indexOf('async function _doInstallBinary'))

  it('gates BOTH archive downloads behind the reuse check', () => {
    expect(body.match(/canReuseLandedArchive\(/g) ?? []).toHaveLength(2)
    // …and the check comes before the partial is prepared, or the tmp is created
    // (and the download started) regardless of what is already on disk.
    expect(body.indexOf('canReuseLandedArchive(')).toBeLessThan(body.indexOf('prepareResumablePartial('))
  })

  it('sweeps only PAST the final success gate — a partial install keeps its archives', () => {
    const sweepAt   = body.indexOf('sweepLandedArchives()')
    const successAt = body.indexOf('if (!isSdCppInstalled())')
    const doneAt    = body.indexOf("stage: 'done'")
    expect(sweepAt).toBeGreaterThan(successAt)
    expect(sweepAt).toBeLessThan(doneAt)
    // No sweep anywhere in the download/extract stretch that can still throw.
    expect(body.slice(0, successAt)).not.toContain('sweepLandedArchives()')
  })

  it('keeps the partial-kept resume contract intact (the fix must not eat it)', () => {
    expect(body).toContain('partial kept, click Install to resume')
    expect(body.match(/sweepStalePartials\(/g) ?? []).toHaveLength(2)
  })
})
