import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
// R8b: the MCP SDK client entries load ON FIRST SPAWN, not at boot.
//
// These two measured 0.1-0.2 ms in the R8b baseline ONLY because
// services/mcp-server.ts had already paid for the shared
// @modelcontextprotocol/sdk internals (44.2 + 18.4 ms) earlier in the bundle's
// load order. mcp-server is now deferred (sidecar-manager.ts), so leaving
// these static would simply move ~60 ms of the same cost onto THIS module —
// the saving would evaporate rather than land. They go together or not at all.
//
// `Client` is a TYPE here (MCPSlot.client) and a value only inside the async
// startServer() below; StdioClientTransport is value-only inside the same
// function. Nothing else in this module touches the SDK.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { filterEnv } from './util/env-filter'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MCPServerConfig {
  name:    string
  command: string
  args:    string[]
  /** Non-secret env vars. Written to mcp-servers.json in plaintext. */
  env?:    Record<string, string>
  /**
   * Env var NAMES whose values live in the encrypted keychain instead of the
   * config file (marketplace entries flagged `secret: true`, e.g. API tokens).
   * Values are re-joined into the spawn env by resolveServerEnv().
   */
  secretEnvKeys?: string[]
  /** Marketplace entry this server came from (absent for hand-added ones). */
  catalogId?: string
  /**
   * Does this server reach the public internet? Comes from the catalog;
   * undefined (hand-added) is treated as `true` — the paranoid default the
   * egress policy uses everywhere else.
   */
  requiresNetwork?: boolean
  /**
   * User wants this server connected. Enabled servers are started lazily at
   * TACHI session start (ensureEnabledServersStarted) so their tools are
   * available without the user pressing START every launch.
   */
  enabled?: boolean
}

export type MCPServerStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface MCPServerInfo {
  name:       string
  status:     MCPServerStatus
  pid?:       number
  toolCount:  number
  lastError?: string
  enabled:    boolean
  catalogId?: string
  requiresNetwork: boolean
  command:    string
  args:       string[]
  /** Env var names only — values (especially secrets) never cross IPC. */
  envKeys:    string[]
  secretEnvKeys: string[]
}

export interface MCPTool {
  name:        string
  description: string
  inputSchema: Record<string, unknown>
}

// ─── Internal state ───────────────────────────────────────────────────────────

interface MCPSlot {
  config:    MCPServerConfig
  status:    MCPServerStatus
  pid?:      number
  lastError?: string
  client?:   Client
  tools:     MCPTool[]
}

const slots = new Map<string, MCPSlot>()

// ─── Persistence ──────────────────────────────────────────────────────────────

function configPath(): string {
  return join(app.getPath('userData'), 'mcp-servers.json')
}

function persistConfigs(): void {
  const configs: MCPServerConfig[] = []
  for (const slot of slots.values()) {
    configs.push(slot.config)
  }
  const path = configPath()
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(path + '.tmp', JSON.stringify(configs, null, 2), 'utf8')
  renameSync(path + '.tmp', path)
}

function loadPersistedConfigs(): void {
  const path = configPath()
  if (!existsSync(path)) return
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as MCPServerConfig[]
    for (const cfg of raw) {
      if (!slots.has(cfg.name)) {
        slots.set(cfg.name, {
          config: cfg,
          status: 'stopped',
          tools:  [],
        })
      }
    }
  } catch { /* ignore corrupt file */ }
}

// Load persisted configs immediately on module load (main process init time).
// app.getPath('userData') is available as soon as electron app is ready.
// We wrap in a try so a missing userData dir during tests won't crash.
try { loadPersistedConfigs() } catch { /* non-fatal */ }

// ─── Public API ───────────────────────────────────────────────────────────────

// ─── Secret env values (keychain, never the plaintext config file) ────────────

/**
 * Keychain id for one server's secret env var. Namespaced under `mcp:` so it
 * cannot collide with a provider API key (which uses a bare provider id).
 * Pure — exported for unit tests.
 */
