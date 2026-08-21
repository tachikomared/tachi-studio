// apps/desktop/test/unit/mcp-pipeline.test.ts
//
// Integration coverage for the MCP server's request → dispatch → audit pipeline
// as a COMPOSED whole — not the individual permission/rate-limit/audit modules
// (each already unit-tested), but the actual handler wired in mcp-server.ts that
// chains them in order on every exit path:
//
//   permission gate → rate limit → run handler → audit (ok | denied | error)
//
// We drive the real Server (via buildMcpServer) over the MCP SDK's in-memory
// transport with a real Client — exercising the genuine CallTool handler, result
// wrapping and the JSONL audit writes — without binding a socket or speaking
// HTTP (the bearer-auth / actor-attribution layer lives in the Express handler
// and is HTTP-specific; here the actor defaults to 'agent'). electron's app is
// mocked to a temp userData so settings + the audit file land in a sandbox.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const USERDATA = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { join } = require('path') as typeof import('path')
  const { tmpdir } = require('os') as typeof import('os')
  return mkdtempSync(join(tmpdir(), 'tachi-mcp-pipe-'))
})

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => USERDATA },
  // buildMcpServer never touches safeStorage (that's only in token persistence,
  // which lives in startMcpServer), but the module destructures it on import.
  safeStorage: { isEncryptionAvailable: () => false },
}))

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { buildMcpServer, type McpServerCore } from '../../electron/services/mcp-server'
import { appSettingsSaveSchema } from '../../electron/services/settings-schema'
import { saveSettings } from '../../electron/services/settings-store'
import type { McpMode } from '../../electron/mcp/mcp-permission'

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'tachi-mcp-ws-'))
  // Fresh audit trail per test (the file path is fixed by userData).
  const auditFile = join(USERDATA, 'mcp-audit.jsonl')
  if (existsSync(auditFile)) rmSync(auditFile)
})
afterEach(() => { rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
afterAll(() => { rmSync(USERDATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

interface CallToolResult {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}
interface AuditEntry { ts: number; actor: string; tool: string; status: string; durationMs: number; detail?: string }

function readAudit(file: string): AuditEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as AuditEntry)
}
const textOf = (r: CallToolResult) => (r.content ?? []).map(c => c.text ?? '').join('\n')

/** Build a fresh server (own registry + rate-limiter + audit file) and a connected client. */
async function connectServer(mode: McpMode): Promise<{ core: McpServerCore; client: Client; close: () => Promise<void> }> {
  saveSettings(appSettingsSaveSchema.parse({ mcpMode: mode }))
  const core = buildMcpServer({ workspaceRoot: () => ws })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'tachi-test', version: '1.0.0' })
  await Promise.all([client.connect(clientT), core.server.connect(serverT)])
  const close = async () => {
    try { await client.close() } catch { /* ignore */ }
    try { await core.server.close() } catch { /* ignore */ }
  }
  return { core, client, close }
}

describe('MCP dispatch pipeline (in-memory transport, real handler + audit)', () => {
  it('allows a read-tier tool under read_only and audits it as ok', async () => {
    writeFileSync(join(ws, 'hello.txt'), 'pipeline content')
    const { core, client, close } = await connectServer('read_only')
    try {
      const res = await client.callTool({ name: 'fs_read', arguments: { path: 'hello.txt' } }) as CallToolResult
      expect(res.isError).toBeFalsy()
      expect(textOf(res)).toContain('pipeline content')

      const audit = readAudit(core.auditFile)
      expect(audit.length).toBe(1)
      expect(audit[0]).toMatchObject({ tool: 'fs_read', status: 'ok', actor: 'agent' })
      expect(typeof audit[0]!.durationMs).toBe('number')
    } finally { await close() }
  })

  it('denies a write-tier tool under read_only and audits it as denied (with the mode)', async () => {
    const { core, client, close } = await connectServer('read_only')
    try {
      const res = await client.callTool({ name: 'fs_write', arguments: { path: 'nope.txt', content: 'x' } }) as CallToolResult
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('blocked by the MCP permission mode')
      // The side effect must not have happened (the handler was never reached).
      expect(existsSync(join(ws, 'nope.txt'))).toBe(false)

      const audit = readAudit(core.auditFile)
      expect(audit.length).toBe(1)
      expect(audit[0]).toMatchObject({ tool: 'fs_write', status: 'denied' })
      expect(audit[0]!.detail).toContain('mcpMode=read_only')
    } finally { await close() }
  })

  it('audits a handler exception as error (sandbox escape) without crashing the pipeline', async () => {
    const { core, client, close } = await connectServer('read_only')
    try {
      const res = await client.callTool({ name: 'fs_read', arguments: { path: '../../escape.txt' } }) as CallToolResult
      expect(res.isError).toBe(true)

      const audit = readAudit(core.auditFile)
      expect(audit.length).toBe(1)
      expect(audit[0]).toMatchObject({ tool: 'fs_read', status: 'error' })
      expect(typeof audit[0]!.detail).toBe('string')
      expect(audit[0]!.detail!.length).toBeGreaterThan(0)
    } finally { await close() }
  })

  it('rejects an unknown tool as an error result (and writes no audit entry — it returns before the audit stage)', async () => {
    const { core, client, close } = await connectServer('full')
    try {
      const res = await client.callTool({ name: 'no_such_tool', arguments: {} }) as CallToolResult
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('unknown tool')
      expect(readAudit(core.auditFile).length).toBe(0)
    } finally { await close() }
  })

  it('enforces the per-tier rate limit and audits the throttled call as denied', async () => {
    writeFileSync(join(ws, 'r.txt'), 'data')
    const { core, client, close } = await connectServer('read_only')
    try {
      // Exhaust the shared read-tier window (120/min) via the SAME limiter the
      // handler consults, so the next dispatched call is over the limit.
      for (let i = 0; i < 120; i++) core.rateLimiter.check('fs_read')

      const res = await client.callTool({ name: 'fs_read', arguments: { path: 'r.txt' } }) as CallToolResult
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('rate limit')

      const audit = readAudit(core.auditFile)
      expect(audit.length).toBe(1)
      expect(audit[0]).toMatchObject({ tool: 'fs_read', status: 'denied', detail: 'rate-limited' })
    } finally { await close() }
  })
})
