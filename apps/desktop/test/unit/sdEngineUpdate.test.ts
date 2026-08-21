// apps/desktop/test/unit/sdEngineUpdate.test.ts
//
// A BUMPED ENGINE PIN REACHED NOBODY WHO ALREADY HAD ONE.
//
// `installSdCppBinary` short-circuits on `isSdCppInstalled()`, which is only
// "does a binary exist". So moving SD_CPP_VERSION from master-782 to master-810
// shipped the new engine to fresh installs and NOTHING to everyone else — their
// bytes unchanged, no surface saying so, and the IP-Adapter / sampler work in
// that release unreachable forever.
//
// `updateSdCppBinary` had been a complete atomic swap the whole time (download
// .new -> verify sha -> rename, prior kept as .old), described in its own
// comment as "dormant until an update flow calls it". Nothing called it. This
// pins the half that was missing: knowing the installed build differs.
//
// The version is READ OFF THE BINARY (`sd-cli --help` prints
// `stable-diffusion.cpp version unknown, commit b290693`) rather than stamped
// at install time, because a stamp is a second truth that drifts the moment a
// file is swapped by hand or a backup restored.

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, BrowserWindow: class {} }))

import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')

import { isSdCppEngineStale, pinnedSdCppCommit } from '../../electron/services/sd-cpp-installer'
import { SD_CPP_VERSION } from '../../electron/services/sd-cpp-models'

describe('pinnedSdCppCommit', () => {
  it('is the short hash the tag ends in', () => {
    // master-810-db99efd -> db99efd. The tag shape is upstream's, and the hash
    // is the only version marker their build carries — the banner literally
    // says "version unknown".
    expect(pinnedSdCppCommit()).toBe(SD_CPP_VERSION.split('-').pop())
    expect(pinnedSdCppCommit()).toMatch(/^[0-9a-f]{7,}$/)
  })
})

describe('isSdCppEngineStale — every failure mode is "say yes when you do not know"', () => {
  it('a matching commit is not stale', () => {
    expect(isSdCppEngineStale('db99efd', 'db99efd')).toBe(false)
  })

  it('a DIFFERENT commit is stale — this is the case the bump created', () => {
    expect(isSdCppEngineStale('b290693', 'db99efd')).toBe(true)
  })

  it('an engine that reported NO commit is never accused', () => {
    // The whole point. An unreadable binary means we do not know, and offering
    // a 400 MB download to fix a problem nobody established is worse than
    // saying nothing at all.
    expect(isSdCppEngineStale(null, 'db99efd')).toBe(false)
    expect(isSdCppEngineStale('', 'db99efd')).toBe(false)
  })

  it('an app with no pin makes no claim either', () => {
    expect(isSdCppEngineStale('b290693', '')).toBe(false)
  })

  it('a longer or shorter spelling of the SAME commit is one build', () => {
    // Upstream tags carry 7 chars; a binary may print more. Treating those as
    // different builds would offer an update that changes nothing, forever.
    expect(isSdCppEngineStale('db99efd1a2b3c4', 'db99efd')).toBe(false)
    expect(isSdCppEngineStale('db99efd', 'db99efd1a2b3c4')).toBe(false)
  })

  it('hex is case-insensitive', () => {
    expect(isSdCppEngineStale('DB99EFD', 'db99efd')).toBe(false)
  })

  it('a commit that merely shares a prefix boundary is still different', () => {
    // `db99efd` vs `db99efe` — one character apart, neither a prefix of the
    // other, so genuinely two builds.
    expect(isSdCppEngineStale('db99efe', 'db99efd')).toBe(true)
  })
})

// ── THE UPDATE PATH ITSELF, AFTER IT BROKE A REAL MACHINE ───────────────────
//
// The first version called `updateBinary({ binPath, url, sha256 })`, which
// downloads a URL and rotates those bytes into place AS THE BINARY. Driver-
// proven on the installed build: it reported
// `{ok:true, from:'b290693', to:'db99efd'}` and left a 362 MB file beginning
// `PK` where `sd-cli.exe` had been. Windows refused to execute it; the
// working engine survived only because of the `.old` backup.
//
// TWO reasons it could never have worked, and the second outlives the first:
//   1. the asset is a ZIP, not a bare executable;
//   2. the archive carries ~15 DLLs versioned WITH the exe (`ggml-base`,
//      `ggml-cpu-*`, `ggml-cuda`), so even extracting just the binary would
//      leave an engine whose halves disagree.
//
// So an sd.cpp update IS an sd.cpp install. A source sweep, because the whole
// property is "which function does it call" and mounting the installer would
// need a network and 362 MB.
describe('an engine update runs the install path, never a single-file swap', () => {
  const SRC = read('electron/services/sd-cpp-installer.ts')
  const body = SRC.slice(SRC.indexOf('export async function updateSdCppToPinned'))
    .slice(0, 1400)

  // Both properties now live in the shared `_runInstall` the update DELEGATES
  // to, which is where install and update were unified — so they are asserted
  // there, plus the delegation itself. Asserting only the outer body would pass
  // a version that had quietly stopped calling the runner.
  const runner = SRC.slice(SRC.indexOf('async function _runInstall')).slice(0, 400)

  it('extracts the archive instead of rotating the URL into the binary', () => {
    expect(body).toContain('_runInstall')
    expect(runner).toContain('_doInstallBinary')
    expect(body).not.toMatch(/updateBinary\s*\(/)
    expect(runner).not.toMatch(/updateBinary\s*\(/)
  })

  it('holds the install lock, so it cannot race a concurrent install', () => {
    expect(runner).toContain("withInstallLock('sd-cpp-binary'")
  })

  it('reports the commit the NEW binary states, not the one we hoped for', () => {
    // The version it replaced returned the pinned hash unconditionally, which
    // is how it announced a successful update over a corrupted exe.
    expect(body).toMatch(/const to = installedSdCppCommit\(\)/)
    expect(body).toMatch(/if \(to === null\) throw/)
  })

  it('forgets the cached commit in a FINALLY, on every path that touches the binary', () => {
    // `installedSdCppCommit` memoises per process. Clearing it only after a
    // SUCCESSFUL update left the app reporting the old commit while the new
    // engine was already extracted — observed live when the caller timed out
    // and abandoned the promise, which kept the UPDATE button on screen
    // offering to install what was already installed. The binary can change
    // even when the install fails, so the invalidation cannot be conditional.
    expect(runner).toContain('finally { forgetInstalledSdCppCommit() }')
    // …and BOTH entry points go through it, or one of them keeps the old bug.
    expect(SRC).toContain('return _runInstall(win, platformId)')
    expect(SRC).toContain('await _runInstall(win, asset.platform)')
  })

  it('the single-file helper is GONE from both installers that had it', () => {
    // Same helper, same archive-shaped assets. piper never called its copy, so
    // deleting it costs nothing and removes an identical landmine.
    expect(SRC).not.toMatch(/export async function updateSdCppBinary/)
    expect(read('electron/services/piper-installer.ts'))
      .not.toMatch(/export async function updatePiperBinary/)
  })

  it('does not re-download the CUDA runtime it already has', () => {
    // 563 MB, versioned by CUDA rather than by the sd.cpp tag, byte-identical
    // across this bump — re-fetching it would more than double a 362 MB update.
    expect(SRC).toContain("existsSync(join(sdBinDir(), 'cudart64_12.dll'))")
  })
})
