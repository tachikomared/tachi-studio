// apps/desktop/electron/services/codex-installer.ts
//
// Sidecar installer for the OpenAI Codex CLI — the "Codex worker" the TACHI
// harness can delegate coding tasks to (same shape openai/codex-plugin-cc
// gives Claude Code). Follows the openclaude-installer pattern: npm-install a
// PINNED version into <userData>/sidecars/codex, verify by package.json
// version, run via the app's own binary as Node (ELECTRON_RUN_AS_NODE) so the
// user never needs a system Node on PATH at runtime (npm is only needed once,
// at install time — same requirement the OpenClaude sidecar already has).
//
// AUTH deliberately reuses the CLI's own default CODEX_HOME (~/.codex): the
// user logs in once with `codex login` (we spawn it for them — it opens the
// browser) and both our sidecar and any global codex share that session.

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { spawn } from 'child_process'
import type { BrowserWindow } from 'electron'
import { filterEnv } from './util/env-filter'

/** Pinned CLI version — bump here to force a clean reinstall on all clients. */
export const CODEX_VERSION = '0.144.5'

function codexBase(): string {
  return join(app.getPath('userData'), 'sidecars', 'codex')
}

/** The npm package's JS launcher (spawns the platform-native binary itself). */
export function codexJsPath(): string {
  return join(codexBase(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
}

const CODEX_TRIPLES: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

/** The platform-NATIVE codex binary, or null if absent. We spawn it DIRECTLY:
 *  going through codex.js puts a GUI-subsystem node hop (our exe as Node) in
 *  the middle, which does not inherit a console — so the console-subsystem
 *  codex.exe under it got a FRESH console, which Win11's default-terminal
 *  setting materializes as a visible Windows Terminal window (seen live).
 *  A console child spawned directly with windowsHide gets a HIDDEN console
 *  that its own PowerShell descendants inherit — nothing flashes. */
export function codexNativeExePath(): string | null {
  const triple = CODEX_TRIPLES[`${process.platform}-${process.arch}`]
  if (!triple) return null
  const bin = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const platPkg = `@openai/codex-${process.platform}-${process.arch}`
  for (const root of [
    join(codexBase(), 'node_modules', ...platPkg.split('/'), 'vendor'),
    join(codexBase(), 'node_modules', '@openai', 'codex', 'vendor'),
  ]) {
    const p = join(root, triple, 'bin', bin)
    if (existsSync(p)) return p
  }
  return null
}

/** How to launch codex: native binary directly (preferred — see above), or
 *  the JS launcher via our own exe as Node when the native one is missing. */
export function codexLaunchSpec(args: string[]): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {
    ...filterEnv(process.env),
    NO_COLOR: '1',
    // CODEX_HOME passed EXPLICITLY: filterEnv strips it (split-brain seen live).
    CODEX_HOME: resolveCodexHome(),
  }
  const native = codexNativeExePath()
  if (native) return { file: native, args, env }
  return { file: process.execPath, args: [codexJsPath(), ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
}

/** True when the pinned version is fully installed. */
export function isCodexInstalled(): boolean {
  if (!existsSync(codexJsPath())) return false
  try {
    const pkg = JSON.parse(readFileSync(join(codexBase(), 'node_modules', '@openai', 'codex', 'package.json'), 'utf8')) as { version?: string }
    return pkg.version === CODEX_VERSION
  } catch {
    return false
  }
}

/** Spawn the codex CLI headlessly (native binary when present — the JS
 *  launcher hop opened a visible Windows Terminal window, see above). */
export function spawnCodex(args: string[], opts: { cwd?: string } = {}) {
  const spec = codexLaunchSpec(args)
  return spawn(spec.file, spec.args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: spec.env,
  })
}

export interface CodexInstallProgress {
  step:    'checking' | 'install' | 'done' | 'error'
  message: string
  percent: number
}

function push(win: BrowserWindow | null, p: CodexInstallProgress): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('codex:install-progress', p)
  }
}

function runNpm(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', err => reject(new Error(`npm spawn error: ${err.message}`)))
    proc.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`npm ${args.join(' ')} exited ${code}: ${stderr.slice(-500)}`))
    })
  })
}