export function mcpSecretKeyId(serverName: string, envKey: string): string {
  return `mcp:${serverName}:${envKey}`
}

/**
 * Merge a server's plaintext env with its keychain-held secrets. A secret that
 * cannot be decrypted (keychain unavailable, key deleted) is simply absent —
 * the server then fails its own auth check with a clear message, which beats
 * refusing to start with an opaque one.
 */
async function resolveServerEnv(config: MCPServerConfig): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...(config.env ?? {}) }
  const keys = config.secretEnvKeys ?? []
  if (keys.length === 0) return env
  try {
    const { retrieveKey } = await import('./keychain')
    for (const k of keys) {
      const value = retrieveKey(mcpSecretKeyId(config.name, k))
      if (value) env[k] = value
    }
  } catch { /* keychain unavailable → start without the secrets */ }
  return env
}

/**
 * Register a new server config. Throws if a server with this name already
 * exists. `secrets` (env var name → value) are written to the encrypted
 * keychain and their NAMES recorded on the config; they never reach
 * mcp-servers.json. Persists to disk.
 */
export async function addServer(
  config: MCPServerConfig,
  secrets: Record<string, string> = {},
): Promise<void> {
  if (slots.has(config.name)) {
    throw new Error(`MCP server "${config.name}" already exists`)
  }

  const secretKeys = Object.keys(secrets).filter(k => (secrets[k] ?? '').length > 0)
  if (secretKeys.length > 0) {
    const { storeKey } = await import('./keychain')
    for (const k of secretKeys) storeKey(mcpSecretKeyId(config.name, k), secrets[k]!)
  }

  // Defence in depth: strip any secret value that leaked into `env` (the UI
  // routes them separately, but a hand-built IPC payload must not persist one).
  const env = { ...(config.env ?? {}) }
  for (const k of secretKeys) delete env[k]

  slots.set(config.name, {
    config: {
      ...config,
      env:           Object.keys(env).length > 0 ? env : undefined,
      secretEnvKeys: secretKeys.length > 0 ? secretKeys : undefined,
    },
    status: 'stopped',
    tools:  [],
  })
  persistConfigs()
}

/**
 * Remove a server by name. Stops it first if running and drops its keychain
 * secrets (a removed server must not leave decryptable tokens behind).
 * Persists to disk.
 */
export async function removeServer(name: string): Promise<void> {
  const slot = slots.get(name)
  if (!slot) return
  if (slot.status === 'running' || slot.status === 'starting') {
    await stopServer(name)
  }
  const secretKeys = slot.config.secretEnvKeys ?? []
  if (secretKeys.length > 0) {
    try {
      const { deleteKey } = await import('./keychain')
      for (const k of secretKeys) deleteKey(mcpSecretKeyId(name, k))
    } catch { /* keychain unavailable → nothing to clean up */ }
  }
  slots.delete(name)
  persistConfigs()
}

/**
 * Flip a server's ENABLED flag and reconcile the process: enabling starts it,
 * disabling stops it. Persists the flag so the next launch reconnects without
 * the user pressing START again (the "one-click, stays working" half of T11).
 * A start failure is surfaced to the caller but the flag stays set, so the user
 * sees the error dot instead of a silently reverted toggle.
 */
export async function setServerEnabled(name: string, enabled: boolean): Promise<void> {
  const slot = slots.get(name)
  if (!slot) throw new Error(`MCP server "${name}" not found`)
  slot.config = { ...slot.config, enabled }
  persistConfigs()
  if (enabled) await startServer(name)
  else await stopServer(name)
}

/**
 * Start every ENABLED server that is not already up. Called at TACHI session
 * start so an enabled server's tools are present without a manual START, and
 * safe to call repeatedly (already-running servers are a no-op). Individual
 * failures are swallowed — one broken server must never block a session; its
 * error surfaces on the settings row.
 */
