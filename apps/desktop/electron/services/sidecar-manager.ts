import { ChildProcess, spawn } from 'child_process'
import { existsSync, createWriteStream, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { findFreePort, OPENGATEWAY_AGENT_MODEL } from '@tachi/core'
import type { SidecarId, SidecarState, SidecarInfo } from './sidecar-types'
import { openclaudeEntry, writeOpenClaudeWrapper } from './openclaude-installer'
import { verifyInstalledFreellmapiPatches } from './freellmapi-installer'
import { logPatchVerdicts } from './freellmapi-patches'
import { darksolEntry, isDarksolInstalled } from './darksol-installer'
import { retrieveKey } from './keychain'
import { onKeyChange } from './key-events'
import { findCcrBinary, injectKeysForStart, scrubKeys } from './router-service'
// R8b: ./mcp-server is loaded ON FIRST START, not at boot — see the lazy
// loader next to startInProcessMcp() below. TYPE-ONLY here so the bundler
// keeps it out of the entry chunk (a single value import anywhere in the graph
// makes rollup inline the module and the deferral silently evaporates).
import type { McpHandle } from './mcp-server'
import { startOpenAiApiServer, rotateOpenAiApiToken, type ApiServerHandle } from './openai-api-server'
import { currentWorkspace } from './workspace-store'
import { CircuitBreaker, type BreakerSnapshot } from './util/circuit-breaker'
// An exit code is not a diagnosis: this turns the child's OWN stderr into the
// message the user reads. See util/sidecar-exit.ts for what went wrong without it.
import { explainSidecarExit } from './util/sidecar-exit'
import { HeartbeatTracker } from './heartbeat'
import { notifyTaskDone } from './notifications'
// These four used to be pulled in with function-body requires of a relative
// path "to break a load-order cycle". There is no cycle (none of them import back
// into sidecar-manager) and a runtime relative require does NOT resolve inside
// the packaged bundle (electron-vite emits one out/main/index.js), so every one
// of those calls silently threw in production. Static imports are hoisted, so
// they cannot reintroduce an init-order problem for call sites inside functions.
import * as walletSvc from './wallet-service'
import { getLlamaCppStatus, getLlamaCppPort, stopLlamaCpp, startLlamaCpp } from './llama-cpp-client'
import { listDownloadedModels as listGgufModelIds } from './llama-cpp-installer'
import { loadSettings, saveSettings } from './settings-store'

// ─── Internal state ───────────────────────────────────────────────────────────

interface SidecarSlot {
  state:      SidecarState
  port?:      number
  pid?:       number
  startedAt?: number
  error?:     string
  proc?:      ChildProcess
  apiKey?:    string   // freellmapi unified API key (fetched after startup)
  /**
   * openclaude only: the ledger/registry id of the gateway the RUNNING sidecar
   * routes to, captured at spawn from the tagged routing tuple in
   * startOpenClaude(). Spend accounting reads it via
   * getOpenClaudeLedgerProviderId() — recording the harness name 'openclaude'
   * instead makes free-router work bill as an invented estimate.
   */
  ledgerProviderId?: string
  /**
   * openclaude only: the model id the RUNNING sidecar was spawned with
   * (`OPENAI_MODEL`), captured beside the gateway above. Read by spend
   * accounting via getOpenClaudeLedgerModelId() for a run that reported none.
   */
  ledgerModelId?: string
}

const slots = new Map<SidecarId, SidecarSlot>([
  ['freellmapi',          { state: 'stopped' }],
  ['openclaude',          { state: 'stopped' }],
  ['freeclaudecode',      { state: 'stopped' }],
  ['claude-code-router',  { state: 'stopped' }],
  // llama-cpp's lifecycle is owned by llama-cpp-client.ts; this slot exists
  // only so listSidecars() / stopAllSidecars() can include it in the unified
  // surface. Status mirroring is done lazily in listSidecars() below.
  ['llama-cpp',           { state: 'stopped' }],
  ['darksol',             { state: 'stopped' }],
])

const PREFERRED_PORT_FREELLMAPI         = 31415
const PREFERRED_PORT_OPENCLAUDE         = 50052
const PREFERRED_PORT_FREECLAUDECODE     = 8082
const PREFERRED_PORT_CLAUDE_CODE_ROUTER = 3456
const PREFERRED_PORT_DARKSOL            = 18790  // darksol agent-signer loopback (integration-plan §4.2)
const FCC_AUTH_TOKEN                 = 'freecc'  // default token; can be overridden via env
const HEALTH_POLL_INTERVAL_MS   = 500
const MAX_HEALTH_ATTEMPTS       = 20  // 10 s total
const OPENGATEWAY_BASE_URL       = 'https://opengateway.gitlawb.com/v1'
const BANKR_BASE_URL             = 'https://llm.bankr.bot/v1'
const VENICE_BASE_URL            = 'https://api.venice.ai/api/v1'
// imgnAI Katana — OpenAI-compatible gateway (glm-5-2 / gpt-5-6 / deepseek behind
// one combined credential, stored in the keychain under 'imgnai').
const IMGNAI_BASE_URL            = 'https://kat.imgnai.com/v1'
// Surplus Intelligence — OpenAI-compatible marketplace. NOTE: base path is
// /api/inference/v1, NOT a bare /v1. Plain HTTPS (Vercel) — no proxy workaround.
const SURPLUS_BASE_URL           = 'https://www.surplusintelligence.ai/api/inference/v1'

// ─── Agent provider override ─────────────────────────────────────────────────
//
// When the user picks "Bankr" in the AgentPage provider selector, the next
// startOpenClaude() invocation routes the harness's OpenAI-
// compatible env at https://llm.bankr.bot/v1 with the user's Bankr key + the
// selected model. Routing is captured at spawn time, so changing the override
// while a sidecar is running has no effect until stop+restart.
//
// `default` (or unset) preserves the original priority:
//   OpenGateway > freellmapi > none
export type AgentProviderOverride =
  | { kind: 'default' }
  | { kind: 'opengateway' }
  | { kind: 'bankr'; model: string }
  | { kind: 'surplus'; model: string }
  | { kind: 'venice'; model: string }
  | { kind: 'imgnai'; model: string }

let agentProviderOverride: AgentProviderOverride = { kind: 'default' }

export function setAgentProviderOverride(o: AgentProviderOverride): void {
  agentProviderOverride = o
}

export function getAgentProviderOverride(): AgentProviderOverride {
  return agentProviderOverride
}

/**
 * Build the env block routing an OpenAI-compatible harness (openclaude)
 * at Bankr's gateway. Returns null when no Bankr key is set so callers can
 * fall back to the default routing.
 */
function buildBankrEnv(model: string): Record<string, string> | null {
  const key = retrieveKey('bankr-gateway')
  if (!key) return null
  return {
    OPENAI_BASE_URL: BANKR_BASE_URL,
    OPENAI_API_KEY:  key,
    OPENAI_MODEL:    model,
  }
}

/**
 * Build the env routing an OpenAI-compatible harness at Surplus Intelligence.
 * Returns null when no Surplus key is set so callers can surface the error.
 * Surplus is plain HTTPS (no Cloudflare proxy workaround needed) — same shape
 * as Bankr, just a different base URL + key.
 */
function buildSurplusEnv(model: string): Record<string, string> | null {
  const key = retrieveKey('surplus')
  if (!key) return null
  return {
    OPENAI_BASE_URL: SURPLUS_BASE_URL,
    OPENAI_API_KEY:  key,
    OPENAI_MODEL:    model,
  }
}

/**
 * Build the env routing an OpenAI-compatible harness at Venice (api.venice.ai).
 * Privacy-first, OpenAI-compatible — same shape as Bankr/Surplus, different base
 * + key. Returns null when no Venice key is set so callers can surface the error.
 */
function buildVeniceEnv(model: string): Record<string, string> | null {
  const key = retrieveKey('venice')
  if (!key) return null
  return {
    OPENAI_BASE_URL: VENICE_BASE_URL,
    OPENAI_API_KEY:  key,
    OPENAI_MODEL:    model,
  }
}

/**
 * Build the env routing an OpenAI-compatible harness at imgnAI Katana
 * (kat.imgnai.com). Bearer = the COMBINED credential stored under 'imgnai'
 * (api_key:api_secret). Same shape as Bankr/Surplus/Venice — different base +
 * key. Returns null when no imgnAI credential is set so callers can surface
 * the error.
 */
function buildImgnaiEnv(model: string): Record<string, string> | null {
  const key = retrieveKey('imgnai')
  if (!key) return null
  return {
    OPENAI_BASE_URL: IMGNAI_BASE_URL,
    OPENAI_API_KEY:  key,
    OPENAI_MODEL:    model,
  }
}

// The OpenGateway env is built INLINE in startOpenClaude()'s routing tuple —
// there is deliberately no helper here. A dead sibling of that env lived at
// this spot until 2026-08-01 and had to be edited in lockstep every time the
// routing changed (the mimo→nemotron repin touched both), which is the exact
// shape of the badge/routing drift it was silently mirroring. One copy only.

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a path inside the bundled sidecars directory.
 *
 * Dev:  apps/desktop/resources/sidecars/<parts>
 * Prod: process.resourcesPath/sidecars/<parts>
 */
function sidecarPath(...parts: string[]): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'sidecars', ...parts)
  }
  return join(app.getAppPath(), 'resources', 'sidecars', ...parts)
}

// ─── Health poll ─────────────────────────────────────────────────────────────

async function pollUntilHealthy(url: string): Promise<void> {
  for (let i = 0; i < MAX_HEALTH_ATTEMPTS; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) as AbortSignal })
      if (res.ok || res.status < 500) return
    } catch { /* keep polling */ }
    await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
  throw new Error(`Health check timed out after ${MAX_HEALTH_ATTEMPTS * HEALTH_POLL_INTERVAL_MS} ms for ${url}`)
}

