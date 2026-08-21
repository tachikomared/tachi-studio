// apps/desktop/test/unit/remotionBinaries.test.ts
//
// THE ENCODER IS FETCHED, NOT SHIPPED — and this file is what keeps it that way.
//
// The installer we were about to publish contained four DLLs whose own version
// string reads:
//
//     libavcodec license: nonfree and unredistributable    FFmpeg version n7.1
//
// (avcodec-60/61 and avformat-60/61, inside @remotion/compositor-win32-x64-msvc,
// put there by the asarUnpack rule "**/node_modules/@remotion/**"). That is
// FFmpeg's own statement about its own bytes when built with --enable-nonfree.
// Shipping it made this project the distributor of something that says it may
// not be distributed, under a page that says MIT.
//
// The package is now excluded and fetched from Remotion's official npm entry on
// an explicit click. What that turns on — verified in the installed renderer,
// @remotion/renderer 4.0.490, dist/compositor/get-executable-path.js:34 — is:
//
//     const base = binariesDirectory ?? getExecutableDir(indent, logLevel);
//
// `getExecutableDir` is the only place that does
// `require('@remotion/compositor-…')`, and it is unreachable when
// `binariesDirectory` is a real path. So the package does not need to exist in
// the bundle at all.
//
// A build config is one careless line from putting it back, so the assertions
// below are deliberately about the CONFIG and the HOOK, not only the functions.

import { describe, it, expect, vi, afterAll } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const USERDATA = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join: j } = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { tmpdir: td } = require('node:os') as typeof import('node:os')
  return mk(j(td(), 'tachi-remotion-'))
})

afterAll(() => {
  try { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* best effort */ }
})

vi.mock('electron', () => ({
  app: { getPath: () => USERDATA, isPackaged: false },
  BrowserWindow: class {},
  net: {},
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
}))

import {
  remotionCompositorPkg, remotionBinaryNames, remotionBinariesDir, remotionVersion,
  isRemotionBinariesInstalled, remotionBinariesState, REMOTION_BINARIES_MISSING,
} from '../../electron/services/remotion-binaries-installer'

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
const repoRead = (rel: string): string => readFileSync(resolve(__dirname, '..', '..', '..', '..', rel), 'utf8')

// ── The packaging rules: the whole point ─────────────────────────────────────

describe('the compositor must not be inside the artifact', () => {
  const cfg = read('electron-builder.json')

  it('electron-builder EXCLUDES every platform compositor package', () => {
    expect(cfg).toContain('!**/node_modules/@remotion/compositor-*/**')
  })

  it('…while still unpacking the rest of @remotion, which is ordinary JS', () => {
    // The renderer and bundler still ship; it is only the binaries that leave.
    expect(cfg).toContain('**/node_modules/@remotion/**')
  })

  it('the afterPack hook fails the build if a compositor is present', () => {
    const hook = read('scripts/afterpack-verify.cjs')
    // It used to demand the opposite. Pin the direction, not just the string.
    expect(hook).toContain('is INSIDE the package')
    expect(hook).not.toContain('no compositor-<platform> package (MP4 export ffmpeg missing)')
  })

  it('the afterPack hook scans shipped binaries for the licence string itself', () => {
    // The exclusion names ONE package. This catches any other dependency that
    // vendors a nonfree FFmpeg — the first time it is packaged, not at the next
    // licence audit.
    const hook = read('scripts/afterpack-verify.cjs')
    expect(hook).toContain("Buffer.from('nonfree and unredistributable'")
    expect(hook).toContain('scanForNonfree')
  })
})

// ── One resolver, two render paths ───────────────────────────────────────────

