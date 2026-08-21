// apps/desktop/electron/services/util/installer-kit.ts
//
// Shared download/verify/extract primitives for the binary + model installers
// (llama-cpp, sd-cpp, piper, whisper, self-update). ONE proven implementation —
// resumable HTTPS Range downloads with transient-error retry, streaming sha256,
// and archive extraction — instead of a per-installer copy (this family used to
// be copy-pasted 4-5×; the bodies here are the llama-cpp superset, which added
// AbortSignal cancel support and friendlier extraction errors).
//
// NOT here on purpose: freellmapi-installer's runAsync — it needs
// `shell: true` on Windows to spawn npm.cmd, a semantically different beast.

import { get as httpsGet } from 'https'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, rmSync, statSync, statfs } from 'fs'
import { dirname } from 'path'

// ─── Transient-failure classification ─────────────────────────────────────────

/** Transient network failures worth retrying a download for. */
export function isTransientNetworkError(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  const code = e?.code ?? ''
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'ENETRESET', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code)) return true
  const msg = (e?.message ?? '').toLowerCase()
  return msg.includes('socket hang up') || msg.includes('aborted') || msg.includes('timeout') || msg.includes('econnreset') || msg.includes('premature close')
}

// ─── Disk-space preflight ─────────────────────────────────────────────────────
//
// "Started a 40 GB model download onto a 10 GB-free disk, watched it die at
// 97% with a cryptic ENOSPC" is the local-AI category's #1 support-ticket
// class. Once a download's total size is known from the response headers we
// check the destination volume and fail FAST with an actionable message.

/** Headroom left for the OS/other apps beyond the download itself. */
export const DISK_MARGIN_BYTES = 500 * 1024 * 1024

/** Bytes still needed on disk for a (possibly resuming) download + margin. */
export function requiredDiskBytes(totalBytes: number, startByte: number): number {
  return Math.max(0, totalBytes - startByte) + DISK_MARGIN_BYTES
}

export function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/**
 * Human-actionable DISK_FULL message ("need X free, have Y at <dir>").
 *
 * Names RELOCATION as the first remedy, not deletion. A user who is out of room
 * for a 7 GB model usually still wants that model — the answer is to put the
 * weights on a drive that has space (Settings → Model weights → Change folder),
 * not to delete downloads they will only fetch again over the same slow link.
 */
export function diskShortfallMessage(freeBytes: number, neededBytes: number, dir: string): string {
  return `Not enough disk space: this download needs ~${formatGb(neededBytes)} free at ${dir}, ` +
    `but only ${formatGb(freeBytes)} is available. Point Settings → Model weights at a folder ` +
    `on a drive with more room (or free up space here), then retry — the partial file resumes.`
}

/** Free bytes on the volume containing `dir`, or null when undeterminable. */
export function freeDiskBytes(dir: string): Promise<number | null> {
  return new Promise(resolve => {
    try {
      statfs(dir, (err, s) => {
        if (err || !s) { resolve(null); return }
        resolve(Number(s.bavail) * Number(s.bsize))
      })
    } catch { resolve(null) }
  })
}

// ─── Per-download request options (auth headers + "is this the file?") ───────
//
// Gated weights hosts (Civitai) need an `Authorization: Bearer <key>` on the
// FIRST request, and their download URL 307s to a presigned object-store URL
// whose signature covers `host` ONLY (`X-Amz-SignedHeaders=host`). Forwarding
// our Authorization across that hop is BOTH broken (400 InvalidRequest) and a
// key leak to a third-party host — so custom headers are scoped to the origin
// the caller actually named. See the SAME-ORIGIN GUARD in downloadFrom.

