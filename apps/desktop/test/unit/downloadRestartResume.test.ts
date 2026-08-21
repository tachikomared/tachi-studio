// apps/desktop/test/unit/downloadRestartResume.test.ts
//
// RESUME AFTER AN APP RESTART TRUNCATED THE PARTIAL (P1, driver-reproduced).
//
// Driver evidence, Civitai phase-1 verify run: a paused download sat at
// 1 599 861 658 bytes on disk. Quit the app → relaunch → the strip correctly
// showed 75% (initDownloadManager re-stats the `.part`, so the manager KNEW the
// count) → click RESUME → the `.part` dropped to 8 239 898 bytes and the whole
// 2.13 GB file re-downloaded. In-session pause→resume, by contrast, preserved
// the partial. Upstream is innocent: `Range: bytes=N-` answers 206 with a
// correct content-range on both civitai.com and the b2 redirect it 307s to.
//
// ROOT CAUSE — downloadFrom's `flags: resuming ? 'a' : 'w'`, where
// `resuming = startByte > 0 && code === 206`. A server that answers **200** to
// our Range request (its right — Range is a request, not a command) therefore
// re-opened the multi-GB partial with 'w' and destroyed it. d24056e knew this
// path truncates and guarded only the text/html shape of it; a 200 carrying
// `application/octet-stream` and the full content-length sails straight
// through the not-a-file gate and into the truncating write.
//
// The restart is what makes the server answer differently at all: `headers`
// are deliberately NOT persisted (downloads.json is plaintext), so the
// rehydrated task re-requests a GATED file with no credential — a materially
// different request from the one that produced the 206 in-session.
//
// TWO INVARIANTS PINNED HERE:
//   1. bytes already on disk are NEVER destroyed by an answer we did not ask
//      for — not by a 200, and not by a 206 whose range starts somewhere else.
//   2. a rehydrated task re-attaches the gated host's credential from the
//      keychain, so the resume is the same request that worked in-session.
//
// Fake fs (createWriteStream with flags 'w' TRUNCATES the in-memory file, so
// "the partial survived" is a real assertion) + fake https. No socket, no disk.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { join } from 'node:path'

// vi.hoisted, not a bare const: the vi.mock('electron') factory below is hoisted
// above these declarations, and download-manager's graph now reaches a module
// that calls app.getPath('userData') at MODULE SCOPE (settings-store), so the
// factory really does run before a plain const would be initialised.
//
// The paths are built in the SHAPE OF THE HOST PLATFORM. The manager walks them
// with node:path, and `C:\Fake…` is a *relative* path to a POSIX runner — which
// is how this file passed for months and then failed the first time CI ran it
// on Linux.
const WIN = process.platform === 'win32'
const USERDATA = vi.hoisted(() => (process.platform === 'win32' ? 'C:\\FakeUserData' : '/FakeUserData'))
const ROOT = WIN ? 'D:\\Tachi Studio' : '/Tachi Studio'
const DOWNLOADS_JSON = join(USERDATA, 'downloads.json')
const DEST = join(ROOT, 'Models', 'sd', 'civitai-142421', 'model.safetensors')
const PART = `${DEST}.part`
const ID = 'sd:civitai-142421:model'
const CIVITAI_URL = 'https://civitai.com/api/download/models/142421?type=Model&format=SafeTensor'
const HF_URL = 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors'

/** The driver's numbers, verbatim. */
const PARTIAL = 1_599_861_658
const TOTAL = 2_132_625_431

const KEY = 'civitai-secret-key-do-not-leak'

// ─── fake fs ──────────────────────────────────────────────────────────────────

const fsState = vi.hoisted(() => ({
  files: new Map<string, number>(),
  /** downloads.json bodies, newest last. */
  persisted: [] as string[],
  streams: [] as Array<EventEmitter & { path: string; flags: string; destroyed: boolean }>,
  removed: [] as string[],
}))

