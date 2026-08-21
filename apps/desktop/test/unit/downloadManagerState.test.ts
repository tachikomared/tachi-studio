// apps/desktop/test/unit/downloadManagerState.test.ts
//
// THE IO LAMP WENT STALE — the download queue lied about a LIVE transfer.
//
// Driver evidence: a queue entry sat frozen at state:'error' with
// receivedBytes 1348645739 while its `.part` kept growing for ~3 more minutes,
// to 1963 MB. Everything downstream reads this store as the source of truth
// (the DownloadStrip, and the OPUS chrome IO lamp which lights on
// queued|active|verifying), so the app showed a dead download during a live
// one.
//
// Root cause: when runManagedDownload rejects with an UNCODED error the
// installers fall back to their legacy direct `resumableDownload` — writing to
// the SAME .part this task owns — and nothing told the manager. The task was
// left in its terminal 'error' state with the byte count from the moment of
// failure.
//
// The contract pinned here: BYTES ADVANCING ⇒ state 'active'. Plus the
// error → resume → active transition, and that PAUSE keeps the partial while
// CANCEL discards it (the app's designed resume behaviour).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// vi.hoisted, not a bare const: the vi.mock('electron') factory below is hoisted
// above these declarations, and download-manager's graph now reaches a module
// that calls app.getPath('userData') at MODULE SCOPE (settings-store), so the
// factory really does run before a plain const would be initialised.
const USERDATA = vi.hoisted(() => 'C:\\FakeUserData')
const PART = 'D:\\Tachi Studio\\Models\\sd\\sd-turbo\\model.safetensors.part'
const DEST = 'D:\\Tachi Studio\\Models\\sd\\sd-turbo\\model.safetensors'

// ─── fake fs ──────────────────────────────────────────────────────────────────

const fsState = vi.hoisted(() => ({
  files: new Map<string, number>(),
  removed: [] as string[],
  written: [] as string[],
  /** Every writeFileSync body — downloads.json is inspected for secrets. */
  writtenBodies: [] as Array<{ path: string; body: string }>,
}))

vi.mock('fs', () => ({
  existsSync: (p: string) => fsState.files.has(p),
  statSync: (p: string) => {
    if (!fsState.files.has(p)) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return { size: fsState.files.get(p)! }
  },
  mkdirSync: () => undefined,
  readFileSync: () => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e },
  writeFileSync: (p: string, body: string) => {
    fsState.written.push(p)
    fsState.writtenBodies.push({ path: p, body: String(body) })
  },
  renameSync: (src: string, dst: string) => {
    fsState.files.set(dst, fsState.files.get(src) ?? 0)
    fsState.files.delete(src)
  },
  rmSync: (p: string) => { fsState.removed.push(p); fsState.files.delete(p) },
}))

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}))

// The keychain, stubbed to hold NOTHING.
//
// This file's fixture URL is a huggingface.co `/resolve/` link, and HF became a
// GATED DOWNLOAD HOST on 2026-07-31 — so `resumeCredentialHeaders` now takes
// its real path for every run here: a dynamic `import('./keychain')` followed by
// a lookup. Without this stub that import pulls the real module (which reads
// userData at module scope) and, more subtly, adds await points BEFORE
// resumableDownload is reached — which is what left `kit.pending` null after a
// single tick. Stubbing it keeps the credential path deterministic and empty,
// so every assertion in this file still describes an ANONYMOUS transfer except
// the ones that pass `headers` explicitly.
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: () => null,
  hasKey: () => false,
}))

// ─── controllable installer-kit ───────────────────────────────────────────────

const kit = vi.hoisted(() => ({
  pending: null as null | {
    resolve: () => void
    reject: (e: unknown) => void
    onChunk?: (bytes: number, total: number) => void
  },
  starts: 0,
  /** The DownloadRequestOptions of every resumableDownload call, in order. */
  optionsSeen: [] as Array<{ headers?: Record<string, string>; expectedTotalBytes?: number } | undefined>,
}))