export interface DownloadRequestOptions {
  /**
   * Extra request headers — e.g. `Authorization` for a gated host.
   *
   * Applied ONLY while the request origin still equals the origin of the `url`
   * handed to this function; every cross-origin redirect hop is served with
   * the built-in headers alone. `Range`/`Host` can never be overridden (they
   * are this module's own: overriding Range would silently corrupt a resume).
   *
   * These carry SECRETS — they are never logged and never persisted (see
   * ManagedDownloadSpec.headers in download-manager.ts).
   */
  headers?: Record<string, string>
  /**
   * Best-known FULL-file size in bytes — exact when the caller has it, the
   * registry estimate otherwise. Used ONLY by the not-a-file guard below.
   */
  expectedTotalBytes?: number
}

/** Headers this module owns; a caller's map can never rewrite them. */
const RESERVED_REQUEST_HEADERS: ReadonlySet<string> = new Set(['range', 'host', 'content-length'])

/**
 * True when two URLs are the same download origin (scheme + host + port).
 * `URL.host` already normalises the default port away, so `https://a.co` and
 * `https://a.co:443` match — while `a.co` vs `cdn.a.co` (a presigned R2/B2
 * bucket) do not. Anything unparseable is NOT the same origin: the guard fails
 * CLOSED, because the cost of being wrong is leaking a Bearer token.
 */
export function isSameDownloadOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.protocol === ub.protocol && ua.host === ub.host
  } catch {
    return false
  }
}

/**
 * How far the declared size may fall short of the expected one before the
 * response is called "not the file".
 */
export const NOT_A_FILE_LENGTH_RATIO = 0.5

/**
 * Start offset of a `Content-Range: bytes <start>-<end>/<total>` header, or
 * null when the header is absent/unparseable (including the `bytes * /TOTAL`
 * unsatisfied form, which carries no offset to check).
 *
 * Node lower-cases header names and MAY hand back an array for a repeated
 * header; both shapes are accepted so a hostile/odd server cannot slip past
 * the offset check by repeating the header.
 */
export function contentRangeStart(raw: string | string[] | undefined): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw
  if (typeof s !== 'string') return null
  const m = /bytes\s+(\d+)\s*-/i.exec(s)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isFinite(n) ? n : null
}

/**
 * "Does this answer actually CONTINUE the partial on disk?" — the guard that
 * killed a driver-reproduced 1.59 GB data loss (Civitai phase-1 verify).
 *
 * Returns an honest reason, or null when the response may be appended.
 *
 * TWO WAYS AN ANSWER DESTROYS A PARTIAL, both refused here:
 *
 *  • **200 to a `Range: bytes=N-` request.** Range is a REQUEST, not a
 *    command: a server is free to answer 200 with the whole file, and some do
 *    (the same URL 206s when the request carries the credential and 200s when
 *    it does not — which is exactly what an app restart produces, because
 *    `headers` are deliberately never persisted). downloadFrom used to hand
 *    that answer to `createWriteStream(..., 'w')`, which TRUNCATES. Driver:
 *    a paused 1 599 861 658-byte `.part` came back as 8 239 898 bytes and the
 *    whole 2.13 GB re-downloaded. d24056e knew this path truncates and only
 *    guarded its text/html shape; a 200 carrying `application/octet-stream`
 *    and the full length went straight through.
 *
 *  • **206 whose range starts somewhere else.** Appending a body that begins
 *    at a different offset produces a file of exactly the right SIZE and
 *    completely corrupt content — the worst possible failure, because
 *    size-only verification would pass it.
 *
 * A fresh download (`startByte === 0`) is not judged at all: starting from
 * zero IS the plan there.
 */
export function resumeMismatchReason(
  startByte: number,
  statusCode: number,
  contentRange: string | string[] | undefined,
): string | null {
  if (!(startByte > 0)) return null
  if (statusCode === 200) {
    return `we asked to continue from byte ${startByte} and the server ignored it, offering the whole file instead ` +
      `(HTTP 200 for Range: bytes=${startByte}-). Writing that answer would discard the ${startByte} bytes already on disk`
  }
  const start = contentRangeStart(contentRange)
  if (start !== null && start !== startByte) {
    return `we asked to continue from byte ${startByte} and the server answered with a range starting at ${start}; ` +
      `appending it would corrupt the file`
  }
  return null
}

