// apps/desktop/electron/services/darksol-installer.ts
//
// On-demand installer for @darksol/terminal (GPL-3.0). darksol is NOT bundled
// (avoids GPL redistribution) — we npm-install it into a Tachi-private dir at
// first use, exactly like openclaude-installer.ts does for @gitlawb/openclaude.
//
// darksol is a Node ESM CLI. Its package.json `bin` exposes the `darksol`
// command; we resolve the package's real entry via createRequire (NOT npx,
// which on Windows fails with "'darksol' is not recognized" because the bin
// shim isn't on the spawned process's PATH — same issue nook-mcp.ts documents
// for @nookplot/mcp). Callers spawn `node <darksolEntry()> <args…>`.

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'node:module'
import { app } from 'electron'
import { spawn } from 'child_process'
import type { BrowserWindow } from 'electron'

/** Pinned version — bump here to force a clean reinstall on all clients. */
const DARKSOL_VERSION = '1.0.0'  // TODO(wiring): pin to the @darksol/terminal version probed at integration time

/** Root directory where darksol is npm-installed. */
function darksolBase(): string {
  return join(app.getPath('userData'), 'sidecars', 'darksol')
}

/**
 * Resolve @darksol/terminal's runnable entry inside the install dir.
 * Tries the package main, then the documented bin path, then a dist fallback —
 * the same defensive ladder nook-mcp.ts uses for @nookplot/mcp.
 */
export function darksolEntry(): string {
  const req = createRequire(join(darksolBase(), 'package.json'))
  try { return req.resolve('@darksol/terminal') }
  catch { /* fall through */ }
  // bin path from package.json (verified at wiring); dist/index.js is the
  // conventional ESM build output for this project layout.
  const binGuess  = join(darksolBase(), 'node_modules', '@darksol', 'terminal', 'bin', 'darksol.js')
  if (existsSync(binGuess)) return binGuess
  return join(darksolBase(), 'node_modules', '@darksol', 'terminal', 'dist', 'index.js')
}

/** True when node_modules + the pinned version are present. */
export function isDarksolInstalled(): boolean {
  const pkgJson = join(darksolBase(), 'node_modules', '@darksol', 'terminal', 'package.json')
  if (!existsSync(pkgJson)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: string }
    return pkg.version === DARKSOL_VERSION
  } catch {
    return false
  }
}

export interface DarksolInstallProgress {
  step:    'checking' | 'init' | 'install' | 'done' | 'error'
  message: string
  percent: number
}

function push(win: BrowserWindow, p: DarksolInstallProgress): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('darksol:install-progress', p)
  }
}

function runNpm(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const proc = spawn(npmCmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', err => reject(new Error(`npm spawn error: ${err.message}`)))
    proc.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`npm ${args.join(' ')} exited ${code}: ${stderr.slice(-500)}`))
    })
  })
}

let activeInstall: Promise<void> | null = null

export function installDarksol(win: BrowserWindow): Promise<void> {
  if (activeInstall) return activeInstall
  activeInstall = _doInstall(win).finally(() => { activeInstall = null })
  return activeInstall
}

async function _doInstall(win: BrowserWindow): Promise<void> {
  const dir = darksolBase()
  push(win, { step: 'checking', message: 'Checking…', percent: 0 })

  mkdirSync(dir, { recursive: true })

  push(win, { step: 'init', message: 'Initialising package directory…', percent: 20 })
  if (!existsSync(join(dir, 'package.json'))) {
    await runNpm(['init', '-y'], dir)
  }

  push(win, { step: 'install', message: `Installing @darksol/terminal@${DARKSOL_VERSION} (may take a minute)…`, percent: 40 })
  await runNpm(['install', `@darksol/terminal@${DARKSOL_VERSION}`], dir)

  push(win, { step: 'done', message: 'darksol ready.', percent: 100 })
}