// ─── Health-poll circuit breaker (Pulse internal/monitoring/circuit_breaker.go) ─
//
// The renderer's StatusPage polls sidecar:health on a fixed short interval
// (HEALTH_POLL_INTERVAL_MS). Without a breaker, a crashed/stopped sidecar gets
// re-probed at that same fast cadence forever — a tight fetch loop against a
// dead port. Each slot gets its own breaker: after a few consecutive failed
// probes the breaker opens and healthCheckSidecar() short-circuits to `false`
// WITHOUT firing the HTTP request, re-probing only on a binary-exponential
// backoff (capped). One success closes the breaker and snaps the slot back to
// the normal poll cadence.
//
// Tuned to the existing poll loop: baseDelayMs == the poll interval so the
// first backoff equals one skipped poll, doubling up to BREAKER_MAX_DELAY_MS.
const BREAKER_FAILURE_THRESHOLD = 3
const BREAKER_MAX_DELAY_MS      = 30_000

const breakers = new Map<SidecarId, CircuitBreaker>()

function breakerFor(id: SidecarId): CircuitBreaker {
  let b = breakers.get(id)
  if (!b) {
    b = new CircuitBreaker({
      failureThreshold: BREAKER_FAILURE_THRESHOLD,
      baseDelayMs:      HEALTH_POLL_INTERVAL_MS,
      maxDelayMs:       BREAKER_MAX_DELAY_MS,
    })
    breakers.set(id, b)
  }
  return b
}

// Reset a slot's breaker so a freshly (re)started sidecar gets the normal poll
// cadence immediately instead of inheriting an open breaker from a prior run.
function resetBreaker(id: SidecarId): void {
  breakers.get(id)?.recordSuccess()
}

/** Observability: per-sidecar breaker state for the StatusPage / debugger. */
export function breakerSnapshot(id: SidecarId): BreakerSnapshot {
  return breakerFor(id).snapshot()
}

// ─── freellmapi ───────────────────────────────────────────────────────────────

/**
 * Start freellmapi on a free port (preferred 31415).
 * No-op if already starting or running.
 */
