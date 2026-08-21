// apps/desktop/test/unit/downloadAuthHeaders.test.ts
//
// THE DOWNLOAD SPINE LEARNS CREDENTIALS — WITHOUT LEAKING THEM, AND WITHOUT
// SAVING AN ERROR PAGE AS A MODEL.
//
// Two failure classes are pinned here, both from the Civitai integration spec
// (notes/CIVITAI-INTEGRATION-SPEC-2026-07-28.md §1 landmine R1, §5 win 10):
//
//  1. TOKEN LEAK ACROSS A REDIRECT. `GET civitai.com/api/download/models/<id>`
//     answers 307 with a presigned R2/B2 URL whose signature covers
//     `X-Amz-SignedHeaders=host` ONLY. downloadFrom REBUILDS its header block
//     on every hop, so a naively-threaded `Authorization` would be re-sent to
//     the object store — which both FAILS (400 InvalidRequest) and hands our
//     user's API key to a third-party host. The header must be scoped to the
//     origin the caller named.
//
//  2. THE 20 KB HTML NAMED `.safetensors`. A missing/expired credential is
//     answered with a 200 HTML page, not a 401. Piped over the `.part` it
//     becomes a "downloaded model" that fails to load hours later — the exact
//     bug ComfyUI-Manager success-reports today. The response is judged BEFORE
//     the write stream exists, so a good partial is never damaged by a bad
//     answer.
//
// Fake `https` + `fs`: every hop, header block and body is deterministic and
// offline — no socket, no disk.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

// ─── fake fs ──────────────────────────────────────────────────────────────────

const fsState = vi.hoisted(() => ({
  streams: [] as Array<EventEmitter & { path: string; flags: string; closed: boolean; destroyed: boolean }>,
  files: new Map<string, number>(),
}))

vi.mock('fs', async () => {
  const { EventEmitter } = await import('events')
  class WS extends EventEmitter {
    closed = false
    destroyed = false
    constructor(public path: string, public flags: string) { super() }
    write(): boolean { return true }
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
    statfs: (_d: string, cb: (e: unknown, s: unknown) => void) => cb(null, { bavail: 1e12, bsize: 4096 }),
    openSync: () => 42,
    closeSync: () => undefined,
    rmSync: (p: string) => { fsState.files.delete(p) },
  }
})

// ─── fake https ───────────────────────────────────────────────────────────────

interface Call { host: string; path: string; headers: Record<string, string> }

const netState = vi.hoisted(() => ({
  /** Every hop's request line + the header block it was actually sent with. */
  calls: [] as Array<{ host: string; path: string; headers: Record<string, string> }>,
  /** Queued answers, one per hop, in order. */
  queue: [] as Array<{ status: number; headers: Record<string, string> }>,
  responses: [] as Array<EventEmitter & { statusCode: number; headers: Record<string, string>; resumed: boolean }>,
}))

vi.mock('https', async () => {
  const { EventEmitter } = await import('events')
  class Req extends EventEmitter {
    destroyed = false
    setTimeout(_ms: number, _cb: () => void): this { return this }
    end(): void { /* */ }
    destroy(err?: Error): void {
      if (this.destroyed) return
      this.destroyed = true
      if (err) this.emit('error', err)
    }
  }
  class Res extends EventEmitter {
    resumed = false
    constructor(public statusCode: number, public headers: Record<string, string>) { super() }
    resume(): void { this.resumed = true }
    pipe(dest: unknown): unknown { return dest }
  }
  return {
    get: (
      opts: { host: string; path: string; headers: Record<string, string> },
      cb: (res: unknown) => void,
    ) => {
      netState.calls.push({ host: opts.host, path: opts.path, headers: { ...opts.headers } })
      const req = new Req()
      const answer = netState.queue.shift() ?? { status: 200, headers: { 'content-length': '100' } }
      const res = new Res(answer.status, answer.headers)
      netState.responses.push(res)
      queueMicrotask(() => cb(res))
      return req
    },
  }
})

