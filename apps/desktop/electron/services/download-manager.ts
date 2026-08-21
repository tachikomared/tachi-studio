// apps/desktop/electron/services/download-manager.ts
//
// RESUMABLE DOWNLOAD MANAGER (UX-benchmark #11) — one central registry for
// large model-file downloads (GGUF weights), giving every download:
//
//   • HTTP Range resume  — a dropped connection or app restart continues from
//     the bytes already on disk (.part file); server ignoring Range (200)
//     falls back to a clean restart. Implemented by installer-kit's
//     resumableDownload, with 3 retry attempts + exponential backoff.
//   • Pause / resume / cancel — surfaced to the renderer via downloads:* IPC
//     and the persistent DownloadStrip in the bottom console dock.
//   • Disk preflight — refuses to start when the target volume can't hold the
//     remainder (+500 MB OS margin). installer-kit re-checks mid-flight once
//     response headers reveal the true size.
//   • Integrity — sha256 verified when an expected hash exists (curated
//     registry pin, caller-supplied, or HuggingFace LFS oid resolved from the
//     paths-info API); otherwise final size vs headers. `verified` reports
//     what was ACTUALLY checked — never claims sha-verification without one.
//   • Persistence — queue + spec in userData/downloads.json. After a restart
//     tasks come back PAUSED and resume on the user's click (the safe
//     default), never auto-network on boot.
//
// Consumers: llama-cpp-installer (curated-registry + by-URL GGUF weights),
// sd-cpp-installer (checkpoint component files), piper-installer (ONNX
// voices), and whisper-installer (ggml models) all route their MODEL-FILE
// downloads through runManagedDownload(); the strip drives the rest. Small
// binaries/zips (≤~50 MB release archives) stay on the legacy direct path by
// design, and each installer keeps that legacy path as a fallback when the
// manager fails unexpectedly (util/download-queue.shouldFallBackToLegacyDownload).
// kokoro-tts is NOT routed: transformers.js from_pretrained owns its own
// fetch/cache pipeline — see the deferred note in kokoro-tts.ts.

import { app, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  resumableDownload,
  sha256File,
  freeDiskBytes,
  requiredDiskBytes,
  diskShortfallMessage,
} from './util/installer-kit'
import { DownloadProgressTracker } from './util/download-progress'
// Storage-root drift on resume (see realignSpecWithStorageRoot). One-way edge:
// model-storage.ts does not import this module.
import { modelsRoot, previousModelRoots } from './model-storage'
import { partPathFor } from './util/model-storage'
import { getStorageRoot } from './storage-root'
import {
  serializeDownloads,
  parsePersistedDownloads,
  parseHfResolveUrl,
  percentOf,
  isSha256Hex,
  type DownloadItemSnapshot,
  type DownloadItemState,
  type DownloadErrorCode,
  type DownloadKind,
  type DownloadVerification,
} from './util/download-queue'

export type { DownloadItemSnapshot } from './util/download-queue'

// ─── Spec + live task ─────────────────────────────────────────────────────────

export interface ManagedDownloadSpec {
  /** Stable id — reuse the model/catalog ref so legacy cancel maps 1:1. */
  id: string
  /** Human label for the strip. */
  name: string
  kind: DownloadKind
  url: string
  /** Final landing path (rename target after verification). */
  destPath: string
  /**
   * Partial-download path — kept across failures for resume.
   *
   * MUST be in the SAME DIRECTORY as `destPath`: the landing step is a
   * `renameSync(partPath, destPath)`, and rename cannot cross devices (EXDEV).
   * Model callers derive it with `partPathFor(destPath)` (util/model-storage),
   * which also makes the disk preflight below — keyed on `dirname(partPath)` —
   * measure the drive the file will actually occupy.
   */
  partPath: string
  /** Pinned/known sha256 — mismatch marks the file bad and discards it. */
  expectedSha256?: string
  /** EXACT expected byte size (e.g. HF LFS) — used for verification + preflight. */
  expectedBytes?: number
  /** APPROXIMATE size (registry sizeMb) — preflight + display only, never verification. */
  approxTotalBytes?: number
  /**
   * Extra request headers for a GATED weights host — e.g.
   * `{ Authorization: 'Bearer <key>' }` for Civitai.
   *
   * TWO hard rules, both enforced rather than documented:
   *  • SCOPED TO THE ORIGIN of `url`. installer-kit drops them on every
   *    cross-origin redirect hop: a Civitai download 307s to a presigned
   *    R2/B2 URL that signs `host` ONLY, so forwarding Authorization there is
   *    both a 400 InvalidRequest and a key leak to a third-party host.
   *  • NEVER PERSISTED. `downloads.json` is PLAINTEXT under userData while the
   *    key's home is the DPAPI-encrypted keychain. Two explicit whitelists
   *    stand between this field and that file — persistState() below names the
   *    fields it maps, and download-queue's serializeDownloads() rebuilds the
   *    row field-by-field — so nothing rides along on a spread. (Neither is a
   *    TYPE error: a `.map()` result is not excess-property-checked, so tsc
   *    will not catch a re-added field. The pin is the runtime assertion in
   *    downloadManagerState.test.ts that reads the written JSON.)
   *    The consequence is deliberate: a task restored after an app restart
   *    carries NO credential, and the CALLER re-attaches it by passing a fresh
   *    spec to runManagedDownload. (Within one session pause→resume keeps
   *    working — the live task still holds this spec object.)
   *
   * Never put a credential in the URL instead: query strings are logged by
   * every proxy AND they would land in downloads.json.
   */
  headers?: Record<string, string>
}