vi.mock('../../electron/services/util/installer-kit', () => ({
  resumableDownload: (
    _url: string,
    _dest: string,
    onChunk?: (bytes: number, total: number) => void,
    _retries?: number,
    signal?: AbortSignal,
    options?: { headers?: Record<string, string>; expectedTotalBytes?: number },
  ) => new Promise<void>((resolve, reject) => {
    kit.starts += 1
    kit.optionsSeen.push(options)
    kit.pending = { resolve, reject, onChunk }
    signal?.addEventListener('abort', () => reject(new Error('Download cancelled')), { once: true })
  }),
  sha256File: async () => 'a'.repeat(64),
  freeDiskBytes: async () => 4_000_000_000_000,
  requiredDiskBytes: (total: number, start: number) => Math.max(0, total - start) + 500 * 1024 * 1024,
  diskShortfallMessage: () => 'Not enough disk space',
}))

import {
  runManagedDownload,
  resumeManagedDownload,
  pauseManagedDownload,
  cancelManagedDownload,
  adoptExternalProgress,
  settleExternalDownload,
  listDownloads,
} from '../../electron/services/download-manager'

const ID = 'sd:sd-turbo:model'

function spec() {
  return {
    id: ID,
    name: 'SD-Turbo — model',
    kind: 'sd-model' as const,
    url: 'https://huggingface.co/stabilityai/sd-turbo/resolve/main/sd_turbo.safetensors',
    destPath: DEST,
    partPath: PART,
    approxTotalBytes: 5_214_561_328,
  }
}

const row = () => listDownloads().find(d => d.id === ID)!
// SEVERAL macrotask turns, not one.
//
// A single turn used to be enough because this file's huggingface.co fixture
// URL matched no gated host, so the credential path short-circuited
// synchronously. HF joined GATED_DOWNLOAD_HOSTS on 2026-07-31, and the
// re-attach (`await import('./keychain')` + lookup) now sits between
// runManagedDownload's entry and the resumableDownload call — one turn lands
// before `kit.pending` is set, which reads as "the manager never started".
//
// Turn count is not the contract; "the async prologue has drained" is. So this
// yields a bounded number of times rather than a hand-tuned exact one, which is
// what stops the next await added to that prologue from re-breaking 12 tests.
const FLUSH_TURNS = 8
const flush = async () => {
  for (let i = 0; i < FLUSH_TURNS; i++) await new Promise(r => setTimeout(r, 0))
}

/** Start a run and drive it to state:'error' with a network failure. */
async function startAndFail(atBytes = 1_348_645_739): Promise<void> {
  const p = runManagedDownload(spec()).catch(() => { /* coded rejection */ })
  await flush()
  kit.pending!.onChunk?.(atBytes, 5_214_561_328)
  fsState.files.set(PART, atBytes)
  kit.pending!.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
  await p
}

beforeEach(() => {
  fsState.files.clear()
  fsState.removed.length = 0
  fsState.written.length = 0
  fsState.writtenBodies.length = 0
  kit.pending = null
  kit.starts = 0
  kit.optionsSeen.length = 0
})

afterEach(async () => {
  // Drain anything still in flight so no run leaks into the next test.
  //
  // THIS HAS TO BE ASYNC, and that is not tidying. Most tests here start a run
  // and never settle it. A run can still be parked on an `await` inside
  // execute()'s prologue when the test ends — the gated-host credential
  // re-attach is one, and HF became a gated host on 2026-07-31, which is what
  // exposed this. cancelManagedDownload() then aborts a transfer that HAS NOT
  // STARTED: there is no abort listener yet, so nothing catches it. The run
  // resumes afterwards, calls resumableDownload, and sets `kit.pending` /
  // pushes `optionsSeen` — AFTER beforeEach cleared them, i.e. inside the next
  // test, which then sees a phantom start it never made. That is how one added
  // await turned into twelve unrelated failures.
  //
  // So: cancel, YIELD until those late arrivals land, reject them, yield again,
  // and only then reset. The reset is repeated here rather than left to
  // beforeEach so the drained state is clean at the moment the test ends.
  for (const d of listDownloads()) cancelManagedDownload(d.id)
  await flush()
  kit.pending?.reject(Object.assign(new Error('Download cancelled'), { code: 'CANCELLED' }))
  await flush()
  for (const d of listDownloads()) cancelManagedDownload(d.id)
  kit.pending = null
  kit.starts = 0
  kit.optionsSeen.length = 0
})