export async function ensureEnabledServersStarted(): Promise<void> {
  const pending = [...slots.values()]
    .filter(s => s.config.enabled && s.status === 'stopped')
    .map(s => s.config.name)
  await Promise.allSettled(pending.map(n => startServer(n)))
}

/**
 * Spawn the server process, connect via StdioClientTransport, initialize,
 * and fetch the tool list. Throws on failure.
 */
export async function startServer(name: string): Promise<void> {
  const slot = slots.get(name)
  if (!slot) throw new Error(`MCP server "${name}" not found`)
  if (slot.status === 'running' || slot.status === 'starting') return

  // PRIVATE MODE gate — refuse to even SPAWN a network-needing third-party
  // server. Dynamic import keeps egress-policy (and its electron/ipc graph) off
  // this module's import-time path. `requiresNetwork` undefined = hand-added =
  // assume network (paranoid default). An import failure is NOT a denial: the
  // gate is best-effort here and re-applied by the TACHI bridge per session.
  let denial: string | undefined
  try {
    const { checkMcpServerEgress } = await import('./egress-policy')
    const decision = checkMcpServerEgress(name, slot.config.requiresNetwork !== false)
    if (!decision.allowed) denial = decision.reason
  } catch { /* egress module unavailable (tests, early boot) → no gate */ }
  if (denial) {
    slot.status    = 'error'
    slot.lastError = denial
    throw new Error(denial)
  }

  slot.status    = 'starting'
  slot.lastError = undefined
  slot.tools     = []

  const resolvedEnv = await resolveServerEnv(slot.config)

  // Deferred SDK load (see the import comment at the top of this file). Loaded
  // here, before the transport is constructed, so a broken/missing SDK still
  // throws out of startServer() exactly where a transport construction failure
  // would have — the caller's error path is unchanged.
  const [{ Client: McpSdkClient }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ])

  const transport = new StdioClientTransport({
    command: slot.config.command,
    args:    slot.config.args,
    // SECURITY: these are ARBITRARY user-configured third-party binaries — do
    // NOT hand them the full parent env (would leak ambient shell/CI secrets).
    // filterEnv passes OS essentials + TACHI_* + the server's own configured env
    // (plaintext vars merged with its keychain-held secrets).
    env:     filterEnv(process.env, resolvedEnv),
  })

  const client = new McpSdkClient(
    { name: 'tachi-mcp-client', version: '1.0.0' },
    { capabilities: {} },
  )

  try {
    await client.connect(transport)

    // StdioClientTransport spawns the process inside connect().
    // Grab the pid from the internal process reference.
    const proc = (transport as unknown as { _process?: { pid?: number } })._process
    slot.pid = proc?.pid

    const result = await client.listTools()
    slot.tools = result.tools.map(t => ({
      name:        t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }))

    slot.client = client
    slot.status = 'running'

    // Handle unexpected disconnection.
    transport.onclose = () => {
      const s = slots.get(name)
      if (s && (s.status === 'running' || s.status === 'starting')) {
        s.status    = 'error'
        s.lastError = 'Server process exited unexpectedly'
        s.client    = undefined
        s.pid       = undefined
      }
    }

    transport.onerror = (err: Error) => {
      const s = slots.get(name)
      if (s) {
        s.status    = 'error'
        s.lastError = err.message
        s.client    = undefined
        s.pid       = undefined
      }
    }
  } catch (err) {
    slot.status    = 'error'
    slot.lastError = err instanceof Error ? err.message : String(err)
    slot.client    = undefined
    slot.pid       = undefined
    try { await client.close() } catch { /* best-effort */ }
    throw err
  }
}

/**
 * Gracefully close the client/transport and mark the server stopped.
 */
