// apps/desktop/test/unit/appRepoResolver.test.ts
//
// The TACHIAPP workspace resolver (electron/services/app-repo.ts). The whole
// point of the TACHIAPP surface is that the user never picks a folder, so this
// resolver is the thing that has to be right — a wrong answer means an agent
// with write access editing the wrong tree.
//
// Filesystem access is injected (AppRepoFs), so every case below runs against
// an in-memory tree: no temp dirs, no electron, deterministic on any machine.

import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import {
  looksLikeAppRepo,
  walkUpForAppRepo,
  resolveAppRepoPath,
  defaultAppRepoCandidates,
  APP_REPO_MARKER_FILE,
  APP_REPO_MARKER_DIR,
  type AppRepoFs,
} from '../../electron/services/app-repo'

/**
 * Build a fake fs from an explicit set of paths.
 *   dirs  — every directory that exists
 *   files — every file that exists
 */
function fakeFs(dirs: string[], files: string[] = []): AppRepoFs {
  const dirSet  = new Set(dirs)
  const fileSet = new Set(files)
  return {
    exists: (p) => dirSet.has(p) || fileSet.has(p),
    isDirectory: (p) => dirSet.has(p),
  }
}

/** A directory that carries BOTH repo markers. */
function repoAt(root: string): { dirs: string[]; files: string[] } {
  return {
    dirs:  [root, join(root, APP_REPO_MARKER_DIR)],
    files: [join(root, APP_REPO_MARKER_FILE)],
  }
}

/**
 * An absolute path in the shape of the platform the test is running on.
 *
 * The resolver walks with `node:path`, so a Windows-shaped literal like
 * `D:\projects\…` is a RELATIVE path to a POSIX runner and every assertion
 * about absoluteness quietly inverts. This file used to hardcode drive letters
 * and passed for months — on Linux CI it failed the first time it ever ran.
 */
const abs = (...parts: string[]) =>
  process.platform === 'win32' ? join('D:\\', ...parts) : join('/', ...parts)

const REPO = abs('projects', 'TachiDesk')

describe('looksLikeAppRepo', () => {
  it('accepts a directory carrying AGENTS.md + apps/desktop', () => {
    const r = repoAt(REPO)
    expect(looksLikeAppRepo(REPO, fakeFs(r.dirs, r.files))).toBe(true)
  })

  it('rejects a directory missing AGENTS.md', () => {
    const r = repoAt(REPO)
    expect(looksLikeAppRepo(REPO, fakeFs(r.dirs, []))).toBe(false)
  })

  it('rejects a directory missing apps/desktop', () => {
    const r = repoAt(REPO)
    expect(looksLikeAppRepo(REPO, fakeFs([REPO], r.files))).toBe(false)
  })

  it('rejects a path that is a file, not a directory', () => {
    expect(looksLikeAppRepo(REPO, fakeFs([], [REPO]))).toBe(false)
  })

  it('rejects nullish input without touching the filesystem', () => {
    const boom: AppRepoFs = {
      exists: () => { throw new Error('should not probe') },
      isDirectory: () => { throw new Error('should not probe') },
    }
    expect(looksLikeAppRepo(null, boom)).toBe(false)
    expect(looksLikeAppRepo(undefined, boom)).toBe(false)
    expect(looksLikeAppRepo('', boom)).toBe(false)
  })
})

describe('walkUpForAppRepo', () => {
  it('finds the root from a nested build directory', () => {
    const r = repoAt(REPO)
    const nested = join(REPO, 'apps', 'desktop', 'out', 'main')
    const fs = fakeFs([...r.dirs, join(REPO, 'apps'), nested], r.files)
    expect(walkUpForAppRepo(nested, fs)).toBe(REPO)
  })

  it('returns the start dir itself when it is already the root', () => {
    const r = repoAt(REPO)
    expect(walkUpForAppRepo(REPO, fakeFs(r.dirs, r.files))).toBe(REPO)
  })

  it('returns null when no ancestor carries the markers', () => {
    const stray = abs('Program Files', 'Tachi Studio', 'resources')
    const fs = fakeFs([stray, abs('Program Files', 'Tachi Studio'), abs('Program Files'), abs()])
    expect(walkUpForAppRepo(stray, fs)).toBe(null)
  })

  it('stops after maxUp levels instead of walking forever', () => {
    // The repo is 3 levels up but we only allow 1 — must give up, not find it.
    const r = repoAt(REPO)
    const nested = join(REPO, 'a', 'b', 'c')
    const fs = fakeFs([...r.dirs, join(REPO, 'a'), join(REPO, 'a', 'b'), nested], r.files)
    expect(walkUpForAppRepo(nested, fs, 1)).toBe(null)
    expect(walkUpForAppRepo(nested, fs, 3)).toBe(REPO)
  })

  it('returns null for nullish start', () => {
    expect(walkUpForAppRepo(null, fakeFs([]))).toBe(null)
    expect(walkUpForAppRepo(undefined, fakeFs([]))).toBe(null)
  })
})