export async function startFreellmapi(): Promise<void> {
  const slot = slots.get('freellmapi')!
  if (slot.state === 'running' || slot.state === 'starting') return
  resetBreaker('freellmapi')  // fresh start → clear any open breaker from a prior run

  const entry = sidecarPath('freellmapi', 'server', 'dist', 'index.js')
  if (!existsSync(entry)) {
    const msg = `freellmapi not found at ${entry}. Run: pnpm prepare:sidecars`
    slot.state = 'error'
    slot.error = msg
    throw new Error(msg)
  }

  // Bug 1(b): auto-build the dashboard client if dist/index.html is missing.
  // Happens on first run after clone or after clearing node_modules. Uses npm
  // (not pnpm) so the freellmapi npm-workspace resolves its own Tailwind v4
  // without being overridden by TachiDesk's root pnpm workspace (Tailwind v3).
  // DEV-ONLY: a packaged app must not assume npm on the user's machine — the
  // dashboard is non-essential (the chat API works without it), so we log and
  // continue instead. prepare:sidecars builds the client at package time.
  const clientDist = sidecarPath('freellmapi', 'client', 'dist', 'index.html')
  if (!existsSync(clientDist) && app.isPackaged) {
    console.warn('[freellmapi] dashboard client dist missing in packaged build — continuing without it.')
  } else if (!existsSync(clientDist)) {
    console.log('[freellmapi] building dashboard client (first run, ~30s)...')
    const clientDir = sidecarPath('freellmapi', 'client')
    await new Promise<void>((resolve, reject) => {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      const buildProc = spawn(npmCmd, ['run', 'build'], {
        cwd:   clientDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      buildProc.stdout?.on('data', d => process.stdout.write(`[freellmapi-build] ${d}`))
      buildProc.stderr?.on('data', d => process.stderr.write(`[freellmapi-build] ${d}`))
      buildProc.on('error', reject)
      buildProc.on('exit', code => {
        if (code === 0) resolve()
        else reject(new Error(`freellmapi client build exited with code ${code}`))
      })
    })
    console.log('[freellmapi] dashboard client build complete.')
  }

  // Set state synchronously before any await to prevent race conditions
  slot.state     = 'starting'
  slot.error     = undefined
  slot.startedAt = undefined

  const port = await findFreePort(PREFERRED_PORT_FREELLMAPI)
  slot.port = port

  // Create a promise that rejects immediately when the process exits unexpectedly
  let rejectOnExit!: (err: Error) => void
  const processExited = new Promise<never>((_, reject) => { rejectOnExit = reject })

  // KEYLESS FIRST-RUN (P0): pick the runtime by the tree's native-addon ABI.
  //   - prepare:sidecars stamps `.abi` = "electron-<ver>" after rebuilding
  //     better-sqlite3 for Electron → spawn OUR OWN binary with
  //     ELECTRON_RUN_AS_NODE=1. End users need NO system Node.js.
  //   - no stamp (runtime git-clone install, or a pre-stamp dev tree) → the
  //     addons were built by system npm for system Node → spawn system node.
  const abiFile = sidecarPath('freellmapi', '.abi')
  let electronAbi = false
  try { electronAbi = readFileSync(abiFile, 'utf8').trim().startsWith('electron-') } catch { /* no stamp */ }

  const spawnCmd = electronAbi
    ? process.execPath
    : (process.platform === 'win32' ? 'node.exe' : 'node')
  const proc = spawn(spawnCmd, [entry], {
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      ...(electronAbi ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    stdio:    ['ignore', 'ignore', 'ignore'],
    detached: false,
  })

  slot.proc = proc
  slot.pid  = proc.pid

  proc.on('error', err => {
    // ENOENT on the system-node path = the machine has no Node.js. Make the
    // error ACTIONABLE instead of a raw spawn dump (P0: stranger first-run).
    const friendly = !electronAbi && (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'The free AI engine needs Node.js 22+ on this machine (or a bundled build). ' +
        'Install Node.js from nodejs.org and retry — or add a provider API key in Settings; cloud providers work without it.'
      : `spawn error: ${err.message}`
    rejectOnExit(new Error(friendly))
    const s = slots.get('freellmapi')!
    s.state = 'error'
    s.error = friendly
    s.proc  = undefined
    s.pid   = undefined
  })

  proc.on('exit', code => {
    rejectOnExit(new Error(`process exited with code ${code ?? 'null'}`))
    const s = slots.get('freellmapi')!
    if (s.state === 'running' || s.state === 'starting') {
      s.state = code === 0 ? 'stopped' : 'error'
      s.error = code !== 0 ? `exited with code ${code}` : undefined
    }
    s.proc = undefined
    s.pid  = undefined
  })

  try {
    await Promise.race([
      pollUntilHealthy(`http://127.0.0.1:${port}/api/ping`),
      processExited,
    ])
    slot.state     = 'running'
    slot.startedAt = Date.now()

    // Say out loud whether the relay on disk is the relay we think we shipped.
    // The 2026-08-01 installer went out with vendor patch #2 missing and there
    // was no line anywhere — in the build log or the app — that would have told
    // anyone. This is that line, on every start, before the first send.
    logPatchVerdicts('freellmapi', verifyInstalledFreellmapiPatches())

    // Fetch the unified API key so freellmapi-client can authenticate requests.
    // /api/settings/api-key requires no auth — intentionally public on localhost.
    try {
      const keyRes = await fetch(`http://127.0.0.1:${port}/api/settings/api-key`)
      if (keyRes.ok) {
        const { apiKey } = await keyRes.json() as { apiKey: string }
        slot.apiKey = apiKey
      }
    } catch { /* non-fatal — key will be fetched lazily on first chat request */ }

    // Auto-seed placeholder keys for anonymous free-tier providers so chat works
    // out of the box without any configuration. freellmapi's router skips
    // platforms with no key entries even when those platforms don't validate the
    // key — a non-empty placeholder is enough.
    //
    // THIS LIST IS THE CHEAPEST FAILOVER CONTROL WE HAVE. The router checks
    // "does this platform have >= 1 key" BEFORE it opens any socket, so a
    // platform absent from here costs exactly zero per send. That makes seeding
    // a DEAD upstream strictly worse than not seeding it: it buys nothing and
    // burns a round-trip on every request that falls through to it.
    //
    // Probed live 2026-08-01 with this exact placeholder (nonce per prompt):
    //   kilo         200 on every free row — header ignored entirely.  SEEDED
    //   zen          200 keyless (bearer would 401; the vendored provider
    //                sets omitAuth so the placeholder never reaches the wire). SEEDED
    //   llm7         codestral-latest 200; its other 4 catalog rows are 400
    //                "currently unavailable" and V13 disables them.     SEEDED
    //   ovh          403 x5 "authentication failed … oauth/ovh/authorize" —
    //                the anonymous tier is GONE, replaced by OAuth.     DROPPED
    //   pollinations 402 Payment Required x4 + legacy-API deprecation
    //                notice, and it took 22-24s to say so twice.        DROPPED
    // The two dropped platforms stay registered in the relay, so a user who adds
    // a real key to the freellmapi dashboard still routes through them; we simply
    // stop asserting a free tier that no longer exists.
    //
    // THE SEED RESULT IS NOW READ. It used to be fire-and-forget inside a bare
    // `catch`, and that is how `zen` failed silently for a whole release: the
    // relay shipped without vendor patch #2, so `zen` was not in its keys-route
    // allowlist, every anon POST for it 400'd, and nothing logged a word — while
    // the Free Providers card went on advertising OpenCode Zen as
    // [FREE · NO KEY]. A seed that does not land is exactly the thing that makes
    // the UI lie, so it gets the loudest line in this function.
    try {
      const keysRes = await fetch(`http://127.0.0.1:${port}/api/keys`)
      if (keysRes.ok) {
        const existing = await keysRes.json() as Array<{ platform: string }>
        const seeded   = new Set(existing.map(k => k.platform))
        const anon = [
          { platform: 'kilo',         label: 'Anonymous (no key required)' },
          { platform: 'zen',          label: 'Anonymous (no key required)' },
          { platform: 'llm7',         label: 'Anonymous (no key required)' },
        ]
        for (const { platform, label } of anon) {
          if (seeded.has(platform)) continue
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/keys`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ platform, key: 'anonymous', label }),
            })
            if (res.ok) {
              console.log(`[freellmapi-seed] anon platform seeded: ${platform}`)
            } else {
              const detail = await res.text().catch(() => '')
              console.error(
                `[freellmapi-seed] ANON SEED REJECTED for '${platform}' (HTTP ${res.status}). `
                + `The relay does not know this platform — it is almost certainly missing a vendor patch. `
                + `The free route will NOT use ${platform}. ${detail.slice(0, 200)}`,
              )
            }
          } catch (e) {
            console.error(`[freellmapi-seed] anon seed for '${platform}' failed:`, e)
          }
        }
      }
    } catch (e) { console.warn('[freellmapi-seed] anon seeding skipped:', e) }

    // Auto-seed any API keys the user has already saved in Tachi's keychain
    // into freellmapi's key store. This runs once per freellmapi startup so
    // users don't need to re-enter keys they already added via Settings.
    // Providers that require no key (kilo, zen, llm7) are skipped here — they're
    // handled by the anon seed block above. Kilo is deliberately NOT listed
    // below even though it has a key concept upstream: it 200s any bearer, so a
    // "key" for it can never be validated and there is no Kilo key in Tachi's
    // keychain to seed.
    //
    // The seeding is idempotent: we read the existing keys list first and
    // skip platforms that already have at least one key entry.
    try {
      const keysRes2 = await fetch(`http://127.0.0.1:${port}/api/keys`)
      if (keysRes2.ok) {
        const existingKeys = await keysRes2.json() as Array<{ platform: string }>
        const seeded = new Set(existingKeys.map(k => k.platform))
        // Platforms that accept real API keys (excludes anon-only platforms)
        const seedable: Array<{ platform: string; label: string }> = [
          { platform: 'google',     label: 'Google Gemini (seeded from Tachi)' },
          { platform: 'groq',       label: 'Groq (seeded from Tachi)' },
          { platform: 'cerebras',   label: 'Cerebras (seeded from Tachi)' },
          { platform: 'sambanova',  label: 'SambaNova (seeded from Tachi)' },
          { platform: 'nvidia',     label: 'NVIDIA NIM (seeded from Tachi)' },
          { platform: 'mistral',    label: 'Mistral (seeded from Tachi)' },
          { platform: 'openrouter', label: 'OpenRouter (seeded from Tachi)' },
          { platform: 'github',     label: 'GitHub Models (seeded from Tachi)' },
          { platform: 'cohere',     label: 'Cohere (seeded from Tachi)' },
          { platform: 'cloudflare', label: 'Cloudflare AI (seeded from Tachi)' },
          { platform: 'zhipu',      label: 'Zhipu GLM (seeded from Tachi)' },
          { platform: 'ollama',     label: 'Ollama Cloud (seeded from Tachi)' },
        ]
        for (const { platform, label } of seedable) {
          if (seeded.has(platform)) continue  // already present
          const rawKey = retrieveKey(platform)
          if (!rawKey) continue  // user hasn't saved this key in Tachi
          // Sanitize: strip common paste-mistake wrappers — `from`/`KEY=`/
          // surrounding quotes / trailing `)` from copied code snippets.
          // Then validate format: real API keys are 16+ chars, alphanumeric
          // plus dashes/underscores/dots, no spaces. If the result still looks
          // wrong (contains `=`, `"`, `(`, `)`, `from`, whitespace), skip it
          // and warn — better to omit than to push a 401-loop into freellmapi.
          const stripped = rawKey
            .replace(/^\s*from\s+/i, '')              // accidental "from foo" prefix
            .replace(/^[A-Z_]+\s*=\s*/, '')           // accidental NVIDIA_KEY= prefix
            .replace(/^["'`]+|["'`]+$/g, '')          // surrounding quotes
            .replace(/^\(+|\)+$/g, '')                // surrounding parens
            .trim()
          const looksValid = /^[A-Za-z0-9._-]{16,}$/.test(stripped)
          if (!looksValid) {
            const masked = stripped.length > 0
              ? `${stripped.slice(0, 4)}...${stripped.slice(-4)}`
              : '(empty)'
            console.warn(
              `[freellmapi-seed] SKIPPING ${platform}: stored key looks invalid `
              + `(masked: ${masked}). Open the freellmapi dashboard or Tachi `
              + `Free Providers card and paste the raw API key (no quotes/code).`,
            )
            continue
          }
          try {
            const res = await fetch(`http://127.0.0.1:${port}/api/keys`, {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ platform, key: stripped, label }),
            })
            // Log only the platform, key LENGTH, and HTTP status — never any
            // characters of the secret. (audit 2026-06-12: the previous log
            // leaked first-8 + last-4 = 12 chars of the live key to stdout,
            // enough to meaningfully narrow a short/low-entropy key.)
            console.log(
              `[freellmapi-seed] sent key for ${platform} `
              + `(len=${stripped.length}, http=${res.status})`,
            )

            // VALIDATE WHAT WE JUST SEEDED. A key lands in the relay with
            // status='unknown' and the router treats unknown as usable, so an
            // expired credential from Tachi's keychain silently occupied a slot
            // in the failover chain. That is how a revoked OpenRouter key
            // ("401 User not found") became the answer to a keyless send on
            // 2026-08-01: nothing had ever asked the upstream whether it was
            // still good, and the router surfaced its 401 instead of routing
            // past it. The relay's own checker answers in one round-trip and
            // writes status='invalid', which routeRequest() filters out before
            // it opens a socket — a dead credential now costs zero sends
            // instead of every send.
            //
            // Best-effort by design: a transport failure marks 'error', not
            // 'invalid', so an offline first-run never condemns a good key.
            if (res.ok) {
              const created = await res.json().catch(() => null) as { id?: number } | null
              if (typeof created?.id === 'number') {
                try {
                  const chk = await fetch(`http://127.0.0.1:${port}/api/health/check/${created.id}`, {
                    method: 'POST',
                    signal: AbortSignal.timeout(15_000) as AbortSignal,
                  })
                  const status = chk.ok
                    ? ((await chk.json().catch(() => null)) as { status?: string } | null)?.status
                    : undefined
                  if (status === 'invalid') {
                    console.warn(
                      `[freellmapi-seed] ${platform} key REJECTED by the provider — marked invalid in the `
                      + `relay and skipped by the router. Replace it in Settings › Free Providers.`,
                    )
                  } else {
                    console.log(`[freellmapi-seed] ${platform} key checked: ${status ?? 'unchecked'}`)
                  }
                } catch {
                  console.log(`[freellmapi-seed] ${platform} key not checked (provider unreachable) — left as-is`)
                }
              }
            }
          } catch (e) {
            console.warn(`[freellmapi-seed] failed for ${platform}:`, e)
          }
        }
      }
    } catch { /* non-fatal — user can add keys manually via freellmapi dashboard */ }
  } catch (err) {
    if (proc.exitCode === null) proc.kill()  // only kill if still alive
    slot.state = 'error'
    slot.error = String(err)
    slot.proc  = undefined
    slot.pid   = undefined
    throw err
  }
}

/** Stop freellmapi. No-op if not running. */
export function stopFreellmapi(): void {
  const slot = slots.get('freellmapi')!
  if (slot.proc) {
    slot.proc.kill()
    slot.state = 'stopped'
    slot.proc  = undefined
  }
}

/** Returns the port freellmapi is listening on, or undefined if not running. */
export function getFreellmapiPort(): number | undefined {
  return slots.get('freellmapi')?.port
}

/** Returns the unified API key for authenticating requests to freellmapi. */
export function getFreellmapiApiKey(): string | undefined {
  return slots.get('freellmapi')?.apiKey
}

// ─── openclaude ───────────────────────────────────────────────────────────────

/**
 * Start OpenClaude gRPC server on a free port (preferred 50052).
 * Uses system Node (not Electron's bundled one) — requires Node ≥ 22.
 * No-op if already starting or running.
 *
 * C3 invariant: sidecar restart MUST preserve conversation context via checkpoint replay.
 * OpenClaude is stateless at the server level (no server-side session objects); the
 * @gitlawb/openclaude SDK accumulates history inside the OpenClaudeClient instance.
 * When the client is destroyed and the server restarts, that in-process history is lost.
 *
 * TODO(C3-replay): Implement checkpoint replay for OpenClaude restarts.
 *
 *   What this function needs:
 *     - Accept an optional `sessionId?: string` parameter (passed through from
 *       agent.ipc.ts when a restart is detected mid-session).
 *
 *   What the harness adapter must do after startOpenClaude() succeeds:
 *     1. Call `loadCheckpoint(sessionId)` from sidecar-checkpoints.ts to get Turn[].
 *     2. Instantiate a new OpenClaudeClient(port).
 *     3. Seed the client's conversation history from the turns — the SDK exposes
 *        a `conversationHistory` or `messages` property (check @gitlawb/openclaude
 *        SDK source at the time of implementation; the field name may differ).
 *        Map Turn roles to the SDK's message format:
 *          'user'        → { role: 'user',      content: turn.content }
 *          'assistant'   → { role: 'assistant',  content: turn.content }
 *          'tool-call'   → { role: 'assistant',  tool_calls: [...] }  (SDK-specific)
 *          'tool-result' → { role: 'user',       tool_call_id: ... }  (SDK-specific)
 *     4. Return the seeded client so agent.ipc.ts can use it for the next sendTask call.
 *
 *   Functions to update when implementing:
 *     - startOpenClaude() — add sessionId param
 *     - agent.ipc.ts agent:send handler — detect restart, pass sessionId, use seeded client
 *     - OpenClaudeClient — add seedHistory(turns: Turn[]) method
 */
export async function startOpenClaude(): Promise<void> {
  const slot = slots.get('openclaude')!
  if (slot.state === 'running' || slot.state === 'starting') return
  resetBreaker('openclaude')  // fresh start → clear any open breaker from a prior run

  // Always refresh the wrapper script. Cheap; ensures users with stale
  // wrappers (e.g. predating an SDK signature change) get healed.
  writeOpenClaudeWrapper()

  const entry = openclaudeEntry()
  if (!existsSync(entry)) {
    const msg = 'OpenClaude not installed. Install it from the Status page.'
    slot.state = 'error'
    slot.error = msg
    throw new Error(msg)
  }

  slot.state     = 'starting'
  slot.error     = undefined
  slot.startedAt = undefined

  const port = await findFreePort(PREFERRED_PORT_OPENCLAUDE)
  slot.port = port

  let rejectOnExit!: (err: Error) => void
  const processExited = new Promise<never>((_, reject) => { rejectOnExit = reject })

  // Use system node (not Electron's bundled node) — openclaude requires Node >= 22
  const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'

  // Determine the model-provider env to pass to the wrapper.
  // Priority order (highest → lowest):
  //   0. Bankr override   → OPENAI_BASE_URL=llm.bankr.bot/v1 + key + selected model
  //   1. OpenGateway key  → OPENAI_BASE_URL=opengateway  + OPENAI_API_KEY=<ogw key>
  //   2. freellmapi local → OPENAI_BASE_URL=localhost:<freellmapi port>/v1  + OPENAI_API_KEY=<freellmapi key>
  //   3. Nothing          → openclaude may fall back to its own ANTHROPIC_API_KEY handling
  //
  // (0) wins only when the user explicitly picked Bankr in AgentPage — without
  // that opt-in we keep the existing local-first behaviour so the rest of the
  // app (Studio scans, freellmapi background work, etc.) stays cost-free.
  const bankrEnv: Record<string, string> | null =
    agentProviderOverride.kind === 'bankr' ? buildBankrEnv(agentProviderOverride.model) : null
  const surplusEnv: Record<string, string> | null =
    agentProviderOverride.kind === 'surplus' ? buildSurplusEnv(agentProviderOverride.model) : null
  const veniceEnv: Record<string, string> | null =
    agentProviderOverride.kind === 'venice' ? buildVeniceEnv(agentProviderOverride.model) : null
  const imgnaiEnv: Record<string, string> | null =
    agentProviderOverride.kind === 'imgnai' ? buildImgnaiEnv(agentProviderOverride.model) : null

  const opengatewayKey = retrieveKey('opengateway')
  const freellmapiPort  = getFreellmapiPort()
  const freellmapiKey   = getFreellmapiApiKey()
  // Explicit OpenGateway pick forces the gateway route even with no key on file
  // (the pinned model is verified free — no credits needed for it).
  const forceOpenGateway = agentProviderOverride.kind === 'opengateway'

  // Pick the right default model for the active gateway — each gateway has its
  // own catalog and rejects names from the other.
  //   Bankr:       user-selected (claude-opus-5 by default for coding)
  //   OpenGateway: OPENGATEWAY_AGENT_MODEL (@tachi/core agent-route.ts — the
  //                verified-free nemotron; repointed 2026-08-01 from the fossil
  //                'mimo-v2.5-pro' pin that kept billing after MiMo went paid
  //                07-16. Free models carry the gateway's per-day quota — on
  //                exhaustion it 429s and the SDK error stream carries the body.)
  //   freellmapi:  'auto' (router picks best free provider; avoids GitHub/LLM7 paid-tier 402 errors)
  //
  // For OpenGateway we route the SDK at our LOCAL proxy (/v1-proxy) and forward
  // upstream via node:https in the wrapper. This is necessary because the SDK's
  // undici-based fetch consistently fails against Cloudflare-fronted OpenGateway
  // with 'TypeError: terminated' — node:https works fine. Bankr does NOT need
  // that workaround (its endpoint is plain HTTPS, no Cloudflare quirks).
  // Tagged routing tuple: the gateway choice and the ledger provider id that
  // names it are picked in ONE expression, so the spend-accounting label can
  // never diverge from where the tokens actually go. Captured onto the slot
  // right below (routing is fixed at spawn — see the AgentProviderOverride
  // note above); spend accounting reads it back via
  // getOpenClaudeLedgerProviderId() when recording a /query. The ids are the
  // registry/keychain ids the cost ledger understands ('freellmapi-local' =
  // the free local router → unpricedReason 'free' → $0 against the cap) —
  // NEVER the harness name 'openclaude', which matches no registry entry and
  // used to charge llmBudgetUsd30d an invented estimate for free work.
  const routing: { providerId: string | null; env: Record<string, string> } = bankrEnv
    ? { providerId: 'bankr-gateway', env: bankrEnv }
    : surplusEnv
    ? { providerId: 'surplus', env: surplusEnv }
    : veniceEnv
    ? { providerId: 'venice', env: veniceEnv }
    : imgnaiEnv
    ? { providerId: 'imgnai', env: imgnaiEnv }
    : (forceOpenGateway || opengatewayKey)
    ? {
        providerId: 'opengateway',
        env: {
          OPENAI_BASE_URL:          `http://127.0.0.1:${port}/v1-proxy`,
          UPSTREAM_OPENAI_BASE_URL: OPENGATEWAY_BASE_URL,
          OPENAI_API_KEY:           opengatewayKey ?? '',
          OPENAI_MODEL:             OPENGATEWAY_AGENT_MODEL,
        },
      }
    : (freellmapiPort && freellmapiKey
        ? {
            providerId: 'freellmapi-local',
            env: {
              OPENAI_BASE_URL: `http://127.0.0.1:${freellmapiPort}/v1`,
              OPENAI_API_KEY:  freellmapiKey,
              OPENAI_MODEL:    'auto',
            },
          }
        : { providerId: null, env: {} })
  const baseModelEnv: Record<string, string> = routing.env
  slot.ledgerProviderId = routing.providerId ?? undefined
  // Captured from the tuple that was just built, so it names THIS process's
  // model rather than the next spawn's — the same rule as the provider above.
  slot.ledgerModelId = routing.env.OPENAI_MODEL || undefined

  // The @gitlawb/openclaude SDK defaults to Anthropic. To route via an
  // OpenAI-compatible endpoint (freellmapi or opengateway) we MUST set
  // CLAUDE_CODE_USE_OPENAI=1 (per the SDK README "Fastest OpenAI setup"),
  // otherwise every /query call fails silently with no model backend.
  const modelEnv: Record<string, string> = Object.keys(baseModelEnv).length > 0
    ? { ...baseModelEnv, CLAUDE_CODE_USE_OPENAI: '1' }
    : {}

  // ── Sandbox: redirect the SDK's config dir to a Tachi-private directory ──────
  //
  // Without this override the SDK loads skills, memory files, and settings
  // from the user's real config dir — leaking the user's personal OpenClaude /
  // Claude Code state into every Tachi agent run.
  //
  // WHICH ENV VAR WORKS DEPENDS ON THE SDK VERSION (pin lives in
  // openclaude-installer.ts):
  //
  //   >= 0.23.0 (current pin 0.27.0): the SDK reads ~/.openclaude and honours
  //     ONLY `OPENCLAUDE_CONFIG_DIR` (added 0.20.0). The 0.27.0 README states
  //     it "does not read ~/.claude, project .claude/ directories, or
  //     CLAUDE_CONFIG_DIR". So OPENCLAUDE_CONFIG_DIR is the var that makes the
  //     sandbox real — without it the sandbox silently no-ops and the agent
  //     reads the user's real ~/.openclaude. It MUST ship in the same commit
  //     as any pin bump across 0.23.0.
  //
  //   <  0.23.0: the SDK read `CLAUDE_CONFIG_DIR` (sdk.mjs ~line 3309) falling
  //     back to homedir()/.openclaude. We keep CLAUDE_CONFIG_DIR and
  //     CLAUDE_HOME set too — harmless on new versions (ignored), and they
  //     keep the sandbox working if the pin is ever rolled back.
  const tachiSandboxDir = join(app.getPath('userData'), 'openclaude-sandbox')
  try { mkdirSync(tachiSandboxDir, { recursive: true }) } catch { /* ignore if exists */ }
  console.log(`[openclaude] config sandbox: ${tachiSandboxDir}`)

  const proc = spawn(nodeCmd, [entry], {
    windowsHide: true,
    // Pin the sidecar's process.cwd() to home so that if a /query call arrives
    // with an empty cwd (shouldn't happen, but defensive), process.cwd() doesn't
    // resolve to Electron's source tree (apps/desktop in dev, install dir in prod).
    // The wrapper overrides cwd per-request via process.chdir(cwd) anyway.
    cwd: app.getPath('home'),
    env: {
      ...process.env,
      OPENCLAUDE_HTTP_PORT: String(port),
      // Redirect SDK config to Tachi-private sandbox so the agent CANNOT read
      // the user's ~/.openclaude skills, memory files, or CLAUDE.md.
      // OPENCLAUDE_CONFIG_DIR is the var SDK >= 0.23.0 honours (CLAUDE_CONFIG_DIR
      // is explicitly ignored there); the two legacy vars cover pins < 0.23.0.
      // All three MUST point at the same sandbox path — see the comment block
      // above tachiSandboxDir.
      OPENCLAUDE_CONFIG_DIR: tachiSandboxDir,
      CLAUDE_CONFIG_DIR:     tachiSandboxDir,
      CLAUDE_HOME:           tachiSandboxDir,
      ...modelEnv,
    },
    stdio:    ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  // Keep the last few KB the child printed. A sidecar that dies at startup has
  // ALREADY said why on stderr — before 2026-08-02 that text went only to the
  // log file and the main-process console, and the user got the bare
  // "process exited with code 1". The tail is what makes the exit explainable.
  const logPath = openclaudeLogPath()
  let outputTail = ''
  const captureTail = (d: Buffer | string): void => {
    outputTail = (outputTail + String(d)).slice(-4096)
  }
  proc.stdout?.on('data', d => { captureTail(d); process.stdout.write(`[openclaude] ${d}`) })
  proc.stderr?.on('data', d => { captureTail(d); process.stderr.write(`[openclaude-err] ${d}`) })

  // Pipe stdout/stderr to a rolling log file in userData so we can debug
  // silent hangs (e.g. SDK auth errors that never surface in /query response).
  try {
    const logStream = createWriteStream(logPath, { flags: 'a' })
    logStream.write(`\n--- openclaude start ${new Date().toISOString()} port=${port} ---\n`)
    proc.stdout?.pipe(logStream)
    proc.stderr?.pipe(logStream)
  } catch { /* logging is best-effort */ }

  slot.proc = proc
  slot.pid  = proc.pid

  proc.on('error', err => {
    // ENOENT on the system-node path = no Node.js on this machine. Say that,
    // not "spawn node.exe ENOENT" (parity with the freellmapi spawn handler).
    const friendly = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'OpenClaude needs Node.js 22+ on this machine. Install it from nodejs.org and retry.'
      : `OpenClaude could not be started: ${err.message}`
    rejectOnExit(new Error(friendly))
    const s = slots.get('openclaude')!
    s.state = 'error'
    s.error = friendly
    s.proc  = undefined
    s.pid   = undefined
  })

  proc.on('exit', code => {
    rejectOnExit(new Error(explainSidecarExit(code, outputTail, logPath, 'OpenClaude')))
    const s = slots.get('openclaude')!
    if (s.state === 'running' || s.state === 'starting') {
      s.state = code === 0 ? 'stopped' : 'error'
      s.error = code !== 0 ? `exited with code ${code}` : undefined
    }
    s.proc = undefined
    s.pid  = undefined
  })

  try {
    await Promise.race([
      pollUntilHealthy(`http://127.0.0.1:${port}/health`),
      processExited,
    ])
    slot.state     = 'running'
    slot.startedAt = Date.now()
  } catch (err) {
    if (proc.exitCode === null) proc.kill()
    slot.state = 'error'
    slot.error = String(err)
    slot.proc  = undefined
    slot.pid   = undefined
    throw err
  }
}

/**
 * Stop OpenClaude if it is running. No-op otherwise.
 *
 * C3 invariant: the caller is responsible for ensuring the session's checkpoint
 * is current BEFORE calling stopOpenClaude(). agent.ipc.ts writes every turn via
 * recordCheckpoint(sessionId, turn) so the checkpoint is durable at stop time.
 */
export function stopOpenClaude(): void {
  const slot = slots.get('openclaude')!
  if (slot.proc) {
    slot.proc.kill()
    slot.state = 'stopped'
    slot.proc  = undefined
    slot.pid   = undefined
  }
}

/** Returns the port OpenClaude gRPC server is listening on, or undefined if not running. */
export function getOpenClaudePort(): number | undefined {
  return slots.get('openclaude')?.port
}

/**
 * Ledger/registry id of the gateway the RUNNING openclaude sidecar routes to,
 * captured at the last startOpenClaude() spawn (tagged routing tuple above).
 * Routing is fixed at spawn, so THIS — not getAgentProviderOverride(), which
 * describes the NEXT spawn — is what spend accounting must record.
 * null → no gateway env was routed (the SDK fell back to its own
 * ANTHROPIC_API_KEY handling); callers keep their own fallback label.
 */
export function getOpenClaudeLedgerProviderId(): string | null {
  return slots.get('openclaude')?.ledgerProviderId ?? null
}

/**
 * The model id this sidecar was SPAWNED with (`OPENAI_MODEL` from the routing
 * tuple above), for a ledger record whose run never reported one.
 *
 * The twin of getOpenClaudeLedgerProviderId(), and for the same reason: the
 * spend record must name what this PROCESS is using, and the model is fixed at
 * spawn along with the gateway. Before this the fallback was the string
 * 'openclaude' — the harness's own name written into the model column, which is
 * not a model, matches no rate row, and left a live ledger row reading
 * `"model":"openclaude"`.
 *
 * Not a stronger claim than it looks: the SDK reports back the model it was
 * given rather than one it observed, so an id read off a run and this id are
 * the same kind of fact. This one merely survives a run that reported nothing.
 */
export function getOpenClaudeLedgerModelId(): string | null {
  return slots.get('openclaude')?.ledgerModelId ?? null
}

/**
 * Absolute path of the rolling openclaude log (stdout+stderr of every sidecar
 * start). ONE definition, used both by the spawn that writes it and by the
 * /query client that has to tell the user where a failure is written down —
 * `explainSidecarExit` already established that naming the log is part of an
 * honest failure message, and a run that dies mid-stream deserves the same.
 */
export function openclaudeLogPath(): string {
  return join(app.getPath('userData'), 'openclaude.log')
}

// ─── free-claude-code ─────────────────────────────────────────────────────────

/**
 * Detect how to launch the free-claude-code FastAPI server.
 * Returns { kind: 'binary', path } if `fcc-server` is on PATH,
 * { kind: 'uv' } if `uv` is on PATH (can `uv run fcc-server`),
 * or null if neither is available.
 */
async function detectFccLauncher(): Promise<{ kind: 'binary'; path: string } | { kind: 'uv' } | null> {
  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)

  // 1. Try fcc-server on PATH
  try {
    const which = process.platform === 'win32' ? 'where.exe' : 'which'
    const { stdout } = await exec(which, ['fcc-server'], { timeout: 5_000 })
    const path = stdout.split('\n')[0]?.trim()
    if (path) return { kind: 'binary', path }
  } catch { /* not on PATH */ }

  // 2. Try uv on PATH (means user can `uv run fcc-server`)
  try {
    const which = process.platform === 'win32' ? 'where.exe' : 'which'
    await exec(which, ['uv'], { timeout: 5_000 })
    return { kind: 'uv' }
  } catch { /* uv not installed */ }

  return null
}

/**
 * Start free-claude-code FastAPI proxy on a free port (preferred 8082).
 * No-op if already starting or running.
 * Throws an informative error if neither fcc-server nor uv is available.
 */
export async function startFreeClaudeCode(): Promise<void> {
  const slot = slots.get('freeclaudecode')!
  if (slot.state === 'running' || slot.state === 'starting') return
  resetBreaker('freeclaudecode')  // fresh start → clear any open breaker from a prior run

  // Detection: `fcc-server` on PATH, OR `uv` on PATH so we can `uv run fcc-server`
  const launcher = await detectFccLauncher()
  if (!launcher) {
    const msg = 'free-claude-code not installed. See https://github.com/Alishahryar1/free-claude-code'
    slot.state = 'error'
    slot.error = msg
    throw new Error(msg)
  }

  slot.state     = 'starting'
  slot.error     = undefined
  slot.startedAt = undefined

  const port = await findFreePort(PREFERRED_PORT_FREECLAUDECODE)
  slot.port = port

  let rejectOnExit!: (err: Error) => void
  const processExited = new Promise<never>((_, reject) => { rejectOnExit = reject })

  const proc = launcher.kind === 'binary'
    ? spawn(launcher.path, ['--port', String(port)], {
        env: { ...process.env, FCC_AUTH_TOKEN, PORT: String(port) },
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: false,
      })
    : spawn('uv', ['run', 'fcc-server', '--port', String(port)], {
        env: { ...process.env, FCC_AUTH_TOKEN, PORT: String(port) },
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: false,
        shell: true,
      })

  slot.proc = proc
  slot.pid  = proc.pid

  proc.on('error', err => {
    rejectOnExit(new Error(`spawn error: ${err.message}`))
    const s = slots.get('freeclaudecode')!
    s.state = 'error'; s.error = err.message; s.proc = undefined; s.pid = undefined
  })

  proc.on('exit', code => {
    rejectOnExit(new Error(`process exited with code ${code ?? 'null'}`))
    const s = slots.get('freeclaudecode')!
    if (s.state === 'running' || s.state === 'starting') {
      s.state = code === 0 ? 'stopped' : 'error'
      s.error = code !== 0 ? `exited with code ${code}` : undefined
    }
    s.proc = undefined; s.pid = undefined
  })

  try {
    await Promise.race([
      pollUntilHealthy(`http://127.0.0.1:${port}/v1/models`),
      processExited,
    ])
    slot.state     = 'running'
    slot.startedAt = Date.now()
  } catch (err) {
    if (proc.exitCode === null) proc.kill()
    slot.state = 'error'; slot.error = String(err); slot.proc = undefined; slot.pid = undefined
    throw err
  }
}

/** Stop free-claude-code if it is running. No-op otherwise. */
export function stopFreeClaudeCode(): void {
  const slot = slots.get('freeclaudecode')!
  if (slot.proc) {
    slot.proc.kill()
    slot.state = 'stopped'
    slot.proc  = undefined
    slot.pid   = undefined
  }
}

/** Returns the port free-claude-code is listening on, or undefined if not running. */
export function getFreeClaudeCodePort(): number | undefined {
  return slots.get('freeclaudecode')?.port
}

/** Returns the auth token for authenticating requests to free-claude-code. */
export function getFreeClaudeCodeToken(): string {
  return FCC_AUTH_TOKEN
}

// ─── claude-code-router ────────────────────────────────────────────────────────

/**
 * Probe ccr's default port. Returns true if a router is already responding.
 * ccr listens on 3456 by default — health is detected by ANY HTTP response
 * (its endpoints require auth/path, so we accept 4xx/5xx as "alive").
 */
async function isRouterAlreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(1500) as AbortSignal,
    })
    return res.status < 600  // anything that came back means the port is bound
  } catch {
    return false
  }
}

/**
 * Start @musistudio/claude-code-router on port 3456 (preferred).
 * No-op if already starting or running. Throws if package isn't installed globally.
 *
 * Adopts an externally-started ccr if one is already listening (ccr persists
 * a PID file at ~/.claude-code-router/.claude-code-router.pid and `ccr start`
 * intentionally exits 1 when it sees the port taken — we mirror that logic
 * here by probing the port first).
 */
export async function startRouter(): Promise<void> {
  const slot = slots.get('claude-code-router')!
  if (slot.state === 'running' || slot.state === 'starting') return
  resetBreaker('claude-code-router')  // fresh start → clear any open breaker from a prior run

  const ccrPath = await findCcrBinary()
  if (!ccrPath) {
    const msg = 'claude-code-router is not installed. Install it from the Settings page.'
    slot.state = 'error'
    slot.error = msg
    throw new Error(msg)
  }

  // Adopt an already-running instance instead of fighting over the port.
  if (await isRouterAlreadyRunning(PREFERRED_PORT_CLAUDE_CODE_ROUTER)) {
    slot.state     = 'running'
    slot.port      = PREFERRED_PORT_CLAUDE_CODE_ROUTER
    slot.startedAt = Date.now()
    slot.error     = undefined
    slot.proc      = undefined  // we don't own it
    slot.pid       = undefined
    return
  }

  slot.state     = 'starting'
  slot.error     = undefined
  slot.startedAt = undefined

  // ccr ignores PORT/CLAUDE_CODE_ROUTER_PORT envs and always uses 3456 from its
  // config (~/.claude-code-router/config.json). Keep our slot.port aligned.
  const port = PREFERRED_PORT_CLAUDE_CODE_ROUTER
  slot.port = port

  // SECURITY: write real api keys into the config ONLY now, just before launching
  // the proxy — they live on disk only while ccr runs (scrubbed on exit/stop).
  injectKeysForStart()

  let rejectOnExit!: (err: Error) => void
  const processExited = new Promise<never>((_, reject) => { rejectOnExit = reject })

  // Capture stdout/stderr so failure messages are visible in the dev log.
  // ccr's CLI is `ccr` (not `claude-code-router`) so we invoke the resolved
  // path directly rather than `npx @musistudio/claude-code-router`.
  const proc = spawn(ccrPath, ['start'], {
    env:      { ...process.env },
    stdio:    ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell:    process.platform === 'win32',
  })

  proc.stdout?.on('data', d => process.stdout.write(`[ccr] ${d}`))
  proc.stderr?.on('data', d => process.stderr.write(`[ccr-err] ${d}`))

  slot.proc = proc
  slot.pid  = proc.pid

  proc.on('error', err => {
    rejectOnExit(new Error(`spawn error: ${err.message}`))
    const s = slots.get('claude-code-router')!
    s.state = 'error'; s.error = err.message; s.proc = undefined; s.pid = undefined
  })

  proc.on('exit', code => {
    rejectOnExit(new Error(`process exited with code ${code ?? 'null'}`))
    const s = slots.get('claude-code-router')!
    if (s.state === 'running' || s.state === 'starting') {
      s.state = code === 0 ? 'stopped' : 'error'
      s.error = code !== 0 ? `exited with code ${code}` : undefined
    }
    s.proc = undefined; s.pid = undefined
    try { scrubKeys() } catch { /* best-effort */ }
  })

  try {
    // Race the exit against the health probe. If ccr exits 1 with "already
    // running" (e.g. another instance bound the port between our probe and
    // spawn), the probe will still succeed because that other instance is
    // alive — so we prefer the probe in that case.
    await Promise.race([
      pollUntilHealthy(`http://127.0.0.1:${port}`),
      processExited,
    ]).catch(async err => {
      // Last-chance recovery: maybe ccr exited because something else was
      // already bound. Re-probe; if alive, adopt it.
      if (await isRouterAlreadyRunning(port)) return
      throw err
    })
    slot.state     = 'running'
    slot.startedAt = Date.now()
  } catch (err) {
    if (proc.exitCode === null) proc.kill()
    slot.state = 'error'; slot.error = String(err); slot.proc = undefined; slot.pid = undefined
    throw err
  }
}

/** Stop claude-code-router if it is running. No-op otherwise. */
export function stopRouter(): void {
  const slot = slots.get('claude-code-router')!
  if (slot.proc) {
    slot.proc.kill()
    slot.state = 'stopped'
    slot.proc  = undefined
    slot.pid   = undefined
  }
  // SECURITY: blank the injected api keys back out so they don't linger on disk.
  try { scrubKeys() } catch { /* best-effort */ }
}

/** Returns the port claude-code-router is listening on, or undefined if not running. */
export function getRouterPort(): number | undefined {
  return slots.get('claude-code-router')?.port
}

// ─── darksol (agent-signer + harness host) ─────────────────────────────────────
//
// One darksol install backs Surface A (this slot) and Surface B (the MCP shim,
// Plan 3). This slot launches the agent-signer: a loopback HTTP signer the
// harness calls to sign send/swap txns under the wallet's limits. The harness
// REASONING loop is driven separately by DarksolClient (Task 4) — it shells
// `harness run --stream-json` against the SAME install + agent wallet.
//
// SECURITY (mirrors router-service injectKeysForStart/scrubKeys):
//   - the active darksol agent wallet's PK (Plan 1 keychain id darksol-wallet:<name>)
//     and the chosen provider key are read from the encrypted keychain and passed
//     ONLY as spawn-time env. They live in the child's env for the process
//     lifetime and are dropped when the process exits (env dies with the process).
//   - The main process keeps NO copy: buildDarksolEnv's object is spread straight
//     into spawn() and is unreachable the moment startDarksol returns. (There used
//     to be a `darksolInjectedEnvKeys` scrub here; it only ever held the env var
//     NAMES, so it scrubbed nothing — removed rather than left as false comfort.)
//   - PK NEVER crosses IPC to the renderer (integration-plan §6).

// darksol provider name → its API-key env var (SERVICES map in keys.js). Bankr/
// Surplus reuse the SAME app keychain ids sidecar-manager already reads for
// openclaude (bankr-gateway, surplus) — only the env var NAME differs.
const DARKSOL_PROVIDER_ENVVAR: Record<string, string> = {
  bankr:   'BANKR_LLM_KEY',
  surplus: 'SURPLUS_API_KEY',
}
const DARKSOL_PROVIDER_KEYCHAIN: Record<string, string> = {
  bankr:   'bankr-gateway',
  surplus: 'surplus',
}

/**
 * Build the spawn-time env for darksol: the chosen provider's name + key env var,
 * plus the active agent wallet's PK. Returns null when a hard prerequisite is
 * missing (no agent wallet, or the selected cloud provider has no key on file)
 * so startDarksol can throw a precise error.
 */
function buildDarksolEnv(walletName: string): { env: Record<string, string>; provider: string } | null {
  // Default provider: Bankr (integration-plan §9 — both selectable; Bankr is the
  // default brain). Reuse the existing AgentProviderOverride the Agent UI sets.
  const ov = agentProviderOverride
  const provider = ov.kind === 'surplus' ? 'surplus' : 'bankr'

  const envVar    = DARKSOL_PROVIDER_ENVVAR[provider]
  const keychainId = DARKSOL_PROVIDER_KEYCHAIN[provider]
  const key = retrieveKey(keychainId)
  if (!key) return null  // cloud provider selected but no key — caller surfaces the error

  // Active agent wallet PK (Plan 1). Uses the module's existing static
  // `retrieveKey` import — the old lazy re-require was redundant AND unresolvable
  // in the packaged bundle.
  const pk = retrieveKey(`darksol-wallet:${walletName}`)
  if (!pk) return null  // no funded agent wallet — caller surfaces the error

  const env: Record<string, string> = {
    // Provider selection: darksol reads opts.provider || llm.provider || 'openai'.
    // Setting DARKSOL_LLM_PROVIDER (config override) + the key env makes the pick
    // explicit at spawn. (Confirm the exact config-override env name at wiring;
    // keys.js SERVICES is the verified source for the key var name.)
    DARKSOL_LLM_PROVIDER: provider,
    [envVar]:             key,
    // Wallet PK for the agent-signer to decrypt-into-memory once and expose
    // only /send + /sign on loopback (integration-plan §6).
    DARKSOL_AGENT_PRIVATE_KEY: pk,
  }
  return { env, provider }
}

/** Probe the agent-signer loopback. Any HTTP response < 600 means the port is bound. */
async function isDarksolSignerAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) as AbortSignal })
    return res.status < 600
  } catch {
    return false
  }
}