import {
  downloadFrom,
  resumableDownload,
  isSameDownloadOrigin,
  notAFileReason,
  isTransientNetworkError,
  NOT_A_FILE_LENGTH_RATIO,
} from '../../electron/services/util/installer-kit'

const ORIGIN_URL = 'https://civitai.com/api/download/models/128713'
const PRESIGNED  = 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/model/x.safetensors?X-Amz-Signature=deadbeef'
const DEST       = 'D:\\Tachi Studio\\Models\\sd\\civitai-128713\\model.safetensors.part'
const TOKEN      = 'Bearer civitai-secret-key-do-not-leak'

const flush = () => new Promise(r => setTimeout(r, 0))
const lastStream = () => fsState.streams[fsState.streams.length - 1]

/**
 * Deliver `bytes` of body on the live response, then close the write stream —
 * i.e. a complete, non-truncated transfer. (downloadFrom only reads
 * `chunk.length`, so no multi-GB buffer is ever allocated here.)
 */
function deliver(bytes: number): void {
  const res = netState.responses[netState.responses.length - 1]
  if (bytes > 0) res.emit('data', { length: bytes } as unknown as Buffer)
  lastStream().emit('finish')
}
/** Case-insensitive header lookup on a captured hop. */
const hdr = (c: Call, name: string): string | undefined =>
  Object.entries(c.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]

/** Queue the answers for the hops of one download, in order. */
function answers(...list: Array<{ status: number; headers: Record<string, string> }>): void {
  netState.queue.push(...list)
}
const ok = (headers: Record<string, string>) => ({ status: 200, headers })
const redirect = (to: string) => ({ status: 302, headers: { location: to } })

beforeEach(() => {
  fsState.streams.length = 0
  fsState.files.clear()
  netState.calls.length = 0
  netState.queue.length = 0
  netState.responses.length = 0
})

// ─── 1. the header is applied on the caller's own origin ─────────────────────

