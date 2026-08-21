// apps/desktop/electron/services/staging-inventory.ts
//
// WHAT THE STORAGE DASHBOARD COULD NOT SEE.
//
// Found on the owner's own machine, 2026-08-02, while checking why C: had 9.1 GB
// free after every model had supposedly been moved to D::
//
//   %APPDATA%\tachi-studio-desktop\llama-cpp\downloads\
//     hf_igorls_gemma-4-12b-it-heretic-gguf_q4_k_m.gguf.tmp   4.76 GB, 2026-06-09
//
// 4.76 GB, eight weeks old, and unreachable by every code path in the app:
//
//   · `downloads.json` held `{"version":1,"tasks":[]}` — no task, running or
//     paused, claims it, so no Resume will ever adopt those bytes;
//   · the download manager stages a model at `partPathFor(dest)` — a `.part`
//     NEXT TO the destination (llama-cpp-installer.ts:600,689), never a `.tmp`
//     in `downloads/`;
//   · `downloads/` is documented by its own installer as "transient .tmp for the
//     BINARY zips only" (llama-cpp-installer.ts:12), and a 4.76 GB GGUF is not
//     a binary zip.
//
// So it is a fossil of a scheme we no longer use. Nothing resumes it, nothing
// lists it, nothing deletes it — and `getStorageUsage()` never counted it,
// because that function walks MODEL ITEMS (`listEngineItemIds`) and a staging
// file is not a model. The dashboard therefore showed a nearly-full system
// drive next to a Move button that could account for less than a third of what
// was on it, and had no words for the rest.
//
// THIS MODULE IS THE MISSING INVENTORY. It only ever looks at, and only ever
// offers, files whose nature is legible from the file itself:
//
//   abandoned-partial  `.tmp` / `.part` — an interrupted transfer. Deleting it
//                      costs NOTHING, because no code can resume it.
//   cached-archive     `.zip` — an installer archive kept after extraction.
//                      Deleting it costs a re-download, and nothing else.
//
// Everything else in a `downloads/` directory is left alone, and that is not
// caution for its own sake: `piper/downloads/` holds 362 EXTRACTED files (the
// .dll / .ort / dictionary tree piper actually runs from). A rule like "empty
// the downloads folder" would take the engine out with the rubbish.
//
// NOTHING HERE DELETES ON ITS OWN. `scanStagingInventory()` reports; the user
// clicks; `reclaimStaging()` re-derives the offer from scratch and refuses any
// path that is not in it. The renderer's list is a request, never an authority
// — same rule as removeModelItem().

import { app } from 'electron'
import { existsSync, readdirSync, rmSync, statSync } from 'fs'
import { join, basename, dirname } from 'path'
import { claimedDownloadPaths } from './download-manager'

// ─── The two guards ──────────────────────────────────────────────────────────

/**
 * A staging file younger than this is NEVER offered, whatever it looks like.
 *
 * This is the guard that makes the whole module safe, and it is derived from
 * the file rather than from bookkeeping: a transfer in flight rewrites its
 * staging file continuously, so a live download's mtime is always ~now. Six
 * hours is far longer than any archive or weight download this app performs,
 * and far shorter than the eight weeks the fossil above sat there.
 *
 * The download manager's own claim set (below) is the second, independent
 * guard. Either one alone would do for the common case; together they also
 * cover a stalled task whose mtime has gone cold while the task still lives.
 */
export const STAGING_MIN_AGE_MS = 6 * 60 * 60 * 1000

/** What a staging file IS, as read off the file itself. */
export type StagingKind = 'abandoned-partial' | 'cached-archive'

/**
 * The extension rule, isolated and pure so the tests can state it without a
 * filesystem. Returns null for anything we will not touch — which is most of
 * what lives in a downloads directory.
 */
export function classifyStagingFile(name: string): StagingKind | null {
  const n = name.toLowerCase()
  if (n.endsWith('.tmp') || n.endsWith('.part')) return 'abandoned-partial'
  if (n.endsWith('.zip')) return 'cached-archive'
  return null
}

// ─── Where we look ───────────────────────────────────────────────────────────

/**
 * Every `<userData>/<engine>/downloads` directory that exists right now.
 *
 * DERIVED FROM THE LAYOUT, NOT FROM A LIST OF ENGINES. Five installers
 * (llama-cpp, sd-cpp, piper, whisper, rife) each keep a private
 * `xDownloadsDir()` returning exactly `<root>/downloads`, and a hand-written
 * list of engine names here would be a sixth copy of that convention — the
 * copy that goes stale the day someone adds an engine and wonders why its
 * leftovers are invisible. One level down, a directory literally named
 * `downloads`: that is the convention, so that is the query.
 */