describe('both render paths read ONE resolver', () => {
  const hf = read('electron/services/design-hf-render.ts')
  const rm = read('electron/services/design-render.ts')

  it('neither file keeps its own copy of the platform table any more', () => {
    // Two copies of "which compositor package is this platform" is how the
    // encoder that gets fetched and the encoder that gets spawned drift apart.
    expect(hf).not.toContain("'compositor-win32-x64-msvc'")
    expect(rm).not.toContain("'compositor-win32-x64-msvc'")
  })

  it('both resolve through resolveRemotionBinariesDir', () => {
    expect(hf).toContain('resolveRemotionBinariesDir()')
    expect(rm).toContain('resolveRemotionBinariesDir()')
  })

  it('neither reads app.asar.unpacked for the compositor any more', () => {
    expect(hf).not.toContain("'app.asar.unpacked', 'node_modules', '@remotion'")
    expect(rm).not.toContain("'app.asar.unpacked', 'node_modules', '@remotion'")
  })

  it('the Remotion path refuses BEFORE bundling when the encoder is absent', () => {
    // Spending a bundle and a browser launch to then say "you need a download"
    // is the wrong order, and it is what the old null-return produced.
    expect(rm).toContain('if (!resolveRemotionBinariesDir()) throw new Error(REMOTION_BINARIES_MISSING)')
  })

  it('both describe the situation with the SAME sentence', () => {
    expect(hf).toContain('REMOTION_BINARIES_MISSING')
    expect(rm).toContain('REMOTION_BINARIES_MISSING')
  })
})

// ── The message a user actually sees ─────────────────────────────────────────

describe('the missing-encoder message', () => {
  it('says what to do, what it costs, and why it is not bundled', () => {
    expect(REMOTION_BINARIES_MISSING).toMatch(/Install video encoder/i)
    expect(REMOTION_BINARIES_MISSING).toMatch(/47 MB/)
    expect(REMOTION_BINARIES_MISSING).toMatch(/redistribut/i)
  })

  it('does not blame the user or tell them to reinstall dependencies', () => {
    // The old text was "reinstall dependencies", which is advice a packaged-app
    // user cannot act on at all.
    expect(REMOTION_BINARIES_MISSING).not.toMatch(/reinstall dependencies/i)
  })
})

// ── The install target ───────────────────────────────────────────────────────

describe('where a fetched encoder lives', () => {
  it('names a real per-platform package for this machine', () => {
    expect(remotionCompositorPkg()).toMatch(/^compositor-(win32|darwin|linux)-(x64|arm64)(-msvc|-gnu)?$/)
  })

  it('asks for the three executables Remotion spawns, with the right extension', () => {
    const n = remotionBinaryNames()
    const ext = process.platform === 'win32' ? '.exe' : ''
    expect(n).toEqual({ compositor: `remotion${ext}`, ffmpeg: `ffmpeg${ext}`, ffprobe: `ffprobe${ext}` })
  })

  it('the directory is VERSIONED — a Remotion bump cannot silently reuse old binaries', () => {
    const a = remotionBinariesDir('4.0.490')
    const b = remotionBinariesDir('4.1.0')
    expect(a).not.toBe(b)
    expect(a).toContain('4.0.490')
    expect(a).toContain(remotionCompositorPkg())
  })

  it('the version is the RENDERER\'s, not a number of our own choosing', () => {
    // Remotion refuses a compositor whose version differs from the renderer's.
    const v = remotionVersion()
    expect(v).toMatch(/^\d+\.\d+\.\d+/)
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> }
    const pinned = pkg.dependencies?.['@remotion/renderer']
    expect(pinned, '@remotion/renderer must stay a dependency').toBeTruthy()
    // The pin in package.json is exact for this package; the resolver must agree.
    expect(v).toBe((pinned as string).replace(/^[\^~]/, ''))
  })

  it('reports NOT installed against an empty user directory', () => {
    expect(isRemotionBinariesInstalled()).toBe(false)
  })

  it('the state the UI quotes carries a size and the real package name', () => {
    const st = remotionBinariesState()
    expect(st.installed).toBe(false)
    expect(st.packageName).toBe(`@remotion/${remotionCompositorPkg()}`)
    expect(st.approxBytes).toBeGreaterThan(1024 * 1024)
    expect(st.version).toBe(remotionVersion())
  })
})

// ── The download is a decision, never a side effect ──────────────────────────