interface ManagedTask {
  spec: ManagedDownloadSpec
  state: DownloadItemState
  receivedBytes: number
  /** Full-file total from response headers (content-range / start+content-length). */
  headerTotalBytes: number
  speedBytesPerSec: number
  etaSec: number
  error?: string
  errorCode?: DownloadErrorCode
  verified?: DownloadVerification
  observedSha256?: string
  createdAt: number
  updatedAt: number
  abort?: AbortController
  /** Set by pause()/cancel() before aborting so the catch block can tell them apart. */
  intent?: 'pause' | 'cancel'
  /**
   * True while an installer's LEGACY direct-download fallback owns this
   * transfer (see adoptExternalProgress). The manager holds no abort handle
   * then, so pause/resume correctly refuse — but the row must still tell the
   * truth about bytes and state.
   */
  external?: boolean
  promise?: Promise<DownloadItemSnapshot>
  /** Per-run legacy event hook (installer pushes llama-cpp:install-progress). Cleared when a run settles. */
  onEvent?: (snap: DownloadItemSnapshot) => void
  doneTimer?: NodeJS.Timeout
}

const tasks = new Map<string, ManagedTask>()

/** How long a finished row stays on the strip before auto-clearing. */
const DONE_LINGER_MS = 6_000
/** Progress broadcast throttle (renderer repaint budget). */
const BROADCAST_MIN_INTERVAL_MS = 250
/** Progress persistence throttle (tiny file, but no need to hammer the disk). */
const PERSIST_MIN_INTERVAL_MS = 5_000

// ─── Snapshots + broadcast ────────────────────────────────────────────────────

function bestTotal(t: ManagedTask): number {
  return t.headerTotalBytes || t.spec.expectedBytes || t.spec.approxTotalBytes || 0
}

function snapshot(t: ManagedTask): DownloadItemSnapshot {
  const totalBytes = bestTotal(t)
  return {
    id: t.spec.id,
    name: t.spec.name,
    kind: t.spec.kind,
    state: t.state,
    receivedBytes: t.receivedBytes,
    totalBytes,
    percent: t.state === 'done' ? 100 : percentOf(t.receivedBytes, totalBytes),
    speedBytesPerSec: t.speedBytesPerSec,
    etaSec: t.etaSec,
    error: t.error,
    errorCode: t.errorCode,
    verified: t.verified,
    observedSha256: t.observedSha256,
    updatedAt: t.updatedAt,
  }
}

/**
 * Every absolute path this manager currently owns — the final file AND the
 * `.part` beside it — for anything that must not delete a file a download will
 * still write to, or resume into.
 *
 * Tasks survive a restart as PAUSED (see the header), so this deliberately
 * covers every state rather than only the running ones: a paused task's `.part`
 * is the opposite of abandoned, and deleting it would silently throw away the
 * bytes the user's next Resume click is counting on.
 */
export function claimedDownloadPaths(): string[] {
  const out: string[] = []
  for (const t of tasks.values()) {
    if (t.spec.destPath) out.push(t.spec.destPath)
    if (t.spec.partPath) out.push(t.spec.partPath)
  }
  return out
}

