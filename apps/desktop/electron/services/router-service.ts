import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import type { BrowserWindow } from 'electron'
import { retrieveKey } from './keychain'
import { listSurplusModels } from './surplus-service'

// ─── Config types (the REAL claude-code-router schema) ─────────────────────────
// Providers[] each carry name + OpenAI-compatible api_base_url + api_key + models[];
// Router maps a scenario (default/background/think/longContext/…) to "name,model".

export interface RouterProvider {
  name:         string
  api_base_url: string
  api_key:      string
  models?:      string[]
  transformer?: Record<string, unknown>
}

export interface RouterRoutes {
  default?:              string
  background?:           string
  think?:                string
  longContext?:          string
  longContextThreshold?: number
  webSearch?:            string
  image?:                string
  [key: string]: string | number | undefined
}

export interface RouterConfig {
  PORT?:           number
  HOST?:           string
  APIKEY?:         string
  API_TIMEOUT_MS?: number
  Providers?:      RouterProvider[]
  Router?:         RouterRoutes
  /** Any extra fields from the upstream config schema. */
  [key: string]: unknown
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export function routerConfigDir(): string {
  return join(homedir(), '.claude-code-router')
}

export function routerConfigPath(): string {
  return join(routerConfigDir(), 'config.json')
}

// ─── Read / write ─────────────────────────────────────────────────────────────

/** Read the router config from disk. Returns null if the file does not exist. */
export function readConfig(): RouterConfig | null {
  const p = routerConfigPath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RouterConfig
  } catch {
    return null
  }
}

/** Atomically write a new config to disk. Creates the directory if needed. */
export function writeConfig(cfg: RouterConfig): void {
  const dir = routerConfigDir()
  mkdirSync(dir, { recursive: true })
  const target = routerConfigPath()
  const tmp    = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  renameSync(tmp, target)
  // Harden perms — this file holds plaintext api_key fields. Restrict to the
  // owner (no group/other read). On Windows %USERPROFILE% is already ACL-scoped
  // to the user, and chmod has no POSIX semantics there, so enforce on POSIX only.
  if (process.platform !== 'win32') {
    try { chmodSync(routerConfigDir(), 0o700); chmodSync(target, 0o600) } catch { /* best-effort */ }
  }
}

// ─── Seed from TachiDesk keys ─────────────────────────────────────────────────

/**
 * Build and write a default config wired to the keys TachiDesk already has:
 *  - OpenGateway  (key: 'opengateway')
 *  - OpenRouter   (key: 'openrouter')
 *  - Ollama       (always added as a local fallback, no key required)
 *
 * Providers are ordered by quality: OpenGateway first, then OpenRouter, then Ollama.
 * Only providers whose keys are actually stored are included (except Ollama).
 * Does NOT overwrite the existing config — callers should check first if needed.
 */
/** First provider whose model list contains any of `kws` → "name,model". */
function pickRoute(providers: RouterProvider[], kws: string[]): string | undefined {
  for (const p of providers) {
    const m = (p.models ?? []).find(id => kws.some(k => id.toLowerCase().includes(k)))
    if (m) return `${p.name},${m}`
  }
  return undefined
}

/** Build a sensible scenario→model map from the available providers. */
function buildDefaultRouter(providers: RouterProvider[]): RouterRoutes {
  const firstOf = (p?: RouterProvider) => (p?.models?.[0]) ? `${p.name},${p.models[0]}` : undefined
  const fallback = pickRoute(providers, ['claude-sonnet', 'sonnet', 'gpt-5', 'gemini', 'claude']) ?? firstOf(providers[0])
  const routes: RouterRoutes = { longContextThreshold: 60000 }
  const set = (k: string, v?: string) => { if (v) routes[k] = v }
  set('default',     fallback)
  set('background',  pickRoute(providers, ['haiku', 'mini', 'flash', 'nano', 'small', 'llama', 'qwen']) ?? fallback)
  set('think',       pickRoute(providers, ['deepseek-r1', 'thinking', 'r1', 'opus', 'gpt-5.5', 'reason']) ?? fallback)
  set('longContext', pickRoute(providers, ['gemini', 'sonnet', 'opus', 'long']) ?? fallback)
  return routes
}

// Provider name (in the CCR config) → TachiDesk keychain id. Keys are injected
// from the encrypted keychain at Start and scrubbed at Stop, so the on-disk config
// holds NO plaintext keys at rest (only while the proxy is actually running).
const PROVIDER_KEYCHAIN: Record<string, string> = {
  surplus:     'surplus',
  bankr:       'bankr-gateway',
  opengateway: 'opengateway',
  openrouter:  'openrouter',
}

/**
 * Build + write a CORRECT claude-code-router config wired to the keys TachiDesk
 * already has, with REAL model lists from each provider's catalog. Providers are
 * ordered by quality (Surplus → Bankr → OpenGateway → OpenRouter → Ollama); only
 * those with a stored key are included (Ollama is always added as a local fallback).
 * A default Router map is generated so the proxy works out of the box.
 */