// ─── 1. error → resume → active ──────────────────────────────────────────────

describe('download-manager — the error → resume → active transition', () => {
  it('a network failure lands the row in error, and resume flips it back to active', async () => {
    await startAndFail()
    expect(row().state).toBe('error')
    expect(row().errorCode).toBe('NETWORK')

    expect(resumeManagedDownload(ID)).toBe(true)
    expect(row().state).toBe('active')     // synchronous — no window where it lies
    expect(row().error).toBeUndefined()
    expect(row().errorCode).toBeUndefined()
    await flush()
    expect(kit.starts).toBe(2)             // a SECOND transfer really started
  })

  it('resume refuses for a row that is already running', async () => {
    runManagedDownload(spec()).catch(() => { /* */ })
    await flush()
    expect(row().state).toBe('active')
    expect(resumeManagedDownload(ID)).toBe(false)
  })

  it('an errored row reports the bytes ON DISK, not the last in-flight counter', async () => {
    const p = runManagedDownload(spec()).catch(() => { /* */ })
    await flush()
    kit.pending!.onChunk?.(1_000_000, 5_214_561_328)
    fsState.files.set(PART, 2_058_354_688)   // the writer got further than the last tick
    kit.pending!.reject(new Error('socket hang up'))
    await p
    expect(row().state).toBe('error')
    expect(row().receivedBytes).toBe(2_058_354_688)
  })
})

// ─── 2. bytes advancing ⇒ active (the legacy-fallback takeover) ──────────────

describe('download-manager — an advancing .part can never read as error', () => {
  it('adopting external progress clears the stale error and reports the real bytes', async () => {
    await startAndFail()
    expect(row().state).toBe('error')

    expect(adoptExternalProgress(ID, 1_500_000_000, 5_214_561_328)).toBe(true)
    expect(row().state).toBe('active')
    expect(row().error).toBeUndefined()
    expect(row().errorCode).toBeUndefined()
    expect(row().receivedBytes).toBe(1_500_000_000)
    expect(row().totalBytes).toBe(5_214_561_328)
  })

  it('THE INVARIANT: no advancing byte count ever coexists with state error', async () => {
    await startAndFail()
    // The driver watched the .part climb 1348 MB → 1963 MB over ~3 minutes
    // while the row said "error". Every one of those ticks must read active.
    let last = row().receivedBytes
    for (const bytes of [1_400_000_000, 1_700_000_000, 2_058_354_688]) {
      adoptExternalProgress(ID, bytes, 5_214_561_328)
      const s = row()
      expect(s.receivedBytes).toBeGreaterThan(last)
      expect(s.state).not.toBe('error')
      expect(s.state).toBe('active')
      last = s.receivedBytes
    }
  })

  it('never stomps a transfer the manager itself is running', async () => {
    runManagedDownload(spec()).catch(() => { /* */ })
    await flush()
    expect(adoptExternalProgress(ID, 999, 5_214_561_328)).toBe(false)
    expect(row().receivedBytes).toBe(0)
  })

  it('refuses an unknown id rather than inventing a row', () => {
    expect(adoptExternalProgress('sd:nope:model', 10)).toBe(false)
    expect(listDownloads().find(d => d.id === 'sd:nope:model')).toBeUndefined()
  })

  it('settling successfully drops the row (the fallback landed the file)', async () => {
    await startAndFail()
    adoptExternalProgress(ID, 1_500_000_000)
    expect(settleExternalDownload(ID)).toBe(true)
    expect(listDownloads().find(d => d.id === ID)).toBeUndefined()
  })

  it('settling with a failure records an honest error at the on-disk offset', async () => {
    await startAndFail()
    adoptExternalProgress(ID, 1_500_000_000)
    fsState.files.set(PART, 2_058_354_688)
    expect(settleExternalDownload(ID, new Error('ETIMEDOUT'))).toBe(true)
    expect(row().state).toBe('error')
    expect(row().error).toContain('ETIMEDOUT')
    expect(row().receivedBytes).toBe(2_058_354_688)
    expect(row().speedBytesPerSec).toBe(0)
  })

  it('settle is a no-op for a row nobody adopted', async () => {
    await startAndFail()
    expect(settleExternalDownload(ID)).toBe(false)
    expect(row().state).toBe('error')      // untouched
  })
})