/** All tasks, oldest first — the wire shape for downloads:list / :changed. */
export function listDownloads(): DownloadItemSnapshot[] {
  return [...tasks.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(snapshot)
}

let lastBroadcastAt = 0
function broadcastNow(): void {
  lastBroadcastAt = Date.now()
  const list = listDownloads()
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) {
        w.webContents.send('downloads:changed', list)
      }
    } catch { /* window mid-teardown */ }
  }
}
function broadcastThrottled(): void {
  if (Date.now() - lastBroadcastAt >= BROADCAST_MIN_INTERVAL_MS) broadcastNow()
}

function emit(t: ManagedTask): void {
  try { t.onEvent?.(snapshot(t)) } catch { /* consumer bug must not kill the download */ }
}

function touch(t: ManagedTask): void {
  t.updatedAt = Date.now()
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function persistPath(): string {
  return join(app.getPath('userData'), 'downloads.json')
}

let lastPersistAt = 0
function persistState(): void {
  lastPersistAt = Date.now()
  try {
    // NOTE: `spec.headers` is deliberately ABSENT from this mapping — it can
    // hold a Bearer token and this file is plaintext. Name fields explicitly
    // here; never spread `t.spec`.
    const file = serializeDownloads([...tasks.values()].map(t => ({
      id: t.spec.id,
      name: t.spec.name,
      kind: t.spec.kind,
      url: t.spec.url,
      destPath: t.spec.destPath,
      partPath: t.spec.partPath,
      expectedSha256: t.spec.expectedSha256,
      expectedBytes: t.spec.expectedBytes,
      approxTotalBytes: t.spec.approxTotalBytes,
      headerTotalBytes: t.headerTotalBytes || undefined,
      state: t.state,
      error: t.error,
      errorCode: t.errorCode,
    })))
    writeFileSync(persistPath(), JSON.stringify(file, null, 2), 'utf-8')
  } catch { /* best-effort — persistence must never break a download */ }
}
function persistThrottled(): void {
  if (Date.now() - lastPersistAt >= PERSIST_MIN_INTERVAL_MS) persistState()
}

/**
 * Load the persisted queue on app start. Every restored task lands PAUSED
 * (or its stored error) — resuming is a user click on the strip, never an
 * automatic network hit at boot. Call once from main after `app` is ready.
 */
export function initDownloadManager(): void {
  try {
    const raw = readFileSync(persistPath(), 'utf-8')
    for (const e of parsePersistedDownloads(raw)) {
      if (tasks.has(e.id)) continue
      if (existsSync(e.destPath)) continue // finished while we weren't looking
      let onDisk = 0
      try { onDisk = existsSync(e.partPath) ? statSync(e.partPath).size : 0 } catch { onDisk = 0 }
      const now = Date.now()
      tasks.set(e.id, {
        spec: {
          id: e.id,
          name: e.name,
          kind: e.kind,
          url: e.url,
          destPath: e.destPath,
          partPath: e.partPath,
          expectedSha256: e.expectedSha256,
          expectedBytes: e.expectedBytes,
          approxTotalBytes: e.approxTotalBytes,
        },
        state: e.state,
        receivedBytes: onDisk,
        headerTotalBytes: e.headerTotalBytes ?? 0,
        speedBytesPerSec: 0,
        etaSec: -1,
        error: e.error,
        errorCode: e.errorCode,
        createdAt: now,
        updatedAt: now,
      })
    }
  } catch { /* no file yet / corrupt → start clean */ }
}

// ─── Credential re-attach after a restart ────────────────────────────────────
//
// `spec.headers` is deliberately NEVER persisted (see ManagedDownloadSpec), so
// a task rehydrated by initDownloadManager carries no credential. The install
// FLOW re-attaches one (civitai:install probes and passes it to
// downloadSdModel), but the DOWNLOADS STRIP's RESUME button hands the manager
// the bare restored spec — and a gated host answers a credential-less request
// differently: 401, an HTML login page, or (driver-reproduced) a plain 200
// with the whole file, which used to TRUNCATE the multi-GB partial.
//
// So the manager re-attaches it itself, per run, from the keychain — the same
// place civitaiAuthHeaders() reads. Nothing is stored: the header is built for
// one attempt and never written back onto the spec, so persistState() and its
// leak-gate test are untouched.

/** Download hosts whose files can be gated behind a stored API key → key id. */
const GATED_DOWNLOAD_HOSTS: Readonly<Record<string, string>> = {
  'civitai.com': 'civitai',
  'www.civitai.com': 'civitai',
  // HuggingFace, added 2026-07-31. `huggingface.co/<repo>/resolve/<rev>/<file>`
  // is the FIRST hop and the only one that may carry the token: it 302s to a
  // CloudFront-presigned CDN host (measured: `us.aws.cdn.hf.co`, with
  // Policy/Signature/Key-Pair-Id in the query), where the URL itself is the
  // credential. `hf.co` is HF's own short domain for the same origin; the CDN
  // hosts are deliberately ABSENT, and the exact-match rule below is what keeps
  // `cdn-lfs.hf.co` / `cas-bridge.xethub.hf.co` out of this table by
  // construction rather than by remembering to exclude them.
  //
  // This is what makes a GATED repo downloadable: the user accepted the terms
  // on huggingface.co, and this hands their own acceptance to the first hop.
  'huggingface.co': 'huggingface',
  'www.huggingface.co': 'huggingface',
  'hf.co': 'huggingface',
}

/**
 * The keychain id whose credential belongs on `url`, or null.
 *
 * EXACT HOST MATCH, never a suffix test: `civitai.com.evil.test` and the
 * presigned `*.r2.cloudflarestorage.com` CDN must both miss. (installer-kit's
 * same-origin guard is the second line — it drops the header on every
 * cross-origin hop regardless of what this returns.)
 */
export function credentialKeyIdForDownloadUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return null
    return GATED_DOWNLOAD_HOSTS[u.hostname.toLowerCase()] ?? null
  } catch {
    return null
  }
}

