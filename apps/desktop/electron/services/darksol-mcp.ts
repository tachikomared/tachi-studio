// apps/desktop/electron/services/darksol-mcp.ts
//
// Registers the darksol MCP SHIM (electron/services/darksol-mcp-server.ts) as a
// managed stdio MCP server, so the app's LLM agents — and the nodes-canvas MCP
// node — get the darksol harness toolset (price/gas/wallet-balance/portfolio/
// market/swap/send/wiretap-*) natively. This is the EXACT twin of nook-mcp.ts;
// see that file's header for how the mcp-manager registry mechanism works.
//
// ─── Why a shim (not a package binary like nook-mcp) ────────────────────────────
//
// nook-mcp spawns @nookplot/mcp's prebuilt binary. darksol ships NO MCP server
// (DARKSOL-AGENT-INTEGRATION-PLAN.md §3), so here `command` is `node` and `args`
// is [our darksol-mcp-server.js], which fronts the darksol CLI harness.
//
// ─── Credentials ───────────────────────────────────────────────────────────────
//
// The darksol harness signs via its own agent-signer + keystore. We don't write a
// credentials.json (darksol has none); instead enable() reads the ACTIVE darksol
// wallet from the SAME keychain ids Plan 1 owns and injects them as ENV on the
// spawned server (mcp-manager merges config.env into the child's process.env):
//   darksol-active-wallet  → DARKSOL_WALLET
//   darksol-wallet:<name>  → (PK is decrypted by darksol's keystore; we pass the
//                             wallet NAME + PASSWORD, never raw PK over the wire)
//   darksol-limits:<name>  → DARKSOL_DRY_RUN (from limits.dryRun)
// Secrets reach the child process ephemerally at spawn and are scrubbed when the
// server stops (mcp-manager drops the slot's env with the process) — mirroring
// router-service injectKeysForStart/scrubKeys and nook-mcp's seed-at-enable model.

import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { retrieveKey } from './keychain'
import {
  addServer,
  startServer,
  stopServer,
  removeServer,
  getServerConfig,
  listServers,
  type MCPServerInfo,
} from './mcp-manager'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Registry name for the managed darksol MCP server. Stable — used as the key in
 *  mcp-servers.json and the lookup key for start/stop/status. */
export const DARKSOL_MCP_NAME = 'darksol'

/** Keychain ids — owned by Plan 1 (wallet foundation). We only READ them. */
const KEY_ACTIVE  = 'darksol-active-wallet'
const walletPkId  = (name: string) => `darksol-wallet:${name}`
const limitsId    = (name: string) => `darksol-limits:${name}`
/** Optional wallet-password keychain id (set by Plan 2's agent-signer flow). */
const passwordId  = (name: string) => `darksol-wallet-password:${name}`

// ─── Entry resolution ───────────────────────────────────────────────────────────

/**
 * Resolve the built path of our darksol-mcp-server script. In dev electron-vite
 * serves from out/main; in prod it's bundled alongside this module. We resolve a
 * sibling file rather than an npm package (this IS our code, not a dep).
 */
function resolveServerEntry(): string {
  // __dirname is the directory of the compiled darksol-mcp.js (out/main). The
  // server script compiles to a sibling darksol-mcp-server.js in the same dir.
  const sibling = join(__dirname, 'darksol-mcp-server.js')
  if (existsSync(sibling)) return sibling
  // Fallback: resolve via require from this module (handles split chunk layouts).
  const req = createRequire(__filename)
  try { return req.resolve('./darksol-mcp-server.js') }
  catch { return req.resolve(join(dirname(__filename), 'darksol-mcp-server.js')) }
}

/**
 * Resolve the darksol CLI entry. Plan 2 owns the on-demand installer; here we
 * just LOCATE whatever is installed. Strategy mirrors router-service.findCcrBinary:
 * resolve the npm package's bin, else fall back to PATH ('darksol'). Returns null
 * when darksol isn't installed so status()/enable() can report it cleanly.
 */
function resolveDarksolBin(): string | null {
  const req = createRequire(__filename)
  // 1. Resolved package entry (preferred — avoids npx-on-Windows, like nook-mcp).
  for (const id of ['@darksol/terminal', '@darksol/terminal/dist/index.js', '@darksol/terminal/bin/darksol.js']) {
    try { return req.resolve(id) } catch { /* try next */ }
  }
  // 2. PATH fallback — darksol installed globally; spawn the bin shim by name.
  //    (resolveServerEntry's child detects a non-.js value and runs it directly.)
  return null
}

// ─── Server config ────────────────────────────────────────────────────────────

interface ActiveCreds {
  wallet: string; password: string | undefined; dryRun: boolean; bin: string
  maxPerTradeEth: string; dailyLimitEth: string; allowlist: string[]
}

/** Resolve the active darksol wallet + its config from the keychain. Throws a
 *  descriptive error (like nook-mcp.seedCredentials) when no wallet is active. */