describe('resolveAppRepoPath — precedence', () => {
  it('1. an existing saved setting beats every heuristic', () => {
    const picked = abs('work', 'tachi-fork')
    const r = repoAt(REPO)
    const fs = fakeFs([...r.dirs, picked], r.files)
    expect(resolveAppRepoPath({
      settingPath: picked,
      appPath: REPO,
      candidates: [REPO],
      fs,
    })).toEqual({ path: picked, source: 'setting' })
  })

  it('ignores a saved setting that no longer exists on disk and falls through', () => {
    const r = repoAt(REPO)
    const fs = fakeFs(r.dirs, r.files)
    expect(resolveAppRepoPath({
      settingPath: abs('deleted', 'checkout'),
      appPath: REPO,
      candidates: [],
      fs,
    })).toEqual({ path: REPO, source: 'dev' })
  })

  it('ignores a blank / whitespace-only setting', () => {
    const r = repoAt(REPO)
    const fs = fakeFs(r.dirs, r.files)
    expect(resolveAppRepoPath({ settingPath: '   ', appPath: REPO, candidates: [], fs }))
      .toEqual({ path: REPO, source: 'dev' })
    expect(resolveAppRepoPath({ settingPath: '', appPath: REPO, candidates: [], fs }))
      .toEqual({ path: REPO, source: 'dev' })
  })

  it('2. dev walk-up from the running app path (repo checkout)', () => {
    const r = repoAt(REPO)
    const appPath = join(REPO, 'apps', 'desktop', 'out')
    const fs = fakeFs([...r.dirs, join(REPO, 'apps'), appPath], r.files)
    expect(resolveAppRepoPath({ appPath, candidates: [], fs }))
      .toEqual({ path: REPO, source: 'dev' })
  })

  it('2b. falls back to extraStartDirs (cwd) when the app path is outside the repo', () => {
    const r = repoAt(REPO)
    const installed = abs('Users', 'x', 'AppData', 'Local', 'Programs', 'tachi')
    const fs = fakeFs([...r.dirs, installed], r.files)
    expect(resolveAppRepoPath({
      appPath: installed,
      extraStartDirs: [join(REPO, 'apps', 'desktop')],
      candidates: [],
      fs,
    })).toEqual({ path: REPO, source: 'dev' })
  })

  it('3. known-install candidate, validated with the markers', () => {
    const r = repoAt(REPO)
    const installed = abs('Program Files', 'Tachi Studio')
    const fs = fakeFs([...r.dirs, installed], r.files)
    expect(resolveAppRepoPath({ appPath: installed, candidates: [REPO], fs }))
      .toEqual({ path: REPO, source: 'fallback' })
  })

  it('3b. skips candidates that exist but are not this repo', () => {
    const decoy = abs('elsewhere', 'TachiDesk')   // exists, but no markers
    const r = repoAt(REPO)
    const fs = fakeFs([...r.dirs, decoy], r.files)
    expect(resolveAppRepoPath({ appPath: null, candidates: [decoy, REPO], fs }))
      .toEqual({ path: REPO, source: 'fallback' })
  })

  it('returns null when nothing resolves (surface shows LOCATE APP SOURCE)', () => {
    const installed = abs('Program Files', 'Tachi Studio')
    const fs = fakeFs([installed])
    expect(resolveAppRepoPath({ appPath: installed, candidates: [REPO], fs })).toBe(null)
  })

  it('returns null on a completely empty invocation', () => {
    expect(resolveAppRepoPath({ candidates: [], fs: fakeFs([]) })).toBe(null)
  })
})

describe('defaultAppRepoCandidates', () => {
  it('offers nothing without a home directory — no absolute guess is right for everyone', () => {
    expect(defaultAppRepoCandidates(null)).toEqual([])
  })

  it('guesses home-relative locations under both repository names', () => {
    const home = abs('Users', 'dev')
    const list = defaultAppRepoCandidates(home)
    expect(list).toContain(join(home, 'projects', 'tachi-studio'))
    expect(list).toContain(join(home, 'tachi-studio'))
    expect(list).toContain(join(home, 'projects', 'TachiDesk'))
    expect(list).toContain(join(home, 'TachiDesk'))
  })

  it('every guess is under the home directory, never elsewhere on the disk', () => {
    const home = abs('Users', 'dev')
    for (const p of defaultAppRepoCandidates(home)) expect(p.startsWith(home)).toBe(true)
  })

  it('ignores a relative / bogus home value', () => {
    expect(defaultAppRepoCandidates('not-absolute')).toEqual([])
  })
})