/** Bearer header for a gated host, or undefined. Never throws, never logs. */
async function resumeCredentialHeaders(url: string): Promise<Record<string, string> | undefined> {
  const keyId = credentialKeyIdForDownloadUrl(url)
  if (!keyId) return undefined
  try {
    // Dynamic: keychain reads userData at module scope, and this must not join
    // the boot import graph (test/unit/startupDeferredImports.test.ts).
    const { retrieveKey } = await import('./keychain')
    const key = retrieveKey(keyId)
    return key ? { Authorization: `Bearer ${key}` } : undefined
  } catch {
    return undefined   // keychain unavailable ⇒ anonymous, not broken
  }
}

// ─── HuggingFace LFS integrity lookup ────────────────────────────────────────

/**
 * Best-effort: resolve the expected sha256 (LFS oid) + exact byte size for a
 * HF resolve-URL via the public paths-info API. Null on any failure — the
 * download then degrades to size-only verification, honestly reported.
 */
export async function resolveHfExpected(url: string): Promise<{ sha256?: string; sizeBytes?: number } | null> {
  const ref = parseHfResolveUrl(url)
  if (!ref) return null
  try {
    const res = await fetch(
      `https://huggingface.co/api/models/${ref.repoId}/paths-info/${encodeURIComponent(ref.revision)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [ref.path] }),
        signal: AbortSignal.timeout(8_000),
      },
    )
    if (!res.ok) return null
    const arr = await res.json() as Array<{ path?: string; size?: number; lfs?: { oid?: string; size?: number } }>
    if (!Array.isArray(arr)) return null
    const f = arr.find(e => e?.path === ref.path)
    if (!f) return null
    const sha256 = isSha256Hex(f.lfs?.oid) ? f.lfs!.oid!.toLowerCase() : undefined
    const rawSize = f.lfs?.size ?? f.size
    const sizeBytes = typeof rawSize === 'number' && rawSize > 0 ? rawSize : undefined
    return sha256 || sizeBytes ? { sha256, sizeBytes } : null
  } catch {
    return null
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start (or join) a managed download. Resolves with the final snapshot when
 * the file is verified and landed at destPath; rejects with a coded Error on
 * pause ('PAUSED'), cancel ('CANCELLED'), or failure. If a paused/errored
 * task with the same id exists, this RESUMES it (fresh spec wins).
 */
export function runManagedDownload(
  spec: ManagedDownloadSpec,
  onEvent?: (snap: DownloadItemSnapshot) => void,
): Promise<DownloadItemSnapshot> {
  const existing = tasks.get(spec.id)
  if (existing && (existing.state === 'active' || existing.state === 'verifying' || existing.state === 'queued') && existing.promise) {
    // Already in flight — join it (double-click / second surface).
    if (onEvent) existing.onEvent = onEvent
    return existing.promise
  }
  let t = existing
  if (t) {
    if (t.doneTimer) { clearTimeout(t.doneTimer); t.doneTimer = undefined }
    t.spec = spec // fresh URL/sha wins over a stale persisted spec
  } else {
    const now = Date.now()
    t = {
      spec,
      state: 'queued',
      receivedBytes: 0,
      headerTotalBytes: 0,
      speedBytesPerSec: 0,
      etaSec: -1,
      createdAt: now,
      updatedAt: now,
    }
    tasks.set(spec.id, t)
  }
  t.onEvent = onEvent
  t.promise = execute(t)
  return t.promise
}

/** Pause an ACTIVE download — keeps the .part bytes, persists, strip shows RESUME. */
export function pauseManagedDownload(id: string): boolean {
  const t = tasks.get(id)
  if (!t || t.state !== 'active' || !t.abort) return false
  t.intent = 'pause'
  t.abort.abort()
  return true
}

// ─── Storage-root drift ───────────────────────────────────────────────────────
//
// A weight is located by CONVENTION — `<storageRoot>/Models/<engine>/…` — not by
// an absolute path anything records (model-storage.ts says so at length). But
// `destPath` IS persisted absolute, so a download paused before the user moved
// their model folder resumed into the root they moved AWAY from: the bytes land
// where no resolver looks, and the model reads "not installed" while occupying
// the old disk.
//
// RESUME time, not rehydrate time, is the moment to re-resolve: the root can be
// changed while a download sits paused mid-session, not only across a restart.
//
// The partial must come with it — `partPath` MUST stay beside `destPath` because
// landing is a `renameSync` and rename cannot cross devices. So: rename when the
// volumes allow it, VERIFY the result the way model-storage's `destSatisfies`
// does (a real file of the exact same size — bare `existsSync` is precisely what
// once let a directory or a truncated stub pass for the real thing), and REFUSE
// with an honest message naming both paths when it cannot be moved. Silently
// re-downloading multi-GB, or landing in the abandoned root, are the two answers
// this is here to avoid.

interface RootRebase {
  destPath: string
  partPath: string
  fromRoot: string
  toRoot:   string
}

const normSlashes = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Path tail of `abs` relative to `<root>/Models`, or null when not under it. */
function tailUnderModelsRoot(abs: string, root: string): string | null {
  const base = normSlashes(join(root, 'Models'))
  const a    = normSlashes(abs)
  // Windows paths are case-insensitive; a root typed with a different case is
  // the same root and must still match.
  const ci = process.platform === 'win32'
  if (!(ci ? a.toLowerCase() : a).startsWith(`${ci ? base.toLowerCase() : base}/`)) return null
  return a.slice(base.length + 1)
}

/**
 * Where this spec's files belong under the CURRENT storage root, or null when
 * it is not under a previously-used root (the overwhelmingly common case).
 */
function rebaseOntoCurrentRoot(spec: ManagedDownloadSpec): RootRebase | null {
  const previous = previousModelRoots()
  if (previous.length === 0) return null
  for (const from of previous) {
    const tail = tailUnderModelsRoot(spec.destPath, from)
    if (tail === null) continue
    const destPath = join(modelsRoot(), ...tail.split('/'))
    if (normSlashes(destPath) === normSlashes(spec.destPath)) return null
    return { destPath, partPath: partPathFor(destPath), fromRoot: from, toRoot: getStorageRoot() }
  }
  return null
}

/** destSatisfies() in one line: a REAL file of exactly this many bytes. */
function isFileOfSize(path: string, bytes: number): boolean {
  try {
    const s = statSync(path)
    return s.isFile() && s.size === bytes
  } catch { return false }
}

/**
 * Point a rehydrated spec at the current storage root, carrying its partial
 * across. 'ok' = safe to run (rebased, or nothing to rebase); 'blocked' = the
 * task now holds an honest STORAGE_MOVED error and must not run.
 */
function realignSpecWithStorageRoot(t: ManagedTask): 'ok' | 'blocked' {
  let rebase: RootRebase | null
  // A settings/root read that throws must never be the reason a resume fails;
  // the pre-existing behaviour (resume where the spec points) is the fallback.
  try { rebase = rebaseOntoCurrentRoot(t.spec) } catch { return 'ok' }
  if (!rebase) return 'ok'

  let partBytes: number
  try { partBytes = statSync(t.spec.partPath).size } catch { partBytes = 0 }

  if (partBytes > 0) {
    try {
      mkdirSync(dirname(rebase.partPath), { recursive: true })
      renameSync(t.spec.partPath, rebase.partPath)
    } catch (err) {
      // EXDEV (different volume) is the expected failure — moving weights to
      // another drive is the whole point of the feature that stranded us here.
      t.state     = 'error'
      t.errorCode = 'STORAGE_MOVED'
      t.error =
        `Your model folder moved to ${rebase.toRoot} while this download was paused, and its partial file `
        + `could not be moved there (${err instanceof Error ? err.message : String(err)}). `
        + `The ${Math.round(partBytes / 1e6)} MB already downloaded are intact at ${t.spec.partPath} — `
        + `move that file to ${rebase.partPath} and resume, or cancel to start again in the new location.`
      touch(t); emit(t); persistState(); broadcastNow()
      return 'blocked'
    }
    // Rename reported success; that is not the same as the bytes being there.
    if (!isFileOfSize(rebase.partPath, partBytes)) {
      t.state     = 'error'
      t.errorCode = 'STORAGE_MOVED'
      t.error =
        `Moving this download's partial file to ${rebase.partPath} did not produce a complete ${partBytes}-byte `
        + `file, so resuming would have appended to the wrong thing. Cancel and restart the download.`
      touch(t); emit(t); persistState(); broadcastNow()
      return 'blocked'
    }
  }

  t.spec = { ...t.spec, destPath: rebase.destPath, partPath: rebase.partPath }
  t.receivedBytes = partBytes
  persistState()
  return 'ok'
}