export async function seedFromTachi(): Promise<RouterConfig> {
  const providers: RouterProvider[] = []

  const surplusKey = retrieveKey('surplus')
  if (surplusKey) {
    let models: string[] = []
    try { models = (await listSurplusModels()).models.map(m => m.id) } catch { /* fall back below */ }
    if (models.length === 0) {
      models = ['claude-sonnet-4.5', 'claude-haiku-4.5', 'claude-opus-4.8', 'deepseek-r1', 'gpt-5.4', 'gemini-3.1-pro']
    }
    providers.push({
      name:         'surplus',
      api_base_url: 'https://www.surplusintelligence.ai/api/inference/v1/chat/completions',
      api_key:      '',  // injected from keychain at Start; never persisted plaintext
      models:       models.slice(0, 80),
    })
  }

  const bankrKey = retrieveKey('bankr-gateway')
  if (bankrKey) providers.push({
    name:         'bankr',
    api_base_url: 'https://llm.bankr.bot/v1/chat/completions',
    api_key:      '',
    models:       ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4.8', 'claude-sonnet-4.6', 'gpt-5.4', 'gemini-3.1-pro'],
  })

  const ogwKey = retrieveKey('opengateway')
  if (ogwKey) providers.push({
    name:         'opengateway',
    api_base_url: 'https://opengateway.gitlawb.com/v1/chat/completions',
    api_key:      '',
    models:       ['mimo-v2.5-pro'],
  })

  const orKey = retrieveKey('openrouter')
  if (orKey) providers.push({
    name:         'openrouter',
    api_base_url: 'https://openrouter.ai/api/v1/chat/completions',
    api_key:      '',
    models:       ['anthropic/claude-3.7-sonnet', 'anthropic/claude-3.5-haiku', 'deepseek/deepseek-r1', 'google/gemini-2.5-pro'],
  })

  // Ollama — zero-config local fallback, always included.
  providers.push({
    name:         'ollama',
    api_base_url: 'http://localhost:11434/v1/chat/completions',
    api_key:      'ollama',
    models:       ['qwen2.5-coder', 'llama3.2', 'deepseek-r1'],
  })

  // HOST 127.0.0.1 → the proxy listens on loopback only (never exposed to the LAN).
  const cfg: RouterConfig = { PORT: 3456, HOST: '127.0.0.1', Providers: providers, Router: buildDefaultRouter(providers) }
  writeConfig(cfg)
  return cfg
}

/**
 * Fill api_key for each MANAGED provider from the encrypted keychain and write the
 * full config — called RIGHT BEFORE the proxy starts. Custom/unknown providers are
 * left untouched. Result: plaintext keys exist on disk only while the proxy runs.
 */
export function injectKeysForStart(): void {
  const cfg = readConfig()
  if (!cfg || !Array.isArray(cfg.Providers)) return
  let changed = false
  for (const p of cfg.Providers) {
    const kid = PROVIDER_KEYCHAIN[p.name]
    if (!kid) continue
    const k = retrieveKey(kid)
    if (k && p.api_key !== k) { p.api_key = k; changed = true }
  }
  if (changed) writeConfig(cfg)
}

/**
 * Blank out api_key for each MANAGED provider and rewrite the keyless config —
 * called after the proxy stops / exits / at app quit. Custom providers untouched.
 */
export function scrubKeys(): void {
  const cfg = readConfig()
  if (!cfg || !Array.isArray(cfg.Providers)) return
  let changed = false
  for (const p of cfg.Providers) {
    if (PROVIDER_KEYCHAIN[p.name] && p.api_key) { p.api_key = ''; changed = true }
  }
  if (changed) writeConfig(cfg)
}

// ─── Install check ────────────────────────────────────────────────────────────

/**
 * Returns the absolute path of the `ccr` binary if claude-code-router is
 * installed globally, otherwise null. We resolve via PATH because the npm
 * package's bin is `ccr` (not `claude-code-router`), so `npx <pkg>` fails to
 * find it.
 */
export async function findCcrBinary(): Promise<string | null> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)

  const which = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const { stdout } = await exec(which, ['ccr'], { timeout: 5_000 })
    const first = stdout.split('\n').map(s => s.trim()).filter(Boolean)[0]
    return first ?? null
  } catch {
    return null
  }
}

/** Returns true when the `ccr` binary is on PATH (npm-global install). */
export async function isRouterInstalled(): Promise<boolean> {
  return (await findCcrBinary()) !== null
}

// ─── Install ─────────────────────────────────────────────────────────────────

export interface RouterInstallProgress {
  step:    'install' | 'done' | 'error'
  message: string
  percent: number
}

let activeInstall: Promise<void> | null = null

export function installRouter(win: BrowserWindow): Promise<void> {
  if (activeInstall) return activeInstall
  activeInstall = _doInstall(win).finally(() => { activeInstall = null })
  return activeInstall
}

function pushProgress(win: BrowserWindow, p: RouterInstallProgress): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('claude-code-router:install-progress', p)
  }
}

async function _doInstall(win: BrowserWindow): Promise<void> {
  pushProgress(win, { step: 'install', message: 'Installing @musistudio/claude-code-router…', percent: 10 })

  await new Promise<void>((resolve, reject) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const proc = spawn(npmCmd, ['install', '-g', '@musistudio/claude-code-router'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })

    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', err => reject(new Error(`npm spawn error: ${err.message}`)))
    proc.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`npm install exited ${code}: ${stderr.slice(-500)}`))
    })
  })

  pushProgress(win, { step: 'done', message: 'claude-code-router installed.', percent: 100 })
}