describe('downloadFrom — credentials on the origin the caller named', () => {
  it('sends the custom header on the first hop', async () => {
    answers(ok({ 'content-length': '1000' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, { headers: { Authorization: TOKEN } })
    await flush()
    deliver(1000)
    await expect(p).resolves.toBeUndefined()
    expect(hdr(netState.calls[0], 'authorization')).toBe(TOKEN)
    expect(hdr(netState.calls[0], 'user-agent')).toBe('TachiDesk/installer')
  })

  it('no options ⇒ exactly the built-in header block (nothing invented)', async () => {
    answers(ok({ 'content-length': '1000' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0)
    await flush()
    deliver(1000)
    await p
    expect(Object.keys(netState.calls[0].headers).sort()).toEqual(['Accept', 'User-Agent'])
  })

  it('keeps the header across a SAME-origin redirect (civitai bounces internally)', async () => {
    answers(redirect('https://civitai.com/api/download/models/128713?type=Model'), ok({ 'content-length': '1000' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, { headers: { Authorization: TOKEN } })
    await flush()
    await flush()
    deliver(1000)
    await p
    expect(netState.calls).toHaveLength(2)
    expect(hdr(netState.calls[1], 'authorization')).toBe(TOKEN)
  })

  it('a relative-path redirect stays on the origin and keeps the header', async () => {
    answers(redirect('/api/download/models/128713/file'), ok({ 'content-length': '1000' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, { headers: { Authorization: TOKEN } })
    await flush()
    await flush()
    deliver(1000)
    await p
    expect(netState.calls[1].host).toBe('civitai.com')
    expect(hdr(netState.calls[1], 'authorization')).toBe(TOKEN)
  })
})

// ─── 2. THE LEAK: the header dies on a cross-origin hop ──────────────────────

describe('downloadFrom — the custom header NEVER crosses an origin', () => {
  it('drops Authorization on the 307 to the presigned object store', async () => {
    answers(redirect(PRESIGNED), ok({ 'content-length': '1000' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, { headers: { Authorization: TOKEN } })
    await flush()
    await flush()
    deliver(1000)
    await p

    expect(netState.calls).toHaveLength(2)
    expect(hdr(netState.calls[0], 'authorization')).toBe(TOKEN)   // origin: yes
    expect(hdr(netState.calls[1], 'authorization')).toBeUndefined() // R2: never
    // …and the token is not smuggled under some other name either.
    expect(JSON.stringify(netState.calls[1].headers)).not.toContain('civitai-secret-key')
  })

  it('the BUILT-IN headers keep flowing on the cross-origin hop (Range included)', async () => {
    fsState.files.set(DEST, 60)
    answers(redirect(PRESIGNED), { status: 206, headers: { 'content-range': 'bytes 60-99/100' } })
    const p = downloadFrom(ORIGIN_URL, DEST, 60, undefined, undefined, { headers: { Authorization: TOKEN } })
    await flush()
    await flush()
    deliver(40)
    await p
    expect(hdr(netState.calls[1], 'user-agent')).toBe('TachiDesk/installer')
    expect(hdr(netState.calls[1], 'accept')).toBe('*/*')
    expect(hdr(netState.calls[1], 'range')).toBe('bytes=60-')
  })

  it('every custom header is dropped, not just Authorization', async () => {
    answers(redirect(PRESIGNED), ok({ 'content-length': '1000' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, {
      headers: { Authorization: TOKEN, 'X-Api-Key': 'second-secret', Cookie: 'session=abc' },
    })
    await flush()
    await flush()
    deliver(1000)
    await p
    expect(Object.keys(netState.calls[1].headers).sort()).toEqual(['Accept', 'User-Agent'])
  })

  it('a hop BACK to the caller origin re-applies it (the guard is per-hop, not one-shot)', async () => {
    answers(redirect(PRESIGNED), redirect(ORIGIN_URL), ok({ 'content-length': '1000' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, { headers: { Authorization: TOKEN } })
    await flush(); await flush(); await flush()
    deliver(1000)
    await p
    expect(netState.calls.map(c => hdr(c, 'authorization'))).toEqual([TOKEN, undefined, TOKEN])
  })

  it('a caller can never rewrite Range or Host — a resume stays honest', async () => {
    fsState.files.set(DEST, 60)
    answers({ status: 206, headers: { 'content-range': 'bytes 60-99/100' } })
    const p = downloadFrom(ORIGIN_URL, DEST, 60, undefined, undefined, {
      headers: { Range: 'bytes=0-', Host: 'evil.test', Authorization: TOKEN },
    })
    await flush()
    deliver(40)
    await p
    expect(hdr(netState.calls[0], 'range')).toBe('bytes=60-')
    expect(hdr(netState.calls[0], 'host')).toBeUndefined()
    expect(hdr(netState.calls[0], 'authorization')).toBe(TOKEN)
  })

  it('resumableDownload threads the options through its retry wrapper', async () => {
    answers(ok({ 'content-length': '1000' }))
    const p = resumableDownload(ORIGIN_URL, DEST, undefined, 0, undefined, { headers: { Authorization: TOKEN } })
    await flush()
    deliver(1000)
    await expect(p).resolves.toBeUndefined()
    expect(hdr(netState.calls[0], 'authorization')).toBe(TOKEN)
  })
})

// ─── 3. HTML-as-model: refused BEFORE anything is written ────────────────────

describe('downloadFrom — an HTML page is never saved as a model file', () => {
  it('rejects a text/html 200 and opens NO write stream', async () => {
    fsState.files.set(DEST, 0)
    answers(ok({ 'content-type': 'text/html; charset=utf-8', 'content-length': '20480' }))
    await expect(downloadFrom(ORIGIN_URL, DEST, 0)).rejects.toThrow(/HTML page/i)
    expect(fsState.streams).toHaveLength(0)   // THE point: the .part is untouched
    expect(netState.responses[0].resumed).toBe(true) // body drained, socket freed
  })

  it('the refusal is CODED and NOT transient — retrying cannot change the answer', async () => {
    answers(ok({ 'content-type': 'text/html', 'content-length': '20480' }))
    const err = await downloadFrom(ORIGIN_URL, DEST, 0).catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('SIZE_MISMATCH')
    expect(isTransientNetworkError(err)).toBe(false)
  })

  it('resumableDownload does not burn its retries on it (one request, then out)', async () => {
    answers(
      ok({ 'content-type': 'text/html', 'content-length': '20480' }),
      ok({ 'content-type': 'text/html', 'content-length': '20480' }),
    )
    await expect(resumableDownload(ORIGIN_URL, DEST, undefined, 6)).rejects.toThrow(/HTML page/i)
    expect(netState.calls).toHaveLength(1)
  })

  it('a real binary content-type sails through', async () => {
    answers(ok({ 'content-type': 'application/octet-stream', 'content-length': '1000' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0)
    await flush()
    deliver(1000)
    await expect(p).resolves.toBeUndefined()
  })

  it('a missing content-type is not held against the server', async () => {
    answers(ok({ 'content-length': '1000' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0)
    await flush()
    deliver(1000)
    await expect(p).resolves.toBeUndefined()
  })

  it('does NOT re-litigate content-type on a 206 resume of verified bytes', async () => {
    fsState.files.set(DEST, 60)
    answers({ status: 206, headers: { 'content-type': 'text/html', 'content-range': 'bytes 60-99/100' } })
    const p = downloadFrom(ORIGIN_URL, DEST, 60, undefined, undefined, { expectedTotalBytes: 100 })
    await flush()
    expect(fsState.streams).toHaveLength(1)
    expect(lastStream().flags).toBe('a')
    deliver(40)
    await expect(p).resolves.toBeUndefined()
  })

  it('DOES judge a 200 answered to a Range request — that restart truncates the .part', async () => {
    // Server ignored Range → downloadFrom would re-open with 'w' and destroy
    // the partial. The bytes are about to be byte 0, so the gate applies.
    fsState.files.set(DEST, 60)
    answers(ok({ 'content-type': 'text/html', 'content-length': '20480' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 60)
    await expect(p).rejects.toThrow(/HTML page/i)
    expect(fsState.streams).toHaveLength(0)
    expect(fsState.files.get(DEST)).toBe(60)   // partial survived intact
  })
})

// ─── 4. length contradiction ─────────────────────────────────────────────────

describe('downloadFrom — a body that cannot be the file is refused', () => {
  it('rejects 20 KB declared for a 2 GB model, before any write', async () => {
    answers(ok({ 'content-type': 'application/octet-stream', 'content-length': '20480' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, { expectedTotalBytes: 2_000_000_000 })
    await expect(p).rejects.toThrow(/less than half/)
    expect(fsState.streams).toHaveLength(0)
  })

  it('accepts a size within the tolerance (registry estimates are approximate)', async () => {
    // piper en_US-amy-medium: 61 MiB declared by the registry, 63_206_176 real.
    answers(ok({ 'content-length': '63206176' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, { expectedTotalBytes: 61 * 1_048_576 })
    await flush()
    deliver(63_206_176)
    await expect(p).resolves.toBeUndefined()
  })

  it('an OVER-declared registry size is not fatal (piper shipped a 2.15x one)', async () => {
    answers(ok({ 'content-length': '63206176' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, { expectedTotalBytes: 28 * 1_048_576 })
    await flush()
    deliver(63_206_176)
    await expect(p).resolves.toBeUndefined()
  })

  it('THE RESUME TRAP: a 206 remainder is judged as a FULL-file total, not raw content-length', async () => {
    // A download resumed at 75% has only 500 MB of body left. Naive code
    // compares that content-length against the 2 GB expectation and
    // "discovers" a 4x shortfall on a perfectly healthy resume — killing every
    // resume past the halfway mark.
    fsState.files.set(DEST, 1_500_000_000)
    answers({ status: 206, headers: { 'content-range': 'bytes 1500000000-1999999999/2000000000', 'content-length': '500000000' } })
    const p = downloadFrom(ORIGIN_URL, DEST, 1_500_000_000, undefined, undefined, { expectedTotalBytes: 2_000_000_000 })
    await flush()
    expect(fsState.streams).toHaveLength(1)
    deliver(500_000_000)
    await expect(p).resolves.toBeUndefined()
  })

  it('a 206 WITHOUT content-range still reconstructs the total from the offset', async () => {
    fsState.files.set(DEST, 1_500_000_000)
    answers({ status: 206, headers: { 'content-length': '500000000' } })
    const p = downloadFrom(ORIGIN_URL, DEST, 1_500_000_000, undefined, undefined, { expectedTotalBytes: 2_000_000_000 })
    await flush()
    expect(fsState.streams).toHaveLength(1)
    deliver(500_000_000)
    await expect(p).resolves.toBeUndefined()
  })

  it('no expectation ⇒ no length judgement (the legacy installers pass none)', async () => {
    answers(ok({ 'content-length': '20480' }))
    const p = downloadFrom(ORIGIN_URL, DEST, 0)
    await flush()
    deliver(20480)
    await expect(p).resolves.toBeUndefined()
  })

  it('an unknown declared size is not a contradiction either', async () => {
    answers(ok({}))   // chunked: no content-length at all
    const p = downloadFrom(ORIGIN_URL, DEST, 0, undefined, undefined, { expectedTotalBytes: 2_000_000_000 })
    await flush()
    deliver(0)
    await expect(p).resolves.toBeUndefined()
  })
})

// ─── 5. the predicates, directly (mutation surface) ──────────────────────────

describe('isSameDownloadOrigin', () => {
  it('same scheme+host+port is the same origin', () => {
    expect(isSameDownloadOrigin('https://civitai.com/a', 'https://civitai.com/b?q=1')).toBe(true)
    expect(isSameDownloadOrigin('https://civitai.com:443/a', 'https://civitai.com/b')).toBe(true)
  })

  it('a different HOST is not — this is the R2 hop', () => {
    expect(isSameDownloadOrigin(PRESIGNED, ORIGIN_URL)).toBe(false)
  })

  it('a SUBDOMAIN is not the same origin (no suffix matching)', () => {
    expect(isSameDownloadOrigin('https://cdn.civitai.com/x', 'https://civitai.com/x')).toBe(false)
    expect(isSameDownloadOrigin('https://civitai.com.evil.test/x', 'https://civitai.com/x')).toBe(false)
  })

  it('a different port or scheme is not the same origin', () => {
    expect(isSameDownloadOrigin('https://civitai.com:8443/a', 'https://civitai.com/a')).toBe(false)
    expect(isSameDownloadOrigin('http://civitai.com/a', 'https://civitai.com/a')).toBe(false)
  })

  it('fails CLOSED on anything unparseable', () => {
    expect(isSameDownloadOrigin('not a url', 'https://civitai.com/a')).toBe(false)
    expect(isSameDownloadOrigin('https://civitai.com/a', '')).toBe(false)
  })
})

describe('notAFileReason', () => {
  it('names text/html, ignoring parameters and case', () => {
    expect(notAFileReason('TEXT/HTML; charset=UTF-8', 20480, 0, true)).toMatch(/HTML page/)
  })

  it('says nothing about content-type when the check is off (a resume)', () => {
    expect(notAFileReason('text/html', 0, 0, false)).toBeNull()
  })

  it('fires strictly below the ratio, not at it', () => {
    const half = 1000 * NOT_A_FILE_LENGTH_RATIO
    expect(notAFileReason(undefined, half, 1000, true)).toBeNull()
    expect(notAFileReason(undefined, half - 1, 1000, true)).toMatch(/less than half/)
  })

  it('never judges a length it does not have on both sides', () => {
    expect(notAFileReason(undefined, 0, 1000, true)).toBeNull()
    expect(notAFileReason(undefined, 20480, 0, true)).toBeNull()
  })

  it('a healthy binary response is not a reason', () => {
    expect(notAFileReason('application/octet-stream', 2_000_000_000, 1_998_000_000, true)).toBeNull()
  })
})
