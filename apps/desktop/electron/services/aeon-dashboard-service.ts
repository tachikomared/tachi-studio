// apps/desktop/electron/services/aeon-dashboard-service.ts
//
// Zero-terminal launcher for Aeon's native Next.js dashboard. The whole flow
// runs inside the main process and streams progress to the renderer:
//
//   1. ensureSource()  — pulls aaronjmars/aeon@main tarball, extracts dashboard/
//   2. ensureDeps()    — runs `npm install` inside the dashboard if missing
//   3. start()         — spawns `next dev` on a free port (default 5555),
//                        passing GH_TOKEN + GH_REPO from our OAuth keychain
//                        so the dashboard's `gh` shellouts talk to the user's
//                        fork without requiring `gh auth login` interactively.
//
// We use the UPSTREAM dashboard source rather than per-fork checkouts because
// the dashboard is the same across forks — only the GH_REPO env differs.
// This means we only have to download + npm-install once for the whole app.
import { app } from 'electron'
import { spawn, ChildProcess, execFile } from 'child_process'
import { promisify } from 'util'
import { createWriteStream, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { findFreePort } from '@tachi/core'
import { retrieveKey } from './keychain'
import { ensureGhCli, onGhProgress, type GhProgress } from './gh-cli-service'

const execFileAsync = promisify(execFile)

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT = () => join(app.getPath('userData'), 'aeon-dashboard')
const DASHBOARD_DIR = () => join(ROOT(), 'dashboard')
const TARBALL_PATH  = () => join(ROOT(), 'source.tar.gz')

const UPSTREAM_TARBALL_URL = 'https://api.github.com/repos/aaronjmars/aeon/tarball/main'
const DEFAULT_PORT = 5555

// ── Progress event ────────────────────────────────────────────────────────────
//
// Every state-changing call emits one of these so the renderer can render a
// live status pill ("downloading source… 2.3 MB / 18 MB"). Kept compact —
// the renderer doesn't need to know how we extract, just what stage we're in.
export type DashboardProgressEvent =
  | { stage: 'idle' }
  | { stage: 'downloading'; bytes?: number; total?: number }
  | { stage: 'extracting' }
  | { stage: 'installing-deps' }
  | { stage: 'installing-gh'; bytes?: number; total?: number }
  | { stage: 'starting' }
  | { stage: 'ready';        port: number }
  | { stage: 'error';        message: string }

let progressListener: ((e: DashboardProgressEvent) => void) | null = null
let lastProgress: DashboardProgressEvent = { stage: 'idle' }

export function onDashboardProgress(cb: (e: DashboardProgressEvent) => void): () => void {
  progressListener = cb
  cb(lastProgress)  // immediately replay current state
  return () => { if (progressListener === cb) progressListener = null }
}

function emit(e: DashboardProgressEvent): void {
  lastProgress = e
  progressListener?.(e)
}

// ── Runtime state ─────────────────────────────────────────────────────────────
let proc:    ChildProcess | null = null
let port:    number | null       = null

export function dashboardStatus(): {
  state: 'idle' | 'downloading' | 'extracting' | 'installing-deps' | 'installing-gh' | 'starting' | 'ready' | 'error'
  port:  number | null
  message?: string
} {
  return {
    state:   lastProgress.stage,
    port,
    message: lastProgress.stage === 'error' ? lastProgress.message : undefined,
  }
}

// ── Step 1: source ────────────────────────────────────────────────────────────

/**
 * Returns true when dashboard source already exists on disk (has package.json).
 * We skip re-download on subsequent launches — the upstream Aeon dashboard is
 * the same for every user, so caching it once is fine.
 */
function hasSource(): boolean {
  return existsSync(join(DASHBOARD_DIR(), 'package.json'))
}

/**
 * Download + extract the upstream Aeon tarball. The GitHub tarball API
 * redirects to a codeload URL that responds with `application/x-gzip` —
 * we stream it to disk, then use the system `tar` (available everywhere
 * we ship) to extract. Tarball root is `aaronjmars-aeon-<sha>/` which we
 * flatten away after extraction.
 */
async function ensureSource(): Promise<void> {
  if (hasSource()) return

  mkdirSync(ROOT(), { recursive: true })
  emit({ stage: 'downloading' })

  const res = await fetch(UPSTREAM_TARBALL_URL, {
    headers: { 'User-Agent': 'TachiDesk-Aeon-Dashboard' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`Tarball fetch failed: HTTP ${res.status}`)
  if (!res.body) throw new Error('Tarball response had no body')

  const total = Number(res.headers.get('content-length') || 0) || undefined
  let bytes = 0
  // Mirror the readable so we can both write to disk and report progress.
  const monitored = new ReadableStream({
    async start(controller) {
      const reader = res.body!.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          bytes += value.byteLength
          emit({ stage: 'downloading', bytes, total })
          controller.enqueue(value)
        }
      }
      controller.close()
    },
  })

  await pipeline(
    Readable.fromWeb(monitored as unknown as import('stream/web').ReadableStream<Uint8Array>),
    createWriteStream(TARBALL_PATH()),
  )

  emit({ stage: 'extracting' })

  // Extract using system `tar`. Strip the top-level "aaronjmars-aeon-<sha>/"
  // prefix so files land directly under extractDir.
  const extractDir = join(ROOT(), 'extract')
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true })
  mkdirSync(extractDir, { recursive: true })

  // GNU tar on Windows (the build that ships with Git Bash / MSYS2) treats
  // any argument containing a colon as a `host:path` remote spec, so a path
  // like `C:\Users\…\source.tar.gz` fails with "Cannot connect to C: resolve
  // failed". Workaround: run tar with cwd=ROOT() and reference the tarball
  // by its bare filename — no drive-letter ever appears as an argument.
  // Extract to ./extract/ (relative) for the same reason.
  await execFileAsync(
    process.platform === 'win32' ? 'tar.exe' : 'tar',
    ['-xzf', 'source.tar.gz', '-C', 'extract', '--strip-components=1'],
    {
      cwd:        ROOT(),
      timeout:    120_000,
      maxBuffer:  16 * 1024 * 1024,
    },
  )

  // We only want the `dashboard/` subdir — move it up so DASHBOARD_DIR()
  // points to the actual Next.js project. Use copy-via-mv pattern so it
  // works even when the destination already exists.
  const extractedDashboard = join(extractDir, 'dashboard')
  if (!existsSync(extractedDashboard)) {
    throw new Error('Tarball had no dashboard/ — upstream layout may have changed')
  }
  if (existsSync(DASHBOARD_DIR())) rmSync(DASHBOARD_DIR(), { recursive: true, force: true })

  // Use system mv/move since fs.renameSync can fail across drives on Windows.
  if (process.platform === 'win32') {
    await execFileAsync('cmd.exe', ['/c', 'move', extractedDashboard, DASHBOARD_DIR()])
  } else {
    await execFileAsync('mv', [extractedDashboard, DASHBOARD_DIR()])
  }

  // Cleanup. Tarball + remaining extracted siblings can go.
  rmSync(extractDir,    { recursive: true, force: true })
  rmSync(TARBALL_PATH(), { force: true })
}