/**
 * Start the darksol agent-signer on the preferred loopback port (18790).
 * No-op if already starting or running. Throws with a precise message when a
 * prerequisite is missing (not installed / no agent wallet / no provider key).
 *
 * Provider + wallet PK are injected ephemerally at spawn and scrubbed on stop.
 * Limits (max/trade, daily) come from Plan 1's getAgentLimits(walletName).
 */
export async function startDarksol(): Promise<void> {
  const slot = slots.get('darksol')!
  if (slot.state === 'running' || slot.state === 'starting') return
  resetBreaker('darksol')  // fresh start → clear any open breaker from a prior run

  if (!isDarksolInstalled()) {
    const msg = 'darksol not installed. Install it from the Agent page.'
    slot.state = 'error'; slot.error = msg
    throw new Error(msg)
  }

  // Plan 1 accessors (static import — see the import block header).
  const walletName = walletSvc.getActiveAgentWallet()
  if (!walletName) {
    const msg = 'No active darksol agent wallet. Create one in the Wallet tab first.'
    slot.state = 'error'; slot.error = msg
    throw new Error(msg)
  }
  const limits = walletSvc.getAgentLimits(walletName)

  const built = buildDarksolEnv(walletName)
  if (!built) {
    const provider = agentProviderOverride.kind === 'surplus' ? 'Surplus' : 'Bankr'
    const msg = `darksol needs a ${provider} key and a funded agent wallet. Add the key in Settings → Providers and fund the wallet in the Wallet tab.`
    slot.state = 'error'; slot.error = msg
    throw new Error(msg)
  }
  console.log(`[darksol] starting agent-signer with provider: ${built.provider}, wallet: ${walletName}, dryRun: ${limits.dryRun}`)

  slot.state     = 'starting'
  slot.error     = undefined
  slot.startedAt = undefined

  // 18790 is darksol's documented signer port; fall back if taken.
  const port = await findFreePort(PREFERRED_PORT_DARKSOL)
  slot.port = port

  let rejectOnExit!: (err: Error) => void
  const processExited = new Promise<never>((_, reject) => { rejectOnExit = reject })

  // Use system node (not Electron's binary) — darksol is a plain Node ESM CLI.
  const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'

  // `darksol agent start <wallet> --max-value <x> --daily-limit <y>` (integration
  // -plan §4.2). dryRun is enforced by the harness tool layer (Task 6 gate); the
  // signer's hard ceiling is max-value/daily-limit. PORT pins the loopback bind.
  const args = [
    darksolEntry(), 'agent', 'start', walletName,
    '--max-value',   limits.maxPerTradeEth,
    '--daily-limit', limits.dailyLimitEth,
  ]

  const proc = spawn(nodeCmd, args, {
    cwd:      app.getPath('home'),
    env:      { ...process.env, ...built.env, DARKSOL_AGENT_SIGNER_PORT: String(port), PORT: String(port) },
    stdio:    ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  proc.stdout?.on('data', d => process.stdout.write(`[darksol] ${d}`))
  proc.stderr?.on('data', d => process.stderr.write(`[darksol-err] ${d}`))

  slot.proc = proc
  slot.pid  = proc.pid

  proc.on('error', err => {
    rejectOnExit(new Error(`spawn error: ${err.message}`))
    const s = slots.get('darksol')!
    s.state = 'error'; s.error = err.message; s.proc = undefined; s.pid = undefined
  })

  proc.on('exit', code => {
    rejectOnExit(new Error(`process exited with code ${code ?? 'null'}`))
    const s = slots.get('darksol')!
    if (s.state === 'running' || s.state === 'starting') {
      s.state = code === 0 ? 'stopped' : 'error'
      s.error = code !== 0 ? `exited with code ${code}` : undefined
    }
    s.proc = undefined; s.pid = undefined
  })

  try {
    await Promise.race([
      // Loopback HTTP probe: signer endpoints require a path/method, so accept
      // any < 600 response as "alive" (same as isRouterAlreadyRunning).
      (async () => {
        for (let i = 0; i < MAX_HEALTH_ATTEMPTS; i++) {
          if (await isDarksolSignerAlive(port)) return
          await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
        }
        throw new Error(`darksol agent-signer health timed out on 127.0.0.1:${port}`)
      })(),
      processExited,
    ])
    slot.state     = 'running'
    slot.startedAt = Date.now()
  } catch (err) {
    if (proc.exitCode === null) proc.kill()
    slot.state = 'error'; slot.error = String(err); slot.proc = undefined; slot.pid = undefined
    throw err
  }
}

/**
 * Stop the darksol agent-signer if running. No-op otherwise.
 * SECURITY: the injected PK/provider key lived only in the child's env, so killing
 * the process is what drops them — the main process never held a copy.
 */
export function stopDarksol(): void {
  const slot = slots.get('darksol')!
  if (slot.proc) {
    slot.proc.kill()
    slot.state = 'stopped'
    slot.proc  = undefined
    slot.pid   = undefined
  }
}

/** Returns the port the darksol agent-signer is listening on, or undefined. */
export function getDarksolPort(): number | undefined {
  return slots.get('darksol')?.port
}

// ─── Key-rotation propagation (audit 2026-06-12, dimension 5) ───────────────────
//
// A sidecar is seeded a COPY of the relevant secret at spawn. Without this, a
// rotated/deleted key kept working inside the live child until a manual restart.
// On a key change we tear down the affected sidecar; it re-spawns on next demand
// with the current keychain contents (freellmapi re-seeds; darksol's old PK dies
// with the killed child, whose env was the only place it lived).
const WALLET_KEY_RE = /^(darksol-(wallet|active-wallet|limits|wallet-password)|nook-private-key)/i
onKeyChange((keyId) => {
  const bulk = keyId === '*'
  if (bulk || WALLET_KEY_RE.test(keyId)) {
    // Wallet rotated/removed → kill the agent-signer that holds the raw PK in env.
    if (slots.get('darksol')?.proc) { try { stopDarksol() } catch { /* best effort */ } }
  }
  if (bulk || !WALLET_KEY_RE.test(keyId)) {
    // A provider/API credential changed → drop freellmapi's stale seeded copy
    // (it re-seeds from the keychain on next start).
    if (slots.get('freellmapi')?.proc) { try { stopFreellmapi() } catch { /* best effort */ } }
  }
})

// ─── Shared API ───────────────────────────────────────────────────────────────

/** Snapshot of all sidecars' state, safe to serialize over IPC. */
export function listSidecars(): SidecarInfo[] {
  // Standard slot-backed sidecars
  const result: SidecarInfo[] = (['freellmapi', 'openclaude', 'freeclaudecode', 'claude-code-router', 'darksol'] as SidecarId[]).map(id => {
    const s = slots.get(id)!
    return {
      id,
      state:    s.state,
      port:     s.port,
      pid:      s.pid,
      uptimeMs: s.startedAt !== undefined ? Date.now() - s.startedAt : undefined,
      error:    s.error,
    }
  })
  // llama-cpp owns its own lifecycle in llama-cpp-client.ts. Mirror its
  // status into the unified shape here so the StatusPage / debugger can
  // see it alongside the rest.
  try {
    const ls = getLlamaCppStatus()
    // 'loading' is an llama-specific intermediate — collapse to 'starting'
    // for the SidecarState union which doesn't have a 'loading' variant.
    const mappedState: SidecarSlot['state'] =
      ls.state === 'loading' ? 'starting' : ls.state
    result.push({
      id:       'llama-cpp',
      state:    mappedState,
      port:     ls.port,
      pid:      ls.pid,
      uptimeMs: ls.uptimeMs,
      error:    ls.error,
    })
  } catch (e) {
    // If the dynamic require fails (e.g. test harness, transpile glitch)
    // fall back to the static slot so the array shape stays consistent.
    const s = slots.get('llama-cpp')!
    result.push({
      id:       'llama-cpp',
      state:    s.state,
      port:     s.port,
      pid:      s.pid,
      uptimeMs: s.startedAt !== undefined ? Date.now() - s.startedAt : undefined,
      error:    s.error ?? (e instanceof Error ? e.message : undefined),
    })
  }
  return result
}

/**
 * HTTP-level health probe. Returns true only when the process is verified alive.
 *
 * Gated by a per-slot circuit breaker: once a sidecar's probes fail
 * consecutively the breaker opens and this returns `false` WITHOUT issuing the
 * fetch, until the backoff window elapses (binary-exponential, capped). This
 * stops a dead/stopped sidecar from being hammered at the fixed poll interval.
 * A single successful probe closes the breaker and restores the normal cadence.
 */
// ─── Heartbeat notifications (STEAL 2026-06-21 #5, checkcle) ────────────────────
// The breaker tracks health but never told the user when a sidecar silently
// died. This fires a native notification on a status TRANSITION only (not every
// probe). A "stopped responding" alert is gated on the slot still being in the
// 'running' state, so a clean user-initiated stop (state → 'stopped') is not
// reported as a crash; recoveries always notify.
const heartbeat = new HeartbeatTracker()
const SIDECAR_LABEL: Record<SidecarId, string> = {
  'freellmapi':         'Local model proxy (freellmapi)',
  'openclaude':         'OpenClaude agent',
  'freeclaudecode':     'free-claude-code',
  'claude-code-router': 'Claude Code Router',
  'llama-cpp':          'llama.cpp',
  'darksol':            'DarkSol signer',
}

function noteHeartbeat(id: SidecarId, alive: boolean): void {
  const r = heartbeat.record(id, alive)
  if (!r.transitioned) return
  const label = SIDECAR_LABEL[id] ?? id
  if (r.status === 'up') {
    notifyTaskDone(`${label} recovered`, 'The background service is responding again.', { silent: true })
  } else if (slots.get(id)?.state === 'running') {
    // Unexpected: the manager still thinks it's running but probes fail → crash.
    notifyTaskDone(`${label} stopped responding`, 'A background service may have crashed — check Status.')
  }
}

export async function healthCheckSidecar(id: SidecarId): Promise<boolean> {
  const breaker = breakerFor(id)
  // Breaker open + backoff not elapsed → report unhealthy without a network hit.
  if (!breaker.shouldAttempt()) { noteHeartbeat(id, false); return false }

  const alive = await rawHealthCheckSidecar(id)
  if (alive) breaker.recordSuccess()
  else       breaker.recordFailure()
  noteHeartbeat(id, alive)
  return alive
}

/** The actual per-sidecar HTTP probe, ungated by the breaker. */
async function rawHealthCheckSidecar(id: SidecarId): Promise<boolean> {
  // llama-cpp owns its own lifecycle; the slot here is a stub for the unified
  // API surface. Defer to its own getLlamaCppPort() check directly.
  if (id === 'llama-cpp') {
    try {
      const port = getLlamaCppPort()
      if (!port) return false
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(3_000) as AbortSignal,
      })
      return res.ok
    } catch { return false }
  }

  const s = slots.get(id)
  if (!s || s.state !== 'running') return false

  if (id === 'freellmapi' && s.port) {
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/ping`, {
        signal: AbortSignal.timeout(3_000) as AbortSignal,
      })
      return res.ok
    } catch { return false }
  }

  if (id === 'openclaude' && s.port) {
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/health`, {
        signal: AbortSignal.timeout(3_000) as AbortSignal,
      })
      return res.ok
    } catch { return false }
  }

  if (id === 'freeclaudecode' && s.port) {
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/models`, {
        signal: AbortSignal.timeout(3_000) as AbortSignal,
      })
      return res.ok || res.status < 500
    } catch { return false }
  }

  if (id === 'claude-code-router' && s.port) {
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/health`, {
        signal: AbortSignal.timeout(3_000) as AbortSignal,
      })
      return res.ok || res.status < 500
    } catch { return false }
  }

  if (id === 'darksol' && s.port) {
    return isDarksolSignerAlive(s.port)
  }

  return false
}

