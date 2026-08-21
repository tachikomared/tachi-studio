// apps/desktop/electron/services/storage-root.ts
//
// USER-VISIBLE storage root for everything the app SAVES FOR THE USER:
// generated media, reference images, design projects, renders, voiceover
// audio, saved flows. Normal people should find their files in a normal
// folder (default: Documents\Tachi Studio) — not buried in %APPDATA%.
//
// App INTERNALS (keys, settings, logs, caches, sidecar binaries, model
// weights, RAG indexes) deliberately STAY in app.getPath('userData') — users
// never need to see those, and moving them risks breaking running services.
//
// Back-compat contract: files saved under the LEGACY userData locations keep
// working forever (media-protocol serves both roots; readers check both).
// Only NEW writes land in the storage root.
//
// HARD-LEARNED (2026-07-17 boot-freeze): node's mkdirSync({recursive:true})
// can SPIN FOREVER at 100% CPU on Windows when the target sits inside a
// Defender Controlled-Folder-Access-protected folder (Documents on some
// machines) — the EPERM mid-walk sends the recursive walker into a loop and
// the main process dies at boot. So this module (a) never calls recursive
// mkdir — it walks segments itself, finitely; (b) PROBES each candidate root
// for real writability once per session; (c) falls back Documents →
// %USERPROFILE%\Tachi Studio → <userData>\Tachi Studio, all still reachable
// through the Settings card's OPEN FOLDER button.

import { app } from 'electron'
import { join, isAbsolute, dirname, basename } from 'path'
import { mkdirSync, existsSync, statSync, writeFileSync, rmSync, copyFileSync, createWriteStream } from 'fs'
import type { WriteStream } from 'fs'
import { loadSettings } from './settings-store'
import { portableStorageRoot } from './portable-mode'

/** Human-named subfolders of the storage root (visible in Explorer/Finder). */
export type StorageKind = 'media' | 'designs' | 'renders' | 'audio' | 'flows' | 'assets'

const SUBDIR: Record<StorageKind, string> = {
  media:   'Media',
  designs: 'Designs',
  renders: 'Design Renders',
  audio:   'Audio',
  flows:   'Flows',
  assets:  'Design Assets',
}

/**
 * Default root when the user hasn't picked one: Documents\Tachi Studio — unless
 * this is a PORTABLE install, in which case it is inside the app's own folder.
 *
 * Portable mode exists to touch nothing outside that folder, and user content is
 * the larger half of what gets written; leaving it in Documents would defeat the
 * whole point while looking like it worked. See services/portable-mode.ts.
 */
export function defaultStorageRoot(): string {
  const portable = portableStorageRoot()
  if (portable) return portable
  return join(app.getPath('documents'), 'Tachi Studio')
}

/**
 * FINITE directory creation — segment-by-segment, non-recursive mkdir, so a
 * protected folder yields `false` instead of node's recursive-mkdir spin.
 */
function ensureDirFinite(dir: string): boolean {
  try {
    if (existsSync(dir)) return statSync(dir).isDirectory()
  } catch { return false }
  const parts = dir.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return false
  let cur = /^[A-Za-z]:$/.test(parts[0]) ? parts[0] + '\\' : (dir.startsWith('/') ? '/' + parts[0] : parts[0])
  for (let i = 1; i < parts.length; i++) {
    cur = join(cur, parts[i])
    try {
      if (!existsSync(cur)) mkdirSync(cur) // NON-recursive on purpose
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false
    }
  }
  try { return statSync(dir).isDirectory() } catch { return false }
}

/** True when we can actually create a file inside `dir` (CFA silently blocks
 *  unauthorized apps — existsSync alone lies). */
