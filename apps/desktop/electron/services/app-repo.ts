// apps/desktop/electron/services/app-repo.ts
//
// Where does Tachi Studio's OWN source live?
//
// The TACHIAPP surface (the pinned self-improvement chat) is deliberately
// folder-free: the user never picks a workspace, so SOMETHING has to answer
// "which directory is this app's source checkout?". That is this module.
//
// Resolution order (first hit wins):
//   1. setting   — an explicit `appRepoPath` the user already answered, when it
//                  still exists on disk. A deliberate answer outranks every
//                  heuristic and is never re-derived.
//   2. dev       — walk UP from the running app path looking for a directory
//                  that carries BOTH marker files (AGENTS.md + apps/desktop).
//                  Covers `pnpm dev` / an unpacked build inside the repo.
//   3. fallback  — known-install candidates (the maintainer box's
//                  D:\projects\TachiDesk plus a few home-relative guesses),
//                  each validated with the same two markers.
//   → null       — nothing found; the surface shows the one-time LOCATE APP
//                  SOURCE card, whose native pick writes case 1 forever.
//
// Everything here is PURE: filesystem access goes through the injected
// `AppRepoFs` (defaults to node:fs), so the unit tests drive it with an
// in-memory tree and no temp dirs.

import { existsSync, statSync } from 'fs'
import { dirname, isAbsolute, join } from 'path'

/** Minimal filesystem surface the resolver needs — injectable for tests. */
export interface AppRepoFs {
  /** True when `p` exists (file OR directory). */
  exists(p: string): boolean
  /** True when `p` exists AND is a directory. */
  isDirectory(p: string): boolean
}

/** Real filesystem, used by the IPC layer. */
export const nodeAppRepoFs: AppRepoFs = {
  exists: (p) => {
    try { return existsSync(p) } catch { return false }
  },
  isDirectory: (p) => {
    try { return existsSync(p) && statSync(p).isDirectory() } catch { return false }
  },
}

/** How the answer was reached — surfaced in the UI chip's tooltip. */
export type AppRepoSource = 'setting' | 'dev' | 'fallback'

export interface AppRepoResolution {
  path: string
  source: AppRepoSource
}

/**
 * The two markers that identify THIS repo (not just any checkout): the agent
 * context file every harness run reads, and the desktop app package.
 */
export const APP_REPO_MARKER_FILE = 'AGENTS.md'
export const APP_REPO_MARKER_DIR  = join('apps', 'desktop')

/** True when `dir` looks like the Tachi Studio source root. */
export function looksLikeAppRepo(dir: string | null | undefined, fs: AppRepoFs = nodeAppRepoFs): boolean {
  if (!dir) return false
  if (!fs.isDirectory(dir)) return false
  if (!fs.exists(join(dir, APP_REPO_MARKER_FILE))) return false
  return fs.isDirectory(join(dir, APP_REPO_MARKER_DIR))
}

/**
 * Walk up from `startDir` (inclusive) looking for the repo root. Bounded by
 * `maxUp` levels AND by hitting the filesystem root, so a bad start can never
 * spin — it just returns null.
 */
export function walkUpForAppRepo(
  startDir: string | null | undefined,
  fs: AppRepoFs = nodeAppRepoFs,
  maxUp = 10,
): string | null {
  if (!startDir) return null
  let cur = startDir
  for (let i = 0; i <= maxUp; i++) {
    if (looksLikeAppRepo(cur, fs)) return cur
    const parent = dirname(cur)
    if (!parent || parent === cur) return null
    cur = parent
  }
  return null
}

/**
 * Known-install guesses, tried in order after the dev walk-up fails.
 *
 * Every entry is home-relative, so a normal `git clone` lands on one of them on
 * any platform. There is deliberately no absolute path here: an absolute guess
 * is only ever right on one machine, and being wrong means an agent with write
 * access pointed at somebody else's tree.
 *
 * Both folder names are tried, because the repository is `tachi-studio` and
 * older checkouts are `TachiDesk`.
 */
export function defaultAppRepoCandidates(home?: string | null): string[] {
  if (!home || !isAbsolute(home)) return []
  const out: string[] = []
  for (const name of ['tachi-studio', 'TachiDesk']) {
    out.push(
      join(home, 'projects', name),
      join(home, name),
      join(home, 'Documents', name),
      join(home, 'src', name),
    )
  }
  return out
}

export interface ResolveAppRepoOptions {
  /** Persisted `appRepoPath` setting ('' / null when unanswered). */
  settingPath?: string | null
  /** `app.getAppPath()` — the dev walk-up starts here. */
  appPath?: string | null
  /** Extra roots to walk up from (e.g. process.cwd()). */
  extraStartDirs?: readonly (string | null | undefined)[]
  /** Known-install candidates; defaults to `defaultAppRepoCandidates(home)`. */
  candidates?: readonly string[]
  /** Home directory used to build the default candidate list. */
  home?: string | null
  fs?: AppRepoFs
}

/**
 * Resolve the app's own source checkout, or null when it can't be found.
 * Pure — every filesystem probe goes through `opts.fs`.
 */
export function resolveAppRepoPath(opts: ResolveAppRepoOptions = {}): AppRepoResolution | null {
  const fs = opts.fs ?? nodeAppRepoFs

  // 1. The user's own answer wins whenever it still exists on disk. We do NOT
  //    re-validate the markers here: they picked it, and a repo mid-rename
  //    should not silently bounce them back to a heuristic guess.
  const setting = (opts.settingPath ?? '').trim()
  if (setting && fs.isDirectory(setting)) {
    return { path: setting, source: 'setting' }
  }

  // 2. Dev heuristic — running from inside the repo (pnpm dev, or an unpacked
  //    build under <repo>/apps/desktop/out).
  const starts = [opts.appPath, ...(opts.extraStartDirs ?? [])]
  for (const start of starts) {
    const found = walkUpForAppRepo(start, fs)
    if (found) return { path: found, source: 'dev' }
  }

  // 3. Known-install fallbacks.
  const candidates = opts.candidates ?? defaultAppRepoCandidates(opts.home)
  for (const cand of candidates) {
    if (looksLikeAppRepo(cand, fs)) return { path: cand, source: 'fallback' }
  }

  return null
}
