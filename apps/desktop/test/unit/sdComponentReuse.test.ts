// apps/desktop/test/unit/sdComponentReuse.test.ts
//
// THE SAME BYTES ARE NEVER DOWNLOADED TWICE.
//
// A model is a SET of component files, and the curated set now SHARES files
// across rows on purpose:
//
//   • Z-Image Turbo reuses the FLUX.1 autoencoder VERBATIM (leejet's own
//     example passes `--vae ae.sft`) — 320 MiB a flux owner already has.
//   • Wan 2.1 I2V-14B-480P reuses the 2.1 vae AND the umt5-xxl encoder —
//     6,007 MiB a Wan owner already has, and the encoder alone is 5.6 GB.
//
// Before this, `_doDownloadModel` looked only at `existsSync(dest)` inside the
// model's OWN directory, so both of those came down the wire a second time. The
// registry has carried the answer all along: `sha256` IS the file's identity,
// which is why the SDXL row's own comment calls it "hash-first dedupe".
//
// The reuse is NOT trusted blindly: the twin is re-hashed before it is placed,
// the same way canReuseLandedArchive re-hashes a landed zip rather than assuming
// the bytes on disk are still the bytes that were verified.
//
// Real electron mock + real fs, matching sdModelExtensionTruth.test.ts in this dir.

import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  const { join: j } = require('node:path') as typeof import('node:path')
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-sdreuse-'))
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  modelComponentPaths, findReusableComponent, placeReusedComponent,
} from '../../electron/services/sd-cpp-installer'
import {
  UserSdModelStore, setUserSdModelStore, type UserSdModel,
} from '../../electron/services/user-sd-models'

const BYTES = Buffer.from('pretend these are 320 MiB of autoencoder weights')
const SHA   = createHash('sha256').update(BYTES).digest('hex')
const OTHER = Buffer.from('different weights entirely')
const OTHER_SHA = createHash('sha256').update(OTHER).digest('hex')

/** Two user rows that DECLARE THE SAME FILE — the shape the curated flux /
 *  Z-Image pair has, in a sha we can actually produce in a test. */
function row(id: string, sha = SHA): UserSdModel {
  return {
    id, name: `Model ${id}`, family: 'sdxl', baseSize: 1024,
    steps: 28, cfgScale: 5, samplingMethod: 'dpm++2m',
    files: [{ role: 'vae', url: 'https://example.org/ae.safetensors', sha256: sha, sizeMb: 320 }],
  }
}

// Model DIRECTORIES are keyed by id under one userData root, so ids must be
// unique per test or a file landed by an earlier case answers a later one.
let n = 0
let store: UserSdModelStore
let A = ''
let B = ''
beforeEach(() => {
  n += 1
  A = `twin-${n}-a`
  B = `twin-${n}-b`
  store = new UserSdModelStore(join(USERDATA, `reuse-${n}.json`))
  setUserSdModelStore(store)
})

afterAll(() => {
  setUserSdModelStore(null)
  try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* */ }
})

/** Land a component on disk for `id`, as a completed download would. */
function land(id: string, bytes: Buffer): string {
  const p = modelComponentPaths(id)!.vae
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, bytes)
  return p
}

describe('findReusableComponent — the sha is the identity', () => {
  it('finds the twin another model already has on disk', async () => {
    store.add(row(A))
    store.add(row(B))
    const landed = land(A, BYTES)

    expect(await findReusableComponent({ sha256: SHA }, B)).toBe(landed)
  })

  it('never answers with the model\'s OWN file (that is `existsSync(dest)`, not reuse)', async () => {
    store.add(row(A))
    land(A, BYTES)
    expect(await findReusableComponent({ sha256: SHA }, A)).toBeNull()
  })

  it('answers null when the declaring row has not downloaded it yet', async () => {
    store.add(row(A))
    store.add(row(B))
    expect(await findReusableComponent({ sha256: SHA }, B)).toBeNull()
  })

  it('RE-HASHES: a file whose bytes no longer match its declared sha is refused', async () => {
    // The registry says A's vae is SHA. Something on disk says otherwise —
    // truncation, a half-written copy, an edit. Placing it under a second model
    // would spread one corrupt file into two broken installs.
    store.add(row(A))
    store.add(row(B))
    land(A, OTHER)
    expect(await findReusableComponent({ sha256: SHA }, B)).toBeNull()
  })

  it('a placeholder sha is never an identity — unverifiable bytes are not reused', async () => {
    store.add(row(A))
    land(A, BYTES)
    expect(await findReusableComponent({ sha256: '__SHA_PLACEHOLDER_TWIN_A__' }, B)).toBeNull()
  })

  it('a different sha finds nothing, even with a same-role file sitting right there', async () => {
    store.add(row(A))
    store.add(row(B, OTHER_SHA))
    land(A, BYTES)
    expect(await findReusableComponent({ sha256: OTHER_SHA }, B)).toBeNull()
  })
})

describe('placeReusedComponent — the bytes land without a download', () => {
  it('places the file at dest and reports how', () => {
    store.add(row(A))
    store.add(row(B))
    const src  = land(A, BYTES)
    const dest = modelComponentPaths(B)!.vae
    mkdirSync(dirname(dest), { recursive: true })

    const how = placeReusedComponent(src, dest, `${dest}.part`)
    expect(['link', 'copy']).toContain(how)
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest).equals(BYTES)).toBe(true)
    // …and the transient .part is gone either way
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('a HARD LINK costs no disk at all, and the source surviving deletion is the point', () => {
    store.add(row(A))
    store.add(row(B))
    const src  = land(A, BYTES)
    const dest = modelComponentPaths(B)!.vae
    mkdirSync(dirname(dest), { recursive: true })
    const how = placeReusedComponent(src, dest, `${dest}.part`)

    if (how === 'link') {
      // Deleting one model must not empty the other: a hard link is a second
      // NAME for the bytes, not a reference into the first model's directory.
      rmSync(src, { force: true })
      expect(existsSync(dest)).toBe(true)
      expect(readFileSync(dest).equals(BYTES)).toBe(true)
    } else {
      expect(statSync(dest).size).toBe(BYTES.length)
    }
  })
})

describe('the download loop asks before it fetches', () => {
  it('_doDownloadModel consults findReusableComponent ahead of runManagedDownload', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'electron/services/sd-cpp-installer.ts'), 'utf8')
    const fn  = src.slice(src.indexOf('async function _doDownloadModel'))
    const reuseAt = fn.indexOf('findReusableComponent')
    const fetchAt = fn.indexOf('runManagedDownload')
    expect(reuseAt, 'the reuse check must exist').toBeGreaterThan(-1)
    expect(reuseAt, 'and must come BEFORE the fetch, or it saves nothing').toBeLessThan(fetchAt)
  })
})