// ── Step 2: deps ──────────────────────────────────────────────────────────────

function depsInstalled(): boolean {
  return existsSync(join(DASHBOARD_DIR(), 'node_modules'))
}

/**
 * Runs `npm install --no-audit --no-fund --no-progress` in the dashboard.
 * stdio is piped to the main process console for debugging but we don't
 * stream individual npm log lines to the renderer — too noisy. The renderer
 * just sees "installing-deps" until completion.
 */
async function ensureDeps(): Promise<void> {
  if (depsInstalled()) return
  emit({ stage: 'installing-deps' })

  await new Promise<void>((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const npmProc = spawn(npmCmd, ['install', '--no-audit', '--no-fund', '--no-progress'], {
      cwd:    DASHBOARD_DIR(),
      stdio:  ['ignore', 'pipe', 'pipe'],
      shell:  process.platform === 'win32',
    })
    let stderr = ''
    npmProc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    // Mirror to our console so we can debug install failures.
    npmProc.stdout?.on('data', d => process.stdout.write(`[aeon-dash:npm] ${d}`))
    npmProc.stderr?.on('data', d => process.stderr.write(`[aeon-dash:npm] ${d}`))

    npmProc.on('error', err => reject(new Error(`npm spawn failed: ${err.message}`)))
    npmProc.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`npm install exited ${code}: ${stderr.slice(-400)}`))
    })
  })
}