/** Install (or reinstall to the pin). Progress via 'codex:install-progress'. */
export async function installCodex(win: BrowserWindow | null): Promise<{ ok: boolean; error?: string }> {
  try {
    if (isCodexInstalled()) {
      push(win, { step: 'done', message: `Codex ${CODEX_VERSION} already installed`, percent: 100 })
      return { ok: true }
    }
    push(win, { step: 'checking', message: 'Preparing sidecar directory…', percent: 5 })
    const dir = codexBase()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tachi-codex-sidecar', private: true }, null, 2), 'utf8')
    push(win, { step: 'install', message: `Installing @openai/codex@${CODEX_VERSION} (may take a minute)…`, percent: 30 })
    await runNpm(['install', `@openai/codex@${CODEX_VERSION}`, '--no-audit', '--no-fund'], dir)
    if (!isCodexInstalled()) throw new Error('install finished but the codex launcher is missing')
    // npm sometimes SKIPS the optional platform binary package (seen live:
    // "Missing optional dependency @openai/codex-win32-x64") — verify it and
    // install the exact spec from the launcher's optionalDependencies if absent.
    const platPkg = `@openai/codex-${process.platform}-${process.arch}`
    if (!existsSync(join(dir, 'node_modules', ...platPkg.split('/')))) {
      try {
        const launcherPkg = JSON.parse(readFileSync(join(dir, 'node_modules', '@openai', 'codex', 'package.json'), 'utf8')) as { optionalDependencies?: Record<string, string> }
        const ver = launcherPkg.optionalDependencies?.[platPkg]
        push(win, { step: 'install', message: `Installing platform binary ${platPkg}…`, percent: 70 })
        await runNpm(['install', ver ? `${platPkg}@${ver}` : platPkg, '--no-audit', '--no-fund'], dir)
      } catch (e) {
        throw new Error(`codex platform binary (${platPkg}) could not be installed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    push(win, { step: 'done', message: 'Codex worker installed.', percent: 100 })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    push(win, { step: 'error', message: msg, percent: 0 })
    return { ok: false, error: msg }
  }
}

/**
 * Auth check WITHOUT spawning anything: read ~/.codex/auth.json directly.
 * The old `codex login status` probe (a) flashed a console window every time
 * the CODE tab / Providers settings mounted (user-reported), and (b) lied
 * anyway — it only checks the same local file, so a rotten refresh token
 * still reported "logged in". Runtime failures surface the re-login hint.
 */
export function codexAuthStatus(): Promise<{ loggedIn: boolean; detail: string }> {
  if (!isCodexInstalled()) return Promise.resolve({ loggedIn: false, detail: 'not installed' })
  try {
    const home = resolveCodexHome()
    const authFile = join(home, 'auth.json')
    if (!existsSync(authFile)) return Promise.resolve({ loggedIn: false, detail: 'no auth.json — log in' })
    const auth = JSON.parse(readFileSync(authFile, 'utf8')) as { tokens?: unknown; OPENAI_API_KEY?: string }
    const loggedIn = !!auth.tokens || !!auth.OPENAI_API_KEY
    return Promise.resolve({ loggedIn, detail: loggedIn ? (auth.tokens ? 'ChatGPT login present' : 'API key present') : 'auth.json empty — log in' })
  } catch (e) {
    return Promise.resolve({ loggedIn: false, detail: `auth.json unreadable: ${e instanceof Error ? e.message : String(e)}` })
  }
}

/**
 * `codex logout` — clears ~/.codex auth so a FRESH login can be made. This is
 * the fix for the "refresh token was already used" state (the ChatGPT app can
 * consume the shared refresh token): LOG OUT → LOG IN.
 */
export function logoutCodex(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    if (!isCodexInstalled()) { resolve({ ok: false, detail: 'not installed' }); return }
    const proc = spawnCodex(['logout'])
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { out += d.toString() })
    const timer = setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, 15_000)
    proc.on('error', err => { clearTimeout(timer); resolve({ ok: false, detail: err.message }) })
    proc.on('exit', () => {
      clearTimeout(timer)
      // Belt-and-braces: if the CLI left auth.json behind, remove it ourselves —
      // the user explicitly asked to log out and the file only blocks re-login.
      try {
        const authFile = codexAuthFile()
        if (existsSync(authFile)) rmSync(authFile, { force: true })
      } catch { /* CLI removal already happened */ }
      resolve({ ok: true, detail: out.trim().slice(0, 200) })
    })
  })
}

// ── CODEX_HOME resolution + stray-login troubleshooting ──────────────────────
// Real-world failure mode (seen on THIS machine): the user's codex home is
// moved via the CODEX_HOME env var, but a login can land in ~/.codex anyway
// (a tool that ignored the var), or the app was launched without the var in
// its environment. Resolution order: process env → the USER registry value
// (HKCU\Environment — covers "var set after the app's parent shell started")
// → ~/.codex. status() additionally reports a login found in the NON-active
// location so the Settings card can offer a one-click fix (codex:adopt-auth).

let _registryHome: string | null | undefined // undefined = not queried yet
function registryCodexHome(): string | null {
  if (_registryHome !== undefined) return _registryHome
  _registryHome = null
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process') as typeof import('child_process')
      const out = execFileSync('reg.exe', ['query', 'HKCU\\Environment', '/v', 'CODEX_HOME'], { timeout: 3000, windowsHide: true }).toString()
      const m = /CODEX_HOME\s+REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out)
      if (m && m[1].trim()) _registryHome = m[1].trim()
    } catch { /* not set in registry */ }
  }
  return _registryHome
}

export function resolveCodexHome(): string {
  return process.env.CODEX_HOME?.trim()
    || registryCodexHome()
    || join(app.getPath('home'), '.codex')
}

function codexAuthFile(): string {
  return join(resolveCodexHome(), 'auth.json')
}

/** A login sitting in the NON-active codex home (the split-brain case). */
export function strayAuthLocation(): string | null {
  const active = resolveCodexHome()
  const candidates = [join(app.getPath('home'), '.codex')]
  const reg = registryCodexHome()
  if (reg) candidates.push(reg)
  if (process.env.CODEX_HOME?.trim()) candidates.push(process.env.CODEX_HOME.trim())
  for (const c of candidates) {
    if (c !== active && existsSync(join(c, 'auth.json')) && !existsSync(codexAuthFile())) return c
  }
  return null
}

/** One-click fix: copy the stray auth.json into the ACTIVE codex home. */
export function adoptStrayAuth(): { ok: boolean; detail: string } {
  const stray = strayAuthLocation()
  if (!stray) return { ok: false, detail: 'no stray login found' }
  try {
    const dir = resolveCodexHome()
    if (!existsSync(dir)) mkdirSync(dir)
    writeFileSync(codexAuthFile(), readFileSync(join(stray, 'auth.json')))
    return { ok: true, detail: `login adopted from ${stray}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

// Only one login flow at a time — a second click must not race the first on
// the OAuth callback port (the loser dies silently and the user's browser
// authorization lands on a corpse — seen live: authorized, no auth.json).
let loginProc: ReturnType<typeof spawnCodex> | null = null

/**
 * Run `codex login` for the user — opens the browser for the ChatGPT OAuth
 * flow. SUCCESS = auth.json APPEARS on disk (polled every second), NOT the
 * child's exit code: the file is the only truth. Failure surfaces the CLI's
 * actual output instead of swallowing it. 10-minute window.
 */
export function loginCodex(win: BrowserWindow | null): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    if (!isCodexInstalled()) { resolve({ ok: false, detail: 'not installed' }); return }
    if (loginProc) { try { loginProc.kill() } catch { /* gone */ } loginProc = null }
    const proc = spawnCodex(['login'])
    loginProc = proc
    let out = ''
    let settled = false
    const forward = (d: Buffer) => {
      const line = d.toString()
      out += line
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('codex:login-progress', { line: line.slice(0, 500) })
      }
    }
    proc.stdout?.on('data', forward)
    proc.stderr?.on('data', forward)

    const finish = (ok: boolean, detail: string) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      if (loginProc === proc) loginProc = null
      resolve({ ok, detail })
    }
    // The truth poll: the CLI writes auth.json the moment the browser
    // round-trip completes — succeed on sight. NEVER kill the child here:
    // it re-touches auth.json during its final steps, and a kill mid-write
    // DELETED the fresh login (seen live: file appeared, then vanished).
    // It exits by itself right after the callback.
    const poll = setInterval(() => {
      if (existsSync(codexAuthFile())) {
        finish(true, 'logged in — auth.json written')
      }
    }, 1000)
    const deadline = setTimeout(() => {
      try { proc.kill() } catch { /* gone */ }
      finish(false, `login timed out after 10 min. CLI output: ${out.trim().slice(-300)}`)
    }, 10 * 60_000)
    proc.on('error', err => finish(false, `codex login failed to start: ${err.message}`))
    proc.on('exit', code => {
      // Give the fs a beat — the file write can land right at exit.
      setTimeout(() => {
        if (existsSync(codexAuthFile())) finish(true, 'logged in — auth.json written')
        else finish(false, `codex login exited (code ${code}) without writing auth.json. CLI output: ${out.trim().slice(-300) || '(none)'}`)
      }, 1500)
    })
  })
}