/**
 * "That response is not the artifact" — the guard that kills the class where a
 * 20 KB HTML login/consent/error page lands on disk named `model.safetensors`
 * (ComfyUI-Manager success-reports exactly that today).
 *
 * Returns an honest reason string, or null when the response looks like a file.
 *
 * TWO deliberate asymmetries:
 *  • content-type is only judged when we are about to write byte 0
 *    (`checkContentType`). A 206 continuation of a partial that already has
 *    verified bytes on disk is not re-litigated — servers are free to label a
 *    range continuation however they like, and the bytes already passed this
 *    gate once.
 *  • the length test fires only when the server declares DRASTICALLY LESS than
 *    expected. Over-declaration is not this failure class and IS a real,
 *    repo-proven state: piper's registry under-declared `en_US-amy-low` by
 *    2.15x (28 MB for a 60.2 MiB file — piper-models.ts:65) and sd-turbo had
 *    the same bug, so a symmetric rule would have hard-failed honest installs
 *    against a stale `sizeMb`. An over-large file is still caught after the
 *    fact by the manager's SIZE_MISMATCH/sha256 verdict and by disk preflight.
 *
 * `declaredTotalBytes` must be the FULL-file total (content-range's `/TOTAL`,
 * or startByte + content-length on a 206) — never the raw content-length of a
 * range response, which is only the remainder.
 */
export function notAFileReason(
  contentType: string | undefined,
  declaredTotalBytes: number,
  expectedTotalBytes: number,
  checkContentType: boolean,
): string | null {
  if (checkContentType) {
    const mime = (contentType ?? '').split(';')[0].trim().toLowerCase()
    if (mime === 'text/html') {
      return `the server answered with an HTML page (content-type ${mime}), not a file`
    }
  }
  if (
    expectedTotalBytes > 0 && declaredTotalBytes > 0 &&
    declaredTotalBytes < expectedTotalBytes * NOT_A_FILE_LENGTH_RATIO
  ) {
    return `the server declared ${declaredTotalBytes} bytes for a file expected to be about ` +
      `${expectedTotalBytes} — less than half of it`
  }
  return null
}

// ─── Download (resumable, redirect-following, https-only) ─────────────────────

/**
 * Download `url` to `dest` with HTTP Range resume + retries — survives the
 * connection resets common on multi-GB CDN transfers. On a transient drop it
 * waits, then re-requests `bytes=<bytesOnDisk>-` and appends. If the server
 * IGNORES Range (answers 200 with the whole file) the attempt is REFUSED with
 * code `RANGE_IGNORED` and the partial is left intact — it used to be silently
 * restarted from scratch, which cost a driver 1.59 GB (see
 * resumeMismatchReason). Discarding a partial is now always the user's call.
 *
 * Every attempt re-requests the ORIGINAL `url` (an expired presign is
 * re-issued by the origin), so `options.headers` are re-attached — and
 * re-scoped — per attempt.
 */
export async function resumableDownload(
  url: string,
  dest: string,
  onChunk?: (bytes: number, total: number) => void,
  maxRetries = 6,
  signal?: AbortSignal,
  options?: DownloadRequestOptions,
): Promise<void> {
  let attempt = 0
  for (;;) {
    if (signal?.aborted) throw new Error('Download cancelled')
    const startByte = existsSync(dest) ? statSync(dest).size : 0
    try {
      await downloadFrom(url, dest, startByte, onChunk, signal, options)
      return
    } catch (err) {
      if (signal?.aborted) throw err            // a cancel is not a transient failure to retry
      if (!isTransientNetworkError(err) || attempt >= maxRetries) throw err
      attempt++
      await new Promise(r => setTimeout(r, Math.min(10_000, 1000 * 2 ** (attempt - 1))))
    }
  }
}

