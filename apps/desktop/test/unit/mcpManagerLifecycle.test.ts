// apps/desktop/test/unit/mcpManagerLifecycle.test.ts
//
// mcp-manager.ts lifecycle, with the official MCP SDK's Client/StdioClientTransport
// mocked out — no third-party process is ever spawned by this test.
//
// What is covered (the marketplace additions, USER-PAINS T11):
//   - addServer: secret env values go to the ENCRYPTED KEYCHAIN and never reach
//     mcp-servers.json; their NAMES are recorded on the config
//   - startServer: keychain secrets are re-joined into the child env, and the
//     env is still filtered (ambient parent secrets stay out)
//   - PRIVATE MODE: a network-needing server is refused BEFORE spawn; a
//     local-only one still starts; a hand-added server counts as network
//   - setServerEnabled / ensureEnabledServersStarted: the "stays connected"
//     half of one-click install
//   - removeServer: drops the keychain entries with the server
//   - listServers: exposes env var NAMES, never values

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const USERDATA = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { join: j } = require('path') as typeof import('path')
  const { tmpdir } = require('os') as typeof import('os')
  return mkdtempSync(j(tmpdir(), 'tachi-mcp-mgr-'))
})

// safeStorage stand-in: reversible, so retrieveKey round-trips what storeKey wrote.
vi.mock('electron', () => ({
  app: { getPath: (_name: string) => USERDATA },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, ''),
  },
}))

// ─── Mocked MCP SDK ───────────────────────────────────────────────────────────

const sdk = vi.hoisted(() => ({
  /** Every StdioClientTransport constructed, with the options it received. */
  transports: [] as Array<{ command: string; args: string[]; env: Record<string, string> }>,
  /** Tools the fake server reports. */
  tools: [{ name: 'do_thing', description: 'does a thing', inputSchema: { type: 'object' } }],
  connectError: null as Error | null,
  closed: 0,
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    onclose?: () => void
    onerror?: (e: Error) => void
    _process = { pid: 4242 }
    constructor(opts: { command: string; args: string[]; env: Record<string, string> }) {
      sdk.transports.push(opts)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() { if (sdk.connectError) throw sdk.connectError }
    async listTools() { return { tools: sdk.tools } }
    async callTool() { return { content: [{ type: 'text', text: 'ok' }] } }
    async close() { sdk.closed++ }
  },
}))

// ─── Mocked egress policy (PRIVATE MODE switch) ──────────────────────────────

const egress = vi.hoisted(() => ({ privateMode: false }))

vi.mock('../../electron/services/egress-policy', () => ({
  checkMcpServerEgress: (serverName: string, requiresNetwork: boolean) => {
    if (!egress.privateMode || !requiresNetwork) return { allowed: true }
    return { allowed: false, reason: `PRIVATE MODE blocks MCP server "${serverName}" — it reaches the public internet.` }
  },
}))

import * as mgr from '../../electron/services/mcp-manager'
import { retrieveKey, hasKey } from '../../electron/services/keychain'

const CONFIG_PATH = join(USERDATA, 'mcp-servers.json')

function readPersisted(): Array<Record<string, unknown>> {
  if (!existsSync(CONFIG_PATH)) return []
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
}

beforeEach(() => {
  sdk.transports = []
  sdk.connectError = null
  sdk.closed = 0
  egress.privateMode = false
})

afterEach(async () => {
  // Leave the module-level registry clean for the next test.
  for (const s of mgr.listServers()) await mgr.removeServer(s.name)
})

