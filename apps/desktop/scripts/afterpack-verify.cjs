// apps/desktop/scripts/afterpack-verify.cjs
//
// electron-builder afterPack hook (STEAL 2026-07-08, Recordly pattern):
// walk the freshly-PACKED app dir and assert every load-bearing binary and
// resource exists at the path the runtime resolves it from. This is a direct
// guard on TachiDesk's proven bug class — THREE asar-binary bugs (inngest
// peer, esbuild env, Remotion binariesDirectory) shipped and were only found
// by manually installing the NSIS build. A missing asarUnpack entry or a
// filtered-out sidecar now FAILS the package step instead of the user's launch.
//
// Since 2026-07-26 it is also the SIZE gate (PLAN RELIABILITY+GROWTH R5). Two
// halves, because either alone is weak:
//   1. a total-bytes budget (PACKAGE_MAX_MB) — catches slow drift;
//   2. a must-not-be-present path list — catches a swap-one-for-another
//      regression that keeps the total flat, and names the offending path.
// The path list is shared with `asar-report.mjs` so the archive interior (which
// a filesystem walk cannot see) is held to the same rules.
//
// Throwing here aborts electron-builder, so a broken package never produces an
// installer. Pure fs + path; no deps.

const { existsSync, statSync, lstatSync, readdirSync, readFileSync, rmSync } = require('node:fs')
const { join, relative, sep } = require('node:path')
const { pathToFileURL } = require('node:url')

// Total unpacked budget. Measured 2026-07-26: 2514.0 MB before the installer
// diet, 1720.0 MB after wave 1 (R1-R5). Wave 2 removes another ~350 MB, both
// halves measured against that package rather than estimated: R7 dropped goose
// (225.0 MB of extraResources on disk; the harness has since been REMOVED from
// the product outright) and R6 the
// onnxruntime-web browser wasm builds (125.4 MB inside app.asar, 7 files) —
// projecting ~1370 MB. 1500 is the gate line: ~130 MB of headroom, the same
// margin wave 1 shipped with, so a regression names itself before an installer
// is produced. Override for a deliberate, explained jump:
// PACKAGE_MAX_MB=2000 pnpm package. 0 disables the budget entirely.
const DEFAULT_PACKAGE_MAX_MB = 1500

const toPosix = p => p.split(sep).join('/')
const mb = bytes => `${(bytes / 1024 / 1024).toFixed(2)} MB`

/** Recursively collect { relPath, size } for every regular file under dir. */
function walkFiles(dir, root = dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) }
  catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    let st
    try { st = lstatSync(full) } catch { continue }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) walkFiles(full, root, out)
    else if (st.isFile()) out.push({ path: toPosix(relative(root, full)), size: st.size })
  }
  return out
}

/** Heaviest `limit` directories at `depth` segments, so a regression names itself. */
function topDirectories(files, depth = 4, limit = 15) {
  const totals = new Map()
  for (const f of files) {
    const prefix = f.path.split('/').slice(0, depth).join('/')
    const cur = totals.get(prefix) ?? { prefix, bytes: 0, count: 0 }
    cur.bytes += f.size
    cur.count += 1
    totals.set(prefix, cur)
  }
  return [...totals.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit)
}

