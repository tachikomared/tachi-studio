// apps/desktop/test/unit/mcpAuditLog.test.ts
//
// Persistent JSONL audit log for the in-process MCP server (STEAL 2026-06-12
// cluster B; gridex MCPAuditLogger). The in-memory activity ring dies with the
// process — this file is the durable record of which agent called what.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendAudit, type AuditEntry } from '../../electron/mcp/audit-log'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-audit-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return { ts: 1718200000000, actor: 'claude', tool: 'fs_read', status: 'ok', durationMs: 12, ...over }
}

describe('appendAudit', () => {
  it('appends one parseable JSON line per call', () => {
    const file = join(dir, 'mcp-audit.jsonl')
    appendAudit(file, entry())
    appendAudit(file, entry({ tool: 'git_commit', status: 'error' }))
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ actor: 'claude', tool: 'fs_read', status: 'ok' })
    expect(JSON.parse(lines[1]!)).toMatchObject({ tool: 'git_commit', status: 'error' })
  })

  it('rotates to .1 when the file exceeds maxBytes', () => {
    const file = join(dir, 'mcp-audit.jsonl')
    appendAudit(file, entry())
    const firstSize = statSync(file).size
    // Force rotation on the next append by setting maxBytes below current size.
    appendAudit(file, entry({ tool: 'fs_write' }), firstSize - 1)
    expect(existsSync(file + '.1')).toBe(true)
    const rotated = readFileSync(file + '.1', 'utf8')
    expect(rotated).toContain('fs_read')
    const current = readFileSync(file, 'utf8')
    expect(current).toContain('fs_write')
    expect(current).not.toContain('fs_read')
  })

  it('overwrites a stale .1 on second rotation (Windows-safe)', () => {
    const file = join(dir, 'mcp-audit.jsonl')
    appendAudit(file, entry({ tool: 'a' }))
    appendAudit(file, entry({ tool: 'b' }), 1) // rotate 1: .1 = [a]
    appendAudit(file, entry({ tool: 'c' }), 1) // rotate 2: .1 = [b]
    expect(readFileSync(file + '.1', 'utf8')).toContain('"b"')
    expect(readFileSync(file, 'utf8')).toContain('"c"')
  })

  it('never throws on unwritable paths (best-effort)', () => {
    expect(() => appendAudit(join(dir, 'no\0pe', 'x.jsonl'), entry())).not.toThrow()
  })
})
