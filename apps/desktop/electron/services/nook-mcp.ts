// apps/desktop/electron/services/nook-mcp.ts
//
// Registers @nookplot/mcp as a managed stdio MCP server so the app's LLM agents
// (Chat / Code / Swarm — anything that consumes the mcp-manager registry, and
// the nodes-canvas MCP node) get the full nookplot toolset natively.
//
// ─── How this hooks into the app's REAL MCP mechanism ──────────────────────────
//
// The app already runs EXTERNAL stdio MCP servers through electron/services/
// mcp-manager.ts: addServer({ name, command, args, env }) persists a config to
// ${userData}/mcp-servers.json, and startServer(name) spawns the process via
// @modelcontextprotocol/sdk's StdioClientTransport, fetches the tool list, and
// keeps a live Client. The Settings → "MCP Servers" card (MCPServersSection.tsx)
// drives the same functions over the mcp:* IPC channels.
//
// So we do NOT reinvent a launcher — we ADD an entry to that registry and use
// its start/stop/list. The single nookplot-specific concern is credentials:
// @nookplot/mcp does NOT read API-key/private-key from the environment. It reads
// ONLY ~/.nookplot/credentials.json (apiKey + privateKey + address + gatewayUrl).
// The honored env vars are NOOKPLOT_GATEWAY_URL / NOOKPLOT_AGENT_NAME /
// NOOKPLOT_AGENT_DESCRIPTION / NOOKPLOT_PROFILE / NOOKPLOT_CONFIG_TOKEN /
// NOOKPLOT_CONFIG_KEY — none of which carry the agent's keypair.
//
// Therefore enable() SEEDS ~/.nookplot/credentials.json from the same keychain
// ids nook-service owns ('nook-api-key' / 'nook-private-key'), deriving the
// wallet address from the private key via @nookplot/sdk's walletFromPrivateKey
// (the exact helper nook-service.ts already uses for EIP-712 signing). This is
// the only safe bridge: the keypair stays in the OS keychain and is materialised
// to the nookplot config dir only at enable() time, for the spawned MCP process.
//
// Verified against the installed package (@nookplot/mcp@0.4.122):
//   - bin:  { "nookplot-mcp": "dist/index.js" }   (single bin; `npx @nookplot/mcp`
//           resolves the package and runs it)
//   - default invocation (no subcommand) loads credentials, validates the API
//     key against /v1/agents/me, then serves the full tool set over stdio.
//   - with no credentials AND no NOOKPLOT_AGENT_NAME it boots in "setup mode"
//     (only the nookplot_register tool) — which is why we seed creds first.

import { app } from 'electron'
import { join } from 'path'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { retrieveKey } from './keychain'
import {
  addServer,
  startServer,
  stopServer,
  getServerConfig,
  listServers,
  type MCPServerInfo,
} from './mcp-manager'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Registry name for the managed nookplot MCP server. Stable — used as the key
 *  in mcp-servers.json and the lookup key for start/stop/status. */
export const NOOK_MCP_NAME = 'nookplot'

/** Keychain ids — MUST match the ones nook-service.ts owns. */
const KEY_API = 'nook-api-key'
const KEY_PK = 'nook-private-key'

const GATEWAY_URL = 'https://gateway.nookplot.com'

// ─── Credential seeding ───────────────────────────────────────────────────────

function nookplotDir(): string {
  return join(homedir(), '.nookplot')
}

function credentialsPath(): string {
  return join(nookplotDir(), 'credentials.json')
}

interface NookCredentials {
  apiKey: string
  privateKey: string
  address: string
  gatewayUrl: string
}

/**
 * Derive the wallet address from a private key using the same SDK helper
 * nook-service.ts uses (@nookplot/sdk walletFromPrivateKey → ethers Wallet).
 * Lazy-imported because @nookplot/sdk is ESM and externalized by electron-vite.
 */
async function deriveAddress(privateKey: string): Promise<string> {
  const sdk = await import('@nookplot/sdk')
  const wallet = sdk.walletFromPrivateKey(privateKey)
  return wallet.address
}

/**
 * Read the already-seeded credentials.json, if present and complete.
 * Returns null on missing/corrupt/incomplete files.
 */
function readSeededCredentials(): NookCredentials | null {
  const p = credentialsPath()
  if (!existsSync(p)) return null
  try {
    const c = JSON.parse(readFileSync(p, 'utf8')) as Partial<NookCredentials>
    if (c.apiKey && c.privateKey && c.address && c.gatewayUrl) {
      return c as NookCredentials
    }
  } catch { /* fall through */ }
  return null
}