vi.mock('fs', async () => {
  const { EventEmitter } = await import('events')
  class WS extends EventEmitter {
    destroyed = false
    constructor(public path: string, public flags: string) { super() }
    write(): boolean { return true }
    end(): void { this.emit('finish') }
    close(cb?: () => void): void { cb?.() }
    destroy(): void { this.destroyed = true }
  }
  return {
    existsSync: (p: string) => fsState.files.has(p),
    statSync: (p: string) => {
      if (!fsState.files.has(p)) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }
      return { size: fsState.files.get(p)! }
    },
    mkdirSync: () => undefined,
    readFileSync: (p: string) => {
      const body = fsState.persisted.length && String(p) === DOWNLOADS_JSON
        ? fsState.persisted[fsState.persisted.length - 1]
        : null
      if (body === null) { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; throw e }
      return body
    },
    writeFileSync: (p: string, body: string) => {
      if (String(p) === DOWNLOADS_JSON) fsState.persisted.push(String(body))
    },
    renameSync: (src: string, dst: string) => {
      fsState.files.set(dst, fsState.files.get(src) ?? 0)
      fsState.files.delete(src)
    },
    rmSync: (p: string) => { fsState.removed.push(p); fsState.files.delete(p) },
    // THE POINT OF THIS MOCK: 'w' truncates, 'a' does not.
    createWriteStream: (p: string, opts: { flags: string }) => {
      if (opts.flags === 'w') fsState.files.set(p, 0)
      else if (!fsState.files.has(p)) fsState.files.set(p, 0)
      const s = new WS(p, opts.flags)
      fsState.streams.push(s)
      return s
    },
    createReadStream: () => {
      const rs = new EventEmitter()
      queueMicrotask(() => rs.emit('end'))
      return rs
    },
    statfs: (_d: string, cb: (e: unknown, s: unknown) => void) => cb(null, { bavail: 1e12, bsize: 4096 }),
    openSync: () => 42,
    closeSync: () => undefined,
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}))

const keyState = vi.hoisted(() => ({ key: null as string | null }))
vi.mock('../../electron/services/keychain', () => ({
  retrieveKey: (id: string) => (id === 'civitai' ? keyState.key : null),
}))

// ─── fake https ───────────────────────────────────────────────────────────────

interface Call { host: string; path: string; headers: Record<string, string> }

const netState = vi.hoisted(() => ({
  calls: [] as Array<{ host: string; path: string; headers: Record<string, string> }>,
  queue: [] as Array<{ status: number; headers: Record<string, string> }>,
  responses: [] as Array<EventEmitter & { statusCode: number; headers: Record<string, string> }>,
}))

vi.mock('https', async () => {
  const { EventEmitter } = await import('events')
  class Req extends EventEmitter {
    destroyed = false
    setTimeout(): this { return this }
    end(): void { /* */ }
    destroy(err?: Error): void {
      if (this.destroyed) return
      this.destroyed = true
      if (err) this.emit('error', err)
    }
  }
  class Res extends EventEmitter {
    constructor(public statusCode: number, public headers: Record<string, string>) { super() }
    resume(): void { /* drained */ }
    pipe(dest: unknown): unknown { return dest }
  }
  return {
    get: (
      opts: { host: string; path: string; headers: Record<string, string> },
      cb: (res: unknown) => void,
    ) => {
      netState.calls.push({ host: opts.host, path: opts.path, headers: { ...opts.headers } })
      const req = new Req()
      const answer = netState.queue.shift() ?? { status: 200, headers: { 'content-length': String(TOTAL) } }
      const res = new Res(answer.status, answer.headers)
      netState.responses.push(res)
      queueMicrotask(() => cb(res))
      return req
    },
  }
})

import {
  initDownloadManager,
  resumeManagedDownload,
  cancelManagedDownload,
  listDownloads,
  credentialKeyIdForDownloadUrl,
} from '../../electron/services/download-manager'
import {
  contentRangeStart,
  resumeMismatchReason,
} from '../../electron/services/util/installer-kit'