export function stagingDownloadDirs(): string[] {
  let userData: string
  try { userData = app.getPath('userData') } catch { return [] }
  let entries: string[]
  try { entries = readdirSync(userData) } catch { return [] }
  const out: string[] = []
  for (const name of entries) {
    const dir = join(userData, name, 'downloads')
    try { if (statSync(dir).isDirectory()) out.push(dir) } catch { /* not a dir */ }
  }
  return out.sort()
}

// ─── The report ──────────────────────────────────────────────────────────────

export interface StagingFile {
  /** Absolute path. Echoed back to reclaim, and re-validated there. */
  path: string
  name: string
  /** The engine directory it belongs to (`llama-cpp`), for grouping on screen. */
  owner: string
  bytes: number
  mtimeMs: number
  kind: StagingKind
}

export interface StagingInventory {
  files: StagingFile[]
  /** Everything offered. */
  totalBytes: number
  /** Bytes whose removal costs the user nothing at all. */
  deadBytes: number
  /** Bytes whose removal costs only a re-download. */
  cachedBytes: number
  /** The directories actually walked — so a surface can say where it looked. */
  scannedDirs: string[]
  /** Files seen and deliberately NOT offered (too new, or claimed by a task). */
  withheldCount: number
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/**
 * Walk every staging directory, one level deep, and report what may be
 * reclaimed.
 *
 * ONE LEVEL DEEP is a rule, not an optimisation: an installer that extracts
 * INTO its downloads directory leaves a live engine tree there (piper does
 * exactly this), and a recursive walk would start offering its parts.
 */
export function scanStagingInventory(now: number = Date.now()): StagingInventory {
  const scannedDirs = stagingDownloadDirs()
  const claimed = new Set(claimedDownloadPaths().map(normPath))
  const files: StagingFile[] = []
  let withheldCount = 0

  for (const dir of scannedDirs) {
    let names: string[]
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      const kind = classifyStagingFile(name)
      const path = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(path) } catch { continue }
      if (!st.isFile()) continue
      if (kind === null) continue
      // Too fresh to be sure it is finished with, or a download is holding it.
      if (now - st.mtimeMs < STAGING_MIN_AGE_MS || claimed.has(normPath(path))) {
        withheldCount++
        continue
      }
      files.push({
        path,
        name,
        owner: basename(dirname(dir)),
        bytes: st.size,
        mtimeMs: st.mtimeMs,
        kind,
      })
    }
  }

  files.sort((a, b) => b.bytes - a.bytes)
  const sum = (k: StagingKind) => files.filter(f => f.kind === k).reduce((s, f) => s + f.bytes, 0)
  return {
    files,
    totalBytes: files.reduce((s, f) => s + f.bytes, 0),
    deadBytes: sum('abandoned-partial'),
    cachedBytes: sum('cached-archive'),
    scannedDirs,
    withheldCount,
  }
}

// ─── The delete ──────────────────────────────────────────────────────────────

export interface ReclaimResult {
  freedBytes: number
  removed: string[]
  failed: Array<{ path: string; error: string }>
  /** Paths the caller asked for that the fresh scan would not offer. */
  refused: string[]
}

/**
 * Delete the named staging files — and ONLY files a fresh scan still offers.
 *
 * The re-derivation is the point. The renderer's list was built from a scan
 * that may be seconds or minutes old, and in between a download can have
 * started writing to one of those very paths. So the list arriving over IPC is
 * treated as a REQUEST: every entry is matched against a scan taken now, and
 * anything absent from it is refused and reported rather than deleted. A caller
 * cannot widen the offer by sending a path of its own choosing, which is the
 * same rule `removeModelItem` follows for weights.
 */
export function reclaimStaging(paths: readonly string[], now: number = Date.now()): ReclaimResult {
  const offer = new Map(scanStagingInventory(now).files.map(f => [normPath(f.path), f]))
  const removed: string[] = []
  const failed: Array<{ path: string; error: string }> = []
  const refused: string[] = []
  let freedBytes = 0

  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue
    const hit = offer.get(normPath(p))
    if (!hit) { refused.push(p); continue }
    try {
      rmSync(hit.path, { force: true })
      // Verified by absence, not by the call returning: `force: true` swallows
      // a missing file, and reporting freed bytes for something still on disk
      // is the kind of claim this codebase keeps deleting.
      if (existsSync(hit.path)) {
        failed.push({ path: hit.path, error: 'The file is still on disk after the delete call.' })
        continue
      }
      removed.push(hit.path)
      freedBytes += hit.bytes
    } catch (err) {
      failed.push({ path: hit.path, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { freedBytes, removed, failed, refused }
}