/** @param {import('electron-builder').AfterPackContext} context */
module.exports = async function afterPackVerify(context) {
  const { appOutDir, electronPlatformName } = context
  const resources = join(appOutDir, electronPlatformName === 'darwin'
    ? // mac: <appOutDir>/<ProductName>.app/Contents/Resources
      readdirSync(appOutDir).find(n => n.endsWith('.app')) ? `${readdirSync(appOutDir).find(n => n.endsWith('.app'))}/Contents/Resources` : 'Resources'
    : 'resources')
  const unpacked = join(resources, 'app.asar.unpacked', 'node_modules')

  const problems = []
  const requireExists = (label, p) => { if (!existsSync(p)) problems.push(`${label}: MISSING ${p}`) }
  const requireNonEmptyDir = (label, p) => {
    if (!existsSync(p)) { problems.push(`${label}: MISSING ${p}`); return }
    try { if (statSync(p).isDirectory() && readdirSync(p).length === 0) problems.push(`${label}: EMPTY ${p}`) }
    catch (e) { problems.push(`${label}: unreadable ${p} (${e.message})`) }
  }

  // 1. The asar itself.
  requireExists('app.asar', join(resources, 'app.asar'))

  // 2. asarUnpack'd native/spawned modules — the exact set from
  //    electron-builder.json. A missing one = the packaged-only stall class.
  for (const mod of ['node-pty', 'esbuild', 'onnxruntime-node', 'node-sqlite3-wasm', 'puppeteer-core', 'pdfjs-dist']) {
    requireNonEmptyDir(`asarUnpack ${mod}`, join(unpacked, mod))
  }
  requireNonEmptyDir('asarUnpack @remotion', join(unpacked, '@remotion'))

  // 2a. THE COMPOSITOR MUST **NOT** SHIP. This assertion used to run the other
  //     way — it demanded the platform compositor be present, because that is
  //     where the MP4 export's ffmpeg lived. Then a grep of the artifact we were
  //     about to publish found, inside avcodec-60/61 and avformat-60/61:
  //
  //         libavcodec license: nonfree and unredistributable
  //
  //     which is FFmpeg's own statement about its own bytes when built with
  //     --enable-nonfree. Shipping it made us the distributor of something that
  //     says it may not be distributed, under a page that says MIT. The package
  //     is now excluded from `files` and fetched at runtime from npm on an
  //     explicit user click (remotion-binaries-installer.ts).
  //
  //     The check is inverted rather than deleted BECAUSE a build config is one
  //     careless line away from putting it back, and nothing else in the repo
  //     would notice.
  const remotionDir = join(unpacked, '@remotion')
  if (existsSync(remotionDir)) {
    const compositor = readdirSync(remotionDir).find(n => n.startsWith('compositor-'))
    if (compositor) {
      problems.push(
        `@remotion/${compositor} is INSIDE the package. Its FFmpeg reports ` +
        `"nonfree and unredistributable"; it must be fetched at runtime, not shipped. ` +
        `Check the "!**/node_modules/@remotion/compositor-*/**" rule in electron-builder.json.`,
      )
    }
  }

  // 2b. …AND NOTHING ELSE MAY SMUGGLE ONE IN. The rule above names one package;
  //     this reads the actual bytes, so a different dependency that vendors a
  //     nonfree FFmpeg is caught the first time it is packaged rather than by
  //     the next licence audit. Scoped to the unpacked native tree (where such
  //     binaries have to live to be spawnable) and capped, so packaging stays
  //     fast.
  const NONFREE = Buffer.from('nonfree and unredistributable', 'latin1')
  const scanned = []
  const scanForNonfree = (dir, depth) => {
    if (depth > 6 || scanned.length > 4000) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) { scanForNonfree(full, depth + 1); continue }
      if (!/\.(dll|so|dylib|exe|node)$/i.test(e.name) && e.name.indexOf('.') !== -1) continue
      let st
      try { st = statSync(full) } catch { continue }
      if (!st.isFile() || st.size < 1024 * 1024) continue   // the string lives in big codec libs
      scanned.push(full)
      try {
        if (readFileSync(full).includes(NONFREE)) {
          problems.push(
            `${full.slice(resources.length)} contains "nonfree and unredistributable" — ` +
            `this binary states it may not be redistributed and must not be inside a published artifact.`,
          )
        }
      } catch { /* unreadable is not evidence of a violation */ }
    }
  }
  if (existsSync(unpacked)) scanForNonfree(unpacked, 0)

  // 2c. onnxruntime-node keeps ONLY this platform's binaries (R3), pruned by the
  //     `files` negations in electron-builder.json. This asserts the one we still
  //     need did not get pruned along with them. RAG (`rag-service.ts`) is the
  //     consumer.
  //
  //     ── THE MAC/LINUX BLOCKER, AND WHY IT IS NOT FIXED HERE ────────────────
  //
  //     Those negations are platform-NEUTRAL:
  //
  //         "!**/node_modules/onnxruntime-node/bin/napi-v3/{darwin,linux}/**"
  //
  //     so a macOS or Linux build prunes the very binaries it needs, and this
  //     assertion then aborts the package after a full compile. That is the one
  //     hard blocker standing between this repo and a mac or linux artifact.
  //
  //     IT CANNOT BE FIXED BY PRUNING HERE. That was tried (2026-08-05) and the
  //     package failed: onnxruntime-node is asarUnpack'd, and an unpacked file
  //     still carries an ENTRY in the asar header. Deleting the bytes in
  //     afterPack leaves a header promising 11 files, 140.58 MB, that are not
  //     there — which the must-not-ship check below correctly rejected. Anything
  //     that removes a file from the package has to run BEFORE the archive is
  //     written, i.e. in `files`.
  //
  //     THE TWO REAL OPTIONS:
  //       (a) per-platform `files` inside the win/mac/linux blocks, each listing
  //           the foreign platforms — but a platform block whose `files` holds
  //           ONLY negations COLLAPSES the whitelist (this repo has stepped on
  //           that before; see CONTINUE-2026-07-27), so each block must repeat
  //           the positive entries too;
  //       (b) move the whole config to electron-builder.config.js and compute
  //           `files` from the target platform — which reintroduces the JS/JSON
  //           two-config drift that d0f6a341 deliberately removed.
  //     Either way it needs a real mac or linux build to verify, which is why it
  //     is written down rather than guessed at from Windows.
  const ortArch = context.arch === 3 /* arm64 */ ? 'arm64' : context.arch === 1 /* x64 */ ? 'x64' : null
  const ortPlatformDir = join(unpacked, 'onnxruntime-node', 'bin', 'napi-v3', electronPlatformName)
  requireNonEmptyDir('onnxruntime-node target platform', ortPlatformDir)
  if (ortArch && existsSync(ortPlatformDir)) {
    requireNonEmptyDir(`onnxruntime-node ${electronPlatformName}/${ortArch}`, join(ortPlatformDir, ortArch))
  }

  // 3. Bundled sidecars in extraResources — the keyless first-run depends on
  //    the freellmapi build being present with its dist output.
  //    NOTE: goose is deliberately NOT asserted here. The Goose harness was
  //    REMOVED from the product (TACHI supersedes it), so it moved from
  //    "must be present" to "must NOT be present" — see the `goose-bundled`
  //    must-not-ship rule below, which is now a permanent regression guard
  //    against a stale `resources/sidecars/goose/` left on a dev machine.
  const freellm = join(resources, 'sidecars', 'freellmapi')
  requireNonEmptyDir('sidecar freellmapi', freellm)
  requireExists('freellmapi server dist', join(freellm, 'server', 'dist'))
  // The client build toolchain is pruned from the package (R4b), so the prebuilt
  // SPA has to be there — `sidecar-manager.ts` only rebuilds it in dev.
  //
  // A WARNING, NOT A FAILURE, and only since 2026-08-20. That SPA is built by a
  // THIRD-PARTY repository's own toolchain, cloned at a SHA we pin but with
  // dependencies we do not: the first real CI run had it fail on Windows
  // (`CssSyntaxError: @layer base is used but no matching @tailwind base`) while
  // passing on macOS in the SAME run. download-sidecars.mjs now survives that,
  // and this assertion has to agree or "survivable" means nothing.
  //
  // What is lost when it is absent: the sidecar's own dashboard PAGE. The relay —
  // the part the app talks to — is asserted above and is not optional.
  const clientIndex = join(freellm, 'client', 'dist', 'index.html')
  if (!existsSync(clientIndex)) {
    console.warn(
      [
        '[afterpack-verify] WARNING: freellmapi client dist is missing (' + clientIndex + ').',
        '[afterpack-verify] The sidecar relay is present; only its dashboard page will 404.',
        '[afterpack-verify] Cause is upstream: that SPA is built by a third-party repo whose deps we do not pin.',
      ].join('\n'),
    )
  }

  // 4. Must-not-be-present paths, on disk AND inside the asar.
  const { bannedPackageRules, readAsarHeader, flattenAsarEntries, findBannedEntries } =
    await import(pathToFileURL(join(__dirname, 'asar-report.mjs')).href)
  const rules = bannedPackageRules(electronPlatformName)

  const allFiles = walkFiles(appOutDir)
  for (const hit of findBannedEntries(allFiles, rules)) {
    problems.push(
      `must-not-ship [${hit.id}]: ${hit.count} file(s), ${mb(hit.bytes)} on disk — ${hit.label}\n` +
      hit.samples.map(s => `      e.g. ${s}`).join('\n')
    )
  }

  const asarPath = join(resources, 'app.asar')
  if (existsSync(asarPath)) {
    try {
      const { header } = readAsarHeader(asarPath)
      const entries = flattenAsarEntries(header)
      for (const hit of findBannedEntries(entries, rules)) {
        problems.push(
          `must-not-ship [${hit.id}] INSIDE app.asar: ${hit.count} entr(ies), ${mb(hit.bytes)} — ${hit.label}\n` +
          hit.samples.map(s => `      e.g. ${s}`).join('\n')
        )
      }
      // 4b. R6 counterpart: dropping onnxruntime-web's *.wasm must NOT take the
      //     transformers.js NODE build with it — that build is what RAG
      //     (semantic_search) and Kokoro TTS actually load, via onnxruntime-node.
      //     A too-greedy negation here is silent until a user's first RAG query.
      const REQUIRED_IN_ASAR = [
        {
          label: '@huggingface/transformers node build (RAG semantic_search + Kokoro TTS load this)',
          pattern: /@huggingface\/transformers\/dist\/transformers\.node[^/]*\.(c?js|mjs)$/,
        },
      ]
      for (const req of REQUIRED_IN_ASAR) {
        if (!entries.some(e => req.pattern.test(e.path))) {
          problems.push(`required-inside-asar: NO entry matches ${req.pattern} — ${req.label}`)
        }
      }
    } catch (e) {
      problems.push(`app.asar: could not read header for the must-not-ship scan (${e.message})`)
    }
  }

  // 5. Size budget. Deliberately last, so a path-list failure — which names the
  //    cause — is reported alongside it rather than being masked by it.
  const totalBytes = allFiles.reduce((n, f) => n + f.size, 0)
  const maxMb = process.env.PACKAGE_MAX_MB != null
    ? Number(process.env.PACKAGE_MAX_MB)
    : DEFAULT_PACKAGE_MAX_MB
  const budgetEnabled = Number.isFinite(maxMb) && maxMb > 0
  if (budgetEnabled && totalBytes > maxMb * 1024 * 1024) {
    problems.push(
      `package size budget: ${mb(totalBytes)} exceeds PACKAGE_MAX_MB=${maxMb} MB\n` +
      `    heaviest directories:\n` +
      topDirectories(allFiles).map(d => `      ${mb(d.bytes).padStart(12)}  ${String(d.count).padStart(6)} files  ${d.prefix}`).join('\n')
    )
  }

  if (problems.length > 0) {
    const msg =
      `\n[afterpack-verify] PACKAGE FAILED — ${problems.length} problem(s):\n` +
      problems.map(p => `  - ${p}`).join('\n') +
      `\nFix files/asarUnpack/extraResources in electron-builder.json before shipping.\n`
    throw new Error(msg)
  }
  console.log(
    `[afterpack-verify] OK — asar + node-pty,esbuild,onnxruntime-node,node-sqlite3-wasm,puppeteer-core,pdfjs-dist,@remotion + freellmapi all present in ${appOutDir}\n` +
    `[afterpack-verify] size ${mb(totalBytes)} / budget ${budgetEnabled ? `${maxMb} MB` : 'disabled'}; ${rules.length} must-not-ship rules clean (disk + asar)`
  )
}