/** Resume a paused/errored task from the bytes on disk (strip's RESUME/RETRY). */
export function resumeManagedDownload(id: string): boolean {
  const t = tasks.get(id)
  if (!t || (t.state !== 'paused' && t.state !== 'error')) return false
  // The storage root may have moved under this task while it sat paused.
  if (realignSpecWithStorageRoot(t) === 'blocked') return false
  // Strip-initiated: no legacy install-progress consumer; swallow the coded
  // rejection so an unhandled-rejection doesn't fire when the user re-pauses.
  runManagedDownload(t.spec).catch(() => { /* state carried on the task itself */ })
  return true
}

/** Cancel: abort if in flight, delete the partial file, drop the task. */
export function cancelManagedDownload(id: string): boolean {
  const t = tasks.get(id)
  if (!t) return false
  if (t.state === 'active' && t.abort) {
    t.intent = 'cancel'
    t.abort.abort()
    return true
  }
  if (t.state === 'verifying') return false // let verification finish
  try { rmSync(t.spec.partPath, { force: true }) } catch { /* ignore */ }
  if (t.doneTimer) clearTimeout(t.doneTimer)
  tasks.delete(id)
  persistState()
  broadcastNow()
  return true
}

// ─── External (legacy-fallback) takeover ──────────────────────────────────────
//
// When runManagedDownload rejects with an UNCODED error the installers fall
// back to their proven direct `resumableDownload` path — writing to the SAME
// .part file this task owns. The manager had no idea, so the queue row stayed
// frozen at state:'error' with the byte count from the moment of failure while
// the .part kept growing for minutes (driver-reproduced: entry stuck at
// 1348645739 bytes / 'error' while the file reached 1963 MB). Everything that
// reads this store — the DownloadStrip, the OPUS chrome IO lamp — was
// therefore lying about a live transfer.
//
// The contract is simply: BYTES ADVANCING ⇒ state 'active'.