function isWritable(dir: string): boolean {
  const probe = join(dir, `.tachi-write-probe-${process.pid}`)
  try {
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

// Resolved once per session (invalidated when the user changes the setting) —
// getStorageRoot is called on hot paths (every tachi-media:// request).
let cachedRoot: string | null = null

/** Call after settings.storageRoot changes (storage:choose / storage:reset). */
export function invalidateStorageRootCache(): void {
  cachedRoot = null
  sawDocumentsWriteFailure = false
}

/** Fallback chain, most-preferred first. */
function candidateRoots(): string[] {
  const candidates: string[] = []
  try {
    const s = loadSettings().storageRoot
    if (typeof s === 'string' && s.trim() && isAbsolute(s.trim())) candidates.push(s.trim())
  } catch { /* settings unreadable → defaults */ }
  candidates.push(defaultStorageRoot())
  try { candidates.push(join(app.getPath('home'), 'Tachi Studio')) } catch { /* no home? */ }
  candidates.push(join(app.getPath('userData'), 'Tachi Studio'))
  return candidates
}

/**
 * Walk the fallback chain and return the first root that is creatable (finite
 * mkdir) AND writable (probe file). `usable:false` means nothing passed — the
 * caller gets the userData path anyway but must NOT cache it, so a transient
 * failure can heal on a later call.
 */
function resolveUsableRoot(): { root: string; usable: boolean } {
  for (const c of candidateRoots()) {
    if (ensureDirFinite(c) && isWritable(c)) return { root: c, usable: true }
  }
  return { root: join(app.getPath('userData'), 'Tachi Studio'), usable: false }
}

/**
 * The current USABLE storage root. Order: user-configured (Settings picker) →
 * Documents\Tachi Studio → %USERPROFILE%\Tachi Studio → <userData>\Tachi
 * Studio. A candidate must be creatable (finite mkdir) AND writable (probe
 * file) — Defender Controlled Folder Access fails both without hanging us.
 */
export function getStorageRoot(): string {
  if (cachedRoot) return cachedRoot
  const { root, usable } = resolveUsableRoot()
  if (usable) cachedRoot = root
  return root
}

// ── Write-failure re-probe (LANE J, 2026-07-27) ──────────────────────────────
//
// The probe above runs ONCE per session. Live evidence: Defender Controlled
// Folder Access was switched on AFTER boot (or the user's install was never on
// the allow-list and the boot probe happened to pass), so every later write to
// Documents\Tachi Studio died with a raw ENOENT on a directory that plainly
// exists — and the cached root never re-probed, so the fallback chain that
// exists precisely for this never fired. Only `storage:reset` healed it.
//
// So: a user-content write that fails with a permission-shaped code
// re-probes the chain ONCE and retries against whatever root that yields. A
// still-writable root simply comes back from the walk unchanged, in which case
// there is nothing to retry and the original error is surfaced (enriched with
// the CFA hint when the target sits under Documents).

/** Errno codes where "the folder turned unwritable under us" is plausible. */
const RETRYABLE_WRITE_CODES = new Set(['EPERM', 'EACCES', 'ENOENT', 'EBUSY', 'EROFS'])

/**
 * Marker prefix on the error message of a write we believe Controlled Folder
 * Access blocked, followed by `<fallback root>|<English text>`. The renderer
 * keys on this to show localized, actionable copy instead of a raw errno —
 * see src/pages/nodes/flow-save.ts (CFA_ERROR_TAG must stay in sync).
 */
export const CFA_ERROR_TAG = '[CFA]'

function isRetryableWriteError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && RETRYABLE_WRITE_CODES.has(code)
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

function isUnderDocuments(abs: string): boolean {
  try {
    return normPath(abs).startsWith(normPath(app.getPath('documents')) + '/')
  } catch {
    return false
  }
}

// Guards the (synchronous) re-probe against re-entry — a nested storage write
// inside a failing write must not restart the walk.
let reprobing = false

// Sticky evidence that Documents refused a USER-CONTENT write in this session.
// Why it must be remembered: a writer that pre-heals its folder
// (ensureStorageDir → the mkdir-step heal) has ALREADY moved off Documents by
// the time its write fails, so the failing path no longer looks like a CFA
// victim even though CFA is exactly what started the cascade. Only set from the
// user-content write paths below (never from the generic root walk), so an
// unrelated failure on a NON-Documents root still reports its own errno — and
// cleared whenever the root setting changes (storage:choose / storage:reset).
let sawDocumentsWriteFailure = false

/** Remember a refused user-content write under Documents (see above). */
function noteWriteFailure(target: string): void {
  if (isUnderDocuments(target)) sawDocumentsWriteFailure = true
}

/**
 * Invalidate the cached root and walk the fallback chain again. Returns the
 * root to use from here on. Concurrency: a second failing write that finds the
 * cache already moved off `failedRoot` reuses that result instead of probing
 * the filesystem again.
 */
export function reprobeStorageRootAfterWriteFailure(failedRoot: string): string {
  if (cachedRoot && normPath(cachedRoot) !== normPath(failedRoot)) return cachedRoot
  if (reprobing) return cachedRoot ?? failedRoot
  reprobing = true
  try {
    cachedRoot = null
    const { root, usable } = resolveUsableRoot()
    if (usable) cachedRoot = root
    return root
  } finally {
    reprobing = false
  }
}

/** First root in the chain that is usable and NOT under Documents — what the
 *  CFA message tells the user their data will land in instead. */
function fallbackRootOutsideDocuments(): string {
  for (const c of candidateRoots()) {
    if (isUnderDocuments(c) || normPath(c) === normPath(defaultStorageRoot())) continue
    if (ensureDirFinite(c) && isWritable(c)) return c
  }
  return join(app.getPath('userData'), 'Tachi Studio')
}

/**
 * Enrich a terminal write failure: when ANY attempt targeted Documents it is
 * almost always CFA, and "ENOENT" tells the user nothing they can act on.
 * (Both attempts are considered — the first one is the Documents write that
 * actually got blocked; the retry may already have moved elsewhere.)
 */
function storageWriteError(dests: string[], err: unknown): Error {
  // Windows-only claim — macOS blocks Documents through TCC, which needs
  // completely different words. Anywhere else the raw errno is the honest answer.
  if (process.platform !== 'win32' || !(dests.some(isUnderDocuments) || sawDocumentsWriteFailure)) {
    return err instanceof Error ? err : new Error(String(err))
  }
  const fallback = fallbackRootOutsideDocuments()
  return new Error(
    `${CFA_ERROR_TAG}${fallback}|Windows Controlled Folder Access is blocking writes to ` +
    `${defaultStorageRoot()} — allow Tachi Studio in Windows Security (Virus & threat protection → ` +
    `Ransomware protection), or the app will store data in ${fallback}`,
  )
}

/**
 * ONE heal contract, shared by every user-content writer: run `op` against the
 * path under the current root; on a permission-shaped failure re-probe the
 * chain ONCE and run it again against whatever root that yields. No loops.
 * Terminal failures carry the CFA message when Documents was involved.
 */
function runStorageWrite<T>(
  kind: StorageKind,
  relPath: string,
  op: (absPath: string) => T,
): { value: T; path: string } {
  const rootBefore = getStorageRoot()
  const first = join(rootBefore, SUBDIR[kind], relPath)
  try {
    ensureDirFinite(dirname(first))
    return { value: op(first), path: first }
  } catch (err) {
    if (!isRetryableWriteError(err)) throw err
    noteWriteFailure(first)
    const rootAfter = reprobeStorageRootAfterWriteFailure(rootBefore)
    if (normPath(rootAfter) === normPath(rootBefore)) throw storageWriteError([first], err)
    const second = join(rootAfter, SUBDIR[kind], relPath)
    try {
      ensureDirFinite(dirname(second))
      return { value: op(second), path: second }
    } catch (err2) {
      throw storageWriteError([first, second], err2)
    }
  }
}

/**
 * Write a USER-CONTENT file under the storage root, healing a root that went
 * unwritable mid-session: one re-probe, one retry, no loops. Returns the path
 * actually written (which may sit under a DIFFERENT root than the caller's
 * first choice). Throws on failure — the errno for ordinary problems, the
 * CFA-tagged message when the blocked target was under Documents.
 *
 * `relPath` may contain subfolders ('refs/x.png'); parents are created finitely.
 */
export function writeStorageFile(kind: StorageKind, relPath: string, data: string | Uint8Array): string {
  return runStorageWrite(kind, relPath, abs => { writeFileSync(abs, data) }).path
}

/**
 * COPY a file into the storage root under the same heal contract (the media
 * artifacts, design assets and voiceover imports are copies, not fresh bytes —
 * reading a 250MB source into memory just to reuse writeStorageFile would be
 * silly). A missing/unreadable SOURCE is reported as itself: it is not a
 * storage-root problem and must never be re-labelled as Controlled Folder
 * Access. Returns the destination actually written.
 */
export function copyStorageFile(kind: StorageKind, relPath: string, srcPath: string): string {
  if (!existsSync(srcPath)) {
    const err = new Error(`ENOENT: no such file, copy '${srcPath}'`) as NodeJS.ErrnoException
    err.code = 'ENOENT'
    throw err
  }
  return runStorageWrite(kind, relPath, abs => { copyFileSync(srcPath, abs) }).path
}

/** Absolute path of a user-content subfolder, created on first use. */
export function storageDir(kind: StorageKind): string {
  const dir = join(getStorageRoot(), SUBDIR[kind])
  ensureDirFinite(dir) // finite; a false just means the caller's write errors
  return dir
}

/**
 * Like storageDir, but PROVES the folder is writable and heals the root when it
 * is not — the pre-heal for writers that mkdir once and then write MANY files
 * into that folder (a design project + its assets), or whose bytes are produced
 * by something we don't control (yt-dlp, piper, sd-cli, ffmpeg, Remotion all
 * write their own output file). One heal covers the whole batch: the caller
 * joins its filenames onto the returned dir, which already sits under a root
 * that passed the probe.
 *
 * Never throws — when NOTHING in the chain is writable the caller's own write
 * fails with its own error, exactly as before.
 */
export function ensureStorageDir(kind: StorageKind, sub = ''): string {
  return resolveStorageDir(kind, sub).dir
}

function resolveStorageDir(kind: StorageKind, sub = ''): { dir: string; root: string } {
  const rootBefore = getStorageRoot()
  const first = sub ? join(rootBefore, SUBDIR[kind], sub) : join(rootBefore, SUBDIR[kind])
  if (ensureDirFinite(first) && isWritable(first)) return { dir: first, root: rootBefore }
  noteWriteFailure(first)
  const rootAfter = reprobeStorageRootAfterWriteFailure(rootBefore)
  if (normPath(rootAfter) === normPath(rootBefore)) return { dir: first, root: rootBefore }
  const second = sub ? join(rootAfter, SUBDIR[kind], sub) : join(rootAfter, SUBDIR[kind])
  ensureDirFinite(second)
  return { dir: second, root: rootAfter }
}

/** The storage ROOT itself, created finitely (never node's recursive mkdir —
 *  see the CFA note at the top) and healed if it turned unwritable. For the
 *  Settings card's OPEN FOLDER button, which must land the user somewhere real. */
export function ensureStorageRoot(): string {
  const rootBefore = getStorageRoot()
  if (ensureDirFinite(rootBefore) && isWritable(rootBefore)) return rootBefore
  return reprobeStorageRootAfterWriteFailure(rootBefore)
}

/**
 * STREAMED user content (a large media download written chunk by chunk).
 *
 * Contract, deliberately narrower than writeStorageFile's:
 *   - PRE-HEAL: the parent folder is created AND write-probed (ensureStorageDir)
 *     before the stream is opened, so a root that went unwritable mid-session
 *     has already moved by the time the first byte is written. Controlled Folder
 *     Access blocks at file CREATION, which is exactly what the probe does — so
 *     the pre-heal covers the CFA case.
 *   - OPEN failure with a permission-shaped errno (the stream's async 'error'
 *     before 'open') re-probes ONCE and reopens against the healed root.
 *   - MID-WRITE failures after a successful open are OUT of the healing
 *     contract: bytes are already on disk under the old root, and silently
 *     re-targeting half a file would produce a corrupt artifact. Those surface
 *     to the caller's own stream 'error' handler unchanged.
 *
 * Resolves once the stream is open (fd acquired), so the caller can pipe into
 * it immediately.
 */
export async function openStorageWriteStream(
  kind: StorageKind,
  relPath: string,
  opts: { flags?: string } = {},
): Promise<{ stream: WriteStream; path: string }> {
  const sub = dirname(relPath)
  const { dir, root } = resolveStorageDir(kind, sub === '.' || sub === '' ? '' : sub)
  const first = join(dir, basename(relPath))
  try {
    return { stream: await openWriteStream(first, opts.flags), path: first }
  } catch (err) {
    if (!isRetryableWriteError(err)) throw err
    noteWriteFailure(first)
    const rootAfter = reprobeStorageRootAfterWriteFailure(root)
    if (normPath(rootAfter) === normPath(root)) throw storageWriteError([first], err)
    const second = join(rootAfter, SUBDIR[kind], relPath)
    ensureDirFinite(dirname(second))
    try {
      return { stream: await openWriteStream(second, opts.flags), path: second }
    } catch (err2) {
      throw storageWriteError([first, second], err2)
    }
  }
}

/** createWriteStream that REJECTS on a failed open instead of emitting an
 *  unhandled 'error' later (node reports open failures asynchronously). */
function openWriteStream(abs: string, flags?: string): Promise<WriteStream> {
  return new Promise((resolve, reject) => {
    let ws: WriteStream
    try {
      ws = createWriteStream(abs, flags ? { flags } : undefined)
    } catch (err) {
      reject(err as Error)
      return
    }
    const done = (fn: () => void) => {
      ws.removeListener('open', onOpen)
      ws.removeListener('error', onError)
      fn()
    }
    const onOpen = () => done(() => resolve(ws))
    const onError = (err: Error) => done(() => {
      try { ws.destroy() } catch { /* already gone */ }
      reject(err)
    })
    ws.once('open', onOpen)
    ws.once('error', onError)
  })
}

/**
 * Legacy userData location for a kind — where PRE-EXISTING files live. Readers
 * that list/serve user content should check this too so nothing the user
 * already generated disappears after the storage-root change.
 */
export function legacyDir(kind: StorageKind): string {
  const legacy: Record<StorageKind, string> = {
    media:   join(app.getPath('userData'), 'media'),
    designs: join(app.getPath('userData'), 'TACHI Design'),
    renders: join(app.getPath('userData'), 'design-renders'),
    audio:   join(app.getPath('userData'), 'design-audio'),
    flows:   join(app.getPath('userData'), 'nodes'),
    assets:  join(app.getPath('userData'), 'design-assets'), // kind is new — dir never populated, listed for completeness
  }
  return legacy[kind]
}

/** True when `abs` sits inside either the current storage root or a legacy
 *  user-content dir — the media-protocol serve check. */
export function isUserContentPath(abs: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') + '/'
  const target = norm(abs)
  const roots = [
    getStorageRoot(),
    defaultStorageRoot(), // may differ from the usable root after a fallback
    ...(['media', 'designs', 'renders', 'audio', 'flows'] as StorageKind[]).map(legacyDir),
  ]
  return roots.some(r => target.startsWith(norm(r)))
}

/** Root exists check without creating it (Settings UI display). */
export function storageRootExists(): boolean {
  return existsSync(getStorageRoot())
}