describe('addServer — secret handling', () => {
  it('writes secret env values to the keychain, never to mcp-servers.json', async () => {
    await mgr.addServer(
      {
        name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_HOST: 'github.com' }, catalogId: 'github', requiresNetwork: true,
      },
      { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_supersecret' },
    )

    const raw = readFileSync(CONFIG_PATH, 'utf8')
    expect(raw).not.toContain('ghp_supersecret')
    expect(raw).toContain('GITHUB_PERSONAL_ACCESS_TOKEN') // the NAME is fine

    const persisted = readPersisted().find(c => c.name === 'github')!
    expect(persisted.env).toEqual({ GITHUB_HOST: 'github.com' })
    expect(persisted.secretEnvKeys).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN'])
    expect(persisted.catalogId).toBe('github')
    expect(persisted.requiresNetwork).toBe(true)

    expect(retrieveKey(mgr.mcpSecretKeyId('github', 'GITHUB_PERSONAL_ACCESS_TOKEN')))
      .toBe('ghp_supersecret')
  })

  it('strips a secret that was ALSO passed in the plaintext env block', async () => {
    await mgr.addServer(
      { name: 'dup', command: 'npx', args: ['x'], env: { TOK: 'leaked', OTHER: 'v' } },
      { TOK: 'real' },
    )
    expect(readFileSync(CONFIG_PATH, 'utf8')).not.toContain('leaked')
    expect(readPersisted().find(c => c.name === 'dup')!.env).toEqual({ OTHER: 'v' })
  })

  it('namespaces keychain ids so two servers cannot collide', () => {
    expect(mgr.mcpSecretKeyId('a', 'K')).toBe('mcp:a:K')
    expect(mgr.mcpSecretKeyId('b', 'K')).toBe('mcp:b:K')
  })

  it('rejects a duplicate server name', async () => {
    await mgr.addServer({ name: 'dupe', command: 'npx', args: [] })
    await expect(mgr.addServer({ name: 'dupe', command: 'npx', args: [] })).rejects.toThrow(/already exists/)
  })
})

describe('startServer — env assembly', () => {
  it('merges keychain secrets into the child env and keeps ambient secrets out', async () => {
    process.env.SOME_AMBIENT_SECRET = 'do-not-leak'
    try {
      await mgr.addServer(
        { name: 'brave', command: 'npx', args: ['-y', 'srv'], env: { PLAIN: 'p' }, requiresNetwork: true },
        { BRAVE_API_KEY: 'bsk_123' },
      )
      await mgr.startServer('brave')

      expect(sdk.transports).toHaveLength(1)
      const spawned = sdk.transports[0]!
      expect(spawned.command).toBe('npx')
      expect(spawned.args).toEqual(['-y', 'srv'])
      expect(spawned.env.BRAVE_API_KEY).toBe('bsk_123')   // from the keychain
      expect(spawned.env.PLAIN).toBe('p')                 // from the config
      expect(spawned.env.SOME_AMBIENT_SECRET).toBeUndefined() // filterEnv held
      expect(spawned.env.PATH ?? spawned.env.Path).toBeDefined() // OS essentials pass
    } finally {
      delete process.env.SOME_AMBIENT_SECRET
    }
  })

  it('reports running status and the tool count after connecting', async () => {
    await mgr.addServer({ name: 'ok', command: 'npx', args: [] })
    await mgr.startServer('ok')
    const info = mgr.listServers().find(s => s.name === 'ok')!
    expect(info.status).toBe('running')
    expect(info.toolCount).toBe(1)
    expect(info.pid).toBe(4242)
  })

  it('records the error and stays stopped-ish when connect fails', async () => {
    sdk.connectError = new Error('ENOENT npx')
    await mgr.addServer({ name: 'broken', command: 'npx', args: [] })
    await expect(mgr.startServer('broken')).rejects.toThrow(/ENOENT npx/)
    const info = mgr.listServers().find(s => s.name === 'broken')!
    expect(info.status).toBe('error')
    expect(info.lastError).toMatch(/ENOENT npx/)
  })
})

describe('PRIVATE MODE gate', () => {
  it('refuses to spawn a network-needing server', async () => {
    await mgr.addServer({ name: 'tavily', command: 'npx', args: [], requiresNetwork: true })
    egress.privateMode = true

    await expect(mgr.startServer('tavily')).rejects.toThrow(/PRIVATE MODE blocks MCP server "tavily"/)
    expect(sdk.transports).toHaveLength(0) // never even constructed a transport
    expect(mgr.listServers().find(s => s.name === 'tavily')!.status).toBe('error')
  })

  it('still starts a local-only server', async () => {
    await mgr.addServer({ name: 'fs', command: 'npx', args: [], requiresNetwork: false })
    egress.privateMode = true

    await mgr.startServer('fs')
    expect(sdk.transports).toHaveLength(1)
    expect(mgr.listServers().find(s => s.name === 'fs')!.status).toBe('running')
  })

  it('treats a hand-added server (no requiresNetwork) as network — paranoid default', async () => {
    await mgr.addServer({ name: 'custom', command: 'npx', args: [] })
    egress.privateMode = true

    await expect(mgr.startServer('custom')).rejects.toThrow(/PRIVATE MODE/)
    expect(mgr.listServers().find(s => s.name === 'custom')!.requiresNetwork).toBe(true)
  })
})