function resolveActiveCreds(): ActiveCreds {
  const wallet = retrieveKey(KEY_ACTIVE) ?? ''
  if (!wallet) {
    throw new Error(
      'darksol MCP needs an active darksol agent wallet. Open the Wallet tab → create or ' +
      'select a darksol agent wallet first, then enable the darksol MCP server.',
    )
  }
  // PK exists check (Plan 1 stores it). We DON'T pass raw PK; darksol's keystore
  // decrypts with the password. Password is optional here (Plan 2 may store it).
  if (!retrieveKey(walletPkId(wallet))) {
    throw new Error(`darksol wallet "${wallet}" has no stored key. Re-create or import it in the Wallet tab.`)
  }
  const password = retrieveKey(passwordId(wallet)) ?? undefined
  // Read the FULL AgentLimits — not just dryRun. The per-trade cap + allowlist
  // are seeded into the shim env so it can enforce them on the MCP path (audit
  // 2026-06-12 CRITICAL: previously only dryRun was extracted, the rest dropped).
  let dryRun = true
  let maxPerTradeEth = '0.05'
  let dailyLimitEth = '0.20'
  let allowlist: string[] = []
  const rawLimits = retrieveKey(limitsId(wallet))
  if (rawLimits) {
    try {
      const l = JSON.parse(rawLimits) as { dryRun?: unknown; maxPerTradeEth?: unknown; dailyLimitEth?: unknown; allowlist?: unknown }
      if (l.dryRun === false) dryRun = false
      if (typeof l.maxPerTradeEth === 'string' && l.maxPerTradeEth) maxPerTradeEth = l.maxPerTradeEth
      if (typeof l.dailyLimitEth === 'string' && l.dailyLimitEth) dailyLimitEth = l.dailyLimitEth
      if (Array.isArray(l.allowlist)) allowlist = l.allowlist.filter((x): x is string => typeof x === 'string')
    } catch { /* keep safe defaults */ }
  }
  const bin = resolveDarksolBin() ?? 'darksol'
  return { wallet, password, dryRun, bin, maxPerTradeEth, dailyLimitEth, allowlist }
}

function buildConfig(creds: ActiveCreds) {
  const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'
  const env: Record<string, string> = {
    DARKSOL_BIN:        creds.bin,
    DARKSOL_WALLET:     creds.wallet,
    DARKSOL_DRY_RUN:    creds.dryRun ? '1' : '0',
    DARKSOL_MAX_VALUE:  creds.maxPerTradeEth,
    DARKSOL_DAILY_LIMIT: creds.dailyLimitEth,
    DARKSOL_ALLOWLIST:  JSON.stringify(creds.allowlist),
  }
  if (creds.password) env.DARKSOL_WALLET_PASSWORD = creds.password
  return { name: DARKSOL_MCP_NAME, command: nodeCmd, args: [resolveServerEntry()], env }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve creds, (re)register the darksol shim in the MCP registry, and start it.
 * After this resolves, the darksol tools are live in the same registry every
 * agent path consumes (listServers / listTools / the nodes-canvas MCP node).
 * Throws if no active wallet, darksol isn't installed, or the process fails to start.
 */
export async function enable(): Promise<MCPServerInfo | undefined> {
  const creds = resolveActiveCreds()             // throws on missing wallet/key
  // Re-register with current env (active wallet may have changed since last enable).
  if (getServerConfig(DARKSOL_MCP_NAME)) {
    await stopServer(DARKSOL_MCP_NAME).catch(() => {})
    await removeServer(DARKSOL_MCP_NAME)
  }
  addServer(buildConfig(creds))
  await startServer(DARKSOL_MCP_NAME)             // throws if darksol/the script fails to start
  return listServers().find(s => s.name === DARKSOL_MCP_NAME)
}

/** Stop the darksol MCP server. Leaves the registry entry in place (shows as
 *  stopped in Settings). Dropping the process drops the seeded env (scrub). */
export async function disable(): Promise<void> {
  if (!getServerConfig(DARKSOL_MCP_NAME)) return
  await stopServer(DARKSOL_MCP_NAME)
}

/** Current status from the app's MCP registry, or { registered:false }. `walletReady`
 *  reflects an active darksol wallet with a stored key; `darksolReady` reflects the
 *  CLI being resolvable. Both gate the UI toggle (like nook-mcp.credentialsReady). */
export function status():
  | (MCPServerInfo & { walletReady: boolean; darksolReady: boolean })
  | { registered: false; walletReady: boolean; darksolReady: boolean } {
  const wallet = retrieveKey(KEY_ACTIVE) ?? ''
  const walletReady = !!wallet && !!retrieveKey(walletPkId(wallet))
  const darksolReady = resolveDarksolBin() !== null
  const info = listServers().find(s => s.name === DARKSOL_MCP_NAME)
  if (!info) return { registered: false, walletReady, darksolReady }
  return { ...info, walletReady, darksolReady }
}

/** True once the registry knows about the darksol server (started or not). */
export function isRegistered(): boolean {
  return !!getServerConfig(DARKSOL_MCP_NAME)
}
