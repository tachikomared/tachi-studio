// apps/desktop/test/unit/downloadStreamCleanup.test.ts
//
// P1 — THE ENGINE INSTALL THAT WEDGED PERMANENTLY.
//
// Driver evidence: one network failure during the sd.cpp engine-zip download
// left `<userData>\sd-cpp\downloads\<asset>.zip.tmp` EXCLUSIVELY OPEN by the
// app's own process. Every later install attempt then returned
//   { ok:false, error:"Download failed: EPERM ... open '...zip.tmp'" }
// until the app was restarted.
//
// Mechanism: downloadFrom() created the write stream and rejected on
// res/req/timeout/abort errors WITHOUT closing it. The caller's `rmSync(tmp)`
// then unlinked a file that still had an open handle — on Windows that leaves
// the name DELETE-PENDING, and every subsequent open of that name fails with
// EPERM for as long as the leaked handle lives (i.e. forever). The fix: the fd
// is released on EVERY exit path, and prepareResumablePartial recovers a
// poisoned .tmp without an app restart.
//
// Pinned here with fake `https` + `fs` modules: the whole failure matrix is
// deterministic and offline — no socket, no disk, no timing.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

interface Stream extends EventEmitter {
  path: string
  flags: string
  destroyed: boolean
  closed: boolean
}

// ─── fake fs ──────────────────────────────────────────────────────────────────

const fsState = vi.hoisted(() => ({
  streams: [] as Array<EventEmitter & { path: string; flags: string; destroyed: boolean; closed: boolean }>,
  files: new Map<string, number>(),
  /** open() throws EPERM here; a successful rmSync clears it (handle released). */
  lockedForOpen: new Set<string>(),
  /** open() throws EPERM here FOREVER — Windows DELETE-PENDING on a leaked fd. */
  wedgedForOpen: new Set<string>(),
  removed: [] as string[],
}))

vi.mock('fs', async () => {
  const { EventEmitter } = await import('events')
  class WS extends EventEmitter {
    destroyed = false
    closed = false
    written = 0
    constructor(public path: string, public flags: string) { super() }
    write(chunk: Buffer | string): boolean { this.written += chunk.length; return true }
    end(): void { this.emit('finish') }
    close(cb?: () => void): void { this.closed = true; cb?.() }
    destroy(): void { this.destroyed = true; this.closed = true }
  }
  return {
    createWriteStream: (p: string, opts: { flags: string }) => {
      const s = new WS(p, opts.flags)
      fsState.streams.push(s)
      return s
    },
    createReadStream: () => new EventEmitter(),
    existsSync: (p: string) => fsState.files.has(p),
    statSync: (p: string) => ({ size: fsState.files.get(p) ?? 0 }),
    mkdirSync: () => undefined,
    statfs: (_d: string, cb: (e: unknown, s: unknown) => void) => cb(null, { bavail: 1e9, bsize: 4096 }),
    openSync: (p: string) => {
      if (fsState.lockedForOpen.has(p) || fsState.wedgedForOpen.has(p)) {
        const err = new Error(`EPERM: operation not permitted, open '${p}'`) as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      fsState.files.set(p, fsState.files.get(p) ?? 0)
      return 42
    },
    closeSync: () => undefined,
    rmSync: (p: string) => {
      fsState.removed.push(p)
      fsState.files.delete(p)
      fsState.lockedForOpen.delete(p) // the handle went away with the file
    },
  }
})

// ─── fake https ───────────────────────────────────────────────────────────────

const netState = vi.hoisted(() => ({
  reqs: [] as Array<EventEmitter & { destroyed: boolean; timeoutMs: number; timeoutHandler: (() => void) | null }>,
  respond: null as null | ((cb: (res: unknown) => void) => void),
}))

vi.mock('https', async () => {
  const { EventEmitter } = await import('events')
  class Req extends EventEmitter {
    destroyed = false
    timeoutMs = 0
    timeoutHandler: (() => void) | null = null
    setTimeout(ms: number, cb: () => void): this { this.timeoutMs = ms; this.timeoutHandler = cb; return this }
    end(): void { /* */ }
    destroy(err?: Error): void {
      if (this.destroyed) return
      this.destroyed = true
      if (err) this.emit('error', err)
    }
  }
  return {
    get: (_opts: unknown, cb: (res: unknown) => void) => {
      const req = new Req()
      netState.reqs.push(req)
      netState.respond?.(cb)
      return req
    },
  }
})

class FakeResponse extends EventEmitter {
  resumed = false
  constructor(public statusCode: number, public headers: Record<string, string>) { super() }
  resume(): void { this.resumed = true }
  pipe(dest: unknown): unknown { return dest }
  destroy(): void { /* */ }
}

import { downloadFrom, prepareResumablePartial } from '../../electron/services/util/installer-kit'

const URL_OK = 'https://example.test/asset.zip'
const DEST = 'C:\\ud\\sd-cpp\\downloads\\asset.zip.tmp'

/** Arm the next https.get to answer with this status/headers. */
function respondWith(status: number, headers: Record<string, string>): { res: FakeResponse } {
  const box = { res: null as unknown as FakeResponse }
  netState.respond = (cb) => {
    const res = new FakeResponse(status, headers)
    box.res = res
    queueMicrotask(() => cb(res)) // delivered async, like a real socket
  }
  return box
}

const lastStream = (): Stream => fsState.streams[fsState.streams.length - 1] as unknown as Stream
const flush = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  fsState.streams.length = 0
  fsState.files.clear()
  fsState.lockedForOpen.clear()
  fsState.wedgedForOpen.clear()
  fsState.removed.length = 0
  netState.reqs.length = 0
  netState.respond = null
})

// ─── 1. every failure path releases the fd ───────────────────────────────────