/**
 * An installer's legacy fallback is now driving this id's transfer. Flips the
 * row back to 'active', clears the stale error, and tracks the real byte
 * count. No-op for a task the manager itself is running (never stomp an
 * in-flight run) or one that already finished.
 */
export function adoptExternalProgress(id: string, receivedBytes: number, totalBytes?: number): boolean {
  const t = tasks.get(id)
  if (!t) return false
  if (t.state === 'done' || t.state === 'verifying') return false
  if (t.abort) return false // the manager owns this run
  t.external = true
  t.state = 'active'
  t.error = undefined
  t.errorCode = undefined
  if (Number.isFinite(receivedBytes) && receivedBytes >= 0) t.receivedBytes = receivedBytes
  if (totalBytes && totalBytes > 0) t.headerTotalBytes = Math.max(t.headerTotalBytes, totalBytes)
  touch(t)
  emit(t)
  broadcastThrottled()
  persistThrottled()
  return true
}

/**
 * The legacy fallback settled. Success drops the row (the file landed — there
 * is nothing left to show); failure records a HONEST error with the bytes
 * actually on disk, so the next resume starts from the right offset.
 */
export function settleExternalDownload(id: string, error?: unknown): boolean {
  const t = tasks.get(id)
  if (!t || !t.external) return false
  t.external = false
  t.speedBytesPerSec = 0
  t.etaSec = -1
  if (error === undefined) {
    if (t.doneTimer) clearTimeout(t.doneTimer)
    tasks.delete(id)
  } else {
    t.state = 'error'
    t.error = error instanceof Error ? error.message : String(error)
    t.errorCode = 'NETWORK'
    try { if (existsSync(t.spec.partPath)) t.receivedBytes = statSync(t.spec.partPath).size } catch { /* keep last */ }
    touch(t)
    emit(t)
  }
  persistState()
  broadcastNow()
  return true
}