/** Kill all running sidecars. Called from app.on('will-quit'). */
export function stopAllSidecars(): void {
  stopFreellmapi()
  stopOpenClaude()
  stopFreeClaudeCode()
  stopRouter()
  stopDarksol()
  // llama-cpp owns its own lifecycle module; guarded because a stop during a
  // half-initialised engine must never block quit.
  try {
    stopLlamaCpp()
  } catch { /* non-fatal — happens in test harnesses */ }
  // The in-process MCP server uses HTTP, not child_process, so it has its
  // own async stop path. Fire-and-forget here — will-quit doesn't await.
  void stopInProcessMcp()
  void stopLocalApiServer()
}

// ─── in-process MCP server ────────────────────────────────────────────────────
//
// Clauge-style auto-start: bind 127.0.0.1:7421 (with +5 fallback) and expose
// our curated 15-tool set. Lifecycle is independent of the child-process
// sidecars above (no spawn, no health-poll). State lives in a module-scoped
// handle so the IPC layer can introspect it without re-exporting internals.
//
// The "enabled" flag is the user-facing toggle (default ON), PERSISTED as
// AppSettings.mcpServerEnabled so an OFF choice survives restarts. Lazy-init
// (not at module load) because settings need electron's userData path.
// When disabled, the server is stopped and startInProcessMcp() becomes a
// no-op until setInProcessMcpEnabled(true) flips it back.