// ─── helpers ──────────────────────────────────────────────────────────────────

const flush = () => new Promise(r => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 8; i++) await flush() }
const hdr = (c: Call, name: string): string | undefined =>
  Object.entries(c.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
const row = () => listDownloads().find(d => d.id === ID)
const lastStream = () => fsState.streams[fsState.streams.length - 1]

/** The downloads.json a real quit-while-paused leaves behind. */
function persistPausedTask(url = CIVITAI_URL): void {
  fsState.persisted.push(JSON.stringify({
    version: 1,
    tasks: [{
      id: ID,
      name: 'Realistic Vision — model',
      kind: 'sd-model',
      url,
      destPath: DEST,
      partPath: PART,
      expectedSha256: 'b'.repeat(64),
      approxTotalBytes: TOTAL,
      headerTotalBytes: TOTAL,
      state: 'paused',
    }],
  }))
}

function answer(status: number, headers: Record<string, string>): void {
  netState.queue.push({ status, headers })
}

/** Restart the app with a paused partial of `bytes` on disk, then hit RESUME. */
async function relaunchAndResume(bytes = PARTIAL, url = CIVITAI_URL): Promise<void> {
  persistPausedTask(url)
  fsState.files.set(PART, bytes)
  initDownloadManager()
  expect(row()).toMatchObject({ state: 'paused', receivedBytes: bytes })
  expect(resumeManagedDownload(ID)).toBe(true)
  await settle()
}

beforeEach(async () => {
  // The manager's task map is module state — a task left mid-flight by the
  // previous test would be joined instead of restarted. Cancel drains it
  // (abort → coded rejection → the row is dropped).
  for (let i = 0; i < 3 && listDownloads().length > 0; i++) {
    for (const d of listDownloads()) cancelManagedDownload(d.id)
    await flush()
  }
  fsState.files.clear()
  fsState.persisted.length = 0
  fsState.streams.length = 0
  fsState.removed.length = 0
  netState.calls.length = 0
  netState.queue.length = 0
  netState.responses.length = 0
  keyState.key = null
})

// ─── 1. THE BUG: a 200 answered to our Range request wiped 1.59 GB ───────────

describe('restart → resume — the partial is never destroyed', () => {
  it('asks to continue from the bytes on disk (Range: bytes=N-)', async () => {
    answer(206, { 'content-range': `bytes ${PARTIAL}-${TOTAL - 1}/${TOTAL}` })
    await relaunchAndResume()
    expect(netState.calls).toHaveLength(1)
    expect(hdr(netState.calls[0], 'range')).toBe(`bytes=${PARTIAL}-`)
  })

  it('THE DRIVER BUG: a 200 to that Range does NOT truncate the .part', async () => {
    // The server ignored Range and offered the whole file. Before the fix this
    // re-opened the partial with flags 'w' and lost 1 599 861 658 bytes.
    answer(200, { 'content-type': 'application/octet-stream', 'content-length': String(TOTAL) })
    await relaunchAndResume()
    expect(fsState.files.get(PART)).toBe(PARTIAL)
    expect(fsState.streams).toHaveLength(0)      // nothing was even opened
    expect(fsState.removed).not.toContain(PART)
  })

  it('…and says so honestly, in a state the user can act on', async () => {
    answer(200, { 'content-type': 'application/octet-stream', 'content-length': String(TOTAL) })
    await relaunchAndResume()
    const r = row()!
    expect(r.state).toBe('error')
    expect(r.receivedBytes).toBe(PARTIAL)        // the row still reports the truth
    expect(r.error).toMatch(/ignored/i)
    expect(r.error).toContain(String(PARTIAL))
    expect(r.errorCode).toBe('RANGE_IGNORED')
  })

  it('does not retry-storm: one request, then out', async () => {
    for (let i = 0; i < 4; i++) answer(200, { 'content-length': String(TOTAL) })
    await relaunchAndResume()
    expect(netState.calls).toHaveLength(1)
  })

  it('a 206 that really continues our partial appends and keeps the bytes', async () => {
    answer(206, { 'content-range': `bytes ${PARTIAL}-${TOTAL - 1}/${TOTAL}` })
    await relaunchAndResume()
    expect(fsState.streams).toHaveLength(1)
    expect(lastStream().flags).toBe('a')
    expect(fsState.files.get(PART)).toBe(PARTIAL)
  })

  it('OFFSET DRIFT: a 206 starting somewhere else is refused, not appended', async () => {
    // Appending a body that starts at byte 0 onto 1.59 GB of partial would
    // produce a file that is the right SIZE and completely corrupt.
    answer(206, { 'content-range': `bytes 0-${TOTAL - 1}/${TOTAL}` })
    await relaunchAndResume()
    expect(fsState.streams).toHaveLength(0)
    expect(fsState.files.get(PART)).toBe(PARTIAL)
    expect(row()!.error).toMatch(/starting at 0/)
  })

  it('a 206 with NO content-range is still trusted (the offset is ours)', async () => {
    answer(206, { 'content-length': String(TOTAL - PARTIAL) })
    await relaunchAndResume()
    expect(fsState.streams).toHaveLength(1)
    expect(lastStream().flags).toBe('a')
  })

  it('a FRESH download (no partial) still starts from zero as usual', async () => {
    answer(200, { 'content-type': 'application/octet-stream', 'content-length': String(TOTAL) })
    persistPausedTask()
    initDownloadManager()                        // no .part on disk at all
    expect(resumeManagedDownload(ID)).toBe(true)
    await settle()
    expect(fsState.streams).toHaveLength(1)
    expect(lastStream().flags).toBe('w')
    expect(hdr(netState.calls[0], 'range')).toBeUndefined()
  })
})

// ─── 2. the rehydrated task re-attaches the gated host's credential ──────────

describe('restart → resume — the credential comes back from the keychain', () => {
  it('re-attaches Authorization for a gated host (it is never persisted)', async () => {
    keyState.key = KEY
    answer(206, { 'content-range': `bytes ${PARTIAL}-${TOTAL - 1}/${TOTAL}` })
    await relaunchAndResume()
    expect(hdr(netState.calls[0], 'authorization')).toBe(`Bearer ${KEY}`)
    // …and it STILL never lands in downloads.json.
    expect(fsState.persisted.join('\n')).not.toContain(KEY)
  })

  it('no stored key ⇒ anonymous, not broken', async () => {
    keyState.key = null
    answer(206, { 'content-range': `bytes ${PARTIAL}-${TOTAL - 1}/${TOTAL}` })
    await relaunchAndResume()
    expect(hdr(netState.calls[0], 'authorization')).toBeUndefined()
  })

  it('a NON-gated host is never handed a credential', async () => {
    keyState.key = KEY
    answer(206, { 'content-range': `bytes ${PARTIAL}-${TOTAL - 1}/${TOTAL}` })
    await relaunchAndResume(PARTIAL, HF_URL)
    expect(hdr(netState.calls[0], 'authorization')).toBeUndefined()
  })
})

// ─── 3. the predicates, directly (mutation surface) ──────────────────────────

describe('contentRangeStart', () => {
  it('reads the start offset of a well-formed header', () => {
    expect(contentRangeStart('bytes 1599861658-2132625430/2132625431')).toBe(1_599_861_658)
    expect(contentRangeStart('BYTES  0-99/100')).toBe(0)
  })

  it('takes the first value when the header is repeated', () => {
    expect(contentRangeStart(['bytes 60-99/100', 'bytes 0-99/100'])).toBe(60)
  })

  it('is null for anything with no offset to check', () => {
    expect(contentRangeStart(undefined)).toBeNull()
    expect(contentRangeStart('bytes */2132625431')).toBeNull()
    expect(contentRangeStart('items 0-99/100')).toBeNull()
  })
})

describe('resumeMismatchReason', () => {
  it('a fresh download is never judged — starting at zero IS the plan', () => {
    expect(resumeMismatchReason(0, 200, undefined)).toBeNull()
    expect(resumeMismatchReason(0, 200, 'bytes 0-99/100')).toBeNull()
  })

  it('a 200 answered to a real resume is refused, and names the bytes at stake', () => {
    const why = resumeMismatchReason(PARTIAL, 200, undefined)
    expect(why).toMatch(/ignored/i)
    expect(why).toContain(String(PARTIAL))
  })

  it('a 206 that continues from our exact offset is fine', () => {
    expect(resumeMismatchReason(60, 206, 'bytes 60-99/100')).toBeNull()
  })

  it('a 206 starting anywhere else is refused — right size, corrupt file', () => {
    expect(resumeMismatchReason(60, 206, 'bytes 0-99/100')).toMatch(/starting at 0/)
    expect(resumeMismatchReason(60, 206, 'bytes 59-99/100')).toMatch(/starting at 59/)
  })

  it('a 206 without a content-range is trusted (the offset is ours)', () => {
    expect(resumeMismatchReason(60, 206, undefined)).toBeNull()
  })
})

describe('credentialKeyIdForDownloadUrl', () => {
  it('maps the gated hosts, case-insensitively', () => {
    expect(credentialKeyIdForDownloadUrl('https://civitai.com/api/download/models/1')).toBe('civitai')
    expect(credentialKeyIdForDownloadUrl('https://CIVITAI.com/api/download/models/1')).toBe('civitai')
    expect(credentialKeyIdForDownloadUrl('https://www.civitai.com/api/download/models/1')).toBe('civitai')
    // HuggingFace joined the table on 2026-07-31 — a stored token is what makes
    // a GATED repo (one this user accepted the terms for) downloadable at all.
    // It used to be asserted NULL below, from the era when civitai was the only
    // credentialled host.
    expect(credentialKeyIdForDownloadUrl('https://huggingface.co/org/repo/resolve/main/f.gguf')).toBe('huggingface')
    expect(credentialKeyIdForDownloadUrl('https://HuggingFace.co/org/repo/resolve/main/f.gguf')).toBe('huggingface')
    expect(credentialKeyIdForDownloadUrl('https://hf.co/org/repo/resolve/main/f.gguf')).toBe('huggingface')
  })

  it('never leaks onto a look-alike or the presigned CDN', () => {
    expect(credentialKeyIdForDownloadUrl('https://civitai.com.evil.test/x')).toBeNull()
    expect(credentialKeyIdForDownloadUrl('https://cdn.civitai.com/x')).toBeNull()
    expect(credentialKeyIdForDownloadUrl('not a url')).toBeNull()

    // THE HF HALF OF THE SAME RULE. A `/resolve/` URL 302s to a CloudFront
    // presign (measured 2026-07-31: us.aws.cdn.hf.co, with Policy + Signature +
    // Key-Pair-Id) where the URL itself is the credential. A Bearer on that hop
    // is pure leakage to a host we do not control — and it is an EXACT-host
    // table, so every one of these misses by construction.
    expect(credentialKeyIdForDownloadUrl('https://us.aws.cdn.hf.co/xet-bridge-us/a?Signature=x')).toBeNull()
    expect(credentialKeyIdForDownloadUrl('https://cdn-lfs.hf.co/repos/aa/f.safetensors')).toBeNull()
    expect(credentialKeyIdForDownloadUrl('https://cas-bridge.xethub.hf.co/xet-bridge-us/a')).toBeNull()
    expect(credentialKeyIdForDownloadUrl('https://huggingface.co.evil.test/x')).toBeNull()
    expect(credentialKeyIdForDownloadUrl('https://nothuggingface.co/x')).toBeNull()
    expect(credentialKeyIdForDownloadUrl('http://huggingface.co/x')).toBeNull()   // https only
  })
})