/**
 * One ranged GET appending to `dest` from `startByte`. Follows redirects.
 *
 * HANDLE HYGIENE (P1, driver-reproduced): the write stream is closed on EVERY
 * exit path — response error, request error, idle timeout, abort, disk
 * preflight, short body, success. A leaked fd used to wedge an install
 * PERMANENTLY on Windows: the caller's `rmSync(tmp)` marks a still-open file
 * DELETE-PENDING, after which *every* re-open of that name returns EPERM until
 * the process exits, so retrying the install kept failing with
 * `EPERM ... open '<asset>.zip.tmp'` until the app was restarted.
 *
 * SAME-ORIGIN GUARD (`options.headers`): the header block is rebuilt on every
 * redirect hop, and the caller's custom headers are added back ONLY while the
 * hop is still on the origin of `url`. Built-in User-Agent/Accept/Range keep
 * flowing everywhere.
 */
export function downloadFrom(
  url: string,
  dest: string,
  startByte: number,
  onChunk?: (bytes: number, total: number) => void,
  signal?: AbortSignal,
  options?: DownloadRequestOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Download cancelled')); return }
    let hops = 0
    let settled = false
    /** Write stream of the CURRENT hop — never leaves this scope alive. */
    let ws: ReturnType<typeof createWriteStream> | null = null
    let req: ReturnType<typeof httpsGet> | null = null

    /** Release the fd. A torn-down stream must not emit an unhandled 'error'
     *  (that would crash main), so the reject-handler is swapped for a sink. */
    const closeStream = (): void => {
      const s = ws
      ws = null
      if (!s) return
      try { s.removeAllListeners('error'); s.on('error', () => { /* torn down */ }) } catch { /* */ }
      try { s.destroy() } catch { /* */ }
    }
    const fail = (err: unknown): void => {
      closeStream()
      if (settled) return
      settled = true
      try { req?.destroy() } catch { /* */ }
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const succeed = (): void => {
      ws = null // already closed by the finish handler
      if (settled) return
      settled = true
      resolve()
    }

    const go = (currentUrl: string): void => {
      if (++hops > 10) { fail(new Error(`Too many redirects: ${url}`)); return }
      let parsed: URL
      try { parsed = new URL(currentUrl) }
      catch { fail(new Error(`Invalid URL: ${currentUrl}`)); return }
      if (parsed.protocol !== 'https:') { fail(new Error(`Only https is allowed (got ${parsed.protocol})`)); return }

      const headers: Record<string, string> = {
        'User-Agent': 'TachiDesk/installer',
        'Accept':     '*/*',
      }
      // SAME-ORIGIN GUARD — the token never leaves the host the caller named.
      if (options?.headers && isSameDownloadOrigin(currentUrl, url)) {
        for (const [k, v] of Object.entries(options.headers)) {
          if (!k || typeof v !== 'string') continue
          if (RESERVED_REQUEST_HEADERS.has(k.toLowerCase())) continue
          headers[k] = v
        }
      }
      if (startByte > 0) headers['Range'] = `bytes=${startByte}-`

      req = httpsGet({
        host: parsed.hostname, port: parsed.port || 443,
        path: parsed.pathname + parsed.search, headers,
      }, (res) => {
        const code = res.statusCode ?? 0
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume()
          go(new URL(res.headers.location, currentUrl).toString())
          return
        }
        // Already have the whole file (range past EOF) → treat as complete.
        if (code === 416 && startByte > 0) { res.resume(); succeed(); return }
        if (code !== 200 && code !== 206) {
          res.resume()
          fail(Object.assign(new Error(`HTTP ${code} for ${currentUrl}`), { code: `HTTP_${code}` }))
          return
        }

        const resuming = startByte > 0 && code === 206
        // Total: prefer content-range "…/TOTAL"; else startByte + content-length.
        let total = 0
        const cr = res.headers['content-range']
        if (cr) { const m = /\/(\d+)\s*$/.exec(cr); if (m) total = parseInt(m[1], 10) }
        if (!total) {
          const cl = parseInt(res.headers['content-length'] ?? '0', 10) || 0
          total = (resuming ? startByte : 0) + cl
        }

        // ── "Is this actually the file?" — BEFORE a single byte is written ──
        // A gated host answers a missing/expired credential with a 200 HTML
        // page; written over a .part it becomes a 20 KB `.safetensors` that
        // fails to load hours later. `total` is already normalised to the
        // FULL-file size above, so the length test is remaining-vs-remaining
        // on a resume. Not transient: retrying cannot change the answer.
        const notAFile = notAFileReason(
          res.headers['content-type'], total, options?.expectedTotalBytes ?? 0, !resuming,
        )
        if (notAFile) {
          res.resume()
          fail(Object.assign(
            new Error(`Refusing to save this response as a file: ${notAFile} (${parsed.host}). ` +
              `Nothing was written to disk — check the link, or whether this download needs credentials.`),
            { code: 'SIZE_MISMATCH' },
          ))
          return
        }

        // ── "Does this answer CONTINUE our partial?" — also before byte 0 ──
        // Runs AFTER the not-a-file gate on purpose: when a gated host answers
        // a resume with an HTML login page, "that is an HTML page, check
        // whether this needs credentials" is the more useful of the two true
        // statements. Everything past that gate is judged on offsets alone.
        // Not transient: retrying re-asks the identical question.
        const mismatch = resumeMismatchReason(startByte, code, res.headers['content-range'])
        if (mismatch) {
          res.resume()
          fail(Object.assign(
            new Error(`Refusing to restart this download from zero: ${mismatch} (${parsed.host}). ` +
              `Nothing was written — the partial file is intact. Retry to try the server again, or ` +
              `Cancel the download to discard the partial and start over.`),
            { code: 'RANGE_IGNORED' },
          ))
          return
        }

        let received = resuming ? startByte : 0
        try { ws = createWriteStream(dest, { flags: resuming ? 'a' : 'w' }) }
        catch (err) { fail(err); return }
        const stream = ws

        // Disk preflight: now that the size is known, fail FAST if the target
        // volume can't hold the remainder — hours before ENOSPC would. Runs in
        // parallel with the first chunks (a few MB may land; harmless). The
        // error is deliberately NOT transient so the retry loop doesn't burn
        // attempts against a full disk.
        if (total > 0) {
          void freeDiskBytes(dirname(dest)).then(free => {
            const needed = requiredDiskBytes(total, received)
            if (free !== null && free < needed) {
              fail(Object.assign(new Error(diskShortfallMessage(free, needed, dirname(dest))), { code: 'DISK_FULL' }))
            }
          })
        }

        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          onChunk?.(received, total)
        })
        res.pipe(stream)
        stream.on('finish', () => stream.close(() => {
          // Truncation guard: a CDN closing the body CLEANLY before
          // content-length used to look like success and leave a corrupt
          // artifact (the category's classic "downloaded model fails to
          // load"). Classify it transient so the retry loop RESUMES from the
          // bytes on disk instead of accepting the short file.
          if (total > 0 && received < total) {
            fail(Object.assign(
              new Error(`short body: got ${received} of ${total} bytes — resuming`),
              { code: 'ERR_STREAM_PREMATURE_CLOSE' },
            ))
            return
          }
          succeed()
        }))
        stream.on('error', fail)
        res.on('error', fail)
      })
      const request = req
      if (signal) {
        if (signal.aborted) { fail(new Error('Download cancelled')); return }
        signal.addEventListener('abort', () => request.destroy(new Error('Download cancelled')), { once: true })
      }
      // Kill a stalled socket so the retry loop can resume.
      request.setTimeout(60_000, () => { request.destroy(new Error('socket idle timeout')) })
      request.on('error', fail)
      request.end()
    }
    go(url)
  })
}