export async function stopServer(name: string): Promise<void> {
  const slot = slots.get(name)
  if (!slot) return
  if (slot.status === 'stopped') return

  const client = slot.client
  slot.client    = undefined
  slot.status    = 'stopped'
  slot.pid       = undefined
  slot.tools     = []
  slot.lastError = undefined

  if (client) {
    try { await client.close() } catch { /* best-effort */ }
  }
}

/**
 * Returns a snapshot of all registered servers, safe to serialize over IPC.
 */
export function listServers(): MCPServerInfo[] {
  const result: MCPServerInfo[] = []
  for (const slot of slots.values()) {
    result.push({
      name:       slot.config.name,
      status:     slot.status,
      pid:        slot.pid,
      toolCount:  slot.tools.length,
      lastError:  slot.lastError,
      enabled:    slot.config.enabled === true,
      catalogId:  slot.config.catalogId,
      // undefined (hand-added) reads as network-needing — matches the gate.
      requiresNetwork: slot.config.requiresNetwork !== false,
      command:    slot.config.command,
      args:       slot.config.args,
      envKeys:       Object.keys(slot.config.env ?? {}),
      secretEnvKeys: slot.config.secretEnvKeys ?? [],
    })
  }
  return result
}

/**
 * Returns the tools exposed by a running server.
 * Throws if the server is not running.
 */
export async function listTools(name: string): Promise<MCPTool[]> {
  const slot = slots.get(name)
  if (!slot) throw new Error(`MCP server "${name}" not found`)
  if (slot.status !== 'running' || !slot.client) {
    throw new Error(`MCP server "${name}" is not running`)
  }
  const result = await slot.client.listTools()
  slot.tools = result.tools.map(t => ({
    name:        t.name,
    description: t.description ?? '',
    inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
  }))
  return slot.tools
}

/**
 * Flatten an MCP CallTool result `content` array to plain text: text parts are
 * joined with newlines; non-text parts (image/audio/resource/…) become short
 * placeholders like "[image]" so callers always get a string. Pure — exported
 * for unit tests.
 */
export function flattenMcpContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const part = item as { type?: unknown; text?: unknown }
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
    } else {
      parts.push(`[${typeof part.type === 'string' && part.type ? part.type : 'unknown'}]`)
    }
  }
  return parts.join('\n')
}

/**
 * Call a tool on a RUNNING server and return the result flattened to text.
 * The call is raced against a timeout so a hung third-party server can never
 * stall the caller forever. Every failure path throws an Error with an
 * actionable message (server missing / not running / timed out / tool error).
 */
export async function callMcpTool(
  serverName: string,
  toolName:   string,
  args:       Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<string> {
  const slot = slots.get(serverName)
  if (!slot) {
    throw new Error(`MCP server "${serverName}" not found — add it in Settings → MCP servers`)
  }
  if (slot.status !== 'running' || !slot.client) {
    throw new Error(`MCP server "${serverName}" is not running (status: ${slot.status}) — start it before calling its tools`)
  }
  const client = slot.client

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP tool "${toolName}" on server "${serverName}" timed out after ${Math.round(timeoutMs / 1000)}s — the server may be hung; try restarting it`)),
      timeoutMs,
    )
  })
  try {
    const result = await Promise.race([
      client.callTool({ name: toolName, arguments: args }),
      timeout,
    ]) as { content?: unknown; isError?: boolean }
    const text = flattenMcpContent(result.content)
    if (result.isError) {
      throw new Error(`MCP tool "${toolName}" on server "${serverName}" returned an error: ${text || '(no detail)'}`)
    }
    return text
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error(`MCP tool "${toolName}" on server "${serverName}" failed: ${String(err)}`)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Returns the config of a registered server, or undefined if not found.
 */
export function getServerConfig(name: string): MCPServerConfig | undefined {
  return slots.get(name)?.config
}

/**
 * Stop all running MCP servers. Called from app.on('will-quit').
 */
export async function stopAllMCPServers(): Promise<void> {
  const names = [...slots.keys()]
  await Promise.allSettled(names.map(n => stopServer(n)))
}
