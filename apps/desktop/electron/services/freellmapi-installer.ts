// apps/desktop/electron/services/freellmapi-installer.ts
import { existsSync, mkdirSync } from 'fs'
import { join }                  from 'path'
import { spawn }                 from 'child_process'
import { app }                   from 'electron'
import type { BrowserWindow }    from 'electron'
import {
  loadPatchManifest,
  verifyFreellmapiTree,
  logPatchVerdicts,
  type PatchEntry,
  type PatchVerdict,
} from './freellmapi-patches'

// ─── Path helpers ─────────────────────────────────────────────────────────────

function sidecarBase(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'sidecars')
    : join(app.getAppPath(), 'resources', 'sidecars')
}

export function freellmapiDir(): string   { return join(sidecarBase(), 'freellmapi') }
export function freellmapiEntry(): string { return join(freellmapiDir(), 'server', 'dist', 'index.js') }

export function isFreellmapiInstalled(): boolean {
  return existsSync(freellmapiEntry())
}

// ─── Progress push ────────────────────────────────────────────────────────────

export interface InstallProgressEvent {
  step:    'checking' | 'clone' | 'install' | 'build' | 'done' | 'error'
  message: string
  percent: number
}

function push(win: BrowserWindow, event: InstallProgressEvent): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('sidecar:install-progress', event)
  }
}

// ─── Async subprocess runner ──────────────────────────────────────────────────

/**
 * Runs a command asynchronously without blocking the main process.
 * Captures stderr for actionable error messages.
 */
function runAsync(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        const detail = stderr.slice(-2000).trim()
        reject(new Error(`${cmd} ${args[0]} failed (exit ${code})${detail ? `:\n${detail}` : ''}`))
      }
    })
    proc.on('error', reject)
  })
}

/** True iff `cmd` can be spawned (e.g. `git --version` succeeds). */
function _toolAvailable(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
      windowsHide: true,
    })
    proc.on('error', () => resolve(false))
    proc.on('close', code => resolve(code === 0))
  })
}

// ─── Concurrency guard ────────────────────────────────────────────────────────

/** In-flight install promise — prevents concurrent installs. */
let activeInstall: Promise<void> | null = null

// ─── Main installer ───────────────────────────────────────────────────────────

const FREELLMAPI_REPO = 'https://github.com/tashfeenahmed/freellmapi'
// Pinned commit — KEEP IN SYNC with scripts/download-sidecars.mjs (the package-
// time build pins the same base). Closes the "upstream rewrites main under us"
// hole for the runtime-install fallback too.
const FREELLMAPI_COMMIT = '2121550'

// The ordered vendor-patch list is NOT duplicated here any more. It lives in
// scripts/patches/manifest.json (shipped to resources/patches), which is also
// what the package-time build reads — one list, one set of proof markers, no
// "keep in sync" comment to forget.
//
// This used to be the honest gap in this file: the package-time build patched
// the clone and this runtime fallback did not, so a user who landed here got a
// STRICTLY WEAKER free route (no Kilo, no Zen, and the dead ovh/pollinations
// rows still enabled) with nothing anywhere saying so. Patches now ship as an
// extraResource so both paths build the same relay — AND both paths now VERIFY
// the result instead of trusting that an apply step ran.

/**
 * Where the vendor patches live at runtime.
 *   packaged → resources/patches (electron-builder extraResources)
 *   dev      → the repo's scripts/patches, walking up from the app path
 * Returns null when neither exists.
 */
export function patchesDir(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'patches')]
    : [
        join(app.getAppPath(), '..', '..', 'scripts', 'patches'),
        join(app.getAppPath(), 'scripts', 'patches'),
      ]
  return candidates.find(existsSync) ?? null
}

/**
 * Does the relay ON DISK carry the vendor patches?
 *
 * The old check was "does the sidecar exist at all", which fires only when the
 * tree is absent entirely — precisely the case that was NOT the problem. The
 * bug that shipped was a PRESENT tree that was missing half its patches. This
 * answers that question, cheaply (a few substring reads), on any path that
 * cares: the installer before and after it builds, and sidecar startup.
 *
 * `null` means "cannot tell" (no manifest), which is different from "not
 * applied" and must not be reported as either success or failure.
 */
export function verifyInstalledFreellmapiPatches(): PatchVerdict[] | null {
  return verifyFreellmapiTree(patchesDir(), freellmapiDir())
}

/** Convenience for callers that only need the headline. */
export function freellmapiPatchesOk(): boolean | null {
  const verdicts = verifyInstalledFreellmapiPatches()
  if (verdicts === null) return null
  return verdicts.every(v => v.applied)
}

export function installFreellmapi(win: BrowserWindow): Promise<void> {
  if (activeInstall) return activeInstall  // deduplicate concurrent invocations

  activeInstall = _doInstall(win).finally(() => { activeInstall = null })
  return activeInstall
}