// ─── Partial-file recovery ────────────────────────────────────────────────────

/** True when `p` can be opened for append RIGHT NOW (creates it if missing). */
function canOpenForAppend(p: string): boolean {
  let fd: number | undefined
  try { fd = openSync(p, 'a'); return true }
  catch { return false }
  finally { if (fd !== undefined) { try { closeSync(fd) } catch { /* */ } } }
}

/** What prepareResumablePartial had to do to make the path usable again. */
export type PartialRecovery = 'ready' | 'cleaned' | 'relocated'

/**
 * Make a partial-download path writable again BEFORE a (re)try, and say which
 * path to actually download into.
 *
 * A failed attempt used to be able to poison its own `.tmp`: on Windows a file
 * that is unlinked while a handle is still open goes DELETE-PENDING, and from
 * then on every open of that name returns EPERM — so an install that failed
 * once stayed broken until the app was restarted. The handle leak that caused
 * it is fixed in downloadFrom; this is the belt-and-braces recovery so a leak
 * anywhere (an older build, an antivirus scanner, another process) degrades to
 * "downloads into a fresh sibling" instead of "wedged until restart".
 *
 *   'ready'     — the path is usable (fresh, or a resumable partial)
 *   'cleaned'   — it was unusable, deleting it fixed that; bytes are gone
 *   'relocated' — still unusable in THIS process; use the returned sibling
 */