describe('enable / disable', () => {
  it('setServerEnabled(true) persists the flag and connects', async () => {
    await mgr.addServer({ name: 'e1', command: 'npx', args: [], requiresNetwork: false })
    await mgr.setServerEnabled('e1', true)

    expect(mgr.listServers().find(s => s.name === 'e1')!.enabled).toBe(true)
    expect(mgr.listServers().find(s => s.name === 'e1')!.status).toBe('running')
    expect(readPersisted().find(c => c.name === 'e1')!.enabled).toBe(true)
  })

  it('setServerEnabled(false) persists and stops', async () => {
    await mgr.addServer({ name: 'e2', command: 'npx', args: [], requiresNetwork: false, enabled: true })
    await mgr.startServer('e2')
    await mgr.setServerEnabled('e2', false)

    expect(mgr.listServers().find(s => s.name === 'e2')!.status).toBe('stopped')
    expect(readPersisted().find(c => c.name === 'e2')!.enabled).toBe(false)
    expect(sdk.closed).toBeGreaterThan(0)
  })

  it('throws for an unknown server', async () => {
    await expect(mgr.setServerEnabled('ghost', true)).rejects.toThrow(/not found/)
  })

  it('ensureEnabledServersStarted brings up ONLY enabled+stopped servers', async () => {
    await mgr.addServer({ name: 'on',  command: 'npx', args: [], requiresNetwork: false, enabled: true })
    await mgr.addServer({ name: 'off', command: 'npx', args: [], requiresNetwork: false, enabled: false })

    await mgr.ensureEnabledServersStarted()

    expect(sdk.transports).toHaveLength(1)
    expect(mgr.listServers().find(s => s.name === 'on')!.status).toBe('running')
    expect(mgr.listServers().find(s => s.name === 'off')!.status).toBe('stopped')
  })

  it('ensureEnabledServersStarted is idempotent and swallows per-server failures', async () => {
    await mgr.addServer({ name: 'a', command: 'npx', args: [], requiresNetwork: false, enabled: true })
    await mgr.addServer({ name: 'b', command: 'npx', args: [], requiresNetwork: true,  enabled: true })
    egress.privateMode = true // 'b' will be denied

    await expect(mgr.ensureEnabledServersStarted()).resolves.toBeUndefined()
    await expect(mgr.ensureEnabledServersStarted()).resolves.toBeUndefined()

    expect(sdk.transports).toHaveLength(1) // 'a' started once, 'b' never
    expect(mgr.listServers().find(s => s.name === 'a')!.status).toBe('running')
    expect(mgr.listServers().find(s => s.name === 'b')!.status).toBe('error')
  })
})

describe('removeServer', () => {
  it('drops the keychain secrets along with the config', async () => {
    await mgr.addServer(
      { name: 'gone', command: 'npx', args: [], requiresNetwork: true },
      { API_KEY: 'k1' },
    )
    const keyId = mgr.mcpSecretKeyId('gone', 'API_KEY')
    expect(hasKey(keyId)).toBe(true)

    await mgr.removeServer('gone')

    expect(hasKey(keyId)).toBe(false)
    expect(mgr.listServers().find(s => s.name === 'gone')).toBeUndefined()
    expect(readPersisted().find(c => c.name === 'gone')).toBeUndefined()
  })
})

describe('listServers — IPC payload', () => {
  it('exposes env var NAMES but never values', async () => {
    await mgr.addServer(
      { name: 'shape', command: 'npx', args: ['-y', 'p'], env: { PLAIN: 'visible' }, requiresNetwork: true, catalogId: 'x' },
      { SECRET_TOKEN: 'nope' },
    )
    const info = mgr.listServers().find(s => s.name === 'shape')!
    expect(info.envKeys).toEqual(['PLAIN'])
    expect(info.secretEnvKeys).toEqual(['SECRET_TOKEN'])
    expect(JSON.stringify(info)).not.toContain('nope')
    expect(info.enabled).toBe(false)
    expect(info.catalogId).toBe('x')
    expect(info.command).toBe('npx')
    expect(info.args).toEqual(['-y', 'p'])
  })
})