/**
 * Materialise ~/.nookplot/credentials.json from the keychain so the spawned
 * @nookplot/mcp process can authenticate. The API key + private key live in the
 * OS keychain; we only write them to the nookplot config dir here, with 0o600
 * perms (no-op on Windows). Throws a descriptive error if creds are missing.
 *
 * Idempotent: if the file already exists with the SAME apiKey we leave it alone
 * (preserves any displayName/address the nookplot CLI may have enriched it with).
 */
async function seedCredentials(): Promise<void> {
  const apiKey = retrieveKey(KEY_API) ?? ''
  const privateKey = retrieveKey(KEY_PK) ?? ''

  if (!apiKey || !privateKey) {
    throw new Error(
      'nookplot MCP needs both an API key and a private key. Connect nookplot first ' +
      '(Nook tab → generate/import an agent key, then Connect) so the credentials ' +
      'are minted, then enable the MCP server.',
    )
  }

  // If a complete file is already present for THIS apiKey, don't rewrite it.
  const existing = readSeededCredentials()
  if (existing && existing.apiKey === apiKey) return

  const address = await deriveAddress(privateKey)
  const creds: NookCredentials = { apiKey, privateKey, address, gatewayUrl: GATEWAY_URL }

  const dir = nookplotDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })

  const p = credentialsPath()
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* Windows no-op */ }
  renameSync(tmp, p)
}

// ─── Server config ────────────────────────────────────────────────────────────

/**
 * The mcp-manager config for the nookplot stdio server.
 *
 * Command: `npx -y @nookplot/mcp` (stdio is the package's default transport).
 * On Windows the npx shim is npx.cmd — mcp-manager passes the command straight
 * to StdioClientTransport which spawns it; use the platform-correct binary name.
 *
 * Env: only NOOKPLOT_GATEWAY_URL is meaningful for auth routing (credentials
 * come from the seeded ~/.nookplot/credentials.json, not env). NOOKPLOT_AGENT_*
 * are set as belt-and-suspenders so that if credentials are somehow absent the
 * server self-registers rather than dropping into setup-only mode.
 */
function resolveMcpEntry(): string {
  // @nookplot/mcp is a direct dep, but nested in pnpm's store — resolve its real
  // entry so we can spawn `node <entry>` directly. This avoids npx, which on
  // Windows fails with "'nookplot-mcp' is not recognized" (the bin shim/PATH
  // isn't available to the stdio transport's spawn).
  const req = createRequire(__filename)
  try { return req.resolve('@nookplot/mcp') }
  catch { return req.resolve('@nookplot/mcp/dist/index.js') }
}

function buildConfig() {
  const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node'
  return {
    name: NOOK_MCP_NAME,
    command: nodeCmd,
    args: [resolveMcpEntry()],
    env: {
      NOOKPLOT_GATEWAY_URL: GATEWAY_URL,
      NOOKPLOT_AGENT_NAME: 'Tachi Studio Agent',
      NOOKPLOT_AGENT_DESCRIPTION: 'Agent connected via Tachi Studio',
    } as Record<string, string>,
  }
}

/** Ensure the registry has the nookplot entry. No-op if already present. */
function ensureRegistered(): void {
  if (getServerConfig(NOOK_MCP_NAME)) return
  addServer(buildConfig())
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Seed credentials, register the server in the app's MCP registry (if needed),
 * and start it. After this resolves, the nookplot tools are live in the same
 * registry every agent path already consumes (listServers / listTools / the
 * nodes-canvas MCP node).
 *
 * Throws if credentials are missing or the process fails to start.
 */
export async function enable(): Promise<MCPServerInfo | undefined> {
  await seedCredentials()
  ensureRegistered()
  await startServer(NOOK_MCP_NAME)
  return listServers().find(s => s.name === NOOK_MCP_NAME)
}

/**
 * Stop the nookplot MCP server. Leaves the registry entry in place (so it shows
 * in Settings as stopped) and leaves the seeded credentials.json untouched.
 */
export async function disable(): Promise<void> {
  if (!getServerConfig(NOOK_MCP_NAME)) return
  await stopServer(NOOK_MCP_NAME)
}

/**
 * Current status of the nookplot MCP server from the app's MCP registry, or
 * null if it was never registered. `credentialsReady` reflects whether the
 * keychain currently holds both secrets needed to (re)seed and start it.
 */
export function status(): (MCPServerInfo & { credentialsReady: boolean }) | { registered: false; credentialsReady: boolean } {
  const info = listServers().find(s => s.name === NOOK_MCP_NAME)
  const credentialsReady = !!retrieveKey(KEY_API) && !!retrieveKey(KEY_PK)
  if (!info) return { registered: false, credentialsReady }
  return { ...info, credentialsReady }
}

/** True once the registry knows about the nookplot server (started or not). */
export function isRegistered(): boolean {
  return !!getServerConfig(NOOK_MCP_NAME)
}
