#!/usr/bin/env node
/**
 * scripts/download-sidecars.mjs
 *
 * Fetches and builds the two sidecar dependencies for Tachi Studio:
 *   1. freellmapi  — clones source, runs npm install + build
 *
 * The Goose harness was REMOVED from the product, so this script no longer
 * downloads any binary. NOTE: an older run may have left ~225 MB in
 * apps/desktop/resources/sidecars/goose/ — nothing reads it, the installer
 * filter + the asar-report `goose-bundled` rule keep it out of packages, and it
 * is safe to delete by hand.
 *
 * Run:
 *   node scripts/download-sidecars.mjs
 *   # or via pnpm from repo root:
 *   pnpm prepare:sidecars
 */

import { execSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, renameSync, createWriteStream, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { get as httpsGet } from 'https'

const __dirname    = dirname(fileURLToPath(import.meta.url))
const RESOURCES    = join(__dirname, '..', 'apps', 'desktop', 'resources', 'sidecars')
const FREELLMAPI   = join(RESOURCES, 'freellmapi')
const FREELLMAPI_REPO = 'https://github.com/tashfeenahmed/freellmapi'
// Pinned commit (audit S2): the vendor patch below was authored against this
// exact base, so the clone is checked out here before patching — reproducible
// and not upstream-writable. Bump deliberately + re-verify the patch applies.
const FREELLMAPI_COMMIT = '2121550'

// Vendor patches applied on top of the pinned commit, IN ORDER — read from
// scripts/patches/manifest.json, the ONE place the list and its proof markers
// live. freellmapi-installer.ts reads the same file from the packaged copy, so
// the package-time build and the runtime-install fallback can never drift.
const PATCHES_DIR = join(__dirname, 'patches')
const MANIFEST    = join(PATCHES_DIR, 'manifest.json')
/** Loaded from the manifest during the patch step; re-read after the build. */
let freellmapiPatches = []

// ─── helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

/**
 * `git apply --check` without inheriting stdio — we need its EXIT CODE and its
 * stderr, not a pretty log. Returns { code, stderr }.
 */
function gitApplyCheck(patchPath, cwd) {
  const r = spawnSync('git', ['apply', '--check', patchPath], { cwd, encoding: 'utf8' })
  return { code: r.status, stderr: `${r.stderr ?? ''}${r.error ? r.error.message : ''}` }
}

/**
 * Classify what `git apply --check` just told us. THREE outcomes, and the whole
 * bug this replaces came from collapsing them into one `catch`:
 *
 *   'pending'  exit 0 — the patch applies cleanly, i.e. it is NOT yet in the
 *              tree. Apply it.
 *   'applied'  exit != 0 because the changes are already there ("already
 *              exists", "reversed", "patch does not apply" on an identical
 *              hunk). Skip, and say SKIPPED, not "applied".
 *   'error'    anything else — a corrupt patch, a moved file, a base drift.
 *              LOUD, and fatal.
 *
 * "patch does not apply" is genuinely ambiguous between already-applied and
 * base-drift, and this function does NOT resolve it. The marker verification
 * that runs immediately after does: a drifted base leaves the markers absent
 * and fails the build. Classification decides whether to RUN `git apply`;
 * markers decide whether the result is acceptable.
 */
export function classifyApplyCheck({ code, stderr }) {
  if (code === 0) return 'pending'
  const s = stderr.toLowerCase()
  const alreadyThere =
    s.includes('already exists') ||
    s.includes('reverse') ||
    s.includes('patch does not apply')
  return alreadyThere ? 'applied' : 'error'
}

/**
 * The proof step. A patch that "applied" without leaving its marker behind did
 * not do what the manifest says it does — treat that as a build failure, not a
 * log line. Returns the markers that are MISSING (empty array == verified).
 */
export function missingMarkers(treeDir, markers) {
  const missing = []
  for (const m of markers ?? []) {
    const file = join(treeDir, ...m.path.split('/'))
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { missing.push(`${m.path} (unreadable)`); continue }
    if (!text.includes(m.contains)) missing.push(`${m.path} :: ${m.contains}`)
  }
  return missing
}

function spawnNpm(args, cwd) {
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
    { cwd, stdio: 'inherit', shell: process.platform === 'win32' }
  )
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (exit ${result.status})`)
}

// All GitHub URLs are HTTPS; redirects stay on HTTPS — httpsGet is sufficient.
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    function request(currentUrl) {
      httpsGet(currentUrl, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          request(res.headers.location)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${currentUrl}`))
          return
        }
        const tmp = destPath + '.tmp'
        const out = createWriteStream(tmp)
        res.pipe(out)
        out.on('finish', () => { out.close(); renameSync(tmp, destPath); resolve() })
        out.on('error', reject)
      }).on('error', reject)
    }
    request(url)
  })
}