let mcpHandle: McpHandle | null = null
let mcpEnabled: boolean | null = null
let mcpStarting: Promise<void> | null = null

// ── R8b: the MCP server module is loaded on first start ──────────────────────
//
// Measured (R8b baseline, installed build 2026-07-27): ./mcp-server dragged
// `express` (47.7 ms) and the two @modelcontextprotocol/sdk SERVER entries
// (44.2 + 18.4 ms) into the 1317 ms pre-STARTUP_T0 prelude — ~110 ms, on a
// path (main.ts → agent.ipc.ts → here) that boot only needs because
// `startInProcessMcp()` is called from whenReady. That call is ALREADY
// `startupPhaseAsync` and already awaited-by-promise, so nothing about the
// lifecycle changes: the module now loads inside the same async start, one
// microtask later, and a load failure lands in the SAME `catch` that a
// `startMcpServer()` throw already landed in ('[mcp] startInProcessMcp
// failed: …', handle left null).
//
// Relative specifier ⇒ `await import()`, never `require()` (electron-vite
// bundles electron/ into one out/main/index.js, so a runtime relative require
// does not resolve inside app.asar — see noRuntimeRelativeRequire.test.ts).
let mcpServerModule: Promise<typeof import('./mcp-server')> | null = null
function loadMcpServer(): Promise<typeof import('./mcp-server')> {
  return (mcpServerModule ??= import('./mcp-server'))
}