export function prepareResumablePartial(partPath: string): { path: string; recovery: PartialRecovery } {
  if (canOpenForAppend(partPath)) return { path: partPath, recovery: 'ready' }
  try { rmSync(partPath, { force: true }) } catch { /* */ }
  if (canOpenForAppend(partPath)) return { path: partPath, recovery: 'cleaned' }
  return { path: `${partPath}.${Date.now().toString(36)}`, recovery: 'relocated' }
}

// ─── Integrity ────────────────────────────────────────────────────────────────

/** Compute sha256 of a file on disk. Streams — never reads the full file into memory. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs   = createReadStream(path)
    rs.on('data',  (chunk: Buffer | string) => hash.update(chunk))
    rs.on('end',   () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
}

// ─── Extract (zip via PowerShell/unzip; tar.gz via tar) ───────────────────────

/** argv spawn, no shell — captures stderr for actionable errors. */
export function runAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}${stderr ? `: ${stderr.slice(-1000)}` : ''}`))
    })
    proc.on('error', reject)
  })
}

/**
 * Extract a zip into a directory. Uses the platform's bundled tool:
 *   Windows   → `powershell -NoProfile -Command "Expand-Archive ..."`
 *   elsewhere → `unzip -q -o <zip> -d <dir>`
 *
 * Throws a clear error if the tool is unavailable.
 */
export async function extractZip(zipPath: string, destDir: string): Promise<void> {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  if (process.platform === 'win32') {
    // PowerShell Expand-Archive ships with Win10/11. `-Force` overwrites.
    await runAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Expand-Archive -Force -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}'`,
    ]).catch(err => {
      throw new Error(
        `Failed to extract zip via PowerShell. Ensure Expand-Archive is available (PowerShell 5+). ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    return
  }
  await runAsync('unzip', ['-q', '-o', zipPath, '-d', destDir]).catch(err => {
    throw new Error(
      `Failed to extract zip via unzip. ${err instanceof Error ? err.message : String(err)}`,
    )
  })
}

/**
 * Extract any supported archive, dispatching by file extension:
 *   *.tar.gz / *.tgz → `tar -xzf` (bsdtar ships on macOS and Windows 10+)
 *   everything else  → extractZip (PowerShell on win, unzip elsewhere)
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await runAsync('tar', ['-xzf', archivePath, '-C', destDir]).catch(err => {
      throw new Error(
        `Failed to extract tar.gz via tar. Ensure tar is on PATH (default on macOS and Windows 10+). ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    return
  }
  return extractZip(archivePath, destDir)
}