// ─── freellmapi ───────────────────────────────────────────────────────────────

async function prepareFreellmapi() {
  console.log('\n[freellmapi] Preparing...')
  mkdirSync(RESOURCES, { recursive: true })

  if (!existsSync(join(FREELLMAPI, '.git'))) {
    console.log(`[freellmapi] Cloning ${FREELLMAPI_REPO} @ ${FREELLMAPI_COMMIT} ...`)
    // No --depth: a shallow clone can't checkout an arbitrary pinned commit.
    // Pinning to a COMMIT (not a branch) makes the build reproducible and
    // closes the "upstream rewrites main under us" hole (audit S2).
    run(`git clone ${FREELLMAPI_REPO} "${FREELLMAPI}"`)
    run(`git checkout ${FREELLMAPI_COMMIT}`, { cwd: FREELLMAPI })
  } else {
    // Existing clone: ensure it's parked on the pinned commit (best-effort —
    // a clone carrying our vendor patch has diverged, so this may no-op).
    console.log(`[freellmapi] Existing clone — pinning to ${FREELLMAPI_COMMIT} ...`)
    try { run(`git checkout ${FREELLMAPI_COMMIT}`, { cwd: FREELLMAPI }) }
    catch { console.warn('[freellmapi] checkout skipped (local vendor commits present)') }
  }

  // Vendor patches: TachiDesk additions that are not upstream. ORDER MATTERS —
  // each is authored against the tree with the previous ones applied.
  //
  // THIS BLOCK USED TO BE THE BUG. It ran `git apply --check` inside a `try`
  // and logged "already present — skipping" from the `catch`, which meant a
  // patch that FAILED to apply and a patch that was already applied produced
  // the identical, reassuring line. On 2026-08-01 an installer shipped without
  // patch #2 — the step was simply never run — and nothing anywhere said so.
  // Verified after the fact: `git apply --check` of that patch against the
  // shipped tree exited 0, so it would have applied; there was no breakage to
  // find, only silence.
  //
  // Now: three outcomes, not two, and a proof step after the apply. A real
  // failure is loud AND fatal — a half-patched relay must never reach a package.
  if (!existsSync(MANIFEST)) {
    throw new Error(
      `Vendor patch manifest missing: ${MANIFEST}. It is the ordered source of truth for the `
      + `freellmapi patches; without it this build cannot know what the relay is supposed to contain.`,
    )
  }
  const patches = JSON.parse(readFileSync(MANIFEST, 'utf8')).patches
  if (!Array.isArray(patches) || patches.length === 0) {
    throw new Error(`Vendor patch manifest ${MANIFEST} lists no patches.`)
  }
  freellmapiPatches = patches

  for (const entry of patches) {
    const { file, what, markers } = entry
    const patch = join(PATCHES_DIR, file)
    if (!existsSync(patch)) {
      throw new Error(
        `Vendor patch MISSING: ${file} (expected at ${patch}). The manifest requires it; `
        + `building without it would ship a relay that silently lacks: ${what}.`,
      )
    }

    const check   = gitApplyCheck(patch, FREELLMAPI)
    const verdict = classifyApplyCheck(check)
    if (verdict === 'error') {
      const { stderr } = check
      throw new Error(
        `Vendor patch ${file} CANNOT be applied and is not already present.\n`
        + `git apply --check said:\n${stderr.trim()}\n`
        + `The pinned base (${FREELLMAPI_COMMIT}) or the patch has drifted. Fix the patch — do not ship without it.`,
      )
    }
    if (verdict === 'pending') {
      run(`git apply "${patch}"`, { cwd: FREELLMAPI })
      console.log(`[freellmapi] vendor patch APPLIED (${what})`)
    } else {
      console.log(`[freellmapi] vendor patch already in tree — SKIPPED (${what})`)
    }

    // Proof. Whether we just applied it or found it already there, the tree
    // must now carry what the manifest says this patch introduces.
    const missing = missingMarkers(FREELLMAPI, markers)
    if (missing.length > 0) {
      throw new Error(
        `Vendor patch ${file} did not leave its marks on the tree — the relay is NOT what this build claims.\n`
        + missing.map(m => `  missing: ${m}`).join('\n')
        + `\nRun with a clean clone (delete ${FREELLMAPI}) and try again.`,
      )
    }
    console.log(`[freellmapi] vendor patch VERIFIED — ${markers.length} marker(s) present (${file})`)
  }

  console.log('[freellmapi] Installing dependencies...')
  spawnNpm(['install'], FREELLMAPI)

  console.log('[freellmapi] Building...')
  spawnNpm(['run', 'build:server'], FREELLMAPI)

  const entry = join(FREELLMAPI, 'server', 'dist', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(
      `Expected ${entry} after build. ` +
      `Check freellmapi's package.json "build" script and ensure it outputs to dist/.`
    )
  }

  // SECOND PROOF, and the one that matters at runtime: server/dist is what the
  // app actually spawns. A tree whose SOURCE is patched but whose dist is stale
  // would have passed every check above while serving the old relay — a green
  // build on the wrong artifact is the same lie in a different place.
  for (const { file, what, builtMarkers } of freellmapiPatches) {
    const missing = missingMarkers(FREELLMAPI, builtMarkers)
    if (missing.length > 0) {
      throw new Error(
        `The BUILT relay (server/dist) does not carry ${file} — the source was patched but the build is stale.\n`
        + missing.map(m => `  missing: ${m}`).join('\n')
        + `\nDelete ${join(FREELLMAPI, 'server', 'dist')} and re-run, so "${what}" is actually compiled in.`,
      )
    }
  }
  console.log('[freellmapi] built relay VERIFIED against every vendor patch')

  // Build the dashboard client HERE so a packaged app never needs npm on the
  // user's machine (startFreellmapi used to auto-build it at runtime — that
  // path is now dev-only).
  //
  // ITS FAILURE MUST NOT FAIL THE RELEASE. This is a third-party repository's own
  // build, with its own unpinned dependencies, and it broke the first real CI run
  // on Windows while passing on macOS in the same run:
  //
  //     CssSyntaxError: [postcss] client/src/index.css:2:3303:
  //     `@layer base` is used but no matching `@tailwind base` directive
  //
  //     — a Tailwind major drifting under a `npm install` we do not control.
  //
  // What this builds is the sidecar's OPTIONAL dashboard page. The RELAY — the
  // part the app actually talks to — is built and verified against every vendor
  // patch above, before this line. Letting someone else's CSS toolchain block a
  // release of ours is the wrong trade, so a failure here is loud and survivable:
  // the app works, the sidecar's own dashboard page is simply absent.
  //
  // THE REAL FIX is upstream of this file — fork the sidecar repo and pin it by
  // full SHA with a lockfile, so its build is reproducible. Recorded in
  // notes/RELEASE-READINESS-2026-08-05.md.
  const clientDir  = join(FREELLMAPI, 'client')
  const clientDist = join(clientDir, 'dist', 'index.html')
  if (existsSync(clientDir) && !existsSync(clientDist)) {
    console.log('[freellmapi] Building dashboard client...')
    try {
      spawnNpm(['run', 'build'], clientDir)
    } catch (err) {
      console.warn(
        [
          '[freellmapi] WARNING: the dashboard client did not build: ' + String(err && err.message ? err.message : err),
          '[freellmapi] Continuing: the relay is built and verified; only the dashboard',
          '[freellmapi] page of the sidecar will be missing. See the note above this line.',
        ].join('\n'),
      )
    }
  }

  // Diet: drop dev-only deps (tsc, vite, test tooling) from the tree that ships
  // inside the installer — measured 619 MB before pruning. Build steps above are
  // done, so only runtime deps are needed from here on.
  console.log('[freellmapi] Pruning dev dependencies...')
  spawnNpm(['prune', '--omit=dev'], FREELLMAPI)

  // …and the sourcemaps its build emits. The electron-builder extraResources
  // filter already lists `!**/*.map`, and the first real CI run still found 46 of
  // them under resources/sidecars/freellmapi/server/dist — so the copy filter is
  // not catching what this tree produces. Deleting them here is deterministic and
  // does not depend on glob semantics we would have to keep re-deriving.
  // A .map has no runtime role; the must-not-ship rule exists because they once
  // added 225.8 MB to an installer.
  let mapsRemoved = 0
  const dropMaps = (dir, depth) => {
    if (depth > 8) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) { dropMaps(full, depth + 1); continue }
      if (!e.name.endsWith('.map')) continue
      try { rmSync(full, { force: true }); mapsRemoved++ } catch { /* best effort */ }
    }
  }
  dropMaps(FREELLMAPI, 0)
  console.log(`[freellmapi] removed ${mapsRemoved} sourcemap(s)`)

  // KEYLESS FIRST-RUN (P0): rebuild native addons (better-sqlite3) for the
  // ELECTRON ABI, then stamp the tree. The app then spawns the sidecar via its
  // own binary with ELECTRON_RUN_AS_NODE=1 — so end users need NO system
  // Node.js at all. prebuild-install honors npm_config_runtime/target, so this
  // usually downloads a prebuilt .node without needing a compiler.
  const electronVersion = getElectronVersion()
  console.log(`[freellmapi] Rebuilding native addons for Electron ${electronVersion} ABI...`)

  // Electron 43 (NODE_MODULE_VERSION 148): the sidecar's pinned tree carries
  // better-sqlite3 12.9.0, whose release has NO v148 prebuild — and this
  // machine class has no Visual Studio, so the gyp fallback dies. 12.11.2+
  // ships the v148 prebuild but is (as of 2026-07) GitHub-release-only, not on
  // npm — install straight from the release tarball (its postinstall then
  // downloads the prebuilt .node; no compiler needed). Its own node-abi copy
  // must also be new enough to map 43.x → 148.
  const BSQ_FIX = 'https://github.com/WiseLibs/better-sqlite3/archive/refs/tags/v12.11.2.tar.gz'
  const bsqPkg = join(FREELLMAPI, 'node_modules', 'better-sqlite3', 'package.json')
  let bsqVersion = ''
  try { bsqVersion = JSON.parse(readFileSync(bsqPkg, 'utf8')).version } catch { /* not installed yet */ }
  if (bsqVersion !== '12.11.2') {
    console.log(`[freellmapi] better-sqlite3 ${bsqVersion || '(none)'} → 12.11.2 (Electron-43 prebuild)...`)
    spawnNpm(['install', 'node-abi@latest', '--save-exact', '--no-audit', '--no-fund'], FREELLMAPI)
    spawnNpm(['install', BSQ_FIX, '--no-audit', '--no-fund'], FREELLMAPI)
  }
  // npm no longer forwards unknown --flags, but prebuild-install DOES read the
  // npm_config_* env vars — set them explicitly so the rebuild really targets
  // the Electron ABI (verified: the flag form silently no-ops on npm 10+).
  const rebuildEnv = {
    ...process.env,
    npm_config_runtime: 'electron',
    npm_config_target:  electronVersion,
    npm_config_disturl: 'https://electronjs.org/headers',
  }
  const rb = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['rebuild', 'better-sqlite3'],
    { cwd: FREELLMAPI, stdio: 'inherit', shell: process.platform === 'win32', env: rebuildEnv }
  )
  if (rb.status !== 0) throw new Error(`electron-ABI rebuild failed (exit ${rb.status})`)
  writeFileSync(join(FREELLMAPI, '.abi'), `electron-${electronVersion}\n`, 'utf8')

  console.log(`[freellmapi] ✓ Ready at ${entry} (electron-ABI)`)
}

/** Exact installed Electron version (node_modules) — fallback: strip the range prefix. */
function getElectronVersion() {
  const installed = join(__dirname, '..', 'apps', 'desktop', 'node_modules', 'electron', 'package.json')
  if (existsSync(installed)) {
    return JSON.parse(readFileSync(installed, 'utf8')).version
  }
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'apps', 'desktop', 'package.json'), 'utf8'))
  const range = pkg.devDependencies?.electron ?? pkg.dependencies?.electron
  if (!range) throw new Error('Cannot determine Electron version for the ABI rebuild.')
  return range.replace(/^[\^~>=]+/, '')
}


// ─── main ─────────────────────────────────────────────────────────────────────

// Guarded so the patch-classification helpers above can be imported and tested
// without cloning or building anything. The classifier is the heart of the fix
// for the "already present — skipping" bug; an untested classifier would be a
// poor place to put that much trust.
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  ;(async () => {
    try {
      await prepareFreellmapi()
      console.log('\n✅ All sidecars ready.\n')
    } catch (err) {
      console.error('\n❌ Sidecar setup failed:', err.message || err)
      process.exit(1)
    }
  })()
}