/** Dismiss a settled row (done/error) from the strip. Keeps any .part file. */
export function dismissManagedDownload(id: string): boolean {
  const t = tasks.get(id)
  if (!t || (t.state !== 'done' && t.state !== 'error')) return false
  if (t.doneTimer) clearTimeout(t.doneTimer)
  tasks.delete(id)
  persistState()
  broadcastNow()
  return true
}

// ─── The run loop ─────────────────────────────────────────────────────────────

async function execute(t: ManagedTask): Promise<DownloadItemSnapshot> {
  const { spec } = t
  const controller = new AbortController()
  t.abort = controller
  t.intent = undefined
  t.external = false // the manager is taking the transfer back
  t.state = 'active'
  t.error = undefined
  t.errorCode = undefined
  t.verified = undefined
  t.observedSha256 = undefined
  touch(t)
  persistState()
  broadcastNow()
  emit(t)

  try {
    mkdirSync(dirname(spec.partPath), { recursive: true })
    mkdirSync(dirname(spec.destPath), { recursive: true })

    let startBytes = 0
    try { startBytes = existsSync(spec.partPath) ? statSync(spec.partPath).size : 0 } catch { startBytes = 0 }
    t.receivedBytes = startBytes

    // ── Disk preflight (before any network) ──
    const planned = spec.expectedBytes ?? spec.approxTotalBytes ?? 0
    if (planned > 0) {
      const free = await freeDiskBytes(dirname(spec.partPath))
      const needed = requiredDiskBytes(planned, startBytes)
      if (free !== null && free < needed) {
        throw Object.assign(
          new Error(diskShortfallMessage(free, needed, dirname(spec.partPath))),
          { code: 'DISK_FULL' },
        )
      }
    }

    // A restart-rehydrated spec has no credential (headers are never
    // persisted) — re-attach the gated host's key for THIS run only, so a
    // strip RESUME sends the same request the in-session one did.
    const runHeaders = spec.headers ?? await resumeCredentialHeaders(spec.url)

    // ── Ranged, retrying download (3 attempts, exponential backoff) ──
    const tracker = new DownloadProgressTracker([{ id: 'f', totalBytes: planned }])
    await resumableDownload(spec.url, spec.partPath, (bytes, total) => {
      tracker.tick('f', bytes, total)
      const s = tracker.snapshot()
      t.receivedBytes = bytes
      // Trust the header total unless it's the degenerate "resume with no
      // content-length" case, where installer-kit reports total === startByte.
      if (total > 0 && total !== startBytes) t.headerTotalBytes = Math.max(t.headerTotalBytes, total)
      t.speedBytesPerSec = s.speedBytesPerSec
      t.etaSec = s.etaSec
      touch(t)
      emit(t)
      broadcastThrottled()
      persistThrottled()
    }, 3, controller.signal, {
      // Origin-scoped credentials (dropped on cross-origin redirects) + the
      // size the response has to be in the same ballpark of, or the body is
      // refused BEFORE it can overwrite the .part (an HTML error page named
      // .safetensors). Exact size wins over the registry estimate.
      headers: runHeaders,
      expectedTotalBytes: spec.expectedBytes ?? spec.approxTotalBytes,
    })

    // ── Integrity ──
    t.state = 'verifying'
    t.speedBytesPerSec = 0
    t.etaSec = -1
    touch(t)
    broadcastNow()
    emit(t)

    const finalSize = statSync(spec.partPath).size
    t.receivedBytes = finalSize
    const observed = await sha256File(spec.partPath)
    t.observedSha256 = observed

    if (spec.expectedSha256) {
      if (observed.toLowerCase() !== spec.expectedSha256.toLowerCase()) {
        // The file is BAD — discard it so a retry re-downloads from scratch.
        try { rmSync(spec.partPath, { force: true }) } catch { /* ignore */ }
        t.receivedBytes = 0
        throw Object.assign(
          new Error(`SHA-256 mismatch for ${spec.name}: expected ${spec.expectedSha256}, got ${observed}. The file was discarded — retry to re-download.`),
          { code: 'CHECKSUM_MISMATCH' },
        )
      }
      t.verified = 'sha256'
    } else {
      // No checksum available → the only real check we can do is size.
      const exact = spec.expectedBytes ?? 0
      const header = t.headerTotalBytes
      if (exact > 0 && finalSize !== exact) {
        if (finalSize > exact) { try { rmSync(spec.partPath, { force: true }) } catch { /* ignore */ } ; t.receivedBytes = 0 }
        throw Object.assign(
          new Error(`Size mismatch for ${spec.name}: expected ${exact} bytes, got ${finalSize}.${finalSize < exact ? ' Resume to fetch the remainder.' : ' The file was discarded — retry to re-download.'}`),
          { code: 'SIZE_MISMATCH' },
        )
      }
      if (exact === 0 && header > 0 && finalSize < header) {
        throw Object.assign(
          new Error(`Size mismatch for ${spec.name}: expected ${header} bytes, got ${finalSize}. Resume to fetch the remainder.`),
          { code: 'SIZE_MISMATCH' },
        )
      }
      t.verified = exact > 0 || (header > 0 && finalSize === header) ? 'size' : 'none'
    }

    // ── Land ──
    if (existsSync(spec.destPath)) { try { rmSync(spec.destPath, { force: true }) } catch { /* ignore */ } }
    renameSync(spec.partPath, spec.destPath)

    t.state = 'done'
    touch(t)
    persistState()
    broadcastNow()
    emit(t)

    // Auto-clear the finished row after a short linger.
    t.doneTimer = setTimeout(() => {
      const cur = tasks.get(spec.id)
      if (cur && cur.state === 'done') {
        tasks.delete(spec.id)
        broadcastNow()
      }
    }, DONE_LINGER_MS)

    return snapshot(t)
  } catch (err) {
    const e = err as { code?: string; message?: string }

    if (t.intent === 'cancel') {
      try { rmSync(spec.partPath, { force: true }) } catch { /* ignore */ }
      if (t.doneTimer) clearTimeout(t.doneTimer)
      tasks.delete(spec.id)
      persistState()
      broadcastNow()
      throw Object.assign(new Error('Download cancelled'), { code: 'CANCELLED' })
    }

    if (t.intent === 'pause') {
      t.state = 'paused'
      t.speedBytesPerSec = 0
      t.etaSec = -1
      try { t.receivedBytes = existsSync(spec.partPath) ? statSync(spec.partPath).size : 0 } catch { /* keep last */ }
      touch(t)
      persistState()
      broadcastNow()
      emit(t)
      throw Object.assign(new Error('Download paused — resume from the DOWNLOADS strip in the bottom bar.'), { code: 'PAUSED' })
    }

    t.state = 'error'
    t.speedBytesPerSec = 0
    t.etaSec = -1
    // Report the bytes that are ACTUALLY on disk, not the last in-flight
    // counter — an errored row is what the resume offset is judged from.
    try { if (existsSync(spec.partPath)) t.receivedBytes = statSync(spec.partPath).size } catch { /* keep last */ }
    t.errorCode =
      e?.code === 'DISK_FULL' ? 'DISK_FULL'
      : e?.code === 'CHECKSUM_MISMATCH' ? 'CHECKSUM_MISMATCH'
      : e?.code === 'SIZE_MISMATCH' ? 'SIZE_MISMATCH'
      : e?.code === 'RANGE_IGNORED' ? 'RANGE_IGNORED'
      : 'NETWORK'
    t.error = e?.message ?? String(err)
    touch(t)
    persistState()
    broadcastNow()
    emit(t)
    throw err
  } finally {
    t.abort = undefined
    t.intent = undefined
    t.onEvent = undefined
    t.promise = undefined
  }
}