// ── Step 3: start next dev ────────────────────────────────────────────────────

/**
 * Spawn `next dev` on a free port. Aeon's dashboard reads GH_TOKEN /
 * GITHUB_TOKEN for `gh` CLI auth and respects PORT for the listener.
 * We also pass GH_REPO so the dashboard's API routes target the user's
 * fork by default rather than aaronjmars/aeon (the source we vendored).
 */
async function start(owner: string): Promise<{ port: number }> {
  if (proc && proc.exitCode === null) {
    // Already running — adopt and return current port.
    if (port) return { port }
  }

  emit({ stage: 'starting' })

  const ownerForkRepo = `${owner}/aeon`
  // Reuse the same OAuth token the rest of Aeon stores under the 'github'
  // keychain id — set by aeon-service.ghLogin() after the device-flow login.
  const ghToken = retrieveKey('github')
  if (!ghToken) {
    // Dashboard's gh shellouts will fail without a token. Surface this
    // immediately rather than letting the dashboard's modal 503 silently.
    throw new Error(
      'No GitHub OAuth token in keychain. Sign in via the Aeon tab first, then re-launch the dashboard.',
    )
  }

  // Ensure the bundled `gh` CLI is present before spawning next dev — every
  // dashboard API route shells out to `gh api` / `gh secret list` and would
  // return empty without it. Surface its progress through our own pipe so the
  // renderer's status pill shows "installing-gh 5 MB / 12 MB" rather than a
  // mysterious 10-second pause inside "starting".
  const offGh = onGhProgress((e: GhProgress) => {
    if (e.stage === 'fetching-meta')   emit({ stage: 'installing-gh' })
    else if (e.stage === 'downloading') emit({ stage: 'installing-gh', bytes: e.bytes, total: e.total })
    else if (e.stage === 'extracting')  emit({ stage: 'installing-gh' })
  })
  let ghBinDir:    string | null = null
  let ghBinPath:   string | null = null
  let ghConfigDir: string | null = null
  try {
    const gh = await ensureGhCli()
    ghBinDir  = gh.binDir
    ghBinPath = gh.binPath
  } catch (err) {
    // Non-fatal — the dashboard will still mount, but API routes will fail
    // until the user retries. Surface a warning rather than blowing up.
    console.warn('[aeon-dash] gh CLI bootstrap failed:', err)
  } finally {
    offGh()
  }

  // Write a hosts.yml so `gh auth status` reports authenticated. The dashboard
  // gates its API routes on that check (returns 503/500 when it fails), and
  // gh's auth status does NOT consider GH_TOKEN env alone as "logged in" —
  // only a hosts.yml entry counts. We keep our own config dir (gh-config/)
  // so we don't disturb any system-wide gh setup the user may have.
  //
  // We can't use `gh auth login --with-token` because the device-flow token
  // Aeon stores lacks `read:org` scope (which login validation requires) but
  // *does* have `repo` + `workflow` — enough for everything the dashboard
  // actually does. Writing hosts.yml directly bypasses that validation;
  // `gh auth status` then succeeds as long as the token works for `gh api user`.
  if (ghBinPath) {
    try {
      ghConfigDir = join(app.getPath('userData'), 'gh-config')
      mkdirSync(ghConfigDir, { recursive: true })
      const hostsYml =
        `github.com:\n` +
        `    oauth_token: ${ghToken}\n` +
        `    git_protocol: https\n` +
        `    user: ${owner}\n`
      writeFileSync(join(ghConfigDir, 'hosts.yml'), hostsYml, { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      // hosts.yml write failed — log but continue. Dashboard will surface a
      // "not authenticated" notice; user can retry.
      console.warn('[aeon-dash] writing gh hosts.yml failed:', err)
      ghConfigDir = null
    }
  }

  const freePort = await findFreePort(DEFAULT_PORT)

  // Spawn `node next/dist/bin/next dev` directly instead of going through
  // the `.cmd` shim. Why: Node's `spawn` on Windows with `shell: true` runs
  // the command via `cmd.exe /c …` and does NOT quote arguments — so a path
  // containing a space (e.g. `C:\Users\Some Name\…`) is parsed by cmd as two
  // tokens and fails with `'C:\Users\Some' is not recognized…`. Calling
  // `node` against the JS entrypoint avoids the shell entirely and
  // sidesteps both the space-in-path bug and any PATHEXT/.cmd quirks. Same
  // pattern we use for the freellmapi + openclaude sidecars.
  const nextJsEntry = join(DASHBOARD_DIR(), 'node_modules', 'next', 'dist', 'bin', 'next')
  if (!existsSync(nextJsEntry)) {
    throw new Error(`next entrypoint missing at ${nextJsEntry} — npm install may have failed`)
  }
  const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'

  // Prepend our bundled gh bin dir onto the dashboard's PATH so its `gh`
  // shellouts resolve to our copy. If the user happens to have a system gh
  // ours wins — that's intentional, we want a known version (and we set
  // GH_TOKEN ourselves so the version doesn't need `gh auth login`).
  const pathKey   = process.platform === 'win32' ? 'Path' : 'PATH'
  const parentPath = process.env[pathKey] ?? process.env.PATH ?? ''
  const dashboardPath = ghBinDir
    ? `${ghBinDir}${process.platform === 'win32' ? ';' : ':'}${parentPath}`
    : parentPath

  const spawned = spawn(nodeCmd, [nextJsEntry, 'dev', '-p', String(freePort)], {
    cwd: DASHBOARD_DIR(),
    env: {
      ...process.env,
      [pathKey]:      dashboardPath,
      PORT:           String(freePort),
      // gh CLI auth path:
      //   GH_CONFIG_DIR points at our pre-populated hosts.yml so `gh auth status`
      //     reports authenticated (the dashboard gates everything on that check).
      //   GH_TOKEN / GITHUB_TOKEN are kept as a fallback for any tool that
      //     reads them directly instead of going through gh.
      ...(ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {}),
      GH_TOKEN:       ghToken,
      GITHUB_TOKEN:   ghToken,
      // Tell the dashboard which repo to target. The dashboard's lib/github.ts
      // checks `GITHUB_REPO` specifically — without it, isLocal() returns true
      // and every file lookup hits the local FS at `<cwd>/..` which doesn't
      // contain the user's fork, so api/skills 500s with ENOENT. Set both
      // GH_REPO (the gh CLI name) and GITHUB_REPO (the dashboard's name) so
      // every consumer is happy.
      GH_REPO:        ownerForkRepo,
      GITHUB_REPO:    ownerForkRepo,
      // Aeon's API gate allows loopback by default — explicit is good.
      AEON_DASHBOARD_ALLOWED_HOSTS: `localhost:${freePort},127.0.0.1:${freePort}`,
    },
    stdio:    ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  proc = spawned
  port = freePort

  spawned.stdout?.on('data', d => process.stdout.write(`[aeon-dash] ${d}`))
  spawned.stderr?.on('data', d => process.stderr.write(`[aeon-dash] ${d}`))

  spawned.on('error', err => {
    emit({ stage: 'error', message: `Spawn error: ${err.message}` })
  })
  spawned.on('exit', code => {
    if (proc === spawned) {
      proc = null
      port = null
      // Don't overwrite a "ready" state with idle if the user just stopped it.
      if (code !== 0 && code !== null) {
        emit({ stage: 'error', message: `Dashboard exited with code ${code}` })
      } else if (lastProgress.stage !== 'error') {
        emit({ stage: 'idle' })
      }
    }
  })

  // Poll the port for readiness (next dev takes 2–10 s).
  const READY_DEADLINE_MS = 30_000
  const deadline = Date.now() + READY_DEADLINE_MS
  while (Date.now() < deadline) {
    if (spawned.exitCode !== null) {
      throw new Error(`Dashboard exited before becoming ready (code ${spawned.exitCode})`)
    }
    try {
      const res = await fetch(`http://localhost:${freePort}/`, {
        signal: AbortSignal.timeout(1500) as AbortSignal,
      })
      if (res.status < 600) {
        emit({ stage: 'ready', port: freePort })
        return { port: freePort }
      }
    } catch { /* not yet — wait and retry */ }
    await new Promise(r => setTimeout(r, 500))
  }

  // Timed out. Don't kill the proc — next dev sometimes recovers — but
  // surface the timeout to the UI so the user can hit "Reload" once they
  // see it come up.
  throw new Error(`Dashboard didn't become ready within ${READY_DEADLINE_MS / 1000}s — try Reload`)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * One-click "install + launch" flow. Idempotent: skipping each stage when
 * the prior install already satisfies it. Emits progress to the renderer
 * via the registered listener.
 */
export async function installAndLaunchDashboard(owner: string): Promise<{ port: number }> {
  try {
    await ensureSource()
    await ensureDeps()
    return await start(owner)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emit({ stage: 'error', message })
    throw err
  }
}

export function stopDashboard(): void {
  if (proc) {
    try { proc.kill() } catch { /* best-effort */ }
    proc = null
    port = null
  }
  emit({ stage: 'idle' })
}

/**
 * Wipe the cached source + node_modules so the next launch re-downloads from
 * upstream. Useful when the user wants to pick up Aeon dashboard updates.
 */
export function resetDashboardCache(): void {
  stopDashboard()
  if (existsSync(ROOT())) {
    rmSync(ROOT(), { recursive: true, force: true })
  }
  emit({ stage: 'idle' })
}

/**
 * Detects whether system `node` + `npm` are available. The whole flow
 * needs both (next dev is JS, npm install for deps). We require system
 * Node ≥ 18 (Next 14+ minimum).
 *
 * Windows quirk: npm ships as `npm.cmd` (a batch shim, not an .exe), and
 * Node's `execFile` only auto-resolves .exe — not .cmd — without going
 * through a shell. We use `shell: true` on Windows so the cmd shim
 * resolves correctly. Same for any other PATH lookup quirk.
 */
export async function checkPrerequisites(): Promise<{
  node: { found: boolean; version?: string }
  npm:  { found: boolean; version?: string }
  ok:   boolean
}> {
  const useShell = process.platform === 'win32'
  async function probe(cmd: string): Promise<{ found: boolean; version?: string }> {
    try {
      const { stdout } = await execFileAsync(cmd, ['--version'], {
        timeout: 5_000,
        // On Windows: shell:true lets cmd.exe resolve `npm` → `npm.cmd`. On
        // POSIX: the binary on PATH resolves directly, no shell needed.
        shell:   useShell,
      })
      return { found: true, version: stdout.trim() }
    } catch {
      // Final fallback: ask the OS to locate the binary's full path and
      // try once more with that. Catches PATHEXT/quoting edge cases.
      try {
        const which = useShell ? 'where.exe' : 'which'
        const { stdout: locator } = await execFileAsync(which, [cmd], {
          timeout: 5_000,
          shell:   useShell,
        })
        const resolved = locator.split(/\r?\n/).map(s => s.trim()).find(Boolean)
        if (!resolved) return { found: false }
        const { stdout } = await execFileAsync(resolved, ['--version'], {
          timeout: 5_000,
          shell:   useShell,
        })
        return { found: true, version: stdout.trim() }
      } catch {
        return { found: false }
      }
    }
  }
  const [node, npm] = await Promise.all([probe('node'), probe('npm')])
  return { node, npm, ok: node.found && npm.found }
}

// ── Analytics API ─────────────────────────────────────────────────────────────

export interface SkillAnalyticsEntry {
  successRate:    number
  streak:         number
  avgDurationMin: number
}

export type SkillAnalyticsMap = Record<string, SkillAnalyticsEntry>

/**
 * Fetch per-skill analytics from the running Aeon dashboard.
 * GET <dashboardBaseUrl>/api/analytics
 *
 * Returns a map of skillName → { successRate, streak, avgDurationMin }.
 * If the dashboard is not running or the endpoint 404s (older fork), resolves
 * to an empty object so callers can degrade gracefully.
 */
export async function getSkillAnalytics(_owner: string): Promise<SkillAnalyticsMap> {
  if (!port) return {}
  try {
    const res = await fetch(`http://localhost:${port}/api/analytics`, {
      signal: AbortSignal.timeout(5_000) as AbortSignal,
    })
    // Older Aeon forks may not expose /api/analytics — treat 404 as empty.
    if (res.status === 404) return {}
    if (!res.ok) throw new Error(`/api/analytics responded ${res.status}`)
    const data = await res.json() as unknown
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as SkillAnalyticsMap
    }
    return {}
  } catch {
    // Network error or timeout — degrade silently.
    return {}
  }
}

// ── E2: Fork-behind indicator ─────────────────────────────────────────────────

export interface AeonSyncStatus {
  hasChanges:   boolean
  changedFiles: string[]
  behind:       number
}

/**
 * Fetches GET <dashboardBaseUrl>/api/sync and returns the result.
 * Requires the dashboard to be running (port != null).
 * Graceful: returns { hasChanges: false, changedFiles: [], behind: 0 } if the
 * endpoint is absent (404) or the dashboard is not running yet.
 */
export async function getSyncStatus(): Promise<AeonSyncStatus> {
  const fallback: AeonSyncStatus = { hasChanges: false, changedFiles: [], behind: 0 }
  if (!port) return fallback
  try {
    const res = await fetch(`http://localhost:${port}/api/sync`, {
      signal: AbortSignal.timeout(8_000) as AbortSignal,
    })
    if (res.status === 404) return fallback
    if (!res.ok) return fallback
    const data = await res.json() as Partial<AeonSyncStatus>
    return {
      hasChanges:   Boolean(data.hasChanges),
      changedFiles: Array.isArray(data.changedFiles) ? data.changedFiles : [],
      behind:       typeof data.behind === 'number' ? data.behind : 0,
    }
  } catch {
    return fallback
  }
}

// ── E4: Memory search API ─────────────────────────────────────────────────────

export interface AeonMemoryEntry {
  id:      string
  title:   string
  snippet: string
  ts:      number
  [key: string]: unknown
}

/**
 * POST /api/memory/search?q=<query> on the running Aeon dashboard.
 * Returns an array of memory entries. Resolves to [] when the dashboard is not
 * running or the endpoint is absent (older fork) — callers degrade gracefully.
 */
export async function searchMemory(query: string): Promise<AeonMemoryEntry[]> {
  if (!port) return []
  try {
    const url = `http://localhost:${port}/api/memory/search?q=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(8_000) as AbortSignal,
    })
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`/api/memory/search responded ${res.status}`)
    const data = await res.json() as unknown
    if (Array.isArray(data)) return data as AeonMemoryEntry[]
    // Some Aeon versions wrap: { results: [...] }
    if (
      data && typeof data === 'object' &&
      Array.isArray((data as Record<string, unknown>).results)
    ) {
      return (data as { results: AeonMemoryEntry[] }).results
    }
    return []
  } catch {
    return []
  }
}

/** Returns the cached dashboard's package.json version, if installed. */
export function vendoredVersion(): string | null {
  const pkgPath = join(DASHBOARD_DIR(), 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}