function mcpEnabledNow(): boolean {
  if (mcpEnabled === null) {
    try {
      mcpEnabled = loadSettings().mcpServerEnabled !== false
    } catch { mcpEnabled = true }
  }
  return mcpEnabled
}

export function getMcpHandle(): McpHandle | null {
  return mcpHandle
}

export function isInProcessMcpEnabled(): boolean {
  return mcpEnabledNow()
}

export async function startInProcessMcp(): Promise<void> {
  if (!mcpEnabledNow()) return
  if (mcpHandle) return
  // De-dup concurrent start calls (e.g. ready + IPC racing).
  if (mcpStarting) return mcpStarting
  mcpStarting = (async () => {
    try {
      const { startMcpServer } = await loadMcpServer()
      mcpHandle = await startMcpServer({
        workspaceRoot: () => currentWorkspace()?.rootPath ?? app.getPath('home'),
      })
    } catch (e) {
      console.warn('[mcp] startInProcessMcp failed:', (e as Error).message)
      mcpHandle = null
    } finally {
      mcpStarting = null
    }
  })()
  return mcpStarting
}

export async function stopInProcessMcp(): Promise<void> {
  const h = mcpHandle
  mcpHandle = null
  if (h) {
    try { await h.stop() } catch (e) { console.warn('[mcp] stop failed:', (e as Error).message) }
  }
}