// ─── 3. Stop semantics: pause KEEPS the partial, cancel discards it ──────────

describe('download-manager — Stop keeps the partial, Cancel does not', () => {
  it('pause aborts the transfer and leaves the .part on disk for resume', async () => {
    const p = runManagedDownload(spec()).catch(() => { /* PAUSED */ })
    await flush()
    kit.pending!.onChunk?.(1_500_000_000, 5_214_561_328)
    fsState.files.set(PART, 1_500_000_000)

    expect(pauseManagedDownload(ID)).toBe(true)
    await p
    expect(row().state).toBe('paused')
    expect(row().receivedBytes).toBe(1_500_000_000)
    expect(fsState.removed).not.toContain(PART)
    expect(fsState.files.has(PART)).toBe(true)   // THE resume path is intact
  })

  it('a paused row resumes from the bytes on disk', async () => {
    const p = runManagedDownload(spec()).catch(() => { /* */ })
    await flush()
    fsState.files.set(PART, 1_500_000_000)
    pauseManagedDownload(ID)
    await p
    expect(resumeManagedDownload(ID)).toBe(true)
    expect(row().state).toBe('active')
    expect(row().receivedBytes).toBe(1_500_000_000)
  })

  it('pause refuses a row the manager is not actively running', async () => {
    await startAndFail()
    expect(pauseManagedDownload(ID)).toBe(false)  // errored — nothing to abort
    adoptExternalProgress(ID, 1_500_000_000)
    expect(pauseManagedDownload(ID)).toBe(false)  // externally owned — no handle
  })

  it('cancel deletes the partial and drops the row', async () => {
    const p = runManagedDownload(spec()).catch(() => { /* CANCELLED */ })
    await flush()
    fsState.files.set(PART, 1_500_000_000)
    expect(cancelManagedDownload(ID)).toBe(true)
    await p
    expect(fsState.removed).toContain(PART)
    expect(listDownloads().find(d => d.id === ID)).toBeUndefined()
  })
})

// ─── 4. gated hosts: the credential reaches the wire, never the disk ─────────
//
// A Civitai download needs `Authorization: Bearer <key>` on civitai.com (and
// NOWHERE else — installer-kit drops it on the presigned-R2 hop, pinned in
// downloadAuthHeaders.test.ts). Here: that the manager THREADS it, and that
// `downloads.json` — plaintext under userData, next to a DPAPI-encrypted
// keychain — never sees it.

const TOKEN = 'Bearer civitai-secret-key-do-not-leak'

function authSpec() {
  return { ...spec(), headers: { Authorization: TOKEN } }
}