describe('downloadFrom — the write stream is closed on EVERY failure path', () => {
  it('response error: rejects AND destroys the stream (no leaked handle)', async () => {
    const box = respondWith(200, { 'content-length': '100' })
    const p = downloadFrom(URL_OK, DEST, 0)
    await flush()
    expect(fsState.streams).toHaveLength(1)
    box.res.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    await expect(p).rejects.toThrow(/socket hang up/)
    expect(lastStream().destroyed).toBe(true)
  })

  it('request error after headers: rejects AND destroys the stream', async () => {
    respondWith(200, { 'content-length': '100' })
    const p = downloadFrom(URL_OK, DEST, 0)
    await flush()
    netState.reqs[0].emit('error', Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }))
    await expect(p).rejects.toThrow(/ECONNRESET/)
    expect(lastStream().destroyed).toBe(true)
  })

  it('socket idle timeout: rejects AND destroys the stream', async () => {
    respondWith(200, { 'content-length': '100' })
    const p = downloadFrom(URL_OK, DEST, 0)
    await flush()
    expect(netState.reqs[0].timeoutMs).toBe(60_000)
    netState.reqs[0].timeoutHandler!()          // exactly what req.setTimeout fires
    await expect(p).rejects.toThrow(/socket idle timeout/)
    expect(lastStream().destroyed).toBe(true)
  })

  it('abort signal mid-transfer: rejects AND destroys the stream', async () => {
    respondWith(200, { 'content-length': '100' })
    const ac = new AbortController()
    const p = downloadFrom(URL_OK, DEST, 0, undefined, ac.signal)
    await flush()
    ac.abort()
    await expect(p).rejects.toThrow(/cancelled/i)
    expect(lastStream().destroyed).toBe(true)
  })

  it('short body (clean close before content-length) resumes AND closes the fd', async () => {
    const box = respondWith(200, { 'content-length': '100' })
    const p = downloadFrom(URL_OK, DEST, 0)
    await flush()
    box.res.emit('data', Buffer.alloc(40))
    lastStream().emit('finish')                  // CDN closed the body early
    await expect(p).rejects.toMatchObject({ code: 'ERR_STREAM_PREMATURE_CLOSE' })
    expect(lastStream().closed).toBe(true)
  })

  it('non-2xx never opens a stream at all', async () => {
    respondWith(404, {})
    await expect(downloadFrom(URL_OK, DEST, 0)).rejects.toMatchObject({ code: 'HTTP_404' })
    expect(fsState.streams).toHaveLength(0)
  })

  it('a late error after a settled failure leaves nothing open', async () => {
    const box = respondWith(200, { 'content-length': '100' })
    const p = downloadFrom(URL_OK, DEST, 0)
    await flush()
    box.res.emit('error', new Error('socket hang up'))
    await expect(p).rejects.toThrow()
    netState.reqs[0].emit('error', new Error('late reset')) // must not throw
    expect(fsState.streams.every(s => s.destroyed || s.closed)).toBe(true)
  })
})

// ─── 2. the success path still succeeds (and closes) ─────────────────────────

describe('downloadFrom — success path', () => {
  it('resolves once the full body has landed, with the fd closed', async () => {
    const box = respondWith(200, { 'content-length': '100' })
    const seen: Array<[number, number]> = []
    const p = downloadFrom(URL_OK, DEST, 0, (b, t) => seen.push([b, t]))
    await flush()
    box.res.emit('data', Buffer.alloc(100))
    lastStream().emit('finish')
    await expect(p).resolves.toBeUndefined()
    expect(seen).toEqual([[100, 100]])
    expect(lastStream().closed).toBe(true)
  })

  it('a resume opens with append and counts from the byte offset', async () => {
    const box = respondWith(206, { 'content-range': 'bytes 60-99/100' })
    const seen: Array<[number, number]> = []
    const p = downloadFrom(URL_OK, DEST, 60, (b, t) => seen.push([b, t]))
    await flush()
    expect(lastStream().flags).toBe('a')
    box.res.emit('data', Buffer.alloc(40))
    lastStream().emit('finish')
    await expect(p).resolves.toBeUndefined()
    expect(seen).toEqual([[100, 100]])           // offset + chunk, total from content-range
  })

  it('416 on a resumed range means "already complete", not a failure', async () => {
    respondWith(416, {})
    await expect(downloadFrom(URL_OK, DEST, 100)).resolves.toBeUndefined()
    expect(fsState.streams).toHaveLength(0)
  })
})

// ─── 3. in-process recovery of a poisoned partial ────────────────────────────

describe('prepareResumablePartial — a failed attempt is recoverable IN-PROCESS', () => {
  it('keeps the path AND its bytes when the partial is usable — that is a resume', () => {
    fsState.files.set(DEST, 1_348_645_739)
    expect(prepareResumablePartial(DEST)).toEqual({ path: DEST, recovery: 'ready' })
    expect(fsState.removed).toHaveLength(0)      // a good partial is NEVER discarded
  })

  it('deletes a partial it cannot open, then reuses the same path', () => {
    fsState.lockedForOpen.add(DEST)
    fsState.files.set(DEST, 10)
    const r = prepareResumablePartial(DEST)
    expect(r).toEqual({ path: DEST, recovery: 'cleaned' })
    expect(fsState.removed).toContain(DEST)
  })

  it('falls back to a fresh sibling when the name stays wedged (DELETE-PENDING)', () => {
    fsState.wedgedForOpen.add(DEST)              // survives the unlink, like Windows
    const r = prepareResumablePartial(DEST)
    expect(r.recovery).toBe('relocated')
    expect(r.path.startsWith(`${DEST}.`)).toBe(true)
    expect(fsState.removed).toContain(DEST)      // it did try to clean first
  })
})