export async function setInProcessMcpEnabled(v: boolean): Promise<void> {
  mcpEnabled = v
  // Persist so the choice survives restarts (Settings -> MCP toggle).
  try {
    saveSettings({ mcpServerEnabled: v })
  } catch { /* non-fatal — in-memory toggle still applies this session */ }
  if (v) {
    await startInProcessMcp()
  } else {
    await stopInProcessMcp()
  }
}

/** Rotate the bearer token: stop, regenerate, restart. */
export async function rotateInProcessMcpToken(): Promise<void> {
  const { rotateMcpToken } = await loadMcpServer()
  if (!mcpEnabledNow()) {
    // Even when disabled, the user can rotate — they probably plan to enable.
    rotateMcpToken()
    return
  }
  await stopInProcessMcp()
  rotateMcpToken()
  await startInProcessMcp()
}

// ─── local OpenAI-compatible API server ───────────────────────────────────────
//
// Same lifecycle shape as the in-process MCP server above: HTTP on loopback,
// no child process, user-facing toggle persisted as AppSettings.apiServerEnabled
// (default ON — it's Bearer-gated and 127.0.0.1-only, and "point your tool at
// Tachi Studio" is the whole feature). See openai-api-server.ts.

let apiServerHandle: ApiServerHandle | null = null
let apiServerEnabled: boolean | null = null
let apiServerStarting: Promise<void> | null = null

function apiServerEnabledNow(): boolean {
  if (apiServerEnabled === null) {
    try {
      apiServerEnabled = loadSettings().apiServerEnabled !== false
    } catch { apiServerEnabled = true }
  }
  return apiServerEnabled
}

export function getApiServerHandle(): ApiServerHandle | null {
  return apiServerHandle
}

export function isLocalApiServerEnabled(): boolean {
  return apiServerEnabledNow()
}

export async function startLocalApiServer(): Promise<void> {
  if (!apiServerEnabledNow()) return
  if (apiServerHandle) return
  if (apiServerStarting) return apiServerStarting
  apiServerStarting = (async () => {
    try {
      apiServerHandle = await startOpenAiApiServer({
        upstreams: () => {
          // Lazy lookups per request — engines start/stop while the server runs.
          let llamaPort: number | undefined
          let llamaModelId: string | undefined
          let localModelIds: string[] = []
          try {
            const s = getLlamaCppStatus()
            if (s.state === 'running') { llamaPort = s.port; llamaModelId = s.modelId }
            // The LAST-SERVED id survives a stop (the slot keeps it on purpose),
            // and the downloaded list does not depend on the engine being awake
            // at all. Both are needed so the router can tell "your own model,
            // currently unloaded" from "a name we have never heard of" — the
            // distinction that stops a local request being answered by a cloud
            // provider. See util/api-route.ts.
            else if (s.modelId) { llamaModelId = s.modelId }
            localModelIds = listGgufModelIds()
          } catch { /* llama slice unavailable — freellm only */ }
          return {
            llamaPort,
            llamaModelId,
            localModelIds,
            freellmPort: getFreellmapiPort(),
            freellmApiKey: getFreellmapiApiKey(),
          }
        },
        // Fire-and-forget wake. The request that triggered it already got a 503
        // with Retry-After; this makes the retry land on a warm engine.
        wakeLocalModel: (modelId) => {
          if (!modelId) return
          void startLlamaCpp({ modelId }).catch(e => {
            console.warn('[api-server] wake failed:', (e as Error).message)
          })
        },
      })
    } catch (e) {
      console.warn('[api-server] startLocalApiServer failed:', (e as Error).message)
      apiServerHandle = null
    } finally {
      apiServerStarting = null
    }
  })()
  return apiServerStarting
}

export async function stopLocalApiServer(): Promise<void> {
  const h = apiServerHandle
  apiServerHandle = null
  if (h) {
    try { await h.stop() } catch (e) { console.warn('[api-server] stop failed:', (e as Error).message) }
  }
}

export async function setLocalApiServerEnabled(v: boolean): Promise<void> {
  apiServerEnabled = v
  try {
    saveSettings({ apiServerEnabled: v })
  } catch { /* non-fatal — in-memory toggle still applies this session */ }
  if (v) {
    await startLocalApiServer()
  } else {
    await stopLocalApiServer()
  }
}

/** Rotate the API key: stop, regenerate, restart. */
export async function rotateLocalApiServerToken(): Promise<void> {
  if (!apiServerEnabledNow()) {
    rotateOpenAiApiToken()
    return
  }
  await stopLocalApiServer()
  rotateOpenAiApiToken()
  await startLocalApiServer()
}
