import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  addServer,
  removeServer,
  startServer,
  stopServer,
  listServers,
  listTools,
  setServerEnabled,
} from '../services/mcp-manager'
import {
  MCP_CATALOG,
  MCP_CATALOG_TAGS,
  getCatalogEntry,
  resolveCatalogArgs,
  splitCatalogEnv,
  missingRequiredInputs,
} from '../services/mcp-catalog'
import type { McpHandle } from '../services/mcp-server'

const ServerNameSchema = z.object({ name: z.string().min(1) })

const AddServerSchema = z.object({
  name:    z.string().min(1),
  command: z.string().min(1),
  args:    z.array(z.string()),
  env:     z.record(z.string(), z.string()).optional(),
  /** Values routed to the encrypted keychain instead of mcp-servers.json. */
  secrets: z.record(z.string(), z.string()).optional(),
})

/** One-click marketplace install: catalog id + the answers the user typed. */
const InstallCatalogSchema = z.object({
  catalogId: z.string().min(1),
  /** Optional rename so two Filesystem servers can coexist. */
  name:      z.string().min(1).optional(),
  /** Slot token ('<path>') → value. */
  slots:     z.record(z.string(), z.string()).default({}),
  /** Env var name → value. Secrets are split out by the catalog helper. */
  env:       z.record(z.string(), z.string()).default({}),
  /** Connect immediately after install. */
  enable:    z.boolean().default(false),
})

export function registerMCPIpc(): void {
  ipcMain.handle('mcp:list', () => {
    return listServers()
  })

  // Static, inert marketplace data — nothing is fetched or launched here.
  ipcMain.handle('mcp:catalog', () => {
    return { entries: MCP_CATALOG, tags: MCP_CATALOG_TAGS }
  })

  ipcMain.handle('mcp:add', async (_event, payload: unknown) => {
    const { secrets, ...config } = AddServerSchema.parse(payload)
    await addServer(config, secrets ?? {})
    return listServers()
  })

  ipcMain.handle('mcp:install', async (_event, payload: unknown) => {
    const req = InstallCatalogSchema.parse(payload)
    const entry = getCatalogEntry(req.catalogId)
    if (!entry) throw new Error(`Unknown MCP catalog entry "${req.catalogId}"`)

    const missing = missingRequiredInputs(entry, req.slots, req.env)
    if (missing.length > 0) {
      throw new Error(`Missing required value(s) for ${entry.name}: ${missing.join(', ')}`)
    }

    // A whitespace-only rename must not become an empty server name.
    const serverName = (req.name ?? '').trim() || entry.id

    const { env, secrets } = splitCatalogEnv(entry, req.env)
    await addServer(
      {
        name:            serverName,
        command:         entry.command,
        args:            resolveCatalogArgs(entry, req.slots),
        env:             Object.keys(env).length > 0 ? env : undefined,
        catalogId:       entry.id,
        requiresNetwork: entry.requiresNetwork,
        enabled:         req.enable,
      },
      secrets,
    )
    // enable:true means "connect now". A spawn failure must NOT undo the
    // install — the error lands on the server's own status row instead.
    if (req.enable) {
      try { await startServer(serverName) } catch { /* status row carries the error */ }
    }
    return listServers()
  })

  ipcMain.handle('mcp:set-server-enabled', async (_event, payload: unknown) => {
    const { name, enabled } = z.object({
      name:    z.string().min(1),
      enabled: z.boolean(),
    }).parse(payload)
    await setServerEnabled(name, enabled)
    return listServers()
  })

  ipcMain.handle('mcp:remove', async (_event, payload: unknown) => {
    const { name } = ServerNameSchema.parse(payload)
    await removeServer(name)
    return listServers()
  })

  ipcMain.handle('mcp:start', async (_event, payload: unknown) => {
    const { name } = ServerNameSchema.parse(payload)
    await startServer(name)
    return listServers().find(s => s.name === name)
  })

  ipcMain.handle('mcp:stop', async (_event, payload: unknown) => {
    const { name } = ServerNameSchema.parse(payload)
    await stopServer(name)
    return listServers().find(s => s.name === name)
  })

  ipcMain.handle('mcp:list-tools', async (_event, payload: unknown) => {
    const { name } = ServerNameSchema.parse(payload)
    return listTools(name)
  })
}

/**
 * Register IPC routes for the in-process MCP server (the one Tachi exposes
 * to external agents on 127.0.0.1:7421). Distinct from registerMCPIpc()
 * above, which handles external MCP server processes the user installs.
 *
 * Channels:
 *   mcp:status              — { running, url, port } (token NOT exposed here)
 *   mcp:reveal-token        — returns the bearer token (renderer must explicitly
 *                             call this; never broadcast)
 *   mcp:rotate-token        — stop, regenerate token, restart. Returns new status.
 *   mcp:set-enabled         — toggle the server on/off. Default: enabled.
 *   mcp:copy-client-config  — return a Claude-Desktop-shaped config snippet
 *                             that the user can paste into their client.
 */
export function registerInProcessMcpIpc(
  getHandle: () => McpHandle | null,
  setEnabled: (v: boolean) => Promise<void>,
  rotateToken: () => Promise<void>,
  isEnabled: () => boolean,
): void {
  ipcMain.handle('mcp:status', () => {
    const h = getHandle()
    if (!h) return { running: false, enabled: isEnabled(), url: null, port: null }
    return { running: true, enabled: isEnabled(), url: h.url, port: h.port }
  })

  // Token is only ever returned through this explicit "reveal" channel — never
  // included in status payloads, never broadcast to other windows.
  ipcMain.handle('mcp:reveal-token', () => {
    const h = getHandle()
    return h ? h.token : null
  })

  ipcMain.handle('mcp:rotate-token', async () => {
    await rotateToken()
    const h = getHandle()
    return h ? { running: true, url: h.url, port: h.port } : { running: false, url: null, port: null }
  })

  ipcMain.handle('mcp:set-enabled', async (_event, payload: unknown) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(payload)
    await setEnabled(enabled)
    const h = getHandle()
    return { running: !!h, enabled: isEnabled(), url: h?.url ?? null, port: h?.port ?? null }
  })

  ipcMain.handle('mcp:copy-client-config', () => {
    const h = getHandle()
    if (!h) return null
    // Claude Desktop's mcpServers shape for HTTP transports.
    return {
      claudeDesktop: {
        mcpServers: {
          tachidesk: {
            url: h.url,
            headers: { Authorization: `Bearer ${h.token}` },
          },
        },
      },
    }
  })
}