describe('consent', () => {
  const svc = read('electron/services/remotion-binaries-installer.ts')

  it('nothing in the render path can call the installer', () => {
    for (const f of ['electron/services/design-render.ts', 'electron/services/design-hf-render.ts']) {
      expect(read(f), f).not.toContain('installRemotionBinaries')
    }
  })

  it('the integrity check happens BEFORE the archive is unpacked', () => {
    // A tarball is executed by `tar`; verifying afterwards is verifying
    // something already on disk.
    expect(svc.indexOf('sha512Base64(tgz)')).toBeGreaterThan(-1)
    expect(svc.indexOf('sha512Base64(tgz)')).toBeLessThan(svc.indexOf('await extractArchive(tgz'))
  })

  it('the tarball URL comes from the registry, never hand-built', () => {
    expect(svc).toContain('registry.npmjs.org')
    expect(svc).toContain('dist.tarball')
    expect(svc).toContain('refusing a non-https tarball URL')
  })

  it('the UI asks before it downloads', () => {
    const page = read('src/pages/design/DesignPage.tsx')
    expect(page).toContain('data-testid="install-encoder"')
    expect(page).toContain("t('artifact.encoderInstallTitle')")
    // …and the export button is only offered once something is usable.
    expect(page).toContain('encoder && !encoder.installed')
  })
})

// ── The line-ending policy that made every commit noisy ──────────────────────

describe('.gitattributes', () => {
  it('exists and normalises text to LF', () => {
    const attrs = repoRead('.gitattributes')
    expect(attrs).toContain('* text=auto eol=lf')
    // Windows-only script formats that genuinely need CRLF stay CRLF.
    expect(attrs).toContain('*.bat  text eol=crlf')
  })
})

// ── The release feed ─────────────────────────────────────────────────────────