async function _doInstall(win: BrowserWindow): Promise<void> {
  const dir = freellmapiDir()

  push(win, { step: 'checking', message: 'Checking…', percent: 0 })

  // PREFLIGHT (P0 stranger first-run): this fallback path builds from source,
  // which needs Git + Node.js/npm on the machine. Fail with an ACTIONABLE
  // message before any half-done clone, not a raw spawn ENOENT afterwards.
  const missing: string[] = []
  if (!(await _toolAvailable('git', ['--version'])))                                  missing.push('Git')
  if (!(await _toolAvailable(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']))) missing.push('Node.js (npm)')
  if (missing.length > 0) {
    const msg =
      `Automatic install needs ${missing.join(' + ')} on this machine. ` +
      `Install ${missing.length > 1 ? 'them' : 'it'} and retry — or skip the local engine and add a provider API key in Settings (cloud providers work without it).`
    push(win, { step: 'error', message: msg, percent: 0 })
    throw new Error(msg)
  }

  // Ensure sidecars/ root exists; git clone will create freellmapi/ itself.
  mkdirSync(sidecarBase(), { recursive: true })

  push(win, { step: 'clone', message: 'Cloning AI engine…', percent: 10 })

  const hasGit  = existsSync(join(dir, '.git'))
  const hasDist = existsSync(freellmapiEntry())

  if (hasGit && !hasDist) {
    // Partial install (clone succeeded, build failed) — remove and re-clone for clean state.
    const { rmSync } = await import('fs')
    rmSync(dir, { recursive: true, force: true })
  }

  if (!existsSync(join(dir, '.git'))) {
    // No --depth: a shallow clone can't checkout an arbitrary pinned commit.
    await runAsync('git', ['clone', FREELLMAPI_REPO, dir])
    await runAsync('git', ['checkout', FREELLMAPI_COMMIT], dir)
  } else {
    // Existing clone: park on the pinned commit (never float with upstream).
    await runAsync('git', ['fetch', '--all'], dir)
    await runAsync('git', ['checkout', FREELLMAPI_COMMIT], dir)
  }

  // Vendor patches — same manifest, same order as the package-time build.
  //
  // The apply step distinguishes THREE outcomes, not two. The old code ran
  // `--check` inside a try and logged "already present — skipping" from the
  // catch, so a genuine failure and an idempotent skip were the same line. Here
  // the result is verified against the manifest's markers afterwards, which is
  // the only thing that actually proves the relay is what we say it is.
  const pDir = patchesDir()
  let manifest: PatchEntry[] = []
  try {
    manifest = pDir ? loadPatchManifest(pDir) : []
  } catch (e) {
    console.error(`[freellmapi-install] vendor patch manifest unreadable: ${String(e)}`)
  }

  if (manifest.length === 0) {
    console.error(
      '[freellmapi-install] vendor patches not found — building the UNPATCHED upstream relay. '
      + 'The free route will lack the Kilo and OpenCode Zen keyless upstreams and will still '
      + 'carry the dead ovh/pollinations rows. This is a degraded install, not a normal one.',
    )
  } else {
    for (const { file, what } of manifest) {
      const patch = join(pDir!, file)
      if (!existsSync(patch)) {
        console.error(`[freellmapi-install] vendor patch FILE MISSING: ${file} — free route will lack: ${what}`)
        continue
      }
      // `--check` exit 0 means NOT YET APPLIED. Any failure means either
      // already-applied or a real error; the marker verification below is what
      // tells those two apart, so neither is silently accepted here.
      let pending = true
      try { await runAsync('git', ['apply', '--check', patch], dir) }
      catch { pending = false }

      if (pending) {
        await runAsync('git', ['apply', patch], dir)
        console.log(`[freellmapi-install] vendor patch APPLIED: ${file}`)
      } else {
        console.log(`[freellmapi-install] vendor patch not applicable (already in tree, or drifted): ${file}`)
      }
    }
    // Proof, not hope. Source-scope here — the build has not run yet.
    logPatchVerdicts('freellmapi-install', verifyFreellmapiTree(pDir, dir, 'source'))
  }

  push(win, { step: 'install', message: 'Installing dependencies…', percent: 40 })
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  await runAsync(npm, ['install', '--prefer-offline'], dir)

  push(win, { step: 'build', message: 'Building…', percent: 75 })
  await runAsync(npm, ['run', 'build:server'], dir)

  if (!existsSync(freellmapiEntry())) {
    throw new Error("Build succeeded but dist/index.js not found. Check freellmapi's build script.")
  }

  // The proof that counts: server/dist is what gets spawned. Source-patched
  // with a stale dist would run the OLD relay while every earlier check reads
  // green — so the same markers are asserted against the compiled output.
  logPatchVerdicts('freellmapi-install(built)', verifyFreellmapiTree(pDir, dir, 'both'))

  push(win, { step: 'done', message: 'AI engine ready!', percent: 100 })
}