describe('download-manager — credentials for gated weights hosts', () => {
  it('threads spec.headers into the transfer', async () => {
    runManagedDownload(authSpec()).catch(() => { /* */ })
    await flush()
    expect(kit.optionsSeen[0]?.headers).toEqual({ Authorization: TOKEN })
  })

  it('a spec without headers sends none (nothing is invented for HF/registry rows)', async () => {
    runManagedDownload(spec()).catch(() => { /* */ })
    await flush()
    expect(kit.optionsSeen[0]?.headers).toBeUndefined()
  })

  it('THE LEAK GATE: downloads.json never contains the credential', async () => {
    runManagedDownload(authSpec()).catch(() => { /* */ })
    await flush()
    kit.pending!.onChunk?.(1_000_000, 5_214_561_328)
    fsState.files.set(PART, 1_000_000)
    pauseManagedDownload(ID)
    await flush()

    const queueFiles = fsState.writtenBodies.filter(w => w.path.endsWith('downloads.json'))
    expect(queueFiles.length).toBeGreaterThan(0)   // it really did persist
    for (const { body } of queueFiles) {
      expect(body).not.toContain('civitai-secret-key')
      expect(body.toLowerCase()).not.toContain('authorization')
      expect(body.toLowerCase()).not.toContain('headers')
      // …and the row itself IS there, so this is not a vacuous pass.
      expect(JSON.parse(body).tasks.some((t: { id: string }) => t.id === ID)).toBe(true)
    }
  })

  it('an in-session pause → resume re-attaches the SAME credential', async () => {
    const p = runManagedDownload(authSpec()).catch(() => { /* PAUSED */ })
    await flush()
    fsState.files.set(PART, 1_000_000)
    pauseManagedDownload(ID)
    await p
    expect(resumeManagedDownload(ID)).toBe(true)
    await flush()
    expect(kit.starts).toBe(2)
    expect(kit.optionsSeen[1]?.headers).toEqual({ Authorization: TOKEN })
  })

  it('a fresh spec replaces the credential (rotated key, same download)', async () => {
    await startAndFail()
    runManagedDownload(authSpec()).catch(() => { /* */ })
    await flush()
    expect(kit.optionsSeen[kit.optionsSeen.length - 1]?.headers).toEqual({ Authorization: TOKEN })
  })
})

describe('download-manager — a refused response is a DELIBERATE outcome', () => {
  it('keeps the SIZE_MISMATCH code (so no installer re-downloads the same garbage)', async () => {
    // installer-kit refuses an HTML body / an impossible content-length with
    // this code. It must NOT decay to 'NETWORK': that is the code that sends
    // the installers down their legacy direct path, which would fetch the very
    // same non-file again.
    const p = runManagedDownload(authSpec()).catch((e: unknown) => e)
    await flush()
    fsState.files.set(PART, 1_000_000)          // an older, good partial
    kit.pending!.reject(Object.assign(
      new Error('Refusing to save this response as a file: the server answered with an HTML page'),
      { code: 'SIZE_MISMATCH' },
    ))
    const err = await p
    expect((err as { code?: string }).code).toBe('SIZE_MISMATCH')
    expect(row().errorCode).toBe('SIZE_MISMATCH')
    expect(row().error).toMatch(/HTML page/)
    // The guard wrote nothing, so the partial it protected is still there.
    expect(fsState.removed).not.toContain(PART)
    expect(row().receivedBytes).toBe(1_000_000)
  })
})

describe('download-manager — the size the response is judged against', () => {
  it('passes the registry estimate when that is all we have', async () => {
    runManagedDownload(spec()).catch(() => { /* */ })
    await flush()
    expect(kit.optionsSeen[0]?.expectedTotalBytes).toBe(5_214_561_328)
  })

  it('an EXACT expected size wins over the approximate one', async () => {
    runManagedDownload({ ...spec(), expectedBytes: 4_444_444_444 }).catch(() => { /* */ })
    await flush()
    expect(kit.optionsSeen[0]?.expectedTotalBytes).toBe(4_444_444_444)
  })

  it('no size at all ⇒ no length judgement is asked for', async () => {
    const { approxTotalBytes: _drop, ...noSize } = spec()
    runManagedDownload(noSize).catch(() => { /* */ })
    await flush()
    expect(kit.optionsSeen[0]?.expectedTotalBytes).toBeUndefined()
  })
})