describe('a tagged build can actually attach something', () => {
  it('publish is a github provider, not null', () => {
    const cfg = JSON.parse(read('electron-builder.json')) as { publish?: unknown }
    expect(cfg.publish).not.toBeNull()
    expect(Array.isArray(cfg.publish)).toBe(true)
    const first = (cfg.publish as Array<{ provider?: string; releaseType?: string }>)[0]
    expect(first.provider).toBe('github')
    expect(first.releaseType).toBe('draft')
  })

  it('the repository is declared in package.json, because a runner cannot infer it', () => {
    // I asserted the opposite here first: that leaving owner/repo out was safer
    // because electron-builder resolves them from .git/config, which
    // actions/checkout writes. THE FIRST REAL RUN DISPROVED IT — all three
    // platforms died at the publish step with
    //   "Cannot detect repository by .git/config. Please specify \"repository\"
    //    in the package.json"
    // after a full compile. The error names its own fix, and a repository URL is
    // public information, not a credential.
    const pkg = JSON.parse(read('package.json')) as { repository?: { url?: string }; homepage?: string }
    expect(pkg.repository?.url, 'electron-builder needs this to publish').toMatch(/^https:\/\/github\.com\/.+\.git$/)
    expect(pkg.homepage).toMatch(/^https:\/\/github\.com\//)
  })

  it('the release workflow may write releases, and can be rehearsed', () => {
    const wf = repoRead('.github/workflows/release.yml')
    expect(wf).toContain('permissions:')
    expect(wf).toContain('contents: write')
    expect(wf).toContain('workflow_dispatch:')
  })
})

// ── PORTABLE MODE: the folder that touches nothing else ──────────────────────
//
// The owner asked for two Windows artifacts: an installer, and an app FOLDER
// that uses neither the C: drive nor his Documents. The split this app ships by
// default puts user content in Documents\Tachi Studio and internals (settings,
// keys, sidecar binaries, model weights) in %APPDATA% — correct for an install,
// wrong for a folder you unzip and carry.

describe('portable mode', () => {
  const svc = read('electron/services/portable-mode.ts')

  it('is opt-in by a marker, never guessed from writability', () => {
    // Guessing would give a user who unzipped to their Desktop a different data
    // location than the same build installed normally, with no way to tell.
    expect(svc).toContain("export const PORTABLE_MARKER = 'tachi-data'")
    expect(svc).toContain('statSync(dir).isDirectory()')
  })

  it('redirects userData AND the Chromium session, not just userData', () => {
    // Leaving sessionData behind would keep a cache in the user profile —
    // exactly the footprint portable mode exists to avoid.
    expect(svc).toContain("app.setPath('userData', userData)")
    expect(svc).toContain('sessionData')
    expect(svc).toContain('crashDumps')
  })

  it('deliberately does NOT move temp', () => {
    expect(svc).toMatch(/temp` is deliberately NOT|temp\b[^\n]*not\s+moved/i)
  })

  it('falls back to the normal locations instead of refusing to start', () => {
    expect(svc).toContain('using the normal locations')
  })

  it('loads before anything that can compute a path', () => {
    const main = read('electron/main.ts')
    const portable = main.indexOf("import './services/portable-mode'")
    const esbuild  = main.indexOf("import './services/esbuild-binary-path'")
    expect(portable).toBeGreaterThan(-1)
    expect(portable).toBeLessThan(esbuild)
  })

  it('user content follows the portable folder too', () => {
    const sr = read('electron/services/storage-root.ts')
    expect(sr).toContain('const portable = portableStorageRoot()')
    expect(sr).toContain('if (portable) return portable')
  })

  it('Windows builds BOTH an installer and a zipped app folder', () => {
    const cfg = JSON.parse(read('electron-builder.json')) as {
      win?: { target?: Array<{ target?: string }> }
    }
    const targets = (cfg.win?.target ?? []).map(t => t.target)
    expect(targets).toContain('nsis')
    expect(targets).toContain('zip')
  })

  it('the zip is checksummed in CI, not only the installer', () => {
    const wf = repoRead('.github/workflows/release.yml')
    expect(wf).toContain('Get-ChildItem *.exe, *.zip')
  })
})

// ── The onnxruntime filter that blocked mac and linux ────────────────────────
//
// One glob in the platform-NEUTRAL `files` array pruned the darwin and linux
// binaries on every build — including the darwin build and the linux build,
// which need exactly those. The first real CI run proved it on ubuntu:
//
//     - onnxruntime-node target platform: MISSING …/napi-v3/linux
//     - must-not-ship [onnxruntime-foreign-platform]: …/napi-v3/win32/x64/…
//
// It is now per-platform. Safe because app-builder-lib MERGES them:
// fileMatcher.js:250-253 calls addPatterns(config.files) and then
// addPatterns(platformOptions.files) onto the same matcher, so a platform block
// of pure negations narrows the shared whitelist instead of replacing it.

describe('onnxruntime is pruned in the TOP-LEVEL files list', () => {
  const cfg = JSON.parse(read('electron-builder.json')) as {
    files: string[]
    win?: { files?: string[] }; mac?: { files?: string[] }; linux?: { files?: string[] }
  }
  const ORT = '!**/node_modules/onnxruntime-node/bin/napi-v3/'

  // THIS FILE USED TO ASSERT THE OPPOSITE, and the opposite was wrong.
  //
  // The pruning was moved into per-platform `files` blocks so each build could
  // drop the two platforms it is not. Those blocks held nothing but negations,
  // and app-builder-lib gives a matcher with no inclusion pattern the default
  // `**/*` — so the top-level whitelist ("out/**/*" + package.json) stopped
  // applying entirely. Measured on a real package: app.asar went to 4613 MB and
  // carried src, electron, test, e2e and three stale build directories.
  //
  // Windows is the only platform packaged today, so the exclusions live in the
  // one list that cannot collapse. The invariant that keeps this from coming
  // back is in builderFilesWhitelist.test.ts: a platform block that narrows the
  // file set must also carry what to include.

  it('prunes the foreign platforms from the shared list', () => {
    const ort = cfg.files.filter(f => f.startsWith(ORT))
    expect(ort.length, 'the shared list is where the pruning lives now').toBeGreaterThan(0)
    const joined = ort.join(' ')
    expect(joined).toContain('darwin')
    expect(joined).toContain('linux')
  })

  it("never excludes the shipping platform's own binaries", () => {
    const joined = cfg.files.filter(f => f.startsWith(ORT)).join(' ')
    // win32/arm64 is a different ARCH of the same platform and may be pruned;
    // `win32/**` would take the binaries this build actually runs on.
    expect(joined, 'excluding win32 wholesale is what broke the build that shipped').not.toContain('win32/**')
  })

  it('no platform block re-introduces the collapse', () => {
    for (const platform of ['win', 'mac', 'linux'] as const) {
      const patterns = cfg[platform]?.files
      if (!patterns) continue
      expect(
        patterns.some(pat => !pat.startsWith('!')),
        `${platform}.files is negations-only — that is the collapse`,
      ).toBe(true)
    }
  })
})
